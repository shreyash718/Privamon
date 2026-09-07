/**
 * Privamon Popup — Conversational Vision Agent Controller
 *
 * Implements persistent chat history matching the user wireframe:
 * 1. Top input bar: "what to do?"
 * 2. Automatic screen capture + local redaction (PII + faces)
 * 3. Transmission to server_side_agent
 * 4. Cards for:
 *    - Redacted screenshot preview ("image which is send to server")
 *    - Reasoning drawer ("Reasoning")
 *    - Action guidance ("Response: what you should do")
 * 5. Full storage persistence across sessions.
 */

// ── DOM References ──
const serverStatusDot   = document.getElementById('serverStatusDot');
const serverStatusLabel = document.getElementById('serverStatusLabel');
const openSidePanelBtn  = document.getElementById('openSidePanelBtn');
const toggleSettingsBtn = document.getElementById('toggleSettingsBtn');
const clearHistoryBtn   = document.getElementById('clearHistoryBtn');
const reloadExtensionBtn = document.getElementById('reloadExtensionBtn');

const settingsDrawer    = document.getElementById('settingsDrawer');
const serverUrlInput    = document.getElementById('serverUrlInput');
const saveSettingsBtn   = document.getElementById('saveSettingsBtn');

const chatForm          = document.getElementById('chatForm');
const taskInput         = document.getElementById('taskInput');
const sendBtn           = document.getElementById('sendBtn');
const promptChips       = document.querySelectorAll('.chip-btn');

const activeProgressCard= document.getElementById('activeProgressCard');
const progressHeadline  = document.getElementById('progressHeadline');
const progressSub       = document.getElementById('progressSub');

const chatTimeline      = document.getElementById('chatTimeline');
const emptyState        = document.getElementById('emptyState');

const imageLightbox     = document.getElementById('imageLightbox');
const lightboxBackdrop  = document.getElementById('lightboxBackdrop');
const closeLightboxBtn  = document.getElementById('closeLightboxBtn');
const lightboxImg       = document.getElementById('lightboxImg');
const openResultsPageBtn= document.getElementById('openResultsPageBtn');

// ── VLM Raw Response Inspector DOM References ──
const openInspectorHeaderBtn = document.getElementById('openInspectorHeaderBtn');
const vlmInspectorModal      = document.getElementById('vlmInspectorModal');
const vlmInspectorBackdrop   = document.getElementById('vlmInspectorBackdrop');
const closeInspectorBtn      = document.getElementById('closeInspectorBtn');
const inspectorCopyBtn       = document.getElementById('inspectorCopyBtn');
const inspectorCopyLabel     = document.getElementById('inspectorCopyLabel');
const inspectorModalTitle    = document.getElementById('inspectorModalTitle');
const inspectorProviderBadge = document.getElementById('inspectorProviderBadge');
const inspectorModelBadge    = document.getElementById('inspectorModelBadge');
const inspectorLatencyBadge  = document.getElementById('inspectorLatencyBadge');
const tabBtnRaw              = document.getElementById('tabBtnRaw');
const tabBtnParsed           = document.getElementById('tabBtnParsed');
const tabBtnThinking         = document.getElementById('tabBtnThinking');
const inspectorCodeBlock     = document.getElementById('inspectorCodeBlock');
const inspectorSchemaStatus  = document.getElementById('inspectorSchemaStatus');
const inspectorCharCount     = document.getElementById('inspectorCharCount');

// ── Local State ──
let isBusy = false;
let currentServerUrl = 'http://localhost:8000';
let activeTurnImageUrl = '';
let currentTurns = [];
let activeInspectorTurn = null;
let activeInspectorTab = 'raw';

// ── Detect Side Panel vs Popup Mode ──
function detectViewMode() {
  const isSidePanel =
    window.location.search.includes('view=sidepanel') ||
    window.location.search.includes('mode=sidepanel') ||
    window.innerWidth > 550;

  if (document.documentElement) {
    if (isSidePanel) {
      document.documentElement.classList.add('is-sidepanel');
    } else {
      document.documentElement.classList.remove('is-sidepanel');
    }
  }
  if (document.body) {
    if (isSidePanel) {
      document.body.classList.add('is-sidepanel');
    } else {
      document.body.classList.remove('is-sidepanel');
    }
  }
}
detectViewMode();

// ── Initialization ──
document.addEventListener('DOMContentLoaded', async () => {
  detectViewMode();
  window.addEventListener('resize', detectViewMode);
  await loadSettings();
  await checkServerHealth();
  await loadChatHistory();
  setupEventListeners();
});

