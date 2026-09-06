"""
Privamon — Decision & Policy Fusion Engine

Reconciles evidence and candidates across Presidio, GLiNER, and deterministic rules:
- Candidate != Final PII: Detectors produce EVIDENCE / CANDIDATES.
- Computes calibrated decision_score and assigns sensitivity_class:
  - DIRECT_PII
  - PERSONAL_IDENTIFIER
  - NON_PERSONAL_IDENTIFIER
  - UNKNOWN_IDENTIFIER
- Final Decision produced per candidate:
  - REDACT
  - KEEP
  - REVIEW
- Bounded and transparent multi-signal evidence aggregation (no fake statistical independence)
- Preserves full provenance, positive/negative evidence, and structured reasoning
- Masked logging for PII privacy
"""

import json
import logging
from typing import List, Dict, Any, Tuple, Optional

from engine.context_engine import (
    evaluate_phone_candidate,
    evaluate_identifier_candidate,
    extract_bidirectional_context
)

logger = logging.getLogger("privamon.fusion")


def _sanitize_for_log(text: str, max_len: int = 8) -> str:
    """Mask PII text for safe logging: show first/last 2 chars only."""
    if len(text) <= 4:
        return "***"
    return text[:2] + "*" * min(max_len, len(text) - 4) + text[-2:]


ENTITY_TYPE_NORMALIZATION = {
    "EMAIL_ADDRESS": "EMAIL",
    "EMAIL": "EMAIL",
    "PHONE_NUMBER": "PHONE",
    "PHONE": "PHONE",
    "PHONE_CANDIDATE": "PHONE",
    "PERSON": "PERSON",
    "PER": "PERSON",
    "NAME": "PERSON",
    "LOCATION": "LOCATION",
    "LOC": "LOCATION",
    "ADDRESS": "ADDRESS",
    "ORGANIZATION": "ORGANIZATION",
    "ORG": "ORGANIZATION",
    "COMPANY": "ORGANIZATION",
    "USERNAME": "USERNAME",
    "PAN": "PAN",
    "AADHAAR": "AADHAAR",
    "CREDIT_CARD": "CREDIT_CARD",
    "IP_ADDRESS": "IP_ADDRESS",
    "UPI_ID": "UPI_ID",
    "UPI": "UPI_ID",
    "PASSPORT": "PASSPORT",
    "DRIVING_LICENCE": "DRIVING_LICENCE",
    "VOTER_ID": "VOTER_ID",
    "BANK_ACCOUNT": "BANK_ACCOUNT",
    "GSTIN": "GSTIN",
    "VEHICLE_REGISTRATION": "VEHICLE_REGISTRATION",
    "DATE_OF_BIRTH": "DATE_OF_BIRTH",
    "DATE_TIME": "DATE_TIME",
    "DOB": "DATE_OF_BIRTH",
    "EMPLOYEE ID": "EMPLOYEE_ID",
    "EMPLOYEE_ID": "EMPLOYEE_ID",
    "CUSTOMER ID": "CUSTOMER_ID",
    "CUSTOMER_ID": "CUSTOMER_ID",
    "ACCOUNT IDENTIFIER": "ACCOUNT_IDENTIFIER",
    "ACCOUNT_IDENTIFIER": "ACCOUNT_IDENTIFIER",
    "APPLICATION NUMBER": "APPLICATION_NUMBER",
    "APPLICATION_NUMBER": "APPLICATION_NUMBER",
    "REFERENCE NUMBER": "REFERENCE_NUMBER",
    "REFERENCE_NUMBER": "REFERENCE_NUMBER",
    "IDENTIFICATION NUMBER": "IDENTIFICATION_NUMBER",
    "IDENTIFICATION_NUMBER": "IDENTIFICATION_NUMBER",
    "MEMBERSHIP NUMBER": "MEMBERSHIP_NUMBER",
    "MEMBERSHIP_NUMBER": "MEMBERSHIP_NUMBER",
}

# Policy Sensitivity Classes
DIRECT_PII_TYPES = {
    "AADHAAR", "PAN", "CREDIT_CARD", "PASSPORT", "DRIVING_LICENCE",
    "VOTER_ID", "BANK_ACCOUNT", "GSTIN", "EMAIL", "PHONE",
    "PERSON", "ADDRESS", "LOCATION", "USERNAME", "DATE_OF_BIRTH",
    "UPI_ID", "IP_ADDRESS", "PASSWORD", "API_KEY", "JWT"
}

