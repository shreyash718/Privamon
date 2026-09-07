import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

PORT = 8992
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
  <script src="/privacy/pii-detector.js"></script>
</head>
<body>
  <h1>Anchor Value Verification</h1>
  <script>
    function detectFormFieldAnchors(ocrWords, regionBbox) {
      if (!ocrWords || !ocrWords.length) return [];
      const anchors = [];
      const rightEdge = regionBbox.x + regionBbox.width - 5;

      // Group words into approximate lines by Y coordinate
      const lines = [];
      const sorted = [...ocrWords].sort((a, b) => a.bbox.y - b.bbox.y);
      for (const item of sorted) {
        const itemMidY = item.bbox.y + item.bbox.height / 2;
        let placed = false;
        for (const line of lines) {
          const lineMidY = line.reduce((sum, w) => sum + (w.bbox.y + w.bbox.height / 2), 0) / line.length;
          const avgH = line.reduce((sum, w) => sum + w.bbox.height, 0) / line.length;
          if (Math.abs(itemMidY - lineMidY) < avgH * 0.55) {
            line.push(item);
            placed = true;
            break;
          }
        }
        if (!placed) lines.push([item]);
      }

      for (const line of lines) {
        line.sort((a, b) => a.bbox.x - b.bbox.x);
        for (let wi = 0; wi < line.length; wi++) {
          const w = line[wi];
          const clean = w.text.toLowerCase().replace(/[^a-z]/g, '');

          // 1. Name field anchor
          if (/^(?:name|customer|patient|buyer)$/i.test(clean)) {
            const startX = w.bbox.x + w.bbox.width + 4;
            const subsequentWords = line.filter(other => other.bbox.x > w.bbox.x + w.bbox.width + 2);
            let valW = 230;
            if (subsequentWords.length > 0) {
              const maxRight = Math.max(...subsequentWords.map(sw => sw.bbox.x + sw.bbox.width));
              valW = Math.max(valW, maxRight - startX + 10);
            }
            valW = Math.min(rightEdge - startX, valW);
            anchors.push({
              type: 'name',
              text: 'Customer Name (Handwritten Field)',
              confidence: 0.98,
              decision: 'REDACT',
              reason: 'form_field_anchor:name',
              bbox: { x: startX, y: w.bbox.y - 3, width: Math.max(80, valW), height: Math.max(w.bbox.height + 8, 26) }
            });
          }

          // 2. Mobile / Phone field anchor
          if (/^(?:mob|mod|mobile|phone|contact|tel)$/i.test(clean)) {
            let nextW = line[wi + 1];
            let refW = w;
            if (nextW && /^(?:no|num)$/i.test(nextW.text.toLowerCase().replace(/[^a-z]/g, ''))) {
              refW = nextW;
            }
            const startX = refW.bbox.x + refW.bbox.width + 4;
            const subsequentWords = line.filter(other => other.bbox.x > refW.bbox.x + refW.bbox.width + 2);
            let valW = 240;
            if (subsequentWords.length > 0) {
              const maxRight = Math.max(...subsequentWords.map(sw => sw.bbox.x + sw.bbox.width));
              valW = Math.max(valW, maxRight - startX + 10);
            }
            valW = Math.min(rightEdge - startX, valW);
            anchors.push({
              type: 'phone',
              text: 'Mobile Number (Handwritten Field)',
              confidence: 0.98,
              decision: 'REDACT',
              reason: 'form_field_anchor:phone',
              bbox: { x: startX, y: refW.bbox.y - 3, width: Math.max(80, valW), height: Math.max(refW.bbox.height + 8, 26) }
            });
          }

          // 3. IMEI / Serial field anchor
          if (/^(?:imei|ime|serial|sr)$/i.test(clean)) {
            let nextW = line[wi + 1];
            let refW = w;
            if (nextW && /^(?:no|num)$/i.test(nextW.text.toLowerCase().replace(/[^a-z]/g, ''))) {
              refW = nextW;
            }
            const startX = refW.bbox.x + refW.bbox.width + 4;
            const subsequentWords = line.filter(other => other.bbox.x > refW.bbox.x + refW.bbox.width + 2);
            let valW = 260;
            if (subsequentWords.length > 0) {
              const maxRight = Math.max(...subsequentWords.map(sw => sw.bbox.x + sw.bbox.width));
              valW = Math.max(valW, maxRight - startX + 10);
            }
            valW = Math.min(rightEdge - startX, valW);
            anchors.push({
              type: 'device_id',
              text: 'Device IMEI (Handwritten Field)',
              confidence: 0.98,
              decision: 'REDACT',
              reason: 'form_field_anchor:imei',
              bbox: { x: startX, y: refW.bbox.y - 3, width: Math.max(80, valW), height: Math.max(refW.bbox.height + 8, 26) }
            });
          }

          // 4. Signature anchors
          if (clean.includes('signature') || clean.includes('signatory') || (clean === 'sign' && line.length <= 4)) {
            const sigX = Math.max(regionBbox.x + 5, w.bbox.x - 30);
            const sigY = Math.max(regionBbox.y + 5, w.bbox.y - 48);
            const sigW = Math.min(rightEdge - sigX, w.bbox.width + 90);
            anchors.push({
              type: 'signature',
              text: 'Handwritten Signature Ink',
              confidence: 0.95,
              decision: 'REDACT',
              reason: 'form_field_anchor:signature',
              bbox: { x: sigX, y: sigY, width: Math.max(100, sigW), height: 55 }
            });
          }
        }
      }

      return anchors;
    }

    async function run() {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise(r => { img.onload = r; img.src = '/scratch/bill.png'; });

        const billX = 460;
        const billY = 0;
        const billW = 370;
        const billH = 515;
        const billBbox = { x: billX, y: billY, width: billW, height: billH };

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
        const ocrWords = (res.data.words || []).map(w => ({
          text: w.text.trim(),
          confidence: w.confidence,
          bbox: {
            x: billX + Math.round(w.bbox.x0 * invScale),
            y: billY + Math.round(w.bbox.y0 * invScale),
            width: Math.round((w.bbox.x1 - w.bbox.x0) * invScale),
            height: Math.round((w.bbox.y1 - w.bbox.y0) * invScale),
          }
        })).filter(w => w.text);

        const anchors = detectFormFieldAnchors(ocrWords, billBbox);

        // Also detect GSTIN and phones
        const textFull = res.data.text;
        const piiDetections = Privamon.PIIDetector.detectPII(textFull, '', 'ocr');

        // Draw solid black on canvas
        const outCanvas = document.createElement('canvas');
        outCanvas.width = img.width;
        outCanvas.height = img.height;
        const outCtx = outCanvas.getContext('2d');
        outCtx.drawImage(img, 0, 0);

        outCtx.fillStyle = '#000000';
        for (const a of anchors) {
          outCtx.fillRect(a.bbox.x, a.bbox.y, a.bbox.width, a.bbox.height);
        }

        // Add phone number at top right
        for (const w of ocrWords) {
          const digits = w.text.replace(/\\D/g, '');
          if (/903477|989647/.test(digits)) {
            outCtx.fillRect(w.bbox.x - 2, w.bbox.y - 2, w.bbox.width + 4, w.bbox.height + 4);
          }
        }

        await fetch('http://localhost:8992/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            anchors,
            redactedDataUrl: outCanvas.toDataURL('image/png')
          })
        });

      } catch (err) {
        await fetch('http://localhost:8992/results', {
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

with open('scratch/anchor_value_test.html', 'w', encoding='utf-8') as f:
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
    f'http://localhost:{PORT}/scratch/anchor_value_test.html'
]

proc = subprocess.Popen(chrome_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

for i in range(35):
    if results_received is not None:
        break
    time.sleep(1)

proc.terminate()
server.shutdown()

if results_received and 'anchors' in results_received:
    print("SUCCESS: Anchors detected:")
    for a in results_received['anchors']:
        print(f"  [{a['type']}] '{a['text']}' at {a['bbox']}")

    import base64
    header, encoded = results_received['redactedDataUrl'].split(',', 1)
    data = base64.b64decode(encoded)
    with open('scratch/final_redacted_bill.png', 'wb') as f:
        f.write(data)
    print("Saved scratch/final_redacted_bill.png successfully!")
else:
    print("Failed:", results_received)
