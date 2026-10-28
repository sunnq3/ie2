'use strict';

const $ = (s) => document.querySelector(s);
const clone = (o) => JSON.parse(JSON.stringify(o));

const DEFAULTS = {
  clean: {
    on: true,
    deblock: { on: false, threshold: 8, strength: 100 },
    deband: { on: false, radius: 16, threshold: 3, grain: 0.6, passes: 1 },
    pattern: { on: false, sensitivity: 4, strength: 100, protect: 6, tile: '256' },
  },
  carve: { on: true, dw: 0, dh: 0, energy: 'forward' },
  lens: { on: true, k1: 0, k2: 0, cx: 0, cy: 0, zoom: 1, autofill: true, interp: 'bicubic' },
  ca: {
    rx: 0, ry: 0, gx: 0, gy: 0, bx: 0, by: 0, rs: 0, gs: 0, bs: 0,
    fall: { curve: 'power', exp: 1, start: 0, width: 30, aspect: 0, shifts: false },
    disp: { on: false, lens: 'achromat', amount: 0.3, bands: 10, balance: 550 },
    axial: { on: false, r: 0, g: 0, b: 0.4, edge: 0 },
    pf: { on: false, amount: 50, thr: 215, width: 2, bias: 0.6, hue: 285, edge: 40 },
    irr: { on: false, amount: 0.5, scale: 80, detail: 2, lockg: true, fall: false, seed: 1 },
    cl: { on: false, cbx: 0.6, cby: 0, crx: -0.6, cry: 0, bleed: 0, soft: 0 },
    smear: { on: false, dir: 'radial', angle: 0, r: 0.8, g: 0, b: -0.8, mode: 'trail', follow: true },
    echo: { on: false, count: 2, decay: 0.45, spacing: 1 },
  },
  resize: { on: true },
  scale: { on: false, up: 2, upMethod: 'bicubic', final: 100, downMethod: 'lanczos3', quant: true },
  sharpen: { on: false, amount: 0.5, radius: 0.8, threshold: 1 },
  sensor: {
    on: false, amount: 1, shadows: 1, colour: 1, seed: 1,
    shot: 0.06, read: 0.09, rgain: 30, bgain: 50,
    lumaNR: 70, sharpen: 1.0, sharpenR: 1.6, chromaNR: 90, blotch: 2, blotchSize: 3,
  },
  out: { quality: 92, protect: 60, sub: '444', name: '' },
};
const NOPROCESS = ['out.'];

// Starting points. Applying one resets everything, then sets these values.
const LOOKS = {
  clean: { label: 'Clean (no changes)', set: {} },
  natural: { label: 'Natural camera', set: {
    'lens.k1': 0.004, 'ca.rs': 0.04, 'ca.bs': -0.05, 'ca.fall.exp': 1.8,
    'ca.disp.on': true, 'ca.disp.amount': 0.15, 'ca.axial.on': true, 'ca.axial.b': 0.3,
    'sensor.on': true } },
  phone: { label: 'Phone camera', set: {
    'ca.rs': 0.02, 'ca.bs': -0.03, 'ca.fall.exp': 2, 'ca.disp.on': true, 'ca.disp.amount': 0.08,
    'sharpen.on': true, 'sharpen.amount': 0.6, 'sharpen.radius': 0.7,
    'sensor.on': true, 'sensor.amount': 1.3, 'sensor.shadows': 1.6, 'sensor.colour': 0.6, 'sensor.lumaNR': 80 } },
  vintage: { label: 'Vintage lens', set: {
    'lens.k1': 0.02, 'ca.rs': 0.12, 'ca.bs': -0.15, 'ca.fall.exp': 2,
    'ca.disp.on': true, 'ca.disp.lens': 'singlet', 'ca.disp.amount': 0.45, 'ca.axial.on': true, 'ca.axial.r': 0.2, 'ca.axial.b': 0.6,
    'ca.pf.on': true, 'ca.pf.amount': 35, 'sensor.on': true, 'sensor.amount': 1.6, 'sensor.colour': 1.3 } },
};

