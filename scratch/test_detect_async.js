// Test end-to-end detectAsync + redaction using Node.js
const fs = require('fs');

global.Privamon = {};
eval(fs.readFileSync('privacy/pii-detector.js', 'utf8'));
eval(fs.readFileSync('privacy/fusion.js', 'utf8'));
eval(fs.readFileSync('privacy/coordinate-mapper.js', 'utf8'));

async function runTest() {
  console.log('=== TEST: detectAsync with Live Local Engine ===');

  const text = 'Customer: Priya Sharma\nPhone: +91 9876543210\nDelivery to: 42 Palm Grove Road, Bandra West, Mumbai 400050';

  // Simulated OCR tokens with bounding boxes
  const tokens = [
    { text: 'Customer:', bbox: { x: 10, y: 10, width: 80, height: 20 }, confidence: 0.95 },
    { text: 'Priya', bbox: { x: 95, y: 10, width: 50, height: 20 }, confidence: 0.98 },
    { text: 'Sharma', bbox: { x: 150, y: 10, width: 60, height: 20 }, confidence: 0.97 },
    { text: 'Phone:', bbox: { x: 10, y: 40, width: 60, height: 20 }, confidence: 0.95 },
    { text: '+91', bbox: { x: 75, y: 40, width: 30, height: 20 }, confidence: 0.99 },
    { text: '9876543210', bbox: { x: 110, y: 40, width: 90, height: 20 }, confidence: 0.99 },
    { text: 'Delivery', bbox: { x: 10, y: 70, width: 70, height: 20 }, confidence: 0.92 },
    { text: 'to:', bbox: { x: 85, y: 70, width: 25, height: 20 }, confidence: 0.94 },
    { text: '42', bbox: { x: 115, y: 70, width: 25, height: 20 }, confidence: 0.96 },
    { text: 'Palm', bbox: { x: 145, y: 70, width: 45, height: 20 }, confidence: 0.97 },
    { text: 'Grove', bbox: { x: 195, y: 70, width: 50, height: 20 }, confidence: 0.96 },
    { text: 'Road,', bbox: { x: 250, y: 70, width: 50, height: 20 }, confidence: 0.95 },
    { text: 'Bandra', bbox: { x: 10, y: 100, width: 65, height: 20 }, confidence: 0.97 },
    { text: 'West,', bbox: { x: 80, y: 100, width: 50, height: 20 }, confidence: 0.96 },
    { text: 'Mumbai', bbox: { x: 135, y: 100, width: 70, height: 20 }, confidence: 0.98 },
    { text: '400050', bbox: { x: 210, y: 100, width: 65, height: 20 }, confidence: 0.99 },
  ];

  const t0 = Date.now();
  const detections = await Privamon.PIIDetector.detectAsync(text, 'ocr', '', tokens);
  const elapsed = Date.now() - t0;

  console.log(`detectAsync returned ${detections.length} detections in ${elapsed}ms:`);
  for (const d of detections) {
    console.log(`- Type: ${d.type}, Text: "${d.text}", Conf: ${d.confidence.toFixed(2)}, BBox:`, d.bbox, 'Boxes:', d.boxes);
  }

  // Verify that PERSON, PHONE, and ADDRESS were detected
  const types = detections.map(d => d.type.toLowerCase());
  console.log('\nVerification checks:');
  const hasPerson = types.some(t => t.includes('person') || t.includes('name'));
  const hasPhone = types.some(t => t.includes('phone'));
  const hasAddress = types.some(t => t.includes('address') || t.includes('location'));

  console.log('✓ Person detected:', hasPerson);
  console.log('✓ Phone detected:', hasPhone);
  console.log('✓ Address detected:', hasAddress);

  if (hasPerson && hasPhone && hasAddress) {
    console.log('\nALL 3 SENSITIVE ENTITIES DETECTED SUCCESSFULLY!');
  } else {
    console.error('\nFAILURE: Missing expected sensitive entities');
    process.exit(1);
  }
}

runTest().catch(err => {
  console.error('Error running test:', err);
  process.exit(1);
});