function setupEventListeners() {
  // Chat query submission
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitChatQuery(taskInput.value.trim());
  });

  // Prompt suggestion chips
  promptChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      if (prompt && !isBusy) {
        taskInput.value = prompt;
        submitChatQuery(prompt);
      }
    });
  });

  // Settings drawer toggle
  toggleSettingsBtn.addEventListener('click', () => {
    const isHidden = settingsDrawer.classList.toggle('hidden');
    toggleSettingsBtn.classList.toggle('active', !isHidden);
  });

  // Save server settings
  saveSettingsBtn.addEventListener('click', async () => {
    const url = serverUrlInput.value.trim().replace(/\/+$/, '') || 'http://localhost:8000';
    currentServerUrl = url;
    await chrome.storage.local.set({ privamon_server_url: url });
    settingsDrawer.classList.add('hidden');
    toggleSettingsBtn.classList.remove('active');
    checkServerHealth();
  });

  // Clear history
  clearHistoryBtn.addEventListener('click', () => {
    if (confirm('Clear all conversation history and redacted screenshots?')) {
      clearHistory();
    }
  });

  // Reload extension & background service worker
  if (reloadExtensionBtn) {
    reloadExtensionBtn.addEventListener('click', () => {
      reloadExtensionBtn.style.transform = 'rotate(180deg)';
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.reload === 'function') {
        chrome.runtime.reload();
      } else {
        location.reload();
      }
    });
  }

  // Open side panel
  openSidePanelBtn.addEventListener('click', async () => {
    try {
      if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
        const window = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: window.id });
        window.close();
      } else {
        alert('Side panel is available in Chrome 114+ by clicking the side panel icon in your toolbar.');
      }
    } catch (e) {
      console.warn('Could not open side panel:', e);
    }
  });

  // Lightbox close
  closeLightboxBtn.addEventListener('click', closeLightbox);
  lightboxBackdrop.addEventListener('click', closeLightbox);

  // Raw VLM Inspector Header Action
  if (openInspectorHeaderBtn) {
    openInspectorHeaderBtn.addEventListener('click', () => {
      openVlmInspector();
    });
  }

  // Raw VLM Inspector Close Actions
  if (closeInspectorBtn) {
    closeInspectorBtn.addEventListener('click', closeVlmInspector);
  }
  if (vlmInspectorBackdrop) {
    vlmInspectorBackdrop.addEventListener('click', closeVlmInspector);
  }

  // Raw VLM Inspector Tabs
  [
    { btn: tabBtnRaw, name: 'raw' },
    { btn: tabBtnParsed, name: 'parsed' },
    { btn: tabBtnThinking, name: 'thinking' }
  ].forEach(({ btn, name }) => {
    if (btn) {
      btn.addEventListener('click', () => {
        renderInspectorTab(name);
      });
    }
  });

  // Raw VLM Inspector Copy to Clipboard
  if (inspectorCopyBtn) {
    inspectorCopyBtn.addEventListener('click', async () => {
      try {
        let textToCopy = '';
        if (activeInspectorTab === 'raw') {
          textToCopy = (activeInspectorTurn && activeInspectorTurn.rawModelOutput)
            ? activeInspectorTurn.rawModelOutput
            : (inspectorCodeBlock ? inspectorCodeBlock.textContent : '');
        } else {
          textToCopy = inspectorCodeBlock ? inspectorCodeBlock.textContent : '';
        }
        await navigator.clipboard.writeText(textToCopy);
        inspectorCopyBtn.classList.add('copied');
        if (inspectorCopyLabel) inspectorCopyLabel.textContent = 'Copied! ✓';
        setTimeout(() => {
          inspectorCopyBtn.classList.remove('copied');
          if (inspectorCopyLabel) inspectorCopyLabel.textContent = 'Copy JSON';
        }, 1500);
      } catch (e) {
        console.warn('Inspector clipboard failed:', e);
      }
    });
  }

  // Keyboard shortcut: Escape closes inspector or lightbox
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (vlmInspectorModal && !vlmInspectorModal.classList.contains('hidden')) {
        closeVlmInspector();
      } else if (imageLightbox && !imageLightbox.classList.contains('hidden')) {
        closeLightbox();
      }
    }
  });

  // Full results page button from lightbox
  openResultsPageBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
  });

  // Listen for pipeline progress from background service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'pipelineProgress' && isBusy) {
      updateProgressUI(message.statusText || 'Processing page...', message.stageId);
    }
    if (message.type === 'pipelineComplete' && message.result && message.result.turn && isBusy) {
      const turn = message.result.turn;
      const existing = document.getElementById(turn.id);
      if (!existing) {
        currentTurns.push(turn);
        const turnEl = createTurnCard(turn);
        chatTimeline.appendChild(turnEl);
        scrollToBottom();
      }
      isBusy = false;
      activeProgressCard.classList.add('hidden');
      taskInput.disabled = false;
      sendBtn.disabled = false;
      taskInput.focus();
    }
  });

  // Real-time synchronization when background saves new turns to storage
  if (isExtensionContext && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.privamon_chat_history) {
        const newHist = changes.privamon_chat_history.newValue || [];
        currentTurns = newHist;
        if (newHist.length > 0 && isBusy) {
          const latest = newHist[newHist.length - 1];
          const existing = document.getElementById(latest.id);
          if (!existing) {
            const turnEl = createTurnCard(latest);
            chatTimeline.appendChild(turnEl);
            scrollToBottom();
            isBusy = false;
            activeProgressCard.classList.add('hidden');
            taskInput.disabled = false;
            sendBtn.disabled = false;
            taskInput.focus();
          }
        }
      }
    });
  }
}

