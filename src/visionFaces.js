// visionFaces.js
// Wraps face-api.js's pretrained TinyFaceDetector (no training — pretrained weights).
// Runs entirely client-side (WASM/WebGL backend via TensorFlow.js under the hood).

import * as faceapi from 'face-api.js';

let modelsLoaded = false;

/**
 * Load pretrained model weights.
 * modelUrl should point to the extension's bundled /models folder
 * (via chrome.runtime.getURL('models')) — see content.js for usage.
 */
export async function loadFaceModel(modelUrl) {
  if (modelsLoaded) return;
  await faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl);
  modelsLoaded = true;
}

/**
 * Detects faces in a given <img> or <video> element already present on the page.
 * Returns bounding boxes in the element's local pixel space.
 */
export async function detectFacesInElement(imgOrVideoEl) {
  if (!modelsLoaded) {
    throw new Error('Face model not loaded — call loadFaceModel() first.');
  }
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 });
  const detections = await faceapi.detectAllFaces(imgOrVideoEl, options);

  return detections.map((d) => ({
    x: Math.round(d.box.x),
    y: Math.round(d.box.y),
    w: Math.round(d.box.width),
    h: Math.round(d.box.height),
    score: Number(d.score.toFixed(2)),
  }));
}
