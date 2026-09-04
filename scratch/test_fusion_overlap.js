const fs = require('fs');

global.Privamon = {};
eval(fs.readFileSync('privacy/pii-detector.js', 'utf8'));
eval(fs.readFileSync('privacy/fusion.js', 'utf8'));

const detector = Privamon.PIIDetector;
const fusion = Privamon.PIIFusion;

const idsText = 'Pay to anita.kumar@okhdfcbank or check DL MH-12-2018-0001234 or Voter ID ABC1234567';
const domDetections = detector.detectInText(idsText, 'dom').map(d => ({
  ...d,
  bbox: { x: d.span.start * 10, y: 10, width: (d.span.end - d.span.start) * 10, height: 20 }
}));

console.log('Pre-fusion detections:', domDetections.map(d => `${d.type}: "${d.text}"`));
const fused = fusion.fuse(domDetections, [], []);
console.log('Post-fusion detections:', fused.detections.map(d => `${d.type}: "${d.text}"`));
