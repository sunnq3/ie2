'use strict';

/*
 * ie2 — one-panel version.
 * A handful of controls; everything else is fixed at the settings that tested best for a clean,
 * natural, camera-like result. The processing engine (worker.js) is shared with v2/v3.
 */

const $ = (s) => document.querySelector(s);
const clone = (o) => JSON.parse(JSON.stringify(o));

const DEFAULTS = {
  fix: false,
  fringe: { amount: 0, type: 'achromat' },
  grain: { amount: 0, shadows: 1, colour: 1, fill: false },
  size: { final: 100 },
  out: { quality: 92, protect: 60, name: '' },
};
const STORE = 'ie2.simple';

const SECTIONS = [
  { title: 'Clean-up', controls: [
    { k: 'fix', type: 'check', label: 'Fix JPEG blocks & banding', hint: 'Smooths 8×8 compression blocks and stepped gradients already in the photo. Leave off if the photo looks clean.' },
  ] },
  { title: 'Lens fringing', controls: [
    { k: 'fringe.amount', type: 'range', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
    { k: 'fringe.type', type: 'select', label: 'Type', options: [['achromat', 'Green / magenta (most lenses)'], ['singlet', 'Blue / yellow (simple lens)']] },
  ], hint: 'Modelled on measured lenses: blue-led fringes that grow toward the corners, purple / green rims on out-of-focus edges, purple fringing beside blown highlights. Only colour changes — detail stays sharp. 25 % is a typical camera.' },
  { title: 'Grain', controls: [
    { k: 'grain.amount', type: 'range', label: 'Amount', min: 0, max: 4, step: 0.01, unit: '×' },
    { k: 'grain.shadows', type: 'range', label: 'Shadow grain', min: 0, max: 4, step: 0.01, unit: '×' },
    { k: 'grain.colour', type: 'range', label: 'Colour noise', min: 0, max: 3, step: 0.01, unit: '×' },
    { k: 'grain.fill', type: 'check', label: 'Fill smoothed patches', hint: 'Puts matching noise back only where an earlier edit (retouching, healing, AI clean-up) wiped it out.' },
  ], hint: 'Real camera sensor noise, added last so nothing softens it. Builds up in dark areas like a real camera. 1× is a typical camera.' },
  { title: 'Size', controls: [
    { k: 'size.final', type: 'range', label: 'Final size', min: 10, max: 200, step: 1, unit: '%' },
  ], hint: 'Resize before any other edit, so nothing added later is resampled. Set this to the size the photo will be shown at.' },
  { title: 'Export', controls: [
    { k: 'out.quality', type: 'range', label: 'Quality', min: 50, max: 100, step: 0.5, unit: '%' },
    { k: 'out.protect', type: 'range', label: 'Protect grain', min: 0, max: 100, step: 1, unit: '%' },
    { k: 'out.name', type: 'text', label: 'Filename', placeholder: 'auto' },
  ], hint: 'Full-resolution colour. Protect grain keeps fine grain from being rounded away by compression (bigger file). Check the JPEG view before exporting.' },
];

/*
 * Lens fringing, modelled on measured lenses (s = Amount / 25; 25 % is a typical camera lens):
 *  - lateral CA: blue vs green dominates, red vs green is small; radial profile is a lensfun-style
 *    polynomial, ~0 inside a third of the radius and growing toward the corners
 *    (at 25 % blue sits ~0.05 % of the radius off at the corner = Imatest "low")
 *  - a slightly decentred CA axis, so the two sides of the frame are not mirror images
 *  - longitudinal CA: purple rims in front of the focal plane, green behind, only where the image is
 *    out of focus (anywhere in the frame, centre included)
 *  - purple fringing on the dark side of clipped highlights, wider toward the corners
 *  - fringes softened the way a Bayer sensor records them
 * Only colour changes; brightness comes from the uncorrected geometry, so detail never softens.
 */
function caParams(s, type) {
  const on = s > 0, simple = type === 'singlet';
  return {
    keepLuma: true, linear: true,
    rx: 0, ry: 0, gx: 0, gy: 0, bx: 0.04 * s, by: -0.03 * s,
    rs: (simple ? 0.03 : 0.012) * s, gs: 0, bs: -(simple ? 0.07 : 0.055) * s,
    ocx: 2.5, ocy: -1.5,
    fall: { curve: 'poly', poly: [0.35, 0, 0.95, -0.3], exp: 1, start: 0, width: 30, aspect: 3, shifts: false },
    disp: { on, lens: type, amount: (simple ? 0.15 : 0.12) * s, bands: 10, balance: 550 },
    axial: { on, r: simple ? 0 : Math.min(0.4, 0.12 * s), g: 0, b: Math.min(0.7, (simple ? 0.35 : 0.22) * s), edge: 0 },
    cam: {
      on, loca: Math.min(0.35, 0.05 * s),
      front: simple ? [1, 0.4, 0] : [1, 0, 1], behind: simple ? [0, 0.4, 1] : [0, 1, 0],
      pf: Math.min(0.8, 0.22 * s), pfw: 1.6 + 0.8 * Math.min(4, s), pfThr: 232, soft: 0.6,
    },
    pf: { on: false }, irr: { on: false }, cl: { on: false }, smear: { on: false }, echo: { on: false },
  };
}

// Everything the engine needs, derived from the few visible settings.
function toWorker(p) {
  const s = Math.max(0, +p.fringe.amount || 0) / 25, fr = s > 0, final = +p.size.final || 100;
  return {
    clean: { on: !!p.fix, deblock: { on: !!p.fix, threshold: 8, strength: 100 }, deband: { on: !!p.fix, radius: 16, threshold: 3, grain: 0.6, passes: 1 } },
    carve: { on: false, dw: 0, dh: 0, energy: 'forward' },
    lens: { on: fr, k1: 0, k2: 0, cx: 0, cy: 0, zoom: 1, autofill: true, interp: 'lanczos3' },
    ca: caParams(s, p.fringe.type),
    resize: { on: true },
    scale: { on: final !== 100, up: 1, final, upMethod: 'bicubic', downMethod: final < 100 ? 'box' : 'lanczos3', quant: false },
    blend: { on: false }, sharpen: { on: false },
    grain: { on: true, fill: { on: !!p.grain.fill, strength: 100, match: 1, pct: 7, size: 6 } },
    sensor: {
      on: +p.grain.amount > 0, amount: +p.grain.amount, shadows: +p.grain.shadows, colour: +p.grain.colour, seed: 1,
      shot: 0.06, read: 0.09, rgain: 30, bgain: 50, lumaNR: 70, sharpen: 1, sharpenR: 1.6, chromaNR: 90, blotch: 2, blotchSize: 3,
    },
  };
}

/* ---------------- state ---------------- */

let params = loadParams();
let orig = null, origName = 'image', result = null;
let viewMode = 'result', holding = false, zoomMode = 'fit';
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
  try { const s = localStorage.getItem(STORE); if (s) p = deepMerge(p, JSON.parse(s)); } catch (e) {}
  return p;
}
function saveParams() { try { localStorage.setItem(STORE, JSON.stringify(params)); } catch (e) {} }

