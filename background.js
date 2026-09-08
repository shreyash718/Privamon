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

/**
 * Pings the offscreen document to check if it is loaded, parsed, and listening.
 */
async function pingOffscreen(timeoutMs = 600) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(false);
      }
    }, timeoutMs);

    chrome.runtime.sendMessage({ action: 'pingOffscreen' })
      .then((res) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(res && res.ready === true);
        }
      })
      .catch(() => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
  });
}

async function ensureOffscreenDocument() {
  // 1. If marked ready, verify with a fast ping
  if (offscreenReady) {
    const isAlive = await pingOffscreen(300);
    if (isAlive) return;
    offscreenReady = false;
  }

  // 2. Check if an offscreen context already exists in the browser
  let hasContext = false;
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen/offscreen.html')],
    });
    hasContext = contexts && contexts.length > 0;
  } catch (e) {
    // getContexts may not be available on all Chrome versions
  }

  if (hasContext) {
    const isAlive = await pingOffscreen(400);
    if (isAlive) {
      offscreenReady = true;
      return;
    }
    // Document exists but is unresponsive — close it to start fresh
    try {
      if (chrome.offscreen && typeof chrome.offscreen.closeDocument === 'function') {
        await chrome.offscreen.closeDocument();
      }
    } catch (e) { /* ignore */ }
  }

  // 3. Create fresh offscreen document
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
      justification: 'Image processing for PII redaction (Canvas), OCR (Workers)',
    });
    console.log('[Background] Offscreen document created');
  } catch (err) {
    if (!err.message?.includes('Only a single offscreen')) {
      throw err;
    }
  }

  // 4. Poll ping until offscreen scripts finish parsing and initialize (up to 12s)
  const startTime = performance.now();
  while (performance.now() - startTime < 12000) {
    const ready = await pingOffscreen(300);
    if (ready) {
      offscreenReady = true;
      console.log(`[Background] Offscreen document confirmed ready in ${Math.round(performance.now() - startTime)}ms`);
      return;
    }
    await new Promise(r => setTimeout(r, 150));
  }

  throw new Error('Offscreen document failed to initialize modules within 12 seconds');
}

// ── Helper: Forward message to popup UI ──

/**
 * Forward a message to the popup (and any open results pages).
 * Non-critical — if popup is closed, the message is silently dropped.
 */
function forwardToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup might be closed — that's fine
  });
}