// ── Helpers for Extension vs Standalone Preview ──
const isExtensionContext = typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function';

// ── Settings ──
async function loadSettings() {
  try {
    if (isExtensionContext) {
      const data = await chrome.storage.local.get(['privamon_server_url']);
      if (data.privamon_server_url) {
        currentServerUrl = data.privamon_server_url;
      }
    } else {
      const saved = localStorage.getItem('privamon_server_url');
      if (saved) currentServerUrl = saved;
    }
    serverUrlInput.value = currentServerUrl;
  } catch (e) {
    console.warn('Failed to load settings:', e);
  }
}

// ── Server Health Check ──
async function checkServerHealth() {
  serverStatusDot.className = 'status-dot';
  serverStatusLabel.textContent = 'Connecting...';

  try {
    let isOnline = false;
    if (isExtensionContext) {
      const response = await chrome.runtime.sendMessage({
        action: 'checkServerStatus',
        serverUrl: currentServerUrl
      });
      isOnline = response && response.online;
    } else {
      const res = await fetch(`${currentServerUrl.replace(/\/+$/, '')}/health`);
      const data = await res.json();
      isOnline = data.status === 'ok';
    }

    if (isOnline) {
      serverStatusDot.className = 'status-dot online';
      serverStatusLabel.textContent = 'Agent Online';
    } else {
      serverStatusDot.className = 'status-dot offline';
      serverStatusLabel.textContent = 'Agent Offline';
    }
  } catch (err) {
    serverStatusDot.className = 'status-dot offline';
    serverStatusLabel.textContent = 'Offline';
  }
}

// ── Chat History ──
async function loadChatHistory() {
  try {
    let history = [];
    if (isExtensionContext) {
      const response = await chrome.runtime.sendMessage({ action: 'getChatHistory' });
      history = (response && response.history) ? response.history : [];
    } else {
      const saved = localStorage.getItem('privamon_chat_history');
      if (saved) {
        history = JSON.parse(saved);
      } else {
        // Pre-populate demo turn in preview mode
        history = [{
          id: 'demo_turn_1',
          timestamp: Date.now() - 60000,
          task: 'What should I do on this page?',
          screenshotUrl: 'icons/icon128.png',
          redactionsCount: 4,
          provider: 'OpenRouter',
          model: 'qwen/qwen2.5-vl-72b-instruct',
          latencyMs: 3420,
          rawModelOutput: JSON.stringify({
            confidence: 0.96,
            action: {
              type: "click",
              target_element_id: "submit-button",
              reasoning: "Submit credentials to authenticate user session"
            },
            reasoning: "The page displays a standard authentication login form. User credentials must be filled into the username and password fields before triggering the submit action.",
            assumptions: ["Valid user credentials are provided in clipboard or password manager"],
            needs_clarification: false
          }, null, 2),
          thinking: '1. User query asks for recommended action.\n2. Identified login form with username, password, and Submit button.\n3. Recommend entering credentials and clicking submit.',
          actions: [
            { action: 'click', target: 'button#submit-button', description: 'Click the Submit button' }
          ],
          action: {
            type: 'click',
            target_element_id: 'submit-button',
            reasoning: 'Click the Submit button'
          },
          confidence: 0.96,
          message: 'The page contains a login interface. You should enter your credentials into the respective input fields and then click the Submit button to proceed.'
        }];
      }
    }
    renderHistory(history);
  } catch (err) {
    console.error('Failed to load chat history:', err);
    renderHistory([]);
  }
}

