# Privamon — Detailed System Design & Architecture
## The Zero-Leakage Edge Privacy Firewall for Autonomous Vision-Language Browser Agents
### Comprehensive Technical Architecture & Smart India Hackathon (SIH 2026) Presentation Blueprint

---

## Executive Summary

**Privamon** is an edge-native, zero-leakage privacy firewall and visual redaction engine designed to eliminate the single greatest security vulnerability in modern autonomous AI: **the inadvertent exfiltration of Personally Identifiable Information (PII), confidential enterprise credentials, and human biometrics to third-party Cloud Vision-Language Models (VLMs)**.

As autonomous browser agents (e.g., WebVoyager, Operator, Claude Computer-Use) gain widespread adoption for booking flights, navigating enterprise ERPs, and completing personal transactions, they capture full-resolution desktop viewports and unredacted DOM trees. In doing so, they transmit sensitive data—such as Aadhaar numbers, PAN cards, credit cards, bank accounts, medical records, and user faces—to remote model endpoints.

Privamon fundamentally resolves this by enforcing a **zero-trust local sanitization boundary**:
1. It intercepts raw screenshots and DOM data **entirely on the client machine** using Google Chrome's Manifest V3 architecture.
2. It executes **Multi-Modal Triangulation** across DOM attributes, in-browser Tesseract.js WebAssembly OCR, and UltraFace/BlazeFace ONNX computer vision models, coupled with client-side PII detection and regex verification.
3. It performs **mathematical checksum verification** (Verhoeff algorithm for Indian Aadhaar, Luhn algorithm for Credit Cards, PAN syntax validation, and UPI VPA verification).
4. It permanently destroys sensitive pixels using an irreversible **Canvas 2D solid black rasterization (`#000000`)** backed by an active 3-pass **opacity verification and 25% safety expansion loop**.
5. It exports an **agent-safe, sanitized DOM and visual frame** to downstream local or cloud VLMs, enabling seamless task reasoning while providing mathematical guarantees against data leakage.

---

## Table of Contents

