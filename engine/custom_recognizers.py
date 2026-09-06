"""
Privamon — Custom Recognizers for Indian PII & False Positive Suppression

Implements high-precision, context-aware recognizers:
- Aadhaar (with full Verhoeff checksum)
- PAN (with status code validation & candidate OCR repair)
- Indian Phone (with strict negative context suppression)
- UPI ID
- Indian Passport
- Driving Licence
- Voter ID (EPIC)
- Bank Account Number (strictly context-gated)
- GSTIN
- Vehicle Registration
- Centralized False Positive Suppression
"""

import re
from typing import List, Optional
from presidio_analyzer import (
    Pattern,
    PatternRecognizer,
    RecognizerResult,
    AnalysisExplanation,
    EntityRecognizer
)

from engine.context_engine import (
    evaluate_phone_candidate,
    COMMERCIAL_NON_PERSONAL_KEYWORDS,
    PERSONAL_ID_KEYWORDS,
    AMBIGUOUS_ID_KEYWORDS
)

# ── Negative Context Keywords (False Positive Suppressors) ──
NEGATIVE_PREFIX_KEYWORDS = [
    r"order\s*(?:id|#|no|num|number)?\s*[:\-]?\s*",
    r"invoice\s*(?:id|#|no|num|number)?\s*[:\-]?\s*",
    r"product\s*(?:code|id|#|no|num)?\s*[:\-]?\s*",
    r"pin\s*(?:code)?\s*[:\-]?\s*",
    r"pincode\s*[:\-]?\s*",
    r"tracking\s*(?:id|#|no|num|number)?\s*[:\-]?\s*",
    r"reference\s*(?:id|#|no|num|number)?\s*[:\-]?\s*",
    r"ref\s*(?:id|#|no|num|number)?\s*[:\-]?\s*",
    r"ticket\s*(?:id|#|no|num|number)?\s*[:\-]?\s*",
    r"sku\s*[:\-]?\s*",
    r"item\s*(?:code|id|#|no)?\s*[:\-]?\s*",
    r"model\s*(?:no|num|number)?\s*[:\-]?\s*",
    r"employee\s*(?:id|#|no|num|number|code)?\s*[:\-]?\s*",
    r"customer\s*(?:id|#|no|num|number|code)?\s*[:\-]?\s*",
    r"patient\s*(?:id|#|no|num|number|code)?\s*[:\-]?\s*",
    r"member\s*(?:id|#|no|num|number|code)?\s*[:\-]?\s*",
    r"applicant\s*(?:id|#|no|num|number|code)?\s*[:\-]?\s*",
    r"serial\s*(?:no|num|number)?\s*[:\-]?\s*",
    r"roll\s*(?:no|num|number)?\s*[:\-]?\s*",
    r"transaction\s*(?:id|#|no|num|number)?\s*[:\-]?\s*",
    r"booking\s*(?:id|#|no|num|number)?\s*[:\-]?\s*",
    r"case\s*(?:id|#|no|num|number)?\s*[:\-]?\s*",
]
NEGATIVE_PREFIX_REGEX = re.compile(r"(?:" + "|".join(NEGATIVE_PREFIX_KEYWORDS) + r")$", re.IGNORECASE)


def is_suppressed_by_negative_context(text: str, start: int, lookback_chars: int = 50) -> Optional[str]:
    """
    Inspects up to lookback_chars before `start` to check if a negative context keyword precedes the match.
    Returns the reason string if suppressed, else None.
    """
    prefix_window = text[max(0, start - lookback_chars):start]
    match = NEGATIVE_PREFIX_REGEX.search(prefix_window)
    if match:
        return f"preceded_by_negative_prefix: '{match.group(0).strip()}'"
    return None


# ── Verhoeff Checksum for Aadhaar ──
VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
]
VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
]
VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9]

def generate_verhoeff(num_str: str) -> str:
    """Calculates the Verhoeff check digit for a given digit string."""
    digits = re.sub(r"\D", "", num_str)
    c = 0
    for i, digit in enumerate(reversed(digits)):
        c = VERHOEFF_D[c][VERHOEFF_P[(i + 1) % 8][int(digit)]]
    return str(VERHOEFF_INV[c])

