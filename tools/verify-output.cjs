/* 验证下载产物中的 DPI 元数据与尺寸 */
'use strict';
const fs = require('fs');

function phys(buf) {
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    if (buf.toString('ascii', pos + 4, pos + 8) === 'pHYs') {
      return { x: buf.readUInt32BE(pos + 8), y: buf.readUInt32BE(pos + 12), u: buf[pos + 16] };
    }
    pos += 12 + len;
  }
  return null;
}

const s = fs.readFileSync(__dirname + '/../.playwright-cli/out-single.png');
const dpi = phys(s);
console.log('single:', s.length, 'bytes;',
  'size:', s.readUInt32BE(16) + 'x' + s.readUInt32BE(20),
  '; pHYs:', JSON.stringify(dpi),
  '=> DPI:', dpi ? Math.round(dpi.x * 0.0254) : 'NONE');

const sh = fs.readFileSync(__dirname + '/../.playwright-cli/out-sheet.png');
const dpi2 = phys(sh);
console.log('sheet:', sh.length, 'bytes;',
  'size:', sh.readUInt32BE(16) + 'x' + sh.readUInt32BE(20),
  '; pHYs:', JSON.stringify(dpi2),
  '=> DPI:', dpi2 ? Math.round(dpi2.x * 0.0254) : 'NONE');