// Shorthand control builders. `adv` controls only show with "Advanced" switched on.
const R = (k, label, min, max, step, unit, extra) => Object.assign({ k, label, type: 'range', min, max, step, unit }, extra || {});
const S = (k, label, options, extra) => Object.assign({ k, label, type: 'select', options }, extra || {});
const C = (k, label, extra) => Object.assign({ k, label, type: 'check' }, extra || {});
const H = (label, extra) => Object.assign({ type: 'head', label }, extra || {});
const ADV = { adv: true };

/*
 * Stages, in processing order. A stage's `on` key bypasses the whole stage. Cards group related
 * controls; a card with `on` has its own switch; `adv` cards/controls are hidden unless Advanced is on.
 */
const STAGES = [
  {
    id: 'resize', title: 'Size', heading: 'Size (resampled first)', on: 'resize.on', resamples: true,
    desc: 'Optional. Resizes the original before any edit, so every effect after it is applied at the final size and is never resampled again.',
    cards: [
      { title: 'Upscale → downscale', on: 'scale.on', hint: 'To make the image smaller for where it will be shown (e.g. Reddit), set Upscale to 1× and Final size to the target. Nearest up + Box down at 100% changes nothing.', controls: [
        R('scale.final', 'Final size', 25, 200, 0.01, '%'), R('scale.up', 'Upscale', 1, 6, 0.01, '×'),
        S('scale.upMethod', 'Up filter', [['bicubic', 'Bicubic'], ['lanczos3', 'Lanczos 3'], ['mitchell', 'Mitchell'], ['bilinear', 'Bilinear'], ['nearest', 'Nearest']], ADV),
        S('scale.downMethod', 'Down filter', [['lanczos3', 'Lanczos 3'], ['bicubic', 'Bicubic'], ['mitchell', 'Mitchell'], ['bilinear', 'Bilinear'], ['box', 'Box (area)'], ['nearest', 'Nearest']], ADV),
        C('scale.quant', 'Round the enlarged image to 8-bit', ADV)] },
    ],
  },
  {
    id: 'clean', title: 'Clean-up', heading: 'Clean-up', on: 'clean.on',
    desc: 'Fix problems already in the photo before anything else. Skip this if the source looks fine.',
    cards: [
      { title: 'Deblock', on: 'clean.deblock.on', hint: 'Smooths JPEG 8×8 block edges in flat areas.',
        controls: [R('clean.deblock.strength', 'Strength', 0, 100, 1, '%'), R('clean.deblock.threshold', 'Max step', 1, 30, 0.1, 'lvl', ADV)] },
      { title: 'Deband', on: 'clean.deband.on', hint: 'Smooths stepped gradients (skies, walls). Edges are left alone.',
        controls: [R('clean.deband.radius', 'Radius', 2, 64, 1, 'px'), R('clean.deband.threshold', 'Threshold', 0.5, 12, 0.1, 'lvl', ADV),
          R('clean.deband.grain', 'Dither', 0, 3, 0.01, 'lvl', ADV), R('clean.deband.passes', 'Passes', 1, 4, 1, '', ADV)] },
      { title: 'Remove moiré & patterns', on: 'clean.pattern.on', hint: 'Removes moiré, halftone dots and screen grids. Can also flatten real repeating textures (fences, fabric).',
        controls: [R('clean.pattern.strength', 'Strength', 0, 100, 1, '%'), R('clean.pattern.sensitivity', 'Threshold', 1.5, 20, 0.1, '×', ADV),
          R('clean.pattern.protect', 'Keep detail <', 0, 40, 0.1, '%', ADV), S('clean.pattern.tile', 'Window', [['128', '128 px'], ['256', '256 px'], ['512', '512 px']], ADV)] },
    ],
  },
  {
    id: 'carve', title: 'Seams', heading: 'Content-aware resize', on: 'carve.on',
    desc: 'Changes the size by removing (−) or adding (+) low-detail pixel paths instead of scaling.',
    cards: [
      { controls: [R('carve.dw', 'Width Δ', -100, 100, 1, 'px'), R('carve.dh', 'Height Δ', -100, 100, 1, 'px'),
        S('carve.energy', 'Energy', [['forward', 'Forward (fewer artefacts)'], ['gradient', 'Gradient']], ADV)] },
    ],
  },
  {
    id: 'lens', title: 'Lens', heading: 'Lens & chromatic aberration', on: 'lens.on', resamples: true,
    desc: 'Distortion and colour fringing like a real lens, done in one resample. Switch off to skip resampling entirely.',
    cards: [
      { controls: [S('lens.interp', 'Interpolation', [['lanczos3', 'Lanczos 3 (sharpest)'], ['bicubic', 'Bicubic'], ['bilinear', 'Bilinear (soft)'], ['nearest', 'Nearest (no blending)']])] },
      { title: 'Distortion', open: true, hint: '+ barrel, − pincushion.', controls: [
        R('lens.k1', 'Amount', -0.1, 0.1, 0.0001), C('lens.autofill', 'Fill the frame (no empty edges)'),
        R('lens.k2', 'Outer amount', -0.05, 0.05, 0.0001, '', ADV), R('lens.cx', 'Centre X', -10, 10, 0.01, '%', ADV), R('lens.cy', 'Centre Y', -10, 10, 0.01, '%', ADV),
        R('lens.zoom', 'Scale', 0.95, 1.05, 0.0001, '×', ADV)] },
      { title: 'Colour fringing', open: true, hint: 'Red and blue images slightly bigger/smaller than green — the classic lens fringe, strongest in the corners.', controls: [
        R('ca.rs', 'Red', -1, 1, 0.001, '%'), R('ca.bs', 'Blue', -1, 1, 0.001, '%'),
        R('ca.fall.exp', 'Corner bias', 0.1, 6, 0.01), R('ca.gs', 'Green', -1, 1, 0.001, '%', ADV),
        H('Shift', ADV), R('ca.rx', 'Red X', -5, 5, 0.01, 'px', ADV), R('ca.ry', 'Red Y', -5, 5, 0.01, 'px', ADV),
        R('ca.gx', 'Green X', -5, 5, 0.01, 'px', ADV), R('ca.gy', 'Green Y', -5, 5, 0.01, 'px', ADV),
        R('ca.bx', 'Blue X', -5, 5, 0.01, 'px', ADV), R('ca.by', 'Blue Y', -5, 5, 0.01, 'px', ADV),
        H('Falloff shape', ADV), S('ca.fall.curve', 'Curve', [['power', 'Power (rⁿ)'], ['smooth', 'S-curve'], ['ring', 'Ring']], ADV),
        R('ca.fall.start', 'Clean centre', 0, 95, 0.1, '%', ADV), R('ca.fall.width', 'Ring width', 2, 100, 0.1, '%', ADV),
        R('ca.fall.aspect', 'Aspect', -60, 60, 0.1, '%', ADV), C('ca.fall.shifts', 'Also scale the X/Y shifts', ADV)] },
      { title: 'Lens dispersion', on: 'ca.disp.on', hint: 'Soft two-tone fringes from real glass: achromat = green/magenta, simple lens = blue/yellow.', controls: [
        S('ca.disp.lens', 'Lens', [['achromat', 'Achromat (green/magenta)'], ['singlet', 'Simple lens (blue/yellow)'], ['prism', 'Prism (rainbow)']]),
        R('ca.disp.amount', 'Amount', -2, 2, 0.001, '%'), R('ca.disp.bands', 'Bands', 3, 32, 1, '', ADV), R('ca.disp.balance', 'Neutral λ', 430, 680, 1, 'nm', ADV)] },
      { title: 'Soft blue focus', on: 'ca.axial.on', hint: 'Blue focuses slightly behind the sensor on most lenses, so it is a touch softer.', controls: [
        R('ca.axial.b', 'Blue blur', 0, 4, 0.01, 'px'), R('ca.axial.r', 'Red blur', 0, 4, 0.01, 'px', ADV), R('ca.axial.g', 'Green blur', 0, 4, 0.01, 'px', ADV),
        R('ca.axial.edge', 'Edge weight', 0, 100, 0.1, '%', ADV)] },
      { title: 'Purple fringing', on: 'ca.pf.on', hint: 'Violet halo around bright highlights against dark edges.', controls: [
        R('ca.pf.amount', 'Amount', 0, 100, 0.1, '%'), R('ca.pf.width', 'Width', 0.3, 12, 0.01, 'px'),
        R('ca.pf.thr', 'Highlight ≥', 100, 255, 0.5, 'lvl', ADV), R('ca.pf.bias', 'Outward', -6, 6, 0.01, 'px', ADV),
        R('ca.pf.hue', 'Hue', 0, 360, 0.5, '°', ADV), R('ca.pf.edge', 'Edge weight', 0, 100, 0.1, '%', ADV)] },
      { title: 'Irregular field', on: 'ca.irr.on', adv: true, hint: 'Misalignment that wanders across the image in patches.', controls: [
        R('ca.irr.amount', 'Amount', 0, 4, 0.01, 'px'), R('ca.irr.scale', 'Patch size', 4, 600, 1, 'px'), R('ca.irr.detail', 'Detail', 1, 5, 1),
        R('ca.irr.seed', 'Seed', 1, 9999, 1, '', { extra: 'seed' }), C('ca.irr.lockg', 'Keep green steady'), C('ca.irr.fall', 'Follow corner bias')] },
      { title: 'Chroma vs luma shift', on: 'ca.cl.on', adv: true, stylised: true, controls: [
        R('ca.cl.cbx', 'Cb X', -5, 5, 0.01, 'px'), R('ca.cl.cby', 'Cb Y', -5, 5, 0.01, 'px'), R('ca.cl.crx', 'Cr X', -5, 5, 0.01, 'px'), R('ca.cl.cry', 'Cr Y', -5, 5, 0.01, 'px'),
        R('ca.cl.bleed', 'Bleed', 0, 12, 0.01, 'px'), R('ca.cl.soft', 'Chroma blur', 0, 4, 0.01, 'px')] },
      { title: 'Directional smear', on: 'ca.smear.on', adv: true, stylised: true, controls: [
        S('ca.smear.dir', 'Direction', [['radial', 'Radial'], ['tangential', 'Tangential'], ['fixed', 'Fixed angle']]),
        R('ca.smear.angle', 'Angle', -180, 180, 0.1, '°'), R('ca.smear.r', 'Red length', -10, 10, 0.01, 'px'), R('ca.smear.g', 'Green length', -10, 10, 0.01, 'px'),
        R('ca.smear.b', 'Blue length', -10, 10, 0.01, 'px'), S('ca.smear.mode', 'Shape', [['trail', 'Trail (fading)'], ['centered', 'Centred']]), C('ca.smear.follow', 'Follow corner bias')] },
      { title: 'Echo (ghost fringes)', on: 'ca.echo.on', adv: true, stylised: true, controls: [
        R('ca.echo.count', 'Echoes', 1, 8, 1), R('ca.echo.decay', 'Decay', 0.05, 1, 0.01), R('ca.echo.spacing', 'Spacing', 0.25, 4, 0.01, '×')] },
    ],
  },
  {
    id: 'sharpen', title: 'Sharpen', heading: 'Sharpen', on: 'sharpen.on',
    desc: 'Optional. Sharpens brightness only, so there are no colour halos. Runs after the lens stage and before grain.',
    cards: [
      { controls: [R('sharpen.amount', 'Amount', 0, 3, 0.01), R('sharpen.radius', 'Radius', 0.3, 4, 0.01, 'px'), R('sharpen.threshold', 'Threshold', 0, 20, 0.1, 'lvl', ADV)] },
    ],
  },
  {
    id: 'grain', title: 'Grain', heading: 'Camera grain', on: 'sensor.on',
    desc: 'Real sensor noise, added last so nothing softens it. Builds up in dark areas like a real camera; your image’s own pixels are not resampled.',
    cards: [
      { controls: [R('sensor.amount', 'Amount', 0, 4, 0.01, '×'), R('sensor.shadows', 'Shadow grain', 0, 4, 0.01, '×'), R('sensor.colour', 'Colour noise', 0, 3, 0.01, '×'),
        R('sensor.seed', 'Seed', 1, 9999, 1, '', { extra: 'seed', adv: true })] },
      { title: 'Sensor', adv: true, hint: 'Shot noise grows with brightness; read noise is a constant floor that dominates the shadows.', controls: [
        R('sensor.shot', 'Shot noise', 0, 0.6, 0.001), R('sensor.read', 'Read noise', 0, 0.4, 0.001),
        R('sensor.rgain', 'Red sites +', 0, 150, 1, '%'), R('sensor.bgain', 'Blue sites +', 0, 150, 1, '%')] },
      { title: 'In-camera processing', adv: true, hint: 'How the camera cleans the noise up — this is what shapes the grain.', controls: [
        R('sensor.lumaNR', 'Luma NR', 0, 100, 1, '%'), R('sensor.sharpen', 'Sharpening', 0, 3, 0.01), R('sensor.sharpenR', 'Radius', 0.3, 4, 0.01, 'px'),
        R('sensor.chromaNR', 'Chroma NR', 0, 100, 1, '%'), R('sensor.blotch', 'Blotches', 0, 5, 0.01, '×'), R('sensor.blotchSize', 'Blotch size', 0.5, 10, 0.1, 'px')] },
    ],
  },
  {
    id: 'output', title: 'Export', heading: 'Export',
    desc: 'Everything above is baked into the pixels of the JPEG. Check the JPEG view to see exactly what the file looks like.',
    cards: [
      { controls: [R('out.quality', 'Quality', 1, 100, 0.5, '%'),
        R('out.protect', 'Protect grain', 0, 100, 1, '%'),
        S('out.sub', 'Colour detail', [['444', 'Full (4:4:4)'], ['422', 'Half (4:2:2)'], ['420', 'Quarter (4:2:0, like browsers)']], ADV),
        { k: 'out.name', label: 'Filename', type: 'text', placeholder: 'auto' }],
        hint: 'Protect grain keeps fine grain and detail from being rounded away by compression (bigger file). Colour is always kept at full resolution unless you change it in Advanced.' },
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
  row.className = 'ctl ' + c.type + (c.adv ? ' adv' : '');
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

let uiState = { stage: 'lens', open: {}, advanced: false };
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
      if (card.stylised && !styl) { styl = true; const h = document.createElement('div'); h.className = 'cards-sep adv'; h.textContent = 'Stylised (not camera-like)'; body.append(h); }
      body.append(makeCard(st, card));
    }
    pane.append(body);
    panes.append(pane);
  });
  const adv = document.createElement('label'); adv.className = 'rail-adv'; adv.title = 'Show every fine-tuning control';
  const advCb = document.createElement('input'); advCb.type = 'checkbox'; advCb.checked = !!uiState.advanced;
  const advK = document.createElement('span');
  adv.append(advCb, advK, document.createTextNode('Advanced'));
  advCb.addEventListener('change', () => { uiState.advanced = advCb.checked; saveUi(); document.body.classList.toggle('show-adv', advCb.checked); });
  document.body.classList.toggle('show-adv', !!uiState.advanced);
  rail.append(adv);
  syncUI();
  selectStage(STAGES.some(s => s.id === uiState.stage) ? uiState.stage : 'lens');
}

