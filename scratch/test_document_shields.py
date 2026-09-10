import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

PORT = 8993
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
  <title>All Identity Documents Shield Verification</title>
  <style>
    body {
      margin: 0;
      padding: 20px;
      background: #111;
      color: #eee;
      font-family: sans-serif;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, 520px);
      gap: 20px;
      justify-content: center;
    }
    canvas {
      background: #fff;
      border-radius: 6px;
      display: block;
    }
  </style>
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
  <h1>Privamon Document Shield Verification</h1>
  <div class="grid">
    <div>
      <h3>1. PAN Card (Permanent Account Number)</h3>
      <canvas id="pan-canvas" width="480" height="300"></canvas>
    </div>
    <div>
      <h3>2. Voter ID (Election Commission of India)</h3>
      <canvas id="voter-canvas" width="480" height="300"></canvas>
    </div>
    <div>
      <h3>3. Indian Passport</h3>
      <canvas id="passport-canvas" width="480" height="300"></canvas>
    </div>
    <div>
      <h3>4. Driving Licence</h3>
      <canvas id="dl-canvas" width="480" height="300"></canvas>
    </div>
  </div>

  <script>
    window.addEventListener('DOMContentLoaded', async () => {
      // 1. Render PAN Card
      const panCvs = document.getElementById('pan-canvas');
      const panCtx = panCvs.getContext('2d');
      panCtx.fillStyle = '#e0f2fe'; // Light blue tone
      panCtx.fillRect(0, 0, 480, 300);
      panCtx.fillStyle = '#0369a1';
      panCtx.fillRect(0, 0, 480, 45);
      panCtx.fillStyle = '#ffffff';
      panCtx.font = 'bold 15px sans-serif';
      panCtx.fillText('आयकर विभाग / INCOME TAX DEPARTMENT', 20, 28);
      panCtx.fillStyle = '#000000';
      panCtx.font = 'bold 13px sans-serif';
      panCtx.fillText('GOVT. OF INDIA', 20, 65);
      panCtx.font = '13px sans-serif';
      panCtx.fillText('Name: VIKRAM RAJESH SHARMA', 20, 105);
      panCtx.fillText('Father Name: RAJESH SHARMA', 20, 135);
      panCtx.fillText('Date of Birth: 15/04/1988', 20, 165);
      panCtx.font = 'bold 14px sans-serif';
      panCtx.fillText('Permanent Account Number', 20, 205);
      panCtx.font = 'bold 18px monospace';
      panCtx.fillText('ABCPS1234F', 20, 235);

      // 2. Render Voter ID Card
      const voterCvs = document.getElementById('voter-canvas');
      const voterCtx = voterCvs.getContext('2d');
      voterCtx.fillStyle = '#f8fafc';
      voterCtx.fillRect(0, 0, 480, 300);
      voterCtx.fillStyle = '#1e293b';
      voterCtx.fillRect(0, 0, 480, 40);
      voterCtx.fillStyle = '#ffffff';
      voterCtx.font = 'bold 15px sans-serif';
      voterCtx.fillText('भारत निर्वाचन आयोग / ELECTION COMMISSION OF INDIA', 15, 26);
      voterCtx.fillStyle = '#000000';
      voterCtx.font = 'bold 14px sans-serif';
      voterCtx.fillText('ELECTOR PHOTO IDENTITY CARD', 20, 70);
      voterCtx.font = 'bold 16px monospace';
      voterCtx.fillText('EPIC NO: WBF1234567', 20, 105);
      voterCtx.font = '13px sans-serif';
      voterCtx.fillText('Elector Name: ANITA VERMA', 20, 145);
      voterCtx.fillText('Father Name: RAMESH VERMA', 20, 175);
      voterCtx.fillText('Gender: FEMALE', 20, 205);
      voterCtx.fillText('Age: 29', 20, 235);

      // 3. Render Indian Passport
      const passCvs = document.getElementById('passport-canvas');
      const passCtx = passCvs.getContext('2d');
      passCtx.fillStyle = '#fffbeb';
      passCtx.fillRect(0, 0, 480, 300);
      passCtx.fillStyle = '#78350f';
      passCtx.fillRect(0, 0, 480, 40);
      passCtx.fillStyle = '#ffffff';
      passCtx.font = 'bold 16px sans-serif';
      passCtx.fillText('REPUBLIC OF INDIA / भारत गणराज्य', 25, 26);
      passCtx.fillStyle = '#000000';
      passCtx.font = 'bold 15px sans-serif';
      passCtx.fillText('PASSPORT / पासपोर्ट', 25, 70);
      passCtx.font = '13px sans-serif';
      passCtx.fillText('Type: P  |  Country Code: IND  |  Passport No: Z1234567', 25, 105);
      passCtx.fillText('Surname: PATEL', 25, 135);
      passCtx.fillText('Given Name: HARSHIL', 25, 160);
      passCtx.fillText('Nationality: INDIAN', 25, 185);
      passCtx.fillText('Date of Birth: 22/11/1992', 25, 210);
      passCtx.font = '11px monospace';
      passCtx.fillText('P<INDPATEL<<HARSHIL<<<<<<<<<<<<<<<<<<<<<<<<<<', 25, 260);

      // 4. Render Driving Licence
      const dlCvs = document.getElementById('dl-canvas');
      const dlCtx = dlCvs.getContext('2d');
      dlCtx.fillStyle = '#f0fdf4';
      dlCtx.fillRect(0, 0, 480, 300);
      dlCtx.fillStyle = '#14532d';
      dlCtx.fillRect(0, 0, 480, 40);
      dlCtx.fillStyle = '#ffffff';
      dlCtx.font = 'bold 15px sans-serif';
      dlCtx.fillText('UNION OF INDIA / TRANSPORT DEPARTMENT', 20, 26);
      dlCtx.fillStyle = '#000000';
      dlCtx.font = 'bold 15px sans-serif';
      dlCtx.fillText('DRIVING LICENCE', 20, 70);
      dlCtx.font = 'bold 14px monospace';
      dlCtx.fillText('DL NO: DL-0420110012345', 20, 100);
      dlCtx.font = '13px sans-serif';
      dlCtx.fillText('Name: ROHIT GUPTA', 20, 135);
      dlCtx.fillText('Date of Birth: 05/06/1995', 20, 165);
      dlCtx.fillText('Valid Till: 04/06/2035', 20, 195);
      dlCtx.fillText('Authorisation to Drive: LMV, MCWG', 20, 225);

      await new Promise(r => setTimeout(r, 600));

      // Extract DOM
      const resp = await fetch('/content/dom-extractor.js');
      const code = await resp.text();
      const domData = eval(code);

      // Build screenshot
      const sw = window.innerWidth;
      const sh = window.innerHeight;
      const sCanvas = document.createElement('canvas');
      sCanvas.width = sw;
      sCanvas.height = sh;
      const sCtx = sCanvas.getContext('2d');
      sCtx.fillStyle = '#111111';
      sCtx.fillRect(0, 0, sw, sh);

      for (const c of [panCvs, voterCvs, passCvs, dlCvs]) {
        const rc = c.getBoundingClientRect();
        sCtx.drawImage(c, rc.left, rc.top);
      }

      const screenshotDataUrl = sCanvas.toDataURL('image/png');

      const result = await Privamon.SanitizePipeline.run({
        screenshot: screenshotDataUrl,
        domData: domData,
        onProgress: (stage, status, msg) => console.log(`[Stage ${stage}] ${msg}`)
      });

      const payload = {
        detections: (result.detections || []).map(d => ({
          type: d.type, text: d.text, reason: d.reason, conf: d.confidence, decision: d.decision, bbox: d.bbox
        })),
        redactions: (result.redactions || []).map(r => ({
          type: r.type, text: r.text, reason: r.reason, conf: r.confidence, bbox: r.bbox
        }))
      };

      await fetch('http://localhost:8993/results', {
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
    with open('scratch/test_document_shields.html', 'w', encoding='utf-8') as f:
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
        f'http://localhost:{PORT}/scratch/test_document_shields.html'
    ]

    proc = subprocess.Popen(chrome_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    start_time = time.time()
    while results_received is None and time.time() - start_time < 50:
        time.sleep(0.5)

    proc.terminate()
    server.shutdown()

    if results_received:
        print("\n=== DOCUMENT SHIELDS DETECTIONS ===")
        doc_shields = []
        for d in results_received.get('detections', []):
            if d['type'] == 'identity_document':
                doc_shields.append(d)
                print(f" [SHIELD] '{d['text']}' reason={d['reason']} dec={d['decision']} conf={d['conf']} bbox={d['bbox']}")
            else:
                print(f" - [{d['type']}] '{d['text']}' reason={d['reason']} dec={d['decision']}")

        print(f"\nTotal Identity Document Shields Activated: {len(doc_shields)}")
        shield_reasons = [d['reason'] for d in doc_shields]
        print(f"Shield Reasons: {shield_reasons}")
    else:
        print("Timed out waiting for results")

if __name__ == '__main__':
    main()