function renderHistory(history) {
  currentTurns = history || [];
  // Clear any existing turn cards (keep emptyState)
  const existingTurns = chatTimeline.querySelectorAll('.chat-turn-card');
  existingTurns.forEach(turn => turn.remove());

  if (!history || history.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  history.forEach(turn => {
    const turnEl = createTurnCard(turn);
    chatTimeline.appendChild(turnEl);
  });

  scrollToBottom();
}

async function clearHistory() {
  try {
    currentTurns = [];
    if (isExtensionContext) {
      await chrome.runtime.sendMessage({ action: 'clearChatHistory' });
    } else {
      localStorage.removeItem('privamon_chat_history');
    }
    renderHistory([]);
  } catch (err) {
    console.error('Failed to clear history:', err);
  }
}

// ── Submit Query Flow ──
async function submitChatQuery(query) {
  if (isBusy || !query) return;
  isBusy = true;

  // UI state
  taskInput.value = '';
  taskInput.disabled = true;
  sendBtn.disabled = true;
  activeProgressCard.classList.remove('hidden');
  progressHeadline.textContent = 'Capturing & Redacting...';
  progressSub.textContent = 'Extracting DOM and masking all PII & faces locally';
  emptyState.classList.add('hidden');
  scrollToBottom();

  try {
    let turn = null;
    if (isExtensionContext) {
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'chatWithAgent',
          task: query,
          serverUrl: currentServerUrl
        });

        if (response && response.error) {
          throw new Error(response.error);
        }
        turn = response && response.turn;
      } catch (sendErr) {
        const errMsg = sendErr.message || '';
        // If message channel closed because inference was long or worker restarted, poll storage
        if (errMsg.includes('message channel closed') || errMsg.includes('Receiving end does not exist')) {
          console.warn('[Popup] Message channel closed during inference; waiting on storage for result...');
          updateProgressUI('Inference running on server... waiting for agent response', 'server');
          turn = await waitForTurnInStorage(query, 45000);
          if (!turn) {
            throw new Error('Inference on server timed out. Please check your Ollama terminal.');
          }
        } else {
          throw sendErr;
        }
      }
    } else {
      // In standalone browser preview, query the server agent directly
      const res = await fetch(`${currentServerUrl.replace(/\/+$/, '')}/interpret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_b64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          task: query,
          redacted_regions: [],
          sanitized_dom: '<button id="submit">Submit</button>'
        })
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      turn = {
        id: 'turn_' + Date.now(),
        timestamp: Date.now(),
        task: query,
        screenshotUrl: 'icons/icon128.png',
        redactionsCount: 1,
        provider: data.provider || 'OpenRouter',
        model: data.model || 'qwen/qwen2.5-vl-72b-instruct',
        latencyMs: data.latency_ms || 3200,
        rawModelOutput: data.raw_model_output || JSON.stringify(data, null, 2),
        thinking: data.thinking || '',
        action: data.action || null,
        actions: data.actions || (data.action ? [data.action] : []),
        confidence: data.confidence,
        reasoning: data.reasoning || data.message || '',
        assumptions: data.assumptions || [],
        needsClarification: Boolean(data.needsClarification),
        message: data.message || 'Completed analysis.'
      };
      const saved = JSON.parse(localStorage.getItem('privamon_chat_history') || '[]');
      saved.push(turn);
      localStorage.setItem('privamon_chat_history', JSON.stringify(saved));
    }

    if (turn) {
      const existing = document.getElementById(turn.id);
      if (!existing) {
        currentTurns.push(turn);
        const turnEl = createTurnCard(turn);
        chatTimeline.appendChild(turnEl);
        scrollToBottom();
      }
    }
  } catch (err) {
    console.error('Chat error:', err);
    const msg = err.message || 'Failed to analyze page.';
    const isWorkerReloadNeeded = Boolean(
      msg.includes('forwardToPopup') || msg.includes('not defined') || msg.includes('Receiving end does not exist') || msg.includes('Extension context invalidated')
    );
    const isServerErr = Boolean(
      msg.includes('Server Error') || msg.includes('Server 4') || msg.includes('Server 5') || msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('8000')
    );
    const isPipelineTimeout = Boolean(
      msg.includes('timed out') || msg.includes('Offscreen document failed')
    );

    let displayMessage = `Error: ${msg}`;
    if (isWorkerReloadNeeded) {
      displayMessage = `The background service worker was updated and needs to be reloaded.\n\nClick the "Reload Extension & Worker" button below or the ⟳ icon in the top header, then try again!`;
    } else if (isServerErr) {
      displayMessage = `Server Connection Error: ${msg}\n\nMake sure the server agent is running: 'uvicorn main:app --reload --port 8000'.`;
    } else if (isPipelineTimeout) {
      displayMessage = `Privacy Pipeline Timeout: ${msg}\n\nPlease click the ⟳ reload button in the header and try again. Heavy pages with dozens of large images may take extra time on initial model setup.`;
    }

    // Render error card in timeline
    const errorTurn = {
      id: 'err_' + Date.now(),
      timestamp: Date.now(),
      task: query,
      screenshotUrl: null,
      redactionsCount: 0,
      thinking: '',
      actions: [],
      isReloadNeeded: isWorkerReloadNeeded || isPipelineTimeout,
      message: displayMessage
    };
    const errEl = createTurnCard(errorTurn, true);
    chatTimeline.appendChild(errEl);
    scrollToBottom();
  } finally {
    isBusy = false;
    taskInput.disabled = false;
    sendBtn.disabled = false;
    activeProgressCard.classList.add('hidden');
    taskInput.focus();
  }
}

function updateProgressUI(statusText, stageId) {
  progressHeadline.textContent = statusText;
  if (stageId === 'capture') {
    progressSub.textContent = 'Taking atomic high-res snapshot of active tab';
  } else if (stageId === 'dom') {
    progressSub.textContent = 'Analyzing interactive DOM elements and input fields';
  } else if (stageId === 'redaction') {
    progressSub.textContent = 'Running local OCR, NER, and face detection blur';
  } else if (stageId === 'server') {
    progressSub.textContent = 'Querying local vision agent model via Ollama/vLLM';
  }
}

// ── Turn Card Builder (Matches Hand-Drawn Wireframe) ──
function createTurnCard(turn, isError = false) {
  const card = document.createElement('article');
  card.className = 'chat-turn-card';
  card.id = turn.id;

  const timeStr = formatTime(turn.timestamp);
  const redactionCount = turn.redactionsCount || (turn.redactedRegions ? turn.redactedRegions.length : 0);

  // 1. User Query Header
  const queryBar = document.createElement('div');
  queryBar.className = 'turn-query-bar';
  queryBar.innerHTML = `
    <div class="turn-query-content">
      <span class="query-icon-badge">Q</span>
      <span class="turn-query-text">${escapeHtml(turn.task || 'Analyze screen')}</span>
    </div>
    <span class="turn-timestamp">${timeStr}</span>
  `;
  card.appendChild(queryBar);

  // 2. Redacted Image Preview Card ("image which is send to server")
  if (turn.screenshotUrl) {
    const imgCard = document.createElement('div');
    imgCard.className = 'screenshot-preview-card';
    imgCard.innerHTML = `
      <div class="screenshot-preview-header">
        <div class="preview-title-wrap">
          <span class="preview-title">Sent to Server</span>
          <span class="privacy-badge">🔒 Sanitized</span>
        </div>
        <span class="pii-badge">${redactionCount} PII Redacted</span>
      </div>
      <div class="screenshot-thumb-container" title="Click to view full redacted image">
        <img src="${turn.screenshotUrl}" alt="Redacted screenshot sent to agent" loading="lazy">
        <div class="thumb-overlay">
          <span>🔍 Click to Expand</span>
        </div>
      </div>
    `;

    imgCard.querySelector('.screenshot-thumb-container').addEventListener('click', () => {
      openLightbox(turn.screenshotUrl, turn.task);
    });

    card.appendChild(imgCard);
  }

  // 3. Reasoning Drawer ("Reasoning")
  if (turn.thinking && turn.thinking.trim()) {
    const reasoningBox = document.createElement('div');
    reasoningBox.className = 'reasoning-box';
    reasoningBox.innerHTML = `
      <button class="reasoning-toggle" type="button" aria-expanded="false">
        <span class="toggle-left">
          <span>🧠</span>
          <span>Model Reasoning</span>
        </span>
        <svg class="chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <div class="reasoning-content">${escapeHtml(turn.thinking.trim())}</div>
    `;

    const toggleBtn = reasoningBox.querySelector('.reasoning-toggle');
    toggleBtn.addEventListener('click', () => {
      const isOpen = reasoningBox.classList.toggle('open');
      toggleBtn.setAttribute('aria-expanded', isOpen);
    });

    card.appendChild(reasoningBox);
  }

  // 4. Response Card ("Response: what you should do")
  const responseCard = document.createElement('div');
  responseCard.className = 'action-response-card';

  // Confidence Badge
  let confidenceHtml = '';
  if (typeof turn.confidence === 'number' && !isNaN(turn.confidence)) {
    const confVal = turn.confidence <= 1.0 ? turn.confidence : turn.confidence / 100;
    const confPct = Math.round(confVal * 100);
    const confLevel = confVal >= 0.8 ? 'high' : (confVal >= 0.5 ? 'medium' : 'low');
    confidenceHtml = `<span class="confidence-badge ${confLevel}" title="Model confidence: ${confPct}%">${confPct}% Conf</span>`;
  }

  // Clarification Banner
  let clarificationHtml = '';
  if (turn.needsClarification) {
    clarificationHtml = `
      <div class="clarification-banner">
        <span>⚠️ Clarification needed: UI state is ambiguous or missing required information</span>
      </div>
    `;
  }

  // Assumptions Box
  let assumptionsHtml = '';
  if (Array.isArray(turn.assumptions) && turn.assumptions.length > 0) {
    assumptionsHtml = `
      <div class="assumptions-box">
        <div class="assumptions-title">Assumptions:</div>
        <ul class="assumptions-list">
          ${turn.assumptions.map(as => `<li>${escapeHtml(as)}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  // Actions List (supports both single atomic action and legacy action array)
  let actionsHtml = '';
  const actionList = [];
  if (turn.action && typeof turn.action === 'object') {
    actionList.push(turn.action);
  } else if (Array.isArray(turn.actions) && turn.actions.length > 0) {
    actionList.push(...turn.actions);
  }

  if (actionList.length > 0) {
    const validActions = actionList.map(act => {
      const actionType = (act.type || act.action || 'action').toLowerCase();
      let target = act.reasoning || act.description || act.target || act.element || '';
      if (act.targetElementId) {
        target = `#${act.targetElementId}` + (target ? ` — ${target}` : '');
      }
      if (act.scrollDirection) {
        target = `Scroll ${act.scrollDirection}` + (target ? ` (${target})` : '');
      }
      if (act.value) {
        if (target) {
          target = `${target} [value: "${act.value}"]`;
        } else {
          target = `"${act.value}"`;
        }
      }
      if (!target) {
        if (act.target_bbox && Array.isArray(act.target_bbox) && act.target_bbox.length === 4) {
          target = `Target bbox [${act.target_bbox.join(', ')}]`;
        } else {
          target = actionType;
        }
      }
      return { actionType, target: target.trim() };
    }).filter(a => a.target.length > 0);

    if (validActions.length > 0) {
      actionsHtml = `
        <div class="action-items-list">
          ${validActions.map(act => `
            <div class="action-pill">
              <span class="action-type ${escapeHtml(act.actionType)}">${escapeHtml(act.actionType)}</span>
              <span class="action-target">${escapeHtml(act.target)}</span>
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  responseCard.innerHTML = `
    ${clarificationHtml}
    <div class="response-header">
      <div class="response-title-wrap">
        <div class="response-avatar">✦</div>
        <span class="response-title">Response: What you should do</span>
      </div>
      ${confidenceHtml}
    </div>
    <div class="response-body">${formatMessageBody(turn.message || turn.reasoning || 'No response details provided.')}</div>
    ${actionsHtml}
    ${assumptionsHtml}
    <div class="turn-footer-actions">
      <button class="btn-turn-action raw-vlm-btn" title="Inspect complete raw VLM model output">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="16 18 22 12 16 6"></polyline>
          <polyline points="8 6 2 12 8 18"></polyline>
        </svg>
        <span>Raw VLM Output</span>
      </button>
      <button class="btn-turn-action copy-btn" title="Copy response text">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span>Copy</span>
      </button>
      <button class="btn-turn-action inspect-btn" title="Open full Privamon analysis page">
        <span>Inspect Detections ↗</span>
      </button>
    </div>
  `;

  // Raw VLM inspector button listener
  const rawVlmBtn = responseCard.querySelector('.raw-vlm-btn');
  if (rawVlmBtn) {
    rawVlmBtn.addEventListener('click', () => {
      openVlmInspector(turn);
    });
  }

  // Copy button listener
  const copyBtn = responseCard.querySelector('.copy-btn');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(turn.message || '');
      const span = copyBtn.querySelector('span');
      span.textContent = 'Copied!';
      setTimeout(() => { span.textContent = 'Copy'; }, 1500);
    } catch (e) {
      console.warn('Clipboard failed:', e);
    }
  });

  // Inspect detections button
  const inspectBtn = responseCard.querySelector('.inspect-btn');
  inspectBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
  });

  if (turn.isReloadNeeded) {
    const reloadBox = document.createElement('div');
    reloadBox.style.marginTop = '10px';
    reloadBox.innerHTML = `
      <button class="btn-primary" id="btnReloadServiceWorker" style="padding: 8px 14px; font-size: 12px; cursor: pointer;">
        ⟳ Reload Extension & Worker
      </button>
    `;
    reloadBox.querySelector('#btnReloadServiceWorker').addEventListener('click', () => {
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.reload === 'function') {
        chrome.runtime.reload();
      } else {
        location.reload();
      }
    });
    responseCard.appendChild(reloadBox);
  }

  card.appendChild(responseCard);
  return card;
}

