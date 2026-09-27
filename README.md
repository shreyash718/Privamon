# Privamon — Privacy-Preserving Browser Agent

Privamon is a 100% browser-native privacy-first browser agent that intercepts and sanitizes sensitive screen content (Personally Identifiable Information, credentials, sensitive documents, and human faces) **locally inside your browser** before visual or DOM data can be processed or transmitted.

---

## Architecture Overview

Privamon operates entirely within Google Chrome (Manifest V3) using an air-gapped, browser-native processing pipeline:

1. **Chrome Extension (Manifest V3)**:
   - **DOM Extractor & Coordinate Mapper**: Extracts text, inputs, images, and maps viewport CSS coordinates to physical screenshot pixels (`privacy/coordinate-mapper.js`).
   - **Offscreen Processing Sandbox**: Performs canvas-based image extraction, Tesseract.js OCR, ONNX Runtime Web BlazeFace vision detection, client-side regex & checksum PII verification (Aadhaar Verhoeff, Luhn Credit Card), and solid opaque redaction (`#000000`).
   - **Interactive Results Viewer (`results.html`)**: Displays the sanitized screenshot, bounding box overlays with confidence scores, pipeline latency metrics, and sanitized DOM.

2. **Server-Side Reasoning Agent (`server_side_agent/`)**:
   - Optional server-side VLM reasoning service (Qwen3-VL / OpenRouter) that receives sanitized, redacted screen data and returns structured user automation actions safely.

---

## Prerequisites

Ensure you have the following installed on your system:

- **Node.js**: v18.0.0 or higher ([Download Node.js](https://nodejs.org/))
- **Google Chrome** (or Chromium-based browser: Brave, Edge)
- **Git** (optional, for cloning)

---

## Step-by-Step Installation Guide

### Step 1: Clone or Open the Repository

Open your terminal or PowerShell and navigate to the project directory:

```bash
cd "path/to/Privamon"
```

---

### Step 2: Install Dependencies

Install the extension dependencies. The post-install script will automatically copy vendor libraries (Tesseract.js and ONNX Runtime Web) into the `lib/` directory:

```bash
npm install
```

> **Note**: If you ever need to manually refresh or re-bundle the vendor libraries, run:
> ```bash
> npm run setup
> ```

---

### Step 3: Load the Extension into Google Chrome

1. Open **Google Chrome**.
2. Navigate to `chrome://extensions/` in the address bar.
3. In the top-right corner, toggle **Developer mode** to **ON**.
4. Click the **Load unpacked** button in the top-left corner.
5. Select the root folder of this project (`Privamon`).
6. The **Privamon — Privacy Browser Agent** card will appear in your extensions list.

---

## How to Use Privamon

1. **Open any webpage**: Browse to any page containing sensitive information (e.g. social media feeds, banking pages, emails, photo grids, or forms).
2. **Open the extension**: Click the Privamon icon in your Chrome extensions toolbar (pin it for convenience).
3. **Trigger Sanitization**: Click the **Sanitize Screen** button.
4. **Review Results**: A new tab (`results.html`) will automatically open displaying:
   - **Sanitized View**: Screenshot with sensitive text and faces painted over with solid black redaction boxes.
   - **Overlay Badges**: Color-coded detection boxes framing each detected entity (`PERSON`, `EMAIL`, `PHONE`, `face (100%)`, etc.).
   - **Sidebar Breakdown**: Summary counts for all detected categories, pipeline execution latency, and sanitized DOM structure.

---

## Updating the Extension After Code Changes

When modifying JavaScript or extension files:

1. Go to `chrome://extensions/`.
2. Find **Privamon — Privacy Browser Agent**.
3. Click the **Reload** (circular arrow 🔄) icon on the card.

---

## Running Automated Tests

Run the test suite:

```bash
npm test
```

---

## Troubleshooting

| Issue | Solution |
| :--- | :--- |
| **Missing vendor libraries (`tesseract.min.js` or `ort.min.js`)** | Run `npm run setup` in your terminal to re-copy all required vendor libraries into `lib/`. |
| **Extension needs reload** | Reload the extension in `chrome://extensions` by clicking the 🔄 button on the card. |

---

## License

MIT License. Designed for privacy-preserving browser automation and local AI security.
