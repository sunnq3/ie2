/* app.js — UI for Tile Signal. DOM + canvas only; math is in pipeline.js
 * (window.Pipeline) and signal.js (window.Signal). Nothing is uploaded. */
(function () {
  'use strict';
  var P = window.Pipeline, Sg = window.Signal;
  if (!P || !Sg) { alert('pipeline.js / signal.js failed to load'); return; }

  var MAX_WORK = 3000;
  var $ = function (id) { return document.getElementById(id); };
  var view = $('view'), overlay = $('overlay');
  var vctx = view.getContext('2d'), octx = overlay.getContext('2d');
  var viewport = $('viewport'), wrap = $('canvasWrap'), dropHint = $('dropHint');

  var S = {
    loaded: false, W: 0, H: 0, rgba: null,
    Yorig: null, Cb: null, Cr: null,
    bufA: null, bufB: null, Yout: null,
    scale: 1, showGrid: false,
  };

  var ctrl = {
    gx: 8, gy: 6, fieldMode: 'random', seed: 1234,
    warpOn: false, warpX: 0.8, warpY: 0.8,
    dctOn: true, dctAmt: 3, bandLo: 4, bandHi: 10,
    noiseOn: false, noiseAmt: 0.012,
  };

  // ---- load ----
  function loadFromImage(img) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    var sc = Math.min(1, MAX_WORK / Math.max(w, h));
    var W = Math.max(1, Math.round(w * sc)), H = Math.max(1, Math.round(h * sc));
    var src = document.createElement('canvas'); src.width = W; src.height = H;
    var sctx = src.getContext('2d'); sctx.drawImage(img, 0, 0, W, H);
    var id = sctx.getImageData(0, 0, W, H);
    S.W = W; S.H = H; S.rgba = id.data;
    var ycc = P.rgbaToYCbCr(S.rgba, W, H);
    S.Yorig = ycc.Y; S.Cb = ycc.Cb; S.Cr = ycc.Cr;
    S.bufA = new Float32Array(W * H); S.bufB = new Float32Array(W * H);
    view.width = W; view.height = H; overlay.width = W; overlay.height = H;
    S.loaded = true; dropHint.classList.add('hidden');
    $('dims').textContent = W + ' × ' + H + (sc < 1 ? ' (capped)' : '') + ' px';
    fitToWindow(); render();
  }

  // ---- core render: apply enabled transforms in order ----
  var rafPending = false;
  function scheduleRender() { if (rafPending) return; rafPending = true; requestAnimationFrame(function () { rafPending = false; render(); }); }

  var sig = { dct: null, warp: null, noise: null };

  function render() {
    if (!S.loaded) return;
    var t0 = performance.now();
    var W = S.W, H = S.H, n = W * H;

    var anyMod = ctrl.warpOn || ctrl.dctOn || ctrl.noiseOn;
    // strength field (unit) shared by dct + noise modulation
    var strength = null;
    if (ctrl.dctOn || ctrl.noiseOn) strength = Sg.smoothField(ctrl.gx, ctrl.gy, W, H, ctrl.seed, ctrl.fieldMode === 'uniform', 'unit');

    // ping-pong buffers; src starts at the original (never overwritten)
    var src = S.Yorig, bufs = [S.bufA, S.bufB], bi = 0;
    function step(fn) { var dst = bufs[bi % 2]; fn(src, dst); src = dst; bi++; }

    sig.warp = sig.dct = sig.noise = null;

    if (ctrl.warpOn) {
      var fx = Sg.smoothField(ctrl.gx, ctrl.gy, W, H, ctrl.seed + 101, ctrl.fieldMode === 'uniform', 'signed');
      var fy = Sg.smoothField(ctrl.gx, ctrl.gy, W, H, ctrl.seed + 202, ctrl.fieldMode === 'uniform', 'signed');
      step(function (s, d) { sig.warp = Sg.warp(s, W, H, d, { ampX: ctrl.warpX, ampY: ctrl.warpY, fieldX: fx, fieldY: fy }); });
    }
    if (ctrl.dctOn) {
      step(function (s, d) { sig.dct = Sg.dctBand(s, W, H, d, { amount: ctrl.dctAmt, bandLo: ctrl.bandLo, bandHi: ctrl.bandHi, seed: ctrl.seed + 303, strength: strength }); });
    }
    if (ctrl.noiseOn) {
      step(function (s, d) { sig.noise = Sg.noise(s, W, H, d, { amount: ctrl.noiseAmt, seed: ctrl.seed + 404, strength: strength }); });
    }

    S.Yout = src; // final (= Yorig if nothing enabled)
    var out = P.yCbCrToRgba(S.Yout, S.Cb, S.Cr, W, H, S.rgba);
    vctx.putImageData(new ImageData(out, W, H), 0, 0);
    drawOverlay();

    // cheap exact readouts
    var st = P.lumaStats(S.Yorig, S.Yout, n);
    $('mPsnr').textContent = isFinite(st.psnr) ? st.psnr.toFixed(2) + ' dB' : '∞';
    $('mMean').textContent = st.meanAbs.toFixed(2);
    $('mMax').textContent = st.maxAbs.toFixed(1);
    $('mDct').textContent = sig.dct ? sig.dct.meanAbsDeltaCoef.toFixed(2) : '—';
    $('mWarp').textContent = sig.warp ? sig.warp.meanDisp.toFixed(3) : '—';
    $('mNoise').textContent = sig.noise ? sig.noise.residualStd.toFixed(3) : '—';
    $('mDelivered').textContent = '—';

    scheduleExactSSIM(anyMod);
    $('procTime').textContent = (performance.now() - t0).toFixed(0) + ' ms';
  }

  var exactTimer = null;
  function scheduleExactSSIM(anyMod) {
    $('mSsim').textContent = '…';
    if (exactTimer) clearTimeout(exactTimer);
    exactTimer = setTimeout(function () {
      if (!anyMod) { $('mSsim').textContent = '1.0000'; $('mSsim').style.color = 'var(--ok)'; return; }
      var r = P.ssim(S.Yorig, S.Yout, S.W, S.H);
      $('mSsim').textContent = r.mssim.toFixed(4);
      $('mSsim').style.color = r.mssim >= 0.97 ? 'var(--ok)' : r.mssim >= 0.9 ? '#fff' : 'var(--warn)';
    }, 150);
  }

  function drawOverlay() {
    octx.clearRect(0, 0, S.W, S.H);
    if (!S.showGrid) return;
    octx.lineWidth = Math.max(1, 1 / S.scale);
    octx.strokeStyle = 'rgba(76,139,245,0.55)';
    octx.beginPath();
    for (var c = 1; c < ctrl.gx; c++) { var x = Math.round(c * S.W / ctrl.gx) + 0.5; octx.moveTo(x, 0); octx.lineTo(x, S.H); }
    for (var r = 1; r < ctrl.gy; r++) { var y = Math.round(r * S.H / ctrl.gy) + 0.5; octx.moveTo(0, y); octx.lineTo(S.W, y); }
    octx.stroke();
  }

  // ---- zoom ----
  function applyScale() {
    wrap.style.width = view.style.width = overlay.style.width = (S.W * S.scale) + 'px';
    wrap.style.height = view.style.height = overlay.style.height = (S.H * S.scale) + 'px';
    $('zoomReadout').textContent = Math.round(S.scale * 100) + '%';
  }
  function fitToWindow() {
    var vw = viewport.clientWidth - 32, vh = viewport.clientHeight - 32;
    S.scale = Math.min(vw / S.W, vh / S.H, 1);
    if (!isFinite(S.scale) || S.scale <= 0) S.scale = 1;
    applyScale();
  }
  function zoomBy(f) { S.scale = Math.min(8, Math.max(0.05, S.scale * f)); applyScale(); }

  // ---- export + delivered SSIM ----
  function exportJpg() {
    if (!S.loaded) return;
    var q = (+$('quality').value) / 100;
    view.toBlob(function (blob) {
      if (!blob) { alert('Export failed'); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = 'tile-signal-' + Date.now() + '.jpg';
      document.body.appendChild(a); a.click(); a.remove();
      var im = new Image();
      im.onload = function () {
        var c = document.createElement('canvas'); c.width = S.W; c.height = S.H;
        var cx = c.getContext('2d'); cx.drawImage(im, 0, 0);
        var d = cx.getImageData(0, 0, S.W, S.H).data;
        var yj = P.rgbaToYCbCr(d, S.W, S.H).Y;
        $('mDelivered').textContent = P.ssim(S.Yorig, yj, S.W, S.H).mssim.toFixed(4);
        URL.revokeObjectURL(url);
      };
      im.src = url;
    }, 'image/jpeg', q);
  }

  // ---- wiring ----
  function bindRange(id, outId, key, fmt, isInt) {
    var el = $(id), out = $(outId);
    el.addEventListener('input', function () {
      ctrl[key] = isInt ? parseInt(el.value, 10) : parseFloat(el.value);
      if (out) out.textContent = fmt ? fmt(ctrl[key]) : ctrl[key];
      scheduleRender();
    });
  }
  bindRange('gridX', 'gridXv', 'gx', null, true);
  bindRange('gridY', 'gridYv', 'gy', null, true);
  bindRange('warpX', 'warpXv', 'warpX', function (v) { return v.toFixed(2); });
  bindRange('warpY', 'warpYv', 'warpY', function (v) { return v.toFixed(2); });
  bindRange('dctAmt', 'dctAmtv', 'dctAmt', function (v) { return v.toFixed(1); });
  bindRange('bandLo', 'bandLov', 'bandLo', null, true);
  bindRange('bandHi', 'bandHiv', 'bandHi', null, true);
  bindRange('noiseAmt', 'noiseAmtv', 'noiseAmt', function (v) { return v.toFixed(3); });

  function bindToggle(id, key) { $(id).addEventListener('change', function () { ctrl[key] = this.checked; scheduleRender(); }); }
  bindToggle('warpOn', 'warpOn'); bindToggle('dctOn', 'dctOn'); bindToggle('noiseOn', 'noiseOn');

  $('fieldMode').addEventListener('change', function () { ctrl.fieldMode = this.value; scheduleRender(); });
  $('seed').addEventListener('input', function () { ctrl.seed = parseInt(this.value, 10) || 0; scheduleRender(); });
  $('reseed').addEventListener('click', function () { ctrl.seed = (Math.random() * 1e6) | 0; $('seed').value = ctrl.seed; scheduleRender(); });
  $('quality').addEventListener('input', function () { $('qVal').textContent = this.value; });
  $('piecesApply').addEventListener('click', function () {
    var g = P.piecesToGrid(parseInt($('pieces').value, 10) || 1, S.W || 16, S.H || 9);
    ctrl.gx = Math.min(64, g.cols); ctrl.gy = Math.min(64, g.rows);
    $('gridX').value = ctrl.gx; $('gridXv').textContent = ctrl.gx;
    $('gridY').value = ctrl.gy; $('gridYv').textContent = ctrl.gy;
    scheduleRender();
  });
  $('gridBtn').addEventListener('click', function () { S.showGrid = !S.showGrid; this.classList.toggle('on', S.showGrid); drawOverlay(); });
  $('fitBtn').addEventListener('click', fitToWindow);
  $('oneToOneBtn').addEventListener('click', function () { S.scale = 1; applyScale(); });
  $('exportBtn').addEventListener('click', exportJpg);

  var beforeBtn = $('beforeBtn');
  function showOriginal(on) { if (!S.loaded) return; if (on) vctx.putImageData(new ImageData(new Uint8ClampedArray(S.rgba), S.W, S.H), 0, 0); else render(); }
  beforeBtn.addEventListener('mousedown', function () { showOriginal(true); });
  beforeBtn.addEventListener('mouseup', function () { showOriginal(false); });
  beforeBtn.addEventListener('mouseleave', function () { showOriginal(false); });

  document.querySelectorAll('.tool').forEach(function (b) {
    b.addEventListener('click', function () { var t = b.dataset.tool; if (t === 'zoomin') zoomBy(1.25); else if (t === 'zoomout') zoomBy(0.8); });
  });
  viewport.addEventListener('wheel', function (e) { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 0.9); }, { passive: false });

  function handleFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () { loadFromImage(img); URL.revokeObjectURL(url); };
    img.onerror = function () { alert('Could not decode that image.'); URL.revokeObjectURL(url); };
    img.src = url;
  }
  $('openBtn').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function (e) { if (e.target.files[0]) handleFile(e.target.files[0]); });
  ['dragenter', 'dragover'].forEach(function (ev) { viewport.addEventListener(ev, function (e) { e.preventDefault(); view.classList.add('dragover'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { viewport.addEventListener(ev, function (e) { e.preventDefault(); view.classList.remove('dragover'); }); });
  viewport.addEventListener('drop', function (e) { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  window.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items; if (!items) return;
    for (var i = 0; i < items.length; i++) if (/^image\//.test(items[i].type)) { handleFile(items[i].getAsFile()); break; }
  });
  window.addEventListener('resize', function () { if (S.loaded) fitToWindow(); });

  $('qVal').textContent = $('quality').value;
})();
