/**
 * Privamon — Background Service Worker
 *
 * Central coordinator for the extension. Orchestrates:
 *   1. Screenshot capture (atomic snapshot via captureVisibleTab)
 *   2. DOM extraction (content script injection — immediately after screenshot)
 *   3. Offscreen document creation & pipeline execution
 *   4. Result storage and UI signaling
 *
 * ── SYNCHRONIZATION (Correction #2) ──
 *
 * The screenshot and DOM extraction must represent the same page state.
 * Strategy: capture screenshot FIRST (it's an atomic browser API snapshot),
 * then inject the content script to extract DOM immediately after.
 *
 * captureVisibleTab() is a synchronous snapshot of the current render frame.
 * The DOM extraction follows within milliseconds. For static/semi-static pages
 * (the vast majority of cases), this gives us a consistent state.
 *
 * Both use viewport-relative coordinates:
 *   - captureVisibleTab captures the viewport as-is
 *   - getBoundingClientRect returns viewport-relative CSS coordinates
 *   - No scroll offset subtraction needed (Correction #1)
 */

// ── Offscreen document management ──

let offscreenReady = false;

async function ensureOffscreenDocument() {
  // Check if we already have an offscreen document
  if (offscreenReady) {
    // Double-check it still exists
    try {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL('offscreen/offscreen.html')],
      });
      if (existingContexts.length > 0) return;
    } catch (e) {
      // getContexts may not be available — fall through to creation
    }
  }

  // Create offscreen document (catch if already exists)
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
      justification: 'Image processing for PII redaction (Canvas), OCR (Workers)',
    });
    offscreenReady = true;
    console.log('[Background] Offscreen document created');
  } catch (err) {
    if (err.message?.includes('Only a single offscreen')) {
      // Already exists — that's fine
      offscreenReady = true;
    } else {
      throw err;
    }
  }
}

// ── Message Handling ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // From popup: start analysis
  if (message.action === 'startAnalysis') {
    handleStartAnalysis(message.task)
      .then(response => sendResponse(response))
      .catch(err => sendResponse({ error: err.message }));
    return true; // Async response
  }

  // From offscreen: pipeline progress updates → forward to popup
  if (message.type === 'pipelineProgress') {
    forwardToPopup(message);
  }

  // From offscreen: pipeline result
  if (message.type === 'pipelineResult') {
    handlePipelineResult(message);
  }
});

/**
 * Handle the "startAnalysis" action from the popup.
 */
async function handleStartAnalysis(task) {
  console.log('[Background] Starting analysis. Task:', task);

  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab found');

    // ── STEP 1: Capture screenshot (FIRST — atomic snapshot) ──
    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'capture',
      status: 'active',
      statusText: 'Capturing screenshot...',
    });

    const captureStart = performance.now();
    const screenshot = await chrome.tabs.captureVisibleTab(null, {
      format: 'png',
    });
    const captureTime = Math.round(performance.now() - captureStart);

    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'capture',
      status: 'done',
      timeMs: captureTime,
    });

    console.log(`[Background] Screenshot captured in ${captureTime}ms`);

    // ── STEP 2: Extract DOM (immediately after screenshot) ──
    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'dom',
      status: 'active',
      statusText: 'Extracting DOM elements...',
    });

    const domStart = performance.now();
    const domResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/dom-range-mapper.js', 'content/dom-extractor.js'],
    });
    const domTime = Math.round(performance.now() - domStart);

    // executeScript with a file returns the IIFE's return value
    const domData = domResults[0]?.result;
    if (!domData) throw new Error('DOM extraction returned no data');

    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'dom',
      status: 'done',
      timeMs: domTime,
      statusText: `Extracted ${domData.stats.totalExtracted} elements`,
    });

    console.log(`[Background] DOM extracted: ${domData.stats.totalExtracted} elements in ${domTime}ms`);

    // ── STEP 3: Create offscreen document & run pipeline ──
    await ensureOffscreenDocument();

    // Send data to offscreen for processing
    chrome.runtime.sendMessage({
      action: 'runPipeline',
      screenshot,
      domData,
      task,
    });

    // Store task for results page
    await chrome.storage.session.set({ privamon_task: task });

    return { status: 'processing' };
  } catch (err) {
    console.error('[Background] Analysis failed:', err);
    forwardToPopup({
      type: 'pipelineError',
      error: err.message,
    });
    return { error: err.message };
  }
}

/**
 * Handle pipeline result from the offscreen document.
 */
async function handlePipelineResult(message) {
  if (message.error) {
    console.error('[Background] Pipeline error:', message.error);
    forwardToPopup({
      type: 'pipelineError',
      error: message.error,
    });
    return;
  }

  const result = message.result;
  console.log('[Background] Pipeline complete. Storing results...');

  try {
    // Store results in session storage for the results page
    await chrome.storage.session.set({
      privamon_result: {
        sanitizedScreenshot: result.sanitizedScreenshot,
        detections: result.detections,
        detectionSummary: result.detectionSummary,
        sanitizedDom: result.sanitizedDom,
        timings: result.timings,
        metadata: result.metadata,
        timestamp: Date.now(),
      },
    });

    // Notify the popup
    forwardToPopup({
      type: 'pipelineComplete',
      result: {
        detectionSummary: result.detectionSummary,
        timings: result.timings,
      },
    });

    console.log('[Background] Results stored successfully');
  } catch (err) {
    console.error('[Background] Failed to store results:', err);

    // If storage fails (e.g., data too large), try with reduced data
    try {
      await chrome.storage.session.set({
        privamon_result: {
          sanitizedScreenshot: result.sanitizedScreenshot,
          detectionSummary: result.detectionSummary,
          timings: result.timings,
          metadata: result.metadata,
          timestamp: Date.now(),
          // Omit full detections and sanitizedDom to save space
          detections: result.detections.slice(0, 50),
          sanitizedDom: null,
        },
      });

      forwardToPopup({
        type: 'pipelineComplete',
        result: {
          detectionSummary: result.detectionSummary,
          timings: result.timings,
        },
      });
    } catch (err2) {
      forwardToPopup({
        type: 'pipelineError',
        error: 'Results too large to store. Please try a simpler page.',
      });
    }
  }
}

/**
 * Forward a message to the popup (and any open results pages).
 * Non-critical — if popup is closed, the message is silently dropped.
 */
function forwardToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup might be closed — that's fine
  });
}

console.log('[Background] Privamon service worker initialized');
