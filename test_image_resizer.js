/**
 * Unit Test Suite for Privamon.ImageResizer
 */
const assert = require('assert');

// Mock Canvas / OffscreenCanvas environment for Node testing
class MockCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
  }
  getContext(type) {
    return {
      drawImage: (src, sx, sy, sw, sh, dx, dy, dw, dh) => {},
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high'
    };
  }
  toDataURL(format = 'image/png', quality = 0.85) {
    return `data:${format};base64,mock_${this.width}x${this.height}_${quality}`;
  }
}

global.OffscreenCanvas = MockCanvas;
global.createImageBitmap = async function(src, opts = {}) {
  const targetW = opts.resizeWidth || src.width;
  const targetH = opts.resizeHeight || src.height;
  return {
    width: targetW,
    height: targetH,
    close: () => {}
  };
};

// Load ImageResizer
require('./privacy/image-resizer.js');
const Resizer = Privamon.ImageResizer;

async function runTests() {
  console.log('[*] Running ImageResizer unit tests...\n');

  // Test 1: Constants
  assert.strictEqual(Resizer.DEFAULT_MAX_SERVER_LONG_EDGE, 1152, 'Default max long edge should be 1152');
  assert.strictEqual(Resizer.DEFAULT_FORMAT, 'image/png', 'Default format should be PNG');
  assert.strictEqual(Resizer.DEFAULT_WEBP_QUALITY, 0.85, 'Default WebP quality should be 0.85');
  console.log('✓ Test 1: Configurable constants verified');

  // Test 2: normalizeDPR (Retina 2x downscaled to 1x CSS)
  const retinaCanvas = new MockCanvas(2560, 1440);
  const normalized = await Resizer.normalizeDPR(retinaCanvas, 2.0);
  assert.strictEqual(normalized.width, 1280, 'DPR 2.0 should halve width');
  assert.strictEqual(normalized.height, 720, 'DPR 2.0 should halve height');
  console.log('✓ Test 2: DPR normalization (2.0x -> 1x CSS) passed');

  // Test 3: normalizeDPR passthrough for DPR <= 1
  const standardCanvas = new MockCanvas(1280, 720);
  const passedThrough = await Resizer.normalizeDPR(standardCanvas, 1.0);
  assert.strictEqual(passedThrough, standardCanvas, 'DPR <= 1 must return original canvas without cloning');
  console.log('✓ Test 3: DPR <= 1 passthrough without re-allocation passed');

  // Test 4: resizeForServer landscape capping (1920x1080 -> 1152x648)
  const fullHd = new MockCanvas(1920, 1080);
  const resizedLandscape = await Resizer.resizeForServer(fullHd, { maxLongEdge: 1152 });
  assert.strictEqual(resizedLandscape.width, 1152, 'Landscape width should be capped at 1152');
  assert.strictEqual(resizedLandscape.height, 648, 'Landscape height should preserve 16:9 aspect ratio');
  console.log('✓ Test 4: Landscape long-edge capping at 1152px with aspect ratio preservation passed');

  // Test 5: resizeForServer portrait capping (1080x1920 -> 648x1152)
  const portrait = new MockCanvas(1080, 1920);
  const resizedPortrait = await Resizer.resizeForServer(portrait, { maxLongEdge: 1152 });
  assert.strictEqual(resizedPortrait.width, 648, 'Portrait width should be 648');
  assert.strictEqual(resizedPortrait.height, 1152, 'Portrait height should be capped at 1152');
  console.log('✓ Test 5: Portrait long-edge capping at 1152px with aspect ratio preservation passed');

  // Test 6: Never upscale (800x600 canvas remains 800x600)
  const smallCanvas = new MockCanvas(800, 600);
  const untouchedSmall = await Resizer.resizeForServer(smallCanvas, { maxLongEdge: 1152 });
  assert.strictEqual(untouchedSmall, smallCanvas, 'Small canvas must be passed through untouched (never upscaled)');
  console.log('✓ Test 6: Never upscale rule verified (small canvas passed through)');

  // Test 7: Full pipeline prepareServerScreenshot (DPR 2x Retina 2560x1440 -> 1280x720 -> 1152x648)
  const retinaSource = new MockCanvas(2560, 1440);
  const result = await Resizer.prepareServerScreenshot(retinaSource, 2.0, { maxLongEdge: 1152, format: 'image/png' });
  assert.ok(result.serverDataUrl, 'Must return serverDataUrl');
  assert.strictEqual(result.metadata.originalDimensions.width, 2560);
  assert.strictEqual(result.metadata.dprNormalizedDimensions.width, 1280);
  assert.strictEqual(result.metadata.serverDimensions.width, 1152);
  assert.strictEqual(result.metadata.serverDimensions.height, 648);
  assert.strictEqual(result.metadata.resampled, true);
  console.log('✓ Test 7: Full prepareServerScreenshot pipeline (DPR normalize + 1152px cap) passed');

  // Test 8: Graceful fallback on unexpected error
  const brokenCanvas = {
    get width() { throw new Error('Out of memory test'); },
    height: 1000,
    toDataURL: () => 'data:image/png;base64,fallback'
  };
  const fallbackResult = await Resizer.prepareServerScreenshot(brokenCanvas, 1.0);
  assert.strictEqual(fallbackResult.metadata.fallbackUsed, true, 'Must flag fallbackUsed on error');
  assert.strictEqual(fallbackResult.serverDataUrl, 'data:image/png;base64,fallback', 'Must safely return full-res fallback');
  console.log('✓ Test 8: Graceful error fallback to full-resolution screenshot passed');

  // Test 9: Dev calibration set generation
  const calibCanvas = new MockCanvas(2000, 1000);
  const calibSet = await Resizer.generateCalibrationSet(calibCanvas, 1.0, [1536, 1152, 896, 640]);
  assert.strictEqual(calibSet.length, 4, 'Should generate 4 candidate outputs');
  assert.strictEqual(calibSet[0].targetLongEdge, 1536);
  assert.strictEqual(calibSet[1].targetLongEdge, 1152);
  assert.strictEqual(calibSet[2].targetLongEdge, 896);
  assert.strictEqual(calibSet[3].targetLongEdge, 640);
  console.log('✓ Test 9: Calibration set harness passed (generated 4 candidate sizes)');

  console.log('\n=========================================');
  console.log('ALL 9 IMAGE RESIZER TESTS PASSED (100%)!');
  console.log('=========================================\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
