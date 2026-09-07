/**
 * Privamon — DOM Range & Coordinate Mapper
 *
 * Uses the browser's Range.getClientRects() API to obtain exact, character-level
 * viewport-relative CSS coordinates for DOM text nodes.
 *
 * Handles:
 * - Single text nodes
 * - Text split across nested inline elements (e.g. <span>Rahul</span> <strong>Sharma</strong>)
 * - Multi-rect wrapped text across line breaks (preserves distinct per-line rectangles)
 * - Word tokenization with stable DOM token IDs
 */
var Privamon = (typeof window !== 'undefined' && window.Privamon)
            || (typeof globalThis !== 'undefined' && globalThis.Privamon)
            || (typeof self !== 'undefined' && self.Privamon)
            || {};
if (typeof window !== 'undefined') window.Privamon = Privamon;
if (typeof globalThis !== 'undefined') globalThis.Privamon = Privamon;
if (typeof self !== 'undefined') self.Privamon = Privamon;

Privamon.DOMRangeMapper = (() => {
  'use strict';

  let domTokenCounter = 0;

  /**
   * Reset the token counter (useful for new document extraction runs).
   */
  function resetCounter() {
    domTokenCounter = 0;
  }

  /**
   * Computes the enclosing bounding box covering an array of boxes.
   */
  function computeUnionBox(boxes) {
    if (!boxes || boxes.length === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    const x1 = Math.min(...boxes.map(b => b.x));
    const y1 = Math.min(...boxes.map(b => b.y));
    const x2 = Math.max(...boxes.map(b => b.x + b.width));
    const y2 = Math.max(...boxes.map(b => b.y + b.height));
    return {
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1
    };
  }

  /**
   * Extracts text content and word-level layout tokens with Range.getClientRects()
   * from a DOM element and its descendants.
   *
   * @param {Element} rootElement - Container DOM element
   * @param {number} [offsetLeft=0] - Visual viewport offsetLeft
   * @param {number} [offsetTop=0] - Visual viewport offsetTop
   * @returns {{ text: string, tokens: Array<Object> }}
   */
  function extractTextAndTokens(rootElement, offsetLeft = 0, offsetTop = 0) {
    if (!rootElement) return { text: '', tokens: [] };

    // Find all visible text nodes inside rootElement
    const textNodes = [];
    const walker = document.createTreeWalker(
      rootElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.textContent || !node.textContent.trim()) {
            return NodeFilter.FILTER_SKIP;
          }
          const parent = node.parentElement;
          if (parent) {
            const style = window.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden') {
              return NodeFilter.FILTER_REJECT;
            }
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let currNode;
    while ((currNode = walker.nextNode())) {
      textNodes.push(currNode);
    }

    if (textNodes.length === 0) {
      return { text: '', tokens: [] };
    }

    let fullText = '';
    const tokens = [];
    const wordRegex = /\S+/g;

    for (const node of textNodes) {
      const nodeText = node.textContent;
      let match;
      wordRegex.lastIndex = 0;

      // If fullText has characters and doesn't end in space, add separator
      if (fullText.length > 0 && !/\s$/.test(fullText)) {
        fullText += ' ';
      }
      const nodeGlobalBase = fullText.length;

      while ((match = wordRegex.exec(nodeText)) !== null) {
        const word = match[0];
        const wordStartInNode = match.index;
        const wordEndInNode = wordStartInNode + word.length;

        const globalStart = nodeGlobalBase + wordStartInNode;
        const globalEnd = nodeGlobalBase + wordEndInNode;

        // Measure exact geometry using Range
        let boxes = [];
        let unionBox = null;

        try {
          const range = document.createRange();
          range.setStart(node, wordStartInNode);
          range.setEnd(node, wordEndInNode);

          const clientRects = range.getClientRects();
          for (let r = 0; r < clientRects.length; r++) {
            const rect = clientRects[r];
            if (rect.width > 0 && rect.height > 0) {
              boxes.push({
                x: Math.round(rect.left - offsetLeft),
                y: Math.round(rect.top - offsetTop),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              });
            }
          }

          if (boxes.length > 0) {
            unionBox = computeUnionBox(boxes);
          }
        } catch (e) {
          // Range creation fallback
        }

        // Fallback to parent element rect if Range measurement produced no boxes
        if (!unionBox || boxes.length === 0) {
          const parentRect = (node.parentElement || rootElement).getBoundingClientRect();
          unionBox = {
            x: Math.round(parentRect.left - offsetLeft),
            y: Math.round(parentRect.top - offsetTop),
            width: Math.round(parentRect.width),
            height: Math.round(parentRect.height)
          };
          boxes = [unionBox];
        }

        domTokenCounter++;
        const tokenId = `dom_${String(domTokenCounter).padStart(4, '0')}`;

        tokens.push({
          id: tokenId,
          text: word,
          start: globalStart,
          end: globalEnd,
          bbox: unionBox,
          boxes: boxes,
          nodeId: rootElement.id || rootElement.getAttribute('data-testid') || null
        });
      }

      fullText += nodeText;
    }

    return { text: fullText, tokens };
  }

  /**
   * Maps a character span [spanStart, spanEnd] back to exact DOM client rectangles.
   * Handles multi-line wrapping and partial token overlap.
   *
   * @param {number} spanStart
   * @param {number} spanEnd
   * @param {Array<Object>} tokens - Tokens from extractTextAndTokens
   * @returns {{ bbox: Object|null, boxes: Array<Object>, tokens: Array<string> }}
   */
  function mapSpanToDomBoxes(spanStart, spanEnd, tokens) {
    if (!tokens || tokens.length === 0) {
      return { bbox: null, boxes: [], tokens: [] };
    }

    const matchedTokens = tokens.filter(t => t.end > spanStart && t.start < spanEnd);
    if (matchedTokens.length === 0) {
      return { bbox: null, boxes: [], tokens: [] };
    }

    const allBoxes = [];
    const matchedTokenIds = [];

    for (const token of matchedTokens) {
      matchedTokenIds.push(token.id);

      // Check if span only partially overlaps the token
      const isFullOverlap = (spanStart <= token.start && spanEnd >= token.end);

      if (isFullOverlap || !token.boxes || token.boxes.length === 0) {
        allBoxes.push(...token.boxes);
      } else {
        // Partial overlap: calculate proportional horizontal sub-box
        const tokenLen = Math.max(1, token.text.length);
        const charWidth = token.bbox.width / tokenLen;

        const clampedStart = Math.max(token.start, spanStart);
        const clampedEnd = Math.min(token.end, spanEnd);

        const offsetChars = clampedStart - token.start;
        const spanChars = clampedEnd - clampedStart;

        const subX = token.bbox.x + Math.round(offsetChars * charWidth);
        const subW = Math.max(2, Math.round(spanChars * charWidth));

        allBoxes.push({
          x: subX,
          y: token.bbox.y,
          width: subW,
          height: token.bbox.height
        });
      }
    }

    // Group adjacent / same-line boxes if possible, or return distinct boxes
    const unionBox = computeUnionBox(allBoxes);

    return {
      bbox: unionBox,
      boxes: allBoxes.length > 0 ? allBoxes : (unionBox ? [unionBox] : []),
      tokens: matchedTokenIds
    };
  }

  return {
    resetCounter,
    extractTextAndTokens,
    mapSpanToDomBoxes,
    computeUnionBox
  };
})();

// Export for CommonJS / Node test environments if available
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Privamon.DOMRangeMapper;
}
