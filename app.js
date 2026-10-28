'use strict';

const $ = (s) => document.querySelector(s);
const clone = (o) => JSON.parse(JSON.stringify(o));

const DEFAULTS = {
  clean: {
    on: true, position: 'start',
    deblock: { on: false, threshold: 8, strength: 100 },
    pattern: { on: false, sensitivity: 4, strength: 100, protect: 6, tile: '256' },
    deband: { on: false, radius: 16, threshold: 3, grain: 0.6, passes: 1 },
  },
  carve: { on: true, dw: 0, dh: 0, energy: 'forward' },
  lens: { on: true, k1: 0, k2: 0, cx: 0, cy: 0, zoom: 1, autofill: true, interp: 'bicubic' },
  ca: {
    linear: true,
    rx: 0, ry: 0, gx: 0, gy: 0, bx: 0, by: 0, rs: 0, gs: 0, bs: 0,
    fall: { curve: 'power', exp: 1, start: 0, width: 30, aspect: 0, shifts: false },
    disp: { on: false, lens: 'achromat', amount: 0.3, bands: 10, balance: 550 },
    irr: { on: false, amount: 0.5, scale: 80, detail: 2, lockg: true, fall: false, seed: 1 },
    axial: { on: false, r: 0, g: 0, b: 0.6, edge: 0 },
    pf: { on: false, amount: 50, thr: 215, width: 2, bias: 0.6, hue: 285, edge: 40 },
    cl: { on: false, cbx: 0.6, cby: 0, crx: -0.6, cry: 0, bleed: 0, soft: 0 },
    smear: { on: false, dir: 'radial', angle: 0, r: 0.8, g: 0, b: -0.8, mode: 'trail', follow: true },
    echo: { on: false, count: 2, decay: 0.45, spacing: 1 },
  },
  color: {
    on: true, iterations: 1,
    linear: { on: false, bits: 8 },
    p3: { on: false, bits: 8 },
    lab: { on: false, bits: 8 },
    hsv: { on: false, bits: 8 },
    hsl: { on: false, bits: 8 },
    ycc: { on: false, bits: 8, matrix: '601', range: 'full', sub: '444' },
  },
  resize: { on: true },
  scale: { on: false, up: 2, upMethod: 'bicubic', final: 100, downMethod: 'lanczos3', quant: true },
  sharpen: { on: false, amount: 0.5, radius: 0.8, threshold: 1 },
  grain: { on: true, scope: 'all' },
  sensor: {
    on: false, mode: 'noise', shot: 0.08, read: 0.025, rgain: 30, bgain: 50, seed: 1,
    interp: 'edge', pattern: 'RGGB',
    lumaNR: 70, sharpen: 1.0, sharpenR: 1.6, chromaNR: 90, blotch: 2, blotchSize: 3,
  },
  noise: { on: false, amount: 1.5, type: 'gaussian', density: 100, chroma: 0, grain: 1, irregular: 0, irrScale: 32, seed: 1 },
  brush: { size: 24, hard: 50, opacity: 100, mode: 'add', display: 'outline' },
  final: { dither: true },
  out: { quality: 92, sub: '444', hf: 30, dither: 60, name: '' },
};
const NOPROCESS = ['out.', 'brush.'];

// Shorthand control builders
const R = (k, label, min, max, step, unit, extra) => Object.assign({ k, label, type: 'range', min, max, step, unit }, extra || {});
const S = (k, label, options) => ({ k, label, type: 'select', options });
const C = (k, label) => ({ k, label, type: 'check' });
const H = (label) => ({ type: 'head', label });
const RGB3 = (pre, what, min, max, step, unit) => [R(pre + 'r', 'Red ' + what, min, max, step, unit), R(pre + 'g', 'Green ' + what, min, max, step, unit), R(pre + 'b', 'Blue ' + what, min, max, step, unit)];

/*
 * Stages, in processing order. A stage's `on` key bypasses the whole stage. Cards group related
 * controls; a card with `on` has its own switch. Cards marked `resamples` interpolate pixels.
 */