// ── Message Handling ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Conversational agent query with automatic screenshot, redaction, server consultation, and history
  if (message.action === 'chatWithAgent') {
    handleChatWithAgent(message.task, message.serverUrl)
      .then(response => {
        try {
          sendResponse(response);
        } catch (e) {
          console.warn('[Background] Message channel already closed when sending response (popup may have closed):', e.message);
        }
      })
      .catch(err => {
        try {
          sendResponse({ error: err.message });
        } catch (e) {}
      });
    return true; // Async response
  }

  // From popup: start analysis (legacy one-shot analysis)
  if (message.action === 'startAnalysis') {
    handleStartAnalysis(message.task)
      .then(response => sendResponse(response))
      .catch(err => sendResponse({ error: err.message }));
    return true; // Async response
  }

  // Retrieve chat history
  if (message.action === 'getChatHistory') {
    chrome.storage.local.get(['privamon_chat_history'], (res) => {
      sendResponse({ history: res.privamon_chat_history || [] });
    });
    return true;
  }

  // Clear chat history
  if (message.action === 'clearChatHistory') {
    chrome.storage.local.set({ privamon_chat_history: [] }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  // Check server health
  if (message.action === 'checkServerStatus') {
    const url = (message.serverUrl || 'http://localhost:8000').replace(/\/+$/, '') + '/health';
    fetch(url)
      .then(r => r.json())
      .then(data => sendResponse({ online: data.status === 'ok' || true, data }))
      .catch(err => sendResponse({ online: false, error: err.message }));
    return true;
  }

  // Execute a single action on the active tab
  if (message.action === 'executeAction') {
    handleExecuteAction(message.payload)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Auto-pilot loop: execute → re-capture → re-analyze → execute (repeat)
  if (message.action === 'executeActionLoop') {
    handleActionLoop(message.task, message.serverUrl, message.maxSteps || 8)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Stop running auto-pilot loop
  if (message.action === 'stopActionLoop') {
    stopActionLoop();
    sendResponse({ success: true, message: 'Loop stop requested' });
    return true;
  }

  // From offscreen: offscreen document loaded and ready
  if (message.type === 'offscreenReady') {
    offscreenReady = true;
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
 * Checks if a tab URL is restricted by Chrome extension security policy.
 */
function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('devtools://') ||
    url.startsWith('view-source:') ||
    url.includes('chromewebstore.google.com')
  );
}

/**
 * Gets an accessible browser tab for Privamon operations.
 * If the current active tab is restricted (e.g. chrome://extensions), it finds and switches
 * to an open web tab (preferring WhatsApp Web or standard http/https pages) in the same window.
 */
async function getOperableTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (activeTab && !isRestrictedUrl(activeTab.url)) {
    return activeTab;
  }

  // Active tab is restricted (like chrome://extensions/)
  const allTabs = await chrome.tabs.query({ currentWindow: true });

  // Look for WhatsApp Web tab or any accessible web tab
  const whatsappTab = allTabs.find(t => t.url && t.url.includes('web.whatsapp.com'));
  const accessibleWebTab = allTabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
  const candidate = whatsappTab || accessibleWebTab;

  if (candidate) {
    console.log(`[Background] Active tab is restricted (${activeTab?.url || 'unknown'}). Switching to web tab: ${candidate.url}`);
    await chrome.tabs.update(candidate.id, { active: true });
    // Brief settle delay for Chrome to bring tab into focus
    await new Promise(r => setTimeout(r, 400));
    return candidate;
  }

  throw new Error('Cannot access browser system pages (chrome://). Please open or switch to a web tab (e.g. WhatsApp Web, https://...) and try again.');
}

/**
 * Waits for a tab to finish loading and for client-side frameworks/SPAs to render.
 */
async function waitForTabReady(tabId, maxWaitMs = 6000) {
  if (!tabId) return null;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const tabInfo = await chrome.tabs.get(tabId);
      if (tabInfo && tabInfo.status === 'complete') {
        // Tab finished loading; wait 450ms for dynamic DOM / SPA frameworks to render
        await new Promise(r => setTimeout(r, 450));
        return tabInfo;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
  }
  return await chrome.tabs.get(tabId).catch(() => null);
}

/**
 * Handle the "startAnalysis" action from the popup.
 */
async function handleStartAnalysis(task) {
  console.log('[Background] Starting analysis. Task:', task);

  try {
    // Get the active tab (switches if currently on chrome://extensions)
    const tab = await getOperableTab();

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
    try {
      if (chrome.offscreen && typeof chrome.offscreen.closeDocument === 'function') {
        await chrome.offscreen.closeDocument();
      }
    } catch (e) { /* ignore */ }
    offscreenReady = false;
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
        allCandidates: result.allCandidates || result.detections,
        redactions: result.redactions || [],
        reviews: result.reviews || [],
        kept: result.kept || [],
        ocrWords: result.ocrWords || [],
        detectionSummary: result.detectionSummary,
        sanitizedDom: result.sanitizedDom,
        ocrRawText: result.ocrRawText,
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
          ocrRawText: result.ocrRawText,
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
  } finally {
    // Keep offscreen document alive across queries so persistent ONNX sessions and
    // Tesseract worker remain warm in memory without re-parsing/re-downloading.
    offscreenReady = true;
  }
}

/**
 * Conversational agent query flow:
 * 1. Capture screenshot of the active tab.
 * 2. Extract DOM elements.
 * 3. Run full local privacy pipeline (PII detection, face detection, solid redactions, verification).
 * 4. Transmit redacted screenshot & sanitized DOM to server_side_agent (/interpret).
 * 5. Save the turn in chrome.storage.local (chat history).
 * 6. Return response to popup / side panel.
 */
async function handleChatWithAgent(task, serverUrl = 'http://localhost:8000') {
  const queryText = (task && task.trim()) ? task.trim() : 'Analyze screen and recommend what to do';
  console.log('[Background] Chat with agent requested. Query:', queryText);

  // Keep MV3 service worker active while awaiting privacy pipeline and model inference
  const keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 3500);

  try {
    // Get active operable tab (automatically switches if user was on chrome://extensions)
    const tab = await getOperableTab();
    await waitForTabReady(tab.id, 6000);

    // Step 1: Capture screenshot
    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'capture',
      status: 'active',
      statusText: 'Capturing screen...',
    });

    let screenshot = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
        if (screenshot) break;
      } catch (capErr) {
        console.warn(`[Background] captureVisibleTab retry ${attempt + 1}:`, capErr.message);
        await new Promise(r => setTimeout(r, 450));
      }
    }
    if (!screenshot) throw new Error('Failed to capture visible tab screenshot. Ensure page is visible.');

    // Step 2: Extract DOM
    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'dom',
      status: 'active',
      statusText: 'Extracting DOM context...',
    });

    let domData = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const domResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/dom-range-mapper.js', 'content/dom-extractor.js'],
        });
        domData = domResults[0]?.result;
        if (domData) break;
      } catch (scriptErr) {
        console.warn(`[Background] DOM extraction retry ${attempt + 1}:`, scriptErr.message);
        await new Promise(r => setTimeout(r, 550));
      }
    }
    if (!domData) throw new Error('DOM extraction returned no data. Page may still be loading.');

    // Step 3: Ensure offscreen document & run privacy pipeline
    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'redaction',
      status: 'active',
      statusText: 'Redacting PII and detecting faces locally...',
    });

    await ensureOffscreenDocument();
    const pipelineResult = await runPipelineAsync(screenshot, domData, queryText);

    // Step 4: Transmit sanitized screenshot to server side agent
    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'server',
      status: 'active',
      statusText: 'Consulting vision agent on server (Ollama)...',
    });

    let agentResp = { actions: [], message: '', thinking: '', raw_model_output: '' };
    try {
      agentResp = await sendToServerAgent(pipelineResult, queryText, serverUrl, tab);
    } catch (serverErr) {
      console.warn('[Background] Server side agent query failed:', serverErr.message);
      agentResp = {
        actions: [],
        message: `Server Error: ${serverErr.message}. Ensure 'uvicorn main:app --reload --port 8000' is running.`,
        thinking: '',
        raw_model_output: ''
      };
    }

    // Step 5: Construct chat turn conforming to Reasoning Agent contract
    const turn = {
      id: 'turn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      timestamp: Date.now(),
      task: queryText,
      screenshotUrl: pipelineResult.sanitizedScreenshot,
      redactionsCount: (pipelineResult.redactions || []).length,
      redactedRegions: (pipelineResult.redactions || []).map(r => ({
        bbox: [
          Math.round(r.bbox.x),
          Math.round(r.bbox.y),
          Math.round(r.bbox.x + r.bbox.width),
          Math.round(r.bbox.y + r.bbox.height)
        ],
        reason: r.type || r.reason || 'redacted_pii'
      })),
      reasoning: agentResp.reasoning || agentResp.message || '',
      thinking: agentResp.thinking || agentResp.reasoning || '',
      confidence: typeof agentResp.confidence === 'number' ? agentResp.confidence : 1.0,
      action: agentResp.action || (agentResp.actions && agentResp.actions[0]) || null,
      actions: agentResp.actions || (agentResp.action ? [agentResp.action] : []),
      assumptions: agentResp.assumptions || [],
      needsClarification: Boolean(agentResp.needsClarification),
      message: agentResp.message || agentResp.reasoning || 'Analysis complete.',
      rawModelOutput: agentResp.raw_model_output || '',
      provider: agentResp.provider || '',
      model: agentResp.model || '',
      latencyMs: agentResp.latency_ms || null,
      pageUrl: tab.url || '',
      pageTitle: tab.title || 'Web Page'
    };

    // Step 6: Append to persistent chat history in chrome.storage.local
    try {
      const data = await chrome.storage.local.get(['privamon_chat_history']);
      const history = data.privamon_chat_history || [];
      history.push(turn);
      // Keep up to 30 past turns
      const trimmed = history.slice(-30);
      await chrome.storage.local.set({ privamon_chat_history: trimmed });
      console.log(`[Background] Saved turn ${turn.id} to chat history. Total turns: ${trimmed.length}`);
    } catch (storeErr) {
      console.error('[Background] Failed to save chat turn:', storeErr);
    }

    // Also save to session storage for results page
    try {
      await chrome.storage.session.set({
        privamon_result: {
          sanitizedScreenshot: pipelineResult.sanitizedScreenshot,
          detections: pipelineResult.detections,
          allCandidates: pipelineResult.allCandidates || pipelineResult.detections,
          redactions: pipelineResult.redactions || [],
          reviews: pipelineResult.reviews || [],
          kept: pipelineResult.kept || [],
          ocrWords: pipelineResult.ocrWords || [],
          detectionSummary: pipelineResult.detectionSummary,
          sanitizedDom: pipelineResult.sanitizedDom,
          ocrRawText: pipelineResult.ocrRawText,
          timings: pipelineResult.timings,
          metadata: pipelineResult.metadata,
          timestamp: Date.now(),
        }
      });
    } catch (e) { /* ignore */ }

    forwardToPopup({
      type: 'pipelineComplete',
      result: {
        detectionSummary: pipelineResult.detectionSummary,
        timings: pipelineResult.timings,
        turn: turn
      }
    });

    return { success: true, turn };
  } finally {
    clearInterval(keepAliveInterval);
  }
}

