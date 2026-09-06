/**
 * Privamon — Results Page Controller
 *
 * Loads the sanitized screenshot and analysis results from
 * chrome.storage.session, then renders them with:
 *   - Properly scaled screenshot canvas
 *   - Detection bounding box overlays
 *   - Detection summary + pipeline timings
 *   - Sanitized DOM viewer
 *
 * IMPORTANT:
 * Zoom is handled by changing the actual CSS dimensions of the
 * canvas/wrapper instead of using transform: scale().
 * This keeps scrolling and detection overlays correctly aligned.
 */
(() => {
  'use strict';

  // ──────────────────────────────────────────────
  // DOM References
  // ──────────────────────────────────────────────

  const screenshotCanvas =
    document.getElementById('screenshotCanvas');

  const screenshotContainer =
    document.getElementById('screenshotContainer');

  const canvasWrapper =
    document.querySelector('.canvas-wrapper');

  const detectionOverlays =
    document.getElementById('detectionOverlays');

  const loadingState =
    document.getElementById('loadingState');

  const noResults =
    document.getElementById('noResults');

  const summaryGrid =
    document.getElementById('summaryGrid');

  const timingsTable =
    document.getElementById('timingsTable');

  const metadataList =
    document.getElementById('metadataList');

  const domSection =
    document.getElementById('domSection');

  const domViewer =
    document.getElementById('domViewer');

  const ocrRawViewer =
    document.getElementById('ocrRawViewer');

  const ocrSanitizedViewer =
    document.getElementById('ocrSanitizedViewer');

  const zoomLevelEl =
    document.getElementById('zoomLevel');

  const toggleRedact =
    document.getElementById('toggleRedact');

  const toggleReview =
    document.getElementById('toggleReview');

  const toggleKept =
    document.getElementById('toggleKept');

  const toggleOcrWords =
    document.getElementById('toggleOcrWords');

  const toggleDom =
    document.getElementById('toggleDom');

  const zoomInBtn =
    document.getElementById('zoomIn');

  const zoomOutBtn =
    document.getElementById('zoomOut');

  const zoomFitBtn =
    document.getElementById('zoomFit');


  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────

  let currentZoom = 1.0;

  let imageWidth = 0;
  let imageHeight = 0;

  let resultData = null;


  // ──────────────────────────────────────────────
  // Initialize
  // ──────────────────────────────────────────────

  document.addEventListener(
    'DOMContentLoaded',
    loadResults
  );

  zoomInBtn?.addEventListener('click', () => {
    setZoom(currentZoom + 0.25);
  });

  zoomOutBtn?.addEventListener('click', () => {
    setZoom(currentZoom - 0.25);
  });

  zoomFitBtn?.addEventListener('click', () => {
    fitToWindow();
  });

  function refreshOverlays() {
    if (resultData && Array.isArray(resultData.detections)) {
      renderDetectionOverlays(resultData.detections);
    }
  }

  toggleRedact?.addEventListener('change', refreshOverlays);
  toggleReview?.addEventListener('change', refreshOverlays);
  toggleKept?.addEventListener('change', refreshOverlays);
  toggleOcrWords?.addEventListener('change', refreshOverlays);

  toggleDom?.addEventListener('change', () => {
    domSection.classList.toggle(
      'hidden',
      !toggleDom.checked
    );
  });


  // ──────────────────────────────────────────────
  // Load Results
  // ──────────────────────────────────────────────

  async function loadResults() {
    try {
      const stored =
        await chrome.storage.session.get(
          'privamon_result'
        );

      resultData =
        stored.privamon_result;

      if (
        !resultData ||
        !resultData.sanitizedScreenshot
      ) {
        loadingState.classList.add('hidden');
        noResults.classList.remove('hidden');
        return;
      }


      // ──────────────────────────────────────────
      // Render screenshot
      // ──────────────────────────────────────────

      await renderScreenshot(
        resultData.sanitizedScreenshot
      );


      // ──────────────────────────────────────────
      // Render detection overlays
      // ──────────────────────────────────────────

      if (Array.isArray(resultData.detections)) {
        renderDetectionOverlays(
          resultData.detections
        );
      }


      // ──────────────────────────────────────────
      // Render summary
      // ──────────────────────────────────────────

      renderSummary(
        resultData.detectionSummary || {}
      );


      // ──────────────────────────────────────────
      // Render timings
      // ──────────────────────────────────────────

      renderTimings(
        resultData.timings || {}
      );


      // ──────────────────────────────────────────
      // Render metadata
      // ──────────────────────────────────────────

      renderMetadata(
        resultData.metadata || {}
      );


      // ──────────────────────────────────────────
      // Render sanitized DOM
      // ──────────────────────────────────────────

      if (resultData.sanitizedDom) {
        domViewer.textContent =
          JSON.stringify(
            resultData.sanitizedDom,
            null,
            2
          );
      }

      // ──────────────────────────────────────────
      // Render OCR Text
      // ──────────────────────────────────────────

      if (resultData.ocrRawText) {
        let rawHtml = resultData.ocrRawText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let sanitizedHtml = rawHtml;
        
        if (Array.isArray(resultData.detections)) {
          const ocrDets = resultData.detections.filter(d => d.source === 'ocr' && d.text);
          // Sort by length descending to avoid partial replacements
          ocrDets.sort((a, b) => b.text.length - a.text.length);
          
          for (const det of ocrDets) {
            const confClass = det.confidence > 0.85 ? 'confidence-high' : (det.confidence > 0.6 ? 'confidence-med' : 'confidence-low');
            const confBadge = `<span class="confidence-badge ${confClass}">${Math.round((det.confidence || 0) * 100)}%</span>`;
            
            // Highlight in Raw (just append confidence badge)
            const rawReplacement = `${det.text}${confBadge}`;
            rawHtml = rawHtml.split(det.text).join(rawReplacement);

            // Redact in Sanitized
            const sanitizedReplacement = `[REDACTED ${det.type.toUpperCase()}]${confBadge}`;
            sanitizedHtml = sanitizedHtml.split(det.text).join(sanitizedReplacement);
          }
        }
        ocrRawViewer.innerHTML = rawHtml;
        ocrSanitizedViewer.innerHTML = sanitizedHtml;
      } else {
        ocrRawViewer.textContent = "No OCR text detected.";
        ocrSanitizedViewer.textContent = "No OCR text detected.";
      }


      // ──────────────────────────────────────────
      // Hide loading state
      // ──────────────────────────────────────────

      loadingState.classList.add('hidden');


      // ──────────────────────────────────────────
      // Fit screenshot to available window
      // ──────────────────────────────────────────

      // Give the browser one frame to calculate
      // the final container dimensions.
      requestAnimationFrame(() => {
        fitToWindow();
      });

    } catch (err) {
      console.error(
        '[Results] Failed to load:',
        err
      );

      loadingState.classList.add('hidden');
      noResults.classList.remove('hidden');
    }
  }


  // ──────────────────────────────────────────────
  // Render Screenshot
  // ──────────────────────────────────────────────

  async function renderScreenshot(dataUrl) {
    return new Promise((resolve, reject) => {

      const img = new Image();

      img.onload = () => {

        // Use natural dimensions so we preserve
        // the original screenshot resolution.
        imageWidth =
          img.naturalWidth || img.width;

        imageHeight =
          img.naturalHeight || img.height;


        if (
          !imageWidth ||
          !imageHeight
        ) {
          reject(
            new Error(
              'Invalid screenshot dimensions'
            )
          );
          return;
        }


        // Canvas keeps ORIGINAL resolution.
        screenshotCanvas.width =
          imageWidth;

        screenshotCanvas.height =
          imageHeight;


        const ctx =
          screenshotCanvas.getContext('2d');


        if (!ctx) {
          reject(
            new Error(
              'Could not create canvas context'
            )
          );
          return;
        }


        // Clear previous image
        ctx.clearRect(
          0,
          0,
          imageWidth,
          imageHeight
        );


        // Draw at native resolution
        ctx.drawImage(
          img,
          0,
          0,
          imageWidth,
          imageHeight
        );


        // Set the initial actual CSS size.
        // This is changed again by setZoom().
        updateCanvasSize();


        resolve();
      };


      img.onerror = () => {
        reject(
          new Error(
            'Failed to load screenshot'
          )
        );
      };


      img.src = dataUrl;
    });
  }


  // ──────────────────────────────────────────────
  // Update Actual Canvas Size
  // ──────────────────────────────────────────────
  //
  // IMPORTANT:
  // We DON'T use transform: scale().
  //
  // Instead:
  //
  //   canvas.width  = original pixel width
  //   canvas.height = original pixel height
  //
  // and:
  //
  //   CSS width  = original width  × zoom
  //   CSS height = original height × zoom
  //
  // This makes the browser's layout system aware
  // of the actual displayed size.
  // ──────────────────────────────────────────────

  function updateCanvasSize() {

    if (
      !imageWidth ||
      !imageHeight
    ) {
      return;
    }


    const displayWidth =
      Math.max(
        1,
        Math.round(
          imageWidth * currentZoom
        )
      );


    const displayHeight =
      Math.max(
        1,
        Math.round(
          imageHeight * currentZoom
        )
      );


    // Wrapper gets the exact same dimensions
    // as the screenshot.
    if (canvasWrapper) {
      canvasWrapper.style.width =
        `${displayWidth}px`;

      canvasWrapper.style.height =
        `${displayHeight}px`;

      // Remove any old transform that might
      // have been applied by previous code.
      canvasWrapper.style.transform =
        'none';
    }


    // Actual visual dimensions of canvas
    screenshotCanvas.style.width =
      `${displayWidth}px`;

    screenshotCanvas.style.height =
      `${displayHeight}px`;


    // Overlay follows exactly the same size
    // as the screenshot.
    detectionOverlays.style.width =
      `${displayWidth}px`;

    detectionOverlays.style.height =
      `${displayHeight}px`;
  }


  // ──────────────────────────────────────────────
  // Detection Overlays
  // ──────────────────────────────────────────────

  function renderDetectionOverlays(detections) {
    detectionOverlays.innerHTML = '';

    const showRedact = toggleRedact ? toggleRedact.checked : true;
    const showReview = toggleReview ? toggleReview.checked : true;
    const showKept = toggleKept ? toggleKept.checked : false;
    const showOcrWords = toggleOcrWords ? toggleOcrWords.checked : false;

    // 1. Render raw OCR word boxes if toggle is active
    if (showOcrWords && resultData && Array.isArray(resultData.ocrWords)) {
      for (const w of resultData.ocrWords) {
        if (!w || !w.bbox) continue;
        const b = w.bbox;
        const box = document.createElement('div');
        box.className = 'detection-box ocr-word-box';
        box.style.left = `${b.x * currentZoom}px`;
        box.style.top = `${b.y * currentZoom}px`;
        box.style.width = `${b.width * currentZoom}px`;
        box.style.height = `${b.height * currentZoom}px`;
        box.style.border = '1px dashed #10b981';
        box.style.backgroundColor = 'rgba(16, 185, 129, 0.08)';
        box.style.pointerEvents = 'auto';
        box.title = `OCR Word: "${w.text}" (${Math.round((w.confidence || 0) * 100)}%)`;
        detectionOverlays.appendChild(box);
      }
    }

    if (!Array.isArray(detections)) {
      return;
    }

    for (const det of detections) {
      if (!det) continue;

      const decision = det.decision || 'REDACT';
      if (decision === 'REDACT' && !showRedact) continue;
      if (decision === 'REVIEW' && !showReview) continue;
      if (decision === 'KEEP' && !showKept) continue;

      const targetBoxes = (Array.isArray(det.boxes) && det.boxes.length > 0)
        ? det.boxes
        : (det.bbox ? [det.bbox] : []);

      if (targetBoxes.length === 0) continue;

      const entityType = (det.type || 'other').toLowerCase();
      const confidence = Number.isFinite(det.confidence)
        ? Math.round(det.confidence * 100)
        : (Number.isFinite(det.model_confidence) ? Math.round(det.model_confidence * 100) : 0);
      const decScore = Number.isFinite(det.decision_score)
        ? det.decision_score.toFixed(2)
        : (confidence / 100).toFixed(2);

      const decisionClass = `decision-${decision.toLowerCase()}`;

      for (let i = 0; i < targetBoxes.length; i++) {
        const b = targetBoxes[i];
        if (
          !b ||
          !Number.isFinite(b.x) ||
          !Number.isFinite(b.y) ||
          !Number.isFinite(b.width) ||
          !Number.isFinite(b.height) ||
          b.width <= 0 ||
          b.height <= 0
        ) {
          continue;
        }

        const box = document.createElement('div');
        box.className = `detection-box type-${entityType} ${decisionClass}`;

        box.style.left = `${b.x * currentZoom}px`;
        box.style.top = `${b.y * currentZoom}px`;
        box.style.width = `${b.width * currentZoom}px`;
        box.style.height = `${b.height * currentZoom}px`;

        if (decision === 'REVIEW') {
          box.style.border = '2px dashed #f59e0b';
          box.style.backgroundColor = 'rgba(245, 158, 11, 0.12)';
        } else if (decision === 'KEEP') {
          box.style.border = '1px dotted #3b82f6';
          box.style.backgroundColor = 'rgba(59, 130, 246, 0.08)';
        }

        const tooltip = [
          `Type: ${det.type || 'unknown'}`,
          `Decision: ${decision} (Decision Score: ${decScore})`,
          `Sensitivity: ${det.sensitivity_class || 'DIRECT_PII'}`,
          det.model_confidence !== undefined ? `Model Conf: ${Math.round(det.model_confidence * 100)}%` : null,
          det.reason ? `Reason: ${det.reason}` : null,
          det.positive_evidence && det.positive_evidence.length ? `Positive Evidence: ${det.positive_evidence.join(', ')}` : null,
          det.negative_evidence && det.negative_evidence.length ? `Negative Evidence: ${det.negative_evidence.join(', ')}` : null,
          det.source ? `Source: ${Array.isArray(det.source) ? det.source.join(', ') : det.source}` : null
        ].filter(Boolean).join('\n');

        box.title = tooltip;

        // Attach label only to the first box of the entity
        if (i === 0) {
          const label = document.createElement('span');
          label.className = 'detection-label';
          label.textContent = `${det.type || 'other'} [${decision}] (${confidence}%)`;
          if (decision === 'REVIEW') label.style.background = '#f59e0b';
          if (decision === 'KEEP') label.style.background = '#3b82f6';
          box.appendChild(label);
        }

        detectionOverlays.appendChild(box);
      }
    }
  }


  // ──────────────────────────────────────────────
  // Re-render Detection Overlays When Zoom
  // Changes
  // ──────────────────────────────────────────────

  function refreshDetectionOverlayScale() {

    if (
      !resultData ||
      !Array.isArray(
        resultData.detections
      )
    ) {
      return;
    }


    renderDetectionOverlays(
      resultData.detections
    );
  }


  // ──────────────────────────────────────────────
  // Detection Summary
  // ──────────────────────────────────────────────

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
      employee_id: '🪪 Employee IDs',
      customer_id: '🏷️ Customer IDs',
      other: '⚠️ Other Sensitive',
    };

    let html = '';

    // High-Level Candidate Decision Breakdown & Warnings
    if (resultData) {
      const candidates = resultData.allCandidates || resultData.detections || [];
      const redacts = candidates.filter(c => !c.decision || c.decision === 'REDACT').length;
      const reviews = candidates.filter(c => c.decision === 'REVIEW').length;
      const kept = candidates.filter(c => c.decision === 'KEEP').length;

      const warnings = (resultData.metadata && Array.isArray(resultData.metadata.warnings))
        ? resultData.metadata.warnings
        : [];

      if (warnings.length > 0) {
        html += `
          <div style="grid-column: 1 / -1; padding: 8px 10px; margin-bottom: 10px; background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; border-radius: 4px; color: #fca5a5; font-size: 11px; line-height: 1.4;">
            <strong>⚠️ Scan Degraded — Subsystem Unavailable:</strong><br>
            ${warnings.map(w => `• ${w}`).join('<br>')}
          </div>
        `;
      }

      html += `
        <div style="grid-column: 1 / -1; display: flex; gap: 6px; margin-bottom: 12px; font-size: 11px; font-weight: 600;">
          <span style="flex: 1; padding: 6px 4px; background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; border-radius: 4px; text-align: center; color: #f87171;" title="Candidates flagged for redaction">
            🛑 REDACT: ${redacts}
          </span>
          <span style="flex: 1; padding: 6px 4px; background: rgba(245, 158, 11, 0.15); border: 1px solid #f59e0b; border-radius: 4px; text-align: center; color: #fbbf24;" title="Ambiguous candidates needing review">
            ⚠️ REVIEW: ${reviews}
          </span>
          <span style="flex: 1; padding: 6px 4px; background: rgba(59, 130, 246, 0.15); border: 1px solid #3b82f6; border-radius: 4px; text-align: center; color: #60a5fa;" title="Kept candidates (non-PII / rejected)">
            🟢 KEEP: ${kept}
          </span>
        </div>
      `;
    }

    let total = 0;

    for (
      const [type, count] of
      Object.entries(summary)
    ) {

      if (
        typeof count !== 'number' ||
        count <= 0
      ) {
        continue;
      }

      total += count;

      const label =
        typeLabels[type] ||
        `🔸 ${type}`;

      html += `
        <span class="summary-type">
          ${label}
        </span>

        <span class="summary-count">
          ${count}
        </span>
      `;
    }

    if (total === 0) {
      const hasWarnings = resultData?.metadata?.warnings?.length > 0;
      if (hasWarnings) {
        html += `
          <span class="summary-type" style="color: #f87171;">
            ⚠️ Incomplete scan (Engine Degraded)
          </span>

          <span class="summary-count" style="color: #f87171;">
            !
          </span>
        `;
      } else {
        html += `
          <span class="summary-type">
            ✅ No sensitive PII detected
          </span>

          <span class="summary-count">
            0
          </span>
        `;
      }
    }


    summaryGrid.innerHTML = html;
  }


  // ──────────────────────────────────────────────
  // Pipeline Timings
  // ──────────────────────────────────────────────

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


    for (
      const [key, ms] of
      Object.entries(timings)
    ) {

      if (key === 'total') {
        continue;
      }


      const label =
        stageLabels[key] || key;


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


  // ──────────────────────────────────────────────
  // Metadata
  // ──────────────────────────────────────────────

  function renderMetadata(metadata) {

    const items = [];


    if (metadata.screenshotDimensions) {

      items.push([
        'Screenshot',
        `${metadata.screenshotDimensions.width}×${metadata.screenshotDimensions.height}`
      ]);
    }


    if (metadata.viewportInfo) {

      items.push([
        'Viewport (CSS)',
        `${metadata.viewportInfo.cssViewportWidth}×${metadata.viewportInfo.cssViewportHeight}`
      ]);


      items.push([
        'DPR',
        metadata.viewportInfo.devicePixelRatio
      ]);


      items.push([
        'Zoom',
        `${Math.round(
          metadata.viewportInfo.estimatedZoom * 100
        )}%`
      ]);
    }


    if (metadata.coordinateScale) {

      items.push([
        'Scale X',
        Number(
          metadata.coordinateScale.x
        ).toFixed(3)
      ]);


      items.push([
        'Scale Y',
        Number(
          metadata.coordinateScale.y
        ).toFixed(3)
      ]);
    }


    if (metadata.domStats) {

      items.push([
        'DOM Elements',
        metadata.domStats.totalExtracted
      ]);


      items.push([
        'Pixel Regions',
        metadata.domStats.pixelRegionCount
      ]);


      items.push([
        'DOM Extraction',
        `${metadata.domStats.extractionTimeMs}ms`
      ]);
    }


    items.push([
      'Verification',
      metadata.verificationPassed
        ? '✅ Passed'
        : '⚠️ Re-redacted'
    ]);


    metadataList.innerHTML =
      items
        .map(
          ([label, value]) => `
            <div class="meta-row">
              <span class="meta-label">
                ${label}
              </span>

              <span class="meta-value">
                ${value}
              </span>
            </div>
          `
        )
        .join('');
  }


  // ──────────────────────────────────────────────
  // Zoom
  // ──────────────────────────────────────────────

  function setZoom(level) {

    currentZoom =
      Math.max(
        0.1,
        Math.min(4.0, level)
      );


    // Update ACTUAL dimensions
    updateCanvasSize();


    // Detection coordinates need to follow
    // the zoom level.
    refreshDetectionOverlayScale();


    // Update UI
    zoomLevelEl.textContent =
      `${Math.round(
        currentZoom * 100
      )}%`;
  }


  // ──────────────────────────────────────────────
  // Fit Screenshot To Window
  // ──────────────────────────────────────────────

  function fitToWindow() {

    if (
      !imageWidth ||
      !imageHeight
    ) {
      return;
    }


    const containerWidth =
      screenshotContainer.clientWidth;


    const containerHeight =
      screenshotContainer.clientHeight;


    // Match CSS padding: 24px on each side.
    const availableWidth =
      Math.max(
        1,
        containerWidth - 48
      );


    const availableHeight =
      Math.max(
        1,
        containerHeight - 48
      );


    const scaleX =
      availableWidth / imageWidth;


    const scaleY =
      availableHeight / imageHeight;


    // Keep aspect ratio.
    let scale =
      Math.min(
        scaleX,
        scaleY
      );


    // Don't enlarge small screenshots.
    scale =
      Math.min(
        scale,
        1
      );


    // Prevent an unusably tiny screenshot.
    scale =
      Math.max(
        scale,
        0.1
      );


    setZoom(scale);


    // Reset scroll position.
    screenshotContainer.scrollLeft = 0;
    screenshotContainer.scrollTop = 0;
  }


  // ──────────────────────────────────────────────
  // Window Resize
  // ──────────────────────────────────────────────

  let resizeTimer = null;

  window.addEventListener(
    'resize',
    () => {

      clearTimeout(resizeTimer);

      resizeTimer = setTimeout(() => {

        // Only automatically refit if the
        // screenshot is currently at a fitted
        // / <=100% scale.
        //
        // Don't destroy user's manual zoom.
        if (currentZoom <= 1.0) {
          fitToWindow();
        }

      }, 100);
    }
  );

})();