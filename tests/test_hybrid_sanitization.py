"""
Tests for Privamon High-Confidence Hybrid PII Sanitization Pipeline.

Validates the architecture rules:
1. Candidate != Final PII (Detectors produce candidates/evidence; Fusion Engine produces REDACT/KEEP/REVIEW)
2. Sensitivity class separation (entity_type, sensitivity_class, decision)
3. Bidirectional context & Phone decision engine (Mobile vs Order ID vs bare 10-digit number)
4. Configurable Personal Identifiers (Employee ID -> REDACT vs Product ID -> KEEP)
5. Semantic entities & Addresses
6. Diagnostics validation (positive/negative evidence, reason, decision_score)
7. Competing Identifiers image & redaction invariant test
"""

import os
import sys
import pytest

# Add project root to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from engine.context_engine import (
    extract_bidirectional_context,
    evaluate_phone_candidate,
    evaluate_identifier_candidate,
)
from engine.presidio_detector import PresidioDetector
from engine.gliner_detector import GLiNERDetector
from engine.fusion_engine import fuse_detections


@pytest.fixture(scope="module")
def presidio():
    """Initializes and returns the Presidio detector."""
    return PresidioDetector()


@pytest.fixture(scope="module")
def gliner():
    """Initializes and returns the singleton GLiNER detector."""
    return GLiNERDetector.get_instance()


# ==============================================================================
# 1. PHONE NUMBER CONTEXTUAL DECISION MATRIX
# ==============================================================================

def test_phone_with_explicit_mobile_label(presidio):
    """Mobile: 9876543210 -> candidate PHONE, positive evidence, decision REDACT."""
    text = "Mobile: 9876543210"
    candidates = presidio.detect(text)
    fused, _ = fuse_detections(candidates, text)
    
    phone_items = [d for d in fused if d["entity_type"] == "PHONE"]
    assert len(phone_items) == 1, f"Expected 1 PHONE item, got {phone_items}"
    assert phone_items[0]["decision"] == "REDACT"
    assert any("mobile" in ev for ev in phone_items[0]["positive_evidence"])
    assert phone_items[0]["decision_score"] >= 0.75


def test_phone_with_international_prefix(presidio):
    """Phone Number: +91 9876543210 -> decision REDACT."""
    text = "Phone Number: +91 9876543210"
    candidates = presidio.detect(text)
    fused, _ = fuse_detections(candidates, text)
    
    phone_items = [d for d in fused if d["entity_type"] == "PHONE"]
    assert len(phone_items) == 1
    assert phone_items[0]["decision"] == "REDACT"


def test_phone_with_whatsapp_context(presidio):
    """WhatsApp: 9876543210 -> decision REDACT."""
    text = "WhatsApp: 9876543210"
    candidates = presidio.detect(text)
    fused, _ = fuse_detections(candidates, text)
    
    phone_items = [d for d in fused if d["entity_type"] == "PHONE"]
    assert len(phone_items) == 1
    assert phone_items[0]["decision"] == "REDACT"


def test_order_id_must_not_be_phone_redact(presidio):
    """Order ID: 9876543210 -> Must NOT be classified as final PHONE or REDACT."""
    text = "Order ID: 9876543210"
    candidates = presidio.detect(text)
    fused, _ = fuse_detections(candidates, text)
    
    # Check that no item is REDACT as PHONE
    phone_redacts = [d for d in fused if d["entity_type"] == "PHONE" and d["decision"] == "REDACT"]
    assert len(phone_redacts) == 0, f"Order ID was incorrectly redacted as phone: {phone_redacts}"
    
    # If any candidate was produced, decision must be KEEP with negative commercial evidence
    for d in fused:
        if "9876543210" in text[d["start"]:d["end"]]:
            assert d["decision"] == "KEEP"
            assert any("order" in ev or "commercial" in ev for ev in d["negative_evidence"])


def test_invoice_number_must_be_kept(presidio):
    """Invoice Number: 9876543210 -> KEEP."""
    text = "Invoice Number: 9876543210"
    candidates = presidio.detect(text)
    fused, _ = fuse_detections(candidates, text)
    
    phone_redacts = [d for d in fused if d["entity_type"] == "PHONE" and d["decision"] == "REDACT"]
    assert len(phone_redacts) == 0


def test_bare_ten_digit_number_no_context(presidio):
    """9876543210 with no context -> REVIEW or KEEP (not automatic high-confidence REDACT)."""
    text = "9876543210"
    candidates = presidio.detect(text)
    fused, _ = fuse_detections(candidates, text)
    
    for d in fused:
        if d["entity_type"] == "PHONE":
            assert d["decision"] in ["REVIEW", "KEEP"], (
                f"Isolated 10-digit number without context must NOT be automatic REDACT: {d}"
            )


# ==============================================================================
# 2. BIDIRECTIONAL CONTEXT TESTS
# ==============================================================================

