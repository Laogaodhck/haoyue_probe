/* verify-layout-params.cjs — 实测排版引擎新参数（列距2.4mm/行距2.12mm/边距5mm） */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const playwright = require(path.join('C:', 'Users', 'laogao', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'));
const ROOT = 'E:/GitHub/photo';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('  ok - ' + msg); } else { fail++; console.log('  FAIL - ' + msg); } }

(async () => {
  const server = spawn(process.execPath, [ROOT + '/tools/server.js'], { env: Object.assign({}, process.env, { PORT: '8445' }) });
  await sleep(800);
  const browser = await playwright.chromium.launch({ executablePath: 'C:\\Users\\laogao\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:8445/');
  await page.click('#home-sheet');
  await sleep(300);

  /* 1. 引擎容量（真实页面内调用） */
  const cap = await page.evaluate(() => {
    const C = window.Composer;
    return {
      a4_1inch: C.sheetCapacity(295, 413, 'a4'),        // 一寸@A4
      a4_2inch: C.sheetCapacity(413, 579, 'a4'),        // 二寸@A4
      six_1inch: C.sheetCapacity(295, 413, '6inch'),    // 一寸@六寸
      gapPx: { x: Math.round(2.4 * 300 / 25.4), y: Math.round(2.12 * 300 / 25.4) }
    };
  });
  assert(cap.a4_1inch.cols === 7 && cap.a4_1inch.rows === 7 && cap.a4_1inch.capacity === 49,
    'A4 一寸 7列×7行=49（实际 ' + cap.a4_1inch.cols + '×' + cap.a4_1inch.rows + '=' + cap.a4_1inch.capacity + '）');
  assert(cap.six_1inch.capacity === 10, '六寸 一寸 10 张不变（实际 ' + cap.six_1inch.capacity + '）');

  /* 2. 间距滑块联动正常（第 1 步面板内） */
  await page.$eval('#sheet-gap', el => { el.value = 10; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(200);
  const gapVal = await page.$eval('#sheet-gap-val', el => el.textContent);
  assert(gapVal === '10px', '间距滑块联动（' + gapVal + '）');
  await page.$eval('#sheet-gap', el => { el.value = 28; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(200);

  /* 3. 排版模块真实出图（默认间距 28px） */
  await page.setInputFiles('#sheet-file-input', ROOT + '/fixtures/photo.jpg');
  await sleep(1500);
  await page.click('#btn-sheet-to-import');
  await sleep(200);
  await page.click('#btn-sheet-to-preview');
  await sleep(400);
  const d = await page.evaluate(() => {
    const c = document.getElementById('laysheet-preview');
    const ctx = c.getContext('2d');
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonWhite = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i] < 240 || img[i + 1] < 240 || img[i + 2] < 240) nonWhite++;
    }
    return { w: c.width, h: c.height, nonWhite, info: document.getElementById('sheet-info').textContent };
  });
  assert(d.w > 500 && d.h > 500, '排版预览画布有内容（' + d.w + '×' + d.h + '，打印版 2480×3508@300DPI）');
  assert(d.nonWhite > 500, '排版内容非空白（非白像素 ' + d.nonWhite + '）：' + d.info.slice(0, 40));

  /* 4. 上下留白对称：预览画布首/末非白内容行到上下边缘的距离应相等（±1px 容差） */
  const sym = await page.evaluate(() => {
    const c = document.getElementById('laysheet-preview');
    const ctx = c.getContext('2d');
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const rowNonWhite = (y) => {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (img[i] < 240 || img[i + 1] < 240 || img[i + 2] < 240) return true;
      }
      return false;
    };
    let first = -1, last = -1;
    for (let y = 0; y < c.height; y++) { if (rowNonWhite(y)) { first = y; break; } }
    for (let y = c.height - 1; y >= 0; y--) { if (rowNonWhite(y)) { last = y; break; } }
    if (first < 0) return null;
    return { top: first, bottom: c.height - 1 - last, h: c.height };
  });
  assert(sym && Math.abs(sym.top - sym.bottom) <= 1,
    '上下留白对称（上 ' + sym.top + 'px / 下 ' + sym.bottom + 'px @预览 ' + sym.h + 'px 高）');

  assert(errors.length === 0, '无页面脚本错误' + (errors.length ? '：' + errors.join(' | ') : ''));
  await browser.close(); server.kill();
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
