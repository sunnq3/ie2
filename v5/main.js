'use strict';
/* ie2 v5 — interface: rack, viewer, presets, export. */

const $ = (s, r = document) => r.querySelector(s);
const KEY = 'ie2.v5.state';

/* ---------------- state ---------------- */
function freshState() {
  const st = { seed: 1, intensity: 100, fx: {} };
  for (const e of EFFECTS) { const p = { on: !!e.defOn }; for (const q of e.params) p[q.k] = q.d; st.fx[e.id] = p; }
  return st;
}
function restore() {
  const st = freshState();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && s.fx) {
      st.seed = Number.isFinite(+s.seed) ? +s.seed : 1;
      st.intensity = Number.isFinite(+s.intensity) ? Math.min(150, Math.max(0, +s.intensity)) : 100;
      for (const id in st.fx) if (s.fx[id]) for (const k in st.fx[id]) if (typeof s.fx[id][k] === typeof st.fx[id][k]) st.fx[id][k] = s.fx[id][k];
    }
  } catch (e) { /* storage unavailable */ }
  return st;
}
let state = restore();
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } };

/* ---------------- GPU ---------------- */
const cv = $('#cv');
let gpu = null;
try { gpu = GPU.create(cv); } catch (e) {
  const d = document.createElement('div'); d.className = 'fatal'; d.textContent = 'ie2 v5 can’t start: ' + e.message; document.body.append(d);
}

/* ---------------- rack ---------------- */
const views = {};
const decimals = (step) => (String(step).split('.')[1] || '').length;
const show = (v, step) => (+v).toFixed(decimals(step));

function buildRack() {
  const list = $('#fxlist');
  for (const [gid, gname] of GROUPS) {
    const g = document.createElement('section'); g.className = 'grp'; g.dataset.g = gid;
    const h = document.createElement('button'); h.type = 'button'; h.className = 'grp-h';
    h.innerHTML = '<span class="grp-n"></span><span class="grp-c"></span><span class="chev"></span>';
    $('.grp-n', h).textContent = gname;
    h.addEventListener('click', () => g.classList.toggle('shut'));
    const body = document.createElement('div'); body.className = 'grp-b';
    for (const e of EFFECTS) if (e.group === gid) body.append(buildEffect(e));
    g.append(h, body); list.append(g);
  }
}

function buildEffect(e) {
  const el = document.createElement('article'); el.className = 'fx'; el.dataset.id = e.id;
  el.innerHTML = '<header class="fx-h"><label class="sw"><input type="checkbox"><i></i></label><button type="button" class="fx-n"></button><span class="badge" hidden></span><button type="button" class="fx-r" title="Back to this effect’s defaults">↺</button></header><p class="fx-i"></p><div class="fx-p"></div>';
  const cb = $('input', el), nm = $('.fx-n', el);
  nm.textContent = e.name; $('.fx-i', el).textContent = e.info;
  cb.setAttribute('aria-label', e.name);
  const st = () => state.fx[e.id];
  cb.addEventListener('change', () => { st().on = cb.checked; el.classList.remove('folded'); sync(); changed(); });
  nm.addEventListener('click', () => {
    if (!st().on) { st().on = true; el.classList.remove('folded'); sync(); changed(); }
    else el.classList.toggle('folded');
  });
  $('.fx-r', el).addEventListener('click', () => { for (const q of e.params) st()[q.k] = q.d; sync(); changed(); });
  const host = $('.fx-p', el), adv = e.params.filter(q => q.adv);
  const rows = e.params.filter(q => !q.adv).map(q => buildParam(e, q, host, sync));
  if (adv.length) {
    const more = document.createElement('button'); more.type = 'button'; more.className = 'fx-more'; more.textContent = 'More settings';
    const box = document.createElement('div'); box.className = 'fx-adv';
    more.addEventListener('click', () => { el.classList.toggle('adv-open'); more.textContent = el.classList.contains('adv-open') ? 'Fewer settings' : 'More settings'; });
    host.append(more, box);
    rows.push(...adv.map(q => buildParam(e, q, box, sync)));
  }
  function sync() { cb.checked = st().on; el.classList.toggle('on', st().on); rows.forEach(r => r()); }
  views[e.id] = { el, sync, badge: $('.badge', el) };
  sync();
  return el;
}

function buildParam(e, q, host, syncEffect) {
  const row = document.createElement('div'); row.className = 'pr';
  const st = () => state.fx[e.id];
  const mark = () => {
    const v = st()[q.k];
    row.classList.toggle('mod', v !== q.d);
    row.classList.toggle('beyond', !!q.real && (v < q.real[0] - 1e-9 || v > q.real[1] + 1e-9));
  };
  let sync;
  if (q.o) {
    row.classList.add('sel');
    const lab = document.createElement('span'); lab.className = 'pr-l'; lab.textContent = q.l;
    const s = document.createElement('select');
    for (const [v, t] of q.o) s.add(new Option(t, v));
    s.addEventListener('change', () => {
      st()[q.k] = s.value;
      // choices like "Camera" or "Like (platform)" set the effect's other settings to match
      const set = e.sets && e.sets.k === q.k && e.sets.from[s.value];
      if (set) { Object.assign(st(), set); syncEffect(); }
      mark(); changed();
    });
    row.append(lab, s);
    sync = () => { s.value = st()[q.k]; mark(); };
  } else if (q.b) {
    row.classList.add('chk');
    const lab = document.createElement('label'), c = document.createElement('input'); c.type = 'checkbox';
    lab.append(c, document.createTextNode(q.l));
    c.addEventListener('change', () => { st()[q.k] = c.checked; mark(); changed(); });
    row.append(lab);
    sync = () => { c.checked = st()[q.k]; mark(); };
  } else {
    row.classList.add('rng');
    const lab = document.createElement('span'); lab.className = 'pr-l'; lab.textContent = q.l; lab.title = 'Double-click to reset';
    const r = document.createElement('input'); r.type = 'range'; r.min = q.min; r.max = q.max; r.step = q.step; r.setAttribute('aria-label', q.l);
    if (q.real) {   // shade the range real cameras / devices produce
      const pc = (v) => (100 * (v - q.min) / (q.max - q.min)).toFixed(2) + '%';
      r.style.setProperty('--lo', pc(q.real[0])); r.style.setProperty('--hi', pc(q.real[1])); r.classList.add('band');
      row.title = 'Shaded: the range real ' + (e.group === 'analog' || e.group === 'display' ? 'devices' : 'cameras') + ' produce';
    }
    const n = document.createElement('input'); n.type = 'text'; n.className = 'pr-v'; n.inputMode = 'decimal'; n.spellcheck = false;
    const u = document.createElement('span'); u.className = 'pr-u'; u.textContent = q.u || '';
    const fmtv = (v) => q.show ? q.show(+v) : show(v, q.step);
    r.addEventListener('input', () => { st()[q.k] = +r.value; n.value = fmtv(r.value); mark(); changed(); });
    n.addEventListener('change', () => {
      let v = parseFloat(n.value); if (Number.isFinite(v) && q.parse) v = q.parse(v); if (!Number.isFinite(v)) v = q.d;
      st()[q.k] = Math.min(q.max, Math.max(q.min, v)); sync(); changed();
    });
    lab.addEventListener('dblclick', () => { st()[q.k] = q.d; sync(); changed(); });
    row.append(lab, r, n, u);
    sync = () => { r.value = st()[q.k]; n.value = fmtv(st()[q.k]); mark(); };
  }
  host.append(row);
  return sync;
}

