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
let mods = { shift: false, alt: false, ctrl: false, a: false, x: false };   // held keys (A = add, X = remove)
let modeBtn = 'replace';                                    // selection mode chosen with the New / Add / Remove buttons
let fillSrc = 'near', fillCol = '#ffffff', brush = 1;       // fill tool settings
let selList = null;                                         // coordinates of small selections, drawn as markers
const heldMode = (e) => (mods.a || (e && e.shiftKey) || mods.shift) ? 'add' : (mods.x || (e && e.altKey) || mods.alt) ? 'sub' : ((e && (e.ctrlKey || e.metaKey)) || mods.ctrl) ? 'toggle' : '';
const selMode = (e) => heldMode(e) || modeBtn;
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
  ['#save', '#all', '#fillholes', '#swarea', '#rnd', '#fb'].forEach(s => { $(s).disabled = false; });
  sync(); fit(); say('ready');
}
function sample() {
  // a small scene that's fun to take apart at high zoom
  const c = document.createElement('canvas'); c.width = 192; c.height = 128; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 90); g.addColorStop(0, '#1d3f8c'); g.addColorStop(0.6, '#e98a5a'); g.addColorStop(1, '#f6d58e');
  x.fillStyle = g; x.fillRect(0, 0, 192, 110);
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

/* ---------------- filling empty pixels ---------------- */
const isEmpty = (i) => data[i * 4 + 3] === 0;
const hexRgb = (hx) => { const h = hx.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)); };
const rgbHex = (c) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
const pickCol = () => hexRgb(fillCol);
const randSwatch = (rnd = Math.random) => swatches.length ? hexRgb(swatches[Math.floor(rnd() * swatches.length)]) : pickCol();
const pack = (r, g, b) => (255 << 24 | b << 16 | g << 8 | r) >>> 0;      // little-endian RGBA word
// average of the nearest non-empty pixels (growing rings), or null if none within reach
function nearColour(x, y) {
  for (let r = 1; r <= 32; r++) {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let yy = y - r; yy <= y + r; yy++) {
      if (yy < 0 || yy >= H) continue;
      const edge = yy === y - r || yy === y + r;
      for (let xx = x - r; xx <= x + r; xx += edge ? 1 : 2 * r) {
        if (xx < 0 || xx >= W) continue;
        const i = (yy * W + xx) * 4; if (!data[i + 3]) continue;
        sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++;
      }
    }
    if (n) return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
  }
  return null;
}
// fill the empty pixels under the brush; existing pixels are never painted over
function paint(cx, cy, list) {
  const h = (brush - 1) >> 1, col = fillSrc === 'colour' ? pickCol() : null, sw = fillSrc === 'swatches';
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = cy - h; y <= cy + h; y++) for (let x = cx - h; x <= cx + h; x++) {
    if (!inside(x, y)) continue;
    const i = y * W + x; if (!isEmpty(i)) continue;
    const c = col || (sw ? randSwatch() : nearColour(x, y)); if (!c) continue;
    px32[i] = pack(c[0], c[1], c[2]); list.push(i);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 >= 0) redraw({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
}
function line(a, b, list) {   // paint along the drag so fast strokes leave no gaps
  let [x, y] = a; const [x1, y1] = b, dx = Math.abs(x1 - x), dy = -Math.abs(y1 - y), sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1;
  let err = dx + dy;
  for (let k = 0; k < 100000; k++) {
    paint(x, y, list);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err; if (e2 >= dy) { err += dy; x += sx; } if (e2 <= dx) { err += dx; y += sy; }
  }
}
function finishFill(list) {
  if (!list.length) { say(fillSrc === 'colour' ? 'nothing filled: only empty pixels get filled' : 'nothing filled: click on empty (deleted) pixels'); return; }
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (const i of list) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const r = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, after = snap(r), before = snap(r);
  for (const i of list) { const x = i % W - x0, y = ((i / W) | 0) - y0; before.pix.fill(0, (y * r.w + x) * 4, (y * r.w + x) * 4 + 4); }
  record(r, before, after, 'fill');
  say(`filled ${list.length.toLocaleString()} pixel${list.length > 1 ? 's' : ''}`);
}
/* ---------------- swatches & colour picker ---------------- */
let swatches = [];
try { swatches = JSON.parse(localStorage.getItem('ie2.pixels.swatches') || '[]').filter(h => /^#[0-9a-f]{6}$/.test(h)).slice(0, 24); } catch (e) { swatches = []; }
function renderSwatches() {
  const box = $('#sws'); box.textContent = '';
  swatches.forEach((h, k) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'swc' + (h === fillCol ? ' on' : ''); b.style.background = h; b.title = h + ' · click to use, right-click to remove';
    b.addEventListener('click', () => setColour(h));
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); swatches.splice(k, 1); saveSwatches(); });
    box.append(b);
  });
  $('#fcol').value = fillCol;
}
function saveSwatches() { try { localStorage.setItem('ie2.pixels.swatches', JSON.stringify(swatches)); } catch (e) { /* ignore */ } renderSwatches(); }
function setColour(h) { fillCol = h; renderSwatches(); }
function addSwatch(h) { swatches = [h, ...swatches.filter(x => x !== h)].slice(0, 24); fillCol = h; saveSwatches(); }
function pickAt(x, y) {
  if (!inside(x, y)) return;
  const i = (y * W + x) * 4;
  if (!data[i + 3]) { say('that pixel is empty: nothing to pick'); return; }
  const h = rgbHex([data[i], data[i + 1], data[i + 2]]); addSwatch(h); say(`picked ${h} into the swatches`);
}
// the main colours of the selection (or the whole image): a coarse colour histogram, most common distinct bins
function swatchesFromArea() {
  if (!loaded) return;
  const r = sel.n ? bbox() : { x: 0, y: 0, w: W, h: H }, useSel = sel.n > 0;
  const cnt = new Float64Array(4096), sr = new Float64Array(4096), sg = new Float64Array(4096), sb = new Float64Array(4096);
  const step = Math.max(1, Math.floor(Math.sqrt(r.w * r.h / 250000)));
  for (let y = r.y; y < r.y + r.h; y += step) for (let x = r.x; x < r.x + r.w; x += step) {
    const i = y * W + x; if (useSel && !mask[i]) continue;
    const o = i * 4; if (!data[o + 3]) continue;
    const b = (data[o] >> 4) << 8 | (data[o + 1] >> 4) << 4 | (data[o + 2] >> 4);
    cnt[b]++; sr[b] += data[o]; sg[b] += data[o + 1]; sb[b] += data[o + 2];
  }
  const bins = [...cnt.keys()].filter(b => cnt[b]).sort((a, b) => cnt[b] - cnt[a]);
  const out = [];
  for (const b of bins) {
    const c = [sr[b] / cnt[b], sg[b] / cnt[b], sb[b] / cnt[b]].map(Math.round);
    if (out.every(o => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) > 28)) out.push(c);
    if (out.length >= 10) break;
  }
  if (!out.length) { say('no colours there (all empty)'); return; }
  swatches = out.map(rgbHex); fillCol = swatches[0]; saveSwatches();
  say(`${out.length} swatches from the ${useSel ? 'selection' : 'image'}`);
}

