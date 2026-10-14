/* ============================================================
 * app.js — 主控：上传 → 抠图换底 → 规格调整 → 导出
 * ============================================================ */
'use strict';

(function () {

  /* ================= 全局状态 ================= */
  var State = {
    originalImg: null,
    sourceName: '',         // 原始文件名（去扩展名），用于导出命名
    workCanvas: null,
    maskCanvas: null,
    initialMaskData: null,
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
      State.initialMaskData = window.Brush.snapMask(State);
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

  function pushUndo() {
    State.undoStack.push(window.Brush.snapMask(State));
    if (State.undoStack.length > 12) State.undoStack.shift();
  }

  function undoMask() {
    var snap = State.undoStack.pop();
    if (!snap) { toast('没有可撤销的操作'); return; }
    State.maskCanvas.getContext('2d').putImageData(snap, 0, 0);
    renderMatteView();
  }

  function resetMask() {
    State.maskCanvas.getContext('2d').putImageData(State.initialMaskData, 0, 0);
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
        saveSettings();
      });
    });
    $('custom-bg').addEventListener('input', function () {
      State.bg = this.value;
      document.querySelectorAll('.swatch').forEach(function (x) { x.classList.remove('active'); });
      renderMatteView();
      saveSettings();
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
        saveSettings();
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
    if (refreshExportPrinters) refreshExportPrinters(); // 刷新打印机列表

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
        saveSettings();
      });
    });
    $('quality').addEventListener('input', function () {
      State.quality = (+this.value) / 100; // toBlob 需要 0–1 小数
      $('quality-val').textContent = this.value + '%';
      saveSettings();
    });
    $('btn-download-single').addEventListener('click', exportSingle);
    $('btn-download-sheet').addEventListener('click', exportSheet);

    // 直接打印：照片导出模块（打印单张成品）
    refreshExportPrinters = setupPrintPanel('print-export', function () {
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

  /* ================= 模块切换（照片 / 排版） ================= */
  function showModule(name) {
    document.body.dataset.module = name;
    $('view-home').style.display = name === 'home' ? '' : 'none';
    $('view-photo').style.display = name === 'photo' ? '' : 'none';
    $('view-sheet').classList.toggle('active', name === 'sheet');
    document.querySelectorAll('.module-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.module === name);
    });
    if (name === 'sheet') showSheetStep('tpl'); // 每次进入排版模块回到第 1 步
  }

  /* 排版模块分步：tpl → import → preview → print */
  var SHEET_STEPS = ['tpl', 'import', 'preview', 'print'];
  function showSheetStep(name) {
    SHEET_STEPS.forEach(function (s, idx) {
      var panel = $('sheetstep-' + s);
      if (panel) panel.classList.toggle('active', s === name);
      var chip = document.querySelector('.step[data-sstep="' + s + '"]');
      if (chip) {
        chip.classList.toggle('active', s === name);
        chip.classList.toggle('done', idx < SHEET_STEPS.indexOf(name));
      }
    });
    if (name === 'preview') renderLaySheet();
    if (name === 'print') { drawPrintPreview(); refreshSheetPrinterList(); }
  }

  /* ================= 排版模块 ================= */
  var sheetFiles = [];       // 批量导入的照片 [{canvas, name}]
  var sheetPages = null;     // 最近一次排版结果 { pages, ... }
  var sheetPageIdx = 0;

  /* 源图 cover 绘制到所选规格尺寸 */
  function coverToSpec(src, sp) {
    var cell = document.createElement('canvas');
    cell.width = sp.pxW; cell.height = sp.pxH;
    var ctx = cell.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, cell.width, cell.height);
    var k = Math.max(cell.width / src.width, cell.height / src.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (cell.width - src.width * k) / 2, (cell.height - src.height * k) / 2, src.width * k, src.height * k);
    return cell;
  }

  /* 组装逐格照片列表：每张导入照片 × 所选份数，统一尺寸 */
  function collectSheetCells() {
    var tip = $('sheet-empty-tip');
    var sp = window.SpecUtil.byId($('sheet-spec').value);
    if (!sheetFiles.length) {
      tip.hidden = false;
      tip.textContent = '请先批量导入照片（可多选），或点击「使用照片模块的成品」';
      return null;
    }
    tip.hidden = true;
    var copies = +$('sheet-count').value;
    var cells = [];
    sheetFiles.forEach(function (f) {
      var cell = coverToSpec(f.canvas, sp);
      for (var i = 0; i < copies; i++) cells.push(cell);
    });
    return { cells: cells, sp: sp };
  }

  function renderLaySheet() {
    var tip = $('sheet-empty-tip');
    var canvas = $('laysheet-preview');
    var info = $('sheet-info');
    var pageRow = $('sheet-page-row');

    var input = collectSheetCells();
    if (!input) {
      sheetPages = null;
      canvas.width = 600; canvas.height = 400;
      var blank = canvas.getContext('2d');
      blank.fillStyle = '#1a1d24';
      blank.fillRect(0, 0, 600, 400);
      info.textContent = '';
      pageRow.hidden = true;
      return;
    }

    var result = window.Composer.layoutBatch(input.cells, $('sheet-paper').value, {
      gap: +$('sheet-gap').value,
      cutLines: $('sheet-cutlines').checked
    });
    if (!result) { info.textContent = '该尺寸无法排入所选相纸'; return; }
    sheetPages = result;
    if (sheetPageIdx >= result.pages.length) sheetPageIdx = 0;

    // 页码下拉
    var pageSel = $('sheet-page');
    pageSel.innerHTML = '';
    for (var i = 0; i < result.pages.length; i++) {
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = '第 ' + (i + 1) + ' 页 / 共 ' + result.pages.length + ' 页（' + result.pages[i].count + ' 张）';
      pageSel.appendChild(opt);
    }
    pageSel.value = sheetPageIdx;
    pageRow.hidden = result.pages.length <= 1;

    drawSheetPage();
    var copies = +$('sheet-count').value;
    info.textContent = result.paper.name + ' · ' + result.width + '×' + result.height + 'px · 300DPI · 共 '
      + sheetFiles.length + ' 张照片 × ' + copies + ' 份 = ' + result.total + ' 格 · 版面 ' + result.cols + ' 列×'
      + Math.min(result.pages[0].rowsUsed, Math.round(result.capacity / result.cols)) + ' 行'
      + (result.pages.length > 1 ? ' · 分 ' + result.pages.length + ' 页' : '');
  }

  function drawSheetPage() {
    if (!sheetPages) return;
    var canvas = $('laysheet-preview');
    var page = sheetPages.pages[sheetPageIdx];
    var k2 = Math.min(1, 900 / sheetPages.width);
    canvas.width = Math.round(sheetPages.width * k2);
    canvas.height = Math.round(sheetPages.height * k2);
    canvas.getContext('2d').drawImage(page.canvas, 0, 0, canvas.width, canvas.height);
  }

  async function downloadLaySheet() {
    if (!sheetPages) {
      // 尚未预览过则现算
      renderLaySheet();
      if (!sheetPages) { toast('请先批量导入照片', true); return; }
    }
    var name = sheetFiles.length ? (sheetFiles[0].name || '照片') : (State.sourceName || '照片');
    var multi = sheetPages.pages.length > 1;
    try {
      for (var i = 0; i < sheetPages.pages.length; i++) {
        var blob = await new Promise(function (r) { sheetPages.pages[i].canvas.toBlob(r, 'image/png'); });
        var buf = window.DpiUtil.setPngDpi(await blob.arrayBuffer(), 300);
        var fname = name + '_排版_' + sheetPages.paper.name
          + (multi ? '_第' + (i + 1) + '页共' + sheetPages.pages.length + '页' : '_' + sheetPages.pages[i].count + '张')
          + '.png';
        download(new Blob([buf], { type: 'image/png' }), fname);
        if (multi) await new Promise(function (r) { setTimeout(r, 350); }); // 间隔避免下载拦截
      }
      toast('排版图已保存（' + sheetPages.total + ' 张 · ' + sheetPages.pages.length + ' 版 · 300DPI）');
    } catch (e) {
      console.error(e);
      toast('导出失败：' + e.message, true);
    }
  }

  function initSheet() {
    // 规格下拉
    var sel = $('sheet-spec');
    window.SPECS.forEach(function (sp) {
      var opt = document.createElement('option');
      opt.value = sp.id;
      opt.textContent = sp.name + ' · ' + sp.desc + ' · ' + sp.pxW + '×' + sp.pxH;
      if (sp.id === State.spec.id) opt.selected = true;
      sel.appendChild(opt);
    });

    // 模块 Tab
    document.querySelectorAll('.module-tab').forEach(function (t) {
      t.addEventListener('click', function () { showModule(t.dataset.module); });
    });

    // 首页菜单卡片
    $('home-photo').addEventListener('click', function () { showModule('photo'); });
    $('home-sheet').addEventListener('click', function () { showModule('sheet'); });

    $('btn-sheet-file').addEventListener('click', function () { $('sheet-file-input').click(); });
    $('sheet-file-input').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []).filter(function (f) { return /^image\//.test(f.type); });
      this.value = '';
      if (!files.length) return;
      var loaded = [];
      var pending = files.length;
      files.forEach(function (file) {
        var reader = new FileReader();
        reader.onload = function () {
          var img = new Image();
          img.onload = function () {
            var c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            loaded.push({ canvas: c, name: (file.name || '').replace(/\.[^.]+$/, '') || '照片' });
            if (--pending === 0) {
              sheetFiles = sheetFiles.concat(loaded); // 累加导入
              $('sheet-file-name').textContent = '已导入 ' + sheetFiles.length + ' 张：'
                + sheetFiles.slice(-loaded.length).map(function (f) { return f.name; }).join('、');
              renderLaySheet();
            }
          };
          img.onerror = function () { if (--pending === 0) renderLaySheet(); };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    });

    // 使用照片模块成品（追加为一张导入照片）
    $('btn-use-photo-result').addEventListener('click', function () {
      if (!State.workCanvas || !State.transform) { toast('请先在「照片」模块完成一张成品', true); return; }
      var c = makeSingleCanvas();
      sheetFiles.push({ canvas: c, name: State.sourceName || '照片成品' });
      $('sheet-file-name').textContent = '已导入 ' + sheetFiles.length + ' 张（含照片模块成品 1 张）';
      renderLaySheet();
    });

    $('sheet-spec').addEventListener('change', renderLaySheet);
    $('sheet-count').addEventListener('change', renderLaySheet);
    $('sheet-paper').addEventListener('change', renderLaySheet);
    $('sheet-cutlines').addEventListener('change', renderLaySheet);
    $('sheet-page').addEventListener('change', function () {
      sheetPageIdx = +this.value;
      drawSheetPage();
    });
    $('sheet-gap').addEventListener('input', function () {
      $('sheet-gap-val').textContent = this.value + 'px';
      renderLaySheet();
    });
    $('btn-download-laysheet').addEventListener('click', downloadLaySheet);

    // 排版分步导航
    $('btn-sheet-back-photo').addEventListener('click', function () { showModule('photo'); });
    $('btn-sheet-to-import').addEventListener('click', function () { showSheetStep('import'); });
    $('btn-sheet-back-tpl').addEventListener('click', function () { showSheetStep('tpl'); });
    $('btn-sheet-to-preview').addEventListener('click', function () {
      if (!sheetFiles.length) { toast('请先导入照片', true); return; }
      showSheetStep('preview');
    });
    $('btn-sheet-back-import').addEventListener('click', function () { showSheetStep('import'); });
    $('btn-sheet-clear').addEventListener('click', function () {
      if (!sheetFiles.length) { toast('当前没有已导入的照片'); return; }
      sheetFiles = [];
      $('sheet-file-name').textContent = '已清空';
      toast('已清空导入的照片');
    });

    // 第 4 步：打印预览（选打印机 → 设参数 → 打印）
    $('btn-sheet-goto-print').addEventListener('click', function () {
      if (!sheetPages) renderLaySheet();
      if (!sheetPages) { toast('请先在第二步导入照片', true); return; }
      showSheetStep('print');
    });
    $('btn-sheet-back-preview').addEventListener('click', function () { showSheetStep('preview'); });
    $('print-sheet-refresh').addEventListener('click', function () { refreshSheetPrinterList(); });
    $('print-sheet-props').addEventListener('click', openSheetPrinterProps);
    $('print-sheet-copies').addEventListener('change', function () {
      // 数字输入钳制到 1–99
      var v = Math.floor(+this.value);
      if (!v || v < 1) v = 1;
      if (v > 99) v = 99;
      this.value = v;
    });
    ['print-paper', 'print-landscape', 'print-margin'].forEach(function (id) {
      $(id).addEventListener('change', function () { drawPrintPreview(); });
    });
    $('print-sheet-btn').addEventListener('click', printLaySheets);
  }

  /* ================= 直接打印（Electron IPC） ================= */
  var printApi = window.haoyuePrint || null;
  var refreshExportPrinters = null;  // 照片导出模块打印机列表刷新器

  /* prefix: 'export'；getJobs 返回 dataURL 数组（每页一张图） */
  function setupPrintPanel(prefix, getJobs) {
    var panel = $(prefix + '-panel');
    var unsup = $(prefix + '-unsupported');
    if (!printApi || !panel) {
      if (panel) panel.hidden = true;
      if (unsup) unsup.hidden = false;
      return null;
    }
    var sel = $(prefix + '-printer');

    async function refreshPrinters() {
      try {
        var printers = await printApi.listPrinters();
        sel.innerHTML = '';
        printers.forEach(function (p) {
          var opt = document.createElement('option');
          opt.value = p.name;
          opt.textContent = (p.isDefault ? '★ ' : '') + p.displayName + (p.status ? '（' + p.status + '）' : '');
          if (p.isDefault) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.disabled = printers.length === 0;
        $(prefix + '-status').textContent = printers.length ? '' : '未检测到打印机，请检查系统打印设备';
      } catch (e) {
        $(prefix + '-status').textContent = '读取打印机失败：' + e.message;
      }
    }
    refreshPrinters();

    $(prefix + '-copies').addEventListener('change', function () {
      // 数字输入钳制到 1–99
      var v = Math.floor(+this.value);
      if (!v || v < 1) v = 1;
      if (v > 99) v = 99;
      this.value = v;
    });

    $(prefix + '-btn').addEventListener('click', async function () {
      var jobs;
      try { jobs = getJobs(); } catch (e) { jobs = []; }
      if (!jobs || !jobs.length) { toast('没有可打印的内容', true); return; }
      var btn = this;
      btn.disabled = true;
      var status = $(prefix + '-status');
      status.textContent = '正在发送打印任务…';
      var fail = null;
      try {
        for (var i = 0; i < jobs.length; i++) {
          var res = await printApi.printImage({
            dataUrl: jobs[i],
            printerName: sel.value || undefined,
            copies: +($(prefix + '-copies').value) || 1
          });
          if (!res.ok) { fail = res.error; break; }
        }
      } catch (e) {
        fail = e.message;
      }
      btn.disabled = false;
      if (fail) {
        status.textContent = '打印失败：' + fail;
        toast('打印失败：' + fail, true);
      } else {
        status.textContent = '已发送打印任务 ✓（' + jobs.length + ' 页）';
        toast('已发送到打印机 ✓');
      }
    });

    return refreshPrinters;
  }

  /* ================= 排版第 4 步：打印预览与执行 ================= */
  /* 物理纸张（mm）；4x6 走 Electron 自定义尺寸（微米） */
  var PRINT_PAPERS = {
    'A4':     { w: 210,   h: 297,   electron: 'A4' },
    'B5':     { w: 182,   h: 257,   electron: { width: 182000, height: 257000 } },  /* 微米自定义尺寸 */
    'A5':     { w: 148,   h: 210,   electron: 'A5' },
    'A3':     { w: 297,   h: 420,   electron: 'A3' },
    'Letter': { w: 215.9, h: 279.4, electron: 'Letter' },
    '4x6':    { w: 101.6, h: 152.4, electron: { width: 101600, height: 152400 } }
  };

  /* 纸张模拟预览：白纸 + 按边距 contain 适配当前排版页 */
  function drawPrintPreview() {
    var canvas = $('print-preview-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (!sheetPages) { renderLaySheet(); }
    if (!sheetPages) {
      canvas.width = 600; canvas.height = 400;
      ctx.fillStyle = '#1a1d24'; ctx.fillRect(0, 0, 600, 400);
      return;
    }
    var pk = PRINT_PAPERS[$('print-paper').value] || PRINT_PAPERS.A4;
    var landscape = $('print-landscape').value === '1';
    var pw = landscape ? pk.h : pk.w;
    var ph = landscape ? pk.w : pk.h;
    var marginMm = $('print-margin').value === 'printableArea' ? 5 : 0;

    var k = Math.min(700 / pw, 760 / ph);
    canvas.width = Math.round(pw * k);
    canvas.height = Math.round(ph * k);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var page = sheetPages.pages[sheetPageIdx] ? sheetPages.pages[sheetPageIdx].canvas : sheetPages.pages[0].canvas;
    var m = marginMm * k;
    var fit = Math.min((canvas.width - 2 * m) / page.width, (canvas.height - 2 * m) / page.height);
    var dw = page.width * fit, dh = page.height * fit;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(page, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);

    if (m > 0) { // 可打印区域示意线
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(m, m, canvas.width - 2 * m, canvas.height - 2 * m);
      ctx.setLineDash([]);
    }
  }

  /* 排版打印面板：刷新打印机列表（桌面版） */
  async function refreshSheetPrinterList() {
    var sel = $('print-sheet-printer');
    var unsup = $('print-sheet-unsupported');
    var status = $('print-sheet-status');
    var btn = $('print-sheet-btn');
    if (!printApi) {
      if (unsup) unsup.hidden = false;
      if (btn) btn.disabled = true;
      var propsBtn = $('print-sheet-props');
      if (propsBtn) propsBtn.disabled = true;
      return;
    }
    if (unsup) unsup.hidden = true;
    try {
      var printers = await printApi.listPrinters();
      sel.innerHTML = '';
      printers.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = (p.isDefault ? '★ ' : '') + p.displayName + (p.status ? '（' + p.status + '）' : '');
        if (p.isDefault) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.disabled = printers.length === 0;
      status.textContent = printers.length ? '' : '未检测到打印机，请检查系统打印设备';
      if (btn) btn.disabled = printers.length === 0;
      var propsBtn = $('print-sheet-props');
      if (propsBtn) propsBtn.disabled = printers.length === 0;
    } catch (e) {
      status.textContent = '读取打印机失败：' + e.message;
    }
  }

  /* 打开所选打印机的系统属性对话框（桌面版） */
  async function openSheetPrinterProps() {
    var status = $('print-sheet-status');
    if (!printApi || !printApi.showPrinterProperties) {
      toast('浏览器模式不支持打印机属性，请使用桌面版', true);
      return;
    }
    var name = $('print-sheet-printer').value;
    if (!name) { toast('请先选择打印机', true); return; }
    if (status) status.textContent = '正在打开打印机属性…';
    try {
      var res = await printApi.showPrinterProperties(name);
      if (status) status.textContent = res && res.ok ? '' : (res.error || '无法打开打印机属性');
      if (!res || !res.ok) toast(res.error || '无法打开打印机属性', true);
    } catch (e) {
      if (status) status.textContent = '打开打印机属性失败：' + e.message;
    }
  }

  /* 执行打印：逐页发送，携带纸张/方向/边距/份数 */
  async function printLaySheets() {
    if (!sheetPages) { renderLaySheet(); }
    if (!sheetPages) { toast('没有可打印的排版，请先导入照片', true); return; }
    if (!printApi) { toast('浏览器模式不支持直接打印，请使用桌面版', true); return; }
    var btn = $('print-sheet-btn');
    var status = $('print-sheet-status');
    var pk = PRINT_PAPERS[$('print-paper').value] || PRINT_PAPERS.A4;
    var params = {
      printerName: $('print-sheet-printer').value || undefined,
      copies: +$('print-sheet-copies').value || 1,
      pageSize: pk.electron,
      landscape: $('print-landscape').value === '1',
      marginType: $('print-margin').value === 'printableArea' ? 'printableArea' : 'none'
    };
    btn.disabled = true;
    status.textContent = '正在发送打印任务…';
    var fail = null;
    try {
      for (var i = 0; i < sheetPages.pages.length; i++) {
        var res = await printApi.printImage(Object.assign({
          dataUrl: sheetPages.pages[i].canvas.toDataURL('image/png')
        }, params));
        if (!res.ok) { fail = res.error; break; }
      }
    } catch (e) {
      fail = e.message;
    }
    btn.disabled = false;
    if (fail) {
      status.textContent = '打印失败：' + fail;
      toast('打印失败：' + fail, true);
    } else {
      status.textContent = '已发送打印任务 ✓（' + sheetPages.pages.length + ' 页 × ' + params.copies + ' 份）';
      toast('已发送到打印机 ✓');
    }
  }

  /* ================= 设置持久化（localStorage） ================= */
  var SETTINGS_KEY = 'haoyue-idphoto-settings';
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        spec: State.spec.id, bg: State.bg, fmt: State.fmt, quality: State.quality
      }));
    } catch (e) { /* 存储不可用时静默忽略 */ }
  }
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (!s) return;
      if (s.spec) State.spec = window.SpecUtil.byId(s.spec);
      if (s.bg) State.bg = s.bg;
      if (s.fmt === 'png' || s.fmt === 'jpeg') State.fmt = s.fmt;
      if (typeof s.quality === 'number') State.quality = Math.min(1, Math.max(0.5, s.quality));
    } catch (e) { }
  }
  function applySettingsToUI() {
    document.querySelectorAll('input[name="fmt"]').forEach(function (r) {
      r.checked = r.value === State.fmt;
    });
    $('quality-row').hidden = State.fmt !== 'jpeg';
    $('quality').value = Math.round(State.quality * 100);
    $('quality-val').textContent = Math.round(State.quality * 100) + '%';
    $('custom-bg').value = /^#[0-9a-fA-F]{6}$/.test(State.bg) ? State.bg : '#FFFFFF';
    syncBgSwatches();
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
    loadSettings(); // 恢复上次的规格/背景/输出设置（须在 buildSpecGrid 之前）
    initUpload();
    initMatte();
    initSpec();
    initExport();
    initSheet();
    applySettingsToUI();
    showModule('home'); // 启动进入首页
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