/* ---------------- panel ---------------- */

function decimals(step) { const s = String(step); return s.includes('.') ? s.split('.')[1].length : 0; }
function fmt(v, step) { return (+v).toFixed(decimals(step)); }

function makeControl(c) {
  const row = document.createElement('div');
  row.className = 'ctl ' + c.type;
  row.dataset.k = c.k;
  const def = getPath(DEFAULTS, c.k);
  if (c.type === 'range') {
    const lab = document.createElement('label'); lab.textContent = c.label; lab.title = 'Double-click to reset';
    const r = document.createElement('input'); r.type = 'range'; r.min = c.min; r.max = c.max; r.step = c.step;
    const n = document.createElement('input'); n.type = 'number'; n.step = c.step; n.inputMode = 'decimal';
    const u = document.createElement('span'); u.className = 'unit'; u.textContent = c.unit || '';
    const set = (v, user) => { r.value = v; n.value = fmt(v, c.step); row.classList.toggle('changed', +v !== +def); if (user) update(c.k, +v); };
    r.addEventListener('input', () => set(+r.value, true));
    n.addEventListener('change', () => { const v = parseFloat(n.value); set(Number.isFinite(v) ? Math.min(c.max, Math.max(c.min, v)) : def, true); });
    lab.addEventListener('dblclick', () => set(def, true));
    row.append(lab, r, n, u);
    CTRL[c.k] = { set: (v) => set(v, false) };
  } else if (c.type === 'check') {
    const lab = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox';
    lab.append(cb, document.createTextNode(' ' + c.label));
    cb.addEventListener('change', () => { row.classList.toggle('changed', cb.checked !== def); update(c.k, cb.checked); });
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
  const frag = document.createDocumentFragment(); frag.append(row);
  if (c.hint) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = c.hint; frag.append(p); }
  return frag;
}

function buildPanel() {
  const panel = $('#panel'); panel.innerHTML = '';
  for (const sec of SECTIONS) {
    const el = document.createElement('section'); el.className = 'sec';
    const h = document.createElement('h3'); h.textContent = sec.title; el.append(h);
    if (sec.hint) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = sec.hint; el.append(p); }
    for (const c of sec.controls) el.append(makeControl(c));
    panel.append(el);
  }
  syncUI();
}
function syncUI() { for (const k in CTRL) CTRL[k].set(getPath(params, k)); }

