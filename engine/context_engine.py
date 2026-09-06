"""
Privamon — Bidirectional Context Engine

Evaluates candidates using bidirectional contextual evidence:
- Preceding and following text windows
- Same line and adjacent lines
- Structured DOM metadata (label, placeholder, name, id, autocomplete, aria-label)
- Structured OCR token neighbors

Produces:
- positive_evidence (list of detected supporting signals)
- negative_evidence (list of detected contradicting/suppressing signals)
- evidence_score (aggregated multi-signal score)
- decision_score (calibrated policy score in [0.0, 1.0])
- sensitivity_class (DIRECT_PII, PERSONAL_IDENTIFIER, NON_PERSONAL_IDENTIFIER, UNKNOWN_IDENTIFIER)
- decision (REDACT, KEEP, REVIEW)
- reason (human-readable explanation)
"""

import re
from typing import Dict, Any, List, Optional, Tuple

# ── Positive Keyword Dictionaries ──
PHONE_POSITIVE_KEYWORDS = [
    r"\bmobile\b", r"\bphone\b", r"\btelephone\b", r"\bcontact(?:\s+number|\s+no)?\b",
    r"\bcall\b", r"\bwhatsapp\b", r"\bcell\b", r"\btel\b", r"\bmob\b",
    r"\breach\s+(?:me|us)\s+at\b", r"\bph\b", r"\bcontact\b",
    r"मोबाइल", r"फ़ोन", r"फोन", r"सम्पर्क", r"संपर्क", r"कॉल"
]

PERSON_POSITIVE_KEYWORDS = [
    r"\bname\b", r"\bfull\s*name\b", r"\bfirst\s*name\b", r"\blast\s*name\b",
    r"\bpatient\b", r"\bcandidate\b", r"\bemployee\b", r"\bdoctor\b", r"\bdr\b",
    r"\bmr\b", r"\bmrs\b", r"\bms\b", r"\buser\b", r"\bapplicant\b",
    r"नाम", r"श्री", r"श्रीमती"
]

ADDRESS_POSITIVE_KEYWORDS = [
    r"\baddress\b", r"\bresidence\b", r"\bflat\b", r"\bhouse\b", r"\bstreet\b",
    r"\broad\b", r"\bsector\b", r"\bblock\b", r"\bcity\b", r"\bstate\b",
    r"\bpincode\b", r"\bpin\s*code\b", r"\bzip\b", r"\bdeliver(?:\s+to)?\b",
    r"\bshipping\s+address\b", r"\bbilling\s+address\b",
    r"पता", r"स्थान", r"सेक्टर", r"शहर", r"फरीदाबाद", r"दिल्ली"
]

# Personal identifier indicators (linked to a human being)
PERSONAL_ID_KEYWORDS = [
    r"\bemployee\s*(?:id|#|no|num|number|code)?\b",
    r"\bcustomer\s*(?:id|#|no|num|number|code)?\b",
    r"\bpatient\s*(?:id|#|no|num|number|code)?\b",
    r"\bmember\s*(?:id|#|no|num|number|code)?\b",
    r"\bmembership\s*(?:id|#|no|num|number|code)?\b",
    r"\bapplicant\s*(?:id|#|no|num|number|code)?\b",
    r"\bcandidate\s*(?:id|#|no|num|number|code)?\b",
    r"\buser\s*(?:id|#|no|num|number|code|name)?\b",
    r"\baccount\s*holder\b",
    r"\broll\s*(?:no|number|num)?\b",
    r"\bstudent\s*(?:id|#|no|num)?\b",
]

# Commercial / Non-personal identifier indicators (orders, catalog, goods)
COMMERCIAL_NON_PERSONAL_KEYWORDS = [
    r"\border\s*(?:id|#|no|num|number)?\b",
    r"\binvoice\s*(?:id|#|no|num|number)?\b",
    r"\bproduct\s*(?:code|id|#|no|num)?\b",
    r"\bsku\b",
    r"\bitem\s*(?:code|id|#|no)?\b",
    r"\bmodel\s*(?:no|num|number)?\b",
    r"\bserial\s*(?:no|num|number)?\b",
    r"\btracking\s*(?:id|#|no|num|number)?\b",
    r"\bwaybill\b", r"\bawb\b",
    r"\bshipment\s*(?:id|#|no|num)?\b",
    r"\bpart\s*(?:no|num|number)?\b",
    r"\bcatalog\s*(?:id|#|no)?\b",
]

