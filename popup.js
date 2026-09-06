/**
 * Privamon Popup — UI Controller
 *
 * Handles user interaction, sends analysis requests to the background
 * service worker, and displays pipeline progress + results.
 */

const PIPELINE_STAGES = [
  { id: 'capture',    name: 'Screenshot Capture' },
  { id: 'dom',        name: 'DOM Extraction' },
  { id: 'domPii',     name: 'DOM PII Detection' },
  { id: 'pixelId',    name: 'Pixel Region Identification' },
  { id: 'ocr',        name: 'OCR Processing' },
  { id: 'vision',     name: 'Vision Analysis' },
  { id: 'fusion',     name: 'PII Fusion' },
  { id: 'coordMap',   name: 'Coordinate Mapping' },
  { id: 'redaction',  name: 'Redaction' },
  { id: 'verify',     name: 'Verification' },
  { id: 'sanitizeDom', name: 'DOM Sanitization' },
];

// ── DOM References ──
const taskInput     = document.getElementById('taskInput');
const analyzeBtn    = document.getElementById('analyzeBtn');
const taskSection   = document.getElementById('taskSection');
const statusSection = document.getElementById('statusSection');
const statusText    = document.getElementById('statusText');
const pipelineEl    = document.getElementById('pipelineStages');
const resultsSection = document.getElementById('resultsSection');
const detectionsList = document.getElementById('detectionsList');
const timingSummary = document.getElementById('timingSummary');
const viewResultsBtn = document.getElementById('viewResultsBtn');
const errorSection  = document.getElementById('errorSection');
const errorText     = document.getElementById('errorText');
const retryBtn      = document.getElementById('retryBtn');
const spinner       = document.getElementById('spinner');

// ── State ──
let isProcessing = false;

// ── Initialize ──
document.addEventListener('DOMContentLoaded', () => {
  buildPipelineUI();
  analyzeBtn.addEventListener('click', startAnalysis);
  viewResultsBtn.addEventListener('click', openResults);
  retryBtn.addEventListener('click', resetToInput);
  taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startAnalysis();
  });
});

function buildPipelineUI() {
  pipelineEl.innerHTML = PIPELINE_STAGES.map(stage => `
    <div class="stage-row" id="stage-${stage.id}">
      <div class="stage-left">
        <div class="stage-indicator"></div>
        <span class="stage-name">${stage.name}</span>
      </div>
      <span class="stage-time" id="time-${stage.id}">—</span>
    </div>
  `).join('');
}

// ── Analysis Flow ──
async function startAnalysis() {
  if (isProcessing) return;
  isProcessing = true;

  const task = taskInput.value.trim() || 'Analyze current page';

  // Switch UI
  taskSection.classList.add('hidden');
  resultsSection.classList.add('hidden');
  errorSection.classList.add('hidden');
  statusSection.classList.remove('hidden');
  statusText.textContent = 'Starting pipeline...';
  spinner.style.display = '';

  // Reset stages
  buildPipelineUI();

  try {
    // Send to background service worker
    const response = await chrome.runtime.sendMessage({
      action: 'startAnalysis',
      task: task,
    });

    if (response && response.error) {
      throw new Error(response.error);
    }

    // The background will send progress updates via messages.
    // We listen for them below.
  } catch (err) {
    showError(err.message || 'Failed to start analysis');
  }
}

// ── Listen for progress updates from background ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'pipelineProgress') {
    updateStage(message.stageId, message.status, message.timeMs);
    statusText.textContent = message.statusText || 'Processing...';
  }

  if (message.type === 'pipelineComplete') {
    onPipelineComplete(message.result);
  }

  if (message.type === 'pipelineError') {
    showError(message.error);
  }
});

function updateStage(stageId, status, timeMs) {
  const row = document.getElementById(`stage-${stageId}`);
  const timeEl = document.getElementById(`time-${stageId}`);
  if (!row) return;

  row.classList.remove('active', 'done');

  if (status === 'active') {
    row.classList.add('active');
    timeEl.textContent = '...';
  } else if (status === 'done') {
    row.classList.add('done');
    timeEl.textContent = timeMs != null ? `${timeMs}ms` : '✓';
  } else if (status === 'skipped') {
    timeEl.textContent = 'skip';
  }
}

function onPipelineComplete(result) {
  isProcessing = false;
  spinner.style.display = 'none';
  statusText.textContent = 'Complete';

  // Show results section
  statusSection.classList.add('hidden');
  resultsSection.classList.remove('hidden');

  // Build detections list
  renderDetections(result.detectionSummary || {});

  // Build timing summary
  renderTimings(result.timings || {});
}

function renderDetections(summary) {
  const PII_CONFIG = {
    email:       { label: 'Emails',          severity: 'high' },
    phone:       { label: 'Phone Numbers',   severity: 'high' },
    password:    { label: 'Password Fields',  severity: 'high' },
    creditCard:  { label: 'Credit Cards',     severity: 'high' },
    aadhaar:     { label: 'Aadhaar Numbers',  severity: 'high' },
    pan:         { label: 'PAN Numbers',       severity: 'high' },
    face:        { label: 'Faces',             severity: 'medium' },
    name:        { label: 'Names',             severity: 'medium' },
    dob:         { label: 'Dates of Birth',    severity: 'medium' },
    ip:          { label: 'IP Addresses',      severity: 'low' },
    ocrPii:      { label: 'OCR-detected PII', severity: 'medium' },
    other:       { label: 'Other Sensitive',   severity: 'low' },
  };

  let html = '';
  let totalDetections = 0;

  for (const [type, count] of Object.entries(summary)) {
    if (count <= 0) continue;
    totalDetections += count;

    const config = PII_CONFIG[type] || { label: type, severity: 'low' };
    html += `
      <div class="detection-item">
        <div class="detection-label">
          <span class="detection-badge ${config.severity}">${config.severity}</span>
          <span>${config.label}</span>
        </div>
        <span class="detection-count">${count}</span>
      </div>
    `;
  }

  if (totalDetections === 0) {
    html = `
      <div class="detection-item">
        <div class="detection-label">
          <span class="detection-badge low">info</span>
          <span>No PII detected on this page</span>
        </div>
        <span class="detection-count">0</span>
      </div>
    `;
  }

  detectionsList.innerHTML = html;
}

function renderTimings(timings) {
  const lines = Object.entries(timings)
    .map(([key, ms]) => `${key.padEnd(20)} ${String(ms).padStart(6)}ms`)
    .join('\n');

  const total = Object.values(timings).reduce((a, b) => a + b, 0);
  timingSummary.textContent = lines + `\n${'TOTAL'.padEnd(20)} ${String(total).padStart(6)}ms`;
}

function showError(msg) {
  isProcessing = false;
  spinner.style.display = 'none';
  statusSection.classList.add('hidden');
  resultsSection.classList.add('hidden');
  errorSection.classList.remove('hidden');
  errorText.textContent = msg;
}

function resetToInput() {
  errorSection.classList.add('hidden');
  resultsSection.classList.add('hidden');
  statusSection.classList.add('hidden');
  taskSection.classList.remove('hidden');
  isProcessing = false;
  buildPipelineUI();
}

function openResults() {
  chrome.tabs.create({
    url: chrome.runtime.getURL('results.html')
  });
}
