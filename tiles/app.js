/* app.js — UI for Tile Signal. DOM + canvas only; math is in pipeline.js
 * (window.Pipeline) and signal.js (window.Signal). Nothing is uploaded.
 *
 * Live editing runs on a capped PREVIEW copy so it stays responsive; the full
 * working resolution is processed only on export. SSIM (the expensive metric)
 * runs on the preview, debounced; the exact delivered SSIM is measured on the
 * re-decoded JPEG. A Diff view shows the change amplified, since the transforms
 * are meant to be near-invisible. */
(function () {
  'use strict';
  var P = window.Pipeline, Sg = window.Signal;
  if (!P || !Sg) { alert('pipeline.js / signal.js failed to load'); return; }

  var MAX_WORK = 3000;   // full working/export resolution cap (longest side)
  var PREVIEW = 900;     // live-edit resolution cap (longest side)

  var $ = function (id) { return document.getElementById(id); };
  var view = $('view'), overlay = $('overlay');
  var vctx = view.getContext('2d'), octx = overlay.getContext('2d');
  var viewport = $('viewport'), wrap = $('canvasWrap'), dropHint = $('dropHint');

  var S = {
    loaded: false,
    // full working res (for export)
    W: 0, H: 0, rgba: null, Yorig: null, Cb: null, Cr: null,
    // preview res (for live display + metrics)
    pW: 0, pH: 0, prgba: null, pYorig: null, pCb: null, pCr: null,
    pA: null, pB: null, pYout: null,
    scale: 1, showGrid: false, diff: 0,
  };

  var ctrl = {
    gx: 8, gy: 6, fieldMode: 'random', seed: 1234,
    warpOn: true, warpX: 1, warpY: 1,
    dctOn: false, dctAmt: 6, bandLo: 4, bandHi: 10,
    noiseOn: false, noiseAmt: 0.012,
  };

  function decodeTo(img, cap) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    var sc = Math.min(1, cap / Math.max(w, h));
    var W = Math.max(1, Math.round(w * sc)), H = Math.max(1, Math.round(h * sc));
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var cx = c.getContext('2d'); cx.drawImage(img, 0, 0, W, H);
    return { W: W, H: H, rgba: cx.getImageData(0, 0, W, H).data, capped: sc < 1 };
  }

  function loadFromImage(img) {
    var full = decodeTo(img, MAX_WORK);
    S.W = full.W; S.H = full.H; S.rgba = full.rgba;
    var fy = P.rgbaToYCbCr(S.rgba, S.W, S.H);
    S.Yorig = fy.Y; S.Cb = fy.Cb; S.Cr = fy.Cr;

    var prev = decodeTo(img, PREVIEW);
    S.pW = prev.W; S.pH = prev.H; S.prgba = prev.rgba;
    var py = P.rgbaToYCbCr(S.prgba, S.pW, S.pH);
    S.pYorig = py.Y; S.pCb = py.Cb; S.pCr = py.Cr;
    var pn = S.pW * S.pH;
    S.pA = new Float32Array(pn); S.pB = new Float32Array(pn); S.pYout = null;

    view.width = S.pW; view.height = S.pH; overlay.width = S.pW; overlay.height = S.pH;
    S.loaded = true; dropHint.classList.add('hidden');
    $('dims').textContent = S.W + ' × ' + S.H + (full.capped ? ' (capped)' : '') +
      ' px · preview ' + S.pW + '×' + S.pH;
    fitToWindow(); render();
  }

  // apply enabled transforms in order on the given luma buffers; returns
  // {Yout, sig}. src must not be overwritten. bufs = [A,B] scratch.
  function runPipeline(W, H, Yorig, bufs, seed) {
    var strength = (ctrl.dctOn || ctrl.noiseOn)
      ? Sg.smoothField(ctrl.gx, ctrl.gy, W, H, seed, ctrl.fieldMode === 'uniform', 'unit') : null;
    var src = Yorig, bi = 0, sig = { warp: null, dct: null, noise: null };
    function step(fn) { var dst = bufs[bi % 2]; fn(src, dst); src = dst; bi++; }
    if (ctrl.warpOn) {
      var fx = Sg.smoothField(ctrl.gx, ctrl.gy, W, H, seed + 101, ctrl.fieldMode === 'uniform', 'signed');
      var fy = Sg.smoothField(ctrl.gx, ctrl.gy, W, H, seed + 202, ctrl.fieldMode === 'uniform', 'signed');
      step(function (s, d) { sig.warp = Sg.warp(s, W, H, d, { ampX: ctrl.warpX, ampY: ctrl.warpY, fieldX: fx, fieldY: fy }); });
    }
    if (ctrl.dctOn) step(function (s, d) { sig.dct = Sg.dctBand(s, W, H, d, { amount: ctrl.dctAmt, bandLo: ctrl.bandLo, bandHi: ctrl.bandHi, seed: seed + 303, strength: strength }); });
    if (ctrl.noiseOn) step(function (s, d) { sig.noise = Sg.noise(s, W, H, d, { amount: ctrl.noiseAmt, seed: seed + 404, strength: strength }); });
    return { Yout: src, sig: sig };
  }

  var rafPending = false;
  function scheduleRender() { if (rafPending) return; rafPending = true; requestAnimationFrame(function () { rafPending = false; render(); }); }

  function render() {
    if (!S.loaded) return;
    var t0 = performance.now();
    var W = S.pW, H = S.pH, n = W * H;
    var res = runPipeline(W, H, S.pYorig, [S.pA, S.pB], ctrl.seed);
    S.pYout = res.Yout;
    var sig = res.sig;

    if (S.diff > 0) {
      // amplified luma difference, grayscale
      var g = new Uint8ClampedArray(n * 4);
      for (var i = 0, p = 0; i < n; i++, p += 4) {
        var v = 128 + (S.pYout[i] - S.pYorig[i]) * S.diff;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        g[p] = g[p + 1] = g[p + 2] = v; g[p + 3] = 255;
      }
      vctx.putImageData(new ImageData(g, W, H), 0, 0);
    } else {
      vctx.putImageData(new ImageData(P.yCbCrToRgba(S.pYout, S.pCb, S.pCr, W, H, S.prgba), W, H), 0, 0);
    }
    drawOverlay();

    var st = P.lumaStats(S.pYorig, S.pYout, n);
    $('mPsnr').textContent = isFinite(st.psnr) ? st.psnr.toFixed(2) + ' dB' : '∞';
    $('mMean').textContent = st.meanAbs.toFixed(2);
    $('mMax').textContent = st.maxAbs.toFixed(1);
    $('mDct').textContent = sig.dct ? sig.dct.meanAbsDeltaCoef.toFixed(2) : '—';
    $('mWarp').textContent = sig.warp ? sig.warp.meanDisp.toFixed(3) : '—';
    $('mNoise').textContent = sig.noise ? sig.noise.residualStd.toFixed(3) : '—';
    $('mDelivered').textContent = '—';

    var anyMod = ctrl.warpOn || ctrl.dctOn || ctrl.noiseOn;
    if (anyMod) {
      var hd = Sg.hashDistances(S.pYorig, S.pYout, W, H);
      setHash('mPhash', hd.p, 12);
      $('mAhash').textContent = hd.a; $('mDhash').textContent = hd.d;
    } else {
      $('mPhash').textContent = '0'; $('mPhash').style.color = 'var(--ink-dim)';
      $('mAhash').textContent = '0'; $('mDhash').textContent = '0';
    }

    scheduleSSIM(anyMod);
    $('procTime').textContent = (performance.now() - t0).toFixed(0) + ' ms';
  }

  function setHash(id, v, thresh) {
    var el = $(id);
    el.textContent = v;
    el.style.color = v >= thresh ? 'var(--ok)' : v > 0 ? '#fff' : 'var(--warn)';
  }

  var ssimTimer = null;
  function scheduleSSIM(anyMod) {
    $('mSsim').textContent = '…';
    if (ssimTimer) clearTimeout(ssimTimer);
    ssimTimer = setTimeout(function () {
      if (!anyMod) { $('mSsim').textContent = '1.0000'; $('mSsim').style.color = 'var(--ok)'; return; }
      var r = P.ssim(S.pYorig, S.pYout, S.pW, S.pH);
      $('mSsim').textContent = '≈ ' + r.mssim.toFixed(4);
      $('mSsim').style.color = r.mssim >= 0.97 ? 'var(--ok)' : r.mssim >= 0.9 ? '#fff' : 'var(--warn)';
    }, 140);
  }

  function drawOverlay() {
    octx.clearRect(0, 0, S.pW, S.pH);
    if (!S.showGrid) return;
    octx.lineWidth = Math.max(1, 1 / S.scale);
    octx.strokeStyle = 'rgba(76,139,245,0.55)';
    octx.beginPath();
    for (var c = 1; c < ctrl.gx; c++) { var x = Math.round(c * S.pW / ctrl.gx) + 0.5; octx.moveTo(x, 0); octx.lineTo(x, S.pH); }
    for (var r = 1; r < ctrl.gy; r++) { var y = Math.round(r * S.pH / ctrl.gy) + 0.5; octx.moveTo(0, y); octx.lineTo(S.pW, y); }
    octx.stroke();
  }

  function applyScale() {
    wrap.style.width = view.style.width = overlay.style.width = (S.pW * S.scale) + 'px';
    wrap.style.height = view.style.height = overlay.style.height = (S.pH * S.scale) + 'px';
    $('zoomReadout').textContent = Math.round(S.scale * 100) + '%';
  }
  function fitToWindow() {
    var vw = viewport.clientWidth - 32, vh = viewport.clientHeight - 32;
    S.scale = Math.min(vw / S.pW, vh / S.pH, 2);
    if (!isFinite(S.scale) || S.scale <= 0) S.scale = 1;
    applyScale();
  }
  function zoomBy(f) { S.scale = Math.min(8, Math.max(0.05, S.scale * f)); applyScale(); }

  // ---- export: full working resolution, one-time ----
  function exportJpg() {
    if (!S.loaded) return;
    $('exportBtn').textContent = 'Processing…';
    setTimeout(function () {
      var W = S.W, H = S.H, n = W * H;
      var res = runPipeline(W, H, S.Yorig, [new Float32Array(n), new Float32Array(n)], ctrl.seed);
      var out = P.yCbCrToRgba(res.Yout, S.Cb, S.Cr, W, H, S.rgba);
      var c = document.createElement('canvas'); c.width = W; c.height = H;
      c.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
      var q = (+$('quality').value) / 100;
      c.toBlob(function (blob) {
        $('exportBtn').textContent = 'Export JPG';
        if (!blob) { alert('Export failed'); return; }
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = 'tile-signal-' + Date.now() + '.jpg';
        document.body.appendChild(a); a.click(); a.remove();
        var im = new Image();
        im.onload = function () {
          var cc = document.createElement('canvas'); cc.width = W; cc.height = H;
          var cx = cc.getContext('2d'); cx.drawImage(im, 0, 0);
          var yj = P.rgbaToYCbCr(cx.getImageData(0, 0, W, H).data, W, H).Y;
          var dsm = P.ssim(S.Yorig, yj, W, H).mssim;
          var dhd = Sg.hashDistances(S.Yorig, yj, W, H);
          $('mDelivered').textContent = dsm.toFixed(3) + ' · Δ' + dhd.p;
          URL.revokeObjectURL(url);
        };
        im.src = url;
      }, 'image/jpeg', q);
    }, 20);
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
    var g = P.piecesToGrid(parseInt($('pieces').value, 10) || 1, S.pW || 16, S.pH || 9);
    ctrl.gx = Math.min(64, g.cols); ctrl.gy = Math.min(64, g.rows);
    $('gridX').value = ctrl.gx; $('gridXv').textContent = ctrl.gx;
    $('gridY').value = ctrl.gy; $('gridYv').textContent = ctrl.gy;
    scheduleRender();
  });
  $('gridBtn').addEventListener('click', function () { S.showGrid = !S.showGrid; this.classList.toggle('on', S.showGrid); drawOverlay(); });
  var diffLevels = [0, 8, 16, 32];
  $('diffBtn').addEventListener('click', function () {
    var i = (diffLevels.indexOf(S.diff) + 1) % diffLevels.length;
    S.diff = diffLevels[i];
    this.textContent = S.diff ? 'Diff: ×' + S.diff : 'Diff: off';
    this.classList.toggle('on', S.diff > 0);
    render();
  });
  $('fitBtn').addEventListener('click', fitToWindow);
  $('oneToOneBtn').addEventListener('click', function () { S.scale = 1; applyScale(); });
  $('exportBtn').addEventListener('click', exportJpg);

  var beforeBtn = $('beforeBtn');
  function showOriginal(on) { if (!S.loaded) return; if (on) vctx.putImageData(new ImageData(new Uint8ClampedArray(S.prgba), S.pW, S.pH), 0, 0); else render(); }
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
