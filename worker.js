'use strict';
/*
 * ie2 processing worker.
 * Pipeline (each stage can be switched off and is then skipped entirely):
 *   size (upscale -> downscale, done first on the original) -> clean-up -> seam carving ->
 *   lens + chromatic aberration -> sharpen -> camera grain -> 8-bit
 * Pixels stay in floating point between stages; they are rounded to 8-bit exactly once, at the end.
 */

let SRC = null;   // { w, h, data: Uint8ClampedArray RGBA }
let CACHE = null; // after seam carving { key, w, h, data, mask }
let PRE = null;   // everything before grain { key, data, w, h }
let CLEAN = null; // cleaned source { key, data }
let SIZED = null; // resized original { key, data, w, h }

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    SRC = { w: m.w, h: m.h, data: new Uint8ClampedArray(m.buffer) };
    CACHE = null; PRE = null; CLEAN = null; SIZED = null;
  } else if (m.type === 'encode') {
    try {
      const bytes = encodeJPEG(new Uint8ClampedArray(m.buffer), m.w, m.h, m.opts || {});
      self.postMessage({ type: 'encoded', id: m.id, buffer: bytes.buffer }, [bytes.buffer]);
    } catch (err) { self.postMessage({ type: 'encode-error', id: m.id, message: (err && err.message) || String(err) }); }
  } else if (m.type === 'process') {
    try { runJob(m.id, m.params); }
    catch (err) { self.postMessage({ type: 'error', id: m.id, message: (err && err.message) || String(err) }); }
  }
};

function progress(id, label, frac) { self.postMessage({ type: 'progress', id, label, frac }); }

function carveKey(C) { return `${Math.round(+C.dw || 0)}|${Math.round(+C.dh || 0)}|${C.energy}`; }

function toF32(d) { return d instanceof Float32Array ? d : Float32Array.from(d); }
function toU8(d) { return d instanceof Uint8ClampedArray ? d : Uint8ClampedArray.from(d); }

// The single rounding to 8-bit. Values that are already whole numbers pass through untouched;
// everything else gets an invisible 1-LSB triangular dither so smooth gradients can't band.
function quantize(d, dither) {
  const out = new Uint8ClampedArray(d.length);
  if (!dither) { out.set(d); for (let i = 3; i < out.length; i += 4) out[i] = 255; return out; }
  const rnd = mulberry32(0x1234567);
  for (let i = 0; i < d.length; i++) {
    if ((i & 3) === 3) { out[i] = 255; continue; }
    const v = d[i], r = Math.round(v);
    out[i] = Math.abs(v - r) < 1e-3 ? r : v + (rnd() + rnd() - 1);
  }
  return out;
}

function runJob(id, P) {
  if (!SRC) throw new Error('No image loaded');
  const t0 = performance.now();
  const on = (k) => !(P[k] && P[k].on === false);

  // size: resample the original first, so no later edit is ever resampled — cached
  const scaleOn = on('resize') && !!(P.scale && P.scale.on);
  const sk = scaleOn ? JSON.stringify(P.scale) : '';
  if (!SIZED || SIZED.key !== sk) {
    if (scaleOn) { const r = rescale(toF32(SRC.data), SRC.w, SRC.h, P.scale, id); SIZED = { key: sk, data: toF32(r.data), w: r.w, h: r.h }; }
    else SIZED = { key: '', data: SRC.data, w: SRC.w, h: SRC.h };
    CLEAN = null;
  }

  // clean-up — cached
  const C = P.clean || {};
  const cleanOn = on('clean') && cleanActive(C);
  const ck = cleanOn ? JSON.stringify(C) : '';
  if (!CLEAN || CLEAN.key !== ck) {
    CLEAN = { key: ck, data: cleanOn ? cleanup(toF32(SIZED.data).slice(), SIZED.w, SIZED.h, C, id) : SIZED.data };
    CACHE = null;
  }

  // seam carving — cached
  const carveP = on('carve') ? (P.carve || {}) : { dw: 0, dh: 0, energy: (P.carve || {}).energy };
  const key = carveKey(carveP) + '#' + ck + '#' + sk;
  let recarved = false;
  if (!CACHE || CACHE.key !== key) {
    CACHE = carve({ w: SIZED.w, h: SIZED.h, data: CLEAN.data }, carveP, id);
    CACHE.key = key;
    recarved = true;
  }

  // lens/CA -> sharpen — cached
  const lensOn = on('lens'), sharpOn = !!(P.sharpen && P.sharpen.on);
  const preKey = key + '|' + JSON.stringify([lensOn && P.lens, lensOn && P.ca, sharpOn && P.sharpen]);
  if (recarved || !PRE || PRE.key !== preKey) {
    const { w, h } = CACHE;
    const out = toF32(lensOn ? resample(CACHE.data, w, h, P.lens, P.ca, id) : CACHE.data.slice());
    if (sharpOn) sharpenImage(out, w, h, P.sharpen);
    PRE = { key: preKey, data: out, w, h };
  }

  // camera grain — last, after all resampling
  const outData = PRE.data.slice();
  sensorSim(outData, PRE.w, PRE.h, P.sensor, id);
  const u8 = quantize(outData, true);
  const msg = { type: 'result', id, w: PRE.w, h: PRE.h, buffer: u8.buffer, ms: performance.now() - t0, carveKey: key };
  const transfer = [u8.buffer];
  if (recarved) { const mk = CACHE.mask.slice(); msg.mask = mk.buffer; transfer.push(mk.buffer); }
  self.postMessage(msg, transfer);
}

// Unsharp mask on luminance only (no colour fringes), with a soft threshold so flat areas and
// fine noise are left alone.
function sharpenImage(d, w, h, S) {
  const amt = +S.amount || 0;
  if (!(amt > 0)) return;
  const r = Math.max(0.3, +S.radius || 0.8), thr = Math.max(0, +S.threshold || 0);
  const N = w * h, Y = new Float32Array(N);
  for (let p = 0, i = 0; p < N; p++, i += 4) Y[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const B = blurPlane(Y, w, h, r);
  for (let p = 0, i = 0; p < N; p++, i += 4) {
    let dl = Y[p] - B[p];
    if (thr > 0) { const a = Math.abs(dl); dl = a <= thr ? 0 : (dl > 0 ? a - thr : thr - a); }
    if (dl === 0) continue;
    const k = amt * dl;
    for (let c = 0; c < 3; c++) { const v = d[i + c] + k; d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v; }
  }
}

/* ------------------------------------------------------------------ */
/* 1. Seam carving (content-aware scale)                               */
/* ------------------------------------------------------------------ */

function carve(src, C, id) {
  const W0 = src.w, H0 = src.h;
  let dw = Math.round(+C.dw || 0), dh = Math.round(+C.dh || 0);
  dw = Math.max(dw, -(W0 - 2));
  dh = Math.max(dh, -(H0 - 2));
  const mask = new Uint8Array(W0 * H0); // 1 = removed, 2 = duplicated (inserted next to)
  if (!dw && !dh) return { w: W0, h: H0, data: src.data.slice(), mask };

  let pix = new Uint32Array(toU8(src.data).slice().buffer);
  let oi = new Int32Array(W0 * H0);
  for (let i = 0; i < oi.length; i++) oi[i] = i;
  let w = W0, h = H0;

  const total = Math.abs(dw) + Math.abs(dh);
  let done = 0, last = 0;
  const tick = () => {
    done++;
    const t = performance.now();
    if (t - last > 60 || done === total) { last = t; progress(id, 'Seam carving', done / total); }
  };
  const forward = C.energy !== 'gradient';

  if (dw) {
    const r = carveAxis(pix, oi, w, h, dw, mask, forward, tick);
    pix = r.pix; oi = r.oi; w = r.w;
  }
  if (dh) {
    let t = transpose(pix, oi, w, h);               // now width=h, height=w
    const r = carveAxis(t.pix, t.oi, h, w, dh, mask, forward, tick);
    t = transpose(r.pix, r.oi, r.w, w);             // back: width=w, height=r.w
    pix = t.pix; oi = t.oi; h = r.w;
  }
  return { w, h, data: new Uint8ClampedArray(pix.buffer), mask };
}

function carveAxis(pix, oi, w, h, k, mask, forward, tick) {
  if (k < 0) {
    const nw = removeSeams(pix, oi, w, h, -k, forward, (row, x) => { mask[oi[row + x]] = 1; }, tick);
    return compact(pix, oi, w, nw, h);
  }
  let rem = k;
  while (rem > 0) {
    const n = Math.min(rem, Math.max(1, Math.floor(w / 2)));
    const r = insertSeams(pix, oi, w, h, n, mask, forward, tick);
    pix = r.pix; oi = r.oi; w = r.w; rem -= n;
  }
  return { pix, oi, w };
}

function lum(v) { return 0.299 * (v & 255) + 0.587 * ((v >>> 8) & 255) + 0.114 * ((v >>> 16) & 255); }

function grad(g, S, w, h, x, y) {
  const r = y * S;
  const xl = x > 0 ? x - 1 : x, xr = x < w - 1 ? x + 1 : x;
  const yu = y > 0 ? r - S : r, yd = y < h - 1 ? r + S : r;
  return Math.abs(g[r + xr] - g[r + xl]) + Math.abs(g[yd + x] - g[yu + x]);
}

function dpBackward(en, M, D, S, w, h) {
  for (let x = 0; x < w; x++) M[x] = en[x];
  for (let y = 1; y < h; y++) {
    const r = y * S, p = r - S;
    for (let x = 0; x < w; x++) {
      let best = M[p + x], d = 0;
      if (x > 0 && M[p + x - 1] < best) { best = M[p + x - 1]; d = -1; }
      if (x < w - 1 && M[p + x + 1] < best) { best = M[p + x + 1]; d = 1; }
      M[r + x] = en[r + x] + best; D[r + x] = d;
    }
  }
}

// Forward energy (Rubinstein, Shamir, Avidan 2008): cost of the new edges a removal creates
function dpForward(g, M, D, S, w, h) {
  for (let x = 0; x < w; x++) {
    const l = x > 0 ? g[x - 1] : g[x], rr = x < w - 1 ? g[x + 1] : g[x];
    M[x] = Math.abs(rr - l);
  }
  for (let y = 1; y < h; y++) {
    const r = y * S, p = r - S;
    for (let x = 0; x < w; x++) {
      const L = x > 0 ? g[r + x - 1] : g[r + x];
      const R = x < w - 1 ? g[r + x + 1] : g[r + x];
      const U = g[p + x];
      const cU = Math.abs(R - L);
      let best = M[p + x] + cU, d = 0;
      if (x > 0) { const v = M[p + x - 1] + cU + Math.abs(U - L); if (v < best) { best = v; d = -1; } }
      if (x < w - 1) { const v = M[p + x + 1] + cU + Math.abs(U - R); if (v < best) { best = v; d = 1; } }
      M[r + x] = best; D[r + x] = d;
    }
  }
}

// Removes n vertical seams in place (row stride S stays fixed). Returns new width.
function removeSeams(pix, car, S, h, n, forward, onRemove, tick) {
  let w = S;
  const N = S * h;
  const g = new Float32Array(N);
  for (let i = 0; i < N; i++) g[i] = lum(pix[i]);
  const M = new Float32Array(N);
  const D = new Int8Array(N);
  const seam = new Int32Array(h);
  let en = null;
  if (!forward) {
    en = new Float32Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) en[y * S + x] = grad(g, S, w, h, x, y);
  }
  for (let s = 0; s < n; s++) {
    if (forward) dpForward(g, M, D, S, w, h); else dpBackward(en, M, D, S, w, h);
    const last = (h - 1) * S;
    let bx = 0, bv = M[last];
    for (let x = 1; x < w; x++) if (M[last + x] < bv) { bv = M[last + x]; bx = x; }
    seam[h - 1] = bx;
    for (let y = h - 1; y > 0; y--) seam[y - 1] = seam[y] + D[y * S + seam[y]];

    for (let y = 0; y < h; y++) {
      const r = y * S, x = seam[y];
      onRemove(r, x);
      if (x < w - 1) {
        pix.copyWithin(r + x, r + x + 1, r + w);
        car.copyWithin(r + x, r + x + 1, r + w);
        g.copyWithin(r + x, r + x + 1, r + w);
        if (en) en.copyWithin(r + x, r + x + 1, r + w);
      }
    }
    w--;
    if (en) {
      for (let y = 0; y < h; y++) {
        let lo = seam[y], hi = seam[y];
        if (y > 0) { lo = Math.min(lo, seam[y - 1]); hi = Math.max(hi, seam[y - 1]); }
        if (y < h - 1) { lo = Math.min(lo, seam[y + 1]); hi = Math.max(hi, seam[y + 1]); }
        lo = Math.max(0, lo - 2); hi = Math.min(w - 1, hi + 1);
        const r = y * S;
        for (let x = lo; x <= hi; x++) en[r + x] = grad(g, S, w, h, x, y);
      }
    }
    tick();
  }
  return w;
}

