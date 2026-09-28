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

// Clean up any stale running state left over from previous service worker sessions/reloads
chrome.storage.local.set({
  privamon_redaction_state: {
    isRunning: false,
    stageId: 'complete',
    status: 'idle',
    statusText: 'Ready',
    timestamp: Date.now()
  },
  privamon_loop_state: {
    isRunning: false,
    step: 0,
    maxSteps: 5,
    status: 'idle',
    message: ''
  }
}).catch(() => {});

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

let currentLoopState = {
  isRunning: false,
  step: 0,
  maxSteps: 5,
  status: 'idle',
  message: '',
  task: ''
};

// Tracks the most recently used server URL for continueAfterGuidance
let currentServerUrl = 'https://privamon.onrender.com';

function updateLoopState(stateUpdate) {
  currentLoopState = { ...currentLoopState, ...stateUpdate };
  chrome.storage.local.set({ privamon_loop_state: currentLoopState }).catch(() => {});
}

/**
 * Forward a message to the popup (and any open results pages).
 * Non-critical — if popup is closed, the message is stored and silently delivered when popup opens.
 */
function forwardToPopup(message) {
  if (message.type === 'autopilotProgress') {
    const isRunning = !(message.status === 'done' || message.status === 'paused' || message.status === 'error');
    updateLoopState({
      isRunning,
      step: message.step || 0,
      maxSteps: message.maxSteps || 5,
      status: message.status || 'idle',
      message: message.message || ''
    });
  }
  if (message.type === 'pipelineProgress') {
    chrome.storage.local.set({
      privamon_redaction_state: {
        isRunning: true,
        stageId: message.stageId,
        status: message.status,
        statusText: message.statusText,
        timestamp: Date.now()
      }
    }).catch(() => {});
  }
  if (message.type === 'pipelineComplete' || message.type === 'pipelineError') {
    chrome.storage.local.set({
      privamon_redaction_state: {
        isRunning: false,
        stageId: message.stageId || 'complete',
        status: message.type === 'pipelineComplete' ? 'done' : 'error',
        statusText: message.type === 'pipelineComplete' ? 'Redaction complete' : (message.error || 'Error'),
        timestamp: Date.now()
      }
    }).catch(() => {});
  }
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup might be closed — stored in chrome.storage.local for popup reopen
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

  // Pure on-device testing: Run redaction pipeline only without server transmission
  if (message.action === 'testRedactionOnly') {
    handleTestRedactionOnly()
      .then(response => {
        try {
          sendResponse(response);
        } catch (e) {
          console.warn('[Background] Message channel already closed when sending test response:', e.message);
        }
      })
      .catch(err => {
        try {
          sendResponse({ success: false, error: err.message });
        } catch (e) {}
      });
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
    const url = (message.serverUrl || 'https://privamon.onrender.com').replace(/\/+$/, '') + '/health';
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

  // Get active loop state (for popup UI sync on reopen)
  if (message.action === 'getLoopState') {
    chrome.storage.local.get(['privamon_loop_state'], (res) => {
      sendResponse({
        loopState: res.privamon_loop_state || currentLoopState,
        isActionLoopRunning
      });
    });
    return true;
  }

  // Submit user clarification / confirmation back to active auto-pilot loop (locally)
  if (message.action === 'submitUserData') {
    const { requestId, data, cancelled } = message;
    const pending = pendingUserInputs.get(requestId);
    if (pending) {
      pending.resolve({ data, cancelled });
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, message: 'No pending input request' });
    }
    return true;
  }

  // Highlight required guidance fields directly on active web page
  if (message.action === 'highlightFields') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
          sendResponse({ success: false, message: 'No active tab found' });
          return;
        }
        await highlightRequiredFieldsOnTab(tab.id, message.fields || []);
        sendResponse({ success: true });
      } catch (err) {
        console.error('[Background] highlightFields error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Directly continue task after user filled guidance fields on page
  if (message.action === 'continueAfterGuidance') {
    sendResponse({ success: true, message: 'Continuing task after guidance' });
    (async () => {
      try {
        const tab = await getOperableTab();
        if (!tab || !tab.id) {
          console.warn('[Background] continueAfterGuidance: No operable tab found');
          forwardToPopup({
            type: 'autopilotProgress',
            status: 'error',
            message: 'Could not find active web tab. Please make sure the IRCTC tab is open.'
          });
          return;
        }

        // Bring window and tab into focus
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        await chrome.tabs.update(tab.id, { active: true }).catch(() => {});

        // First check if current tab is a login page or IRCTC travel page
        const isLoginTask = /\b(login|log\s*in|sign\s*in|signin|auth|portal|credentials)\b/i.test(message.task || '');
        const pageTypeRes = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const passInps = Array.from(document.querySelectorAll('input[type="password"], input[name*="pass" i], input[id*="pass" i]'));
            const userInps = Array.from(document.querySelectorAll('input[name*="user" i], input[id*="user" i], input[placeholder*="user" i], input[autocomplete*="user" i], input[type="email"], input[name*="roll" i], input[id*="roll" i], input[type="text"]'));
            const hasSubmitBtn = document.querySelector('#btnSubmit, #btnLogin, button[type="submit"], input[type="submit"]') !== null;
            const isLogin = passInps.length > 0 || hasSubmitBtn;

            const userFilled = userInps.some(i => (i.value || '').trim().length > 0);
            const passFilled = passInps.some(i => (i.value || '').trim().length > 0);

            const isTravel = window.location.hostname.includes('irctc.co.in') || Boolean(document.querySelector('p-autocomplete, button.search_btn, button.train_Search'));

            return {
              isLogin,
              isTravel,
              userFilled,
              passFilled
            };
          }
        });

        const pageInfo = pageTypeRes[0]?.result;
        const isLoginFlow = (pageInfo?.isLogin && !pageInfo?.isTravel) || isLoginTask;

        // ── Handle Login Page Flow ──
        if (isLoginFlow) {
          // Click Sign in / Login button directly and trigger submit
          const loginClickRes = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              // 1. Dispatch input and change on credentials fields to guarantee form validity
              const allInputs = Array.from(document.querySelectorAll('input, select, textarea'));
              for (const inp of allInputs) {
                if ((inp.value || '').trim().length > 0) {
                  inp.dispatchEvent(new Event('input', { bubbles: true }));
                  inp.dispatchEvent(new Event('change', { bubbles: true }));
                  inp.dispatchEvent(new Event('blur', { bubbles: true }));
                }
              }

              // 2. Locate sign in / submit button
              const passInp = document.querySelector('input[type="password"]');
              let loginBtn = null;
              if (passInp && passInp.form) {
                loginBtn = passInp.form.querySelector('#btnSubmit, #btnLogin, input[type="submit"], button[type="submit"], input[value*="Sign in" i], input[value*="Login" i], button');
              }
              if (!loginBtn) {
                loginBtn = document.querySelector('#btnSubmit, #btnLogin, input[type="submit"], button[type="submit"], input[value*="Sign in" i], input[value*="Login" i]');
              }
              if (!loginBtn) {
                const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, a[role="button"]'));
                loginBtn = buttons.find(b => {
                  if (b.getAttribute('data-toggle') === 'tab' || b.getAttribute('role') === 'tab') return false;
                  const text = (b.textContent || b.value || '').toLowerCase().replace(/\s+/g, ' ').trim();
                  return text === 'sign in' || text === 'login' || text === 'log in' ||
                         text.includes('sign in') || text.includes('login') || text.includes('log in');
                });
              }

              if (loginBtn) {
                loginBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                loginBtn.focus();
                const rect = loginBtn.getBoundingClientRect();
                const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
                loginBtn.dispatchEvent(new MouseEvent('mouseover', opts));
                loginBtn.dispatchEvent(new MouseEvent('mousedown', opts));
                loginBtn.dispatchEvent(new MouseEvent('mouseup', opts));
                loginBtn.dispatchEvent(new MouseEvent('click', opts));
                if (typeof loginBtn.click === 'function') {
                  loginBtn.click();
                }

                // If button is in a form, trigger requestSubmit or form submit
                if (loginBtn.form) {
                  try {
                    if (typeof loginBtn.form.requestSubmit === 'function') {
                      loginBtn.form.requestSubmit(loginBtn);
                    } else if (typeof loginBtn.form.submit === 'function') {
                      loginBtn.form.submit();
                    }
                  } catch (e) {}
                }

                return {
                  success: true,
                  text: (loginBtn.textContent || loginBtn.value || '').trim().slice(0, 50),
                  targetId: loginBtn.id || loginBtn.name || 'btnSubmit'
                };
              }
              return { success: false };
            }
          });

          const clickedLogin = loginClickRes[0]?.result?.success;
          const targetId = loginClickRes[0]?.result?.targetId || 'btnSubmit';

          // Halt any running autopilot loop so no background loop competes
          isLoopCancelled = true;
          isActionLoopRunning = false;

          // Directly record executed action in chat history
          const turn = {
            id: 'turn_' + Date.now(),
            task: 'Login with entered credentials',
            timestamp: Date.now(),
            reasoning: 'Credentials entered on page. Directly clicked Sign in button to proceed to login.',
            action: {
              type: 'click',
              targetElementId: targetId,
              value: null,
              scrollDirection: null
            },
            actions: [{
              type: 'click',
              targetElementId: targetId,
              value: null,
              scrollDirection: null
            }],
            outcome: 'clicked_successfully',
            confidence: 0.99,
            needsClarification: false
          };

          try {
            const histData = await chrome.storage.local.get(['privamon_chat_history']);
            const history = histData.privamon_chat_history || [];
            history.push(turn);
            await chrome.storage.local.set({ privamon_chat_history: history.slice(-30) });
          } catch (e) {}

          forwardToPopup({
            type: 'pipelineComplete',
            result: { turn }
          });

          forwardToPopup({
            type: 'autopilotProgress',
            status: 'done',
            message: clickedLogin ? '✓ Directly clicked Sign in to log in!' : 'Credentials registered on page. Click Sign in to proceed.'
          });

          return;
        }

        // ── Handle Travel / IRCTC Flow ──
        // First verify that From and To are actually filled before clicking search
        const verifyRes = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // IRCTC uses p-autocomplete with formcontrolname for station inputs
            const fromInputs = [
              document.querySelector('p-autocomplete[formcontrolname="journeyFrom"] input'),
              document.querySelector('p-autocomplete[formcontrolname*="from" i] input'),
              document.querySelector('p-autocomplete[formcontrolname*="origin" i] input'),
              document.querySelector('#origin input, input[aria-label*="from" i], input[placeholder*="from" i]')
            ];
            const toInputs = [
              document.querySelector('p-autocomplete[formcontrolname="journeyTo"] input'),
              document.querySelector('p-autocomplete[formcontrolname*="to" i] input'),
              document.querySelector('p-autocomplete[formcontrolname*="destination" i] input'),
              document.querySelector('#destination input, input[aria-label*="to" i], input[placeholder*="to" i]')
            ];
            // Fallback: get all p-autocomplete inputs ordered by DOM position
            const allAutos = Array.from(document.querySelectorAll('p-autocomplete input, .ui-autocomplete input'));
            const fromInp = fromInputs.find(el => el) || allAutos[0];
            const toInp = toInputs.find(el => el) || allAutos[1];
            const fromVal = (fromInp?.value || fromInp?.getAttribute('value') || '').trim();
            const toVal = (toInp?.value || toInp?.getAttribute('value') || '').trim();
            return { fromFilled: fromVal.length > 0, toFilled: toVal.length > 0, fromVal, toVal };
          }
        });

        const verify = verifyRes[0]?.result;
        if (verify && (!verify.fromFilled || !verify.toFilled)) {
          console.warn('[Background] continueAfterGuidance: Stations still empty! From:', verify.fromVal, 'To:', verify.toVal);
          forwardToPopup({
            type: 'autopilotProgress',
            status: 'clarification',
            message: `Stations still empty — please fill From and To stations directly on the IRCTC page first.`
          });
          // Re-highlight
          highlightRequiredFieldsOnTab(tab.id, []).catch(() => {});
          return;
        }

        // Click the Search Trains button on page with robust detection
        const searchRes = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Strategy 1: IRCTC-specific selectors
            let searchBtn = document.querySelector('button.search_btn, button.train_Search, button[label="Find Trains"], button[label*="Search" i]');
            // Strategy 2: Form submit buttons
            if (!searchBtn) searchBtn = document.querySelector('form button[type="submit"], form input[type="submit"]');
            // Strategy 3: Text content match
            if (!searchBtn) {
              const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn, a.search_btn'));
              searchBtn = buttons.find(b => {
                const text = (b.textContent || b.value || '').toLowerCase().replace(/\s+/g, ' ').trim();
                const cls = String(b.className || '').toLowerCase();
                return text.includes('search train') || text.includes('find train') ||
                       text.includes('search') || cls.includes('search_btn') || cls.includes('train_search');
              });
            }
            if (searchBtn) {
              searchBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              const rect = searchBtn.getBoundingClientRect();
              const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
              searchBtn.dispatchEvent(new MouseEvent('mousedown', opts));
              searchBtn.dispatchEvent(new MouseEvent('mouseup', opts));
              searchBtn.dispatchEvent(new MouseEvent('click', opts));
              searchBtn.click();
              return { success: true, text: (searchBtn.textContent || searchBtn.value || '').trim().slice(0, 50) };
            }
            return { success: false };
          }
        });

        const clicked = searchRes[0]?.result?.success;
        if (clicked) {
          console.log('[Background] continueAfterGuidance: Successfully clicked Search Trains button on page!');

          // Halt any running autopilot loop
          isLoopCancelled = true;
          isActionLoopRunning = false;

          // Directly record executed action in chat history
          const turn = {
            id: 'turn_' + Date.now(),
            task: 'Search trains with entered details',
            timestamp: Date.now(),
            reasoning: 'Journey stations entered on page. Directly clicked Search Trains button.',
            action: { type: 'click', targetElementId: 'search_btn', value: null, scrollDirection: null },
            actions: [{ type: 'click', targetElementId: 'search_btn', value: null, scrollDirection: null }],
            outcome: 'clicked_successfully',
            confidence: 0.99,
            needsClarification: false
          };
          try {
            const histData = await chrome.storage.local.get(['privamon_chat_history']);
            const history = histData.privamon_chat_history || [];
            history.push(turn);
            await chrome.storage.local.set({ privamon_chat_history: history.slice(-30) });
          } catch (e) {}

          forwardToPopup({
            type: 'pipelineComplete',
            result: { turn }
          });

          forwardToPopup({
            type: 'autopilotProgress',
            status: 'done',
            message: '✓ Directly clicked Search Trains with entered station details!'
          });
          return;
        }

        // If no direct Search Trains button, resume normal chat turn safely
        console.log('[Background] continueAfterGuidance: No Search button found, resuming normal agent flow.');
        try {
          await handleChatWithAgent(message.task || 'Proceed with entered details now', currentServerUrl);
        } catch (serverErr) {
          forwardToPopup({
            type: 'autopilotProgress',
            status: 'done',
            message: 'Proceeded with entered details.'
          });
        }
      } catch (err) {
        console.error('[Background] continueAfterGuidance error:', err);
        forwardToPopup({
          type: 'autopilotProgress',
          status: 'error',
          message: `Error continuing: ${err.message}`
        });
      }
    })();
    return true;
  }

  // Get active redaction test state (for popup UI sync on reopen)
  if (message.action === 'getRedactionState') {
    chrome.storage.local.get(['privamon_redaction_state'], (res) => {
      sendResponse({
        isRunning: isRedactionTestRunning,
        state: res.privamon_redaction_state || null
      });
    });
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

let lastOperableTabId = null;

/**
 * Gets an accessible browser tab for Privamon operations.
 * If the current active tab is restricted (e.g. chrome://extensions or results.html),
 * it returns to the last analyzed tab, or finds an open web tab (across all windows).
 */
async function getOperableTab() {
  let [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab) {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  const activeUrl = activeTab?.url || activeTab?.pendingUrl;

  if (activeTab && !isRestrictedUrl(activeUrl)) {
    lastOperableTabId = activeTab.id;
    return activeTab;
  }

  // 1. Check if our last analyzed tab is still open and operable
  if (lastOperableTabId) {
    try {
      const lastTab = await chrome.tabs.get(lastOperableTabId);
      const lastUrl = lastTab?.url || lastTab?.pendingUrl;
      if (lastTab && !isRestrictedUrl(lastUrl)) {
        console.log(`[Background] Switching back to last analyzed tab: ${lastUrl}`);
        if (lastTab.windowId) {
          await chrome.windows.update(lastTab.windowId, { focused: true }).catch(() => {});
        }
        await chrome.tabs.update(lastTab.id, { active: true });
        await new Promise(r => setTimeout(r, 600));
        return lastTab;
      }
    } catch (e) {
      lastOperableTabId = null;
    }
  }

  // 2. Search tabs in the current window first
  const isAccessible = (t) => {
    const u = t?.url || t?.pendingUrl;
    return Boolean(u && !isRestrictedUrl(u));
  };
  const currentWindowTabs = await chrome.tabs.query({ currentWindow: true });

  let candidate = currentWindowTabs.find(t => (t.url || t.pendingUrl || '').includes('web.whatsapp.com'))
               || currentWindowTabs.find(isAccessible);

  // 3. If not found in current window, search across all open browser windows
  if (!candidate) {
    const allTabs = await chrome.tabs.query({});
    candidate = allTabs.find(t => (t.url || t.pendingUrl || '').includes('web.whatsapp.com'))
             || allTabs.find(isAccessible);
  }

  if (candidate) {
    const candUrl = candidate.url || candidate.pendingUrl || 'unknown';
    console.log(`[Background] Active tab is restricted (${activeUrl || 'unknown'}). Switching to operable tab: ${candUrl}`);
    if (candidate.windowId) {
      await chrome.windows.update(candidate.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(candidate.id, { active: true });
    // Brief settle delay for Chrome to bring tab into focus
    await new Promise(r => setTimeout(r, 600));
    lastOperableTabId = candidate.id;
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
    let screenshot = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        screenshot = await chrome.tabs.captureVisibleTab(tab?.windowId || null, { format: 'png' });
        if (screenshot) break;
      } catch (capErr) {
        console.warn(`[Background] captureVisibleTab retry ${attempt + 1}:`, capErr.message);
        await new Promise(r => setTimeout(r, 650));
      }
    }
    if (!screenshot) throw new Error('Failed to capture visible tab screenshot. Ensure tab is active and visible.');
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
 * Injects a visual pulse and guide badges directly onto missing fields in the user's active tab.
 */
async function highlightRequiredFieldsOnTab(tabId, guidanceFields = []) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (fieldsList) => {
        // ── Robust IRCTC field detection using multiple selector strategies ──
        // IRCTC uses PrimeNG p-autocomplete with Angular formcontrolname attributes:
        //   - From: <p-autocomplete formcontrolname="journeyFrom">
        //   - To:   <p-autocomplete formcontrolname="journeyTo">
        //   - Date: <p-calendar formcontrolname="journeyDate">
        //   - Quota:<p-dropdown formcontrolname="journeyQuota" or journeyClass>

        function findFromInput() {
          // Priority 1: IRCTC-specific formcontrolname
          let el = document.querySelector('p-autocomplete[formcontrolname="journeyFrom"] input');
          if (el) return el;
          el = document.querySelector('p-autocomplete[formcontrolname*="from" i] input');
          if (el) return el;
          el = document.querySelector('p-autocomplete[formcontrolname*="origin" i] input');
          if (el) return el;
          // Priority 2: ID-based
          el = document.querySelector('#origin input, #fromStation input, input#origin');
          if (el) return el;
          // Priority 3: aria-label / placeholder
          el = document.querySelector('input[aria-label*="from" i], input[placeholder*="from" i]');
          if (el) return el;
          // Priority 4: First p-autocomplete
          const allAutos = document.querySelectorAll('p-autocomplete input, .ui-autocomplete input');
          if (allAutos.length >= 1) return allAutos[0];
          return null;
        }

        function findToInput() {
          let el = document.querySelector('p-autocomplete[formcontrolname="journeyTo"] input');
          if (el) return el;
          el = document.querySelector('p-autocomplete[formcontrolname*="to" i]:not([formcontrolname*="auto" i]) input');
          if (el) return el;
          el = document.querySelector('p-autocomplete[formcontrolname*="destination" i] input');
          if (el) return el;
          el = document.querySelector('#destination input, #toStation input, input#destination');
          if (el) return el;
          el = document.querySelector('input[aria-label*="going to" i], input[aria-label*="to" i]:not([aria-label*="auto" i]), input[placeholder*="to" i]:not([placeholder*="auto" i])');
          if (el) return el;
          const allAutos = document.querySelectorAll('p-autocomplete input, .ui-autocomplete input');
          if (allAutos.length >= 2) return allAutos[1];
          return null;
        }

        function findDateInput() {
          let el = document.querySelector('p-calendar[formcontrolname*="date" i] input, p-calendar[formcontrolname*="Date" i] input');
          if (el) return el;
          el = document.querySelector('p-calendar input, .ui-calendar input');
          if (el) return el;
          el = document.querySelector('input[type="date"], input[placeholder*="date" i], input[placeholder*="dd/mm" i], input[aria-label*="date" i]');
          if (el) return el;
          // Fallback: p-calendar element itself
          const pCal = document.querySelector('p-calendar');
          if (pCal) return pCal;
          return null;
        }

        function findClassDropdown() {
          let el = document.querySelector('p-dropdown[formcontrolname*="class" i], p-dropdown[formcontrolname*="quota" i], p-dropdown[formcontrolname*="Class" i]');
          if (el) return el;
          el = document.querySelector('p-dropdown, .ui-dropdown');
          if (el) return el;
          el = document.querySelector('select[name*="class" i], select[name*="quota" i]');
          return el;
        }

        function findUsernameInput() {
          let el = document.querySelector('input[name*="user" i], input[id*="user" i], input[placeholder*="user" i], input[autocomplete*="user" i], input[type="email"], input[name*="email" i], input[id*="email" i], input[name*="roll" i], input[id*="roll" i]');
          if (el) return el;
          const pass = document.querySelector('input[type="password"]');
          if (pass && pass.form) {
            const inps = Array.from(pass.form.querySelectorAll('input:not([type="hidden"]):not([type="password"]):not([type="submit"]):not([type="button"])'));
            if (inps.length > 0) return inps[0];
          }
          return null;
        }

        function findPasswordInput() {
          let el = document.querySelector('input[type="password"]');
          if (el) return el;
          return document.querySelector('input[name*="pass" i], input[id*="pass" i], input[placeholder*="pass" i]');
        }

        const fromEl = findFromInput();
        const toEl = findToInput();
        const dateEl = findDateInput();
        const classEl = findClassDropdown();
        const userEl = findUsernameInput();
        const passEl = findPasswordInput();

        const matchedElements = [];
        const isLoginFocus = (fieldsList && fieldsList.some(f => /user|pass|login|credential/i.test(f.name || f.label || ''))) ||
                             (Boolean(passEl) && !fromEl && !toEl);

        if (isLoginFocus || (userEl && passEl)) {
          if (userEl) matchedElements.push({ el: userEl, label: 'UserName' });
          if (passEl) matchedElements.push({ el: passEl, label: 'Password' });
        } else {
          if (fromEl) matchedElements.push({ el: fromEl, label: 'From Station (Origin)' });
          if (toEl && toEl !== fromEl) matchedElements.push({ el: toEl, label: 'To Station (Destination)' });
          if (dateEl) matchedElements.push({ el: dateEl, label: 'Journey Date' });
          if (classEl) matchedElements.push({ el: classEl, label: 'Class / Quota' });
        }

        // If no matches found, fallback to empty inputs
        if (matchedElements.length === 0) {
          const fallbackInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea')).filter(el => !el.value || el.value.trim() === '');
          fallbackInputs.slice(0, 3).forEach(el => {
            matchedElements.push({ el, label: 'Required Field' });
          });
        }

        if (matchedElements.length === 0) return false;

        // Scroll the primary field into view
        try {
          matchedElements[0].el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (e) {}

        // Remove all prior highlights and badges before applying new ones
        document.querySelectorAll('.privamon-field-highlight').forEach(el => el.classList.remove('privamon-field-highlight'));
        document.querySelectorAll('.privamon-guidance-badge').forEach(el => el.remove());

        // Ensure keyframe pulse animation and badge styles exist
        if (!document.getElementById('privamon-guidance-style')) {
          const style = document.createElement('style');
          style.id = 'privamon-guidance-style';
          style.textContent = `
            @keyframes privamonGlowPulse {
              0% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.7); }
              70% { box-shadow: 0 0 0 12px rgba(99, 102, 241, 0); }
              100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0); }
            }
            .privamon-field-highlight {
              outline: 3px solid #6366f1 !important;
              outline-offset: 2px !important;
              animation: privamonGlowPulse 1.8s infinite !important;
              transition: all 0.3s ease !important;
            }
            .privamon-guidance-badge {
              position: absolute;
              top: -28px;
              left: 0;
              background: linear-gradient(135deg, #6366f1, #8b5cf6);
              color: #ffffff;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              font-size: 11px;
              font-weight: 600;
              padding: 3px 8px;
              border-radius: 6px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.25);
              z-index: 2147483647;
              pointer-events: none;
              white-space: nowrap;
              letter-spacing: 0.3px;
            }
          `;
          document.head.appendChild(style);
        }

        // Apply highlights to each matched element
        matchedElements.forEach(({ el, label }) => {
          // Resolve to visible input child if wrapper component
          let target = el;
          if (['P-AUTOCOMPLETE', 'P-CALENDAR', 'P-DROPDOWN'].includes(el.tagName)) {
            target = el.querySelector('input, .p-dropdown-label, .ui-dropdown-label') || el;
          }

          target.classList.add('privamon-field-highlight');

          // Create floating badge above the field
          const badgeAnchor = target.parentElement || target;
          const badge = document.createElement('div');
          badge.className = 'privamon-guidance-badge';
          badge.textContent = `👉 Fill ${label}`;
          try {
            const currentPos = window.getComputedStyle(badgeAnchor).position;
            if (currentPos === 'static') {
              badgeAnchor.style.position = 'relative';
            }
            badgeAnchor.appendChild(badge);
          } catch (e) {}

          // Auto-remove highlight on user interaction or after 8s
          const removeHighlight = () => {
            target.classList.remove('privamon-field-highlight');
            const b = badgeAnchor.querySelector('.privamon-guidance-badge');
            if (b) b.remove();
            target.removeEventListener('input', removeHighlight);
            target.removeEventListener('focus', removeHighlight);
          };
          target.addEventListener('input', removeHighlight, { once: true });
          target.addEventListener('focus', removeHighlight, { once: true });
          setTimeout(removeHighlight, 8000);
        });

        // Scroll to first empty target
        const emptyTarget = matchedElements.find(m => {
          const inp = m.el.querySelector ? (m.el.querySelector('input') || m.el) : m.el;
          return !inp.value || inp.value.trim() === '';
        }) || matchedElements[0];

        if (emptyTarget) {
          const focusable = emptyTarget.el.querySelector ? (emptyTarget.el.querySelector('input') || emptyTarget.el) : emptyTarget.el;
          focusable.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => {
            try { focusable.focus(); } catch (e) {}
          }, 300);
        }

        return true;
      },
      args: [guidanceFields]
    });
  } catch (err) {
    console.warn('[Background] Could not highlight fields on tab:', err);
  }
}

