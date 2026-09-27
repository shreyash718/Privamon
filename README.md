# Privamon 🛡️

> Built for **Smart India Hackathon 2026** (Problem Statement 26171: *On-device Visual Perception for Light-weight Browser Agents*).

Privamon is a privacy shield for your browser. It automatically blacks out your faces, credit cards, Aadhaar/PAN cards, and phone numbers locally on your machine before an AI agent gets to peek at your screen. Nothing sensitive ever leaves your device.

---

## 🏃 For Normal Humans (The "Just Make It Work" Guide)

Don't want to touch a terminal or look at code? Good news: **it's 100% plug and play.** No Node.js, no command line, no developer headache.

### Step 1: Grab the Extension
- 🌐 **Showcase Website:** [privamon.vercel.app](https://privamon.vercel.app)
- Or simply click the green **Code &rarr; Download ZIP** button at the top of this GitHub page and extract the folder on your computer.

### Step 2: Plug It Into Your Browser
1. Open Google Chrome (or Brave / Edge).
2. Type `chrome://extensions` in your address bar and press Enter.
3. Turn **ON** the **Developer mode** toggle in the top-right corner (don't worry, you don't actually have to develop anything).
4. Click **Load unpacked** (top-left) and select the unzipped `Privamon` folder.

### Step 3: Play!
1. Head over to WhatsApp Web, Gmail, Amazon, or any site with personal data.
2. Click the Privamon extension icon in your extensions toolbar (pin it so it's easy to find).
3. Hit **Sanitize Screen**.
4. A tab pops up showing your screenshot with solid black redaction boxes over all sensitive info. 

That's it. You're fully protected.

---

## 💻 For Developers (The "Let Me See The Code" Guide)

Welcome under the hood. No bloated bundlers or webpack labyrinths here—just clean, modern JavaScript built on Chrome Manifest V3.

### Quick Start

Fun fact: **You don't even need `npm install` to run the extension.** All runtime ML libraries and model files are already pre-bundled inside [`lib/`](lib/).

```bash
# Clone the repository
git clone https://github.com/shreyash718/Privamon.git
cd Privamon
```

Then load the folder directly into `chrome://extensions/` using **Load unpacked**.

> **Dev Pro-Tip:** Edited a file in `background.js` or `popup.js`? Just click the circular reload arrow (🔄) on the Privamon card in `chrome://extensions/`.

### When DO You Need `npm install`?

Only if you are running backend tooling or the local showcase:
- **`npm start`**: Spins up the local documentation/showcase site at `http://localhost:3000`.
- **`npm test`**: Runs the automated test suite.
- **Server-side Reasoning Agent (`server_side_agent/`)**: If you're testing the optional WebSocket VLM bridge.
- **Report API (`api/report.js`)**: If you're running the serverless email handler locally.

```bash
npm install
npm start
```

### Architecture at a Glance

Everything runs strictly inside the user's browser:
- **Chrome Offscreen Sandbox (Manifest V3)**: Offloads Canvas 2D scanning and ML inference so the active tab stays smooth at 60 FPS.
- **UltraFace ONNX (via ONNX Runtime Web)**: Detects human faces with WebGPU hardware acceleration (falls back to WASM SIMD).
- **Tesseract.js**: In-browser OCR for extracting text from screenshots and rendered images.
- **Rule & Checksum Engines**: Mathematical verification for Aadhaar (Verhoeff), Credit Cards (Luhn), PAN, and regex heuristics for credentials.
- **Opaque Pixel Redaction**: Renders solid `#000000` rectangles over detected bounding boxes. No reversible CSS blurs or translucent masks.

### Tech Stack
- Vanilla ES6+ JavaScript
- Chrome Extensions MV3 (Service Workers + Offscreen Documents)
- WebGPU & WebAssembly (WASM SIMD)
- ONNX Runtime Web & Tesseract.js
- HTML5 / CSS3 for the showcase site

---

## License

Apache 2.0 License.