function compact(pix, oi, S, w, h) {
  const np = new Uint32Array(w * h), no = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    np.set(pix.subarray(y * S, y * S + w), y * w);
    no.set(oi.subarray(y * S, y * S + w), y * w);
  }
  return { pix: np, oi: no, w };
}

function avgPix(a, b) {
  const r = ((a & 255) + (b & 255) + 1) >> 1;
  const g = (((a >>> 8) & 255) + ((b >>> 8) & 255) + 1) >> 1;
  const bb = (((a >>> 16) & 255) + ((b >>> 16) & 255) + 1) >> 1;
  return ((255 << 24) | (bb << 16) | (g << 8) | r) >>> 0;
}

// Seam insertion (Avidan & Shamir): find n removal seams on a copy, then duplicate them in the original
function insertSeams(pix, oi, w, h, n, mask, forward, tick) {
  const p2 = pix.slice();
  const loc = new Int32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) loc[y * w + x] = x;
  const dup = new Uint8Array(w * h);
  removeSeams(p2, loc, w, h, n, forward, (row, x) => { dup[row + loc[row + x]] = 1; }, tick);

  const W2 = w + n;
  const np = new Uint32Array(W2 * h), no = new Int32Array(W2 * h);
  for (let y = 0; y < h; y++) {
    let o = y * W2;
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const i = r + x;
      np[o] = pix[i]; no[o] = oi[i]; o++;
      if (dup[i]) {
        const j = x < w - 1 ? i + 1 : (x > 0 ? i - 1 : i);
        np[o] = avgPix(pix[i], pix[j]); no[o] = oi[i]; mask[oi[i]] = 2; o++;
      }
    }
  }
  return { pix: np, oi: no, w: W2 };
}

function transpose(pix, oi, w, h) {
  const np = new Uint32Array(w * h), no = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) { const j = x * h + y; np[j] = pix[r + x]; no[j] = oi[r + x]; }
  }
  return { pix: np, oi: no };
}

/* ------------------------------------------------------------------ */
/* 2 + 3. Lens distortion and chromatic aberration (one resample)       */
/* ------------------------------------------------------------------ */

function bil(d, w, h, x, y, c) {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = x | 0, y0 = y | 0;
  const x1 = x0 < w - 1 ? x0 + 1 : x0, y1 = y0 < h - 1 ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  const a0 = d[(y0 * w + x0) * 4 + c], a1 = d[(y0 * w + x1) * 4 + c];
  const b0 = d[(y1 * w + x0) * 4 + c], b1 = d[(y1 * w + x1) * 4 + c];
  const a = a0 + (a1 - a0) * fx, b = b0 + (b1 - b0) * fx;
  return a + (b - a) * fy;
}

function cl255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
function nea(d, w, h, x, y, c) {
  let xi = Math.round(x), yi = Math.round(y);
  xi = xi < 0 ? 0 : xi > w - 1 ? w - 1 : xi; yi = yi < 0 ? 0 : yi > h - 1 ? h - 1 : yi;
  return d[(yi * w + xi) * 4 + c];
}
// Pixel replace: copy one real source pixel, chosen between the two candidates on each axis with
// probability equal to the fractional position. No new (blended) colour values are created, there is
// no softening, and on average the sub-pixel position is exact. The choice is deterministic for a
// given source position, so all channels sampled at the same spot pick the same pixel.
function rpl(d, w, h, x, y, c) {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  let xi = x0, yi = y0;
  if (fx > 0 && x0 < w - 1 && hash2(Math.round(x * 1024), Math.round(y * 1024), 7919) < fx) xi = x0 + 1;
  if (fy > 0 && y0 < h - 1 && hash2(Math.round(y * 1024), Math.round(x * 1024), 104729) < fy) yi = y0 + 1;
  return d[(yi * w + xi) * 4 + c];
}
// Lanczos-3 via a kernel lookup table
const LZ_RES = 1024, LZ = new Float64Array(6 * LZ_RES + 1);
for (let i = 0; i <= 6 * LZ_RES; i++) {
  const t = i / LZ_RES - 3;
  LZ[i] = t === 0 ? 1 : Math.abs(t) >= 3 ? 0 : (3 * Math.sin(Math.PI * t) * Math.sin(Math.PI * t / 3)) / (Math.PI * Math.PI * t * t);
}
const LWX = new Float64Array(6), LWY = new Float64Array(6), LIX = new Int32Array(6), LIY = new Int32Array(6);
function lz3(d, w, h, x, y, c) {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  if (fx === 0 && fy === 0) return d[(y0 * w + x0) * 4 + c];
  let sx = 0, sy = 0;
  for (let k = 0; k < 6; k++) {
    const ox = k - 2;
    LWX[k] = LZ[Math.round((ox - fx + 3) * LZ_RES)]; sx += LWX[k];
    LWY[k] = LZ[Math.round((ox - fy + 3) * LZ_RES)]; sy += LWY[k];
    const xi = x0 + ox, yi = y0 + ox;
    LIX[k] = xi < 0 ? 0 : xi > w - 1 ? w - 1 : xi; LIY[k] = yi < 0 ? 0 : yi > h - 1 ? h - 1 : yi;
  }
  let s = 0;
  for (let j = 0; j < 6; j++) {
    const wy = LWY[j]; if (wy === 0) continue;
    const r = LIY[j] * w;
    let a = 0;
    for (let k = 0; k < 6; k++) a += LWX[k] * d[(r + LIX[k]) * 4 + c];
    s += wy * a;
  }
  return s / (sx * sy);
}
const WX = new Float64Array(4), WY = new Float64Array(4), IX = new Int32Array(4), IY = new Int32Array(4);
function cubicW(t, o) {
  const t2 = t * t, t3 = t2 * t;
  o[0] = -0.5 * t3 + t2 - 0.5 * t;
  o[1] = 1.5 * t3 - 2.5 * t2 + 1;
  o[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  o[3] = 0.5 * t3 - 0.5 * t2;
}
function bic(d, w, h, x, y, c) {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  cubicW(x - x0, WX); cubicW(y - y0, WY);
  for (let k = 0; k < 4; k++) {
    let xi = x0 - 1 + k; IX[k] = xi < 0 ? 0 : xi > w - 1 ? w - 1 : xi;
    let yi = y0 - 1 + k; IY[k] = yi < 0 ? 0 : yi > h - 1 ? h - 1 : yi;
  }
  let s = 0;
  for (let j = 0; j < 4; j++) {
    const r = IY[j] * w;
    s += WY[j] * (WX[0] * d[(r + IX[0]) * 4 + c] + WX[1] * d[(r + IX[1]) * 4 + c] +
                  WX[2] * d[(r + IX[2]) * 4 + c] + WX[3] * d[(r + IX[3]) * 4 + c]);
  }
  return s;
}

function autoZoom(w, h, cx, cy, k1, k2) {
  const R = Math.sqrt(w * w + h * h) / 2;
  let req = 0;
  const N = 256;
  const test = (px, py) => {
    const dx0 = px - cx, dy0 = py - cy;
    const nx = dx0 / R, ny = dy0 / R, r2 = nx * nx + ny * ny;
    const f = 1 + k1 * r2 + k2 * r2 * r2;
    const dX = dx0 * f, dY = dy0 * f;
    if (dX > 0 && w - cx > 0) req = Math.max(req, dX / (w - cx));
    if (dX < 0 && cx > 0) req = Math.max(req, -dX / cx);
    if (dY > 0 && h - cy > 0) req = Math.max(req, dY / (h - cy));
    if (dY < 0 && cy > 0) req = Math.max(req, -dY / cy);
  };
  for (let i = 0; i <= N; i++) {
    const tx = (i / N) * w, ty = (i / N) * h;
    test(tx, 0); test(tx, h); test(0, ty); test(w, ty);
  }
  return req > 1e-3 ? req : 1;
}

/* Plane helpers (Float32 single-channel images, values 0..255) */
function bilP(P, w, h, x, y) {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = x | 0, y0 = y | 0, x1 = x0 < w - 1 ? x0 + 1 : x0, y1 = y0 < h - 1 ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0, r0 = y0 * w, r1 = y1 * w;
  const a = P[r0 + x0] + (P[r0 + x1] - P[r0 + x0]) * fx;
  const b = P[r1 + x0] + (P[r1 + x1] - P[r1 + x0]) * fx;
  return a + (b - a) * fy;
}
function boxH(s, d, w, h, r) {
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = (r + 1) * s[row];
    for (let j = 1; j <= r; j++) sum += s[row + Math.min(j, w - 1)];
    for (let x = 0; x < w; x++) {
      d[row + x] = sum * k;
      sum += s[row + Math.min(x + r + 1, w - 1)] - s[row + Math.max(x - r, 0)];
    }
  }
}
function boxV(s, d, w, h, r) {
  // running column sums, walked row by row (cache-friendly)
  const k = 1 / (2 * r + 1), sum = new Float64Array(w);
  for (let x = 0; x < w; x++) sum[x] = (r + 1) * s[x];
  for (let j = 1; j <= r; j++) { const row = Math.min(j, h - 1) * w; for (let x = 0; x < w; x++) sum[x] += s[row + x]; }
  for (let y = 0; y < h; y++) {
    const o = y * w, add = Math.min(y + r + 1, h - 1) * w, sub = Math.max(y - r, 0) * w;
    for (let x = 0; x < w; x++) { d[o + x] = sum[x] * k; sum[x] += s[add + x] - s[sub + x]; }
  }
}
function blurPlane(src, w, h, sigma) {
  if (!(sigma > 0.05)) return src.slice();
  const tmp = new Float32Array(w * h);
  if (sigma < 1.2) {
    const r = Math.max(1, Math.ceil(sigma * 3)), K = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { K[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += K[i + r]; }
    for (let i = 0; i < K.length; i++) K[i] /= s;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let a = 0;
        for (let i = -r; i <= r; i++) { let xi = x + i; xi = xi < 0 ? 0 : xi >= w ? w - 1 : xi; a += src[row + xi] * K[i + r]; }
        tmp[row + x] = a;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let a = 0;
        for (let i = -r; i <= r; i++) { let yi = y + i; yi = yi < 0 ? 0 : yi >= h ? h - 1 : yi; a += tmp[yi * w + x] * K[i + r]; }
        out[y * w + x] = a;
      }
    }
    return out;
  }
  // 3 box blurs approximate a Gaussian
  const n = 3, wIdeal = Math.sqrt(12 * sigma * sigma / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const a = src.slice();
  for (let i = 0; i < n; i++) {
    const r = ((i < m ? wl : wl + 2) - 1) / 2;
    boxH(a, tmp, w, h, r); boxV(tmp, a, w, h, r);
  }
  return a;
}

