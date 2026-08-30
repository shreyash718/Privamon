// redact.js
// Draws an image onto an offscreen canvas and blacks out given regions.
// Returns a redacted data URL — THIS is what should ever leave the browser,
// never the original image source.

export async function redactImageRegions(imgEl, regions) {
  const canvas = document.createElement('canvas');
  canvas.width = imgEl.naturalWidth || imgEl.width;
  canvas.height = imgEl.naturalHeight || imgEl.height;
  const ctx = canvas.getContext('2d');

  ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#000000';
  for (const r of regions) {
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }

  return canvas.toDataURL('image/png');
}
