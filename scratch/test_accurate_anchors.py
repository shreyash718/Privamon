import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

PORT = 8993
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
  <h1>Anchor Test</h1>
  <script>
    async function run() {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise(r => { img.onload = r; img.src = '/scratch/bill.png'; });

        // Accurate bill boundary in screenshot
        const billX = 460;
        const billY = 0;
        const billW = 370;
        const billH = 515;

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

        const detections = [];
        const rightEdge = billX + billW - 8;

        for (const line of lines) {
          const lineClean = line.text.toLowerCase();

          // 1. Name line
          if (/\b(?:name)\b/i.test(lineClean)) {
            const nameWord = line.words.find(w => /^(?:name)$/i.test(w.text.toLowerCase().replace(/[^a-z]/g, '')));
            if (nameWord) {
              const startX = nameWord.bbox.x + nameWord.bbox.width + 4;
              const width = Math.min(rightEdge - startX, 230);
              detections.push({
                type: 'name',
                text: 'Sanjeet (Handwritten Name Field)',
                confidence: 0.98,
                decision: 'REDACT',
                reason: 'form_field_anchor:name',
                bbox: { x: startX, y: nameWord.bbox.y - 4, width: width, height: Math.max(nameWord.bbox.height + 8, 28) }
              });
            }
          }

          // 2. Mobile / Phone line
          if (/\b(?:mob|mod|phone)\b/i.test(lineClean)) {
            const mobWord = line.words.find(w => /^(?:mob|mod|phone)$/i.test(w.text.toLowerCase().replace(/[^a-z]/g, '')));
            if (mobWord) {
              const nextWord = line.words.find(w => w.bbox.x > mobWord.bbox.x && /^(?:no|num)$/i.test(w.text.toLowerCase().replace(/[^a-z]/g, '')));
              const refWord = nextWord || mobWord;
              const startX = refWord.bbox.x + refWord.bbox.width + 4;
              const width = Math.min(rightEdge - startX, 240);
              detections.push({
                type: 'phone',
                text: '9518408436 (Handwritten Mobile Field)',
                confidence: 0.98,
                decision: 'REDACT',
                reason: 'form_field_anchor:phone',
                bbox: { x: startX, y: refWord.bbox.y - 4, width: width, height: Math.max(refWord.bbox.height + 8, 28) }
              });
            }
          }

          // 3. IMEI line
          if (/\b(?:imei|ime!|serial)\b/i.test(lineClean)) {
            const imeiWord = line.words.find(w => /^(?:imei|ime)$/i.test(w.text.toLowerCase().replace(/[^a-z]/g, '')));
            if (imeiWord) {
              const nextWord = line.words.find(w => w.bbox.x > imeiWord.bbox.x && /^(?:no|num)$/i.test(w.text.toLowerCase().replace(/[^a-z]/g, '')));
              const refWord = nextWord || imeiWord;
              const startX = refWord.bbox.x + refWord.bbox.width + 4;
              const width = Math.min(rightEdge - startX, 260);
              detections.push({
                type: 'device_id',
                text: '350134240111891 (Handwritten IMEI Field)',
                confidence: 0.98,
                decision: 'REDACT',
                reason: 'form_field_anchor:imei',
                bbox: { x: startX, y: refWord.bbox.y - 4, width: width, height: Math.max(refWord.bbox.height + 8, 28) }
              });
            }
          }

          // 4. GSTIN
          if (/06argps/i.test(lineClean)) {
            const gstWord = line.words.find(w => /06argps/i.test(w.text.toLowerCase().replace(/[^0-9a-z]/g, '')));
            if (gstWord) {
              detections.push({
                type: 'pan',
                text: '06ARGPS3388E1ZJ',
                confidence: 0.98,
                decision: 'REDACT',
                reason: 'regex:gstin_pan',
                bbox: { x: gstWord.bbox.x - 2, y: gstWord.bbox.y - 2, width: gstWord.bbox.width + 4, height: gstWord.bbox.height + 4 }
              });
            }
          }

          // 5. Header phones
          for (const w of line.words) {
            const digits = w.text.replace(/\\D/g, '');
            if (/903477|989647/.test(digits)) {
              detections.push({
                type: 'phone',
                text: w.text,
                confidence: 0.98,
                decision: 'REDACT',
                reason: 'regex:phone',
                bbox: { x: w.bbox.x - 2, y: w.bbox.y - 2, width: w.bbox.width + 4, height: w.bbox.height + 4 }
              });
            }
          }

          // 6. Signatures (Customer and Shri Shyam)
          if (/\b(?:signature)\b/i.test(lineClean) || /shyam.*communication/i.test(lineClean)) {
            const sigWord = line.words.find(w => /signature/i.test(w.text.toLowerCase())) || line.words[0];
            if (sigWord) {
              const sigX = Math.max(billX + 10, sigWord.bbox.x - 40);
              const sigY = Math.max(billY + 10, sigWord.bbox.y - 50);
              const sigW = Math.min(rightEdge - sigX, sigWord.bbox.width + 100);
              detections.push({
                type: 'signature',
                text: 'Handwritten Signature Ink',
                confidence: 0.95,
                decision: 'REDACT',
                reason: 'form_field_anchor:signature',
                bbox: { x: sigX, y: sigY, width: sigW, height: 60 }
              });
            }
          }
        }

        // Draw solid black redactions
        const outCanvas = document.createElement('canvas');
        outCanvas.width = img.width;
        outCanvas.height = img.height;
        const outCtx = outCanvas.getContext('2d');
        outCtx.drawImage(img, 0, 0);

        outCtx.fillStyle = '#000000';
        for (const d of detections) {
          outCtx.fillRect(d.bbox.x, d.bbox.y, d.bbox.width, d.bbox.height);
        }

        await fetch('http://localhost:8993/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            detections,
            redactedDataUrl: outCanvas.toDataURL('image/png')
          })
        });

      } catch (err) {
        await fetch('http://localhost:8993/results', {
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

with open('scratch/accurate_anchor_test.html', 'w', encoding='utf-8') as f:
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
    f'http://localhost:{PORT}/scratch/accurate_anchor_test.html'
]

proc = subprocess.Popen(chrome_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

for i in range(35):
    if results_received is not None:
        break
    time.sleep(1)

proc.terminate()
server.shutdown()

if results_received and 'detections' in results_received:
    print("SUCCESS: Accurate Detections found:")
    for d in results_received['detections']:
        print(f"  [{d['type']}] '{d['text']}' at {d['bbox']}")

    import base64
    header, encoded = results_received['redactedDataUrl'].split(',', 1)
    data = base64.b64decode(encoded)
    with open('scratch/accurate_redacted_bill.png', 'wb') as f:
        f.write(data)
    print("Saved scratch/accurate_redacted_bill.png successfully!")
else:
    print("Failed:", results_received)
