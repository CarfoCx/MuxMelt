'use strict';

// Unit tests for the PlayStation TIM decoder.
//
// TIM buffers are synthesized here rather than committed as fixtures: the format
// is compact enough to write by hand, and building each variant in the test
// documents the layout far better than an opaque binary blob would.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { decodeTim, isTimBuffer } = require('../node-tools/tim-decoder');
const { validateMagicBytes, IMAGE_EXTS } = require('../node-tools/path-utils');
const { IMAGE_EXTS: CONVERTER_IMAGE_EXTS } = (() => {
  // format-converter.js requires sharp and registers IPC, so read its source
  // instead of loading it. This keeps the test dependency-free.
  const source = fs.readFileSync(path.join(__dirname, '..', 'node-tools', 'format-converter.js'), 'utf8');
  const match = source.match(/const IMAGE_EXTS = new Set\(\[([^\]]*)\]\)/);
  const exts = match ? match[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1)) : [];
  return { IMAGE_EXTS: new Set(exts) };
})();

const failures = [];
let assertions = 0;

function check(condition, message) {
  assertions += 1;
  if (!condition) failures.push(message);
}

function checkThrows(fn, pattern, message) {
  assertions += 1;
  try {
    fn();
    failures.push(`${message} (expected a throw, got none)`);
  } catch (err) {
    if (pattern && !pattern.test(err.message)) {
      failures.push(`${message} (message was: ${err.message})`);
    }
  }
}

// ---- TIM builders ----

/** Pack a BGR555 texel. Channels are 0-31. */
function bgr555(r, g, b) {
  return (b << 10) | (g << 5) | r;
}

const TRANSPARENT = 0;
const RED = bgr555(31, 0, 0);
const GREEN = bgr555(0, 31, 0);
const BLUE = bgr555(0, 0, 31);

function block(width, height, payload) {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(12 + payload.length, 0);
  header.writeUInt16LE(0, 4); // framebuffer x
  header.writeUInt16LE(0, 6); // framebuffer y
  header.writeUInt16LE(width, 8);
  header.writeUInt16LE(height, 10);
  return Buffer.concat([header, payload]);
}

function clutBlock(cluts) {
  const entries = cluts[0].length;
  const payload = Buffer.alloc(cluts.length * entries * 2);
  cluts.forEach((clut, clutIndex) => {
    clut.forEach((color, entry) => {
      payload.writeUInt16LE(color, (clutIndex * entries + entry) * 2);
    });
  });
  return block(entries, cluts.length, payload);
}

function timHeader(pmode, hasClut) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x10, 0);
  header.writeUInt32LE(pmode | (hasClut ? 0x08 : 0), 4);
  return header;
}

/** Build a 4bpp TIM. `indices` is a height-length array of width-length rows. */
function build4bpp(indices, cluts) {
  const width = indices[0].length;
  const words = Math.ceil(width / 4);
  const rowBytes = words * 2;
  const payload = Buffer.alloc(rowBytes * indices.length);
  indices.forEach((row, y) => {
    row.forEach((index, x) => {
      const offset = y * rowBytes + (x >> 1);
      payload[offset] |= x % 2 === 0 ? (index & 0x0f) : ((index & 0x0f) << 4);
    });
  });
  return Buffer.concat([timHeader(0, true), clutBlock(cluts), block(words, indices.length, payload)]);
}

function build8bpp(indices, cluts) {
  const width = indices[0].length;
  const words = Math.ceil(width / 2);
  const rowBytes = words * 2;
  const payload = Buffer.alloc(rowBytes * indices.length);
  indices.forEach((row, y) => {
    row.forEach((index, x) => { payload[y * rowBytes + x] = index; });
  });
  return Buffer.concat([timHeader(1, true), clutBlock(cluts), block(words, indices.length, payload)]);
}