/**
 * Circuit-breaker to prevent clicking "Search Trains" or search buttons
 * when origin/destination stations on travel booking pages (like IRCTC) are empty,
 * and to automatically trigger Search Trains when origin and destination are filled.
 */
function checkMissingTravelDetails(action, reasoning, task, domElements, tabUrl, liveStationInfo = null) {
  if (!action) return null;
  // NEVER block task completion
  if (action.type === 'done') return null;

  const url = tabUrl || '';
  const isIrctcUrl = url.includes('irctc.co.in');
  const isTravelTask = /\b(book|ticket|train|irctc|journey|reservation|railway)\b/i.test(task || '');

  // CRITICAL: NEVER activate unless on IRCTC or user specifically asked for travel/trains
  if (!isIrctcUrl && !isTravelTask) {
    return null;
  }

  let fromElement = null;
  let toElement = null;
  let dateElement = null;
  let searchElement = null;

  if (Array.isArray(domElements)) {
    // 1. Check for explicit origin / destination travel roles or formControlNames
    for (const el of domElements) {
      const role = String(el.travelRole || '').toLowerCase();
      const fcn = String(el.formControlName || el.name || '').toLowerCase();
      const ph = String(el.placeholder || el.attributes?.placeholder || '').toLowerCase();
      const label = String(el.label || '').toLowerCase();
      const elId = String(el.elementId || el.id || '').toLowerCase();
      const tag = String(el.tag || '').toLowerCase();
      const text = String(el.text || '').toLowerCase();
      const cls = String(el.className || '').toLowerCase();
      const aria = String(el.ariaLabel || el.attributes?.['aria-label'] || '').toLowerCase();

      // Search button
      if (!searchElement) {
        if (role === 'search_button' || text.includes('search train') || text.includes('find train') ||
            cls.includes('search_btn') || cls.includes('train_search') ||
            (tag === 'button' && (text.includes('search') || label.includes('search')))) {
          searchElement = el;
        } else if (action.targetElementId && (elId === action.targetElementId || elId.includes(action.targetElementId))) {
          if (text.includes('search') || label.includes('search') || ph.includes('search') || tag === 'button') {
            searchElement = el;
          }
        }
      }

      // From / Origin
      if (!fromElement) {
        if (role === 'origin' || fcn === 'journeyfrom' || fcn.includes('origin') || fcn.includes('from') ||
            ph.startsWith('from') || elId.includes('origin') ||
            ((label.includes('from') || aria.includes('from')) && !label.includes('to'))) {
          fromElement = el;
        }
      }

      // To / Destination
      if (!toElement) {
        if (el !== fromElement && (
            role === 'destination' || fcn === 'journeyto' || fcn.includes('destination') || fcn.includes('to') ||
            ph.startsWith('to') || elId.includes('destination') || elId.includes('dest') ||
            ((label.includes('to') || aria.includes('to')) && !label.includes('from')))) {
          toElement = el;
        }
      }

      // Date element
      if (!dateElement) {
        if (label.includes('date') || ph.includes('date') || ph.includes('dd/mm') || el.widgetType === 'datepicker') {
          dateElement = el;
        }
      }
    }

    // Fallback: autocomplete inputs in DOM order
    if (!fromElement || !toElement) {
      const autocompletes = domElements.filter(el => {
        const w = String(el.widgetType || '').toLowerCase();
        const tag = String(el.tag || '').toLowerCase();
        return w === 'autocomplete' || tag === 'p-autocomplete';
      });
      if (autocompletes.length >= 2) {
        if (!fromElement) fromElement = autocompletes[0];
        if (!toElement) toElement = autocompletes[1];
      }
    }
  }

  const isTravelContext = isIrctcUrl || isTravelTask;
  const reasonText = String(reasoning || '').toLowerCase();
  const targetId = String(action.targetElementId || '').toLowerCase();
  const isSearchClick = (action.type === 'click' && (
    reasonText.includes('search train') ||
    reasonText.includes('search trains') ||
    reasonText.includes('proceed with booking') ||
    reasonText.includes('find train') ||
    reasonText.includes('find trains') ||
    (searchElement !== null && (targetId.includes('search') || targetId.includes('train') || targetId === searchElement.elementId))
  ));

  let fromVal = String(fromElement?.value || fromElement?.attributes?.value || fromElement?.text || '').trim();
  let toVal = String(toElement?.value || toElement?.attributes?.value || toElement?.text || '').trim();

  // If live verified values from active tab are provided, prefer them
  if (liveStationInfo) {
    if (liveStationInfo.fromVal) fromVal = liveStationInfo.fromVal;
    if (liveStationInfo.toVal) toVal = liveStationInfo.toVal;
  }

  const fromEmpty = fromVal === '';
  const toEmpty = toVal === '';

  // IF FROM AND TO ARE FILLED:
  if (isTravelContext && !fromEmpty && !toEmpty) {
    // If the model emitted wait/ask_user with fill, convert to click Search Trains button!
    if (action.type === 'wait' || action.type === 'ask_user') {
      const sId = (searchElement?.elementId || searchElement?.id || 'button_search');
      console.log(`[Background] Stations are filled (From="${fromVal}", To="${toVal}"). Auto-converting to click Search Trains (${sId})!`);
      return {
        action: {
          type: 'click',
          targetElementId: sId,
          value: null,
          scrollDirection: null
        },
        reasoning: `Stations are filled ("${fromVal}" to "${toVal}"). Clicking Search Trains to view available trains.`,
        assumptions: ['Origin and destination stations are filled on page.'],
        needsClarification: false
      };
    }
    return null; // Don't block search clicks!
  }

  // IF FROM OR TO ARE EMPTY, BLOCK SEARCH:
  if (isTravelContext && isSearchClick) {
    if (fromEmpty || toEmpty) {
      console.warn('[Background] Travel Circuit-Breaker: Blocked premature search click because From/To are empty!');
      const taskStr = task || '';
      const fromMatch = taskStr.match(/\bfrom\s+([A-Za-z0-9\s/]+?)(?:\s+to|\s+on|\s+date|$)/i);
      const toMatch = taskStr.match(/\bto\s+([A-Za-z0-9\s/]+?)(?:\s+from|\s+on|\s+date|$)/i);

      if (fromEmpty && fromMatch && fromElement) {
        return {
          action: {
            type: 'type_and_select',
            targetElementId: fromElement.elementId || 'from',
            value: fromMatch[1].trim(),
            scrollDirection: null
          },
          reasoning: `Entering origin station "${fromMatch[1].trim()}" into From field before searching.`,
          assumptions: ['Origin station must be filled before searching trains.'],
          needsClarification: false
        };
      }

      if (toEmpty && toMatch && toElement) {
        return {
          action: {
            type: 'type_and_select',
            targetElementId: toElement.elementId || 'to',
            value: toMatch[1].trim(),
            scrollDirection: null
          },
          reasoning: `Entering destination station "${toMatch[1].trim()}" into To field before searching.`,
          assumptions: ['Destination station must be filled before searching trains.'],
          needsClarification: false
        };
      }

      return {
        action: {
          type: 'wait',
          targetElementId: null,
          value: 'Please fill From Station, To Station, and Journey Date directly on the page before searching trains.',
          scrollDirection: null
        },
        reasoning: 'Please fill in your From Station, To Station, and Journey Date directly on the page before searching. Click "Show Me Where" if you need guidance, then click Continue once filled.',
        assumptions: ['IRCTC requires From and To stations before searching trains.'],
        needsClarification: true,
        guidance: {
          title: 'Enter Journey Details on IRCTC',
          question: 'Please fill in the travel stations and date directly on the page before proceeding:',
          fields: [
            { name: 'from', label: 'From Station', description: 'Enter departure station (e.g. New Delhi / NDLS)' },
            { name: 'to', label: 'To Station', description: 'Enter destination station (e.g. Mumbai / BCT)' },
            { name: 'date', label: 'Journey Date', description: 'Select your travel date' },
            { name: 'class', label: 'Class / Quota', description: 'Select your desired coach class' }
          ]
        }
      };
    }
  }

  return null;
}

