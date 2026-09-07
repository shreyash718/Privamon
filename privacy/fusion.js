/**
 * Privamon — Multi-Modal PII Fusion Engine
 *
 * Merges detections from DOM, OCR, Vision, and NER into a unified screenshot-space list.
 *
 * Implements:
 *   - Spatial grid indexing to accelerate box comparisons on busy pages
 *   - Mathematical IoU overlap computation & containment clustering
 *   - Modal agreement confidence boosting (cross-source corroboration raises confidence)
 *   - Explicit decision classification using named thresholds:
 *       REDACT >= 0.8 (or checksum valid)
 *       REVIEW 0.4 to 0.8
 *       KEEP < 0.4
 */
var Privamon = (typeof window !== 'undefined' && window.Privamon)
            || (typeof globalThis !== 'undefined' && globalThis.Privamon)
            || (typeof self !== 'undefined' && self.Privamon)
            || {};
if (typeof window !== 'undefined') window.Privamon = Privamon;
if (typeof globalThis !== 'undefined') globalThis.Privamon = Privamon;
if (typeof self !== 'undefined') self.Privamon = Privamon;

Privamon.PIIFusion = (() => {
  'use strict';

  // ── Named Threshold Constants ──
  const IOU_THRESHOLD = 0.40;
  const CONFIDENCE_REDACT_THRESHOLD = 0.70;
  const CONFIDENCE_REVIEW_THRESHOLD = 0.40;
  const MULTI_MODAL_AGREEMENT_BOOST = 0.15; // Raised confidence when multiple independent modalities agree
  const SPATIAL_CELL_SIZE = 120;             // Grid cell size in physical pixels for spatial bucketing

  /**
   * Calculate Intersection over Union of two bounding boxes.
   */
  function iou(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);

    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = (a.width * a.height) + (b.width * b.height) - inter;
    return union > 0 ? inter / union : 0;
  }

  /**
   * Checks if outer box completely encloses inner box.
   */
  function contains(outer, inner) {
    return (
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width &&
      inner.y + inner.height <= outer.y + outer.height
    );
  }

  /**
   * Computes the bounding box covering both boxes.
   */
  function unionBox(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return {
      x,
      y,
      width: right - x,
      height: bottom - y
    };
  }

  /**
   * Fuses candidate detections across all modalities.
   * Assumes all candidate bboxes are already in physical screenshot coordinates.
   *
   * @param {Array<Object>} candidates - Array of DetectionCandidate objects
   * @returns {Object} { detections, redactions, reviews, kept, summary }
   */
  function fuse(candidates = []) {
    if (!candidates || candidates.length === 0) {
      return {
        detections: [],
        redactions: [],
        reviews: [],
        kept: [],
        summary: { total: 0, byType: {}, bySource: {} }
      };
    }

    // Filter valid bboxes
    const valid = candidates.filter(c => c && c.bbox && c.bbox.width > 0 && c.bbox.height > 0);

    // Sort candidates by confidence descending
    valid.sort((a, b) => b.confidence - a.confidence);

    const merged = [];
    const used = new Set();

    // Fast spatial indexing for larger candidate counts
    const useSpatialGrid = valid.length > 30;
    const grid = new Map();

    if (useSpatialGrid) {
      for (let i = 0; i < valid.length; i++) {
        const box = valid[i].bbox;
        const minCellX = Math.floor(box.x / SPATIAL_CELL_SIZE);
        const maxCellX = Math.floor((box.x + box.width) / SPATIAL_CELL_SIZE);
        const minCellY = Math.floor(box.y / SPATIAL_CELL_SIZE);
        const maxCellY = Math.floor((box.y + box.height) / SPATIAL_CELL_SIZE);

        for (let cx = minCellX; cx <= maxCellX; cx++) {
          for (let cy = minCellY; cy <= maxCellY; cy++) {
            const key = `${cx}:${cy}`;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push(i);
          }
        }
      }
    }

    for (let i = 0; i < valid.length; i++) {
      if (used.has(i)) continue;

      let current = {
        ...valid[i],
        sources: valid[i].sources ? [...valid[i].sources] : [valid[i].source || 'dom'],
        tokens: valid[i].tokens ? [...valid[i].tokens] : [],
        boxes: valid[i].boxes ? [...valid[i].boxes] : [valid[i].bbox]
      };

      // Determine candidate indices to check
      let neighborIndices;
      if (useSpatialGrid) {
        const box = current.bbox;
        const minCellX = Math.floor(box.x / SPATIAL_CELL_SIZE);
        const maxCellX = Math.floor((box.x + box.width) / SPATIAL_CELL_SIZE);
        const minCellY = Math.floor(box.y / SPATIAL_CELL_SIZE);
        const maxCellY = Math.floor((box.y + box.height) / SPATIAL_CELL_SIZE);

        const neighbors = new Set();
        for (let cx = minCellX; cx <= maxCellX; cx++) {
          for (let cy = minCellY; cy <= maxCellY; cy++) {
            const cellList = grid.get(`${cx}:${cy}`);
            if (cellList) {
              for (const idx of cellList) {
                if (idx > i && !used.has(idx)) neighbors.add(idx);
              }
            }
          }
        }
        neighborIndices = Array.from(neighbors).sort((a, b) => a - b);
      } else {
        neighborIndices = [];
        for (let j = i + 1; j < valid.length; j++) {
          if (!used.has(j)) neighborIndices.push(j);
        }
      }

      for (const j of neighborIndices) {
        if (used.has(j)) continue;
        const other = valid[j];

        // Faces must only merge with faces
        const isFaceCurrent = (current.type === 'face');
        const isFaceOther = (other.type === 'face');
        if (isFaceCurrent !== isFaceOther) continue;

        const overlapIoU = iou(current.bbox, other.bbox);
        const areaCurrent = current.bbox.width * current.bbox.height;
        const areaOther = other.bbox.width * other.bbox.height;
        const minArea = Math.min(areaCurrent, areaOther);
        const maxArea = Math.max(areaCurrent, areaOther);
        const areaRatio = maxArea > 0 ? minArea / maxArea : 0;

        // Merging on containment is only valid if candidates have comparable size (areaRatio >= 0.5)
        const isContained = (contains(current.bbox, other.bbox) || contains(other.bbox, current.bbox)) && (areaRatio >= 0.5);

        if (overlapIoU > IOU_THRESHOLD || isContained) {
          used.add(j);

          // Merge bounding box geometry
          current.bbox = unionBox(current.bbox, other.bbox);

          // Combine sub-boxes
          if (other.boxes && other.boxes.length > 0) {
            current.boxes = [...current.boxes, ...other.boxes];
          }

          // Combine token IDs without duplicates
          if (other.tokens && other.tokens.length > 0) {
            for (const t of other.tokens) {
              if (!current.tokens.includes(t)) current.tokens.push(t);
            }
          }

          // Merge sources array
          const otherSources = other.sources || [other.source || 'dom'];
          for (const s of otherSources) {
            if (!current.sources.includes(s)) {
              current.sources.push(s);
            }
          }

          // Agreement across distinct modalities raises confidence
          if (current.sources.length > 1) {
            current.confidence = Math.min(1.0, Math.max(current.confidence, other.confidence) + MULTI_MODAL_AGREEMENT_BOOST);
          } else {
            current.confidence = Math.max(current.confidence, other.confidence);
          }

          // Label arbitration: prefer more specific type and text
          if (other.confidence > current.confidence - 0.05 && other.text && !current.text) {
            current.text = other.text;
          }
          if (current.type === 'other' && other.type !== 'other') {
            current.type = other.type;
          }
        }
      }

      // Assign decision based on named confidence thresholds & checksums
      // Faces detected by the vision model are high-risk biometric identifiers and must be REDACTED
      let decision = 'KEEP';
      if (current.checksumValidated || current.type === 'face' || current.confidence >= CONFIDENCE_REDACT_THRESHOLD) {
        decision = 'REDACT';
      } else if (current.confidence >= CONFIDENCE_REVIEW_THRESHOLD) {
        decision = 'REVIEW';
      } else {
        decision = 'KEEP';
      }

      // Hard Sanity Check: Text PII (name, phone, email, credentials, tokens) can NEVER be a giant container.
      // If a non-face detection has an abnormally large area, it is an over-redacted container false positive.
      // EXCEPTION: Form field anchors (reason starts with 'form_field_anchor:') are intentionally large boxes
      // designed to cover handwritten PII on paper invoices/receipts. These MUST bypass this check.
      const candArea = (current.bbox ? current.bbox.width * current.bbox.height : 0);
      const isFormFieldAnchor = current.reason && (current.reason.startsWith('form_field_anchor:') || current.reason.startsWith('ocr_regex:'));
      const isGiantContainer = current.type !== 'face' && !isFormFieldAnchor && (
        (current.bbox && (current.bbox.width > 550 && current.bbox.height > 120)) ||
        candArea > 45000
      );

      if (isGiantContainer) {
        decision = 'KEEP';
      }

      // Expand signature bounding box upward to securely mask handwritten signature ink above label
      if (current.type === 'signature' && current.bbox && decision === 'REDACT') {
        const extraTop = Math.min(current.bbox.y, 45);
        current.bbox.y -= extraTop;
        current.bbox.height += extraTop + 10;
        current.bbox.width += 25;
        if (current.boxes && current.boxes.length > 0) {
          current.boxes = current.boxes.map(b => ({
            x: b.x,
            y: Math.max(0, b.y - extraTop),
            width: b.width + 25,
            height: b.height + extraTop + 10
          }));
        }
      }

      current.decision = decision;
      merged.push(current);
    }

    // Partition by decision
    const redactions = [];
    const reviews = [];
    const kept = [];
    const summary = {
      total: merged.length,
      byType: {},
      bySource: {}
    };

    for (const c of merged) {
      summary.byType[c.type] = (summary.byType[c.type] || 0) + 1;
      const primarySource = c.sources && c.sources.length > 0 ? c.sources[0] : (c.source || 'dom');
      summary.bySource[primarySource] = (summary.bySource[primarySource] || 0) + 1;

      if (c.decision === 'REDACT') {
        redactions.push(c);
      } else if (c.decision === 'REVIEW') {
        reviews.push(c);
      } else {
        kept.push(c);
      }
    }

    return {
      detections: merged,
      redactions,
      reviews,
      kept,
      summary
    };
  }

  return {
    fuse,
    iou,
    contains,
    unionBox,
    CONFIDENCE_REDACT_THRESHOLD,
    CONFIDENCE_REVIEW_THRESHOLD
  };
})();
Privamon.Fusion = Privamon.PIIFusion;
