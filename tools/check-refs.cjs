/* ============================================================
 * check-refs.cjs — 校验 index.html 与分割器引用的本地资源真实存在
 * 纯前端无构建步骤，漏文件只会在运行时 404，这里提前拦住。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT, createChecker } = require('./_lib.cjs');

const checker = createChecker();
const assert = checker.assert;

/* 相对路径（非协议/锚点/内联数据）才需要落盘校验 */
function isLocal(ref) {
  return !/^([a-z]+:)?\/\//i.test(ref) && !/^(#|data:|mailto:|javascript:)/i.test(ref);
}

function refsFrom(file, pattern) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = [];
  let m;
  while ((m = pattern.exec(text)) !== null) out.push(m[1]);
  return out;
}

const html = refsFrom('index.html', /(?:src|href)="([^"]+)"/g).filter(isLocal);
assert(html.length >= 12, 'index.html 解析到 ' + html.length + ' 个本地引用');
for (const ref of new Set(html)) {
  assert(fs.existsSync(path.join(ROOT, ref.split('?')[0])), 'index.html 引用存在：' + ref);
}

const vendor = refsFrom('js/segmenter.js', /['"](vendor\/[^'"]+)['"]/g);
assert(vendor.length >= 3, '分割器解析到 ' + vendor.length + ' 个 vendor 路径');
for (const ref of new Set(vendor)) {
  assert(fs.existsSync(path.join(ROOT, ref)), '模型/运行时就位：' + ref);
}

checker.finish();