const STAGES = [
  {
    id: 'clean', title: 'Clean-up', heading: 'Clean-up', on: 'clean.on',
    desc: 'Removes JPEG blocks, repeating patterns and gradient banding before (or after) everything else.',
    cards: [
      { title: 'When', controls: [S('clean.position', 'Run', [['start', 'First — fix the source'], ['end', 'Late — before sharpen & grain']])] },
      { title: 'Deblock', on: 'clean.deblock.on', hint: 'Smooths JPEG 8×8 block edges in flat areas only.',
        controls: [R('clean.deblock.threshold', 'Max step', 1, 30, 0.1, 'lvl'), R('clean.deblock.strength', 'Strength', 0, 100, 1, '%')] },
      { title: 'Remove repeating patterns', on: 'clean.pattern.on', hint: 'Moiré, halftone, screen grids, scan lines. Also flattens real repeating textures (fences, fabric) — raise the threshold if it does.',
        controls: [R('clean.pattern.sensitivity', 'Threshold', 1.5, 20, 0.1, '×'), R('clean.pattern.strength', 'Strength', 0, 100, 1, '%'),
          R('clean.pattern.protect', 'Keep detail <', 0, 40, 0.1, '%'), S('clean.pattern.tile', 'Window', [['128', '128 px (local)'], ['256', '256 px'], ['512', '512 px (fine)']])] },
      { title: 'Deband gradients', on: 'clean.deband.on', hint: 'Smooths stepped gradients in flat areas; edges are left alone.',
        controls: [R('clean.deband.radius', 'Radius', 2, 64, 1, 'px'), R('clean.deband.threshold', 'Threshold', 0.5, 12, 0.1, 'lvl'),
          R('clean.deband.grain', 'Dither', 0, 3, 0.01, 'lvl'), R('clean.deband.passes', 'Passes', 1, 4, 1)] },
    ],
  },
  {
    id: 'carve', title: 'Seams', heading: 'Content-aware resize', on: 'carve.on',
    desc: 'Seam carving: removes (−) or inserts (+) low-detail pixel paths instead of scaling.',
    cards: [
      { controls: [R('carve.dw', 'Width Δ', -100, 100, 1, 'px'), R('carve.dh', 'Height Δ', -100, 100, 1, 'px'),
        S('carve.energy', 'Energy', [['forward', 'Forward (fewer artefacts)'], ['gradient', 'Gradient']])] },
    ],
  },
  {
    id: 'lens', title: 'Lens & CA', heading: 'Lens distortion & chromatic aberration', on: 'lens.on', resamples: true,
    desc: 'Lens distortion and chromatic aberration, done in a single resample. Switch the stage off to skip resampling entirely.',
    cards: [
      { title: 'Resampling', open: true, controls: [
        S('lens.interp', 'Interpolation', [['lanczos3', 'Lanczos 3 (sharpest)'], ['bicubic', 'Bicubic'], ['bilinear', 'Bilinear (soft)'], ['nearest', 'Nearest (no interpolation)']]),
        C('ca.linear', 'Mix colour shifts in linear light')],
        hint: 'Nearest never blends pixels: shifts snap to whole pixels and nothing is softened, but warps can look jagged.' },
      { title: 'Distortion', controls: [
        R('lens.k1', 'k1', -0.1, 0.1, 0.0001), R('lens.k2', 'k2', -0.05, 0.05, 0.0001),
        R('lens.cx', 'Centre X', -10, 10, 0.01, '%'), R('lens.cy', 'Centre Y', -10, 10, 0.01, '%'),
        R('lens.zoom', 'Scale', 0.95, 1.05, 0.0001, '×'), C('lens.autofill', 'Auto-scale to fill the frame')],
        hint: '+k barrel, −k pincushion. The centre is also the centre for chromatic aberration.' },
      { title: 'Lateral CA', controls: [
        H('Shift'), R('ca.rx', 'Red X', -5, 5, 0.01, 'px'), R('ca.ry', 'Red Y', -5, 5, 0.01, 'px'),
        R('ca.gx', 'Green X', -5, 5, 0.01, 'px'), R('ca.gy', 'Green Y', -5, 5, 0.01, 'px'),
        R('ca.bx', 'Blue X', -5, 5, 0.01, 'px'), R('ca.by', 'Blue Y', -5, 5, 0.01, 'px'),
        H('Radial scale'), R('ca.rs', 'Red', -1, 1, 0.001, '%'), R('ca.gs', 'Green', -1, 1, 0.001, '%'), R('ca.bs', 'Blue', -1, 1, 0.001, '%')] },
      { title: 'Radial falloff', controls: [
        S('ca.fall.curve', 'Curve', [['power', 'Power (rⁿ)'], ['smooth', 'S-curve'], ['ring', 'Ring']]),
        R('ca.fall.exp', 'Exponent', 0.1, 6, 0.01), R('ca.fall.start', 'Start / ring r', 0, 95, 0.1, '%'),
        R('ca.fall.width', 'Ring width', 2, 100, 0.1, '%'), R('ca.fall.aspect', 'Aspect', -60, 60, 0.1, '%'),
        C('ca.fall.shifts', 'Also scale the X/Y shifts')], hint: 'How fringing grows from the centre to the corners.' },
      { title: 'Spectral dispersion', on: 'ca.disp.on', hint: 'Real lens fringes: achromat = green/magenta, simple lens = blue/yellow.', controls: [
        S('ca.disp.lens', 'Lens', [['achromat', 'Achromat (green/magenta)'], ['singlet', 'Simple lens (blue/yellow)'], ['prism', 'Prism (rainbow)']]),
        R('ca.disp.amount', 'Amount', -2, 2, 0.001, '%'), R('ca.disp.bands', 'Bands', 3, 32, 1), R('ca.disp.balance', 'Neutral λ', 430, 680, 1, 'nm')] },
      { title: 'Axial CA (defocus)', on: 'ca.axial.on', controls: [...RGB3('ca.axial.', 'blur', 0, 4, 0.01, 'px'), R('ca.axial.edge', 'Edge weight', 0, 100, 0.1, '%')] },
      { title: 'Purple fringing', on: 'ca.pf.on', controls: [
        R('ca.pf.amount', 'Amount', 0, 100, 0.1, '%'), R('ca.pf.thr', 'Highlight ≥', 100, 255, 0.5, 'lvl'), R('ca.pf.width', 'Width', 0.3, 12, 0.01, 'px'),
        R('ca.pf.bias', 'Outward', -6, 6, 0.01, 'px'), R('ca.pf.hue', 'Hue', 0, 360, 0.5, '°'), R('ca.pf.edge', 'Edge weight', 0, 100, 0.1, '%')] },
      { title: 'Irregular field', on: 'ca.irr.on', hint: 'Misalignment that wanders across the image in patches.', controls: [
        R('ca.irr.amount', 'Amount', 0, 4, 0.01, 'px'), R('ca.irr.scale', 'Patch size', 4, 600, 1, 'px'), R('ca.irr.detail', 'Detail', 1, 5, 1),
        R('ca.irr.seed', 'Seed', 1, 9999, 1, '', { extra: 'seed' }), C('ca.irr.lockg', 'Keep green steady'), C('ca.irr.fall', 'Follow radial falloff')] },
      { title: 'Chroma vs luma shift', on: 'ca.cl.on', stylised: true, controls: [
        R('ca.cl.cbx', 'Cb X', -5, 5, 0.01, 'px'), R('ca.cl.cby', 'Cb Y', -5, 5, 0.01, 'px'), R('ca.cl.crx', 'Cr X', -5, 5, 0.01, 'px'), R('ca.cl.cry', 'Cr Y', -5, 5, 0.01, 'px'),
        R('ca.cl.bleed', 'Bleed', 0, 12, 0.01, 'px'), R('ca.cl.soft', 'Chroma blur', 0, 4, 0.01, 'px')] },
      { title: 'Directional smear', on: 'ca.smear.on', stylised: true, controls: [
        S('ca.smear.dir', 'Direction', [['radial', 'Radial'], ['tangential', 'Tangential'], ['fixed', 'Fixed angle']]),
        R('ca.smear.angle', 'Angle', -180, 180, 0.1, '°'), ...RGB3('ca.smear.', 'length', -10, 10, 0.01, 'px'),
        S('ca.smear.mode', 'Shape', [['trail', 'Trail (fading)'], ['centered', 'Centred']]), C('ca.smear.follow', 'Follow radial falloff')] },
      { title: 'Echo (ghost fringes)', on: 'ca.echo.on', stylised: true, controls: [
        R('ca.echo.count', 'Echoes', 1, 8, 1), R('ca.echo.decay', 'Decay', 0.05, 1, 0.01), R('ca.echo.spacing', 'Spacing', 0.25, 4, 0.01, '×')] },
    ],
  },
  {
    id: 'color', title: 'Colour', heading: 'Colour-space roundtrip', on: 'color.on',
    desc: 'Converts to another colour space and back, storing the intermediate at the chosen precision.',
    cards: [
      { controls: [R('color.iterations', 'Passes', 1, 10, 1)] },
      ...[['linear', 'sRGB ↔ linear light'], ['p3', 'sRGB ↔ Display P3'], ['lab', 'sRGB ↔ CIE Lab'], ['hsv', 'RGB ↔ HSV'], ['hsl', 'RGB ↔ HSL']].map(([k, t]) =>
        ({ title: t, on: `color.${k}.on`, controls: [R(`color.${k}.bits`, 'Precision', 4, 16, 0.01, 'bit')] })),
      { title: 'RGB ↔ YCbCr', on: 'color.ycc.on', controls: [R('color.ycc.bits', 'Precision', 4, 16, 0.01, 'bit'),
        S('color.ycc.matrix', 'Matrix', [['601', 'BT.601'], ['709', 'BT.709'], ['2020', 'BT.2020']]),
        S('color.ycc.range', 'Range', [['full', 'Full'], ['limited', 'Limited (16–235)']]),
        S('color.ycc.sub', 'Chroma', [['444', '4:4:4'], ['422', '4:2:2'], ['420', '4:2:0']])] },
    ],
  },
  {
    id: 'resize', title: 'Resample', heading: 'Resample & sharpen', on: 'resize.on', resamples: true,
    desc: 'Optional. Nothing here runs unless you switch a card on.',
    cards: [
      { title: 'Upscale → downscale', on: 'scale.on', hint: 'Enlarges, then shrinks to the final size (100 % = unchanged size). Use Final size to match where the image will be shown.', controls: [
        R('scale.up', 'Upscale', 1, 6, 0.01, '×'), S('scale.upMethod', 'Up filter', [['bicubic', 'Bicubic'], ['lanczos3', 'Lanczos 3'], ['mitchell', 'Mitchell'], ['bilinear', 'Bilinear'], ['nearest', 'Nearest']]),
        R('scale.final', 'Final size', 25, 200, 0.01, '%'), S('scale.downMethod', 'Down filter', [['lanczos3', 'Lanczos 3'], ['bicubic', 'Bicubic'], ['mitchell', 'Mitchell'], ['bilinear', 'Bilinear'], ['box', 'Box (area)'], ['nearest', 'Nearest']]),
        C('scale.quant', 'Round the enlarged image to 8-bit')] },
      { title: 'Sharpen', on: 'sharpen.on', hint: 'Unsharp mask on brightness only (no colour halos). Threshold leaves flat areas and fine noise alone.', controls: [
        R('sharpen.amount', 'Amount', 0, 3, 0.01), R('sharpen.radius', 'Radius', 0.3, 4, 0.01, 'px'), R('sharpen.threshold', 'Threshold', 0, 20, 0.1, 'lvl')] },
    ],
  },
  {
    id: 'grain', title: 'Grain', heading: 'Grain', on: 'grain.on',
    desc: 'Added last, after all resampling, so nothing softens it. Both kinds share one placement mask.',
    cards: [
      { title: 'Placement', open: true, controls: [
        S('grain.scope', 'Apply to', [['all', 'Whole image'], ['inside', 'Painted areas only'], ['outside', 'Everywhere except painted']]),
        { type: 'buttons', buttons: [['paint', 'Paint'], ['erase', 'Erase'], ['undo', 'Undo'], ['clear', 'Clear']] },
        R('brush.size', 'Brush size', 1, 300, 0.5, 'px', { nmax: 5000 }), R('brush.hard', 'Hardness', 0, 100, 1, '%'), R('brush.opacity', 'Opacity', 1, 100, 0.1, '%'),
        S('brush.display', 'Mask view', [['outline', 'Thin outline'], ['tint', 'Tinted'], ['hidden', 'Hidden']])],
        hint: 'B paint · E erase · Alt-drag erases · [ ] size · Ctrl/⌘+Z undo · Esc stop' },
      { title: 'Camera sensor grain', on: 'sensor.on', hint: 'Noise sent through a camera pipeline: photosite noise → edge-aware demosaic → in-camera NR & sharpening. Mid-frequency grain + soft colour blotches, strongest in shadows — survives compression well.', controls: [
        S('sensor.mode', 'Mode', [['noise', 'Grain only (image untouched)'], ['full', 'Full re-mosaic (artefacts)']]),
        H('Photosite noise'), R('sensor.shot', 'Shot noise', 0, 0.6, 0.001), R('sensor.read', 'Read noise', 0, 0.3, 0.001),
        R('sensor.rgain', 'Red sites +', 0, 150, 1, '%'), R('sensor.bgain', 'Blue sites +', 0, 150, 1, '%'), R('sensor.seed', 'Seed', 1, 9999, 1, '', { extra: 'seed' }),
        H('Demosaic'), S('sensor.interp', 'Method', [['edge', 'Edge-directed'], ['mhc', 'Malvar-He-Cutler'], ['bilinear', 'Bilinear'], ['none', 'None (1-px noise)']]),
        S('sensor.pattern', 'Pattern', [['RGGB', 'RGGB'], ['BGGR', 'BGGR'], ['GRBG', 'GRBG'], ['GBRG', 'GBRG']]),
        H('In-camera processing'), R('sensor.lumaNR', 'Luma NR', 0, 100, 1, '%'), R('sensor.sharpen', 'Sharpening', 0, 3, 0.01), R('sensor.sharpenR', 'Radius', 0.3, 4, 0.01, 'px'),
        R('sensor.chromaNR', 'Chroma NR', 0, 100, 1, '%'), R('sensor.blotch', 'Blotches', 0, 5, 0.01, '×'), R('sensor.blotchSize', 'Blotch size', 0.5, 10, 0.1, 'px')] },
      { title: 'Synthetic noise', on: 'noise.on', hint: 'Plain statistical noise. Finer than camera grain, so less of it survives compression.', controls: [
        R('noise.amount', 'Amount', 0, 10, 0.01, 'lvl', { nmax: 255 }),
        S('noise.type', 'Distribution', [['gaussian', 'Gaussian'], ['uniform', 'Uniform'], ['laplacian', 'Laplacian'], ['impulse', 'Impulse (specks)'], ['shot', 'Brightness-dependent']]),
        R('noise.density', 'Density', 0, 100, 0.01, '%'), R('noise.chroma', 'Colour', 0, 100, 0.1, '%'), R('noise.grain', 'Grain size', 1, 8, 0.01, 'px'),
        R('noise.irregular', 'Irregularity', 0, 100, 0.1, '%'), R('noise.irrScale', 'Patch size', 2, 400, 1, 'px'), R('noise.seed', 'Seed', 1, 9999, 1, '', { extra: 'seed' })] },
    ],
  },
  {
    id: 'output', title: 'Output', heading: 'Output',
    desc: 'Everything above is baked into the pixels. The image is rounded to 8-bit once, here.',
    cards: [
      { title: '8-bit conversion', open: true, controls: [C('final.dither', 'Anti-banding dither')],
        hint: 'Adds an invisible ±1-level dither only where values fall between levels, so gradients can’t band. Untouched pixels stay identical.' },
      { title: 'JPEG export', open: true, hint: '4:4:4 keeps full colour (browsers export 4:2:0). Grain keep and grain-safe rounding stop fine detail rounding away. Use the JPEG view to check the file.', controls: [
        R('out.quality', 'Quality', 1, 100, 0.5, '%'),
        S('out.sub', 'Chroma', [['444', '4:4:4 (full colour)'], ['422', '4:2:2'], ['420', '4:2:0']]),
        R('out.hf', 'Grain keep', 0, 90, 1, '%'), R('out.dither', 'Grain-safe rounding', 0, 100, 1, '%'),
        { k: 'out.name', label: 'Filename', type: 'text', placeholder: 'auto' }] },
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
  row.className = 'ctl ' + c.type;
  const def = c.k ? getPath(DEFAULTS, c.k) : undefined;

  if (c.type === 'range') {
    const lab = document.createElement('label');
    lab.textContent = c.label; lab.title = c.label + ' — double-click to reset';
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
    cb.addEventListener('change', () => { row.classList.toggle('changed', cb.checked !== def); update(c.k, cb.checked); });
    row.append(lab);
    CTRL[c.k] = { set: (v) => { cb.checked = !!v; row.classList.toggle('changed', !!v !== def); } };
  } else if (c.type === 'select') {
    const lab = document.createElement('label'); lab.textContent = c.label; lab.title = c.label;
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

/* A small on/off switch bound to a boolean param */
const SWITCHES = {};
function makeSwitch(k, title) {
  const lab = document.createElement('label');
  lab.className = 'sw'; lab.title = title || 'On / off';
  const cb = document.createElement('input'); cb.type = 'checkbox';
  const knob = document.createElement('span');
  lab.append(cb, knob);
  lab.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', () => { update(k, cb.checked); onSwitch(k, cb.checked); });
  (SWITCHES[k] = SWITCHES[k] || []).push(cb);
  return lab;
}

let uiState = { stage: 'lens', open: {} };
try { const u = JSON.parse(localStorage.getItem('ie2.ui') || 'null'); if (u && u.stage) uiState = Object.assign(uiState, u); } catch (e) {}
function saveUi() { try { localStorage.setItem('ie2.ui', JSON.stringify(uiState)); } catch (e) {} }
const CARDS = [];   // { el, stage, card }

function buildPanel() {
  const rail = $('#rail'), panes = $('#panes');
  rail.innerHTML = ''; panes.innerHTML = '';
  STAGES.forEach((st, i) => {
    // rail item
    const it = document.createElement('div');
    it.className = 'rail-item'; it.dataset.stage = st.id; it.tabIndex = 0;
    const num = document.createElement('span'); num.className = 'rail-num'; num.textContent = i + 1;
    const name = document.createElement('span'); name.className = 'rail-name'; name.textContent = st.title;
    const dot = document.createElement('span'); dot.className = 'rail-dot';
    it.append(num, name, dot);
    it.title = st.heading;
    it.addEventListener('click', () => selectStage(st.id));
    it.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectStage(st.id); } });
    rail.append(it);

    // pane
    const pane = document.createElement('section');
    pane.className = 'pane'; pane.dataset.stage = st.id;
    const head = document.createElement('div'); head.className = 'pane-head';
    const t = document.createElement('h2'); t.textContent = st.heading || st.title;
    const rb = document.createElement('button'); rb.className = 'mini'; rb.type = 'button'; rb.textContent = 'Reset'; rb.title = 'Reset this stage';
    rb.addEventListener('click', () => resetStage(st));
    head.append(t);
    if (st.resamples) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'resamples'; tag.title = 'This stage interpolates pixels when active'; head.append(tag); }
    head.append(rb);
    if (st.on) head.append(makeSwitch(st.on, 'Bypass / enable this stage'));
    pane.append(head);
    const d = document.createElement('p'); d.className = 'pane-desc'; d.textContent = st.desc; pane.append(d);
    const body = document.createElement('div'); body.className = 'pane-body';
    let styl = false;
    for (const card of st.cards) {
      if (card.stylised && !styl) { styl = true; const h = document.createElement('div'); h.className = 'cards-sep'; h.textContent = 'Stylised (not camera-like)'; body.append(h); }
      body.append(makeCard(st, card));
    }
    pane.append(body);
    panes.append(pane);
  });
  syncUI();
  selectStage(STAGES.some(s => s.id === uiState.stage) ? uiState.stage : 'lens');
}

