// results.js — reads the last stored capture and renders it as a readable report.

chrome.storage.local.get('privamon_last_capture', (r) => {
  const data = r.privamon_last_capture;
  if (!data) {
    document.body.innerHTML = '<h1>Privamon</h1><p class="empty">No capture stored yet.</p>';
    return;
  }

  document.getElementById('meta').innerHTML = `
    <strong>URL:</strong> ${escapeHtml(data.url)}<br>
    <strong>Captured:</strong> ${new Date(data.timestamp).toLocaleString()}<br>
    <strong>Action requested:</strong> ${escapeHtml(data.userAction || '(none)')}
  `;

  if (data.redactedScreenshot) {
    document.getElementById('screenshotWrap').innerHTML =
      `<img id="screenshot" src="${data.redactedScreenshot}">`;
  }

  const elBody = document.querySelector('#elementsTable tbody');
  for (const el of data.elements || []) {
    const flagged = (el.piiDetected && el.piiDetected.length > 0);
    elBody.innerHTML += `
      <tr>
        <td>${escapeHtml(el.tag)}</td>
        <td>${escapeHtml(el.type || '')}</td>
        <td class="${flagged ? 'redacted' : ''}">${escapeHtml(el.value ?? '')}</td>
        <td class="${flagged ? 'redacted' : ''}">${escapeHtml(el.text ?? '')}</td>
        <td>${escapeHtml((el.piiDetected || []).join(', '))}</td>
      </tr>`;
  }

  const imgBody = document.querySelector('#imagesTable tbody');
  for (const img of data.imageFindings || []) {
    imgBody.innerHTML += `
      <tr>
        <td>${escapeHtml(img.selector)}</td>
        <td>${img.facesDetected}</td>
        <td>${img.ocrTextFound ? 'yes' : 'no'}</td>
      </tr>`;
  }

  const regBody = document.querySelector('#regionsTable tbody');
  for (const r2 of data.redactionRegions || []) {
    regBody.innerHTML += `
      <tr>
        <td>${Math.round(r2.x)}</td>
        <td>${Math.round(r2.y)}</td>
        <td>${Math.round(r2.w)}</td>
        <td>${Math.round(r2.h)}</td>
        <td>${escapeHtml(r2.reason || '')}</td>
      </tr>`;
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}