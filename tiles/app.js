/* app.js — UI controller for Tile Luma. DOM + canvas only; all math is in
 * pipeline.js (window.Pipeline). Nothing is uploaded; everything runs here. */
(function () {
  'use strict';
  var P = window.Pipeline;
  if (!P) { alert('pipeline.js failed to load'); return; }

  var MAX_WORK = 3000;   // cap longest side of the working image (memory)
  var PROXY = 480;       // longest side for the live (drag) SSIM estimate

  // ----- element refs -----
  var $ = function (id) { return document.getElementById(id); };
  var view = $('view'), overlay = $('overlay');
  var vctx = view.getContext('2d'), octx = overlay.getContext('2d');
  var viewport = $('viewport'), wrap = $('canvasWrap'), dropHint = $('dropHint');

  // ----- state -----
  var S = {
    loaded: false,
    W: 0, H: 0,
    rgba: null,            // Uint8ClampedArray source pixels
    Yorig: null, Cb: null, Cr: null,
    Yout: null, gField: null, bField: null,
    // proxy
    pW: 0, pH: 0, YorigP: null, gFieldP: null, bFieldP: null, YoutP: null,
    scale: 1,
    showGrid: false,
  };

  var ctrl = {
    gx: 8, gy: 6, blend: 'smooth',
    gain: 0.08, offset: 8, mode: 'random', seed: 1234,
  };

  // ============================================================= load image
  function loadFromImage(img) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    var scale = Math.min(1, MAX_WORK / Math.max(w, h));
    var W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));
    var src = document.createElement('canvas'); src.width = W; src.height = H;
    var sctx = src.getContext('2d');
    sctx.drawImage(img, 0, 0, W, H);
    var id = sctx.getImageData(0, 0, W, H);

    S.W = W; S.H = H; S.rgba = id.data;
    var ycc = P.rgbaToYCbCr(S.rgba, W, H);
    S.Yorig = ycc.Y; S.Cb = ycc.Cb; S.Cr = ycc.Cr;
    S.Yout = new Float32Array(W * H);
    S.gField = new Float32Array(W * H);
    S.bField = new Float32Array(W * H);

    // proxy luma (box-average downscale of original Y)
    buildProxy();

    view.width = W; view.height = H;
    overlay.width = W; overlay.height = H;
    S.loaded = true;
    dropHint.classList.add('hidden');
    $('dims').textContent = W + ' × ' + H + (scale < 1 ? ' (capped)' : '') + ' px';
    fitToWindow();
    render();
  }

  function buildProxy() {
    var W = S.W, H = S.H;
    var s = Math.min(1, PROXY / Math.max(W, H));
    var pW = Math.max(1, Math.round(W * s)), pH = Math.max(1, Math.round(H * s));
    S.pW = pW; S.pH = pH;
    S.YorigP = new Float32Array(pW * pH);
    S.gFieldP = new Float32Array(pW * pH);
    S.bFieldP = new Float32Array(pW * pH);
    S.YoutP = new Float32Array(pW * pH);
    // area-average box downscale
    for (var py = 0; py < pH; py++) {
      var y0 = Math.floor(py * H / pH), y1 = Math.max(y0 + 1, Math.floor((py + 1) * H / pH));
      for (var px = 0; px < pW; px++) {
        var x0 = Math.floor(px * W / pW), x1 = Math.max(x0 + 1, Math.floor((px + 1) * W / pW));
        var acc = 0, cnt = 0;
        for (var y = y0; y < y1; y++) { var rb = y * W; for (var x = x0; x < x1; x++) { acc += S.Yorig[rb + x]; cnt++; } }
        S.YorigP[py * pW + px] = acc / cnt;
      }
    }
  }

  // ============================================================= core render
  var rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; render(); });
  }

  function render() {
    if (!S.loaded) return;
    var t0 = performance.now();
    var W = S.W, H = S.H;
    var grid = P.buildControlGrid(ctrl.gx, ctrl.gy, {
      seed: ctrl.seed,
      gainJitter: ctrl.gain,
      offsetJitter: ctrl.offset,
      uniform: ctrl.mode === 'uniform',
      baseGain: 1, baseOffset: 0,
    });
    P.interpolateField(grid, W, H, ctrl.blend, S.gField, S.bField);
    P.applyLumaEdit(S.Yorig, S.gField, S.bField, W, H, S.Yout, 128);
    var out = P.yCbCrToRgba(S.Yout, S.Cb, S.Cr, W, H, S.rgba);
    vctx.putImageData(new ImageData(out, W, H), 0, 0);

    drawOverlay(grid);

    // cheap exact metrics every frame
    var st = P.lumaStats(S.Yorig, S.Yout, W * H);
    $('mPsnr').textContent = isFinite(st.psnr) ? st.psnr.toFixed(2) + ' dB' : '∞';
    $('mMean').textContent = st.meanAbs.toFixed(2);
    $('mMax').textContent = st.maxAbs.toFixed(1);
    $('mDelivered').textContent = '—'; // stale until next export

    // live (proxy) SSIM immediately, exact full-res SSIM when settled
    liveSSIM(grid);
    scheduleExactSSIM();

    $('procTime').textContent = (performance.now() - t0).toFixed(0) + ' ms';
  }

  function liveSSIM(grid) {
    var pW = S.pW, pH = S.pH;
    P.interpolateField(grid, pW, pH, ctrl.blend, S.gFieldP, S.bFieldP);
    P.applyLumaEdit(S.YorigP, S.gFieldP, S.bFieldP, pW, pH, S.YoutP, 128);
    var r = P.ssim(S.YorigP, S.YoutP, pW, pH);
    $('mSsim').textContent = '≈ ' + r.mssim.toFixed(4);
    $('mSsim').style.color = r.mssim >= 0.97 ? 'var(--ok)' : r.mssim >= 0.9 ? '#fff' : 'var(--warn)';
  }

  var exactTimer = null;
  function scheduleExactSSIM() {
    if (exactTimer) clearTimeout(exactTimer);
    exactTimer = setTimeout(function () {
      var r = P.ssim(S.Yorig, S.Yout, S.W, S.H);
      $('mSsim').textContent = r.mssim.toFixed(4);
      $('mSsim').style.color = r.mssim >= 0.97 ? 'var(--ok)' : r.mssim >= 0.9 ? '#fff' : 'var(--warn)';
    }, 170);
  }

  // ============================================================= overlay grid
  function drawOverlay(grid) {
    octx.clearRect(0, 0, S.W, S.H);
    if (!S.showGrid) return;
    octx.lineWidth = Math.max(1, 1 / S.scale);
    octx.strokeStyle = 'rgba(76,139,245,0.55)';
    octx.beginPath();
    for (var c = 1; c < ctrl.gx; c++) { var x = Math.round(c * S.W / ctrl.gx) + 0.5; octx.moveTo(x, 0); octx.lineTo(x, S.H); }
    for (var r = 1; r < ctrl.gy; r++) { var y = Math.round(r * S.H / ctrl.gy) + 0.5; octx.moveTo(0, y); octx.lineTo(S.W, y); }
    octx.stroke();
  }

  // ============================================================= zoom / pan
  function applyScale() {
    wrap.style.width = (S.W * S.scale) + 'px';
    wrap.style.height = (S.H * S.scale) + 'px';
    view.style.width = overlay.style.width = (S.W * S.scale) + 'px';
    view.style.height = overlay.style.height = (S.H * S.scale) + 'px';
    $('zoomReadout').textContent = Math.round(S.scale * 100) + '%';
  }
  function fitToWindow() {
    var vw = viewport.clientWidth - 32, vh = viewport.clientHeight - 32;
    S.scale = Math.min(vw / S.W, vh / S.H, 1);
    if (!isFinite(S.scale) || S.scale <= 0) S.scale = 1;
    applyScale();
  }
  function zoomBy(f) { S.scale = Math.min(8, Math.max(0.05, S.scale * f)); applyScale(); }

  // ============================================================= export
  function exportJpg() {
    if (!S.loaded) return;
    var q = (+$('quality').value) / 100;
    view.toBlob(function (blob) {
      if (!blob) { alert('Export failed'); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'tile-luma-' + Date.now() + '.jpg';
      document.body.appendChild(a); a.click(); a.remove();
      // delivered SSIM: re-decode the actual JPEG and measure against the original
      var im = new Image();
      im.onload = function () {
        var c = document.createElement('canvas'); c.width = S.W; c.height = S.H;
        var cx = c.getContext('2d'); cx.drawImage(im, 0, 0);
        var d = cx.getImageData(0, 0, S.W, S.H).data;
        var yj = P.rgbaToYCbCr(d, S.W, S.H).Y;
        var r = P.ssim(S.Yorig, yj, S.W, S.H);
        $('mDelivered').textContent = r.mssim.toFixed(4);
        URL.revokeObjectURL(url);
      };
      im.src = url;
    }, 'image/jpeg', q);
  }

  // ============================================================= wiring
  function syncPieces() {
    $('gridXv').value = ctrl.gx; $('gridYv').value = ctrl.gy;
    $('gridX').value = ctrl.gx; $('gridY').value = ctrl.gy;
  }

  function bindRange(id, outId, key, fmt, isInt) {
    var el = $(id), out = $(outId);
    el.addEventListener('input', function () {
      ctrl[key] = isInt ? parseInt(el.value, 10) : parseFloat(el.value);
      if (out) out.textContent = fmt ? fmt(ctrl[key]) : ctrl[key];
      scheduleRender();
    });
  }
  bindRange('gain', 'gainv', 'gain', function (v) { return v.toFixed(3); });
  bindRange('offset', 'offsetv', 'offset', function (v) { return v.toFixed(1); });
  bindRange('gridX', 'gridXv', 'gx', null, true);
  bindRange('gridY', 'gridYv', 'gy', null, true);

  $('blend').addEventListener('change', function () { ctrl.blend = this.value; scheduleRender(); });
  $('mode').addEventListener('change', function () { ctrl.mode = this.value; scheduleRender(); });
  $('seed').addEventListener('input', function () { ctrl.seed = parseInt(this.value, 10) || 0; scheduleRender(); });
  $('reseed').addEventListener('click', function () {
    ctrl.seed = (Math.random() * 1e6) | 0; $('seed').value = ctrl.seed; scheduleRender();
  });
  $('quality').addEventListener('input', function () { $('qVal').textContent = this.value; });

  $('piecesApply').addEventListener('click', function () {
    var n = parseInt($('pieces').value, 10) || 1;
    var g = P.piecesToGrid(n, S.W || 16, S.H || 9);
    ctrl.gx = Math.min(64, g.cols); ctrl.gy = Math.min(64, g.rows);
    syncPieces(); scheduleRender();
  });

  $('gridBtn').addEventListener('click', function () {
    S.showGrid = !S.showGrid; this.classList.toggle('on', S.showGrid); render();
  });
  $('fitBtn').addEventListener('click', fitToWindow);
  $('oneToOneBtn').addEventListener('click', function () { S.scale = 1; applyScale(); });
  $('exportBtn').addEventListener('click', exportJpg);

  // before/after hold
  var beforeBtn = $('beforeBtn');
  function showOriginal(on) {
    if (!S.loaded) return;
    if (on) vctx.putImageData(new ImageData(new Uint8ClampedArray(S.rgba), S.W, S.H), 0, 0);
    else render();
  }
  beforeBtn.addEventListener('mousedown', function () { showOriginal(true); });
  beforeBtn.addEventListener('mouseup', function () { showOriginal(false); });
  beforeBtn.addEventListener('mouseleave', function () { showOriginal(false); });

  // tools (zoom)
  document.querySelectorAll('.tool').forEach(function (b) {
    b.addEventListener('click', function () {
      var t = b.dataset.tool;
      if (t === 'zoomin') zoomBy(1.25);
      else if (t === 'zoomout') zoomBy(0.8);
    });
  });
  viewport.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
  }, { passive: false });

  // ----- file input / drag-drop / paste -----
  function handleFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () { loadFromImage(img); URL.revokeObjectURL(url); };
    img.onerror = function () { alert('Could not decode that image.'); URL.revokeObjectURL(url); };
    img.src = url;
  }
  $('openBtn').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function (e) { if (e.target.files[0]) handleFile(e.target.files[0]); });

  ['dragenter', 'dragover'].forEach(function (ev) {
    viewport.addEventListener(ev, function (e) { e.preventDefault(); view.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    viewport.addEventListener(ev, function (e) { e.preventDefault(); view.classList.remove('dragover'); });
  });
  viewport.addEventListener('drop', function (e) {
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) if (/^image\//.test(items[i].type)) { handleFile(items[i].getAsFile()); break; }
  });

  window.addEventListener('resize', function () { if (S.loaded) fitToWindow(); });

  syncPieces();
  $('qVal').textContent = $('quality').value;
})();