function syncAll() { for (const id in views) views[id].sync(); }

function refreshSummary() {
  for (const [gid] of GROUPS) {
    const n = EFFECTS.filter(e => e.group === gid && state.fx[e.id].on && e.id !== 'light').length;
    $(`.grp[data-g="${gid}"] .grp-c`).textContent = n ? n + ' on' : '';
  }
  const on = EFFECTS.filter(e => state.fx[e.id].on && e.id !== 'light');
  const chain = $('#chain');
  chain.textContent = 'chain: ';
  if (!on.length) { const b = document.createElement('b'); b.textContent = 'empty — switch an effect on'; chain.append(b); }
  on.forEach((e, i) => {
    if (i) { const a = document.createElement('i'); a.textContent = '→'; chain.append(a); }
    const b = document.createElement('b'); b.textContent = e.name; chain.append(b);
  });
}

function changed() { persist(); refreshSummary(); request(true); scheduleMeter(); }

/* the chain as the GPU runs it: light settings go to the scene conversion, amounts scaled by intensity */
function buildChain() {
  const k = state.intensity / 100;
  return EFFECTS.filter(e => state.fx[e.id].on && e.id !== 'light').map(e => {
    const p = Object.assign({}, state.fx[e.id]);
    for (const q of e.params) if (q.amt) p[q.k] = Math.min(q.max, Math.max(q.min, p[q.k] * k));
    return { fx: e, p };
  });
}
function chainOpts() {
  const L = state.fx.light;
  return { hr: L.on ? Math.pow(2, L.stops) : 1, knee: L.knee, k: state.intensity / 100 };
}

/* overall intensity */
function syncIntensity() { $('#inten').value = state.intensity; $('#intenv').textContent = state.intensity + '%'; }
$('#inten').addEventListener('input', (e) => { state.intensity = +e.target.value; syncIntensity(); changed(); });
$('#inten').addEventListener('dblclick', () => { state.intensity = 100; syncIntensity(); changed(); });

/* filter */
$('#find').addEventListener('input', (ev) => {
  const t = ev.target.value.trim().toLowerCase();
  for (const e of EFFECTS) views[e.id].el.hidden = !!t && !(e.name + ' ' + e.info).toLowerCase().includes(t);
  document.querySelectorAll('.grp').forEach(g => { g.hidden = ![...g.querySelectorAll('.fx')].some(f => !f.hidden); if (t) g.classList.remove('shut'); });
});

/* presets */
for (const [name] of PRESETS) $('#preset').add(new Option(name, name));
$('#preset').addEventListener('change', (ev) => {
  const pr = PRESETS.find(p => p[0] === ev.target.value);
  ev.target.value = '';
  if (!pr) return;
  const seed = state.seed; state = freshState(); state.seed = seed;
  for (const id in pr[1]) {
    const e = EFFECTS.find(x => x.id === id), v = pr[1][id];
    if (e && e.sets && v[e.sets.k] && e.sets.from[v[e.sets.k]]) Object.assign(state.fx[id], e.sets.from[v[e.sets.k]]);
    Object.assign(state.fx[id], v); state.fx[id].on = true;
  }
  syncAll(); changed(); say('preset: ' + pr[0]);
});
$('#reseed').addEventListener('click', () => { state.seed = 1 + Math.floor(Math.random() * 9999); changed(); say('seed ' + state.seed); });
$('#alloff').addEventListener('click', () => { for (const id in state.fx) state.fx[id].on = id === 'light' ? state.fx[id].on : false; syncAll(); changed(); });
$('#resetall').addEventListener('click', () => { const seed = state.seed; state = freshState(); state.seed = seed; syncAll(); syncIntensity(); changed(); });

/* ---------------- rendering ---------------- */
let stack = null, mergeDirty = false;   // merge of several versions (see "merge" below)
let loaded = false, needProcess = false, frameReq = 0, mode = 0, holdOrig = false, split = 0.5;
function request(processToo) { if (processToo) needProcess = true; if (!frameReq) frameReq = requestAnimationFrame(frame); }
function frame() {
  frameReq = 0;
  if (!loaded || !gpu) return;
  if (mergeDirty && stack && !cropping) {
    mergeDirty = false;
    try { runMerge(); } catch (e) { say(e.message, true); console.error(e); }
    needProcess = true;
  }
  if (needProcess && !cropping) {
    needProcess = false;
    const chain = buildChain();
    try { gpu.process(chain, state.seed, chainOpts()); say(chain.length ? `${chain.length} effect${chain.length > 1 ? 's' : ''}` : 'original'); }
    catch (e) { say(e.message, true); console.error(e); }
  }
  let tex = null;
  if (cropping) tex = gpu.base;
  else if (xs.asSaved) { try { tex = gpu.savedView(exportS()); } catch (e) { say(e.message, true); console.error(e); } }
  const w0 = cv.width, h0 = cv.height;
  gpu.show(cropping ? 0 : holdOrig ? 1 : mode, split, tex);
  if (cv.width !== w0 || cv.height !== h0) fit();
  $('#viewnote').textContent = !cropping && xs.asSaved ? viewNote() : '';
}
function say(t, err) { const s = $('#status'); s.textContent = t; s.classList.toggle('err', !!err); }