function makeCard(st, card) {
  const el = document.createElement('div');
  el.className = 'card' + (card.title ? '' : ' bare') + (card.adv ? ' adv' : '');
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
    case 'resize': return p.resize.on && p.scale.on && (+p.scale.up !== 1 || +p.scale.final !== 100);
    case 'sharpen': return p.sharpen.on && +p.sharpen.amount > 0;
    case 'grain': return p.sensor.on && +p.sensor.amount > 0;
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
  dim('scale.upMethod', +params.scale.up === 1);
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
  syncUI(); saveParams(); schedule();
}

function applyLook(id) {
  const look = LOOKS[id]; if (!look) return;
  const name = params.out.name;
  const out = clone(params.out);
  params = clone(DEFAULTS); params.out = out; params.out.name = name;
  for (const [k, v] of Object.entries(look.set)) setPath(params, k, v);
  syncUI(); saveParams(); schedule();
  setStatus('Look applied: ' + look.label + ' — fine-tune any stage on the right.');
}

function update(k, v) {
  setPath(params, k, v);
  saveParams();
  syncState();
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
  const sk = p.resize.on !== false && p.scale.on ? JSON.stringify(p.scale) : '';
  return `${Math.round(+cv.dw || 0)}|${Math.round(+cv.dh || 0)}|${cv.energy}#${ck}#${sk}`;
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
  delete p.out;
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
  const mode = holding ? 'original' : viewMode;
  if (mode === 'original') img = orig;
  else if (mode === 'diff') { img = diffImage(); if (!img) note = 'Diff needs the same size as the original — Size or Seams changed it. Showing result.'; }
  else if (mode === 'jpeg' && result) {
    if (jpegPreview && jpegPreview.key === encKey() && jpegPreview.img) { img = jpegPreview.img; note = 'JPEG view: decoded export file'; }
    else { note = 'Encoding JPEG preview…'; refreshJpegPreview(); }
  }
  else if (mode === 'seams') {
    if (mask && mask.length !== orig.width * orig.height) note = 'Seams view needs Size at 100% — showing result.';
    else { img = seamImage(); if (!mask || !mask.some(v => v)) note = 'No seams yet — set a width/height Δ.'; }
  }
  if (!img) img = result || orig;
  if (view.width !== img.width || view.height !== img.height) { view.width = img.width; view.height = img.height; }
  vctx.putImageData(img, 0, 0);
  $('#viewnote').textContent = note;
  applyZoom();
}

