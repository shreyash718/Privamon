import subprocess
import http.server
import socketserver
import threading
import time
import os

PORT = 8888
DIRECTORY = "/home/mishrazi/ProjectContributed/Privamon"

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

def start_server():
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        httpd.serve_forever()

server_thread = threading.Thread(target=start_server, daemon=True)
server_thread.start()
time.sleep(1)

chrome_cmd = [
    "google-chrome-stable",
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-unsafe-webgpu",
    "--use-gl=angle",
    "--use-angle=vulkan",
    "--virtual-time-budget=10000",
    f"http://localhost:{PORT}/scratch/test_webgpu_standalone.html"
]

print("[*] Running headless Chrome test...")
try:
    res = subprocess.run(chrome_cmd, capture_output=True, text=True, timeout=25)
    print("=== CHROME STDOUT / DUMP DOM ===")
    print(res.stdout)
    print("=== CHROME STDERR ===")
    print(res.stderr)
except Exception as e:
    print("Execution error:", e)
