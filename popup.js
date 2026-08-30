// popup.js
// Runs in the extension popup context. No npm imports here — plain JS,
// loaded as an external file (never inline) to satisfy MV3's CSP.

const actionInput = document.getElementById('actionInput');
const captureBtn = document.getElementById('captureBtn');
const statusEl = document.getElementById('status');

captureBtn.addEventListener('click', async () => {
  const action = actionInput.value.trim();
  if (!action) {
    statusEl.textContent = 'Please describe what you want done first.';
    return;
  }

  statusEl.textContent = 'Capturing and sanitizing...';
  captureBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'PRIVAMON_CAPTURE',
      action,
    });

    if (response && response.ok) {
      statusEl.textContent =
        `Captured ${response.elementCount} elements, ` +
        `${response.imageCount} images processed.\n` +
        `Stored locally — ready to send to server.`;
    } else {
      statusEl.textContent = 'Something went wrong: ' + (response?.error || 'unknown error');
    }
  } catch (err) {
    statusEl.textContent =
      'Could not reach the page. Try refreshing the tab, then retry.\n(' + err.message + ')';
  } finally {
    captureBtn.disabled = false;
  }
});