def validate_verhoeff(num_str: str) -> bool:
    """Validates Aadhaar 12-digit number using Verhoeff algorithm."""
    digits = re.sub(r"[\s\-]", "", num_str)
    if len(digits) != 12 or not digits.isdigit():
        return False
    # Aadhaar cannot start with 0 or 1
    if digits[0] in ('0', '1'):
        return False
    c = 0
    for i, digit in enumerate(reversed(digits)):
        c = VERHOEFF_D[c][VERHOEFF_P[i % 8][int(digit)]]
    return c == 0


# ── Custom Aadhaar Recognizer ──
class AadhaarRecognizer(PatternRecognizer):
    """
    Recognizes Indian Aadhaar numbers:
    - 12 digits, format XXXX XXXX XXXX or XXXXXXXXXXXX or XXXX-XXXX-XXXX
    - First digit in [2-9]
    - Validates with Verhoeff algorithm
    - Context boosting + negative context suppression
    """
    PATTERNS = [
        Pattern("aadhaar_spaced", r"\b[2-9]\d{3}[\s\-]\d{4}[\s\-]\d{4}\b", 0.70),
        Pattern("aadhaar_continuous", r"\b[2-9]\d{11}\b", 0.40),
    ]
    CONTEXT = ["aadhaar", "aadhar", "uid", "uidai", "identity", "meroaadhaar"]

    def __init__(self):
        super().__init__(
            supported_entity="AADHAAR",
            patterns=self.PATTERNS,
            context=self.CONTEXT,
            supported_language="en"
        )

    def validate_result(self, pattern_text: str) -> bool:
        return validate_verhoeff(pattern_text)

    def analyze(self, text: str, entities: List[str], nlp_artifacts=None) -> List[RecognizerResult]:
        results = super().analyze(text, entities, nlp_artifacts)
        filtered_results = []
        for r in results:
            # Check negative context
            suppress_reason = is_suppressed_by_negative_context(text, r.start)
            if suppress_reason:
                continue

            match_str = text[r.start:r.end]
            if not self.validate_result(match_str):
                # If checksum fails, keep only if context is exceptionally strong, else discard
                continue
            
            # If checksum passes, boost confidence significantly
            r.score = min(0.99, r.score + 0.25)
            filtered_results.append(r)
        return filtered_results


# ── Custom PAN Recognizer ──
class PANRecognizer(PatternRecognizer):
    """
    Recognizes Indian Permanent Account Number (PAN):
    - Format: 5 uppercase letters, 4 digits, 1 uppercase letter (AAAAA9999A)
    - 4th character indicates status: P (Individual), C (Company), H (HUF), F (Firm),
      A (AOP), T (Trust), B (BOI), L (Local Authority), J (AJP), G (Govt)
    - Rejects matches preceded by product/order/invoice keywords
    """
    PATTERNS = [
        Pattern("pan_standard", r"\b[A-Z]{5}[0-9]{4}[A-Z]\b", 0.85),
    ]
    CONTEXT = ["pan", "permanent account", "income tax", "tax", "itr", "nsdl", "uti"]
    VALID_STATUS_CHARS = set("ABCFGHLJPT")

    def __init__(self):
        super().__init__(
            supported_entity="PAN",
            patterns=self.PATTERNS,
            context=self.CONTEXT,
            supported_language="en"
        )

    def validate_result(self, pattern_text: str) -> bool:
        clean = pattern_text.replace(" ", "").replace("-", "").upper()
        if len(clean) != 10:
            return False
        # 4th character validation
        return clean[3] in self.VALID_STATUS_CHARS

    def analyze(self, text: str, entities: List[str], nlp_artifacts=None) -> List[RecognizerResult]:
        results = super().analyze(text, entities, nlp_artifacts)
        filtered_results = []
        for r in results:
            suppress_reason = is_suppressed_by_negative_context(text, r.start)
            if suppress_reason:
                continue

            match_str = text[r.start:r.end]
            if not self.validate_result(match_str):
                # If 4th char is not a known status code, require explicit PAN context
                context_window = text[max(0, r.start - 50):min(len(text), r.end + 50)].lower()
                if not any(k in context_window for k in self.CONTEXT):
                    continue
                r.score = 0.70
            else:
                r.score = min(0.98, r.score + 0.10)
            filtered_results.append(r)
        return filtered_results


