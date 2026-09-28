const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// High-fidelity vector math & supersampling PNG rasterizer
function createSolarIconPng(targetSize) {
  // Use 4x supersampling for ultra-crisp antialiasing
  const SS = 4;
  const W = targetSize * SS;
  const H = targetSize * SS;
  const S = W / 128; // scale factor from 128 base grid

  // Target RGBA buffer for full resolution (targetSize)
  const targetBuffer = Buffer.alloc(targetSize * targetSize * 4);

  // Background navy: [12, 47, 84] -> #0c2f54
  const bgNavy = [12, 47, 84, 255];
  // Sun gold: [251, 168, 27] -> #fba81b
  const sunGold = [251, 168, 27, 255];
  // Sun gold highlight: [255, 192, 46]
  const sunGoldLight = [255, 195, 50, 255];
  // Panel white: [248, 250, 252] -> #f8fafc
  const panelWhite = [248, 250, 252, 255];
  // Panel subtle shadow: [226, 232, 240]
  const panelShadow = [226, 232, 240, 255];
  // Accent line
  const accentNavy = [12, 47, 84, 255];

  // Helper: point in convex polygon (cross-product method)
  function pointInPoly(px, py, poly) {
    let inside = true;
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const cross = (p2[0] - p1[0]) * (py - p1[1]) - (p2[1] - p1[1]) * (px - p1[0]);
      if (cross < 0) {
        inside = false;
        break;
      }
    }
    return inside;
  }

  // Rounded rectangle test (Squircle)
  const cornerRadius = 26 * S;
  function inSquircle(px, py) {
    if (px < 0 || px >= W || py < 0 || py >= H) return false;
    // check 4 corners
    if (px < cornerRadius && py < cornerRadius) {
      const dx = px - cornerRadius;
      const dy = py - cornerRadius;
      return dx * dx + dy * dy <= cornerRadius * cornerRadius;
    }
    if (px > W - cornerRadius && py < cornerRadius) {
      const dx = px - (W - cornerRadius);
      const dy = py - cornerRadius;
      return dx * dx + dy * dy <= cornerRadius * cornerRadius;
    }
    if (px < cornerRadius && py > H - cornerRadius) {
      const dx = px - cornerRadius;
      const dy = py - (H - cornerRadius);
      return dx * dx + dy * dy <= cornerRadius * cornerRadius;
    }
    if (px > W - cornerRadius && py > H - cornerRadius) {
      const dx = px - (W - cornerRadius);
      const dy = py - (H - cornerRadius);
      return dx * dx + dy * dy <= cornerRadius * cornerRadius;
    }
    return true;
  }

  // Sun definition
  const sunCenter = [62 * S, 44 * S];
  const sunRadius = 21 * S;

  // Sun rays (7 rays fanning from -155 deg to -25 deg)
  const rayAngles = [-155, -133, -111, -89, -67, -45, -23].map(a => (a * Math.PI) / 180);
  const rayPolys = rayAngles.map(angle => {
    const r1 = 26 * S;
    const r2 = 35 * S;
    const w1 = 2.4 * S;
    const w2 = 2.9 * S;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const normX = -sin;
    const normY = cos;

    return [
      [sunCenter[0] + r1 * cos - normX * w1, sunCenter[1] + r1 * sin - normY * w1],
      [sunCenter[0] + r2 * cos - normX * w2, sunCenter[1] + r2 * sin - normY * w2],
      [sunCenter[0] + r2 * cos + normX * w2, sunCenter[1] + r2 * sin + normY * w2],
      [sunCenter[0] + r1 * cos + normX * w1, sunCenter[1] + r1 * sin + normY * w1],
    ];
  });

  // Solar Panels Definition (3 columns x 2 rows = 6 modules)
  // Scaled coordinates from base 128
  const panels = [
    // Column 1 - Top
    [[33, 62], [57, 59], [57, 78], [33, 81]].map(p => [p[0] * S, p[1] * S]),
    // Column 1 - Bottom
    [[30, 84], [55, 81], [55, 101], [30, 103]].map(p => [p[0] * S, p[1] * S]),

    // Column 2 - Top
    [[60, 58], [84, 55], [84, 75], [60, 78]].map(p => [p[0] * S, p[1] * S]),
    // Column 2 - Bottom
    [[58, 80], [82, 77], [82, 98], [58, 100]].map(p => [p[0] * S, p[1] * S]),

    // Column 3 - Top
    [[87, 55], [111, 52], [111, 72], [87, 75]].map(p => [p[0] * S, p[1] * S]),
    // Column 3 - Bottom
    [[85, 77], [108, 73], [108, 94], [85, 96]].map(p => [p[0] * S, p[1] * S]),
  ];

  // Busbar / reflection stroke line across bottom panels
  const accentLinePoly = [
    [58 * S, 93 * S],
    [93 * S, 87 * S],
    [93 * S, 90 * S],
    [58 * S, 96 * S]
  ];

  // Sample function at supersampled pixel (x, y)
  function getSampleColor(px, py) {
    if (!inSquircle(px, py)) {
      return [0, 0, 0, 0]; // Transparent
    }

    // Check panels first (front-most layer)
    for (let i = 0; i < panels.length; i++) {
      if (pointInPoly(px, py, panels[i])) {
        // Check if on accent bar line
        if (pointInPoly(px, py, accentLinePoly)) {
          return accentNavy;
        }
        // Subtle vertical gradient on panels for realism
        const isBottom = i % 2 === 1;
        return isBottom ? panelShadow : panelWhite;
      }
    }

    // Check sun disc
    const dx = px - sunCenter[0];
    const dy = py - sunCenter[1];
    const distSq = dx * dx + dy * dy;
    if (distSq <= sunRadius * sunRadius) {
      // Sun gradient: lighter near top left
      const grad = Math.max(0, Math.min(1, (px - (sunCenter[0] - sunRadius)) / (sunRadius * 2)));
      return [
        Math.round(sunGoldLight[0] * (1 - grad * 0.2) + sunGold[0] * (grad * 0.2)),
        Math.round(sunGoldLight[1] * (1 - grad * 0.2) + sunGold[1] * (grad * 0.2)),
        Math.round(sunGoldLight[2] * (1 - grad * 0.2) + sunGold[2] * (grad * 0.2)),
        255
      ];
    }

    // Check sun rays
    for (const ray of rayPolys) {
      if (pointInPoly(px, py, ray)) {
        return sunGold;
      }
    }

    // Background navy
    return bgNavy;
  }

  // Downsample to targetSize by averaging SS x SS samples
  const totalSamples = SS * SS;
  for (let ty = 0; ty < targetSize; ty++) {
    for (let tx = 0; tx < targetSize; tx++) {
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = tx * SS + sx + 0.5;
          const py = ty * SS + sy + 0.5;
          const [r, g, b, a] = getSampleColor(px, py);

          // Premultiplied alpha accumulation
          rSum += (r * a) / 255;
          gSum += (g * a) / 255;
          bSum += (b * a) / 255;
          aSum += a;
        }
      }

      const outIndex = (ty * targetSize + tx) * 4;
      const finalAlpha = Math.round(aSum / totalSamples);
      if (finalAlpha > 0) {
        targetBuffer[outIndex] = Math.min(255, Math.round((rSum / totalSamples) * (255 / (finalAlpha || 1))));
        targetBuffer[outIndex + 1] = Math.min(255, Math.round((gSum / totalSamples) * (255 / (finalAlpha || 1))));
        targetBuffer[outIndex + 2] = Math.min(255, Math.round((bSum / totalSamples) * (255 / (finalAlpha || 1))));
        targetBuffer[outIndex + 3] = finalAlpha;
      } else {
        targetBuffer[outIndex] = 0;
        targetBuffer[outIndex + 1] = 0;
        targetBuffer[outIndex + 2] = 0;
        targetBuffer[outIndex + 3] = 0;
      }
    }
  }

  return encodePngBuffer(targetSize, targetSize, targetBuffer);
}