/* ---------------- randomize ---------------- */
// A share of the pixels in the selection (or the image) is deleted or recoloured; replacement colours come
// from a random pixel within reach (sampled from the image as it was before), from the swatches, or both.
const rx = { amt: 30, del: 30, src: 'near', reach: 4 };
try { Object.assign(rx, JSON.parse(localStorage.getItem('ie2.pixels.random') || '{}')); } catch (e) { /* ignore */ }
let lastRandom = null;     // the history entry of the last randomize, for Re-roll
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function randomize() {
  if (!loaded || float) return;
  const useSel = sel.n > 0, r = useSel ? bbox() : { x: 0, y: 0, w: W, h: H };
  const rnd = mulberry((Math.random() * 4294967296) >>> 0), R = Math.max(1, rx.reach | 0);
  // frozen copy of the area plus its reach, so replacements come from the original pixels
  const fx0 = Math.max(0, r.x - R), fy0 = Math.max(0, r.y - R), fx1 = Math.min(W, r.x + r.w + R), fy1 = Math.min(H, r.y + r.h + R), fw = fx1 - fx0;
  const frozen = new Uint32Array(fw * (fy1 - fy0));
  for (let y = fy0; y < fy1; y++) frozen.set(px32.subarray(y * W + fx0, y * W + fx1), (y - fy0) * fw);
  const before = snap(r);
  const pAmt = rx.amt / 100, pDel = rx.del / 100;
  let changed = 0, deleted = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const i = y * W + x;
    if (useSel && !mask[i]) continue;
    if (rnd() >= pAmt) continue;
    changed++;
    if (rnd() < pDel) { px32[i] = 0; deleted++; continue; }
    const fromSw = rx.src === 'swatches' || (rx.src === 'mix' && rnd() < 0.5);
    if (fromSw && swatches.length) { const c = randSwatch(rnd); px32[i] = pack(c[0], c[1], c[2]); continue; }
    for (let t = 0; t < 8; t++) {                // a random non-empty pixel within reach
      const X = x + Math.round((rnd() * 2 - 1) * R), Y = y + Math.round((rnd() * 2 - 1) * R);
      if (X < fx0 || Y < fy0 || X >= fx1 || Y >= fy1) continue;
      const v = frozen[(Y - fy0) * fw + (X - fx0)];
      if (v >>> 24) { px32[i] = v; break; }
    }
  }
  if (!changed) { say('nothing changed: raise Amount'); return; }
  record(r, before, snap(r), 'randomize'); lastRandom = hist[hist.length - 1];
  redraw(r); need(); syncRandom();
  say(`randomized ${changed.toLocaleString()} pixels${useSel ? ' in the selection' : ''} · ${deleted.toLocaleString()} deleted, ${(changed - deleted).toLocaleString()} recoloured`);
}
function reroll() {
  if (!(lastRandom && hist[hist.length - 1] === lastRandom)) return;
  undo(); const e = future.pop(); histBytes -= 2 * (e.before.pix.length + e.before.m.length);   // replaced, not redoable
  randomize();
}
function syncRandom() {
  $('#ramt').value = rx.amt; $('#ramtv').textContent = rx.amt + '%'; $('#rdel').value = rx.del; $('#rdelv').textContent = rx.del + '%';
  $('#rsrc').value = rx.src; $('#rreach').value = rx.reach; $('#rreachv').textContent = rx.reach + ' px';
  $('#rarea').textContent = sel.n ? `Works on the ${sel.n.toLocaleString()} selected pixels.` : 'Nothing selected: works on the whole image.';
  $('#rroll').disabled = !(lastRandom && hist[hist.length - 1] === lastRandom);
  try { localStorage.setItem('ie2.pixels.random', JSON.stringify(rx)); } catch (e) { /* ignore */ }
}

