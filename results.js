/**
 * Privamon — Results Page Controller
 *
 * Loads the sanitized screenshot and analysis results from
 * chrome.storage.session, then renders them with:
 *   - Zoomable screenshot canvas
 *   - Detection bounding box overlays (toggleable)
 *   - Detection summary + pipeline timings
 *   - Sanitized DOM viewer (toggleable)
 */
(() => {
  'use strict';

  // ── DOM References ──
  const screenshotCanvas   = document.getElementById('screenshotCanvas');
  const screenshotContainer = document.getElementById('screenshotContainer');
  const detectionOverlays  = document.getElementById('detectionOverlays');
  const loadingState       = document.getElementById('loadingState');
  const noResults          = document.getElementById('noResults');
  const summaryGrid        = document.getElementById('summaryGrid');
  const timingsTable       = document.getElementById('timingsTable');
  const metadataList       = document.getElementById('metadataList');
  const domSection         = document.getElementById('domSection');
  const domViewer          = document.getElementById('domViewer');
  const zoomLevelEl        = document.getElementById('zoomLevel');
  const toggleOverlay      = document.getElementById('toggleOverlay');
  const toggleDom          = document.getElementById('toggleDom');

  let currentZoom = 1.0;
  let imageWidth = 0;
  let imageHeight = 0;
  let resultData = null;

  // ── Initialize ──
  document.addEventListener('DOMContentLoaded', loadResults);
  document.getElementById('zoomIn').addEventListener('click', () => setZoom(currentZoom + 0.25));
  document.getElementById('zoomOut').addEventListener('click', () => setZoom(currentZoom - 0.25));
  document.getElementById('zoomFit').addEventListener('click', fitToWindow);
  toggleOverlay.addEventListener('change', () => {
    detectionOverlays.style.display = toggleOverlay.checked ? '' : 'none';
  });
  toggleDom.addEventListener('change', () => {
    domSection.classList.toggle('hidden', !toggleDom.checked);
  });

  async function loadResults() {
    try {
      const stored = await chrome.storage.session.get('privamon_result');
      resultData = stored.privamon_result;

      if (!resultData || !resultData.sanitizedScreenshot) {
        loadingState.classList.add('hidden');
        noResults.classList.remove('hidden');
        return;
      }

      // Render screenshot
      await renderScreenshot(resultData.sanitizedScreenshot);

      // Render detection overlays
      if (resultData.detections) {
        renderDetectionOverlays(resultData.detections);
      }

      // Render summary
      renderSummary(resultData.detectionSummary || {});

      // Render timings
      renderTimings(resultData.timings || {});

      // Render metadata
      renderMetadata(resultData.metadata || {});

      // Render sanitized DOM
      if (resultData.sanitizedDom) {
        domViewer.textContent = JSON.stringify(resultData.sanitizedDom, null, 2);
      }

      // Hide loading
      loadingState.classList.add('hidden');

      // Fit to window
      fitToWindow();

    } catch (err) {
      console.error('[Results] Failed to load:', err);
      loadingState.classList.add('hidden');
      noResults.classList.remove('hidden');
    }
  }

  async function renderScreenshot(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        imageWidth = img.width;
        imageHeight = img.height;

        screenshotCanvas.width = imageWidth;
        screenshotCanvas.height = imageHeight;
        const ctx = screenshotCanvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        resolve();
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function renderDetectionOverlays(detections) {
    detectionOverlays.innerHTML = '';

    for (const det of detections) {
      if (!det.bbox) continue;

      const box = document.createElement('div');
      box.className = `detection-box type-${det.type}`;

      // The bbox is in screenshot pixel coordinates.
      // The canvas displays at its natural size (scaled by zoom).
      // We position overlays relative to the canvas using CSS transforms.
      box.style.left = `${det.bbox.x}px`;
      box.style.top = `${det.bbox.y}px`;
      box.style.width = `${det.bbox.width}px`;
      box.style.height = `${det.bbox.height}px`;

      const label = document.createElement('span');
      label.className = 'detection-label';
      label.textContent = `${det.type} (${Math.round((det.confidence || 0) * 100)}%)`;
      box.appendChild(label);

      detectionOverlays.appendChild(box);
    }
  }

  function renderSummary(summary) {
    const typeLabels = {
      email: '📧 Emails',
      phone: '📞 Phone Numbers',
      password: '🔑 Password Fields',
      creditCard: '💳 Credit Cards',
      aadhaar: '🪪 Aadhaar Numbers',
      pan: '🏷️ PAN Numbers',
      face: '👤 Faces',
      name: '📝 Names',
      dob: '📅 Dates of Birth',
      ip: '🌐 IP Addresses',
      address: '🏠 Addresses',
      other: '⚠️ Other Sensitive',
    };

    let html = '';
    let total = 0;

    for (const [type, count] of Object.entries(summary)) {
      if (count <= 0) continue;
      total += count;
      const label = typeLabels[type] || `🔸 ${type}`;
      html += `
        <span class="summary-type">${label}</span>
        <span class="summary-count">${count}</span>
      `;
    }

    if (total === 0) {
      html = `
        <span class="summary-type">✅ No PII detected</span>
        <span class="summary-count">0</span>
      `;
    }

    summaryGrid.innerHTML = html;
  }

  function renderTimings(timings) {
    const stageLabels = {
      domPiiDetection: 'DOM PII Detection',
      pixelIdentification: 'Pixel ID',
      ocr: 'OCR',
      vision: 'Vision',
      fusion: 'Fusion',
      coordinateMapping: 'Coordinate Map',
      redaction: 'Redaction',
      verification: 'Verification',
      domSanitization: 'DOM Sanitization',
      total: 'TOTAL',
    };

    let html = '';
    for (const [key, ms] of Object.entries(timings)) {
      if (key === 'total') continue;
      const label = stageLabels[key] || key;
      html += `
        <div class="timing-row">
          <span>${label}</span>
          <span>${ms}ms</span>
        </div>
      `;
    }

    if (timings.total != null) {
      html += `
        <div class="timing-row total">
          <span>TOTAL</span>
          <span>${timings.total}ms</span>
        </div>
      `;
    }

    timingsTable.innerHTML = html;
  }

  function renderMetadata(metadata) {
    const items = [];

    if (metadata.screenshotDimensions) {
      items.push(['Screenshot', `${metadata.screenshotDimensions.width}×${metadata.screenshotDimensions.height}`]);
    }
    if (metadata.viewportInfo) {
      items.push(['Viewport (CSS)', `${metadata.viewportInfo.cssViewportWidth}×${metadata.viewportInfo.cssViewportHeight}`]);
      items.push(['DPR', metadata.viewportInfo.devicePixelRatio]);
      items.push(['Zoom', `${Math.round(metadata.viewportInfo.estimatedZoom * 100)}%`]);
    }
    if (metadata.coordinateScale) {
      items.push(['Scale X', metadata.coordinateScale.x.toFixed(3)]);
      items.push(['Scale Y', metadata.coordinateScale.y.toFixed(3)]);
    }
    if (metadata.domStats) {
      items.push(['DOM Elements', metadata.domStats.totalExtracted]);
      items.push(['Pixel Regions', metadata.domStats.pixelRegionCount]);
      items.push(['DOM Extraction', `${metadata.domStats.extractionTimeMs}ms`]);
    }
    items.push(['Verification', metadata.verificationPassed ? '✅ Passed' : '⚠️ Re-redacted']);

    metadataList.innerHTML = items.map(([label, value]) => `
      <div class="meta-row">
        <span class="meta-label">${label}</span>
        <span class="meta-value">${value}</span>
      </div>
    `).join('');
  }

  // ── Zoom ──
  function setZoom(level) {
    currentZoom = Math.max(0.25, Math.min(4, level));
    const wrapper = document.querySelector('.canvas-wrapper');
    if (wrapper) {
      wrapper.style.transform = `scale(${currentZoom})`;
    }
    zoomLevelEl.textContent = `${Math.round(currentZoom * 100)}%`;
  }

  function fitToWindow() {
    if (!imageWidth || !imageHeight) return;
    const containerRect = screenshotContainer.getBoundingClientRect();
    const pad = 40;
    const scaleX = (containerRect.width - pad) / imageWidth;
    const scaleY = (containerRect.height - pad) / imageHeight;
    setZoom(Math.min(scaleX, scaleY, 1));
  }
})();
