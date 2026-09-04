/**
 * Privamon — Coordinate Mapper
 *
 * Maps CSS viewport bounding boxes to screenshot pixel coordinates.
 *
 * ── KEY INSIGHT (CORRECTED) ──
 *
 * Both getBoundingClientRect() and captureVisibleTab() are VIEWPORT-RELATIVE.
 *
 *   getBoundingClientRect() → CSS px relative to viewport top-left (0,0)
 *   captureVisibleTab()     → captures exactly the visible viewport
 *
 * Therefore: NO scroll offset subtraction is needed.
 *
 * The only transformation needed is the CSS→physical pixel scale:
 *
 *   scaleX = screenshotWidth  / viewportCSSWidth
 *   scaleY = screenshotHeight / viewportCSSHeight
 *
 * This ratio naturally incorporates:
 *   - devicePixelRatio
 *   - browser zoom level
 *   - any DPI scaling
 *
 * We do NOT independently use devicePixelRatio or estimated zoom.
 * We derive the actual scale from the screenshot/viewport dimension ratio.
 * This is the most reliable approach because it reflects what actually happened,
 * rather than what we think should have happened based on browser APIs.
 *
 * ── VERIFICATION ──
 *
 * At 100% zoom, DPR=1:
 *   viewport = 1280×720 CSS px, screenshot = 1280×720 px → scale = 1.0
 *
 * At 100% zoom, DPR=2 (Retina):
 *   viewport = 1280×720 CSS px, screenshot = 2560×1440 px → scale = 2.0
 *
 * At 125% zoom, DPR=1:
 *   viewport = 1024×576 CSS px, screenshot = 1280×720 px → scale = 1.25
 *
 * At 150% zoom, DPR=1.5 (Windows scaling):
 *   viewport = ~853×480 CSS px, screenshot = 1280×720 px → scale = 1.5
 */
var Privamon = Privamon || {};

Privamon.CoordinateMapper = (() => {
  'use strict';

  /**
   * Create a mapper for a specific screenshot/viewport pair.
   *
   * @param {Object} viewportInfo - From dom-extractor
   *   { cssViewportWidth, cssViewportHeight, devicePixelRatio, scrollX, scrollY }
   * @param {Object} screenshotDims - Actual screenshot image dimensions
   *   { width, height }
   * @returns {Object} Mapper instance
   */
  function create(viewportInfo, screenshotDims) {
    // The actual scale factors — derived from real dimensions, not assumptions
    const scaleX = screenshotDims.width / viewportInfo.cssViewportWidth;
    const scaleY = screenshotDims.height / viewportInfo.cssViewportHeight;

    // Sanity check: scaleX and scaleY should be very close
    // (they can differ slightly due to browser chrome, but not by much)
    const scaleDiff = Math.abs(scaleX - scaleY);
    if (scaleDiff > 0.1) {
      console.warn(
        `[CoordinateMapper] Scale mismatch: scaleX=${scaleX.toFixed(3)}, scaleY=${scaleY.toFixed(3)}. ` +
        `This may indicate incorrect viewport or screenshot dimensions.`
      );
    }

    const info = {
      scaleX,
      scaleY,
      screenshotWidth: screenshotDims.width,
      screenshotHeight: screenshotDims.height,
      viewportCSSWidth: viewportInfo.cssViewportWidth,
      viewportCSSHeight: viewportInfo.cssViewportHeight,
      devicePixelRatio: viewportInfo.devicePixelRatio,
      estimatedZoom: viewportInfo.estimatedZoom,
    };

    return {
      info,
      mapBbox: (cssBbox) => mapBbox(cssBbox, scaleX, scaleY, screenshotDims),
      mapPoint: (x, y) => mapPoint(x, y, scaleX, scaleY),
      mapAll: (detections) => mapAllDetections(detections, scaleX, scaleY, screenshotDims),
    };
  }

  /**
   * Map a CSS viewport bbox to screenshot pixel coordinates.
   *
   * @param {Object} cssBbox - { x, y, width, height } in CSS viewport pixels
   * @param {number} scaleX
   * @param {number} scaleY
   * @param {Object} screenshotDims - { width, height }
   * @returns {Object} { x, y, width, height } in screenshot pixels
   */
  function mapBbox(cssBbox, scaleX, scaleY, screenshotDims) {
    // No scroll subtraction — both coordinate systems share the viewport origin
    let x = Math.round(cssBbox.x * scaleX);
    let y = Math.round(cssBbox.y * scaleY);
    let width = Math.round(cssBbox.width * scaleX);
    let height = Math.round(cssBbox.height * scaleY);

    // Clamp to screenshot bounds
    x = Math.max(0, Math.min(x, screenshotDims.width - 1));
    y = Math.max(0, Math.min(y, screenshotDims.height - 1));
    width = Math.min(width, screenshotDims.width - x);
    height = Math.min(height, screenshotDims.height - y);

    return { x, y, width, height };
  }

  /**
   * Map a single CSS viewport point to screenshot pixel coordinates.
   */
  function mapPoint(cssX, cssY, scaleX, scaleY) {
    return {
      x: Math.round(cssX * scaleX),
      y: Math.round(cssY * scaleY),
    };
  }

  /**
   * Map all detections' bounding boxes to screenshot coordinates.
   * Returns new detection objects (does not mutate originals).
   *
   * @param {Array} detections - Array of detections with .bbox in CSS pixels
   * @param {number} scaleX
   * @param {number} scaleY
   * @param {Object} screenshotDims
   * @returns {Array} Detections with .screenshotBbox added
   */
  function mapAllDetections(detections, scaleX, scaleY, screenshotDims) {
    return detections.map(d => {
      if (!d.bbox) return d;
      if (d.coordinateSpace === 'screenshot') {
        return {
          ...d,
          cssBbox: null, // Did not originate from CSS viewport
          bbox: { ...d.bbox }, // Keep exactly as is
        };
      }

      return {
        ...d,
        // Keep original CSS bbox for reference
        cssBbox: { ...d.bbox },
        // Add mapped screenshot bbox
        bbox: mapBbox(d.bbox, scaleX, scaleY, screenshotDims),
        coordinateSpace: 'screenshot'
      };
    });
  }

  return { create };
})();
