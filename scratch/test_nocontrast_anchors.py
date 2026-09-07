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
  <h1>Anchor Test No Contrast</h1>
  <script>
    async function run() {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise(r => { img.onload = r; img.src = '/scratch/bill.png'; });

        // Bill boundary in screenshot
        const billX = 460;
        const billY = 0;
        const billW = 370;
        const billH = 515;

        // Smooth 3.0x scale WITHOUT contrast stretching
        const cropCanvas = document.createElement('canvas');
        const scale = 3.0;
        cropCanvas.width = billW * scale;
        cropCanvas.height = billH * scale;
        const cropCtx = cropCanvas.getContext('2d');
        cropCtx.imageSmoothingEnabled = true;
        cropCtx.imageSmoothingQuality = 'high';
        cropCtx.drawImage(img, billX, billY, billW, billH, 0, 0, cropCanvas.width, cropCanvas.height);

        const worker = await Tesseract.createWorker('eng', 1, {
          workerPath: '/lib/tesseract/worker.min.js',
          corePath: '/lib/tesseract/tesseract-core-simd.wasm.js',
          langPath: '/lib/tesseract/',
          workerBlobURL: false,
          gzip: false,
        });

        await worker.setParameters({ tessedit_pageseg_mode: '6' });
        const res = await worker.recognize(cropCanvas.toDataURL('image/png'));
        await worker.terminate();

        const invScale = 1.0 / scale;
        const words = (res.data.words || []).map(w => ({
          text: w.text.trim(),
          conf: w.confidence,
          bbox: {
            x: billX + Math.round(w.bbox.x0 * invScale),
            y: billY + Math.round(w.bbox.y0 * invScale),
            width: Math.round((w.bbox.x1 - w.bbox.x0) * invScale),
            height: Math.round((w.bbox.y1 - w.bbox.y0) * invScale),
          }
        })).filter(w => w.text);

        await fetch('http://localhost:8997/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            words,
            text: res.data.text
          })
        });

      } catch (err) {
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

with open('scratch/nocontrast_anchor_test.html', 'w', encoding='utf-8') as f:
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
    f'http://localhost:{PORT}/scratch/nocontrast_anchor_test.html'
]

proc = subprocess.Popen(chrome_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

for i in range(35):
    if results_received is not None:
        break
    time.sleep(1)

proc.terminate()
server.shutdown()

if results_received and 'words' in results_received:
    print(f"Recognized {len(results_received['words'])} words.")
    with open('scratch/nocontrast_words.json', 'w') as f:
        json.dump(results_received, f, indent=2)
    print("Full output saved to scratch/nocontrast_words.json")
else:
    print("Failed:", results_received)
