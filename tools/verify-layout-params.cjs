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

  /* 4. 纵向定位规则（引擎级实测）：
   *    满页（行数排满）→ 上下留白对称居中；末页不满 → 上留白 6.16mm 顶部对齐 */
  const lay = await page.evaluate(() => {
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = 295; c.height = 413;                    // 一寸@300DPI
      const x = c.getContext('2d');
      x.fillStyle = '#3a6ea5'; x.fillRect(0, 0, 295, 413);
      return c;
    };
    const measure = (cells) => {
      const r = window.Composer.layoutBatch(cells, 'a4', { gap: 28, cutLines: false });
      const ctx = r.pages[0].canvas.getContext('2d');
      const img = ctx.getImageData(0, 0, r.width, r.height).data;
      const rowHas = (y) => {
        for (let x = 0; x < r.width; x++) {
          const i = (y * r.width + x) * 4;
          if (img[i] < 240 || img[i + 1] < 240 || img[i + 2] < 240) return true;
        }
        return false;
      };
      let first = -1, last = -1;
      for (let y = 0; y < r.height; y++) { if (rowHas(y)) { first = y; break; } }
      for (let y = r.height - 1; y >= 0; y--) { if (rowHas(y)) { last = y; break; } }
      return { first, bottom: r.height - 1 - last, rowsUsed: r.pages[0].rowsUsed, cols: r.cols };
    };
    return {
      partial: measure(Array.from({ length: 30 }, mk)),   // 30 张 → 5 行 < 7 行（末页不满）
      full: measure(Array.from({ length: 49 }, mk))       // 49 张 → 7 行排满
    };
  });
  const expectTop = Math.round(6.16 * 300 / 25.4);        // 73px ≈ 6.16mm
  assert(lay.partial.rowsUsed === 5 && lay.partial.cols === 7,
    '30 张 → 7 列 × 5 行（实际 ' + lay.partial.cols + '×' + lay.partial.rowsUsed + '）');
  assert(Math.abs(lay.partial.first - expectTop) <= 2,
    '末页不满：上留白 6.16mm（首行 ' + lay.partial.first + 'px ≈ ' + expectTop + 'px）');
  assert(lay.partial.bottom > lay.partial.first * 3,
    '末页不满：多余留白在底部（下 ' + lay.partial.bottom + 'px > 上 ' + lay.partial.first + 'px）');
  assert(Math.abs(lay.full.first - lay.full.bottom) <= 2,
    '满页：上下留白对称（上 ' + lay.full.first + 'px / 下 ' + lay.full.bottom + 'px）');

  assert(errors.length === 0, '无页面脚本错误' + (errors.length ? '：' + errors.join(' | ') : ''));
  await browser.close(); server.kill();
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