/* Spectral dispersion: wavelength bands, per-channel sensitivity weights, Cauchy-like index curve */
/*
 * Spectral dispersion.
 *  achromat: secondary spectrum of a corrected doublet — magnification vs wavelength is parabolic,
 *            red and blue land together and green separates -> green/magenta fringes (most real lenses).
 *  singlet:  uncorrected lens, monotonic Cauchy dispersion -> blue/yellow or red/cyan fringes.
 *  prism:    monotonic dispersion seen through narrow filters -> visible rainbow.
 * achromat and singlet are integrated with broad, overlapping Bayer-filter sensitivities.
 */
function spectralBands(N, balance, type) {
  type = type || 'achromat';
  const e = [], wt = [[], [], []], ebar = [0, 0, 0];
  const g = (l, c, s) => Math.exp(-0.5 * ((l - c) / s) * ((l - c) / s));
  const inv = (l) => 1 / (l * l);
  const l0 = balance || 550, norm = inv(400) - inv(550);
  for (let b = 0; b < N; b++) {
    const l = 400 + 300 * (b + 0.5) / N;
    if (type === 'achromat') { const t = (l - l0) / 150; e.push(t * t - 1 / 3); }
    else e.push((inv(l) - inv(l0)) / norm);
    if (type === 'prism') {
      wt[0].push(g(l, 600, 45) + 0.12 * g(l, 445, 20));
      wt[1].push(g(l, 545, 40));
      wt[2].push(g(l, 450, 28));
    } else {
      wt[0].push(g(l, 605, 48) + 0.06 * g(l, 440, 25) + 0.08 * g(l, 530, 40));
      wt[1].push(g(l, 538, 50) + 0.06 * g(l, 610, 40));
      wt[2].push(g(l, 462, 38) + 0.08 * g(l, 520, 35));
    }
  }
  for (let c = 0; c < 3; c++) {
    // drop bands that contribute < 4% of the channel's peak (speed), then normalise
    const mx = Math.max(...wt[c]);
    for (let b = 0; b < N; b++) if (wt[c][b] < 0.04 * mx) wt[c][b] = 0;
    const s = wt[c].reduce((a, v) => a + v, 0);
    for (let b = 0; b < N; b++) { wt[c][b] /= s; ebar[c] += wt[c][b] * e[b]; }
  }
  return { e, wt, ebar };
}

/* ---- Bayer helpers ---------------------------------------------------- */
function cfaOf(pattern) {
  const pat = (pattern || 'RGGB').toUpperCase(), idx = { R: 0, G: 1, B: 2 };
  return [idx[pat[0]], idx[pat[1]], idx[pat[2]], idx[pat[3]]];
}
// 2-px mirror-reflect padding (reflection keeps the CFA phase at the borders)
function padReflect(A, w, h) {
  const W2 = w + 4, Q = new Float32Array(W2 * (h + 4));
  const rx = (x) => { x = x < 0 ? -x : x >= w ? 2 * w - 2 - x : x; return x < 0 ? 0 : x >= w ? w - 1 : x; };
  const ry = (y) => { y = y < 0 ? -y : y >= h ? 2 * h - 2 - y : y; return y < 0 ? 0 : y >= h ? h - 1 : y; };
  const l1 = rx(-1), l2 = rx(-2), r1 = rx(w), r2 = rx(w + 1);
  for (let y = -2; y < h + 2; y++) {
    const sr = ry(y) * w, row = (y + 2) * W2;
    Q.set(A.subarray(sr, sr + w), row + 2);
    Q[row] = A[sr + l2]; Q[row + 1] = A[sr + l1]; Q[row + w + 2] = A[sr + r1]; Q[row + w + 3] = A[sr + r2];
  }
  return Q;
}

/*
 * Demosaic a single-channel CFA mosaic M into three planes.
 *  'edge'     edge-directed (Hamilton-Adams style): green is interpolated along the direction with
 *             the smaller gradient, measured on the guide mosaic; red/blue via colour differences.
 *  'mhc'      Malvar-He-Cutler 5x5 linear filters.
 *  'bilinear' plain neighbour averages.
 * For a fixed guide every method is linear in M, so it can be applied to a noise mosaic on its own.
 */
function demosaicMosaic(M, w, h, cfa, method, guide) {
  const N = w * h, P0 = new Float32Array(N), P1 = new Float32Array(N), P2 = new Float32Array(N), P = [P0, P1, P2];
  const W2 = w + 4, Wd = 2 * W2, Q = padReflect(M, w, h);
  const colAt = (x, y) => cfa[((y & 1) << 1) | (x & 1)];
  if (method === 'edge') {
    const Gd = padReflect(guide || M, w, h);
    // pass 1: green everywhere
    const Gp = new Float32Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const q = (y + 2) * W2 + x + 2, p = y * w + x;
      if (colAt(x, y) === 1) { Gp[p] = Q[q]; continue; }
      const C = Q[q];
      const gh = (Q[q - 1] + Q[q + 1]) / 2 + (2 * C - Q[q - 2] - Q[q + 2]) / 4;
      const gv = (Q[q - W2] + Q[q + W2]) / 2 + (2 * C - Q[q - Wd] - Q[q + Wd]) / 4;
      const c = Gd[q];
      const dH = Math.abs(Gd[q - 1] - Gd[q + 1]) + Math.abs(2 * c - Gd[q - 2] - Gd[q + 2]);
      const dV = Math.abs(Gd[q - W2] - Gd[q + W2]) + Math.abs(2 * c - Gd[q - Wd] - Gd[q + Wd]);
      const wH = 1 / ((1 + dH) * (1 + dH)), wV = 1 / ((1 + dV) * (1 + dV));
      Gp[p] = (wH * gh + wV * gv) / (wH + wV);
    }
    const G = padReflect(Gp, w, h);
    // pass 2/3: red and blue from colour differences (X - G) of the nearest same-colour sites
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const q = (y + 2) * W2 + x + 2, p = y * w + x, c = colAt(x, y), g = G[q];
      P1[p] = g;
      if (c === 1) {
        const hc = colAt(x + 1, y), vc = colAt(x, y + 1);
        P[hc][p] = g + ((Q[q - 1] - G[q - 1]) + (Q[q + 1] - G[q + 1])) / 2;
        P[vc][p] = g + ((Q[q - W2] - G[q - W2]) + (Q[q + W2] - G[q + W2])) / 2;
      } else {
        P[c][p] = Q[q];
        const o = 2 - c;
        P[o][p] = g + ((Q[q - W2 - 1] - G[q - W2 - 1]) + (Q[q - W2 + 1] - G[q - W2 + 1]) +
                       (Q[q + W2 - 1] - G[q + W2 - 1]) + (Q[q + W2 + 1] - G[q + W2 + 1])) / 4;
      }
    }
    return P;
  }
  const mhc = method !== 'bilinear', out = [0, 0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = colAt(x, y), q = (y + 2) * W2 + x + 2, C = Q[q], p = y * w + x;
    out[0] = out[1] = out[2] = 0; out[c] = C;
    const l = Q[q - 1], r = Q[q + 1], u = Q[q - W2], d = Q[q + W2];
    const dg = Q[q - W2 - 1] + Q[q - W2 + 1] + Q[q + W2 - 1] + Q[q + W2 + 1];
    if (c !== 1) {
      const o = 2 - c;
      if (mhc) {
        const far = Q[q - 2] + Q[q + 2] + Q[q - Wd] + Q[q + Wd];
        out[1] = (4 * C + 2 * (l + r + u + d) - far) / 8;
        out[o] = (6 * C + 2 * dg - 1.5 * far) / 8;
      } else { out[1] = (l + r + u + d) / 4; out[o] = dg / 4; }
    } else {
      const hc = colAt(x + 1, y), vc = colAt(x, y + 1);
      if (mhc) {
        const fh = Q[q - 2] + Q[q + 2], fv = Q[q - Wd] + Q[q + Wd];
        out[hc] = (5 * C + 4 * (l + r) - fh - dg + 0.5 * fv) / 8;
        out[vc] = (5 * C + 4 * (u + d) - fv - dg + 0.5 * fh) / 8;
      } else { out[hc] = (l + r) / 2; out[vc] = (u + d) / 2; }
    }
    P0[p] = out[0]; P1[p] = out[1]; P2[p] = out[2];
  }
  return P;
}

/* 16-bit LUT linear(0..1) -> sRGB(0..255) */
let ENC_LUT = null;
function encLut() {
  if (ENC_LUT) return ENC_LUT;
  ENC_LUT = new Float32Array(65537);
  for (let i = 0; i <= 65536; i++) ENC_LUT[i] = enc(i / 65536) * 255;
  return ENC_LUT;
}
function encPx(v) { // v: linear 0..255 scale
  let t = v * (65536 / 255);
  if (!(t > 0)) return 0;
  if (t >= 65536) return 255;
  const i = t | 0, f = t - i, L = ENC_LUT;
  return L[i] + (L[i + 1] - L[i]) * f;
}

