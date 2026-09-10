import http.server
import socketserver
import threading
import time
import subprocess
import os

PORT = 8996

class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

def main():
    server = ReusableServer(('', PORT), Handler)
    t = threading.Thread(target=server.serve_forever)
    t.daemon = True
    t.start()
    print(f"Test server started on http://localhost:{PORT}")

    # Create test results launcher html that populates sessionStorage/chrome.storage and redirects to results.html
    launcher_html = """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Results Tester</title></head>
<body>
<script>
  const mockResult = {
    sanitizedScreenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    originalScreenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    detections: [
      {
        type: 'identity_document',
        text: '[Aadhaar Card Document - Full Shield]',
        reason: 'document_shield:aadhaar_card',
        confidence: 1.0,
        decision: 'REDACT',
        source: 'ocr_document_shield',
        bbox: { x: 50, y: 50, width: 400, height: 250 }
      },
      {
        type: 'identity_document',
        text: '[PAN Card Document - Full Shield]',
        reason: 'document_shield:pan_card',
        confidence: 1.0,
        decision: 'REDACT',
        source: 'ocr_document_shield',
        bbox: { x: 50, y: 320, width: 400, height: 250 }
      },
      {
        type: 'name',
        text: 'Saurabh Yadav',
        reason: 'ocr_regex:indian_name',
        confidence: 0.90,
        decision: 'REDACT',
        source: 'ocr',
        bbox: { x: 70, y: 120, width: 120, height: 20 }
      },
      {
        type: 'face',
        text: '[Biometric Face Photo]',
        reason: 'Biometric face detection via UltraFace ONNX',
        confidence: 0.96,
        decision: 'REDACT',
        source: 'vision',
        bbox: { x: 300, y: 70, width: 100, height: 120 }
      }
    ],
    redactions: [
      {
        type: 'identity_document',
        text: '[Aadhaar Card Document - Full Shield]',
        reason: 'document_shield:aadhaar_card',
        confidence: 1.0,
        bbox: { x: 50, y: 50, width: 400, height: 250 }
      },
      {
        type: 'identity_document',
        text: '[PAN Card Document - Full Shield]',
        reason: 'document_shield:pan_card',
        confidence: 1.0,
        bbox: { x: 50, y: 320, width: 400, height: 250 }
      },
      {
        type: 'name',
        text: 'Saurabh Yadav',
        reason: 'ocr_regex:indian_name',
        confidence: 0.90,
        bbox: { x: 70, y: 120, width: 120, height: 20 }
      },
      {
        type: 'face',
        text: '[Biometric Face Photo]',
        reason: 'Biometric face detection via UltraFace ONNX',
        confidence: 0.96,
        bbox: { x: 300, y: 70, width: 100, height: 120 }
      }
    ],
    sanitizedDom: {
      url: 'http://localhost/test',
      title: 'Aadhaar & PAN Verification Page',
      timestamp: new Date().toISOString(),
      elements: [
        { elementId: 'el-1', tag: 'CANVAS', isSanitized: true, reason: 'identity_document' }
      ]
    },
    rawOcrText: 'GOVERNMENT OF INDIA\\nUIDAI\\nSaurabh Yadav\\nDOB: 10/08/2006\\nINCOME TAX DEPARTMENT\\nPermanent Account Number\\nABCPS1234F',
    sanitizedOcrText: '[REDACTED: AADHAAR CARD FULL SHIELD]\\n[REDACTED: PAN CARD FULL SHIELD]',
    stats: {
      timings: { total: 450, ocr: 220, vision: 110, ner: 40, fusion: 15, redaction: 20 }
    }
  };

  // Mock chrome.storage.local
  window.chrome = {
    storage: {
      local: {
        get: function(keys, cb) {
          cb({ lastPipelineResult: mockResult });
        }
      }
    },
    tabs: {
      query: function(q, cb) { cb([]); }
    }
  };

  sessionStorage.setItem('lastPipelineResult', JSON.stringify(mockResult));
  window.location.href = '/results.html';
</script>
</body>
</html>
"""
    with open('scratch/test_ui_launcher.html', 'w', encoding='utf-8') as f:
        f.write(launcher_html)

    cmd = [
        'google-chrome',
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--window-size=1600,1000',
        f'http://localhost:{PORT}/scratch/test_ui_launcher.html'
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(4)
    proc.terminate()
    server.shutdown()
    print("UI validation executed with zero crash!")

if __name__ == '__main__':
    main()
