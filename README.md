# Privamon 🛡️

Privamon is a privacy-first Chrome extension built for **Smart India Hackathon 2026** (Problem Statement 26171). 

It automatically detects and blocks out sensitive personal data—like human faces, names, phone numbers, credit cards, and IDs (Aadhaar/PAN)—locally inside your browser before a screen capture is handed over to an AI vision agent. Nothing raw ever leaves your device.

---

## How to Run Locally

### 1. Running the Chrome Extension

You don't need any complex build step to test the extension.

1. **Clone the repo and install dependencies:**
   ```bash
   git clone https://github.com/shreyash718/Privamon.git
   cd Privamon
   npm install
   ```
   *(This copies the local OCR and ONNX model runtime files into `lib/`.)*

2. **Load into Chrome (or Brave / Edge):**
   - Open your browser and go to `chrome://extensions/`
   - Turn on **Developer mode** (toggle in the top-right corner)
   - Click **Load unpacked** (top-left)
   - Select the `Privamon` project folder

3. **Try it out:**
   - Go to any webpage with sensitive info (like WhatsApp Web, Gmail, Amazon, or a form).
   - Click the Privamon extension icon in your browser toolbar and click **Sanitize Screen**.
   - A results tab will open showing the sanitized screenshot with solid black redaction boxes and detection labels.

> **Tip:** If you make changes to extension files, just click the reload (🔄) icon on the Privamon card in `chrome://extensions/`.

---

### 2. Running the Landing Page

If you want to view or work on the project website locally:

```bash
npm start
```
Then open [http://localhost:3000](http://localhost:3000) in your browser.

---

## How It Works

Everything runs 100% on your machine:
- **Chrome Offscreen API (Manifest V3)**: Handles canvas operations and background model runs without freezing the active tab.
- **UltraFace ONNX (via ONNX Runtime Web)**: Detects human faces with WebGPU / WASM acceleration.
- **Tesseract.js**: Client-side OCR for reading on-screen text.
- **PII Detectors & Checksums**: Verifies sensitive numbers like Aadhaar (Verhoeff algorithm), Credit Cards (Luhn algorithm), PAN, emails, and phone numbers.
- **Opaque Redaction**: Paints solid `#000000` black boxes over sensitive pixels before anything gets passed to vision models.

---

## Tech Stack

- JavaScript (Vanilla, ES6 Modules)
- Chrome Extensions Manifest V3
- WebGPU / WebAssembly (WASM SIMD)
- ONNX Runtime Web & Tesseract.js
- HTML5 / CSS3 for the showcase site

---

## License

Apache 2.0 License.
