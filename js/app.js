/* ============================================================
 * app.js — 核心状态 + 照片流程：上传 → 抠图换底 → 规格调整 → 导出
 * 排版流程见 sheet.js，直接打印见 print.js，设置持久化见 settings.js。
 * ============================================================ */
'use strict';

window.App = (function () {

  /* ================= 全局状态 ================= */
  var State = {
    originalImg: null,
    sourceName: '',         // 原始文件名（去扩展名），用于导出命名
    workCanvas: null,
    maskCanvas: null,
    initialMask: null,      // 自动抠图初始蒙版（Brush.snapMask 快照）
    bg: '#FFFFFF',
    brushMode: 'restore',   // restore=修补 erase=擦除
    brushSize: 30,          // 显示像素（按比例换算工作图坐标）
    spec: window.SPECS[0],
    outW: 295,
    outH: 413,
    transform: null,        // {scale, tx, ty}  work → 输出画框
    matteView: null,        // 抠图步骤视图 {zoom, panX, panY}（zoom 相对适配比例）
    viewTf: null,           // 抠图视图合成变换 work → 画布 px（供笔刷坐标映射）
    fmt: 'png',
    quality: 0.92,
    undoStack: []
  };

  var $ = function (id) { return document.getElementById(id); };
  var cropperApi = null;
  var matteViewApi = null;
  var renderPending = false;
  var syncBrushRing = null; // 笔刷圆圈光标尺寸同步器（initMatte 中赋值）

  /* ================= 步骤切换 ================= */
  var STEP_ORDER = ['upload', 'matte', 'spec', 'export'];

  function showStep(name) {
    for (var i = 0; i < STEP_ORDER.length; i++) {
      var s = STEP_ORDER[i];
      $('step-' + s).classList.toggle('active', s === name);
      var chip = document.querySelector('.step[data-step="' + s + '"]');
      if (chip) {
        chip.classList.toggle('active', s === name);
        chip.classList.toggle('done', STEP_ORDER.indexOf(s) < STEP_ORDER.indexOf(name));
      }
    }
    if (name === 'spec') enterSpecStep();
    if (name === 'export') enterExportStep();
  }

  /* ================= 通用 UI ================= */
  var loadingEl = $('loading');
  function showLoading(text) {
    loadingEl.querySelector('span').textContent = text || '处理中…';
    loadingEl.hidden = false;
  }
  function hideLoading() { loadingEl.hidden = true; }

  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  function download(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 800);
  }

  /* ================= 步骤 1：上传 ================= */
  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) {
      toast('请选择图片文件（JPG/PNG）', true);
      return;
    }
    // 记录原始文件名（去扩展名），导出时沿用
    State.sourceName = (file.name || '').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || '证件照';
    showLoading('正在加载 AI 人像分割模型…');

    var imgPromise;
    if (window.createImageBitmap) {
      imgPromise = createImageBitmap(file, { imageOrientation: 'from-image' });
    } else {
      imgPromise = new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = reject;
        img.src = url;
      });
    }

    imgPromise.then(function (img) {
      State.originalImg = img;
      return window.Matting.segment(img, showLoading); // 分割进度实时显示在遮罩上
    }).then(function (r) {
      State.workCanvas = r.workCanvas;
      State.maskCanvas = r.maskCanvas;
      State.undoStack = [];
      State.initialMask = window.Brush.snapMask(State);
      State.bg = '#FFFFFF';
      State.matteView = { zoom: 1, panX: 0, panY: 0 }; // 新照片重置视图
      if (matteViewApi) matteViewApi.fit();
      syncBgSwatches();
      renderMatteView();
      hideLoading();
      showStep('matte');
    }).catch(function (err) {
      hideLoading();
      console.error(err);
      toast('处理失败：' + err.message, true);
    });
  }

  function initUpload() {
    var fileInput = $('file-input');
    var dropzone = $('dropzone');
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
      fileInput.value = '';
    });
    dropzone.addEventListener('click', function () { fileInput.click(); });
    ['dragover', 'dragenter'].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) {
        e.preventDefault();
        dropzone.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) {
        e.preventDefault();
        dropzone.classList.remove('drag');
      });
    });
    dropzone.addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });
    // 支持粘贴截图
    window.addEventListener('paste', function (e) {
      if (e.clipboardData && e.clipboardData.files && e.clipboardData.files[0]) {
        loadFile(e.clipboardData.files[0]);
      }
    });
  }

  /* ================= 步骤 2：抠图换底 ================= */
  function matteViewSize() {
    var work = State.workCanvas;
    var maxV = 900;
    var k = Math.min(1, maxV / Math.max(work.width, work.height));
    return { w: Math.round(work.width * k), h: Math.round(work.height * k) };
  }

  function renderMatteView() {
    if (!State.workCanvas) return;
    var canvas = $('matte-view');
    var size = matteViewSize();
    if (canvas.width !== size.w || canvas.height !== size.h) {
      canvas.width = size.w;
      canvas.height = size.h;
    }
    var mv = State.matteView || { zoom: 1, panX: 0, panY: 0 };
    var k = size.w / State.workCanvas.width;
    var tf = { scale: k * mv.zoom, tx: mv.panX, ty: mv.panY };
    State.viewTf = tf;
    var ctx = canvas.getContext('2d');
    window.Composer.compositeInto(
      ctx, size.w, size.h,
      Object.assign({}, State, { transform: tf })
    );
    // 缩放/平移后用虚线标出照片边界（视口外的区域与底色同色，需边界提示）
    if (mv.zoom > 1 || mv.panX || mv.panY) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(tf.tx + 0.5, tf.ty + 0.5,
        State.workCanvas.width * tf.scale - 1, State.workCanvas.height * tf.scale - 1);
      ctx.restore();
    }
  }

  function scheduleMatteRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(function () {
      renderPending = false;
      renderMatteView();
    });
  }

  /* 撤销快照只存单通道蒙版 alpha（1 字节/像素，蒙版本身只有白+alpha），
     并按像素总量限制层数：RGBA ImageData 每层 4 字节，1600×1600 下 12 层要吃 120MB */
  var UNDO_BUDGET = 16 * 1024 * 1024;

  function pushUndo(snap) {
    State.undoStack.push(snap || window.Brush.snapMask(State));
    var px = State.maskCanvas.width * State.maskCanvas.height;
    var max = Math.max(3, Math.min(12, Math.floor(UNDO_BUDGET / px)));
    while (State.undoStack.length > max) State.undoStack.shift();
  }

  function undoMask() {
    var snap = State.undoStack.pop();
    if (!snap) { toast('没有可撤销的操作'); return; }
    window.Brush.restoreMask(State, snap);
    renderMatteView();
  }

  function resetMask() {
    if (!State.initialMask) return;
    window.Brush.restoreMask(State, State.initialMask);
    State.undoStack = [];
    renderMatteView();
  }

  function initMatte() {
    // 笔刷
    window.Brush.attach($('matte-view'), State, {
      onStrokeStart: pushUndo,
      onChange: scheduleMatteRender,
      onStrokeEnd: function () { renderMatteView(); }
    });

    // 画布自由缩放/平移：滚轮锚点缩放、双指捏合、空格/中键拖动平移
    var panMode = false;
    matteViewApi = window.MatteView.attach($('matte-view'), State, {
      onChange: scheduleMatteRender,
      onZoom: function (pct) { $('mv-zoom-label').textContent = pct + '%'; },
      isActive: function () { return $('step-matte').classList.contains('active'); },
      onPanMode: function (on) { panMode = on; }
    });
    $('mv-zoom-in').addEventListener('click', function () { matteViewApi.zoomStep(1.25); });
    $('mv-zoom-out').addEventListener('click', function () { matteViewApi.zoomStep(1 / 1.25); });
    $('mv-zoom-fit').addEventListener('click', function () { matteViewApi.fit(); });

    // 笔刷圆圈光标（替代系统十字标）：跟随鼠标，直径 = 笔刷大小 × 2
    var ring = document.createElement('div');
    ring.id = 'brush-cursor';
    ring.hidden = true;
    document.body.appendChild(ring);
    syncBrushRing = function () {
      var d = Math.max(6, State.brushSize * 2);
      ring.style.width = d + 'px';
      ring.style.height = d + 'px';
    };
    var view = $('matte-view');
    view.addEventListener('mouseenter', function () {
      syncBrushRing();
      ring.hidden = panMode;
    });
    view.addEventListener('mouseleave', function () { ring.hidden = true; });
    view.addEventListener('mousemove', function (e) {
      ring.hidden = panMode; // 平移模式下隐藏笔刷圈
      // transform 移动不触发布局，配合 CSS will-change 保持拖动流畅
      ring.style.transform = 'translate3d(' + e.clientX + 'px,' + e.clientY + 'px,0) translate(-50%, -50%)';
    });

    // 工具切换
    var btns = document.querySelectorAll('#tool-group button');
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        State.brushMode = b.dataset.mode;
        btns.forEach(function (x) { x.classList.toggle('active', x === b); });
      });
    });

    $('brush-size').addEventListener('input', function () {
      State.brushSize = +this.value;
      $('brush-size-val').textContent = this.value + 'px';
      if (syncBrushRing) syncBrushRing();
    });

    $('btn-undo').addEventListener('click', undoMask);
    $('btn-reset-mask').addEventListener('click', resetMask);
    $('btn-resegment').addEventListener('click', function () {
      resetMask();
      toast('已重新应用自动抠图结果');
    });

    // 背景色
    document.querySelectorAll('.swatch').forEach(function (s) {
      s.addEventListener('click', function () {
        State.bg = s.dataset.color;
        syncBgSwatches();
        renderMatteView();
        window.App.settings.save();
      });
    });
    $('custom-bg').addEventListener('input', function () {
      State.bg = this.value;
      document.querySelectorAll('.swatch').forEach(function (x) { x.classList.remove('active'); });
      renderMatteView();
      window.App.settings.save();
    });

    $('btn-to-spec').addEventListener('click', function () { showStep('spec'); });
    $('btn-back-upload').addEventListener('click', function () { showStep('upload'); });

    // 键盘快捷键（仅抠图步骤生效）：Ctrl+Z 撤销、[ ] 调节笔刷大小
    document.addEventListener('keydown', function (e) {
      if (!$('step-matte').classList.contains('active')) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undoMask();
      } else if (e.key === '[' || e.key === ']') {
        var size = Math.min(120, Math.max(4, State.brushSize + (e.key === ']' ? 4 : -4)));
        State.brushSize = size;
        $('brush-size').value = size;
        $('brush-size-val').textContent = size + 'px';
        if (syncBrushRing) syncBrushRing();
        e.preventDefault();
      }
    });
  }

  function syncBgSwatches() {
    document.querySelectorAll('.swatch').forEach(function (s) {
      s.classList.toggle('active', s.dataset.color.toLowerCase() === State.bg.toLowerCase());
    });
  }

  /* ================= 步骤 3：规格与裁剪 ================= */
  function enterSpecStep() {
    if (!State.transform) {
      applySpec(); // 首次进入：初始化画框并智能对齐
    } else {
      renderCrop();
      renderGuides();
    }
    updateSpecInfo();
  }

  function buildSpecGrid() {
    var grid = $('spec-grid');
    window.SPECS.forEach(function (sp) {
      var card = document.createElement('div');
      card.className = 'spec-card' + (sp.id === State.spec.id ? ' active' : '');
      card.dataset.id = sp.id;
      // 微缩比例示意
      var ratio = sp.pxW / sp.pxH;
      var boxH = 44;
      var boxW = Math.round(boxH * ratio);
      card.innerHTML =
        '<div class="spec-shape" style="width:' + boxW + 'px;height:' + boxH + 'px"></div>' +
        '<div class="spec-name">' + sp.name + '</div>' +
        '<div class="spec-desc">' + sp.desc + ' · ' + sp.pxW + '×' + sp.pxH + '</div>';
      card.addEventListener('click', function () {
        State.spec = sp;
        document.querySelectorAll('.spec-card').forEach(function (c) {
          c.classList.toggle('active', c.dataset.id === sp.id);
        });
        applySpec();
        window.App.settings.save();
      });
      grid.appendChild(card);
    });
  }

  function applySpec() {
    State.outW = State.spec.pxW;
    State.outH = State.spec.pxH;
    var canvas = $('crop-view');
    var guides = $('crop-guides');
    canvas.width = State.outW;
    canvas.height = State.outH;
    guides.width = State.outW;
    guides.height = State.outH;
    window.Cropper.autoAlign(State); // 智能对齐：头顶/下巴参考线一次到位
    renderCrop();
    renderGuides();
    updateSpecInfo();
    syncZoomSlider();
  }

  function renderCrop() {
    var canvas = $('crop-view');
    if (canvas.width !== State.outW) { canvas.width = State.outW; canvas.height = State.outH; }
    window.Composer.compositeInto(canvas.getContext('2d'), State.outW, State.outH, State);
  }

  function renderGuides() {
    var g = $('crop-guides');
    var ctx = g.getContext('2d');
    var h = State.spec.head;
    ctx.clearRect(0, 0, g.width, g.height);

    function line(yFrac, color, label, dash) {
      var y = Math.round(g.height * yFrac) + 0.5;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      if (dash) ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(g.width, y);
      ctx.stroke();
      ctx.font = '11px sans-serif';
      ctx.fillStyle = color;
      ctx.fillText(label, 4, y - 3);
      ctx.restore();
    }
    line(h.top, 'rgba(255,90,90,0.95)', '头顶线', true);
    line(h.eye, 'rgba(80,190,255,0.95)', '眼线', false);
    line(h.chin, 'rgba(255,200,80,0.95)', '下巴线', true);
  }

  function updateSpecInfo() {
    var sp = State.spec;
    $('spec-info').textContent =
      sp.name + ' · ' + sp.mmW + '×' + sp.mmH + 'mm · ' +
      sp.pxW + '×' + sp.pxH + 'px · ' + sp.dpi + ' DPI';
  }

  function syncZoomSlider() {
    var work = State.workCanvas;
    var minScale = Math.max(State.outW / work.width, State.outH / work.height);
    var v = Math.round((State.transform.scale / minScale) * 100);
    $('zoom').value = Math.min(500, Math.max(100, v));
  }

  function initSpec() {
    buildSpecGrid();
    cropperApi = window.Cropper.attach($('crop-view'), State, {
      onChange: function () {
        renderCrop();
        syncZoomSlider();
      }
    });

    $('zoom').addEventListener('input', function () {
      var work = State.workCanvas;
      var minScale = Math.max(State.outW / work.width, State.outH / work.height);
      var newScale = minScale * (+this.value / 100);
      var factor = newScale / State.transform.scale;
      cropperApi.zoomAt(State.outW / 2, State.outH / 2, factor);
      renderCrop();
    });

    $('btn-refit').addEventListener('click', function () {
      window.Cropper.autoAlign(State);
      renderCrop();
      syncZoomSlider();
    });

    $('btn-to-export').addEventListener('click', function () { showStep('export'); });
    $('btn-back-matte').addEventListener('click', function () { showStep('matte'); });
  }

  /* ================= 步骤 4：导出 ================= */
  function enterExportStep() {
    renderCrop();
    var c = $('export-preview');
    if (c.width !== State.outW || c.height !== State.outH) {
      c.width = State.outW;
      c.height = State.outH;
    }
    c.getContext('2d').drawImage($('crop-view'), 0, 0);
    window.App.print.refreshExportList(); // 刷新打印机列表

    var sp = State.spec;
    var layout = window.Composer.bestLayout(sp.pxW, sp.pxH);
    $('export-info').innerHTML =
      '规格 <b>' + sp.name + '</b>（' + sp.mmW + '×' + sp.mmH + 'mm） · ' +
      '成品 <b>' + sp.pxW + '×' + sp.pxH + 'px</b> · ' + sp.dpi + 'DPI' +
      '<br>六寸相纸（1800×1200px）可排 <b>' + layout.n + '</b> 张（' + layout.cols + '列×' + layout.rows + '行）';

    previewSheet();
  }

  function previewSheet() {
    var sp = State.spec;
    var result = window.Composer.buildSheet(State, sp);
    var c = $('sheet-preview');
    c.width = 600; c.height = 400;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#1a1d24';
    ctx.fillRect(0, 0, 600, 400);
    if (result) {
      ctx.drawImage(result.canvas, 0, 0, 600, 400);
    }
  }

  function makeSingleCanvas() {
    var c = document.createElement('canvas');
    c.width = State.outW; c.height = State.outH;
    window.Composer.compositeInto(c.getContext('2d'), State.outW, State.outH, State);
    return c;
  }

  async function exportSingle() {
    var sp = State.spec;
    var c = makeSingleCanvas();
    var baseName = State.sourceName || ('证件照_' + sp.name + '_' + sp.pxW + 'x' + sp.pxH);
    try {
      if (State.fmt === 'jpeg') {
        var blob = await new Promise(function (r) { c.toBlob(r, 'image/jpeg', State.quality); });
        var buf = window.DpiUtil.setJpegDpi(await blob.arrayBuffer(), sp.dpi);
        download(new Blob([buf], { type: 'image/jpeg' }), baseName + '.jpg');
      } else {
        var blob2 = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
        var buf2 = window.DpiUtil.setPngDpi(await blob2.arrayBuffer(), sp.dpi);
        download(new Blob([buf2], { type: 'image/png' }), baseName + '.png');
      }
      toast('成品已保存（已写入 ' + sp.dpi + ' DPI）');
    } catch (e) {
      console.error(e);
      toast('导出失败：' + e.message, true);
    }
  }

  async function exportSheet() {
    var sp = State.spec;
    var result = window.Composer.buildSheet(State, sp);
    if (!result) { toast('排版失败', true); return; }
    var baseName = (State.sourceName || '证件照') + '_六寸相纸' + result.layout.n + '张';
    try {
      var blob = await new Promise(function (r) { result.canvas.toBlob(r, 'image/png'); });
      var buf = window.DpiUtil.setPngDpi(await blob.arrayBuffer(), 300);
      download(new Blob([buf], { type: 'image/png' }), baseName + '.png');
      toast('六寸排版已保存（' + result.layout.n + ' 张，含裁切线）');
    } catch (e) {
      console.error(e);
      toast('导出失败：' + e.message, true);
    }
  }

  function initExport() {
    document.querySelectorAll('input[name="fmt"]').forEach(function (r) {
      r.addEventListener('change', function () {
        State.fmt = this.value;
        $('quality-row').hidden = State.fmt !== 'jpeg';
        window.App.settings.save();
      });
    });
    $('quality').addEventListener('input', function () {
      State.quality = (+this.value) / 100; // toBlob 需要 0–1 小数
      $('quality-val').textContent = this.value + '%';
      window.App.settings.save();
    });
    $('btn-download-single').addEventListener('click', exportSingle);
    $('btn-download-sheet').addEventListener('click', exportSheet);

    // 直接打印：照片导出模块（打印单张成品）
    window.App.print.setupPanel('print-export', function () {
      if (!State.workCanvas || !State.transform) throw new Error('请先完成一张照片');
      return [makeSingleCanvas().toDataURL('image/png')];
    });
    $('btn-back-spec').addEventListener('click', function () { showStep('spec'); });
    $('btn-restart').addEventListener('click', function () {
      State.originalImg = null;
      State.workCanvas = null;
      State.maskCanvas = null;
      State.transform = null;
      State.undoStack = [];
      showStep('upload');
    });
  }

  /* ================= 模块切换（首页 / 照片 / 排版） ================= */
  function showModule(name) {
    document.body.dataset.module = name;
    $('view-home').style.display = name === 'home' ? '' : 'none';
    $('view-photo').style.display = name === 'photo' ? '' : 'none';
    $('view-sheet').classList.toggle('active', name === 'sheet');
    document.querySelectorAll('.module-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.module === name);
    });
    if (name === 'sheet') window.App.sheet.showStep('tpl'); // 每次进入排版模块回到第 1 步
  }

  function initModules() {
    document.querySelectorAll('.module-tab').forEach(function (t) {
      t.addEventListener('click', function () { showModule(t.dataset.module); });
    });
    $('home-photo').addEventListener('click', function () { showModule('photo'); });
    $('home-sheet').addEventListener('click', function () { showModule('sheet'); });
  }

  /* ================= 启动 ================= */
  function boot() {
    // 全局兜底：任何未捕获错误都必须关掉加载遮罩并提示，避免“永久转圈”
    window.addEventListener('unhandledrejection', function (e) {
      hideLoading();
      var msg = e && e.reason && (e.reason.message || String(e.reason)) || '未知错误';
      console.error(e && e.reason || msg);
      toast('处理失败：' + msg, true);
    });
    window.addEventListener('error', function (e) {
      if (e && e.message && !/favicon/.test(e.message)) {
        hideLoading();
        toast('脚本错误：' + e.message, true);
      }
    });

    if (location.protocol === 'file:') {
      var warn = $('offline-warning');
      warn.hidden = false;
      warn.textContent = '⚠️ 当前以 file:// 方式打开，AI 模型无法加载。请双击 start.bat（或用任意静态服务器）打开本工具。';
    }
    window.App.settings.load();   // 恢复上次的规格/背景/输出设置（须在 buildSpecGrid 之前）
    initModules();
    initUpload();
    initMatte();
    initSpec();
    initExport();
    window.App.sheet.init();
    window.App.print.init();
    window.App.settings.applyToUI();
    showModule('home'); // 启动进入首页
  }

  var App = {
    State: State,
    showModule: showModule,
    ui: {
      $: $, toast: toast, showLoading: showLoading, hideLoading: hideLoading, download: download
    },
    photo: {
      showStep: showStep,
      syncBgSwatches: syncBgSwatches,
      makeSingleCanvas: makeSingleCanvas
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  return App;
})();
