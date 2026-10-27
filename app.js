'use strict';

const $ = (s) => document.querySelector(s);
const clone = (o) => JSON.parse(JSON.stringify(o));

const DEFAULTS = {
  clean: {
    position: 'start',
    deblock: { on: false, threshold: 8, strength: 100 },
    pattern: { on: false, sensitivity: 4, strength: 100, protect: 6, tile: '256' },
    deband: { on: false, radius: 16, threshold: 3, grain: 0.6, passes: 1 },
  },
  carve: { dw: 0, dh: 0, energy: 'forward' },
  lens: { k1: 0, k2: 0, cx: 0, cy: 0, zoom: 1, autofill: true, interp: 'bicubic' },
  ca: {
    linear: true,
    rx: 0, ry: 0, gx: 0, gy: 0, bx: 0, by: 0, rs: 0, gs: 0, bs: 0,
    fall: { curve: 'power', exp: 1, start: 0, width: 30, aspect: 0, shifts: false },
    disp: { on: false, lens: 'achromat', amount: 0.3, bands: 10, balance: 550 },
    irr: { on: false, amount: 0.5, scale: 80, detail: 2, lockg: true, fall: false, seed: 1 },
    axial: { on: false, r: 0, g: 0, b: 0.6, edge: 0 },
    smear: { on: false, dir: 'radial', angle: 0, r: 0.8, g: 0, b: -0.8, mode: 'trail', follow: true },
    echo: { on: false, count: 2, decay: 0.45, spacing: 1 },
    cl: { on: false, cbx: 0.6, cby: 0, crx: -0.6, cry: 0, bleed: 0, soft: 0 },
    pf: { on: false, amount: 50, thr: 215, width: 2, bias: 0.6, hue: 285, edge: 40 },
  },
  color: {
    iterations: 1,
    linear: { on: false, bits: 8 },
    p3: { on: false, bits: 8 },
    lab: { on: false, bits: 8 },
    hsv: { on: false, bits: 8 },
    hsl: { on: false, bits: 8 },
    ycc: { on: false, bits: 8, matrix: '601', range: 'full', sub: '444' },
  },
  scale: { up: 1, upMethod: 'bicubic', final: 100, downMethod: 'lanczos3', quant: true },
  noise: { amount: 0, type: 'gaussian', density: 100, chroma: 0, grain: 1, irregular: 0, irrScale: 32, seed: 1, scope: 'all' },
  brush: { size: 24, hard: 50, opacity: 100, mode: 'add', display: 'outline' },
  sensor: { on: false, shot: 0.05, read: 0.02, rgain: 30, bgain: 50, chromaNR: 60, aa: 0.3, demosaic: 'mhc', pattern: 'RGGB', seed: 1, useMask: false },
  out: { quality: 92, sub: '444', hf: 30, dither: 60, name: '' },
};
const NOPROCESS = ['out.', 'brush.'];

