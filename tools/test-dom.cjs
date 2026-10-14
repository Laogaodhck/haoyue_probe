/* ============================================================
 * test-dom.cjs — jsdom 冒烟测试
 * 起本地静态服务后加载 index.html 及全部外链脚本，捕获引导期错误。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createChecker, withServer } = require('./_lib.cjs');

const ROOT = path.join(__dirname, '..');
const PORT = 8439;
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  const msg = String(e.detail && e.detail.stack || e.message || e);
  errors.push(msg.split('\n')[0]);
});
vc.on('error', (m) => errors.push('console.error: ' + m));

const checker = createChecker();
const assert = checker.assert;

withServer(PORT, async () => {
  const dom = await JSDOM.fromURL('http://localhost:' + PORT + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    virtualConsole: vc,
    pretendToBeVisual: true
  });

  // jsdom 没有 canvas 2D 上下文，getContext 返回 null 时不要让引导期崩掉
  const win = dom.window;
  const origGetContext = win.HTMLCanvasElement.prototype.getContext;
  win.HTMLCanvasElement.prototype.getContext = function (type) {
    try {
      const ctx = origGetContext.call(this, type);
      if (ctx) return ctx;
    } catch (e) { /* ignore */ }
    return null;
  };

  await new Promise((r) => setTimeout(r, 1500)); // 等外链脚本执行完
  const doc = win.document;

  assert(!!win.__mpVision, 'MediaPipe IIFE 已挂载 window.__mpVision');
  assert(win.__mpVision && !!win.__mpVision.FilesetResolver, 'FilesetResolver 已导出');
  assert(win.__mpVision && !!win.__mpVision.ImageSegmenter, 'ImageSegmenter 已导出');
  assert(Array.isArray(win.SPECS) && win.SPECS.length === 8, 'SPECS 8 个规格');
  assert(typeof win.DpiUtil.setPngDpi === 'function', 'DpiUtil 就绪');
  assert(typeof win.Matting.segment === 'function', 'Matting 就绪');
  assert(typeof win.Composer.compositeInto === 'function', 'Composer 就绪');
  assert(typeof win.Brush.attach === 'function', 'Brush 就绪');
  assert(typeof win.Brush.restoreMask === 'function', 'Brush.restoreMask 就绪（撤销用单通道快照）');
  assert(typeof win.MatteView.attach === 'function', 'MatteView 就绪');
  assert(typeof win.Cropper.attach === 'function', 'Cropper 就绪');
  assert(win.App && typeof win.App.showModule === 'function', 'App 核心状态就绪');
  ['ui', 'photo', 'sheet', 'print', 'settings'].forEach(function (m) {
    assert(!!win.App && typeof win.App[m] === 'object', 'App.' + m + ' 命名空间已注册');
  });
  assert(typeof win.App.sheet.init === 'function' && typeof win.App.print.init === 'function',
    'App.sheet / App.print 引导函数就绪');
  assert(typeof win.App.settings.save === 'function' && typeof win.App.photo.makeSingleCanvas === 'function',
    'App.settings.save / App.photo.makeSingleCanvas 可用');
  assert(!!doc.getElementById('dropzone'), '上传区存在');
  assert(!!doc.getElementById('matte-view'), '抠图画布存在');
  assert(!!doc.getElementById('mv-zoom-in') && !!doc.getElementById('mv-zoom-out') && !!doc.getElementById('mv-zoom-fit'), '缩放工具栏存在');
  assert(!!doc.getElementById('mv-zoom-label'), '缩放百分比标签存在');
  assert(!!doc.getElementById('crop-view'), '裁剪画布存在');
  assert(doc.querySelectorAll('.spec-card').length === 8, '规格卡片已渲染 8 张');
  assert(doc.querySelectorAll('#steps-nav .step').length === 4, '照片模块步骤指示器 4 个');
  assert(doc.querySelectorAll('#sheet-steps-nav .step').length === 4, '排版模块步骤指示器 4 个');
  assert(doc.getElementById('sheetstep-print'), '排版第 4 步打印面板存在');
  const paperSel = doc.getElementById('sheet-paper');
  assert(paperSel && paperSel.options.length === 5, '相纸下拉 5 种（A4/B5/A5/A3/六寸）');
  assert(paperSel && paperSel.value === 'a4', '相纸默认 A4');
  assert(doc.getElementById('print-paper') && doc.getElementById('print-paper').options.length === 6, '打印纸张下拉 6 种');
  assert(doc.getElementById('step-upload').classList.contains('active'), '默认显示上传步骤');

  // app.js 引导错误（排除 mediapipe 对 jsdom 缺失 API 的抱怨）
  const appErrors = errors.filter(e => !/OffscreenCanvas|Worker|WebGL|createImageBitmap|VideoFrame|ImageDecoder|MediaStream/i.test(e));
  assert(appErrors.length === 0, '无引导期脚本错误' + (appErrors.length ? '：' + appErrors.join(' | ') : ''));

  win.close();
}).then(checker.finish, e => { console.error('脚本异常:', e && e.message || e); process.exit(2); });
