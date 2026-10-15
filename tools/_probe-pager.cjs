console.log("MARK");/* ============================================================
 * _probe-pager.cjs — 页码按钮列表真机探针（临时验证脚本）
 * 验证：1) 多页时按钮列表出现、当前页高亮 2) 点击切换同步预览与打印步
 *       3) 页数多时省略号收窄（首/末/当前±1）4) 单页时隐藏
 * 运行：node tools/_probe-pager.cjs
 * ============================================================ */
'use strict';

const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const { createStaticServer } = require('../electron/static-server');

(async () => {
  const root = path.join(__dirname, '..');
  const { port, close } = await createStaticServer(root);
  const browser = await chromium.launch({
    executablePath: 'C:\\Users\\laogao\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle' });
  await page.click('#home-sheet');

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  const mkFiles = (n) => Array.from({ length: n }, (_, i) => ({ name: '照片' + (i + 1) + '.png', mimeType: 'image/png', buffer: png }));

  console.log("MARK");/* 1. 单页（3 张 × 1 份）：页码列表隐藏 */
  await page.click('#btn-sheet-to-import');   // 进入导入步（后续点击需要面板激活）
  await page.setInputFiles('#sheet-file-input', mkFiles(3));
  await page.waitForFunction(() => /已导入 3 张/.test(document.getElementById('sheet-file-name').textContent), { timeout: 8000 });
  assert.ok(await page.$eval('#sheet-pager', (el) => el.hidden), '单页时排版页码列表隐藏');

  console.log("MARK");/* 2. 多页（200 张 × 4 份 → 与已有 3 张累加 203×4=812 格 → 17 页）：按钮列表出现，首页高亮，省略号收窄 */
  await page.setInputFiles('#sheet-file-input', mkFiles(200));
  await page.waitForFunction(() => /已导入 200 张/.test(document.getElementById('sheet-import-text').textContent), { timeout: 20000 });
  await page.$eval('#sheet-count', (el) => { el.value = '4'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.click('#btn-sheet-to-preview');  // 进入预览步（页码按钮在此面板）
  await page.waitForFunction(() => {
    const nav = document.getElementById('sheet-pager');
    return !nav.hidden && nav.querySelectorAll('.pager-btn').length >= 3;
  }, { timeout: 20000 });
  let btns = await page.$$eval('#sheet-pager > *', (els) => els.map((e) => e.textContent));
  assert.deepStrictEqual(btns, ['1', '2', '…', '17'], '17 页时显示 [1, 2, …, 17]（实际：' + btns.join(',') + '）');
  let active = await page.$eval('#sheet-pager .pager-btn.active', (el) => el.textContent);
  assert.strictEqual(active, '1', '当前页（第 1 页）高亮');

  console.log("MARK");/* 3. 点击切换：高亮移动、末页态显示 [1, …, 16, 17] */
  await page.click('#sheet-pager .pager-btn:last-child');
  btns = await page.$$eval('#sheet-pager > *', (els) => els.map((e) => e.textContent));
  assert.deepStrictEqual(btns, ['1', '…', '16', '17'], '切到末页后显示 [1, …, 16, 17]（实际：' + btns.join(',') + '）');
  active = await page.$eval('#sheet-pager .pager-btn.active', (el) => el.textContent);
  assert.strictEqual(active, '17', '当前页（第 17 页）高亮');

  console.log("MARK");/* 4. 打印步：打印预览使用同一份页码列表且状态同步 */
  await page.click('#btn-sheet-goto-print');
  await page.waitForSelector('#sheetstep-print.active', { timeout: 5000 });
  const pBtns = await page.$$eval('#print-pager > *', (els) => els.map((e) => e.textContent));
  assert.deepStrictEqual(pBtns, ['1', '…', '16', '17'], '打印步页码列表与排版步一致');
  const pActive = await page.$eval('#print-pager .pager-btn.active', (el) => el.textContent);
  assert.strictEqual(pActive, '17', '打印步高亮同步在第 17 页');

  console.log("MARK");/* 5. 打印步点击第 1 页：两处列表同步高亮 */
  await page.click('#print-pager .pager-btn:first-child');
  const a1 = await page.$eval('#print-pager .pager-btn.active', (el) => el.textContent);
  const a2 = await page.$eval('#sheet-pager .pager-btn.active', (el) => el.textContent);
  assert.strictEqual(a1, '1', '打印步切到第 1 页');
  assert.strictEqual(a2, '1', '排版步高亮同步为第 1 页');

  assert.deepStrictEqual(errors, [], '无页面脚本错误' + (errors.length ? '：' + errors.join(' | ') : ''));
  await browser.close(); close();
  console.log('结果: 8 通过, 0 失败');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message.split('\n')[0], '\nAT:', (e.stack || '').split('\n').filter(l => l.includes('_probe-pager')).slice(0, 2).join(' | ')); process.exit(1); });