def test_bidirectional_context_following_line_positive():
    """Number:\n9876543210\nMobile contact -> positive evidence from following line."""
    text = "Number:\n9876543210\nMobile contact"
    start = text.index("9876543210")
    end = start + len("9876543210")
    
    eval_res = evaluate_phone_candidate(text, start, end, "9876543210")
    assert eval_res["decision"] == "REDACT"
    assert any("mobile" in ev or "phone_keyword" in ev for ev in eval_res["positive_evidence"])


def test_bidirectional_context_following_line_negative():
    """Identifier:\n9876543210\nEmployee ID -> negative phone evidence from following line."""
    text = "Identifier:\n9876543210\nEmployee ID"
    start = text.index("9876543210")
    end = start + len("9876543210")
    
    eval_res = evaluate_phone_candidate(text, start, end, "9876543210")
    assert any("identifier" in ev for ev in eval_res["negative_evidence"])
    assert eval_res["decision"] != "REDACT"


# ==============================================================================
# 3. PERSONAL IDENTIFIERS VS PRODUCT IDENTIFIERS
# ==============================================================================

def test_employee_id_vs_product_id(presidio, gliner):
    """
    Employee ID: XJ729184 -> PERSONAL_IDENTIFIER -> REDACT under policy.
    Product ID: XJ729184 -> NON_PERSONAL_IDENTIFIER -> KEEP.
    """
    emp_text = "Employee ID: XJ729184"
    prod_text = "Product ID: XJ729184"
    
    # 1. Employee ID
    emp_cand = presidio.detect(emp_text) + gliner.detect(emp_text)
    emp_fused, _ = fuse_detections(emp_cand, emp_text)
    
    emp_items = [d for d in emp_fused if "XJ729184" in emp_text[d["start"]:d["end"]]]
    assert len(emp_items) >= 1
    assert emp_items[0]["decision"] == "REDACT"
    assert emp_items[0]["sensitivity_class"] == "PERSONAL_IDENTIFIER"
    
    # 2. Product ID
    prod_cand = presidio.detect(prod_text) + gliner.detect(prod_text)
    prod_fused, _ = fuse_detections(prod_cand, prod_text)
    
    prod_items = [d for d in prod_fused if "XJ729184" in prod_text[d["start"]:d["end"]]]
    if prod_items:
        assert prod_items[0]["decision"] == "KEEP"
        assert prod_items[0]["sensitivity_class"] == "NON_PERSONAL_IDENTIFIER"


def test_customer_id_vs_tracking_id(presidio, gliner):
    """
    Customer ID: CUST-9921 -> PERSONAL_IDENTIFIER -> REDACT.
    Tracking ID: TRK-9921 -> NON_PERSONAL_IDENTIFIER -> KEEP.
    """
    cust_text = "Customer ID: CUST-9921"
    trk_text = "Tracking ID: TRK-9921"
    
    c_cand = presidio.detect(cust_text) + gliner.detect(cust_text)
    c_fused, _ = fuse_detections(c_cand, cust_text)
    c_items = [d for d in c_fused if "CUST-9921" in cust_text[d["start"]:d["end"]]]
    assert len(c_items) >= 1
    assert c_items[0]["decision"] == "REDACT"
    assert c_items[0]["sensitivity_class"] == "PERSONAL_IDENTIFIER"
    
    t_cand = presidio.detect(trk_text) + gliner.detect(trk_text)
    t_fused, _ = fuse_detections(t_cand, trk_text)
    t_items = [d for d in t_fused if "TRK-9921" in trk_text[d["start"]:d["end"]]]
    if t_items:
        assert t_items[0]["decision"] == "KEEP"


# ==============================================================================
# 4. SEMANTIC ENTITIES (PERSON, ADDRESS, LOCATION)
# ==============================================================================

def test_person_name_with_context(presidio, gliner):
    """Name: Riya Sharma -> entity PERSON, decision REDACT."""
    text = "Name: Riya Sharma"
    candidates = presidio.detect(text) + gliner.detect(text)
    fused, _ = fuse_detections(candidates, text)
    
    person_items = [d for d in fused if "Riya Sharma" in text[d["start"]:d["end"]]]
    assert len(person_items) >= 1
    assert person_items[0]["decision"] == "REDACT"
    assert person_items[0]["entity_type"] in ["PERSON", "NAME"]


def test_address_with_context(presidio, gliner):
    """Address: 456 Green Park, New Delhi, 110016 -> decision REDACT."""
    text = "Address: 456 Green Park, New Delhi, 110016"
    candidates = presidio.detect(text) + gliner.detect(text)
    fused, _ = fuse_detections(candidates, text)
    
    redacts = [d for d in fused if d["decision"] == "REDACT"]
    assert len(redacts) >= 1, f"Address was not redacted: {fused}"