function checkMissingLoginCredentials(action, reasoning, task, domElements, tabUrl, liveLoginInfo = null) {
  if (!action) return null;
  // NEVER block task completion (e.g. user already logged into dashboard)
  if (action.type === 'done') return null;

  let userElement = null;
  let passElement = null;
  let loginElement = null;

  if (Array.isArray(domElements)) {
    for (const el of domElements) {
      const authRole = String(el.authRole || '').toLowerCase();
      const inpType = String(el.inputType || el.type || '').toLowerCase();
      const ph = String(el.placeholder || el.attributes?.placeholder || '').toLowerCase();
      const label = String(el.label || '').toLowerCase();
      const elId = String(el.elementId || el.id || '').toLowerCase();
      const name = String(el.name || '').toLowerCase();
      const tag = String(el.tag || '').toLowerCase();
      const text = String(el.text || '').toLowerCase();
      const role = String(el.role || '').toLowerCase();

      // Password input
      if (!passElement) {
        if (authRole === 'password_input' || inpType === 'password' || elId.includes('password') || ph.includes('password') || name.includes('password')) {
          passElement = el;
        }
      }

      // Username input
      if (!userElement) {
        if (authRole === 'username_input' || (inpType !== 'password' && (
          elId === 'username' || elId === 'userid' || elId.includes('txtuser') ||
          ph.includes('username') || name === 'username' || name.includes('user') ||
          elId.includes('roll') || name.includes('roll') || label.includes('username') || label.includes('roll')
        ))) {
          userElement = el;
        }
      }

      // Login / Sign in submit button (must be a button or submit input, NOT a container div or tab)
      if (!loginElement) {
        const isClickable = tag === 'button' || tag === 'input' || (tag === 'a' && el.className?.includes('btn'));
        const isTab = el.attributes?.['data-toggle'] === 'tab' || role === 'tab';
        if (isClickable && !isTab && (
          authRole === 'login_button' ||
          elId === 'btnsubmit' || elId === 'btnlogin' || elId.includes('btnsubmit') || elId.includes('btnlogin') ||
          (inpType === 'submit' && (text.includes('sign in') || text.includes('login') || text.includes('submit'))) ||
          text === 'sign in' || text === 'login' || text === 'log in' ||
          text.includes('sign in') || text.includes('login') || text.includes('log in')
        )) {
          loginElement = el;
        }
      }
    }
  }

  // If there is NO password input on the current page, this is NOT a login screen (e.g. user is on dashboard)!
  if (!passElement) {
    return null;
  }

  let userVal = String(userElement?.value || userElement?.attributes?.value || '').trim();
  let passVal = String(passElement?.value || passElement?.attributes?.value || '').trim();

  if (liveLoginInfo) {
    if (liveLoginInfo.userVal) userVal = liveLoginInfo.userVal;
    if (liveLoginInfo.passVal) passVal = liveLoginInfo.passVal;
  }

  const userEmpty = userVal === '';
  const passEmpty = passVal === '';

  const reasonText = String(reasoning || '').toLowerCase();
  const targetId = String(action.targetElementId || '').toLowerCase();
  const isLoginClick = (action.type === 'click' && (
    reasonText.includes('sign in') || reasonText.includes('login') || reasonText.includes('log in') ||
    (loginElement && (targetId === loginElement.elementId || targetId === loginElement.id)) ||
    targetId === 'btnsubmit' || targetId === 'btnlogin'
  ));

  // IF CREDENTIALS ARE EMPTY: ONLY block premature click on the submit button!
  if (userEmpty || passEmpty) {
    if (isLoginClick) {
      console.warn('[Background] Login Circuit-Breaker: Blocked premature login click because credentials are empty!');
      return {
        action: {
          type: 'wait',
          targetElementId: null,
          value: 'Please fill in your correct credentials directly on the page. After filling, click Proceed.',
          scrollDirection: null
        },
        reasoning: 'Please fill in your correct credentials directly on the page. After filling, click Proceed.',
        assumptions: ['User must enter their credentials on the login form before proceeding.'],
        needsClarification: true,
        guidance: {
          title: 'Please Fill Correct Credentials',
          question: 'Please fill in your correct credentials directly on the page. After filling, click Proceed:',
          fields: [
            { name: 'username', label: 'UserName', description: 'Enter your username, roll number, or email' },
            { name: 'password', label: 'Password', description: 'Enter your password' }
          ]
        }
      };
    }
  }

  return null;
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
async function handleChatWithAgent(task, serverUrl = 'https://privamon.onrender.com') {
  // Track server URL for continueAfterGuidance
  if (serverUrl) currentServerUrl = serverUrl;
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

    // Bring tab and window into active focus before capturing screenshot
    if (tab?.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    }

    // Step 1: Capture screenshot with 6.5s timeout race
    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'capture',
      status: 'active',
      statusText: 'Capturing screen...',
    });

    let screenshot = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        screenshot = await Promise.race([
          chrome.tabs.captureVisibleTab(tab?.windowId || null, { format: 'png' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('captureVisibleTab timed out after 6.5s')), 6500))
        ]);
        if (screenshot) break;
      } catch (capErr) {
        console.warn(`[Background] captureVisibleTab retry ${attempt + 1}:`, capErr.message);
        await new Promise(r => setTimeout(r, 650));
      }
    }
    if (!screenshot) throw new Error('Failed to capture visible tab screenshot. Ensure page is visible and active.');

    // Step 2: Extract DOM with 7.5s timeout race
    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'dom',
      status: 'active',
      statusText: 'Extracting DOM context...',
    });

    let domData = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const domResults = await Promise.race([
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/dom-range-mapper.js', 'content/dom-extractor.js'],
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('DOM extraction timed out after 7.5s')), 7500))
        ]);
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
      statusText: 'Consulting Privamon AI Agent...',
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

    // Check live station values directly on IRCTC tab for 100% accurate detection
    let liveStationInfo = null;
    if (tab?.id && tab.url && tab.url.includes('irctc.co.in')) {
      try {
        const liveRes = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const fromInp = document.querySelector('p-autocomplete[formcontrolname="journeyFrom"] input')
              || document.querySelector('p-autocomplete[formcontrolname*="from" i] input, p-autocomplete[formcontrolname*="origin" i] input')
              || (document.querySelectorAll('p-autocomplete input, .ui-autocomplete input')[0])
              || document.querySelector('input[placeholder*="from" i], input[aria-label*="from" i], #origin input');
            const toInp = document.querySelector('p-autocomplete[formcontrolname="journeyTo"] input')
              || document.querySelector('p-autocomplete[formcontrolname*="destination" i] input')
              || (document.querySelectorAll('p-autocomplete input, .ui-autocomplete input')[1])
              || document.querySelector('input[placeholder*="to" i]:not([placeholder*="auto" i]), input[aria-label*="to" i]:not([aria-label*="auto" i]), #destination input');
            const fromVal = (fromInp?.value || fromInp?.getAttribute('value') || '').trim();
            const toVal = (toInp?.value || toInp?.getAttribute('value') || '').trim();

            const uInp = document.querySelector('input[name*="user" i], input[id*="user" i], input[placeholder*="user" i], input[autocomplete*="user" i], input[type="email"], input[name*="roll" i], input[id*="roll" i]');
            const pInp = document.querySelector('input[type="password"], input[name*="pass" i], input[id*="pass" i]');
            const userVal = (uInp?.value || '').trim();
            const passVal = (pInp?.value || '').trim();

            return {
              fromVal, toVal, isFilled: fromVal.length > 0 && toVal.length > 0,
              userVal, passVal
            };
          }
        });
        liveStationInfo = liveRes[0]?.result;
      } catch (e) {}
    }

    // Circuit breaker: Intercept premature search clicks when From/To are empty on IRCTC/travel pages
    const travelIntercept = checkMissingTravelDetails(turn.action, turn.reasoning, queryText, domData?.elements, tab?.url, liveStationInfo);
    if (travelIntercept) {
      console.log('[Background] Circuit-breaker intercepted travel search in turn:', travelIntercept);
      turn.action = travelIntercept.action;
      turn.actions = [travelIntercept.action];
      if (travelIntercept.reasoning) turn.reasoning = travelIntercept.reasoning;
      if (travelIntercept.assumptions) turn.assumptions = travelIntercept.assumptions;
      if (travelIntercept.needsClarification !== undefined) turn.needsClarification = travelIntercept.needsClarification;
      if (travelIntercept.guidance) turn.guidance = travelIntercept.guidance;

      // Automatically highlight fields on active tab to guide the user visually if still empty
      if (tab?.id && turn.needsClarification) {
        highlightRequiredFieldsOnTab(tab.id, travelIntercept.guidance?.fields || []).catch(() => {});
      }
    }

    // Circuit breaker: Intercept premature login clicks or failed logins when credentials are empty
    const loginIntercept = checkMissingLoginCredentials(turn.action, turn.reasoning, queryText, domData?.elements, tab?.url, liveStationInfo);
    if (loginIntercept) {
      console.log('[Background] Circuit-breaker intercepted login in turn:', loginIntercept);
      turn.action = loginIntercept.action;
      turn.actions = [loginIntercept.action];
      if (loginIntercept.reasoning) turn.reasoning = loginIntercept.reasoning;
      if (loginIntercept.assumptions) turn.assumptions = loginIntercept.assumptions;
      if (loginIntercept.needsClarification !== undefined) turn.needsClarification = loginIntercept.needsClarification;
      if (loginIntercept.guidance) turn.guidance = loginIntercept.guidance;

      // Automatically highlight credentials fields on active tab to show user where to fill them
      if (tab?.id && turn.needsClarification) {
        highlightRequiredFieldsOnTab(tab.id, loginIntercept.guidance?.fields || []).catch(() => {});
      }
    }

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
  } catch (err) {
    console.error('[Background] handleChatWithAgent error:', err);
    forwardToPopup({
      type: 'pipelineError',
      error: err.message || 'Page analysis failed',
    });
    throw err;
  } finally {
    clearInterval(keepAliveInterval);
    chrome.storage.local.set({
      privamon_redaction_state: {
        isRunning: false,
        stageId: 'complete',
        status: 'done',
        statusText: 'Pipeline idle',
        timestamp: Date.now()
      }
    }).catch(() => {});
  }
}

