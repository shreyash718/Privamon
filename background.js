// background.js
// Minimal service worker. Extended later to relay sanitized payloads to the server.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Privamon] Extension installed.');
});
