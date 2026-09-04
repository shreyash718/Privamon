"""
Privamon — GLiNER Contextual NER Detector

Uses `urchade/gliner_multi_pii-v1` for contextual PII entities:
- person
- address
- location
- organization
- username
- date_of_birth

Rules:
1. The model loads ONCE at server startup and remains in memory.
2. If model loading fails, reports model_not_ready without crashing.
3. Does NOT run GLiNER on single OCR words; operates on coherent text blocks.
"""

import re
import logging
from typing import List, Dict, Any, Optional

logger = logging.getLogger("privamon.gliner")

DEFAULT_LABELS = [
    "person",
    "address",
    "location",
    "organization",
]

# Minimum word-count and alphabetic content thresholds for NER eligibility
_MIN_ALPHA_WORDS = 2
_MIN_TEXT_LEN = 8


def is_eligible_for_ner(text: str) -> bool:
    """
    Returns True only if the text contains enough alphabetic content
    to warrant running expensive neural NER.
    Returns False for purely numeric strings, short codes, tracking numbers,
    order IDs, PIN codes, or extremely short text.
    """
    stripped = text.strip()
    if len(stripped) < _MIN_TEXT_LEN:
        return False
    # Count words that contain at least one letter
    alpha_words = re.findall(r'\b[a-zA-Z]+[a-zA-Z0-9]*\b', stripped)
    return len(alpha_words) >= _MIN_ALPHA_WORDS

LABEL_NORMALIZATION_MAP = {
    "person": "PERSON",
    "name": "PERSON",
    "address": "ADDRESS",
    "location": "LOCATION",
    "organization": "ORGANIZATION",
    "company": "ORGANIZATION",
    "username": "USERNAME",
    "date of birth": "DATE_OF_BIRTH",
    "dob": "DATE_OF_BIRTH"
}


class GLiNERDetector:
    _instance: Optional['GLiNERDetector'] = None
    _model = None
    _is_ready = False
    _init_error = None

    def __init__(self, model_name: str = "urchade/gliner_multi_pii-v1"):
        self.model_name = model_name

    @classmethod
    def get_instance(cls, model_name: str = "urchade/gliner_multi_pii-v1") -> 'GLiNERDetector':
        if cls._instance is None:
            cls._instance = cls(model_name)
        return cls._instance

    def initialize(self) -> bool:
        """Loads the GLiNER model once and caches it in memory."""
        if self._is_ready and self._model is not None:
            return True

        if self._init_error is not None:
            return False

        try:
            logger.info(f"Loading GLiNER model: {self.model_name}...")
            from gliner import GLiNER
            # Load model (uses standard Hugging Face cache)
            self._model = GLiNER.from_pretrained(self.model_name)
            self._is_ready = True
            logger.info("GLiNER model loaded successfully and cached in memory.")
            return True
        except Exception as e:
            self._init_error = str(e)
            self._is_ready = False
            logger.error(f"Failed to load GLiNER model '{self.model_name}': {e}", exc_info=True)
            return False

    @property
    def is_ready(self) -> bool:
        return self._is_ready

    @property
    def init_error(self) -> Optional[str]:
        return self._init_error

    def detect(self, text: str, threshold: float = 0.50, labels: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        """
        Runs contextual NER inference on the provided text block.
        Skips inference entirely if text is ineligible (purely numeric, too short, etc.).
        """
        if not text or not text.strip():
            return []

        if not is_eligible_for_ner(text):
            logger.debug(f"GLiNER skipped: text not eligible for NER (len={len(text.strip())})")
            return []

        if not self._is_ready:
            # Try lazy load if not already attempted
            if self._init_error is None:
                self.initialize()
            if not self._is_ready:
                logger.warning("GLiNER detector called but model is not ready.")
                return []

        target_labels = labels or DEFAULT_LABELS

        try:
            raw_entities = self._model.predict_entities(
                text,
                target_labels,
                threshold=threshold
            )

            detections = []
            for ent in raw_entities:
                label = ent.get("label", "").lower()
                norm_type = LABEL_NORMALIZATION_MAP.get(label, label.upper())

                detections.append({
                    "type": norm_type,
                    "text": ent.get("text", ""),
                    "start": ent.get("start", 0),
                    "end": ent.get("end", 0),
                    "confidence": round(float(ent.get("score", 0.0)), 4),
                    "source": "gliner",
                    "raw_label": label
                })

            return detections

        except Exception as e:
            logger.error(f"GLiNER prediction failed: {e}", exc_info=True)
            return []
