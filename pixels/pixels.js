'use strict';
/*
 * ie2 pixels — select, drag and delete individual pixels without falling over on big images.
 *
 * How it stays fast:
 *  - the image is one flat RGBA array (plus one canvas mirror for drawing), never an object per pixel;
 *  - the selection is a byte mask, so selecting millions of pixels is just writing bytes;
 *  - dragging moves a single "floating" picture of the selection; pixels are written once, on drop;
 *  - every edit touches only its bounding rectangle, and undo stores only those rectangles,
 *    within a fixed memory budget;
 *  - the view draws only what is on screen; the pixel grid appears only when pixels are big enough.
 */
const $ = (s) => document.querySelector(s);
const MAX_PX = 24e6, HIST_BYTES = 320 * 1048576, HIST_MAX = 300;
const ACC = [228, 71, 27];

/* ---------------- image state ---------------- */
let W = 0, H = 0, data = null, px32 = null, mask = null, imgData = null, name = 'image', loaded = false;   // px32: one 32-bit word per pixel
const sel = { n: 0, x0: 0, y0: 0, x1: -1, y1: -1 };     // count and bounding box (inclusive)
const img = document.createElement('canvas'), ictx = img.getContext('2d');
let tint = null;                                          // selection overlay, bounding-box sized
let float = null;                                         // lifted selection while dragging
const hist = [], future = []; let histBytes = 0;

/* ---------------- view state ---------------- */
const stage = $('#stage'), view = $('#view'), vctx = view.getContext('2d');
let z = 1, tx = 0, ty = 0, dpr = 1, tool = 'select', spaceDown = false, drag = null, hover = null, frameReq = 0;
let mods = { shift: false, alt: false, ctrl: false };       // held modifier keys, shown on screen
let selList = null;                                         // coordinates of small selections, drawn as markers
const selMode = (e) => e.shiftKey ? 'add' : e.altKey ? 'sub' : (e.ctrlKey || e.metaKey) ? 'toggle' : 'replace';
const MODE_LABEL = { add: '+ add', sub: '− remove', toggle: '± toggle' };

