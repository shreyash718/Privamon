import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

PORT = 8997
results_received = None

class TestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def do_POST(self):
        global results_received
        length = int(self.headers.get('content-length', 0))
        data = self.rfile.read(length)
        results_received = json.loads(data.decode('utf-8'))
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

    def log_message(self, format, *args):
        pass

html_content = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="/lib/tesseract/tesseract.min.js"></script>
</head>
<body>
  <h1>Cropped Bill OCR Tester</h1>
  <div id="status">Running tests...</div>
  <script>
    async function run() {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = '/scratch/bill_cropped.png';
        });

        console.log(`Loaded bill_cropped: ${img.width}x${img.height}`);

        // We will test 3 scale factors and 2 PSM modes
        // Scales: 2.0, 3.0
        // PSMs: 6, 11, 4

        const worker = await Tesseract.createWorker('eng', 1, {
          workerPath: '/lib/tesseract/worker.min.js',
          corePath: '/lib/tesseract/tesseract-core-simd.wasm.js',
          langPath: '/lib/tesseract/',
          workerBlobURL: false,
          gzip: false,
        });

        const testConfigs = [
          { scale: 2.5, psm: '6', contrast: true, name: 'scale2.5_psm6_contrast' },
          { scale: 3.0, psm: '11', contrast: true, name: 'scale3_psm11_contrast' },
          { scale: 3.0, psm: '4', contrast: true, name: 'scale3_psm4_contrast' },
          { scale: 3.0, psm: '6', contrast: false, name: 'scale3_psm6_nocontrast' },
          { scale: 3.0, psm: '11', binarize: true, name: 'scale3_psm11_binarize' },
        ];

        const testResults = {};

        for (const cfg of testConfigs) {
          console.log(`Running config: ${cfg.name}`);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * cfg.scale);
          canvas.height = Math.round(img.height * cfg.scale);
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          if (cfg.contrast || cfg.binarize) {
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const d = imgData.data;

            // Grayscale
            for (let i = 0; i < d.length; i += 4) {
              const lum = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
              d[i] = lum;
              d[i+1] = lum;
              d[i+2] = lum;
            }

            if (cfg.binarize) {
              // Local adaptive / simple threshold
              for (let i = 0; i < d.length; i += 4) {
                const val = d[i] > 165 ? 255 : 0;
                d[i] = val;
                d[i+1] = val;
                d[i+2] = val;
              }
            } else {
              // Min-max stretch
              let minL = 255, maxL = 0;
              for (let i = 0; i < d.length; i += 16) {
                if (d[i] < minL) minL = d[i];
                if (d[i] > maxL) maxL = d[i];
              }
              const factor = 255 / Math.max(1, maxL - minL);
              for (let i = 0; i < d.length; i += 4) {
                const stretched = Math.min(255, Math.max(0, (d[i] - minL) * factor));
                d[i] = stretched;
                d[i+1] = stretched;
                d[i+2] = stretched;
              }
            }
            ctx.putImageData(imgData, 0, 0);
          }

          await worker.setParameters({
            tessedit_pageseg_mode: cfg.psm,
          });

          const res = await worker.recognize(canvas.toDataURL('image/png'));
          testResults[cfg.name] = {
            text: res.data.text,
            wordCount: (res.data.words || []).length,
            words: (res.data.words || []).map(w => w.text)
          };
        }

        await worker.terminate();

        await fetch('http://localhost:8997/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(testResults)
        });

        document.getElementById('status').textContent = 'DONE';
      } catch (err) {
        console.error(err);
        await fetch('http://localhost:8997/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: err.stack || err.message })
        });
      }
    }
    window.onload = run;
  </script>
</body>
</html>
"""

with open('scratch/ocr_cropped_test.html', 'w', encoding='utf-8') as f:
    f.write(html_content)

server = socketserver.TCPServer(('', PORT), TestHandler)
t = threading.Thread(target=server.serve_forever)
t.daemon = True
t.start()
print(f'Server started on http://localhost:{PORT}')

chrome_cmd = [
    'google-chrome',
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    f'http://localhost:{PORT}/scratch/ocr_cropped_test.html'
]

proc = subprocess.Popen(chrome_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

for i in range(50):
    if results_received is not None:
        break
    time.sleep(1)

proc.terminate()
server.shutdown()

if results_received:
    with open('scratch/ocr_cropped_results.json', 'w', encoding='utf-8') as f:
        json.dump(results_received, f, indent=2)
    print('SUCCESS: Results saved to scratch/ocr_cropped_results.json')
    for name, data in results_received.items():
        if isinstance(data, dict) and 'text' in data:
            print(f"\n=== CONFIG: {name} (Words: {data['wordCount']}) ===")
            print(data['text'][:300])
else:
    print('TIMEOUT')
