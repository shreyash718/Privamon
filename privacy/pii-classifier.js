/**
 * Privamon — PII Classifier
 *
 * Pluggable classification system. Wraps the regex-based PIIDetector
 * and provides an interface for adding future NER/ML-based detectors.
 *
 * Usage:
 *   const classifier = new Privamon.PIIClassifier();
 *   classifier.addDetector(myCustomNERDetector);
 *   const results = classifier.classify(text, context);
 */
var Privamon = Privamon || {};

Privamon.PIIClassifier = class PIIClassifier {
  constructor() {
    /**
     * Array of detector functions.
     * Each detector has the signature:
     *   (text: string, context: object) => Detection[]
     *
     * Where Detection is:
     *   { type, text, confidence, span?, source? }
     */
    this.detectors = [];

    // Register the built-in regex detector
    this.detectors.push({
      name: 'regex',
      detect: (text, context) => {
        return Privamon.PIIDetector.detectInText(
          text,
          context.source || 'dom',
          context.nearbyText || ''
        );
      },
    });
  }

  /**
   * Add a custom detector plugin.
   * @param {Object} detector - { name: string, detect: (text, context) => Detection[] }
   */
  addDetector(detector) {
    if (!detector || typeof detector.detect !== 'function') {
      console.warn('[PIIClassifier] Invalid detector — must have a detect() method');
      return;
    }
    this.detectors.push(detector);
  }

  /**
   * Run all detectors on the given text.
   * @param {string} text - Text to classify
   * @param {Object} context - { source, nearbyText, elementType, ... }
   * @returns {Array} All detections from all detectors
   */
  classify(text, context = {}) {
    if (!text || typeof text !== 'string') return [];

    const allDetections = [];

    for (const detector of this.detectors) {
      try {
        const detections = detector.detect(text, context);
        if (Array.isArray(detections)) {
          for (const d of detections) {
            allDetections.push({
              ...d,
              detectorName: detector.name,
            });
          }
        }
      } catch (err) {
        console.error(`[PIIClassifier] Detector '${detector.name}' failed:`, err);
      }
    }

    return allDetections;
  }

  /**
   * Get list of registered detector names.
   */
  getDetectorNames() {
    return this.detectors.map(d => d.name);
  }
};
