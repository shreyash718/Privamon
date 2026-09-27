const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const PORT = 8889;
const CDP_PORT = 9223;

const server = http.createServer((req, res) => {
  const fs = require('fs');
  const path = require('path');
  let filePath = path.join(__dirname, '..', req.url.split('?')[0]);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
    } else {
      let contentType = 'text/html';
      if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) contentType = 'application/javascript';
      else if (filePath.endsWith('.wasm')) contentType = 'application/wasm';
      else if (filePath.endsWith('.onnx') || filePath.endsWith('.bin')) contentType = 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[*] HTTP server listening on port ${PORT}`);
  launchChrome();
});

function launchChrome() {
  const chrome = spawn('google-chrome-stable', [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-webgpu',
    '--use-gl=angle',
    '--use-angle=vulkan',
    `--remote-debugging-port=${CDP_PORT}`,
    `http://localhost:${PORT}/scratch/test_transformers_webgpu.html`
  ]);

  setTimeout(() => connectCDP(chrome), 1500);
}

function connectCDP(chromeProcess) {
  http.get(`http://localhost:${CDP_PORT}/json`, (res) => {
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
      try {
        const targets = JSON.parse(raw);
        const pageTarget = targets.find(t => t.type === 'page');
        if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
          console.error('No page target found in CDP response');
          process.exit(1);
        }

        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        let id = 1;

        ws.on('open', () => {
          console.log('[*] Connected to Chrome DevTools Protocol WebSocket');
          ws.send(JSON.stringify({ id: id++, method: 'Console.enable' }));
          ws.send(JSON.stringify({ id: id++, method: 'Runtime.enable' }));
          ws.send(JSON.stringify({ id: id++, method: 'Page.enable' }));
        });

        ws.on('message', (data) => {
          const msg = JSON.parse(data);
          if (msg.method === 'Runtime.consoleAPICalled') {
            const args = msg.params.args.map(a => a.value !== undefined ? a.value : (a.description || JSON.stringify(a)));
            console.log(`[CHROME LOG] ${args.join(' ')}`);
            if (args.join(' ').includes('BENCHMARK COMPLETE')) {
              setTimeout(() => {
                chromeProcess.kill();
                process.exit(0);
              }, 1000);
            }
          }
          if (msg.method === 'Runtime.exceptionThrown') {
            console.error('[CHROME EXCEPTION]', msg.params.exceptionDetails);
          }
        });

      } catch (e) {
        console.error('CDP connect error:', e);
      }
    });
  }).on('error', (err) => {
    console.error('CDP HTTP get error:', err);
  });
}