/* ---------------- viewer: zoom, pan, split ---------------- */
const stage = $('#stage'), frameEl = $('#frame');
let z = 1, tx = 0, ty = 0;
function place() {
  frameEl.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
  cv.classList.toggle('px', z >= 2);
  $('#zv').textContent = loaded ? Math.round(z * 100) + '%' : '–';
  const x = tx + split * cv.width * z;
  $('#split').style.left = x + 'px';
  $('#tagL').style.right = (stage.clientWidth - x + 8) + 'px';
  $('#tagR').style.left = (x + 8) + 'px';
  if (cropping) placeCrop();
}
function fit() {
  if (!loaded) return;
  const W = cv.width, H = cv.height, sw = stage.clientWidth, sh = stage.clientHeight;
  z = Math.min(1, (sw - 40) / W, (sh - 40) / H);
  tx = (sw - W * z) / 2; ty = (sh - H * z) / 2; place();
}
function zoomAt(nz, mx, my) {
  nz = Math.min(32, Math.max(0.03, nz));
  tx = mx - (mx - tx) * nz / z; ty = my - (my - ty) * nz / z; z = nz; place();
}
const centre = () => [stage.clientWidth / 2, stage.clientHeight / 2];
$('#zin').addEventListener('click', () => zoomAt(z * 1.5, ...centre()));
$('#zout').addEventListener('click', () => zoomAt(z / 1.5, ...centre()));
$('#zfit').addEventListener('click', fit);
$('#z1').addEventListener('click', () => zoomAt(1, ...centre()));
stage.addEventListener('wheel', (e) => {
  if (!loaded) return;
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  zoomAt(z * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

let drag = null;
stage.addEventListener('pointerdown', (e) => {
  if (!loaded || e.button !== 0 || e.target.closest('.drop')) return;
  if (cropping && e.target.closest('#cbox')) {
    const k = e.target.dataset.k || 'move';
    drag = { crop: k, x: e.clientX, y: e.clientY, c0: edit.crop.slice() };
    stage.setPointerCapture(e.pointerId);
    return;
  }
  const onSplit = !cropping && e.target === $('#split');
  drag = { split: onSplit, x: e.clientX, y: e.clientY, tx, ty };
  stage.setPointerCapture(e.pointerId);
  if (!onSplit) stage.classList.add('panning');
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.crop) { dragCrop(e); return; }
  if (drag.split) {
    const r = stage.getBoundingClientRect();
    split = Math.min(1, Math.max(0, (e.clientX - r.left - tx) / (cv.width * z)));
    place(); request(false);
  } else { tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y; place(); }
});
const endDrag = () => { drag = null; stage.classList.remove('panning'); };
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
window.addEventListener('resize', () => { if (loaded) place(); });

function setMode(m) {
  mode = m;
  document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', +b.dataset.m === m));
  document.body.classList.toggle('splitting', m === 2);
  place(); request(false);
}
document.querySelectorAll('#modes button').forEach(b => b.addEventListener('click', () => setMode(+b.dataset.m)));

window.addEventListener('keydown', (e) => {
  if (cropping && e.key === 'Escape') { endCrop(false); return; }
  if (cropping && e.key === 'Enter' && document.activeElement.tagName !== 'SELECT') { e.preventDefault(); endCrop(true); return; }
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (e.key === 'c' && loaded) { cropping ? endCrop(true) : startCrop(); return; }
  if (e.code === 'Space') { e.preventDefault(); if (!holdOrig) { holdOrig = true; request(false); } }
  else if (e.key === 'f') fit();
  else if (e.key === '1') zoomAt(1, ...centre());
  else if (e.key === 's' && !cropping) setMode(mode === 2 ? 0 : 2);
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space' && holdOrig) { holdOrig = false; request(false); } });

/* ---------------- loading ---------------- */
let baseName = 'image';
// Decode through <img>: every browser applies the photo's EXIF orientation there. ImageBitmaps are
// only a fallback, because some browsers ignore the orientation tag or flip them on GPU upload.
async function decode(file) {
  const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); return img; }
  catch (e) { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
function useSource(src, w0, h0, name) {
  if (!gpu) return;
  const cap = Math.min(gpu.maxTex, 8192), k = Math.min(1, cap / Math.max(w0, h0), Math.sqrt(24e6 / (w0 * h0)));
  // Always go through a plain 2D canvas: it is drawn upright in every browser, and a canvas uploads
  // to WebGL the same way everywhere (no browser-specific flips of images or bitmaps).
  const w = k < 1 ? Math.max(1, Math.round(w0 * k)) : w0, h = k < 1 ? Math.max(1, Math.round(h0 * k)) : h0;
  const s = document.createElement('canvas'); s.width = w; s.height = h;
  const x = s.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, h);
  if (cropping) endCrop(false);
  gpu.load(s, w, h);
  stack = null; $('#merge').hidden = true;
  geo = freshGeo();
  loaded = true; baseName = name; sourceNote = `${name} · ${w}×${h}` + (k < 1 ? ` (working copy of ${w0}×${h0})` : '');
  updateMeta();
  $('#drop').classList.add('gone');
  $('#save').disabled = false; $('#cropbtn').disabled = false;
  fit(); request(true); scheduleMeter();
}
async function openFile(file) {
  if (!file || !gpu) return;
  say('opening…');
  try {
    const src = await decode(file);
    useSource(src, src.naturalWidth || src.width, src.naturalHeight || src.height, (file.name || 'pasted').replace(/\.[^.]+$/, '') || 'image');
  } catch (e) { say('this browser can’t decode that file', true); }
}
$('#open').addEventListener('click', () => $('#file').click());
$('#open2').addEventListener('click', () => $('#file').click());
$('#mergebtn').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
$('#chart').addEventListener('click', () => { const c = testScene(); useSource(c, c.width, c.height, 'test-scene'); });
['dragenter', 'dragover'].forEach(t => window.addEventListener(t, (e) => { e.preventDefault(); document.body.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(t => window.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) document.body.classList.remove('dragging'); }));
window.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) openFiles(e.dataTransfer.files); });
window.addEventListener('paste', (e) => {
  const its = e.clipboardData ? [...e.clipboardData.items].filter(i => i.kind === 'file' && i.type.startsWith('image/')) : [];
  if (its.length) { e.preventDefault(); openFiles(its.map(i => i.getAsFile())); }
});

