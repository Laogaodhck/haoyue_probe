/* jsdom 冒烟测试：加载 index.html + 全部脚本，捕获引导期错误 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require(path.join(
  'C:', 'Users', 'laogao', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'jsdom'
));

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  const msg = String(e.detail && e.detail.stack || e.message || e);
  errors.push(msg.split('\n')[0]);
});
vc.on('error', (m) => errors.push('console.error: ' + m));

const dom = new JSDOM(html, {
  url: 'http://localhost:8410/',
  runScripts: 'dangerously',
  resources: 'usable',
  virtualConsole: vc,
  pretendToBeVisual: true
});

// jsdom 没有 canvas 2D 上下文，给 getContext 一个最小桩避免崩溃
const win = dom.window;
const origGetContext = win.HTMLCanvasElement.prototype.getContext;
win.HTMLCanvasElement.prototype.getContext = function (type) {
  try {
    const ctx = origGetContext.call(this, type);
    if (ctx) return ctx;
  } catch (e) { /* ignore */ }
  return null;
};

setTimeout(() => {
  const doc = win.document;
  let pass = 0, fail = 0;
  function assert(cond, name) {
    if (cond) { pass++; console.log('  ok -', name); }
    else { fail++; console.log('  FAIL -', name); }
  }

  assert(!!win.__mpVision, 'MediaPipe IIFE 已挂载 window.__mpVision');
  assert(!!win.__mpVision.FilesetResolver, 'FilesetResolver 已导出');
  assert(!!win.__mpVision.ImageSegmenter, 'ImageSegmenter 已导出');
  assert(Array.isArray(win.SPECS) && win.SPECS.length === 8, 'SPECS 8 个规格');
  assert(typeof win.DpiUtil.setPngDpi === 'function', 'DpiUtil 就绪');
  assert(typeof win.Matting.segment === 'function', 'Matting 就绪');
  assert(typeof win.Composer.compositeInto === 'function', 'Composer 就绪');
  assert(typeof win.Brush.attach === 'function', 'Brush 就绪');
  assert(typeof win.MatteView.attach === 'function', 'MatteView 就绪');
  assert(typeof win.Cropper.attach === 'function', 'Cropper 就绪');
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

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (errors.length) console.log('（jsdom 环境噪音）:\n  ' + errors.slice(0, 5).join('\n  '));
  process.exit(fail ? 1 : 0);
}, 1500);
