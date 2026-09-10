import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

PORT = 8982
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
</head>
<body>
  <script>
    // Test the new patterns directly

    // 1. name_labeled pattern supporting Hindi & English without trailing label swallow
    const nameLabeledRegex = /\\b(?:(?:नाम(?:\\s*\\/\\s*name)?|name|customer[^\\S\\r\\n]*name|patient[^\\S\\r\\n]*name|buyer[^\\S\\r\\n]*name|holder[^\\S\\r\\n]*name|m\\/s|shri|smt|mr\\.)\\s*[:.\\-_=~*\\/]?\\s*|client\\s*name\\s*[:.\\-_=~*]?\\s*|client\\s*[:=]\\s*)([a-zA-Z\\u0900-\\u097F][a-zA-Z0-9\\u0900-\\u097F\\.\\'\\-]+(?:[^\\S\\r\\n]+[a-zA-Z\\u0900-\\u097F\\.\\'\\-]+){0,3})/gui;

    // 2. address_labeled pattern
    const addressLabeledRegex = /(?:पता(?:\\s*\\/\\s*address)?|address)\\s*[:.\\-_=~*\\/]\\s*([^\\n\\r]{5,80})/gi;

    // 3. hindi_name pattern
    const hindiNameRegex = /\\b(?:राहुल|प्रिया|अमित|अंजलि|रोहित|पूजा|विकास|नेहा|सुनील|दीपक|संजय|राजेश|अजय|मनोज|सुरेश|अनिल|राकेश|संदीप|मनीष|कविता|सुनीता|अनीता|रेखा|रीता|आरती|सपना|रेनू|किरण|निशा|मीना|स्वाति|पूनम|शिल्पा|मोनिका)(?:[^\\S\\r\\n]+(?:वर्मा|शर्मा|गुप्ता|सिंह|कुमार|यादव|मिश्रा|तिवारी|पांडेय|चौहान|चौधरी|जोशी|मेहता|शाह|पटेल|रेड्डी|नायर|अय्यर|दास|मुखर्जी|बोस|घोष|सेन|दत्ता|रॉय|जैन|बंसल|गोयल|मित्तल|सिंघल|गर्ग|भाटिया|अरोड़ा|कपूर|मल्होत्रा|खन्ना|चोपड़ा|सेठी|ग्रोवर|आहूजा|मलिक|गिल|धिल्लों|संधू|ग्रेवाल|सिद्धू|मान))?\\b/gu;

    const testTexts = [
      "Full Name: Priya Sharma",
      "Email Address: priya.sharma@example-synthetic.org",
      "Baked Pixel PII & Client-Side OCR Validation",
      "नाम / Name: राहुल वर्मा (Rahul Verma)",
      "पता / Address: १२३ सिविल लाइन्स, नई दिल्ली (123 Civil Lines, New Delhi)",
      "Baked English PII Tokens:",
      "Baked Bilingual PII Tokens:",
      "Name: Priya Sharma Email: priya.sharma@example-synthetic.org"
    ];

    const results = {};

    for (const t of testTexts) {
      results[t] = {
        nameLabeled: [],
        addressLabeled: [],
        hindiName: []
      };

      let m;
      nameLabeledRegex.lastIndex = 0;
      while ((m = nameLabeledRegex.exec(t)) !== null) {
        let val = m[1].trim();
        // Truncate before next label if swallowed
        const labelSplit = val.split(/\\s+(?=(?:email|mobile|phone|contact|aadhaar|aadhar|pan|address|date|id|code|order|invoice)\\b)/i);
        if (labelSplit.length > 1) val = labelSplit[0].trim();
        results[t].nameLabeled.push(val);
      }

      addressLabeledRegex.lastIndex = 0;
      while ((m = addressLabeledRegex.exec(t)) !== null) {
        results[t].addressLabeled.push(m[1].trim());
      }

      hindiNameRegex.lastIndex = 0;
      while ((m = hindiNameRegex.exec(t)) !== null) {
        results[t].hindiName.push(m[0].trim());
      }
    }

    fetch('http://localhost:8982/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(results)
    });
  </script>
</body>
</html>
"""

def main():
    global results_received
    os.makedirs('scratch', exist_ok=True)
    with open('scratch/test_new_rules.html', 'w', encoding='utf-8') as f:
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
        f'http://localhost:{PORT}/scratch/test_new_rules.html'
    ]
    
    proc = subprocess.Popen(chrome_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    start_time = time.time()
    while results_received is None and time.time() - start_time < 15:
        time.sleep(0.2)

    proc.terminate()
    server.shutdown()

    if results_received:
        for text, res in results_received.items():
            print(f"\nTarget: '{text}'")
            print("  nameLabeled   :", res['nameLabeled'])
            print("  addressLabeled:", res['addressLabeled'])
            print("  hindiName     :", res['hindiName'])
    else:
        print("Timed out")

if __name__ == '__main__':
    main()
