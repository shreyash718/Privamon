/**
 * Privamon — PII Fusion Engine
 *
 * Merges detections from DOM, OCR, and Vision into a unified list.
 * Deduplicates overlapping bounding boxes using IoU (Intersection over Union).
 * Keeps the highest-confidence detection when duplicates are found.
 *
 * Output format (common representation):
 * {
 *   type: 'email',
 *   source: 'dom'|'ocr'|'vision',
 *   text: 'user@example.com',
 *   bbox: { x, y, width, height },
 *   confidence: 0.96,
 *   elementId: 'email-input' | null
 * }
 */
var Privamon = Privamon || {};

Privamon.PIIFusion = (() => {
  'use strict';

  // IoU threshold for considering two bboxes as overlapping
  const IOU_THRESHOLD = 0.4;

  // Minimum confidence to keep a detection
  const MIN_CONFIDENCE = 0.3;

  /**
   * Calculate Intersection over Union of two bounding boxes.
   */
  function calculateIoU(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);

    const intersectionWidth = Math.max(0, x2 - x1);
    const intersectionHeight = Math.max(0, y2 - y1);
    const intersectionArea = intersectionWidth * intersectionHeight;

    const areaA = a.width * a.height;
    const areaB = b.width * b.height;
    const unionArea = areaA + areaB - intersectionArea;

    if (unionArea === 0) return 0;
    return intersectionArea / unionArea;
  }

  /**
   * Check if bbox A contains bbox B (A is larger and fully encloses B).
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
   * Merge two bounding boxes into one that covers both.
   */
  function mergeBboxes(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return {
      x,
      y,
      width: right - x,
      height: bottom - y,
    };
  }

  /**
   * Fuse detections from multiple sources.
   *
   * @param {Array} domDetections - From PIIDetector.detectAllDom()
   * @param {Array} ocrDetections - From OCR pipeline
   * @param {Array} visionDetections - From Vision model
   * @returns {Object} { detections: Detection[], summary: { email: 2, phone: 1, ... } }
   */
  function fuse(domDetections = [], ocrDetections = [], visionDetections = []) {
    // Normalize all detections to common format
    const all = [
      ...domDetections.map(d => normalize(d, 'dom')),
      ...ocrDetections.map(d => normalize(d, 'ocr')),
      ...visionDetections.map(d => normalize(d, 'vision')),
    ];

    // Filter by minimum confidence
    const filtered = all.filter(d => d.confidence >= MIN_CONFIDENCE && d.bbox);

    // Sort by confidence descending (keep best first)
    filtered.sort((a, b) => b.confidence - a.confidence);

    // Deduplicate overlapping detections
    const merged = [];
    const used = new Set();

    for (let i = 0; i < filtered.length; i++) {
      if (used.has(i)) continue;

      let current = { ...filtered[i] };

      for (let j = i + 1; j < filtered.length; j++) {
        if (used.has(j)) continue;

        const other = filtered[j];
        const iou = calculateIoU(current.bbox, other.bbox);

        if (iou >= IOU_THRESHOLD || contains(current.bbox, other.bbox) || contains(other.bbox, current.bbox)) {
          // Same region: merge bboxes, keep higher confidence & more specific type
          used.add(j);

          // Prefer the more specific type
          if (current.type === 'other' && other.type !== 'other') {
            current.type = other.type;
          }

          // Merge bboxes to cover both areas
          current.bbox = mergeBboxes(current.bbox, other.bbox);

          // Keep max confidence
          current.confidence = Math.max(current.confidence, other.confidence);

          // Track merged sources
          if (!current.mergedSources) current.mergedSources = [current.source];
          current.mergedSources.push(other.source);
        }
      }

      merged.push(current);
    }

    // Build summary
    const summary = {};
    for (const d of merged) {
      summary[d.type] = (summary[d.type] || 0) + 1;
    }

    return { detections: merged, summary };
  }

  /**
   * Normalize a detection to the common format.
   */
  function normalize(detection, defaultSource) {
    return {
      type: detection.type || 'other',
      source: detection.source || defaultSource,
      text: detection.text || '',
      bbox: detection.bbox || null,
      confidence: detection.confidence || 0.5,
      elementId: detection.elementId || null,
      reason: detection.reason || null,
      coordinateSpace: detection.coordinateSpace || null,
    };
  }

  return { fuse, calculateIoU, mergeBboxes };
})();
