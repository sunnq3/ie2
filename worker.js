'use strict';
/*
 * ie2 processing worker
 * Pipeline: seam carving -> lens distortion + chromatic aberration (single resample) -> colour-space roundtrip
 */

let SRC = null;   // { w, h, data: Uint8ClampedArray RGBA }
let CACHE = null; // { key, w, h, data, mask }

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    SRC = { w: m.w, h: m.h, data: new Uint8ClampedArray(m.buffer) };
    CACHE = null;
  } else if (m.type === 'process') {
    try { runJob(m.id, m.params); }
    catch (err) { self.postMessage({ type: 'error', id: m.id, message: (err && err.message) || String(err) }); }
  }
};

function progress(id, label, frac) { self.postMessage({ type: 'progress', id, label, frac }); }

function carveKey(C) { return `${Math.round(+C.dw || 0)}|${Math.round(+C.dh || 0)}|${C.energy}`; }

function runJob(id, P) {
  if (!SRC) throw new Error('No image loaded');
  const t0 = performance.now();
  const key = carveKey(P.carve);
  let recarved = false;
  if (!CACHE || CACHE.key !== key) {
    CACHE = carve(SRC, P.carve, id);
    CACHE.key = key;
    recarved = true;
  }
  const { w, h } = CACHE;
  progress(id, 'Resampling', 0.5);
  const out = resample(CACHE.data, w, h, P.lens, P.ca);
  colorRoundtrip(out, w, h, P.color, id);
  const msg = { type: 'result', id, w, h, buffer: out.buffer, ms: performance.now() - t0, carveKey: key };
  const transfer = [out.buffer];
  if (recarved) { const mk = CACHE.mask.slice(); msg.mask = mk.buffer; transfer.push(mk.buffer); }
  self.postMessage(msg, transfer);
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

  let pix = new Uint32Array(src.data.slice().buffer);
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

function resample(data, w, h, L, A) {
  L = L || {}; A = A || {};
  const k1 = +L.k1 || 0, k2 = +L.k2 || 0;
  const userZoom = +L.zoom || 1;
  const cx = w * (0.5 + (+L.cx || 0) / 100), cy = h * (0.5 + (+L.cy || 0) / 100);
  const sh = [[+A.rx || 0, +A.ry || 0], [+A.gx || 0, +A.gy || 0], [+A.bx || 0, +A.by || 0]];
  const sc = [1 + (+A.rs || 0) / 100, 1 + (+A.gs || 0) / 100, 1 + (+A.bs || 0) / 100];
  const lensOn = k1 !== 0 || k2 !== 0;
  const caOn = sh.some(s => s[0] !== 0 || s[1] !== 0) || sc.some(s => s !== 1);
  let z = userZoom;
  if (lensOn && L.autofill) z *= autoZoom(w, h, cx, cy, k1, k2);
  if (!lensOn && !caOn && z === 1) return data.slice();

  const sample = L.interp === 'bilinear' ? bil : bic;
  const out = new Uint8ClampedArray(w * h * 4);
  const R = Math.sqrt(w * w + h * h) / 2, invR = 1 / R, iz = 1 / z;
  const i0 = 1 / sc[0], i1 = 1 / sc[1], i2 = 1 / sc[2];
  for (let y = 0; y < h; y++) {
    const py = y + 0.5 - cy;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - cx;
      let dx = px, dy = py;
      if (lensOn) {
        const nx = px * invR, ny = py * invR, r2 = nx * nx + ny * ny;
        const f = 1 + k1 * r2 + k2 * r2 * r2;
        dx *= f; dy *= f;
      }
      dx *= iz; dy *= iz;
      const o = (y * w + x) * 4;
      out[o]     = sample(data, w, h, cx + dx * i0 - sh[0][0] - 0.5, cy + dy * i0 - sh[0][1] - 0.5, 0);
      out[o + 1] = sample(data, w, h, cx + dx * i1 - sh[1][0] - 0.5, cy + dy * i1 - sh[1][1] - 0.5, 1);
      out[o + 2] = sample(data, w, h, cx + dx * i2 - sh[2][0] - 0.5, cy + dy * i2 - sh[2][1] - 0.5, 2);
      out[o + 3] = 255;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 4. Colour-space roundtripping                                        */
/* ------------------------------------------------------------------ */

const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function enc(v) { v = v < 0 ? 0 : v > 1 ? 1 : v; return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; }
function dec(v) { v = v < 0 ? 0 : v > 1 ? 1 : v; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function levels(bits) { return Math.pow(2, +bits || 8) - 1; }
function qz(v, lo, hi, L) {
  if (v < lo) v = lo; else if (v > hi) v = hi;
  return lo + Math.round(((v - lo) / (hi - lo)) * L) / L * (hi - lo);
}

function stLinear(d, bits) {
  const L = levels(bits);
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = enc(qz(LIN[d[i]], 0, 1, L)) * 255;
    d[i + 1] = enc(qz(LIN[d[i + 1]], 0, 1, L)) * 255;
    d[i + 2] = enc(qz(LIN[d[i + 2]], 0, 1, L)) * 255;
  }
}

function stP3(d, bits) {
  const L = levels(bits);
  for (let i = 0; i < d.length; i += 4) {
    const r = LIN[d[i]], g = LIN[d[i + 1]], b = LIN[d[i + 2]];
    let pr = 0.8224621 * r + 0.1775380 * g;
    let pg = 0.0331941 * r + 0.9668058 * g;
    let pb = 0.0170827 * r + 0.0723974 * g + 0.9105199 * b;
    pr = dec(qz(enc(pr), 0, 1, L)); pg = dec(qz(enc(pg), 0, 1, L)); pb = dec(qz(enc(pb), 0, 1, L));
    const sr = 1.2249401 * pr - 0.2249404 * pg;
    const sg = -0.0420569 * pr + 1.0420571 * pg;
    const sb = -0.0196376 * pr - 0.0786361 * pg + 1.0982735 * pb;
    d[i] = enc(sr) * 255; d[i + 1] = enc(sg) * 255; d[i + 2] = enc(sb) * 255;
  }
}

const XN = 0.95047, YN = 1.0, ZN = 1.08883, EPS = 216 / 24389, KAP = 24389 / 27;
function labF(t) { return t > EPS ? Math.cbrt(t) : (KAP * t + 16) / 116; }
function labFi(f) { const f3 = f * f * f; return f3 > EPS ? f3 : (116 * f - 16) / KAP; }
function stLab(d, bits) {
  const L = levels(bits);
  for (let i = 0; i < d.length; i += 4) {
    const r = LIN[d[i]], g = LIN[d[i + 1]], b = LIN[d[i + 2]];
    const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    const fx = labF(X / XN), fy = labF(Y / YN), fz = labF(Z / ZN);
    let l = 116 * fy - 16, a = 500 * (fx - fy), bb = 200 * (fy - fz);
    l = qz(l, 0, 100, L); a = qz(a, -128, 128, L); bb = qz(bb, -128, 128, L);
    const gy = (l + 16) / 116, gx = gy + a / 500, gz = gy - bb / 200;
    const X2 = labFi(gx) * XN, Y2 = labFi(gy) * YN, Z2 = labFi(gz) * ZN;
    const r2 = 3.2404542 * X2 - 1.5371385 * Y2 - 0.4985314 * Z2;
    const g2 = -0.9692660 * X2 + 1.8760108 * Y2 + 0.0415560 * Z2;
    const b2 = 0.0556434 * X2 - 0.2040259 * Y2 + 1.0572252 * Z2;
    d[i] = enc(r2) * 255; d[i + 1] = enc(g2) * 255; d[i + 2] = enc(b2) * 255;
  }
}

function hueOf(r, g, b, mx, dl) {
  if (!dl) return 0;
  let h;
  if (mx === r) h = ((g - b) / dl) % 6;
  else if (mx === g) h = (b - r) / dl + 2;
  else h = (r - g) / dl + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
const OUT = new Float64Array(3);
function fromHC(h, c, m) {
  const hp = (h % 360) / 60, x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; } else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; } else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
  OUT[0] = r + m; OUT[1] = g + m; OUT[2] = b + m;
}
function stHSV(d, bits) {
  const L = levels(bits);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
    let h = hueOf(r, g, b, mx, dl), s = mx ? dl / mx : 0, v = mx;
    h = qz(h, 0, 360, L); s = qz(s, 0, 1, L); v = qz(v, 0, 1, L);
    const c = v * s;
    fromHC(h, c, v - c);
    d[i] = OUT[0] * 255; d[i + 1] = OUT[1] * 255; d[i + 2] = OUT[2] * 255;
  }
}
function stHSL(d, bits) {
  const L = levels(bits);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
    let l = (mx + mn) / 2;
    let h = hueOf(r, g, b, mx, dl);
    let s = dl ? dl / (1 - Math.abs(2 * l - 1)) : 0;
    h = qz(h, 0, 360, L); s = qz(s, 0, 1, L); l = qz(l, 0, 1, L);
    const c = (1 - Math.abs(2 * l - 1)) * s;
    fromHC(h, c, l - c / 2);
    d[i] = OUT[0] * 255; d[i + 1] = OUT[1] * 255; d[i + 2] = OUT[2] * 255;
  }
}

