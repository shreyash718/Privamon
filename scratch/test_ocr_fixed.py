import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

PORT = 8980
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
  <script src="/lib/tesseract/tesseract.min.js"></script>
  <script src="/content/dom-range-mapper.js"></script>
  <script src="/privacy/coordinate-mapper.js"></script>
  <script src="/privacy/pii-detector.js"></script>
  <script src="/privacy/pii-classifier.js"></script>
  <script src="/privacy/ner-engine.js"></script>
  <script src="/privacy/fusion.js"></script>
  <script src="/privacy/redactor.js"></script>
  <script src="/privacy/verifier.js"></script>
  <script src="/vision/ocr-engine.js"></script>
  <script src="/pipeline/sanitize-pipeline.js"></script>
</head>
<body>
  <canvas id="ocr-doc-en" width="680" height="360"></canvas>
  <canvas id="ocr-doc-hi" width="680" height="360"></canvas>
  <img id="ocr-img-hi" width="680" height="360">

  <script>
    async function sendResult(payload) {
      await fetch('http://localhost:8980/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    window.onerror = function(msg, url, line) {
      sendResult({ error: msg + ' at ' + url + ':' + line });
    };

    // Apply the proposed fixes dynamically to the in-memory Privamon modules for validation
    function applyFixes() {
      // 1. Add hindi_name and address_labeled and update name_labeled in Privamon.PIIDetector
      // We can patch Privamon.PIIDetector.PATTERNS if accessible, or patch detectPII
      const origDetectPII = Privamon.PIIDetector.detectPII;

      const nameLabeledRegex = /\\b(?:(?:नाम(?:\\s*\\/\\s*name)?|name|customer[^\\S\\r\\n]*name|patient[^\\S\\r\\n]*name|buyer[^\\S\\r\\n]*name|holder[^\\S\\r\\n]*name|m\\/s|shri|smt|mr\\.)\\s*[:.\\-_=~*\\/]?\\s*|client\\s*name\\s*[:.\\-_=~*]?\\s*|client\\s*[:=]\\s*)([a-zA-Z\\u0900-\\u097F][a-zA-Z0-9\\u0900-\\u097F\\.\\'\\-]+(?:[^\\S\\r\\n]+[a-zA-Z\\u0900-\\u097F\\.\\'\\-]+){0,3})/gui;
      const addressLabeledRegex = /(?:पता(?:\\s*\\/\\s*address)?|(?<!email\\s)(?<!e-mail\\s)\\baddress)\\s*[:.\\-_=~*\\/]\\s*([^\\n\\r]{5,80})/gi;
      const hindiNameRegex = /\\b(?:राहुल|प्रिया|अमित|अंजलि|रोहित|पूजा|विकास|नेहा|सुनील|दीपक|संजय|राजेश|अजय|मनोज|सुरेश|अनिल|राकेश|संदीप|मनीष|कविता|सुनीता|अनीता|रेखा|रीता|आरती|सपना|रेनू|किरण|निशा|मीना|स्वाति|पूनम|शिल्पा|मोनिका)(?:[^\\S\\r\\n]+(?:वर्मा|शर्मा|गुप्ता|सिंह|कुमार|यादव|मिश्रा|तिवारी|पांडेय|चौहान|चौधरी|जोशी|मेहता|शाह|पटेल|रेड्डी|नायर|अय्यर|दास|मुखर्जी|बोस|घोष|सेन|दत्ता|रॉय|जैन|बंसल|गोयल|मित्तल|सिंघल|गर्ग|भाटिया|अरोड़ा|कपूर|मल्होत्रा|खन्ना|चोपड़ा|सेठी|ग्रोवर|आहूजा|मलिक|गिल|धिल्लों|संधू|ग्रेवाल|सिद्धू|मान))?\\b/gu;

      Privamon.PIIDetector.detectPII = function(text, nearbyContext = '', source = 'dom') {
        const rawDets = origDetectPII(text, nearbyContext, source);

        // Filter out false positives from person_name_context (Email Address, Tokens, Side, etc.)
        const filtered = rawDets.filter(d => {
          if (d.patternName === 'person_name_context') {
            const lower = d.text.toLowerCase().trim();
            if (['email', 'email address', 'tokens', 'token', 'side', 'ocr', 'validation', 'verhoeff-valid', 'verhoeff', 'valid'].includes(lower)) {
              return false;
            }
          }
          if (d.patternName === 'name_labeled') {
            const lower = d.text.toLowerCase().trim();
            if (lower.includes('side ocr') || lower.includes('ocr validation') || lower === 'side') {
              return false;
            }
          }
          return true;
        });

        // Add Hindi Name matches
        let m;
        hindiNameRegex.lastIndex = 0;
        while ((m = hindiNameRegex.exec(text)) !== null) {
          const val = m[0].trim();
          filtered.push({
            type: 'name',
            patternName: 'hindi_name',
            text: val,
            span: { start: m.index, end: m.index + val.length },
            confidence: 0.95,
            checksumValidated: false
          });
        }

        // Add Labeled Address matches
        addressLabeledRegex.lastIndex = 0;
        while ((m = addressLabeledRegex.exec(text)) !== null) {
          const val = m[1].trim();
          const start = m.index + m[0].indexOf(val);
          filtered.push({
            type: 'location',
            patternName: 'address_labeled',
            text: val,
            span: { start, end: start + val.length },
            confidence: 0.90,
            checksumValidated: false
          });
        }

        return filtered;
      };

      // 2. Patch detectFormFieldAnchors in Privamon.OCREngine:
      // Don't create signature_slot if no signature keyword exists.
      // Don't create handwritten name anchor if name was already detected by OCR.
      const origProcessRegions = Privamon.OCREngine.processRegions;
      // We can also patch directly in ocr-engine.js code
    }

    async function run() {
      try {
        applyFixes();

        // 1. Render English Document Canvas
        const canvasEn = document.getElementById('ocr-doc-en');
        const ctxEn = canvasEn.getContext('2d');
        ctxEn.fillStyle = '#ffffff';
        ctxEn.fillRect(0, 0, 680, 360);
        ctxEn.fillStyle = '#1e3a8a';
        ctxEn.fillRect(0, 0, 680, 56);
        ctxEn.fillStyle = '#ffffff';
        ctxEn.font = 'bold 20px sans-serif';
        ctxEn.fillText('SYNTHETIC IDENTITY VERIFICATION SLIP', 24, 36);
        ctxEn.fillStyle = '#111827';
        ctxEn.font = 'bold 16px sans-serif';
        ctxEn.fillText('OFFICIAL IDENTITY RECORD (NON-REAL TEST DATA)', 24, 90);

        ctxEn.font = '15px sans-serif';
        ctxEn.fillStyle = '#374151';
        ctxEn.fillText('Full Name:', 24, 130);
        ctxEn.font = 'bold 16px sans-serif';
        ctxEn.fillStyle = '#000000';
        ctxEn.fillText('Priya Sharma', 180, 130);

        ctxEn.font = '15px sans-serif';
        ctxEn.fillStyle = '#374151';
        ctxEn.fillText('Email Address:', 24, 170);
        ctxEn.font = 'bold 16px sans-serif';
        ctxEn.fillStyle = '#000000';
        ctxEn.fillText('priya.sharma@example-synthetic.org', 180, 170);

        ctxEn.font = '15px sans-serif';
        ctxEn.fillStyle = '#374151';
        ctxEn.fillText('Contact Mobile:', 24, 210);
        ctxEn.font = 'bold 16px sans-serif';
        ctxEn.fillStyle = '#000000';
        ctxEn.fillText('+91 98765 43210', 180, 210);

        ctxEn.font = '15px sans-serif';
        ctxEn.fillStyle = '#374151';
        ctxEn.fillText('Aadhaar Number:', 24, 250);
        ctxEn.font = 'bold 16px monospace';
        ctxEn.fillStyle = '#000000';
        ctxEn.fillText('5678 9012 3458', 180, 250);

        ctxEn.font = '15px sans-serif';
        ctxEn.fillStyle = '#374151';
        ctxEn.fillText('Permanent Account (PAN):', 24, 290);
        ctxEn.font = 'bold 16px monospace';
        ctxEn.fillStyle = '#000000';
        ctxEn.fillText('ABCPE5678G', 260, 290);

        ctxEn.fillStyle = '#4b5563';
        ctxEn.font = '13px sans-serif';
        ctxEn.fillText('Verification Code: Order ID: 9876543210 | Issue Date: 15/09/2026', 24, 335);

        // 2. Render Hindi Document Canvas
        const canvasHi = document.getElementById('ocr-doc-hi');
        const imgHi = document.getElementById('ocr-img-hi');
        const ctxHi = canvasHi.getContext('2d');
        ctxHi.fillStyle = '#ffffff';
        ctxHi.fillRect(0, 0, 680, 360);
        ctxHi.fillStyle = '#ea580c';
        ctxHi.fillRect(0, 0, 680, 24);
        ctxHi.fillStyle = '#1e3a8a';
        ctxHi.fillRect(0, 24, 680, 38);
        ctxHi.fillStyle = '#ffffff';
        ctxHi.font = 'bold 18px sans-serif';
        ctxHi.fillText('भारत सरकार / GOVERNMENT OF INDIA', 24, 49);
        ctxHi.fillStyle = '#111827';
        ctxHi.font = 'bold 16px sans-serif';
        ctxHi.fillText('नागरिक पहचान पत्र / CITIZEN IDENTITY CARD', 24, 95);

        ctxHi.font = '15px sans-serif';
        ctxHi.fillStyle = '#374151';
        ctxHi.fillText('नाम / Name:', 24, 135);
        ctxHi.font = 'bold 17px sans-serif';
        ctxHi.fillStyle = '#000000';
        ctxHi.fillText('राहुल वर्मा (Rahul Verma)', 190, 135);

        ctxHi.font = '15px sans-serif';
        ctxHi.fillStyle = '#374151';
        ctxHi.fillText('पहचान पत्र / PAN:', 24, 175);
        ctxHi.font = 'bold 16px monospace';
        ctxHi.fillStyle = '#000000';
        ctxHi.fillText('XYZPC9876L', 190, 175);

        ctxHi.font = '15px sans-serif';
        ctxHi.fillStyle = '#374151';
        ctxHi.fillText('मोबाइल / Mobile:', 24, 215);
        ctxHi.font = 'bold 16px monospace';
        ctxHi.fillStyle = '#000000';
        ctxHi.fillText('91234 56789', 190, 215);

        ctxHi.font = '15px sans-serif';
        ctxHi.fillStyle = '#374151';
        ctxHi.fillText('आधार / Aadhaar:', 24, 255);
        ctxHi.font = 'bold 17px monospace';
        ctxHi.fillStyle = '#000000';
        ctxHi.fillText('2345 6789 0124', 190, 255);

        ctxHi.font = '15px sans-serif';
        ctxHi.fillStyle = '#374151';
        ctxHi.fillText('पता / Address:', 24, 295);
        ctxHi.font = '15px sans-serif';
        ctxHi.fillStyle = '#000000';
        ctxHi.fillText('१२३ सिविल लाइन्स, नई दिल्ली (123 Civil Lines, New Delhi)', 190, 295);

        imgHi.src = canvasHi.toDataURL('image/png');
        await new Promise(r => { imgHi.onload = r; });

        await Privamon.OCREngine.initialize();

        const mockMapper = {
          mapBbox: (b) => ({ ...b }),
          info: { scaleX: 1, scaleY: 1 }
        };

        const resEn = await Privamon.OCREngine.processRegions(
          canvasEn.toDataURL('image/png'),
          [{ regionId: 'canvas_en', bbox: { x: 0, y: 0, width: 680, height: 360 }, tag: 'CANVAS' }],
          mockMapper
        );

        const resHi = await Privamon.OCREngine.processRegions(
          canvasHi.toDataURL('image/png'),
          [{ regionId: 'img_hi', bbox: { x: 0, y: 0, width: 680, height: 360 }, tag: 'IMG' }],
          mockMapper
        );

        // Filter out form_field_anchor:name when name already exists
        const filterAnchors = (dets) => {
          const hasName = dets.some(d => d.type === 'name' && !d.reason?.startsWith('form_field_anchor'));
          return dets.filter(d => {
            if (d.reason === 'form_field_anchor:signature_slot') return false;
            if (hasName && d.reason === 'form_field_anchor:name') return false;
            return true;
          });
        };

        const finalEn = filterAnchors(resEn.detections);
        const finalHi = filterAnchors(resHi.detections);

        const fusedEn = Privamon.PIIFusion.fuse(finalEn);
        const fusedHi = Privamon.PIIFusion.fuse(finalHi);

        await Privamon.OCREngine.terminate();

        await sendResult({
          enRedactions: fusedEn.redactions.map(r => ({ type: r.type, text: r.text, reason: r.reason, bbox: r.bbox })),
          hiRedactions: fusedHi.redactions.map(r => ({ type: r.type, text: r.text, reason: r.reason, bbox: r.bbox }))
        });
      } catch (err) {
        await sendResult({ error: err.stack || err.message });
      }
    }

    window.onload = run;
  </script>
</body>
</html>
"""

def main():
    global results_received
    os.makedirs('scratch', exist_ok=True)
    with open('scratch/test_ocr_fixed.html', 'w', encoding='utf-8') as f:
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
        f'http://localhost:{PORT}/scratch/test_ocr_fixed.html'
    ]
    
    proc = subprocess.Popen(chrome_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    start_time = time.time()
    while results_received is None and time.time() - start_time < 35:
        time.sleep(0.3)

    proc.terminate()
    server.shutdown()

    if results_received:
        if 'error' in results_received:
            print("ERROR:", results_received['error'])
        else:
            print("\n=== ENGLISH CANVAS REDACTIONS ===")
            for r in results_received.get('enRedactions', []):
                print(f" - [{r['type']}] '{r['text']}' bbox={r['bbox']} reason={r['reason']}")

            print("\n=== HINDI IMAGE REDACTIONS ===")
            for r in results_received.get('hiRedactions', []):
                print(f" - [{r['type']}] '{r['text']}' bbox={r['bbox']} reason={r['reason']}")
    else:
        print("Timed out waiting for results")

if __name__ == '__main__':
    main()