function build16bpp(rows) {
  const width = rows[0].length;
  const payload = Buffer.alloc(width * 2 * rows.length);
  rows.forEach((row, y) => {
    row.forEach((color, x) => { payload.writeUInt16LE(color, (y * width + x) * 2); });
  });
  return Buffer.concat([timHeader(2, false), block(width, rows.length, payload)]);
}

function build24bpp(rows) {
  const width = rows[0].length;
  const words = Math.ceil((width * 3) / 2);
  const rowBytes = words * 2;
  const payload = Buffer.alloc(rowBytes * rows.length);
  rows.forEach((row, y) => {
    row.forEach(([r, g, b], x) => {
      const offset = y * rowBytes + x * 3;
      payload[offset] = r; payload[offset + 1] = g; payload[offset + 2] = b;
    });
  });
  return Buffer.concat([timHeader(3, false), block(words, rows.length, payload)]);
}

function pixelAt(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [...image.data.subarray(offset, offset + 4)];
}

// ---- 5-bit to 8-bit expansion ----
{
  // A full 5-bit channel must reach 255, not 248 -- otherwise white washes grey.
  const image = decodeTim(build16bpp([[bgr555(31, 31, 31)]]));
  check(
    JSON.stringify(pixelAt(image, 0, 0)) === JSON.stringify([255, 255, 255, 255]),
    `White 16bpp texel should expand to opaque 255,255,255 (got ${pixelAt(image, 0, 0)})`
  );
}

// ---- 16bpp direct colour, channel order, and transparency ----
{
  const image = decodeTim(build16bpp([
    [RED, GREEN],
    [BLUE, TRANSPARENT]
  ]));
  check(image.width === 2 && image.height === 2, `16bpp dimensions should be 2x2 (got ${image.width}x${image.height})`);
  check(image.mode === '16bpp', `16bpp mode should be reported (got ${image.mode})`);
  check(JSON.stringify(pixelAt(image, 0, 0)) === JSON.stringify([255, 0, 0, 255]), 'BGR555 red should decode to RGBA red');
  check(JSON.stringify(pixelAt(image, 1, 0)) === JSON.stringify([0, 255, 0, 255]), 'BGR555 green should decode to RGBA green');
  check(JSON.stringify(pixelAt(image, 0, 1)) === JSON.stringify([0, 0, 255, 255]), 'BGR555 blue should decode to RGBA blue');
  check(JSON.stringify(pixelAt(image, 1, 1)) === JSON.stringify([0, 0, 0, 0]), 'Texel 0x0000 should decode to fully transparent');
  check(image.data.length === 2 * 2 * 4, 'Decoded buffer length should be width*height*4');
}

// ---- Opaque black must survive (STP set, RGB zero) ----
{
  const image = decodeTim(build16bpp([[0x8000]]));
  check(
    JSON.stringify(pixelAt(image, 0, 0)) === JSON.stringify([0, 0, 0, 255]),
    `0x8000 should stay opaque black, not become transparent (got ${pixelAt(image, 0, 0)})`
  );
}

