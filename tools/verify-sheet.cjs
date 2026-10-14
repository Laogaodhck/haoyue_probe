/* verify-sheet.cjs — 排版模块相纸扩展真机验证：5 种相纸逐个排版出图 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const playwright = require(path.join(
  'C:', 'Users', 'laogao', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'
));
const ROOT = path.join(__dirname, '..');
const PORT = 8435;
const PHOTO = path.join(ROOT, '微信图片_20261013083008_56_356.jpg');

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) })
  });
  await sleep(800);

  const browser = await playwright.chromium.launch({
    executablePath: 'C:\\Users\\laogao\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.goto('http://localhost:' + PORT + '/');
  await page.click('#home-sheet');                 // 进入排版模块（第 1 步：选择模板）
  await page.setInputFiles('#sheet-file-input', PHOTO);
  await sleep(1500);                               // 等图片加载与首版排版

  const info = () => page.$eval('#sheet-info', el => el.textContent);
  // 全画布扫描非白像素数（照片格内容 + 裁切线），避免稀疏采样漏检
  const nonWhite = () => page.$eval('#laysheet-preview', c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255) n++; }
    return n;
  });

  assert((await info()).includes('A4'), '默认相纸 A4：' + (await info()));

  for (const [key, name] of [['b5', 'B5'], ['a5', 'A5'], ['a3', 'A3'], ['6inch', '六寸']]) {
    await page.selectOption('#sheet-paper', key);
    await sleep(400);
    const txt = await info();
    const nw = await nonWhite();
    assert(txt.includes('张') && nw > 50, name + ' 排版出图（非白像素 ' + nw + '）：' + txt.slice(0, 30) + '…');
  }

  // 分步导航：第 1 步 → 第 2 步（导入）→ 第 3 步（预览）→ 第 4 步（打印）
  await page.selectOption('#sheet-paper', 'a4');
  await page.click('#btn-sheet-to-import');
  await sleep(200);
  await page.click('#btn-sheet-to-preview');
  await sleep(300);
  await page.click('#btn-sheet-goto-print');
  await sleep(300);
  await page.selectOption('#print-paper', 'B5');
  await sleep(300);
  const previewOk = await page.$eval('#print-preview-canvas', c => c.width > 100 && c.height > 100);
  assert(previewOk, '打印预览 B5 纸张可渲染');

  assert(pageErrors.length === 0, '无页面脚本错误' + (pageErrors.length ? '：' + pageErrors.join(' | ') : ''));

  await browser.close();
  server.kill();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
