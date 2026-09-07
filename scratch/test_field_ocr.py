import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

PORT = 8996
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
  <h1>Field OCR Tester</h1>
  <div id="status">Running tests...</div>
  <script>
    async function testField(worker, url, psm) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise(r => { img.onload = r; img.src = url; });

      // Scale 3x
      const c = document.createElement('canvas');
      c.width = img.width * 3;
      c.height = img.height * 3;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);

      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const res = await worker.recognize(c.toDataURL('image/png'));
      return {
        text: res.data.text.trim(),
        words: (res.data.words || []).map(w => ({ text: w.text, conf: w.confidence, bbox: w.bbox }))
      };
    }

    async function run() {
      try {
        const worker = await Tesseract.createWorker('eng', 1, {
          workerPath: '/lib/tesseract/worker.min.js',
          corePath: '/lib/tesseract/tesseract-core-simd.wasm.js',
          langPath: '/lib/tesseract/',
          workerBlobURL: false,
          gzip: false,
        });

        const results = {
          name_psm7: await testField(worker, '/scratch/field_name.png', '7'),
          name_psm6: await testField(worker, '/scratch/field_name.png', '6'),
          mob_psm7: await testField(worker, '/scratch/field_mob.png', '7'),
          mob_psm6: await testField(worker, '/scratch/field_mob.png', '6'),
          imei_psm7: await testField(worker, '/scratch/field_imei.png', '7'),
          imei_psm6: await testField(worker, '/scratch/field_imei.png', '6'),
        };

        await worker.terminate();

        await fetch('http://localhost:8996/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(results)
        });
      } catch (err) {
        await fetch('http://localhost:8996/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: err.message })
        });
      }
    }
    window.onload = run;
  </script>
</body>
</html>
"""

with open('scratch/field_test.html', 'w', encoding='utf-8') as f:
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
    f'http://localhost:{PORT}/scratch/field_test.html'
]

proc = subprocess.Popen(chrome_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

for i in range(30):
    if results_received is not None:
        break
    time.sleep(1)

proc.terminate()
server.shutdown()

print("Field Results:")
print(json.dumps(results_received, indent=2))
