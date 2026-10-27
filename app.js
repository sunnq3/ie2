'use strict';

const $ = (s) => document.querySelector(s);
const clone = (o) => JSON.parse(JSON.stringify(o));

const DEFAULTS = {
  carve: { dw: 0, dh: 0, energy: 'forward' },
  lens: { k1: 0, k2: 0, cx: 0, cy: 0, zoom: 1, autofill: true, interp: 'bicubic' },
  ca: { rx: 0, ry: 0, gx: 0, gy: 0, bx: 0, by: 0, rs: 0, gs: 0, bs: 0 },
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
  brush: { size: 24, hard: 50, opacity: 100, mode: 'add', show: true },
  out: { quality: 92, name: '' },
};
const NOPROCESS = ['out.', 'brush.'];

const SCHEMA = [
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
    note: 'Per-channel sub-pixel shift (px) and radial scale (%, lateral CA from the lens centre).',
    controls: [
      { k: 'ca.rx', label: 'Red X', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px' },
      { k: 'ca.ry', label: 'Red Y', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px' },
      { k: 'ca.gx', label: 'Green X', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px' },
      { k: 'ca.gy', label: 'Green Y', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px' },
      { k: 'ca.bx', label: 'Blue X', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px' },
      { k: 'ca.by', label: 'Blue Y', type: 'range', min: -5, max: 5, step: 0.01, unit: 'px' },
      { k: 'ca.rs', label: 'Red radial', type: 'range', min: -1, max: 1, step: 0.001, unit: '%' },
      { k: 'ca.gs', label: 'Green radial', type: 'range', min: -1, max: 1, step: 0.001, unit: '%' },
      { k: 'ca.bs', label: 'Blue radial', type: 'range', min: -1, max: 1, step: 0.001, unit: '%' },
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
      { k: 'brush.show', label: 'Show painted mask', type: 'check' },
    ],
  },
  {
    id: 'out', title: 'Export',
    controls: [
      { k: 'out.quality', label: 'JPEG quality', type: 'range', min: 1, max: 100, step: 0.5, unit: '%' },
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
  // dim the sub-controls of disabled colour stages
  for (const s of ['linear', 'p3', 'lab', 'hsv', 'hsl', 'ycc']) {
    const on = params.color[s].on;
    document.querySelectorAll(`.ctl.sub[data-k^="color.${s}."]`).forEach(el => el.classList.toggle('off', !on));
  }
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
  renderOverlay();
}

function update(k, v) {
  setPath(params, k, v);
  saveParams();
  if (k === 'noise.irregular') syncSubs();
  if (k === 'brush.show') renderOverlay();
  if (!NOPROCESS.some(p => k.startsWith(p))) schedule();
}

/* ---------------- worker ---------------- */

let worker = null, jobId = 0, inflight = null, pending = false, workerCarveKey = null, timer = 0;

function carveKeyOf(p) { return `${Math.round(+p.carve.dw || 0)}|${Math.round(+p.carve.dh || 0)}|${p.carve.energy}`; }

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

function drawStroke(s, from) {
  const W = overlay.width, H = overlay.height, p = s.pts;
  octx.save();
  octx.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
  octx.strokeStyle = octx.fillStyle = '#ff2bd6';
  octx.globalAlpha = s.mode === 'erase' ? 1 : Math.max(0.15, s.o);
  const lw = Math.max(1, s.r * W * 2);
  octx.lineWidth = lw; octx.lineCap = 'round'; octx.lineJoin = 'round';
  if (p.length <= 2 || from === 0 && p.length <= 2) {
    octx.beginPath(); octx.arc(p[0] * W, p[1] * H, lw / 2, 0, Math.PI * 2); octx.fill();
  } else {
    const st = Math.max(0, (from || 0) - 2);
    octx.beginPath(); octx.moveTo(p[st] * W, p[st + 1] * H);
    for (let k = st + 2; k + 1 < p.length; k += 2) octx.lineTo(p[k] * W, p[k + 1] * H);
    octx.stroke();
  }
  octx.restore();
}

function renderOverlay() {
  const show = !!result && (paintMode || params.brush.show) && !holding;
  overlay.hidden = !show;
  if (!show) return;
  if (overlay.width !== view.width || overlay.height !== view.height) { overlay.width = view.width; overlay.height = view.height; }
  octx.clearRect(0, 0, overlay.width, overlay.height);
  for (const s of strokes) drawStroke(s, 0);
  if (curStroke) drawStroke(curStroke, 0);
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
  else if (act === 'undo') { if (strokes.length) { strokes.pop(); renderOverlay(); schedule(); } }
  else if (act === 'clear') { if (strokes.length) { strokes = []; renderOverlay(); schedule(); } }
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
  renderOverlay();
});
wrap.addEventListener('pointermove', (e) => {
  moveRing(e);
  if (!curStroke) return;
  const [nx, ny, r] = evToNorm(e);
  const p = curStroke.pts, lx = p[p.length - 2], ly = p[p.length - 1];
  const distPx = Math.hypot((nx - lx) * view.width, (ny - ly) * view.height);
  if (distPx < 0.25 && r) return;
  p.push(nx, ny);
  drawStroke(curStroke, p.length - 2);
});
const endStroke = () => {
  if (!curStroke) return;
  strokes.push(curStroke); curStroke = null;
  renderOverlay(); schedule();
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
    result = null; mask = null; strokes = []; curStroke = null;
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

function exportJpg() {
  if (!result) return;
  const c = document.createElement('canvas');
  c.width = result.width; c.height = result.height;
  c.getContext('2d').putImageData(result, 0, 0);
  let name = (params.out.name || '').trim() || (origName + '_ie2.jpg');
  if (!/\.jpe?g$/i.test(name)) name += '.jpg';
  const q = Math.min(1, Math.max(0.01, (+params.out.quality || 92) / 100));
  c.toBlob((blob) => {
    if (!blob) { setStatus('Export failed.', true); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus(`Exported ${name} · ${result.width}×${result.height} · ${(blob.size / 1024).toFixed(1)} KB · q ${Math.round(q * 1000) / 10}`);
  }, 'image/jpeg', q);
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
