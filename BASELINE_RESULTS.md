# Privamon — Baseline Performance Report (Phase 1)

**Date**: 2026-09-04  
**Test Subject**: Existing Privamon Pipeline (`privacy/pii-detector.js`, `vision/ocr-engine.js`, `privacy/fusion.js`, `privacy/redactor.js`)  
**Build Status**: `npm run setup` executed successfully (exit code 0; all vendor files copied).

---

## 1. Test Execution & Observed Results

### Test Case 1: Standard PII
**Input String**:
```
"My name is Rahul Sharma. My phone number is +91 9876543210. My email is rahul@gmail.com. My PAN is ABCDE1234F."
```

**Detections Produced by Current Detector**:
1. `email`: `"rahul@gmail.com. My"` (span: [72, 91], confidence: 1.00)
2. `phone`: `" 9876543210"` (span: [47, 58], confidence: 1.00)
3. `phone`: `"9876543210"` (span: [48, 58], confidence: 1.00)
4. `aadhaar`: `"91 9876543210"` (span: [45, 58], confidence: 0.70)

**Analysis of Test Case 1**:
- **What is detected**: Phone number and email were detected.
- **What is MISSED**:
  - **Person Name ("Rahul Sharma")**: Completely missed (0 detections). There is no NER or name pattern.
  - **PAN ("ABCDE1234F")**: Regex matched, but failed validation (`clean[3] === 'D'` is not in `'ABCFGHLJPT'`).
- **What is INCORRECTLY detected**:
  - **Email Span Corruption**: Email regex matched `"rahul@gmail.com. My"`, bleeding across the sentence period into the next word.
  - **False Aadhaar Match**: The Indian phone number with prefix (`91 9876543210`, 12 digits) matched the naive 12-digit Aadhaar pattern with 0.70 confidence.
  - **Duplicate Phone Match**: Both `phone_indian` and `phone_intl` fired independently on the same phone number.

---

### Test Case 2: False Positive Candidates
**Input String**:
```
"Order ID: 1234567890 Invoice Number: 1234567890 Product Code: ABCDE1234F PIN Code: 110001"
```

**Detections Produced by Current Detector**:
1. `phone`: `"1234567890"` (span: [10, 20], confidence: 1.00) — **FALSE POSITIVE**
2. `phone`: `"1234567890"` (span: [37, 47], confidence: 1.00) — **FALSE POSITIVE**
3. `otp`: `"110001"` (span: [83, 89], confidence: 0.45) — **FALSE POSITIVE**

**Analysis of Test Case 2**:
- **What is detected**: 3 detections.
- **What is MISSED**: Nothing should have been detected here as PII.
- **What is INCORRECTLY detected**:
  - Order ID `1234567890` was classified as a phone number with **1.00 confidence**.
  - Invoice Number `1234567890` was classified as a phone number with **1.00 confidence**.
  - PIN Code `110001` was classified as an OTP with **0.45 confidence** (which passes the fusion threshold of 0.30).
  - *Root cause*: Absence of negative context filters and over-reliance on bare digit count without context validation.

---

### Test Case 3: Addresses & India-Specific Identifiers
**Input String**:
```
"Deliver to Flat 402, Green Valley Apartments, Indiranagar, Bengaluru. UPI: rahul@okhdfcbank. Aadhaar: 2345 6789 0123. DL: DL1420110012345."
```

**Detections Produced by Current Detector**:
1. `email`: `"rahul@okhdfcbank. Aadhaar"` (span: [75, 100], confidence: 0.92) — **MISCLASSIFIED & CORRUPTED**
2. `aadhaar`: `"2345 6789 0123"` (span: [102, 116], confidence: 1.00)
3. `otp`: `"2345"` (span: [102, 106], confidence: 0.10)
4. `otp`: `"6789"` (span: [107, 111], confidence: 0.10)
5. `otp`: `"0123"` (span: [112, 116], confidence: 0.10)

**Analysis of Test Case 3**:
- **What is MISSED**:
  - **Full Address ("Flat 402, Green Valley Apartments, Indiranagar, Bengaluru")**: Completely missed (0 detections).
  - **Driving Licence ("DL1420110012345")**: Completely missed (0 detections).
  - **UPI ID**: No UPI recognizer exists; misclassified as an email and bled into the next word.
- **What is INCORRECTLY detected**:
  - Naive OTP regex fired on each 4-digit block of the Aadhaar number.

---

## 2. Redaction & Bounding Box Pipeline Assessment

### Does detected PII reach redaction?
- **Yes, BUT only for detections that pass confidence filtering and are matched to bounding boxes**:
  - When PII is detected in DOM elements, it reaches redaction.
  - When PII is detected in OCR tokens, it reaches redaction **only if** the token character span matching succeeds in `ocr-engine.js`.
  - **Critical Failure**: When names, addresses, or IDs in an image produce 0 detections, the pipeline terminates with `"No PII detected"` and the original unredacted image is exported.

### Are bounding boxes correct?
- **Single-line tokens**: Union bbox works reasonably when all tokens are strictly horizontal.
- **Multi-line tokens**:
  - `vision/ocr-engine.js` computes a single bounding box:
    `x = min(x)`, `y = min(y)`, `width = max(x + w) - min(x)`, `height = max(y + h) - min(y)`.
  - On a two-line or wrapped entity (e.g. multi-line address), this creates a giant rectangular box that masks unrelated content on intervening lines.

---

## 3. Summary of Baseline Deficiencies

| Area | Current Behavior | Required Behavior |
|------|------------------|-------------------|
| **Person Names** | 0% recall (unsupported) | High recall via GLiNER NER |
| **Addresses** | 0% recall (unsupported) | High recall via GLiNER NER |
| **False Positives** | Order/Invoice IDs redacted as Phone; PIN redacted as OTP | Suppressed via negative context & validator |
| **India Identifiers** | UPI, DL, Voter ID, GSTIN, Bank Acct unsupported; Aadhaar lacks Verhoeff | Deterministic recognizers with checksums |
| **Email Regex** | Bleeds across sentence periods (`. My`) | Strict word boundaries & RFC-compliant syntax |
| **Multi-line Bbox** | Single union box blanketing intervening lines | Segmented per-line bounding boxes |
| **Logging** | Detections dropped silently | Structured logs at every stage with discard reasons |
