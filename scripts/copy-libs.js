/**
 * Post-install script: copies required library files from node_modules
 * into the extension's lib/ directory for bundling.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const copies = [
  // Tesseract.js core
  {
    src: 'node_modules/tesseract.js/dist/tesseract.min.js',
    dest: 'lib/tesseract/tesseract.min.js'
  },
  {
    src: 'node_modules/tesseract.js/dist/worker.min.js',
    dest: 'lib/tesseract/worker.min.js'
  },
  // ONNX Runtime Web
  {
    src: 'node_modules/onnxruntime-web/dist/ort.min.js',
    dest: 'lib/onnx/ort.min.js'
  }
];

// WASM files for ONNX Runtime
const onnxWasmDir = path.join(ROOT, 'node_modules/onnxruntime-web/dist');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function copyFile(src, dest) {
  const srcPath = path.join(ROOT, src);
  const destPath = path.join(ROOT, dest);
  ensureDir(path.dirname(destPath));

  if (!fs.existsSync(srcPath)) {
    console.warn(`  SKIP (not found): ${src}`);
    return false;
  }

  fs.copyFileSync(srcPath, destPath);
  const size = (fs.statSync(destPath).size / 1024).toFixed(1);
  console.log(`  COPY: ${src} -> ${dest} (${size} KB)`);
  return true;
}

console.log('\n[Privamon] Copying library files...\n');

for (const { src, dest } of copies) {
  copyFile(src, dest);
}

// Copy ONNX WASM files
if (fs.existsSync(onnxWasmDir)) {
  const wasmFiles = fs.readdirSync(onnxWasmDir).filter(f => f.endsWith('.wasm'));
  for (const f of wasmFiles) {
    copyFile(`node_modules/onnxruntime-web/dist/${f}`, `lib/onnx/${f}`);
  }
}

// Create a placeholder for the BlazeFace model
const blazefacePlaceholder = path.join(ROOT, 'lib/onnx/blazeface_placeholder.txt');
ensureDir(path.dirname(blazefacePlaceholder));
if (!fs.existsSync(path.join(ROOT, 'lib/onnx/blazeface.onnx'))) {
  fs.writeFileSync(blazefacePlaceholder,
    'BlazeFace ONNX model not yet downloaded.\n' +
    'To enable face detection, download blazeface.onnx and place it here.\n' +
    'The face-detector module will gracefully degrade without it.\n'
  );
  console.log('  NOTE: BlazeFace model not present — face detection will be stubbed.');
}

console.log('\n[Privamon] Library setup complete.\n');
