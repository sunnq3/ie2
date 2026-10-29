'use strict';
/* ie2 v5 — interface: rack, viewer, presets, export. */

const $ = (s, r = document) => r.querySelector(s);
const KEY = 'ie2.v5.state';

/* ---------------- state ---------------- */
function freshState() {
  const st = { seed: 1, fx: {} };
  for (const e of EFFECTS) { const p = { on: false }; for (const q of e.params) p[q.k] = q.d; st.fx[e.id] = p; }
  return st;
}
function restore() {
  const st = freshState();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && s.fx) {
      st.seed = Number.isFinite(+s.seed) ? +s.seed : 1;
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
  el.innerHTML = '<header class="fx-h"><label class="sw"><input type="checkbox"><i></i></label><button type="button" class="fx-n"></button><button type="button" class="fx-r" title="Back to this effect’s defaults">↺</button></header><p class="fx-i"></p><div class="fx-p"></div>';
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
  const rows = e.params.map(q => buildParam(e, q, $('.fx-p', el)));
  function sync() { cb.checked = st().on; el.classList.toggle('on', st().on); rows.forEach(r => r()); }
  views[e.id] = { el, sync };
  sync();
  return el;
}

function buildParam(e, q, host) {
  const row = document.createElement('div'); row.className = 'pr';
  const st = () => state.fx[e.id];
  const mark = () => row.classList.toggle('mod', st()[q.k] !== q.d);
  let sync;
  if (q.o) {
    row.classList.add('sel');
    const lab = document.createElement('span'); lab.className = 'pr-l'; lab.textContent = q.l;
    const s = document.createElement('select');
    for (const [v, t] of q.o) s.add(new Option(t, v));
    s.addEventListener('change', () => { st()[q.k] = s.value; mark(); changed(); });
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
    const n = document.createElement('input'); n.type = 'text'; n.className = 'pr-v'; n.inputMode = 'decimal'; n.spellcheck = false;
    const u = document.createElement('span'); u.className = 'pr-u'; u.textContent = q.u || '';
    r.addEventListener('input', () => { st()[q.k] = +r.value; n.value = show(r.value, q.step); mark(); changed(); });
    n.addEventListener('change', () => {
      let v = parseFloat(n.value); if (!Number.isFinite(v)) v = q.d;
      st()[q.k] = Math.min(q.max, Math.max(q.min, v)); sync(); changed();
    });
    lab.addEventListener('dblclick', () => { st()[q.k] = q.d; sync(); changed(); });
    row.append(lab, r, n, u);
    sync = () => { r.value = st()[q.k]; n.value = show(st()[q.k], q.step); mark(); };
  }
  host.append(row);
  return sync;
}

function syncAll() { for (const id in views) views[id].sync(); }

function refreshSummary() {
  for (const [gid] of GROUPS) {
    const n = EFFECTS.filter(e => e.group === gid && state.fx[e.id].on).length;
    $(`.grp[data-g="${gid}"] .grp-c`).textContent = n ? n + ' on' : '';
  }
  const on = EFFECTS.filter(e => state.fx[e.id].on);
  const chain = $('#chain');
  chain.textContent = 'chain: ';
  if (!on.length) { const b = document.createElement('b'); b.textContent = 'empty — switch an effect on'; chain.append(b); }
  on.forEach((e, i) => {
    if (i) { const a = document.createElement('i'); a.textContent = '→'; chain.append(a); }
    const b = document.createElement('b'); b.textContent = e.name; chain.append(b);
  });
}

function changed() { persist(); refreshSummary(); request(true); }

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
  for (const id in pr[1]) { Object.assign(state.fx[id], pr[1][id]); state.fx[id].on = true; }
  syncAll(); changed(); say('preset: ' + pr[0]);
});
$('#reseed').addEventListener('click', () => { state.seed = 1 + Math.floor(Math.random() * 9999); changed(); say('seed ' + state.seed); });
$('#alloff').addEventListener('click', () => { for (const id in state.fx) state.fx[id].on = false; syncAll(); changed(); });
$('#resetall').addEventListener('click', () => { const seed = state.seed; state = freshState(); state.seed = seed; syncAll(); changed(); });

/* ---------------- rendering ---------------- */
let loaded = false, needProcess = false, frameReq = 0, mode = 0, holdOrig = false, split = 0.5;
function request(processToo) { if (processToo) needProcess = true; if (!frameReq) frameReq = requestAnimationFrame(frame); }
function frame() {
  frameReq = 0;
  if (!loaded || !gpu) return;
  if (needProcess && !cropping) {
    needProcess = false;
    const chain = EFFECTS.filter(e => state.fx[e.id].on).map(e => ({ fx: e, p: state.fx[e.id] }));
    try { gpu.process(chain, state.seed); say(chain.length ? `${chain.length} effect${chain.length > 1 ? 's' : ''}` : 'original'); }
    catch (e) { say(e.message, true); console.error(e); }
  }
  gpu.show(holdOrig ? 1 : mode, split);
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
  geo = freshGeo();
  loaded = true; baseName = name; sourceNote = `${name} · ${w}×${h}` + (k < 1 ? ` (working copy of ${w0}×${h0})` : '');
  updateMeta();
  $('#drop').classList.add('gone');
  $('#save').disabled = false; $('#cropbtn').disabled = false;
  fit(); request(true);
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
$('#file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
$('#chart').addEventListener('click', () => { const c = testScene(); useSource(c, c.width, c.height, 'test-scene'); });
['dragenter', 'dragover'].forEach(t => window.addEventListener(t, (e) => { e.preventDefault(); document.body.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(t => window.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) document.body.classList.remove('dragging'); }));
window.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) openFile(f); });
window.addEventListener('paste', (e) => {
  const it = e.clipboardData && [...e.clipboardData.items].find(i => i.kind === 'file' && i.type.startsWith('image/'));
  if (it) { e.preventDefault(); openFile(it.getAsFile()); }
});

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
$('#fmt').addEventListener('change', () => { $('#qwrap').hidden = $('#fmt').value === 'png'; });
$('#q').addEventListener('input', () => { $('#qv').textContent = $('#q').value; });
$('#save').addEventListener('click', () => {
  if (!loaded) return;
  if (cropping) endCrop(true);
  request(true); frame();
  // Save the on-screen canvas itself, drawn at full resolution in Result view: the file is exactly the
  // picture you are looking at, so it can never come out turned or flipped relative to the screen.
  gpu.show(0, split, !state.fx.posterize.on);
  const fmt = $('#fmt').value, mime = 'image/' + fmt, ext = fmt === 'jpeg' ? 'jpg' : fmt;
  say('encoding ' + ext + '…');
  cv.toBlob((blob) => {
    request(false);
    if (!blob) { say('export failed', true); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${baseName}_v5.${ext}`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    say(`saved ${a.download} · ${(blob.size / 1024).toFixed(0)} KB`);
  }, mime, +$('#q').value / 100);
});

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
  updateMeta(); fit(); request(true);
  if (apply) say(`cropped to ${gpu.size[0]}×${gpu.size[1]}`);
}
// While editing, show the whole frame (no crop) so the crop box can be moved anywhere in it.
function preview() { gpu.setGeometry(edit, [0, 0, 1, 1]); placeCrop(); request(false); }
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