const SCHEMA = [
  {
    id: 'clean', title: '0 · Clean up banding & patterns',
    note: 'Removes JPEG block edges, repeating patterns (moiré, halftone dots, grids, scan lines) and gradient banding. Use Diff to see exactly what changed.',
    controls: [
      { k: 'clean.position', label: 'Run', type: 'select', options: [['start', 'First (fix the source image)'], ['end', 'After colour & scale, before noise']] },
      { k: 'clean.deblock.on', label: 'Deblock (JPEG 8×8 grid)', type: 'check', group: 'start' },
      { k: 'clean.deblock.threshold', label: 'Max step', type: 'range', min: 1, max: 30, step: 0.1, unit: 'lvl', sub: true },
      { k: 'clean.deblock.strength', label: 'Strength', type: 'range', min: 0, max: 100, step: 1, unit: '%', sub: true },
      { k: 'clean.pattern.on', label: 'Remove repeating patterns', type: 'check', group: 'start' },
      { k: 'clean.pattern.sensitivity', label: 'Threshold', type: 'range', min: 1.5, max: 20, step: 0.1, unit: '×', sub: true },
      { k: 'clean.pattern.strength', label: 'Strength', type: 'range', min: 0, max: 100, step: 1, unit: '%', sub: true },
      { k: 'clean.pattern.protect', label: 'Keep detail <', type: 'range', min: 0, max: 40, step: 0.1, unit: '%', sub: true },
      { k: 'clean.pattern.tile', label: 'Window', type: 'select', sub: true, options: [['128', '128 px (local)'], ['256', '256 px'], ['512', '512 px (fine frequencies)']] },
      { k: 'clean.deband.on', label: 'Deband gradients', type: 'check', group: 'start' },
      { k: 'clean.deband.radius', label: 'Radius', type: 'range', min: 2, max: 64, step: 1, unit: 'px', sub: true },
      { k: 'clean.deband.threshold', label: 'Threshold', type: 'range', min: 0.5, max: 12, step: 0.1, unit: 'lvl', sub: true },
      { k: 'clean.deband.grain', label: 'Dither', type: 'range', min: 0, max: 3, step: 0.01, unit: 'lvl', sub: true },
      { k: 'clean.deband.passes', label: 'Passes', type: 'range', min: 1, max: 4, step: 1, sub: true },
    ],
  },
  {
    id: 'carve', title: '1 · Content-aware scale',
    note: 'Seam carving. Negative removes, positive inserts low-energy pixel paths. Values are pixels.',
    controls: [
      { k: 'carve.dw', label: 'Width Δ', type: 'range', min: -100, max: 100, step: 1, unit: 'px' },
      { k: 'carve.dh', label: 'Height Δ', type: 'range', min: -100, max: 100, step: 1, unit: 'px' },
      { k: 'carve.energy', label: 'Energy', type: 'select', options: [['forward', 'Forward energy'], ['gradient', 'Gradient (backward)']] },
    ],
  },
  {
    id: 'ca', title: '2 · Chromatic aberration',
    note: 'Lateral shift/scale per channel, shaped by the radial falloff curve. Each effect below has its own switch; they all run in the same resample as the lens warp.',
    controls: [
      { type: 'head', label: 'Lateral' },
      { k: 'ca.linear', label: 'Mix in linear light (camera-like)', type: 'check' },
      { k: 'ca.rx', label: 'Red X', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px' },
      { k: 'ca.ry', label: 'Red Y', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px' },
      { k: 'ca.gx', label: 'Green X', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px' },
      { k: 'ca.gy', label: 'Green Y', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px' },
      { k: 'ca.bx', label: 'Blue X', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px' },
      { k: 'ca.by', label: 'Blue Y', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px' },
      { k: 'ca.rs', label: 'Red radial', type: 'range', min: -1, max: 1, step: 0.001, unit: '%' },
      { k: 'ca.gs', label: 'Green radial', type: 'range', min: -1, max: 1, step: 0.001, unit: '%' },
      { k: 'ca.bs', label: 'Blue radial', type: 'range', min: -1, max: 1, step: 0.001, unit: '%' },

      { type: 'head', label: 'Radial falloff' },
      { k: 'ca.fall.curve', label: 'Curve', type: 'select', options: [['power', 'Power (rⁿ)'], ['smooth', 'S-curve'], ['ring', 'Ring (peaks at a radius)']] },
      { k: 'ca.fall.exp', label: 'Exponent', type: 'range', min: 0.1, max: 6, step: 0.01 },
      { k: 'ca.fall.start', label: 'Start / ring r', type: 'range', min: 0, max: 95, step: 0.1, unit: '%' },
      { k: 'ca.fall.width', label: 'Ring width', type: 'range', min: 2, max: 100, step: 0.1, unit: '%' },
      { k: 'ca.fall.aspect', label: 'Aspect', type: 'range', min: -60, max: 60, step: 0.1, unit: '%' },
      { k: 'ca.fall.shifts', label: 'Falloff also scales X/Y shifts', type: 'check' },

      { k: 'ca.disp.on', label: 'Spectral dispersion', type: 'check', group: 'start' },
      { k: 'ca.disp.lens', label: 'Lens', type: 'select', sub: true, options: [['achromat', 'Achromat (green/magenta)'], ['singlet', 'Simple lens (blue/yellow)'], ['prism', 'Prism (rainbow)']] },
      { k: 'ca.disp.amount', label: 'Amount', type: 'range', min: -2, max: 2, step: 0.001, unit: '%', sub: true },
      { k: 'ca.disp.bands', label: 'Bands', type: 'range', min: 3, max: 32, step: 1, sub: true },
      { k: 'ca.disp.balance', label: 'Neutral λ', type: 'range', min: 430, max: 680, step: 1, unit: 'nm', sub: true },

      { k: 'ca.irr.on', label: 'Irregular CA field', type: 'check', group: 'start' },
      { k: 'ca.irr.amount', label: 'Amount', type: 'range', min: 0, max: 4, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.irr.scale', label: 'Patch size', type: 'range', min: 4, max: 600, step: 1, unit: 'px', sub: true },
      { k: 'ca.irr.detail', label: 'Detail', type: 'range', min: 1, max: 5, step: 1, sub: true },
      { k: 'ca.irr.seed', label: 'Seed', type: 'range', min: 1, max: 9999, step: 1, extra: 'seed', sub: true },
      { k: 'ca.irr.lockg', label: 'Keep green steady', type: 'check', sub: true },
      { k: 'ca.irr.fall', label: 'Follow radial falloff', type: 'check', sub: true },

      { k: 'ca.axial.on', label: 'Axial CA (per-channel defocus)', type: 'check', group: 'start' },
      { k: 'ca.axial.r', label: 'Red blur', type: 'range', min: 0, max: 4, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.axial.g', label: 'Green blur', type: 'range', min: 0, max: 4, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.axial.b', label: 'Blue blur', type: 'range', min: 0, max: 4, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.axial.edge', label: 'Edge weight', type: 'range', min: 0, max: 100, step: 0.1, unit: '%', sub: true },

      { k: 'ca.smear.on', label: 'Directional smear', type: 'check', group: 'start' },
      { k: 'ca.smear.dir', label: 'Direction', type: 'select', sub: true, options: [['radial', 'Radial (from centre)'], ['tangential', 'Tangential (around centre)'], ['fixed', 'Fixed angle']] },
      { k: 'ca.smear.angle', label: 'Angle', type: 'range', min: -180, max: 180, step: 0.1, unit: '°', sub: true },
      { k: 'ca.smear.r', label: 'R length', type: 'range', min: -10, max: 10, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.smear.g', label: 'G length', type: 'range', min: -10, max: 10, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.smear.b', label: 'B length', type: 'range', min: -10, max: 10, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.smear.mode', label: 'Shape', type: 'select', sub: true, options: [['trail', 'Trail (one-sided, fading)'], ['centered', 'Centred (both ways)']] },
      { k: 'ca.smear.follow', label: 'Follow radial falloff', type: 'check', sub: true },

      { k: 'ca.echo.on', label: 'Echo passes (ghost fringes)', type: 'check', group: 'start' },
      { k: 'ca.echo.count', label: 'Echoes', type: 'range', min: 1, max: 8, step: 1, sub: true },
      { k: 'ca.echo.decay', label: 'Decay', type: 'range', min: 0.05, max: 1, step: 0.01, sub: true },
      { k: 'ca.echo.spacing', label: 'Spacing', type: 'range', min: 0.25, max: 4, step: 0.01, unit: '×', sub: true },

      { k: 'ca.cl.on', label: 'Chroma vs luma shift', type: 'check', group: 'start' },
      { k: 'ca.cl.cbx', label: 'Cb X', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.cl.cby', label: 'Cb Y', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.cl.crx', label: 'Cr X', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.cl.cry', label: 'Cr Y', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.cl.bleed', label: 'Bleed', type: 'range', min: 0, max: 12, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.cl.soft', label: 'Chroma blur', type: 'range', min: 0, max: 4, step: 0.01, unit: 'px', sub: true },

      { k: 'ca.pf.on', label: 'Purple fringing', type: 'check', group: 'start' },
      { k: 'ca.pf.amount', label: 'Amount', type: 'range', min: 0, max: 100, step: 0.1, unit: '%', sub: true },
      { k: 'ca.pf.thr', label: 'Highlight ≥', type: 'range', min: 100, max: 255, step: 0.5, unit: 'lvl', sub: true },
      { k: 'ca.pf.width', label: 'Width', type: 'range', min: 0.3, max: 12, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.pf.bias', label: 'Outward', type: 'range', min: -6, max: 6, step: 0.01, unit: 'px', sub: true },
      { k: 'ca.pf.hue', label: 'Hue', type: 'range', min: 0, max: 360, step: 0.5, unit: '°', sub: true },
      { k: 'ca.pf.edge', label: 'Edge weight', type: 'range', min: 0, max: 100, step: 0.1, unit: '%', sub: true },
    ],
  },
  {
    id: 'lens', title: '3 · Elastic warp (lens distortion)',
    note: 'Radial model r·(1 + k1·r² + k2·r⁴). Positive k = barrel, negative k = pincushion.',
    controls: [
      { k: 'lens.k1', label: 'k1', type: 'range', min: -0.1, max: 0.1, step: 0.0001 },
      { k: 'lens.k2', label: 'k2', type: 'range', min: -0.05, max: 0.05, step: 0.0001 },
      { k: 'lens.cx', label: 'Centre X', type: 'range', min: -10, max: 10, step: 0.01, unit: '%' },
      { k: 'lens.cy', label: 'Centre Y', type: 'range', min: -10, max: 10, step: 0.01, unit: '%' },
      { k: 'lens.zoom', label: 'Scale', type: 'range', min: 0.95, max: 1.05, step: 0.0001, unit: '×' },
      { k: 'lens.autofill', label: 'Auto-scale to fill frame (no empty edges)', type: 'check' },
      { k: 'lens.interp', label: 'Resampling', type: 'select', options: [['bicubic', 'Bicubic'], ['bilinear', 'Bilinear']] },
    ],
  },
  {
    id: 'color', title: '4 · Colour-space roundtrip',
    note: 'Each enabled stage converts RGB → space → RGB with the intermediate stored at the given precision, then back to 8-bit. Stages run in this order, repeated per pass.',
    controls: [
      { k: 'color.iterations', label: 'Passes', type: 'range', min: 1, max: 10, step: 1 },
      { k: 'color.linear.on', label: 'sRGB ↔ linear light', type: 'check', group: 'start' },
      { k: 'color.linear.bits', label: 'Precision', type: 'range', min: 4, max: 16, step: 0.01, unit: 'bit', sub: true },
      { k: 'color.p3.on', label: 'sRGB ↔ Display P3', type: 'check', group: 'start' },
      { k: 'color.p3.bits', label: 'Precision', type: 'range', min: 4, max: 16, step: 0.01, unit: 'bit', sub: true },
      { k: 'color.lab.on', label: 'sRGB ↔ CIE L*a*b*', type: 'check', group: 'start' },
      { k: 'color.lab.bits', label: 'Precision', type: 'range', min: 4, max: 16, step: 0.01, unit: 'bit', sub: true },
      { k: 'color.hsv.on', label: 'RGB ↔ HSV', type: 'check', group: 'start' },
      { k: 'color.hsv.bits', label: 'Precision', type: 'range', min: 4, max: 16, step: 0.01, unit: 'bit', sub: true },
      { k: 'color.hsl.on', label: 'RGB ↔ HSL', type: 'check', group: 'start' },
      { k: 'color.hsl.bits', label: 'Precision', type: 'range', min: 4, max: 16, step: 0.01, unit: 'bit', sub: true },
      { k: 'color.ycc.on', label: 'RGB ↔ YCbCr', type: 'check', group: 'start' },
      { k: 'color.ycc.bits', label: 'Precision', type: 'range', min: 4, max: 16, step: 0.01, unit: 'bit', sub: true },
      { k: 'color.ycc.matrix', label: 'Matrix', type: 'select', sub: true, options: [['601', 'BT.601'], ['709', 'BT.709'], ['2020', 'BT.2020']] },
      { k: 'color.ycc.range', label: 'Range', type: 'select', sub: true, options: [['full', 'Full (0–255)'], ['limited', 'Limited (16–235)']] },
      { k: 'color.ycc.sub', label: 'Chroma', type: 'select', sub: true, options: [['444', '4:4:4'], ['422', '4:2:2'], ['420', '4:2:0']] },
    ],
  },
  {
    id: 'scale', title: '5 · Upscale → downscale',
    note: 'Enlarges the image by the factor, then shrinks it to the final size (100 % = same size as before this step). Runs last, right before export.',
    controls: [
      { k: 'scale.up', label: 'Upscale', type: 'range', min: 1, max: 6, step: 0.01, unit: '×' },
      { k: 'scale.upMethod', label: 'Up filter', type: 'select', options: [['bicubic', 'Bicubic'], ['lanczos3', 'Lanczos 3'], ['mitchell', 'Mitchell'], ['bilinear', 'Bilinear'], ['nearest', 'Nearest']] },
      { k: 'scale.final', label: 'Final size', type: 'range', min: 25, max: 200, step: 0.01, unit: '%' },
      { k: 'scale.downMethod', label: 'Down filter', type: 'select', options: [['lanczos3', 'Lanczos 3'], ['bicubic', 'Bicubic'], ['mitchell', 'Mitchell'], ['bilinear', 'Bilinear'], ['box', 'Box (area)'], ['nearest', 'Nearest']] },
      { k: 'scale.quant', label: 'Store the upscaled image at 8-bit', type: 'check' },
    ],
  },
  {
    id: 'noise', title: '6 · Noise distribution',
    note: 'Amount is the noise strength in 8-bit levels. Paint where it goes with the brush below, or apply it to the whole image.',
    controls: [
      { k: 'noise.amount', label: 'Amount', type: 'range', min: 0, max: 10, step: 0.01, unit: 'lvl', nmax: 255 },
      { k: 'noise.type', label: 'Distribution', type: 'select', options: [['gaussian', 'Gaussian'], ['uniform', 'Uniform'], ['laplacian', 'Laplacian (spiky)'], ['impulse', 'Impulse (± specks)'], ['shot', 'Shot (brightness-dependent)']] },
      { k: 'noise.density', label: 'Density', type: 'range', min: 0, max: 100, step: 0.01, unit: '%' },
      { k: 'noise.chroma', label: 'Colour', type: 'range', min: 0, max: 100, step: 0.1, unit: '%' },
      { k: 'noise.grain', label: 'Grain size', type: 'range', min: 1, max: 8, step: 0.01, unit: 'px' },
      { k: 'noise.irregular', label: 'Irregularity', type: 'range', min: 0, max: 100, step: 0.1, unit: '%' },
      { k: 'noise.irrScale', label: 'Patch size', type: 'range', min: 2, max: 400, step: 1, unit: 'px', sub: true },
      { k: 'noise.seed', label: 'Seed', type: 'range', min: 1, max: 9999, step: 1, extra: 'seed' },
      { k: 'noise.scope', label: 'Apply to', type: 'select', options: [['all', 'Whole image'], ['inside', 'Painted areas only'], ['outside', 'Everywhere except painted']] },
      { type: 'buttons', group: 'start', buttons: [['paint', 'Paint mask'], ['erase', 'Erase'], ['undo', 'Undo'], ['clear', 'Clear']] },
      { k: 'brush.size', label: 'Brush size', type: 'range', min: 1, max: 300, step: 0.5, unit: 'px', nmax: 5000 },
      { k: 'brush.hard', label: 'Hardness', type: 'range', min: 0, max: 100, step: 1, unit: '%' },
      { k: 'brush.opacity', label: 'Opacity', type: 'range', min: 1, max: 100, step: 0.1, unit: '%' },
      { k: 'brush.display', label: 'Mask view', type: 'select', options: [['outline', 'Thin outline'], ['tint', 'Tinted fill'], ['hidden', 'Hidden']] },
    ],
  },
  {
    id: 'sensor', title: '7 · Sensor grain (raw camera look)',
    note: 'Runs last. Rebuilds the image like a camera: linear light → AA filter → Bayer colour filter → photon (shot) + read noise per photosite → demosaic → in-camera chroma noise reduction. The grain comes out correlated over ~2 px like real camera noise, which survives JPEG far better than 1-px noise.',
    controls: [
      { k: 'sensor.on', label: 'Simulate camera sensor', type: 'check' },
      { k: 'sensor.shot', label: 'Shot noise', type: 'range', min: 0, max: 0.5, step: 0.001, sub: true },
      { k: 'sensor.read', label: 'Read noise', type: 'range', min: 0, max: 0.3, step: 0.001, sub: true },
      { k: 'sensor.rgain', label: 'Red sites +', type: 'range', min: 0, max: 150, step: 1, unit: '%', sub: true },
      { k: 'sensor.bgain', label: 'Blue sites +', type: 'range', min: 0, max: 150, step: 1, unit: '%', sub: true },
      { k: 'sensor.chromaNR', label: 'Chroma NR', type: 'range', min: 0, max: 100, step: 1, unit: '%', sub: true },
      { k: 'sensor.aa', label: 'AA filter', type: 'range', min: 0, max: 1.5, step: 0.01, unit: 'px', sub: true },
      { k: 'sensor.demosaic', label: 'Demosaic', type: 'select', sub: true, options: [['mhc', 'Malvar-He-Cutler (in-camera)'], ['bilinear', 'Bilinear (softer)'], ['none', 'None (1-px noise, no CFA)']] },
      { k: 'sensor.pattern', label: 'Pattern', type: 'select', sub: true, options: [['RGGB', 'RGGB'], ['BGGR', 'BGGR'], ['GRBG', 'GRBG'], ['GBRG', 'GBRG']] },
      { k: 'sensor.seed', label: 'Seed', type: 'range', min: 1, max: 9999, step: 1, extra: 'seed', sub: true },
      { k: 'sensor.useMask', label: 'Only where the noise mask allows (section 6)', type: 'check', sub: true },
    ],
  },
  {
    id: 'out', title: 'Export',
    note: 'Built-in JPEG encoder. 4:4:4 keeps full colour (browsers use 4:2:0). "Grain keep" lowers high-frequency quantisation; "Dithered rounding" lets small detail survive instead of rounding to zero. Check the JPEG view to see exactly what the file will look like.',
    controls: [
      { k: 'out.quality', label: 'JPEG quality', type: 'range', min: 1, max: 100, step: 0.5, unit: '%' },
      { k: 'out.sub', label: 'Chroma', type: 'select', options: [['444', '4:4:4 (full colour)'], ['422', '4:2:2'], ['420', '4:2:0 (browser default)']] },
      { k: 'out.hf', label: 'Grain keep', type: 'range', min: 0, max: 90, step: 1, unit: '%' },
      { k: 'out.dither', label: 'Dithered round', type: 'range', min: 0, max: 100, step: 1, unit: '%' },
      { k: 'out.name', label: 'Filename', type: 'text', placeholder: 'auto' },
    ],
  },
];

/* ---------------- state ---------------- */

let params = loadParams();
let orig = null;         // ImageData
let origName = 'image';
let result = null;       // ImageData
let mask = null;         // Uint8Array (orig dims)
let viewMode = 'result';
let holding = false;
let diffAmp = 16;
let zoomMode = 'fit';
let paintMode = false;
let strokes = [];        // noise mask strokes, normalised to output size
let curStroke = null;
const CTRL = {};

function getPath(o, k) { return k.split('.').reduce((a, p) => (a == null ? a : a[p]), o); }
function setPath(o, k, v) { const ps = k.split('.'); let a = o; for (let i = 0; i < ps.length - 1; i++) a = a[ps[i]]; a[ps[ps.length - 1]] = v; }
function deepMerge(base, over) {
  for (const k in over) {
    if (!(k in base)) continue;
    if (base[k] && typeof base[k] === 'object') deepMerge(base[k], over[k] || {});
    else if (typeof over[k] === typeof base[k]) base[k] = over[k];
  }
  return base;
}
function loadParams() {
  let p = clone(DEFAULTS);
  try { const s = localStorage.getItem('ie2.params'); if (s) p = deepMerge(p, JSON.parse(s)); } catch (e) {}
  return p;
}
function saveParams() { try { localStorage.setItem('ie2.params', JSON.stringify(params)); } catch (e) {} }

/* ---------------- panel ---------------- */

function decimals(step) { const s = String(step); return s.includes('.') ? s.split('.')[1].length : 0; }
function fmt(v, step) { return (+v).toFixed(decimals(step)); }

function makeControl(c) {
  const row = document.createElement('div');
  row.className = 'ctl ' + c.type + (c.sub ? ' sub' : '') + (c.group === 'start' ? ' group' : '');
  const def = c.k ? getPath(DEFAULTS, c.k) : undefined;

  if (c.type === 'range') {
    const lab = document.createElement('label');
    lab.textContent = c.label; lab.title = 'Double-click to reset';
    const r = document.createElement('input');
    r.type = 'range'; r.min = c.min; r.max = c.max; r.step = c.step;
    const n = document.createElement('input');
    n.type = 'number'; n.step = c.step; n.inputMode = 'decimal';
    const u = document.createElement('span'); u.className = 'unit'; u.textContent = c.unit || '';
    const set = (v, fromUser) => {
      r.value = v; n.value = fmt(v, c.step);
      row.classList.toggle('changed', +v !== +def);
      if (fromUser) update(c.k, v);
    };
    r.addEventListener('input', () => set(+r.value, true));
    n.addEventListener('input', () => {
      const v = parseFloat(n.value);
      if (Number.isFinite(v)) { r.value = v; row.classList.toggle('changed', v !== +def); update(c.k, v); }
    });
    n.addEventListener('change', () => { const v = parseFloat(n.value); set(Number.isFinite(v) ? v : def, true); });
    lab.addEventListener('dblclick', () => set(def, true));
    if (c.nmax != null) n.max = c.nmax;
    if (c.extra === 'seed') {
      u.textContent = '';
      const dice = document.createElement('button');
      dice.type = 'button'; dice.className = 'mini dice'; dice.textContent = '⟳'; dice.title = 'New random seed';
      dice.addEventListener('click', () => set(1 + Math.floor(Math.random() * 9999), true));
      u.append(dice);
    }
    row.append(lab, r, n, u);
    CTRL[c.k] = {
      set: (v) => set(v, false),
      setRange: (min, max, nmin, nmax) => { r.min = min; r.max = max; n.min = nmin; n.max = nmax; set(getPath(params, c.k), false); },
    };
  } else if (c.type === 'check') {
    const lab = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox';
    lab.append(cb, document.createTextNode(' ' + c.label));
    cb.addEventListener('change', () => { row.classList.toggle('changed', cb.checked !== def); update(c.k, cb.checked); syncSubs(); });
    row.append(lab);
    CTRL[c.k] = { set: (v) => { cb.checked = !!v; row.classList.toggle('changed', !!v !== def); } };
  } else if (c.type === 'select') {
    const lab = document.createElement('label'); lab.textContent = c.label;
    const s = document.createElement('select');
    for (const [v, t] of c.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; s.append(o); }
    s.addEventListener('change', () => { row.classList.toggle('changed', s.value !== def); update(c.k, s.value); });
    row.append(lab, s);
    CTRL[c.k] = { set: (v) => { s.value = v; row.classList.toggle('changed', v !== def); } };
  } else if (c.type === 'text') {
    const lab = document.createElement('label'); lab.textContent = c.label;
    const t = document.createElement('input'); t.type = 'text'; t.placeholder = c.placeholder || ''; t.spellcheck = false;
    t.addEventListener('input', () => update(c.k, t.value));
    row.append(lab, t);
    CTRL[c.k] = { set: (v) => { t.value = v; }, el: t };
  } else if (c.type === 'head') {
    row.textContent = c.label;
    return row;
  } else if (c.type === 'buttons') {
    for (const [act, text] of c.buttons) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small tool'; b.textContent = text; b.dataset.act = act;
      b.addEventListener('click', () => maskAction(act));
      row.append(b);
    }
    return row;
  }
  row.dataset.k = c.k;
  return row;
}

function buildPanel() {
  const panel = $('#panel');
  panel.innerHTML = '';
  for (const sec of SCHEMA) {
    const det = document.createElement('details');
    det.className = 'sec'; det.open = true; det.dataset.sec = sec.id;
    const sum = document.createElement('summary');
    const t = document.createElement('span'); t.textContent = sec.title;
    const rb = document.createElement('button'); rb.className = 'mini'; rb.type = 'button'; rb.textContent = 'reset';
    rb.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); resetSection(sec); });
    sum.append(t, rb);
    det.append(sum);
    if (sec.note) { const p = document.createElement('p'); p.className = 'note'; p.textContent = sec.note; det.append(p); }
    const body = document.createElement('div'); body.className = 'body';
    for (const c of sec.controls) body.append(makeControl(c));
    det.append(body);
    panel.append(det);
  }
  syncUI();
}

function syncUI() {
  for (const k in CTRL) CTRL[k].set(getPath(params, k));
  syncSubs();
}

function syncSubs() {
  // dim the sub-controls of disabled stages (any "<prefix>.on" checkbox)
  document.querySelectorAll('.ctl.check[data-k$=".on"]').forEach(cb => {
    const pre = cb.dataset.k.slice(0, -2), on = !!getPath(params, cb.dataset.k);
    document.querySelectorAll(`.ctl.sub[data-k^="${pre}"]`).forEach(el => el.classList.toggle('hide', !on));
  });
  const rw = document.querySelector('.ctl[data-k="ca.fall.width"]');
  if (rw) rw.classList.toggle('off', params.ca.fall.curve !== 'ring');
  const ang = document.querySelector('.ctl[data-k="ca.smear.angle"]');
  if (ang) ang.classList.toggle('off', params.ca.smear.dir !== 'fixed');
  const irr = document.querySelector('.ctl[data-k="noise.irrScale"]');
  if (irr) irr.classList.toggle('off', !(+params.noise.irregular > 0));
  document.querySelectorAll('.tool').forEach(b => {
    b.classList.toggle('on', (b.dataset.act === 'paint' && paintMode && params.brush.mode === 'add') || (b.dataset.act === 'erase' && paintMode && params.brush.mode === 'erase'));
  });
}

function resetSection(sec) {
  for (const c of sec.controls) {
    if (!c.k || c.k === 'out.name') continue;
    setPath(params, c.k, clone(getPath(DEFAULTS, c.k)));
  }
  syncUI(); saveParams();
  if (sec.id !== 'out') schedule();
  requestOverlay(true);
}

function update(k, v) {
  setPath(params, k, v);
  saveParams();
  if (k === 'noise.irregular' || k === 'ca.fall.curve' || k === 'ca.smear.dir') syncSubs();
  if (k === 'brush.display') requestOverlay(true);
  if (k.startsWith('out.') && k !== 'out.name' && viewMode === 'jpeg') { clearTimeout(pvTimer); pvTimer = setTimeout(render, 200); }
  if (!NOPROCESS.some(p => k.startsWith(p))) schedule();
}

/* ---------------- worker ---------------- */

let worker = null, jobId = 0, inflight = null, pending = false, workerCarveKey = null, timer = 0;

function cleanOn(C) { return !!(C && ((C.deblock && C.deblock.on) || (C.pattern && C.pattern.on) || (C.deband && C.deband.on))); }
// must match the key the worker builds
function carveKeyOf(p) {
  const ck = cleanOn(p.clean) && p.clean.position !== 'end' ? JSON.stringify(p.clean) : '';
  return `${Math.round(+p.carve.dw || 0)}|${Math.round(+p.carve.dh || 0)}|${p.carve.energy}#${ck}`;
}

function makeWorker() {
  if (worker) worker.terminate();
  worker = new Worker('worker.js');
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => { setStatus('Worker error: ' + (e.message || e), true); inflight = null; hideBar(); };
  workerCarveKey = null;
  if (orig) {
    const copy = orig.data.slice();
    worker.postMessage({ type: 'load', w: orig.width, h: orig.height, buffer: copy.buffer }, [copy.buffer]);
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(dispatch, 80);
}

function dispatch() {
  if (!orig) return;
  const p = clone(params);
  delete p.brush; delete p.out;
  p.noise.strokes = strokes;
  const key = carveKeyOf(p);
  if (inflight) {
    if (inflight.needsCarve && inflight.key !== key) { makeWorker(); inflight = null; }
    else { pending = true; return; }
  }
  const id = ++jobId;
  inflight = { id, key, needsCarve: key !== workerCarveKey };
  worker.postMessage({ type: 'process', id, params: p });
  if (inflight.needsCarve) showBar(0, 'Seam carving');
}

function onWorkerMessage(e) {
  const m = e.data;
  if (!inflight || m.id !== inflight.id) return;
  if (m.type === 'progress') { showBar(m.frac, m.label); return; }
  if (m.type === 'error') {
    setStatus('Error: ' + m.message, true);
    inflight = null; hideBar();
  } else if (m.type === 'result') {
    workerCarveKey = m.carveKey;
    if (m.mask) mask = new Uint8Array(m.mask);
    result = new ImageData(new Uint8ClampedArray(m.buffer), m.w, m.h);
    resultVer++;
    inflight = null; hideBar();
    render();
    updateMeta(m.ms);
    $('#export').disabled = false;
  }
  if (pending) { pending = false; dispatch(); }
}

/* ---------------- viewer ---------------- */

const view = $('#view');
const vctx = view.getContext('2d');
const stage = $('#stage');

function diffImage() {
  if (!result || !orig) return null;
  if (result.width !== orig.width || result.height !== orig.height) return null;
  const a = orig.data, b = result.data, out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i += 4) {
    out[i] = Math.abs(a[i] - b[i]) * diffAmp;
    out[i + 1] = Math.abs(a[i + 1] - b[i + 1]) * diffAmp;
    out[i + 2] = Math.abs(a[i + 2] - b[i + 2]) * diffAmp;
    out[i + 3] = 255;
  }
  return new ImageData(out, orig.width, orig.height);
}

function seamImage() {
  if (!orig) return null;
  const a = orig.data, out = new Uint8ClampedArray(a.length);
  for (let i = 0, p = 0; i < a.length; i += 4, p++) {
    const m = mask ? mask[p] : 0;
    if (m === 1) { out[i] = 255; out[i + 1] = 30; out[i + 2] = 60; }
    else if (m === 2) { out[i] = 0; out[i + 1] = 255; out[i + 2] = 140; }
    else { const g = (a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11) * 0.55; out[i] = g; out[i + 1] = g; out[i + 2] = g; }
    out[i + 3] = 255;
  }
  return new ImageData(out, orig.width, orig.height);
}

function render() {
  if (!orig) return;
  let img = null, note = '';
  const mode = holding ? 'original' : (paintMode ? 'result' : viewMode);
  if (mode === 'original') img = orig;
  else if (mode === 'diff') { img = diffImage(); if (!img) note = 'Diff needs equal dimensions — seam carving changed the size. Showing result.'; }
  else if (mode === 'jpeg' && result) {
    if (jpegPreview && jpegPreview.key === encKey() && jpegPreview.img) { img = jpegPreview.img; note = 'JPEG view: decoded export file'; }
    else { note = 'Encoding JPEG preview…'; refreshJpegPreview(); }
  }
  else if (mode === 'seams') { img = seamImage(); if (!mask || !mask.some(v => v)) note = 'No seams yet — set a width/height Δ.'; }
  if (!img) img = result || orig;
  if (view.width !== img.width || view.height !== img.height) { view.width = img.width; view.height = img.height; }
  vctx.putImageData(img, 0, 0);
  if (!note && +params.noise.amount > 0 && params.noise.scope === 'inside' && !strokes.length)
    note = 'Noise is set to painted areas only — paint on the image to place it.';
  $('#viewnote').textContent = note;
  applyZoom();
  renderOverlay();
}

function applyZoom() {
  if (!view.width) return;
  let z;
  if (zoomMode === 'fit') {
    const cw = stage.clientWidth - 24, ch = stage.clientHeight - 24;
    z = Math.min(cw / view.width, ch / view.height);
  } else z = +zoomMode;
  const cssW = Math.max(1, Math.round(view.width * z)) + 'px', cssH = Math.max(1, Math.round(view.height * z)) + 'px';
  view.style.width = overlay.style.width = cssW;
  view.style.height = overlay.style.height = cssH;
  view.classList.toggle('pixelated', z >= 2);
  stage.classList.toggle('fit', zoomMode === 'fit');
}

/* ---------------- noise mask painting ---------------- */

const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const brushRing = $('#brushring');
const wrap = $('#wrap');

// Mask strokes are drawn into offscreen canvases at *screen* resolution, then shown either as a
// thin outline (default), a light tint, or not at all — so you can see the actual result.
const maskC = document.createElement('canvas'), maskX = maskC.getContext('2d');
const combC = document.createElement('canvas'), combX = combC.getContext('2d');
const ringC = document.createElement('canvas'), ringX = ringC.getContext('2d');
let maskDirty = true, ovRaf = 0;

function drawStroke(ctx, s, W, H) {
  const p = s.pts;
  ctx.save();
  ctx.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = ctx.fillStyle = '#000';
  const lw = Math.max(1, s.r * W * 2);
  ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (p.length <= 2) {
    ctx.beginPath(); ctx.arc(p[0] * W, p[1] * H, lw / 2, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(p[0] * W, p[1] * H);
    for (let k = 2; k + 1 < p.length; k += 2) ctx.lineTo(p[k] * W, p[k + 1] * H);
    ctx.stroke();
  }
  ctx.restore();
}

function requestOverlay(dirty) {
  if (dirty) maskDirty = true;
  if (!ovRaf) ovRaf = requestAnimationFrame(() => { ovRaf = 0; renderOverlay(); });
}

function ring(src, off, color, W, H) {
  ringX.globalCompositeOperation = 'source-over';
  ringX.clearRect(0, 0, W, H);
  for (let a = 0; a < 8; a++) {
    const t = a * Math.PI / 4;
    ringX.drawImage(src, Math.cos(t) * off, Math.sin(t) * off);
  }
  ringX.globalCompositeOperation = 'destination-out';
  ringX.drawImage(src, 0, 0);
  ringX.globalCompositeOperation = 'source-in';
  ringX.fillStyle = color; ringX.fillRect(0, 0, W, H);
  ringX.globalCompositeOperation = 'source-over';
  octx.drawImage(ringC, 0, 0);
}

function renderOverlay() {
  const disp = params.brush.display || 'outline';
  const showing = !!result && !holding && disp !== 'hidden' && (strokes.length > 0 || !!curStroke) &&
    (paintMode || viewMode === 'result');
  overlay.hidden = !showing;
  if (!showing) return;
  const cssW = parseFloat(view.style.width) || view.width, cssH = parseFloat(view.style.height) || view.height;
  const dpr = window.devicePixelRatio || 1;
  let sc = dpr;
  const maxPx = 16e6;
  if (cssW * cssH * sc * sc > maxPx) sc = Math.sqrt(maxPx / (cssW * cssH));
  const W = Math.max(1, Math.min(16384, Math.round(cssW * sc))), H = Math.max(1, Math.min(16384, Math.round(cssH * sc)));
  if (overlay.width !== W || overlay.height !== H) {
    overlay.width = maskC.width = combC.width = ringC.width = W;
    overlay.height = maskC.height = combC.height = ringC.height = H;
    maskDirty = true;
  }
  if (maskDirty) {
    maskX.clearRect(0, 0, W, H);
    for (const s of strokes) drawStroke(maskX, s, W, H);
    maskDirty = false;
  }
  combX.globalCompositeOperation = 'source-over';
  combX.clearRect(0, 0, W, H);
  combX.drawImage(maskC, 0, 0);
  if (curStroke) drawStroke(combX, curStroke, W, H);
  octx.clearRect(0, 0, W, H);
  if (disp === 'tint') {
    octx.globalAlpha = 0.28;
    octx.drawImage(combC, 0, 0);
    octx.globalCompositeOperation = 'source-in';
    octx.fillStyle = '#ff2bd6'; octx.fillRect(0, 0, W, H);
    octx.globalCompositeOperation = 'source-over'; octx.globalAlpha = 1;
  }
  const u = sc;
  ring(combC, 2.6 * u, 'rgba(0,0,0,0.7)', W, H);
  ring(combC, 1.3 * u, '#ff2bd6', W, H);
}

function setPaint(on, mode) {
  paintMode = on;
  if (mode) { params.brush.mode = mode; saveParams(); }
  wrap.classList.toggle('painting', paintMode);
  brushRing.hidden = true;
  syncSubs();
  render();
}

function maskAction(act) {
  if (act === 'paint') setPaint(!(paintMode && params.brush.mode === 'add'), 'add');
  else if (act === 'erase') setPaint(!(paintMode && params.brush.mode === 'erase'), 'erase');
  else if (act === 'undo') { if (strokes.length) { strokes.pop(); requestOverlay(true); schedule(); } }
  else if (act === 'clear') { if (strokes.length) { strokes = []; requestOverlay(true); schedule(); } }
}

function evToNorm(e) {
  const r = view.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, r];
}

function moveRing(e) {
  if (!paintMode || !result) { brushRing.hidden = true; return; }
  const r = view.getBoundingClientRect();
  const d = Math.max(2, params.brush.size * (r.width / view.width));
  const wr = wrap.getBoundingClientRect();
  brushRing.hidden = false;
  brushRing.style.width = brushRing.style.height = d + 'px';
  brushRing.style.left = (e.clientX - wr.left - d / 2) + 'px';
  brushRing.style.top = (e.clientY - wr.top - d / 2) + 'px';
  brushRing.classList.toggle('erase', params.brush.mode === 'erase' || e.altKey);
}

wrap.addEventListener('pointerdown', (e) => {
  if (!paintMode || !result || e.button !== 0) return;
  e.preventDefault();
  wrap.setPointerCapture(e.pointerId);
  const [nx, ny] = evToNorm(e);
  if (params.noise.scope === 'all') { params.noise.scope = 'inside'; CTRL['noise.scope'].set('inside'); saveParams(); }
  const mode = e.altKey ? (params.brush.mode === 'erase' ? 'add' : 'erase') : params.brush.mode;
  curStroke = { mode, r: params.brush.size / 2 / view.width, h: params.brush.hard / 100, o: params.brush.opacity / 100, pts: [nx, ny] };
  requestOverlay();
});
wrap.addEventListener('pointermove', (e) => {
  moveRing(e);
  if (!curStroke) return;
  const [nx, ny, r] = evToNorm(e);
  const p = curStroke.pts, lx = p[p.length - 2], ly = p[p.length - 1];
  const distPx = Math.hypot((nx - lx) * view.width, (ny - ly) * view.height);
  if (distPx < 0.25 && r) return;
  p.push(nx, ny);
  requestOverlay();
});
const endStroke = () => {
  if (!curStroke) return;
  strokes.push(curStroke); curStroke = null;
  requestOverlay(true); schedule();
};
wrap.addEventListener('pointerup', endStroke);
wrap.addEventListener('pointercancel', endStroke);
wrap.addEventListener('pointerleave', () => { brushRing.hidden = true; });

/* ---------------- status ---------------- */

function setStatus(t, err) { const s = $('#status'); s.textContent = t; s.classList.toggle('err', !!err); }
function showBar(f, label) { const b = $('#bar'); b.hidden = false; b.firstElementChild.style.width = Math.round(f * 100) + '%'; setStatus((label || 'Working') + '… ' + Math.round(f * 100) + '%'); }
function hideBar() { $('#bar').hidden = true; }
function updateMeta(ms) {
  if (!orig) return;
  const inS = `${orig.width}×${orig.height}`;
  const outS = result ? `${result.width}×${result.height}` : inS;
  $('#meta').textContent = `${origName} · in ${inS} → out ${outS}`;
  if (ms != null) setStatus(`Processed in ${Math.round(ms)} ms`);
}

/* ---------------- loading ---------------- */

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Failed to load ' + src)); document.head.append(s); });
}

async function decodeToCanvasSource(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {}
  try {
    const url = URL.createObjectURL(file);
    const img = new Image(); img.src = url;
    await img.decode();
    return img;
  } catch (e) {}
  const name = (file.name || '').toLowerCase(), type = (file.type || '').toLowerCase();
  if (/\.(heic|heif)$/.test(name) || /hei[cf]/.test(type)) {
    setStatus('Decoding HEIC…');
    if (!window.heic2any) await loadScript('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js');
    let out = await window.heic2any({ blob: file, toType: 'image/png' });
    if (Array.isArray(out)) out = out[0];
    return await createImageBitmap(out);
  }
  if (/\.(tif|tiff)$/.test(name) || /tiff/.test(type)) {
    setStatus('Decoding TIFF…');
    if (!window.UTIF) await loadScript('https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js');
    const buf = await file.arrayBuffer();
    const ifds = window.UTIF.decode(buf);
    window.UTIF.decodeImage(buf, ifds[0]);
    const rgba = window.UTIF.toRGBA8(ifds[0]);
    return new ImageData(new Uint8ClampedArray(rgba.buffer), ifds[0].width, ifds[0].height);
  }
  throw new Error('This browser cannot decode that file format.');
}

async function loadFile(file) {
  if (!file) return;
  setStatus('Loading ' + (file.name || 'image') + '…');
  try {
    const srcImg = await decodeToCanvasSource(file);
    const c = document.createElement('canvas');
    const W = srcImg.width, H = srcImg.height;
    if (!W || !H) throw new Error('Image has no pixels.');
    c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
    if (srcImg instanceof ImageData) {
      const t = document.createElement('canvas'); t.width = W; t.height = H;
      t.getContext('2d').putImageData(srcImg, 0, 0);
      x.drawImage(t, 0, 0);
    } else x.drawImage(srcImg, 0, 0);
    orig = x.getImageData(0, 0, W, H);
    origName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
    result = null; mask = null; strokes = []; curStroke = null; maskDirty = true;
    $('#drop').classList.add('hidden');
    const cw = Math.max(10, Math.min(400, Math.round(W * 0.25))), ch = Math.max(10, Math.min(400, Math.round(H * 0.25)));
    CTRL['carve.dw'].setRange(-cw, cw, -(W - 2), W * 4);
    CTRL['carve.dh'].setRange(-ch, ch, -(H - 2), H * 4);
    CTRL['out.name'].el.placeholder = origName + '_ie2.jpg';
    makeWorker();
    render();
    updateMeta();
    dispatch();
  } catch (err) {
    setStatus('Could not open image: ' + (err.message || err), true);
  }
}

/* ---------------- export ---------------- */

let encWorker = null, encSeq = 0, encCache = null, encPending = null, jpegPreview = null, pvTimer = 0, resultVer = 0;
const encWaiters = new Map();
function getEncWorker() {
  if (!encWorker) {
    encWorker = new Worker('worker.js');
    encWorker.onmessage = (e) => {
      const m = e.data, r = encWaiters.get(m.id);
      if (!r) return;
      encWaiters.delete(m.id);
      if (m.type === 'encoded') r.res(new Uint8Array(m.buffer)); else r.rej(new Error(m.message || 'encode failed'));
    };
  }
  return encWorker;
}
function encOpts() { return { quality: +params.out.quality || 92, sub: params.out.sub || '444', hf: +params.out.hf || 0, dither: +params.out.dither || 0 }; }
function encKey() { return resultVer + '|' + JSON.stringify(encOpts()); }
function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB'; }

function getEncoded() {
  const key = encKey();
  if (encCache && encCache.key === key) return Promise.resolve(encCache);
  if (encPending && encPending.key === key) return encPending.p;
  const img = result, id = ++encSeq, copy = img.data.slice();
  const p = new Promise((res, rej) => {
    encWaiters.set(id, { res, rej });
    getEncWorker().postMessage({ type: 'encode', id, w: img.width, h: img.height, buffer: copy.buffer, opts: encOpts() }, [copy.buffer]);
  }).then((bytes) => {
    const r = { key, bytes, src: img, img: null, kept: null };
    if (encKey() === key) encCache = r;
    if (encPending && encPending.key === key) encPending = null;
    return r;
  });
  encPending = { key, p };
  return p;
}

// share of the image's fine (high-frequency) luma detail that is still present after encoding
function detailKept(a, b) {
  const w = a.width, h = a.height, A = a.data, B = b.data;
  const L = (d, p) => 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
  let num = 0, den = 0;
  const step = w * h > 4e6 ? 2 : 1;
  for (let y = 1; y < h - 1; y += step) for (let x = 1; x < w - 1; x += step) {
    const p = y * w + x;
    const ha = L(A, p) - (L(A, p - 1) + L(A, p + 1) + L(A, p - w) + L(A, p + w)) / 4;
    const hb = L(B, p) - (L(B, p - 1) + L(B, p + 1) + L(B, p - w) + L(B, p + w)) / 4;
    num += ha * hb; den += ha * ha;
  }
  return den > 0 ? Math.max(0, Math.min(100, 100 * num / den)) : 100;
}

let pvBusy = false;
async function refreshJpegPreview() {
  if (!result || pvBusy) return;
  pvBusy = true;
  try {
    const key = encKey();
    const enc = await getEncoded();
    if (!enc.img) {
      const bmp = await createImageBitmap(new Blob([enc.bytes], { type: 'image/jpeg' }));
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0);
      enc.img = x.getImageData(0, 0, c.width, c.height);
      enc.kept = detailKept(enc.src, enc.img);
    }
    jpegPreview = enc;
    if (viewMode === 'jpeg') {
      setStatus(`JPEG · ${fmtSize(enc.bytes.length)} · fine detail kept ${enc.kept.toFixed(1)}%`);
      if (key === encKey()) render();
    }
  } catch (err) {
    setStatus('JPEG preview failed: ' + (err.message || err), true);
  } finally {
    pvBusy = false;
    if (viewMode === 'jpeg' && result && (!jpegPreview || jpegPreview.key !== encKey())) setTimeout(render, 0);
  }
}

async function exportJpg() {
  if (!result) return;
  let name = (params.out.name || '').trim() || (origName + '_ie2.jpg');
  if (!/\.jpe?g$/i.test(name)) name += '.jpg';
  setStatus('Encoding JPEG…');
  try {
    const enc = await getEncoded();
    const blob = new Blob([enc.bytes], { type: 'image/jpeg' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    const o = encOpts();
    setStatus(`Exported ${name} · ${enc.src.width}×${enc.src.height} · ${fmtSize(blob.size)} · q${o.quality} ${o.sub.split('').join(':')}`);
  } catch (err) {
    setStatus('Export failed: ' + (err.message || err), true);
  }
}

/* ---------------- wiring ---------------- */

buildPanel();
CTRL['scale.up'].setRange(1, 6, 1, 6);
CTRL['scale.final'].setRange(25, 200, 1, 600);

$('#file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
$('#drop').addEventListener('click', () => $('#file').click());
$('#export').addEventListener('click', exportJpg);
$('#resetall').addEventListener('click', () => {
  const name = params.out.name;
  params = clone(DEFAULTS); params.out.name = name;
  syncUI(); saveParams(); schedule();
});

document.querySelectorAll('#views button').forEach(b => b.addEventListener('click', () => {
  viewMode = b.dataset.view;
  if (paintMode) { paintMode = false; wrap.classList.remove('painting'); syncSubs(); }
  document.querySelectorAll('#views button').forEach(x => x.classList.toggle('on', x === b));
  $('#ampwrap').hidden = viewMode !== 'diff';
  render();
}));
$('#amp').addEventListener('input', (e) => { diffAmp = +e.target.value; $('#ampv').textContent = '×' + diffAmp; if (viewMode === 'diff') render(); });
$('#zoom').addEventListener('change', (e) => { zoomMode = e.target.value; applyZoom(); requestOverlay(); });
window.addEventListener('resize', () => { if (zoomMode === 'fit') { applyZoom(); requestOverlay(); } });

const hold = $('#hold');
const holdOn = (e) => { e.preventDefault(); if (!holding) { holding = true; render(); } };
const holdOff = () => { if (holding) { holding = false; render(); } };
hold.addEventListener('pointerdown', holdOn);
['pointerup', 'pointerleave', 'pointercancel'].forEach(t => hold.addEventListener(t, holdOff));
window.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (e.code === 'Space') holdOn(e);
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); maskAction('undo'); }
  else if (e.ctrlKey || e.metaKey || e.altKey) return;
  else if (e.key === 'b' || e.key === 'B') maskAction('paint');
  else if (e.key === 'e' || e.key === 'E') maskAction('erase');
  else if (e.key === 'Escape' && paintMode) setPaint(false);
  else if (e.key === '[' || e.key === ']') {
    const s = params.brush.size, f = e.shiftKey ? 1.02 : 1.15;
    const v = Math.min(5000, Math.max(1, Math.round((e.key === ']' ? s * f + 0.5 : s / f) * 2) / 2));
    params.brush.size = v; CTRL['brush.size'].set(v); saveParams();
  }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') holdOff(); });

['dragenter', 'dragover'].forEach(t => window.addEventListener(t, (e) => { e.preventDefault(); document.body.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(t => window.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement || !e.relatedTarget) document.body.classList.remove('dragging'); }));
window.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) loadFile(f); });
window.addEventListener('paste', (e) => {
  const items = e.clipboardData ? [...e.clipboardData.items] : [];
  const it = items.find(i => i.kind === 'file');
  if (it) { e.preventDefault(); loadFile(it.getAsFile()); }
});
