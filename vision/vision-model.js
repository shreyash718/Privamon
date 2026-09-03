/**
 * Privamon — Vision Model Interface
 *
 * Abstract interface for pluggable local vision models.
 * Vision models handle cases where OCR/DOM text extraction is insufficient:
 *   - Face detection (implemented via BlazeFace)
 *   - Identity document detection (future)
 *   - Handwritten text recognition (future)
 *   - Sensitive visual content classification (future)
 *
 * Each model implements this interface and registers itself.
 *
 * ── HONEST SCOPE (Correction #4) ──
 *
 * Currently, only face detection is implemented (BlazeFace).
 * This is NOT a general screen-understanding model. It detects faces,
 * and that's it. The interface is designed so that additional specialized
 * detectors (document classifier, handwriting recognizer, etc.) can be
 * added independently without rewriting the pipeline.
 */
var Privamon = Privamon || {};

Privamon.VisionModel = (() => {
  'use strict';

  /**
   * Registry of vision model implementations.
   * Each entry: { name, description, capabilities[], detect(imageData, region) }
   */
  const registry = [];

  /**
   * Register a vision model.
   *
   * @param {Object} model
   * @param {string} model.name - Unique name (e.g., 'blazeface')
   * @param {string} model.description - What this model does
   * @param {string[]} model.capabilities - What it can detect (e.g., ['face'])
   * @param {Function} model.initialize - async () => void
   * @param {Function} model.detect - async (regionDataUrl, bbox) => Detection[]
   * @param {Function} model.dispose - async () => void
   * @param {Function} [model.shouldProcess] - (region) => boolean — selectivity filter
   */
  function register(model) {
    if (!model || !model.name || typeof model.detect !== 'function') {
      console.warn('[VisionModel] Invalid model registration:', model);
      return;
    }
    registry.push(model);
    console.log(`[VisionModel] Registered: ${model.name} — ${model.description}`);
  }

  /**
   * Get all registered models.
   */
  function getModels() {
    return [...registry];
  }

  /**
   * Run all registered vision models on a set of image regions.
   *
   * @param {string} screenshotDataUrl - Full screenshot
   * @param {Array} pixelRegions - Regions to process (pre-filtered by selectivity)
   * @param {Object} mapper - CoordinateMapper instance
   * @returns {Promise<Array>} All vision detections
   */
  async function processRegions(screenshotDataUrl, pixelRegions, mapper) {
    if (registry.length === 0) {
      console.log('[VisionModel] No models registered — skipping vision processing');
      return [];
    }

    const allDetections = [];

    for (const model of registry) {
      try {
        // Initialize model if needed
        if (typeof model.initialize === 'function') {
          await model.initialize();
        }

        for (const region of pixelRegions) {
          // Check model-specific selectivity
          if (typeof model.shouldProcess === 'function' && !model.shouldProcess(region)) {
            continue;
          }

          // Map region bbox to screenshot coordinates
          const screenshotBbox = mapper.mapBbox(region.bbox);
          if (screenshotBbox.width < 10 || screenshotBbox.height < 10) continue;

          // Extract region
          const regionDataUrl = await Privamon.Redactor.extractRegion(
            screenshotDataUrl,
            screenshotBbox
          );

          // Run detection
          const detections = await model.detect(regionDataUrl, screenshotBbox);
          if (Array.isArray(detections)) {
            allDetections.push(...detections);
          }
        }
      } catch (err) {
        console.error(`[VisionModel] Model '${model.name}' failed:`, err);
      }
    }

    return allDetections;
  }

  /**
   * Dispose all registered models.
   */
  async function disposeAll() {
    for (const model of registry) {
      if (typeof model.dispose === 'function') {
        try { await model.dispose(); } catch (e) { /* ignore */ }
      }
    }
  }

  return { register, getModels, processRegions, disposeAll };
})();