/* ---------------- merge ---------------- */
/* Several versions of the same picture are uploaded as layers and blended on the GPU into the
   source image; crop & rotate and the effect rack then work on the blend as on any other image. */
const MAXV = 8, MKEY = 'ie2.v5.merge';
const MERGE_MODES = [
  ['mix', 'Mix', 'A weighted blend: every version’s edits show, in proportion to its weight.'],
  ['median', 'Median', 'Keeps what most versions agree on; an edit only one or two have fades out. Weights count as votes.'],
  ['lighten', 'Lighten', 'The brightest version at each pixel: glows, halation, bloom and light leaks come through. Weight is opacity.'],
  ['darken', 'Darken', 'The darkest version at each pixel: scanlines, masks, shadows and dark fringes come through. Weight is opacity.'],
  ['sharpest', 'Sharpest', 'Takes whichever version has the most fine detail at each spot (grain counts as detail). Selectivity 0 is a plain mix.'],
  ['patch', 'Patchwork', 'Each area comes from a different version, joined with soft seams. Weight sets how much ground each one gets.'],
  ['channels', 'Channels', 'Red, green and blue each come from a version you choose.'],
  ['lumachroma', 'Detail + colour', 'Brightness and detail from one version, colour from another.'],
];
const mergeP = (() => {
  const d = { mode: 'mix', pow: 2, scale: 14, soft: 0.5, pseed: 1, w: [], solo: -1, ch: [0, 1, 2] };
  try { const s = JSON.parse(localStorage.getItem(MKEY) || 'null'); if (s) for (const k of ['mode', 'pow', 'scale', 'soft']) if (typeof s[k] === typeof d[k]) d[k] = s[k]; } catch (e) { /* ignore */ }
  if (!MERGE_MODES.some(m => m[0] === d.mode)) d.mode = 'mix';
  return d;
})();
const saveMerge = () => { try { localStorage.setItem(MKEY, JSON.stringify({ mode: mergeP.mode, pow: mergeP.pow, scale: mergeP.scale, soft: mergeP.soft })); } catch (e) { /* ignore */ } };
const markMerge = () => { saveMerge(); mergeDirty = true; request(false); scheduleMeter(); };

function runMerge() {
  const n = stack.names.length, solo = mergeP.solo, w = new Array(8).fill(0);
  for (let i = 0; i < n; i++) w[i] = solo >= 0 ? (i === solo ? 1 : 0) : Math.max(0, +mergeP.w[i] || 0) / 100;
  if (!w.some(v => v > 0)) w[0] = 1;   // everything off: show version 1 rather than nothing
  const mi = solo >= 0 ? 0 : MERGE_MODES.findIndex(m => m[0] === mergeP.mode);
  gpu.merge({ mode: mi, w, scale: mergeP.scale / 100 * Math.min(...gpu.source), soft: mergeP.soft, pow: mergeP.pow, seed: mergeP.pseed,
    ch: mergeP.ch.map(c => Math.min(n - 1, c)) });
  gpu.setGeometry(geo);
}

function openFiles(list) {
  const files = [...list].filter(Boolean);
  if (!files.length) return;
  if (files.length === 1) { openFile(files[0]); return; }
  openStack(files.slice(0, MAXV), files.length > MAXV);
}
async function openStack(files, clipped) {
  if (!gpu) return;
  say(`opening ${files.length} images…`);
  let imgs;
  try { imgs = await Promise.all(files.map(decode)); } catch (e) { say('one of those files can’t be decoded by this browser', true); return; }
  const dims = imgs.map(im => [im.naturalWidth || im.width, im.naturalHeight || im.height]), [w0, h0] = dims[0];
  // all versions are held on the GPU at once, so the per-image size budget shrinks with the count
  const cap = Math.min(gpu.maxTex, 8192), k = Math.min(1, cap / Math.max(w0, h0), Math.sqrt(Math.min(24e6, 64e6 / imgs.length) / (w0 * h0)));
  const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
  const odd = dims.filter(([a, b]) => a !== w0 || b !== h0).length;
  const canvases = imgs.map(im => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, w, h); return c;
  });
  const thumbs = canvases.map(c => {
    const t = document.createElement('canvas'); t.height = 64; t.width = Math.max(1, Math.round(64 * w / h));
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height); return t.toDataURL('image/jpeg', 0.8);
  });
  if (cropping) endCrop(false);
  gpu.loadStack(canvases, w, h);
  stack = { names: files.map((f, i) => (f.name || 'version ' + (i + 1)).replace(/\.[^.]+$/, '')), thumbs };
  mergeP.w = stack.names.map(() => 100); mergeP.solo = -1; mergeP.ch = [0, 1, 2].map(c => Math.min(c, files.length - 1));
  geo = freshGeo();
  loaded = true; baseName = stack.names[0] + '_merge';
  sourceNote = `merge of ${files.length} · ${stack.names[0]} · ${w}×${h}` + (k < 1 ? ' (working copies)' : '');
  buildMerge();
  runMerge(); mergeDirty = false;
  updateMeta();
  $('#drop').classList.add('gone');
  $('#save').disabled = false; $('#cropbtn').disabled = false;
  $('#fxlist').scrollTop = 0;
  fit(); request(true);
  const notes = [];
  if (odd) notes.push(`${odd} ${odd > 1 ? 'were' : 'was'} a different size and stretched to match the first`);
  if (clipped) notes.push(`only the first ${MAXV} were used`);
  setTimeout(() => say(`merged ${files.length} versions` + (notes.length ? ' · ' + notes.join(' · ') : ''), !!odd), 50);
}