function hsvRgb(hDeg, s, v) {
  const h = ((hDeg % 360) + 360) % 360 / 60, c = v * s, x = c * (1 - Math.abs((h % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 1) { r = c; g = x; } else if (h < 2) { r = x; g = c; } else if (h < 3) { g = c; b = x; }
  else if (h < 4) { g = x; b = c; } else if (h < 5) { r = x; b = c; } else { r = c; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/*
 * Lens distortion + chromatic aberration.
 * Main pass (one resample from the source): per-channel lateral shift, radial scale shaped by a
 * falloff curve, spectral dispersion, irregular displacement field.
 * Post passes on float planes: axial blur, directional smear, echo, chroma-vs-luma shift, purple fringing.
 */
function resample(data, w, h, L, A, id) {
  L = L || {}; A = A || {};
  const k1 = +L.k1 || 0, k2 = +L.k2 || 0;
  const userZoom = +L.zoom || 1;
  const cx = w * (0.5 + (+L.cx || 0) / 100), cy = h * (0.5 + (+L.cy || 0) / 100);
  const sh = [[+A.rx || 0, +A.ry || 0], [+A.gx || 0, +A.gy || 0], [+A.bx || 0, +A.by || 0]];
  const scl = [(+A.rs || 0) / 100, (+A.gs || 0) / 100, (+A.bs || 0) / 100];
  const F = A.fall || {}, DS = A.disp || {}, IR = A.irr || {}, AX = A.axial || {}, SM = A.smear || {},
        EC = A.echo || {}, CL = A.cl || {}, PF = A.pf || {};

  const D = DS.on ? (+DS.amount || 0) / 100 : 0;
  const irrOn = !!IR.on && (+IR.amount || 0) > 0;
  const axOn = !!AX.on && ((+AX.r || 0) > 0 || (+AX.g || 0) > 0 || (+AX.b || 0) > 0);
  const smOn = !!SM.on && ((+SM.r || 0) !== 0 || (+SM.g || 0) !== 0 || (+SM.b || 0) !== 0);
  const ecOn = !!EC.on && (+EC.count || 0) >= 1 && (+EC.decay || 0) > 0;
  const clOn = !!CL.on && ['cbx', 'cby', 'crx', 'cry', 'bleed', 'soft'].some(k => (+CL[k] || 0) !== 0);
  const pfOn = !!PF.on && (+PF.amount || 0) > 0;
  const postOn = axOn || smOn || ecOn || clOn || pfOn;

  const lensOn = k1 !== 0 || k2 !== 0;
  const caOn = sh.some(s => s[0] !== 0 || s[1] !== 0) || scl.some(s => s !== 0) || D !== 0 || irrOn || postOn;
  let z = userZoom;
  if (lensOn && L.autofill) z *= autoZoom(w, h, cx, cy, k1, k2);
  if (!lensOn && !caOn && z === 1) return data.slice();
  // mix in linear light when any CA effect is active (how fringes form optically and on the sensor)
  const linOn = caOn && A.linear !== false;
  let src = data;
  if (linOn) {
    encLut();
    src = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 4) {
      src[i] = linOf(data[i]) * 255; src[i + 1] = linOf(data[i + 1]) * 255; src[i + 2] = linOf(data[i + 2]) * 255;
    }
  }

  const sample = L.interp === 'bilinear' ? bil : L.interp === 'nearest' ? nea : L.interp === 'replace' ? rpl : L.interp === 'lanczos3' ? lz3 : bic;
  const bandSample = L.interp === 'nearest' ? nea : L.interp === 'replace' ? rpl : bil;
  const R = Math.sqrt(w * w + h * h) / 2, invR = 1 / R, iz = 1 / z;

  // radial falloff curve g(r): r = 0 at centre, 1 at the corner
  const curve = F.curve || 'power', ex = Math.max(0.01, F.exp == null ? 1 : +F.exp);
  const r0 = Math.min(0.99, Math.max(0, (+F.start || 0) / 100));
  const rw = Math.max(0.01, (F.width == null ? 30 : +F.width) / 100);
  const asp = Math.max(-0.95, Math.min(0.95, (+F.aspect || 0) / 100));
  const linear = curve === 'power' && ex === 1 && r0 === 0;
  const gf = (rr) => {
    if (curve === 'ring') { const d = (rr - r0) / rw; return Math.exp(-ex * d * d); }
    const t = (rr - r0) / (1 - r0);
    if (t <= 0) return 0;
    if (curve === 'smooth') { const u = t < 1 ? t : 1, s = u * u * (3 - 2 * u); return (ex === 1 ? s : Math.pow(s, ex)) * (t > 1 ? t : 1); }
    return ex === 1 ? t : Math.pow(t, ex);
  };
  const shiftFall = !!F.shifts;

  // geometry for an output pixel: source offset from centre (dx, dy), radial unit vector, falloff
  const G = { dx: 0, dy: 0, ux: 0, uy: 0, g: 0 };
  const geo = (x, y) => {
    const px = x + 0.5 - cx, py = y + 0.5 - cy;
    let dx = px, dy = py;
    if (lensOn) {
      const nx = px * invR, ny = py * invR, r2 = nx * nx + ny * ny, f = 1 + k1 * r2 + k2 * r2 * r2;
      dx *= f; dy *= f;
    }
    dx *= iz; dy *= iz;
    const dl = Math.sqrt(dx * dx + dy * dy);
    G.dx = dx; G.dy = dy;
    G.ux = dl > 1e-9 ? dx / dl : 0; G.uy = dl > 1e-9 ? dy / dl : 0;
    const rr = asp === 0 ? dl * invR : Math.sqrt(dx * dx * (1 + asp) * (1 + asp) + dy * dy * (1 - asp) * (1 - asp)) * invR;
    G.g = linear ? rr : gf(rr);
    return G;
  };

  // spectral bands
  let SB = null, NB = 0;
  if (D !== 0) { NB = Math.max(3, Math.min(32, Math.round(+DS.bands || 12))); SB = spectralBands(NB, +DS.balance || 550, DS.lens || 'achromat'); }

  // irregular displacement field on a coarse grid
  let IG = null, ist = 1, igw = 0;
  const irrA = +IR.amount || 0, irrFall = !!IR.fall;
  if (irrOn) {
    const S = Math.max(2, +IR.scale || 80), oct = Math.max(1, Math.min(5, Math.round(+IR.detail || 2)));
    const seed = Math.round(+IR.seed || 1);
    ist = Math.max(1, Math.min(8, Math.round(S / 6)));
    igw = Math.ceil(w / ist) + 2;
    const igh = Math.ceil(h / ist) + 2;
    IG = [];
    let ampSum = 0; for (let o = 0; o < oct; o++) ampSum += Math.pow(0.5, o);
    for (let c = 0; c < 3; c++) {
      const fx = new Float32Array(igw * igh), fy = new Float32Array(igw * igh);
      if (!(c === 1 && IR.lockg)) {
        for (let j = 0; j < igh; j++) for (let i = 0; i < igw; i++) {
          const X = i * ist / S, Y = j * ist / S;
          let ax = 0, ay = 0;
          for (let o = 0; o < oct; o++) {
            const f = 1 << o, a = Math.pow(0.5, o);
            ax += a * (2 * vnoise(X * f, Y * f, seed * 31 + c * 7 + o * 101) - 1);
            ay += a * (2 * vnoise(X * f + 17.3, Y * f - 9.1, seed * 31 + c * 7 + o * 101 + 53) - 1);
          }
          fx[j * igw + i] = (ax / ampSum) * irrA * 1.8;
          fy[j * igw + i] = (ay / ampSum) * irrA * 1.8;
        }
      }
      IG.push([fx, fy]);
    }
  }
  const IRX = [0, 0, 0], IRY = [0, 0, 0];
  const irrAt = (x, y, g) => {
    const gx = x / ist, gy = y / ist, xi = gx | 0, yi = gy | 0, fx = gx - xi, fy = gy - yi, o = yi * igw + xi;
    const k = irrFall ? g : 1;
    for (let c = 0; c < 3; c++) {
      const [ax, ay] = IG[c];
      const a0 = ax[o] + (ax[o + 1] - ax[o]) * fx, a1 = ax[o + igw] + (ax[o + igw + 1] - ax[o + igw]) * fx;
      const b0 = ay[o] + (ay[o + 1] - ay[o]) * fx, b1 = ay[o + igw] + (ay[o + igw + 1] - ay[o + igw]) * fx;
      IRX[c] = (a0 + (a1 - a0) * fy) * k; IRY[c] = (b0 + (b1 - b0) * fy) * k;
    }
  };

  // ---- main pass ----
  const N = w * h;
  const out = new Float32Array(N * 4);
  const P = postOn ? [new Float32Array(N), new Float32Array(N), new Float32Array(N)] : null;
  const V = [0, 0, 0];
  let last = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const g = geo(x, y), dx = g.dx, dy = g.dy, ux = g.ux, uy = g.uy, gg = g.g;
      if (irrOn) irrAt(x, y, gg);
      const fs = shiftFall ? gg : 1;
      for (let c = 0; c < 3; c++) {
        let bx = cx + dx - sh[c][0] * fs - 0.5, by = cy + dy - sh[c][1] * fs - 0.5;
        if (irrOn) { bx -= IRX[c]; by -= IRY[c]; }
        if (D === 0) {
          const d = scl[c] * gg * R;
          V[c] = sample(src, w, h, bx - ux * d, by - uy * d, c);
        } else {
          const wt = SB.wt[c], e = SB.e;
          let acc = 0;
          for (let b = 0; b < NB; b++) {
            const wb = wt[b];
            if (wb === 0) continue;
            const d = (scl[c] + D * e[b]) * gg * R;
            acc += wb * bandSample(src, w, h, bx - ux * d, by - uy * d, c);
          }
          V[c] = acc;
        }
      }
      const p = y * w + x;
      if (P) { P[0][p] = V[0]; P[1][p] = V[1]; P[2][p] = V[2]; }
      else if (linOn) { const o = p * 4; out[o] = encPx(V[0]); out[o + 1] = encPx(V[1]); out[o + 2] = encPx(V[2]); out[o + 3] = 255; }
      else { const o = p * 4; out[o] = cl255(V[0]); out[o + 1] = cl255(V[1]); out[o + 2] = cl255(V[2]); out[o + 3] = 255; }
    }
    if (id != null && (y & 31) === 0) { const t = performance.now(); if (t - last > 100) { last = t; progress(id, 'Lens / CA', 0.3 + 0.4 * y / h); } }
  }
  if (!P) return out;

  // ---- axial CA: per-channel defocus ----
  if (axOn) {
    if (id != null) progress(id, 'Axial CA', 0.72);
    const rad = [+AX.r || 0, +AX.g || 0, +AX.b || 0], ew = Math.min(1, Math.max(0, (+AX.edge || 0) / 100));
    for (let c = 0; c < 3; c++) {
      if (!(rad[c] > 0)) continue;
      const B = blurPlane(P[c], w, h, rad[c]), Pc = P[c];
      if (ew === 0) { P[c] = B; continue; }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = y * w + x, k = (1 - ew) + ew * Math.min(1.5, geo(x, y).g);
        Pc[p] += (B[p] - Pc[p]) * k;
      }
    }
  }

  // ---- directional smear ----
  if (smOn) {
    if (id != null) progress(id, 'Smear', 0.78);
    const len = [+SM.r || 0, +SM.g || 0, +SM.b || 0];
    const th = (+SM.angle || 0) * Math.PI / 180, ca = Math.cos(th), sa = Math.sin(th);
    const mode = SM.dir || 'fixed', trail = SM.mode === 'trail', follow = !!SM.follow;
    for (let c = 0; c < 3; c++) {
      if (len[c] === 0) continue;
      const S = P[c].slice(), Pc = P[c];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let vx = ca, vy = sa, Lc = len[c];
        if (mode !== 'fixed' || follow) {
          const g = geo(x, y);
          if (mode === 'radial') { vx = g.ux; vy = g.uy; } else if (mode === 'tangential') { vx = -g.uy; vy = g.ux; }
          if (follow) Lc *= Math.min(1.5, g.g);
        }
        const aL = Math.abs(Lc);
        if (aL < 0.01) continue;
        const n = Math.max(2, Math.ceil(aL * 2) + 1);
        let acc = 0, ws = 0;
        for (let i = 0; i < n; i++) {
          const f = i / (n - 1);
          const t = trail ? f * Lc : (f - 0.5) * Lc;
          const wgt = trail ? 1 - f * (n - 1) / n : 1;
          acc += wgt * bilP(S, w, h, x - vx * t, y - vy * t); ws += wgt;
        }
        Pc[y * w + x] = acc / ws;
      }
    }
  }

  // ---- echo: ghost copies at multiples of each channel's displacement ----
  if (ecOn) {
    if (id != null) progress(id, 'Echo', 0.84);
    const E = Math.max(1, Math.min(8, Math.round(+EC.count || 1))), dec = Math.min(1, Math.max(0, +EC.decay || 0));
    const sp = Math.max(0.05, +EC.spacing || 1);
    const S = [P[0].slice(), P[1].slice(), P[2].slice()];
    const MX = [0, 0, 0], MY = [0, 0, 0];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const g = geo(x, y), gg = g.g, fs = shiftFall ? gg : 1;
      if (irrOn) irrAt(x, y, gg);
      for (let c = 0; c < 3; c++) {
        const d = (scl[c] + (SB ? D * SB.ebar[c] : 0)) * gg * R;
        MX[c] = g.ux * d + sh[c][0] * fs + (irrOn ? IRX[c] : 0);
        MY[c] = g.uy * d + sh[c][1] * fs + (irrOn ? IRY[c] : 0);
      }
      const p = y * w + x;
      for (let c = 0; c < 3; c++) {
        if (Math.abs(MX[c]) + Math.abs(MY[c]) < 1e-3) continue;
        let acc = S[c][p], ws = 1, wk = 1;
        for (let k = 1; k <= E; k++) {
          wk *= dec;
          acc += wk * bilP(S[c], w, h, x - k * sp * MX[c], y - k * sp * MY[c]); ws += wk;
        }
        P[c][p] = acc / ws;
      }
    }
  }

  // back to gamma-encoded values for the display-space effects below
  if (linOn) for (let c = 0; c < 3; c++) { const Pc = P[c]; for (let p = 0; p < N; p++) Pc[p] = encPx(Pc[p]); }

  // ---- chroma vs luma shift (YCbCr, BT.709) ----
  if (clOn) {
    if (id != null) progress(id, 'Chroma shift', 0.9);
    const Kr = 0.2126, Kb = 0.0722, Kg = 1 - Kr - Kb;
    const Y = new Float32Array(N), Cb = new Float32Array(N), Cr = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const r = P[0][p], g = P[1][p], b = P[2][p], yy = Kr * r + Kg * g + Kb * b;
      Y[p] = yy; Cb[p] = (b - yy) / (2 * (1 - Kb)); Cr[p] = (r - yy) / (2 * (1 - Kr));
    }
    const soft = +CL.soft || 0;
    const CbS = soft > 0 ? blurPlane(Cb, w, h, soft) : Cb, CrS = soft > 0 ? blurPlane(Cr, w, h, soft) : Cr;
    const cbx = +CL.cbx || 0, cby = +CL.cby || 0, crx = +CL.crx || 0, cry = +CL.cry || 0, bl = +CL.bleed || 0;
    const nb = bl > 0.01 ? Math.max(2, Math.ceil(bl * 2) + 1) : 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let b = 0, r = 0, ws = 0;
      for (let i = 0; i < nb; i++) {
        const f = nb > 1 ? i / (nb - 1) : 0, t = f * bl, wgt = 1 - f * (nb - 1) / nb;
        b += wgt * bilP(CbS, w, h, x - cbx - t, y - cby);
        r += wgt * bilP(CrS, w, h, x - crx - t, y - cry);
        ws += wgt;
      }
      b /= ws; r /= ws;
      const p = y * w + x, yy = Y[p];
      const R_ = yy + 2 * (1 - Kr) * r, B_ = yy + 2 * (1 - Kb) * b;
      P[0][p] = R_; P[2][p] = B_; P[1][p] = (yy - Kr * R_ - Kb * B_) / Kg;
    }
  }

  // ---- purple fringing around bright high-contrast edges ----
  if (pfOn) {
    if (id != null) progress(id, 'Purple fringing', 0.95);
    const amt = Math.min(1, (+PF.amount || 0) / 100), thr = +PF.thr || 215, soft = 24;
    const wid = Math.max(0.2, +PF.width || 2.5), bias = +PF.bias || 0, ew = Math.min(1, Math.max(0, (+PF.edge || 0) / 100));
    const col = hsvRgb(PF.hue == null ? 285 : +PF.hue, 0.8, 0.72);
    const H = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const l = 0.2126 * P[0][p] + 0.7152 * P[1][p] + 0.0722 * P[2][p];
      let t = (l - (thr - soft)) / soft; t = t < 0 ? 0 : t > 1 ? 1 : t;
      H[p] = t * t * (3 - 2 * t);
    }
    const Hb = blurPlane(H, w, h, wid);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let hb, wgt = 1;
      if (bias !== 0 || ew > 0) {
        const g = geo(x, y);
        hb = bias !== 0 ? bilP(Hb, w, h, x - g.ux * bias, y - g.uy * bias) : Hb[p];
        wgt = (1 - ew) + ew * Math.min(1.5, g.g);
      } else hb = Hb[p];
      let halo = (hb - H[p]) * 2.2; if (halo <= 0) continue; if (halo > 1) halo = 1;
      const k = amt * halo * wgt;
      P[0][p] += (col[0] - P[0][p]) * k; P[1][p] += (col[1] - P[1][p]) * k; P[2][p] += (col[2] - P[2][p]) * k;
    }
  }

  for (let p = 0, o = 0; p < N; p++, o += 4) { out[o] = cl255(P[0][p]); out[o + 1] = cl255(P[1][p]); out[o + 2] = cl255(P[2][p]); out[o + 3] = 255; }
  return out;
}

