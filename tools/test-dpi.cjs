/* dpi.js 单元测试：PNG pHYs 注入/替换 + JPEG JFIF 密度修补/插入 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// 以经典脚本方式加载 dpi.js（模拟 window）
global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'dpi.js'), 'utf8'));
const DpiUtil = global.window.DpiUtil;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}

/* Node Buffer 底层是内存池视图，转成独立 ArrayBuffer 模拟浏览器 blob.arrayBuffer() */
function toAb(buf) {
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return ab;
}

/* ---------- 构造假 PNG: sig + IHDR(13B) + IDAT(4B) + IEND ---------- */
function makePng(withPhys) {
  const chunks = [];
  function chunk(type, data) {
    const buf = Buffer.alloc(8 + data.length + 4);
    buf.writeUInt32BE(data.length, 0);
    buf.write(type, 4, 'ascii');
    data.copy(buf, 8);
    const crc = zlib.crc32(buf.subarray(4, 8 + data.length));
    buf.writeUInt32BE(crc >>> 0, 8 + data.length);
    return buf;
  }
  const ihdr = chunk('IHDR', Buffer.alloc(13));
  chunks.push(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), ihdr);
  if (withPhys) chunks.push(chunk('pHYs', Buffer.alloc(9)));
  chunks.push(chunk('IDAT', Buffer.from([1, 2, 3, 4])));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function findPhys(buf) {
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'pHYs') {
      return {
        ppmX: buf.readUInt32BE(pos + 8),
        ppmY: buf.readUInt32BE(pos + 12),
        unit: buf[pos + 16],
        crc: buf.readUInt32BE(pos + 17)
      };
    }
    pos += 12 + len;
  }
  return null;
}

const DPI = 300;
const PPM = Math.round(DPI / 0.0254); // 11811

console.log('[PNG] 注入 pHYs（无已有块）');
{
  const src = makePng(false);
  const out = Buffer.from(DpiUtil.setPngDpi(toAb(src), DPI));
  assert(out.length === src.length + 21, '长度 +21');
  const phys = findPhys(out);
  assert(phys && phys.ppmX === PPM && phys.ppmY === PPM && phys.unit === 1, 'pHYs 值正确 (11811)');
  const recomputed = zlib.crc32(out.subarray(findPhys(out) ? posOfPhys(out) + 4 : 0, posOfPhys(out) + 17));
  assert(recomputed >>> 0 === phys.crc, 'pHYs CRC 校验通过');
  // IDAT 完整性
  let pos = 8, types = [];
  while (pos + 8 <= out.length) {
    const len = out.readUInt32BE(pos);
    types.push(out.toString('ascii', pos + 4, pos + 8));
    pos += 12 + len;
  }
  assert(JSON.stringify(types) === JSON.stringify(['IHDR', 'pHYs', 'IDAT', 'IEND']), 'chunk 顺序保持');
}

console.log('[PNG] 替换已有 pHYs');
{
  const src = makePng(true);
  const out = Buffer.from(DpiUtil.setPngDpi(toAb(src), DPI));
  const phys = findPhys(out);
  assert(phys && phys.ppmX === PPM, '旧 pHYs 已被替换');
  let pos = 8, count = 0, types = [];
  while (pos + 8 <= out.length) {
    const len = out.readUInt32BE(pos);
    types.push(out.toString('ascii', pos + 4, pos + 8));
    if (out.toString('ascii', pos + 4, pos + 8) === 'pHYs') count++;
    pos += 12 + len;
  }
  assert(count === 1, '只有一个 pHYs');
  assert(types[types.length - 1] === 'IEND', 'IEND 仍在末尾');
}

function posOfPhys(buf) {
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    if (buf.toString('ascii', pos + 4, pos + 8) === 'pHYs') return pos;
    pos += 12 + len;
  }
  return -1;
}

console.log('[JPEG] 无 APP0 → 插入');
{
  const src = Buffer.concat([Buffer.from([0xFF, 0xD8]), Buffer.from([0xFF, 0xDB]), Buffer.from([1, 2, 3])]);
  const out = Buffer.from(DpiUtil.setJpegDpi(toAb(src), DPI));
  assert(out.length === src.length + 18, '长度 +18');
  assert(out[2] === 0xFF && out[3] === 0xE0, 'APP0 标记正确');
  assert(out.toString('ascii', 6, 10) === 'JFIF', 'JFIF 标识正确');
  assert(out[13] === 1, '密度单位 = 英寸');
  assert(out.readUInt16BE(14) === DPI && out.readUInt16BE(16) === DPI, '密度 = 300');
  assert(out[18] === 0 && out[19] === 0, '无缩略图');
  assert(out[20] === 0xFF && out[21] === 0xDB, '原 DQT 数据保留');
}

console.log('[JPEG] 已有 APP0 → 修补');
{
  // 完整 APP0: FF E0 0010 "JFIF\0" ver(01 01) units(00) X(00 01) Y(00 01) thumb(00 00)
  const src = Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xFF, 0xDA, 0x09, 0x0A])
  ]);
  const out = Buffer.from(DpiUtil.setJpegDpi(toAb(src), 350));
  assert(out.length === src.length, '长度不变');
  assert(out[13] === 1 && out.readUInt16BE(14) === 350 && out.readUInt16BE(16) === 350, '密度改为 350');
  assert(out.readUInt16BE(out.length - 2) === 0x090A, '后续数据保留');
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
