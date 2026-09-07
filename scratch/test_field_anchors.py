import http.server
import socketserver
import threading
import time
import json
import subprocess
import os
from PIL import Image

PORT = 8995
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
  <h1>Form Field Anchor Test</h1>
  <script>
    async function run() {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise(r => { img.onload = r; img.src = '/scratch/bill.png'; });

        // Let's test form field detection on the bill region
        // Bill is at x: 495, y: 5, w: 340, h: 510
        const billX = 495;
        const billY = 5;
        const billW = 340;
        const billH = 510;

        const cropCanvas = document.createElement('canvas');
        // Upscale 3x for Tesseract
        cropCanvas.width = billW * 3;
        cropCanvas.height = billH * 3;
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

        await worker.setParameters({
          tessedit_pageseg_mode: '6',
        });

        const res = await worker.recognize(cropCanvas.toDataURL('image/png'));
        await worker.terminate();

        const invScale = 1.0 / 3.0;
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

        // Group words into lines
        const lines = (res.data.lines || []).map(l => {
          const lWords = (l.words || []).map(w => ({
            text: w.text.trim(),
            conf: w.confidence,
            bbox: {
              x: billX + Math.round(w.bbox.x0 * invScale),
              y: billY + Math.round(w.bbox.y0 * invScale),
              width: Math.round((w.bbox.x1 - w.bbox.x0) * invScale),
              height: Math.round((w.bbox.y1 - w.bbox.y0) * invScale),
            }
          })).filter(w => w.text);

          return {
            text: l.text.trim(),
            words: lWords,
            bbox: {
              x: billX + Math.round(l.bbox.x0 * invScale),
              y: billY + Math.round(l.bbox.y0 * invScale),
              width: Math.round((l.bbox.x1 - l.bbox.x0) * invScale),
              height: Math.round((l.bbox.y1 - l.bbox.y0) * invScale),
            }
          };
        });

        // Test Form Field Anchor Extraction:
        const fieldDetections = [];
        const rightMargin = billX + billW - 10;

        for (const line of lines) {
          for (let wi = 0; wi < line.words.length; wi++) {
            const w = line.words[wi];
            const cleanText = w.text.toLowerCase().replace(/[^a-z]/g, '');

            // 1. Name field
            if (/^(?:name|customer|patient|buyer)$/i.test(cleanText)) {
              // The value starts after this word
              const valX = w.bbox.x + w.bbox.width + 6;
              const valW = Math.min(rightMargin - valX, 230);
              const valH = Math.max(w.bbox.height + 6, 22);
              const valY = w.bbox.y - 2;

              fieldDetections.push({
                type: 'name',
                label: w.text,
                reason: 'form_field_anchor:name',
                bbox: { x: valX, y: valY, width: valW, height: valH }
              });
            }

            // 2. Mobile / Phone field
            if (/^(?:mob|mod|mobile|phone|contact|tel)$/i.test(cleanText)) {
              let nextW = line.words[wi + 1];
              let startX = w.bbox.x + w.bbox.width + 6;
              if (nextW && /^(?:no|num)$/i.test(nextW.text.toLowerCase().replace(/[^a-z]/g, ''))) {
                startX = nextW.bbox.x + nextW.bbox.width + 6;
              }
              const valW = Math.min(rightMargin - startX, 240);
              const valH = Math.max(w.bbox.height + 6, 22);
              const valY = w.bbox.y - 2;

              fieldDetections.push({
                type: 'phone',
                label: w.text,
                reason: 'form_field_anchor:phone',
                bbox: { x: startX, y: valY, width: valW, height: valH }
              });
            }

            // 3. IMEI / Serial field
            if (/^(?:imei|serial|model)$/i.test(cleanText)) {
              let nextW = line.words[wi + 1];
              let startX = w.bbox.x + w.bbox.width + 6;
              if (nextW && /^(?:no|num)$/i.test(nextW.text.toLowerCase().replace(/[^a-z]/g, ''))) {
                startX = nextW.bbox.x + nextW.bbox.width + 6;
              }
              const valW = Math.min(rightMargin - startX, 250);
              const valH = Math.max(w.bbox.height + 6, 22);
              const valY = w.bbox.y - 2;

              fieldDetections.push({
                type: cleanText === 'model' ? 'device_model' : 'device_id',
                label: w.text,
                reason: `form_field_anchor:${cleanText}`,
                bbox: { x: startX, y: valY, width: valW, height: valH }
              });
            }

            // 4. Signature field
            if (/^(?:signature|signatory|sign)$/i.test(cleanText)) {
              // Expand upward to cover signature ink
              const sigX = Math.max(billX + 5, w.bbox.x - 30);
              const sigY = Math.max(billY + 5, w.bbox.y - 50);
              const sigW = Math.min(rightMargin - sigX, w.bbox.width + 90);
              const sigH = 60;

              fieldDetections.push({
                type: 'signature',
                label: w.text,
                reason: 'form_field_anchor:signature',
                bbox: { x: sigX, y: sigY, width: sigW, height: sigH }
              });
            }
          }
        }

        // Draw redactions on original image canvas
        const finalCanvas = document.createElement('canvas');
        finalCanvas.width = img.width;
        finalCanvas.height = img.height;
        const fCtx = finalCanvas.getContext('2d');
        fCtx.drawImage(img, 0, 0);

        fCtx.fillStyle = '#000000';
        for (const fd of fieldDetections) {
          fCtx.fillRect(fd.bbox.x, fd.bbox.y, fd.bbox.width, fd.bbox.height);
        }

        await fetch('http://localhost:8995/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fieldDetections,
            lines: lines.map(l => l.text),
            redactedDataUrl: finalCanvas.toDataURL('image/png')
          })
        });

      } catch (err) {
        await fetch('http://localhost:8995/results', {
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

with open('scratch/anchor_test.html', 'w', encoding='utf-8') as f:
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
    f'http://localhost:{PORT}/scratch/anchor_test.html'
]

proc = subprocess.Popen(chrome_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

for i in range(30):
    if results_received is not None:
        break
    time.sleep(1)

proc.terminate()
server.shutdown()

if results_received and 'redactedDataUrl' in results_received:
    import base64
    header, encoded = results_received['redactedDataUrl'].split(',', 1)
    data = base64.b64decode(encoded)
    with open('scratch/redacted_bill_output.png', 'wb') as f:
        f.write(data)
    print("Saved scratch/redacted_bill_output.png successfully!")
    print("\nField Detections:")
    for fd in results_received['fieldDetections']:
        print(f"  [{fd['type']}] Label: '{fd['label']}', bbox: {fd['bbox']}")
else:
    print("Error:", results_received)
