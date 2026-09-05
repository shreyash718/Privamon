"""
Privamon — Presidio Deterministic Detector

Orchestrates Microsoft Presidio AnalyzerEngine with custom India PII recognizers
and strict false-positive suppression rules.
"""

import re
from typing import List, Dict, Any, Optional
from presidio_analyzer import AnalyzerEngine, RecognizerRegistry
from presidio_analyzer.nlp_engine import NlpEngineProvider
from engine.custom_recognizers import (
    AadhaarRecognizer,
    PANRecognizer,
    IndianPhoneRecognizer,
    UPIRecognizer,
    IndianPassportRecognizer,
    DrivingLicenceRecognizer,
    VoterIDRecognizer,
    BankAccountRecognizer,
    GSTINRecognizer,
    VehicleRegistrationRecognizer,
    is_suppressed_by_negative_context
)


# Foreign / region-specific recognizers to REMOVE after loading predefined set.
# These add scan overhead and produce false positives on Indian PII text.
_PRUNE_RECOGNIZER_NAMES = {
    "AuAbnRecognizer",
    "AuAcnRecognizer",
    "AuMedicareRecognizer",
    "AuTfnRecognizer",
    "EsNifRecognizer",
    "InPanRecognizer",      # replaced by our custom PANRecognizer
    "ItDriverLicenseRecognizer",
    "ItFiscalCodeRecognizer",
    "ItIdentityCardRecognizer",
    "ItPassportRecognizer",
    "ItVatCodeRecognizer",
    "PlPeselRecognizer",
    "SgFinRecognizer",
    "NhsRecognizer",
    "UkNhsRecognizer",
    "UsBankRecognizer",
    "UsItinRecognizer",
    "UsPassportRecognizer",
    "UsSsnRecognizer",
    "UsLicenseRecognizer",
    "SpacyRecognizer",
}


class PresidioDetector:
    def __init__(self):
        # Configure lightweight spaCy NLP engine (en_core_web_sm)
        # Prevents Presidio from downloading the massive en_core_web_lg model
        nlp_config = {
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
        }
        provider = NlpEngineProvider(nlp_configuration=nlp_config)
        nlp_engine = provider.create_engine()

        # Create registry, load predefined recognizers, then prune foreign ones
        registry = RecognizerRegistry()
        registry.load_predefined_recognizers(languages=["en"], nlp_engine=nlp_engine)

        # Prune foreign / region-specific recognizers that are irrelevant
        for recognizer in list(registry.recognizers):
            recognizer_class = type(recognizer).__name__
            if recognizer_class in _PRUNE_RECOGNIZER_NAMES:
                registry.remove_recognizer(recognizer_class)

        # Register custom India PII recognizers
        registry.add_recognizer(AadhaarRecognizer())
        registry.add_recognizer(PANRecognizer())
        registry.add_recognizer(IndianPhoneRecognizer())
        registry.add_recognizer(UPIRecognizer())
        registry.add_recognizer(IndianPassportRecognizer())
        registry.add_recognizer(DrivingLicenceRecognizer())
        registry.add_recognizer(VoterIDRecognizer())
        registry.add_recognizer(BankAccountRecognizer())
        registry.add_recognizer(GSTINRecognizer())
        registry.add_recognizer(VehicleRegistrationRecognizer())

        self.analyzer = AnalyzerEngine(
            registry=registry,
            nlp_engine=nlp_engine,
            supported_languages=["en"]
        )

    def detect(self, text: str, context: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Runs Presidio deterministic recognition on the given text.
        Returns a list of structured detections.
        """
        if not text or not text.strip():
            return []

        results = self.analyzer.analyze(
            text=text,
            language="en",
            score_threshold=0.40,
            context=[context] if context else None
        )

        detections = []
        for r in results:
            raw_matched_text = text[r.start:r.end]
            start, end = r.start, r.end

            # Post-processing 1: Clean email span bleeding into punctuation / next words
            if r.entity_type == "EMAIL_ADDRESS":
                clean_email = re.split(r"[\s,;!?:()]", raw_matched_text)[0].rstrip(".")
                if len(clean_email) > 3 and "@" in clean_email:
                    end = start + len(clean_email)
                    raw_matched_text = clean_email

            # Post-processing 2: Never allow entities (other than LOCATION/ADDRESS) to cross newlines
            if "\n" in raw_matched_text and r.entity_type not in ("LOCATION", "ADDRESS"):
                first_line = raw_matched_text.split("\n")[0]
                end = start + len(first_line)
                raw_matched_text = first_line

            # Post-processing 3: Strip leading/trailing punctuation and whitespace
            stripped = raw_matched_text.strip(" \t\r\n:,;.-")
            if not stripped or len(stripped) < 2:
                continue
            if stripped != raw_matched_text:
                lead_trim = len(raw_matched_text) - len(raw_matched_text.lstrip(" \t\r\n:,;.-"))
                start += lead_trim
                end = start + len(stripped)
                raw_matched_text = stripped

            # Post-processing 4: Centralized False-Positive Suppression
            suppress_reason = is_suppressed_by_negative_context(text, start)
            if suppress_reason:
                continue

            # Post-processing 5: Aadhaar vs Phone conflict resolution
            digits_only = re.sub(r"\D", "", raw_matched_text)
            if r.entity_type == "PHONE_NUMBER" and len(digits_only) == 12 and not raw_matched_text.startswith("+"):
                continue

            detections.append({
                "type": r.entity_type,
                "text": raw_matched_text,
                "start": start,
                "end": end,
                "confidence": round(float(r.score), 4),
                "source": "presidio",
                "recognizer": r.recognition_metadata.get("recognizer_name", "presidio") if hasattr(r, "recognition_metadata") and r.recognition_metadata else "presidio"
            })

        return detections
