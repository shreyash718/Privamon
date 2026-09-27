/**
 * Privamon — Face Detector (100% In-Browser via ONNX Runtime Web)
 *
 * Runs UltraFace / BlazeFace inside the browser offscreen sandbox using WebGPU/WASM.
 * Detects human faces in candidate visual elements (profile pictures, photo galleries, ID badges).
 *
 * Implements:
 *   - Persistent ONNX session cached in memory
 *   - Execution providers: WebGPU prioritized, WASM as rock-solid universal fallback
 *   - Bilinear tensor preprocessing [1, 3, 240, 320] with mean/std normalization
 *   - Non-Maximum Suppression (NMS) with IoU threshold = 0.3
 *   - Coordinate transformation to screenshot pixel space
 *   - Universal DetectionCandidate normalization
 */
var Privamon = (typeof window !== 'undefined' && window.Privamon)
            || (typeof globalThis !== 'undefined' && globalThis.Privamon)
            || (typeof self !== 'undefined' && self.Privamon)
            || {};
if (typeof window !== 'undefined') window.Privamon = Privamon;
if (typeof globalThis !== 'undefined') globalThis.Privamon = Privamon;
if (typeof self !== 'undefined') self.Privamon = Privamon;

Privamon.FaceDetector = (() => {
  'use strict';

  let session = null;
  let isInitializing = false;
  let initPromise = null;
  let fallbackWasmPromise = null;
  let isAvailable = false;
  let ortInstance = null;
  let cachedModelBuffer = null;
  let webgpuFailed = false;

  // UltraFace RFB 320 tensor dimensions
  const INPUT_WIDTH = 320;
  const INPUT_HEIGHT = 240;

  // Thresholds
  const FACE_CONFIDENCE_THRESHOLD = 0.45;
  const NMS_IOU_THRESHOLD = 0.30;
  const MIN_FACE_REGION_SIZE = 16; // Min CSS px dimension to consider for face detection

  // Reusable offscreen canvas for preprocessing to reduce GC churn
  let preprocessCanvas = null;
  let preprocessCtx = null;

  function getPreprocessContext() {
    if (!preprocessCanvas) {
      preprocessCanvas = document.createElement('canvas');
      preprocessCanvas.width = INPUT_WIDTH;
      preprocessCanvas.height = INPUT_HEIGHT;
      preprocessCtx = preprocessCanvas.getContext('2d', { willReadFrequently: true });
    }
    return preprocessCtx;
  }

  /**
   * Filters pixel regions to those plausibly containing human photos (not thin dividers or tiny icons).
   */
  function shouldProcess(region) {
    if (!region || !region.bbox) return false;
    if (region.bbox.width < MIN_FACE_REGION_SIZE || region.bbox.height < MIN_FACE_REGION_SIZE) {
      return false;
    }
    const aspectRatio = region.bbox.width / (region.bbox.height || 1);
    if (aspectRatio > 6.0 || aspectRatio < 0.16) return false;
    return true;
  }

  /**
   * Lazily initializes the ONNX inference session.
   */
  function resolveUrl(relativePath) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL(relativePath);
    }
    return relativePath.startsWith('/') ? relativePath : '/' + relativePath;
  }

  /**
   * Lazily initializes the ONNX inference session.
   */
  function initialize() {
    if (session) return Promise.resolve(session);
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        const ortObj = (typeof ort !== 'undefined') ? ort
                     : (typeof window !== 'undefined' && window.ort) ? window.ort
                     : (typeof globalThis !== 'undefined' && globalThis.ort) ? globalThis.ort
                     : (typeof self !== 'undefined' && self.ort) ? self.ort
                     : null;

        if (!ortObj) {
          console.warn('[FaceDetector] ONNX Runtime Web (ort) not loaded — face detection unavailable');
          return null;
        }

        // Configure WASM paths
        if (ortObj.env && ortObj.env.wasm) {
          ortObj.env.wasm.wasmPaths = resolveUrl('lib/onnx/');
          ortObj.env.wasm.numThreads = 1;
        }

        ortInstance = ortObj;

        // Try primary model first, fallback to blazeface
        const modelPaths = [
          resolveUrl('lib/onnx/version-RFB-320-clean.onnx'),
          '../lib/onnx/version-RFB-320-clean.onnx',
          'lib/onnx/version-RFB-320-clean.onnx',
          resolveUrl('lib/onnx/blazeface.onnx'),
          '../lib/onnx/blazeface.onnx',
          'lib/onnx/blazeface.onnx'
        ];

        if (!cachedModelBuffer) {
          for (const url of modelPaths) {
            try {
              const resp = await fetch(url);
              if (resp.ok) {
                cachedModelBuffer = await resp.arrayBuffer();
                console.log('[FaceDetector] Successfully loaded face model from:', url);
                break;
              }
            } catch (e) {
              // Try next candidate
            }
          }
        }

        if (!cachedModelBuffer) {
          throw new Error('No ONNX face model file could be loaded');
        }

        // Feature-detect navigator.gpu for WebGPU hardware acceleration (unless WebGPU previously failed)
        let hasWebGPU = false;
        if (!webgpuFailed && typeof navigator !== 'undefined' && navigator.gpu) {
          try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
              hasWebGPU = true;
              console.info('[FaceDetector] WebGPU hardware adapter detected successfully.');
            }
          } catch (gpuErr) {
            console.warn('[FaceDetector] navigator.gpu available but adapter request failed:', gpuErr.message);
          }
        }

        const primaryEPs = (hasWebGPU && !webgpuFailed) ? ['webgpu', 'wasm'] : ['wasm'];
        console.info(`[FaceDetector] Attempting InferenceSession creation with executionProviders: [${primaryEPs.join(', ')}]`);

        let createdSession = null;
        try {
          createdSession = await ortInstance.InferenceSession.create(cachedModelBuffer, {
            executionProviders: primaryEPs,
            graphOptimizationLevel: 'all',
          });
          console.info(`[FaceDetector] Session initialized successfully with provider: ${primaryEPs.includes('webgpu') ? 'WebGPU' : 'WASM SIMD'}`);
        } catch (epErr) {
          console.warn('[FaceDetector] Primary execution provider failed, falling back to WASM SIMD:', epErr.message);
          webgpuFailed = true;
          createdSession = await ortInstance.InferenceSession.create(cachedModelBuffer, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
          });
        }

        session = createdSession;
        isAvailable = true;
        console.log('[FaceDetector] Face detection session initialized. Inputs:', session.inputNames);

        // Run eager background warm-up inference if WebGPU provider was chosen,
        // ensuring any JSEP kernel bugs are caught and resolved in background before user interaction
        if (primaryEPs.includes('webgpu') && !webgpuFailed) {
          try {
            const dummyDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
            const dummyTensor = await prepareTensor(dummyDataUrl);
            const feeds = {};
            feeds[session.inputNames[0] || 'input'] = dummyTensor;
            await session.run(feeds);
          } catch (warmupErr) {
            console.warn('[FaceDetector] Background WebGPU warm-up inference failed, switching to WASM SIMD:', warmupErr.message);
            webgpuFailed = true;
            session = await ortInstance.InferenceSession.create(cachedModelBuffer, {
              executionProviders: ['wasm'],
              graphOptimizationLevel: 'all',
            });
            console.info('[FaceDetector] Pre-warmed WASM SIMD session ready for immediate user interaction.');
          }
        }

        return session;
      } catch (err) {
        console.warn('[FaceDetector] Failed to initialize in-browser face detector:', err.message);
        session = null;
        isAvailable = false;
        return null;
      }
    })();

    return initPromise;
  }

  /**
   * Prepares image data as an RGB float32 NCHW tensor [1, 3, 240, 320].
   */
  async function prepareTensor(dataUrl) {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = dataUrl;
    });

    const ctx = getPreprocessContext();
    ctx.drawImage(img, 0, 0, INPUT_WIDTH, INPUT_HEIGHT);

    const imgData = ctx.getImageData(0, 0, INPUT_WIDTH, INPUT_HEIGHT);
    const { data } = imgData;

    const planeSize = INPUT_HEIGHT * INPUT_WIDTH;
    const float32Data = new Float32Array(3 * planeSize);

    // Normalize per UltraFace standard: (pixel - 127.0) / 128.0
    for (let i = 0; i < planeSize; i++) {
      float32Data[i] = (data[i * 4 + 0] - 127.0) / 128.0;               // R
      float32Data[planeSize + i] = (data[i * 4 + 1] - 127.0) / 128.0;   // G
      float32Data[2 * planeSize + i] = (data[i * 4 + 2] - 127.0) / 128.0;// B
    }

    const ortClass = ortInstance || (typeof ort !== 'undefined' ? ort : (typeof window !== 'undefined' ? window.ort : null));
    return new ortClass.Tensor('float32', float32Data, [1, 3, INPUT_HEIGHT, INPUT_WIDTH]);
  }

  /**
   * Calculates IoU between two bounding boxes for NMS.
   */
  function calculateIoU(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);

    const interW = Math.max(0, x2 - x1);
    const interH = Math.max(0, y2 - y1);
    const interArea = interW * interH;

    const areaA = a.width * a.height;
    const areaB = b.width * b.height;
    const unionArea = areaA + areaB - interArea;

    return unionArea > 0 ? interArea / unionArea : 0;
  }

  /**
   * Decodes model outputs and applies Non-Maximum Suppression (NMS).
   */
  function decodeDetections(results, regionBbox) {
    const rawCandidates = [];

    // Locate scores and boxes tensors
    let scoresData = null;
    let boxesData = null;

    for (const name of Object.keys(results)) {
      const lower = name.toLowerCase();
      if (lower.includes('score') || lower.includes('conf')) {
        scoresData = results[name].data;
      } else if (lower.includes('box') || lower.includes('loc')) {
        boxesData = results[name].data;
      }
    }

    if (!scoresData || !boxesData) return [];

    const numDetections = Math.floor(scoresData.length / 2);

    for (let i = 0; i < numDetections; i++) {
      const faceScore = scoresData[i * 2 + 1];
      if (faceScore >= FACE_CONFIDENCE_THRESHOLD) {
        const xmin = Math.max(0.0, Math.min(1.0, boxesData[i * 4 + 0]));
        const ymin = Math.max(0.0, Math.min(1.0, boxesData[i * 4 + 1]));
        const xmax = Math.max(0.0, Math.min(1.0, boxesData[i * 4 + 2]));
        const ymax = Math.max(0.0, Math.min(1.0, boxesData[i * 4 + 3]));

        if (xmax <= xmin || ymax <= ymin) continue;

        // Map normalized crop coords to screenshot pixel space
        const rx = Math.round(regionBbox.x + xmin * regionBbox.width);
        const ry = Math.round(regionBbox.y + ymin * regionBbox.height);
        const rw = Math.round((xmax - xmin) * regionBbox.width);
        const rh = Math.round((ymax - ymin) * regionBbox.height);

        if (rw < 6 || rh < 6) continue;

        // Add 15% horizontal and 20% vertical margin so face redactions cleanly cover
        // the entire head, forehead, and chin contours rather than just inner facial landmarks
        const padX = Math.round(rw * 0.15);
        const padY = Math.round(rh * 0.20);
        const finalX = Math.max(0, rx - padX);
        const finalY = Math.max(0, ry - padY);
        const finalW = rw + 2 * padX;
        const finalH = rh + 2 * padY;

        rawCandidates.push({
          bbox: { x: finalX, y: finalY, width: finalW, height: finalH },
          confidence: faceScore
        });
      }
    }

    if (rawCandidates.length === 0) return [];

    // Sort by confidence descending
    rawCandidates.sort((a, b) => b.confidence - a.confidence);

    // Apply Non-Maximum Suppression (NMS)
    const nmsResults = [];
    const suppressed = new Set();

    for (let i = 0; i < rawCandidates.length; i++) {
      if (suppressed.has(i)) continue;
      const current = rawCandidates[i];
      nmsResults.push(current);

      for (let j = i + 1; j < rawCandidates.length; j++) {
        if (suppressed.has(j)) continue;
        if (calculateIoU(current.bbox, rawCandidates[j].bbox) >= NMS_IOU_THRESHOLD) {
          suppressed.add(j);
        }
      }
    }

    // Convert to unified DetectionCandidate objects
    return nmsResults.map(cand => {
      const candidateObj = {
        type: 'face',
        source: 'vision',
        text: null,
        bbox: cand.bbox,
        boxes: [cand.bbox],
        confidence: cand.confidence,
        reason: `face_model:${Math.round(cand.confidence * 100)}%`,
        coordinateSpace: 'screenshot'
      };
      return (Privamon.PIIDetector && typeof Privamon.PIIDetector.toCandidate === 'function')
        ? Privamon.PIIDetector.toCandidate(candidateObj)
        : candidateObj;
    });
  }

  /**
   * Detects faces in an image crop.
   *
   * @param {string} regionDataUrl - Image crop data URL
   * @param {Object} regionBbox - Bounding box in screenshot pixels
   * @returns {Promise<Array<Object>>} Array of DetectionCandidate objects
   */
  async function detect(regionDataUrl, regionBbox) {
    if (!regionDataUrl || !regionBbox) return [];

    const sess = await initialize();
    if (!sess) return [];

    try {
      const inputTensor = await prepareTensor(regionDataUrl);
      const feeds = {};
      feeds[sess.inputNames[0] || 'input'] = inputTensor;

      const results = await sess.run(feeds);
      return decodeDetections(results, regionBbox);
    } catch (err) {
      console.warn('[FaceDetector] WebGPU runtime inference error, switching session to WASM SIMD:', err.message);
      webgpuFailed = true;

      // Deduplicate fallback WASM session creation across concurrent callers
      if (!fallbackWasmPromise) {
        fallbackWasmPromise = (async () => {
          try {
            if (!cachedModelBuffer) throw new Error('No cached model buffer available for fallback');
            console.info('[FaceDetector] Instantiating dedicated WASM SIMD fallback session...');
            const wasmSess = await ortInstance.InferenceSession.create(cachedModelBuffer, {
              executionProviders: ['wasm'],
              graphOptimizationLevel: 'all',
            });
            session = wasmSess;
            initPromise = Promise.resolve(session);
            console.info('[FaceDetector] WASM SIMD fallback session created and cached permanently.');
            return session;
          } catch (e) {
            console.error('[FaceDetector] WASM fallback session creation failed:', e.message);
            return null;
          } finally {
            fallbackWasmPromise = null;
          }
        })();
      }

      const fallbackSess = await fallbackWasmPromise;
      if (fallbackSess) {
        try {
          const inputTensor = await prepareTensor(regionDataUrl);
          const feeds = {};
          feeds[fallbackSess.inputNames[0] || 'input'] = inputTensor;
          const results = await fallbackSess.run(feeds);
          return decodeDetections(results, regionBbox);
        } catch (fbErr) {
          console.warn('[FaceDetector] Fallback WASM inference failed:', fbErr.message);
        }
      }
      return [];
    }
  }

  /**
   * Process all candidate pixel regions in the screenshot.
   */
  async function processRegions(screenshotDataUrl, pixelRegions, mapper) {
    const candidates = [];
    const eligibleRegions = pixelRegions.filter(shouldProcess);

    if (eligibleRegions.length === 0) return [];

    const sess = await initialize();
    if (!sess) return [];

    for (const region of eligibleRegions) {
      try {
        const screenshotBbox = mapper ? mapper.mapBbox(region.bbox) : region.bbox;
        const cropDataUrl = await Privamon.Redactor.extractRegion(screenshotDataUrl, screenshotBbox);
        const faces = await detect(cropDataUrl, screenshotBbox);
        if (faces.length > 0) {
          candidates.push(...faces);
        }
      } catch (err) {
        console.warn(`[FaceDetector] Error processing region ${region.regionId}:`, err.message);
      }
    }

    return candidates;
  }

  return {
    initialize,
    shouldProcess,
    detect,
    processRegions,
    isAvailable: () => isAvailable
  };
})();