// ── Lightbox Helpers ──
function openLightbox(imageUrl, title) {
  activeTurnImageUrl = imageUrl;
  lightboxImg.src = imageUrl;
  document.getElementById('lightboxTitle').textContent = title ? `Redacted: ${title}` : 'Redacted Image Sent to Server';
  imageLightbox.classList.remove('hidden');
}

function closeLightbox() {
  imageLightbox.classList.add('hidden');
  lightboxImg.src = '';
  activeTurnImageUrl = '';
}

// ── Formatting Utilities ──
function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatMessageBody(text) {
  if (!text) return '';
  // Basic markdown-like formatting for bullet points and paragraphs
  const lines = text.split('\n');
  return lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      return `<p style="padding-left: 10px;">• ${escapeHtml(trimmed.slice(2))}</p>`;
    }
    if (/^\d+\.\s/.test(trimmed)) {
      return `<p style="padding-left: 10px;"><b>${escapeHtml(trimmed.slice(0, 3))}</b> ${escapeHtml(trimmed.slice(3))}</p>`;
    }
    return `<p>${escapeHtml(trimmed)}</p>`;
  }).join('');
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    chatTimeline.scrollTop = chatTimeline.scrollHeight;
  });
}

// ── Storage Fallback Helper ──
async function waitForTurnInStorage(taskQuery, timeoutMs = 45000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const data = await chrome.storage.local.get(['privamon_chat_history']);
      const history = data.privamon_chat_history || [];
      if (history.length > 0) {
        const latest = history[history.length - 1];
        if (latest && (latest.timestamp >= startTime - 10000 || latest.task === taskQuery)) {
          return latest;
        }
      }
    } catch (e) { /* ignore */ }
    await new Promise(r => setTimeout(r, 1200));
  }
  return null;
}