/* ------------------------------------------------------------------ */
/* sRGB transfer helpers                                                */
/* ------------------------------------------------------------------ */

const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
// sRGB value (0..255, may be fractional) -> linear 0..1
function linOf(v) {
  if ((v | 0) === v && v >= 0 && v <= 255) return LIN[v];
  const c = v <= 0 ? 0 : v >= 255 ? 1 : v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function enc(v) { v = v < 0 ? 0 : v > 1 ? 1 : v; return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; }
/* ------------------------------------------------------------------ */
/* 5. Upscale -> downscale roundtrip                                    */
/* ------------------------------------------------------------------ */
/* Separable: each axis is upscaled, optionally stored at 8-bit, then
   downscaled. Because the per-axis filters commute, this matches a full
   2D upscale/downscale without holding the (up to 36x) enlarged image. */

function sinc(x) { if (x === 0) return 1; const p = Math.PI * x; return Math.sin(p) / p; }
const KERNELS = {
  nearest: { r: 0.5, f: x => (x >= -0.5 && x < 0.5 ? 1 : 0) },
  box: { r: 0.5, f: x => (x >= -0.5 && x < 0.5 ? 1 : 0) },
  bilinear: { r: 1, f: x => { x = Math.abs(x); return x < 1 ? 1 - x : 0; } },
  bicubic: { r: 2, f: x => { // Catmull-Rom
    x = Math.abs(x);
    if (x < 1) return 1.5 * x * x * x - 2.5 * x * x + 1;
    if (x < 2) return -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2;
    return 0;
  } },
  mitchell: { r: 2, f: x => { // B = C = 1/3
    x = Math.abs(x); const B = 1 / 3, C = 1 / 3;
    if (x < 1) return ((12 - 9 * B - 6 * C) * x * x * x + (-18 + 12 * B + 6 * C) * x * x + (6 - 2 * B)) / 6;
    if (x < 2) return ((-B - 6 * C) * x * x * x + (6 * B + 30 * C) * x * x + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
    return 0;
  } },
  lanczos3: { r: 3, f: x => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0) },
};

function contribs(n, m, kernel) {
  const K = KERNELS[kernel] || KERNELS.bicubic;
  const scale = m / n;
  const fs = scale < 1 ? 1 / scale : 1;
  const support = K.r * fs;
  const taps = Math.ceil(support * 2) + 2;
  const start = new Int32Array(m), cnt = new Int32Array(m), wt = new Float32Array(m * taps);
  for (let i = 0; i < m; i++) {
    const center = (i + 0.5) / scale;
    if (kernel === 'nearest') {
      const j = Math.min(n - 1, Math.max(0, Math.floor(center)));
      start[i] = j; cnt[i] = 1; wt[i * taps] = 1; continue;
    }
    const lo = Math.max(0, Math.floor(center - support)), hi = Math.min(n - 1, Math.ceil(center + support));
    let sum = 0;
    for (let j = lo; j <= hi; j++) { const v = K.f((j + 0.5 - center) / fs); wt[i * taps + (j - lo)] = v; sum += v; }
    start[i] = lo; cnt[i] = hi - lo + 1;
    if (Math.abs(sum) < 1e-9) {
      const j = Math.min(n - 1, Math.max(0, Math.floor(center)));
      wt.fill(0, i * taps, i * taps + taps); start[i] = j; cnt[i] = 1; wt[i * taps] = 1;
    } else for (let k = 0; k < cnt[i]; k++) wt[i * taps + k] /= sum;
  }
  return { m, taps, start, cnt, wt };
}

// line: Float32 (n*3 interleaved) -> out Float32 (m*3)
function apply1d(line, out, C) {
  const { m, taps, start, cnt, wt } = C;
  for (let i = 0; i < m; i++) {
    let r = 0, g = 0, b = 0, p = start[i] * 3;
    const wo = i * taps, c = cnt[i];
    for (let k = 0; k < c; k++, p += 3) { const w = wt[wo + k]; r += line[p] * w; g += line[p + 1] * w; b += line[p + 2] * w; }
    out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
  }
}

function quant8(a) { for (let i = 0; i < a.length; i++) { let v = Math.round(a[i]); a[i] = v < 0 ? 0 : v > 255 ? 255 : v; } }

// Resize by pixel replacement: every output pixel is a copy of one original pixel picked at random
// from the area it covers. No averaging, so no blur, halos or new colour values.
function replaceResize(d, w, h, fw, fh) {
  const out = new Float32Array(fw * fh * 4), sx = w / fw, sy = h / fh;
  for (let j = 0; j < fh; j++) {
    for (let i = 0; i < fw; i++) {
      let x = Math.floor((i + hash2(i, j, 31337)) * sx), y = Math.floor((j + hash2(j, i, 4241)) * sy);
      x = x < 0 ? 0 : x > w - 1 ? w - 1 : x; y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
      const s = (y * w + x) * 4, o = (j * fw + i) * 4;
      out[o] = d[s]; out[o + 1] = d[s + 1]; out[o + 2] = d[s + 2]; out[o + 3] = 255;
    }
  }
  return { data: out, w: fw, h: fh };
}

function rescale(d, w, h, S, id) {
  S = S || {};
  const up = Math.max(1, +S.up || 1);
  const fin = Math.max(0.0001, (+S.final || 100) / 100);
  const fw = Math.max(1, Math.round(w * fin)), fh = Math.max(1, Math.round(h * fin));
  if (up === 1 && fw === w && fh === h) return { data: d, w, h };
  if (S.downMethod === 'replace') return replaceResize(d, w, h, fw, fh);
  const uw = Math.max(1, Math.round(w * up)), uh = Math.max(1, Math.round(h * up));
  const q = S.quant !== false;
  const cHu = contribs(w, uw, S.upMethod), cHd = contribs(uw, fw, S.downMethod);
  const cVu = contribs(h, uh, S.upMethod), cVd = contribs(uh, fh, S.downMethod);

  let last = 0;
  const tick = (f) => { const t = performance.now(); if (t - last > 80) { last = t; progress(id, `Upscale ×${up} → downscale`, f); } };

  // horizontal pass: (w x h) -> (fw x h)
  const mid = new Float32Array(fw * h * 3);
  const line = new Float32Array(w * 3), upL = new Float32Array(uw * 3), dn = new Float32Array(fw * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0, p = y * w * 4; x < w; x++, p += 4) { line[x * 3] = d[p]; line[x * 3 + 1] = d[p + 1]; line[x * 3 + 2] = d[p + 2]; }
    apply1d(line, upL, cHu);
    if (q) quant8(upL);
    apply1d(upL, dn, cHd);
    mid.set(dn, y * fw * 3);
    if ((y & 31) === 0) tick(0.5 * y / h);
  }

  // vertical pass: (fw x h) -> (fw x fh)
  const out = new Float32Array(fw * fh * 4);
  const col = new Float32Array(h * 3), upC = new Float32Array(uh * 3), dc = new Float32Array(fh * 3);
  for (let x = 0; x < fw; x++) {
    for (let y = 0; y < h; y++) { const s = (y * fw + x) * 3; col[y * 3] = mid[s]; col[y * 3 + 1] = mid[s + 1]; col[y * 3 + 2] = mid[s + 2]; }
    apply1d(col, upC, cVu);
    if (q) quant8(upC);
    apply1d(upC, dc, cVd);
    for (let y = 0; y < fh; y++) { const o = (y * fw + x) * 4; out[o] = cl255(dc[y * 3]); out[o + 1] = cl255(dc[y * 3 + 1]); out[o + 2] = cl255(dc[y * 3 + 2]); out[o + 3] = 255; }
    if ((x & 31) === 0) tick(0.5 + 0.5 * x / fw);
  }
  return { data: out, w: fw, h: fh };
}