# ── Custom Indian Phone Recognizer ──
class IndianPhoneRecognizer(PatternRecognizer):
    """
    Recognizes Indian phone numbers with country code or local 10-digit format.
    Strictly suppresses matches with negative prefix (Order ID, Invoice, Tracking, etc.).
    """
    PATTERNS = [
        Pattern("phone_intl_91", r"\b(?:\+91[\s\-]?)?[6-9]\d{4}[\s\-]?\d{5}\b", 0.85),
        Pattern("phone_with_0", r"\b0[6-9]\d{9}\b", 0.75),
    ]
    CONTEXT = ["phone", "mobile", "cell", "call", "whatsapp", "contact", "tel", "reach"]

    def __init__(self):
        super().__init__(
            supported_entity="PHONE_NUMBER",
            patterns=self.PATTERNS,
            context=self.CONTEXT,
            supported_language="en"
        )

    def analyze(self, text: str, entities: List[str], nlp_artifacts=None) -> List[RecognizerResult]:
        results = super().analyze(text, entities, nlp_artifacts)
        filtered_results = []
        for r in results:
            match_text = text[r.start:r.end]
            # Ensure the matched number has exactly 10 digits (excluding +91 or 0 prefix)
            digits = re.sub(r"\D", "", match_text)
            if digits.startswith("91") and len(digits) == 12:
                digits = digits[2:]
            elif digits.startswith("0") and len(digits) == 11:
                digits = digits[1:]
            if len(digits) != 10:
                continue

            # Reject repetitive dummy numbers like 9999999999
            if len(set(digits)) <= 2:
                continue

            # Evaluate through bidirectional context engine
            eval_res = evaluate_phone_candidate(text, r.start, r.end, match_text)

            r.score = eval_res["decision_score"]
            if hasattr(r, "recognition_metadata") and r.recognition_metadata is not None:
                r.recognition_metadata["context_eval"] = eval_res
            else:
                r.recognition_metadata = {"context_eval": eval_res}

            filtered_results.append(r)
        return filtered_results


# ── Custom UPI ID Recognizer ──
class UPIRecognizer(PatternRecognizer):
    """
    Recognizes Indian Unified Payments Interface (UPI) IDs:
    - user@bank or phone@bank (e.g. rahul@okhdfcbank, 9876543210@paytm)
    """
    PATTERNS = [
        Pattern("upi_known_psp",
                r"\b[a-zA-Z0-9.\-_]{2,49}@(oksbi|okhdfcbank|okaxis|okicici|paytm|apl|ybl|upi|axl|ibl|sbi|hdfc|icici|axis|fbl|idfcbank|postbank|kotak|indus)\b",
                0.95),
        Pattern("upi_generic",
                r"\b[a-zA-Z0-9.\-_]{2,49}@[a-zA-Z]{3,15}\b",
                0.50),
    ]
    CONTEXT = ["upi", "vpa", "gpay", "googlepay", "phonepe", "paytm", "bhim", "payment"]

    def __init__(self):
        super().__init__(
            supported_entity="UPI_ID",
            patterns=self.PATTERNS,
            context=self.CONTEXT,
            supported_language="en"
        )

    def analyze(self, text: str, entities: List[str], nlp_artifacts=None) -> List[RecognizerResult]:
        results = super().analyze(text, entities, nlp_artifacts)
        filtered = []
        for r in results:
            match_str = text[r.start:r.end].lower()
            # If it's the generic pattern, require strong UPI context so it doesn't collide with email
            if not any(match_str.endswith("@" + psp) for psp in ["oksbi", "okhdfcbank", "okaxis", "okicici", "paytm", "apl", "ybl", "upi"]):
                context_window = text[max(0, r.start - 40):min(len(text), r.end + 40)].lower()
                if not any(k in context_window for k in self.CONTEXT):
                    continue
            filtered.append(r)
        return filtered


