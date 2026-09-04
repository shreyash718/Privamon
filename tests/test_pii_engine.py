"""
Privamon — PII Detection Engine Test Suite

Tests covering:
1. Structured Indian & Global PII (Email, Phone, PAN, Aadhaar, UPI, Passport, DL, Voter ID, Bank Account, GSTIN)
2. False Positive Protection (Order ID, Invoice Number, Product Code, PIN Code, Tracking Number)
3. Contextual NER (Person, Address, Location)
4. OCR Token Span Mapping (Single-line & Multi-line bounding boxes)
5. Conservative Normalizer offset mapping
6. Full FastAPI /detect endpoint contract
"""

import pytest
from fastapi.testclient import TestClient

from engine.server import app
from engine.normalizer import normalize_text, pan_candidate_ocr_repair
from engine.custom_recognizers import validate_verhoeff, generate_verhoeff
from engine.presidio_detector import PresidioDetector
from engine.gliner_detector import GLiNERDetector
from engine.fusion_engine import fuse_detections
from engine.span_mapper import map_detections_to_tokens


@pytest.fixture(scope="session")
def client():
    # Use FastAPI TestClient directly
    return TestClient(app)


@pytest.fixture(scope="session")
def presidio():
    return PresidioDetector()


@pytest.fixture(scope="session")
def gliner():
    detector = GLiNERDetector.get_instance()
    detector.initialize()
    return detector


# ── 1. Structured PII Tests ──

def test_email_detection_no_bleeding(client):
    text = "Contact me at rahul@gmail.com. My phone is active."
    resp = client.post("/detect", json={"text": text, "source": "ocr"})
    assert resp.status_code == 200
    data = resp.json()

    emails = [d for d in data["detections"] if d["type"] == "EMAIL"]
    assert len(emails) == 1
    assert emails[0]["text"] == "rahul@gmail.com"
    assert emails[0]["confidence"] >= 0.85


def test_indian_phone_detection(client):
    text = "Call me on +91 9876543210 or local 9876543210."
    resp = client.post("/detect", json={"text": text, "source": "ocr"})
    assert resp.status_code == 200
    data = resp.json()

    phones = [d for d in data["detections"] if d["type"] == "PHONE"]
    assert len(phones) >= 1
    assert any("9876543210" in p["text"] for p in phones)


def test_pan_detection_with_valid_status_code(client):
    # 'P' as 4th char is Individual
    text = "My PAN number is ABCPE1234F."
    resp = client.post("/detect", json={"text": text, "source": "ocr"})
    assert resp.status_code == 200
    data = resp.json()

    pans = [d for d in data["detections"] if d["type"] == "PAN"]
    assert len(pans) == 1
    assert pans[0]["text"] == "ABCPE1234F"
    assert pans[0]["confidence"] >= 0.85


def test_aadhaar_with_verhoeff_validation(client):
    base = "23456789012"
    valid_aadhaar = base + generate_verhoeff(base)  # Validates with Verhoeff
    assert validate_verhoeff(valid_aadhaar) is True

    text = f"My Aadhaar card is {valid_aadhaar[:4]} {valid_aadhaar[4:8]} {valid_aadhaar[8:]}."
    resp = client.post("/detect", json={"text": text, "source": "ocr"})
    assert resp.status_code == 200
    data = resp.json()

    aadhaar_dets = [d for d in data["detections"] if d["type"] == "AADHAAR"]
    assert len(aadhaar_dets) == 1
    assert aadhaar_dets[0]["confidence"] >= 0.85


def test_invalid_aadhaar_checksum_rejected(client):
    # Intentionally corrupt the last check digit
    invalid_aadhaar = "2345 6789 0129"
    assert validate_verhoeff(invalid_aadhaar) is False

    text = f"Random number {invalid_aadhaar} without Aadhaar context."
    resp = client.post("/detect", json={"text": text, "source": "ocr"})
    data = resp.json()

    # Should NOT be classified as Aadhaar
    aadhaars = [d for d in data["detections"] if d["type"] == "AADHAAR"]
    assert len(aadhaars) == 0