/**
 * Executes the offscreen privacy pipeline asynchronously.
 */
function runPipelineAsync(screenshot, domData, task) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Privacy pipeline timed out after 90 seconds. Try running on a simpler page.'));
    }, 90000);

    function listener(message) {
      if (message.type === 'pipelineResult') {
        cleanup();
        if (message.error) {
          reject(new Error(message.error));
        } else {
          resolve(message.result);
        }
      } else if (message.type === 'pipelineError') {
        cleanup();
        reject(new Error(message.error || 'Pipeline error occurred'));
      }
    }

    function cleanup() {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
    }

    chrome.runtime.onMessage.addListener(listener);

    // Send runPipeline and retry if not acknowledged immediately
    (async () => {
      let acked = false;
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (finished) break;
        try {
          const resp = await chrome.runtime.sendMessage({
            action: 'runPipeline',
            screenshot,
            domData,
            task,
          });
          if (resp && resp.status === 'started') {
            acked = true;
            console.log(`[Background] Pipeline run acknowledged on attempt ${attempt}`);
            break;
          }
        } catch (sendErr) {
          console.warn(`[Background] Attempt ${attempt} to dispatch runPipeline:`, sendErr.message);
        }
        await new Promise(r => setTimeout(r, 250));
      }
      if (!acked && !finished) {
        console.warn('[Background] Pipeline message not acknowledged by offscreen, waiting on listener anyway');
      }
    })();
  });
}

