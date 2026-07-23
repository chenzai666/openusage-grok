/**
 * Generate tray PNG: black square + white percentage digits.
 * Uses pure PNG encoding without native deps (uncompressed IHDR/IDAT/IEND).
 */
const zlib = require("zlib");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 3x5 digit glyphs for 0-9 and optional "100" */
const GLYPHS = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "%": ["101", "001", "010", "100", "101"],
};

function createPercentPng(percent, { size = 32, showPercentSign = false } = {}) {
  let n = Number(percent);
  if (!Number.isFinite(n)) n = 0;
  n = Math.max(0, Math.min(100, Math.round(n)));
  const text = showPercentSign ? String(n) + "%" : String(n);

  const scale = n >= 100 ? 2 : n >= 10 ? 3 : 4;
  const glyphW = 3;
  const glyphH = 5;
  const gap = 1;
  const chars = text.split("");
  const totalW = chars.length * glyphW + (chars.length - 1) * gap;
  const totalH = glyphH;

  const img = Buffer.alloc(size * size * 4);
  // dark background
  for (let i = 0; i < size * size; i++) {
    img[i * 4] = 18;
    img[i * 4 + 1] = 18;
    img[i * 4 + 2] = 18;
    img[i * 4 + 3] = 255;
  }

  const drawW = totalW * scale;
  const drawH = totalH * scale;
  const ox = Math.floor((size - drawW) / 2);
  const oy = Math.floor((size - drawH) / 2);

  let cx = 0;
  for (const ch of chars) {
    const g = GLYPHS[ch] || GLYPHS["0"];
    for (let y = 0; y < glyphH; y++) {
      for (let x = 0; x < glyphW; x++) {
        if (g[y][x] !== "1") continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = ox + (cx + x) * scale + sx;
            const py = oy + y * scale + sy;
            if (px < 0 || py < 0 || px >= size || py >= size) continue;
            const idx = (py * size + px) * 4;
            img[idx] = 255;
            img[idx + 1] = 255;
            img[idx + 2] = 255;
            img[idx + 3] = 255;
          }
        }
      }
    }
    cx += glyphW + gap;
  }

  // Build PNG
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    img.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const compressed = zlib.deflateSync(raw);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createTrayNativeImage(nativeImage, percent, opts) {
  const png = createPercentPng(percent, opts);
  return nativeImage.createFromBuffer(png);
}

module.exports = { createPercentPng, createTrayNativeImage };
