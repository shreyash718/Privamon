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
    handleActionLoop(message.task, message.serverUrl, message.maxSteps || 10)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
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
    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab found');

    // Step 1: Capture screenshot
    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'capture',
      status: 'active',
      statusText: 'Capturing screen...',
    });

    const screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    // Step 2: Extract DOM
    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'dom',
      status: 'active',
      statusText: 'Extracting DOM context...',
    });

    const domResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/dom-range-mapper.js', 'content/dom-extractor.js'],
    });
    const domData = domResults[0]?.result;
    if (!domData) throw new Error('DOM extraction returned no data');

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
 * Restricts payload to top 20 elements to preserve VLM token budget.
 */
function rankDomElements(sanitizedDom, task, viewportInfo, maxElements = 20) {
  if (!Array.isArray(sanitizedDom) || sanitizedDom.length === 0) {
    return [];
  }

  const stopWords = new Set(['the', 'a', 'an', 'is', 'to', 'on', 'in', 'it', 'for', 'of', 'and', 'at', 'by', 'this', 'that', 'with', 'from', 'my', 'me']);
  const taskTokens = (task || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w));

  const hasClickIntent = /\b(click|press|tap|select|submit|choose|open|go|check|tick)\b/i.test(task || '');
  const hasTypeIntent = /\b(type|enter|fill|input|write|search|set)\b/i.test(task || '');

  const scored = sanitizedDom.map((el, idx) => {
    const tag = (el.tag || 'elem').toLowerCase();
    const role = (el.role || '').toLowerCase();
    const pos = computeCoarsePosition(el.bbox, viewportInfo);

    let score = 0;

    // 1. Interactivity weight
    const isInteractiveTag = ['button', 'input', 'a', 'select', 'textarea'].includes(tag);
    const isInteractiveRole = ['button', 'link', 'combobox', 'textbox', 'checkbox', 'radio', 'menuitem'].includes(role);
    if (isInteractiveTag || isInteractiveRole) {
      score += 10;
    }

    // 2. Action verb intent alignment
    if (hasClickIntent && (tag === 'button' || tag === 'a' || role === 'button' || role === 'link')) {
      score += 8;
    }
    if (hasTypeIntent && (tag === 'input' || tag === 'textarea' || role === 'textbox')) {
      score += 8;
    }

    // 3. Keyword overlap
    const searchableText = [
      el.label,
      el.placeholder,
      el.text,
      el.id,
      el.name,
      el.inputType,
      el.role
    ].filter(Boolean).join(' ').toLowerCase();

    for (const token of taskTokens) {
      if (searchableText.includes(token)) {
        score += 6;
      }
    }

    // 4. Viewport spatial tie-breaker (prefer upper/middle over far bottom)
    if (pos && pos.startsWith('top')) score += 2;
    else if (pos && pos.startsWith('mid')) score += 1;

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
        type: el.inputType || null,
        placeholder: el.placeholder || null,
        value: el.value ? String(el.value).slice(0, 40) : null
      },
      _score: score
    };
  });

  // Sort descending by score, take top maxElements
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, maxElements).map(({ _score, ...el }) => el);
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

  // Rank and prune DOM elements (top 20 relevant elements with coarse spatial hints)
  const viewportInfo = result.metadata?.viewportInfo || null;
  const structuredDom = rankDomElements(result.sanitizedDom, task, viewportInfo, 20);

  // Concise text string format fallback
  let sanitized_dom_str = '';
  if (structuredDom.length > 0) {
    sanitized_dom_str = structuredDom.map(el => {
      const pos = el.pos ? ` pos="${el.pos}"` : '';
      const type = el.attributes?.type ? ` type="${el.attributes.type}"` : '';
      const label = el.label ? ` label="${el.label}"` : '';
      const val = el.attributes?.value ? ` val="${el.attributes.value}"` : '';
      const text = el.text ? ` text="${el.text}"` : '';
      return `<${el.tag} id="${el.elementId}"${pos}${type}${label}${val}${text}/>`;
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
        } else if (lastTurn.action && lastTurn.action.targetElementId) {
          const targetId = lastTurn.action.targetElementId;
          const stillExists = Array.isArray(result.sanitizedDom) && result.sanitizedDom.some(
            el => (el.elementId === targetId || el.id === targetId)
          );
          if (stillExists) {
            lastOutcome = 'no_change_detected';
          } else {
            lastOutcome = 'state_changed';
          }
        } else {
          lastOutcome = 'completed';
        }
      }

      priorActions = pastTurns.slice(-3).map((t, idx, arr) => {
        const isLast = (idx === arr.length - 1);
        const outcome = isLast && lastOutcome ? lastOutcome : (t.outcome || 'completed');
        const actStr = t.action
          ? `${t.action.type} ${t.action.targetElementId || t.action.value || ''}`.trim()
          : `"${t.task}"`;

        if (outcome === 'no_change_detected') {
          return `${actStr} [outcome: no_change_detected — DO NOT REPEAT UNCHANGED]`;
        } else if (outcome) {
          return `${actStr} [outcome: ${outcome}]`;
        }
        return actStr;
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

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');

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

/**
 * Auto-pilot loop: execute the current action, wait, re-capture, re-analyze, repeat.
 * Stops when: action type is 'done', 'ask_user', confidence < 0.5, or maxSteps reached.
 */
async function handleActionLoop(initialTask, serverUrl = 'http://localhost:8000', maxSteps = 10) {
  const task = initialTask || 'Continue the current task';
  const steps = [];

  // Keep MV3 service worker alive during the loop
  const keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 3500);

  try {
    for (let step = 0; step < maxSteps; step++) {
      console.log(`[Background] Auto-pilot step ${step + 1}/${maxSteps}`);

      forwardToPopup({
        type: 'autopilotProgress',
        step: step + 1,
        maxSteps,
        status: 'analyzing',
        message: `Step ${step + 1}: Capturing & analyzing screen...`
      });

      // Run the full chat-with-agent pipeline (capture → redact → server query)
      let chatResult;
      try {
        chatResult = await handleChatWithAgent(task, serverUrl);
      } catch (err) {
        steps.push({ step: step + 1, error: err.message });
        break;
      }

      if (!chatResult || !chatResult.turn) {
        steps.push({ step: step + 1, error: 'No turn returned from agent' });
        break;
      }

      const turn = chatResult.turn;
      const action = turn.action;
      const confidence = turn.confidence;

      // Check stopping conditions
      if (!action || action.type === 'done') {
        steps.push({ step: step + 1, action: action || { type: 'done' }, result: 'Task complete', stopped: 'done' });
        forwardToPopup({ type: 'autopilotProgress', step: step + 1, maxSteps, status: 'done', message: 'Task complete!' });
        break;
      }

      if (action.type === 'ask_user' || turn.needsClarification) {
        steps.push({ step: step + 1, action, result: 'Needs clarification', stopped: 'clarification' });
        forwardToPopup({ type: 'autopilotProgress', step: step + 1, maxSteps, status: 'paused', message: 'Agent needs your input' });
        break;
      }

      if (typeof confidence === 'number' && confidence < 0.5) {
        steps.push({ step: step + 1, action, confidence, result: 'Low confidence', stopped: 'low_confidence' });
        forwardToPopup({ type: 'autopilotProgress', step: step + 1, maxSteps, status: 'paused', message: `Paused: confidence too low (${Math.round(confidence * 100)}%)` });
        break;
      }

      // Execute the action
      forwardToPopup({
        type: 'autopilotProgress',
        step: step + 1,
        maxSteps,
        status: 'executing',
        message: `Step ${step + 1}: Executing ${action.type} on ${action.targetElementId || 'page'}...`
      });

      let execResult;
      try {
        execResult = await handleExecuteAction(action);
      } catch (err) {
        steps.push({ step: step + 1, action, error: `Execution failed: ${err.message}` });
        break;
      }

      steps.push({ step: step + 1, action, execResult, confidence });

      if (!execResult.success) {
        forwardToPopup({ type: 'autopilotProgress', step: step + 1, maxSteps, status: 'error', message: `Action failed: ${execResult.message}` });
        break;
      }

      // Wait for page to settle after action (navigation, AJAX, etc.)
      await new Promise(r => setTimeout(r, 2000));
    }

    forwardToPopup({
      type: 'autopilotComplete',
      steps,
      totalSteps: steps.length
    });

    return { success: true, steps, totalSteps: steps.length };
  } finally {
    clearInterval(keepAliveInterval);
  }
}

console.log('[Background] Privamon service worker initialized');


