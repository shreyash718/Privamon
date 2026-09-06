"""
Privamon PII Engine — Baseline Benchmark Script
Measures Presidio, GLiNER, Fusion, Span Mapping, and Total Latency.
"""

import os
import sys
sys.path.insert(0, os.path.abspath("."))

import time
import statistics
from engine.normalizer import normalize_text
from engine.presidio_detector import PresidioDetector
from engine.gliner_detector import GLiNERDetector
from engine.fusion_engine import fuse_detections
from engine.span_mapper import map_detections_to_tokens

# 1. Test Datasets
SMALL_TEXT = "My name is Rahul Sharma and my phone is +91 9876543210."

MEDIUM_TEXT = """
Customer Invoice & Shipping Manifest
Order ID: #ORD-9821443210
Customer Name: Priya Ananya Sharma
Contact: +91 9876543210 | priya.sharma@example.com
Delivery Address:
Flat 402, Lotus Towers, 80 Feet Road,
Koramangala 4th Block, Bengaluru, Karnataka 560034
Identity Details:
Aadhaar: 2345 6789 0124
PAN: ABCPS1234F
UPI ID for refund: priya.sharma@okhdfcbank
Tracking Number: TRK908123847123
"""

LARGE_TEXT = """
CONFIDENTIAL MEDICAL DISCHARGE SUMMARY & CLAIMS VERIFICATION
Hospital: Apollo Hospitals, Bannerghatta Road, Bangalore 560076
Patient Details:
Name: Rajesh Kumar Verma | Age: 42 | Gender: Male | DOB: 14/08/1984
Contact Number: +91-9123456789 | Alternate: 080-26589999
Email: rajesh.verma84@gmail.com
Residential Address:
House No. 12/B, Green Glen Layout, Outer Ring Road,
Bellandur, Bengaluru, Karnataka 560103
Emergency Contact: Sunita Verma (Spouse) - 9845012345

Billing & Financial Information:
Corporate Insurance Policy No: TPA-POL-98765432
Claim ID: CLM-2026-9812401
Policyholder: Rajesh Kumar Verma
Employee ID: EMP-55421
Primary Account No: 12345678901234 (State Bank of India)
IFSC Code: SBIN0001234
PAN Number: BAPRV5678K
Aadhaar Card: 2345 6789 0124
Driving Licence: KA-01-2015-0004321
Voter ID: WEC1234567

Itemized Billing Summary:
1. Room Rent (Deluxe Cabin): INR 24,000.00 (Item Code: ITM-001)
2. ICU Monitoring & Care: INR 45,000.00 (Item Code: ITM-002)
3. Pharmacy & Consumables: INR 18,340.50 (Invoice Ref: INV-98123)
4. Diagnostic Pathology: INR 9,200.00 (Test SKU: SKU-9921)
Total Authorized Settlement: INR 96,540.50
Transaction Reference ID: TXN998822110099
Authorized Doctor: Dr. Arvind Swaminathan (Reg No: KMC-44512)
"""

NUMERIC_STRUCTURED_ONLY = "Order ID #9876543210, Tracking Number: 123456789012, PIN Code: 560001."

def generate_tokens(text):
    tokens = []
    lines = text.split("\n")
    y = 20
    for line in lines:
        x = 20
        words = line.split()
        for w in words:
            w_len = len(w) * 8
            tokens.append({
                "text": w,
                "bbox": {"x": x, "y": y, "width": w_len, "height": 20},
                "confidence": 0.98
            })
            x += w_len + 8
        y += 28
    return tokens

def profile_run(p_det, g_det, text, tokens, iterations=5):
    presidio_times = []
    gliner_times = []
    fusion_times = []
    mapping_times = []
    total_times = []
    detection_counts = []

    for _ in range(iterations):
        t0 = time.perf_counter()

        # Normalization
        norm_res = normalize_text(text)
        norm_text = norm_res.normalized_text

        # Presidio
        t_p0 = time.perf_counter()
        p_res = p_det.detect(norm_text, "")
        t_p1 = time.perf_counter()

        raw_dets = []
        for d in p_res:
            orig_s, orig_e = norm_res.map_span_to_original(d["start"], d["end"])
            raw_dets.append({
                **d, "start": orig_s, "end": orig_e, "text": text[orig_s:orig_e]
            })

        # GLiNER
        t_g0 = time.perf_counter()
        g_res = g_det.detect(norm_text)
        t_g1 = time.perf_counter()

        for d in g_res:
            orig_s, orig_e = norm_res.map_span_to_original(d["start"], d["end"])
            raw_dets.append({
                **d, "start": orig_s, "end": orig_e, "text": text[orig_s:orig_e]
            })

        # Fusion
        t_f0 = time.perf_counter()
        fused, _ = fuse_detections(raw_dets, text)
        t_f1 = time.perf_counter()

        # Mapping
        t_m0 = time.perf_counter()
        if tokens:
            final_dets = map_detections_to_tokens(fused, tokens, text)
        else:
            final_dets = fused
        t_m1 = time.perf_counter()

        total = (t_m1 - t0) * 1000

        presidio_times.append((t_p1 - t_p0) * 1000)
        gliner_times.append((t_g1 - t_g0) * 1000)
        fusion_times.append((t_f1 - t_f0) * 1000)
        mapping_times.append((t_m1 - t_m0) * 1000)
        total_times.append(total)
        detection_counts.append(len(final_dets))

    return {
        "presidio_ms": round(statistics.mean(presidio_times), 2),
        "gliner_ms": round(statistics.mean(gliner_times), 2),
        "fusion_ms": round(statistics.mean(fusion_times), 2),
        "mapping_ms": round(statistics.mean(mapping_times), 2),
        "total_ms": round(statistics.mean(total_times), 2),
        "count": detection_counts[0]
    }

def main():
    print("Initializing models for benchmark...")
    p_det = PresidioDetector()
    g_det = GLiNERDetector.get_instance()
    g_det.initialize()

    # Warmup
    print("Warming up...")
    _ = p_det.detect("Warmup text", "")
    _ = g_det.detect("Warmup text")

    print("\n--- BENCHMARK 1: Small Text ---")
    small_tokens = generate_tokens(SMALL_TEXT)
    res_small = profile_run(p_det, g_det, SMALL_TEXT, small_tokens, iterations=5)
    print("Small Text Results:", res_small)

    print("\n--- BENCHMARK 2: Medium OCR Block ---")
    med_tokens = generate_tokens(MEDIUM_TEXT)
    res_med = profile_run(p_det, g_det, MEDIUM_TEXT, med_tokens, iterations=5)
    print("Medium OCR Results:", res_med)

    print("\n--- BENCHMARK 3: Large OCR Block ---")
    large_tokens = generate_tokens(LARGE_TEXT)
    res_large = profile_run(p_det, g_det, LARGE_TEXT, large_tokens, iterations=5)
    print("Large OCR Results:", res_large)

    print("\n--- BENCHMARK 4: Purely Numeric / Structured Text ---")
    num_tokens = generate_tokens(NUMERIC_STRUCTURED_ONLY)
    res_num = profile_run(p_det, g_det, NUMERIC_STRUCTURED_ONLY, num_tokens, iterations=5)
    print("Numeric Structured Results:", res_num)

if __name__ == "__main__":
    main()