/* ------------------------------------------------------------------ */
/* Random helpers                                                       */
/* ------------------------------------------------------------------ */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/* ------------------------------------------------------------------ */
/* 0. Clean-up: deblock, periodic-pattern removal, deband               */
/* ------------------------------------------------------------------ */

function cleanActive(C) {
  return !!(C && C.on !== false && ((C.deblock && C.deblock.on) || (C.pattern && C.pattern.on) || (C.deband && C.deband.on)));
}

function cleanup(d, w, h, C, id) {
  if (C.deblock && C.deblock.on) { progress(id, 'Deblocking', 0.1); deblock(d, w, h, C.deblock); }
  if (C.pattern && C.pattern.on) depattern(d, w, h, C.pattern, id);
  if (C.deband && C.deband.on) { progress(id, 'Debanding', 0.9); deband(d, w, h, C.deband); }
  return d;
}

// JPEG 8x8 block-edge smoothing (H.264-style, only where the edge is a small step on flat sides)
function deblock(d, w, h, B) {
  const s = Math.min(1, Math.max(0, (+B.strength || 0) / 100));
  const thr = Math.max(0.1, +B.threshold || 6);
  const beta = thr * 0.5 + 0.5;
  const L = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const f = new Float32Array(8 * 3);
  // q0 = first pixel after the block boundary, st = stride between pixels across the edge
  const edge = (q0i, st) => {
    const lp0 = L(q0i - st), lq0 = L(q0i);
    const step = Math.abs(lp0 - lq0);
    if (step === 0 || step >= thr) return;
    let flat = true, weakOk = true;
    for (let k = 1; k < 4; k++) {
      const dp = Math.abs(L(q0i - (k + 1) * st) - lp0), dq = Math.abs(L(q0i + k * st) - lq0);
      if (dp >= beta || dq >= beta) { flat = false; if (k === 1) weakOk = false; }
    }
    if (!weakOk) return;
    for (let c = 0; c < 3; c++) {
      if (flat) {
        // spread the step as an even ramp across both half-blocks
        const dlt = (d[q0i + c] - d[q0i - st + c]) * s / 9;
        for (let k = 0; k < 4; k++) {
          d[q0i - (k + 1) * st + c] += dlt * (4 - k);
          d[q0i + k * st + c] -= dlt * (4 - k);
        }
      } else {
        const p1 = d[q0i - 2 * st + c], p0 = d[q0i - st + c], q0 = d[q0i + c], q1 = d[q0i + st + c];
        let delta = ((q0 - p0) * 4 + (p1 - q1)) / 8;
        if (delta > thr) delta = thr; else if (delta < -thr) delta = -thr;
        delta *= s;
        d[q0i - st + c] = p0 + delta; d[q0i + c] = q0 - delta;
        d[q0i - 2 * st + c] = p1 + delta / 2; d[q0i + st + c] = q1 - delta / 2;
      }
    }
  };
  for (let y = 0; y < h; y++) for (let x = 8; x + 3 < w; x += 8) edge((y * w + x) * 4, 4);
  for (let y = 8; y + 3 < h; y += 8) for (let x = 0; x < w; x++) edge((y * w + x) * 4, w * 4);
}

// Gradient debanding (flash3kyuu-style): replace pixels in flat areas with the mean of 4 random
// neighbours at distance <= radius, then re-quantise with triangular dither so bands don't return.
function deband(d, w, h, D) {
  const R = Math.max(1, +D.radius || 16);
  const thr = Math.max(0.05, +D.threshold || 3);
  const grain = Math.max(0, +D.grain || 0);
  const passes = Math.max(1, Math.min(4, Math.round(+D.passes || 1)));
  const rnd = mulberry32(0x2545F491);
  const cx = (v) => (v < 0 ? 0 : v >= w ? w - 1 : v), cy = (v) => (v < 0 ? 0 : v >= h ? h - 1 : v);
  for (let pass = 0; pass < passes; pass++) {
    const src = d.slice();
    const rad = Math.max(1, R / (pass + 1));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = rnd() * 6.283185307, dist = 1 + rnd() * (rad - 1);
        const dx = Math.round(Math.cos(a) * dist), dy = Math.round(Math.sin(a) * dist);
        const i = (y * w + x) * 4;
        const s0 = (cy(y + dy) * w + cx(x + dx)) * 4, s1 = (cy(y - dy) * w + cx(x - dx)) * 4;
        const s2 = (cy(y + dx) * w + cx(x - dy)) * 4, s3 = (cy(y - dx) * w + cx(x + dy)) * 4;
        let ok = true;
        for (let c = 0; c < 3 && ok; c++) {
          const p = src[i + c];
          if (Math.abs(src[s0 + c] - p) > thr || Math.abs(src[s1 + c] - p) > thr ||
              Math.abs(src[s2 + c] - p) > thr || Math.abs(src[s3 + c] - p) > thr) ok = false;
        }
        const n1 = rnd(), n2 = rnd();
        if (!ok) continue;
        const dt = (n1 - n2) * grain;
        for (let c = 0; c < 3; c++) {
          const m = (src[s0 + c] + src[s1 + c] + src[s2 + c] + src[s3 + c]) / 4;
          d[i + c] = cl255(m + dt + (rnd() - 0.5) * 0.5);
        }
      }
    }
  }
}

// --- FFT ---
const FFTP = {};
function fftPlan(n) {
  if (FFTP[n]) return FFTP[n];
  const bits = Math.log2(n), rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cs = new Float64Array(n / 2), sn = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) { cs[k] = Math.cos(2 * Math.PI * k / n); sn[k] = Math.sin(2 * Math.PI * k / n); }
  return (FFTP[n] = { rev, cs, sn });
}
function fft1(re, im, n, inv, P) {
  const { rev, cs, sn } = P;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half, c = cs[k], s = inv ? -sn[k] : sn[k];
        const tr = re[b] * c + im[b] * s, ti = im[b] * c - re[b] * s;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}
function fft2(re, im, T, inv, P, cr, ci) {
  for (let r = 0; r < T; r++) fft1(re.subarray(r * T, r * T + T), im.subarray(r * T, r * T + T), T, inv, P);
  for (let c = 0; c < T; c++) {
    for (let r = 0; r < T; r++) { cr[r] = re[r * T + c]; ci[r] = im[r * T + c]; }
    fft1(cr, ci, T, inv, P);
    for (let r = 0; r < T; r++) { re[r * T + c] = cr[r]; im[r * T + c] = ci[r]; }
  }
}