- [Privamon — Detailed System Design \& Architecture](#privamon--detailed-system-design--architecture)
  - [The Zero-Leakage Edge Privacy Firewall for Autonomous Vision-Language Browser Agents](#the-zero-leakage-edge-privacy-firewall-for-autonomous-vision-language-browser-agents)
    - [Comprehensive Technical Architecture \& Smart India Hackathon (SIH 2026) Presentation Blueprint](#comprehensive-technical-architecture--smart-india-hackathon-sih-2026-presentation-blueprint)
  - [Executive Summary](#executive-summary)
  - [Table of Contents](#table-of-contents)
  - [SIH 2026 Presentation Quick Mapping](#sih-2026-presentation-quick-mapping)
  - [1. Slide 1: Idea Title \& Problem Statement](#1-slide-1-idea-title--problem-statement)
    - [1.1 Project Title \& Hackathon Track](#11-project-title--hackathon-track)
    - [1.2 The Core Problem: The Privacy Crisis in Multimodal Browser Agents](#12-the-core-problem-the-privacy-crisis-in-multimodal-browser-agents)
    - [1.3 Threat Vectors in Unsanitized VLM Telemetry](#13-threat-vectors-in-unsanitized-vlm-telemetry)
    - [1.4 Statutory \& Regulatory Imperative (DPDP Act 2023 / GDPR)](#14-statutory--regulatory-imperative-dpdp-act-2023--gdpr)
    - [1.5 Why Existing Solutions Fail](#15-why-existing-solutions-fail)
  - [2. Slide 2: Proposed Solution \& Architectural Innovation](#2-slide-2-proposed-solution--architectural-innovation)
    - [2.1 The Privamon Paradigm: "Sanitize at the Edge, Reason on the Sanitized"](#21-the-privamon-paradigm-sanitize-at-the-edge-reason-on-the-sanitized)
    - [2.2 The 3-Tier Zero-Trust Architecture](#22-the-3-tier-zero-trust-architecture)
    - [2.3 How Privamon Resolves the Threat Vectors](#23-how-privamon-resolves-the-threat-vectors)
    - [2.4 Competitive \& Uniqueness Matrix](#24-competitive--uniqueness-matrix)
    - [2.5 Core Technical Innovations](#25-core-technical-innovations)
  - [3. Slide 3: Technical Approach \& System Design](#3-slide-3-technical-approach--system-design)
    - [3.1 Comprehensive Technology Stack Table](#31-comprehensive-technology-stack-table)
    - [3.2 System Architecture Diagrams](#32-system-architecture-diagrams)
      - [Figure 1: End-to-End System Topology \& Isolation Boundary](#figure-1-end-to-end-system-topology--isolation-boundary)
      - [Figure 2: The 9-Stage Master Sanitization Pipeline Dataflow](#figure-2-the-9-stage-master-sanitization-pipeline-dataflow)
      - [Figure 3: Multi-Modal Triangulation \& IoU Fusion Engine](#figure-3-multi-modal-triangulation--iou-fusion-engine)
      - [Figure 4: Viewport-to-Physical Coordinate Mapping Geometry](#figure-4-viewport-to-physical-coordinate-mapping-geometry)
      - [Figure 5: Autonomous VLM Closed-Loop Execution Workflow](#figure-5-autonomous-vlm-closed-loop-execution-workflow)
    - [3.3 Detailed 9-Stage Implementation Methodology](#33-detailed-9-stage-implementation-methodology)
    - [3.4 Server-Side Autonomous Reasoning Agent Workflow](#34-server-side-autonomous-reasoning-agent-workflow)
  - [4. Slide 4: Feasibility, Viability \& Risk Analysis](#4-slide-4-feasibility-viability--risk-analysis)
    - [4.1 Technical Feasibility Analysis](#41-technical-feasibility-analysis)
    - [4.2 Empirical Latency \& Optimization Benchmarks](#42-empirical-latency--optimization-benchmarks)
    - [4.3 Comprehensive Risk Analysis \& Mitigation Matrix](#43-comprehensive-risk-analysis--mitigation-matrix)
    - [4.4 Operational \& Commercial Viability](#44-operational--commercial-viability)
  - [5. Slide 5: Impact, Benefits \& Value Proposition](#5-slide-5-impact-benefits--value-proposition)
    - [5.1 Target Audience \& Beneficiary Ecosystem](#51-target-audience--beneficiary-ecosystem)
    - [5.2 Multi-Dimensional Benefits Assessment](#52-multi-dimensional-benefits-assessment)
    - [5.3 Statutory Compliance Mapping](#53-statutory-compliance-mapping)
  - [6. Slide 6: Research, Academic Foundations \& References](#6-slide-6-research-academic-foundations--references)
    - [6.1 Peer-Reviewed Research Literature](#61-peer-reviewed-research-literature)
    - [6.2 Mathematical Formulations \& Algorithms](#62-mathematical-formulations--algorithms)
    - [6.3 Statutory Acts \& Technical Standards](#63-statutory-acts--technical-standards)
  - [7. SIH 2026 Presentation Drafting Kit (Slide-by-Slide Deck)](#7-sih-2026-presentation-drafting-kit-slide-by-slide-deck)
    - [Slide 1: Idea Title \& Problem Statement](#slide-1-idea-title--problem-statement)
    - [Slide 2: Proposed Solution (Describe your Idea/Solution/Prototype)](#slide-2-proposed-solution-describe-your-ideasolutionprototype)
    - [Slide 3: Technical Approach](#slide-3-technical-approach)
    - [Slide 4: Feasibility and Viability](#slide-4-feasibility-and-viability)
    - [Slide 5: Impact and Benefits](#slide-5-impact-and-benefits)
    - [Slide 6: Research and References](#slide-6-research-and-references)
    - [Jury Defense Q\&A Master Guide](#jury-defense-qa-master-guide)

---

## SIH 2026 Presentation Quick Mapping

This document is mapped directly to the official Smart India Hackathon (SIH 2026) PowerPoint template:

| SIH Presentation Slide | Document Section | Key Visual / Deliverable |
| :--- | :--- | :--- |
| **Slide 1: Idea Title** | [Section 1](#1-slide-1-idea-title--problem-statement) | Title, Problem Formulation, Threat Vectors, DPDP Act 2023 mandate |
| **Slide 2: Proposed Solution** | [Section 2](#2-slide-2-proposed-solution--architectural-innovation) | 3-Tier Architecture, Innovation Matrix, Zero-Leakage Guarantee |
| **Slide 3: Technical Approach** | [Section 3](#3-slide-3-technical-approach--system-design) | Complete Tech Stack Table, 5 Mermaid Architecture Diagrams, 9-Stage Flow |
| **Slide 4: Feasibility \& Viability** | [Section 4](#4-slide-4-feasibility-viability--risk-analysis) | Latency Benchmarks (28x speedup), Risk Mitigation Matrix, Edge Feasibility |
| **Slide 5: Impact \& Benefits** | [Section 5](#5-slide-5-impact-benefits--value-proposition) | Beneficiary Personas, Social/Economic/Environmental Benefits, DPDP Compliance |
| **Slide 6: Research \& References**| [Section 6](#6-slide-6-research-academic-foundations--references) | Academic Citations (GLiNER, BlazeFace), Verhoeff Algorithm, W3C Standards |
| **Slide-by-Slide PPT Content** | [Section 7](#7-sih-2026-presentation-drafting-kit-slide-by-slide-deck) | **Ready-to-copy slide bullets & 30-second speaker pitch scripts** |

---

## 1. Slide 1: Idea Title & Problem Statement

### 1.1 Project Title & Hackathon Track
- **Project Title**: **Privamon: Zero-Leakage Edge Privacy Firewall & Redaction Architecture for Autonomous Browser AI Agents**
- **Theme**: Smart Automation / Cybersecurity / Artificial Intelligence / Citizen Services
- **Category**: Software / Browser Extension / Edge Machine Learning
- **Target Problem Statement**: Ensuring User Privacy and Personal Data Protection (DPDP Act 2023) in Next-Generation Multimodal AI and Autonomous Web Agents.

### 1.2 The Core Problem: The Privacy Crisis in Multimodal Browser Agents
The software industry is transitioning from static web browsing to **Autonomous Browser Agents** (e.g., Anthropic Claude Computer-Use, OpenAI Operator, Google Project Mariner, WebVoyager). These agents execute end-to-end tasks on behalf of users:
- Booking train and flight tickets via government and private portals.
- Managing banking transactions, insurance claims, and utility payments.
- Operating enterprise CRM, ERP, and HR management software.

To make decisions, these agents rely on **Vision-Language Models (VLMs)** that operate via a perception loop:
$$\text{Perceive}(\text{Screenshot}, \text{DOM Tree}) \longrightarrow \text{Reason} \longrightarrow \text{Act}(\text{Click}, \text{Type}, \text{Scroll})$$

```
[User Browser Session]
   │  (Contains Aadhaar, Credit Cards, Medical Data, Faces)
   ▼
[Raw Screenshot & DOM Exfiltration] ─── UNPROTECTED CLOUD TRANSMISSION ───► [Third-Party Cloud VLM]
                                                                                (OpenAI / Anthropic / Google)
                                                                                ⚠️ Cloud Logging
                                                                                ⚠️ Training Ingestion
                                                                                ⚠️ Prompt Injection / Leaks
```

**The Vulnerability**: To automate web actions, the host machine captures high-resolution screenshots (`captureVisibleTab`) and scrapes the complete DOM hierarchy. This telemetry contains:
1. **Unmasked Personal Credentials**: Passwords, session cookies, API tokens.
2. **Indian National Identifiers**: Aadhaar cards, PAN numbers, Voter IDs (EPIC), Driving Licenses, Passports.
3. **Financial Records**: Credit card numbers, CVVs, UPI IDs, bank account numbers, balances.
4. **Biometric Assets**: Profile photos, ID badge headshots, colleague pictures, live webcam feeds.
5. **Private Context**: Medical diagnoses, tax returns, personal WhatsApp Web and email messages.

This raw data is uploaded across the Internet to centralized cloud model providers, where it is logged, subjected to prompt caching, analyzed by remote employees, and exposed to prompt-injection or data-breach exploits.

### 1.3 Threat Vectors in Unsanitized VLM Telemetry

| Threat Vector | Source | Mechanism of Exposure | Severity |
| :--- | :--- | :--- | :--- |
| **Visual OCR Exfiltration** | Webpage Viewport | Images, rendered text, PDFs, and invoices contain printed PII that standard DOM filters miss entirely. | **CRITICAL** |
| **Biometric Face Profiling** | Webpage Images | Profile photos and ID cards provide unconsented facial biometrics to external AI model providers. | **CRITICAL** |
| **DOM Hierarchy Scraping** | Webpage Tree | Hidden form inputs, autocomplete metadata, and aria-labels leak masked inputs (`type="password"`). | **HIGH** |
| **Multi-Turn History Leak** | Conversation State | Cloud VLM sessions maintain image chat histories, compounding privacy leaks over dozens of turns. | **CRITICAL** |
| **Prompt Injection Leak** | Adversarial Websites | Malicious websites render text instructing the VLM to read and exfiltrate confidential screen data. | **HIGH** |

### 1.4 Statutory & Regulatory Imperative (DPDP Act 2023 / GDPR)
Failure to protect user data is no longer merely an architectural shortcoming; it is an acute legal liability:
- **Digital Personal Data Protection (DPDP) Act, 2023 (India)**:
  - **Section 4 & 6**: Mandates unambiguous consent and data minimization. Processing data beyond the explicit task violates the law.
  - **Section 8**: Data Fiduciaries must implement reasonable security safeguards to prevent personal data breaches.
  - **Penalties**: Up to **₹250 Crores ($30M USD)** per breach event under the First Schedule of the Act.
- **European Union General Data Protection Regulation (GDPR)**:
  - **Article 9**: Strict prohibition against processing biometric data (facial imagery) without explicit exemption.
  - **Article 25 (Data Protection by Design and by Default)**: Requires privacy mechanisms to be baked directly into the processing pipeline.
  - **Penalties**: Up to **€20 Million or 4% of global annual turnover**.

### 1.5 Why Existing Solutions Fail

| Traditional Solution | Why It Fails for Autonomous AI Agents |
| :--- | :--- |
| **Adblockers (uBlock, AdGuard)** | Block known third-party tracking scripts; completely blind to first-party PII rendered in valid application views. |
| **CSS Blur / UI Masks** | Only alter the browser's graphical composition layer; raw pixels captured via browser extension APIs remain 100% visible. |
| **Cloud DLP Gateways (e.g. Netskope)** | Require transmitting the unredacted payload across the network to a corporate proxy, violating the zero-trust local boundary. |
| **Pure Regex DOM Strippers** | Blind to canvas graphics, SVG charts, scanned receipts, photos, and multi-line rendered text; zero face-detection capability. |
| **Pixelation / Gaussian Blur** | Mathematically reversible using convolutional deblurring networks and diffusion models; does not guarantee zero-leakage. |

---

## 2. Slide 2: Proposed Solution & Architectural Innovation

### 2.1 The Privamon Paradigm: "Sanitize at the Edge, Reason on the Sanitized"

Privamon introduces a **Zero-Trust Client-Side Privacy Firewall** deployed as a Chrome Extension (Manifest V3) paired with an ultra-lightweight local inference runtime. 

Privamon intercepts visual and structural telemetry **before** any network packet leaves the user's browser, applies permanent, destructive mathematical redactions locally, and exports a dual-sanitized artifact:
1. **Sanitized Screenshot Canvas**: All sensitive text, IDs, and human faces are painted over with irreversible solid black rectangles (`#000000`).
2. **Sanitized Structural DOM**: Extracted DOM nodes have sensitive strings replaced with semantic tokens (`[REDACTED: email]`, `[REDACTED: aadhaar]`) while preserving spatial tags and element identifiers for robotic control.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          LOCAL USER DEVICE (FIREWALL)                       │
│                                                                             │
│   Active Tab  ──────►  [MV3 Background Sensor]                              │
│   (Sensitive)                  │                                            │
│                                ▼                                            │
│                     [Offscreen Sandbox + WASM]                              │
│                                │                                            │
│                     [In-Browser Processing Models]                          │
│                     - Tesseract.js (Eng/Hin WASM OCR)                       │
│                     - UltraFace ONNX (WebGPU/WASM)                          │
│                     - Client PII Regex & NER Engine                         │
│                     - Luhn & Verhoeff Checksums                             │
│                                │                                            │
│                                ▼                                            │
│                     [Multi-Modal IoU Fusion]                                │
│                                │                                            │
│                                ▼                                            │
│                     [Solid Redactor (#000000)]                              │
│                                │                                            │
│                                ▼                                            │
│                     [Active Opacity Verifier]                               │
└────────────────────────────────┼────────────────────────────────────────────┘
                                 │
                     ZERO-LEAKAGE PRIVACY BOUNDARY
              (Only Opaque Redacted PNG + Sanitized DOM Tree)
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │ DOWNSTREAM VLM AGENT  │
                     │ (Cloud or Local Edge) │
                     │ - Claude 3.5 Sonnet   │
                     │ - GPT-4o / Qwen-VL    │
                     └───────────────────────┘
```

### 2.2 The 3-Tier Zero-Trust Architecture

1. **Tier 1: Client-Side Browser Sensor (Chrome MV3)**:
   - Synchronously captures visual viewports via `chrome.tabs.captureVisibleTab`.
   - Injects the `DOMRangeMapper` content script to extract sub-element bounding boxes using native `Range.getClientRects()`.
   - Isolates execution inside a sandboxed `offscreen.html` environment with strict Content Security Policy (`script-src 'self' 'wasm-unsafe-eval'`).

2. **Tier 2: Browser-Native Client Processing Engine (Chrome Offscreen Sandbox)**:
   - 100% in-browser air-gapped execution environment operating within Chrome's sandboxed offscreen document.
   - Dual-engine architecture:
     - **Deterministic Pipeline**: Luhn algorithm (Credit Cards), Verhoeff algorithm (Aadhaar), PAN status code validation, UPI VPA syntax matching, and regex PII rules.
     - **Vision & OCR Pipeline**: Tesseract.js (Multilingual Eng+Hin OCR) and ONNX Runtime Web (BlazeFace/UltraFace deep neural network for ~15ms face detection).
   - **Zero External Server Dependency**: Executes entirely in-browser with zero network calls and zero uptime degradation.

3. **Tier 3: Autonomous Downstream VLM Reasoning Agent**:
   - Consumes sanitized visual artifacts and structured DOM trees.
   - Grounds visual action candidates (`click`, `type`, `scroll`, `wait`, `done`) on non-sensitive structural landmarks.
   - Operates with zero knowledge of underlying confidential data, ensuring 100% regulatory compliance.

### 2.3 How Privamon Resolves the Threat Vectors

- **Irreversible Solid Destruction**: Replaces sensitive pixel regions with `#000000` (RGBA `0, 0, 0, 255`). Unlike blur, mosaic, or pixelation, solid fills possess mathematical entropy of zero, rendering algorithmic inversion or AI reconstruction mathematically impossible.
- **Defense-in-Depth Verification**: Never assumes redaction succeeded. An automated verification pass inspects the raw canvas pixels post-redaction. If any non-black pixel bleeds through due to anti-aliasing or fractional DPI scaling, it expands the bounding box by **25%** and re-executes redaction across a 3-pass loop.
- **Exact Coordinate Synchronization**: Sub-pixel viewport scaling eliminates the coordinate drift common in multi-monitor and high-DPI (Retina) displays.

### 2.4 Competitive & Uniqueness Matrix

| Feature / Capability | Privamon | Cloud DLP (Netskope / Zscaler) | Standard Adblockers | Browser Masking (Blur CSS) | Cloud AI Anonymizers |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Execution Environment** | **100% Local (Edge)** | Cloud Proxy | Client-side | Client-side | Cloud API |
| **Visual (Screenshot) Redaction** | **YES (Pixel-Level)** | NO | NO | NO (CSS only) | YES (Slow, in cloud) |
| **Biometric Face Redaction** | **YES (UltraFace ONNX)** | NO | NO | NO | Partial |
| **India-Specific PII Checksums** | **Aadhaar, PAN, UPI, DL** | NO | NO | NO | NO |
| **Multi-Modal Triangulation** | **DOM + OCR + CV** | DOM/Network only | Network rules | None | OCR only |
| **Post-Redaction Pixel Audit** | **YES (3-Pass Verifier)**| NO | NO | NO | NO |
| **VLM Agent Action Grounding** | **YES (Sanitized DOM)** | NO | NO | NO | NO |
| **DPDP Act 2023 Compliance** | **Guaranteed Zero-Leak** | Leaks to Proxy | Inapplicable | Violates (Leaks raw) | Violates (Cloud leak) |
| **Cloud Latency Overhead** | **0 ms (Edge Only)** | 250–800 ms | 0 ms | 0 ms | 1500–4000 ms |

### 2.5 Core Technical Innovations

1. **Multi-Modal Triangulation**: Fuses DOM semantic metadata, WebAssembly OCR token spans, and deep-learning visual face detections using a unified **Intersection over Union (IoU)** arbitration engine.
2. **Sub-Element Range Mapping**: Employs `Range.getClientRects()` to split multi-line wrapped text blocks into distinct geometric boxes, eliminating the massive rectangular masks that obscure non-sensitive content on typical web pages.
3. **Cryptographic Checksum Recognizers**: Eliminates catastrophic false positives by combining regular expressions with the **Verhoeff Dihedral Group $D_5$ algorithm** for Aadhaar and the **Luhn Modulus 10 algorithm** for payment cards.
4. **Context-Gated Neural NER**: Implements alphabetic pre-gating for GLiNER transformer inference, skipping neural evaluation on pure numeric tokens for an empirical **28x to 62x speedup** on numeric inputs.
5. **Zero-Trust Opacity Auditing**: An active post-redaction canvas inspector samples pixel byte buffers via `getImageData()`, mathematically certifying that no residual clear-text or biometric pixel leaves the browser sandbox.

---

## 3. Slide 3: Technical Approach & System Design

### 3.1 Comprehensive Technology Stack Table

| Layer / Subsystem | Technology / Library | Version / Spec | Purpose & Architectural Role |
| :--- | :--- | :--- | :--- |
| **Client Extension** | JavaScript (ES2022) | Chrome MV3 | Orchestration, tab capture, DOM scraping, UI dashboards |
| **Extension Sandbox** | HTML5 Offscreen API | MV3 Reason: WORKERS | Bypasses Service Worker limits; hosts Canvas 2D & WASM |
| **Client OCR Engine** | Tesseract.js (WASM) | v5.1.0 | In-browser optical character recognition on cropped image regions |
| **Multilingual Models** | Tesseract Traineddata | Eng + Hin (`hin.traineddata`)| Multilingual text extraction for English and Hindi text |
| **Client Vision Model** | ONNX Runtime Web | v1.17+ (WASM/WebGPU) | In-browser execution of UltraFace / BlazeFace deep neural nets |
| **Face Detection Weights**| UltraFace RFB-320 | ONNX Format (320x240) | Ultra-lightweight (~1.2 MB) face detection at ~15 ms latency |
| **Client PII Engine** | JavaScript / Regex / Checksums | ES2022 | Browser-native entity detection with Aadhaar Verhoeff & Luhn validation |
| **Autonomous VLM** | Ollama / OpenRouter | Qwen2.5-VL / Claude 3.5 | Vision-Language Models for executing web automation on sanitized frames |
| **Validation Framework** | Pytest / Vitest | Automated Suite | Synthetic and end-to-end integration test suites |

---

### 3.2 System Architecture Diagrams

#### Figure 1: End-to-End System Topology & Isolation Boundary

```mermaid
flowchart TB
    subgraph BROWSER ["Client Browser Runtime (Google Chrome MV3)"]
        subgraph TAB ["Active Web Page Viewport"]
            LiveDOM["Live DOM Tree\n(Rendered Elements)"]
            Viewport["Visible Viewport Canvas"]
            DOMMapper["DOMRangeMapper Script\n(Range.getClientRects)"]
        end

        subgraph BG ["MV3 Service Worker"]
            Background["background.js\n(Event Orchestrator)"]
            SessionStore[("chrome.storage.session\n(Sanitized Artifacts)")]
        end

        subgraph OFFSCREEN ["Sandboxed Offscreen Document (offscreen.html)"]
            OffController["offscreen.js"]
            SanPipeline["sanitize-pipeline.js"]
            CanvasEngine["HTML5 Offscreen Canvas 2D"]
            TessWASM["Tesseract.js WASM\n(Eng / Hin OCR)"]
            ORTWasm["ONNX Runtime Web\n(UltraFace Model)"]
            ClientPII["Browser PII & NER Engine\n(Regex & Verhoeff / Luhn)"]
        end

        subgraph UI ["User Interface Consoles"]
            PopupUI["Popup Extension UI\n(popup.html / popup.js)"]
            ResultsUI["Inspection Console\n(results.html / results.js)"]
        end
    end

    subgraph DOWNSTREAM ["Downstream Autonomous Agent Layer"]
        AgentServer["Server-Side Reasoning Agent\n(server_side_agent/main.py)"]
        VLM_Model["Vision-Language Model\n(Ollama Qwen-VL / OpenRouter Claude)"]
        ActionExec["Browser Action Dispatcher\n(Click / Type / Scroll / Wait)"]
    end

    %% Workflow Traces
    PopupUI -->|"1. User triggers task"| Background
    Background -->|"2. Capture visible tab (PNG)"| Viewport
    Background -->|"3. Ingest coordinates"| DOMMapper
    DOMMapper -->|"4. Return tokens & layout"| Background
    Background -->|"5. Dispatch runPipeline"| OffController
    OffController --> SanPipeline

    SanPipeline <--> CanvasEngine
    SanPipeline <--> TessWASM
    SanPipeline <--> ORTWasm
    SanPipeline <--> ClientPII

    SanPipeline -->|"6. Solid Redact & Verify"| CanvasEngine
    SanPipeline -->|"7. Commit clean artifacts"| Background
    Background --> SessionStore
    SessionStore --> ResultsUI

    %% Agent Integration
    SessionStore -->|"8. Deliver Sanitized PNG & DOM"| AgentServer
    AgentServer -->|"9. Reason without PII"| VLM_Model
    VLM_Model -->|"10. Structured Action Plan"| AgentServer
    AgentServer -->|"11. Dispatch robotic action"| ActionExec
    ActionExec -->|"12. Execute click/type"| LiveDOM
```

---

#### Figure 2: The 9-Stage Master Sanitization Pipeline Dataflow

```mermaid
flowchart TD
    Start([Raw Screenshot PNG + Viewport DOM Snapshot]) --> S1

    subgraph S1_BOX ["Stage 1: DOM Semantic Analysis"]
        S1["DOM PII Detection\n(privacy/pii-detector.js)"]
        S1_Desc["- Evaluates input type, autocomplete, aria tags\n- Verhoeff algorithm for Aadhaar\n- Luhn algorithm for Cards\n- Regex checks for PAN, Phone, Email, UPI"]
    end

    S1 --> S2

    subgraph S2_BOX ["Stage 2: Visual Candidate Selection"]
        S2["Pixel Region Filtering\n(vision/ocr-engine.js)"]
        S2_Desc["- Heuristic size gating (>16px, <0.8x viewport)\n- Filters decorative icons, SVGs, background wallpapers\n- Identifies potential text images, badges, and photo cards"]
    end

    S2 --> S3 & S4

    subgraph S3_BOX ["Stage 3: Optical Character Recognition"]
        S3["OCR Processing Engine\n(Tesseract.js WASM)"]
        S3_Desc["- Offscreen Canvas crop extraction\n- English + Hindi traineddata inference\n- Extracts words, confidence scores, and local bounding boxes"]
    end

    subgraph S4_BOX ["Stage 4: Computer Vision Face Detection"]
        S4["Deep Vision Face Detector\n(ONNX Runtime Web)"]
        S4_Desc["- UltraFace RFB-320 Tensor [1, 3, 240, 320]\n- WebGPU accelerated with WASM fallback\n- Non-Maximum Suppression (NMS IoU = 0.30)\n- Flags human profiles and ID badge portraits"]
    end

    S3 & S4 --> S5

    subgraph S5_BOX ["Stage 5: Coordinate Space Mapping"]
        S5["Coordinate Transformation Engine\n(privacy/coordinate-mapper.js)"]
        S5_Desc["- Computes scaleX = imgWidth / cssWidth\n- Computes scaleY = imgHeight / cssHeight\n- Normalizes CSS viewport coordinates to physical screenshot pixels"]
    end

    S5 --> S6

    subgraph S6_BOX ["Stage 6: Multi-Modal Fusion & Arbitration"]
        S6["PII Fusion Engine\n(privacy/fusion.js & engine/fusion_engine.py)"]
        S6_Desc["- Computes Intersection-over-Union (IoU) across DOM, OCR, CV\n- Merges overlapping boxes (IoU > 0.40)\n- Resolves conflicts & assigns decisions: REDACT, REVIEW, KEEP"]
    end

    S6 --> S7

    subgraph S7_BOX ["Stage 7: Destructive Canvas Redaction"]
        S7["Canvas 2D Redactor\n(privacy/redactor.js)"]
        S7_Desc["- Loads screenshot to HTML5 Offscreen Canvas\n- Sets ctx.fillStyle = '#000000'\n- Rasterizes solid black rectangles over REDACT bounding boxes"]
    end

    S7 --> S8

    subgraph S8_BOX ["Stage 8: Active Opacity Verification"]
        S8["Pixel Opacity Verifier\n(privacy/verifier.js)"]
        S8_Desc["- Samples ctx.getImageData() across redacted regions\n- Verifies strictly opaque black (R=0, G=0, B=0, A=255)\n- If leakage detected: expands bbox by 25% & re-redacts (3 passes)"]
    end

    S8 --> S9

    subgraph S9_BOX ["Stage 9: Structural DOM Sanitization"]
        S9["DOM Sanitizer\n(dom/sanitized-dom.js)"]
        S9_Desc["- Replaces raw text nodes with tokens ([REDACTED: email])\n- Strips sensitive input values and placeholder strings\n- Preserves structural IDs (dom-tok-*) for agent visual grounding"]
    end

    S9 --> End([Sanitized Screenshot PNG + Agent-Safe DOM Tree])
```

---

#### Figure 3: Multi-Modal Triangulation & IoU Fusion Engine

```mermaid
flowchart LR
    subgraph STREAM1 ["Stream 1: DOM Semantic Stream"]
        D1["Input Semantics\n(type='password', autocomplete)"]
        D2["Rendered Text Nodes\n(Range.getClientRects)"]
    end

    subgraph STREAM2 ["Stream 2: Visual OCR Stream"]
        O1["Canvas Image Crops"]
        O2["Tesseract.js WASM\n(Eng / Hin Tokens)"]
    end

    subgraph STREAM3 ["Stream 3: Deep Vision Stream"]
        V1["Profile Photos / Badges"]
        V2["UltraFace ONNX Inference\n(Bounding Boxes)"]
    end

    STREAM1 --> FUSION_CORE
    STREAM2 --> FUSION_CORE
    STREAM3 --> FUSION_CORE

    subgraph FUSION_CORE ["Multi-Modal Fusion Core (IoU Arbitration)"]
        CoordScale["Coordinate Normalizer\n(Viewport -> Physical Pixels)"]
        IoUCalc["IoU Matrix Calculator\nIoU = Area(A ∩ B) / Area(A ∪ B)"]
        Containment["Containment Engine\n(Parent-Child BBox Merging)"]
        Classifier["Confidence & Context Classifier\n(False Positive Suppressor)"]

        CoordScale --> IoUCalc --> Containment --> Classifier
    end

    Classifier --> DecisionTree{Decision Thresholds}
    DecisionTree -->|"Confidence >= 0.65 OR Checksum Valid"| REDACT["REDACT Action\n(Paint Solid #000000)"]
    DecisionTree -->|"0.30 <= Confidence < 0.65"| REVIEW["REVIEW Action\n(Flag in UI Dashboard)"]
    DecisionTree -->|"Negative Context / Low Confidence"| KEEP["KEEP Action\n(Retain for VLM Grounding)"]
```

---

#### Figure 4: Viewport-to-Physical Coordinate Mapping Geometry

```mermaid
flowchart TD
    subgraph CSS_SPACE ["CSS Viewport Coordinate Space (Browser Logical Pixels)"]
        CSS_Box["DOM Element Bounding Box\nleft: 150px, top: 200px\nwidth: 250px, height: 40px\n(Obtained via Range.getClientRects)"]
        CSS_Dims["CSS Viewport Dimensions\ninnerWidth = 1280px\ninnerHeight = 800px"]
    end

    subgraph TRANSFORM ["Transformation Mathematics"]
        CalcX["scaleX = screenshotWidth / innerWidth\n(e.g., 2560 / 1280 = 2.00)"]
        CalcY["scaleY = screenshotHeight / innerHeight\n(e.g., 1600 / 800 = 2.00)"]
        Formula["x_phys = left * scaleX\ny_phys = top * scaleY\nw_phys = width * scaleX\nh_phys = height * scaleY"]
    end

    subgraph PHYS_SPACE ["Physical Screenshot Canvas Space (Raw Image Pixels)"]
        Phys_Box["Physical Canvas Target Bounding Box\nX: 300px, Y: 400px\nWidth: 500px, Height: 80px\n(Exact pixel alignment with captureVisibleTab)"]
    end

    CSS_Space --> TRANSFORM
    CSS_Dims --> TRANSFORM
    TRANSFORM --> PHYS_SPACE
```

---

#### Figure 5: Autonomous VLM Closed-Loop Execution Workflow

```mermaid
sequenceDiagram
    autonumber
    actor User as User
    participant Ext as Privamon Extension (MV3)
    participant Engine as Local Python Engine (127.0.0.1)
    participant Agent as Server-Side VLM Agent
    participant CloudVLM as Remote VLM (Claude / Qwen)
    participant Page as Target Webpage

    User->>Ext: 1. Input Task: "Pay electricity bill on portal"
    Ext->>Page: 2. Capture Viewport Snapshot & Extract DOM
    Ext->>Engine: 3. Query PII & Spans (Local Loopback)
    Engine-->>Ext: 4. Return Aadhaar/Card/Name Bounding Boxes
    Ext->>Ext: 5. Irreversible Canvas Redaction (#000000)
    Ext->>Ext: 6. 3-Pass Opacity Audit & Re-Redaction
    Ext->>Ext: 7. Sanitize DOM Tree (Insert [REDACTED] Tokens)

    Note over Ext,Agent: ZERO-LEAKAGE PRIVACY BOUNDARY
    Ext->>Agent: 8. Send Clean Screenshot + Sanitized DOM Tree
    Agent->>CloudVLM: 9. Prompt with Sanitized Image & Structural DOM
    CloudVLM-->>Agent: 10. Return Structured Action: {"type": "click", "targetElementId": "dom-tok-submit"}
    Agent->>Agent: 11. Self-Validate Action & Circuit-Breaker Check
    Agent->>Ext: 12. Dispatch Action Instruction
    Ext->>Page: 13. Execute Synthetic Mouse Click on Submit
    Page-->>Ext: 14. Page State Transitions to Confirmation
    Ext-->>User: 15. Task Completed Safely with Zero PII Leakage
```

---

### 3.3 Detailed 9-Stage Implementation Methodology

#### Stage 1: DOM Semantic Extraction & Range Mapping
- Injects `content/dom-range-mapper.js` dynamically via `chrome.scripting.executeScript`.
- Traverses all visible text nodes using `document.createTreeWalker`.
- Evaluates form input metadata (`type="password"`, `autocomplete="cc-number"`, `aria-label`).
- Utilizes the W3C `Range.getClientRects()` API to compute per-line geometric rectangles for wrapped text, assigning unique identifiers (`dom-tok-0`, `dom-tok-1`).
- Runs client-side deterministic algorithms:
  - **Aadhaar Verhoeff Checksum**: Implements multiplication ($d$) and permutation ($p$) matrices over dihedral group $D_5$ to detect all single-digit errors and transposition errors.
  - **Luhn Algorithm**: Modulus 10 validation on candidate payment cards.

#### Stage 2: Pixel Region Selection & Heuristic Filtering
- Inspects all visual elements (`<img>`, `<canvas>`, `<video>`, `<svg>`).
- Applies heuristic size and aspect ratio gating:
  - Discards small icons ($< 16 \text{ px}$ in width or height).
  - Discards giant background wrappers ($> 0.8 \times \text{viewport area}$).
  - Gathers candidate crops for OCR and facial analysis.

#### Stage 3: OCR Processing Engine
- Initializes a dedicated Tesseract.js WebAssembly worker inside the offscreen document.
- Loads pre-compiled language data: English (`eng.traineddata`) and Hindi (`hin.traineddata`).
- Crops candidate pixel regions onto an offscreen canvas and runs optical character recognition.
- Aligns recognized word bounding boxes to physical screenshot coordinates, capturing text embedded inside images, scanned PDFs, and invoices.

#### Stage 4: Deep Vision Face Detection
- Instantiates ONNX Runtime Web inside the offscreen sandbox using WebGPU (falling back to WASM SIMD).
- Loads the UltraFace RFB-320 deep neural network (~1.2 MB).
- Resizes candidate crops to $320 \times 240$ tensors, applying mean subtraction ($\mu = 127.0$) and standard deviation scaling ($\sigma = 128.0$).
- Decodes confidence logits and bounding box regression tensors, applying Non-Maximum Suppression (NMS with $\text{IoU} \ge 0.30$) to detect human faces in profile photos, ID cards, and galleries.

#### Stage 5: Coordinate Space Mapping
- Unifies disparate coordinate frames:
  - DOM elements report logical CSS viewport coordinates via `getBoundingClientRect()`.
  - Raw screen captures from `captureVisibleTab()` report physical device pixels influenced by `devicePixelRatio` and OS display scaling.
- Applies linear scaling:
  $$\text{scaleX} = \frac{\text{screenshotWidth}}{\text{cssViewportWidth}}, \quad \text{scaleY} = \frac{\text{screenshotHeight}}{\text{cssViewportHeight}}$$
- Transforms logical coordinates into physical canvas pixel space without scroll-induced offsets.

#### Stage 6: Multi-Modal IoU Fusion & Arbitration
- Combines detections across DOM, OCR, and Vision streams.
- Computes Intersection over Union (IoU) across candidate bounding boxes:
  $$\text{IoU}(A, B) = \frac{\text{Area}(A \cap B)}{\text{Area}(A \cup B)}$$
- Merges clusters where $\text{IoU} \ge 0.40$ or where spatial containment ($A \subseteq B$) occurs.
- Arbitrates actions:
  - `REDACT`: Confidence $\ge 0.65$ or validated via checksum.
  - `REVIEW`: Confidence between $0.30$ and $0.65$ (flagged in user dashboard).
  - `KEEP`: Contextually benign or false-positive matches.

#### Stage 7: Destructive Canvas Redaction
- Loads the raw screenshot into an HTML5 `OffscreenCanvas` with a `2d` rendering context.
- Iterates over all candidates designated as `REDACT`.
- Enforces solid opaque rasterization:
  ```javascript
  ctx.fillStyle = '#000000';
  ctx.fillRect(bbox.x, bbox.y, bbox.width, bbox.height);
  ```
- Irreversibly overwrites underlying image pixels, producing a sanitized PNG Data URL.

#### Stage 8: Active Opacity Verification & Re-Redaction
- Extracts byte buffers from the redacted canvas using `ctx.getImageData()`.
- Validates that every pixel in each redacted bounding box conforms to strictly opaque black ($\text{RGBA} = [0, 0, 0, 255]$).
- **Auto-Expansion Safeguard**: If sub-pixel anti-aliasing or font bleed is detected, expands the bounding box by **25%** in all dimensions ($\text{EXPAND\_FACTOR} = 0.25$) and re-redacts over a 3-pass loop.

#### Stage 9: Structural DOM Sanitization
- Iterates over extracted DOM nodes matching confirmed PII spans.
- Replaces raw sensitive values and text with deterministic tokens (`[REDACTED: email]`, `[REDACTED: aadhaar]`, `[REDACTED: name]`).
- Retains semantic HTML tags, ARIA roles, and `elementId` properties, producing a sanitized DOM representation safe for robotic VLM consumption.

---

### 3.4 Server-Side Autonomous Reasoning Agent Workflow

Privamon includes a complete autonomous web agent (`server_side_agent/main.py`) demonstrating how downstream AI systems interact with sanitized telemetry:
- **API Endpoint**: `POST /interpret` receiving sanitized screenshot PNG, sanitized DOM tree, prior actions, and task prompt.
- **Strict Structured Action Schema**: Enforces output conformance using Pydantic:
  ```python
  class ActionPayload(BaseModel):
      type: Literal["click", "type", "scroll", "wait", "key_combination", "done", "ask_clarification"]
      targetElementId: Optional[str] = None
      value: Optional[str] = None
      coordinate: Optional[List[int]] = None
  ```
- **Circuit Breaker Deduplication**: Detects repetitive actions on the same input container, breaking out of infinite agent loops.
- **Audit Logging**: Emits structured JSONL audit logs (`audit_log.jsonl`) recording reasoning, confidence, and timestamps for regulatory compliance.

---

## 4. Slide 4: Feasibility, Viability & Risk Analysis

### 4.1 Technical Feasibility Analysis

1. **Client-Side Edge Viability**:
   - Privamon executes on standard consumer hardware without requiring dedicated GPUs.
   - The in-browser stack utilizes **WebAssembly (WASM)** and **WebGPU**, achieving near-native execution speeds.
   - Memory footprint: The Chrome extension sandbox consumes $\sim 85 \text{ MB}$ of RAM during active inference.
   - The native Python engine utilizes SpaCy's lightweight `en_core_web_sm` model ($\sim 12 \text{ MB}$ footprint) and loads GLiNER once at startup.

2. **Network Independence**:
   - The entire privacy pipeline operates locally. No internet connectivity is required to detect PII, compute checksums, run OCR, or redact screenshots.

### 4.2 Empirical Latency & Optimization Benchmarks

Privamon underwent systematic profiling and architectural optimization (documented in `PERFORMANCE_REPORT.md`). The implementation of **GLiNER eligibility gating**, **Presidio recognizer pruning**, and a **SHA-256 LRU cache** yielded dramatic speedups:

| Scenario / Input Type | Baseline Latency | Optimized Latency | Speedup Factor | Optimization Mechanism |
| :--- | :---: | :---: | :---: | :--- |
| **Numeric-Only Strings (Aadhaar, IDs)** | 225.0 ms | **8.02 ms** | **28.1x Faster** | Gating skips expensive neural NER on digits |
| **Short Alphanumeric Codes (`ABC123`)** | 210.0 ms | **3.35 ms** | **62.7x Faster** | Pre-checks filter non-sentential tokens |
| **Tracking Numbers (`AWB# 9876...`)** | 215.0 ms | **4.01 ms** | **53.6x Faster** | Negative prefix suppression regex |
| **Full Natural Sentences with Names** | 350.0 ms | **150.58 ms** | **2.3x Faster** | Streamlined GLiNER labels (4 core classes) |
| **Address & Contact Blocks** | 320.0 ms | **146.39 ms** | **2.2x Faster** | Pruned 19 irrelevant foreign recognizers |
| **Repeated / Cached Inputs** | 350.0 ms | **< 1.00 ms** | **> 300x Faster** | Cryptographic SHA-256 bounded LRU cache |
| **Face Detection (UltraFace ONNX)** | 180.0 ms | **15.20 ms** | **11.8x Faster** | WebGPU execution provider + RFB-320 weights |
| **Canvas Redaction + Verification** | 12.0 ms | **4.10 ms** | **2.9x Faster** | TypedArray pixel sampling buffer |

*Validation: 100% pass rate across the 19-test automated test suite (`pytest tests/ -v`).*

---

### 4.3 Comprehensive Risk Analysis & Mitigation Matrix

```
┌────────────────────────────────────────────────────────────────────────┐
│                        RISK IMPACT vs PROBABILITY                      │
│                                                                        │
│   HIGH    │ [Risk 3: False Positives]    [Risk 1: Coord Drift]         │
│   IMPACT  │ (Order IDs as Phones)         (High-DPI Desync)            │
│           │                                                            │
│   MED     │ [Risk 6: Complex Fonts]      [Risk 4: NER Latency]         │
│   IMPACT  │ (Low OCR Confidence)         (Page Freeze)                 │
│           │                                                            │
│   LOW     │ [Risk 5: Worker Term.]       [Risk 2: Multi-line Mask]     │
│   IMPACT  │ (MV3 Inactivity)             (Intervening Line Redaction)  │
│           └────────────────────────────────────────────────────────────┤
│                    LOW PROBABILITY               HIGH PROBABILITY      │
└────────────────────────────────────────────────────────────────────────┘
```

| Risk ID | Failure Mode / Potential Challenge | Severity | Probability | Architectural Mitigation in Privamon |
| :---: | :--- | :---: | :---: | :--- |
| **R1** | **Viewport & Coordinate Desynchronization**<br>Display scaling (Retina/4K) causes redaction boxes to shift, leaving PII exposed. | **CRITICAL** | High | Dynamic scale factor derivation ($\text{scaleX}, \text{scaleY}$) synchronizing CSS coordinates with physical canvas pixels without scroll offset subtractions. |
| **R2** | **Multi-Line Text Mask Blanketing**<br>Wrapping text produces a single giant rectangle that masks unrelated safe content. | **MEDIUM** | High | `DOMRangeMapper` uses `Range.getClientRects()` to segment multi-line entities into discrete, line-by-line bounding boxes. |
| **R3** | **False Positive Code Redactions**<br>Tracking numbers, invoice numbers, and PIN codes misclassified as phone numbers or OTPs. | **HIGH** | Medium | Context-aware suppression engine (`NEGATIVE_PREFIX_KEYWORDS`) filtering order, invoice, SKU, and pincode prefixes prior to evaluation. |
| **R4** | **Neural NER Computational Bottleneck**<br>Running transformer models on every string causes browser tab freezing. | **HIGH** | High | Alphabetic gating (`is_eligible_for_ner`) requires $\ge 2$ words and $\ge 8$ chars; skips NER on codes, achieving an 8 ms response time. |
| **R5** | **Service Worker Lifecycle Termination**<br>Chrome MV3 terminates idle background service workers mid-pipeline. | **MEDIUM** | Low | Offscreen document sandbox (`offscreen.html`) maintains long-running compute loops without being subject to 30-second service worker timeouts. |
| **R6** | **Font Anti-Aliasing Bleed**<br>Sub-pixel text rendering leaves colored fringing around redaction box edges. | **HIGH** | Medium | Opacity Verifier (`verifier.js`) samples canvas pixels post-redaction and auto-expands bounding boxes by **25%** if non-black pixels are found. |
| **R7** | **Offline Browser Execution**<br>User operates in an air-gapped environment. | **MEDIUM** | Low | 100% browser-native execution: WASM OCR, ONNX Web, and JS checksums run locally with zero server dependency. |
| **R8** | **Autonomous Agent Infinite Loops**<br>VLM enters a repetitive typing loop on sanitized forms. | **MEDIUM** | Low | Circuit breaker deduplication in `server_side_agent/model_client.py` halts duplicate actions and transitions to completion. |

---

### 4.4 Operational & Commercial Viability

- **Zero Cloud Infrastructure Cost**: Because all sanitization occurs on client devices, deploying Privamon to millions of users incurs **$0 in cloud server or GPU inference costs** for the privacy firewall layer.
- **Enterprise Fleet Deployment**: Distributable via Google Chrome Enterprise Management (.crx package / GPO policy), allowing instant deployment across corporate workstations without proxy configuration.
- **Developer Extensibility**: The decoupled modular architecture allows AI developers to drop Privamon in front of any existing agent framework (LangChain, CrewAI, AutoGen, Browserbase) via standard REST or browser extension APIs.

---

## 5. Slide 5: Impact, Benefits & Value Proposition

### 5.1 Target Audience & Beneficiary Ecosystem

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             PRIVAMON ECOSYSTEM                              │
├──────────────────────────┬──────────────────────────┬───────────────────────┤
│    EVERYDAY CITIZENS     │  ENTERPRISE WORKFORCES   │   AI AGENT BUILDERS   │
│ - Booking travel tickets │ - Customer Support (CRM) │ - Autonomous Agents   │
│ - Filing tax returns     │ - Financial Operations   │ - Web Automation SDKs │
│ - Banking transactions   │ - Healthcare & Medical   │ - Cloud Model Labs    │
├──────────────────────────┼──────────────────────────┼───────────────────────┤
│ Shield personal Aadhaar, │ Ensure zero corporate    │ Achieve turn-key DPDP │
│ PAN, and family photos   │ data leaks while adopted │ Act compliance with   │
│ from cloud AI storage    │ cutting-edge AI tools    │ zero backend overhead │
└──────────────────────────┴──────────────────────────┴───────────────────────┘
```

1. **Everyday Citizens & Consumers**:
   - Protects personal identities when using consumer AI assistants for booking travel, shopping, or drafting communications.
   - Shields biometric identities and family photos from persistent cloud storage.

2. **Enterprise & Regulated Industries (BFSI, Healthcare, Legal)**:
   - Enables financial institutions and hospitals to safely authorize autonomous AI agents on employee workstations without exposing customer PII or electronic health records (EHR).

3. **Government & Public Sector Services**:
   - Enables secure deployment of AI copilots across Digital India platforms (e.g., UMANG, Digilocker, Income Tax e-filing) with full compliance with citizen data protection laws.

4. **Autonomous AI Developers & Researchers**:
   - Provides a plug-and-play, standard-compliant visual privacy layer, unlocking commercial deployment in regulated sectors.

---

### 5.2 Multi-Dimensional Benefits Assessment

#### 1. Social & Ethical Benefits
- **Democratization of AI with Dignity**: Enables citizens from all demographics to utilize autonomous AI without sacrificing fundamental rights to privacy and biometric autonomy.
- **Multilingual Inclusivity**: Built-in support for Indian languages (Hindi + English OCR models), protecting diverse regional populations across India.
- **Defense Against Identity Theft**: Eliminates the risk of deepfake generation and financial fraud caused by scraped selfies and national ID cards.

#### 2. Economic & Commercial Benefits
- **Avoidance of Catastrophic Regulatory Fines**: Protects Indian enterprises from penalties up to **₹250 Crores** under the DPDP Act 2023, and global enterprises from fines up to **€20M / 4% of turnover** under GDPR.
- **60%+ Reduction in Cloud VLM Token Costs**: Sanitizing the DOM tree and compressing viewport telemetry dramatically reduces input token counts passed to commercial cloud models (e.g., GPT-4o, Claude 3.5), slashing operational API costs.
- **Accelerated Enterprise AI Adoption**: Removes the primary compliance barrier preventing Fortune 500 CISOs from adopting autonomous AI browser agents.

#### 3. Environmental & Computational Benefits
- **Edge Efficiency**: Executing inference locally on lightweight, quantized models (UltraFace ~1.2 MB, SpaCy ~12 MB) consumes milliwatt-hours of energy compared to the massive carbon footprint of streaming 4K video feeds to centralized data center GPUs.
- **Bandwidth Conservation**: Transmits optimized, sanitized crops and tokenized DOM trees rather than raw gigabyte-scale telemetry streams.

---

### 5.3 Statutory Compliance Mapping

| Legal / Regulatory Standard | Specific Statutory Requirement | Privamon Architectural Enforcement |
| :--- | :--- | :--- |
| **India DPDP Act 2023 (Sec 4)** | Grounds for processing personal data | Only sanitized, non-personal tokens exit the local browser boundary. |
| **India DPDP Act 2023 (Sec 8)** | Duty to implement reasonable security safeguards | 3-pass opacity verification and irreversible `#000000` rasterization. |
| **India DPDP Act 2023 (Schedule 1)**| Penalty up to ₹250 Cr for data breach failure | Zero-leakage mathematical guarantee eliminates data breach vectors. |
| **EU GDPR (Article 9)** | Prohibition on processing biometric data | Local UltraFace ONNX engine detects and redacts human faces client-side. |
| **EU GDPR (Article 25)** | Privacy by Design and by Default | Extension intercepts telemetry before transmission by default. |
| **RBI Master Directions (IT)** | Protection of customer financial credentials | Card numbers (Luhn), CVVs, and UPI VPAs are scrubbed at the edge. |
| **PCI-DSS (Req 3.4)** | Render Primary Account Numbers unreadable | Destructive pixel fill prevents card number recovery. |

---

## 6. Research, Academic Foundations & References

### 6.1 Peer-Reviewed Research Literature

1. **GLiNER: Generalist Model for Named Entity Recognition using Bidirectional Transformer Encoders**  
   *Zaratiana, U., Tomeh, N., Holat, P., & Charnois, T. (2024).*  
   *Demonstrates state-of-the-art zero-shot and few-shot NER performance using bidirectional transformer encoders, providing the foundation for Privamon's contextual entity extraction.*
   - Link: [arXiv:2311.08526](https://arxiv.org/abs/2311.08526)

2. **BlazeFace: Sub-millisecond Neural Face Detection on Mobile GPUs**  
   *Bazarevsky, V., Kartynnik, Y., Vakunov, A., Raveendran, K., & Grundmann, M. (Google Research, 2019).*  
   *Pioneers compact anchor schemes and lightweight convolutional architectures for ultra-fast edge face detection, utilized in Privamon's client-side ONNX engine.*
   - Link: [arXiv:1907.05047](https://arxiv.org/abs/1907.05047)

3. **WebVoyager: Building an End-to-End Web Agent with Large Multimodal Models**  
   *He, H., Yao, W., Ma, K., Yu, D., Dai, H., & Chen, Y. (2024).*  
   *Establishes the perception-action benchmark for visual web agents, serving as the target architecture safeguarded by Privamon.*
   - Link: [arXiv:2401.13919](https://arxiv.org/abs/2401.13919)

4. **Mind2Web: Towards a Generalist Agent for the Web**  
   *Deng, X., Gu, Y., Zheng, B., Chen, S., Stevens, S., Wang, B., Sun, H., & Su, Y. (2023).*  
   *Analyzes DOM element grounding and multimodal visual challenges in autonomous web automation.*
   - Link: [arXiv:2306.06070](https://arxiv.org/abs/2306.06070)

5. **An Overview of the Tesseract OCR Engine**  
   *Smith, R. (Google Inc., 2007).*  
   *Documents line-finding, word-recognition, and multi-lingual character analysis adapted for Privamon's WebAssembly OCR worker.*
   - Link: [ICDAR 2007 Proceedings](https://doi.org/10.1109/ICDAR.2007.4378687)

6. **Microsoft Presidio: Data Protection and De-identification SDK**  
   *Microsoft Open Source Architecture (2021–2024).*  
   *Provides extensible pattern recognizers and orchestrators for enterprise data protection.*
   - Link: [github.com/microsoft/presidio](https://github.com/microsoft/presidio)

---

### 6.2 Mathematical Formulations & Algorithms

#### 1. Verhoeff Checksum Algorithm (Dihedral Group $D_5$)
The Verhoeff algorithm validates 12-digit Indian Aadhaar numbers using non-commutative permutation and multiplication tables based on the symmetries of a regular pentagon ($D_5$).

Given an $n$-digit number represented as a sequence of digits $a_n a_{n-1} \dots a_1$:
$$c = \sum_{i=1}^{n} d\left(c, p\left(i \bmod 8, a_i\right)\right)$$
Where:
- $d(j, k)$ is the multiplication operation in the dihedral group $D_5$.
- $p(pos, val)$ is the permutation matrix operating on position and value.
- A valid Aadhaar number strictly satisfies $c = 0$.

#### 2. Luhn Modulus 10 Checksum Algorithm
Validates payment card numbers by doubling every second digit from right to left:
$$\left( \sum_{i=1}^{k} a_i + \sum_{j=1}^{m} \left( 2b_j - 9 \cdot \mathbb{I}_{\{2b_j > 9\}} \right) \right) \equiv 0 \pmod{10}$$

#### 3. Intersection over Union (IoU) Bounding Box Formulation
Used by the fusion engine to cluster multi-modal detections:
$$\text{IoU}(A, B) = \frac{\text{Area}(A \cap B)}{\text{Area}(A \cup B)} = \frac{\max(0, x_2 - x_1) \times \max(0, y_2 - y_1)}{\text{Area}(A) + \text{Area}(B) - \text{Area}(A \cap B)}$$
Boxes are merged when $\text{IoU}(A, B) \ge 0.40$.

---

### 6.3 Statutory Acts & Technical Standards

- **The Digital Personal Data Protection Act, 2023 (Act No. 22 of 2023)**, Ministry of Law and Justice, Government of India. [Gazette of India, CG-DL-E-12082023-248045].
- **Regulation (EU) 2016/679 (General Data Protection Regulation)**, European Parliament and Council of the European Union.
- **W3C Chrome Extensions Manifest V3 Specification**, World Wide Web Consortium (W3C) WebExtensions Community Group.

---

## 7. SIH 2026 Presentation Drafting Kit (Slide-by-Slide Deck)

Use the following slide cards directly to draft your official PowerPoint presentation:

```
================================================================================
                                   SLIDE 1
================================================================================
TITLE: PRIVAMON — ZERO-LEAKAGE EDGE PRIVACY FIREWALL FOR AUTONOMOUS AI AGENTS
SUBTITLE: Shielding Citizen Data, Biometrics, and National IDs in Multimodal Web Automation
TEAM NAME: [Insert Your Team Name] | THEME: Smart Automation / Cybersecurity (SIH 2026)

KEY BULLET POINTS:
• The Autonomous AI Dilemma: Modern Vision-Language Agents (Claude, Operator, WebVoyager)
  capture unredacted browser viewports, exfiltrating sensitive screens to cloud servers.
• Critical Data at Risk: High-resolution screenshots leak Aadhaar cards, PAN numbers,
  credit cards, passwords, medical records, and live facial biometrics.
• Severe Legal Exposure: Violates India's DPDP Act 2023 (penalties up to ₹250 Crores)
  and EU GDPR Article 9 (biometric surveillance restrictions).
• Current Solutions Fail: Adblockers and CSS masks only alter display styling;
  raw underlying pixels are still uploaded directly to cloud AI endpoints.

RECOMMENDED VISUAL:
- Diagram showing Raw Browser Screen with Aadhaar/Face leaking to Cloud VLM vs. Risk Triangle.

30-SECOND SPEAKER PITCH SCRIPT:
"Respected jury members, as autonomous AI browser agents automate everyday tasks like booking tickets
and managing finances, they introduce a catastrophic privacy crisis. To operate, they capture full
screen snapshots and upload raw Aadhaar cards, bank details, and personal faces to remote cloud models.
This directly violates India's DPDP Act 2023, exposing organizations to ₹250 Crore penalties.
Traditional adblockers and CSS blur cannot stop this because raw pixels are still exfiltrated.
We present Privamon: the world's first edge-native privacy firewall that sanitizes screens locally
before AI agents can ever see them."
================================================================================
```

```
================================================================================
                                   SLIDE 2
================================================================================
TITLE: PROPOSED SOLUTION — CLIENT-SIDE MULTI-MODAL PRIVACY FIREWALL
SUBTITLE: Intercepting, Redacting, and Certifying Screen Data Locally at the Edge

KEY BULLET POINTS:
• The Privamon Paradigm: 'Sanitize at the Edge, Reason on the Sanitized.'
  Zero unredacted visual or DOM data is ever permitted to leave the user's device.
• Multi-Modal Triangulation: Discovers sensitive entities by fusing 3 distinct data streams:
  1. DOM Semantic Metadata | 2. In-Browser WASM OCR | 3. UltraFace ONNX Computer Vision.
• Irreversible Solid Redaction: Overwrites sensitive text and faces with solid black
  raster fills (#000000) having zero mathematical entropy—preventing AI inversion.
• Active Opacity Verification: An automated post-redaction audit inspects canvas pixels
  and auto-expands bounding boxes by 25% if any sub-pixel bleeding is detected.
• 100% In-Browser Execution: Runs entirely in-browser via WASM & ONNX Web
  with zero external backend dependencies and sub-15ms enterprise performance.

RECOMMENDED VISUAL:
- Side-by-Side screenshot comparison: Unsanitized Webpage vs. Privamon Solid Redacted Output with Overlay Badges.

30-SECOND SPEAKER PITCH SCRIPT:
"Privamon acts as an unbreachable privacy airlock between the browser and the AI agent.
Before any screen capture leaves the machine, Privamon triangulates sensitive data using DOM
semantics, in-browser WebAssembly OCR, and deep learning face detection. It validates Indian
identifiers like Aadhaar using the Verhoeff mathematical checksum to prevent false positives.
Then, it permanently obliterates sensitive pixels with solid black rectangles and verifies
pixel opacity with a 3-pass audit. The AI agent receives a perfectly sanitized screenshot and
DOM tree, allowing it to navigate the web flawlessly without ever viewing private data."
================================================================================
```

```
================================================================================
                                   SLIDE 3
================================================================================
TITLE: TECHNICAL APPROACH & SYSTEM ARCHITECTURE
SUBTITLE: Chrome Manifest V3 Orchestration, WebAssembly, and Transformer NER

KEY BULLET POINTS:
• Manifest V3 Offscreen Sandbox: Bypasses Service Worker limits using an offscreen
  document hosting Canvas 2D, Tesseract.js (Eng/Hin), and ONNX Runtime Web.
• Viewport-to-Pixel Coordinate Sync: Sub-element Range.getClientRects() mapping
  eliminates multi-line text distortion and high-DPI (Retina) scaling drift.
• India-Centric Checksum Suite: Verhoeff algorithm for Aadhaar, Luhn for credit cards,
  and regex status code repair for Indian PAN and UPI virtual payment addresses.
• Browser-Native PII Engine: Combines Tesseract.js WASM, ONNX Web BlazeFace vision models,
  and client-side Verhoeff & Luhn validation suite.
• Autonomous Reasoning Loop: Server-side VLM agent executes clicks and keystrokes
  on sanitized structural landmarks using strict Pydantic JSON schemas.

RECOMMENDED VISUAL:
- End-to-End System Topology Diagram (Figure 1) + 9-Stage Pipeline Flowchart (Figure 2).

30-SECOND SPEAKER PITCH SCRIPT:
"Our technical approach combines cutting-edge web engineering with local AI acceleration.
Built strictly on Chrome Manifest V3, Privamon isolates heavy processing inside an offscreen
sandbox using WebAssembly and WebGPU. We solve the difficult challenge of multi-line wrapped
text using browser-native Range ClientRects, segmenting text into precise line boxes.
Our browser engine pairs Tesseract.js WASM with ONNX Runtime Web, accelerated by our
eligibility gating that drops latency from 225ms down to 8ms. We achieve sub-pixel redaction
accuracy with an automated 9-stage pipeline that completes in under 150 milliseconds."
================================================================================
```

```
================================================================================
                                   SLIDE 4
================================================================================
TITLE: FEASIBILITY, VIABILITY & RISK MITIGATION
SUBTITLE: Lightweight Hardware Footprint, Sub-10ms Latency, and Industrial Hardening

KEY BULLET POINTS:
• Consumer Hardware Feasibility: Consumes only ~85 MB RAM in the browser; operates
  on commodity laptops without discrete GPUs using WebAssembly and WebGPU.
• Proven Latency Optimization: Numeric PII processed in 8.02 ms (28x speedup);
  face detection in 15.2 ms; repeated inputs return in < 1 ms via SHA-256 LRU cache.
• Zero Cloud Server Costs: 100% edge processing means scaling to 10 million users
  incurs $0 in backend server or cloud GPU infrastructure costs.
• Industrial Risk Hardening:
  - Coordinate Drift: Resolved via dynamic viewport-to-pixel scaling formulas.
  - False Positives: Suppressed via negative context filtering (orders, SKUs, invoices).
  - Worker Timeouts: Mitigated via persistent offscreen sandbox containers.
  - Font Bleed: Eliminated via active opacity auditing with 25% safety padding.

RECOMMENDED VISUAL:
- Benchmark Bar Chart (Baseline vs. Optimized Latency) + Risk Matrix Table.

30-SECOND SPEAKER PITCH SCRIPT:
"Privamon is engineered for immediate real-world viability. Because all inference executes
directly on the user's laptop using lightweight quantized models, deploying to millions of users
requires zero cloud GPU infrastructure. Through rigorous profiling, we reduced numeric PII
latency by 28 times—down to just 8 milliseconds. We have systematically addressed critical
production failure modes: coordinate drift on 4K displays is solved mathematically, false positives
on order IDs are suppressed through negative context filtering, and edge bleed is caught by our
25% safety expansion loop. All 19 automated integration tests pass with zero regressions."
================================================================================
```

```
================================================================================
                                   SLIDE 5
================================================================================
TITLE: IMPACT, BENEFITS & VALUE PROPOSITION
SUBTITLE: Upholding Privacy as a Fundamental Right while Unlocking Enterprise AI

KEY BULLET POINTS:
• Societal & Citizen Impact: Protects fundamental digital privacy rights across India;
  safeguards biometric identity (faces) and vernacular users (Hindi + English OCR).
• 100% DPDP Act 2023 Compliance: Guarantees zero-leakage compliance with Sections 4 & 8,
  insulating Indian organizations from crippling ₹250 Crore non-compliance penalties.
• 60%+ Cloud Token Cost Savings: Sanitized DOM trees compress token context, significantly
  slashing monthly API bills for commercial AI browser agent deployments.
• Unlocks Regulated Sectors: Empowers banks (BFSI), hospitals, and government portals
  to safely deploy autonomous AI agents without risking customer data exfiltration.
• Sustainable Computing: Edge filtering eliminates gigabytes of continuous video streaming
  to data centers, reducing global AI carbon emissions and energy consumption.

RECOMMENDED VISUAL:
- Beneficiary Persona Icons (Citizen, Enterprise, AI Builder) + DPDP Act Compliance Badge.

30-SECOND SPEAKER PITCH SCRIPT:
"The impact of Privamon is transformative across social, legal, and economic dimensions.
Socially, it protects 1.4 billion citizens by ensuring their Aadhaar cards, medical histories,
and biometric faces cannot be harvested by foreign AI cloud databases.
Economically, it shields enterprises from ₹250 Crore DPDP Act penalties while slashing cloud
VLM token costs by over 60%.
Privamon removes the single greatest security barrier blocking the enterprise adoption of AI
agents, proving that India can lead the world in privacy-preserving artificial intelligence."
================================================================================
```

```
================================================================================
                                   SLIDE 6
================================================================================
TITLE: RESEARCH, REFERENCES & ACADEMIC FOUNDATIONS
SUBTITLE: Built upon Peer-Reviewed Literature, Cryptographic Algorithms, and Global Standards

KEY BULLET POINTS:
• Academic Research Foundations:
  - GLiNER: Bidirectional Transformer Encoders for Zero-Shot NER (Zaratiana et al., 2024).
  - BlazeFace / UltraFace: Sub-millisecond Neural Face Detection on Edge (Google Research).
  - WebVoyager & Mind2Web: Multimodal Web Agent Benchmarks (He et al., 2024).
• Mathematical Formulations:
  - Verhoeff Checksum: Non-commutative Dihedral Group D5 for error-proof Aadhaar checks.
  - Luhn Modulus 10 Algorithm: Formal credit card validation matrix.
  - Spatial Intersection-over-Union (IoU) Bounding Box Clustering (IoU ≥ 0.40).
• Statutory Standards:
  - Digital Personal Data Protection (DPDP) Act, 2023 (Ministry of Law & Justice, GoI).
  - EU General Data Protection Regulation (Regulation EU 2016/679).
  - W3C Manifest V3 Offscreen Document Security Specifications.

RECOMMENDED VISUAL:
- Collage of Research Paper Titles + Verhoeff Dihedral Multiplication Table Matrix ($D_5$).

30-SECOND SPEAKER PITCH SCRIPT:
"Privamon is grounded in peer-reviewed science and rigorous mathematics.
Our contextual entity extraction builds upon GLiNER transformer research published in 2024,
while our vision pipeline leverages Google's BlazeFace architecture for sub-millisecond edge
inference. Our validation relies on foundational mathematics: the Verhoeff dihedral group D5
algorithm guarantees error-proof Aadhaar verification, and our spatial fusion uses formal
Intersection-over-Union clustering. By aligning cutting-edge academic AI with the statutory
mandates of India's DPDP Act 2023 and W3C web standards, Privamon stands ready for nationwide
deployment. Thank you, and we welcome your questions."
================================================================================
```

---

### Jury Defense Q&A Master Guide

Prepare for the top questions likely to be asked by the SIH Technical Evaluation Jury:

#### Q1: "Why not simply run the VLM agent on the server and sanitize it there?"
**Answer**:  
"Transmitting raw, unredacted screenshots to an external server—even our own—inherently breaches the zero-trust boundary and violates Sections 4 & 6 of the DPDP Act 2023. If the transit network is intercepted, or if the server logs images, user PII is compromised. By performing 100% of detection and redaction directly inside the user's browser offscreen sandbox before transmission, we provide a mathematical guarantee that cleartext PII never leaves the local machine."

#### Q2: "Can't modern generative AI or deconvolution networks reconstruct the blurred data?"
**Answer**:  
"Yes, which is precisely why Privamon does **not** use blur, pixelation, or mosaic masking. Privamon utilizes **Canvas 2D solid black fills (`#000000`)**. A solid black fill has a mathematical Shannon entropy of zero. The original pixel byte values are overwritten in memory, leaving zero residual signals or gradient information for any neural network to reconstruct."

#### Q3: "How do you handle Indian names and vernacular text in documents?"
**Answer**:  
"We implement a dual-strategy approach:
1. For visual text, our Tesseract.js WASM engine is bundled with both English (`eng.traineddata`) and Hindi (`hin.traineddata`) language models.
2. For entity recognition, our browser PII engine combines pattern-based detection with Verhoeff and Luhn checksum validation to identify Indian names, IDs, and financial credentials."

#### Q4: "What happens if a user is on a slow machine without a dedicated GPU?"
**Answer**:  
"Privamon was explicitly architected for low-resource environments. The in-browser face detector uses UltraFace RFB-320, a tiny 1.2 MB quantized ONNX model that runs via WebAssembly SIMD in ~15 ms on standard Intel Core i3/i5 CPUs. Furthermore, our alphabetic gating skips expensive processing for numeric tokens, processing IDs in just 8 ms. The extension operates 100% in-browser via WASM and ONNX Runtime Web with zero external backend server dependencies."

#### Q5: "How does the autonomous agent know where to click if elements are redacted?"
**Answer**:  
"While the visual pixels are blacked out, our **Stage 9: DOM Sanitization** preserves the structural HTML hierarchy, ARIA roles, and element IDs (`dom-tok-*`). The VLM receives the visual layout to understand spatial structure and references the sanitized DOM tree to locate interactive buttons and input containers. Clicks and keystrokes are grounded on structural element selectors, ensuring full automation capabilities without exposing the underlying confidential text."

---

## 8. Automated Test Suite & Verification Commands

To verify Privamon's browser-native architecture and autonomous reasoning agent, run:

```bash
# 1. Install Extension Dependencies and Copy Vendor Libraries
npm install
npm run setup

# 2. Run Extension Integration & Synthetic Suite Tests
npm test

# 3. Test Autonomous VLM Loop Verification & Adapter
python test_vlm_adapter.py
python test_loop_verification.py
python test_whatsapp_dom.py

# 4. Start Server-Side VLM Reasoning Agent (Optional)
uvicorn server_side_agent.main:app --port 8000 --reload
```

---

*Privamon — Built for the Smart India Hackathon (SIH 2026). Dedicated to privacy-preserving artificial intelligence and digital data sovereignty.*
