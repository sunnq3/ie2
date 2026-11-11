/* De-grid: remove the JPEG 8×8 grid look without blurring or copying pixels.
 *
 * What the eye reads as a grid on walls / flat colours is not mainly brightness steps: every 8×8 cell carries
 * its own little stamped texture (bars, checkers, or nothing), so the texture changes at every cell border.
 *
 *  1. structure / detail split: an edge-preserving filter (guided filter) keeps light, shading, colour and edges;
 *     what is left is the fine texture, including the stamps.
 *  2. grid map: inside a JPEG cell neighbouring pixels are strongly related, across a cell border they are not.
 *     The local difference between the two is a direct measurement of the grid (≈0 on clean photos).
 *  3. tone steps that sit exactly on the cell borders are ramped out of the structure layer.
 *  4. long lines (creases, edges) are found by averaging along 8 directions over more than one cell and are kept.
 *  5. noise profile: how much fine grain the photo has at each brightness (16 levels) and how coarse it is, measured
 *     on calm tiles of the whole photo. Where the grid is, the stamped texture is replaced by continuous grain at the
 *     profile's level; detail above that level is real texture and stays. Elsewhere, areas JPEG left quieter than
 *     the profile get grain added and nothing else changes, so the noise ends up even across the photo. All levels
 *     are matched on what the eye reads as grain (the fine band), and the fill-in is variance-matched, so partly
 *     treated areas don't dip. Nothing is copied from elsewhere, nothing is blurred.
 *  6. the new grain is brightness only and sized per brightness to survive a JPEG save at the target quality (see
 *     survival()); the editor's JPG export rounds brightness boundary-aware (seamQuant), and check() measures what a
 *     save does to the grain.
 *  The same profile drives addGrain(), which the editor's fill and randomize tools use for the pixels they make.
 *
 * Runs as a Web Worker (message {data, W, H, sel, opts}) or as a plain script / node module (Degrid.run).
 */