/**
 * Executes on-device privacy redaction testing on the active tab without server transmission.
 * 1. Captures visible tab screenshot.
 * 2. Extracts DOM elements.
 * 3. Runs full in-browser redaction pipeline (PII detection, face detection, solid redactions, verification).
 * 4. Stores result in chrome.storage.session for results.html inspection.
 * 5. Returns redacted result directly to caller with ZERO server network calls.
 */
let isRedactionTestRunning = false;

async function handleTestRedactionOnly() {
  if (isRedactionTestRunning) {
    console.log('[Background] Test Redaction already in progress. Ignoring duplicate request.');
    return { success: true, running: true, message: 'Redaction test already in progress in background' };
  }
  isRedactionTestRunning = true;
  console.log('[Background] Test Redaction requested (Zero Server Transmission)');

  chrome.storage.local.set({
    privamon_redaction_state: {
      isRunning: true,
      stageId: 'start',
      status: 'active',
      statusText: 'Starting redaction test (Zero Server)...'
    },
    privamon_active_mode: 'redaction'
  }).catch(() => {});

  const keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 3500);

  try {
    const tab = await getOperableTab();
    await waitForTabReady(tab.id, 6000);

    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'capture',
      status: 'active',
      statusText: 'Capturing screen for testing...',
    });

    let screenshot = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        screenshot = await chrome.tabs.captureVisibleTab(tab?.windowId || null, { format: 'png' });
        if (screenshot) break;
      } catch (capErr) {
        console.warn(`[Background] captureVisibleTab retry ${attempt + 1}:`, capErr.message);
        await new Promise(r => setTimeout(r, 650));
      }
    }
    if (!screenshot) throw new Error('Failed to capture visible tab screenshot. Ensure tab is active and visible.');

    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'dom',
      status: 'active',
      statusText: 'Extracting DOM elements for testing...',
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

    forwardToPopup({
      type: 'pipelineProgress',
      stageId: 'redaction',
      status: 'active',
      statusText: 'Running on-device redaction pipeline (Zero Server)...',
    });

    await ensureOffscreenDocument();
    const pipelineResult = await runPipelineAsync(screenshot, domData, 'Redaction Test (Local Only)');

    // Store in session storage so results.html / full tab can inspect sanitized results
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
          isTestOnly: true,
          pageTitle: tab.title || 'Tested Page',
          pageUrl: tab.url || ''
        }
      });
    } catch (storeErr) {
      console.warn('[Background] Failed to store full result in session storage:', storeErr.message);
    }

    forwardToPopup({
      type: 'pipelineComplete',
      result: {
        detectionSummary: pipelineResult.detectionSummary,
        timings: pipelineResult.timings,
      },
    });

    console.log('[Background] Test Redaction complete. Returning sanitized page without server transmission.');

    return {
      success: true,
      sanitizedScreenshot: pipelineResult.sanitizedScreenshot,
      originalScreenshot: screenshot,
      detections: pipelineResult.detections || [],
      redactions: pipelineResult.redactions || [],
      reviews: pipelineResult.reviews || [],
      kept: pipelineResult.kept || [],
      detectionSummary: pipelineResult.detectionSummary || { total: 0, byType: {}, bySource: {} },
      timings: pipelineResult.timings || {},
      verificationPassed: pipelineResult.verificationPassed,
      pageTitle: tab.title || 'Web Page',
      pageUrl: tab.url || ''
    };
  } finally {
    isRedactionTestRunning = false;
    clearInterval(keepAliveInterval);
    chrome.storage.local.set({
      privamon_redaction_state: {
        isRunning: false,
        stageId: 'complete',
        status: 'done',
        statusText: 'Redaction idle'
      }
    }).catch(() => {});
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
  const hasChatIntent = /\b(send|message|chat|reply|text|contact|tell|draft)\b/i.test(task || '');
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

    // WhatsApp contact search result item match (in left pane below search bar)
    const isContactResultEl = !isAudioRecord && !isSearchInputEl && (
      (el.bbox && el.bbox.x < 450 && el.bbox.y >= 65 && el.bbox.y <= 400)
    ) && (
      (role === 'listitem' || role === 'row' || role === 'gridcell' || tag === 'div' || tag === 'span') &&
      !/^(all|unread|favourites|groups|archived|chats|status|channels|communities)$/i.test(el.label || el.text || '')
    );
    if ((hasChatIntent || hasSearchIntent) && isContactResultEl) {
      score += 20;
      if (el.bbox && el.bbox.y <= 200) {
        score += 15; // Extra boost for the top contact card
      }
    }

    // Heavy penalty for YouTube sidebar navigation links
    const isSidebarEl = Boolean(
      el.isSidebar ||
      (el.bbox && el.bbox.x < 220 && (tag === 'a' || role === 'link' || tag === 'yt-formatted-string') &&
       /^(home|shorts|subscriptions|you|history|playlists|watch later|liked videos|your videos|your clips|trending|music|gaming|news|sports)/i.test(el.label || el.text || ''))
    );
    if (isSidebarEl) {
      score -= 40; // Never prioritize sidebar navigation links over search results
    }

    // YouTube video, playlist, and course result link match
    const isPlayableMediaEl = (tag === 'a' || role === 'link' || tag === 'yt-formatted-string' || el.id === 'video-title') && (
      el.id === 'video-title' ||
      el.isSearchResult ||
      el.isPlaylist ||
      /watch\?v=|playlist\?list=|\/playlist|\/course/i.test(el.href || '') ||
      /views|subscribers|ago|video|playlist|course|lessons/i.test(el.label || '') ||
      /view full (playlist|course)/i.test(el.text || '')
    ) && !isSidebarEl;

    if (hasVideoIntent && isPlayableMediaEl) {
      score += 25;
      if (el.isSearchResult || el.isPlaylist) {
        score += 10; // Extra boost for verified search result / playlist card
      }
      if (/\b(most viewed|popular)\b/i.test(task || '') && /\b\d+(\.\d+)?[Mm]\s+views/i.test(el.label || '')) {
        score += 10; // Boost million-view videos when asking for most viewed
      }
      if (/\b(first|top)\b/i.test(task || '') && pos && pos.startsWith('top')) {
        score += 12;
      }
      // Prioritize the top-most main search result card (above-the-fold)
      if (el.bbox && el.bbox.x >= 220 && el.bbox.y >= 60 && el.bbox.y <= 450) {
        score += 20; // Primary above-the-fold search result boost
      }
      if (el.label && (el.label.includes('MEMBERS ONLY') || el.label.includes('Members only'))) {
        score -= 50; // Ensure members-only videos are not picked over free public items
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
      href: el.href || null,
      attributes: {
        type: el.inputType || (isContentEditable ? 'contenteditable' : null),
        placeholder: placeholderVal || null,
        value: el.value ? String(el.value).slice(0, 40) : null,
        href: el.href ? String(el.href).slice(0, 100) : null
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
async function sendToServerAgent(result, task, serverUrl = 'https://privamon.onrender.com', tab = null) {
  const endpoint = (serverUrl || 'https://privamon.onrender.com').replace(/\/+$/, '') + '/interpret';

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
      const href = el.href ? ` href="${el.href.slice(0, 60)}"` : '';
      const text = el.text ? ` text="${el.text}"` : '';
      return `<${el.tag} id="${el.elementId}"${pos}${type}${label}${ph}${val}${href}${text}/>`;
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
        const valPreview = t.action?.value
          ? '"' + (t.action.value.length > 50 ? t.action.value.slice(0, 50) + '...' : t.action.value) + '"'
          : '';
        const actStr = t.action
          ? `${t.action.type} ${t.action.targetElementId || ''} ${valPreview}`.trim()
          : `"${(t.task || '').length > 50 ? t.task.slice(0, 50) + '...' : t.task}"`;

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

  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (netErr) {
    if (netErr.name === 'AbortError') {
      throw new Error(`Server request timed out after 45s (${endpoint}). The model server may be cold-starting or busy.`);
    }
    throw netErr;
  } finally {
    clearTimeout(fetchTimeout);
  }

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

  // Prevent manual execution of Search click when travel inputs are empty
  if (actionPayload.type === 'click') {
    if (tab && tab.url && tab.url.includes('irctc.co.in')) {
      try {
        const checkResult = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (targetId) => {
            const el = document.getElementById(targetId) ||
                       document.querySelector(`[data-privamon-id="${targetId}"]`) ||
                       document.querySelector('button.search_btn, button.train_Search, [type="submit"]');
            const isSearch = el && (/search/i.test(el.textContent || '') || /train_search|search_btn/i.test(el.className || ''));
            if (!isSearch) return { blocked: false };

            // Use IRCTC formcontrolname selectors first
            const fromInp = document.querySelector('p-autocomplete[formcontrolname="journeyFrom"] input')
              || document.querySelector('p-autocomplete[formcontrolname*="from" i] input')
              || (document.querySelectorAll('p-autocomplete input, .ui-autocomplete input')[0])
              || document.querySelector('input[placeholder*="from" i], input[aria-label*="from" i], #origin input');
            const toInp = document.querySelector('p-autocomplete[formcontrolname="journeyTo"] input')
              || document.querySelector('p-autocomplete[formcontrolname*="destination" i] input')
              || (document.querySelectorAll('p-autocomplete input, .ui-autocomplete input')[1])
              || document.querySelector('input[placeholder*="to" i]:not([placeholder*="auto" i]), input[aria-label*="to" i]:not([aria-label*="auto" i]), #destination input');
            const fromEmpty = !fromInp || !fromInp.value || fromInp.value.trim() === '';
            const toEmpty = !toInp || !toInp.value || toInp.value.trim() === '';
            return { blocked: fromEmpty || toEmpty };
          },
          args: [actionPayload.targetElementId || '']
        });
        if (checkResult[0]?.result?.blocked) {
          console.warn('[Background] Blocked manual execution of click Search: From/To are empty!');
          return {
            success: false,
            actionType: 'click',
            targetElementId: actionPayload.targetElementId,
            message: 'Cannot click Search Trains: From and To stations must be entered first.'
          };
        }
      } catch (e) {}
    }
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
const pendingUserInputs = new Map();

function waitForUserInput(requestId, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingUserInputs.delete(requestId);
      resolve({ cancelled: true, reason: 'timeout' });
    }, timeoutMs);

    pendingUserInputs.set(requestId, {
      resolve: (data) => {
        clearTimeout(timer);
        pendingUserInputs.delete(requestId);
        resolve(data);
      }
    });
  });
}

