/* ============================================================
 * layout-a4.cjs — 整版照片识别测量 + A4 重排（300DPI）
 * 输入：E:/electron-dist/01.png（既有整版照片）
 * 步骤：
 *   1) 白度投影扫描 → 识别列带/行带 → 得出行列数、单张尺寸、间隙、边距
 *   2) 按带切出每张照片，等比缩放放入 24.3mm×34mm 单元格（禁止拉伸）
 *   3) 网格排列到 A4 210×297mm @300DPI（2480×3508px），输出打印版 PNG
 * 运行：node tools/layout-a4.cjs
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');

const SRC = 'E:/electron-dist/01.png';
const OUT_DIR = 'E:/electron-dist/A4排版输出';

/* ---------- 目标版面常量 ---------- */
const DPI = 300;
const MM = DPI / 25.4;                       // px per mm
const PAGE_W = Math.round(210 * MM);         // 2480
const PAGE_H = Math.round(297 * MM);         // 3508
const CELL_W = Math.round(24.3 * MM);        // 287 px
const CELL_H = Math.round(34 * MM);          // 402 px
const COLS = 7, ROWS = 8;
const GAP_X = Math.round(2.4 * MM);          // 横向间隙 2.4mm = 28px（用户指定）
const MARGIN_TOP = Math.round(5 * MM);       // 上边距 5mm = 59px
/* 纵向间隙由剩余空间均分：297-2*5-8*34 = 15mm → 7 缝 ≈ 2.14mm */
const GAP_Y = Math.floor(((297 - 2 * 5 - ROWS * 34) / (ROWS - 1)) * MM); // 25px ≈ 2.14mm
const CONTENT_W = COLS * CELL_W + (COLS - 1) * GAP_X;
const CONTENT_H = ROWS * CELL_H + (ROWS - 1) * GAP_Y;
const MARGIN_LR = Math.floor((PAGE_W - CONTENT_W) / 2);   // ≈ 94px ≈ 7.95mm
const MARGIN_BT = PAGE_H - MARGIN_TOP - CONTENT_H;        // ≈ 58px ≈ 4.9mm

/* ---------- 带检测：投影 profile → 连续非空白带 ---------- */
function findBands(counts, minCount, minLen) {
  const bands = [];
  let s = -1;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > minCount) {
      if (s < 0) s = i;
    } else if (s >= 0) {
      if (i - s >= minLen) bands.push({ x: s, w: i - s });
      s = -1;
    }
  }
  if (s >= 0 && counts.length - s >= minLen) bands.push({ x: s, w: counts.length - s });
  return bands;
}

function gapsOf(bands) {
  const g = [];
  for (let i = 1; i < bands.length; i++) g.push(bands[i].x - (bands[i - 1].x + bands[i - 1].w));
  return g;
}

(async () => {
  const img = await Jimp.read(SRC);
  const { width: W, height: H, data } = img.bitmap;

  /* 1) 白度投影：非白像素 = 任一通道 < 240 */
  const colCnt = new Uint32Array(W);
  const rowCnt = new Uint32Array(H);
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = row + x * 4;
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) {
        colCnt[x]++; rowCnt[y]++;
      }
    }
  }
  const colBands = findBands(colCnt, 3, 15);
  const rowBands = findBands(rowCnt, 3, 15);
  const srcGapsX = gapsOf(colBands), srcGapsY = gapsOf(rowBands);
  const srcMarginL = colBands[0].x, srcMarginR = W - (colBands[colBands.length - 1].x + colBands[colBands.length - 1].w);
  const srcMarginT = rowBands[0].x, srcMarginB = H - (rowBands[rowBands.length - 1].x + rowBands[rowBands.length - 1].h);
  const cellW0 = colBands[0].w, cellH0 = rowBands[0].w;

  const measure = {
    源图: { 宽: W, 高: H },
    识别结果: {
      行列数: rowBands.length + ' 行 × ' + colBands.length + ' 列 = ' + rowBands.length * colBands.length + ' 张',
      单张px: cellW0 + '×' + cellH0,
      单张宽高比: (cellW0 / cellH0).toFixed(4),
      目标单张比例: (24.3 / 34).toFixed(4),
      源横向间隙px: srcGapsX,
      源纵向间隙px: srcGapsY,
      源边距px: { 左: srcMarginL, 右: srcMarginR, 上: srcMarginT, 下: srcMarginB }
    }
  };

  /* 2) 目标 A4 合成 */
  const page = new Jimp({ width: PAGE_W, height: PAGE_H, color: 0xffffffff });
  let fitted = 0;
  for (let r = 0; r < Math.min(ROWS, rowBands.length); r++) {
    for (let c = 0; c < Math.min(COLS, colBands.length); c++) {
      const cb = colBands[c], rb = rowBands[r];
      const cell = img.clone().crop({ x: cb.x, y: rb.x, w: cb.w, h: rb.w });
      const sw = cell.bitmap.width, sh = cell.bitmap.height;
      const scale = Math.min(CELL_W / sw, CELL_H / sh);   // 等比，禁止拉伸
      const tw = Math.max(1, Math.round(sw * scale));
      const th = Math.max(1, Math.round(sh * scale));
      if (tw !== sw || th !== sh) cell.resize({ w: tw, h: th });
      const ox = MARGIN_LR + c * (CELL_W + GAP_X) + Math.floor((CELL_W - tw) / 2);
      const oy = MARGIN_TOP + r * (CELL_H + GAP_Y) + Math.floor((CELL_H - th) / 2);
      page.composite(cell, ox, oy);
      fitted++;
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPng = path.join(OUT_DIR, 'A4排版-打印版-300dpi.png');
  await page.write(outPng);

  const layout = {
    目标A4: {
      页面: '210×297mm @300DPI（' + PAGE_W + '×' + PAGE_H + 'px）',
      行列数: COLS + ' 列 × ' + ROWS + ' 行 = ' + COLS * ROWS + ' 张（已放置 ' + fitted + ' 张）',
      单张: '24.3×34mm（' + CELL_W + '×' + CELL_H + 'px），等比缩放无拉伸',
      横向间隙: (GAP_X / MM).toFixed(2) + 'mm（' + GAP_X + 'px）',
      纵向间隙: (GAP_Y / MM).toFixed(2) + 'mm（' + GAP_Y + 'px）',
      边距: {
        左右: (MARGIN_LR / MM).toFixed(2) + 'mm（' + MARGIN_LR + 'px）',
        上: (MARGIN_TOP / MM).toFixed(2) + 'mm（' + MARGIN_TOP + 'px）',
        下: (MARGIN_BT / MM).toFixed(2) + 'mm（' + MARGIN_BT + 'px）'
      },
      版心: (CONTENT_W / MM).toFixed(1) + '×' + (CONTENT_H / MM).toFixed(1) + 'mm'
    }
  };
  console.log(JSON.stringify(Object.assign(measure, layout), null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'measure.json'), JSON.stringify(Object.assign(measure, layout), null, 1));
  console.log('PNG => ' + outPng);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
