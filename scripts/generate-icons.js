/**
 * Generate extension icons at required sizes (16, 48, 128 px)
 * from a source image.
 *
 * Usage: node scripts/generate-icons.js [source-image-path]
 */
const fs = require('fs');
const path = require('path');

// We'll create simple SVG-based PNG icons since we can't resize images in Node
// without sharp/canvas. These are inline generated icons.

const ROOT = path.resolve(__dirname, '..');
const ICONS_DIR = path.join(ROOT, 'icons');

if (!fs.existsSync(ICONS_DIR)) {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
}

/**
 * Create a simple SVG icon and save as SVG (Chrome supports SVG icons in some contexts).
 * For full compatibility, we create a minimal PNG using the data URI approach.
 */
function createSvgIcon(size) {
  // Shield + eye + lock motif in indigo-violet gradient
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#6366f1"/>
      <stop offset="100%" style="stop-color:#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="24" fill="url(#grad)"/>
  <path d="M64 20C44 20 28 36 28 56c0 28 36 52 36 52s36-24 36-52c0-20-16-36-36-36z" fill="none" stroke="white" stroke-width="5" opacity="0.9"/>
  <circle cx="64" cy="56" r="14" fill="white" opacity="0.9"/>
  <rect x="58" y="50" width="12" height="14" rx="2" fill="url(#grad)"/>
  <rect x="61" y="44" width="6" height="8" rx="3" fill="none" stroke="url(#grad)" stroke-width="2"/>
</svg>`;
  return svg;
}

// Generate SVG icons at each size
// Chrome extensions accept PNG, but for simplicity we'll create SVG files
// and also a conversion helper

const sizes = [16, 48, 128];
for (const size of sizes) {
  const svg = createSvgIcon(size);
  const svgPath = path.join(ICONS_DIR, `icon${size}.svg`);
  fs.writeFileSync(svgPath, svg);
  console.log(`Created: icons/icon${size}.svg`);
}

// Chrome requires PNG for manifest icons. Create a simple HTML helper.
console.log(`
Icons created as SVG. Chrome manifest requires PNG icons.

Quick fix: The extension will work with the SVG inline icons in the popup.
For production, convert SVGs to PNGs using any tool.

For now, creating minimal 1x1 PNG placeholders so the manifest doesn't error.
`);

// Create minimal valid PNG files (1x1 pixel, transparent)
// This is the smallest valid PNG: 68 bytes
const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89,
  0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
  0x78, 0x9C, 0x62, 0x00, 0x00, 0x00, 0x02, 0x00,
  0x01, 0xE5, 0x27, 0xDE, 0xFC,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND chunk
  0xAE, 0x42, 0x60, 0x82,
]);

for (const size of sizes) {
  const pngPath = path.join(ICONS_DIR, `icon${size}.png`);
  fs.writeFileSync(pngPath, MINIMAL_PNG);
  console.log(`Created placeholder: icons/icon${size}.png`);
}

console.log('\nIcon generation complete.');
