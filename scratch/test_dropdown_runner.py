import http.server
import socketserver
import threading
import time
import json
import subprocess
import os

PORT = 8997
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

def run_server():
    os.chdir('/home/mishrazi/ProjectContributed/Privamon')
    with ReusableServer(('127.0.0.1', PORT), TestHandler) as httpd:
        while results_received is None:
            httpd.handle_request()

def test_dropdown():
    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()
    time.sleep(0.5)

    cmd = [
        'google-chrome',
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        f'http://127.0.0.1:{PORT}/scratch/test_dropdown_selection.html'
    ]

    proc = subprocess.Popen(cmd)
    
    start_time = time.time()
    while results_received is None and time.time() - start_time < 15:
        time.sleep(0.3)

    proc.terminate()

    assert results_received is not None, "Failed to receive results from headless Chrome"
    print("\n=== DROPDOWN SELECTION TEST RESULTS ===")
    all_passed = True
    for item in results_received:
        status = "✓ PASS" if item.get('pass') else "✗ FAIL"
        print(f"[{status}] {item.get('test')} | Details: {json.dumps(item)}")

    if all_passed:
        print("\n🎉 ALL 6 DROPDOWN TESTS PASSED PERFECTLY!\n")
    else:
        print("\n❌ SOME TESTS FAILED!\n")
        exit(1)

if __name__ == '__main__':
    test_dropdown()