// onion peel: each round fills the holes touching real pixels with the average of those neighbours.
// Returns how many holes had nothing around to borrow from.
function peel(hole, n) {
  const touches = (i) => { const x = i % W, y = (i / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if ((dx || dy) && X >= 0 && Y >= 0 && X < W && Y < H) { const j = Y * W + X; if (!hole[j] && !isEmpty(j)) return true; } } return false; };
  const queued = new Uint8Array(W * H);
  let front = [];
  for (let i = 0; i < hole.length; i++) if (hole[i] && touches(i)) { front.push(i); queued[i] = 1; }
  let left = n;
  while (front.length) {
    const cols = new Uint32Array(front.length);
    for (let k = 0; k < front.length; k++) {
      const i = front[k], x = i % W, y = (i / W) | 0; let sr = 0, sg = 0, sb = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy; if (!(dx || dy) || X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const j = Y * W + X; if (hole[j] || isEmpty(j)) continue;
        const o = j * 4; sr += data[o]; sg += data[o + 1]; sb += data[o + 2]; c++;
      }
      cols[k] = c ? pack(Math.round(sr / c), Math.round(sg / c), Math.round(sb / c)) : 0;
    }
    const next = [];
    for (let k = 0; k < front.length; k++) if (cols[k]) { px32[front[k]] = cols[k]; hole[front[k]] = 0; left--; }
    for (const i of front) {
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const j = Y * W + X; if (hole[j] && !queued[j]) { queued[j] = 1; next.push(j); }
      }
    }
    front = next;
  }
  return left;
}
// give every marked pixel a colour from the current fill source
function fillMarked(hole, n) {
  if (fillSrc === 'colour') { const c = pickCol(), w = pack(c[0], c[1], c[2]); for (let i = 0; i < hole.length; i++) if (hole[i]) px32[i] = w; return; }
  if (fillSrc === 'swatches') { for (let i = 0; i < hole.length; i++) if (hole[i]) { const c = randSwatch(); px32[i] = pack(c[0], c[1], c[2]); } return; }
  if (peel(hole, n) > 0) { const c = pickCol(), w = pack(c[0], c[1], c[2]); for (let i = 0; i < hole.length; i++) if (hole[i]) px32[i] = w; }   // nothing around to borrow from
}
// fill every empty pixel in the selection (or the whole image) from the outside in
function fillHoles() {
  if (!loaded || float) return;
  const r = sel.n ? bbox() : { x: 0, y: 0, w: W, h: H }, useSel = sel.n > 0;
  const hole = new Uint8Array(W * H); let n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let i = y * W + r.x, e = i + r.w; i < e; i++) if (isEmpty(i) && (!useSel || mask[i])) { hole[i] = 1; n++; }
  if (!n) { say(useSel ? 'no empty pixels in the selection' : 'no empty pixels to fill'); return; }
  const before = snap(r);
  fillMarked(hole, n);
  record(r, before, snap(r), 'fill holes'); redraw(r); need();
  say(`filled ${n.toLocaleString()} empty pixel${n > 1 ? 's' : ''}` + (useSel ? ' in the selection' : ''));
}
// replace every selected pixel (empty or not) with colour rebuilt from around the selection
function fillSel() {
  if (!sel.n || float) return;
  const r = bbox(), hole = new Uint8Array(W * H); let n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let i = y * W + r.x, e = i + r.w; i < e; i++) if (mask[i]) { hole[i] = 1; n++; }
  const before = snap(r);
  fillMarked(hole, n);
  record(r, before, snap(r), 'fill selection'); redraw(r); need();
  say(`refilled ${n.toLocaleString()} selected pixel${n > 1 ? 's' : ''} ` + (fillSrc === 'near' ? 'from their surroundings' : fillSrc === 'colour' ? 'with the current colour' : 'with random swatches'));
}

/* ---------------- smoothing ---------------- */
// gaussian-like blur (three box passes) of the selected pixels; empty pixels neither change nor contribute
function hbox(a, w, h, r, tmp) {
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0;
    for (let k = -r; k <= r; k++) s += a[o + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) { tmp[o + x] = s / d; s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)]; }
  }
  a.set(tmp);
}
function vbox(a, w, h, r, tmp) {
  const d = 2 * r + 1, s = new Float64Array(w);
  for (let k = -r; k <= r; k++) { const o = clamp(k, 0, h - 1) * w; for (let x = 0; x < w; x++) s[x] += a[o + x]; }
  for (let y = 0; y < h; y++) {
    const o = y * w, add = Math.min(h - 1, y + r + 1) * w, sub = Math.max(0, y - r) * w;
    for (let x = 0; x < w; x++) { tmp[o + x] = s[x] / d; s[x] += a[add + x] - a[sub + x]; }
  }
  a.set(tmp);
}
function smoothSel() {
  if (!sel.n || float) return;
  const sigma = fb.sigma, br = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2)), M = 3 * br + 1;
  const r = bbox(), before = snap(r), bp = before.pix;
  const ax0 = Math.max(0, r.x - M), ax1 = Math.min(W, r.x + r.w + M), aw = ax1 - ax0;
  const S = Math.max(32, Math.floor(4e6 / aw));
  let n = 0;
  for (let y0 = r.y; y0 < r.y + r.h; y0 += S) {
    const y1 = Math.min(r.y + r.h, y0 + S), sy0 = Math.max(0, y0 - M), sy1 = Math.min(H, y1 + M), sh = sy1 - sy0, N = aw * sh;
    const ch = [new Float32Array(N), new Float32Array(N), new Float32Array(N), new Float32Array(N)], tmp = new Float32Array(N);
    for (let y = sy0; y < sy1; y++) {
      const inRow = y >= r.y && y < r.y + r.h;
      for (let x = ax0; x < ax1; x++) {
        const k = (y - sy0) * aw + (x - ax0);
        let o, src;
        if (inRow && x >= r.x && x < r.x + r.w) { src = bp; o = ((y - r.y) * r.w + (x - r.x)) * 4; } else { src = data; o = (y * W + x) * 4; }
        if (!src[o + 3]) continue;
        ch[0][k] = src[o]; ch[1][k] = src[o + 1]; ch[2][k] = src[o + 2]; ch[3][k] = 1;
      }
    }
    for (const a of ch) for (let p = 0; p < 3; p++) { hbox(a, aw, sh, br, tmp); vbox(a, aw, sh, br, tmp); }
    for (let y = y0; y < y1; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const i = y * W + x; if (!mask[i] || !data[i * 4 + 3]) continue;
      const k = (y - sy0) * aw + (x - ax0), wt = ch[3][k]; if (wt <= 1e-6) continue;
      const o = i * 4; data[o] = ch[0][k] / wt; data[o + 1] = ch[1][k] / wt; data[o + 2] = ch[2][k] / wt; n++;
    }
  }
  record(r, before, snap(r), 'smooth'); redraw(r); need();
  say(`smoothed ${n.toLocaleString()} pixels (radius ${sigma} px)`);
}