// Periodic-pattern suppression: overlapped windowed tiles, find spectral peaks that stand out from
// their neighbourhood (moiré, halftone dots, screen grids, scan lines, JPEG grid) and pull them down.
function depattern(d, w, h, Q, id) {
  const T = [128, 256, 512].includes(+Q.tile) ? +Q.tile : 256;
  const sens = Math.log(Math.max(1.05, +Q.sensitivity || 4));
  const str = Math.min(1, Math.max(0, (Q.strength == null ? 100 : +Q.strength) / 100));
  const prot = Math.max(0, (+Q.protect || 0) / 100) * (T / 2);
  const P = fftPlan(T), hop = T / 2, N = T * T;
  const win = new Float64Array(T);
  for (let i = 0; i < T; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / T));
  const out = new Float32Array(w * h * 3);
  const r1 = new Float64Array(N), i1 = new Float64Array(N), r2 = new Float64Array(N), i2 = new Float64Array(N);
  const Lg = new Float64Array(N), tmp = new Float64Array(N), Bg = new Float64Array(N), fac = new Float64Array(N);
  const cr = new Float64Array(T), ci = new Float64Array(T);
  const K = 4; // background box radius in bins
  const freq = (u) => (u <= T / 2 ? u : u - T);
  const protMask = new Uint8Array(N);
  for (let v = 0; v < T; v++) for (let u = 0; u < T; u++) {
    const fu = freq(u), fv = freq(v);
    protMask[v * T + u] = fu * fu + fv * fv <= prot * prot || (Math.abs(fu) <= 1 && Math.abs(fv) <= 1) ? 1 : 0;
  }
  const tilesX = Math.ceil((w + hop) / hop), tilesY = Math.ceil((h + hop) / hop);
  let done = 0, last = 0;
  for (let ty = -hop; ty < h; ty += hop) {
    for (let tx = -hop; tx < w; tx += hop) {
      for (let y = 0; y < T; y++) {
        const sy = Math.min(h - 1, Math.max(0, ty + y)), wy = win[y];
        for (let x = 0; x < T; x++) {
          const sx = Math.min(w - 1, Math.max(0, tx + x)), wv = wy * win[x], si = (sy * w + sx) * 4, o = y * T + x;
          const R = d[si], G = d[si + 1], Bb = d[si + 2];
          r1[o] = R * wv; i1[o] = G * wv; r2[o] = Bb * wv; i2[o] = (0.299 * R + 0.587 * G + 0.114 * Bb) * wv;
        }
      }
      fft2(r1, i1, T, false, P, cr, ci);
      fft2(r2, i2, T, false, P, cr, ci);
      // |Y| from packed B + iY spectrum
      for (let v = 0; v < T; v++) {
        const mv = ((T - v) % T) * T;
        for (let u = 0; u < T; u++) {
          const k = v * T + u, mk = mv + ((T - u) % T);
          const yr = (i2[k] + i2[mk]) * 0.5, yi = (r2[mk] - r2[k]) * 0.5;
          Lg[k] = Math.log(Math.sqrt(yr * yr + yi * yi) + 1e-6);
        }
      }
      // background = wrapped box blur of log-magnitude
      for (let v = 0; v < T; v++) {
        const row = v * T;
        let s = 0;
        for (let k = -K; k <= K; k++) s += Lg[row + ((k + T) % T)];
        for (let u = 0; u < T; u++) {
          tmp[row + u] = s;
          s += Lg[row + ((u + K + 1) % T)] - Lg[row + ((u - K + T) % T)];
        }
      }
      for (let u = 0; u < T; u++) {
        let s = 0;
        for (let k = -K; k <= K; k++) s += tmp[((k + T) % T) * T + u];
        for (let v = 0; v < T; v++) {
          Bg[v * T + u] = s / ((2 * K + 1) * (2 * K + 1));
          s += tmp[((v + K + 1) % T) * T + u] - tmp[((v - K + T) % T) * T + u];
        }
      }
      let any = false;
      for (let k = 0; k < N; k++) {
        const ex = Lg[k] - Bg[k];
        if (protMask[k] || ex <= sens) fac[k] = 1;
        else { fac[k] = Math.exp(-(ex - sens * 0.5) * str); any = true; }
      }
      if (any) {
        for (let k = 0; k < N; k++) { const f = fac[k]; r1[k] *= f; i1[k] *= f; r2[k] *= f; i2[k] *= f; }
      }
      fft2(r1, i1, T, true, P, cr, ci);
      fft2(r2, i2, T, true, P, cr, ci);
      const sc = 1 / N;
      for (let y = 0; y < T; y++) {
        const sy = ty + y;
        if (sy < 0 || sy >= h) continue;
        const wy = win[y];
        for (let x = 0; x < T; x++) {
          const sx = tx + x;
          if (sx < 0 || sx >= w) continue;
          const wv = wy * win[x] * sc, o = y * T + x, p = (sy * w + sx) * 3;
          out[p] += r1[o] * wv; out[p + 1] += i1[o] * wv; out[p + 2] += r2[o] * wv;
        }
      }
      done++;
      const t = performance.now();
      if (t - last > 100) { last = t; progress(id, 'Removing patterns', done / (tilesX * tilesY)); }
    }
  }
  for (let p = 0, i = 0; p < w * h; p++, i += 4) { d[i] = cl255(out[p * 3]); d[i + 1] = cl255(out[p * 3 + 1]); d[i + 2] = cl255(out[p * 3 + 2]); }
}

/* ------------------------------------------------------------------ */
/* Camera grain: noise sent through a camera pipeline                   */
/* ------------------------------------------------------------------ */
/*
 * The image's own pixels are never re-sampled; only the noise goes through the pipeline:
 *   1. per-photosite noise on a virtual Bayer mosaic, in linear light:
 *        shot noise  ∝ sqrt(signal)   (photon noise)
 *        read noise  = constant floor (electronics) — after the sRGB curve this is what makes grain
 *                      accumulate in the shadows, as on a real sensor;
 *   2. edge-directed demosaic of that noise, steered by the clean image's own edges, so each
 *      photosite's noise spreads into its neighbours along structures;
 *   3. sRGB transfer (strongest in shadows);
 *   4. in-camera luma NR + sharpening (grain lands at mid frequencies) and chroma NR that leaves
 *      soft low-frequency colour blotches.
 * Simple controls: amount (overall), shadows (read-noise floor), colour (colour-noise share).
 */
function sensorSim(d, w, h, S, id) {
  if (!S || !S.on) return;
  const amount = Math.max(0, S.amount == null ? 1 : +S.amount);
  const shot = Math.max(0, +S.shot || 0) * amount;
  const read = Math.max(0, +S.read || 0) * amount * Math.max(0, S.shadows == null ? 1 : +S.shadows);
  const colour = Math.max(0, S.colour == null ? 1 : +S.colour);
  if (!(shot > 0 || read > 0)) return;
  if (id != null) progress(id, 'Grain', 0.88);
  encLut();
  const N = w * h;
  const P = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  const L8 = new Float32Array(256); for (let v = 0; v < 256; v++) L8[v] = LIN[v] * 255;
  const lin = (v) => ((v | 0) === v && v >= 0 && v <= 255 ? L8[v] : linOf(v) * 255);
  { const A0 = P[0], A1 = P[1], A2 = P[2]; for (let p = 0, i = 0; p < N; p++, i += 4) { A0[p] = lin(d[i]); A1[p] = lin(d[i + 1]); A2[p] = lin(d[i + 2]); } }
  const EL = ENC_LUT, K = 65536 / 255;
  const E = (v) => { const t = v * K; if (!(t > 0)) return 0; if (t >= 65536) return 255; const i = t | 0; return EL[i] + (EL[i + 1] - EL[i]) * (t - i); };
  const Cg = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  for (let c = 0; c < 3; c++) { const A = P[c], B = Cg[c]; for (let p = 0; p < N; p++) B[p] = E(A[p]); }

  const cfa = cfaOf('RGGB');
  const Mc = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    const r = y * w, cA = P[cfa[(y & 1) << 1]], cB = P[cfa[((y & 1) << 1) | 1]];
    for (let x = 0; x < w; x += 2) { Mc[r + x] = cA[r + x]; if (x + 1 < w) Mc[r + x + 1] = cB[r + x + 1]; }
  }

  // 1. photosite noise (red and blue sites get less light -> more noise)
  const gainB = [1 + (S.rgain == null ? 30 : +S.rgain) / 100, 1, 1 + (S.bgain == null ? 50 : +S.bgain) / 100];
  const rnd = mulberry32(((Math.round(+S.seed || 1) * 2654435761) ^ 0x9e3779b9) >>> 0);
  let spare = null;
  const gauss = () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = rnd(); if (u < 1e-12) u = 1e-12;
    const v = rnd(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(6.283185307179586 * v);
    return r * Math.cos(6.283185307179586 * v);
  };
  const Nm = new Float32Array(N), s2 = shot * shot, r2 = read * read;
  for (let y = 0; y < h; y++) {
    const gA = gainB[cfa[(y & 1) << 1]], gB = gainB[cfa[((y & 1) << 1) | 1]];
    for (let x = 0; x < w; x++) {
      const p = y * w + x, v = Mc[p], g = (x & 1) ? gB : gA;
      Nm[p] = gauss() * Math.sqrt(s2 * g * (v > 0 ? v : 0) + r2 * g * g);
    }
  }

  // 2 + 3. edge-directed demosaic of the noise, then into sRGB
  if (id != null) progress(id, 'Grain: demosaic', 0.91);
  const guide = new Float32Array(N); for (let p = 0; p < N; p++) guide[p] = E(Mc[p]);
  const nG = demosaicMosaic(Nm, w, h, cfa, 'edge', guide);
  for (let c = 0; c < 3; c++) { const A = P[c], Rn = nG[c], B = Cg[c]; for (let p = 0; p < N; p++) Rn[p] = E(A[p] + Rn[p]) - B[p]; P[c] = null; }

  // 4. in-camera processing of the noise (in place: nG[0] -> Cr, nG[1] -> Y, nG[2] -> Cb)
  if (id != null) progress(id, 'Grain: in-camera processing', 0.95);
  const Cr = nG[0], Yn = nG[1], Cb = nG[2];
  for (let p = 0; p < N; p++) { const r = Cr[p], g = Yn[p], b = Cb[p], yy = 0.299 * r + 0.587 * g + 0.114 * b; Yn[p] = yy; Cb[p] = b - yy; Cr[p] = r - yy; }
  const lnr = Math.min(1, Math.max(0, (S.lumaNR == null ? 70 : +S.lumaNR) / 100));
  if (lnr > 0) { const B = blurPlane(Yn, w, h, 0.5 + 0.7 * lnr); for (let p = 0; p < N; p++) Yn[p] += (B[p] - Yn[p]) * lnr; }
  const sh = S.sharpen == null ? 1 : +S.sharpen;
  if (sh > 0) { const B = blurPlane(Yn, w, h, Math.max(0.3, +S.sharpenR || 1.6)); for (let p = 0; p < N; p++) Yn[p] += sh * (Yn[p] - B[p]); }
  const cnr = Math.min(1, Math.max(0, (S.chromaNR == null ? 90 : +S.chromaNR) / 100)), bl = Math.max(0, S.blotch == null ? 2 : +S.blotch);
  const bs = Math.max(0.5, +S.blotchSize || 3);
  const Bb = blurPlane(Cb, w, h, bs), Br = blurPlane(Cr, w, h, bs);
  for (let p = 0; p < N; p++) { Cb[p] = colour * ((1 - cnr) * Cb[p] + bl * Bb[p]); Cr[p] = colour * ((1 - cnr) * Cr[p] + bl * Br[p]); }

  { const C0 = Cg[0], C1 = Cg[1], C2 = Cg[2];
    for (let p = 0, i = 0; p < N; p++, i += 4) {
      const yy = Yn[p], r = yy + Cr[p], b = yy + Cb[p], g = (yy - 0.299 * r - 0.114 * b) / 0.587;
      d[i] = C0[p] + r; d[i + 1] = C1[p] + g; d[i + 2] = C2[p] + b; d[i + 3] = 255;
    } }
}