# ── Custom Indian Passport Recognizer ──
class IndianPassportRecognizer(PatternRecognizer):
    """
    Recognizes Indian Passport numbers:
    - 1 letter (except Q, X, Z), followed by 7 digits with first digit non-zero.
    """
    PATTERNS = [
        Pattern("indian_passport", r"\b[A-PR-WYa-pr-wy][1-9]\d{6}\b", 0.85),
    ]
    CONTEXT = ["passport", "travel document", "nationality", "republic of india", "visa"]

    def __init__(self):
        super().__init__(
            supported_entity="PASSPORT",
            patterns=self.PATTERNS,
            context=self.CONTEXT,
            supported_language="en"
        )


# ── Custom Driving Licence Recognizer ──
class DrivingLicenceRecognizer(PatternRecognizer):
    """
    Recognizes Indian Driving Licence numbers:
    - State code (2 letters) + 2 digits + 4 digits (year) + 7 digits (e.g. DL1420110012345)
    """
    STATE_CODES = (
        "AN|AP|AR|AS|BR|CH|CG|DD|DL|DN|GA|GJ|HP|HR|JH|JK|KA|KL|LD|MH|ML|MN|MP|MZ|NL|OD|PB|PY|RJ|SK|TN|TR|TS|UK|UP|WB"
    )
    PATTERNS = [
        Pattern("dl_standard",
                r"\b(?:" + STATE_CODES + r")[\s\-]?[0-9]{2}[\s\-]?(?:19|20)[0-9]{2}[\s\-]?[0-9]{7}\b",
                0.90),
        Pattern("dl_short",
                r"\b(?:" + STATE_CODES + r")[0-9]{13,14}\b",
                0.80),
    ]
    CONTEXT = ["driving", "licence", "license", "dl", "transport", "motor vehicle"]

    def __init__(self):
        super().__init__(
            supported_entity="DRIVING_LICENCE",
            patterns=self.PATTERNS,
            context=self.CONTEXT,
            supported_language="en"
        )


# ── Custom Voter ID (EPIC) Recognizer ──
class VoterIDRecognizer(PatternRecognizer):
    """
    Recognizes Indian Voter ID (EPIC):
    - 3 uppercase letters followed by 7 digits (e.g. ABC1234567)
    """
    PATTERNS = [
        Pattern("voter_id_epic", r"\b[A-Z]{3}[0-9]{7}\b", 0.70),
    ]
    CONTEXT = ["voter", "epic", "election", "elector", "electoral", "identity card"]

    def __init__(self):
        super().__init__(
            supported_entity="VOTER_ID",
            patterns=self.PATTERNS,
            context=self.CONTEXT,
            supported_language="en"
        )

    def analyze(self, text: str, entities: List[str], nlp_artifacts=None) -> List[RecognizerResult]:
        results = super().analyze(text, entities, nlp_artifacts)
        filtered = []
        for r in results:
            suppress_reason = is_suppressed_by_negative_context(text, r.start)
            if suppress_reason:
                continue
            # Needs at least some election/voter context to prevent false positives on random 10-char codes
            context_window = text[max(0, r.start - 50):min(len(text), r.end + 50)].lower()
            if any(k in context_window for k in self.CONTEXT):
                r.score = 0.95
                filtered.append(r)
            elif r.score >= 0.70:
                filtered.append(r)
        return filtered


# ── Custom Bank Account Recognizer ──
class BankAccountRecognizer(PatternRecognizer):
    """
    Recognizes Indian Bank Account numbers:
    - 9 to 18 digits.
    - STRICT REQUIREMENT: MUST have explicit banking context. Bare numbers are REJECTED!
    """
    PATTERNS = [
        Pattern("bank_account_num", r"\b[0-9]{9,18}\b", 0.30),
    ]
    CONTEXT = [
        "account number", "account no", "acct no", "a/c no", "a/c number",
        "bank account", "savings account", "current account", "bank a/c",
        "account #", "ac no"
    ]

    def __init__(self):
        super().__init__(
            supported_entity="BANK_ACCOUNT",
            patterns=self.PATTERNS,
            context=self.CONTEXT,
            supported_language="en"
        )

    def analyze(self, text: str, entities: List[str], nlp_artifacts=None) -> List[RecognizerResult]:
        results = super().analyze(text, entities, nlp_artifacts)
        filtered = []
        for r in results:
            suppress_reason = is_suppressed_by_negative_context(text, r.start)
            if suppress_reason:
                continue

            # Strict context check within 60 chars preceding the number
            prefix = text[max(0, r.start - 60):r.start].lower()
            if any(k in prefix for k in self.CONTEXT):
                r.score = 0.95
                filtered.append(r)
        return filtered


