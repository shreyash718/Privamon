import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

PORT = 8990
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

def main():
    global results_received
    server = socketserver.TCPServer(('', PORT), TestHandler)
    t = threading.Thread(target=server.serve_forever)
    t.daemon = True
    t.start()

    test_page_html = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="/content/dom-range-mapper.js"></script>
  <script src="/privacy/coordinate-mapper.js"></script>
  <script src="/privacy/pii-detector.js"></script>
  <script src="/privacy/fusion.js"></script>
  <script src="/privacy/ner-engine.js"></script>
  <script src="/pipeline/sanitize-pipeline.js"></script>
</head>
<body>
  <iframe id="f" src="/test-pages/ocr-image-pii.html" width="1280" height="1200"></iframe>
  <script>
    async function run() {
      const iframe = document.getElementById('f');
      await new Promise(r => {
        if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') setTimeout(r, 600);
        else iframe.onload = () => setTimeout(r, 600);
      });

      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;

      // Run dom extractor in iframe
      // We can evaluate dom-extractor script directly in iframe
      const s = doc.createElement('script');
      s.src = '/content/dom-extractor.js';
      doc.body.appendChild(s);
      
      // Wait for dom-extractor to return or run its logic
      await new Promise(r => setTimeout(r, 500));
      
      // Extract elements using dom-extractor logic
      const viewportInfo = {
        cssViewportWidth: win.innerWidth,
        cssViewportHeight: win.innerHeight,
        devicePixelRatio: 1,
        scrollX: 0,
        scrollY: 0
      };
      
      const mapper = Privamon.CoordinateMapper.create(viewportInfo, { width: 1280, height: 1200 });
      
      // Grab all text elements
      const elements = [];
      const all = doc.querySelectorAll('*');
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const txt = el.innerText || el.textContent || '';
        if (txt.trim() && el.children.length === 0) {
          // Tokenize
          const words = txt.trim().split(/\s+/);
          const tokens = [];
          let cur = 0;
          for (let i = 0; i < words.length; i++) {
            const w = words[i];
            const start = txt.indexOf(w, cur);
            const end = start + w.length;
            cur = end;
            tokens.push({
              id: `t_${i}`,
              text: w,
              start,
              end,
              bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
              boxes: [{ x: r.x, y: r.y, width: r.width, height: r.height }]
            });
          }
          elements.push({
            elementId: el.id || ('el_' + elements.length),
            tag: el.tagName,
            text: txt.trim(),
            bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
            tokens,
            isContainer: false,
            label: el.getAttribute('aria-label') || ''
          });
        }
      }

      const domCandidates = Privamon.PIIDetector.detectDOMBatch(elements, mapper);
      
      await fetch('http://localhost:8990/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elementsCount: elements.length,
          domCandidates: domCandidates.map(c => ({
            type: c.type,
            text: c.text,
            reason: c.reason,
            confidence: c.confidence,
            bbox: c.bbox
          }))
        })
      });
    }
    window.onload = run;
  </script>
</body>
</html>
"""
    with open('scratch/test_live_page.html', 'w', encoding='utf-8') as f:
        f.write(test_page_html)

    chrome_cmd = [
        'google-chrome',
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        f'http://localhost:{PORT}/scratch/test_live_page.html'
    ]
    
    proc = subprocess.Popen(chrome_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    start_time = time.time()
    while results_received is None and time.time() - start_time < 20:
        time.sleep(0.3)

    proc.terminate()
    server.shutdown()

    if results_received:
        print(f"Total DOM candidates found: {len(results_received['domCandidates'])}")
        for c in results_received['domCandidates']:
            print(f" - [{c['type']}] '{c['text']}' reason={c['reason']} bbox={c['bbox']}")

if __name__ == '__main__':
    main()