function mrow(label, min, max, step, get, set, unit) {
  const row = document.createElement('div'); row.className = 'pr rng';
  const lab = document.createElement('span'); lab.className = 'pr-l'; lab.textContent = label;
  const r = document.createElement('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = get(); r.setAttribute('aria-label', label);
  const n = document.createElement('input'); n.type = 'text'; n.className = 'pr-v'; n.inputMode = 'decimal'; n.value = show(get(), step);
  const u = document.createElement('span'); u.className = 'pr-u'; u.textContent = unit || '';
  r.addEventListener('input', () => { set(+r.value); n.value = show(r.value, step); markMerge(); });
  n.addEventListener('change', () => { const v = parseFloat(n.value); if (Number.isFinite(v)) set(clamp(v, min, max)); r.value = get(); n.value = show(get(), step); markMerge(); });
  row.append(lab, r, n, u); return row;
}
function mpick(label, idx) {
  const row = document.createElement('div'); row.className = 'pr sel';
  const lab = document.createElement('span'); lab.className = 'pr-l'; lab.textContent = label;
  const s = document.createElement('select');
  stack.names.forEach((nm, i) => s.add(new Option(`${i + 1} · ${nm}`, i)));
  s.value = mergeP.ch[idx];
  s.addEventListener('change', () => { mergeP.ch[idx] = +s.value; markMerge(); });
  row.append(lab, s); return row;
}
function buildMerge() {
  const box = $('#merge'); box.textContent = ''; box.hidden = false;
  const h = document.createElement('div'); h.className = 'mg-h';
  const t = document.createElement('span'); t.className = 'mg-t'; t.textContent = `Merge · ${stack.names.length} versions`;
  const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Merge mode');
  for (const [v, l] of MERGE_MODES) sel.add(new Option(l, v));
  sel.value = mergeP.mode;
  h.append(t, sel);
  const hint = document.createElement('p'); hint.className = 'mg-hint';
  const rows = document.createElement('div'); rows.className = 'mg-rows';
  const ths = [];
  stack.names.forEach((nm, i) => {
    const row = document.createElement('div'); row.className = 'mg-row';
    const th = document.createElement('button'); th.type = 'button'; th.className = 'mg-th';
    th.style.backgroundImage = `url("${stack.thumbs[i]}")`; th.title = 'View this version alone (click again to merge)';
    th.setAttribute('aria-label', `View version ${i + 1} alone`);
    const name = document.createElement('span'); name.className = 'mg-n';
    const b = document.createElement('b'); b.textContent = i + 1; name.append(b, document.createTextNode(nm)); name.title = nm;
    const r = document.createElement('input'); r.type = 'range'; r.min = 0; r.max = 100; r.step = 1; r.value = mergeP.w[i]; r.setAttribute('aria-label', `Weight of version ${i + 1}`);
    const v = document.createElement('input'); v.type = 'text'; v.className = 'pr-v'; v.inputMode = 'numeric'; v.value = mergeP.w[i];
    const setW = (x) => { mergeP.w[i] = x; r.value = x; v.value = x; row.classList.toggle('off', x <= 0); markMerge(); };
    r.addEventListener('input', () => setW(+r.value));
    v.addEventListener('change', () => { const x = parseFloat(v.value); setW(Number.isFinite(x) ? clamp(Math.round(x), 0, 100) : 100); });
    th.addEventListener('click', () => {
      mergeP.solo = mergeP.solo === i ? -1 : i;
      ths.forEach((x, j) => x.classList.toggle('solo', j === mergeP.solo));
      say(mergeP.solo >= 0 ? `showing version ${i + 1} alone · click it again to merge` : 'merged');
      markMerge();
    });
    ths.push(th);
    row.append(th, name, r, v); rows.append(row);
  });
  const params = document.createElement('div'); params.className = 'mg-p';
  const fillParams = () => {
    params.textContent = '';
    const m = mergeP.mode;
    hint.textContent = MERGE_MODES.find(x => x[0] === m)[2];
    box.classList.toggle('noweights', m === 'channels' || m === 'lumachroma');
    if (m === 'sharpest') params.append(mrow('Selectivity', 0, 8, 0.1, () => mergeP.pow, (x) => { mergeP.pow = x; }));
    if (m === 'patch') {
      params.append(mrow('Patch size', 2, 60, 1, () => mergeP.scale, (x) => { mergeP.scale = x; }, '%'),
        mrow('Seam softness', 0, 1, 0.01, () => mergeP.soft, (x) => { mergeP.soft = x; }));
      const rb = document.createElement('button'); rb.type = 'button'; rb.className = 'b'; rb.textContent = 'Reshuffle patches';
      rb.addEventListener('click', () => { mergeP.pseed = 1 + Math.floor(Math.random() * 9999); markMerge(); });
      params.append(rb);
    }
    if (m === 'channels') params.append(mpick('Red from', 0), mpick('Green from', 1), mpick('Blue from', 2));
    if (m === 'lumachroma') params.append(mpick('Detail from', 0), mpick('Colour from', 1));
  };
  sel.addEventListener('change', () => { mergeP.mode = sel.value; fillParams(); markMerge(); });
  fillParams();
  box.append(h, hint, rows, params);
}

/* A synthetic scene with something for every effect: sky gradient, a clipped sun, street lights in
   the corners, dark silhouettes, colour patches, red-on-black text, fine lines and deep shadows. */
function testScene() {
  const W = 1800, H = 1200, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  let g = x.createLinearGradient(0, 0, 0, H * 0.62);
  g.addColorStop(0, '#0d3f8f'); g.addColorStop(0.55, '#5b9fe0'); g.addColorStop(1, '#f4d6a9');
  x.fillStyle = g; x.fillRect(0, 0, W, H * 0.62);
  g = x.createRadialGradient(1260, 330, 10, 1260, 330, 260);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.18, 'rgba(255,250,225,1)'); g.addColorStop(0.45, 'rgba(255,214,140,.55)'); g.addColorStop(1, 'rgba(255,190,120,0)');
  x.fillStyle = g; x.fillRect(900, 0, 760, 700);
  // skyline silhouettes
  x.fillStyle = '#16161c';
  [[0, 520, 140], [130, 430, 120], [240, 480, 90], [320, 380, 150], [460, 450, 110], [560, 500, 160], [1500, 470, 120], [1610, 400, 190]].forEach(([bx, by, bw]) => x.fillRect(bx, by, bw, H * 0.62 - by));
  for (let i = 0; i < 160; i++) { x.fillStyle = Math.random() < 0.6 ? '#ffd27a' : '#2a2a33'; x.fillRect(10 + (i % 40) * 17.5, 540 + Math.floor(i / 40) * 40, 7, 12); }
  // ground: deep shadow gradient
  g = x.createLinearGradient(0, H * 0.62, 0, H);
  g.addColorStop(0, '#2b2622'); g.addColorStop(1, '#050505');
  x.fillStyle = g; x.fillRect(0, H * 0.62, W, H * 0.38);
  // colour patches
  const cols = ['#735244', '#c29682', '#627a9d', '#576c43', '#8580b1', '#67bdaa', '#d67e2c', '#505ba6', '#c15a63', '#5e3c6c', '#9dbc40', '#e0a32e',
    '#383d96', '#469449', '#af363c', '#e7c71f', '#bb5695', '#0885a1', '#f3f3f2', '#c8c8c8', '#a0a0a0', '#7a7a79', '#555555', '#343434'];
  cols.forEach((col, i) => { x.fillStyle = col; x.fillRect(70 + (i % 6) * 74, 790 + Math.floor(i / 6) * 74, 66, 66); });
  // red and blue text on black, black text on white
  x.fillStyle = '#000'; x.fillRect(560, 790, 620, 140);
  x.font = '700 54px Arial, sans-serif'; x.fillStyle = '#ff1a1a'; x.fillText('RED ON BLACK', 585, 852);
  x.font = '700 40px Arial, sans-serif'; x.fillStyle = '#1f3dff'; x.fillText('blue text 4:2:0', 590, 905);
  x.fillStyle = '#fff'; x.fillRect(560, 950, 620, 150);
  x.fillStyle = '#111'; x.font = '15px Georgia, serif';
  ['The quick brown fox jumps over the lazy dog 0123456789.', 'Fine type shows subpixel fringes, ringing and mosquito noise.', 'Sharpening halos sit on every one of these letter edges.', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz'].forEach((t, i) => x.fillText(t, 575, 978 + i * 30));
  // fine stripes and a zone plate
  for (let i = 0; i < 90; i++) { x.fillStyle = i % 2 ? '#fff' : '#000'; x.fillRect(1230 + i * 2, 790, 2, 140); }
  for (let i = 0; i < 70; i++) { x.fillStyle = i % 2 ? '#e8e8e8' : '#202020'; x.fillRect(1230 + i * 3, 950, 3, 150); }
  const zp = x.createImageData(260, 310);
  for (let yy = 0; yy < 310; yy++) for (let xx = 0; xx < 260; xx++) {
    const r2 = (xx - 130) ** 2 + (yy - 155) ** 2, v = 127.5 + 127.5 * Math.cos(r2 * 0.012), o = (yy * 260 + xx) * 4;
    zp.data[o] = zp.data[o + 1] = zp.data[o + 2] = v; zp.data[o + 3] = 255;
  }
  x.putImageData(zp, 1480, 790);
  // street lights near the corners (coma, smear, halation)
  [[60, 60], [W - 60, 70], [80, H - 70], [W - 90, H - 60], [700, 640], [1100, 660]].forEach(([lx, ly]) => {
    const rg = x.createRadialGradient(lx, ly, 0, lx, ly, 22); rg.addColorStop(0, '#fff'); rg.addColorStop(0.35, '#fff6dc'); rg.addColorStop(1, 'rgba(255,220,150,0)');
    x.fillStyle = rg; x.beginPath(); x.arc(lx, ly, 22, 0, Math.PI * 2); x.fill();
  });
  return c;
}

/* ---------------- export ---------------- */
/* export settings: what the file will be, and (optionally) which app to check it against */
const XKEY = 'ie2.v5.export';
const xs = (() => {
  const d = { format: 'jpeg', q: 92, sub: '444', long: '0', check: 'none', asSaved: true };
  try { const v = JSON.parse(localStorage.getItem(XKEY) || 'null'); if (v) for (const k in d) if (typeof v[k] === typeof d[k]) d[k] = v[k]; } catch (e) { /* ignore */ }
  return d;
})();
const saveX = () => { try { localStorage.setItem(XKEY, JSON.stringify(xs)); } catch (e) { /* ignore */ } };
function exportS() {
  const P = xs.check !== 'none' && PLATFORMS[xs.check];
  return { format: xs.format, q: +xs.q, sub: xs.sub, long: +xs.long || 0, check: P ? { long: P.long, q: P.q, sub: P.sub, sharpen: P.psharp } : null };
}
const CHECK_NAMES = { instagram: 'Instagram', whatsapp: 'WhatsApp', facebook: 'Facebook', x: 'X', messages: 'Messages' };
function viewNote() {
  const f = xs.format === 'jpeg' ? `JPEG ${xs.q} ${xs.sub.split('').join(':')}` : xs.format === 'png' ? 'PNG' : 'PNG 16-bit';
  return `as saved: ${f}` + (+xs.long ? ` · ${xs.long} px` : '') + (xs.check !== 'none' ? ` · then ${CHECK_NAMES[xs.check]} ≈` : '');
}
function syncExportUI() {
  $('#xfmt').value = xs.format; $('#xq').value = xs.q; $('#xqv').textContent = xs.q; $('#xsub').value = xs.sub; $('#xlong').value = xs.long; $('#xcheck').value = xs.check;
  document.querySelectorAll('.xjpeg').forEach(el => { el.hidden = xs.format !== 'jpeg'; });
  $('#assaved').classList.toggle('on', xs.asSaved);
  $('#assaved').setAttribute('aria-pressed', xs.asSaved);
}
function exportChanged() { saveX(); syncExportUI(); request(false); scheduleMeter(); scheduleSize(); }
$('#xfmt').addEventListener('change', (e) => { xs.format = e.target.value; exportChanged(); });
$('#xq').addEventListener('input', (e) => { xs.q = +e.target.value; exportChanged(); });
$('#xsub').addEventListener('change', (e) => { xs.sub = e.target.value; exportChanged(); });
$('#xlong').addEventListener('change', (e) => { xs.long = e.target.value; exportChanged(); });
$('#xcheck').addEventListener('change', (e) => { xs.check = e.target.value; exportChanged(); });
$('#assaved').addEventListener('click', () => { xs.asSaved = !xs.asSaved; exportChanged(); });
$('#save').addEventListener('click', () => { const p = $('#xpop'); p.hidden = !p.hidden; if (!p.hidden) scheduleSize(); });
document.addEventListener('pointerdown', (e) => { if (!$('#xpop').hidden && !e.target.closest('#xpop, #save')) $('#xpop').hidden = true; });

// estimated JPEG file size (real encode), only while the panel is open
let sizeTimer = 0;
function scheduleSize() {
  clearTimeout(sizeTimer);
  if ($('#xpop').hidden || !loaded) return;
  if (xs.format !== 'jpeg') { $('#xsize').textContent = 'Lossless: nothing is lost in the file.'; return; }
  $('#xsize').textContent = 'estimating size…';
  sizeTimer = setTimeout(() => {
    if ($('#xpop').hidden || cropping) return;
    try { frame(); const src = gpu.prepareJpeg(exportS()); try { const b = ENC.jpeg(src); $('#xsize').textContent = `≈ ${fmtBytes(b.length)} · ${src.info.W}×${src.info.H}`; } finally { src.done(); } }
    catch (e) { $('#xsize').textContent = ''; console.error(e); }
  }, 500);
}
const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB';

async function saveFile() {
  if (!loaded) return;
  if (cropping) endCrop(true);
  frame();
  const S = exportS();
  say('encoding…');
  await new Promise(r => setTimeout(r, 20));
  let bytes, ext, w, h;
  try {
    if (S.format === 'jpeg') {
      const src = gpu.prepareJpeg(S); w = src.info.W; h = src.info.H;
      try { bytes = ENC.jpeg(src); } finally { src.done(); }
      ext = 'jpg';
    } else {
      const src = gpu.preparePng(S); w = src.w; h = src.h;
      try { bytes = await ENC.png(src); } finally { src.done(); }
      ext = 'png';
    }
  } catch (e) { say('export failed: ' + e.message, true); console.error(e); return; }
  request(false);
  const blob = new Blob([bytes], { type: ext === 'jpg' ? 'image/jpeg' : 'image/png' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${baseName}_v5.${ext}`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  say(`saved ${a.download} · ${w}×${h} · ${fmtBytes(blob.size)}`);
  $('#xpop').hidden = true;
}
$('#xsave').addEventListener('click', saveFile);

/* ---------------- survival meter ---------------- */
// After edits settle, every effect's change is measured before and after the export (and the chosen
// app check): Lost = it won't show in the file, Natural = survives within real-camera range,
// Too strong = a setting is beyond what real cameras / devices produce.
let meterTimer = 0;
function scheduleMeter() {
  clearTimeout(meterTimer);
  for (const id in views) if (views[id].badge) views[id].badge.classList.add('stale');
  if (!loaded || cropping) return;
  meterTimer = setTimeout(runMeter, 900);
}
function rate(e, p, m) {
  const beyond = e.params.some(q => q.real && !q.o && !q.b && (p[q.k] < q.real[0] - 1e-9 || p[q.k] > q.real[1] + 1e-9));
  const { pre, post } = m, keep = pre.mean > 1e-4 ? post.mean / pre.mean : 0;
  const info = `Keeps ${Math.round(Math.min(1, keep) * 100)}% of its change after export · visibly changes ${(post.vis * 100).toFixed(1)}% of the image`;
  if (pre.mean < 0.05 && pre.vis < 0.001) return ['lost', 'No change', 'This photo has nothing for it to act on (or it is set to zero).'];
  if (post.mean < 0.06 || (keep < 0.3 && post.vis < 0.005)) return ['lost', 'Lost', info + '. It will not really show in the saved file.'];
  if (beyond) return ['strong', 'Too strong', info + '. A setting is beyond what real cameras / devices produce.'];
  return ['ok', 'Natural', info + '.'];
}
function runMeter() {
  if (!loaded || cropping || !gpu) return;
  const chain = buildChain();
  for (const id in views) { const b = views[id].badge; if (b) { b.hidden = true; b.classList.remove('stale'); } }
  if (!chain.length) { $('#msum').textContent = ''; return; }
  let res;
  try { res = gpu.measure(chain, state.seed, chainOpts(), exportS()); } catch (e) { console.error(e); return; }
  const count = { ok: 0, lost: 0, strong: 0 };
  chain.forEach(({ fx, p }, i) => {
    if (fx.meter === false || !res[i]) return;
    const [cls, label, tip] = rate(fx, p, res[i]), b = views[fx.id].badge;
    b.hidden = false; b.className = 'badge ' + cls; b.textContent = label; b.title = tip;
    count[cls]++;
  });
  $('#msum').textContent = [count.ok && `${count.ok} natural`, count.lost && `${count.lost} lost`, count.strong && `${count.strong} too strong`].filter(Boolean).join(' · ');
  request(false);
}

/* ---------------- crop & rotate ---------------- */
/* geo = what is applied; edit = the working copy while the crop bar is open. The crop rectangle is
   kept normalised to the "frame": the largest rectangle (same aspect as the image) that fits inside
   the rotated picture, so straightening never shows empty corners. */
const freshGeo = () => ({ turns: 0, angle: 0, flipH: false, flipV: false, crop: [0, 0, 1, 1], aspect: 'free' });
let geo = freshGeo(), edit = null, cropping = false, sourceNote = '';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function updateMeta() {
  if (!loaded) return;
  const [w, h] = gpu.size, [sw, sh] = gpu.source;
  $('#meta').textContent = sourceNote + (w !== sw || h !== sh || geo.angle || geo.turns || geo.flipH || geo.flipV ? ` → ${w}×${h}` : '');
}
function startCrop() {
  if (!loaded || cropping) return;
  cropping = true; edit = JSON.parse(JSON.stringify(geo));
  holdOrig = false;
  document.body.classList.add('cropping');
  $('#aspect').value = edit.aspect;
  syncAngle();
  preview(); fit();
}
function endCrop(apply) {
  if (!cropping) return;
  cropping = false;
  if (apply) geo = edit;
  edit = null; drag = null;
  document.body.classList.remove('cropping');
  gpu.setGeometry(geo);
  updateMeta(); request(true); scheduleMeter();
  if (apply) say(`cropped to ${gpu.size[0]}×${gpu.size[1]}`);
}
// While editing, show the whole frame (no crop) so the crop box can be moved anywhere in it.
function preview() { gpu.setGeometry(edit, [0, 0, 1, 1]); const [w, h] = gpu.size; if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } placeCrop(); request(false); }
function ratio() {
  if (edit.aspect === 'free') return 0;
  return edit.aspect === 'orig' ? cv.width / cv.height : +edit.aspect;
}
function applyAspect() {
  const R = ratio(), fw = cv.width, fh = cv.height;
  $('#cbox').classList.toggle('lock', !!R);
  if (!R) return;
  const c = edit.crop, cx = (c[0] + c[2] / 2) * fw, cy = (c[1] + c[3] / 2) * fh;
  let w = Math.min(fw, fh * R), h = w / R;
  const x = clamp(cx - w / 2, 0, fw - w), y = clamp(cy - h / 2, 0, fh - h);
  edit.crop = [x / fw, y / fh, w / fw, h / fh];
}
function placeCrop() {
  if (!edit) return;
  const c = edit.crop, b = $('#cbox'), fw = cv.width, fh = cv.height;
  b.style.left = (tx + c[0] * fw * z) + 'px'; b.style.top = (ty + c[1] * fh * z) + 'px';
  b.style.width = (c[2] * fw * z) + 'px'; b.style.height = (c[3] * fh * z) + 'px';
  $('#cdim').textContent = `${Math.round(c[2] * fw)} × ${Math.round(c[3] * fh)}`;
  b.classList.toggle('lock', !!ratio());
}
function dragCrop(e) {
  const fw = cv.width, fh = cv.height, dx = (e.clientX - drag.x) / z / fw, dy = (e.clientY - drag.y) / z / fh;
  const [x0, y0, w0, h0] = drag.c0, k = drag.crop, R = ratio();
  if (k === 'move') { edit.crop = [clamp(x0 + dx, 0, 1 - w0), clamp(y0 + dy, 0, 1 - h0), w0, h0]; placeCrop(); return; }
  const mw = Math.min(1, 24 / fw), mh = Math.min(1, 24 / fh);
  let l = x0, t = y0, r = x0 + w0, b = y0 + h0;
  if (R && k.length === 2) {
    // aspect locked: the opposite corner stays put; size follows the pointer, held to the ratio
    const ax = k.includes('w') ? r : l, ay = k.includes('n') ? b : t;
    const px = (k.includes('w') ? l + dx : r + dx), py = (k.includes('n') ? t + dy : b + dy);
    let W = Math.abs(px - ax) * fw, H = Math.abs(py - ay) * fh;
    W = Math.max(24, (W + H * R) / 2); H = W / R;
    const maxW = (k.includes('w') ? ax : 1 - ax) * fw, maxH = (k.includes('n') ? ay : 1 - ay) * fh;
    if (W > maxW) { W = maxW; H = W / R; }
    if (H > maxH) { H = maxH; W = H * R; }
    const wn = W / fw, hn = H / fh;
    l = k.includes('w') ? ax - wn : ax; t = k.includes('n') ? ay - hn : ay;
    edit.crop = [l, t, wn, hn];
  } else {
    if (k.includes('w')) l = clamp(x0 + dx, 0, r - mw);
    if (k.includes('e')) r = clamp(x0 + w0 + dx, l + mw, 1);
    if (k.includes('n')) t = clamp(y0 + dy, 0, b - mh);
    if (k.includes('s')) b = clamp(y0 + h0 + dy, t + mh, 1);
    edit.crop = [l, t, r - l, b - t];
  }
  placeCrop();
}
function turn(cw) {
  const [x, y, w, h] = edit.crop;
  edit.turns = (edit.turns + (cw ? 1 : 3)) & 3;
  edit.crop = cw ? [1 - y - h, x, h, w] : [y, 1 - x - w, h, w];
  preview(); applyAspect(); fit();
}
function syncAngle() { $('#angle').value = edit.angle; $('#anglev').value = (+edit.angle).toFixed(1); }
function setAngle(v) { edit.angle = clamp(Math.round(v * 10) / 10, -45, 45); syncAngle(); preview(); applyAspect(); placeCrop(); }

$('#cropbtn').addEventListener('click', startCrop);
$('#cdone').addEventListener('click', () => endCrop(true));
$('#ccancel').addEventListener('click', () => endCrop(false));
$('#creset').addEventListener('click', () => { edit = freshGeo(); $('#aspect').value = 'free'; syncAngle(); preview(); fit(); });
$('#tcw').addEventListener('click', () => turn(true));
$('#tccw').addEventListener('click', () => turn(false));
$('#fliph').addEventListener('click', () => { const c = edit.crop; edit.flipH = !edit.flipH; edit.crop = [1 - c[0] - c[2], c[1], c[2], c[3]]; preview(); });
$('#flipv').addEventListener('click', () => { const c = edit.crop; edit.flipV = !edit.flipV; edit.crop = [c[0], 1 - c[1] - c[3], c[2], c[3]]; preview(); });
$('#aspect').addEventListener('change', (e) => { edit.aspect = e.target.value; applyAspect(); placeCrop(); });
$('#angle').addEventListener('input', (e) => setAngle(+e.target.value));
$('#angle').addEventListener('dblclick', () => setAngle(0));
$('#anglev').addEventListener('change', (e) => { const v = parseFloat(e.target.value); setAngle(Number.isFinite(v) ? v : 0); });

/* ---------------- go ---------------- */
buildRack();
refreshSummary();
syncIntensity();
syncExportUI();