// ---- 4bpp paletted, including nibble order across a 2-row image ----
{
  const clut = [TRANSPARENT, RED, GREEN, BLUE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const image = decodeTim(build4bpp([
    [0, 1, 2, 3],
    [3, 2, 1, 0]
  ], [clut]));
  check(image.width === 4 && image.height === 2, `4bpp dimensions should be 4x2 (got ${image.width}x${image.height})`);
  check(image.mode === '4bpp', `4bpp mode should be reported (got ${image.mode})`);
  check(JSON.stringify(pixelAt(image, 1, 0)) === JSON.stringify([255, 0, 0, 255]), '4bpp low nibble should map to palette entry 1');
  check(JSON.stringify(pixelAt(image, 2, 0)) === JSON.stringify([0, 255, 0, 255]), '4bpp high nibble should map to palette entry 2');
  // Row 2 reversed: catches a decoder that ignores the row stride.
  check(JSON.stringify(pixelAt(image, 0, 1)) === JSON.stringify([0, 0, 255, 255]), '4bpp second row should start at the correct stride');
  check(JSON.stringify(pixelAt(image, 3, 1)) === JSON.stringify([0, 0, 0, 0]), '4bpp second row should end on the transparent entry');
}

// ---- 8bpp paletted ----
{
  const clut = new Array(256).fill(0);
  clut[7] = RED;
  clut[200] = BLUE;
  const image = decodeTim(build8bpp([[0, 7, 200, 7]], [clut]));
  check(image.width === 4 && image.height === 1, `8bpp dimensions should be 4x1 (got ${image.width}x${image.height})`);
  check(JSON.stringify(pixelAt(image, 1, 0)) === JSON.stringify([255, 0, 0, 255]), '8bpp index 7 should map to red');
  check(JSON.stringify(pixelAt(image, 2, 0)) === JSON.stringify([0, 0, 255, 255]), '8bpp index 200 should map to blue');
}

// ---- 24bpp direct colour ----
{
  const image = decodeTim(build24bpp([[[10, 20, 30], [200, 100, 50]]]));
  check(image.width === 2 && image.height === 1, `24bpp dimensions should be 2x1 (got ${image.width}x${image.height})`);
  check(JSON.stringify(pixelAt(image, 0, 0)) === JSON.stringify([10, 20, 30, 255]), '24bpp pixels should pass through unchanged and opaque');
  check(JSON.stringify(pixelAt(image, 1, 0)) === JSON.stringify([200, 100, 50, 255]), '24bpp second pixel should decode at a 3-byte stride');
}

// ---- Alternate palettes ----
{
  const clutA = [TRANSPARENT, RED, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const clutB = [TRANSPARENT, BLUE, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const buffer = build4bpp([[1, 1, 1, 1]], [clutA, clutB]);

  check(decodeTim(buffer).clutCount === 2, 'decodeTim should report both palettes');
  check(
    JSON.stringify(pixelAt(decodeTim(buffer), 0, 0)) === JSON.stringify([255, 0, 0, 255]),
    'Default palette should be CLUT 0'
  );
  check(
    JSON.stringify(pixelAt(decodeTim(buffer, { clutIndex: 1 }), 0, 0)) === JSON.stringify([0, 0, 255, 255]),
    'clutIndex 1 should select the second palette'
  );
  // A bad index must not throw or read out of bounds -- it falls back to CLUT 0.
  check(
    JSON.stringify(pixelAt(decodeTim(buffer, { clutIndex: 99 }), 0, 0)) === JSON.stringify([255, 0, 0, 255]),
    'Out-of-range clutIndex should fall back to CLUT 0'
  );
  check(
    JSON.stringify(pixelAt(decodeTim(buffer, { clutIndex: -1 }), 0, 0)) === JSON.stringify([255, 0, 0, 255]),
    'Negative clutIndex should fall back to CLUT 0'
  );
}

// ---- CLUT-less paletted images decode to a grey ramp rather than failing ----
{
  const payload = Buffer.from([0x10, 0x32]); // indices 0,1,2,3
  const buffer = Buffer.concat([timHeader(0, false), block(1, 1, payload)]);
  const image = decodeTim(buffer);
  check(image.width === 4 && image.hasClut === false, 'CLUT-less 4bpp should still decode');
  // 16 palette entries spread over 0..255 gives a step of 17.
  const ramp = [0, 1, 2, 3].map((x) => pixelAt(image, x, 0)[0]);
  check(
    JSON.stringify(ramp) === JSON.stringify([0, 17, 34, 51]),
    `CLUT-less 4bpp should ramp in steps of 17 (got ${ramp})`
  );
  check(
    [0, 1, 2, 3].every((x) => {
      const [r, g, b] = pixelAt(image, x, 0);
      return r === g && g === b;
    }),
    'Grey-ramp pixels should be neutral grey'
  );
  check(pixelAt(image, 0, 0)[3] === 255, 'Grey-ramp pixels should be opaque');
}

// ---- Header sniffing ----
{
  check(isTimBuffer(build16bpp([[RED]])), 'isTimBuffer should accept a real TIM');
  check(!isTimBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), 'isTimBuffer should reject a PNG header');
  check(!isTimBuffer(Buffer.alloc(4)), 'isTimBuffer should reject a buffer shorter than the header');
  check(!isTimBuffer(Buffer.from([0x10, 0x01, 0, 0, 0, 0, 0, 0])), 'isTimBuffer should reject a non-zero version byte');
  // pmode 7 is not a defined pixel mode
  check(!isTimBuffer(Buffer.from([0x10, 0, 0, 0, 0x07, 0, 0, 0])), 'isTimBuffer should reject an undefined pixel mode');
}

// ---- Rejections ----
{
  checkThrows(() => decodeTim(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), /not a valid TIM/i, 'A PNG should be rejected');
  checkThrows(() => decodeTim('not a buffer'), /Buffer/i, 'A non-Buffer input should be rejected');
  checkThrows(() => decodeTim(Buffer.concat([timHeader(4, false)])), /mixed-mode/i, 'Mixed-mode TIMs should be rejected with a clear message');

  // Truncated pixel block header.
  const truncated = Buffer.concat([timHeader(2, false), Buffer.from([0x10, 0x00])]);
  checkThrows(() => decodeTim(truncated), /truncated/i, 'A truncated block header should be rejected');

  // Zero height.
  const empty = Buffer.concat([timHeader(2, false), block(2, 0, Buffer.alloc(4))]);
  checkThrows(() => decodeTim(empty), /empty dimensions|truncated/i, 'Zero-height TIMs should be rejected');

  // A corrupt width must not trigger a giant allocation.
  const huge = Buffer.concat([timHeader(2, false), block(60000, 60000, Buffer.alloc(4))]);
  checkThrows(() => decodeTim(huge), /implausible/i, 'Implausible dimensions should be rejected before allocating');
}

// ---- Truncated payloads decode without crashing ----
{
  // Claims 2 rows but only supplies enough bytes for one. Real rips are
  // sometimes cut short; the decoder should pad rather than throw.
  const payload = Buffer.alloc(4);
  payload.writeUInt16LE(RED, 0);
  payload.writeUInt16LE(GREEN, 2);
  const buffer = Buffer.concat([timHeader(2, false), block(2, 2, payload)]);
  const image = decodeTim(buffer);
  check(image.width === 2 && image.height === 2, 'A short payload should still yield the declared dimensions');
  check(image.data.length === 16, 'A short payload should be zero-padded to full size');
  check(JSON.stringify(pixelAt(image, 0, 1)) === JSON.stringify([0, 0, 0, 0]), 'Missing rows should read as transparent');
}

// ---- Wiring: the converter and its validators must recognise .tim ----
{
  check(CONVERTER_IMAGE_EXTS.has('.tim'), 'node-tools/format-converter.js IMAGE_EXTS should include .tim');
  check(!IMAGE_EXTS.has('.tim'), 'path-utils IMAGE_EXTS must NOT claim .tim: sharp/PIL tools cannot read it');

  const { SUPPORTED_EXTS } = require('../src/main/folder-scan');
  check(SUPPORTED_EXTS.has('.tim'), 'folder scan should pick up .tim files');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-smoke-'));
  try {
    const good = path.join(dir, 'good.tim');
    fs.writeFileSync(good, build16bpp([[RED]]));
    check(validateMagicBytes(good) === true, 'validateMagicBytes should accept a real .tim');

    const bad = path.join(dir, 'bad.tim');
    fs.writeFileSync(bad, Buffer.from('this is plain text, not a texture'));
    check(validateMagicBytes(bad) === false, 'validateMagicBytes should reject a mislabelled .tim');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`TIM decoder smoke test FAILED (${failures.length} of ${assertions} assertions):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`TIM decoder smoke test passed (${assertions} assertions).`);