# ==============================================================================
# 5. DIAGNOSTICS & REDACTION INVARIANT
# ==============================================================================

def test_diagnostics_structure(presidio):
    """Every candidate must expose diagnostics fields."""
    text = "Contact: 9876543210"
    candidates = presidio.detect(text)
    fused, _ = fuse_detections(candidates, text)
    
    assert len(fused) > 0
    for d in fused:
        assert "entity_type" in d
        assert "decision" in d
        assert d["decision"] in ["REDACT", "KEEP", "REVIEW"]
        assert "sensitivity_class" in d
        assert "decision_score" in d
        assert "positive_evidence" in d
        assert "negative_evidence" in d
        assert "reason" in d
        assert isinstance(d["positive_evidence"], list)
        assert isinstance(d["negative_evidence"], list)


# ==============================================================================
# 6. COMPETING IDENTIFIERS SYNTHETIC IMAGE TEST (SECTION 17)
# ==============================================================================

def test_competing_identifiers_synthetic_dataset(presidio, gliner):
    """
    Test Section 17 full competing identifiers case:
    Name: Riya Sharma
    Mobile: 9876543210
    Order ID: 9876543210
    Employee ID: XJ729184
    Product ID: XJ729184
    Email: riya@example.com
    Address: 456 Green Park, New Delhi

    Expected decisions:
    - Riya Sharma          -> REDACT
    - Mobile: 9876543210   -> REDACT
    - Order ID: 9876543210 -> KEEP
    - Employee ID: XJ729184-> REDACT
    - Product ID: XJ729184 -> KEEP
    - Email: riya@example.com -> REDACT
    - Address              -> REDACT
    """
    lines = [
        "Name: Riya Sharma",
        "Mobile: 9876543210",
        "Order ID: 9876543210",
        "Employee ID: XJ729184",
        "Product ID: XJ729184",
        "Email: riya@example.com",
        "Address: 456 Green Park, New Delhi",
    ]
    full_text = "\n".join(lines)
    
    candidates = presidio.detect(full_text) + gliner.detect(full_text)
    fused, _ = fuse_detections(candidates, full_text)
    
    decisions_by_snippet = {}
    for d in fused:
        snippet = full_text[d["start"]:d["end"]]
        decisions_by_snippet[snippet] = d["decision"]
    
    # 1. Riya Sharma -> REDACT
    riya_decisions = [d["decision"] for d in fused if "Riya Sharma" in full_text[d["start"]:d["end"]]]
    assert "REDACT" in riya_decisions, f"Riya Sharma not redacted: {fused}"
    
    # 2. Mobile 9876543210 -> REDACT
    mobile_line = "Mobile: 9876543210"
    mobile_offset = full_text.index(mobile_line)
    mobile_cands = [d for d in fused if d["start"] >= mobile_offset and d["end"] <= mobile_offset + len(mobile_line)]
    assert any(d["decision"] == "REDACT" for d in mobile_cands), f"Mobile number was not redacted: {mobile_cands}"
    
    # 3. Order ID 9876543210 -> KEEP (must not be redacted as phone)
    order_line = "Order ID: 9876543210"
    order_offset = full_text.index(order_line)
    order_cands = [d for d in fused if d["start"] >= order_offset and d["end"] <= order_offset + len(order_line)]
    for d in order_cands:
        assert d["decision"] != "REDACT", f"Order ID was incorrectly redacted: {d}"
    
    # 4. Employee ID XJ729184 -> REDACT
    emp_line = "Employee ID: XJ729184"
    emp_offset = full_text.index(emp_line)
    emp_cands = [d for d in fused if d["start"] >= emp_offset and d["end"] <= emp_offset + len(emp_line)]
    assert any(d["decision"] == "REDACT" for d in emp_cands), f"Employee ID was not redacted: {emp_cands}"
    
    # 5. Product ID XJ729184 -> KEEP
    prod_line = "Product ID: XJ729184"
    prod_offset = full_text.index(prod_line)
    prod_cands = [d for d in fused if d["start"] >= prod_offset and d["end"] <= prod_offset + len(prod_line)]
    for d in prod_cands:
        assert d["decision"] != "REDACT", f"Product ID was incorrectly redacted: {d}"
        
    # 6. Email riya@example.com -> REDACT
    email_line = "Email: riya@example.com"
    email_offset = full_text.index(email_line)
    email_cands = [d for d in fused if d["start"] >= email_offset and d["end"] <= email_offset + len(email_line)]
    assert any(d["decision"] == "REDACT" for d in email_cands), f"Email was not redacted: {email_cands}"
    
    # 7. Redactor invariant: only decision == "REDACT" are redacted
    redactions = [d for d in fused if d["decision"] == "REDACT"]
    for r in redactions:
        # Verify no product or order ID leaked into redactions
        r_text = full_text[r["start"]:r["end"]]
        assert "Product ID" not in r_text
        assert "Order ID" not in r_text
