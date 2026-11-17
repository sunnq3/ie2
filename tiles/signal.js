/*
 * signal.js — transforms that make a REAL, measurable change to an image's
 * signature while staying close to visually identical. All operate on luma.
 *
 * Three transforms, each honest about what it moves and what it does not:
 *
 *   1. dctBand   — perturbs mid/high-band 8x8 DCT coefficients. Moves the
 *                  block-DCT coefficient statistics that JPEG-domain and
 *                  double-compression forensics inspect. Does NOT target any
 *                  specific detector's threshold; it shifts the distribution.
 *
 *   2. warp      — a smooth sub-pixel non-uniform resample. Rewrites every
 *                  pixel's provenance through interpolation, which both leaves
 *                  a resampling trace (Popescu-Farid style periodic
 *                  correlation) and disturbs one already present, and moves
 *                  perceptual hashes. Does NOT geometrically "hide" anything.
 *
 *   3. noise     — a multiplicative high-frequency field, the PRNU *model*
 *                  Y*(1 + k*N). Changes the noise residual a denoise-and-
 *                  subtract extractor recovers. This is NOT forging a real
 *                  camera's fingerprint — that needs the reference PRNU — it
 *                  only perturbs the residual.
 *
 * The tile grid supplies a smooth [0,1] strength field so each transform can
 * be strong in some regions and weak in others, with no seam.
 *
 * Pure functions, no DOM. Runs in Node (tests import it) and the browser.
 */

var P = (typeof module !== 'undefined' && module.exports)
  ? require('./pipeline.js')
  : (typeof window !== 'undefined' ? window.Pipeline : null);

// ---------------------------------------------------------------------------
// Smooth strength / displacement field from the tile grid.
// Returns Float32Array in [0,1] (range='unit') or [-1,1] (range='signed').
// ---------------------------------------------------------------------------
function smoothField(gx, gy, width, height, seed, uniform, range) {
  var nodesX = gx + 1, nodesY = gy + 1, count = nodesX * nodesY;
  var nodes = new Float32Array(count);
  if (uniform) {
    nodes.fill(range === 'signed' ? 0 : 1); // uniform: full strength / no displacement bias
    // a signed uniform field of 0 would mean "no warp"; for uniform warp we
    // still want motion, so uniform signed uses a single shared draw instead:
    if (range === 'signed') {
      var r0 = P.mulberry32((seed >>> 0) || 1);
      nodes.fill(r0() * 2 - 1);
    }
  } else {
    var rnd = P.mulberry32((seed >>> 0) || 1);
    for (var i = 0; i < count; i++) nodes[i] = range === 'signed' ? (rnd() * 2 - 1) : rnd();
  }
  var grid = { gx: gx, gy: gy, nodesX: nodesX, nodesY: nodesY, gain: nodes, offset: new Float32Array(count) };
  var f = new Float32Array(width * height);
  var tmp = new Float32Array(width * height);
  P.interpolateField(grid, width, height, 'smooth', f, tmp);
  return f;
}

// ===========================================================================
// 1. 8x8 orthonormal DCT-II and mid/high-band perturbation
// ===========================================================================

// Precompute the 8-point orthonormal DCT matrix M[k*8+n].
// Forward block:  F = M * f * M^T    Inverse: f = M^T * F * M
var DCTM = (function () {
  var M = new Float32Array(64);
  for (var k = 0; k < 8; k++) {
    var ck = k === 0 ? Math.sqrt(1 / 8) : Math.sqrt(2 / 8);
    for (var n = 0; n < 8; n++) {
      M[k * 8 + n] = ck * Math.cos(Math.PI * (2 * n + 1) * k / 16);
    }
  }
  return M;
})();

// forward 8x8 DCT of one block (row-major 64) -> coeffs (row-major 64)
function fdct8x8(block, out) {
  var t = fdct8x8._t || (fdct8x8._t = new Float32Array(64));
  // t = M * block  (apply DCT down columns: treat block rows as vectors)
  for (var k = 0; k < 8; k++) {
    for (var j = 0; j < 8; j++) {
      var s = 0;
      for (var n = 0; n < 8; n++) s += DCTM[k * 8 + n] * block[n * 8 + j];
      t[k * 8 + j] = s;
    }
  }
  // out = t * M^T  (apply DCT along rows)
  for (var r = 0; r < 8; r++) {
    for (var v = 0; v < 8; v++) {
      var s2 = 0;
      for (var m = 0; m < 8; m++) s2 += t[r * 8 + m] * DCTM[v * 8 + m];
      out[r * 8 + v] = s2;
    }
  }
}

// inverse 8x8 DCT of coeffs -> block
function idct8x8(coeffs, out) {
  var t = idct8x8._t || (idct8x8._t = new Float32Array(64));
  // t = M^T * coeffs
  for (var n = 0; n < 8; n++) {
    for (var v = 0; v < 8; v++) {
      var s = 0;
      for (var k = 0; k < 8; k++) s += DCTM[k * 8 + n] * coeffs[k * 8 + v];
      t[n * 8 + v] = s;
    }
  }
  // out = t * M
  for (var r = 0; r < 8; r++) {
    for (var c = 0; c < 8; c++) {
      var s2 = 0;
      for (var m = 0; m < 8; m++) s2 += t[r * 8 + m] * DCTM[m * 8 + c];
      out[r * 8 + c] = s2;
    }
  }
}

