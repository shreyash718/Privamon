const assert = require('assert');

// Extract functions for testing
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

    // 4. Viewport spatial tie-breaker
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

  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, maxElements).map(({ _score, ...el }) => el);
}

// 1. Test Position Calculations
const vp = { cssViewportWidth: 1200, cssViewportHeight: 900 };
assert.strictEqual(computeCoarsePosition({ x: 50, y: 50, width: 100, height: 40 }, vp), 'top-left');
assert.strictEqual(computeCoarsePosition({ x: 1000, y: 50, width: 100, height: 40 }, vp), 'top-right');
assert.strictEqual(computeCoarsePosition({ x: 500, y: 400, width: 100, height: 40 }, vp), 'mid-center');
assert.strictEqual(computeCoarsePosition({ x: 1000, y: 800, width: 100, height: 40 }, vp), 'bottom-right');
console.log('[TEST POSITIONS] Passed!');

// 2. Test Ranking & Pruning
const rawElements = [
  { tag: 'p', text: 'Privacy policy and terms of service', bbox: { x: 50, y: 850, width: 500, height: 20 } },
  { tag: 'div', text: 'Some random banner', bbox: { x: 50, y: 200, width: 500, height: 50 } },
  { tag: 'button', label: 'Submit Login', text: 'Sign In', bbox: { x: 1000, y: 100, width: 100, height: 40 } },
  { tag: 'input', inputType: 'password', placeholder: 'Enter password', bbox: { x: 500, y: 150, width: 200, height: 35 } },
  { tag: 'button', label: 'Cancel', text: 'Cancel', bbox: { x: 900, y: 100, width: 80, height: 40 } },
];

const ranked = rankDomElements(rawElements, 'Click on Submit Login button', vp, 3);
console.log('[TEST RANKING RESULTS]');
ranked.forEach(r => console.log(`- ${r.tag} (${r.label || r.text}) pos=${r.pos}`));

assert.strictEqual(ranked.length, 3, 'Expected 3 elements after pruning');
assert.strictEqual(ranked[0].tag, 'button');
assert.strictEqual(ranked[0].label, 'Submit Login');
assert.strictEqual(ranked[0].pos, 'top-right');
console.log('[TEST RANKING & PRUNING] Passed!');

console.log('\nALL JS DOM RANKING TESTS PASSED SUCCESSFULLY!');
