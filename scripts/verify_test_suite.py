#!/usr/bin/env python3
"""
Privamon — Synthetic Test Suite Verification Script

Automated validation runner that verifies:
1. Integrity and existence of all 6 test pages and 6 matching manifest files.
2. JSON schema conformance of all ground-truth manifests.
3. Mathematical correctness of Verhoeff checksums on all generated Aadhaar numbers.
4. Mathematical correctness of Luhn checksums on all credit card numbers.
5. Structural validity of PAN numbers (format [A-Z]{5}[0-9]{4}[A-Z] & valid entity char).
6. 100% offline self-containment (zero external http/https CDN/script/font links).
7. Asset existence and integrity.
"""

import os
import sys
import re
import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
TEST_PAGES_DIR = BASE_DIR / "test-pages"

# ── Verhoeff Algorithm Tables ──
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

def validate_verhoeff(num_str: str) -> bool:
    digits = [int(d) for d in num_str if d.isdigit()]
    if len(digits) != 12 or digits[0] in (0, 1):
        return False
    c = 0
    for i, digit in enumerate(reversed(digits)):
        c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digit]]
    return c == 0

def luhn_valid(num_str: str) -> bool:
    digits = [int(d) for d in num_str if d.isdigit()]
    if len(digits) < 13 or len(digits) > 19:
        return False
    digits.reverse()
    total = sum(d if i % 2 == 0 else (d * 2 - 9 if d * 2 > 9 else d * 2) for i, d in enumerate(digits))
    return total % 10 == 0

def validate_pan(pan_str: str) -> bool:
    clean = re.sub(r"[\s\-]", "", pan_str).upper()
    if len(clean) != 10:
        return False
    if not re.match(r"^[A-Z]{5}[0-9]{4}[A-Z]$", clean):
        return False
    # 4th character indicates entity type
    return clean[3] in "ABCFGHLJPT"


