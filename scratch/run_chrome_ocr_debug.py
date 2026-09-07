import http.server
import socketserver
import threading
import time
import json
import subprocess
import os
import sys

PORT = 8998
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
        # Suppress noisy logs
        pass

html_content = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="/lib/tesseract/tesseract.min.js"></script>
</head>
<body>
  <h1>OCR Debugger</h1>
  <div id="status">Running OCR...</div>
  <script>
    async function run() {
      try {
        console.log('[DEBUG] Loading image...');
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = '/scratch/bill.png';
        });

        console.log(`[DEBUG] Image size: ${img.width}x${img.height}`);

        // Prepare 3 variants:
        // 1. Raw
        // 2. Grayscale + contrast stretched
        // 3. High-contrast Otsu/Adaptive binarized

        // 1. Raw canvas
        const cRaw = document.createElement('canvas');
        cRaw.width = img.width;
        cRaw.height = img.height;
        const ctxRaw = cRaw.getContext('2d');
        ctxRaw.drawImage(img, 0, 0);

        // 2. Grayscale + stretched canvas
        const cStretched = document.createElement('canvas');
        cStretched.width = img.width;
        cStretched.height = img.height;
        const ctxStretched = cStretched.getContext('2d');
        ctxStretched.drawImage(img, 0, 0);
        const imgData = ctxStretched.getImageData(0, 0, img.width, img.height);
        const d = imgData.data;

        let minL = 255, maxL = 0;
        for (let i = 0; i < d.length; i += 16) {
          const l = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
          if (l < minL) minL = l;
          if (l > maxL) maxL = l;
        }
        const factor = 255 / Math.max(1, maxL - minL);
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
          const val = Math.min(255, Math.max(0, (l - minL) * factor));
          d[i] = val;
          d[i+1] = val;
          d[i+2] = val;
        }
        ctxStretched.putImageData(imgData, 0, 0);

        // Initialize Tesseract worker
        console.log('[DEBUG] Initializing Tesseract...');
        const worker = await Tesseract.createWorker('eng+hin', 1, {
          workerPath: '/lib/tesseract/worker.min.js',
          corePath: '/lib/tesseract/tesseract-core-simd.wasm.js',
          langPath: '/lib/tesseract/',
          workerBlobURL: false,
          gzip: false,
        });

        // Configure Tesseract for better handwriting/form recognition
        await worker.setParameters({
          tessedit_pageseg_mode: '1', // Automatic page segmentation with OSD
        });

        console.log('[DEBUG] Recognizing stretched image...');
        const resStretched = await worker.recognize(cStretched.toDataURL('image/png'));
        
        console.log('[DEBUG] Recognizing raw image...');
        const resRaw = await worker.recognize(cRaw.toDataURL('image/png'));

        await worker.terminate();

        const wordsStretched = (resStretched.data.words || []).map(w => ({
          text: w.text,
          confidence: w.confidence,
          bbox: w.bbox
        }));

        const linesStretched = (resStretched.data.lines || []).map(l => ({
          text: l.text.trim(),
          confidence: l.confidence,
          bbox: l.bbox
        }));

        const wordsRaw = (resRaw.data.words || []).map(w => ({
          text: w.text,
          confidence: w.confidence,
          bbox: w.bbox
        }));

        const payload = {
          stretched: {
            text: resStretched.data.text,
            lines: linesStretched,
            words: wordsStretched
          },
          raw: {
            text: resRaw.data.text,
            words: wordsRaw
          }
        };

        await fetch('http://localhost:8998/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        document.getElementById('status').textContent = 'DONE';
      } catch (err) {
        console.error(err);
        await fetch('http://localhost:8998/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: err.stack || err.message })
        });
        document.getElementById('status').textContent = 'ERROR: ' + err.message;
      }
    }
    window.onload = run;
  </script>
</body>
</html>
"""

os.makedirs('scratch', exist_ok=True)
with open('scratch/ocr_debug.html', 'w', encoding='utf-8') as f:
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
    f'http://localhost:{PORT}/scratch/ocr_debug.html'
]

proc = subprocess.Popen(chrome_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

for i in range(40):
    if results_received is not None:
        break
    time.sleep(1)

proc.terminate()
server.shutdown()

if results_received:
    with open('scratch/ocr_debug_results.json', 'w', encoding='utf-8') as f:
        json.dump(results_received, f, indent=2)
    print('SUCCESS: Results saved to scratch/ocr_debug_results.json')
    if 'error' in results_received:
        print('ERROR:', results_received['error'])
    else:
        print('\n=== STRETCHED OCR TEXT ===')
        print(results_received['stretched']['text'])
        print('\n=== RAW OCR TEXT ===')
        print(results_received['raw']['text'])
else:
    print('TIMEOUT: No results received within 40 seconds')
