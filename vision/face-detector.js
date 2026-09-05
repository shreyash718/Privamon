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

  // UltraFace RFB 320 input dimensions
  const INPUT_WIDTH = 320;
  const INPUT_HEIGHT = 240;

  // Confidence threshold for face detection
  const FACE_CONFIDENCE_THRESHOLD = 0.50;

  // IoU threshold for Non-Maximum Suppression (NMS)
  const NMS_IOU_THRESHOLD = 0.3;

  // Minimum region size (CSS px) to consider for face detection
  const MIN_FACE_REGION_SIZE = 30;

  const LOCAL_FACE_URL = 'http://127.0.0.1:8765/detect/face';
  const ENGINE_TIMEOUT_MS = 6000;

  /**
   * Check if a pixel region should be processed for face detection.
   * Only images large enough to plausibly contain a face.
   */
  function shouldProcess(region) {
    if (!region || !region.bbox) return false;

    // Must be large enough (min 30px)
    if (region.bbox.width < MIN_FACE_REGION_SIZE || region.bbox.height < MIN_FACE_REGION_SIZE) {
      return false;
    }

    // Skip extreme banners or hair-thin dividers
    const aspectRatio = region.bbox.width / (region.bbox.height || 1);
    if (aspectRatio > 8.0 || aspectRatio < 0.12) return false;

    return true;
  }

  /**
   * Initialize the ONNX inference session.
   */
  async function initialize() {
    if (initialized && session) return;
    initialized = true;

    try {
      if (typeof ort === 'undefined') {
        console.warn('[FaceDetector] ONNX Runtime not loaded — face detection unavailable');
        return;
      }

      // Configure WASM paths
      if (ort.env && ort.env.wasm) {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
          ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/onnx/');
        } else {
          ort.env.wasm.wasmPaths = 'lib/onnx/';
        }
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
      }

      let modelPath;
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        modelPath = chrome.runtime.getURL('lib/onnx/blazeface.onnx');
      } else {
        modelPath = 'lib/onnx/blazeface.onnx';
      }

      const response = await fetch(modelPath);
      if (!response.ok) {
        console.warn('[FaceDetector] Face detection model file not found at:', modelPath);
        return;
      }

      const modelBuffer = await response.arrayBuffer();

      session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });

      available = true;
      console.log(`[FaceDetector] Initialized face detection model (WASM). Inputs:`, session.inputNames);
    } catch (err) {
      console.warn('[FaceDetector] Client-side initialization failed (will use local engine):', err.message);
      session = null;
      available = false;
    }
  }

  /**
   * Detect faces in an image region.
   *
   * @param {string} regionDataUrl - Image region as data URL
   * @param {Object} regionBbox - The bbox in screenshot coordinates { x, y, width, height }
   * @returns {Promise<Array>} Face detections: [{ type: 'face', bbox, confidence, source: 'vision' }]
   */
  async function detect(regionDataUrl, regionBbox) {
    if (!regionDataUrl || !regionBbox) return [];

    // 1. Primary: High-speed local Privamon PII Engine (native C++ ONNX, ~15ms)
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ENGINE_TIMEOUT_MS);

      console.log(`[FaceDetector] Querying local engine at ${LOCAL_FACE_URL} for region ${regionBbox.width}×${regionBbox.height}...`);
      const response = await fetch(LOCAL_FACE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: regionDataUrl,
          bbox: regionBbox,
          threshold: FACE_CONFIDENCE_THRESHOLD,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.faces)) {
          console.log(`[FaceDetector] Local engine returned ${data.faces.length} face(s) in ${data.processing_ms}ms`);
          return data.faces;
        }
      } else {
        console.warn(`[FaceDetector] Local engine HTTP error ${response.status}: ${response.statusText}`);
      }
    } catch (engineErr) {
      console.log('[FaceDetector] Local engine face detection unavailable, falling back to client-side ONNX:', engineErr.message);
    }

    // 2. Fallback: Client-side ONNX Runtime Web
    if (!available || !session) {
      await initialize();
      if (!available || !session) return [];
    }

    try {
      // Load image and resize to model input (320 × 240)
      const inputData = await prepareInput(regionDataUrl);
      if (!inputData) return [];

      // Create input tensor [1, 3, 240, 320]
      const inputTensor = new ort.Tensor('float32', inputData.data, [1, 3, INPUT_HEIGHT, INPUT_WIDTH]);

      // Run inference
      const feeds = {};
      const inputName = session.inputNames[0] || 'input';
      feeds[inputName] = inputTensor;

      const results = await session.run(feeds);

      // Parse outputs and map coordinates to regionBbox
      return parseDetections(results, regionBbox);
    } catch (err) {
      console.error('[FaceDetector] Detection failed:', err);
      return [];
    }
  }

  /**
   * Prepare image data for model input.
   * Resizes to INPUT_WIDTH (320) × INPUT_HEIGHT (240), normalizes (pixel - 127.0) / 128.0, NCHW layout.
   */
  async function prepareInput(dataUrl) {
    let img;
    if (Privamon.Redactor && typeof Privamon.Redactor.loadImage === 'function') {
      img = await Privamon.Redactor.loadImage(dataUrl);
    } else {
      img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = dataUrl;
      });
    }

    const canvas = document.createElement('canvas');
    canvas.width = INPUT_WIDTH;
    canvas.height = INPUT_HEIGHT;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, INPUT_WIDTH, INPUT_HEIGHT);

    const imgData = ctx.getImageData(0, 0, INPUT_WIDTH, INPUT_HEIGHT);
    const { data } = imgData;

    // Convert RGBA HWC to RGB NCHW float32 normalized: (v - 127.0) / 128.0
    const planeSize = INPUT_HEIGHT * INPUT_WIDTH;
    const float32Data = new Float32Array(3 * planeSize);

    for (let i = 0; i < planeSize; i++) {
      float32Data[i] = (data[i * 4 + 0] - 127.0) / 128.0;               // R
      float32Data[planeSize + i] = (data[i * 4 + 1] - 127.0) / 128.0;   // G
      float32Data[2 * planeSize + i] = (data[i * 4 + 2] - 127.0) / 128.0;// B
    }

    return { data: float32Data, width: img.width, height: img.height };
  }

  /**
   * Calculate Intersection over Union of two bounding boxes.
   */
  function calculateIoU(boxA, boxB) {
    const xA = Math.max(boxA.x, boxB.x);
    const yA = Math.max(boxA.y, boxB.y);
    const xB = Math.min(boxA.x + boxA.width, boxB.x + boxB.width);
    const yB = Math.min(boxA.y + boxA.height, boxB.y + boxB.height);

    const interW = Math.max(0, xB - xA);
    const interH = Math.max(0, yB - yA);
    const interArea = interW * interH;

    const areaA = boxA.width * boxA.height;
    const areaB = boxB.width * boxB.height;
    const unionArea = areaA + areaB - interArea;

    if (unionArea <= 0) return 0;
    return interArea / unionArea;
  }

  /**
   * Parse model outputs into face detections with Non-Maximum Suppression.
   */
  function parseDetections(results, regionBbox) {
    const candidates = [];

    try {
      // Find scores and boxes tensors
      let scoresData = null;
      let boxesData = null;

      for (const name of Object.keys(results)) {
        const tensor = results[name];
        const lowerName = name.toLowerCase();
        if (lowerName.includes('score') || lowerName.includes('conf')) {
          scoresData = tensor.data;
        } else if (lowerName.includes('box') || lowerName.includes('loc')) {
          boxesData = tensor.data;
        }
      }

      if (!scoresData || !boxesData) {
        console.warn('[FaceDetector] Could not locate scores or boxes tensors:', Object.keys(results));
        return [];
      }

      // Each detection has 2 scores [background, face] and 4 box coords [xmin, ymin, xmax, ymax]
      const numDetections = Math.floor(scoresData.length / 2);

      for (let i = 0; i < numDetections; i++) {
        const faceScore = scoresData[i * 2 + 1];
        if (faceScore >= FACE_CONFIDENCE_THRESHOLD) {
          const xmin = Math.max(0.0, Math.min(1.0, boxesData[i * 4 + 0]));
          const ymin = Math.max(0.0, Math.min(1.0, boxesData[i * 4 + 1]));
          const xmax = Math.max(0.0, Math.min(1.0, boxesData[i * 4 + 2]));
          const ymax = Math.max(0.0, Math.min(1.0, boxesData[i * 4 + 3]));

          if (xmax <= xmin || ymax <= ymin) continue;

          // Map to screenshot pixel space
          const rx = Math.round(regionBbox.x + xmin * regionBbox.width);
          const ry = Math.round(regionBbox.y + ymin * regionBbox.height);
          const rw = Math.round((xmax - xmin) * regionBbox.width);
          const rh = Math.round((ymax - ymin) * regionBbox.height);

          if (rw < 5 || rh < 5) continue;

          candidates.push({
            type: 'face',
            source: 'vision',
            text: '[face detected]',
            confidence: faceScore,
            bbox: {
              x: rx,
              y: ry,
              width: rw,
              height: rh,
            },
            boxes: [{
              x: rx,
              y: ry,
              width: rw,
              height: rh,
            }],
          });
        }
      }

      // Sort descending by confidence
      candidates.sort((a, b) => b.confidence - a.confidence);

      // Non-Maximum Suppression (NMS)
      const kept = [];
      for (const cand of candidates) {
        let suppressed = false;
        for (const existing of kept) {
          if (calculateIoU(cand.bbox, existing.bbox) > NMS_IOU_THRESHOLD) {
            suppressed = true;
            break;
          }
        }
        if (!suppressed) {
          kept.push(cand);
        }
      }

      console.log(`[FaceDetector] Detected ${kept.length} face(s) in region ${regionBbox.width}×${regionBbox.height}`);
      return kept;
    } catch (err) {
      console.error('[FaceDetector] Output parsing failed:', err);
      return [];
    }
  }

  /**
   * Clean up the ONNX session.
   */
  async function dispose() {
    if (session) {
      try {
        session.release();
      } catch (e) { /* ignore */ }
      session = null;
      available = false;
      initialized = false;
    }
  }

  // ── Register with the VisionModel registry ──
  if (typeof Privamon.VisionModel !== 'undefined') {
    Privamon.VisionModel.register({
      name: 'facedetector',
      description: 'Face detection via UltraFace ONNX Runtime Web',
      capabilities: ['face'],
      initialize,
      detect,
      dispose,
      shouldProcess,
    });
  }

  return { initialize, detect, dispose, shouldProcess };
})();