// Perturb mid/high-band DCT coefficients blockwise.
// opts: { amount, bandLo, bandHi, seed, strength:Float32Array|null, measure }
// band selected by radial index (u+v) in [bandLo, bandHi].
// Writes edited luma into Yout. Returns {meanAbsDeltaCoef, coefCount}.
function dctBand(Y, width, height, Yout, opts) {
  var amount = opts.amount || 0;
  var bandLo = opts.bandLo == null ? 4 : opts.bandLo;
  var bandHi = opts.bandHi == null ? 10 : opts.bandHi;
  var strength = opts.strength || null;
  var rnd = P.mulberry32((opts.seed >>> 0) || 1);

  // band mask
  var mask = new Uint8Array(64);
  var bandN = 0;
  for (var u = 0; u < 8; u++) for (var v = 0; v < 8; v++) {
    if (u + v >= bandLo && u + v <= bandHi) { mask[u * 8 + v] = 1; bandN++; }
  }

  // pad to multiples of 8 by edge replication into a working buffer
  var bw = Math.ceil(width / 8) * 8, bh = Math.ceil(height / 8) * 8;
  var pad = new Float32Array(bw * bh);
  for (var y = 0; y < bh; y++) {
    var sy = y < height ? y : height - 1;
    for (var x = 0; x < bw; x++) {
      var sx = x < width ? x : width - 1;
      pad[y * bw + x] = Y[sy * width + sx];
    }
  }

  var block = new Float32Array(64), coef = new Float32Array(64), rec = new Float32Array(64);
  var sumAbs = 0, cnt = 0;
  for (var by = 0; by < bh; by += 8) {
    for (var bx = 0; bx < bw; bx += 8) {
      // local strength at block center (0..1), default 1
      var s = 1;
      if (strength) {
        var cxp = Math.min(width - 1, bx + 4), cyp = Math.min(height - 1, by + 4);
        s = strength[cyp * width + cxp];
      }
      // load block
      for (var yy = 0; yy < 8; yy++) for (var xx = 0; xx < 8; xx++)
        block[yy * 8 + xx] = pad[(by + yy) * bw + (bx + xx)];
      fdct8x8(block, coef);
      // perturb band coefficients (additive, seeded, scaled by strength)
      for (var i = 0; i < 64; i++) {
        if (mask[i]) {
          var d = (rnd() * 2 - 1) * amount * s;
          coef[i] += d;
          sumAbs += Math.abs(d); cnt++;
        } else {
          // still advance RNG deterministically? No — only draw for band coeffs
        }
      }
      idct8x8(coef, rec);
      // write back only the in-image pixels
      for (var ry = 0; ry < 8; ry++) {
        var oy = by + ry; if (oy >= height) break;
        for (var rx = 0; rx < 8; rx++) {
          var ox = bx + rx; if (ox >= width) break;
          var val = rec[ry * 8 + rx];
          Yout[oy * width + ox] = val < 0 ? 0 : val > 255 ? 255 : val;
        }
      }
    }
  }
  return { meanAbsDeltaCoef: cnt ? sumAbs / cnt : 0, coefCount: cnt, bandSize: bandN };
}

// ===========================================================================
// 2. Sub-pixel non-uniform resample (warp)
// ===========================================================================
// Yout(x,y) = bilinear sample of Y at (x + ampX*fx(x,y), y + ampY*fy(x,y)),
// where fx,fy are smooth signed [-1,1] fields. Clamps sample coords.
function warp(Y, width, height, Yout, opts) {
  var ampX = opts.ampX || 0, ampY = opts.ampY || 0;
  var fx = opts.fieldX, fy = opts.fieldY;
  var sumD = 0, maxD = 0;
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      var i = y * width + x;
      var dx = ampX * (fx ? fx[i] : 0);
      var dy = ampY * (fy ? fy[i] : 0);
      var d = Math.sqrt(dx * dx + dy * dy);
      sumD += d; if (d > maxD) maxD = d;
      var sxf = x + dx, syf = y + dy;
      // clamp
      if (sxf < 0) sxf = 0; else if (sxf > width - 1) sxf = width - 1;
      if (syf < 0) syf = 0; else if (syf > height - 1) syf = height - 1;
      var x0 = sxf | 0, y0 = syf | 0;
      var x1 = x0 + 1 < width ? x0 + 1 : x0;
      var y1 = y0 + 1 < height ? y0 + 1 : y0;
      var tx = sxf - x0, ty = syf - y0;
      var a = Y[y0 * width + x0], b = Y[y0 * width + x1];
      var c = Y[y1 * width + x0], e = Y[y1 * width + x1];
      var top = a + (b - a) * tx, bot = c + (e - c) * tx;
      Yout[i] = top + (bot - top) * ty;
    }
  }
  var n = width * height;
  return { meanDisp: sumD / n, maxDisp: maxD };
}

// ===========================================================================
// 3. Multiplicative high-frequency noise (PRNU model)
// ===========================================================================
// Yout = Y * (1 + k * strength * N), N ~ zero-mean unit white noise.
// Returns residual std of (Yout - Y).
function noise(Y, width, height, Yout, opts) {
  var k = opts.amount || 0;
  var strength = opts.strength || null;
  var rnd = P.mulberry32((opts.seed >>> 0) || 1);
  var n = width * height;
  var sse = 0;
  for (var i = 0; i < n; i++) {
    // Box-Muller-ish: uniform in [-1,1]*sqrt(3) -> unit variance, fast
    var N = (rnd() * 2 - 1) * 1.7320508;
    var s = strength ? strength[i] : 1;
    var v = Y[i] * (1 + k * s * N);
    if (v < 0) v = 0; else if (v > 255) v = 255;
    var d = v - Y[i]; sse += d * d;
    Yout[i] = v;
  }
  return { residualStd: Math.sqrt(sse / n) };
}

var SignalAPI = { smoothField, DCTM, fdct8x8, idct8x8, dctBand, warp, noise };
if (typeof module !== 'undefined' && module.exports) module.exports = SignalAPI;
if (typeof window !== 'undefined') window.Signal = SignalAPI;