function makeCard(st, card) {
  const el = document.createElement('div');
  el.className = 'card' + (card.title ? '' : ' bare');
  const id = st.id + ':' + (card.title || '');
  if (card.title) {
    const h = document.createElement('div'); h.className = 'card-h';
    const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '▸';
    const t = document.createElement('span'); t.className = 'card-t'; t.textContent = card.title;
    h.append(chev, t);
    if (card.on) h.append(makeSwitch(card.on));
    h.addEventListener('click', () => { const o = !el.classList.contains('open'); el.classList.toggle('open', o); uiState.open[id] = o; saveUi(); });
    el.append(h);
  }
  const b = document.createElement('div'); b.className = 'card-b';
  if (card.hint) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = card.hint; b.append(p); }
  for (const c of card.controls) b.append(makeControl(c));
  el.append(b);
  const remembered = uiState.open[id];
  el.classList.toggle('open', !card.title || (remembered != null ? remembered : !!card.open || (card.on && !!getPath(params, card.on))));
  CARDS.push({ el, stage: st.id, card, id });
  return el;
}

function onSwitch(k, v) {
  // switching a card on opens it
  if (v) for (const c of CARDS) if (c.card.on === k) { c.el.classList.add('open'); uiState.open[c.id] = true; saveUi(); }
}