PERSONAL_IDENTIFIER_TYPES = {
    "EMPLOYEE_ID", "CUSTOMER_ID", "ACCOUNT_IDENTIFIER",
    "MEMBERSHIP_NUMBER", "PATIENT_ID", "APPLICANT_ID", "STUDENT_ID"
}

NON_PERSONAL_IDENTIFIER_TYPES = {
    "PRODUCT_ID", "SKU", "ITEM_CODE", "ORDER_ID",
    "INVOICE_ID", "TRACKING_ID", "MODEL_NO", "SERIAL_NO"
}

# Minimum decision_score required for REDACT
DECISION_THRESHOLDS = {
    "AADHAAR": 0.65,
    "PAN": 0.70,
    "EMAIL": 0.75,
    "PHONE": 0.75,
    "UPI_ID": 0.70,
    "PASSPORT": 0.80,
    "DRIVING_LICENCE": 0.75,
    "VOTER_ID": 0.70,
    "BANK_ACCOUNT": 0.80,
    "GSTIN": 0.80,
    "VEHICLE_REGISTRATION": 0.65,
    "CREDIT_CARD": 0.75,
    "IP_ADDRESS": 0.60,
    "PERSON": 0.50,
    "ADDRESS": 0.45,
    "LOCATION": 0.50,
    "ORGANIZATION": 0.55,
    "USERNAME": 0.60,
    "DATE_OF_BIRTH": 0.50,
    "EMPLOYEE_ID": 0.70,
    "CUSTOMER_ID": 0.70,
    "ACCOUNT_IDENTIFIER": 0.70,
    "MEMBERSHIP_NUMBER": 0.70,
    "DEFAULT": 0.50,
}

DETERMINISTIC_ENTITIES = {
    "PAN", "AADHAAR", "EMAIL", "CREDIT_CARD", "UPI_ID",
    "PASSPORT", "DRIVING_LICENCE", "VOTER_ID", "GSTIN",
    "BANK_ACCOUNT", "IP_ADDRESS"
}


def normalize_type(raw_type: str) -> str:
    cleaned = raw_type.upper().replace("-", "_")
    return ENTITY_TYPE_NORMALIZATION.get(cleaned, cleaned)


