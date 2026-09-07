import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

PORT = 8991
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
  <h1>Name Section PSM Test</h1>
  <script>
    async function run() {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise(r => { img.onload = r; img.src = '/scratch/bill_name_section.png'; });

        const worker = await Tesseract.createWorker('eng', 1, {
          workerPath: '/lib/tesseract/worker.min.js',
          corePath: '/lib/tesseract/tesseract-core-simd.wasm.js',
          langPath: '/lib/tesseract/',
          workerBlobURL: false,
          gzip: false,
        });

        const tests = {};

        for (const scale of [1.0, 2.0, 3.0]) {
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * scale);
          c.height = Math.round(img.height * scale);
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, c.width, c.height);
          const dataUrl = c.toDataURL('image/png');

          for (const psm of ['3', '4', '6', '11']) {
            await worker.setParameters({ tessedit_pageseg_mode: psm });
            const res = await worker.recognize(dataUrl);
            tests[`scale${scale}_psm${psm}`] = res.data.text.trim();
          }
        }

        await worker.terminate();

        await fetch('http://localhost:8991/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tests)
        });
      } catch (err) {
        await fetch('http://localhost:8991/results', {
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

with open('scratch/name_psm_test.html', 'w', encoding='utf-8') as f:
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
    f'http://localhost:{PORT}/scratch/name_psm_test.html'
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
        print(f"=== {k} ===")
        print(v)
else:
    print("Failed")
