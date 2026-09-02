// imagePII.js
// Wraps screenpipe/pii-image-redactor — an RF-DETR-Nano object detector
// trained specifically to find PII *regions* in screenshots of real app UI
// (chat, terminals, forms, password managers). This is a different job than
// face-api.js: this model finds PII baked into the pixels as UI/text content,
// not human faces. Both run — face-api for faces, this for UI/text PII.
//
// License: CC BY-NC 4.0 — non-commercial only. Fine for this SIH prototype;
// flag before any commercial use per screenpipe's terms.
//
// Preprocessing/postprocessing below follows the model card's reference
// implementation exactly (512x512 input, ImageNet normalization, cxcywh boxes).

import * as ort from 'onnxruntime-web/wasm';
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/';

const MODEL_URL = 'https://huggingface.co/screenpipe/pii-image-redactor/resolve/main/rfdetr_v11.onnx';
const SIZE = 512;
const THRESHOLD = 0.3;
const NUM_CLASSES = 12; // 13 output channels total = 12 PII classes + 1 no-object channel

let session = null;
let loadFailed = false;

async function getSession() {
  if (loadFailed) return null;
  if (session) return session;

  try {
    // Fetched from HF's CDN on first use, cached by the browser afterward.
    // KNOWN LIMITATION: same CSP caveat as textPII.js — strict connect-src
    // policies on some sites will block this fetch.
    session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
    });
    return session;
  } catch (err) {
    console.warn('[Privamon] Image PII model failed to load:', err);
    loadFailed = true;
    return null;
  }
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Preprocesses an already-loaded <img> (or canvas) into the normalized
 * CHW float32 tensor the model expects — mirrors the model card's Python
 * reference implementation (resize 512x512, ImageNet mean/std, HWC->CHW).
 */
function preprocess(imgEl) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imgEl, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE); // RGBA, uint8

  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const chw = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;

  for (let i = 0; i < plane; i++) {
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;
    chw[i] = (r - mean[0]) / std[0]; // R plane
    chw[plane + i] = (g - mean[1]) / std[1]; // G plane
    chw[2 * plane + i] = (b - mean[2]) / std[2]; // B plane
  }

  return new ort.Tensor('float32', chw, [1, 3, SIZE, SIZE]);
}

/**
 * Runs detection on an image (e.g. the full-page screenshot) and returns
 * PII regions in the ORIGINAL image's pixel coordinates (already scaled up
 * from the model's 512x512 working resolution).
 *
 * Per the model card's guidance: this is a localizer, not a reliable
 * classifier — we redact every region above threshold regardless of its
 * predicted class, rather than filtering by category.
 */
export async function detectImagePII(imgEl, originalWidth, originalHeight) {
  const sess = await getSession();
  if (!sess) return [];

  const inputTensor = preprocess(imgEl);
  const feeds = { [sess.inputNames[0]]: inputTensor };
  const output = await sess.run(feeds);

  // boxes: [1, 300, 4] cxcywh normalized; logits: [1, 300, 13]
  const boxesTensor = output[sess.outputNames[0]];
  const logitsTensor = output[sess.outputNames[1]];
  const boxes = boxesTensor.data;
  const logits = logitsTensor.data;
  const numQueries = boxesTensor.dims[1];

  const regions = [];
  for (let q = 0; q < numQueries; q++) {
    let maxScore = 0;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const score = sigmoid(logits[q * (NUM_CLASSES + 1) + c]);
      if (score > maxScore) maxScore = score;
    }
    if (maxScore < THRESHOLD) continue;

    const cx = boxes[q * 4];
    const cy = boxes[q * 4 + 1];
    const w = boxes[q * 4 + 2];
    const h = boxes[q * 4 + 3];

    // Convert normalized cxcywh -> pixel-space top-left x,y,w,h in the
    // ORIGINAL (pre-resize) image dimensions.
    regions.push({
      x: (cx - w / 2) * originalWidth,
      y: (cy - h / 2) * originalHeight,
      w: w * originalWidth,
      h: h * originalHeight,
      score: Number(maxScore.toFixed(2)),
    });
  }

  return regions;
}