const say = (t, err) => { const s = $('#status'); s.textContent = t; s.classList.toggle('err', !!err); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------------- loading ---------------- */
async function decode(file) {
  const url = URL.createObjectURL(file);
  try { const im = new Image(); im.src = url; await im.decode(); return im; }
  catch (e) { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
async function openFile(file) {
  if (!file) return;
  say('opening…');
  try { const im = await decode(file); setImage(im, im.naturalWidth || im.width, im.naturalHeight || im.height, (file.name || 'image').replace(/\.[^.]+$/, '')); }
  catch (e) { say('this browser can’t decode that file', true); }
}
function setImage(src, w0, h0, nm) {
  const k = Math.min(1, Math.sqrt(MAX_PX / (w0 * h0)));
  W = Math.max(1, Math.round(w0 * k)); H = Math.max(1, Math.round(h0 * k));
  img.width = W; img.height = H;
  ictx.clearRect(0, 0, W, H); ictx.imageSmoothingQuality = 'high'; ictx.drawImage(src, 0, 0, W, H);
  imgData = ictx.getImageData(0, 0, W, H); data = imgData.data; px32 = new Uint32Array(data.buffer, data.byteOffset, W * H);
  mask = new Uint8Array(W * H);
  sel.n = 0; sel.x1 = sel.y1 = -1; tint = null; float = null;
  hist.length = 0; future.length = 0; histBytes = 0;
  name = nm; loaded = true;
  $('#meta').textContent = `${nm} · ${W}×${H}` + (k < 1 ? ` (working copy of ${w0}×${h0})` : '');
  $('#drop').classList.add('gone');
  ['#save', '#all'].forEach(s => { $(s).disabled = false; });
  sync(); fit(); say('ready');
}
function sample() {
  // a small scene that's fun to take apart at high zoom
  const c = document.createElement('canvas'); c.width = 192; c.height = 128; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 90); g.addColorStop(0, '#1d3f8c'); g.addColorStop(0.6, '#e98a5a'); g.addColorStop(1, '#f6d58e');
  x.fillStyle = g; x.fillRect(0, 0, 192, 90);
  x.fillStyle = '#fff3c4'; x.beginPath(); x.arc(140, 58, 14, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#3b2a4d'; x.beginPath(); x.moveTo(0, 92); x.lineTo(40, 64); x.lineTo(78, 90); x.lineTo(120, 70); x.lineTo(192, 96); x.lineTo(192, 128); x.lineTo(0, 128); x.fill();
  x.fillStyle = '#25331f'; x.fillRect(0, 100, 192, 28);
  x.fillStyle = '#c84c32'; x.fillRect(30, 84, 30, 20); x.fillStyle = '#5a2418'; x.beginPath(); x.moveTo(26, 85); x.lineTo(45, 72); x.lineTo(64, 85); x.fill();
  x.fillStyle = '#ffd36b'; x.fillRect(36, 89, 6, 6); x.fillRect(48, 89, 6, 6);
  x.fillStyle = '#1a1414'; x.fillRect(42, 96, 6, 8);
  for (let i = 0; i < 40; i++) { x.fillStyle = `rgba(255,255,255,${0.4 + 0.6 * ((i * 37) % 10) / 10})`; x.fillRect((i * 53) % 192, (i * 29) % 40, 1, 1); }
  setImage(c, 192, 128, 'sample');
}

/* ---------------- selection ---------------- */
function rescan(x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1, full = true) {
  // recount the selection; with full = false only the given rectangle may contain selected pixels
  if (full) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }
  let n = 0, bx0 = W, by0 = H, bx1 = -1, by1 = -1;
  for (let y = y0; y <= y1; y++) {
    const row = y * W; let any = false;
    for (let x = x0; x <= x1; x++) if (mask[row + x]) { n++; any = true; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; }
    if (any) { if (y < by0) by0 = y; by1 = y; }
  }
  sel.n = n; sel.x0 = bx0; sel.y0 = by0; sel.x1 = bx1; sel.y1 = by1;
  buildTint(); sync();
}
function buildTint() {
  selList = null;
  if (!sel.n) { tint = null; return; }
  if (sel.n <= 4000) selList = [];
  const w = sel.x1 - sel.x0 + 1, h = sel.y1 - sel.y0 + 1;
  const c = tint && tint.width === w && tint.height === h ? tint : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const t = c.getContext('2d'), id = t.createImageData(w, h), d = id.data;
  for (let y = 0; y < h; y++) {
    const row = (sel.y0 + y) * W + sel.x0;
    for (let x = 0; x < w; x++) if (mask[row + x]) { const i = (y * w + x) * 4; d[i] = ACC[0]; d[i + 1] = ACC[1]; d[i + 2] = ACC[2]; d[i + 3] = 255; if (selList) selList.push(sel.x0 + x, sel.y0 + y); }
  }
  t.putImageData(id, 0, 0); tint = c;
}
function setRect(x0, y0, x1, y1, mode) {
  // mode: 'replace' | 'add' | 'sub'
  x0 = clamp(x0, 0, W - 1); y0 = clamp(y0, 0, H - 1); x1 = clamp(x1, 0, W - 1); y1 = clamp(y1, 0, H - 1);
  if (mode === 'toggle') { for (let y = y0; y <= y1; y++) for (let i = y * W + x0; i <= y * W + x1; i++) mask[i] ^= 1; rescan(); return; }
  if (mode === 'replace') clearSel(false);
  const v = mode === 'sub' ? 0 : 1;
  for (let y = y0; y <= y1; y++) mask.fill(v, y * W + x0, y * W + x1 + 1);
  if (mode === 'sub') rescan();
  else {   // grow the bounding box without a full scan
    const had = sel.n > 0;
    rescan(had ? Math.min(sel.x0, x0) : x0, had ? Math.min(sel.y0, y0) : y0, had ? Math.max(sel.x1, x1) : x1, had ? Math.max(sel.y1, y1) : y1, false);
  }
}
function clearSel(update = true) {
  if (sel.n) for (let y = sel.y0; y <= sel.y1; y++) mask.fill(0, y * W + sel.x0, y * W + sel.x1 + 1);
  sel.n = 0; sel.x1 = sel.y1 = -1; tint = null; selList = null;
  if (update) { sync(); need(); }
}
function selectAll() { if (!loaded) return; mask.fill(1); sel.n = W * H; sel.x0 = 0; sel.y0 = 0; sel.x1 = W - 1; sel.y1 = H - 1; buildTint(); sync(); need(); }

/* ---------------- edits & undo ---------------- */
function snap(r) {
  const pix = new Uint8ClampedArray(r.w * r.h * 4), m = new Uint8Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) {
    const s = (r.y + y) * W + r.x;
    pix.set(data.subarray(s * 4, (s + r.w) * 4), y * r.w * 4);
    m.set(mask.subarray(s, s + r.w), y * r.w);
  }
  return { pix, m };
}
function unsnap(r, sn) {
  for (let y = 0; y < r.h; y++) {
    const s = (r.y + y) * W + r.x;
    data.set(sn.pix.subarray(y * r.w * 4, (y + 1) * r.w * 4), s * 4);
    mask.set(sn.m.subarray(y * r.w, (y + 1) * r.w), s);
  }
}
const redraw = (r) => { if (r.w > 0 && r.h > 0) ictx.putImageData(imgData, 0, 0, r.x, r.y, r.w, r.h); };
function record(r, before, after, label) {
  hist.push({ r, before, after, label });
  histBytes += 2 * (before.pix.length + before.m.length);
  for (const f of future) histBytes -= 2 * (f.before.pix.length + f.before.m.length);
  future.length = 0;
  while (hist.length > 1 && (histBytes > HIST_BYTES || hist.length > HIST_MAX)) { const o = hist.shift(); histBytes -= 2 * (o.before.pix.length + o.before.m.length); }
  sync();
}
function undo() {
  if (float || !hist.length) return;
  const e = hist.pop(); future.push(e);
  unsnap(e.r, e.before); redraw(e.r); rescan(); need(); say('undid ' + e.label);
}
function redo() {
  if (float || !future.length) return;
  const e = future.pop(); hist.push(e);
  unsnap(e.r, e.after); redraw(e.r); rescan(); need(); say('redid ' + e.label);
}
function bbox() { return { x: sel.x0, y: sel.y0, w: sel.x1 - sel.x0 + 1, h: sel.y1 - sel.y0 + 1 }; }
function del() {
  if (!sel.n || float) return;
  const r = bbox(), before = snap(r);
  for (let y = r.y; y < r.y + r.h; y++) for (let i = y * W + r.x, e = i + r.w; i < e; i++) if (mask[i]) px32[i] = 0;
  record(r, before, snap(r), 'delete'); redraw(r); need();
  say(`deleted ${sel.n.toLocaleString()} pixel${sel.n > 1 ? 's' : ''}`);
}
// lift the selection off the image into a floating layer
function lift() {
  const r = bbox(), before = snap(r), pix = new Uint8ClampedArray(r.w * r.h * 4), m = new Uint8Array(r.w * r.h), p32 = new Uint32Array(pix.buffer);
  for (let y = 0; y < r.h; y++) {
    let i = (r.y + y) * W + r.x, j = y * r.w;
    for (let x = 0; x < r.w; x++, i++, j++) if (mask[i]) { m[j] = 1; p32[j] = px32[i]; px32[i] = 0; }
  }
  redraw(r);
  const c = Object.assign(document.createElement('canvas'), { width: r.w, height: r.h });
  c.getContext('2d').putImageData(new ImageData(pix, r.w, r.h), 0, 0);
  float = { r, before, pix, m, canvas: c, dx: 0, dy: 0 };
}
function drop(dx, dy) {
  const f = float; float = null;
  if (!f) return;
  const r = f.r;
  if (!dx && !dy) { unsnap(r, f.before); redraw(r); need(); return; }        // nothing moved: put it back
  const d = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
  const cx0 = clamp(d.x, 0, W), cy0 = clamp(d.y, 0, H), cx1 = clamp(d.x + d.w, 0, W), cy1 = clamp(d.y + d.h, 0, H);
  const ux0 = Math.min(r.x, cx0), uy0 = Math.min(r.y, cy0), ux1 = Math.max(r.x + r.w, cx1), uy1 = Math.max(r.y + r.h, cy1);
  const U = { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };
  // "before" = the union area as it was before the lift
  const before = snap(U);
  for (let y = 0; y < r.h; y++) {
    const o = ((r.y - U.y + y) * U.w + (r.x - U.x)) ;
    before.pix.set(f.before.pix.subarray(y * r.w * 4, (y + 1) * r.w * 4), o * 4);
    before.m.set(f.before.m.subarray(y * r.w, (y + 1) * r.w), o);
  }
  // clear the old selection, then write the moved pixels (and their selection) at the new place
  for (let y = 0; y < r.h; y++) { let i = (r.y + y) * W + r.x, j = y * r.w; for (let x = 0; x < r.w; x++, i++, j++) if (f.m[j]) mask[i] = 0; }
  let lost = 0; const p32 = new Uint32Array(f.pix.buffer);
  for (let y = 0; y < r.h; y++) {
    const Y = d.y + y, rowOk = Y >= 0 && Y < H;
    for (let x = 0, j = y * r.w; x < r.w; x++, j++) {
      if (!f.m[j]) continue;
      const X = d.x + x;
      if (!rowOk || X < 0 || X >= W) { lost++; continue; }
      const i = Y * W + X; px32[i] = p32[j]; mask[i] = 1;
    }
  }
  record(U, before, snap(U), 'move'); redraw(U);
  if (cx1 > cx0 && cy1 > cy0) rescan(cx0, cy0, cx1 - 1, cy1 - 1, false); else rescan();
  need();
  say(`moved ${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy}` + (lost ? ` · ${lost.toLocaleString()} pixel${lost > 1 ? 's' : ''} went off the edge and were removed` : ''));
}
function nudge(dx, dy) { if (!sel.n || float) return; lift(); drop(dx, dy); }

/* ---------------- view ---------------- */
function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = stage.clientWidth, h = stage.clientHeight;
  view.width = Math.max(1, Math.round(w * dpr)); view.height = Math.max(1, Math.round(h * dpr));
  need();
}
function fit() {
  if (!loaded) return;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  z = Math.min((sw - 40) / W, (sh - 40) / H); if (z > 1) z = Math.max(1, Math.floor(z));
  tx = Math.round((sw - W * z) / 2); ty = Math.round((sh - H * z) / 2); sync(); need();
}
function zoomAt(nz, mx, my) {
  nz = clamp(nz, 0.02, 96);
  if (nz > 1) nz = Math.round(nz * 4) / 4;
  tx = mx - (mx - tx) * nz / z; ty = my - (my - ty) * nz / z; z = nz; sync(); need();
}
const toImg = (cx, cy) => [Math.floor((cx - tx) / z), Math.floor((cy - ty) / z)];
const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const checker = (() => {
  const c = Object.assign(document.createElement('canvas'), { width: 16, height: 16 }), x = c.getContext('2d');
  x.fillStyle = '#d9d4ca'; x.fillRect(0, 0, 16, 16); x.fillStyle = '#c3bdb1'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  return vctx.createPattern(c, 'repeat');
})();
function need() { if (!frameReq) frameReq = requestAnimationFrame(draw); }
function draw() {
  frameReq = 0;
  const cw = view.width / dpr, ch = view.height / dpr;
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vctx.clearRect(0, 0, cw, ch);
  if (!loaded) return;
  const iw = W * z, ih = H * z;
  // transparent areas show a checkerboard
  const vx0 = Math.max(0, tx), vy0 = Math.max(0, ty), vx1 = Math.min(cw, tx + iw), vy1 = Math.min(ch, ty + ih);
  if (vx1 > vx0 && vy1 > vy0) { vctx.fillStyle = checker; vctx.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0); }
  vctx.imageSmoothingEnabled = z < 1;
  vctx.drawImage(img, tx, ty, iw, ih);
  const ox = float ? float.dx : 0, oy = float ? float.dy : 0;
  if (float) vctx.drawImage(float.canvas, tx + (float.r.x + ox) * z, ty + (float.r.y + oy) * z, float.r.w * z, float.r.h * z);
  if (tint) {
    vctx.globalAlpha = z >= 6 ? 0.28 : 0.4;
    vctx.drawImage(tint, tx + (sel.x0 + ox) * z, ty + (sel.y0 + oy) * z, tint.width * z, tint.height * z);
    vctx.globalAlpha = 1;
  }
  // pixel grid once pixels are big enough to grab
  if (z >= 8) {
    vctx.strokeStyle = 'rgba(0,0,0,.22)'; vctx.lineWidth = 1; vctx.beginPath();
    const gx0 = Math.max(0, Math.floor(-tx / z)), gx1 = Math.min(W, Math.ceil((cw - tx) / z)), gy0 = Math.max(0, Math.floor(-ty / z)), gy1 = Math.min(H, Math.ceil((ch - ty) / z));
    for (let x = gx0; x <= gx1; x++) { const X = Math.round(tx + x * z) + 0.5; vctx.moveTo(X, Math.max(ty, 0)); vctx.lineTo(X, Math.min(ty + ih, ch)); }
    for (let y = gy0; y <= gy1; y++) { const Y = Math.round(ty + y * z) + 0.5; vctx.moveTo(Math.max(tx, 0), Y); vctx.lineTo(Math.min(tx + iw, cw), Y); }
    vctx.stroke();
  }
  if (selList && z < 6) {   // small selections stay visible when pixels are smaller than a few screen dots
    const s2 = Math.max(z, 6);
    vctx.lineWidth = 1.5;
    for (let k = 0; k < selList.length; k += 2) {
      const X = tx + (selList[k] + ox + 0.5) * z - s2 / 2, Y = ty + (selList[k + 1] + oy + 0.5) * z - s2 / 2;
      vctx.strokeStyle = '#fff'; vctx.strokeRect(X - 1, Y - 1, s2 + 2, s2 + 2);
      vctx.strokeStyle = 'rgb(' + ACC.join(',') + ')'; vctx.strokeRect(X, Y, s2, s2);
    }
  }
  if (sel.n) {   // selection bounds
    vctx.setLineDash([5, 4]); vctx.strokeStyle = 'rgb(' + ACC.join(',') + ')'; vctx.lineWidth = 1.5;
    vctx.strokeRect(tx + (sel.x0 + ox) * z - 1, ty + (sel.y0 + oy) * z - 1, (sel.x1 - sel.x0 + 1) * z + 2, (sel.y1 - sel.y0 + 1) * z + 2);
    vctx.setLineDash([]);
  }
  if (hover && !drag && inside(hover[0], hover[1]) && z >= 4) {   // pixel under the cursor
    vctx.strokeStyle = '#fff'; vctx.lineWidth = 1.5; vctx.strokeRect(tx + hover[0] * z + 0.5, ty + hover[1] * z + 0.5, z - 1, z - 1);
  }
  const ml = MODE_LABEL[mods.shift ? 'add' : mods.alt ? 'sub' : mods.ctrl ? 'toggle' : ''];
  if (ml && hover && tool === 'select' && !spaceDown) {
    const hx = tx + (hover[0] + 1) * z + 10, hy = ty + (hover[1] + 1) * z + 10;
    vctx.font = '600 11px "IBM Plex Mono", monospace'; const tw = vctx.measureText(ml).width;
    vctx.fillStyle = 'rgba(27,26,23,.9)'; vctx.fillRect(hx, hy, tw + 10, 18);
    vctx.fillStyle = '#fff'; vctx.fillText(ml, hx + 5, hy + 13);
  }
  if (drag && drag.mode === 'box') {
    const [a, b] = [drag.a, drag.b];
    const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    vctx.fillStyle = 'rgba(228,71,27,.12)'; vctx.strokeStyle = '#fff'; vctx.lineWidth = 1; vctx.setLineDash([4, 3]);
    const rx = tx + clamp(x0, 0, W - 1) * z, ry = ty + clamp(y0, 0, H - 1) * z, rw = (clamp(x1, 0, W - 1) - clamp(x0, 0, W - 1) + 1) * z, rh = (clamp(y1, 0, H - 1) - clamp(y0, 0, H - 1) + 1) * z;
    vctx.fillRect(rx, ry, rw, rh); vctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1); vctx.setLineDash([]);
  }
}
function sync() {
  $('#zv').textContent = loaded ? (z >= 1 ? Math.round(z * 100) + '%' : (z * 100).toFixed(z < 0.1 ? 1 : 0) + '%') : '–';
  $('#undo').disabled = !hist.length || !!float; $('#redo').disabled = !future.length || !!float;
  $('#del').disabled = !sel.n; $('#none').disabled = !sel.n;
  $('#selinfo').textContent = sel.n ? `${sel.n.toLocaleString()} selected · ${sel.x1 - sel.x0 + 1}×${sel.y1 - sel.y0 + 1}` : '';
}
function showHover() {
  if (!hover || !loaded || !inside(hover[0], hover[1])) { $('#hover').textContent = ''; return; }
  const i = (hover[1] * W + hover[0]) * 4, a = data[i + 3];
  $('#hover').innerHTML = '';
  const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = a ? `rgb(${data[i]},${data[i + 1]},${data[i + 2]})` : 'transparent';
  $('#hover').append(sw, document.createTextNode(`${hover[0]}, ${hover[1]} · ` + (a ? `${data[i]} ${data[i + 1]} ${data[i + 2]}` + (a < 255 ? ` α${a}` : '') : 'empty')));
}

