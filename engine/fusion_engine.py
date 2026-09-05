"""
Privamon — Detection Fusion Engine

Reconciles detections from Presidio, GLiNER, and other recognizers:
- Entity type standardization
- Character span overlap resolution
- Multi-detector evidence combination (probabilistic confidence boost)
- Provenance preservation (e.g. ["presidio", "gliner"])
- Configurable entity-specific thresholds
- Structured discard logging for full traceability
"""

import json
import logging
from typing import List, Dict, Any, Tuple

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
}

# Configurable minimum confidence per entity type
ENTITY_THRESHOLDS = {
    "AADHAAR": 0.65,
    "PAN": 0.70,
    "EMAIL": 0.75,
    "PHONE": 0.75,
    "UPI_ID": 0.70,
    "PASSPORT": 0.80,
    "DRIVING_LICENCE": 0.75,
    "VOTER_ID": 0.70,
    "BANK_ACCOUNT": 0.80,
    "GSTIN": 0.85,
    "VEHICLE_REGISTRATION": 0.65,
    "CREDIT_CARD": 0.75,
    "IP_ADDRESS": 0.60,
    "PERSON": 0.50,
    "ADDRESS": 0.45,
    "LOCATION": 0.50,
    "ORGANIZATION": 0.55,
    "USERNAME": 0.60,
    "DATE_OF_BIRTH": 0.50,
    "DEFAULT": 0.50,
}

# Deterministic priority over general NER when spans conflict
DETERMINISTIC_ENTITIES = {
    "PAN", "AADHAAR", "EMAIL", "PHONE", "UPI_ID",
    "PASSPORT", "DRIVING_LICENCE", "VOTER_ID", "GSTIN",
    "BANK_ACCOUNT", "CREDIT_CARD", "IP_ADDRESS"
}


def normalize_type(raw_type: str) -> str:
    return ENTITY_TYPE_NORMALIZATION.get(raw_type.upper(), raw_type.upper())


def calculate_combined_confidence(conf1: float, conf2: float) -> float:
    """
    Combines independent evidence using probabilistic sum:
    P(A or B) = 1 - (1 - P(A)) * (1 - P(B))
    Capped at 0.99
    """
    combined = 1.0 - (1.0 - min(0.99, conf1)) * (1.0 - min(0.99, conf2))
    return round(min(0.99, combined), 4)


