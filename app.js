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
  out: { quality: 92, name: '' },
};

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
  const def = getPath(DEFAULTS, c.k);

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
}

function resetSection(sec) {
  for (const c of sec.controls) {
    if (c.k === 'out.name') continue;
    setPath(params, c.k, clone(getPath(DEFAULTS, c.k)));
  }
  syncUI(); saveParams();
  if (sec.id !== 'out') schedule();
}

function update(k, v) {
  setPath(params, k, v);
  saveParams();
  if (!k.startsWith('out.')) schedule();
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
  const mode = holding ? 'original' : viewMode;
  if (mode === 'original') img = orig;
  else if (mode === 'diff') { img = diffImage(); if (!img) note = 'Diff needs equal dimensions — seam carving changed the size. Showing result.'; }
  else if (mode === 'seams') { img = seamImage(); if (!mask || !mask.some(v => v)) note = 'No seams yet — set a width/height Δ.'; }
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
  view.style.width = Math.max(1, Math.round(view.width * z)) + 'px';
  view.style.height = Math.max(1, Math.round(view.height * z)) + 'px';
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
  if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) holdOn(e);
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
