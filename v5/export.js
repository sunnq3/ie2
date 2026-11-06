'use strict';
/*
 * ie2 v5 — file writers.
 * JPEG: the GPU has already done colour conversion, chroma subsampling, DCT and quantisation (the same
 * passes the on-screen "as saved" view uses), so this file only entropy-codes those integers with
 * Huffman tables optimised for the image, and wraps them in JFIF + EXIF (orientation = upright).
 * PNG: 8- or 16-bit RGB, Sub filter, zlib via the browser's CompressionStream.
 */
const ENC = (() => {
  // zigzag scan: position in the scan -> index (row * 8 + col) within the block
  const ZIG = (() => {
    const z = [];
    for (let s = 0; s < 15; s++) {
      const cells = [];
      for (let r = 0; r < 8; r++) { const c = s - r; if (c >= 0 && c < 8) cells.push(r * 8 + c); }
      if (s % 2 === 0) cells.reverse();
      z.push(...cells);
    }
    return z;
  })();

  class Bytes {
    constructor(n) { this.b = new Uint8Array(n || 1 << 20); this.n = 0; }
    grow(k) { if (this.n + k <= this.b.length) return; let m = this.b.length * 2; while (m < this.n + k) m *= 2; const nb = new Uint8Array(m); nb.set(this.b.subarray(0, this.n)); this.b = nb; }
    u8(v) { this.grow(1); this.b[this.n++] = v & 255; }
    u16(v) { this.u8(v >> 8); this.u8(v); }
    u32(v) { this.u16(v >>> 16); this.u16(v & 0xffff); }
    raw(a) { this.grow(a.length); this.b.set(a, this.n); this.n += a.length; }
    out() { return this.b.slice(0, this.n); }
  }

  /* ---------------- Huffman tables (ITU T.81 Annex K.2) ---------------- */
  // freq: counts per symbol (DC: 0..11, AC: 0..255). Returns { bits[1..16], vals, code[], len[] }.
  function huffman(freq) {
    const n = freq.length, f = Array.from(freq);
    f.push(1);                                   // reserved symbol: no code may be all 1s
    const size = new Int32Array(f.length), next = new Int32Array(f.length).fill(-1);
    for (;;) {
      let a = -1, b = -1;
      for (let i = 0; i < f.length; i++) {        // two smallest non-zero, ties to the larger index
        if (!f[i]) continue;
        if (a < 0 || f[i] <= f[a]) { b = a; a = i; } else if (b < 0 || f[i] <= f[b]) b = i;
      }
      if (b < 0) break;
      f[b] += f[a]; f[a] = 0;
      for (let i = b; ; i = next[i]) { size[i]++; if (next[i] < 0) { next[i] = a; break; } }
      for (let i = a; i >= 0; i = next[i]) size[i]++;
    }
    const bits = new Int32Array(33);
    for (let i = 0; i < size.length; i++) if (size[i]) bits[size[i]]++;
    for (let i = 32; i > 16; i--) {               // limit code lengths to 16 bits
      while (bits[i] > 0) {
        let j = i - 2; while (bits[j] === 0) j--;
        bits[i] -= 2; bits[i - 1]++; bits[j + 1] += 2; bits[j]--;
      }
    }
    let top = 16; while (bits[top] === 0) top--;
    bits[top]--;                                  // drop the reserved symbol
    const vals = [];
    for (let L = 1; L <= 32; L++) for (let s = 0; s < n; s++) if (size[s] === L) vals.push(s);
    const code = new Int32Array(n), len = new Int32Array(n);
    let c = 0, k = 0;
    for (let L = 1; L <= 16; L++) { for (let i = 0; i < bits[L]; i++) { code[vals[k]] = c++; len[vals[k]] = L; k++; } c <<= 1; }
    return { bits: Array.from(bits.slice(1, 17)), vals: vals.slice(0, k), code, len };
  }
  const mag = (v) => { v = v < 0 ? -v : v; let n = 0; while (v) { n++; v >>= 1; } return n; };

  /* ---------------- EXIF: upright orientation, software, date ---------------- */
  function exif() {
    const d = new Date(), p = (x) => String(x).padStart(2, '0');
    const date = `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}\0`;
    const soft = 'ie2 v5\0';
    const ent = [[0x0112, 3, 1, 1], [0x0131, 2, soft.length, soft], [0x0132, 2, date.length, date]];
    const ifd = 8, dataAt = ifd + 2 + ent.length * 12 + 4;
    const t = new Bytes(256);
    t.raw([0x4d, 0x4d, 0, 42]); t.u32(ifd);       // big-endian TIFF header
    t.u16(ent.length);
    let off = dataAt; const extra = [];
    for (const [tag, type, count, val] of ent) {
      t.u16(tag); t.u16(type); t.u32(count);
      if (type === 3) { t.u16(val); t.u16(0); }
      else if (count <= 4) { const s = val.padEnd(4, '\0'); for (let i = 0; i < 4; i++) t.u8(s.charCodeAt(i)); }
      else { t.u32(off); extra.push(val); off += count + (count & 1); }
    }
    t.u32(0);
    for (const s of extra) { for (let i = 0; i < s.length; i++) t.u8(s.charCodeAt(i)); if (s.length & 1) t.u8(0); }
    return t.out();
  }

  /* ---------------- JPEG ---------------- */
  // src = { info: { W, H, Wp, Hp, hs, vs, qY, qC }, readY(y, rows), readC(y, rows) } (RGBA float rows)
  function jpeg(src, onProgress) {
    const { W, H, Wp, Hp, hs, vs, qY, qC } = src.info;
    const mw = 8 * hs, mh = 8 * vs, mx = Wp / mw, my = Hp / mh, Wc = Wp / hs, sep = hs * vs > 1;
    const blk = new Int32Array(64);
    // walk every block in MCU order, calling fn(component, block coefficients in zigzag order)
    function walk(fn) {
      for (let r = 0; r < my; r++) {
        const Yr = src.readY(r * mh, mh), Cr = sep ? src.readC(r * 8, 8) : Yr, cw = sep ? Wc : Wp;
        for (let m = 0; m < mx; m++) {
          for (let by = 0; by < vs; by++) for (let bx = 0; bx < hs; bx++) {
            const x0 = m * mw + bx * 8, y0 = by * 8;
            for (let k = 0; k < 64; k++) { const z = ZIG[k]; blk[k] = Yr[((y0 + (z >> 3)) * Wp + x0 + (z & 7)) * 4]; }
            fn(0, blk);
          }
          const x0 = sep ? m * 8 : m * mw;
          for (let c = 1; c <= 2; c++) {
            for (let k = 0; k < 64; k++) { const z = ZIG[k]; blk[k] = Cr[(((z >> 3)) * cw + x0 + (z & 7)) * 4 + c]; }
            fn(c, blk);
          }
        }
        if (onProgress && (r & 15) === 0) onProgress(r / my);
      }
    }
    // pass 1: symbol statistics
    const fDC = [new Float64Array(12), new Float64Array(12)], fAC = [new Float64Array(256), new Float64Array(256)];
    let pred = [0, 0, 0];
    const tally = (c, b) => {
      const t = c ? 1 : 0, d = b[0] - pred[c]; pred[c] = b[0];
      fDC[t][mag(d)]++;
      let run = 0;
      for (let k = 1; k < 64; k++) {
        if (!b[k]) { run++; continue; }
        while (run > 15) { fAC[t][0xf0]++; run -= 16; }
        fAC[t][(run << 4) | mag(b[k])]++; run = 0;
      }
      if (run) fAC[t][0]++;
    };
    walk(tally);
    const hDC = [huffman(fDC[0]), huffman(fDC[1])], hAC = [huffman(fAC[0]), huffman(fAC[1])];

    const o = new Bytes(Math.max(1 << 16, W * H));
    o.u16(0xffd8);
    o.u16(0xffe0); o.u16(16); o.raw([0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 0]); o.u16(1); o.u16(1); o.u8(0); o.u8(0);
    const ex = exif(); o.u16(0xffe1); o.u16(ex.length + 8); o.raw([0x45, 0x78, 0x69, 0x66, 0, 0]); o.raw(ex);
    o.u16(0xffdb); o.u16(2 + 2 * 65);
    o.u8(0); for (let k = 0; k < 64; k++) o.u8(qY[ZIG[k]]);
    o.u8(1); for (let k = 0; k < 64; k++) o.u8(qC[ZIG[k]]);
    o.u16(0xffc0); o.u16(17); o.u8(8); o.u16(H); o.u16(W); o.u8(3);
    o.u8(1); o.u8((hs << 4) | vs); o.u8(0);
    o.u8(2); o.u8(0x11); o.u8(1);
    o.u8(3); o.u8(0x11); o.u8(1);
    const tabs = [[0x00, hDC[0]], [0x10, hAC[0]], [0x01, hDC[1]], [0x11, hAC[1]]];
    o.u16(0xffc4); o.u16(2 + tabs.reduce((a, [, t]) => a + 17 + t.vals.length, 0));
    for (const [cls, t] of tabs) { o.u8(cls); t.bits.forEach(v => o.u8(v)); t.vals.forEach(v => o.u8(v)); }
    o.u16(0xffda); o.u16(12); o.u8(3); o.u8(1); o.u8(0x00); o.u8(2); o.u8(0x11); o.u8(3); o.u8(0x11); o.u8(0); o.u8(63); o.u8(0);

    // pass 2: entropy-coded data with 0xFF byte stuffing
    let acc = 0, nb = 0;
    const put = (code, n) => {
      acc = (acc << n) | (code & ((1 << n) - 1)); nb += n;
      while (nb >= 8) { const v = (acc >>> (nb - 8)) & 255; o.u8(v); if (v === 255) o.u8(0); nb -= 8; acc &= (1 << nb) - 1; }
    };
    const val = (v, n) => { if (n) put(v < 0 ? v + (1 << n) - 1 : v, n); };
    pred = [0, 0, 0];
    walk((c, b) => {
      const t = c ? 1 : 0, d = b[0] - pred[c]; pred[c] = b[0];
      const s = mag(d); put(hDC[t].code[s], hDC[t].len[s]); val(d, s);
      let run = 0;
      for (let k = 1; k < 64; k++) {
        if (!b[k]) { run++; continue; }
        while (run > 15) { put(hAC[t].code[0xf0], hAC[t].len[0xf0]); run -= 16; }
        const m = mag(b[k]), sym = (run << 4) | m; put(hAC[t].code[sym], hAC[t].len[sym]); val(b[k], m); run = 0;
      }
      if (run) put(hAC[t].code[0], hAC[t].len[0]);
    });
    if (nb) put((1 << (8 - nb)) - 1, 8 - nb);
    o.u16(0xffd9);
    return o.out();
  }

  /* ---------------- PNG ---------------- */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc(bytes, c = 0xffffffff) { for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8); return c; }
  function chunk(o, type, data) {
    const tb = new TextEncoder().encode(type);
    o.u32(data.length); o.raw(tb); o.raw(data);
    o.u32((crc(data, crc(tb)) ^ 0xffffffff) >>> 0);
  }
  // src = { w, h, deep, alpha, read(y, rows) -> RGBA (Uint8Array, or Float32Array 0..1 when deep) }
  // alpha: keep transparency (8-bit RGBA); otherwise RGB.
  async function png(src, onProgress) {
    if (typeof CompressionStream === 'undefined') throw new Error('this browser cannot write PNG files (no CompressionStream)');
    const { w, h, deep } = src, alpha = !!src.alpha && !deep, nc = alpha ? 4 : 3, bpp = deep ? 6 : nc, stride = w * bpp + 1;
    const cs = new CompressionStream('deflate'), writer = cs.writable.getWriter();
    const parts = []; let total = 0;
    const reading = (async () => { const rd = cs.readable.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; parts.push(value); total += value.length; } })();
    const band = Math.max(1, Math.floor((1 << 22) / (w * 4)));
    for (let y0 = 0; y0 < h; y0 += band) {
      const rows = Math.min(band, h - y0), px = src.read(y0, rows), out = new Uint8Array(rows * stride);
      const line = new Uint8Array(w * bpp);
      for (let r = 0; r < rows; r++) {
        for (let x = 0, i = r * w * 4, j = 0; x < w; x++, i += 4) {
          for (let c = 0; c < nc; c++) {
            if (deep) { const v = Math.round(Math.min(1, Math.max(0, px[i + c])) * 65535); line[j++] = v >> 8; line[j++] = v & 255; }
            else line[j++] = px[i + c];
          }
        }
        const o = r * stride; out[o] = 1;          // Sub filter
        for (let k = 0; k < line.length; k++) out[o + 1 + k] = (line[k] - (k >= bpp ? line[k - bpp] : 0)) & 255;
      }
      await writer.write(out);
      if (onProgress) onProgress(y0 / h);
    }
    await writer.close(); await reading;
    const o = new Bytes(total + 1024);
    o.raw([137, 80, 78, 71, 13, 10, 26, 10]);
    const ih = new Bytes(13); ih.u32(w); ih.u32(h); ih.u8(deep ? 16 : 8); ih.u8(alpha ? 6 : 2); ih.u8(0); ih.u8(0); ih.u8(0);
    chunk(o, 'IHDR', ih.out());
    chunk(o, 'sRGB', new Uint8Array([0]));
    chunk(o, 'tEXt', new TextEncoder().encode('Software\0ie2 v5'));
    const z = new Uint8Array(total); let k = 0; for (const p of parts) { z.set(p, k); k += p.length; }
    chunk(o, 'IDAT', z);
    chunk(o, 'IEND', new Uint8Array(0));
    return o.out();
  }

  return { jpeg, png, huffman, ZIG };
})();

if (typeof module !== 'undefined') module.exports = ENC;