// PNG Encoder (RFC 2083)
function encodePngBuffer(width, height, rgbaBuffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // 8-bit
  ihdrData[9] = 6;  // RGBA
  ihdrData[10] = 0; // Deflate
  ihdrData[11] = 0; // Filter
  ihdrData[12] = 0; // Interlace

  function crc32(buf) {
    let c;
    const table = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        if (c & 1) c = 0xedb88320 ^ (c >>> 1);
        else c = c >>> 1;
      }
      table[n] = c;
    }
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ (-1)) >>> 0;
  }

  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = data.length;
    const buf = Buffer.alloc(8 + len + 4);
    buf.writeUInt32BE(len, 0);
    typeBuf.copy(buf, 4);
    data.copy(buf, 8);
    const crcVal = crc32(Buffer.concat([typeBuf, data]));
    buf.writeUInt32BE(crcVal, 8 + len);
    return buf;
  }

  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // Scanline data with 0 (None) filter byte
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0;
    rgbaBuffer.copy(rawData, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressedData = zlib.deflateSync(rawData, { level: 9 });
  const idatChunk = makeChunk('IDAT', compressedData);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Generate SVG representation
function generateSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="sunGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffc332" />
      <stop offset="100%" stop-color="#fba81b" />
    </linearGradient>
    <linearGradient id="panelGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="100%" stop-color="#edf2f7" />
    </linearGradient>
  </defs>

  <!-- Navy Squircle Background -->
  <rect x="0" y="0" width="128" height="128" rx="26" ry="26" fill="#0c2f54" />

  <!-- Sun Rays -->
  <g fill="#fba81b">
    <polygon points="38.4,32.8 30.2,29.1 32.7,24.4 40.8,28.2" />
    <polygon points="44.2,21.8 38.0,14.6 42.6,11.2 48.4,18.5" />
    <polygon points="53.8,14.6 50.8,6.0 56.4,4.2 59.2,12.8" />
    <polygon points="65.3,12.3 66.2,3.3 72.0,3.6 70.8,12.6" />
    <polygon points="76.5,15.1 81.3,7.2 86.4,10.0 81.4,17.9" />
    <polygon points="85.4,22.8 93.3,18.1 96.6,22.9 88.5,27.5" />
    <polygon points="90.5,34.0 99.4,33.1 100.2,38.8 91.1,39.6" />
  </g>

  <!-- Sun Disc -->
  <circle cx="62" cy="44" r="21" fill="url(#sunGrad)" />

  <!-- Solar Panels Array (Perspective Grid) -->
  <g fill="url(#panelGrad)">
    <!-- Column 1 -->
    <polygon points="33,62 57,59 57,78 33,81" />
    <polygon points="30,84 55,81 55,101 30,103" />

    <!-- Column 2 -->
    <polygon points="60,58 84,55 84,75 60,78" />
    <polygon points="58,80 82,77 82,98 58,100" />

    <!-- Column 3 -->
    <polygon points="87,55 111,52 111,72 87,75" />
    <polygon points="85,77 108,73 108,94 85,96" />
  </g>

  <!-- Accent Divider Line -->
  <polygon points="58,93 93,87 93,90 58,96" fill="#0c2f54" />
</svg>`;
}

// Main execution
const extensionIconsDir = path.join(__dirname, '..', 'public', 'tars-extension', 'icons');
const publicDir = path.join(__dirname, '..', 'public');

if (!fs.existsSync(extensionIconsDir)) {
  fs.mkdirSync(extensionIconsDir, { recursive: true });
}

// Generate all standard sizes
const sizes = [16, 32, 48, 128, 256, 512];
sizes.forEach(size => {
  const png = createSolarIconPng(size);
  fs.writeFileSync(path.join(extensionIconsDir, `icon-${size}.png`), png);
  console.log(`✓ Generated extension icon-${size}.png (${png.length} bytes)`);

  if (size === 128 || size === 512 || size === 32) {
    fs.writeFileSync(path.join(publicDir, `solar-icon-${size}.png`), png);
  }
});

// Copy 128px as default public favicon and app icon
const icon128 = createSolarIconPng(128);
fs.writeFileSync(path.join(publicDir, 'solar-icon.png'), icon128);
fs.writeFileSync(path.join(publicDir, 'favicon.png'), createSolarIconPng(32));

// Save SVG
const svg = generateSvg();
fs.writeFileSync(path.join(extensionIconsDir, 'icon.svg'), svg);
fs.writeFileSync(path.join(publicDir, 'solar-icon.svg'), svg);
console.log('✓ Generated SVG icons');
