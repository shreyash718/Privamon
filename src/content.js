// content.js
// Main orchestrator. Runs in the context of the actual webpage.
// Pipeline: capture DOM -> sanitize text -> detect+redact visual PII -> build payload.

console.log('[Privamon] content script injected and running.');

// Some errors from face-api's internal WebGL/tensor pipeline (e.g. tainted-canvas
// on a cross-origin image we couldn't pre-filter) surface as unhandled promise
// rejections rather than being catchable in our own try/catch. We already filter
// out same-origin/size issues before attempting detection, so anything still
// slipping through here is a rare edge case — log it quietly instead of letting
// it show as a page error.
window.addEventListener('unhandledrejection', (event) => {
  const msg = String(event.reason?.message || event.reason || '');
  if (msg.includes('texImage2D') || msg.includes('Tainted canvas') || msg.includes('drawImage')) {
    console.warn('[Privamon] Suppressed internal vision-model error:', msg);
    event.preventDefault();
  }
});

import { captureDomElements } from './domCapture.js';
import { sanitizeDomElements } from './piiText.js';
import { loadFaceModel, detectFacesInElement } from './visionFaces.js';
import { extractTextFromImage } from './visionOCR.js';
import { redactImageRegions } from './redact.js';

const PII_TEXT_PATTERNS_MODULE = './piiText.js';

// Images below this size are almost always icons/emoji/UI chrome, not photos of people.
const MIN_IMAGE_DIMENSION = 60;

// Hard cap on how many images we attempt per run — bounds latency and error
// volume on image-heavy sites (chat apps, social feeds) where dozens of
// avatars/emoji can load at once.
const MAX_IMAGES_PER_RUN = 15;

function isSameOrigin(src) {
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

async function processImages(domElements) {
  const modelUrl = chrome.runtime.getURL('models');
  await loadFaceModel(modelUrl);

  const imageResults = [];
  const candidates = domElements.filter((e) => e.tag === 'img' && e.src);
  let attempted = 0;

  for (const el of candidates) {
    if (attempted >= MAX_IMAGES_PER_RUN) {
      console.warn('[Privamon] Image processing cap reached, skipping remaining images.');
      break;
    }

    const imgEl = document.querySelector(el.selector) || findBySrc(el.src);

    // Skip images that failed to load or haven't finished loading.
    if (!imgEl || !imgEl.complete || imgEl.naturalWidth === 0 || imgEl.naturalHeight === 0) {
      continue;
    }

    // Skip small icons/emoji — not worth the inference cost, rarely contain PII.
    if (imgEl.naturalWidth < MIN_IMAGE_DIMENSION || imgEl.naturalHeight < MIN_IMAGE_DIMENSION) {
      continue;
    }

    // Skip cross-origin images up front — we already know these will fail
    // WebGL's tainted-canvas check, so don't waste time/errors attempting them.
    // (Known limitation: cross-origin images can't be vision-processed locally
    // without the source server opting into CORS — documented, not silently hidden.)
    if (!isSameOrigin(el.src)) {
      continue;
    }

    attempted++;

    try {
      const faceBoxes = await detectFacesInElement(imgEl);
      const ocrText = await extractTextFromImage(imgEl).catch(() => '');

      let redactedDataUrl = null;
      if (faceBoxes.length > 0) {
        redactedDataUrl = await redactImageRegions(imgEl, faceBoxes);
      }

      imageResults.push({
        selector: el.selector,
        facesDetected: faceBoxes.length,
        faceBoxes,
        ocrTextFound: ocrText.trim().length > 0,
        redactedImage: redactedDataUrl,
      });
    } catch (err) {
      console.warn('[Privamon] Vision processing failed for', el.selector, err);
    }
  }

  return imageResults;
}

function findBySrc(src) {
  return Array.from(document.images).find((i) => i.src === src) || null;
}

async function runPipeline(userAction) {
  console.time('[Privamon] full pipeline');

  console.time('[Privamon] dom capture');
  const rawElements = captureDomElements();
  console.timeEnd('[Privamon] dom capture');

  console.time('[Privamon] text sanitize');
  const sanitizedElements = sanitizeDomElements(rawElements);
  console.timeEnd('[Privamon] text sanitize');

  console.time('[Privamon] vision pipeline');
  const imageFindings = await processImages(rawElements);
  console.timeEnd('[Privamon] vision pipeline');

  const payload = {
    url: location.href,
    timestamp: Date.now(),
    userAction: userAction || null, // what the user wants done — goes to the server alongside sanitized context
    elements: sanitizedElements,
    imageFindings,
  };

  console.timeEnd('[Privamon] full pipeline');
  console.log('[Privamon] SANITIZED PAYLOAD:', payload);
  return payload;
}

// Expose for manual testing from DevTools console
window.__privamonRun = runPipeline;

// Triggered from the popup when the user clicks "Capture & Sanitize" —
// this replaces the old auto-run-on-load behavior, since a one-time capture
// on page load can't reflect values the user later types into the form.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'PRIVAMON_CAPTURE') return false; // not for us

  runPipeline(message.action)
    .then(async (payload) => {
      // Store locally for now — this is what a later step will POST to the server.
      await chrome.storage.local.set({ privamon_last_capture: payload });
      sendResponse({
        ok: true,
        elementCount: payload.elements.length,
        imageCount: payload.imageFindings.length,
      });
    })
    .catch((err) => {
      console.error('[Privamon] Pipeline failed:', err);
      sendResponse({ ok: false, error: err.message });
    });

  return true; // keep the message channel open for the async sendResponse above
});