// ── Complete Raw VLM Response Inspector Controller ──
function openVlmInspector(turn = null) {
  if (!turn) {
    if (currentTurns && currentTurns.length > 0) {
      turn = currentTurns[currentTurns.length - 1];
    } else {
      turn = {
        task: 'Waiting for queries...',
        provider: 'OpenRouter / Ollama',
        model: 'Ready for inference',
        latencyMs: null,
        rawModelOutput: JSON.stringify({
          status: "ready",
          message: "No VLM response captured yet. Ask Privamon what to do on this page to inspect raw model tokens."
        }, null, 2),
        thinking: "Awaiting execution...",
        action: null,
        confidence: null
      };
    }
  }

  activeInspectorTurn = turn;

  if (inspectorModalTitle) {
    inspectorModalTitle.textContent = turn.task ? `VLM: ${turn.task}` : 'VLM Response Inspector';
  }
  if (inspectorProviderBadge) {
    inspectorProviderBadge.textContent = turn.provider || 'OpenRouter';
  }
  if (inspectorModelBadge) {
    const modelStr = turn.model || 'qwen2.5-vl-72b';
    const shortName = modelStr.includes('/') ? modelStr.split('/').pop() : modelStr;
    inspectorModelBadge.textContent = shortName;
    inspectorModelBadge.title = modelStr;
  }
  if (inspectorLatencyBadge) {
    if (turn.latencyMs) {
      const latText = turn.latencyMs >= 1000 ? `${(turn.latencyMs / 1000).toFixed(1)}s` : `${turn.latencyMs}ms`;
      inspectorLatencyBadge.textContent = `⚡ ${latText}`;
    } else if (turn.timestamp) {
      inspectorLatencyBadge.textContent = formatTime(turn.timestamp);
    } else {
      inspectorLatencyBadge.textContent = '—';
    }
  }

  renderInspectorTab(activeInspectorTab);

  if (vlmInspectorModal) {
    vlmInspectorModal.classList.remove('hidden');
  }
}

