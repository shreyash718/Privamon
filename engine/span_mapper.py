"""
Privamon — OCR Token Span Mapper & Bounding Box Generator

Maps detected PII character spans back to original OCR tokens:
- Matches character ranges to token coordinates
- Handles single-line entities (calculates clean union bounding box)
- Handles multi-line entities (produces separate per-line bounding boxes
  to prevent masking unrelated content between lines)
- Preserves token provenance
"""

from typing import List, Dict, Any, Optional


def align_tokens_with_text(text: str, tokens: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Ensures every token has accurate character `start` and `end` indices relative to `text`,
    as well as a stable deterministic token ID (e.g. `ocr_0001`).
    """
    if not tokens:
        return []

    # Check if first token already has valid start/end
    has_valid_offsets = "start" in tokens[0] and "end" in tokens[0] and tokens[0]["end"] > tokens[0]["start"]

    aligned = []
    current_idx = 0

    for i, t in enumerate(tokens):
        token_text = t.get("text", "")
        token_id = t.get("id") or f"ocr_{i+1:04d}"

        if has_valid_offsets:
            aligned.append({
                **t,
                "id": token_id
            })
            continue

        if not token_text:
            continue

        # Find occurrence in text from current_idx
        idx = text.find(token_text, current_idx)
        if idx != -1:
            start = idx
            end = idx + len(token_text)
            current_idx = end
        else:
            # Fallback approximate position
            start = current_idx
            end = current_idx + len(token_text)
            current_idx = end

        aligned.append({
            **t,
            "id": token_id,
            "start": start,
            "end": end
        })

    return aligned


def compute_union_box(boxes: List[Dict[str, int]]) -> Dict[str, int]:
    """Computes the enclosing bounding box covering all given boxes."""
    if not boxes:
        return {"x": 0, "y": 0, "width": 0, "height": 0}

    x1 = min(b["x"] for b in boxes)
    y1 = min(b["y"] for b in boxes)
    x2 = max(b["x"] + b["width"] for b in boxes)
    y2 = max(b["y"] + b["height"] for b in boxes)

    return {
        "x": x1,
        "y": y1,
        "width": x2 - x1,
        "height": y2 - y1
    }


def compute_token_sub_box(token: Dict[str, Any], span_start: int, span_end: int) -> Dict[str, int]:
    """
    Calculates a proportional horizontal sub-box when a PII span only partially
    overlaps an OCR token (e.g. OCR token is 'Rahul123', PII is 'Rahul').
    """
    box = token["bbox"]
    token_text = token.get("text", "")
    t_start = token["start"]
    t_end = token["end"]

    # If span completely encloses the token, use the full token box
    if span_start <= t_start and span_end >= t_end:
        return {
            "x": box["x"],
            "y": box["y"],
            "width": box["width"],
            "height": box["height"]
        }

    token_len = max(1, len(token_text))
    char_w = box["width"] / float(token_len)

    clamped_start = max(t_start, span_start)
    clamped_end = min(t_end, span_end)

    offset_chars = clamped_start - t_start
    span_chars = max(1, clamped_end - clamped_start)

    sub_x = box["x"] + int(round(offset_chars * char_w))
    sub_w = max(2, int(round(span_chars * char_w)))

    # Clamp tightly within the original token box
    max_right = box["x"] + box["width"]
    sub_x = min(sub_x, max_right - 2)
    sub_w = min(sub_w, max_right - sub_x)

    return {
        "x": sub_x,
        "y": box["y"],
        "width": sub_w,
        "height": box["height"]
    }


def group_tokens_by_line(items: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """
    Groups items with bounding boxes into visual lines based on vertical overlap.
    """
    if not items:
        return []

    # Sort items primarily by vertical position y, then horizontal position x
    sorted_items = sorted(items, key=lambda t: (t["bbox"]["y"], t["bbox"]["x"]))
    lines: List[List[Dict[str, Any]]] = []

    for item in sorted_items:
        box = item["bbox"]
        t_mid_y = box["y"] + box["height"] / 2.0

        placed = False
        for line in lines:
            ref_box = line[0]["bbox"]
            ref_mid_y = ref_box["y"] + ref_box["height"] / 2.0
            avg_height = (box["height"] + ref_box["height"]) / 2.0

            if abs(t_mid_y - ref_mid_y) < avg_height * 0.6:
                line.append(item)
                placed = True
                break

        if not placed:
            lines.append([item])

    # Sort each line from left to right
    for line in lines:
        line.sort(key=lambda t: t["bbox"]["x"])

    return lines


def map_span_to_bboxes(span_start: int, span_end: int, aligned_tokens: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Finds all tokens overlapping [span_start, span_end].
    Produces:
    - matched_tokens: list of token IDs
    - bbox: primary enclosing bounding box (with partial overlap sub-box precision)
    - boxes: list of per-line bounding boxes (handles multi-line accurately)
    """
    overlapping_items = []
    token_ids = []

    for t in aligned_tokens:
        t_start = t["start"]
        t_end = t["end"]

        # Token overlaps with PII span if:
        if t_end > span_start and t_start < span_end:
            token_ids.append(t["id"])
            # Compute exact sub-box for this token
            exact_box = compute_token_sub_box(t, span_start, span_end)
            overlapping_items.append({
                "id": t["id"],
                "text": t.get("text", ""),
                "start": t_start,
                "end": t_end,
                "bbox": exact_box,
                "token_ref": t
            })

    if not overlapping_items:
        return {
            "tokens": [],
            "bbox": None,
            "boxes": []
        }

    # Group overlapping items by line
    line_groups = group_tokens_by_line(overlapping_items)

    # Compute bounding box for each individual line
    per_line_boxes = [compute_union_box([item["bbox"] for item in line]) for line in line_groups]

    # Compute overall union box
    overall_union = compute_union_box([item["bbox"] for item in overlapping_items])

    return {
        "tokens": token_ids,
        "bbox": overall_union,
        "boxes": per_line_boxes if len(per_line_boxes) > 1 else [overall_union]
    }


def map_detections_to_tokens(detections: List[Dict[str, Any]], tokens: List[Dict[str, Any]], text: str) -> List[Dict[str, Any]]:
    """
    Enriches each detection with matched token IDs and bounding boxes.
    """
    if not tokens:
        return detections

    aligned_tokens = align_tokens_with_text(text, tokens)
    mapped_detections = []

    for d in detections:
        span_res = map_span_to_bboxes(d["start"], d["end"], aligned_tokens)
        mapped = {
            **d,
            "tokens": span_res["tokens"],
            "bbox": span_res["bbox"],
            "boxes": span_res["boxes"]
        }
        mapped_detections.append(mapped)

    return mapped_detections
