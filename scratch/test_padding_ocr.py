import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

PORT = 8990
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
  <h1>Padded Crop OCR Test</h1>
  <script>
    async function run() {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise(r => { img.onload = r; img.src = '/scratch/exact_bill.png'; });

        const worker = await Tesseract.createWorker('eng', 1, {
          workerPath: '/lib/tesseract/worker.min.js',
          corePath: '/lib/tesseract/tesseract-core-simd.wasm.js',
          langPath: '/lib/tesseract/',
          workerBlobURL: false,
          gzip: false,
        });

        await worker.setParameters({ tessedit_pageseg_mode: '6' });

        const tests = {};
        for (const pad of [0, 20, 40]) {
          const scale = 3.0;
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * scale) + pad * 2;
          c.height = Math.round(img.height * scale) + pad * 2;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, pad, pad, Math.round(img.width * scale), Math.round(img.height * scale));

          const res = await worker.recognize(c.toDataURL('image/png'));
          tests[`pad_${pad}`] = {
            text: res.data.text.trim(),
            words: (res.data.words || []).map(w => w.text.trim()).filter(Boolean)
          };
        }

        await worker.terminate();

        await fetch('http://localhost:8990/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tests)
        });
      } catch (err) {
        await fetch('http://localhost:8990/results', {
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

with open('scratch/padded_crop_test.html', 'w', encoding='utf-8') as f:
    f.write(html_content)

server = socketserver.TCPServer(('', PORT), TestHandler)
t = threading.Thread(target=server.serve_forever)
t.daemon = True
t.start()

chrome_cmd = [
    'google-chrome',
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    f'http://localhost:{PORT}/scratch/padded_crop_test.html'
]

proc = subprocess.Popen(chrome_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

for i in range(35):
    if results_received is not None:
        break
    time.sleep(1)

proc.terminate()
server.shutdown()

if results_received:
    for k, v in results_received.items():
        print(f"=== {k} (words: {len(v['words'])}) ===")
        # Print lines containing name, mob, imei, sign
        for line in v['text'].split('\n'):
            l = line.lower()
            if any(term in l for term in ['name', 'mod', 'mob', 'ime', 'sign', 'shyam', 'gst', '13495']):
                print("   LINE:", line)
else:
    print("Failed")