def test_upi_id_detection(client):
    text = "Pay via UPI to rahul@okhdfcbank or merchant@paytm."
    resp = client.post("/detect", json={"text": text, "source": "ocr"})
    assert resp.status_code == 200
    data = resp.json()

    upis = [d for d in data["detections"] if d["type"] == "UPI_ID"]
    assert len(upis) >= 1
    assert any("rahul@okhdfcbank" in u["text"] for u in upis)


def test_passport_detection(client):
    text = "Passport number: A1234567."
    resp = client.post("/detect", json={"text": text, "source": "ocr"})
    data = resp.json()

    passports = [d for d in data["detections"] if d["type"] == "PASSPORT"]
    assert len(passports) == 1
    assert passports[0]["text"] == "A1234567"


def test_driving_licence_detection(client):
    text = "Driving licence: DL1420110012345."
    resp = client.post("/detect", json={"text": text, "source": "ocr"})
    data = resp.json()

    dls = [d for d in data["detections"] if d["type"] == "DRIVING_LICENCE"]
    assert len(dls) == 1
    assert "DL1420110012345" in dls[0]["text"]


def test_voter_id_detection(client):
    text = "Voter ID card EPIC: ABC1234567."
    resp = client.post("/detect", json={"text": text, "source": "ocr"})
    data = resp.json()

    voters = [d for d in data["detections"] if d["type"] == "VOTER_ID"]
    assert len(voters) == 1
    assert voters[0]["text"] == "ABC1234567"


def test_bank_account_strict_context(client):
    # With banking context: SHOULD detect
    text_with_context = "Transfer funds to Account Number: 9876543210123."
    resp1 = client.post("/detect", json={"text": text_with_context, "source": "ocr"})
    accounts = [d for d in resp1.json()["detections"] if d["type"] == "BANK_ACCOUNT"]
    assert len(accounts) == 1

    # Bare number without banking context: MUST NOT detect
    text_bare = "Item total was 9876543210123 units in catalog."
    resp2 = client.post("/detect", json={"text": text_bare, "source": "ocr"})
    accounts_bare = [d for d in resp2.json()["detections"] if d["type"] == "BANK_ACCOUNT"]
    assert len(accounts_bare) == 0


def test_gstin_detection(client):
    text = "GSTIN: 29ABCDE1234F1Z5 on invoice."
    resp = client.post("/detect", json={"text": text, "source": "ocr"})
    data = resp.json()

    gstins = [d for d in data["detections"] if d["type"] == "GSTIN"]
    assert len(gstins) == 1
    assert gstins[0]["text"] == "29ABCDE1234F1Z5"


# ── 2. False Positive Protection Tests ──

def test_false_positive_order_and_invoice_ids(client):
    """
    CRITICAL REQUIREMENT:
    Order ID, Invoice Number, Product Code, PIN Code must NOT be classified as PII.
    """
    text = "Order ID: 1234567890 Invoice Number: 1234567890 Product Code: ABCDE1234F PIN Code: 110001"
    resp = client.post("/detect", json={"text": text, "source": "ocr"})
    assert resp.status_code == 200
    data = resp.json()

    # Neither Order ID nor Invoice Number should be classified as PHONE
    phones = [d for d in data["detections"] if d["type"] == "PHONE"]
    assert len(phones) == 0, f"False positive phones detected: {phones}"

    # Product Code should NOT be classified as PAN
    pans = [d for d in data["detections"] if d["type"] == "PAN"]
    assert len(pans) == 0, f"False positive PAN detected: {pans}"

    # PIN code must not be classified as OTP or PII
    otps = [d for d in data["detections"] if d["type"] in ("OTP", "AADHAAR")]
    assert len(otps) == 0, f"False positive OTP/Aadhaar detected: {otps}"


def test_tracking_number_not_phone_or_aadhaar(client):
    text = "Tracking Number: 123456789012 shipped via courier."
    resp = client.post("/detect", json={"text": text, "source": "ocr"})
    data = resp.json()
    # The 12-digit tracking number must NOT be classified as PHONE or AADHAAR
    invalid_pii = [d for d in data["detections"] if d["type"] in ("PHONE", "AADHAAR")]
    assert len(invalid_pii) == 0, f"Tracking number incorrectly classified: {invalid_pii}"


# ── 3. Contextual NER Tests (GLiNER) ──

