/* ============================================================
 * test-print-route.cjs — 打印内存路由单元测试（纯 Node，无 GUI）
 * 验证 createStaticServer 的 memoryPages 路由：
 *   1) 内存路由可返回 >2MB 的 HTML（data: URL 的 2MB 上限场景）
 *   2) Content-Type / Cache-Control 正确
 *   3) 未命中的路径回退文件服务，不影响正常静态资源
 * 运行：node tools/test-print-route.cjs
 * ============================================================ */
'use strict';

const http = require('http');
const assert = require('assert');
const path = require('path');
const { createStaticServer } = require('../electron/static-server');

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

(async () => {
  const root = path.join(__dirname, '..');
  const printPages = new Map();
  const { port, close } = await createStaticServer(root, printPages);

  /* 1. 内存路由：3.2MB HTML（模拟 A4 300DPI 打印页，超 data: URL 2MB 上限） */
  const bigImg = 'data:image/png;base64,' + Buffer.alloc(2.4 * 1024 * 1024).toString('base64');
  const html = '<!DOCTYPE html><html><body><img src="' + bigImg + '"></body></html>';
  printPages.set('/__print__/tok1', html);
  const r1 = await get(port, '/__print__/tok1');
  assert.strictEqual(r1.status, 200, '内存路由返回 200');
  assert.strictEqual(r1.body.length, Buffer.byteLength(html), '大 HTML 完整返回（>2MB 无截断）');
  assert.ok(r1.body.toString().indexOf('data:image/png;base64,') !== -1, 'base64 内容完整');
  assert.strictEqual(r1.headers['content-type'], 'text/html; charset=utf-8', 'Content-Type 正确');
  assert.strictEqual(r1.headers['cache-control'], 'no-store', 'Cache-Control no-store');

  /* 2. 路由删除后 404（打印完成清理 token，防重放） */
  printPages.delete('/__print__/tok1');
  const r2 = await get(port, '/__print__/tok1');
  assert.strictEqual(r2.status, 404, 'token 清理后回退文件服务（不存在 → 404）');

  /* 3. 正常静态文件不受影响 */
  const r3 = await get(port, '/');
  assert.strictEqual(r3.status, 200, '静态文件服务正常');
  assert.ok(r3.body.toString().indexOf('<!DOCTYPE html>') !== -1, 'index.html 内容正确');

  /* 4. 同端口多 token 并存 */
  printPages.set('/__print__/a', '<html>a</html>');
  printPages.set('/__print__/b', '<html>b</html>');
  assert.strictEqual((await get(port, '/__print__/a')).body.toString(), '<html>a</html>', 'token A');
  assert.strictEqual((await get(port, '/__print__/b')).body.toString(), '<html>b</html>', 'token B');

  close();
  console.log('结果: 8 通过, 0 失败');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
