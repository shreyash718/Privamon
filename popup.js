// popup.js
// Runs in the extension popup context. Now bundled via esbuild since it
// imports the image PII model (see build.js).

import { detectImagePII } from './src/imagePII.js';

const actionInput = document.getElementById('actionInput');
const captureBtn = document.getElementById('captureBtn');
const statusEl = document.getElementById('status');

captureBtn.addEventListener('click', async () => {
  const action = actionInput.value.trim();
  if (!action) {
    statusEl.textContent = 'Please describe what you want done first.';
    return;
  }

  statusEl.textContent = 'Capturing DOM and sanitizing...';
  captureBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'PRIVAMON_CAPTURE',
      action,
    });

    if (!response || !response.ok) {
      statusEl.textContent = 'Something went wrong: ' + (response?.error || 'unknown error');
      return;
    }
    const payload = response.payload;

    // Re-measure regions live, right before the screenshot — closes the gap
    // between when the DOM was originally captured and now, so zoom/scroll
    // changes in between don't cause misaligned redaction boxes.
    const fresh = await chrome.tabs.sendMessage(tab.id, { type: 'PRIVAMON_REMEASURE' });

    statusEl.textContent = 'Capturing screenshot...';
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

    statusEl.textContent = 'Scanning screenshot for on-screen PII...';
    const modelRegions = await detectRegionsOnScreenshot(screenshotDataUrl);

    // DOM/face-derived regions are in CSS-pixel viewport space and need
    // devicePixelRatio scaling; the image model's regions are already in the
    // screenshot's own pixel space (no scaling needed) — redactScreenshot
    // below applies dpr only to the first set.
    statusEl.textContent = 'Redacting screenshot...';
        const redactedScreenshot = await redactScreenshot(
      screenshotDataUrl,
      fresh.redactionRegions,
      fresh.devicePixelRatio,
      modelRegions
    );

    const finalPayload = {
      ...payload,
      redactedScreenshot,
      imagePIIRegionsFound: modelRegions.length,
    };
    await chrome.storage.local.set({ privamon_last_capture: finalPayload });

    statusEl.textContent =
      `Captured ${payload.elements.length} elements, ` +
      `${payload.imageFindings.length} images, ` +
      `${payload.redactionRegions.length} DOM/face regions + ` +
      `${modelRegions.length} on-screen PII regions redacted.\n` +
      `Stored locally — ready to send to server.`;
  } catch (err) {
    statusEl.textContent =
      'Could not complete capture. Try refreshing the tab, then retry.\n(' + err.message + ')';
  } finally {
    captureBtn.disabled = false;
  }
});

/**
 * Runs the image PII model over the full screenshot and returns detected
 * regions already scaled to the screenshot's own pixel dimensions.
 */
function detectRegionsOnScreenshot(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = async () => {
      try {
        const regions = await detectImagePII(img, img.width, img.height);
        resolve(regions);
      } catch (err) {
        console.warn('[Privamon] Image PII model failed, continuing without it:', err);
        resolve([]);
      }
    };
    img.onerror = () => resolve([]);
    img.src = dataUrl;
  });
}

/**
 * Draws the screenshot onto a canvas and blacks out every region from both
 * sources. domFaceRegions are in CSS-pixel viewport space (scaled by
 * devicePixelRatio); modelRegions are already in screenshot pixel space.
 */
function redactScreenshot(dataUrl, domFaceRegions, devicePixelRatio, modelRegions) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      ctx.fillStyle = '#000000';

      for (const r of domFaceRegions || []) {
        ctx.fillRect(
          r.x * devicePixelRatio,
          r.y * devicePixelRatio,
          r.w * devicePixelRatio,
          r.h * devicePixelRatio
        );
      }

      for (const r of modelRegions || []) {
        ctx.fillRect(r.x, r.y, r.w, r.h); // already in screenshot pixel space
      }

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}
document.getElementById('viewResultsLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
});