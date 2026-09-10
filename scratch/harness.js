
window.addEventListener('DOMContentLoaded', async () => {
  // Wait for canvas to draw
  await new Promise(r => setTimeout(r, 600));

  // Load all scripts into this window
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  try {
    await loadScript('/lib/tesseract/tesseract.min.js');
    await loadScript('/content/dom-range-mapper.js');
    await loadScript('/privacy/coordinate-mapper.js');
    await loadScript('/privacy/pii-detector.js');
    await loadScript('/privacy/pii-classifier.js');
    await loadScript('/privacy/ner-engine.js');
    await loadScript('/privacy/fusion.js');
    await loadScript('/privacy/redactor.js');
    await loadScript('/privacy/verifier.js');
    await loadScript('/privacy/image-resizer.js');
    await loadScript('/vision/vision-model.js');
    await loadScript('/vision/face-detector.js');
    await loadScript('/vision/ocr-engine.js');
    await loadScript('/pipeline/sanitize-pipeline.js');

    const mainEl = document.querySelector('main');
    console.log('[DEBUG] mainEl:', mainEl ? 'found' : 'not found', 'offsetParent:', mainEl ? mainEl.offsetParent : null, 'display:', mainEl ? window.getComputedStyle(mainEl).display : null);
    
    // Now window.__privamonExtractedDOM should exist if dom-extractor set it,
    // or let's run dom-extractor's IIFE
    // In dom-extractor.js, it returns a value or sets it.
    // Let's fetch dom-extractor.js code and eval it to get domData:
    const resp = await fetch('/content/dom-extractor.js');
    const code = await resp.text();
    const domData = eval(code);

    // Create screenshot canvas
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0f19';
    ctx.fillRect(0, 0, sw, sh);

    // Draw the canvases/images on page
    const cEn = document.getElementById('ocr-doc-en');
    const rEn = cEn.getBoundingClientRect();
    ctx.drawImage(cEn, rEn.left, rEn.top);

    const imgHi = document.getElementById('ocr-img-hi');
    const rHi = imgHi.getBoundingClientRect();
    ctx.drawImage(imgHi, rHi.left, rHi.top);

    const screenshotDataUrl = canvas.toDataURL('image/png');

    console.log('[DEBUG] domData:', domData.elements.length, 'elements,', domData.pixelRegions.length, 'pixel regions');
    console.log('[DEBUG] pixelRegions:', JSON.stringify(domData.pixelRegions));

    const result = await Privamon.SanitizePipeline.run({
      screenshot: screenshotDataUrl,
      domData: domData,
      onProgress: (stage, status, msg) => console.log(`[Stage ${stage}] ${msg}`)
    });

    const payload = {
      firstEl: domData.elements[0] ? { tag: domData.elements[0].tag, text: domData.elements[0].text } : null,
      elementsCount: domData.elements.length,
      pixelRegionsCount: domData.pixelRegions.length,
      detections: (result.detections || []).map(d => ({
        type: d.type, text: d.text, reason: d.reason, conf: d.confidence, decision: d.decision, bbox: d.bbox, sources: d.sources
      })),
      redactions: (result.redactions || []).map(r => ({
        type: r.type, text: r.text, reason: r.reason, conf: r.confidence, bbox: r.bbox, boxes: r.boxes
      }))
    };

    await fetch('http://localhost:8988/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error(err);
    await fetch('http://localhost:8988/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.stack || err.message })
    });
  }
});
