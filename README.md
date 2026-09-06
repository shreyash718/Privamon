# Privamon — Privacy-Preserving Browser Agent

Privamon is a privacy-first browser agent that intercepts and sanitizes sensitive screen content (Personally Identifiable Information, credentials, sensitive documents, and human faces) **locally** on your machine before visual or DOM data can be processed or transmitted.

---

## Architecture Overview

Privamon operates through a hybrid pipeline combining client-side browser orchestration with a high-speed local inference engine:

1. **Chrome Extension (Manifest V3)**:
   - **DOM Extractor & Coordinate Mapper**: Extracts text, inputs, images, and maps viewport CSS coordinates to physical screenshot pixels.
   - **Offscreen Processing Sandbox**: Performs canvas-based image extraction, Tesseract.js OCR, and solid opaque redaction (`#000000`).
   - **Interactive Results Viewer (`results.html`)**: Displays the sanitized screenshot, bounding box overlays with confidence scores, pipeline latency metrics, and sanitized DOM.

2. **Local PII & Vision Engine (`127.0.0.1:8765`)**:
   - **Text PII Engine**: Microsoft Presidio Analyzer + SpaCy + GLiNER for hybrid regex and transformer-based Named Entity Recognition (Names, Locations, Organizations, Phone Numbers, Aadhaar, PAN, etc.).
   - **Vision Face Engine**: UltraFace / BlazeFace running via native C++ ONNX Runtime for ultra-low latency (~15ms) face detection across DOM images, non-DOM elements, profile photos, and full screenshots.

---

## Prerequisites

Ensure you have the following installed on your system:

- **Node.js**: v18.0.0 or higher ([Download Node.js](https://nodejs.org/))
- **Python**: v3.10, 3.11, 3.12, or 3.13 ([Download Python](https://www.python.org/))
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

### Step 2: Install Node.js Dependencies

Install the extension dependencies. The post-install script will automatically copy vendor libraries (Tesseract.js and ONNX Runtime Web) into the `lib/` directory:

```bash
npm install
```

> **Note**: If you ever need to manually refresh or re-bundle the vendor libraries, run:
> ```bash
> npm run setup
> ```

---

### Step 3: Set Up Python Environment & Dependencies

1. *(Recommended)* Create and activate a Python virtual environment:

   **Windows (PowerShell):**
   ```powershell
   python -m venv venv
   .\venv\Scripts\Activate.ps1
   ```

   **macOS / Linux:**
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   ```

2. Install Python dependencies:
   ```bash
   pip install -r engine/requirements.txt
   ```

3. Download the SpaCy English language model:
   ```bash
   python -m spacy download en_core_web_sm
   ```

---

### Step 4: Verify the Face Detection Model

Ensure the ONNX model file exists in `lib/onnx/`:
- `lib/onnx/blazeface.onnx` (or `version-RFB-320-clean.onnx`)

*(This file is bundled within the repository. The engine will automatically detect and load it on startup.)*

---

### Step 5: Start the Local PII & Vision Engine

Launch the local FastAPI server:

```bash
npm run engine:start
```

Alternatively, you can run directly with Python:
```bash
python -m engine.server
```

You should see output similar to:
```
INFO:     Started server process [...]
INFO:     Waiting for application startup.
INFO:     privamon.server: Initializing Privamon PII Engine...
INFO:     privamon.server: Engine initialized successfully in ...s
INFO:     Uvicorn running on http://127.0.0.1:8765 (Press CTRL+C to quit)
```

> **Health Check**: Open [http://127.0.0.1:8765/docs](http://127.0.0.1:8765/docs) in your browser to verify the Swagger UI and available endpoints (`/detect`, `/detect/batch`, `/detect/face`).

---

### Step 6: Load the Extension into Google Chrome

1. Open **Google Chrome**.
2. Navigate to `chrome://extensions/` in the address bar.
3. In the top-right corner, toggle **Developer mode** to **ON**.
4. Click the **Load unpacked** button in the top-left corner.
5. Select the root folder of this project (`Privamon`).
6. The **Privamon — Privacy Browser Agent** card will appear in your extensions list.

---

## How to Use Privamon

1. **Keep the engine running**: Ensure `npm run engine:start` is running in your terminal.
2. **Open any webpage**: Browse to any page containing sensitive information (e.g. social media feeds, banking pages, emails, photo grids, or forms).
3. **Open the extension**: Click the Privamon icon in your Chrome extensions toolbar (pin it for convenience).
4. **Trigger Sanitization**: Click the **Sanitize Screen** button.
5. **Review Results**: A new tab (`results.html`) will automatically open displaying:
   - **Sanitized View**: Screenshot with sensitive text and faces painted over with solid black redaction boxes.
   - **Overlay Badges**: Color-coded detection boxes framing each detected entity (`PERSON`, `EMAIL`, `PHONE`, `face (100%)`, etc.).
   - **Sidebar Breakdown**: Summary counts for all detected categories, pipeline execution latency, and sanitized DOM structure.

---

## Updating the Extension After Code Changes

When modifying JavaScript or extension files:

1. Go to `chrome://extensions/`.
2. Find **Privamon — Privacy Browser Agent**.
3. Click the **Reload** (circular arrow 🔄) icon on the card.
4. If you modified Python backend code in `engine/server.py`, press `Ctrl + C` in the terminal and rerun `npm run engine:start`.

---

## Running Automated Tests

Run the full automated test suite to verify PII detection, OCR coordinate fusion, and face redaction:

```bash
npm run engine:test
```

Or directly via pytest:
```bash
pytest tests/ -v
```

---

## Troubleshooting

| Issue | Solution |
| :--- | :--- |
| **Port 8765 already in use (`WinError 10048`)** | An older instance of the server is still running. In PowerShell, find the PID with `netstat -ano \| findstr :8765` and terminate it with `taskkill /PID <PID> /F`, then re-run `npm run engine:start`. |
| **"Python engine offline/unreachable"** | Verify that `npm run engine:start` is running and accessible at [http://127.0.0.1:8765/docs](http://127.0.0.1:8765/docs). |
| **Faces not detected or 0 detections** | 1. Ensure `npm run engine:start` is active.<br>2. Reload the extension in `chrome://extensions` by clicking the 🔄 button.<br>3. Check the terminal output for `[VisionEngine] Successfully detected X face(s)`. |
| **Missing vendor libraries (`tesseract.min.js` or `ort.min.js`)** | Run `npm run setup` in your terminal to re-copy all required vendor libraries into `lib/`. |

---

## License

MIT License. Designed for privacy-preserving browser automation and local AI security.