function update(k, v) {
  setPath(params, k, v);
  saveParams();
  if (k.startsWith('out.')) { if (k !== 'out.name' && viewMode === 'jpeg') { clearTimeout(pvTimer); pvTimer = setTimeout(render, 200); } return; }
  schedule();
}

/* ---------------- worker ---------------- */

let worker = null, jobId = 0, inflight = null, pending = false, timer = 0;

function makeWorker() {
  if (worker) worker.terminate();
  worker = new Worker('worker.js');
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => { setStatus('Worker error: ' + (e.message || e), true); inflight = null; hideBar(); };
  if (orig) { const copy = orig.data.slice(); worker.postMessage({ type: 'load', w: orig.width, h: orig.height, buffer: copy.buffer }, [copy.buffer]); }
}
function schedule() { clearTimeout(timer); timer = setTimeout(dispatch, 80); }
function dispatch() {
  if (!orig) return;
  if (inflight) { pending = true; return; }
  inflight = { id: ++jobId };
  worker.postMessage({ type: 'process', id: inflight.id, params: toWorker(params) });
}
function onWorkerMessage(e) {
  const m = e.data;
  if (!inflight || m.id !== inflight.id) return;
  if (m.type === 'progress') { showBar(m.frac, m.label); return; }
  if (m.type === 'error') { setStatus('Error: ' + m.message, true); inflight = null; hideBar(); }
  else if (m.type === 'result') {
    result = new ImageData(new Uint8ClampedArray(m.buffer), m.w, m.h);
    resultVer++;
    inflight = null; hideBar();
    render(); updateMeta(m.ms);
    $('#export').disabled = false;
  }
  if (pending) { pending = false; dispatch(); }
}

/* ---------------- viewer ---------------- */

const view = $('#view'), vctx = view.getContext('2d'), stage = $('#stage');

function render() {
  if (!orig) return;
  let img = null, note = '';
  const mode = holding ? 'original' : viewMode;
  if (mode === 'original') img = orig;
  else if (mode === 'jpeg' && result) {
    if (jpegPreview && jpegPreview.key === encKey() && jpegPreview.img) { img = jpegPreview.img; note = 'JPEG view: the decoded export file'; }
    else { note = 'Encoding JPEG preview…'; refreshJpegPreview(); }
  }
  if (!img) img = result || orig;
  if (view.width !== img.width || view.height !== img.height) { view.width = img.width; view.height = img.height; }
  vctx.putImageData(img, 0, 0);
  if (!note && zoomMode === 'fit' && (view.width > stage.clientWidth || view.height > stage.clientHeight)) note = 'Preview scaled to fit — use 100% to judge detail';
  $('#viewnote').textContent = note;
  applyZoom();
}
function applyZoom() {
  if (!view.width) return;
  let z;
  if (zoomMode === 'fit') z = Math.min((stage.clientWidth - 24) / view.width, (stage.clientHeight - 24) / view.height, 1);
  else z = +zoomMode;
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
  const inS = `${orig.width}×${orig.height}`, outS = result ? `${result.width}×${result.height}` : inS;
  $('#meta').textContent = `${origName} · ${inS}` + (outS !== inS ? ` → ${outS}` : '');
  if (ms != null) setStatus(`Processed in ${Math.round(ms)} ms`);
}

/* ---------------- loading ---------------- */

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Failed to load ' + src)); document.head.append(s); });
}
async function decodeToCanvasSource(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {}
  try { const img = new Image(); img.src = URL.createObjectURL(file); await img.decode(); return img; } catch (e) {}
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
    const buf = await file.arrayBuffer(), ifds = window.UTIF.decode(buf);
    window.UTIF.decodeImage(buf, ifds[0]);
    return new ImageData(new Uint8ClampedArray(window.UTIF.toRGBA8(ifds[0]).buffer), ifds[0].width, ifds[0].height);
  }
  throw new Error('This browser cannot decode that file format.');
}
async function loadFile(file) {
  if (!file) return;
  setStatus('Loading ' + (file.name || 'image') + '…');
  try {
    const src = await decodeToCanvasSource(file), W = src.width, H = src.height;
    if (!W || !H) throw new Error('Image has no pixels.');
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
    if (src instanceof ImageData) { const t = document.createElement('canvas'); t.width = W; t.height = H; t.getContext('2d').putImageData(src, 0, 0); x.drawImage(t, 0, 0); }
    else x.drawImage(src, 0, 0);
    orig = x.getImageData(0, 0, W, H);
    origName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
    result = null;
    $('#drop').classList.add('hidden');
    CTRL['out.name'].el.placeholder = origName + '_ie2.jpg';
    makeWorker(); render(); updateMeta(); dispatch();
  } catch (err) { setStatus('Could not open image: ' + (err.message || err), true); }
}

/* ---------------- JPEG preview & export ---------------- */

