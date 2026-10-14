/* 生成 Electron/NSIS 所需图标：多尺寸 PNG + 多尺寸 ICO（PNG 条目） */
'use strict';
const fs = require('fs');
const path = require('path');
const Jimp = require(path.join(
  'C:', 'Users', 'laogao', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'jimp'
));

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'src-icon.png');
const SIZES = [256, 128, 64, 48, 32, 24, 16];

(async () => {
  const src = await Jimp.read(SRC);
  console.log('源图:', src.bitmap.width + 'x' + src.bitmap.height);

  const pngs = [];
  for (const size of SIZES) {
    const img = src.clone().resize(size, size, Jimp.RESIZE_BICUBIC);
    const buf = await img.getBufferAsync(Jimp.MIME_PNG);
    pngs.push({ size, buf });
    if (size === 256) {
      fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), buf);
    }
  }

  // 组装 ICO：6 字节头 + N×16 目录项 + 数据
  const count = pngs.length;
  const headerSize = 6 + 16 * count;
  const totalSize = headerSize + pngs.reduce((s, p) => s + p.buf.length, 0);
  const ico = Buffer.alloc(totalSize);
  let off = 0;

  ico.writeUInt16LE(0, off); off += 2;   // reserved
  ico.writeUInt16LE(1, off); off += 2;   // type: icon
  ico.writeUInt16LE(count, off); off += 2;

  let dataOff = headerSize;
  for (const p of pngs) {
    ico[off++] = p.size === 256 ? 0 : p.size; // width (0 = 256)
    ico[off++] = p.size === 256 ? 0 : p.size; // height
    ico[off++] = 0;   // 调色板色数
    ico[off++] = 0;   // reserved
    ico.writeUInt16LE(1, off); off += 2;   // planes
    ico.writeUInt16LE(32, off); off += 2;  // bpp
    ico.writeUInt32LE(p.buf.length, off); off += 4;
    ico.writeUInt32LE(dataOff, off); off += 4;
    p.buf.copy(ico, dataOff);
    dataOff += p.buf.length;
  }
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.ico'), ico);
  console.log('icon.ico:', totalSize, 'bytes,', count, '个尺寸; icon.png 256px 已生成');
})().catch(e => { console.error(e); process.exit(1); });