/* ------------------------------------------------------------------ */
/* JPEG encoder (baseline, optimized Huffman)                           */
/* ------------------------------------------------------------------ */
/* Options: quality 1-100, sub '444' | '422' | '420', hf 0-100 (flatten the quant tables toward
   high frequencies so fine grain is kept), dither 0-100 (stochastic rounding of AC coefficients:
   small coefficients survive in proportion to their size instead of all rounding to zero). */
const ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const QL = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];

function quantTable(base, quality, hf) {
  const q = Math.min(100, Math.max(1, quality));
  const sc = q < 50 ? 5000 / q : 200 - 2 * q;
  const t = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    let v = Math.floor((base[i] * sc + 50) / 100);
    const u = i & 7, vv = i >> 3, wgt = Math.min(1, (u + vv) / 7);
    v = Math.round(v * (1 - hf * wgt));
    t[i] = Math.min(255, Math.max(1, v));
  }
  return t;
}

const DCT_T = (() => {
  const T = new Float64Array(64);
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) T[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) / 2 * Math.cos((2 * x + 1) * u * Math.PI / 16);
  return T;
})();
function fdct(blk, out, tmp) {
  for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) {
    let s = 0; for (let x = 0; x < 8; x++) s += DCT_T[u * 8 + x] * blk[y * 8 + x];
    tmp[y * 8 + u] = s;
  }
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
    let s = 0; for (let y = 0; y < 8; y++) s += DCT_T[v * 8 + y] * tmp[y * 8 + u];
    out[v * 8 + u] = s;
  }
}

function huffTable(freq) {
  // JPEG Annex K.2 length-limited Huffman code (as libjpeg's jpeg_gen_optimal_table)
  const f = freq.slice(); f[256] = 1;
  const codesize = new Int32Array(257), others = new Int32Array(257).fill(-1);
  for (;;) {
    let c1 = -1, c2 = -1, v = 1e18;
    for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v) { v = f[i]; c1 = i; }
    v = 1e18;
    for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v && i !== c1) { v = f[i]; c2 = i; }
    if (c2 < 0) break;
    f[c1] += f[c2]; f[c2] = 0;
    codesize[c1]++;
    while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
    others[c1] = c2;
    codesize[c2]++;
    while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
  }
  const bits = new Int32Array(33);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
  for (let i = 32; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2; while (bits[j] === 0) j--;
      bits[i] -= 2; bits[i - 1]++; bits[j + 1] += 2; bits[j]--;
    }
  }
  let i = 16; while (bits[i] === 0) i--; bits[i]--;
  const vals = [];
  for (let len = 1; len <= 32; len++) for (let s = 0; s < 256; s++) if (codesize[s] === len) vals.push(s);
  // canonical codes
  const code = new Int32Array(256), size = new Int32Array(256);
  let c = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let n = 0; n < bits[len]; n++) { code[vals[k]] = c; size[vals[k]] = len; c++; k++; }
    c <<= 1;
  }
  return { bits: Array.from(bits.subarray(1, 17)), vals, code, size };
}

function bitLen(v) { v = v < 0 ? -v : v; let n = 0; while (v) { n++; v >>= 1; } return n; }

function encodeJPEG(rgba, w, h, opts) {
  const quality = +opts.quality || 92, sub = opts.sub || '444';
  const hf = Math.min(0.95, Math.max(0, (+opts.hf || 0) / 100)), dith = Math.min(1, Math.max(0, (+opts.dither || 0) / 100));
  const qY = quantTable(QL, quality, hf), qC = quantTable(QC, quality, hf);
  const H = sub === '444' ? 1 : 2, V = sub === '420' ? 2 : 1;
  const N = w * h;
  const Yp = new Float32Array(N), Cbp = new Float32Array(N), Crp = new Float32Array(N);
  for (let p = 0, i = 0; p < N; p++, i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    Yp[p] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
    Cbp[p] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    Crp[p] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  let cw = w, ch = h, Cb = Cbp, Cr = Crp;
  if (H > 1 || V > 1) {
    cw = Math.ceil(w / H); ch = Math.ceil(h / V);
    Cb = new Float32Array(cw * ch); Cr = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      let sb = 0, sr = 0, n = 0;
      for (let dy = 0; dy < V; dy++) for (let dx = 0; dx < H; dx++) {
        const sx = Math.min(w - 1, x * H + dx), sy = Math.min(h - 1, y * V + dy), p = sy * w + sx;
        sb += Cbp[p]; sr += Crp[p]; n++;
      }
      Cb[y * cw + x] = sb / n; Cr[y * cw + x] = sr / n;
    }
  }
  const mcuX = Math.ceil(w / (8 * H)), mcuY = Math.ceil(h / (8 * V));
  const perMcu = H * V + 2, nBlocks = mcuX * mcuY * perMcu;
  const coef = new Int16Array(nBlocks * 64);
  const rnd = mulberry32(0x51f15e);
  const blk = new Float64Array(64), F = new Float64Array(64), tmp = new Float64Array(64);
  const take = (plane, pw, ph, bx, by) => {
    for (let y = 0; y < 8; y++) {
      const sy = Math.min(ph - 1, by + y);
      for (let x = 0; x < 8; x++) blk[y * 8 + x] = plane[sy * pw + Math.min(pw - 1, bx + x)];
    }
  };
  const quant = (q, o) => {
    fdct(blk, F, tmp);
    for (let k = 0; k < 64; k++) {
      const n = ZZ[k], c = F[n] / q[n];
      let v;
      if (k === 0 || dith === 0) v = Math.round(c);
      else v = Math.floor(c + 0.5 + dith * (rnd() - 0.5));
      const lim = k === 0 ? 2047 : 1023;
      coef[o + k] = v > lim ? lim : v < -lim ? -lim : v;
    }
  };
  let o = 0;
  for (let my = 0; my < mcuY; my++) for (let mx = 0; mx < mcuX; mx++) {
    for (let v = 0; v < V; v++) for (let hh = 0; hh < H; hh++) {
      take(Yp, w, h, (mx * H + hh) * 8, (my * V + v) * 8); quant(qY, o); o += 64;
    }
    take(Cb, cw, ch, mx * 8, my * 8); quant(qC, o); o += 64;
    take(Cr, cw, ch, mx * 8, my * 8); quant(qC, o); o += 64;
  }
  // block -> component index
  const compOf = (b) => { const r = b % perMcu; return r < H * V ? 0 : r === H * V ? 1 : 2; };

  // pass 1: symbol statistics
  const fDC = [new Float64Array(257), new Float64Array(257)], fAC = [new Float64Array(257), new Float64Array(257)];
  const walk = (emitDC, emitAC) => {
    const pred = [0, 0, 0];
    for (let b = 0; b < nBlocks; b++) {
      const c = compOf(b), t = c === 0 ? 0 : 1, base = b * 64;
      const diff = coef[base] - pred[c]; pred[c] = coef[base];
      emitDC(t, diff);
      let run = 0;
      for (let k = 1; k < 64; k++) {
        const v = coef[base + k];
        if (v === 0) { run++; continue; }
        while (run > 15) { emitAC(t, 0xF0, 0); run -= 16; }
        emitAC(t, (run << 4) | bitLen(v), v); run = 0;
      }
      if (run > 0) emitAC(t, 0x00, 0);
    }
  };
  walk((t, diff) => { fDC[t][bitLen(diff)]++; }, (t, sym) => { fAC[t][sym]++; });
  const hDC = [huffTable(fDC[0]), huffTable(fDC[1])], hAC = [huffTable(fAC[0]), huffTable(fAC[1])];

  // output buffer
  let buf = new Uint8Array(Math.max(1 << 16, N)), len = 0;
  const byte = (v) => { if (len >= buf.length) { const nb = new Uint8Array(buf.length * 2); nb.set(buf); buf = nb; } buf[len++] = v; };
  const word = (v) => { byte((v >> 8) & 255); byte(v & 255); };
  // headers
  word(0xFFD8);
  word(0xFFE0); word(16); [0x4A, 0x46, 0x49, 0x46, 0].forEach(byte); byte(1); byte(1); byte(0); word(1); word(1); byte(0); byte(0);
  word(0xFFDB); word(2 + 65 * 2);
  byte(0); for (let k = 0; k < 64; k++) byte(qY[ZZ[k]]);
  byte(1); for (let k = 0; k < 64; k++) byte(qC[ZZ[k]]);
  word(0xFFC0); word(17); byte(8); word(h); word(w); byte(3);
  byte(1); byte((H << 4) | V); byte(0);
  byte(2); byte(0x11); byte(1);
  byte(3); byte(0x11); byte(1);
  const tabs = [[0x00, hDC[0]], [0x10, hAC[0]], [0x01, hDC[1]], [0x11, hAC[1]]];
  word(0xFFC4); word(2 + tabs.reduce((a, [, t]) => a + 17 + t.vals.length, 0));
  for (const [cls, t] of tabs) { byte(cls); t.bits.forEach(byte); t.vals.forEach(byte); }
  word(0xFFDA); word(12); byte(3); byte(1); byte(0x00); byte(2); byte(0x11); byte(3); byte(0x11); byte(0); byte(63); byte(0);
  // entropy-coded data
  let acc = 0, nb = 0;
  const put = (code, size) => {
    acc = (acc << size) | (code & ((1 << size) - 1)); nb += size;
    while (nb >= 8) {
      const b = (acc >> (nb - 8)) & 255; byte(b); if (b === 255) byte(0);
      nb -= 8; acc &= (1 << nb) - 1;
    }
  };
  const putVal = (v, s) => { if (s) put(v < 0 ? v + (1 << s) - 1 : v, s); };
  walk((t, diff) => { const s = bitLen(diff); put(hDC[t].code[s], hDC[t].size[s]); putVal(diff, s); },
       (t, sym, v) => { put(hAC[t].code[sym], hAC[t].size[sym]); putVal(v, sym & 15); });
  if (nb > 0) put((1 << (8 - nb)) - 1, 8 - nb);
  word(0xFFD9);
  return buf.slice(0, len);
}

// Expose for headless testing
if (typeof module !== 'undefined') module.exports = { encodeJPEG, sensorSim, demosaicMosaic, cfaOf, blurPlane, spectralBands, carve, resample, autoZoom, rescale, cleanup, deband, deblock, depattern, quantize };