/* ---------------- repair JPEG blocks ---------------- */
// Keeps every pixel's own detail. Only two things change:
//  1. inside each selected 8×8 block, DCT patterns that are much stronger than in the clean blocks around it
//     (the stripes / checkers) are turned down to the neighbourhood's level, keeping their sign;
//  2. along each 8-pixel block border, the average jump (minus the natural slope) is removed with a 4 px ramp
//     on both sides. It is an average over the whole border, so pixel-level grain stays; real edges are skipped.
function repairSel() {
  if (!sel.n || float || !loaded) return;
  const t0 = performance.now(), k = fb.rep / 100;
  const { ox, oy } = blockGrid();
  const nbx = Math.floor((W - ox) / 8), nby = Math.floor((H - oy) / 8);
  if (nbx < 1 || nby < 1) return;
  // which blocks are selected (at least a quarter of their pixels) and fully non-empty
  const NB = nbx * nby, tgt = new Uint8Array(NB), valid = new Uint8Array(NB);
  for (let by = 0; by < nby; by++) for (let bx = 0; bx < nbx; bx++) {
    const X0 = ox + bx * 8, Y0 = oy + by * 8; let ns = 0, ok = 1;
    for (let j = 0; j < 8; j++) for (let i = 0, p = (Y0 + j) * W + X0; i < 8; i++, p++) { if (mask[p]) ns++; if (!data[p * 4 + 3]) ok = 0; }
    valid[by * nbx + bx] = ok; if (ok && ns >= 16) tgt[by * nbx + bx] = 1;
  }
  let nt = 0, tb = [nbx, nby, -1, -1];
  for (let b = 0; b < NB; b++) if (tgt[b]) { nt++; const bx = b % nbx, by = (b / nbx) | 0; tb[0] = Math.min(tb[0], bx); tb[1] = Math.min(tb[1], by); tb[2] = Math.max(tb[2], bx); tb[3] = Math.max(tb[3], by); }
  if (!nt) { say('no whole 8×8 blocks in the selection to repair'); return; }
  const r = { x: Math.max(0, ox + tb[0] * 8 - 4), y: Math.max(0, oy + tb[1] * 8 - 4) };
  r.w = Math.min(W, ox + tb[2] * 8 + 12) - r.x; r.h = Math.min(H, oy + tb[3] * 8 + 12) - r.y;
  const before = snap(r);
  // 1. stripes: per channel, per band of block rows
  const RB = 3, BAND = 48;
  const blk = new Float32Array(64), tm = new Float32Array(64), Cb = new Float32Array(64), ref = new Float32Array(64);
  let shrunk = 0;
  for (let b0 = tb[1]; b0 <= tb[3]; b0 += BAND) {
    const b1 = Math.min(tb[3], b0 + BAND - 1);
    const wy0 = Math.max(0, b0 - RB), wy1 = Math.min(nby - 1, b1 + RB), wx0 = Math.max(0, tb[0] - RB), wx1 = Math.min(nbx - 1, tb[2] + RB);
    const nwx = wx1 - wx0 + 1, nwy = wy1 - wy0 + 1, NW = nwx * nwy;
    for (let c = 0; c < 3; c++) {
      const coef = new Float32Array(NW * 64);
      for (let wy = 0; wy < nwy; wy++) for (let wx = 0; wx < nwx; wx++) {
        const b = (wy0 + wy) * nbx + wx0 + wx; if (!valid[b]) continue;
        const X0 = ox + (wx0 + wx) * 8, Y0 = oy + (wy0 + wy) * 8;
        for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) blk[j * 8 + i] = data[((Y0 + j) * W + X0 + i) * 4 + c];
        dct8(blk, tm, coef, (wy * nwx + wx) * 64);
      }
      // fallback reference: median |coefficient| over the unselected blocks of this band
      const glob = new Float32Array(64);
      { const list = []; for (let wy = 0; wy < nwy; wy++) for (let wx = 0; wx < nwx; wx++) { const b = (wy0 + wy) * nbx + wx0 + wx; if (valid[b] && !tgt[b]) list.push(wy * nwx + wx); }
        if (list.length < 4) for (let q = 0; q < NW; q++) { const b = (wy0 + ((q / nwx) | 0)) * nbx + wx0 + q % nwx; if (valid[b]) list.push(q); }
        const step = Math.max(1, Math.floor(list.length / 1500)), tmp = [];
        for (let u = 1; u < 64; u++) { tmp.length = 0; for (let q = 0; q < list.length; q += step) tmp.push(Math.abs(coef[list[q] * 64 + u])); tmp.sort((a, b) => a - b); glob[u] = tmp.length ? tmp[tmp.length >> 1] / 0.6745 : 1; } }
      for (let by = b0; by <= b1; by++) for (let bx = tb[0]; bx <= tb[2]; bx++) {
        const b = by * nbx + bx; if (!tgt[b]) continue;
        // local reference: typical size of each pattern in the clean blocks nearby
        let n = 0; ref.fill(0);
        for (let R = 2; R <= RB && n < 4; R++) {
          n = 0; ref.fill(0);
          for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
            const X = bx + dx, Y = by + dy; if (X < wx0 || X > wx1 || Y < wy0 || Y > wy1) continue;
            const nb = Y * nbx + X; if (!valid[nb] || tgt[nb]) continue;
            const o = ((Y - wy0) * nwx + X - wx0) * 64; for (let u = 1; u < 64; u++) ref[u] += Math.abs(coef[o + u]); n++;
          }
        }
        for (let u = 1; u < 64; u++) ref[u] = n >= 4 ? (ref[u] / n) * 1.2533 : glob[u];
        const o = ((by - wy0) * nwx + bx - wx0) * 64; let ch = false;
        for (let u = 0; u < 64; u++) Cb[u] = coef[o + u];
        for (let u = 1; u < 64; u++) {
          if (Math.max(u & 7, u >> 3) < 2) continue;                   // leave the block's shading / gradients alone
          const a = Math.abs(Cb[u]), lim = 1.5 * ref[u] + 1;
          if (a > lim) { const target = Math.max(ref[u], 0.5); Cb[u] *= 1 - k * (1 - target / a); ch = true; shrunk++; }
        }
        if (!ch) continue;
        idct8(Cb, tm, blk);
        const X0 = ox + bx * 8, Y0 = oy + by * 8;
        for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const p = (Y0 + j) * W + X0 + i; if (mask[p]) data[p * 4 + c] = blk[j * 8 + i]; }
      }
    }
  }
  // 2. block borders: remove the average step along each border of a repaired block
  const WT = [0.5, 0.375, 0.25, 0.125];
  let borders = 0;
  const fixBorder = (A, B, vert) => {
    // vert: A left of B (border is a vertical line); else A above B
    const ax = ox + (A % nbx) * 8, ay = oy + ((A / nbx) | 0) * 8;
    const at = (t, d) => vert ? ((ay + t) * W + ax + 7 - d) : ((ay + 7 - d) * W + ax + t);       // pixel d steps inside A from the border
    const bt = (t, d) => vert ? ((ay + t) * W + ax + 8 + d) : ((ay + 8 + d) * W + ax + t);       // pixel d steps inside B
    let did = false;
    for (let c = 0; c < 3; c++) {
      let e = 0, e2 = 0, jump = 0;
      for (let t = 0; t < 8; t++) {
        const p0 = data[at(t, 0) * 4 + c], p1 = data[at(t, 1) * 4 + c], q0 = data[bt(t, 0) * 4 + c], q1 = data[bt(t, 1) * 4 + c];
        const x = (q0 - p0) - ((p0 - p1) + (q1 - q0)) / 2; e += x; e2 += x * x; jump += Math.abs(q0 - p0);
      }
      e /= 8; jump /= 8;
      const se = Math.sqrt(Math.max(0, e2 / 8 - e * e) / 7);          // how uncertain that average is (grain)
      if (Math.abs(e) < 0.75 + 1.5 * se || jump > 22) continue;     // no real step (just grain), or a real edge
      const d = e * k;
      for (let t = 0; t < 8; t++) for (let s = 0; s < 4; s++) { const pa = at(t, s) * 4 + c, pb = bt(t, s) * 4 + c; data[pa] = data[pa] + d * WT[s]; data[pb] = data[pb] - d * WT[s]; }
      did = true;
    }
    if (did) borders++;
  };
  for (let by = tb[1]; by <= tb[3]; by++) for (let bx = Math.max(0, tb[0] - 1); bx <= tb[2] && bx < nbx - 1; bx++) {
    const a = by * nbx + bx, b = a + 1; if ((tgt[a] || tgt[b]) && valid[a] && valid[b]) fixBorder(a, b, true);
  }
  for (let by = Math.max(0, tb[1] - 1); by <= tb[3] && by < nby - 1; by++) for (let bx = tb[0]; bx <= tb[2]; bx++) {
    const a = by * nbx + bx, b = a + nbx; if ((tgt[a] || tgt[b]) && valid[a] && valid[b]) fixBorder(a, b, false);
  }
  record(r, before, snap(r), 'repair blocks'); redraw(r); need();
  say(`repaired ${nt.toLocaleString()} block${nt > 1 ? 's' : ''} · ${shrunk.toLocaleString()} stripe patterns toned down · ${borders.toLocaleString()} block borders evened out (${Math.round(performance.now() - t0)} ms)`);
}
function dct8(blk, tm, out, o) {
  for (let j = 0; j < 8; j++) for (let u = 0; u < 8; u++) { let a = 0; for (let i = 0; i < 8; i++) a += DB[u * 8 + i] * blk[j * 8 + i]; tm[j * 8 + u] = a; }
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) { let a = 0; for (let j = 0; j < 8; j++) a += DB[v * 8 + j] * tm[j * 8 + u]; out[o + v * 8 + u] = a; }
}
function idct8(C, tm, blk) {
  for (let j = 0; j < 8; j++) for (let u = 0; u < 8; u++) { let a = 0; for (let v = 0; v < 8; v++) a += DB[v * 8 + j] * C[v * 8 + u]; tm[j * 8 + u] = a; }
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { let a = 0; for (let u = 0; u < 8; u++) a += DB[u * 8 + i] * tm[j * 8 + u]; blk[j * 8 + i] = a; }
}

