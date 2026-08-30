// domCapture.js
// Extracts structured info about interactive/visible DOM elements.
// This is the primary "screen state" source — cheap, exact, no ML needed.

let _selectorCounter = 0;

function getUniqueSelector(el) {
  if (el.id) return `#${el.id}`;
  el.setAttribute('data-pva-id', _selectorCounter);
  return `[data-pva-id="${_selectorCounter++}"]`;
}

export function captureDomElements() {
  const SELECTOR = 'input, button, a, textarea, select, img, video';
  const elements = [];

  document.querySelectorAll(SELECTOR).forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return; // skip hidden/collapsed

    elements.push({
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      autocomplete: el.autocomplete || null,
      text: el.innerText ? el.innerText.slice(0, 200) : null,
      value: el.value ?? null,
      placeholder: el.placeholder || null,
      src: el.src || null, // for <img>/<video> — needed for the vision pipeline
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      selector: getUniqueSelector(el),
    });
  });

  return elements;
}