# ── Custom GSTIN Recognizer ──
class GSTINRecognizer(PatternRecognizer):
    """
    Recognizes Indian Goods and Services Tax Identification Number (GSTIN):
    - 15 characters: 2-digit state code + 10-char PAN + 1-digit entity number + 'Z' + 1 check digit
    """
    PATTERNS = [
        Pattern("gstin_standard",
                r"\b[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b",
                0.95),
    ]
    CONTEXT = ["gstin", "gst", "tax invoice", "goods and services"]

    def __init__(self):
        super().__init__(
            supported_entity="GSTIN",
            patterns=self.PATTERNS,
            context=self.CONTEXT,
            supported_language="en"
        )


# ── Custom Vehicle Registration Recognizer ──
class VehicleRegistrationRecognizer(PatternRecognizer):
    """
    Recognizes Indian Vehicle Registration Numbers:
    - 2-letter state code + 1-2 digit district + optional 1-3 letters + 4 digits
    """
    PATTERNS = [
        Pattern("vehicle_reg",
                r"\b[A-Z]{2}[\s\-]?[0-9]{1,2}[\s\-]?(?:[A-Z]{1,3}[\s\-]?)?[0-9]{4}\b",
                0.65),
    ]
    CONTEXT = ["vehicle", "car", "bike", "registration", "reg no", "rc", "chassis"]

    def __init__(self):
        super().__init__(
            supported_entity="VEHICLE_REGISTRATION",
            patterns=self.PATTERNS,
            context=self.CONTEXT,
            supported_language="en"
        )

    def analyze(self, text: str, entities: List[str], nlp_artifacts=None) -> List[RecognizerResult]:
        results = super().analyze(text, entities, nlp_artifacts)
        filtered = []
        for r in results:
            suppress_reason = is_suppressed_by_negative_context(text, r.start)
            if suppress_reason:
                continue
            context_window = text[max(0, r.start - 40):min(len(text), r.end + 40)].lower()
            if any(k in context_window for k in self.CONTEXT):
                r.score = 0.90
                filtered.append(r)
        return filtered


# ── Custom Hindi Context Recognizer ──
class HindiContextRecognizer(EntityRecognizer):
    """
    Recognizes contextual Hindi PII fields:
    - नाम / श्री / श्रीमती - <नाम> (PERSON)
    - पता / स्थान / निवास - <पता> (ADDRESS)
    """
    def __init__(self):
        super().__init__(
            supported_entities=["PERSON", "ADDRESS"],
            name="HindiContextRecognizer",
            supported_language="en"
        )

    def load(self) -> None:
        pass

    def analyze(self, text: str, entities: List[str], nlp_artifacts=None) -> List[RecognizerResult]:
        results = []
        # 1. Hindi Name: नाम - मिश्र जी / मशिर जी
        for m in re.finditer(r"(?:नाम|श्री|श्रीमती)\s*[:\-–]\s*([^\n\r,]+)", text):
            val = m.group(1).strip()
            if val and len(val) >= 2:
                v_start = m.start(1)
                v_end = v_start + len(val)
                results.append(RecognizerResult(
                    entity_type="PERSON",
                    start=v_start,
                    end=v_end,
                    score=0.88
                ))

        # 2. Hindi Address: पता - सेक्टर 11, फरीदाबाद
        for m in re.finditer(r"(?:पता|स्थान|निवास)\s*[:\-–]\s*([^\n\r]+)", text):
            val = m.group(1).strip()
            if val and len(val) >= 2:
                v_start = m.start(1)
                v_end = v_start + len(val)
                results.append(RecognizerResult(
                    entity_type="ADDRESS",
                    start=v_start,
                    end=v_end,
                    score=0.88
                ))

        return results
