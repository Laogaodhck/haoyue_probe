/* ============================================================
 * _probe-import.cjs — 批量导入进度条真机探针（临时验证脚本）
 * 验证：1) 导入后最终文案只报总数不列文件名 2) 进度条满格后自动收起
 * 运行：node tools/_probe-import.cjs
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle' });
  await page.click('#home-sheet');

  // 生成 3 张真实小 PNG（1×1 蓝色像素）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  const files = [1, 2, 3].map((i) => ({ name: '测试照片' + i + '.png', mimeType: 'image/png', buffer: png }));
  await page.setInputFiles('#sheet-file-input', files);

  // 最终态：满格 + 总数文案（不列文件名）
  await page.waitForFunction(() => {
    const el = document.getElementById('sheet-import-text');
    return el && /已导入 3 张/.test(el.textContent);
  }, { timeout: 8000 });
  const width = await page.$eval('#sheet-import-bar', (el) => el.style.width);
  assert.strictEqual(width, '100%', '进度条满格 100%');
  const nameText = await page.$eval('#sheet-file-name', (el) => el.textContent);
  assert.strictEqual(nameText, '已导入 3 张', '状态区只报总数（实际：' + nameText + '）');
  assert.ok(nameText.indexOf('测试照片') === -1, '不再罗列文件名');

  // 1.2s 后进度条自动收起
  await page.waitForFunction(() => document.getElementById('sheet-import-progress').hidden === true, { timeout: 4000 });
  assert.ok(true, '进度条满格停留后自动收起');

  // 连续第二批导入：进度条重新出现并正常工作
  await page.setInputFiles('#sheet-file-input', files);
  await page.waitForFunction(() => {
    const el = document.getElementById('sheet-import-text');
    return el && /已导入 3 张/.test(el.textContent);
  }, { timeout: 8000 });
  const nameText2 = await page.$eval('#sheet-file-name', (el) => el.textContent);
  assert.strictEqual(nameText2, '已导入 6 张', '累加导入总数正确（实际：' + nameText2 + '）');

  assert.deepStrictEqual(errors, [], '无页面脚本错误' + (errors.length ? '：' + errors.join(' | ') : ''));
  await browser.close(); close();
  console.log('结果: 5 通过, 0 失败');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
