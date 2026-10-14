/* ============================================================
 * sheet.js — 排版流程：选择模板 → 批量导入 → 预览导出 → 打印
 * 相纸与排版算法在 composer.js，打印参数与执行在 print.js。
 * ============================================================ */
'use strict';

(function (App) {

  var $ = App.ui.$;
  var toast = App.ui.toast;
  var download = App.ui.download;
  var State = App.State;

  var sheetFiles = [];       // 批量导入的照片 [{canvas, name}]
  var sheetPages = null;     // 最近一次排版结果 { pages, ... }
  var sheetPageIdx = 0;

  /* 排版模块分步：tpl → import → preview → print */
  var SHEET_STEPS = ['tpl', 'import', 'preview', 'print'];

  function showStep(name) {
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
    if (name === 'print') { App.print.drawPreview(); App.print.refreshSheetList(); }
  }

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
  function collectCells() {
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

    var input = collectCells();
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

    drawPage();
    var copies = +$('sheet-count').value;
    info.textContent = result.paper.name + ' · ' + result.width + '×' + result.height + 'px · 300DPI · 共 '
      + sheetFiles.length + ' 张照片 × ' + copies + ' 份 = ' + result.total + ' 格 · 版面 ' + result.cols + ' 列×'
      + Math.min(result.pages[0].rowsUsed, Math.round(result.capacity / result.cols)) + ' 行'
      + (result.pages.length > 1 ? ' · 分 ' + result.pages.length + ' 页' : '');
  }

  function drawPage() {
    if (!sheetPages) return;
    var canvas = $('laysheet-preview');
    var page = sheetPages.pages[sheetPageIdx];
    var k2 = Math.min(1, 900 / sheetPages.width);
    canvas.width = Math.round(sheetPages.width * k2);
    canvas.height = Math.round(sheetPages.height * k2);
    canvas.getContext('2d').drawImage(page.canvas, 0, 0, canvas.width, canvas.height);
  }

  async function downloadSheet() {
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

  function loadFiles(files) {
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
  }

  function init() {
    // 单张尺寸下拉
    var sel = $('sheet-spec');
    window.SPECS.forEach(function (sp) {
      var opt = document.createElement('option');
      opt.value = sp.id;
      opt.textContent = sp.name + ' · ' + sp.desc + ' · ' + sp.pxW + '×' + sp.pxH;
      if (sp.id === State.spec.id) opt.selected = true;
      sel.appendChild(opt);
    });

    $('btn-sheet-file').addEventListener('click', function () { $('sheet-file-input').click(); });
    $('sheet-file-input').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []).filter(function (f) { return /^image\//.test(f.type); });
      this.value = '';
      if (!files.length) return;
      loadFiles(files);
    });

    // 使用照片模块成品（追加为一张导入照片）
    $('btn-use-photo-result').addEventListener('click', function () {
      if (!State.workCanvas || !State.transform) { toast('请先在「照片」模块完成一张成品', true); return; }
      var c = App.photo.makeSingleCanvas();
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
      drawPage();
    });
    $('sheet-gap').addEventListener('input', function () {
      $('sheet-gap-val').textContent = this.value + 'px';
      renderLaySheet();
    });
    $('btn-download-laysheet').addEventListener('click', downloadSheet);

    // 排版分步导航
    $('btn-sheet-back-photo').addEventListener('click', function () { App.showModule('photo'); });
    $('btn-sheet-to-import').addEventListener('click', function () { showStep('import'); });
    $('btn-sheet-back-tpl').addEventListener('click', function () { showStep('tpl'); });
    $('btn-sheet-to-preview').addEventListener('click', function () {
      if (!sheetFiles.length) { toast('请先导入照片', true); return; }
      showStep('preview');
    });
    $('btn-sheet-back-import').addEventListener('click', function () { showStep('import'); });
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
      showStep('print');
    });
    $('btn-sheet-back-preview').addEventListener('click', function () { showStep('preview'); });
  }

  App.sheet = {
    init: init,
    showStep: showStep,
    render: renderLaySheet,
    getPages: function () { return sheetPages; },
    getPageIndex: function () { return sheetPageIdx; }
  };
})(window.App);