(function (root) {
  'use strict';
  const KR = 0.299, KG = 0.587, KB = 0.114;

  /* ---------- small helpers on Float32 planes (w × h, row-major) ---------- */
  function boxH(src, dst, w, h, r) {
    const d = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const o = y * w; let s = 0;
      for (let k = -r; k <= r; k++) s += src[o + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) { dst[o + x] = s / d; s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; }
    }
  }
  function boxV(src, dst, w, h, r) {
    const d = 2 * r + 1, s = new Float64Array(w);
    for (let k = -r; k <= r; k++) { const o = Math.min(h - 1, Math.max(0, k)) * w; for (let x = 0; x < w; x++) s[x] += src[o + x]; }
    for (let y = 0; y < h; y++) {
      const o = y * w, a = Math.min(h - 1, y + r + 1) * w, b = Math.max(0, y - r) * w;
      for (let x = 0; x < w; x++) { dst[o + x] = s[x] / d; s[x] += src[a + x] - src[b + x]; }
    }
  }
  function box(p, w, h, r, tmp) { boxH(p, tmp, w, h, r); boxV(tmp, p, w, h, r); return p; }
  // gaussian blur by three box passes (Kovesi's sizes)
  function boxesFor(sigma) {
    const wI = Math.floor(Math.sqrt(12 * sigma * sigma / 3 + 1)), wl = wI % 2 === 0 ? wI - 1 : wI, wu = wl + 2;
    const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
    return [0, 1, 2].map(i => ((i < m ? wl : wu) - 1) / 2);
  }
  function gauss(p, w, h, sigma, tmp) { for (const r of boxesFor(sigma)) if (r > 0) box(p, w, h, r, tmp); return p; }
  // small exact gaussian (separable), sigma < ~2; returns the 1-D kernel
  function gaussSmall(p, w, h, sigma, tmp) {
    const R = Math.max(1, Math.ceil(3 * sigma)), K = 2 * R + 1, k = new Float32Array(K); let s = 0;
    for (let i = -R; i <= R; i++) { k[i + R] = Math.exp(-i * i / (2 * sigma * sigma)); s += k[i + R]; }
    for (let i = 0; i < K; i++) k[i] /= s;
    const row = new Float32Array(w + 2 * R);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) row[x + R] = p[o + x];
      for (let x = 0; x < R; x++) { row[x] = p[o]; row[w + R + x] = p[o + w - 1]; }
      for (let x = 0; x < w; x++) { let a = 0; for (let i = 0; i < K; i++) a += k[i] * row[x + i]; tmp[o + x] = a; }
    }
    for (let y = 0; y < h; y++) {
      const o = y * w; for (let x = 0; x < w; x++) p[o + x] = 0;
      for (let i = 0; i < K; i++) { const kk = k[i], src = Math.min(h - 1, Math.max(0, y + i - R)) * w; for (let x = 0; x < w; x++) p[o + x] += kk * tmp[src + x]; }
    }
    return k;
  }
  // 4× reduced sums and bilinear expansion, for maps that are smooth anyway
  function reduce4(p, w, h) {
    const lw = Math.ceil(w / 4), lh = Math.ceil(h / 4), o = new Float32Array(lw * lh);
    for (let y = 0; y < h; y++) { const oy = (y >> 2) * lw, r = y * w; for (let x = 0; x < w; x++) o[oy + (x >> 2)] += p[r + x]; }
    return { p: o, w: lw, h: lh };
  }
  function expand4(L, w, h) {
    const o = new Float32Array(w * h), lw = L.w, lh = L.h, q = L.p;
    for (let y = 0; y < h; y++) {
      const fy = Math.min(lh - 1, Math.max(0, (y + 0.5) / 4 - 0.5)), y0 = Math.floor(fy), y1 = Math.min(lh - 1, y0 + 1), ay = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(lw - 1, Math.max(0, (x + 0.5) / 4 - 0.5)), x0 = Math.floor(fx), x1 = Math.min(lw - 1, x0 + 1), ax = fx - x0;
        o[y * w + x] = (q[y0 * lw + x0] * (1 - ax) + q[y0 * lw + x1] * ax) * (1 - ay) + (q[y1 * lw + x0] * (1 - ax) + q[y1 * lw + x1] * ax) * ay;
      }
    }
    return o;
  }
  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  function median(arr, n) { const a = arr.subarray(0, n).slice(); a.sort(); return n ? a[n >> 1] : 0; }
  // deterministic gaussian noise per pixel (so overlapping strips agree)
  function hash(x, y, c, seed) {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(c + 1, 0x9e3779b9) ^ Math.imul(seed, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
    return h >>> 0;
  }
  // near-gaussian, unit variance: the sum of the four bytes of one hash (cheap; it feeds a blur, so the cut tails at
  // ±3.5 sigma never show)
  const GN = 1 / Math.sqrt(4 * (256 * 256 - 1) / 12);
  function gnoise(x, y, c, seed) {
    const h = hash(x, y, c, seed);
    return ((h & 255) + (h >>> 8 & 255) + (h >>> 16 & 255) + (h >>> 24) - 510) * GN;
  }

  // camera-like grain: per-pixel gaussian noise (fixed by image position and seed), blurred to grain size `size`,
  // unit variance. Computed with padding, so any rectangle gives the same values as the whole image would.
  function grainField(x0, y0, w, h, c, seed, size) {
    const R = size > 0.25 ? Math.max(1, Math.ceil(3 * size)) : 0, pw = w + 2 * R, ph = h + 2 * R, G = new Float32Array(pw * ph);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) G[y * pw + x] = gnoise(x0 + x - R, y0 + y - R, c, seed);
    if (!R) return G;
    const kk = gaussSmall(G, pw, ph, size, new Float32Array(pw * ph)); let s2 = 0; for (const v of kk) s2 += v * v;
    const out = new Float32Array(w * h), norm = 1 / s2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = G[(y + R) * pw + x + R] * norm;
    return out;
  }
  // the fine band of a detail plane: what the eye reads as grain (detail minus a small blur of it)
  const FB = 1.5;
  function fine(d, w, h) { const f = d.slice(); gauss(f, w, h, FB, new Float32Array(w * h)); for (let i = 0; i < f.length; i++) f[i] = d[i] - f[i]; return f; }
  // share of a unit grain field that lands in the fine band (depends on grain size only)
  const phiCache = new Map();
  function phi(size) {
    const k = Math.round(size * 100); if (phiCache.has(k)) return phiCache.get(k);
    const G = grainField(0, 0, 96, 96, 0, 12345, k / 100), F = fine(G, 96, 96); let a = 0, b = 0;
    for (let y = 8; y < 88; y++) for (let x = 8; x < 88; x++) { const i = y * 96 + x; a += F[i] * F[i]; b += G[i] * G[i]; }
    const v = Math.sqrt(a / b); phiCache.set(k, v); return v;
  }
  const NBINS = 16;
  // the image's noise level (fine band, per channel) at luma Yv, from the profile measured by stats()
  function noiseAt(nl, Yv) { const f = Math.min(NBINS - 1.001, Math.max(0, Yv / (256 / NBINS) - 0.5)), b0 = f | 0; return nl[b0] + (nl[b0 + 1] - nl[b0]) * (f - b0); }
  // grain size (gaussian sigma) that gives a measured neighbour correlation r1
  const sizeOf = (r1) => Math.sqrt(-1 / (4 * Math.log(r1)));
  /* ---------- grain that survives JPEG ----------
   * JPEG stores each 8×8 cell as 64 patterns and rounds each one to a step that grows with the pattern's fineness and
   * shrinks with quality. Grain whose patterns are smaller than their steps is wiped or rounded into stamps, which is
   * the grid look all over again. For a target quality, every brightness level gets the smallest grain size whose
   * patterns mostly clear their steps (at most RT of the grain's energy wiped or rounded off), at the photo's own
   * grain strength there. Coarser grain keeps the same overall strength, so it reads coarser, not heavier. Size grows
   * at most to 1.7× the photo's own (beyond that it turns into blotches); where that isn't enough (quiet, dark areas
   * at lower qualities) the strength is raised a little (≤ 15%) and the rest is reported by the export check.
   * Grain goes in brightness only: colour grain is halved by colour subsampling and reads as speckle. */
  const QBY = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
  function qtab(q) { q = Math.min(100, Math.max(1, Math.round(q))); const s = q < 50 ? 5000 / q : 200 - 2 * q; return QBY.map(v => Math.min(255, Math.max(1, Math.floor((v * s + 50) / 100)))); }
  const DB = new Float64Array(64);                      // orthonormal 8-point DCT basis (the one JPEG uses)
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) DB[u * 8 + x] = (u ? 1 : Math.SQRT1_2) * 0.5 * Math.cos((2 * x + 1) * u * Math.PI / 16);
  function dct8(src, w, x0, y0, out, T) {                // 8×8 block at (x0, y0) of plane src (width w) -> out[v*8+u]
    for (let j = 0; j < 8; j++) for (let u = 0; u < 8; u++) { let a = 0; for (let i = 0; i < 8; i++) a += DB[u * 8 + i] * src[(y0 + j) * w + x0 + i]; T[j * 8 + u] = a; }
    for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) { let a = 0; for (let j = 0; j < 8; j++) a += DB[v * 8 + j] * T[j * 8 + u]; out[v * 8 + u] = a; }
  }
  function idct8(c, out, T) {                            // inverse of dct8 for one block
    for (let v = 0; v < 8; v++) for (let x = 0; x < 8; x++) { let a = 0; for (let u = 0; u < 8; u++) a += DB[u * 8 + x] * c[v * 8 + u]; T[v * 8 + x] = a; }
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { let a = 0; for (let v = 0; v < 8; v++) a += DB[v * 8 + y] * T[v * 8 + x]; out[y * 8 + x] = a; }
  }
  // spread of each of the 64 patterns for unit grain of a given size (measured once per size)
  const csCache = new Map();
  function coefStd(size) {
    const key = Math.round(size * 100); if (csCache.has(key)) return csCache.get(key);
    const N = 128, G = grainField(0, 0, N, N, 0, 4242, key / 100), acc = new Float64Array(64), c = new Float64Array(64), T = new Float64Array(64);
    for (let by = 0; by < N; by += 8) for (let bx = 0; bx < N; bx += 8) { dct8(G, N, bx, by, c, T); for (let k = 0; k < 64; k++) acc[k] += c[k] * c[k]; }
    const out = acc.map(v => Math.sqrt(v / (N * N / 64))); csCache.set(key, out); return out;
  }
  // share of a pattern's energy lost to rounding, for spread / step = rho (gaussian), tabulated
  const QE = (() => {
    const t = new Float64Array(301);
    for (let k = 1; k <= 300; k++) {
      const rho = k / 50; let e = 0, ps = 0;
      for (let z = -6; z <= 6; z += 0.01) { const x = z * rho, p = Math.exp(-z * z / 2), d = x - Math.round(x); e += p * d * d; ps += p; }
      t[k] = (e / ps) / (rho * rho);
    }
    t[0] = 1; return t;
  })();
  const qerr = (rho) => rho >= 6 ? 1 / (12 * rho * rho) : (() => { const f = rho * 50, k = Math.floor(f); return QE[k] + (QE[k + 1] - QE[k]) * (f - k); })();
  // share of the grain's energy JPEG wipes or rounds off (the cell's average, DC, is left out: it is the same for any grain)
  function mangled(size, amp, qt) {
    const cs = coefStd(size); let e = 0, t = 0;
    for (let k = 1; k < 64; k++) { const sd = amp * cs[k], v = sd * sd; t += v; e += v * qerr(sd / qt[k]); }
    return t > 0 ? e / t : 0;
  }
  let RT = 0.08, MAXMUL = 1.7, MAXBOOST = 1.15; const SSTEP = 1.12, SMAX = 3.2;
  const levelSize = (s0, k) => Math.min(SMAX, s0 * Math.pow(SSTEP, k));
  // per brightness bin: grain size level (fractional, smoothed) and strength boost, for JPEG quality q
  function survival(g, q, minMul = 1) {
    const key = q + ':' + minMul + ':' + RT + ':' + MAXMUL; if (g.svMemo && g.svMemo.key === key) return g.svMemo.val;
    const val = survival0(g, q, minMul); g.svMemo = { key, val }; return val;
  }
  function survival0(g, q, minMul) {
    const s0 = Math.max(0.5, sizeOf(g.r1[0])), qt = qtab(q), ph0 = phi(s0), K = Math.max(0, Math.floor(Math.log(Math.min(SMAX, MAXMUL * s0) / s0) / Math.log(SSTEP) + 1e-9));
    const kmin = Math.max(0, Math.log(Math.max(1, minMul)) / Math.log(SSTEP)), lev = new Float64Array(NBINS), boost = new Float64Array(NBINS);
    for (let b = 0; b < NBINS; b++) {
      const amp = g.nlf[0][b] / ph0; let k = Math.ceil(kmin - 1e-9), m = 1;
      while (k < K && mangled(levelSize(s0, k), amp, qt) > RT) k++;
      if (mangled(levelSize(s0, k), amp, qt) > RT) while (m < MAXBOOST && mangled(levelSize(s0, k), m * amp, qt) > RT) m += 0.05;
      lev[b] = Math.max(kmin, k); boost[b] = Math.min(MAXBOOST, m);
    }
    const sm = (a) => a.map((x, i) => Math.max(x, (a[Math.max(0, i - 1)] + 2 * x + a[Math.min(NBINS - 1, i + 1)]) / 4));   // smooth, never below need
    const L = sm(lev), Bo = sm(boost);
    return { q, s0, ph0, K: Math.max(K, Math.ceil(Math.max(...L))), lev: L, boost: Bo, sizes: Array.from(L, k => levelSize(s0, k)) };
  }
  const binAt = (Yv) => Math.min(NBINS - 1.001, Math.max(0, Yv / (256 / NBINS) - 0.5));
  const lerpBin = (a, Yv) => { const f = binAt(Yv), b0 = f | 0; return a[b0] + (a[b0 + 1] - a[b0]) * (f - b0); };
  // luma grain over a rectangle whose size follows brightness: fields for the size levels in use (all from the same
  // underlying noise, so neighbouring levels blend smoothly), mixed per pixel and kept at unit variance
  function survField(x0, y0, w, h, seed, sv, lumaAt) {
    const n = w * h, kf = new Float32Array(n); let lo = 1e9, hi = -1;
    for (let i = 0; i < n; i++) { const k = lerpBin(sv.lev, lumaAt(i)); kf[i] = k; if (k < lo) lo = k; if (k > hi) hi = k; }
    const k0 = Math.floor(lo), k1 = Math.min(sv.K, Math.ceil(hi)), F = new Map();
    for (let k = k0; k <= k1; k++) F.set(k, grainField(x0, y0, w, h, 0, seed, levelSize(sv.s0, k)));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = kf[i], a = Math.min(k1, Math.floor(k)), b = Math.min(k1, a + 1), t = k - a;
      if (t < 1e-3 || a === b) { out[i] = F.get(a)[i]; continue; }
      const sa = levelSize(sv.s0, a), sb = levelSize(sv.s0, b), rho = 2 * sa * sb / (sa * sa + sb * sb);
      out[i] = ((1 - t) * F.get(a)[i] + t * F.get(b)[i]) / Math.sqrt((1 - t) * (1 - t) + t * t + 2 * t * (1 - t) * rho);
    }
    return out;
  }

  /* Add the photo's own grain to chosen pixels (their current colour is the base): the photo's strength for that
   * brightness, sized to survive JPEG at quality q, brightness only. Used by the editor's fill and randomize tools.
   * data: RGBA of the whole image (changed in place), r: rectangle {x,y,w,h}, pick(i): pixel index -> amount 0..1
   * (0 = leave), g: profile from stats(), seed: grain seed. Works in row bands, so whole-image calls stay small.
   * scattered: the picked pixels are scattered among untouched ones (Randomize). Their grain can't line up with the
   * neighbours' grain, so it reads as pixel-sized noise; it gets plain per-pixel noise scaled to look as strong as the
   * photo's grain does at pixel scale (0.6 × its fine-grain level, measured), instead of the full grain swing. */
  function addGrain(data, W, r, pick, g, seed, amount = 1, scattered = false, q = 85) {
    const sv = survival(g, q), BAND = 128, lum = (o) => KR * data[o] + KG * data[o + 1] + KB * data[o + 2];
    let n = 0;
    for (let y0 = r.y; y0 < r.y + r.h; y0 += BAND) {
      const bh = Math.min(BAND, r.y + r.h - y0); let bx0 = r.x + r.w, bx1 = -1;     // columns with picked pixels
      for (let y = y0; y < y0 + bh; y++) for (let x = r.x, i = y * W + x; x < r.x + r.w; x++, i++) if (data[i * 4 + 3] && pick(i)) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; }
      if (bx1 < 0) continue;
      const bw = bx1 - bx0 + 1, G = scattered ? null : survField(bx0, y0, bw, bh, seed, sv, (q2) => lum(((y0 + (q2 / bw | 0)) * W + bx0 + q2 % bw) * 4));
      for (let y = y0; y < y0 + bh; y++) for (let x = bx0; x <= bx1; x++) {
        const i = y * W + x, o = i * 4; if (!data[o + 3]) continue;
        const a = pick(i); if (!a) continue;
        const Yv = lum(o), N = noiseAt(g.nlf[0], Yv);
        const d = scattered ? a * 0.6 * amount * N * gnoise(x, y, 0, seed) : a * amount * N / sv.ph0 * lerpBin(sv.boost, Yv) * G[(y - y0) * bw + (x - bx0)];
        data[o] += d; data[o + 1] += d; data[o + 2] += d; n++;     // brightness only: the same step on R, G and B
      }
    }
    return n;
  }

  /* What a JPEG save at quality q would do to the grain, measured on small crops (aligned to the 8×8 cells of a save
   * from the top-left corner): brightness is put through JPEG's own rounding (cells, patterns, steps) and back, then
   * grid strength and grain level are measured before and after. */
  function checkWins(data, W, H) {
    const cw = Math.min(256, W >> 3 << 3), ch = Math.min(256, H >> 3 << 3), nx = Math.max(1, Math.min(3, Math.floor(W / cw))), ny = Math.max(1, Math.min(3, Math.floor(H / ch))), wins = [];
    for (let j = 0; j < ny; j++) for (let k = 0; k < nx; k++) {
      const x0 = Math.round((W - cw) * (nx > 1 ? k / (nx - 1) : 0.5) / 8) * 8, y0 = Math.round((H - ch) * (ny > 1 ? j / (ny - 1) : 0.5) / 8) * 8;
      const Y = new Float32Array(cw * ch), A = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const o = ((y0 + y) * W + x0 + x) * 4; Y[y * cw + x] = KR * data[o] + KG * data[o + 1] + KB * data[o + 2]; A[y * cw + x] = data[o + 3]; }
      wins.push({ Y, A });
    }
    return { wins, w: cw, h: ch };
  }
  function greyWin(Y, A, w, h) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { const v = Y[i]; rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = A[i]; }
    return { rgba, c0: 0, c1: h, wy0: 0, wy1: h };
  }
  /* Boundary-aware rounding (encoder side). Plain JPEG rounds every pattern of a cell to the nearest step on its
   * own, and the rounding errors of neighbouring cells don't agree at their shared border: that mismatch is the grid.
   * Each pattern can just as validly be rounded the other way (the file stays standard and decodes anywhere), so for
   * every cell, in save order, the coarse-to-mid patterns that sit close to halfway are flipped where that makes the
   * cell's left and top edge continue the already-saved neighbours the way the original image does, weighed against
   * staying close to the original. Costs well under 1% in file size.
   * blk: 64 values (Y - 128, row-major), qt: steps, left/top: { rec: 8 saved neighbour edge values, orig: 8 original }
   * or null; writes the 64 rounded levels (row-major v*8+u) into Q and the decoded cell into rec. */
  const SEAM = { lam: 2, maxf: 5, top: 24, minFrac: 0.2 };
  const DQ = new Float64Array(64);
  const dequant = (Q, qt) => { for (let k = 0; k < 64; k++) DQ[k] = Q[k] * qt[k]; return DQ; };
  function seamQuant(blk, qt, left, top, Q, rec, C, T) {
    dct8(blk, 8, 0, 0, C, T);
    for (let k = 0; k < 64; k++) Q[k] = Math.round(C[k] / qt[k]);
    if (left || top) {
      // only the left column and top row of the decoded cell matter here
      for (let j = 0; j < 8; j++) { let a = 0, b = 0; for (let k = 0; k < 64; k++) { if (!Q[k]) continue; const w = Q[k] * qt[k], v = k >> 3, u = k & 7; a += w * DB[v * 8 + j] * DB[u * 8]; b += w * DB[v * 8] * DB[u * 8 + j]; } rec[j * 8] = a; rec[j] = j ? b : a; }
      const eL = new Float64Array(8), eT = new Float64Array(8);   // current edge mismatch against the target
      for (let j = 0; j < 8; j++) {
        if (left) eL[j] = rec[j * 8] - (left.rec[j] + blk[j * 8] - left.orig[j]);
        if (top) eT[j] = rec[j] - (top.rec[j] + blk[j] - top.orig[j]);
      }
      const cand = [];
      for (let v = 0; v < 8; v++) for (let u = 0; u + v <= SEAM.maxf && u < 8; u++) {
        const k = v * 8 + u, f = C[k] / qt[k] - Q[k]; if (Math.abs(f) >= SEAM.minFrac) cand.push([Math.abs(f), k]);
      }
      cand.sort((a, b) => b[0] - a[0]);
      for (let n = 0; n < Math.min(SEAM.top, cand.length); n++) {
        const k = cand[n][1], v = k >> 3, u = k & 7, d = Math.sign(C[k] / qt[k] - Q[k]), st = d * qt[k];
        let dc = 0;
        if (left) for (let j = 0; j < 8; j++) { const dd = st * DB[v * 8 + j] * DB[u * 8]; dc += (eL[j] + dd) ** 2 - eL[j] ** 2; }
        if (top) for (let i = 0; i < 8; i++) { const dd = st * DB[v * 8] * DB[u * 8 + i]; dc += (eT[i] + dd) ** 2 - eT[i] ** 2; }
        const a0 = Q[k] * qt[k] - C[k], a1 = (Q[k] + d) * qt[k] - C[k]; dc += SEAM.lam * (a1 * a1 - a0 * a0) / 8;
        if (dc < 0) {
          Q[k] += d;
          if (left) for (let j = 0; j < 8; j++) eL[j] += st * DB[v * 8 + j] * DB[u * 8];
          if (top) for (let i = 0; i < 8; i++) eT[i] += st * DB[v * 8] * DB[u * 8 + i];
        }
      }
    }
    idct8(dequant(Q, qt), rec, T);
  }
  // a whole luma plane (values Y - 128, w × h multiples of 8) the way the export saves it: calls put(bx, by, Q) per
  // cell in save order and returns the decoded plane
  function seamPlane(Y, w, h, qt, put) {
    const blk = new Float64Array(64), Q = new Int32Array(64), rec = new Float64Array(64), C = new Float64Array(64), T = new Float64Array(64);
    const R = new Float32Array(w * h), L = { rec: new Float64Array(8), orig: new Float64Array(8) }, Tp = { rec: new Float64Array(8), orig: new Float64Array(8) };
    for (let by = 0; by < h; by += 8) for (let bx = 0; bx < w; bx += 8) {
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) blk[j * 8 + i] = Y[(by + j) * w + bx + i];
      if (bx) for (let j = 0; j < 8; j++) { L.rec[j] = R[(by + j) * w + bx - 1]; L.orig[j] = Y[(by + j) * w + bx - 1]; }
      if (by) for (let i = 0; i < 8; i++) { Tp.rec[i] = R[(by - 1) * w + bx + i]; Tp.orig[i] = Y[(by - 1) * w + bx + i]; }
      seamQuant(blk, qt, bx ? L : null, by ? Tp : null, Q, rec, C, T);
      if (put) put(bx, by, Q);
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) R[(by + j) * w + bx + i] = rec[j * 8 + i];
    }
    return R;
  }
  function jpegLuma(Y, w, h, q) {                        // brightness through the export's own JPEG rounding and back
    const P = new Float32Array(w * h); for (let i = 0; i < w * h; i++) P[i] = Y[i] - 128;
    const R = seamPlane(P, w, h, qtab(q));
    for (let i = 0; i < w * h; i++) R[i] = Math.min(255, Math.max(0, Math.round(R[i] + 128)));
    return R;
  }
  function measure(cw, w, h, Ys) {
    const st = stats(cw.wins.map((x, k) => greyWin(Ys ? Ys[k] : x.Y, x.A, w, h)), w, h, { noiseOnly: true });
    return { gap: Math.max(0, st.gap), fine: st.fine };
  }
  // grade: 0 = grain survives intact (grid within 0.04 of before), 1 = survives with a faint grid (within 0.10),
  // 2 = the grid comes back (or the grain is lost)
  function check(cw, q) {
    cw.memo = cw.memo || {};
    if (cw.memo[q]) return cw.memo[q];
    const { w, h } = cw, before = cw.before || (cw.before = measure(cw, w, h)), after = measure(cw, w, h, cw.wins.map(x => jpegLuma(x.Y, w, h, q)));
    const kept = before.fine > 0 ? after.fine / before.fine : 1, rise = after.gap - before.gap;
    const grade = kept < 0.85 ? 2 : rise <= 0.04 ? 0 : rise <= 0.10 ? 1 : 2;
    return (cw.memo[q] = { q, gapBefore: before.gap, gapAfter: after.gap, kept, grade, ok: grade === 0 });
  }
  // the lowest quality that reaches a grade (null if even 100 doesn't); quality only ever helps, so bisect
  function lowestQ(cw, grade = 0) {
    let lo = 60, hi = 100;
    if (check(cw, hi).grade > grade) return null;
    if (check(cw, lo).grade <= grade) return check(cw, lo);
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (check(cw, mid).grade <= grade) hi = mid; else lo = mid; }
    return check(cw, hi);
  }

  /* ---------- per-window building blocks ---------- */
  // YCbCr planes of rows [wy0, wy1) ; invalid (empty) pixels get the value of the previous valid one in the row
  function planes(data, W, wy0, wy1) {
    const n = W * (wy1 - wy0), Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n), valid = new Uint8Array(n);
    for (let y = wy0; y < wy1; y++) {
      let lr = 128, lg = 128, lb = 128, have = false;
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, i = (y - wy0) * W + x;
        let r, g, b;
        if (data[o + 3]) { r = data[o]; g = data[o + 1]; b = data[o + 2]; lr = r; lg = g; lb = b; have = true; valid[i] = 1; }
        else { r = lr; g = lg; b = lb; }
        if (!have) { r = g = b = 128; }
        Y[i] = KR * r + KG * g + KB * b; Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b; Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
    }
    return { Y, Cb, Cr, valid };
  }
  // guided filter with guide I (luma) for the three channels; returns bases
  function guided(P, w, h, r, eps) {
    const I = P[0], n = w * h, tmp = new Float32Array(n);
    const mI = box(I.slice(), w, h, r, tmp);
    const vI = new Float32Array(n); for (let i = 0; i < n; i++) vI[i] = I[i] * I[i];
    box(vI, w, h, r, tmp); for (let i = 0; i < n; i++) vI[i] -= mI[i] * mI[i];
    return P.map(p => {
      const mp = box(p.slice(), w, h, r, tmp), a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = I[i] * p[i];
      box(a, w, h, r, tmp);
      const b = new Float32Array(n);
      for (let i = 0; i < n; i++) { const cov = a[i] - mI[i] * mp[i], A = cov / (vI[i] + eps); a[i] = A; b[i] = mp[i] - A * mI[i]; }
      box(a, w, h, r, tmp); box(b, w, h, r, tmp);
      for (let i = 0; i < n; i++) b[i] += a[i] * I[i];
      return b;
    });
  }
  // directional responses of a plane: |gaussian-weighted average along direction d| for nd directions, taps -T..T
  function dirResp(p, w, h, nd, T, sa) {
    const P = T + 2, pw = w + 2 * P, ph = h + 2 * P, pad = new Float32Array(pw * ph);
    for (let y = 0; y < ph; y++) { const sy = Math.min(h - 1, Math.max(0, y - P)) * w, o = y * pw; for (let x = 0; x < pw; x++) pad[o + x] = p[sy + Math.min(w - 1, Math.max(0, x - P))]; }
    let ws = 0; for (let t = -T; t <= T; t++) ws += Math.exp(-t * t / (2 * sa * sa));
    const outs = [];
    for (let d = 0; d < nd; d++) {
      const th = Math.PI * d / nd, c = Math.cos(th), s = Math.sin(th), m = new Map();
      for (let t = -T; t <= T; t++) {
        const fx = t * c, fy = t * s, ix = Math.floor(fx + 1e-9), iy = Math.floor(fy + 1e-9), ax = fx - ix, ay = fy - iy, k = Math.exp(-t * t / (2 * sa * sa)) / ws;
        const add = (off, v) => { if (v > 1e-5) m.set(off, (m.get(off) || 0) + v); };
        add(iy * pw + ix, k * (1 - ax) * (1 - ay)); add(iy * pw + ix + 1, k * ax * (1 - ay)); add((iy + 1) * pw + ix, k * (1 - ax) * ay); add((iy + 1) * pw + ix + 1, k * ax * ay);
      }
      const offs = Int32Array.from(m.keys()), ww = Float32Array.from(m.values()), nt = offs.length, acc = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        const base = (y + P) * pw + P, o = y * w;
        for (let x = 0; x < w; x++) { const q = base + x; let a = 0; for (let k = 0; k < nt; k++) a += ww[k] * pad[q + offs[k]]; acc[o + x] = a < 0 ? -a : a; }
      }
      outs.push(acc);
    }
    return outs;
  }
  function halve(p, w, h) {
    const hw = w >> 1, hh = h >> 1, o = new Float32Array(Math.max(1, hw * hh));
    for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) { const i = 2 * y * w + 2 * x; o[y * hw + x] = 0.25 * (p[i] + p[i + 1] + p[i + w] + p[i + w + 1]); }
    return { p: o, w: hw, h: hh };
  }
  // line gate over a window: strong along a direction over ~12 px and still present over ~24 px
  const ND = 8;
  function lineMaps(DL, w, h) {
    const H1 = halve(DL, w, h), H2 = halve(H1.p, H1.w, H1.h);
    return { H1, H2, S: dirResp(H1.p, H1.w, H1.h, ND, 7, 3), L: dirResp(H2.p, H2.w, H2.h, ND, 6, 2.5) };
  }
  function lineGate(m, w, h, ss, sl, lo, hi) {
    const { H1, H2, S, L } = m, g = new Float32Array(H1.w * H1.h);
    for (let y = 0; y < H1.h; y++) for (let x = 0; x < H1.w; x++) {
      const i = y * H1.w + x, j = Math.min(H2.h - 1, y >> 1) * H2.w + Math.min(H2.w - 1, x >> 1); let best = 0;
      for (let d = 0; d < ND; d++) { const v = smooth(lo * ss, hi * ss, S[d][i]) * smooth(0.8 * lo * sl, 0.8 * hi * sl, L[d][j]); if (v > best) best = v; }
      g[i] = best;
    }
    // 3×3 max at half res, back to full res, small blur
    const gm = new Float32Array(g.length);
    for (let y = 0; y < H1.h; y++) for (let x = 0; x < H1.w; x++) { let m2 = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < H1.w && Y < H1.h) m2 = Math.max(m2, g[Y * H1.w + X]); } gm[y * H1.w + x] = m2; }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = gm[Math.min(H1.h - 1, y >> 1) * H1.w + Math.min(H1.w - 1, x >> 1)];
    gaussSmall(out, w, h, 0.8, new Float32Array(w * h));
    return out;
  }
  // local grid score: within-cell minus across-border neighbour correlation of the detail
  function gridMap(D, valid, w, h, wy0, kx, ky, sigma) {
    const n = w * h, win = new Float32Array(n), winE = new Float32Array(n), acr = new Float32Array(n), acrE = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, a = D[i];
      if (x + 1 < w && valid[i] && valid[i + 1]) { const b = D[i + 1], p = a * b, e = (a * a + b * b) / 2; if ((x & 7) === kx) { acr[i] += p; acrE[i] += e; } else { win[i] += p; winE[i] += e; } }
      if (y + 1 < h && valid[i] && valid[i + w]) { const b = D[i + w], p = a * b, e = (a * a + b * b) / 2; if (((y + wy0) & 7) === ky) { acr[i] += p; acrE[i] += e; } else { win[i] += p; winE[i] += e; } }
    }
    const R = [win, winE, acr, acrE].map(p => reduce4(p, w, h)), lw = R[0].w, lh = R[0].h, tmp = new Float32Array(lw * lh);
    for (const r of R) gauss(r.p, lw, lh, sigma / 4, tmp);
    const S = new Float32Array(lw * lh);
    for (let i = 0; i < S.length; i++) S[i] = R[0].p[i] / Math.max(R[1].p[i], 1e-6) - R[2].p[i] / Math.max(R[3].p[i], 1e-6);
    return expand4({ p: S, w: lw, h: lh }, w, h);
  }
  // ramp out tone steps that sit exactly on cell borders (structure layer only)
  function deblock(B, wg, w, h, wy0, kx, ky, T) {
    const WT = [0.5, 0.375, 0.25, 0.125], e = [0, 0, 0];
    const cy0 = ((ky + 1) & 7) - 8;      // first cell row start (may be negative), in global coords
    for (let x = kx; x < w - 1; x += 8) {
      if (x - 3 < 0 || x + 4 >= w) continue;
      for (let gy = cy0 + Math.floor((wy0 - cy0) / 8) * 8 - 8; gy < wy0 + h; gy += 8) {
        const r0 = Math.max(0, gy - wy0), r1 = Math.min(h, gy + 8 - wy0); if (r1 <= r0) continue;
        let ws = 0;
        for (let c = 0; c < 3; c++) {
          const P = B[c]; let s = 0;
          for (let y = r0; y < r1; y++) { const i = y * w + x, p0 = P[i], p1 = P[i - 1], q0 = P[i + 1], q1 = P[i + 2]; s += (q0 - p0) - ((p0 - p1) + (q1 - q0)) / 2; }
          e[c] = s / (r1 - r0);
        }
        if (Math.abs(e[0]) > T) continue;
        for (let y = r0; y < r1; y++) ws += wg[y * w + x] + wg[y * w + x + 1];
        ws /= 2 * (r1 - r0);
        for (let c = 0; c < 3; c++) { const P = B[c], d = ws * e[c]; if (!d) continue; for (let y = r0; y < r1; y++) { const i = y * w + x; for (let k = 0; k < 4; k++) { P[i - k] += d * WT[k]; P[i + 1 + k] -= d * WT[k]; } } }
      }
    }
    const cx0 = ((kx + 1) & 7) - 8;
    for (let gy = ky; gy < wy0 + h; gy += 8) {
      const y = gy - wy0; if (y < 3 || y + 4 >= h) continue;
      for (let xb = cx0; xb < w; xb += 8) {
        const c0 = Math.max(0, xb), c1 = Math.min(w, xb + 8); if (c1 <= c0) continue;
        for (let c = 0; c < 3; c++) {
          const P = B[c]; let s = 0;
          for (let x = c0; x < c1; x++) { const i = y * w + x, p0 = P[i], p1 = P[i - w], q0 = P[i + w], q1 = P[i + 2 * w]; s += (q0 - p0) - ((p0 - p1) + (q1 - q0)) / 2; }
          e[c] = s / (c1 - c0);
        }
        if (Math.abs(e[0]) > T) continue;
        let ws = 0; for (let x = c0; x < c1; x++) ws += wg[y * w + x] + wg[(y + 1) * w + x]; ws /= 2 * (c1 - c0);
        for (let c = 0; c < 3; c++) { const P = B[c], d = ws * e[c]; if (!d) continue; for (let x = c0; x < c1; x++) { const i = y * w + x; for (let k = 0; k < 4; k++) { P[i - k * w] += d * WT[k]; P[i + (1 + k) * w] -= d * WT[k]; } } }
      }
    }
  }

  /* ---------- the whole thing ---------- */
  const MG = 64, NB = NBINS, MB = 3;      // MB: bytes per pixel in the map (re-textured, kept, grain added)
  let NLQ = 0.85, BETA = 1.2;
  // how the image is cut: strips of core rows, each processed with MG rows of context above and below
  function layout(W, H) {
    const CORE = Math.max(64, Math.min(1024, Math.floor(1.5e6 / W / 32) * 32));
    const strips = []; for (let y = 0; y < H; y += CORE) { const c0 = y, c1 = Math.min(H, y + CORE); strips.push({ c0, c1, wy0: Math.max(0, c0 - MG), wy1: Math.min(H, c1 + MG) }); }
    const NP = Math.max(1, Math.min(10, Math.round(H / 200))), samples = [];
    for (let k = 0; k < NP; k++) { const mid = Math.floor((k + 0.5) * H / NP), c0 = Math.max(0, mid - 64), c1 = Math.min(H, mid + 64); samples.push({ c0, c1, wy0: Math.max(0, c0 - MG), wy1: Math.min(H, c1 + MG) }); }
    return { strips, samples };
  }
  const rowsOf = (data, W, w) => data.subarray(w.wy0 * W * 4, w.wy1 * W * 4);
  // small crops spread over the image, for measuring the photo's grain quickly: { wins, W } to pass to stats()
  function profileWins(data, W, H) {
    const cw = Math.min(W, 512), M = 16, core = Math.min(H, 96), nx = Math.max(1, Math.min(4, Math.round(W / cw))), ny = Math.max(1, Math.min(4, Math.round(H / (core + 2 * M)))), wins = [];
    for (let j = 0; j < ny; j++) for (let k = 0; k < nx; k++) {
      const x0 = Math.round((W - cw) * (nx > 1 ? k / (nx - 1) : 0.5)), c0 = Math.round((H - core) * (ny > 1 ? j / (ny - 1) : 0.5));
      const wy0 = Math.max(0, c0 - M), wy1 = Math.min(H, c0 + core + M), rgba = new Uint8ClampedArray(cw * (wy1 - wy0) * 4);
      for (let y = wy0; y < wy1; y++) rgba.set(data.subarray((y * W + x0) * 4, (y * W + x0 + cw) * 4), (y - wy0) * cw * 4);
      wins.push({ rgba, c0: c0 - wy0, c1: c0 - wy0 + core, wy0: 0, wy1: wy1 - wy0 });
    }
    return { wins, W: cw };
  }
  function profile(data, W, H) { const p = profileWins(data, W, H); return stats(p.wins, p.W, H, { noiseOnly: true }); }
  function prep(rgba, W, h, wy0, eps, needF) {
    const pl = planes(rgba, W, 0, h), P = [pl.Y, pl.Cb, pl.Cr], n = W * h;
    const B = guided(P, W, h, 4, eps), D = P.map((p, c) => { const d = new Float32Array(n), b = B[c]; for (let i = 0; i < n; i++) d[i] = p[i] - b[i]; return d; });
    return { w: W, h, wy0, P, B, D, F: needF ? D.map(d => fine(d, W, h)) : null, FP: P.map(p => fine(p, W, h)), valid: pl.valid };
  }
  // 1. measurements from a few sample windows: texture level, grid position, line-response level, grain size
  function stats(wins, W, H, opts) {
    const o = Object.assign({ protect: 2.5, size: 1 }, opts || {});
    const samp = []; 
    for (const wn of wins) {
      const h = wn.wy1 - wn.wy0, pl = planes(wn.rgba, W, 0, h), m = box(pl.Y.slice(), W, h, 4, new Float32Array(W * h));
      for (let y = wn.c0 - wn.wy0; y < wn.c1 - wn.wy0; y += 3) for (let x = (y % 2); x < W; x += 3) { const i = y * W + x; if (pl.valid[i]) samp.push(Math.abs(pl.Y[i] - m[i])); }
    }
    const sa = Float32Array.from(samp), sn = Math.max(0.3, 1.4826 * median(sa, sa.length)), eps = (o.protect * sn) ** 2;
    const cx = new Float64Array(16), cy = new Float64Array(16), sS = [], sL = [], r1 = [[0, 0], [0, 0], [0, 0]];
    const tiles = [[], [], []].map(() => Array.from({ length: NB }, () => [])); let fineS = 0, fineN = 0;
    for (const wn of wins) {
      const st = prep(wn.rgba, W, wn.wy1 - wn.wy0, wn.wy0, eps), { w, h, wy0, D, FP, B, valid } = st, DL = D[0], c0 = wn.c0 - wy0, c1 = wn.c1 - wy0;
      for (let y = c0; y < c1; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (!valid[i]) continue;
        if (x + 1 < w && valid[i + 1]) { const ph = x & 7; cx[ph * 2] += DL[i] * DL[i + 1]; cx[ph * 2 + 1] += (DL[i] * DL[i] + DL[i + 1] * DL[i + 1]) / 2; }
        if (y + 1 < h && valid[i + w]) { const ph = (y + wy0) & 7; cy[ph * 2] += DL[i] * DL[i + w]; cy[ph * 2 + 1] += (DL[i] * DL[i] + DL[i + w] * DL[i + w]) / 2; }
      }
      const lm = o.noiseOnly ? null : lineMaps(DL, w, h);
      if (lm) for (let y = c0 >> 1; y < (c1 >> 1) && y < lm.H1.h; y++) for (let x = 0; x < lm.H1.w; x += 2) { let m = 0; const i = y * lm.H1.w + x; for (let d = 0; d < ND; d++) m = Math.max(m, lm.S[d][i]); sS.push(m); }
      if (lm) for (let y = c0 >> 2; y < (c1 >> 2) && y < lm.H2.h; y++) for (let x = 0; x < lm.H2.w; x++) { let m = 0; const i = y * lm.H2.w + x; for (let d = 0; d < ND; d++) m = Math.max(m, lm.L[d][i]); sL.push(m); }
      const BL = B[0];
      for (let y = Math.max(1, c0); y < Math.min(h - 1, c1); y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x; if (!valid[i] || !valid[i + 1] || !valid[i + w]) continue;
        const gx = (BL[i + 1] - BL[i - 1]) / 2, gy = (BL[i + w] - BL[i - w]) / 2; if (gx * gx + gy * gy > 2.25 * sn * sn) continue;
        for (let c = 0; c < 3; c++) { const d = D[c]; r1[c][0] += d[i] * d[i + 1] + d[i] * d[i + w]; r1[c][1] += d[i] * d[i] + (d[i + 1] * d[i + 1] + d[i + w] * d[i + w]) / 2; }
      }
      // noise level by brightness: RMS of the detail in calm 16×16 tiles, filed under the tile's mean luma
      for (let ty = Math.max(1, c0); ty + 16 <= Math.min(h - 1, c1); ty += 16) for (let tx = 1; tx + 16 < w; tx += 16) {
        let nc = 0, sy = 0; const s2 = [0, 0, 0], qs = [0, 0, 0, 0], qn = [0, 0, 0, 0];
        for (let y = ty; y < ty + 16; y++) for (let x = tx; x < tx + 16; x++) {
          const i = y * w + x; if (!valid[i]) continue;
          const gx = (BL[i + 1] - BL[i - 1]) / 2, gy = (BL[i + w] - BL[i - w]) / 2; if (gx * gx + gy * gy > 2.25 * sn * sn) continue;
          const qd = (y - ty >> 3) * 2 + (x - tx >> 3); qs[qd] += BL[i]; qn[qd]++;
          nc++; sy += BL[i]; for (let c = 0; c < 3; c++) s2[c] += FP[c][i] * FP[c][i];
        }
        if (nc < 192) continue;
        const qm = qs.map((v, k) => qn[k] ? v / qn[k] : sy / nc);
        if (Math.max(...qm) - Math.min(...qm) > Math.max(6, 2 * sn)) continue;      // one surface only, not two sides of an edge
        const b = Math.min(NB - 1, Math.max(0, Math.floor(sy / nc / (256 / NB))));
        for (let c = 0; c < 3; c++) tiles[c][b].push(Math.sqrt(s2[c] / nc));
        fineS += s2[0] / nc; fineN++;
      }
    }
    // per bin: power average of the tiles (JPEG leaves some cells noisy and wipes others; what the eye sees is the
    // average), leaving out the busiest share. A brightness that is mostly real texture (a patterned fabric, foliage)
    // would still read high, so each bin is also held to its quiet end (30th percentile) times the ratio between the
    // two that the photo shows where it is plain noise. Empty bins borrow from their neighbours.
    const nlf = tiles.map((bins, ch) => {
      const tp = [], lo = [];
      bins.forEach((a, i) => {
        if (a.length < 4) { tp[i] = lo[i] = -1; return; }
        a.sort((p, q) => p - q);
        const m = Math.max(2, Math.ceil((ch ? NLQ - 0.15 : NLQ) * a.length)); let s = 0; for (let k = 0; k < m; k++) s += a[k] * a[k];
        tp[i] = Math.sqrt(s / m); lo[i] = a[Math.floor(0.3 * (a.length - 1))];
      });
      const rs = Float32Array.from(bins.map((a, i) => a.length >= 8 && lo[i] > 0.05 ? tp[i] / lo[i] : -1).filter(x => x > 0));
      const kap = rs.length ? median(rs, rs.length) : 1.5;
      const v = tp.map((t, i) => t < 0 ? -1 : Math.min(t, kap * lo[i]));
      const have = v.map((x, i) => x >= 0 ? i : -1).filter(i => i >= 0);
      if (!have.length) return new Array(NB).fill(sn);
      for (let i = 0; i < NB; i++) if (v[i] < 0) {
        let lo = -1, hi = -1; for (const j of have) { if (j < i) lo = j; else if (hi < 0) hi = j; }
        v[i] = lo < 0 ? v[hi] : hi < 0 ? v[lo] : v[lo] + (v[hi] - v[lo]) * (i - lo) / (hi - lo);
      }
      return v.map((x, i) => (v[Math.max(0, i - 1)] + 4 * x + v[Math.min(NB - 1, i + 1)]) / 6);
    });
    const corrX = [], corrY = []; for (let p = 0; p < 8; p++) { corrX.push(cx[p * 2] / Math.max(1e-9, cx[p * 2 + 1])); corrY.push(cy[p * 2] / Math.max(1e-9, cy[p * 2 + 1])); }
    const argmin = (a) => a.indexOf(Math.min(...a)), gapOf = (a, k) => a.reduce((s, v, i) => s + (i === k ? 0 : v), 0) / 7 - a[k];
    const kx = argmin(corrX), ky = argmin(corrY), gap = Math.min(gapOf(corrX, kx), gapOf(corrY, ky));
    const fS = Float32Array.from(sS), fL = Float32Array.from(sL);
    const ss = Math.max(1e-3, median(fS, fS.length)), sl = Math.max(1e-3, median(fL, fL.length));
    const r1v = r1.map(([a, b]) => Math.min(0.95, Math.max(0.01, b > 0 ? a / b : 0.3)));
    return { sn, eps, kx, ky, gap, ss, sl, r1: r1v, corrX, corrY, nlf, fine: fineN ? Math.sqrt(fineS / fineN) : 0 };
  }
  // 2. one strip: rgba holds rows wy0..wy1 of the image, sel (optional) the same rows of the selection mask
  function strip(wn, W, g, opts, sel) {
    const o = Object.assign({ strength: 1, amount: 1, size: 1, seed: 1, even: 1, q: 85, onlySel: false }, opts || {});
    const sv = survival(g, o.q, o.size);
    const st = prep(wn.rgba, W, wn.wy1 - wn.wy0, wn.wy0, g.eps, true), { w, h, wy0, P, B, D, F, FP, valid } = st, n = w * h, tmp = new Float32Array(n), sn = g.sn;
    const wgs = gridMap(D[0], valid, w, h, wy0, g.kx, g.ky, 10), wg = new Float32Array(n);
    for (let i = 0; i < n; i++) wg[i] = smooth(0.05, 0.18, wgs[i]);
    const lg = lineGate(lineMaps(D[0], w, h), w, h, g.ss, g.sl, 2.0, 3.2);
    deblock(B, wg, w, h, wy0, g.kx, g.ky, 4 * sn + 3);
    const bl = B[0].slice(); gaussSmall(bl, w, h, 0.7, tmp);
    const flat = new Float32Array(n), k2 = 1 / (2.25 * sn * sn);
    for (let y = 0; y < h; y++) {
      const ro = y * w, up = Math.max(0, y - 1) * w, dn = Math.min(h - 1, y + 1) * w;
      for (let x = 0; x < w; x++) {
        const i = ro + x, gx = (bl[ro + Math.min(w - 1, x + 1)] - bl[ro + Math.max(0, x - 1)]) / 2, gy = (bl[dn + x] - bl[up + x]) / 2;
        const edge = 1 - Math.exp(-(gx * gx + gy * gy) * k2);
        flat[i] = valid[i] ? 1 - Math.max(lg[i], edge) : 0;
      }
    }
    let selw = null;
    if (o.onlySel && sel) { selw = new Float32Array(n); for (let i = 0; i < n; i++) selw[i] = sel[i] ? 1 : 0; gauss(selw, w, h, 3, tmp); }
    const mix = new Float32Array(n);
    for (let i = 0; i < n; i++) { const m = o.strength * wg[i] * flat[i] * (selw ? selw[i] : 1); mix[i] = m < 0 ? 0 : m > 1 ? 1 : m; }
    // how much change is allowed at all (strength, selection), for the even-out top-up outside the grid areas
    const allow = new Float32Array(n);
    for (let i = 0; i < n; i++) allow[i] = valid[i] ? o.strength * (selw ? selw[i] : 1) : 0;
    // local fine-band energy of a plane, calm areas only (edges and lines left out so they don't count), over a few cells
    const WT = reduce4(flat, w, h), ltmp = new Float32Array(WT.p.length); gauss(WT.p, WT.w, WT.h, 2, ltmp);
    const lw = WT.w, lh = WT.h;
    const energy = (f) => {
      const AL = { p: new Float32Array(lw * lh), w: lw, h: lh }, AU = { p: new Float32Array(lw * lh), w: lw, h: lh }, pl = AL.p, pu = AU.p;
      for (let y = 0; y < h; y++) { const oy = (y >> 2) * lw, ro = y * w; for (let x = 0; x < w; x++) { const i = ro + x, e = f[i] * f[i], q = oy + (x >> 2); pl[q] += e * flat[i]; pu[q] += e; } }
      gauss(pl, lw, lh, 2, ltmp); gauss(pu, lw, lh, 2, ltmp);
      for (let i = 0; i < AL.p.length; i++) AL.p[i] = (AL.p[i] + 0.02 * AU.p[i]) / (WT.p[i] + 0.02);
      return expand4(AL, w, h);
    };
    const res = [], top = new Float32Array(n), chg = new Uint8Array(n), BY = B[0];
    for (let c = 0; c < 3; c++) {
      const nl = g.nlf[c], Pc = P[c], Bc = B[c], Fc = F[c], FPc = FP[c], Vp = energy(FPc);
      // 1. per pixel: the noise level for this brightness, texture vs noise, how much of the original detail stays
      const N = new Float32Array(n), K = new Float32Array(n), cK = new Float32Array(n), kT = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const Nv = noiseAt(nl, BY[i]), v = Vp[i];
        const k = v > 1e-6 ? Math.max(0, 1 - BETA * BETA * Nv * Nv / v) : 0;   // share of the local detail that is texture
        const c0 = 1 - mix[i] * (1 - k);
        N[i] = Nv; kT[i] = k; cK[i] = c0;
        K[i] = FPc[i] - (1 - c0) * Fc[i];                                     // fine band of what stays of the original
      }
      const VK = energy(K);
      // 2. new grain fills the noise up to an even level: what was taken out, plus what JPEG had already wiped.
      //    Brightness only, sized per brightness to survive a JPEG save at quality o.q (survival()); its overall
      //    strength is what the photo's own grain has (fine-band level / fine share of the natural size).
      //    Colour gets no new grain: where stamps are replaced, the colour keeps its structure and real texture only.
      const G = c === 0 ? survField(0, wy0, w, h, o.seed, sv, (i) => BY[i]) : null, R = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const u = allow[i]; if (!u) { R[i] = Pc[i]; continue; }
        const m = mix[i]; if (m > 0) chg[i] = 1;
        const v = Vp[i], k = kT[i], nz2 = (1 - k) * v, am = 1 + m * (o.amount - 1), eN = o.even * u * N[i];
        // re-textured areas get the photo's level (Even out) instead of their own; elsewhere only too-quiet areas are topped up
        const Ne = o.even * N[i] * N[i] + (1 - o.even) * nz2, want = am * am * ((1 - m) * Math.max(nz2, eN * eN) + m * Ne), kept = Math.max(0, VK[i] - k * v), s2 = want - kept, s = s2 > 0 ? Math.sqrt(s2) : 0;
        R[i] = Bc[i] + cK[i] * (Pc[i] - Bc[i]) + (G ? s * lerpBin(sv.boost, BY[i]) / sv.ph0 * G[i] : 0);
        if (G && s > 0.02) chg[i] = 1;
        if (c === 0) top[i] = o.even > 0 && N[i] > 0.05 ? Math.min(1, (1 - m) * s / N[i]) : 0;
      }
      res.push(R);
    }
    const ch = wn.c1 - wn.c0, out = new Uint8ClampedArray(ch * W * 4), map = new Uint8Array(ch * W * MB);
    let acted = 0, topped = 0;
    for (let y = wn.c0; y < wn.c1; y++) for (let x = 0; x < W; x++) {
      const i = (y - wy0) * w + x, q = (y - wn.c0) * W + x, oo = q * 4, so = i * 4;
      out[oo] = wn.rgba[so]; out[oo + 1] = wn.rgba[so + 1]; out[oo + 2] = wn.rgba[so + 2]; out[oo + 3] = wn.rgba[so + 3];
      map[q * MB] = Math.round(mix[i] * 255); map[q * MB + 1] = valid[i] ? Math.round((1 - flat[i]) * 255) : 0; map[q * MB + 2] = Math.round(top[i] * 255);
      if (!valid[i] || !allow[i] || !chg[i]) continue;
      if (mix[i] > 0.5 * o.strength) acted++; else if (top[i] > 0.25) topped++;
      const Yv = res[0][i], cb = res[1][i], cr = res[2][i];
      out[oo] = Yv + 1.402 * cr; out[oo + 1] = Yv - 0.344136 * cb - 0.714136 * cr; out[oo + 2] = Yv + 1.772 * cb;
    }
    return { c0: wn.c0, c1: wn.c1, out, map, acted, topped };
  }
  // the whole image in this thread (tests / fallback). The page uses a pool of workers instead (stats + strip jobs).
  async function run(data, W, H, sel, opts, progress) {
    const t0 = Date.now(), tick = progress || (() => {}), L = layout(W, H);
    const g = stats(L.samples.map(w => Object.assign({ rgba: rowsOf(data, W, w) }, w)), W, H, opts);
    const out = new Uint8ClampedArray(W * H * 4), map = new Uint8Array(W * H * MB); let acted = 0, topped = 0;
    for (let k = 0; k < L.strips.length; k++) {
      tick(k / L.strips.length, 'de-gridding'); await new Promise(r => setTimeout(r, 0));
      const w = L.strips[k], r = strip(Object.assign({ rgba: rowsOf(data, W, w) }, w), W, g, opts, sel ? sel.subarray(w.wy0 * W, w.wy1 * W) : null);
      out.set(r.out, w.c0 * W * 4); map.set(r.map, w.c0 * W * MB); acted += r.acted; topped += r.topped;
    }
    return { out, map, info: Object.assign({}, g, { acted: acted / (W * H), topped: topped / (W * H), ms: Date.now() - t0, sizes: g.r1.map(r => sizeOf(r) * ((opts && opts.size) || 1)), survival: survival(g, (opts && opts.q) || 85, (opts && opts.size) || 1) }) };
  }

  const Degrid = { run, stats, strip, layout, addGrain, profile, profileWins, survival, checkWins, check, lowestQ, seamPlane, seamQuant, qtab, MG, MB, tune: (q, b, rt, mm, mb) => { NLQ = q; BETA = b; if (rt) RT = rt; if (mm) MAXMUL = mm; if (mb) MAXBOOST = mb; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = Degrid;
  root.Degrid = Degrid;
  // worker mode: { job: 'stats', wins, W, H, opts } -> stats ; { job: 'strip', wn, W, g, opts, sel } -> rows
  if (typeof importScripts === 'function' && typeof document === 'undefined') {
    root.onmessage = (e) => {
      const m = e.data;
      try {
        if (m.job === 'stats') root.postMessage({ id: m.id, g: stats(m.wins, m.W, m.H, m.opts) });
        else if (m.job === 'check') root.postMessage({ id: m.id, r: { at: check(m.cw, m.q), intact: lowestQ(m.cw, 0), faint: lowestQ(m.cw, 1) } });
        else { const r = strip(m.wn, m.W, m.g, m.opts, m.sel); root.postMessage({ id: m.id, r }, [r.out.buffer, r.map.buffer]); }
      } catch (err) { root.postMessage({ id: m.id, error: String(err && err.stack || err) }); }
    };
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