function selectStage(id) {
  uiState.stage = id; saveUi();
  document.querySelectorAll('.rail-item').forEach(e => e.classList.toggle('sel', e.dataset.stage === id));
  document.querySelectorAll('.pane').forEach(e => e.hidden = e.dataset.stage !== id);
  $('#panes').scrollTop = 0;
}

function anyOn(o, keys) { return keys.some(k => o[k] && o[k].on); }
function stageActive(id) {
  const p = params;
  switch (id) {
    case 'clean': return p.clean.on && anyOn(p.clean, ['deblock', 'pattern', 'deband']);
    case 'carve': return p.carve.on && (+p.carve.dw !== 0 || +p.carve.dh !== 0);
    case 'lens': {
      const a = p.ca;
      return p.lens.on && (+p.lens.k1 !== 0 || +p.lens.k2 !== 0 || +p.lens.zoom !== 1 ||
        ['rx', 'ry', 'gx', 'gy', 'bx', 'by', 'rs', 'gs', 'bs'].some(k => +a[k] !== 0) || anyOn(a, ['disp', 'irr', 'axial', 'pf', 'cl', 'smear', 'echo']));
    }
    case 'color': return p.color.on && anyOn(p.color, ['linear', 'p3', 'lab', 'hsv', 'hsl', 'ycc']);
    case 'resize': return p.resize.on && ((p.scale.on && (+p.scale.up !== 1 || +p.scale.final !== 100)) || (p.sharpen.on && +p.sharpen.amount > 0));
    case 'grain': return p.grain.on && (p.sensor.on || (p.noise.on && +p.noise.amount > 0));
    default: return false;
  }
}

