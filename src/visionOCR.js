// visionOCR.js
// Wraps Tesseract.js's pretrained OCR model to catch PII embedded IN images
// (e.g. a screenshotted ID card, a photo of a form) that DOM text can't see.
// Runs entirely client-side via WASM.

import { createWorker } from 'tesseract.js';

let worker = null;

export async function initOCR() {
  if (worker) return worker;
  worker = await createWorker('eng');
  return worker;
}

/**
 * Runs OCR on an image element and returns extracted text.
 * Caller is responsible for running this text through piiText.js's redactor.
 */
export async function extractTextFromImage(imgEl) {
  if (!worker) await initOCR();
  const { data } = await worker.recognize(imgEl.src);
  return data.text || '';
}

export async function terminateOCR() {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}
