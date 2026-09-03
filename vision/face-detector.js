/**
 * Privamon — Face Detector (BlazeFace via ONNX Runtime Web)
 *
 * ── HONEST SCOPE (Correction #4) ──
 *
 * This model does ONE thing: detect human faces in images.
 * It does NOT understand screen content, read text, classify documents,
 * or perform any general visual analysis.
 *
 * It is one specialized detector registered into the VisionModel registry.
 * Other detectors (document classifier, ID card detector, etc.) would be
 * separate implementations registered alongside this one.
 *
 * ── SELECTIVE PROCESSING (Correction #3) ──
 *
 * Face detection is only run on image regions that plausibly contain
 * photographs (not icons, logos, or decorative graphics). We use
 * size and aspect ratio heuristics + the shouldProcess filter.
 *
 * ── GRACEFUL DEGRADATION ──
 *
 * If the BlazeFace ONNX model file is not present or ONNX Runtime fails
 * to load, this module logs a warning and returns empty results.
 * The rest of the pipeline works perfectly without it.
 */
var Privamon = Privamon || {};

Privamon.FaceDetector = (() => {
  'use strict';

  let session = null;
  let initialized = false;
  let available = false;

  // BlazeFace input size
  const INPUT_SIZE = 128;

  // Confidence threshold for face detection
  const FACE_CONFIDENCE_THRESHOLD = 0.65;

  // Minimum region size (CSS px) to consider for face detection
  const MIN_FACE_REGION_SIZE = 60;

  /**
   * Check if a pixel region should be processed for face detection.
   * Only images large enough to plausibly contain a face.
   */
  function shouldProcess(region) {
    // Only process IMG and CANVAS
    if (region.tag !== 'IMG' && region.tag !== 'CANVAS') return false;

    // Must be large enough
    if (region.bbox.width < MIN_FACE_REGION_SIZE || region.bbox.height < MIN_FACE_REGION_SIZE) {
      return false;
    }

    // Skip very wide/narrow images (banners, dividers)
    const aspectRatio = region.bbox.width / region.bbox.height;
    if (aspectRatio > 5 || aspectRatio < 0.2) return false;

    return true;
  }

  /**
   * Initialize the ONNX inference session.
   */
  async function initialize() {
    if (initialized) return;
    initialized = true;

    try {
      if (typeof ort === 'undefined') {
        console.warn('[FaceDetector] ONNX Runtime not loaded — face detection unavailable');
        return;
      }

      const modelPath = chrome.runtime.getURL('lib/onnx/blazeface.onnx');

      // Try to load the model
      const response = await fetch(modelPath);
      if (!response.ok) {
        console.warn('[FaceDetector] BlazeFace model not found — face detection unavailable');
        return;
      }

      const modelBuffer = await response.arrayBuffer();

      // Prefer WebGPU, fall back to WASM
      const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
      const providers = hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'];

      session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: providers,
        graphOptimizationLevel: 'all',
      });

      available = true;
      console.log(`[FaceDetector] Initialized with provider: ${providers[0]}`);
    } catch (err) {
      console.warn('[FaceDetector] Initialization failed (face detection will be unavailable):', err.message);
      session = null;
      available = false;
    }
  }

  /**
   * Detect faces in an image region.
   *
   * @param {string} regionDataUrl - Image region as data URL
   * @param {Object} regionBbox - The bbox in screenshot coordinates
   * @returns {Promise<Array>} Face detections: [{ type: 'face', bbox, confidence, source: 'vision' }]
   */
  async function detect(regionDataUrl, regionBbox) {
    if (!available || !session) return [];

    try {
      // Load image and resize to model input
      const imageData = await prepareInput(regionDataUrl);
      if (!imageData) return [];

      // Create input tensor
      const inputTensor = new ort.Tensor('float32', imageData.data, [1, 3, INPUT_SIZE, INPUT_SIZE]);

      // Run inference
      const feeds = {};
      const inputName = session.inputNames[0];
      feeds[inputName] = inputTensor;

      const results = await session.run(feeds);

      // Parse output (BlazeFace outputs vary by export — this handles common formats)
      return parseDetections(results, regionBbox);
    } catch (err) {
      console.error('[FaceDetector] Detection failed:', err);
      return [];
    }
  }

  /**
   * Prepare image data for model input.
   * Resizes to INPUT_SIZE × INPUT_SIZE, normalizes to [0,1], CHW format.
   */
  async function prepareInput(dataUrl) {
    const img = await Privamon.Redactor.loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = INPUT_SIZE;
    canvas.height = INPUT_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, INPUT_SIZE, INPUT_SIZE);

    const imgData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
    const { data } = imgData;

    // Convert to CHW float32 normalized to [0, 1]
    const float32Data = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
    for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
      float32Data[i] = data[i * 4] / 255.0;                        // R
      float32Data[INPUT_SIZE * INPUT_SIZE + i] = data[i * 4 + 1] / 255.0;  // G
      float32Data[2 * INPUT_SIZE * INPUT_SIZE + i] = data[i * 4 + 2] / 255.0; // B
    }

    return { data: float32Data, width: img.width, height: img.height };
  }

  /**
   * Parse ONNX model output into face detections.
   * This is a best-effort parser for common BlazeFace output formats.
   */
  function parseDetections(results, regionBbox) {
    const detections = [];

    try {
      // Try to find the relevant output tensors
      const outputNames = Object.keys(results);

      // Common output patterns:
      // 1. 'boxes' + 'scores'
      // 2. 'detectionsOutput'
      // 3. Single output with [N, 17] shape (6 box coords + landmarks + score)

      let scores, boxes;

      for (const name of outputNames) {
        const tensor = results[name];
        const data = tensor.data;

        if (name.toLowerCase().includes('score') || name.toLowerCase().includes('confidence')) {
          scores = data;
        } else if (name.toLowerCase().includes('box') || name.toLowerCase().includes('detection') || name.toLowerCase().includes('coord')) {
          boxes = data;
        }
      }

      // If we found both scores and boxes
      if (scores && boxes) {
        const numDetections = scores.length;
        for (let i = 0; i < numDetections; i++) {
          if (scores[i] > FACE_CONFIDENCE_THRESHOLD) {
            const x = boxes[i * 4] * regionBbox.width + regionBbox.x;
            const y = boxes[i * 4 + 1] * regionBbox.height + regionBbox.y;
            const w = (boxes[i * 4 + 2] - boxes[i * 4]) * regionBbox.width;
            const h = (boxes[i * 4 + 3] - boxes[i * 4 + 1]) * regionBbox.height;

            detections.push({
              type: 'face',
              source: 'vision',
              text: '[face detected]',
              confidence: scores[i],
              bbox: {
                x: Math.round(x),
                y: Math.round(y),
                width: Math.round(Math.abs(w)),
                height: Math.round(Math.abs(h)),
              },
            });
          }
        }
      }

      // Fallback: single output tensor (common BlazeFace export)
      if (detections.length === 0 && outputNames.length >= 1) {
        const output = results[outputNames[0]];
        const data = output.data;
        const shape = output.dims;

        // [1, N, 17] format: [ymin, xmin, ymax, xmax, ...landmarks, score]
        if (shape.length === 3 && shape[2] >= 5) {
          const numBoxes = shape[1];
          const stride = shape[2];
          for (let i = 0; i < numBoxes; i++) {
            const offset = i * stride;
            const score = data[offset + stride - 1]; // Last element is typically score
            if (score > FACE_CONFIDENCE_THRESHOLD) {
              const ymin = data[offset] * regionBbox.height + regionBbox.y;
              const xmin = data[offset + 1] * regionBbox.width + regionBbox.x;
              const ymax = data[offset + 2] * regionBbox.height + regionBbox.y;
              const xmax = data[offset + 3] * regionBbox.width + regionBbox.x;

              detections.push({
                type: 'face',
                source: 'vision',
                text: '[face detected]',
                confidence: score,
                bbox: {
                  x: Math.round(xmin),
                  y: Math.round(ymin),
                  width: Math.round(xmax - xmin),
                  height: Math.round(ymax - ymin),
                },
              });
            }
          }
        }
      }
    } catch (err) {
      console.error('[FaceDetector] Output parsing failed:', err);
    }

    return detections;
  }

  /**
   * Clean up the ONNX session.
   */
  async function dispose() {
    if (session) {
      session.release();
      session = null;
      available = false;
      initialized = false;
    }
  }

  // ── Register with the VisionModel registry ──
  // This runs when the script loads in the offscreen document.
  if (typeof Privamon.VisionModel !== 'undefined') {
    Privamon.VisionModel.register({
      name: 'blazeface',
      description: 'Face detection only (BlazeFace). Does NOT do general visual understanding.',
      capabilities: ['face'],
      initialize,
      detect,
      dispose,
      shouldProcess,
    });
  }

  return { initialize, detect, dispose, shouldProcess };
})();
