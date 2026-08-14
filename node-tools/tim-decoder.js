'use strict';

// Decoder for PlayStation 1 TIM images.
//
// TIM is a raw VRAM-upload format, not a general-purpose image container: the
// header describes where the pixels were meant to land in the PSX framebuffer,
// and the "width" field is measured in 16-bit VRAM words rather than pixels.
// Nothing in sharp or ffmpeg understands it, so we decode to raw RGBA here and
// hand the buffer to sharp as a `raw` input.
//
// Layout:
//   u32 magic  - 0x10 followed by a version byte (0 in practice) + 2 reserved
//   u32 flags  - bits 0-2: pixel mode, bit 3: a CLUT block follows
//   [CLUT block]  (only when flags bit 3 is set)
//   [pixel block]
//
// Both blocks share the same shape: a u32 byte length that *includes* itself,
// u16 framebuffer x/y (irrelevant once the image leaves VRAM), u16 width, u16
// height, then the payload.

const HEADER_SIZE = 8;
const BLOCK_HEADER_SIZE = 12;
const TIM_MAGIC = 0x10;

const PMODE_4BPP = 0;
const PMODE_8BPP = 1;
const PMODE_16BPP = 2;
const PMODE_24BPP = 3;
const PMODE_MIXED = 4;

const PMODE_NAMES = {
  [PMODE_4BPP]: '4bpp',
  [PMODE_8BPP]: '8bpp',
  [PMODE_16BPP]: '16bpp',
  [PMODE_24BPP]: '24bpp',
  [PMODE_MIXED]: 'mixed'
};

/**
 * Expand a 5-bit channel to 8 bits, replicating the high bits into the low ones
 * so that 31 maps to 255 rather than 248.
 */
function expand5(value) {
  return (value << 3) | (value >> 2);
}

/**
 * Convert one PSX 16-bit texel (BGR555 + semi-transparency flag) to RGBA.
 *
 * The PSX treats a palette/texel value of 0x0000 as fully transparent; that is
 * the convention every TIM viewer follows, so we reproduce it. The top bit (STP)
 * only selects a blending mode at draw time and carries no meaning in a
 * standalone image, so an opaque black pixel (0x8000) stays opaque black.
 */
function bgr555ToRgba(value, out, offset) {
  if (value === 0) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 0;
    return;
  }
  out[offset] = expand5(value & 0x1f);
  out[offset + 1] = expand5((value >> 5) & 0x1f);
  out[offset + 2] = expand5((value >> 10) & 0x1f);
  out[offset + 3] = 255;
}

function readBlock(buffer, offset, label) {
  if (offset + BLOCK_HEADER_SIZE > buffer.length) {
    throw new Error(`TIM file is truncated: the ${label} block header is incomplete.`);
  }
  const byteLength = buffer.readUInt32LE(offset);
  if (byteLength < BLOCK_HEADER_SIZE) {
    throw new Error(`TIM file is malformed: the ${label} block declares an impossible size (${byteLength} bytes).`);
  }
  const width = buffer.readUInt16LE(offset + 8);
  const height = buffer.readUInt16LE(offset + 10);
  const dataStart = offset + BLOCK_HEADER_SIZE;
  // Trust whichever is smaller: some tools write a byteLength that runs past
  // the end of the file, and some pad the file beyond byteLength.
  const dataEnd = Math.min(offset + byteLength, buffer.length);
  if (dataEnd <= dataStart) {
    throw new Error(`TIM file is truncated: the ${label} block has no data.`);
  }
  return {
    width,
    height,
    data: buffer.subarray(dataStart, dataEnd),
    next: offset + byteLength
  };
}

/**
 * Read every CLUT in the palette block as RGBA quads.
 * Returns an array of Uint8Array palettes, one per CLUT.
 */
function readCluts(block, entriesPerClut) {
  const available = Math.floor(block.data.length / 2);
  const clutCount = Math.max(1, Math.floor(available / entriesPerClut));
  const cluts = [];
  for (let index = 0; index < clutCount; index += 1) {
    const palette = new Uint8Array(entriesPerClut * 4);
    for (let entry = 0; entry < entriesPerClut; entry += 1) {
      const wordIndex = index * entriesPerClut + entry;
      const value = wordIndex < available ? block.data.readUInt16LE(wordIndex * 2) : 0;
      bgr555ToRgba(value, palette, entry * 4);
    }
    cluts.push(palette);
  }
  return cluts;
}

/**
 * Build a grayscale ramp for CLUT-less paletted images. These are rare (the
 * game supplies a palette from elsewhere at runtime) but decoding to a visible
 * ramp beats refusing the file outright.
 */
function grayscaleRamp(entries) {
  const palette = new Uint8Array(entries * 4);
  const step = entries > 1 ? 255 / (entries - 1) : 0;
  for (let entry = 0; entry < entries; entry += 1) {
    const level = Math.round(entry * step);
    palette[entry * 4] = level;
    palette[entry * 4 + 1] = level;
    palette[entry * 4 + 2] = level;
    palette[entry * 4 + 3] = 255;
  }
  return palette;
}

/**
 * Number of image pixels represented by one 16-bit VRAM word.
 */
function pixelsPerWord(pmode) {
  switch (pmode) {
    case PMODE_4BPP: return 4;
    case PMODE_8BPP: return 2;
    case PMODE_16BPP: return 1;
    case PMODE_24BPP: return 2 / 3;
    default: return 1;
  }
}