def test_contextual_person_and_address(client):
    text = "My name is Rahul Sharma. Deliver package to Flat 402, Green Valley Apartments, Indiranagar, Bengaluru."
    resp = client.post("/detect", json={"text": text, "source": "ocr"})
    assert resp.status_code == 200
    data = resp.json()

    persons = [d for d in data["detections"] if d["type"] == "PERSON"]
    assert len(persons) >= 1
    assert any("Rahul Sharma" in p["text"] for p in persons)

    address_or_loc = [d for d in data["detections"] if d["type"] in ("ADDRESS", "LOCATION")]
    assert len(address_or_loc) >= 1
    assert any("Bengaluru" in a["text"] or "Indiranagar" in a["text"] or "Flat 402" in a["text"] for a in address_or_loc)


# ── 4. OCR Token Span Mapping Tests ──

def test_single_line_token_mapping(client):
    text = "Rahul Sharma is here"
    tokens = [
        {"text": "Rahul", "bbox": {"x": 100, "y": 200, "width": 50, "height": 20}},
        {"text": "Sharma", "bbox": {"x": 155, "y": 200, "width": 60, "height": 20}},
        {"text": "is", "bbox": {"x": 220, "y": 200, "width": 20, "height": 20}},
        {"text": "here", "bbox": {"x": 245, "y": 200, "width": 40, "height": 20}}
    ]

    resp = client.post("/detect", json={"text": text, "tokens": tokens, "source": "ocr"})
    data = resp.json()

    person_dets = [d for d in data["detections"] if d["type"] == "PERSON"]
    assert len(person_dets) == 1
    det = person_dets[0]

    assert det["bbox"] is not None
    # Union bbox x should be min(100, 155) = 100, width = (155+60) - 100 = 115
    assert det["bbox"]["x"] == 100
    assert det["bbox"]["y"] == 200
    assert det["bbox"]["width"] == 115
    assert det["bbox"]["height"] == 20
    assert len(det["tokens"]) == 2


def test_multi_line_token_mapping_segmented_boxes(client):
    text = "Flat 402, Green Valley Apartments, Bengaluru"
    # Multi-line tokens on two distinct vertical lines: y=100 and y=160
    tokens = [
        {"text": "Flat", "bbox": {"x": 50, "y": 100, "width": 40, "height": 20}},
        {"text": "402,", "bbox": {"x": 95, "y": 100, "width": 40, "height": 20}},
        {"text": "Green", "bbox": {"x": 50, "y": 160, "width": 50, "height": 20}},
        {"text": "Valley", "bbox": {"x": 105, "y": 160, "width": 50, "height": 20}},
        {"text": "Apartments,", "bbox": {"x": 160, "y": 160, "width": 90, "height": 20}},
        {"text": "Bengaluru", "bbox": {"x": 255, "y": 160, "width": 80, "height": 20}}
    ]

    resp = client.post("/detect", json={"text": text, "tokens": tokens, "source": "ocr"})
    data = resp.json()

    addr_dets = [d for d in data["detections"] if d["type"] in ("ADDRESS", "LOCATION")]
    assert len(addr_dets) >= 1
    # Check that multi-line entities have segmented boxes
    for d in addr_dets:
        if len(d.get("tokens", [])) >= 4:
            # Must return per-line boxes to avoid blanketing space between y=100 and y=160
            assert "boxes" in d
            assert len(d["boxes"]) >= 2


# ── 5. Normalizer Offset Mapping Tests ──

def test_normalizer_offset_mapping():
    # Text with non-breaking space and Unicode
    text = "Name:\u00a0Rahul\tSharma"
    res = normalize_text(text)
    assert res.normalized_text == "Name: Rahul Sharma"

    # Span of "Rahul" in normalized text: index 6 to 11
    orig_start, orig_end = res.map_span_to_original(6, 11)
    assert text[orig_start:orig_end] == "Rahul"


def test_pan_candidate_ocr_repair():
    corrupted_pan = "ABCDE1234F"
    repaired = pan_candidate_ocr_repair(corrupted_pan)
    assert repaired == "ABCDE1234F"

    # With OCR O instead of 0 in digit section: ABCDE123OF
    corrupted_digit = "ABCDE123OF"
    repaired = pan_candidate_ocr_repair(corrupted_digit)
    assert repaired == "ABCDE1230F"