# Ambiguous reference / transaction keywords (need careful context)
AMBIGUOUS_ID_KEYWORDS = [
    r"\breference\s*(?:id|#|no|num|number)?\b",
    r"\bref\s*(?:id|#|no|num|number)?\b",
    r"\bticket\s*(?:id|#|no|num|number)?\b",
    r"\bcase\s*(?:id|#|no|num|number)?\b",
    r"\bbooking\s*(?:id|#|no|num|number)?\b",
    r"\btransaction\s*(?:id|#|no|num|number)?\b",
    r"\btxn\s*(?:id|#|no|num)?\b",
    r"\butr\b",
    r"\bpnr\b",
]

_PHONE_POS_RE = re.compile("|".join(PHONE_POSITIVE_KEYWORDS), re.IGNORECASE)
_PERSONAL_ID_RE = re.compile("|".join(PERSONAL_ID_KEYWORDS), re.IGNORECASE)
_COMMERCIAL_RE = re.compile("|".join(COMMERCIAL_NON_PERSONAL_KEYWORDS), re.IGNORECASE)
_AMBIGUOUS_ID_RE = re.compile("|".join(AMBIGUOUS_ID_KEYWORDS), re.IGNORECASE)


def extract_bidirectional_context(
    text: str,
    start: int,
    end: int,
    lookback_chars: int = 60,
    lookahead_chars: int = 60
) -> Dict[str, str]:
    """
    Extracts preceding context, following context, same-line context,
    and previous/next line context around a character span.
    """
    preceding = text[max(0, start - lookback_chars):start]
    following = text[end:min(len(text), end + lookahead_chars)]

    # Determine line boundaries
    line_start = text.rfind('\n', 0, start)
    line_start = 0 if line_start == -1 else line_start + 1

    line_end = text.find('\n', end)
    line_end = len(text) if line_end == -1 else line_end

    same_line = text[line_start:line_end]

    # Preceding line
    prev_line = ""
    if line_start > 1:
        p_start = text.rfind('\n', 0, line_start - 1)
        p_start = 0 if p_start == -1 else p_start + 1
        prev_line = text[p_start:line_start - 1]

    # Following line
    next_line = ""
    if line_end < len(text):
        n_end = text.find('\n', line_end + 1)
        n_end = len(text) if n_end == -1 else n_end
        next_line = text[line_end + 1:n_end]

    return {
        "preceding": preceding,
        "following": following,
        "same_line": same_line,
        "prev_line": prev_line,
        "next_line": next_line,
        "combined_window": f"{prev_line} {same_line} {next_line}".strip()
    }


