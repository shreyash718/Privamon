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
  <script src="/content/dom-range-mapper.js"></script>
  <script src="/privacy/coordinate-mapper.js"></script>
  <script src="/privacy/pii-detector.js"></script>
  <script src="/privacy/fusion.js"></script>
</head>
<body>
  <div id="test1"><strong>Baked English PII Tokens:</strong></div>
  <div id="test2"><strong>Baked Bilingual PII Tokens:</strong></div>
  <div id="test3"><li>Name: <code class="inline-code">Priya Sharma</code></li></div>
  <div id="test4"><li>Email: <code class="inline-code">priya.sharma@example-synthetic.org</code></li></div>
  <div id="test5"><li>नाम / Name: <code class="inline-code">राहुल वर्मा (Rahul Verma)</code></li></div>
  <div id="nav">Privamon Test Suite 1. DOM Form 2. Text PII 3. OCR Pixel</div>

  <script>
    async function run() {
      const mockMapper = {
        mapBbox: (b) => ({ ...b }),
        info: { scaleX: 1, scaleY: 1 }
      };

      const testStrings = [
        "Baked English PII Tokens:",
        "Baked Bilingual PII Tokens:",
        "Name: Priya Sharma",
        "Email: priya.sharma@example-synthetic.org",
        "नाम / Name: राहुल वर्मा (Rahul Verma)",
        "Privamon Test Suite 1. DOM Form 2. Text PII 3. OCR Pixel"
      ];

      const detectionsByString = {};
      for (const str of testStrings) {
        const dets = Privamon.PIIDetector.detectPII(str, '', 'dom');
        detectionsByString[str] = dets.map(d => ({
          type: d.type,
          text: d.text,
          pattern: d.patternName,
          conf: d.confidence
        }));
      }

      await fetch('http://localhost:8991/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(detectionsByString)
      });
    }
    window.onload = run;
  </script>
</body>
</html>
"""

def main():
    global results_received
    os.makedirs('scratch', exist_ok=True)
    with open('scratch/test_dom_meta.html', 'w', encoding='utf-8') as f:
        f.write(html_content)

    server = socketserver.TCPServer(('', PORT), TestHandler)
    t = threading.Thread(target=server.serve_forever)
    t.daemon = True
    t.start()

    chrome_cmd = [
        'google-chrome',
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        f'http://localhost:{PORT}/scratch/test_dom_meta.html'
    ]
    
    proc = subprocess.Popen(chrome_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    start_time = time.time()
    while results_received is None and time.time() - start_time < 15:
        time.sleep(0.3)

    proc.terminate()
    server.shutdown()

    if results_received:
        for text, dets in results_received.items():
            print(f"\nText: '{text}' -> {len(dets)} detections:")
            for d in dets:
                print(f"  - [{d['type']}] '{d['text']}' via {d['pattern']} (conf: {d['conf']})")

if __name__ == '__main__':
    main()
