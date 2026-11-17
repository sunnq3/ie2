/*
 * pipeline.js — all image math for the tile luma tool.
 *
 * Pure functions only: no DOM, no canvas, no globals. Runs in the browser
 * and in Node (the test harness imports it directly). Everything works on
 * Float32 buffers and only the caller quantises to 8-bit, at export.
 *
 * Colour model: JFIF / full-range BT.601, the exact transform JPEG uses, so
 * a zero edit is an identity round trip and chroma is left untouched.
 */

// ---------------------------------------------------------------------------
// Colour: RGB <-> YCbCr (JFIF full range, ITU-T T.871)
// ---------------------------------------------------------------------------
//
// Forward:
//   Y  = 0.299 R + 0.587 G + 0.114 B
//   Cb = 128 - 0.168736 R - 0.331264 G + 0.5 B
//   Cr = 128 + 0.5 R - 0.418688 G - 0.081312 B
// Inverse:
//   R = Y + 1.402 (Cr-128)
//   G = Y - 0.344136 (Cb-128) - 0.714136 (Cr-128)
//   B = Y + 1.772 (Cb-128)
//
// Inputs/outputs in [0,255] float. No clamping here; the caller clamps once
// on the final 8-bit write so intermediate math stays exact.

function rgbaToYCbCr(rgba, width, height) {
  const n = width * height;
  const Y = new Float32Array(n);
  const Cb = new Float32Array(n);
  const Cr = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    Y[i]  = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  return { Y, Cb, Cr };
}

function clamp8(v) {
  // round-to-nearest then clamp; the single quantisation point of the pipeline
  v = v + 0.5;
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v | 0;
}