function stopActionLoop() {
  console.log('[Background] Stopping action loop on user request.');
  isLoopCancelled = true;
  isActionLoopRunning = false;
  for (const [reqId, pending] of pendingUserInputs.entries()) {
    pending.resolve({ cancelled: true, reason: 'stopped' });
  }
  pendingUserInputs.clear();
  updateLoopState({
    isRunning: false,
    status: 'paused',
    message: 'Loop stopped by user.'
  });
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
async function handleActionLoop(initialTask, serverUrl = 'https://privamon.onrender.com', maxSteps = 5) {
  const task = initialTask || 'Continue the current task';
  const steps = [];

  if (isActionLoopRunning) {
    console.warn('[Background] Auto-pilot loop already active; overriding existing run.');
    isLoopCancelled = true;
    await new Promise(r => setTimeout(r, 400));
  }

  isActionLoopRunning = true;
  isLoopCancelled = false;
  updateLoopState({
    isRunning: true,
    step: 1,
    maxSteps,
    status: 'analyzing',
    message: 'Step 1: Inspecting screen & verifying state...',
    task
  });

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

      // Provide intent-aware verification context to the model on subsequent steps
      const prevAct = steps[steps.length - 1]?.action;
      const prevValSnippet = prevAct?.value
        ? '"' + (prevAct.value.length > 50 ? prevAct.value.slice(0, 50) + '...' : prevAct.value) + '"'
        : '';
      
      let stepGuidance = '';
      const isVideoPlayTask = /\b(play|watch|video|song|episode|listen)\b/i.test(task);
      const isContactMessagingTask = /\b(?:search\s+(?:for\s+)?(?:contact\s+)?|message\s+[A-Za-z0-9_]|send\s+[A-Za-z0-9_]|tell\s+[A-Za-z0-9_]|text\s+[A-Za-z0-9_])\b/i.test(task);
      const isChatTask = /\b(send|message|chat|reply|type|text|draft)\b/i.test(task);
      const isSearchTask = /\b(search|find|look\s*up)\b/i.test(task);
      const isTravelBookingTask = /\b(book|ticket|train|irctc|journey|flight|bus|reservation|seat)\b/i.test(task);
      const isLoginTask = /\b(login|log\s*in|sign\s*in|signin|auth|portal|credentials)\b/i.test(task);

      if (isLoginTask) {
        const hasPriorLoginClick = steps.some(s => s.action && s.action.type === 'click' && s.execResult?.success);
        const hasPriorGuidance = steps.some(s => s.action && (s.action.type === 'wait' || s.action.type === 'ask_user'));

        if (hasPriorLoginClick) {
          stepGuidance = `[STEP GUIDANCE: Sign in was clicked. Inspect the screen: if the user is now logged in to the dashboard/portal (URL changed or dashboard elements visible), return action type "done". If login did NOT happen (the page is still on the login screen, shows an error like "Invalid credentials", or username/password fields are still visible), DO NOT click login repeatedly. Return action type "ask_user" with needsClarification=true: "Please fill in your correct credentials directly on the page. After filling, click Proceed."]`;
        } else if (hasPriorGuidance) {
          stepGuidance = `[STEP GUIDANCE: The user was asked to fill their credentials. Inspect the username and password fields: if they are now filled, emit action type "click" targeting the "Sign in" / "Login" button. If still empty, return action type "ask_user" instructing the user: "Please fill in your correct credentials directly on the page. After filling, click Proceed."]`;
        } else {
          stepGuidance = `[STEP GUIDANCE: The user requested to login. Inspect the page: if username and password fields are present and empty, NEVER submit empty credentials or guess passwords. Return action type "ask_user" with needsClarification=true: "Please fill in your correct credentials directly on the page. After filling, click Proceed."]`;
        }
      } else if (isTravelBookingTask) {
        // IRCTC / Travel booking step guidance
        const hasPriorGuidance = steps.some(s => s.action && (s.action.type === 'wait' || s.action.type === 'ask_user') && s.message?.includes('filled'));
        const hasPriorSearchClick = steps.some(s => s.action && s.action.type === 'click' && s.execResult?.success);

        if (hasPriorSearchClick) {
          stepGuidance = `[STEP GUIDANCE: Search Trains was clicked. Inspect the screen: if train results are listed, describe the available trains to the user and return action type "done". If an error appeared (e.g. "Please submit correct input"), the stations may not have been filled correctly — emit ask_user to guide the user to re-enter them.]`;
        } else if (hasPriorGuidance) {
          stepGuidance = `[STEP GUIDANCE: The user was asked to fill journey details. Inspect the From and To station fields: if they now contain station names, click the "Search Trains" or "Find Trains" button. If they are still empty, remind the user to fill them. NEVER guess station names — let the user fill them directly on the IRCTC page.]`;
        } else {
          stepGuidance = `[STEP GUIDANCE: This is a travel booking task on IRCTC. CRITICAL: Do NOT click Search Trains if From or To station fields are empty! If the user has not specified station names in their query, emit ask_user with needsClarification=true to guide them to fill From Station, To Station, and Journey Date directly on the page. NEVER hallucinate station names.]`;
        }
      } else if (isVideoPlayTask) {
        stepGuidance = `[STEP GUIDANCE: The previous action (${prevAct?.type || 'action'} ${prevValSnippet}) was executed. Inspect the screen: If you are on search results with video/playlist/course cards, DO NOT return "done" yet — the user's task explicitly requires playing the video or playlist! Target the first public title link or thumbnail in the main search results (look for a#video-title or first card at x >= 240) with action type "click". NEVER click sidebar navigation links (e.g. "Playlists" or "Liked videos" on the left). ONLY return action type "done" when the video watch page (/watch) or playlist player is open and playing.]`;
      } else if (isContactMessagingTask) {
        const hasPriorContactSearch = steps.some(s => s.action && s.action.type === 'type' && (!s.execResult || !s.execResult.message || !s.execResult.message.includes('and sent message')));
        const hasPriorContactClick = steps.some(s => s.action && s.action.type === 'click');
        const hasPriorMessageSend = steps.some(s => s.action && s.action.type === 'type' && s.execResult && (s.execResult.message?.includes('and sent message') || s.action.isMessageSend));

        if (hasPriorMessageSend) {
          stepGuidance = `[VERIFY TASK COMPLETION: The previous action (${prevAct?.type || 'action'} ${prevValSnippet}) was executed. Inspect the chat history: if the message is visible in the chat bubbles or the input is cleared, return action type "done". If the message is still sitting in the input box and not yet sent, emit action type "click" targeting the Send button.]`;
        } else if (hasPriorContactClick || (hasPriorContactSearch && prevAct?.type === 'click')) {
          stepGuidance = `[STEP GUIDANCE: The contact's chat conversation is now open on the right. Now type the requested message (or generate the requested poem/content) into the message input box at the bottom ("Type a message", role="textbox") with action type "type". The client will automatically send the message once typed.]`;
        } else if (hasPriorContactSearch || prevAct?.type === 'type') {
          stepGuidance = `[STEP GUIDANCE: The contact name was searched in the search bar. Inspect the left column under "Chats": click the FIRST/TOP contact result that appears in the search list to open their conversation pane. CRITICAL: DO NOT click or type into the message input box on the right until that contact's chat is open!]`;
        } else {
          stepGuidance = `[STEP GUIDANCE: The previous action (${prevAct?.type || 'action'} ${prevValSnippet}) was executed. Inspect screen state and take the next required step.]`;
        }
      } else if (isChatTask) {
        stepGuidance = `[VERIFY TASK COMPLETION: The previous action (${prevAct?.type || 'action'} ${prevValSnippet}) was executed. Inspect the screen: if the message is visible in chat history or input is cleared, return action type "done". If the message is still sitting in the input box and not yet sent, emit action type "click" targeting the Send button.]`;
      } else if (isSearchTask) {
        stepGuidance = `[STEP GUIDANCE: The previous action (${prevAct?.type || 'action'} ${prevValSnippet}) was executed. Inspect the screen: If search results or product listings for the search query are displayed (URL /search, /results, /s), the search succeeded! Return action type "done" unless the user asked to click or open a specific item. CRITICAL: If you are still on the homepage or the search input is empty, DO NOT return "done" — homepage banners and suggested items are not search results!]`;
      } else {
        stepGuidance = `[STEP GUIDANCE: The previous action (${prevAct?.type || 'action'} ${prevValSnippet}) was executed. Inspect current screen state and take the next required step, or return "done" if fully complete.]`;
      }

      const currentQuery = step === 0 ? task : `${task} ${stepGuidance}`;

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
        const isSearchOnly = isSearchTask && !isVideoPlayTask;
        if (isSearchOnly && step === 0) {
          console.warn('[Background] Model emitted premature "done" on Step 1 of search task without searching. Continuing loop.');
          continue;
        }
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
      // BUT only if no prior type/search step has already succeeded (otherwise the model is correctly
      // trying to click a video or result item and should NOT be converted to type)
      if (step > 0 && action.type === 'click' && action.targetElementId) {
        const priorSameClicks = steps.filter(s => s.action && s.action.type === 'click' && s.action.targetElementId === action.targetElementId);
        const hasPriorTypeSuccess = steps.some(s => s.action && s.action.type === 'type' && s.execResult && s.execResult.success);
        if (priorSameClicks.length >= 1 && !hasPriorTypeSuccess) {
          const isSearchTask = /\b(search|find|look\s*up)\b/i.test(task || '');
          if (isSearchTask) {
            console.log('[Background] Circuit-breaker: Repeated click on search element detected (no prior search). Auto-converting to type action.');
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

      if (action.type === 'ask_user' || turn.needsClarification || (action.type === 'wait' && turn.needsClarification)) {
        let question = 'Please fill in the required details directly on the page before proceeding:';
        let title = 'Action Needed on Page';
        let fields = [];

        // Check if turn.guidance or action.value is structured JSON
        if (turn.guidance) {
          title = turn.guidance.title || title;
          question = turn.guidance.question || question;
          fields = turn.guidance.fields || [];
        } else if (action.value) {
          try {
            const parsed = JSON.parse(action.value);
            if (parsed.fields && Array.isArray(parsed.fields)) {
              fields = parsed.fields;
              question = parsed.question || question;
              title = parsed.title || title;
            } else if (typeof parsed === 'object') {
              question = parsed.question || action.value;
              title = parsed.title || title;
            }
          } catch (e) {
            question = action.value;
          }
        }

        // If no fields were provided in value, but the task relates to booking or IRCTC, auto-generate standard travel fields!
        if (fields.length === 0 && /\b(book|ticket|train|irctc|journey|flight|bus|reservation)\b/i.test(task || '')) {
          fields = [
            { name: 'from', label: 'From Station', description: 'Enter departure station (e.g. New Delhi / NDLS)' },
            { name: 'to', label: 'To Station', description: 'Enter destination station (e.g. Mumbai / BCT)' },
            { name: 'date', label: 'Journey Date', description: 'Select your travel date' },
            { name: 'class', label: 'Class / Quota', description: 'Choose coach class (e.g. Sleeper or 3A)' }
          ];
        } else if (fields.length === 0 && /\b(login|log\s*in|sign\s*in|signin|auth|portal|credentials)\b/i.test(task || '')) {
          title = 'Please Fill Correct Credentials';
          question = 'Please fill in your correct credentials directly on the page. After filling, click Proceed:';
          fields = [
            { name: 'username', label: 'UserName', description: 'Enter your username, roll number, or email' },
            { name: 'password', label: 'Password', description: 'Enter your password' }
          ];
        }

        const requestId = 'req_' + Date.now();
        console.log(`[Background] Pausing auto-pilot loop for user guidance on page (${requestId}):`, question, fields);

        // Highlight fields automatically on active tab
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab && activeTab.id) {
            highlightRequiredFieldsOnTab(activeTab.id, fields).catch(() => {});
          }
        } catch (e) {}

        forwardToPopup({
          type: 'askUserPrompt',
          requestId,
          title,
          question,
          fields,
          task
        });

        forwardToPopup({
          type: 'autopilotProgress',
          step: step + 1,
          maxSteps,
          status: 'clarification',
          message: `Awaiting required details: Fill on page and click Continue ➔`
        });

        // Wait for user to confirm on page (or dismiss)
        const userResponse = await waitForUserInput(requestId, 180000); // 3 minute timeout

        if (!userResponse || userResponse.cancelled) {
          steps.push({ step: step + 1, action, result: 'Guidance dismissed by user', stopped: 'cancelled' });
          forwardToPopup({ type: 'autopilotProgress', step: step + 1, maxSteps, status: 'paused', message: 'Guidance dismissed.' });
          break;
        }

        console.log('[Background] User confirmed required details were filled on page. Executing next step directly...');

        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const isLoginTaskOrPage = isLoginTask || /\b(login|log\s*in|sign\s*in|signin|auth|portal|credentials)\b/i.test(task || '');

        if (activeTab && activeTab.id && isLoginTaskOrPage) {
          forwardToPopup({
            type: 'autopilotProgress',
            step: step + 1,
            maxSteps,
            status: 'executing',
            message: 'Credentials filled. Directly clicking Sign in to log in...'
          });

          const loginClickRes = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            func: () => {
              // 1. Dispatch input and change on credentials fields to guarantee form validity
              const allInputs = Array.from(document.querySelectorAll('input, select, textarea'));
              for (const inp of allInputs) {
                if ((inp.value || '').trim().length > 0) {
                  inp.dispatchEvent(new Event('input', { bubbles: true }));
                  inp.dispatchEvent(new Event('change', { bubbles: true }));
                  inp.dispatchEvent(new Event('blur', { bubbles: true }));
                }
              }

              // 2. Locate sign in / submit button
              const passInp = document.querySelector('input[type="password"]');
              let loginBtn = null;
              if (passInp && passInp.form) {
                loginBtn = passInp.form.querySelector('#btnSubmit, #btnLogin, input[type="submit"], button[type="submit"], input[value*="Sign in" i], input[value*="Login" i], button');
              }
              if (!loginBtn) {
                loginBtn = document.querySelector('#btnSubmit, #btnLogin, input[type="submit"], button[type="submit"], input[value*="Sign in" i], input[value*="Login" i]');
              }
              if (!loginBtn) {
                const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, a[role="button"]'));
                loginBtn = buttons.find(b => {
                  if (b.getAttribute('data-toggle') === 'tab' || b.getAttribute('role') === 'tab') return false;
                  const text = (b.textContent || b.value || '').toLowerCase().replace(/\s+/g, ' ').trim();
                  return text === 'sign in' || text === 'login' || text === 'log in' ||
                         text.includes('sign in') || text.includes('login') || text.includes('log in');
                });
              }

              if (loginBtn) {
                loginBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                loginBtn.focus();
                const rect = loginBtn.getBoundingClientRect();
                const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
                loginBtn.dispatchEvent(new MouseEvent('mouseover', opts));
                loginBtn.dispatchEvent(new MouseEvent('mousedown', opts));
                loginBtn.dispatchEvent(new MouseEvent('mouseup', opts));
                loginBtn.dispatchEvent(new MouseEvent('click', opts));
                if (typeof loginBtn.click === 'function') {
                  loginBtn.click();
                }

                // If button is in a form, trigger requestSubmit or form submit
                if (loginBtn.form) {
                  try {
                    if (typeof loginBtn.form.requestSubmit === 'function') {
                      loginBtn.form.requestSubmit(loginBtn);
                    } else if (typeof loginBtn.form.submit === 'function') {
                      loginBtn.form.submit();
                    }
                  } catch (e) {}
                }

                return {
                  success: true,
                  text: (loginBtn.textContent || loginBtn.value || '').trim().slice(0, 50),
                  targetId: loginBtn.id || loginBtn.name || 'btnSubmit'
                };
              }
              return { success: false };
            }
          });

          const clickedLogin = loginClickRes && loginClickRes[0]?.result?.success;
          const targetId = loginClickRes && loginClickRes[0]?.result?.targetId || 'btnSubmit';

          const turn = {
            id: 'turn_' + Date.now(),
            task: task || 'Login with entered credentials',
            timestamp: Date.now(),
            reasoning: 'Credentials entered on page. Directly clicked Sign in button to log in.',
            action: { type: 'click', targetElementId: targetId, value: null, scrollDirection: null },
            actions: [{ type: 'click', targetElementId: targetId, value: null, scrollDirection: null }],
            outcome: 'clicked_successfully',
            confidence: 0.99,
            needsClarification: false
          };

          try {
            const histData = await chrome.storage.local.get(['privamon_chat_history']);
            const history = histData.privamon_chat_history || [];
            history.push(turn);
            await chrome.storage.local.set({ privamon_chat_history: history.slice(-30) });
          } catch (e) {}

          steps.push({
            step: step + 1,
            action: { type: 'click', targetElementId: targetId },
            outcome: 'clicked_successfully',
            result: 'Clicked Sign in directly on page'
          });

          forwardToPopup({ type: 'pipelineComplete', result: { turn } });
          forwardToPopup({
            type: 'autopilotProgress',
            step: step + 1,
            maxSteps,
            status: 'done',
            message: clickedLogin ? '✓ Directly clicked Sign in to log in!' : 'Credentials entered on page. Click Sign in to log in.'
          });
          break;
        }

        if (activeTab && activeTab.id && isTravelBookingTask) {
          forwardToPopup({
            type: 'autopilotProgress',
            step: step + 1,
            maxSteps,
            status: 'executing',
            message: 'Journey details filled. Directly clicking Search Trains on page...'
          });

          const searchClickRes = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            func: () => {
              let searchBtn = document.querySelector('button.search_btn, button.train_Search, button[label="Find Trains"], button[label*="Search" i]');
              if (!searchBtn) searchBtn = document.querySelector('form button[type="submit"], form input[type="submit"]');
              if (!searchBtn) {
                const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn, a.search_btn'));
                searchBtn = buttons.find(b => {
                  const text = (b.textContent || b.value || '').toLowerCase().replace(/\s+/g, ' ').trim();
                  const cls = String(b.className || '').toLowerCase();
                  return text.includes('search train') || text.includes('find train') ||
                         text.includes('search') || cls.includes('search_btn') || cls.includes('train_Search');
                });
              }
              if (searchBtn) {
                searchBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                searchBtn.focus();
                searchBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                searchBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                searchBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                if (typeof searchBtn.click === 'function') searchBtn.click();
                return { success: true, targetId: searchBtn.id || searchBtn.className || 'search_btn' };
              }
              return { success: false };
            }
          });

          const clickedSearch = searchClickRes && searchClickRes[0]?.result?.success;
          const targetId = searchClickRes && searchClickRes[0]?.result?.targetId || 'search_btn';

          const turn = {
            id: 'turn_' + Date.now(),
            task: task || 'Search trains with entered details',
            timestamp: Date.now(),
            reasoning: 'Station and date entered on page. Directly clicked Search Trains button.',
            action: { type: 'click', targetElementId: targetId, value: null, scrollDirection: null },
            actions: [{ type: 'click', targetElementId: targetId, value: null, scrollDirection: null }],
            outcome: 'clicked_successfully',
            confidence: 0.99,
            needsClarification: false
          };

          try {
            const histData = await chrome.storage.local.get(['privamon_chat_history']);
            const history = histData.privamon_chat_history || [];
            history.push(turn);
            await chrome.storage.local.set({ privamon_chat_history: history.slice(-30) });
          } catch (e) {}

          steps.push({
            step: step + 1,
            action: { type: 'click', targetElementId: targetId },
            outcome: 'clicked_successfully',
            result: 'Clicked Search Trains directly on page'
          });

          forwardToPopup({ type: 'pipelineComplete', result: { turn } });
          forwardToPopup({
            type: 'autopilotProgress',
            step: step + 1,
            maxSteps,
            status: 'done',
            message: clickedSearch ? '✓ Directly clicked Search Trains with entered station details!' : 'Details registered. Click Search Trains on the page.'
          });
          break;
        }

        forwardToPopup({
          type: 'autopilotProgress',
          step: step + 1,
          maxSteps,
          status: 'executing',
          message: 'Details filled on page. Re-inspecting page to proceed with next step...'
        });

        steps.push({
          step: step + 1,
          action: { type: 'wait', value: 'User filled details on page' },
          message: 'User filled required details directly on page.'
        });

        // Settle page and continue the loop!
        await new Promise(r => setTimeout(r, 600));
        continue;
      }

      if (typeof confidence === 'number' && confidence < 0.45) {
        steps.push({ step: step + 1, action, confidence, result: 'Low confidence', stopped: 'low_confidence' });
        forwardToPopup({ type: 'autopilotProgress', step: step + 1, maxSteps, status: 'paused', message: `Paused: low confidence (${Math.round(confidence * 100)}%)` });
        break;
      }

      // Strip leaked step guidance or verification text from action values before execution
      if (action.value && typeof action.value === 'string') {
        const cleanedValue = action.value.replace(/\[(?:STEP GUIDANCE|VERIFY TASK COMPLETION)[^\]]*\]/gi, '').trim();
        if (cleanedValue !== action.value) {
          console.log(`[Background] Stripped leaked guidance text from action value. Original length: ${action.value.length}, cleaned: ${cleanedValue.length}`);
          action.value = cleanedValue;
        }
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


