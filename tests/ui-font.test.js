import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPixelFont, measurePixelText, getGlyph } from '../src/ui/font.js';

function tables(buf) {
  const v = new DataView(buf);
  const n = v.getUint16(4);
  const out = {};
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16;
    const tag = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
    out[tag] = { checksum: v.getUint32(p + 4), offset: v.getUint32(p + 8), length: v.getUint32(p + 12) };
  }
  return out;
}

/** Look a code point up in the format-4 cmap subtable. */
function cmapLookup(buf, t, code) {
  const v = new DataView(buf);
  const sub = t.cmap.offset + v.getUint32(t.cmap.offset + 8);
  assert.equal(v.getUint16(sub), 4);
  const segX2 = v.getUint16(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  for (let i = 0; i < segX2 / 2; i++) {
    const end = v.getUint16(ends + i * 2);
    if (code > end) continue;
    const start = v.getUint16(starts + i * 2);
    if (code < start) return 0;
    return (code + v.getInt16(deltas + i * 2)) & 0xffff;
  }
  return 0;
}

test('pixel font is a well-formed TrueType file', () => {
  const buf = buildPixelFont();
  const v = new DataView(buf);
  assert.equal(v.getUint32(0), 0x00010000);
  const t = tables(buf);
  for (const tag of ['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']) {
    assert.ok(t[tag], tag);
    assert.equal(t[tag].offset % 4, 0, `${tag} aligned`);
    assert.ok(t[tag].offset + t[tag].length <= buf.byteLength);
  }
  assert.equal(v.getUint32(t.head.offset + 12), 0x5f0f3cf5, 'head magic');
  assert.equal(v.getUint16(t.head.offset + 18), 1024, 'unitsPerEm');
  // whole-file checksum must be 0xB1B0AFBA after the adjustment
  let sum = 0;
  for (let i = 0; i < buf.byteLength; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  assert.equal(sum, 0xb1b0afba);
  const numGlyphs = v.getUint16(t.maxp.offset + 4);
  assert.equal(numGlyphs, 1 + 95 + 3);
  assert.equal(cmapLookup(buf, t, 0x20), 1);
  assert.equal(cmapLookup(buf, t, 0x41), 0x41 - 31);
  assert.equal(cmapLookup(buf, t, 0x7e), 95);
  assert.equal(cmapLookup(buf, t, 0xb0), 96);
  assert.equal(cmapLookup(buf, t, 0x4e2d), 0, 'CJK is not covered (falls back to system fonts)');
});

test('glyph metrics', () => {
  assert.equal(measurePixelText('Hi!'), 6 + 2 + 2);
  assert.equal(measurePixelText(' '), 4);
  assert.equal(measurePixelText('中'), 8);
  assert.equal(getGlyph('A').length, 7);
  assert.equal(getGlyph('中'), null);
});