// Recombine an edited Y with the original Cb/Cr into an RGBA Uint8ClampedArray.
// alphaSource, if given, supplies the alpha channel (else 255).
function yCbCrToRgba(Y, Cb, Cr, width, height, alphaSource) {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const y = Y[i], cb = Cb[i] - 128, cr = Cr[i] - 128;
    out[p]     = clamp8(y + 1.402 * cr);
    out[p + 1] = clamp8(y - 0.344136 * cb - 0.714136 * cr);
    out[p + 2] = clamp8(y + 1.772 * cb);
    out[p + 3] = alphaSource ? alphaSource[p + 3] : 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32. Deterministic: a seed reproduces a run exactly.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Control grid: gain/offset values on an (gx+1) x (gy+1) lattice of nodes.
// ---------------------------------------------------------------------------
//
// gainJitter a:  per-node gain drawn uniformly in [1-a, 1+a]
// offsetJitter d: per-node offset drawn uniformly in [-d, +d]  (luma units)
// uniform=true:  every node identical (gain 1+a? no — gain 1, offset 0 unless
//                a caller-supplied constant); used to show "no local variation".
//
// Returns {gx, gy, gain:Float32Array, offset:Float32Array} with
// (gx+1)*(gy+1) entries in row-major node order.
function buildControlGrid(gx, gy, opts) {
  const a = opts.gainJitter || 0;
  const d = opts.offsetJitter || 0;
  const baseGain = opts.baseGain != null ? opts.baseGain : 1;
  const baseOffset = opts.baseOffset != null ? opts.baseOffset : 0;
  const nodesX = gx + 1, nodesY = gy + 1;
  const count = nodesX * nodesY;
  const gain = new Float32Array(count);
  const offset = new Float32Array(count);
  if (opts.uniform) {
    // one shared draw within the ranges, applied to every node -> same edit
    // everywhere (still reproducible: the seed picks the single value).
    const rnd = mulberry32((opts.seed >>> 0) || 1);
    const g = baseGain + (rnd() * 2 - 1) * a;
    const b = baseOffset + (rnd() * 2 - 1) * d;
    gain.fill(g);
    offset.fill(b);
    return { gx, gy, nodesX, nodesY, gain, offset };
  }
  const rnd = mulberry32(opts.seed >>> 0);
  for (let i = 0; i < count; i++) {
    gain[i]   = baseGain + (rnd() * 2 - 1) * a;
    offset[i] = baseOffset + (rnd() * 2 - 1) * d;
  }
  return { gx, gy, nodesX, nodesY, gain, offset };
}

// smoothstep: 3t^2 - 2t^3, C1-continuous at node boundaries
function smoothstep(t) { return t * t * (3 - 2 * t); }

// ---------------------------------------------------------------------------
// Interpolate the control grid up to a per-pixel field.
// mode: 'smooth' (smoothstep bilinear, C1), 'bilinear' (C0), 'nearest' (hard tiles).
// Writes into gField/bField (Float32Array length width*height).
// ---------------------------------------------------------------------------
function interpolateField(grid, width, height, mode, gField, bField) {
  const { gx, gy, nodesX, gain, offset } = grid;
  // Map pixel to grid-node coordinate space. Use (dim-1) so the last pixel
  // lands exactly on the last node (no extrapolation past the lattice).
  const sx = width > 1 ? gx / (width - 1) : 0;
  const sy = height > 1 ? gy / (height - 1) : 0;
  for (let y = 0; y < height; y++) {
    let fy = y * sy;
    let j0 = fy | 0;
    if (j0 >= gy) j0 = gy - 1 < 0 ? 0 : gy - 1;
    let ty = fy - j0;
    const rowBase = j0 * nodesX;
    for (let x = 0; x < width; x++) {
      let fx = x * sx;
      let i0 = fx | 0;
      if (i0 >= gx) i0 = gx - 1 < 0 ? 0 : gx - 1;
      let tx = fx - i0;
      const idx = y * width + x;
      if (mode === 'nearest') {
        // pick the nearest node -> hard tile, visible seams (for comparison)
        const ni = (tx < 0.5 ? i0 : i0 + 1);
        const nj = (ty < 0.5 ? j0 : j0 + 1);
        const k = nj * nodesX + ni;
        gField[idx] = gain[k];
        bField[idx] = offset[k];
        continue;
      }
      let wx = tx, wy = ty;
      if (mode === 'smooth') { wx = smoothstep(tx); wy = smoothstep(ty); }
      const k00 = rowBase + i0;
      const k10 = k00 + 1;
      const k01 = k00 + nodesX;
      const k11 = k01 + 1;
      const g0 = gain[k00] + (gain[k10] - gain[k00]) * wx;
      const g1 = gain[k01] + (gain[k11] - gain[k01]) * wx;
      gField[idx] = g0 + (g1 - g0) * wy;
      const o0 = offset[k00] + (offset[k10] - offset[k00]) * wx;
      const o1 = offset[k01] + (offset[k11] - offset[k01]) * wx;
      bField[idx] = o0 + (o1 - o0) * wy;
    }
  }
}

// ---------------------------------------------------------------------------
// Apply the edit to luma:  Y' = g(x,y) * (Y - pivot) + pivot + b(x,y)
// pivot = 128 scales contrast about mid-grey. Clamp to [0,255] (highlights/
// shadows can only clip at the extremes). Writes into Yout.
// ---------------------------------------------------------------------------
function applyLumaEdit(Y, gField, bField, width, height, Yout, pivot) {
  const n = width * height;
  const pv = pivot == null ? 128 : pivot;
  for (let i = 0; i < n; i++) {
    let v = gField[i] * (Y[i] - pv) + pv + bField[i];
    if (v < 0) v = 0; else if (v > 255) v = 255;
    Yout[i] = v;
  }
}

// ---------------------------------------------------------------------------
// SSIM — Wang et al. 2004, 11x11 Gaussian (sigma 1.5), k1=0.01, k2=0.03,
// dynamic range L=255. Computed on luma. Returns the mean over the 'valid'
// region (5px border cropped, as in the reference implementations).
// ---------------------------------------------------------------------------

function gaussianKernel1D(size, sigma) {
  const k = new Float32Array(size);
  const c = (size - 1) / 2;
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const d = i - c;
    k[i] = Math.exp(-(d * d) / (2 * sigma * sigma));
    sum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= sum; // normalise -> weights sum to 1
  return k;
}

// Separable convolution with clamp (replicate) padding. src,dst Float32Array.
function convolveSeparable(src, width, height, kernel, tmp, dst) {
  const ks = kernel.length;
  const r = (ks - 1) / 2;
  // horizontal
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let t = 0; t < ks; t++) {
        let xx = x + t - r;
        if (xx < 0) xx = 0; else if (xx >= width) xx = width - 1;
        acc += src[row + xx] * kernel[t];
      }
      tmp[row + x] = acc;
    }
  }
  // vertical
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let t = 0; t < ks; t++) {
        let yy = y + t - r;
        if (yy < 0) yy = 0; else if (yy >= height) yy = height - 1;
        acc += tmp[yy * width + x] * kernel[t];
      }
      dst[y * width + x] = acc;
    }
  }
}