/* ---------------- pointer ---------------- */
const pos = (e) => { const r = view.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
view.addEventListener('pointerdown', (e) => {
  if (!loaded) return;
  const [cx, cy] = pos(e);
  view.setPointerCapture(e.pointerId);
  if (tool === 'hand' || spaceDown || e.button === 1 || e.button === 2) { drag = { mode: 'pan', cx, cy, tx, ty }; stage.classList.add('panning'); return; }
  if (e.button !== 0) return;
  const [x, y] = toImg(cx, cy);
  const mode = selMode(e);
  if (inside(x, y) && mask[y * W + x] && mode === 'replace') { lift(); drag = { mode: 'move', cx, cy }; sync(); need(); return; }
  drag = { mode: 'pick', cx, cy, a: [x, y], b: [x, y], sel: mode };
});
view.addEventListener('pointermove', (e) => {
  const [cx, cy] = pos(e);
  if (!drag) { hover = loaded ? toImg(cx, cy) : null; showHover(); stage.classList.toggle('over-sel', !!(hover && inside(...hover) && mask[hover[1] * W + hover[0]] && tool === 'select' && !spaceDown)); need(); return; }
  if (drag.mode === 'pan') { tx = drag.tx + cx - drag.cx; ty = drag.ty + cy - drag.cy; need(); return; }
  if (drag.mode === 'move') { moveTo(cx, cy, e.shiftKey); $('#status').textContent = `moving ${float.dx}, ${float.dy}` + (e.shiftKey ? ' · straight' : ''); need(); return; }
  if (drag.mode === 'pick' && Math.hypot(cx - drag.cx, cy - drag.cy) > 3) drag.mode = 'box';
  if (drag.mode === 'box') { drag.b = toImg(cx, cy); need(); }
});
// Shift while moving keeps the move straight (horizontal or vertical)
function moveTo(cx, cy, straight) {
  let dx = Math.round((cx - drag.cx) / z), dy = Math.round((cy - drag.cy) / z);
  if (straight) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
  float.dx = dx; float.dy = dy;
}
function endDrag(e) {
  if (!drag) return;
  if (e && e.type === 'pointerup') {   // take the release point and the keys held at release too
    const [cx, cy] = pos(e);
    if (drag.mode === 'move' && float) moveTo(cx, cy, e.shiftKey);
    if (drag.mode === 'box' || (drag.mode === 'pick' && Math.hypot(cx - drag.cx, cy - drag.cy) > 3)) { drag.mode = 'box'; drag.b = toImg(cx, cy); }
    const m = selMode(e); if (m !== 'replace' && drag.sel) drag.sel = m;
  }
  const d = drag; drag = null; stage.classList.remove('panning');
  if (d.mode === 'move') drop(float ? float.dx : 0, float ? float.dy : 0);
  else if (d.mode === 'pick') {
    const [x, y] = d.a;
    if (inside(x, y)) setRect(x, y, x, y, d.sel); else if (d.sel === 'replace') clearSel();
  } else if (d.mode === 'box') {
    const [a, b] = [d.a, d.b];
    const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    if (x1 >= 0 && y1 >= 0 && x0 < W && y0 < H) setRect(x0, y0, x1, y1, d.sel); else if (d.sel === 'replace') clearSel();
  }
  sync(); need();
}
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);
view.addEventListener('pointerleave', () => { if (!drag) { hover = null; showHover(); need(); } });
view.addEventListener('contextmenu', (e) => e.preventDefault());
view.addEventListener('wheel', (e) => {
  if (!loaded) return; e.preventDefault();
  const [cx, cy] = pos(e);
  zoomAt(z * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), cx, cy);
}, { passive: false });

