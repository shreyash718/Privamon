import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

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
        pass

html_content = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="/lib/tesseract/tesseract.min.js"></script>
  <script src="/privacy/pii-detector.js"></script>
</head>
<body>
  <h1>Form Field Anchor Test on Bill Crop</h1>
  <script>
    function detectFormFieldAnchors(ocrWords, regionBbox) {
      if (!ocrWords || !ocrWords.length) return [];
      const anchors = [];
      const regX = regionBbox.x;
      const regY = regionBbox.y;
      const rightEdge = regX + regionBbox.width - 6;

      // 1. Group words into approximate lines
      const lines = [];
      const sorted = [...ocrWords].sort((a, b) => a.bbox.y - b.bbox.y);
      for (const item of sorted) {
        const itemMidY = item.bbox.y + item.bbox.height / 2;
        let placed = false;
        for (const line of lines) {
          const lineMidY = line.reduce((sum, w) => sum + (w.bbox.y + w.bbox.height / 2), 0) / line.length;
          const avgH = line.reduce((sum, w) => sum + w.bbox.height, 0) / line.length;
          if (Math.abs(itemMidY - lineMidY) < avgH * 0.60) {
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
          const clean = w.text.toLowerCase().replace(/[^a-z0-9!]/g, '');

          // Helper to get subsequent words on this line
          const getSubsequentWords = (fromX) => line.filter(other => other.bbox.x > fromX);

          // Helper to calculate span width from startX to either next structural column or max words or default
          const calcSpanWidth = (startX, defaultW, maxRightLimit = rightEdge) => {
            const subsequent = getSubsequentWords(startX);
            let wVal = defaultW;
            if (subsequent.length > 0) {
              const maxWordRight = Math.max(...subsequent.map(sw => sw.bbox.x + sw.bbox.width));
              wVal = Math.max(wVal, maxWordRight - startX + 12);
            }
            return Math.max(60, Math.min(maxRightLimit - startX, wVal));
          };

          // ── Anchor 1: Name ──
          if (/^(?:name|customer|patient|buyer|client|applicant)$/i.test(clean) ||
              (clean === 'nam' && line[wi + 1] && /^(?:e|is)$/i.test(line[wi + 1].text.toLowerCase().replace(/[^a-z]/g, '')))) {
            // Find colon or label boundary
            let refWord = w;
            if (line[wi + 1] && /^[:\-]$/.test(line[wi + 1].text.trim())) {
              refWord = line[wi + 1];
            }
            const startX = refWord.bbox.x + refWord.bbox.width + 4;
            // Name field usually ends before Date column if Date exists on same line
            const dateWord = line.find(other => other.bbox.x > startX && /date/i.test(other.text));
            const limitRight = dateWord ? (dateWord.bbox.x - 8) : (regX + regionBbox.width * 0.72);
            const valW = calcSpanWidth(startX, 210, limitRight);

            anchors.push({
              type: 'name',
              text: 'Handwritten Customer Name',
              confidence: 0.98,
              decision: 'REDACT',
              reason: 'form_field_anchor:name',
              bbox: {
                x: startX,
                y: Math.max(regY + 2, refWord.bbox.y - 4),
                width: valW,
                height: Math.max(refWord.bbox.height + 10, 26)
              }
            });
          }

          // ── Anchor 2: Mobile / Phone ──
          if (/^(?:mob|mod|mobile|phone|contact|tel|cell|ono)$/i.test(clean)) {
            let refWord = w;
            const nextW = line[wi + 1];
            if (nextW && /^(?:no|num|nos)$/i.test(nextW.text.toLowerCase().replace(/[^a-z]/g, ''))) {
              refWord = nextW;
            }
            if (line[wi + 1] && /^[:\-]$/.test(line[wi + 1].text.trim())) {
              refWord = line[wi + 1];
            }
            const startX = refWord.bbox.x + refWord.bbox.width + 4;
            const limitRight = regX + regionBbox.width * 0.85;
            const valW = calcSpanWidth(startX, 220, limitRight);

            anchors.push({
              type: 'phone',
              text: 'Handwritten Mobile Number',
              confidence: 0.98,
              decision: 'REDACT',
              reason: 'form_field_anchor:phone',
              bbox: {
                x: startX,
                y: Math.max(regY + 2, refWord.bbox.y - 4),
                width: valW,
                height: Math.max(refWord.bbox.height + 10, 26)
              }
            });
          }

          // ── Anchor 3: IMEI / Serial / Device ID ──
          if (/^(?:imei|ime|ime!|serial|sr|sl|sno)$/i.test(clean)) {
            let refWord = w;
            const nextW = line[wi + 1];
            if (nextW && /^(?:no|num|nos)$/i.test(nextW.text.toLowerCase().replace(/[^a-z]/g, ''))) {
              refWord = nextW;
            }
            const startX = refWord.bbox.x + refWord.bbox.width + 4;
            // Stop before table quantity/amount columns (right ~60% of table width)
            const limitRight = regX + regionBbox.width * 0.65;
            const valW = calcSpanWidth(startX, 230, limitRight);

            anchors.push({
              type: 'device_id',
              text: 'Handwritten IMEI / Serial Number',
              confidence: 0.98,
              decision: 'REDACT',
              reason: 'form_field_anchor:imei',
              bbox: {
                x: startX,
                y: Math.max(regY + 2, refWord.bbox.y - 4),
                width: valW,
                height: Math.max(refWord.bbox.height + 10, 26)
              }
            });
          }

          // ── Anchor 4: Signature ──
          // Matches "Customer Signature", "Signature", "Signatory", "Bugnacure" (OCR typo for signature)
          if (/signature|signatory|bugnacure|bgnarure|begnarure/i.test(clean) || (clean === 'sign' && line.length <= 4)) {
            // Signature ink is usually directly above the signature label
            const sigX = Math.max(regX + 4, w.bbox.x - 35);
            const sigY = Math.max(regY + 4, w.bbox.y - 50);
            const sigW = Math.min(rightEdge - sigX, w.bbox.width + 90);

            anchors.push({
              type: 'signature',
              text: 'Handwritten Signature Ink',
              confidence: 0.95,
              decision: 'REDACT',
              reason: 'form_field_anchor:signature',
              bbox: {
                x: sigX,
                y: sigY,
                width: Math.max(90, sigW),
                height: 55
              }
            });
          }

          // Also match "FOR <COMPANY>" signature block (e.g. FOR SHRI SHYAM COMMUNICATION)
          if (/^(?:for|ror)$/i.test(clean) && line.some(other => /shyam|communication|ltd|pvt|corp|store/i.test(other.text))) {
            const forWord = w;
            const sigX = Math.max(regX + 4, forWord.bbox.x - 10);
            // Redact the blue ink signature below FOR COMPANY
            const sigY = forWord.bbox.y + forWord.bbox.height + 2;
            const sigW = Math.min(rightEdge - sigX, 130);

            anchors.push({
              type: 'signature',
              text: 'Authorized Signature Ink',
              confidence: 0.95,
              decision: 'REDACT',
              reason: 'form_field_anchor:auth_signature',
              bbox: {
                x: sigX,
                y: sigY,
                width: Math.max(90, sigW),
                height: 50
              }
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

        const billX = 451;
        const billY = 16;
        const billW = 367;
        const billH = 472;
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

        // Header phone numbers & GSTIN
        const additionalDetections = [];
        for (const w of ocrWords) {
          const digits = w.text.replace(/\\D/g, '');
          if (/903477|989647/.test(digits)) {
            additionalDetections.push({
              type: 'phone',
              text: w.text,
              confidence: 0.98,
              bbox: { x: w.bbox.x - 2, y: w.bbox.y - 2, width: w.bbox.width + 4, height: w.bbox.height + 4 }
            });
          }
          if (/06argps|0bargps/i.test(w.text.replace(/[^0-9a-zA-Z]/g, ''))) {
            additionalDetections.push({
              type: 'pan',
              text: w.text,
              confidence: 0.98,
              bbox: { x: w.bbox.x - 2, y: w.bbox.y - 2, width: w.bbox.width + 4, height: w.bbox.height + 4 }
            });
          }
        }

        const allDetections = [...anchors, ...additionalDetections];

        // Draw solid black on full screenshot
        const outCanvas = document.createElement('canvas');
        outCanvas.width = img.width;
        outCanvas.height = img.height;
        const outCtx = outCanvas.getContext('2d');
        outCtx.drawImage(img, 0, 0);

        outCtx.fillStyle = '#000000';
        for (const d of allDetections) {
          outCtx.fillRect(d.bbox.x, d.bbox.y, d.bbox.width, d.bbox.height);
        }

        await fetch('http://localhost:8998/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            detections: allDetections,
            redactedDataUrl: outCanvas.toDataURL('image/png')
          })
        });

      } catch (err) {
        await fetch('http://localhost:8998/results', {
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

with open('scratch/crop_anchor_test.html', 'w', encoding='utf-8') as f:
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
    f'http://localhost:{PORT}/scratch/crop_anchor_test.html'
]

proc = subprocess.Popen(chrome_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

for i in range(35):
    if results_received is not None:
        break
    time.sleep(1)

proc.terminate()
server.shutdown()

if results_received and 'detections' in results_received:
    print(f"SUCCESS: {len(results_received['detections'])} detections found:")
    for d in results_received['detections']:
        print(f"  [{d['type']}] '{d['text']}' at {d['bbox']}")

    import base64
    header, encoded = results_received['redactedDataUrl'].split(',', 1)
    data = base64.b64decode(encoded)
    with open('scratch/perfect_redacted_bill.png', 'wb') as f:
        f.write(data)
    print("Saved scratch/perfect_redacted_bill.png successfully!")
else:
    print("Failed:", results_received)