function decodePaletted(block, width, height, palette, bitsPerPixel) {
  const out = new Uint8Array(width * height * 4);
  const entries = palette.length / 4;
  const pixelsPerByte = bitsPerPixel === 4 ? 2 : 1;
  // Rows are padded out to whole VRAM words, so step by the declared word width
  // rather than by the pixel width.
  const rowBytes = block.width * 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byteOffset = y * rowBytes + Math.floor(x / pixelsPerByte);
      let index = 0;
      if (byteOffset < block.data.length) {
        const byte = block.data[byteOffset];
        index = bitsPerPixel === 4
          ? (x % 2 === 0 ? byte & 0x0f : byte >> 4)
          : byte;
      }
      const source = (index < entries ? index : 0) * 4;
      const target = (y * width + x) * 4;
      out[target] = palette[source];
      out[target + 1] = palette[source + 1];
      out[target + 2] = palette[source + 2];
      out[target + 3] = palette[source + 3];
    }
  }
  return out;
}

function decode16bpp(block, width, height) {
  const out = new Uint8Array(width * height * 4);
  const rowBytes = block.width * 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byteOffset = y * rowBytes + x * 2;
      const value = byteOffset + 1 < block.data.length
        ? block.data.readUInt16LE(byteOffset)
        : 0;
      bgr555ToRgba(value, out, (y * width + x) * 4);
    }
  }
  return out;
}

function decode24bpp(block, width, height) {
  const out = new Uint8Array(width * height * 4);
  const rowBytes = block.width * 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byteOffset = y * rowBytes + x * 3;
      const target = (y * width + x) * 4;
      out[target] = byteOffset < block.data.length ? block.data[byteOffset] : 0;
      out[target + 1] = byteOffset + 1 < block.data.length ? block.data[byteOffset + 1] : 0;
      out[target + 2] = byteOffset + 2 < block.data.length ? block.data[byteOffset + 2] : 0;
      out[target + 3] = 255;
    }
  }
  return out;
}

/**
 * Cheap header sniff used by magic-byte validation. Does not decode pixels.
 */
function isTimBuffer(buffer) {
  if (!buffer || buffer.length < HEADER_SIZE) return false;
  if (buffer[0] !== TIM_MAGIC) return false;
  // Bytes 1-3 are a version byte plus reserved padding; every real-world TIM
  // leaves all three at zero.
  if (buffer[1] !== 0 || buffer[2] !== 0 || buffer[3] !== 0) return false;
  const pmode = buffer.readUInt32LE(4) & 0x07;
  return pmode <= PMODE_MIXED;
}

/**
 * Decode a TIM buffer to raw RGBA.
 *
 * @param {Buffer} buffer Full file contents.
 * @param {object} [options]
 * @param {number} [options.clutIndex=0] Which palette to apply when the file
 *   carries several alternates. Out-of-range values fall back to 0.
 * @returns {{width:number,height:number,channels:number,data:Buffer,mode:string,clutCount:number}}
 */
function decodeTim(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('decodeTim expects a Buffer.');
  }
  if (!isTimBuffer(buffer)) {
    throw new Error('This is not a valid TIM file: the 0x10 header tag is missing.');
  }

  const flags = buffer.readUInt32LE(4);
  const pmode = flags & 0x07;
  const hasClut = (flags & 0x08) !== 0;

  if (pmode === PMODE_MIXED) {
    throw new Error('This TIM uses mixed-mode pixels, which have no single image representation.');
  }
  if (pmode > PMODE_MIXED) {
    throw new Error(`Unsupported TIM pixel mode ${pmode}.`);
  }

  let offset = HEADER_SIZE;
  let cluts = null;
  if (hasClut) {
    const clutBlock = readBlock(buffer, offset, 'palette');
    const entriesPerClut = pmode === PMODE_4BPP ? 16 : 256;
    cluts = readCluts(clutBlock, entriesPerClut);
    offset = clutBlock.next;
  }

  const pixelBlock = readBlock(buffer, offset, 'pixel');
  const width = Math.floor(pixelBlock.width * pixelsPerWord(pmode));
  const height = pixelBlock.height;
  if (width <= 0 || height <= 0) {
    throw new Error(`TIM file declares empty dimensions (${width}x${height}).`);
  }
  // Guard against a corrupt header asking for a multi-gigabyte allocation.
  if (width > 8192 || height > 8192) {
    throw new Error(`TIM file declares implausible dimensions (${width}x${height}).`);
  }

  let data;
  let clutCount = cluts ? cluts.length : 0;
  if (pmode === PMODE_4BPP || pmode === PMODE_8BPP) {
    const entries = pmode === PMODE_4BPP ? 16 : 256;
    const requested = Number.isInteger(options.clutIndex) ? options.clutIndex : 0;
    const palette = cluts
      ? cluts[requested >= 0 && requested < cluts.length ? requested : 0]
      : grayscaleRamp(entries);
    data = decodePaletted(pixelBlock, width, height, palette, pmode === PMODE_4BPP ? 4 : 8);
  } else if (pmode === PMODE_16BPP) {
    data = decode16bpp(pixelBlock, width, height);
  } else {
    data = decode24bpp(pixelBlock, width, height);
  }

  return {
    width,
    height,
    channels: 4,
    data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    mode: PMODE_NAMES[pmode],
    hasClut,
    clutCount
  };
}

module.exports = { decodeTim, isTimBuffer };
