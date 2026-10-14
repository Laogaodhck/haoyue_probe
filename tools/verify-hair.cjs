/* ============================================================
 * verify-hair.cjs — 头发/白衣服增强 真机验证
 * 真实照片走完整本地 AI 流程，切红底后统计：
 *   1. 四角为背景（不外溢）
 *   2. 整体前景占比合理
 *   3. 头发带（0.12–0.32H）前景占比达标（增强后不被切掉）
 *   4. 衣服带（0.55–0.95H）前景占比达标（白衣服不被裁）
 *   5. 管线无脚本错误
 * ============================================================ */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const playwright = require(path.join(
  'C:', 'Users', 'laogao', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright'
));

const ROOT = path.join(__dirname, '..');
const PORT = 8433;
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

  const t0 = Date.now();
  await page.goto('http://localhost:' + PORT + '/');
  await page.click('#home-photo');
  await page.setInputFiles('#file-input', PHOTO);
  await page.waitForSelector('#step-matte.active', { timeout: 90000 });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('  (管线耗时 ' + elapsed + 's)');

  // 切红底：前景=非纯红像素，背景=纯红
  await page.click('.swatch[data-color="#FF0000"]');
  await sleep(300);

  const stats = await page.evaluate(() => {
    const c = document.getElementById('matte-view');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const W = c.width, H = c.height;
    const isRed = (i) => d[i * 4] === 255 && d[i * 4 + 1] === 0 && d[i * 4 + 2] === 0;
    function bandRatio(y0f, y1f, x0f, x1f) {
      let fg = 0, n = 0;
      const y0 = Math.round(H * y0f), y1 = Math.round(H * y1f);
      const x0 = Math.round(W * x0f), x1 = Math.round(W * x1f);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        n++; if (!isRed(y * W + x)) fg++;
      }
      return n ? fg / n : 0;
    }
    return {
      corner: [isRed(0), isRed(W - 1), isRed((H - 1) * W), isRed(H * W - 1)],
      total: bandRatio(0, 1, 0, 1),
      hairBand: bandRatio(0.12, 0.32, 0.25, 0.75),
      clothesBand: bandRatio(0.55, 0.95, 0.15, 0.85),
      topEdge: bandRatio(0, 0.04, 0, 1)   // 顶边应基本是背景
    };
  });
  console.log('  统计:', JSON.stringify(stats));

  assert(stats.corner.every(v => v), '四角均为背景（红色）');
  assert(stats.total > 0.08 && stats.total < 0.85, '整体前景占比合理（' + (stats.total * 100).toFixed(1) + '%）');
  assert(stats.hairBand > 0.15, '头发带前景占比 ' + (stats.hairBand * 100).toFixed(1) + '% ≥ 15%（发丝保留）');
  assert(stats.clothesBand > 0.25, '衣服带前景占比 ' + (stats.clothesBand * 100).toFixed(1) + '% ≥ 25%（衣服完整）');
  assert(stats.topEdge < 0.5, '顶边背景不被误吞（' + (stats.topEdge * 100).toFixed(1) + '%）');
  assert(pageErrors.length === 0, '无页面脚本错误' + (pageErrors.length ? '：' + pageErrors.join(' | ') : ''));

  await browser.close();
  server.kill();

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
