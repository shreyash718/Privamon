/**
 * Runs Tesseract.js directly in Node on synthetic test images.
 * Outputs OCR text and word bounding boxes.
 */
const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');

async function runOCR(imagePath, lang = 'eng') {
  console.log(`[Node OCR] Starting OCR on ${imagePath} with lang=${lang}...`);
  const worker = await Tesseract.createWorker(lang, 1, {
    langPath: path.resolve(__dirname, '../lib/tesseract'),
    cachePath: path.resolve(__dirname, '../lib/tesseract'),
    gzip: true,
  });
  
  const result = await worker.recognize(imagePath);
  await worker.terminate();

  const words = (result.data.words || []).map(w => ({
    text: w.text.trim(),
    confidence: w.confidence / 100,
    bbox: {
      x: w.bbox.x0,
      y: w.bbox.y0,
      width: w.bbox.x1 - w.bbox.x0,
      height: w.bbox.y1 - w.bbox.y0,
    }
  })).filter(w => w.text);

  console.log(`[Node OCR] Recognized ${words.length} words from ${imagePath}:`);
  console.log(result.data.text);
  
  return {
    rawText: result.data.text,
    words
  };
}

async function main() {
  const engResult = await runOCR('scratch/competing_identifiers.png', 'eng');
  fs.writeFileSync('scratch/competing_ocr.json', JSON.stringify(engResult, null, 2));

  const hinResult = await runOCR('scratch/hindi_english.png', 'hin+eng');
  fs.writeFileSync('scratch/hindi_ocr.json', JSON.stringify(hinResult, null, 2));
  console.log('[Node OCR] Completed successfully!');
}

main().catch(err => {
  console.error('[Node OCR Error]', err);
  process.exit(1);
});
