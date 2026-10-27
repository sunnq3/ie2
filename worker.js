'use strict';
/*
 * ie2 processing worker
 * Pipeline: seam carving -> lens distortion + chromatic aberration (single resample) -> colour-space roundtrip
 */

let SRC = null;   // { w, h, data: Uint8ClampedArray RGBA }
let CACHE = null; // { key, w, h, data, mask }
let PRE = null;   // output of everything before the noise stage { key, data, w, h }
let CLEAN = null; // cleaned source { key, data }

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    SRC = { w: m.w, h: m.h, data: new Uint8ClampedArray(m.buffer) };
    CACHE = null; PRE = null; CLEAN = null;
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
  const C = P.clean || {};
  const cleanOn = cleanActive(C);
  const startClean = cleanOn && C.position !== 'end';
  const ck = startClean ? JSON.stringify(C) : '';
  if (!CLEAN || CLEAN.key !== ck) {
    CLEAN = { key: ck, data: startClean ? cleanup(SRC.data.slice(), SRC.w, SRC.h, C, id) : SRC.data };
    CACHE = null;
  }
  const key = carveKey(P.carve) + '#' + ck;
  let recarved = false;
  if (!CACHE || CACHE.key !== key) {
    CACHE = carve({ w: SRC.w, h: SRC.h, data: CLEAN.data }, P.carve, id);
    CACHE.key = key;
    recarved = true;
  }
  const endClean = cleanOn && C.position === 'end';
  const preKey = key + '|' + JSON.stringify([P.lens, P.ca, P.color, P.scale, endClean ? C : 0]);
  if (recarved || !PRE || PRE.key !== preKey) {
    const { w, h } = CACHE;
    progress(id, 'Resampling', 0.5);
    const out = resample(CACHE.data, w, h, P.lens, P.ca, id);
    colorRoundtrip(out, w, h, P.color, id);
    const fin = rescale(out, w, h, P.scale, id);
    if (endClean) cleanup(fin.data, fin.w, fin.h, C, id);
    PRE = { key: preKey, data: fin.data, w: fin.w, h: fin.h };
  }
  const outData = PRE.data.slice();
  addNoise(outData, PRE.w, PRE.h, P.noise, id);
  const msg = { type: 'result', id, w: PRE.w, h: PRE.h, buffer: outData.buffer, ms: performance.now() - t0, carveKey: key };
  const transfer = [outData.buffer];
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
  const k = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let sum = (r + 1) * s[x];
    for (let j = 1; j <= r; j++) sum += s[Math.min(j, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      d[y * w + x] = sum * k;
      sum += s[Math.min(y + r + 1, h - 1) * w + x] - s[Math.max(y - r, 0) * w + x];
    }
  }
}
function blurPlane(src, w, h, sigma) {
  if (!(sigma > 0.05)) return src.slice();
  const tmp = new Float32Array(w * h);
  if (sigma < 2.5) {
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

/* Bayer re-mosaic + demosaic (Malvar-He-Cutler or bilinear) on float planes */
function bayerRoundtrip(P, w, h, pattern, method) {
  const pat = (pattern || 'RGGB').toUpperCase(), idx = { R: 0, G: 1, B: 2 };
  const cfa = [idx[pat[0]], idx[pat[1]], idx[pat[2]], idx[pat[3]]];
  const col = (x, y) => cfa[((y & 1) << 1) | (x & 1)];
  const N = w * h, M = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) M[y * w + x] = P[col(x, y)][y * w + x];
  // mirror-reflect so the CFA phase is preserved at the borders
  const rx = (x) => (x < 0 ? -x : x >= w ? 2 * w - 2 - x : x), ry = (y) => (y < 0 ? -y : y >= h ? 2 * h - 2 - y : y);
  const m = (x, y) => M[ry(y) * w + rx(x)];
  const mhc = method !== 'bilinear';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = col(x, y), C = m(x, y), p = y * w + x;
      const out = [0, 0, 0];
      out[c] = C;
      if (c !== 1) {
        const o = 2 - c; // the other of R/B
        if (mhc) {
          out[1] = (4 * C + 2 * (m(x - 1, y) + m(x + 1, y) + m(x, y - 1) + m(x, y + 1)) -
                    (m(x - 2, y) + m(x + 2, y) + m(x, y - 2) + m(x, y + 2))) / 8;
          out[o] = (6 * C + 2 * (m(x - 1, y - 1) + m(x + 1, y - 1) + m(x - 1, y + 1) + m(x + 1, y + 1)) -
                    1.5 * (m(x - 2, y) + m(x + 2, y) + m(x, y - 2) + m(x, y + 2))) / 8;
        } else {
          out[1] = (m(x - 1, y) + m(x + 1, y) + m(x, y - 1) + m(x, y + 1)) / 4;
          out[o] = (m(x - 1, y - 1) + m(x + 1, y - 1) + m(x - 1, y + 1) + m(x + 1, y + 1)) / 4;
        }
      } else {
        const hc = col(x + 1, y), vc = col(x, y + 1); // colour found horizontally / vertically
        if (mhc) {
          const diag = m(x - 1, y - 1) + m(x + 1, y - 1) + m(x - 1, y + 1) + m(x + 1, y + 1);
          out[hc] = (5 * C + 4 * (m(x - 1, y) + m(x + 1, y)) - (m(x - 2, y) + m(x + 2, y)) - diag +
                     0.5 * (m(x, y - 2) + m(x, y + 2))) / 8;
          out[vc] = (5 * C + 4 * (m(x, y - 1) + m(x, y + 1)) - (m(x, y - 2) + m(x, y + 2)) - diag +
                     0.5 * (m(x - 2, y) + m(x + 2, y))) / 8;
        } else {
          out[hc] = (m(x - 1, y) + m(x + 1, y)) / 2;
          out[vc] = (m(x, y - 1) + m(x, y + 1)) / 2;
        }
      }
      P[0][p] = out[0] < 0 ? 0 : out[0]; P[1][p] = out[1] < 0 ? 0 : out[1]; P[2][p] = out[2] < 0 ? 0 : out[2];
    }
  }
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
  const byOn = !!(A.bayer && A.bayer.on);
  const postOn = axOn || smOn || ecOn || clOn || pfOn || byOn;

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
      src[i] = LIN[data[i]] * 255; src[i + 1] = LIN[data[i + 1]] * 255; src[i + 2] = LIN[data[i + 2]] * 255;
    }
  }

  const sample = L.interp === 'bilinear' ? bil : bic;
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
  const out = new Uint8ClampedArray(N * 4);
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
            acc += wb * bil(src, w, h, bx - ux * d, by - uy * d, c);
          }
          V[c] = acc;
        }
      }
      const p = y * w + x;
      if (P) { P[0][p] = V[0]; P[1][p] = V[1]; P[2][p] = V[2]; }
      else if (linOn) { const o = p * 4; out[o] = encPx(V[0]); out[o + 1] = encPx(V[1]); out[o + 2] = encPx(V[2]); out[o + 3] = 255; }
      else { const o = p * 4; out[o] = V[0]; out[o + 1] = V[1]; out[o + 2] = V[2]; out[o + 3] = 255; }
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

  // ---- sensor: Bayer re-mosaic + demosaic (on linear data, like a raw pipeline) ----
  if (byOn) {
    if (id != null) progress(id, 'Bayer demosaic', 0.88);
    const aa = +A.bayer.aa || 0;
    if (aa > 0.05) for (let c = 0; c < 3; c++) P[c] = blurPlane(P[c], w, h, aa); // optical low-pass (AA) filter
    bayerRoundtrip(P, w, h, A.bayer.pattern, A.bayer.method);
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

  for (let p = 0, o = 0; p < N; p++, o += 4) { out[o] = P[0][p]; out[o + 1] = P[1][p]; out[o + 2] = P[2][p]; out[o + 3] = 255; }
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

function rescale(d, w, h, S, id) {
  S = S || {};
  const up = Math.max(1, +S.up || 1);
  const fin = Math.max(0.0001, (+S.final || 100) / 100);
  const fw = Math.max(1, Math.round(w * fin)), fh = Math.max(1, Math.round(h * fin));
  if (up === 1 && fw === w && fh === h) return { data: d, w, h };
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
  const out = new Uint8ClampedArray(fw * fh * 4);
  const col = new Float32Array(h * 3), upC = new Float32Array(uh * 3), dc = new Float32Array(fh * 3);
  for (let x = 0; x < fw; x++) {
    for (let y = 0; y < h; y++) { const s = (y * fw + x) * 3; col[y * 3] = mid[s]; col[y * 3 + 1] = mid[s + 1]; col[y * 3 + 2] = mid[s + 2]; }
    apply1d(col, upC, cVu);
    if (q) quant8(upC);
    apply1d(upC, dc, cVd);
    for (let y = 0; y < fh; y++) { const o = (y * fw + x) * 4; out[o] = dc[y * 3]; out[o + 1] = dc[y * 3 + 1]; out[o + 2] = dc[y * 3 + 2]; out[o + 3] = 255; }
    if ((x & 31) === 0) tick(0.5 + 0.5 * x / fw);
  }
  return { data: out, w: fw, h: fh };
}

/* ------------------------------------------------------------------ */
/* 6. Noise distribution (with painted mask)                            */
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

// Rasterise brush strokes (normalised coords) into a 0..1 mask at w x h
function rasterMask(strokes, w, h) {
  const m = new Float32Array(w * h);
  for (const s of strokes) {
    const R = Math.max(0.7072, (+s.r || 0) * w);
    const inner = R * Math.min(1, Math.max(0, +s.h || 0));
    const op = Math.min(1, Math.max(0, s.o == null ? 1 : +s.o));
    const erase = s.mode === 'erase';
    const pts = s.pts || [];
    const stamp = (cx, cy) => {
      const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R));
      const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
      for (let y = y0; y <= y1; y++) {
        const dy = y + 0.5 - cy;
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cx, d = Math.sqrt(dx * dx + dy * dy);
          if (d >= R) continue;
          let a = d <= inner ? 1 : 1 - (d - inner) / (R - inner);
          a = a * a * (3 - 2 * a) * op;
          const i = y * w + x;
          if (erase) { const v = 1 - a; if (v < m[i]) m[i] = v; } else if (a > m[i]) m[i] = a;
        }
      }
    };
    if (pts.length < 2) continue;
    let px = pts[0] * w, py = pts[1] * h;
    stamp(px, py);
    const step = Math.max(0.35, R * 0.2);
    for (let k = 2; k + 1 < pts.length; k += 2) {
      const qx = pts[k] * w, qy = pts[k + 1] * h;
      const len = Math.hypot(qx - px, qy - py), n = Math.ceil(len / step);
      for (let j = 1; j <= n; j++) stamp(px + (qx - px) * j / n, py + (qy - py) * j / n);
      px = qx; py = qy;
    }
  }
  return m;
}

