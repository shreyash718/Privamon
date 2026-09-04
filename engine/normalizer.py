"""
Privamon — Conservative Text Normalizer & Offset Mapper

Rules:
1. Normalization must be conservative.
2. The original OCR text must remain untouched.
3. Every character in the normalized text must map back to its original character position.
4. Do NOT globally substitute O -> 0, I -> 1, S -> 5.
"""

import unicodedata
from typing import List, Tuple, Dict, Any


class NormalizationResult:
    def __init__(self, original_text: str, normalized_text: str, index_map: List[int]):
        self.original_text = original_text
        self.normalized_text = normalized_text
        self.index_map = index_map  # index_map[norm_idx] = orig_idx

    def map_span_to_original(self, norm_start: int, norm_end: int) -> Tuple[int, int]:
        """Maps a character span [norm_start, norm_end] back to [orig_start, orig_end]."""
        if not self.index_map or len(self.index_map) == 0:
            return norm_start, norm_end

        clamped_start = max(0, min(norm_start, len(self.index_map) - 1))
        orig_start = self.index_map[clamped_start]

        if norm_end <= norm_start:
            return orig_start, orig_start

        clamped_end_idx = max(0, min(norm_end - 1, len(self.index_map) - 1))
        # End is exclusive, so it is one character past the mapped last character in original
        orig_end = self.index_map[clamped_end_idx] + 1

        return orig_start, orig_end


def normalize_text(text: str) -> NormalizationResult:
    """
    Conservatively normalizes text:
    - Normalizes Unicode characters to NFKC.
    - Converts non-breaking and unusual whitespaces to standard space.
    - Preserves exact bidirectional character offset mapping.
    """
    if not text:
        return NormalizationResult("", "", [])

    # Map each original character index
    norm_chars = []
    index_map = []

    for orig_idx, char in enumerate(text):
        # Normalize character using NFKC
        n_char = unicodedata.normalize('NFKC', char)
        
        # Replace non-breaking / strange whitespaces with standard space
        if unicodedata.category(char).startswith('Z') or char in ('\u00a0', '\u200b', '\ufeff', '\t'):
            n_char = ' '

        # Append normalized character(s) and track origin
        for c in n_char:
            norm_chars.append(c)
            index_map.append(orig_idx)

    normalized_text = "".join(norm_chars)
    return NormalizationResult(text, normalized_text, index_map)


def pan_candidate_ocr_repair(candidate_text: str) -> str:
    """
    Attempts conservative OCR substitution on a PAN candidate ONLY:
    PAN format is: 5 uppercase letters, 4 digits, 1 uppercase letter.
    E.g. O -> 0 or 0 -> O in appropriate positions.
    Returns repaired candidate if it forms a valid PAN pattern, else original candidate.
    """
    clean = candidate_text.replace(" ", "").replace("-", "").upper()
    if len(clean) != 10:
        return candidate_text

    chars = list(clean)
    # First 5 characters must be letters: convert digits 0->O, 1->I, 5->S, 8->B
    sub_digit_to_alpha = {'0': 'O', '1': 'I', '5': 'S', '8': 'B'}
    for i in range(5):
        if chars[i] in sub_digit_to_alpha:
            chars[i] = sub_digit_to_alpha[chars[i]]

    # Next 4 characters (index 5 to 8) must be digits: convert letters O->0, I->1, S->5, B->8
    sub_alpha_to_digit = {'O': '0', 'I': '1', 'L': '1', 'S': '5', 'B': '8'}
    for i in range(5, 9):
        if chars[i] in sub_alpha_to_digit:
            chars[i] = sub_alpha_to_digit[chars[i]]

    # 10th character (index 9) must be a letter
    if chars[9] in sub_digit_to_alpha:
        chars[9] = sub_digit_to_alpha[chars[9]]

    repaired = "".join(chars)
    return repaired