/* ---------------- keyboard ---------------- */
function trackMods(e) {
  const m = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
  if (m.shift !== mods.shift || m.alt !== mods.alt || m.ctrl !== mods.ctrl) {
    mods = m;
    const l = MODE_LABEL[m.shift ? 'add' : m.alt ? 'sub' : m.ctrl ? 'toggle' : ''];
    if (loaded && !drag) say(l ? `${l}: click or drag to ${m.shift ? 'add to' : m.alt ? 'remove from' : 'toggle in'} the selection` + (m.shift ? ' · Shift while dragging a selection moves it straight' : '') : 'ready');
    need();
  }
}
window.addEventListener('keydown', trackMods, true);
window.addEventListener('keyup', trackMods, true);
window.addEventListener('blur', () => { mods = { shift: false, alt: false, ctrl: false }; need(); });
view.addEventListener('pointermove', trackMods);
window.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (e.code === 'Space') { e.preventDefault(); spaceDown = true; stage.classList.add('hand'); return; }
  if (!loaded) return;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'a') { e.preventDefault(); selectAll(); return; }
  if (mod && k === 'd') { e.preventDefault(); clearSel(); return; }
  if (e.key === 'Escape') { clearSel(); $('#xpop').hidden = true; return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); del(); return; }
  const step = e.shiftKey ? 10 : 1;
  const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (arrows[e.key] && sel.n) { e.preventDefault(); nudge(...arrows[e.key]); return; }
  if (k === 'v') setTool('select'); else if (k === 'h') setTool('hand'); else if (k === 'f') fit();
  else if (k === '+' || k === '=') zoomAt(z * 1.5, stage.clientWidth / 2, stage.clientHeight / 2);
  else if (k === '-') zoomAt(z / 1.5, stage.clientWidth / 2, stage.clientHeight / 2);
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; stage.classList.toggle('hand', tool === 'hand'); } });
function setTool(t) { tool = t; document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); stage.classList.toggle('hand', t === 'hand'); }
document.querySelectorAll('#tools button').forEach(b => b.addEventListener('click', () => setTool(b.dataset.t)));