// Returns { mssim, map } . map is the per-pixel SSIM (full size; border values
// are computed with clamp padding but excluded from mssim).
function ssim(a, b, width, height, opts) {
  opts = opts || {};
  const L = opts.L != null ? opts.L : 255;
  const k1 = opts.k1 != null ? opts.k1 : 0.01;
  const k2 = opts.k2 != null ? opts.k2 : 0.03;
  const C1 = (k1 * L) * (k1 * L);
  const C2 = (k2 * L) * (k2 * L);
  const win = opts.win || 11;
  const sigma = opts.sigma || 1.5;
  const border = (win - 1) / 2;

  if (width < win || height < win) {
    // too small for the window; fall back to a global single-window SSIM
    return globalSSIM(a, b, width * height, C1, C2);
  }

  const kernel = gaussianKernel1D(win, sigma);
  const n = width * height;
  const tmp = new Float32Array(n);
  const mu_a = new Float32Array(n);
  const mu_b = new Float32Array(n);
  const aa = new Float32Array(n);
  const bb = new Float32Array(n);
  const ab = new Float32Array(n);
  for (let i = 0; i < n; i++) { aa[i] = a[i] * a[i]; bb[i] = b[i] * b[i]; ab[i] = a[i] * b[i]; }

  convolveSeparable(a, width, height, kernel, tmp, mu_a);
  convolveSeparable(b, width, height, kernel, tmp, mu_b);
  const s_aa = new Float32Array(n), s_bb = new Float32Array(n), s_ab = new Float32Array(n);
  convolveSeparable(aa, width, height, kernel, tmp, s_aa);
  convolveSeparable(bb, width, height, kernel, tmp, s_bb);
  convolveSeparable(ab, width, height, kernel, tmp, s_ab);

  const map = new Float32Array(n);
  let sum = 0, cnt = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const ma = mu_a[i], mb = mu_b[i];
      const ma2 = ma * ma, mb2 = mb * mb, mab = ma * mb;
      const va = s_aa[i] - ma2;        // sigma_a^2
      const vb = s_bb[i] - mb2;        // sigma_b^2
      const vab = s_ab[i] - mab;       // sigma_ab
      const num = (2 * mab + C1) * (2 * vab + C2);
      const den = (ma2 + mb2 + C1) * (va + vb + C2);
      const s = num / den;
      map[i] = s;
      if (x >= border && x < width - border && y >= border && y < height - border) {
        sum += s; cnt++;
      }
    }
  }
  return { mssim: cnt ? sum / cnt : 0, map };
}

// Single-window SSIM for tiny images (no spatial map).
function globalSSIM(a, b, n, C1, C2) {
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let va = 0, vb = 0, vab = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    va += da * da; vb += db * db; vab += da * db;
  }
  va /= (n - 1); vb /= (n - 1); vab /= (n - 1);
  const num = (2 * ma * mb + C1) * (2 * vab + C2);
  const den = (ma * ma + mb * mb + C1) * (va + vb + C2);
  return { mssim: num / den, map: null };
}

// ---------------------------------------------------------------------------
// Auxiliary metrics on luma: PSNR and mean/max |delta|.
// SSIM says "looks the same"; these say "how far the luma pattern moved".
// ---------------------------------------------------------------------------
function lumaStats(a, b, n) {
  let sse = 0, sumAbs = 0, maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    const ad = d < 0 ? -d : d;
    sse += d * d; sumAbs += ad;
    if (ad > maxAbs) maxAbs = ad;
  }
  const mse = sse / n;
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  return { mse, psnr, meanAbs: sumAbs / n, maxAbs };
}

// ---------------------------------------------------------------------------
// Piece count -> near-square grid, biased to the aspect ratio.
// ---------------------------------------------------------------------------
function piecesToGrid(nPieces, width, height) {
  nPieces = Math.max(1, Math.round(nPieces));
  let cols = Math.max(1, Math.round(Math.sqrt(nPieces * width / height)));
  let rows = Math.max(1, Math.round(nPieces / cols));
  return { cols, rows };
}

const PipelineAPI = {
  rgbaToYCbCr, yCbCrToRgba, clamp8,
  mulberry32, buildControlGrid, smoothstep, interpolateField, applyLumaEdit,
  gaussianKernel1D, convolveSeparable, ssim, globalSSIM, lumaStats, piecesToGrid,
};

if (typeof module !== 'undefined' && module.exports) module.exports = PipelineAPI;
if (typeof window !== 'undefined') window.Pipeline = PipelineAPI;