def fuse_detections(raw_detections: List[Dict[str, Any]], original_text: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Fuses a collection of raw detections from all detectors.
    Returns (final_fused_detections, discarded_detections_log).
    """
    discard_log = []
    normalized_list = []

    # Step 1: Normalize entity types and sources
    for d in raw_detections:
        norm_t = normalize_type(d.get("type", "OTHER"))
        src = d.get("source", "unknown")
        sources = [src] if isinstance(src, str) else list(src)

        normalized_list.append({
            "type": norm_t,
            "text": d.get("text", ""),
            "start": int(d.get("start", 0)),
            "end": int(d.get("end", 0)),
            "confidence": float(d.get("confidence", 0.5)),
            "source": sources,
            "metadata": d.get("metadata", {})
        })

    # Step 2: Sort primarily by start position, then descending by confidence
    normalized_list.sort(key=lambda x: (x["start"], -x["confidence"]))

    # Step 3: Span-level fusion & conflict resolution
    fused: List[Dict[str, Any]] = []

    for current in normalized_list:
        merged = False

        for existing in fused:
            # Check overlap between [current.start, current.end] and [existing.start, existing.end]
            overlap_start = max(current["start"], existing["start"])
            overlap_end = min(current["end"], existing["end"])

            if overlap_start < overlap_end:
                # Spans overlap!
                merged = True

                # Case A: Same entity type -> Merge span & combine confidence
                if current["type"] == existing["type"]:
                    candidate_start = min(existing["start"], current["start"])
                    candidate_end = max(existing["end"], current["end"])
                    candidate_text = original_text[candidate_start:candidate_end]

                    if "\n" in candidate_text and current["type"] not in ("ADDRESS", "LOCATION"):
                        # Do not merge across newlines for single-line entities
                        if current["confidence"] > existing["confidence"]:
                            existing["start"] = current["start"]
                            existing["end"] = current["end"]
                            existing["text"] = current["text"]
                            existing["confidence"] = current["confidence"]
                            existing["source"] = current["source"]
                    else:
                        existing["start"] = candidate_start
                        existing["end"] = candidate_end
                        existing["text"] = candidate_text
                        existing["confidence"] = calculate_combined_confidence(existing["confidence"], current["confidence"])

                    for s in current["source"]:
                        if s not in existing["source"]:
                            existing["source"].append(s)
                    break

                # Case B: Deterministic entity vs Contextual entity conflict
                if existing["type"] in DETERMINISTIC_ENTITIES and current["type"] not in DETERMINISTIC_ENTITIES:
                    # Existing deterministic match takes precedence
                    discard_entry = {
                        "stage": "fusion",
                        "action": "discard",
                        "entity": current["type"],
                        "text": _sanitize_for_log(current["text"]),
                        "confidence": current["confidence"],
                        "reason": f"shadowed_by_{existing['type']}"
                    }
                    discard_log.append(discard_entry)
                    logger.info(json.dumps(discard_entry))
                    break

                elif current["type"] in DETERMINISTIC_ENTITIES and existing["type"] not in DETERMINISTIC_ENTITIES:
                    # Current deterministic match replaces existing contextual match
                    discard_entry = {
                        "stage": "fusion",
                        "action": "discard",
                        "entity": existing["type"],
                        "text": _sanitize_for_log(existing["text"]),
                        "confidence": existing["confidence"],
                        "reason": f"shadowed_by_{current['type']}"
                    }
                    discard_log.append(discard_entry)
                    logger.info(json.dumps(discard_entry))

                    existing["type"] = current["type"]
                    existing["start"] = current["start"]
                    existing["end"] = current["end"]
                    existing["text"] = current["text"]
                    existing["confidence"] = current["confidence"]
                    existing["source"] = current["source"]
                    break

                else:
                    # Both are same category or both contextual: higher confidence wins
                    if current["confidence"] > existing["confidence"]:
                        discard_entry = {
                            "stage": "fusion",
                            "action": "discard",
                            "entity": existing["type"],
                            "text": _sanitize_for_log(existing["text"]),
                            "confidence": existing["confidence"],
                            "reason": f"lower_confidence_than_{current['type']}"
                        }
                        discard_log.append(discard_entry)
                        logger.info(json.dumps(discard_entry))

                        existing["type"] = current["type"]
                        existing["start"] = current["start"]
                        existing["end"] = current["end"]
                        existing["text"] = current["text"]
                        existing["confidence"] = current["confidence"]
                        existing["source"] = current["source"]
                    else:
                        discard_entry = {
                            "stage": "fusion",
                            "action": "discard",
                            "entity": current["type"],
                            "text": _sanitize_for_log(current["text"]),
                            "confidence": current["confidence"],
                            "reason": f"lower_confidence_than_{existing['type']}"
                        }
                        discard_log.append(discard_entry)
                        logger.info(json.dumps(discard_entry))
                    break

        if not merged:
            fused.append(current)

    # Step 4: Apply entity-specific confidence thresholds
    final_detections = []
    for item in fused:
        thresh = ENTITY_THRESHOLDS.get(item["type"], ENTITY_THRESHOLDS["DEFAULT"])
        if item["confidence"] < thresh:
            discard_entry = {
                "stage": "fusion",
                "action": "discard",
                "entity": item["type"],
                "text": _sanitize_for_log(item["text"]),
                "confidence": item["confidence"],
                "reason": f"below_threshold ({item['confidence']} < {thresh})"
            }
            discard_log.append(discard_entry)
            logger.info(json.dumps(discard_entry))
        else:
            # Strip trailing/leading punctuation and whitespace
            txt = item["text"]
            stripped = txt.strip(" \t\r\n:,;.-")
            if not stripped or len(stripped) < 2:
                continue
            if stripped != txt:
                lead = len(txt) - len(txt.lstrip(" \t\r\n:,;.-"))
                item["start"] += lead
                item["end"] = item["start"] + len(stripped)
                item["text"] = stripped
            final_detections.append(item)

    return final_detections, discard_log