/* ---------------- buttons, files ---------------- */
$('#open').addEventListener('click', () => $('#file').click());
$('#open2').addEventListener('click', () => $('#file').click());
$('#sample').addEventListener('click', sample);
$('#file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
$('#undo').addEventListener('click', undo); $('#redo').addEventListener('click', redo);
$('#del').addEventListener('click', del); $('#all').addEventListener('click', selectAll); $('#none').addEventListener('click', () => clearSel());
$('#zin').addEventListener('click', () => zoomAt(z * 1.5, stage.clientWidth / 2, stage.clientHeight / 2));
$('#zout').addEventListener('click', () => zoomAt(z / 1.5, stage.clientWidth / 2, stage.clientHeight / 2));
$('#zfit').addEventListener('click', fit);
['dragenter', 'dragover'].forEach(t => window.addEventListener(t, (e) => { e.preventDefault(); document.body.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(t => window.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) document.body.classList.remove('dragging'); }));
window.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) openFile(f); });
window.addEventListener('paste', (e) => { const it = e.clipboardData && [...e.clipboardData.items].find(i => i.kind === 'file' && i.type.startsWith('image/')); if (it) { e.preventDefault(); openFile(it.getAsFile()); } });
window.addEventListener('resize', () => { resize(); });

/* ---------------- export ---------------- */
const xs = { fmt: 'png', q: 92, sub: '444', bg: '#ffffff' };
try { Object.assign(xs, JSON.parse(localStorage.getItem('ie2.pixels.export') || '{}')); } catch (e) { /* ignore */ }
function syncX() {
  $('#xfmt').value = xs.fmt; $('#xq').value = xs.q; $('#xqv').textContent = xs.q; $('#xsub').value = xs.sub; $('#xbg').value = xs.bg;
  document.querySelectorAll('.xj').forEach(el => { el.hidden = xs.fmt !== 'jpg'; });
  try { localStorage.setItem('ie2.pixels.export', JSON.stringify(xs)); } catch (e) { /* ignore */ }
}
$('#xfmt').addEventListener('change', (e) => { xs.fmt = e.target.value; syncX(); });
$('#xq').addEventListener('input', (e) => { xs.q = +e.target.value; syncX(); });
$('#xsub').addEventListener('change', (e) => { xs.sub = e.target.value; syncX(); });
$('#xbg').addEventListener('input', (e) => { xs.bg = e.target.value; syncX(); });
$('#save').addEventListener('click', () => { const p = $('#xpop'); p.hidden = !p.hidden; });
document.addEventListener('pointerdown', (e) => { if (!$('#xpop').hidden && !e.target.closest('#xpop, #save')) $('#xpop').hidden = true; });
$('#xsave').addEventListener('click', save);