function applyZoom() {
  if (!view.width) return;
  let z;
  if (zoomMode === 'fit') {
    const cw = stage.clientWidth - 24, ch = stage.clientHeight - 24;
    z = Math.min(cw / view.width, ch / view.height);
  } else z = +zoomMode;
  const cssW = Math.max(1, Math.round(view.width * z)) + 'px', cssH = Math.max(1, Math.round(view.height * z)) + 'px';
  view.style.width = cssW;
  view.style.height = cssH;
  view.classList.toggle('pixelated', z >= 2);
  stage.classList.toggle('fit', zoomMode === 'fit');
}

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
    result = null; mask = null;
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
function encOpts() {
  const pr = Math.min(100, Math.max(0, +params.out.protect || 0));
  return { quality: +params.out.quality || 92, sub: params.out.sub || '444', hf: Math.round(pr * 0.5), dither: pr };
}
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
$('#resetall').addEventListener('click', () => { applyLook('clean'); $('#look').value = ''; });
const lookSel = $('#look');
for (const [id, l] of Object.entries(LOOKS)) { const o = document.createElement('option'); o.value = id; o.textContent = l.label; lookSel.append(o); }
lookSel.addEventListener('change', () => { if (lookSel.value) applyLook(lookSel.value); });

function setView(v) {
  viewMode = v;
  document.querySelectorAll('#views button').forEach(x => x.classList.toggle('on', x.dataset.view === v));
  $('#ampwrap').hidden = viewMode !== 'diff';
  render();
}
document.querySelectorAll('#views button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('#amp').addEventListener('input', (e) => { diffAmp = +e.target.value; $('#ampv').textContent = '×' + diffAmp; if (viewMode === 'diff') render(); });
$('#zoom').addEventListener('change', (e) => { zoomMode = e.target.value; applyZoom(); });
window.addEventListener('resize', () => { if (zoomMode === 'fit') applyZoom(); });

const hold = $('#hold');
const holdOn = (e) => { e.preventDefault(); if (!holding) { holding = true; render(); } };
const holdOff = () => { if (holding) { holding = false; render(); } };
hold.addEventListener('pointerdown', holdOn);
['pointerup', 'pointerleave', 'pointercancel'].forEach(t => hold.addEventListener(t, holdOff));
window.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (e.code === 'Space') holdOn(e);
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