function syncUI() {
  for (const k in CTRL) CTRL[k].set(getPath(params, k));
  for (const k in SWITCHES) for (const cb of SWITCHES[k]) cb.checked = !!getPath(params, k);
  syncState();
}

function syncState() {
  for (const c of CARDS) if (c.card.on) c.el.classList.toggle('off', !getPath(params, c.card.on));
  for (const st of STAGES) {
    const it = document.querySelector(`.rail-item[data-stage="${st.id}"]`);
    const pane = document.querySelector(`.pane[data-stage="${st.id}"]`);
    const bypassed = st.on && !getPath(params, st.on);
    if (it) { it.classList.toggle('bypassed', !!bypassed); it.classList.toggle('active', stageActive(st.id)); }
    if (pane) pane.classList.toggle('bypassed', !!bypassed);
  }
  const dim = (k, off) => { const e = document.querySelector(`.ctl[data-k="${k}"]`); if (e) e.classList.toggle('off', off); };
  dim('ca.fall.width', params.ca.fall.curve !== 'ring');
  dim('ca.smear.angle', params.ca.smear.dir !== 'fixed');
  dim('noise.irrScale', !(+params.noise.irregular > 0));
  dim('scale.upMethod', +params.scale.up === 1);
  document.querySelectorAll('.tool').forEach(b => {
    b.classList.toggle('on', (b.dataset.act === 'paint' && paintMode && params.brush.mode === 'add') || (b.dataset.act === 'erase' && paintMode && params.brush.mode === 'erase'));
  });
  const seamsBtn = document.querySelector('#views button[data-view="seams"]');
  const seamsOn = stageActive('carve');
  if (seamsBtn) { seamsBtn.hidden = !seamsOn; if (!seamsOn && viewMode === 'seams') setView('result'); }
}