// JPEG front half on the CPU (colour conversion, chroma subsampling, DCT, quantisation), in the exact
// layout v5's encoder reads; rows are produced band by band, so memory stays small at any image size.
function jpegSource(q, sub, bg) {
  const [hs, vs] = { 444: [1, 1], 422: [2, 1], 420: [2, 2] }[sub], B = GPU.DCTB;
  const qY = GPU.qtable(GPU.QBASE_Y, q), qC = GPU.qtable(GPU.QBASE_C, q);
  const Wp = Math.ceil(W / (8 * hs)) * 8 * hs, Hp = Math.ceil(H / (8 * vs)) * 8 * vs, Wc = Wp / hs;
  const ycc = (y) => {        // one padded full-resolution row: Y-128, Cb, Cr (holes composited over bg)
    const out = new Float32Array(Wp * 3), yy = Math.min(y, H - 1);
    for (let x = 0; x < Wp; x++) {
      const i = (yy * W + Math.min(x, W - 1)) * 4, a = data[i + 3] / 255;
      const r = Math.round(data[i] * a + bg[0] * (1 - a)), g = Math.round(data[i + 1] * a + bg[1] * (1 - a)), b = Math.round(data[i + 2] * a + bg[2] * (1 - a));
      out[x * 3] = Math.floor(0.299 * r + 0.587 * g + 0.114 * b + 0.5) - 128;
      out[x * 3 + 1] = Math.floor(-0.168736 * r - 0.331264 * g + 0.5 * b + 128.5) - 128;
      out[x * 3 + 2] = Math.floor(0.5 * r - 0.418688 * g - 0.081312 * b + 128.5) - 128;
    }
    return out;
  };
  const T = new Float32Array(64);
  // DCT + quantise an 8-row band of `n` planes (plane[c][row * pw + x]); writes RGBA-interleaved output
  function band(planes, pw, qs, out, outRow0, chans) {
    for (let p = 0; p < planes.length; p++) {
      const src = planes[p], qt = qs[p], ch = chans[p];
      for (let bx = 0; bx < pw; bx += 8) {
        for (let j = 0; j < 8; j++) for (let u = 0; u < 8; u++) { let s = 0; for (let i = 0; i < 8; i++) s += B[u * 8 + i] * src[j * pw + bx + i]; T[j * 8 + u] = s; }
        for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
          let s = 0; for (let j = 0; j < 8; j++) s += B[v * 8 + j] * T[j * 8 + u];
          out[((outRow0 + v) * pw + bx + u) * 4 + ch] = Math.max(-1023, Math.min(1023, Math.round(s / qt[v * 8 + u])));
        }
      }
    }
  }
  return {
    info: { W, H, Wp, Hp, hs, vs, qY, qC },
    readY(y0, rows) {
      const out = new Float32Array(Wp * rows * 4);
      for (let b = 0; b < rows; b += 8) {
        const Y = new Float32Array(Wp * 8), Cb = new Float32Array(Wp * 8), Cr = new Float32Array(Wp * 8);
        for (let j = 0; j < 8; j++) { const r = ycc(y0 + b + j); for (let x = 0; x < Wp; x++) { Y[j * Wp + x] = r[x * 3]; Cb[j * Wp + x] = r[x * 3 + 1]; Cr[j * Wp + x] = r[x * 3 + 2]; } }
        if (hs * vs === 1) band([Y, Cb, Cr], Wp, [qY, qC, qC], out, b, [0, 1, 2]); else band([Y], Wp, [qY], out, b, [0]);
      }
      return out;
    },
    readC(y0, rows) {
      const out = new Float32Array(Wc * rows * 4), Cb = new Float32Array(Wc * 8), Cr = new Float32Array(Wc * 8);
      for (let j = 0; j < 8; j++) {
        const src = []; for (let k = 0; k < vs; k++) src.push(ycc((y0 + j) * vs + k));
        for (let x = 0; x < Wc; x++) {
          let sb = 0, sr = 0;
          for (const r of src) for (let k = 0; k < hs; k++) { sb += r[(x * hs + k) * 3 + 1]; sr += r[(x * hs + k) * 3 + 2]; }
          Cb[j * Wc + x] = Math.floor(sb / (hs * vs) + 0.5); Cr[j * Wc + x] = Math.floor(sr / (hs * vs) + 0.5);
        }
      }
      band([Cb, Cr], Wc, [qC, qC], out, 0, [1, 2]);
      return out;
    },
  };
}
async function save() {
  if (!loaded || float) return;
  say('encoding…'); $('#xpop').hidden = true;
  await new Promise(r => setTimeout(r, 20));
  let bytes, ext;
  try {
    if (xs.fmt === 'jpg') {
      const h = xs.bg.replace('#', ''), bg = [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16));
      bytes = ENC.jpeg(jpegSource(xs.q, xs.sub, bg)); ext = 'jpg';
    } else {
      bytes = await ENC.png({ w: W, h: H, alpha: true, read: (y, rows) => data.subarray(y * W * 4, (y + rows) * W * 4) }); ext = 'png';
    }
  } catch (e) { say('export failed: ' + e.message, true); console.error(e); return; }
  const blob = new Blob([bytes], { type: ext === 'jpg' ? 'image/jpeg' : 'image/png' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${name}_pixels.${ext}`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  say(`saved ${a.download} · ${W}×${H} · ${blob.size >= 1048576 ? (blob.size / 1048576).toFixed(2) + ' MB' : Math.round(blob.size / 1024) + ' KB'}`);
}

/* ---------------- go ---------------- */
syncX(); resize(); sync();
