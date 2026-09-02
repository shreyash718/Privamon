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
// import { detectAndRedactBatch } from './textPII.js';
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
      // const ocrText = await extractTextFromImage(imgEl).catch(() => '');

      let redactedDataUrl = null;
      if (faceBoxes.length > 0) {
        redactedDataUrl = await redactImageRegions(imgEl, faceBoxes);
      }

      imageResults.push({
        selector: el.selector,
        facesDetected: faceBoxes.length,
        faceBoxes,
        // ocrTextFound: ocrText.trim().length > 0,
        redactedImage: redactedDataUrl,
        // Needed later to convert face boxes (natural-pixel space) into
        // viewport coordinates for redacting the full-page screenshot.
        viewportRect: el.rect,
        naturalWidth: imgEl.naturalWidth,
        naturalHeight: imgEl.naturalHeight,
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

/**
 * Builds a list of viewport-relative (x, y, w, h) boxes to black out on the
 * full-page screenshot — one per sensitive DOM field and one per detected face.
 * Coordinates are in CSS pixels; the popup scales them by devicePixelRatio
 * when drawing onto the (device-pixel-resolution) captured screenshot.
 */
function collectRedactionRegions(sanitizedElements, imageFindings) {
  const regions = [];

  // Sensitive form fields — anything our text/attribute sanitizer flagged.
  for (const el of sanitizedElements) {
    if (el.piiDetected && el.piiDetected.length > 0 && el.rect) {
      regions.push({ ...el.rect, reason: 'field:' + el.piiDetected.join(',') });
    }
  }

  // Detected faces — convert from natural-image-pixel space to viewport space.
  for (const img of imageFindings) {
    if (!img.faceBoxes || img.faceBoxes.length === 0) continue;
    const { viewportRect: vr, naturalWidth: nw, naturalHeight: nh } = img;
    if (!vr || !nw || !nh) continue;

    const scaleX = vr.w / nw;
    const scaleY = vr.h / nh;

    for (const box of img.faceBoxes) {
      regions.push({
        x: vr.x + box.x * scaleX,
        y: vr.y + box.y * scaleY,
        w: box.w * scaleX,
        h: box.h * scaleY,
        reason: 'face',
      });
    }
  }

  return regions;
}

/**
 * Second-pass redaction using the NER model — catches PII that regex
 * structurally cannot (names, addresses, etc.). Skips fields already fully
 * replaced by the attribute-based pass (e.g. exactly "[REDACTED]" — nothing
 * left there to improve on). Batches all fields into one inference call.
 */


async function runPipeline(userAction) {
  console.time('[Privamon] full pipeline');

  console.time('[Privamon] dom capture');
  const rawElements = captureDomElements();
  console.timeEnd('[Privamon] dom capture');

  console.time('[Privamon] text sanitize (regex/attribute)');
  const sanitizedElements = sanitizeDomElements(rawElements);
  console.timeEnd('[Privamon] text sanitize (regex/attribute)');


  console.time('[Privamon] vision pipeline');
  const imageFindings = await processImages(rawElements);
  console.timeEnd('[Privamon] vision pipeline');

  const redactionRegions = collectRedactionRegions(sanitizedElements, imageFindings);

  const payload = {
    url: location.href,
    timestamp: Date.now(),
    userAction: userAction || null, // what the user wants done — goes to the server alongside sanitized context
    elements: sanitizedElements,
    imageFindings,
    redactionRegions, // viewport-space boxes the popup will black out on the screenshot
    devicePixelRatio: window.devicePixelRatio || 1,
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
      // Send the full payload back — the popup needs redactionRegions and
      // devicePixelRatio to redact the screenshot it's about to capture.
      sendResponse({ ok: true, payload });
    })
    .catch((err) => {
      console.error('[Privamon] Pipeline failed:', err);
      sendResponse({ ok: false, error: err.message });
    });

  return true; // keep the message channel open for the async sendResponse above
});