let encWorker = null, encSeq = 0, encCache = null, encPending = null, jpegPreview = null, pvTimer = 0, resultVer = 0, pvBusy = false;
const encWaiters = new Map();
function getEncWorker() {
  if (!encWorker) {
    encWorker = new Worker('worker.js');
    encWorker.onmessage = (e) => {
      const m = e.data, r = encWaiters.get(m.id); if (!r) return;
      encWaiters.delete(m.id);
      if (m.type === 'encoded') r.res(new Uint8Array(m.buffer)); else r.rej(new Error(m.message || 'encode failed'));
    };
  }
  return encWorker;
}
function encOpts() { const pr = Math.min(100, Math.max(0, +params.out.protect || 0)); return { quality: +params.out.quality || 92, sub: '444', hf: Math.round(pr * 0.5), dither: pr }; }
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
function detailKept(a, b) {
  const w = a.width, h = a.height, A = a.data, B = b.data;
  const L = (d, p) => 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
  let num = 0, den = 0; const step = w * h > 4e6 ? 2 : 1;
  for (let y = 1; y < h - 1; y += step) for (let x = 1; x < w - 1; x += step) {
    const p = y * w + x;
    const ha = L(A, p) - (L(A, p - 1) + L(A, p + 1) + L(A, p - w) + L(A, p + w)) / 4;
    const hb = L(B, p) - (L(B, p - 1) + L(B, p + 1) + L(B, p - w) + L(B, p + w)) / 4;
    num += ha * hb; den += ha * ha;
  }
  return den > 0 ? Math.max(0, Math.min(100, 100 * num / den)) : 100;
}
async function refreshJpegPreview() {
  if (!result || pvBusy) return;
  pvBusy = true;
  try {
    const key = encKey(), enc = await getEncoded();
    if (!enc.img) {
      const bmp = await createImageBitmap(new Blob([enc.bytes], { type: 'image/jpeg' }));
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0);
      enc.img = x.getImageData(0, 0, c.width, c.height);
      enc.kept = detailKept(enc.src, enc.img);
    }
    jpegPreview = enc;
    if (viewMode === 'jpeg') { setStatus(`JPEG · ${fmtSize(enc.bytes.length)} · fine detail kept ${enc.kept.toFixed(1)}%`); if (key === encKey()) render(); }
  } catch (err) { setStatus('JPEG preview failed: ' + (err.message || err), true); }
  finally { pvBusy = false; if (viewMode === 'jpeg' && result && (!jpegPreview || jpegPreview.key !== encKey())) setTimeout(render, 0); }
}
async function exportJpg() {
  if (!result) return;
  let name = (params.out.name || '').trim() || (origName + '_ie2.jpg');
  if (!/\.jpe?g$/i.test(name)) name += '.jpg';
  setStatus('Encoding JPEG…');
  try {
    const enc = await getEncoded(), blob = new Blob([enc.bytes], { type: 'image/jpeg' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus(`Exported ${name} · ${enc.src.width}×${enc.src.height} · ${fmtSize(blob.size)}`);
  } catch (err) { setStatus('Export failed: ' + (err.message || err), true); }
}

/* ---------------- wiring ---------------- */

buildPanel();
$('#file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
$('#drop').addEventListener('click', () => $('#file').click());
$('#export').addEventListener('click', exportJpg);
$('#resetall').addEventListener('click', () => { const name = params.out.name; params = clone(DEFAULTS); params.out.name = name; syncUI(); saveParams(); schedule(); });

function setView(v) {
  viewMode = v;
  document.querySelectorAll('#views button').forEach(x => x.classList.toggle('on', x.dataset.view === v));
  render();
}
document.querySelectorAll('#views button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('#zoom').addEventListener('change', (e) => { zoomMode = e.target.value; render(); });
window.addEventListener('resize', () => { if (zoomMode === 'fit') applyZoom(); });

const hold = $('#hold');
const holdOn = (e) => { e.preventDefault(); if (!holding) { holding = true; render(); } };
const holdOff = () => { if (holding) { holding = false; render(); } };
hold.addEventListener('pointerdown', holdOn);
['pointerup', 'pointerleave', 'pointercancel'].forEach(t => hold.addEventListener(t, holdOff));
window.addEventListener('keydown', (e) => { if (!/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && e.code === 'Space') holdOn(e); });
window.addEventListener('keyup', (e) => { if (e.code === 'Space') holdOff(); });

['dragenter', 'dragover'].forEach(t => window.addEventListener(t, (e) => { e.preventDefault(); document.body.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(t => window.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) document.body.classList.remove('dragging'); }));
window.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) loadFile(f); });
window.addEventListener('paste', (e) => {
  const it = (e.clipboardData ? [...e.clipboardData.items] : []).find(i => i.kind === 'file');
  if (it) { e.preventDefault(); loadFile(it.getAsFile()); }
});