function collectKeys(st) {
  const keys = [];
  if (st.on) keys.push(st.on);
  for (const card of st.cards) { if (card.on) keys.push(card.on); for (const c of card.controls) if (c.k && c.k !== 'out.name') keys.push(c.k); }
  return keys;
}
function resetStage(st) {
  for (const k of collectKeys(st)) setPath(params, k, clone(getPath(DEFAULTS, k)));
  syncUI(); saveParams();
  if (st.id !== 'output' || true) schedule();
  requestOverlay(true);
}

function update(k, v) {
  setPath(params, k, v);
  saveParams();
  syncState();
  if (k === 'brush.display') requestOverlay(true);
  if (k.startsWith('out.') && k !== 'out.name' && viewMode === 'jpeg') { clearTimeout(pvTimer); pvTimer = setTimeout(render, 200); }
  if (!NOPROCESS.some(p => k.startsWith(p))) schedule();
}

/* ---------------- worker ---------------- */

let worker = null, jobId = 0, inflight = null, pending = false, workerCarveKey = null, timer = 0;

function cleanOn(C) { return !!(C && C.on !== false && ((C.deblock && C.deblock.on) || (C.pattern && C.pattern.on) || (C.deband && C.deband.on))); }
// must match the key the worker builds
function carveKeyOf(p) {
  const ck = cleanOn(p.clean) && p.clean.position !== 'end' ? JSON.stringify(p.clean) : '';
  const cv = p.carve.on === false ? { dw: 0, dh: 0, energy: p.carve.energy } : p.carve;
  return `${Math.round(+cv.dw || 0)}|${Math.round(+cv.dh || 0)}|${cv.energy}#${ck}`;
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
  p.noise.scope = p.grain.scope;
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
  if (!note && stageActive('grain') && params.grain.scope === 'inside' && !strokes.length)
    note = 'Grain is set to painted areas only — paint on the image to place it.';
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
  if (on && uiState.stage !== 'grain') selectStage('grain');
  wrap.classList.toggle('painting', paintMode);
  brushRing.hidden = true;
  syncState();
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
  if (params.grain.scope === 'all') { params.grain.scope = 'inside'; CTRL['grain.scope'].set('inside'); saveParams(); }
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
  syncUI(); saveParams(); schedule(); requestOverlay(true);
});

function setView(v) {
  viewMode = v;
  if (paintMode) { paintMode = false; wrap.classList.remove('painting'); }
  document.querySelectorAll('#views button').forEach(x => x.classList.toggle('on', x.dataset.view === v));
  $('#ampwrap').hidden = viewMode !== 'diff';
  render();
}
document.querySelectorAll('#views button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
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