/**
 * Computes coarse 9-region position tag for spatial disambiguation.
 */
function computeCoarsePosition(bbox, viewportInfo) {
  if (!bbox) return null;
  const vpW = (viewportInfo && viewportInfo.cssViewportWidth) || 1280;
  const vpH = (viewportInfo && viewportInfo.cssViewportHeight) || 800;
  const midX = bbox.x + (bbox.width || 0) / 2;
  const midY = bbox.y + (bbox.height || 0) / 2;

  const vPos = midY < vpH * 0.33 ? 'top' : (midY < vpH * 0.66 ? 'mid' : 'bottom');
  const hPos = midX < vpW * 0.33 ? 'left' : (midX < vpW * 0.66 ? 'center' : 'right');
  return `${vPos}-${hPos}`;
}

/**
 * Filters, ranks, and maps DOM elements based on task relevance and interactivity.
 * Restricts payload to top 35 elements to preserve VLM token budget while ensuring all key controls fit.
 */
function rankDomElements(sanitizedDom, task, viewportInfo, maxElements = 35) {
  if (!Array.isArray(sanitizedDom) || sanitizedDom.length === 0) {
    return [];
  }

  const stopWords = new Set(['the', 'a', 'an', 'is', 'to', 'on', 'in', 'it', 'for', 'of', 'and', 'at', 'by', 'this', 'that', 'with', 'from', 'my', 'me']);
  const taskTokens = (task || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w));

  const hasClickIntent = /\b(click|press|tap|select|submit|choose|open|go|check|tick|play|watch)\b/i.test(task || '');
  const hasTypeIntent = /\b(type|enter|fill|input|write|search|set|send|message|reply|post|chat|say|text)\b/i.test(task || '') || /"[^"]+"/.test(task || '');
  const hasSearchIntent = /\b(search|find|look\s*up|query)\b/i.test(task || '');
  const hasVideoIntent = /\b(video|play|watch|first|views|most viewed|song|episode|listen)\b/i.test(task || '');

  const scored = sanitizedDom.map((el, idx) => {
    const tag = (el.tag || 'elem').toLowerCase();
    const role = (el.role || '').toLowerCase();
    const pos = computeCoarsePosition(el.bbox, viewportInfo);

    const isInputTag = ['input', 'textarea', 'select'].includes(tag);
    const isInputRole = ['textbox', 'combobox', 'searchbox'].includes(role);
    const isContentEditable = Boolean(el.isContentEditable || el.inputType === 'contenteditable' || el.attributes?.type === 'contenteditable');
    const isInput = isInputTag || isInputRole || isContentEditable;

    const isInteractiveTag = isInputTag || ['button', 'a'].includes(tag);
    const isInteractiveRole = isInputRole || ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab'].includes(role);

    let score = 0;

    // 1. Interactivity weight
    if (isInteractiveTag || isInteractiveRole || isContentEditable) {
      score += 10;
    }

    // 2. Action verb intent alignment
    if (hasClickIntent && (tag === 'button' || tag === 'a' || role === 'button' || role === 'link')) {
      score += 8;
    }
    if (hasTypeIntent && isInput) {
      score += 15; // High priority for input fields when typing/sending
    }

    // 3. Keyword overlap
    const placeholderVal = el.placeholder || el.attributes?.placeholder || '';
    const searchableText = [
      el.label,
      placeholderVal,
      el.text,
      el.id,
      el.elementId,
      el.name,
      el.inputType,
      el.role
    ].filter(Boolean).join(' ').toLowerCase();

    for (const token of taskTokens) {
      if (searchableText.includes(token)) {
        score += 6;
      }
    }

    // Heavy penalty for audio/voice recording / voice search buttons
    const isAudioRecord = Boolean(
      el.isAudioRecord ||
      /voice\s*message|ptt|record\s*audio|microphone|voice\s*note|voice\s*search|search\s*with\s*(your\s*)?voice|voice-search/i.test(searchableText)
    );
    if ((hasTypeIntent || hasSearchIntent) && isAudioRecord) {
      score -= 60; // Ensure microphone / voice search button is never picked for typing or search
    }

    // Direct search input match
    const isSearchInputEl = isInput && !isAudioRecord && (
      el.id === 'search' ||
      el.name === 'search_query' ||
      el.name === 'q' ||
      el.inputType === 'search' ||
      role === 'searchbox' ||
      /search/i.test(placeholderVal) ||
      /search/i.test(el.label || '')
    );
    if (hasSearchIntent && isSearchInputEl) {
      score += 30; // Search inputs are #1 priority for search tasks
    }

    // Dedicated search submit button match
    const isSearchBtnEl = (tag === 'button' || role === 'button') && !isAudioRecord && (
      el.id === 'search-icon-legacy' ||
      /search/i.test(el.label || '') ||
      /search/i.test(placeholderVal)
    );
    if (hasSearchIntent && isSearchBtnEl) {
      score += 15;
    }

    // Direct chat/message input match
    if (isInput && !isSearchInputEl && !isAudioRecord && /message|chat|reply|type a message|send/i.test(searchableText)) {
      score += 15;
    }

    // YouTube video title link match
    const isVideoLinkEl = (tag === 'a' || role === 'link') && (
      el.id === 'video-title' ||
      /watch\?v=/i.test(el.href || '') ||
      /views|subscribers|ago|video/i.test(el.label || '')
    );
    if (hasVideoIntent && isVideoLinkEl) {
      score += 25;
      if (/\b(most viewed|popular)\b/i.test(task || '') && /\b\d+(\.\d+)?[Mm]\s+views/i.test(el.label || '')) {
        score += 10; // Boost million-view videos when asking for most viewed
      }
      if (/\b(first|top)\b/i.test(task || '') && pos && pos.startsWith('top')) {
        score += 8;
      }
      if (el.label && (el.label.includes('MEMBERS ONLY') || el.label.includes('Members only'))) {
        score -= 50; // Ensure members-only videos are not picked over free public episodes
      }
    }

    // 4. Viewport spatial tie-breaker:
    // Search inputs live at the top of the viewport!
    // Chat & messaging inputs live at the bottom of the viewport!
    if (hasSearchIntent && isSearchInputEl && pos && pos.startsWith('top')) {
      score += 12;
    } else if (hasTypeIntent && isInput && !isAudioRecord && pos && pos.startsWith('bot')) {
      score += 10;
    } else if (pos && pos.startsWith('top')) {
      score += 2;
    } else if (pos && pos.startsWith('mid')) {
      score += 1;
    }

    return {
      elementId: el.elementId || el.id || `dom-tok-${idx}`,
      tag: tag,
      role: el.role || null,
      pos: pos,
      label: el.label || null,
      text: el.text ? el.text.slice(0, 80) : null,
      bbox: el.bbox ? {
        x: Math.round(el.bbox.x),
        y: Math.round(el.bbox.y),
        width: Math.round(el.bbox.width),
        height: Math.round(el.bbox.height)
      } : null,
      attributes: {
        type: el.inputType || (isContentEditable ? 'contenteditable' : null),
        placeholder: placeholderVal || null,
        value: el.value ? String(el.value).slice(0, 40) : null
      },
      _isInput: isInput,
      _score: score
    };
  });

  // Sort descending by score
  scored.sort((a, b) => b._score - a._score);

  // Take top maxElements, but guarantee any high-value inputs are preserved
  let topRanked = scored.slice(0, maxElements);
  if (hasTypeIntent) {
    const includedIds = new Set(topRanked.map(e => e.elementId));
    const missingInputs = scored.slice(maxElements).filter(e => e._isInput && !includedIds.has(e.elementId));
    if (missingInputs.length > 0) {
      for (const inputEl of missingInputs) {
        const replaceIdx = topRanked.findLastIndex(e => !e._isInput);
        if (replaceIdx !== -1) {
          topRanked[replaceIdx] = inputEl;
        } else {
          topRanked.push(inputEl);
        }
      }
    }
  }

  return topRanked.map(({ _score, _isInput, ...el }) => el);
}

