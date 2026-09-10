import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

PORT = 8997
results_received = None

class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True

class TestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
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
  <title>User Image Debug</title>
  <script src="/lib/tesseract/tesseract.min.js"></script>
  <script src="/content/dom-range-mapper.js"></script>
  <script src="/privacy/coordinate-mapper.js"></script>
  <script src="/privacy/pii-detector.js"></script>
  <script src="/privacy/pii-classifier.js"></script>
  <script src="/privacy/ner-engine.js"></script>
  <script src="/privacy/fusion.js"></script>
  <script src="/privacy/redactor.js"></script>
  <script src="/privacy/verifier.js"></script>
  <script src="/privacy/image-resizer.js"></script>
  <script src="/vision/vision-model.js"></script>
  <script src="/vision/face-detector.js"></script>
  <script src="/vision/ocr-engine.js"></script>
  <script src="/pipeline/sanitize-pipeline.js"></script>
</head>
<body>
  <img id="user-card" src="/scratch/cards_in_viewer.png" style="display:block;">

  <script>
    window.addEventListener('DOMContentLoaded', async () => {
      const img = document.getElementById('user-card');
      await new Promise(r => {
        if (img.complete) r();
        else img.onload = r;
      });

      const rImg = img.getBoundingClientRect();
      const sw = Math.max(800, rImg.width + 100);
      const sh = Math.max(600, rImg.height + 100);

      const sCanvas = document.createElement('canvas');
      sCanvas.width = sw;
      sCanvas.height = sh;
      const sCtx = sCanvas.getContext('2d');
      sCtx.fillStyle = '#111';
      sCtx.fillRect(0, 0, sw, sh);
      sCtx.drawImage(img, 20, 20);

      const screenshotDataUrl = sCanvas.toDataURL('image/png');

      const regions = [{
        elementId: 'user-card',
        tag: 'IMG',
        bbox: { x: 20, y: 20, width: rImg.width, height: rImg.height },
        boxes: [{ x: 20, y: 20, width: rImg.width, height: rImg.height }],
        area: rImg.width * rImg.height
      }];

      const mapper = {
        mapBbox: b => b,
        mapBoxes: bx => bx,
        scaleX: 1,
        scaleY: 1
      };

      const ocrOutput = await Privamon.OCREngine.processRegions(screenshotDataUrl, regions, mapper);

      const payload = {
        rawText: ocrOutput.rawText,
        detections: ocrOutput.detections,
        imgWidth: rImg.width,
        imgHeight: rImg.height,
        aspect: rImg.width / Math.max(rImg.height, 1)
      };

      await fetch('http://localhost:8997/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    });
  </script>
</body>
</html>
"""

def main():
    global results_received
    os.makedirs('scratch', exist_ok=True)
    with open('scratch/test_user_image_debug.html', 'w', encoding='utf-8') as f:
        f.write(html_content)

    server = ReusableServer(('', PORT), TestHandler)
    t = threading.Thread(target=server.serve_forever)
    t.daemon = True
    t.start()
    print(f'Server started on http://localhost:{PORT}')

    chrome_cmd = [
        'google-chrome',
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--window-size=1280,1000',
        f'http://localhost:{PORT}/scratch/test_user_image_debug.html'
    ]

    proc = subprocess.Popen(chrome_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    start_time = time.time()
    while results_received is None and time.time() - start_time < 40:
        time.sleep(0.5)

    proc.terminate()
    server.shutdown()

    if results_received:
        print("\n=== OCR DEBUG RESULTS ON USER IMAGE ===")
        print("Image dimensions:", results_received.get('imgWidth'), "x", results_received.get('imgHeight'))
        print("Aspect ratio:", results_received.get('aspect'))
        print("Raw Text:\n", results_received.get('rawText'))
        print("\nDetections:")
        for d in results_received.get('detections', []):
            print(" -", d.get('type'), d.get('text'), d.get('reason'), d.get('bbox'))
    else:
        print("Timed out waiting for results")

if __name__ == '__main__':
    main()