/* ---------------- find JPEG blocks ---------------- */
// JPEG works on an 8×8 grid. Damaged blocks show up as either
//  - "stripes": a block whose detail is carried by one or a few strong high-frequency DCT patterns (barcode / checker looks), or
//  - "flat steps": blocks with no detail inside that jump in brightness exactly at the block border (staircase look).
const fb = { sens: 50, kind: 'both', grow: 1, within: false, sigma: 2, rep: 100 };
try { Object.assign(fb, JSON.parse(localStorage.getItem('ie2.pixels.blocks') || '{}')); } catch (e) { /* ignore */ }
const DB = (() => { const b = new Float32Array(64); for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) b[u * 8 + x] = (u ? 1 : Math.SQRT1_2) * 0.5 * Math.cos((2 * x + 1) * u * Math.PI / 16); return b; })();
const lumAt = (o) => 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
// where the 8×8 grid sits: the column / row phase at which neighbouring pixels differ the most
function blockGrid() {
  const sx = new Float64Array(8), nx = new Float64Array(8), sy = new Float64Array(8), ny = new Float64Array(8);
  const rs = Math.max(1, Math.floor(H / 500)), cs = Math.max(1, Math.floor(W / 500));
  for (let y = 0; y < H; y += rs) for (let x = 1; x < W; x++) { const o = (y * W + x) * 4; if (data[o + 3] && data[o - 1]) { sx[(x - 1) & 7] += Math.abs(lumAt(o) - lumAt(o - 4)); nx[(x - 1) & 7]++; } }
  for (let y = 1; y < H; y++) for (let x = 0; x < W; x += cs) { const o = (y * W + x) * 4, p = o - W * 4; if (data[o + 3] && data[p + 3]) { sy[(y - 1) & 7] += Math.abs(lumAt(o) - lumAt(p)); ny[(y - 1) & 7]++; } }
  const best = (s, n) => { const m = [...s].map((v, k) => n[k] ? v / n[k] : 0); let k = 0; for (let j = 1; j < 8; j++) if (m[j] > m[k]) k = j; const med = [...m].sort((a, b) => a - b)[4]; return [(k + 1) & 7, med > 0 ? m[k] / med : 1]; };
  const [ox, kx] = best(sx, nx), [oy, ky] = best(sy, ny);
  return { ox, oy, strength: Math.min(kx, ky) };
}
let lastFind = null;
function findBlocks() {
  if (!loaded || float) return;
  const t0 = performance.now(), s = fb.sens / 100, g = blockGrid(), { ox, oy } = g;
  const nbx = Math.floor((W - ox) / 8), nby = Math.floor((H - oy) / 8);
  if (nbx < 1 || nby < 1) { say('image is smaller than one 8×8 block'); return; }
  const mode = heldMode() || modeBtn, within = fb.within && sel.n > 0;
  let bx0 = 0, by0 = 0, bx1 = nbx - 1, by1 = nby - 1;
  if (within) { bx0 = clamp(Math.floor((sel.x0 - ox) / 8), 0, nbx - 1); by0 = clamp(Math.floor((sel.y0 - oy) / 8), 0, nby - 1); bx1 = clamp(Math.floor((sel.x1 - ox) / 8), 0, nbx - 1); by1 = clamp(Math.floor((sel.y1 - oy) / 8), 0, nby - 1); }
  const NB = nbx * nby, flag = new Uint8Array(NB), valid = new Uint8Array(NB), flat = new Uint8Array(NB), edge = new Float32Array(NB * 4);
  const aMin = 4 - 3 * s, kMax = 2 + Math.round(3 * s), rMax = 0.55 + 0.7 * s, flatMax = 0.35 + 0.4 * s, stepMin = 1.9 - 0.8 * s, lineMin = 0.45 - 0.2 * s, lineAmp = 5 - 2.5 * s;
  const doStripes = fb.kind !== 'steps', doSteps = fb.kind !== 'stripes';
  const blk = new Float32Array(64), tm = new Float32Array(64), C = new Float32Array(64);
  for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
    const b = by * nbx + bx, X0 = ox + bx * 8, Y0 = oy + by * 8;
    let ok = true, m = 0;
    for (let j = 0; j < 8 && ok; j++) for (let i = 0; i < 8; i++) { const o = ((Y0 + j) * W + X0 + i) * 4; if (!data[o + 3]) { ok = false; break; } const l = lumAt(o); blk[j * 8 + i] = l; m += l; }
    if (!ok) continue;
    valid[b] = 1; m /= 64;
    let le = 0, ri = 0, to = 0, bo = 0;
    for (let k = 0; k < 8; k++) { le += blk[k * 8]; ri += blk[k * 8 + 7]; to += blk[k]; bo += blk[56 + k]; }
    edge[b * 4] = le / 8; edge[b * 4 + 1] = ri / 8; edge[b * 4 + 2] = to / 8; edge[b * 4 + 3] = bo / 8;
    for (let k = 0; k < 64; k++) blk[k] -= m;
    for (let j = 0; j < 8; j++) for (let u = 0; u < 8; u++) { let a = 0; for (let i = 0; i < 8; i++) a += DB[u * 8 + i] * blk[j * 8 + i]; tm[j * 8 + u] = a; }
    let A1 = 0, E = 0;
    for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) { let a = 0; for (let j = 0; j < 8; j++) a += DB[v * 8 + j] * tm[j * 8 + u]; C[v * 8 + u] = a; if (v || u) { const q = Math.abs(a); E += a * a; if (q > A1) A1 = q; } }
    if (Math.sqrt(E / 63) <= flatMax) flat[b] = 1;
    if (doStripes && A1 >= aMin) {
      const thr = Math.max(1.5, 0.25 * A1); let k = 0, rest = 0, hf = false;
      for (let q = 1; q < 64; q++) { const a = Math.abs(C[q]); if (a >= thr) { k++; if (Math.max(q & 7, q >> 3) >= 2) hf = true; } else rest += a * a; }
      if (hf && k <= kMax && Math.sqrt(rest / Math.max(1, 63 - k)) <= rMax) flag[b] |= 1;
    }
    if (doStripes && !(flag[b] & 1) && E > 0) {
      // straight line stripes: most of the detail sits in fine vertical (or horizontal) lines, not in coarse shading or a real edge
      // (a single thin line or edge spreads evenly over all frequencies; stripes peak at one)
      let vh = 0, vl = 0, hh = 0, hl = 0, vm = 0, hm = 0;
      for (let q = 1; q < 8; q++) { const a = C[q] * C[q], c = C[q * 8] * C[q * 8]; if (a > vm) vm = a; if (c > hm) hm = c; if (q < 3) { vl += a; hl += c; } else { vh += a; hh += c; } }
      const useV = vh >= hh, hi = useV ? vh : hh, lo = useV ? vl : hl, peak = (useV ? vm : hm) / (hi + lo);
      if (hi / E >= lineMin && Math.sqrt(hi) >= lineAmp && hi >= 1.5 * lo && peak >= 0.4) flag[b] |= 1;
    }
  }
  if (doSteps) {
    // flat neighbours that jump at the shared border, while neither block slopes towards it (that would be a smooth gradient)
    const test = (a, b, horiz) => {
      if (!valid[a] || !valid[b] || !flat[a] || !flat[b]) return;
      const [nearA, farA, nearB, farB] = horiz ? [edge[a * 4 + 1], edge[a * 4], edge[b * 4], edge[b * 4 + 1]] : [edge[a * 4 + 3], edge[a * 4 + 2], edge[b * 4 + 2], edge[b * 4 + 3]];
      const jump = Math.abs(nearB - nearA), slope = Math.max(Math.abs(nearA - farA), Math.abs(farB - nearB)) / 7;
      if (jump >= stepMin && jump <= 16 && jump >= 2.5 * slope + 0.3) { flag[a] |= 2; flag[b] |= 2; }
    };
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      const b = by * nbx + bx;
      if (bx < bx1) test(b, b + 1, true);
      if (by < by1) test(b, b + nbx, false);
    }
  }
  // turn flagged blocks into a pixel mask, grown by a few pixels so the block borders are covered too
  const found = new Uint8Array(W * H), gr = fb.grow | 0;
  let nf = 0, nStripe = 0, nStep = 0;
  for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
    const f = flag[by * nbx + bx]; if (!f) continue;
    nf++; if (f & 1) nStripe++; else nStep++;
    const x0 = Math.max(0, ox + bx * 8 - gr), x1 = Math.min(W - 1, ox + bx * 8 + 7 + gr), y0 = Math.max(0, oy + by * 8 - gr), y1 = Math.min(H - 1, oy + by * 8 + 7 + gr);
    for (let y = y0; y <= y1; y++) found.fill(1, y * W + x0, y * W + x1 + 1);
  }
  if (within && mode !== 'sub') { for (let y = sel.y0; y <= sel.y1; y++) for (let i = y * W + sel.x0, e = y * W + sel.x1; i <= e; i++) mask[i] &= found[i]; }
  else if (mode === 'sub') { for (let i = 0; i < found.length; i++) if (found[i]) mask[i] = 0; }
  else if (mode === 'add') { for (let i = 0; i < found.length; i++) if (found[i]) mask[i] = 1; }
  else if (mode === 'toggle') { for (let i = 0; i < found.length; i++) mask[i] ^= found[i]; }
  else mask.set(found);
  rescan(); need();
  const scanned = (bx1 - bx0 + 1) * (by1 - by0 + 1);
  lastFind = { blocks: nf, stripes: nStripe, steps: nStep, scanned, ox, oy, strength: g.strength, ms: Math.round(performance.now() - t0) };
  syncBlocks();
  say(nf ? `found ${nf.toLocaleString()} block${nf > 1 ? 's' : ''} with JPEG patterns · ${sel.n.toLocaleString()} pixels selected` : 'no block patterns found at this sensitivity');
}
function syncBlocks() {
  $('#fbsens').value = fb.sens; $('#fbsensv').textContent = fb.sens; $('#fbkind').value = fb.kind; $('#fbgrow').value = fb.grow; $('#fbgrowv').textContent = fb.grow + ' px';
  $('#fbwithin').checked = fb.within; $('#fbsig').value = fb.sigma; $('#fbsigv').textContent = fb.sigma + ' px'; $('#fbrepk').value = fb.rep; $('#fbrepv').textContent = fb.rep + '%'; $('#fbsrc').value = fillSrc;
  const f = lastFind;
  $('#fbres').textContent = !f ? 'Nothing searched yet.' : !f.blocks ? 'No block patterns found. Raise Sensitivity to catch fainter ones.'
    : `${f.blocks.toLocaleString()} of ${f.scanned.toLocaleString()} blocks (${(100 * f.blocks / f.scanned).toFixed(1)}%) · ${f.stripes.toLocaleString()} striped, ${f.steps.toLocaleString()} flat steps` + (f.strength < 1.15 ? ' · no clear JPEG grid in this image, results are a best guess' : '');
  ['#fbrep', '#fbsmooth', '#fbfill', '#fbdel', '#fbrnd'].forEach(q => { $(q).disabled = !sel.n; });
  try { localStorage.setItem('ie2.pixels.blocks', JSON.stringify(fb)); } catch (e) { /* ignore */ }
}

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
    vctx.globalAlpha = z >= 6 ? 0.2 : 0.3;
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
  if (selList && z < 3 && sel.n <= 1500) {   // small selections stay visible when pixels are smaller than a few screen dots
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
  if (tool === 'fill' && hover && !spaceDown) {     // brush outline
    const h = (brush - 1) / 2, bx = tx + (hover[0] - h) * z, by = ty + (hover[1] - h) * z, bs = Math.max(brush * z, 4);
    vctx.strokeStyle = '#fff'; vctx.lineWidth = 1.5; vctx.strokeRect(bx - .5, by - .5, bs + 1, bs + 1);
    vctx.strokeStyle = 'rgb(' + ACC.join(',') + ')'; vctx.lineWidth = 1; vctx.strokeRect(bx + .5, by + .5, bs - 1, bs - 1);
  }
  const ml = tool === 'select' ? MODE_LABEL[selMode(null) === 'replace' ? '' : selMode(null)] : '';
  if (ml && hover && !spaceDown) {
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
  if (!$('#rpop').hidden) syncRandom();
  if (!$('#fbpop').hidden) syncBlocks();
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
  e.preventDefault();                                   // no text selection / native drag (Firefox Shift+click)
  if (drag) endDrag(null);                              // a previous click whose release never arrived
  const [cx, cy] = pos(e);
  try { view.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety */ }
  if (tool === 'hand' || spaceDown || e.button === 1 || e.button === 2) { drag = { mode: 'pan', cx, cy, tx, ty }; stage.classList.add('panning'); return; }
  if (e.button !== 0) return;
  const [x, y] = toImg(cx, cy);
  if (tool === 'fill') { drag = { mode: 'fill', filled: [], last: [x, y] }; paint(x, y, drag.filled); need(); return; }
  if (tool === 'pick') { pickAt(x, y); return; }
  const mode = selMode(e);
  if (inside(x, y) && mask[y * W + x] && !heldMode(e) && modeBtn !== 'sub') { lift(); drag = { mode: 'move', cx, cy }; sync(); need(); return; }
  drag = { mode: 'pick', cx, cy, a: [x, y], b: [x, y], sel: mode };
});
view.addEventListener('pointermove', (e) => {
  const [cx, cy] = pos(e);
  if (!drag) { hover = loaded ? toImg(cx, cy) : null; showHover(); stage.classList.toggle('over-sel', !!(hover && inside(...hover) && mask[hover[1] * W + hover[0]] && tool === 'select' && !spaceDown)); need(); return; }
  if (drag.mode === 'pan') { tx = drag.tx + cx - drag.cx; ty = drag.ty + cy - drag.cy; need(); return; }
  if (drag.mode === 'move') { moveTo(cx, cy, e.shiftKey); $('#status').textContent = `moving ${float.dx}, ${float.dy}` + (e.shiftKey ? ' · straight' : ''); need(); return; }
  if (drag.mode === 'fill') { const p = toImg(cx, cy); line(drag.last, p, drag.filled); drag.last = p; hover = p; need(); return; }
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
  if (e && (e.type === 'pointerup' || e.type === 'mouseup')) {   // take the release point and the keys held at release too
    const [cx, cy] = pos(e);
    if (drag.mode === 'move' && float) moveTo(cx, cy, e.shiftKey);
    if (drag.mode === 'box' || (drag.mode === 'pick' && Math.hypot(cx - drag.cx, cy - drag.cy) > 3)) { drag.mode = 'box'; drag.b = toImg(cx, cy); }
    const m = heldMode(e); if (m && drag.sel) drag.sel = m;
  }
  const d = drag; drag = null; stage.classList.remove('panning');
  if (d.mode === 'fill') { finishFill(d.filled); sync(); need(); return; }
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
view.addEventListener('lostpointercapture', (e) => { if (drag) endDrag(e); });
// fallbacks: a release outside the canvas, or a mouse release without a pointer release
window.addEventListener('pointerup', (e) => { if (drag) endDrag(e); });
window.addEventListener('mouseup', (e) => { if (drag) setTimeout(() => { if (drag) endDrag(e); }, 0); });
['mousedown', 'selectstart', 'dragstart'].forEach(t => view.addEventListener(t, (e) => e.preventDefault()));
view.addEventListener('pointerleave', () => { if (!drag) { hover = null; showHover(); need(); } });
view.addEventListener('contextmenu', (e) => e.preventDefault());
view.addEventListener('wheel', (e) => {
  if (!loaded) return; e.preventDefault();
  const [cx, cy] = pos(e);
  zoomAt(z * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), cx, cy);
}, { passive: false });

/* ---------------- keyboard ---------------- */
const NOMODS = () => ({ shift: false, alt: false, ctrl: false, a: false, x: false });
function trackMods(e) {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  const down = e.type === 'keydown', k = (e.key || '').toLowerCase(), plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  const m = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, a: mods.a, x: mods.x };
  if (k === 'a' && plain) m.a = down; if (k === 'x' && plain) m.x = down;
  const before = heldMode(null);
  mods = m;
  const now = heldMode(null);
  if (now !== before && loaded && !drag && tool === 'select') { say(now ? `${MODE_LABEL[now]}: click or drag` : 'ready'); }
  need();
}
window.addEventListener('keydown', trackMods, true);
window.addEventListener('keyup', trackMods, true);
window.addEventListener('blur', () => { mods = NOMODS(); need(); });
document.addEventListener('visibilitychange', () => { mods = NOMODS(); });
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
  if (k === 'v') setTool('select'); else if (k === 'h') setTool('hand'); else if (k === 'f') setTool('fill'); else if (k === 'i') setTool('pick'); else if (k === '0') fit();
  else if (k === '+' || k === '=') zoomAt(z * 1.5, stage.clientWidth / 2, stage.clientHeight / 2);
  else if (k === '-') zoomAt(z / 1.5, stage.clientWidth / 2, stage.clientHeight / 2);
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; stage.classList.toggle('hand', tool === 'hand'); } });
function setTool(t) {
  tool = t; document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  stage.classList.toggle('hand', t === 'hand'); stage.classList.toggle('filling', t === 'fill'); stage.classList.toggle('picking', t === 'pick');
  $('#smode').hidden = t !== 'select'; $('#fopts').hidden = t !== 'fill';
  need();
}
document.querySelectorAll('#tools button').forEach(b => b.addEventListener('click', () => setTool(b.dataset.t)));
function setModeBtn(m) { modeBtn = m; document.querySelectorAll('#smode button').forEach(b => b.classList.toggle('on', b.dataset.m === m)); need(); }
document.querySelectorAll('#smode button').forEach(b => b.addEventListener('click', () => setModeBtn(b.dataset.m)));
$('#brush').addEventListener('change', (e) => { brush = +e.target.value; need(); });
$('#fsrc').addEventListener('change', (e) => { fillSrc = e.target.value; });
$('#fcol').addEventListener('input', (e) => { fillCol = e.target.value; renderSwatches(); });
$('#fcol').addEventListener('change', (e) => addSwatch(e.target.value));
$('#swarea').addEventListener('click', swatchesFromArea);
$('#swclear').addEventListener('click', () => { swatches = []; saveSwatches(); });
$('#rnd').addEventListener('click', () => { const p = $('#rpop'); p.hidden = !p.hidden; syncRandom(); });
$('#ramt').addEventListener('input', (e) => { rx.amt = +e.target.value; syncRandom(); });
$('#rdel').addEventListener('input', (e) => { rx.del = +e.target.value; syncRandom(); });
$('#rsrc').addEventListener('change', (e) => { rx.src = e.target.value; syncRandom(); });
$('#rreach').addEventListener('input', (e) => { rx.reach = +e.target.value; syncRandom(); });
$('#rapply').addEventListener('click', randomize);
$('#rroll').addEventListener('click', reroll);
document.addEventListener('pointerdown', (e) => { if (!$('#rpop').hidden && !e.target.closest('#rpop, #rnd, #fbrnd')) $('#rpop').hidden = true; });
$('#fillholes').addEventListener('click', fillHoles);
$('#fb').addEventListener('click', () => { const p = $('#fbpop'); p.hidden = !p.hidden; $('#rpop').hidden = true; syncBlocks(); });
$('#fbsens').addEventListener('input', (e) => { fb.sens = +e.target.value; syncBlocks(); });
$('#fbkind').addEventListener('change', (e) => { fb.kind = e.target.value; syncBlocks(); });
$('#fbgrow').addEventListener('input', (e) => { fb.grow = +e.target.value; syncBlocks(); });
$('#fbwithin').addEventListener('change', (e) => { fb.within = e.target.checked; syncBlocks(); });
$('#fbsig').addEventListener('input', (e) => { fb.sigma = +e.target.value; syncBlocks(); });
$('#fbsrc').addEventListener('change', (e) => { fillSrc = e.target.value; $('#fsrc').value = fillSrc; });
$('#fbfind').addEventListener('click', findBlocks);
$('#fbsmooth').addEventListener('click', smoothSel);
$('#fbrep').addEventListener('click', repairSel);
$('#fbrepk').addEventListener('input', (e) => { fb.rep = +e.target.value; syncBlocks(); });
$('#fbfill').addEventListener('click', fillSel);
$('#fbdel').addEventListener('click', del);
$('#fbrnd').addEventListener('click', () => { $('#fbpop').hidden = true; $('#rpop').hidden = false; syncRandom(); });
document.addEventListener('pointerdown', (e) => { if (!$('#fbpop').hidden && !e.target.closest('#fbpop, #fb')) $('#fbpop').hidden = true; });

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
syncX(); renderSwatches(); syncRandom(); resize(); sync();