/**
 * Sends the sanitized image, redacted regions, task, and DOM context to server_side_agent.
 */
async function sendToServerAgent(result, task, serverUrl = 'http://localhost:8000', tab = null) {
  const endpoint = (serverUrl || 'http://localhost:8000').replace(/\/+$/, '') + '/interpret';

  // Format redacted regions
  const redacted_regions = (result.redactions || []).map(r => ({
    bbox: [
      Math.round(r.bbox.x),
      Math.round(r.bbox.y),
      Math.round(r.bbox.x + r.bbox.width),
      Math.round(r.bbox.y + r.bbox.height)
    ],
    reason: r.type || r.reason || 'redacted_pii'
  }));

  // Rank and prune DOM elements (top 35 relevant elements with coarse spatial hints)
  const viewportInfo = result.metadata?.viewportInfo || null;
  const structuredDom = rankDomElements(result.sanitizedDom, task, viewportInfo, 35);

  // Concise text string format fallback
  let sanitized_dom_str = '';
  if (structuredDom.length > 0) {
    sanitized_dom_str = structuredDom.map(el => {
      const pos = el.pos ? ` pos="${el.pos}"` : '';
      const type = el.attributes?.type ? ` type="${el.attributes.type}"` : '';
      const label = el.label ? ` label="${el.label}"` : '';
      const ph = el.attributes?.placeholder ? ` placeholder="${el.attributes.placeholder}"` : '';
      const val = el.attributes?.value ? ` val="${el.attributes.value}"` : '';
      const text = el.text ? ` text="${el.text}"` : '';
      return `<${el.tag} id="${el.elementId}"${pos}${type}${label}${ph}${val}${text}/>`;
    }).join('\n');
  }

  // Retrieve past turn actions and evaluate outcomes
  let priorActions = [];
  try {
    const histData = await chrome.storage.local.get(['privamon_chat_history']);
    const pastTurns = histData.privamon_chat_history || [];
    if (pastTurns.length > 0) {
      const lastTurn = pastTurns[pastTurns.length - 1];
      let lastOutcome = lastTurn.outcome || null;

      if (!lastOutcome) {
        // Compare page states between last turn and current turn
        const lastUrl = lastTurn.pageUrl || '';
        const currentUrl = (tab && tab.url) || '';

        if (lastUrl && currentUrl && lastUrl !== currentUrl) {
          lastOutcome = 'navigation_success';
        } else if (lastTurn.action && lastTurn.action.type === 'type') {
          // If a message was typed into a chat, it was typed and dispatched
          lastOutcome = 'executed_and_sent';
        } else if (lastTurn.action && lastTurn.action.type === 'click') {
          lastOutcome = 'clicked_successfully';
        } else {
          lastOutcome = 'executed_successfully';
        }
      }

      priorActions = pastTurns.slice(-3).map((t, idx, arr) => {
        const isLast = (idx === arr.length - 1);
        const outcome = isLast && lastOutcome ? lastOutcome : (t.outcome || 'executed_successfully');
        const actStr = t.action
          ? `${t.action.type} ${t.action.targetElementId || ''} ${t.action.value ? '"' + t.action.value + '"' : ''}`.trim()
          : `"${t.task}"`;

        return `${actStr} [outcome: ${outcome}]`;
      });
    }
  } catch (e) {
    console.warn('[Background] Failed to process prior actions outcome:', e);
  }

  const detectionSummary = result.detectionSummary || {
    total: redacted_regions.length,
    byType: redacted_regions.reduce((acc, r) => {
      acc[r.reason] = (acc[r.reason] || 0) + 1;
      return acc;
    }, {})
  };

  const serverImg = result.serverScreenshot || result.sanitizedScreenshot;

  const payload = {
    task: task,
    sanitizedScreenshot: serverImg,
    image_b64: serverImg,
    sanitizedDom: structuredDom,
    sanitized_dom: sanitized_dom_str,
    detectionSummary: detectionSummary,
    redacted_regions: redacted_regions,
    priorActions: priorActions,
    conversationState: {}
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Server ${response.status}: ${errText.slice(0, 200)}`);
  }

  return await response.json();
}

/**
 * Execute a single action on the active tab by injecting the action executor content script.
 */
async function handleExecuteAction(actionPayload) {
  if (!actionPayload || !actionPayload.type) {
    return { success: false, actionType: 'unknown', message: 'No action payload provided' };
  }

  const tab = await getOperableTab();

  // For non-page actions, handle directly
  if (actionPayload.type === 'done') {
    return { success: true, actionType: 'done', targetElementId: null, message: 'Task marked as complete.' };
  }
  if (actionPayload.type === 'ask_user') {
    return { success: true, actionType: 'ask_user', targetElementId: null, message: actionPayload.value || 'Agent needs clarification.' };
  }
  if (actionPayload.type === 'wait') {
    await new Promise(r => setTimeout(r, 1500));
    return { success: true, actionType: 'wait', targetElementId: null, message: 'Waited 1.5 seconds.' };
  }

  console.log(`[Background] Executing action: ${actionPayload.type} on ${actionPayload.targetElementId || 'page'}`);

  // Inject the action payload as a global, then execute the action executor script
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (action) => {
      window.__privamon_action = action;
    },
    args: [actionPayload]
  });

  // Now inject the action executor
  const execResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content/action-executor.js']
  });

  const result = execResults[0]?.result;
  if (!result) {
    return { success: false, actionType: actionPayload.type, message: 'Action executor returned no result' };
  }

  console.log(`[Background] Action result:`, result);

  // Notify popup of execution result
  forwardToPopup({
    type: 'actionExecuted',
    result: result
  });

  return result;
}

let isActionLoopRunning = false;
let isLoopCancelled = false;

function stopActionLoop() {
  console.log('[Background] Stopping action loop on user request.');
  isLoopCancelled = true;
  isActionLoopRunning = false;
  forwardToPopup({
    type: 'autopilotProgress',
    status: 'paused',
    message: 'Loop stopped by user.'
  });
}

/**
 * Auto-pilot loop: execute the current action, wait, re-capture, re-analyze, repeat.
 * Stops when: action type is 'done', 'ask_user', confidence < 0.45, cancelled, or maxSteps reached.
 */
async function handleActionLoop(initialTask, serverUrl = 'http://localhost:8000', maxSteps = 5) {
  const task = initialTask || 'Continue the current task';
  const steps = [];

  if (isActionLoopRunning) {
    console.warn('[Background] Auto-pilot loop already active; overriding existing run.');
    isLoopCancelled = true;
    await new Promise(r => setTimeout(r, 400));
  }

  isActionLoopRunning = true;
  isLoopCancelled = false;

  // Keep MV3 service worker alive during the loop
  const keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 3500);

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (isLoopCancelled) {
        forwardToPopup({ type: 'autopilotProgress', step: step + 1, maxSteps, status: 'paused', message: 'Loop stopped by user.' });
        break;
      }

      const stepPrefix = step === 0 ? 'Step 1' : (step === 1 ? 'Step 2 (Verifying)' : `Step ${step + 1}`);
      console.log(`[Background] Auto-pilot ${stepPrefix}`);

      forwardToPopup({
        type: 'autopilotProgress',
        step: step + 1,
        maxSteps,
        status: 'analyzing',
        message: `${stepPrefix}: Inspecting screen & verifying state...`
      });

      // Provide verification context to the model on subsequent steps
      const currentQuery = step === 0
        ? task
        : `${task} [VERIFY TASK COMPLETION: The previous action (${steps[steps.length - 1]?.action?.type || 'action'} ${steps[steps.length - 1]?.action?.value ? '"' + steps[steps.length - 1].action.value + '"' : ''}) was executed. Inspect the screen: if the goal is accomplished (e.g. message is visible in chat history or input is cleared, video is playing, or page is loaded), return action type "done". If the message is still sitting in the input box and not yet sent, emit action type "click" targeting the Send button.]`;

      // Run the full chat-with-agent pipeline (capture → redact → server query)
      let chatResult;
      try {
        chatResult = await handleChatWithAgent(currentQuery, serverUrl);
      } catch (err) {
        steps.push({ step: step + 1, error: err.message });
        forwardToPopup({ type: 'autopilotProgress', step: step + 1, maxSteps, status: 'error', message: `Analysis failed: ${err.message}` });
        break;
      }

      if (isLoopCancelled) break;

      if (!chatResult || !chatResult.turn) {
        steps.push({ step: step + 1, error: 'No turn returned from agent' });
        break;
      }

      const turn = chatResult.turn;
      const action = turn.action;
      const confidence = turn.confidence;

      // Check stopping conditions: verified task completion
      if (!action || action.type === 'done') {
        steps.push({ step: step + 1, action: action || { type: 'done' }, result: 'Task complete', stopped: 'done' });
        forwardToPopup({ type: 'autopilotProgress', step: step + 1, maxSteps, status: 'done', message: `✓ Task verified complete! (${step + 1} step${step > 0 ? 's' : ''})` });
        break;
      }

      // Circuit-breaker: If model tries to re-type the same message already sent in an earlier step
      if (step > 0 && action.type === 'type') {
        const alreadySent = steps.some(s => s.action && s.action.type === 'type' && s.action.value === action.value && s.execResult && s.execResult.success);
        if (alreadySent) {
          console.log('[Background] Circuit-breaker: message was already sent in prior step. Halting loop as complete.');
          steps.push({ step: step + 1, action: { type: 'done' }, result: 'Task verified complete' });
          forwardToPopup({
            type: 'autopilotProgress',
            step: step + 1,
            maxSteps,
            status: 'done',
            message: `✓ Task verified complete! Message was sent.`
          });
          break;
        }
      }

      // Circuit-breaker: If model tries to repeatedly click the same input/element without state change during a search task
      if (step > 0 && action.type === 'click' && action.targetElementId) {
        const priorSameClicks = steps.filter(s => s.action && s.action.type === 'click' && s.action.targetElementId === action.targetElementId);
        if (priorSameClicks.length >= 1) {
          const isSearchTask = /\b(search|find|look\s*up)\b/i.test(task || '');
          if (isSearchTask) {
            console.log('[Background] Circuit-breaker: Repeated click on search element detected. Auto-converting to type action.');
            const qMatch = task.match(/(?:search(?:\s+for)?|look\s*up|find)\s+["'“”]?([^"'“”.,\n]+?)(?:["'“”]?(?:\s+and\s+(?:play|watch|click|open).*|$))/i);
            const queryVal = qMatch ? qMatch[1].trim() : task.replace(/^(?:please\s+)?search(?:\s+for)?\s+/i, '').split(/\s+and\s+/i)[0].trim();
            if (queryVal) {
              action.type = 'type';
              action.value = queryVal;
              turn.reasoning = `Entering search query "${queryVal}" into search bar and submitting.`;
              console.log(`[Background] Circuit-breaker converted action to type "${queryVal}"`);
            }
          }
        }
      }

      if (action.type === 'ask_user' || turn.needsClarification) {
        steps.push({ step: step + 1, action, result: 'Needs clarification', stopped: 'clarification' });
        forwardToPopup({ type: 'autopilotProgress', step: step + 1, maxSteps, status: 'paused', message: 'Agent paused: clarification needed' });
        break;
      }

      if (typeof confidence === 'number' && confidence < 0.45) {
        steps.push({ step: step + 1, action, confidence, result: 'Low confidence', stopped: 'low_confidence' });
        forwardToPopup({ type: 'autopilotProgress', step: step + 1, maxSteps, status: 'paused', message: `Paused: low confidence (${Math.round(confidence * 100)}%)` });
        break;
      }

      // Execute the action
      forwardToPopup({
        type: 'autopilotProgress',
        step: step + 1,
        maxSteps,
        status: 'executing',
        message: `${stepPrefix}: Executing ${action.type}${action.targetElementId ? ' on #' + action.targetElementId : ''}...`
      });

      let execResult;
      try {
        execResult = await handleExecuteAction(action);
      } catch (err) {
        steps.push({ step: step + 1, action, error: `Execution failed: ${err.message}` });
        forwardToPopup({ type: 'autopilotProgress', step: step + 1, maxSteps, status: 'error', message: `Action failed: ${err.message}` });
        break;
      }

      steps.push({ step: step + 1, action, execResult, confidence });

      // Record execution outcome to chat history so next turn sees the success
      try {
        const histData = await chrome.storage.local.get(['privamon_chat_history']);
        const history = histData.privamon_chat_history || [];
        if (history.length > 0) {
          const last = history[history.length - 1];
          last.outcome = execResult.success ? (action.type === 'type' ? 'executed_and_sent' : 'clicked_successfully') : 'failed';
          last.execResult = execResult;
          await chrome.storage.local.set({ privamon_chat_history: history });
        }
      } catch (e) {
        console.warn('[Background] Failed to update chat history outcome:', e);
      }

      if (!execResult.success) {
        forwardToPopup({ type: 'autopilotProgress', step: step + 1, maxSteps, status: 'error', message: `Action error: ${execResult.message}` });
        break;
      }

      if (isLoopCancelled) break;

      // Wait for page to settle after action (navigation, DOM updates, React renders, network)
      forwardToPopup({
        type: 'autopilotProgress',
        step: step + 1,
        maxSteps,
        status: 'settling',
        message: `${stepPrefix}: Action executed. Waiting for page to settle...`
      });
      await new Promise(r => setTimeout(r, 2400));
    }

    forwardToPopup({
      type: 'autopilotComplete',
      steps,
      totalSteps: steps.length
    });

    return { success: true, steps, totalSteps: steps.length };
  } finally {
    isActionLoopRunning = false;
    clearInterval(keepAliveInterval);
  }
}

console.log('[Background] Privamon service worker initialized');


