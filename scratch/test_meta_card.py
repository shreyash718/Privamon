import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

PORT = 8985
results_received = None

class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True

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
  <script src="/privacy/ner-engine.js"></script>
</head>
<body>
  <div class="ocr-meta-card">
    <strong id="strong1" style="color: var(--accent-blue);">Baked English PII Tokens:</strong>
    <ul id="ul1">
      <li id="li1">Name: <code class="inline-code">Priya Sharma</code></li>
      <li id="li2">Email: <code class="inline-code">priya.sharma@example-synthetic.org</code></li>
      <li id="li3">Mobile: <code class="inline-code">+91 98765 43210</code></li>
      <li id="li4">Aadhaar: <code class="inline-code">5678 9012 3458</code> (Verhoeff-valid)</li>
      <li id="li5">PAN: <code class="inline-code">ABCPE5678G</code></li>
    </ul>
  </div>

  <script>
    async function run() {
      const resp = await fetch('/content/dom-extractor.js');
      const code = await resp.text();
      const domData = eval(code);

      const mapper = Privamon.CoordinateMapper.create(domData.viewportInfo, { width: 1280, height: 800 });
      const domCandidates = Privamon.PIIDetector.detectDOMBatch(domData.elements, mapper);

      const itemsForNER = domData.elements.filter(e => !e.isContainer && e.text).map(e => ({
        text: e.text,
        tokens: e.tokens || [],
        source: 'dom',
        bbox: mapper.mapBbox(e.bbox),
        elementId: e.elementId || e.id
      }));

      const nerCandidates = await Privamon.NEREngine.detectEntities(itemsForNER, mapper);
      const all = [...domCandidates, ...nerCandidates];
      const fusion = Privamon.PIIFusion.fuse(all);

      await fetch('http://localhost:8985/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: domData.elements.map(e => ({ tag: e.tag, text: e.text, label: e.label })),
          domCandidates: domCandidates.map(c => ({ type: c.type, text: c.text, reason: c.reason, bbox: c.bbox })),
          nerCandidates: nerCandidates.map(c => ({ type: c.type, text: c.text, reason: c.reason, bbox: c.bbox })),
          redactions: fusion.redactions.map(r => ({ type: r.type, text: r.text, reason: r.reason, bbox: r.bbox, boxes: r.boxes }))
        })
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
    with open('scratch/test_meta_card.html', 'w', encoding='utf-8') as f:
        f.write(html_content)

    server = ReusableServer(('', PORT), TestHandler)
    t = threading.Thread(target=server.serve_forever)
    t.daemon = True
    t.start()

    chrome_cmd = [
        'google-chrome',
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--window-size=1280,800',
        f'http://localhost:{PORT}/scratch/test_meta_card.html'
    ]
    
    proc = subprocess.Popen(chrome_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    start_time = time.time()
    while results_received is None and time.time() - start_time < 20:
        time.sleep(0.3)

    proc.terminate()
    server.shutdown()

    if results_received:
        print("\n=== ELEMENTS EXTRACTED ===")
        for e in results_received.get('elements', []):
            print(f" - <{e.get('tag')}> '{e.get('text')}' (label='{e.get('label')}')")

        print("\n=== DOM CANDIDATES ===")
        for c in results_received.get('domCandidates', []):
            print(f" - [{c['type']}] '{c['text']}' reason={c['reason']} bbox={c['bbox']}")

        print("\n=== NER CANDIDATES ===")
        for c in results_received.get('nerCandidates', []):
            print(f" - [{c['type']}] '{c['text']}' reason={c['reason']} bbox={c['bbox']}")

        print("\n=== REDACTIONS ===")
        for r in results_received.get('redactions', []):
            print(f" - [{r['type']}] '{r['text']}' reason={r['reason']} bbox={r['bbox']}")
    else:
        print("Timed out waiting for results")

if __name__ == '__main__':
    main()