function stYcc(d, w, h, Y) {
  const bits = +Y.bits || 8;
  const Kr = Y.matrix === '709' ? 0.2126 : Y.matrix === '2020' ? 0.2627 : 0.299;
  const Kb = Y.matrix === '709' ? 0.0722 : Y.matrix === '2020' ? 0.0593 : 0.114;
  const Kg = 1 - Kr - Kb;
  const N = w * h;
  const YP = new Float32Array(N), CB = new Float32Array(N), CR = new Float32Array(N);
  let qY, qC;
  if (Y.range === 'limited') {
    const s = Math.pow(2, bits - 8), LY = 219 * s, LC = 224 * s;
    qY = v => Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * LY) / LY;
    qC = c => Math.round((c < -0.5 ? -0.5 : c > 0.5 ? 0.5 : c) * LC) / LC;
  } else {
    const L = levels(bits);
    qY = v => Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * L) / L;
    qC = c => Math.round(((c < -0.5 ? -0.5 : c > 0.5 ? 0.5 : c) + 0.5) * L) / L - 0.5;
  }
  for (let p = 0, i = 0; p < N; p++, i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const yy = Kr * r + Kg * g + Kb * b;
    YP[p] = qY(yy);
    CB[p] = (b - yy) / (2 * (1 - Kb));
    CR[p] = (r - yy) / (2 * (1 - Kr));
  }
  const sub = Y.sub || '444';
  const bx = sub === '444' ? 1 : 2, by = sub === '420' ? 2 : 1;
  for (let y0 = 0; y0 < h; y0 += by) {
    for (let x0 = 0; x0 < w; x0 += bx) {
      let sb = 0, sr = 0, n = 0;
      for (let yy = y0; yy < Math.min(h, y0 + by); yy++)
        for (let xx = x0; xx < Math.min(w, x0 + bx); xx++) { const p = yy * w + xx; sb += CB[p]; sr += CR[p]; n++; }
      const qb = qC(sb / n), qr = qC(sr / n);
      for (let yy = y0; yy < Math.min(h, y0 + by); yy++)
        for (let xx = x0; xx < Math.min(w, x0 + bx); xx++) { const p = yy * w + xx; CB[p] = qb; CR[p] = qr; }
    }
  }
  for (let p = 0, i = 0; p < N; p++, i += 4) {
    const yy = YP[p];
    const r = yy + 2 * (1 - Kr) * CR[p];
    const b = yy + 2 * (1 - Kb) * CB[p];
    const g = (yy - Kr * r - Kb * b) / Kg;
    d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;
  }
}

function colorRoundtrip(d, w, h, C, id) {
  if (!C) return;
  const it = Math.max(0, Math.round(+C.iterations || 0));
  const on = s => C[s] && C[s].on;
  if (!it || !['linear', 'p3', 'lab', 'hsv', 'hsl', 'ycc'].some(on)) return;
  for (let k = 0; k < it; k++) {
    progress(id, 'Colour roundtrip', (k + 0.5) / it);
    if (on('linear')) stLinear(d, C.linear.bits);
    if (on('p3')) stP3(d, C.p3.bits);
    if (on('lab')) stLab(d, C.lab.bits);
    if (on('hsv')) stHSV(d, C.hsv.bits);
    if (on('hsl')) stHSL(d, C.hsl.bits);
    if (on('ycc')) stYcc(d, w, h, C.ycc);
  }
}

// Expose for headless testing
if (typeof module !== 'undefined') module.exports = { carve, resample, colorRoundtrip, autoZoom };