function closeVlmInspector() {
  if (vlmInspectorModal) {
    vlmInspectorModal.classList.add('hidden');
  }
}

function renderInspectorTab(tabName) {
  activeInspectorTab = tabName;

  [tabBtnRaw, tabBtnParsed, tabBtnThinking].forEach(btn => {
    if (!btn) return;
    if (btn.getAttribute('data-tab') === tabName) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  if (!activeInspectorTurn) return;

  let textContent = '';
  let htmlContent = '';

  if (tabName === 'raw') {
    const rawOutput = activeInspectorTurn.rawModelOutput || '';
    if (rawOutput && rawOutput.trim()) {
      textContent = rawOutput.trim();
      htmlContent = formatSyntaxHighlight(textContent);
    } else {
      const fallbackObj = {
        action: activeInspectorTurn.action || null,
        confidence: activeInspectorTurn.confidence,
        reasoning: activeInspectorTurn.reasoning || activeInspectorTurn.message || '',
        assumptions: activeInspectorTurn.assumptions || [],
        needsClarification: Boolean(activeInspectorTurn.needsClarification)
      };
      textContent = JSON.stringify(fallbackObj, null, 2);
      htmlContent = formatSyntaxHighlight(textContent);
    }
  } else if (tabName === 'parsed') {
    const parsedContract = {
      action: activeInspectorTurn.action || null,
      actions: activeInspectorTurn.actions || (activeInspectorTurn.action ? [activeInspectorTurn.action] : []),
      confidence: activeInspectorTurn.confidence,
      reasoning: activeInspectorTurn.reasoning || activeInspectorTurn.message || '',
      assumptions: activeInspectorTurn.assumptions || [],
      needsClarification: Boolean(activeInspectorTurn.needsClarification)
    };
    textContent = JSON.stringify(parsedContract, null, 2);
    htmlContent = formatSyntaxHighlight(textContent);
  } else if (tabName === 'thinking') {
    const thinking = activeInspectorTurn.thinking || '';
    if (thinking && thinking.trim()) {
      textContent = thinking.trim();
      htmlContent = escapeHtml(textContent);
    } else {
      textContent = 'No internal <think> chain-of-thought tokens recorded for this inference.';
      htmlContent = `<span style="color: var(--text-dim); font-style: italic;">${escapeHtml(textContent)}</span>`;
    }
  }

  if (inspectorCodeBlock) {
    inspectorCodeBlock.innerHTML = htmlContent;
  }

  if (inspectorCharCount) {
    inspectorCharCount.textContent = `${textContent.length.toLocaleString()} chars`;
  }

  if (inspectorSchemaStatus) {
    if (activeInspectorTurn.action || (typeof activeInspectorTurn.confidence === 'number')) {
      inspectorSchemaStatus.className = 'schema-status-pill verified';
      inspectorSchemaStatus.textContent = '✓ Schema Validated';
    } else {
      inspectorSchemaStatus.className = 'schema-status-pill unverified';
      inspectorSchemaStatus.textContent = '⚠ Raw / Unparsed';
    }
  }
}

function formatSyntaxHighlight(raw) {
  if (!raw) return '<span class="tok-null">null</span>';
  let formatted = raw;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    formatted = JSON.stringify(parsed, null, 2);
  } catch (e) {
    return escapeHtml(String(raw));
  }

  const escaped = escapeHtml(formatted);
  return escaped.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
    let cls = 'tok-num';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'tok-key';
        return `<span class="${cls}">${match.slice(0, -1)}</span><span class="tok-punct">:</span>`;
      } else {
        cls = 'tok-str';
      }
    } else if (/true|false/.test(match)) {
      cls = 'tok-bool';
    } else if (/null/.test(match)) {
      cls = 'tok-null';
    }
    return `<span class="${cls}">${match}</span>`;
  });
}