def evaluate_phone_candidate(
    text: str,
    start: int,
    end: int,
    match_str: str,
    structured_context: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Evaluates a candidate 10-digit/phone match with bidirectional context.
    Computes decision_score and returns REDACT, KEEP, or REVIEW.
    """
    ctx = extract_bidirectional_context(text, start, end)
    search_scope = f"{ctx['preceding']} {ctx['following']} {ctx['same_line']} {ctx['prev_line']} {ctx['next_line']}"
    
    if structured_context:
        dom_ctx = " ".join(filter(None, [
            structured_context.get("label"),
            structured_context.get("placeholder"),
            structured_context.get("name"),
            structured_context.get("id"),
            structured_context.get("autocomplete"),
            structured_context.get("aria_label"),
            structured_context.get("nearby_text"),
        ]))
        search_scope = f"{search_scope} {dom_ctx}"

    positive_evidence = []
    negative_evidence = []
    score = 0.45  # Base score for valid 10-digit Indian phone pattern

    clean_match = match_str.strip()
    digits = re.sub(r"\D", "", clean_match)

    # 1. Format-level evidence
    if clean_match.startswith("+91") or clean_match.startswith("+"):
        positive_evidence.append("international_country_code")
        score += 0.30
    elif clean_match.startswith("0") and len(digits) == 11:
        positive_evidence.append("domestic_std_prefix")
        score += 0.15
    else:
        positive_evidence.append("ten_digit_pattern")

    # 2. Contextual Evidence Scope: Same Line vs Adjacent Lines
    same_line = ctx["same_line"]
    has_same_line_phone = bool(_PHONE_POS_RE.search(same_line))
    has_dom_phone = False
    if structured_context:
        dom_text = " ".join(filter(None, [
            structured_context.get("label"),
            structured_context.get("placeholder"),
            structured_context.get("name"),
            structured_context.get("id"),
            structured_context.get("aria_label"),
        ]))
        has_dom_phone = bool(_PHONE_POS_RE.search(dom_text))

    has_explicit_phone_context = has_same_line_phone or has_dom_phone

    # Positive context matching
    pos_match_same_line = _PHONE_POS_RE.search(same_line)
    pos_match_adj = _PHONE_POS_RE.search(f"{ctx['prev_line']} {ctx['next_line']}") if not has_explicit_phone_context else None
    pos_match = pos_match_same_line or pos_match_adj
    if pos_match:
        matched_word = pos_match.group(0).lower()
        positive_evidence.append(f"phone_keyword:{matched_word}")
        if any(w in matched_word for w in ["mobile", "phone", "whatsapp", "call", "contact", "मोबाइल", "फ़ोन", "फोन", "सम्पर्क", "संपर्क"]):
            score += 0.40
        else:
            score += 0.25

    # Autocomplete / DOM attribute evidence
    if structured_context:
        ac = (structured_context.get("autocomplete") or "").lower()
        inp_type = (structured_context.get("type") or "").lower()
        if ac == "tel" or inp_type == "tel":
            positive_evidence.append("dom_tel_attribute")
            score += 0.40

    # 3. Negative Contextual Evidence (Commercial / Identifier context)
    # Direct same-line check: e.g. "Order ID: 9876543210" or "Invoice Number: 9876543210"
    comm_match_same_line = _COMMERCIAL_RE.search(same_line)
    pers_id_match_same_line = _PERSONAL_ID_RE.search(same_line)
    ambig_match_same_line = _AMBIGUOUS_ID_RE.search(same_line)

    # Adjacent line check: ONLY when the candidate does NOT have an explicit same-line phone label.
    # (prevents an 'Order ID' or 'Employee ID' on an adjacent row from suppressing a real 'Mobile:' field)
    comm_match_adj = None
    pers_id_match_adj = None
    ambig_match_adj = None
    if not has_explicit_phone_context:
        adj_scope = f"{ctx['prev_line']} {ctx['next_line']}"
        comm_match_adj = _COMMERCIAL_RE.search(adj_scope)
        pers_id_match_adj = _PERSONAL_ID_RE.search(adj_scope)
        ambig_match_adj = _AMBIGUOUS_ID_RE.search(adj_scope)

    comm_match = comm_match_same_line or comm_match_adj
    if comm_match:
        matched_comm = comm_match.group(0).strip()
        negative_evidence.append(f"commercial_keyword:{matched_comm}")
        score -= 0.65

    pers_id_match = pers_id_match_same_line or pers_id_match_adj
    if pers_id_match:
        matched_pid = pers_id_match.group(0).strip()
        negative_evidence.append(f"identifier_keyword:{matched_pid}")
        score -= 0.55

    ambig_match = ambig_match_same_line or ambig_match_adj
    if ambig_match:
        matched_ambig = ambig_match.group(0).strip()
        negative_evidence.append(f"ambiguous_id_keyword:{matched_ambig}")
        score -= 0.45

    # Lookback delimiter check on same line (e.g. "ID: 9876543210" or "#9876543210")
    preceding_snippet = ctx["preceding"].strip()
    if re.search(r"[:#\-]\s*$", preceding_snippet) and (comm_match or pers_id_match or ambig_match):
        negative_evidence.append("preceded_by_identifier_delimiter")
        score -= 0.15

    # Clamp decision_score
    decision_score = round(max(0.0, min(1.0, score)), 4)

    # Decision logic
    if comm_match and not any("phone_keyword" in e or "dom_tel_attribute" in e for e in positive_evidence):
        decision = "KEEP"
        matched_str = comm_match.group(0).lower()
        if "order" in matched_str:
            final_type = "ORDER_ID"
        elif "invoice" in matched_str:
            final_type = "INVOICE_NUMBER"
        elif "product" in matched_str or "sku" in matched_str:
            final_type = "PRODUCT_ID"
        elif "tracking" in matched_str or "shipment" in matched_str:
            final_type = "TRACKING_NUMBER"
        else:
            final_type = "COMMERCIAL_ID"
        sensitivity_class = "NON_PERSONAL_IDENTIFIER"
        reason = f"Suppressed as phone by commercial context ({final_type}): {', '.join(negative_evidence)}"
    elif pers_id_match_same_line and not any("phone_keyword" in e or "dom_tel_attribute" in e for e in positive_evidence):
        matched_str = pers_id_match_same_line.group(0).lower()
        if "employee" in matched_str:
            final_type = "EMPLOYEE_ID"
        elif "customer" in matched_str:
            final_type = "CUSTOMER_ID"
        else:
            final_type = "PERSONAL_IDENTIFIER"
        decision = "REDACT"
        sensitivity_class = "PERSONAL_IDENTIFIER"
        reason = f"Reclassified from phone to personal identifier ({final_type}) by context"
    elif negative_evidence and not any("phone_keyword" in e or "dom_tel_attribute" in e for e in positive_evidence):
        decision = "KEEP"
        final_type = "NUMERIC_IDENTIFIER"
        sensitivity_class = "NON_PERSONAL_IDENTIFIER"
        reason = f"Suppressed as phone by identifier context: {', '.join(negative_evidence)}"
    elif decision_score >= 0.75:
        decision = "REDACT"
        final_type = "PHONE"
        sensitivity_class = "DIRECT_PII"
        reason = f"Confirmed phone number with strong context (score={decision_score})"
    elif decision_score <= 0.40:
        decision = "KEEP"
        final_type = "NUMERIC_IDENTIFIER"
        sensitivity_class = "NON_PERSONAL_IDENTIFIER"
        reason = f"Insufficient phone evidence; negative context present (score={decision_score})"
    else:
        # 0.40 < decision_score < 0.75 without strong positive keyword
        decision = "REVIEW"
        final_type = "NUMERIC_IDENTIFIER"
        sensitivity_class = "AMBIGUOUS_IDENTIFIER"
        reason = f"Bare 10-digit number without explicit phone context; flagged for review (score={decision_score})"

    return {
        "candidate_type": "PHONE_CANDIDATE",
        "final_type": final_type,
        "sensitivity_class": sensitivity_class,
        "decision_score": decision_score,
        "decision": decision,
        "positive_evidence": positive_evidence,
        "negative_evidence": negative_evidence,
        "reason": reason,
        "context_snippet": ctx["same_line"].strip()
    }


def evaluate_identifier_candidate(
    text: str,
    start: int,
    end: int,
    match_str: str,
    raw_label: str,
    model_confidence: float = 0.50,
    structured_context: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Evaluates contextual identifier candidates (e.g. Employee ID, Product ID, Order ID).
    Classifies into sensitivity_class and decides REDACT vs KEEP vs REVIEW.
    """
    ctx = extract_bidirectional_context(text, start, end)
    same_line = ctx["same_line"]
    dom_ctx = ""
    if structured_context:
        dom_ctx = " ".join(filter(None, [
            structured_context.get("label"),
            structured_context.get("placeholder"),
            structured_context.get("name"),
            structured_context.get("id"),
            structured_context.get("nearby_text"),
        ]))
    primary_scope = f"{same_line} {dom_ctx}".strip()

    positive_evidence = [f"gliner_label:{raw_label}"]
    negative_evidence = []
    norm_label = raw_label.lower().replace("_", " ")

    # 1. Primary scope check (exact same-line / DOM field provenance)
    comm_primary = _COMMERCIAL_RE.search(primary_scope)
    pers_primary = _PERSONAL_ID_RE.search(primary_scope)

    if comm_primary and not pers_primary:
        matched_kw = comm_primary.group(0).strip()
        sensitivity_class = "NON_PERSONAL_IDENTIFIER"
        decision = "KEEP"
        negative_evidence.append(f"commercial_context:{matched_kw}")
        reason = f"Commercial identifier context ({matched_kw}); non-personal under policy"
        decision_score = round(max(0.10, 1.0 - model_confidence), 4)
        final_type = (
            "PRODUCT_ID" if "product" in matched_kw.lower() or "sku" in matched_kw.lower()
            else ("ORDER_ID" if "order" in matched_kw.lower()
            else ("INVOICE_NUMBER" if "invoice" in matched_kw.lower()
            else "COMMERCIAL_ID"))
        )

    elif pers_primary:
        matched_kw = pers_primary.group(0).strip()
        sensitivity_class = "PERSONAL_IDENTIFIER"
        decision = "REDACT"
        positive_evidence.append(f"personal_context:{matched_kw}")
        reason = f"Personal identifier context ({matched_kw}); sensitive under policy"
        decision_score = round(max(0.80, model_confidence), 4)
        final_type = (
            "EMPLOYEE_ID" if "employee" in matched_kw.lower()
            else ("CUSTOMER_ID" if "customer" in matched_kw.lower()
            else ("PATIENT_ID" if "patient" in matched_kw.lower()
            else ("MEMBER_ID" if "member" in matched_kw.lower()
            else "PERSONAL_IDENTIFIER")))
        )

    else:
        # Fallback to adjacent scope & model label when same-line has no explicit keyword
        search_scope = f"{ctx['preceding']} {ctx['following']} {ctx['prev_line']} {ctx['next_line']} {dom_ctx}"
        is_commercial = _COMMERCIAL_RE.search(search_scope) or any(
            k in norm_label for k in ["product", "sku", "item", "order", "invoice", "tracking", "shipment"]
        )
        is_personal = _PERSONAL_ID_RE.search(search_scope) or any(
            k in norm_label for k in ["employee", "customer", "patient", "member", "applicant", "candidate", "student", "roll", "user"]
        )

        if is_commercial and not is_personal:
            sensitivity_class = "NON_PERSONAL_IDENTIFIER"
            decision = "KEEP"
            negative_evidence.append("commercial_identifier_context")
            reason = f"Commercial identifier ({norm_label}); not personal PII under policy"
            decision_score = round(max(0.10, 1.0 - model_confidence), 4)
            final_type = norm_label.upper().replace(" ", "_")

        elif is_personal:
            sensitivity_class = "PERSONAL_IDENTIFIER"
            decision = "REDACT"
            positive_evidence.append("personal_identifier_context")
            reason = f"Personal identifier ({norm_label}) identifying an individual"
            decision_score = round(max(0.80, model_confidence), 4)
            final_type = norm_label.upper().replace(" ", "_")

        else:
            # Ambiguous reference (e.g. "Reference: ABX-92817")
            if _AMBIGUOUS_ID_RE.search(search_scope):
                positive_evidence.append("ambiguous_reference_context")
                sensitivity_class = "UNKNOWN_IDENTIFIER"
                decision = "REVIEW"
                reason = f"Contextual reference ({norm_label}); ambiguous persona linkage"
                decision_score = round(model_confidence, 4)
            else:
                sensitivity_class = "NON_PERSONAL_IDENTIFIER"
                decision = "KEEP"
                reason = f"Unclassified identifier without personal linkage"
                decision_score = 0.30
            final_type = norm_label.upper().replace(" ", "_")

    return {
        "candidate_type": norm_label.upper().replace(" ", "_"),
        "final_type": final_type,
        "sensitivity_class": sensitivity_class,
        "decision_score": decision_score,
        "decision": decision,
        "positive_evidence": positive_evidence,
        "negative_evidence": negative_evidence,
        "reason": reason,
        "context_snippet": ctx["same_line"].strip()
    }
