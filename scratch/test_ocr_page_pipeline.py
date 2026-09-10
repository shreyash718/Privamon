import http.server
import socketserver
import threading
import time
import json
import subprocess
import os
import sys

PORT = 8995
results_received = None

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

def main():
    global results_received
    os.makedirs('scratch', exist_ok=True)
    
    server = socketserver.TCPServer(('', PORT), TestHandler)
    t = threading.Thread(target=server.serve_forever)
    t.daemon = True
    t.start()
    print(f'Server started on http://localhost:{PORT}')

    # Create test runner HTML that embeds the test page in an iframe or loads it directly
    runner_html = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>OCR Page Pipeline Debug</title>
  <!-- Load Privamon modules -->
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
  <script src="/vision/ocr-engine.js"></script>
  <script src="/pipeline/sanitize-pipeline.js"></script>
</head>
<body>
  <h1>Running Pipeline on test-pages/ocr-image-pii.html...</h1>
  <iframe id="test-frame" src="/test-pages/ocr-image-pii.html" width="1280" height="1200" style="border:none;"></iframe>

  <script>
    async function run() {
      const frame = document.getElementById('test-frame');
      await new Promise(resolve => {
        if (frame.contentDocument && frame.contentDocument.readyState === 'complete') {
          setTimeout(resolve, 800);
        } else {
          frame.onload = () => setTimeout(resolve, 800);
        }
      });

      const frameWin = frame.contentWindow;
      const frameDoc = frame.contentDocument;

      // Extract DOM from iframe
      // Inject dom-extractor into frame
      const extractScript = document.createElement('script');
      extractScript.src = '/content/dom-extractor.js';
      
      // Let's run dom extractor logic directly in frame
      const viewportInfo = {
        cssViewportWidth: 1280,
        cssViewportHeight: 1200,
        devicePixelRatio: 1,
        scrollX: 0,
        scrollY: 0,
        estimatedZoom: 1
      };

      // Find pixel regions
      const canvas1 = frameDoc.getElementById('ocr-doc-en');
      const img2 = frameDoc.getElementById('ocr-img-hi');
      const rect1 = canvas1.getBoundingClientRect();
      const rect2 = img2.getBoundingClientRect();

      const pixelRegions = [
        {
          regionId: 'reg_canvas_en',
          tag: 'CANVAS',
          bbox: { x: rect1.x, y: rect1.y, width: rect1.width, height: rect1.height },
          area: rect1.width * rect1.height
        },
        {
          regionId: 'reg_img_hi',
          tag: 'IMG',
          bbox: { x: rect2.x, y: rect2.y, width: rect2.width, height: rect2.height },
          area: rect2.width * rect2.height
        }
      ];

      // Extract elements from frameDoc
      const allEls = frameDoc.querySelectorAll('*');
      const elements = [];
      for (const el of allEls) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const txt = el.innerText || el.textContent || '';
        if (txt.trim() && el.children.length === 0) {
          elements.push({
            elementId: el.id || ('el_' + Math.random().toString(36).substr(2, 6)),
            tag: el.tagName,
            text: txt.trim(),
            bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
            isContainer: false
          });
        }
      }

      // Capture screenshot of the iframe by drawing its elements onto a canvas
      const fullCanvas = document.createElement('canvas');
      fullCanvas.width = 1280;
      fullCanvas.height = 1200;
      const fctx = fullCanvas.getContext('2d');
      fctx.fillStyle = '#0f172a'; // page background
      fctx.fillRect(0, 0, 1280, 1200);

      // Draw canvas1 and img2 at exact positions
      fctx.drawImage(canvas1, rect1.x, rect1.y);
      fctx.drawImage(img2, rect2.x, rect2.y);

      const screenshotDataUrl = fullCanvas.toDataURL('image/png');

      const domData = {
        viewportInfo,
        pixelRegions,
        elements,
        stats: { elementCount: elements.length }
      };

      // Run Pipeline
      const result = await Privamon.SanitizePipeline.run({
        screenshot: screenshotDataUrl,
        domData,
        onProgress: (stage, status, msg) => console.log(`[Stage: ${stage}] ${status}: ${msg}`)
      });

      const detections = result.detections.map(d => ({
        type: d.type,
        text: d.text,
        confidence: d.confidence,
        decision: d.decision,
        reason: d.reason,
        bbox: d.bbox,
        sources: d.sources
      }));

      // Report back
      await fetch('http://localhost:' + 8995 + '/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          detections,
          redactionsCount: result.redactions.length,
          sanitizedScreenshot: result.sanitizedScreenshot.slice(0, 200) + '...',
          redactions: result.redactions.map(r => ({
            type: r.type,
            text: r.text,
            reason: r.reason,
            bbox: r.bbox
          }))
        })
      });
    }

    window.onload = () => {
      setTimeout(run, 500);
    };
  </script>
</body>
</html>
"""

    with open('scratch/debug_ocr_pipeline.html', 'w', encoding='utf-8') as f:
        f.write(runner_html)

    chrome_cmd = [
        'google-chrome',
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--remote-debugging-port=9222',
        f'http://localhost:{PORT}/scratch/debug_ocr_pipeline.html'
    ]
    
    proc = subprocess.Popen(chrome_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    start_time = time.time()
    while results_received is None and time.time() - start_time < 30:
        time.sleep(0.5)

    proc.terminate()
    server.shutdown()

    if results_received:
        print("\n=== PIPELINE RUN RESULTS ===")
        print(f"Total redactions: {results_received.get('redactionsCount')}")
        print("\nRedactions list:")
        for r in results_received.get('redactions', []):
            print(f" - [{r['type']}] '{r['text']}' reason={r['reason']} bbox={r['bbox']}")
    else:
        print("Timed out waiting for results")

if __name__ == '__main__':
    main()