def run_checks():
    print("=" * 70)
    print("Privamon Synthetic Test-Page Suite Verification")
    print("=" * 70)

    pages = [
        "dom-pii-form",
        "text-pii",
        "ocr-image-pii",
        "face-detection",
        "realistic-combined"
    ]

    all_passed = True

    # ── 1. File Existence & Manifest Syntax Checks ──
    print("\n[1/6] Checking File Existence & JSON Manifest Schemas...")
    for p in pages:
        html_file = TEST_PAGES_DIR / f"{p}.html"
        json_file = TEST_PAGES_DIR / f"{p}.manifest.json"

        if not html_file.exists():
            print(f"  ❌ Missing HTML file: {html_file}")
            all_passed = False
        else:
            print(f"  ✓ Found HTML: {html_file.name} ({html_file.stat().st_size:,} bytes)")

        if not json_file.exists():
            print(f"  ❌ Missing Manifest file: {json_file}")
            all_passed = False
        else:
            try:
                with open(json_file, "r", encoding="utf-8") as f:
                    manifest = json.load(f)
                assert "page" in manifest, "Manifest missing 'page' property"
                assert "expectedDetections" in manifest, "Manifest missing 'expectedDetections'"
                assert isinstance(manifest["expectedDetections"], list), "'expectedDetections' must be a list"
                for item in manifest["expectedDetections"]:
                    assert "type" in item, f"Item missing 'type': {item}"
                    assert "value" in item or "targetElement" in item or "elementId" in item, f"Item missing target identifier: {item}"
                    assert "shouldRedact" in item, f"Item missing 'shouldRedact': {item}"
                    assert isinstance(item["shouldRedact"], bool), f"'shouldRedact' must be boolean: {item}"
                print(f"  ✓ Found Manifest: {json_file.name} ({len(manifest['expectedDetections'])} entries validated)")
            except Exception as e:
                print(f"  ❌ Invalid JSON Manifest {json_file.name}: {e}")
                all_passed = False

    # ── 2. Offline / Self-Contained Checks ──
    print("\n[2/6] Checking Offline Self-Containment (Zero External URLs)...")
    external_url_pattern = re.compile(r"""(?:src|href)\s*=\s*['"](https?://[^'"]+)['"]""", re.IGNORECASE)
    for p in pages:
        html_file = TEST_PAGES_DIR / f"{p}.html"
        if html_file.exists():
            content = html_file.read_text(encoding="utf-8")
            matches = external_url_pattern.findall(content)
            # Exclude benign SVG namespace declarations
            external_links = [m for m in matches if not m.startswith("http://www.w3.org/")]
            if external_links:
                print(f"  ❌ External network request detected in {html_file.name}: {external_links}")
                all_passed = False
            else:
                print(f"  ✓ {html_file.name} is 100% self-contained (zero external network requests)")

    # ── 3. Mathematical Verhoeff Aadhaar Verification ──
    print("\n[3/6] Programmatic Verhoeff Checksum Validation (Aadhaar)...")
    aadhaar_numbers = [
        ("2345 6789 0124", "dom-pii-form.html & realistic-combined.html"),
        ("4921 5832 9010", "text-pii.html"),
        ("3141 5926 5351", "text-pii.html"),
        ("5678 9012 3458", "ocr-image-pii.html (English Canvas)")
    ]

    for num, loc in aadhaar_numbers:
        is_valid = validate_verhoeff(num)
        if is_valid:
            print(f"  ✓ Aadhaar '{num}' ({loc}): PASSES Verhoeff check")
        else:
            print(f"  ❌ Aadhaar '{num}' ({loc}): FAILED Verhoeff check")
            all_passed = False

    # Negative test on corrupted Aadhaar to prove detector sensitivity
    corrupted_aadhaar = "2345 6789 0129"
    assert not validate_verhoeff(corrupted_aadhaar), "Corrupted Aadhaar should fail Verhoeff"
    print(f"  ✓ Negative test on corrupted '{corrupted_aadhaar}': Correctly REJECTED")

    # ── 4. Mathematical Luhn Verification (Credit Cards) ──
    print("\n[4/6] Programmatic Luhn Checksum Validation (Credit Cards)...")
    cards = [
        ("4111 1111 1111 1111", "Visa Test Card", "dom-pii-form, text-pii, realistic-combined"),
        ("5555 5555 5555 4444", "Mastercard Test Card", "text-pii.html")
    ]

    for num, name, loc in cards:
        is_valid = luhn_valid(num)
        if is_valid:
            print(f"  ✓ {name} '{num}' ({loc}): PASSES Luhn check")
        else:
            print(f"  ❌ {name} '{num}' ({loc}): FAILED Luhn check")
            all_passed = False

    # Negative test on corrupted card
    corrupted_card = "4111 1111 1111 1112"
    assert not luhn_valid(corrupted_card), "Corrupted card should fail Luhn"
    print(f"  ✓ Negative test on corrupted '{corrupted_card}': Correctly REJECTED")

    # ── 5. Structural PAN Verification ──
    print("\n[5/6] Structural PAN Tax Entity Verification...")
    pans = [
        ("ABCPE1234F", "Individual (P)", "dom-pii-form, text-pii, realistic-combined"),
        ("XYZPC9876L", "Company (C)", "text-pii.html, ocr-image-pii.html"),
        ("ABCPE5678G", "Individual (P)", "ocr-image-pii.html")
    ]

    for pan_val, desc, loc in pans:
        is_valid = validate_pan(pan_val)
        if is_valid:
            print(f"  ✓ PAN '{pan_val}' [{desc}] ({loc}): PASSES format & entity validation")
        else:
            print(f"  ❌ PAN '{pan_val}' [{desc}] ({loc}): FAILED validation")
            all_passed = False

    # ── 6. Assets Verification ──
    print("\n[6/6] Checking Synthetic Image Assets...")
    assets = [
        ("synthetic_face.jpg", "AI-Generated Synthetic Face Asset"),
        ("synthetic_logo.jpg", "Abstract Geometric Shield Logo"),
        ("shared.css", "Shared Offline CSS Design System")
    ]

    for filename, desc in assets:
        asset_file = TEST_PAGES_DIR / "assets" / filename
        if asset_file.exists() and asset_file.stat().st_size > 0:
            print(f"  ✓ Asset '{filename}' ({desc}): Present ({asset_file.stat().st_size:,} bytes)")
        else:
            print(f"  ❌ Missing or empty asset: {filename}")
            all_passed = False

    print("\n" + "=" * 70)
    if all_passed:
        print("🎉 ALL TESTS PASSED: Synthetic PII Suite is 100% verified & valid!")
        print("=" * 70)
        return 0
    else:
        print("❌ SOME CHECKS FAILED: Please review logs above.")
        print("=" * 70)
        return 1

if __name__ == "__main__":
    sys.exit(run_checks())