def evaluate_candidate(
    cand: Dict[str, Any],
    original_text: str,
    structured_context: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Evaluates raw candidate evidence through the context and policy layers.
    Determines sensitivity_class, decision_score, and final decision (REDACT/KEEP/REVIEW).
    """
    norm_type = normalize_type(cand.get("type", "OTHER"))
    raw_label = cand.get("raw_label", norm_type.lower())
    text_val = cand.get("text", "")
    start = int(cand.get("start", 0))
    end = int(cand.get("end", 0))
    model_conf = float(cand.get("confidence", 0.50))
    src = cand.get("source", "unknown")
    sources = [src] if isinstance(src, str) else list(src)
    rec_meta = cand.get("metadata", {})

    positive_evidence = []
    negative_evidence = []

    # 1. PHONE / 10-Digit candidate evaluation
    if norm_type == "PHONE":
        if "context_eval" in rec_meta:
            eval_res = rec_meta["context_eval"]
        else:
            eval_res = evaluate_phone_candidate(original_text, start, end, text_val, structured_context)

        ctx_sum = eval_res.get("context_snippet", "")
        return {
            "type": eval_res["final_type"],
            "entity_type": eval_res["final_type"],
            "sensitivity_class": eval_res["sensitivity_class"],
            "decision": eval_res["decision"],
            "text": text_val,
            "start": start,
            "end": end,
            "model_confidence": model_conf,
            "decision_score": eval_res["decision_score"],
            "confidence": eval_res["decision_score"],
            "source": sources,
            "positive_evidence": eval_res["positive_evidence"] + [f"detector:{s}" for s in sources],
            "negative_evidence": eval_res["negative_evidence"],
            "reason": eval_res["reason"],
            "context_summary": ctx_sum,
            "metadata": rec_meta
        }

    # 2. Contextual Identifier candidates (Employee ID, Customer ID, Reference Number, etc.)
    if norm_type in PERSONAL_IDENTIFIER_TYPES or norm_type in NON_PERSONAL_IDENTIFIER_TYPES or cand.get("is_candidate"):
        eval_res = evaluate_identifier_candidate(
            original_text, start, end, text_val, raw_label, model_conf, structured_context
        )
        ctx_sum = eval_res.get("context_snippet", "")
        return {
            "type": eval_res["final_type"],
            "entity_type": eval_res["final_type"],
            "sensitivity_class": eval_res["sensitivity_class"],
            "decision": eval_res["decision"],
            "text": text_val,
            "start": start,
            "end": end,
            "model_confidence": model_conf,
            "decision_score": eval_res["decision_score"],
            "confidence": eval_res["decision_score"],
            "source": sources,
            "positive_evidence": eval_res["positive_evidence"] + [f"detector:{s}" for s in sources],
            "negative_evidence": eval_res["negative_evidence"],
            "reason": eval_res["reason"],
            "context_summary": ctx_sum,
            "metadata": rec_meta
        }

    # 3. Deterministic High-Risk PII (Aadhaar, PAN, Email, Credit Card, etc.)
    if norm_type in DETERMINISTIC_ENTITIES:
        positive_evidence.append(f"deterministic_recognizer:{rec_meta.get('recognizer_name', 'presidio')}")
        positive_evidence.append(f"format_validated:{norm_type}")
        decision_score = round(max(0.85, model_conf), 4)
        thresh = DECISION_THRESHOLDS.get(norm_type, 0.70)
        decision = "REDACT" if decision_score >= thresh else "KEEP"

        ctx = extract_bidirectional_context(original_text, start, end)
        return {
            "type": norm_type,
            "entity_type": norm_type,
            "sensitivity_class": "DIRECT_PII",
            "decision": decision,
            "text": text_val,
            "start": start,
            "end": end,
            "model_confidence": model_conf,
            "decision_score": decision_score,
            "confidence": decision_score,
            "source": sources,
            "positive_evidence": positive_evidence,
            "negative_evidence": negative_evidence,
            "reason": f"High-risk deterministic PII ({norm_type}) verified",
            "context_summary": ctx["same_line"].strip(),
            "metadata": rec_meta
        }

    # 4. Semantic Contextual Entities (Person, Address, Location, Organization, Username)
    ctx = extract_bidirectional_context(original_text, start, end)
    positive_evidence.append(f"gliner_entity:{raw_label}")

    if norm_type in ("PERSON", "ADDRESS"):
        thresh = DECISION_THRESHOLDS.get(norm_type, 0.50)
        decision_score = round(model_conf, 4)
        if decision_score >= thresh:
            decision = "REDACT"
            reason = f"Contextual {norm_type} detected with high confidence ({decision_score} >= {thresh})"
        else:
            decision = "KEEP"
            reason = f"Contextual {norm_type} below confidence threshold ({decision_score} < {thresh})"

        return {
            "type": norm_type,
            "entity_type": norm_type,
            "sensitivity_class": "DIRECT_PII",
            "decision": decision,
            "text": text_val,
            "start": start,
            "end": end,
            "model_confidence": model_conf,
            "decision_score": decision_score,
            "confidence": decision_score,
            "source": sources,
            "positive_evidence": positive_evidence,
            "negative_evidence": negative_evidence,
            "reason": reason,
            "context_summary": ctx["same_line"].strip(),
            "metadata": rec_meta
        }

    # Default / Other Entities
    thresh = DECISION_THRESHOLDS.get(norm_type, DECISION_THRESHOLDS["DEFAULT"])
    decision_score = round(model_conf, 4)
    decision = "REDACT" if decision_score >= thresh else "KEEP"

    return {
        "type": norm_type,
        "entity_type": norm_type,
        "sensitivity_class": "DIRECT_PII" if norm_type in DIRECT_PII_TYPES else "UNKNOWN_IDENTIFIER",
        "decision": decision,
        "text": text_val,
        "start": start,
        "end": end,
        "model_confidence": model_conf,
        "decision_score": decision_score,
        "confidence": decision_score,
        "source": sources,
        "positive_evidence": positive_evidence,
        "negative_evidence": negative_evidence,
        "reason": f"Entity {norm_type} threshold evaluation ({decision_score} vs {thresh})",
        "context_summary": ctx["same_line"].strip(),
        "metadata": rec_meta
    }


def fuse_detections(
    raw_detections: List[Dict[str, Any]],
    original_text: str,
    structured_context: Optional[Dict[str, Any]] = None
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Fuses raw detections into evaluated candidates with explicit REDACT / KEEP / REVIEW decisions.
    Resolves span conflicts with deterministic precedence.
    Returns (all_candidates_with_decisions, discard_log).
    """
    discard_log = []
    evaluated_candidates = []

    # Step 1: Evaluate each candidate independently through context & policy
    for raw in raw_detections:
        evaluated = evaluate_candidate(raw, original_text, structured_context)
        evaluated_candidates.append(evaluated)

    # Step 2: Sort primarily by start position, then descending by decision_score
    evaluated_candidates.sort(key=lambda x: (x["start"], -x["decision_score"]))

    # Step 3: Span-level overlap reconciliation & conflict resolution
    fused: List[Dict[str, Any]] = []

    for current in evaluated_candidates:
        merged = False

        for existing in fused:
            overlap_start = max(current["start"], existing["start"])
            overlap_end = min(current["end"], existing["end"])

            if overlap_start < overlap_end:
                # Spans overlap!
                merged = True

                # Case A: Same entity type -> merge span, combine evidence, take maximum decision score
                if current["type"] == existing["type"]:
                    candidate_start = min(existing["start"], current["start"])
                    candidate_end = max(existing["end"], current["end"])
                    candidate_text = original_text[candidate_start:candidate_end]

                    if "\n" in candidate_text and current["type"] not in ("ADDRESS", "LOCATION"):
                        if current["decision_score"] > existing["decision_score"]:
                            existing.update(current)
                    else:
                        existing["start"] = candidate_start
                        existing["end"] = candidate_end
                        existing["text"] = candidate_text
                        existing["decision_score"] = round(max(existing["decision_score"], current["decision_score"]), 4)
                        existing["confidence"] = existing["decision_score"]
                        # Evidence accumulation
                        for ev in current["positive_evidence"]:
                            if ev not in existing["positive_evidence"]:
                                existing["positive_evidence"].append(ev)
                        for ev in current["negative_evidence"]:
                            if ev not in existing["negative_evidence"]:
                                existing["negative_evidence"].append(ev)
                        for s in current["source"]:
                            if s not in existing["source"]:
                                existing["source"].append(s)
                        if current["decision"] == "REDACT":
                            existing["decision"] = "REDACT"
                    break

                # Case B: Deterministic entity vs Contextual entity conflict
                is_curr_det = current["type"] in DETERMINISTIC_ENTITIES
                is_exist_det = existing["type"] in DETERMINISTIC_ENTITIES

                if is_exist_det and not is_curr_det:
                    discard_entry = {
                        "stage": "fusion",
                        "action": "discard",
                        "entity": current["type"],
                        "text": _sanitize_for_log(current["text"]),
                        "decision": "DISCARDED",
                        "reason": f"shadowed_by_{existing['type']}"
                    }
                    discard_log.append(discard_entry)
                    logger.info(json.dumps(discard_entry))
                    break

                elif is_curr_det and not is_exist_det:
                    discard_entry = {
                        "stage": "fusion",
                        "action": "discard",
                        "entity": existing["type"],
                        "text": _sanitize_for_log(existing["text"]),
                        "decision": "DISCARDED",
                        "reason": f"shadowed_by_{current['type']}"
                    }
                    discard_log.append(discard_entry)
                    logger.info(json.dumps(discard_entry))
                    existing.update(current)
                    break

                else:
                    # Both same priority: higher decision_score wins
                    if current["decision_score"] > existing["decision_score"]:
                        discard_entry = {
                            "stage": "fusion",
                            "action": "discard",
                            "entity": existing["type"],
                            "text": _sanitize_for_log(existing["text"]),
                            "decision": "DISCARDED",
                            "reason": f"lower_decision_score_than_{current['type']}"
                        }
                        discard_log.append(discard_entry)
                        logger.info(json.dumps(discard_entry))
                        existing.update(current)
                    else:
                        discard_entry = {
                            "stage": "fusion",
                            "action": "discard",
                            "entity": current["type"],
                            "text": _sanitize_for_log(current["text"]),
                            "decision": "DISCARDED",
                            "reason": f"lower_decision_score_than_{existing['type']}"
                        }
                        discard_log.append(discard_entry)
                        logger.info(json.dumps(discard_entry))
                    break

        if not merged:
            fused.append(current)

    # Step 4: Final strip and formatting
    final_results = []
    for item in fused:
        txt = item["text"]
        stripped = txt.strip(" \t\r\n:,;.-")
        if not stripped or len(stripped) < 2:
            continue
        if stripped != txt:
            lead = len(txt) - len(txt.lstrip(" \t\r\n:,;.-"))
            item["start"] += lead
            item["end"] = item["start"] + len(stripped)
            item["text"] = stripped

        final_results.append(item)

    return final_results, discard_log