function addNoise(d, w, h, N, id) {
  if (!N) return;
  const amp = +N.amount || 0;
  if (!(amp > 0)) return;
  const scope = N.scope || 'all';
  let mask = null;
  if (scope !== 'all') {
    if (scope === 'inside' && !(N.strokes && N.strokes.length)) return;
    progress(id, 'Noise mask', 0.2);
    mask = rasterMask(N.strokes || [], w, h);
  }
  progress(id, 'Noise', 0.5);
  const type = N.type || 'gaussian';
  const dens = Math.min(1, Math.max(0, (N.density == null ? 100 : +N.density) / 100));
  const ch = Math.min(1, Math.max(0, (+N.chroma || 0) / 100));
  const g = Math.max(1, +N.grain || 1);
  const irr = Math.min(1, Math.max(0, (+N.irregular || 0) / 100));
  const iS = Math.max(1, +N.irrScale || 32);
  const seed = Math.round(+N.seed || 1);

  const rA = mulberry32(seed * 2654435761), rD = mulberry32((seed ^ 0x5bd1e995) * 2246822519);
  let spare = null;
  const gauss = () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = rA(); if (u < 1e-12) u = 1e-12;
    const v = rA(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  const draw = type === 'uniform' ? () => (rA() * 2 - 1) * 1.7320508
    : type === 'laplacian' ? () => { const u = rA() - 0.5, a = Math.max(1e-12, 1 - 2 * Math.abs(u)); return (u < 0 ? 1 : -1) * Math.log(a) / Math.SQRT2; }
    : type === 'impulse' ? () => (rA() < 0.5 ? -1 : 1)
    : gauss;
  const shot = type === 'shot';

  // Coarse fields for grain > 1
  let F = null, gw = 0, gh = 0, comp = 1;
  if (g > 1) {
    gw = Math.ceil(w / g) + 2; gh = Math.ceil(h / g) + 2;
    F = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
    for (let i = 0; i < gw * gh; i++) { F[0][i] = draw(); F[1][i] = draw(); F[2][i] = draw(); F[3][i] = draw(); }
    comp = 1 + 0.5 * Math.min(1, g - 1);
  }
  const sampleF = (f, x, y) => {
    const gx = x / g, gy = y / g, xi = gx | 0, yi = gy | 0, fx = gx - xi, fy = gy - yi, o = yi * gw + xi;
    const a = f[o] + (f[o + 1] - f[o]) * fx, b = f[o + gw] + (f[o + gw + 1] - f[o + gw]) * fx;
    return (a + (b - a) * fy) * comp;
  };

  let last = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      // consume randoms in a fixed order so the pattern is stable while you paint
      let nm, n0, n1, n2;
      if (F) { nm = sampleF(F[0], x, y); n0 = sampleF(F[1], x, y); n1 = sampleF(F[2], x, y); n2 = sampleF(F[3], x, y); }
      else { nm = draw(); n0 = draw(); n1 = draw(); n2 = draw(); }
      const dr = rD();
      let wgt = 1;
      if (mask) { wgt = scope === 'inside' ? mask[p] : 1 - mask[p]; if (wgt <= 0) continue; }
      let mult = 1;
      if (irr > 0) {
        const V = vnoise(x / iS, y / iS, seed) * 0.65 + vnoise(2 * x / iS, 2 * y / iS, seed + 7) * 0.35;
        mult = 1 + irr * (2 * V - 1) * 1.6;
        if (mult <= 0) continue;
      }
      if (dr >= dens * Math.min(1, mult)) continue;
      const A = amp * wgt * mult;
      const a0 = (1 - ch) * nm + ch * n0, a1 = (1 - ch) * nm + ch * n1, a2 = (1 - ch) * nm + ch * n2;
      if (shot) {
        d[i] = d[i] + a0 * A * Math.sqrt(Math.max(d[i], 1) / 128);
        d[i + 1] = d[i + 1] + a1 * A * Math.sqrt(Math.max(d[i + 1], 1) / 128);
        d[i + 2] = d[i + 2] + a2 * A * Math.sqrt(Math.max(d[i + 2], 1) / 128);
      } else {
        d[i] = d[i] + a0 * A; d[i + 1] = d[i + 1] + a1 * A; d[i + 2] = d[i + 2] + a2 * A;
      }
    }
    if ((y & 63) === 0) { const t = performance.now(); if (t - last > 80) { last = t; progress(id, 'Noise', 0.5 + 0.5 * y / h); } }
  }
}

/* ------------------------------------------------------------------ */
/* 0. Clean-up: deblock, periodic-pattern removal, deband               */
/* ------------------------------------------------------------------ */

function cleanActive(C) {
  return !!(C && ((C.deblock && C.deblock.on) || (C.pattern && C.pattern.on) || (C.deband && C.deband.on)));
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
          d[i + c] = m + dt + (rnd() - 0.5) * 0.5;
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
  for (let p = 0, i = 0; p < w * h; p++, i += 4) { d[i] = out[p * 3]; d[i + 1] = out[p * 3 + 1]; d[i + 2] = out[p * 3 + 2]; }
}

// Expose for headless testing
if (typeof module !== 'undefined') module.exports = { blurPlane, spectralBands, bayerRoundtrip, carve, resample, colorRoundtrip, autoZoom, rescale, addNoise, rasterMask, cleanup, deband, deblock, depattern };
