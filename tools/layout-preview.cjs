/* ============================================================
 * layout-preview.cjs — 生成带尺寸标注的 A4 排版预览 HTML
 * SVG 覆盖层以 mm 为坐标系（viewBox 0 0 210 297），标注与实际
 * 打印尺寸 1:1 对应；@page A4 margin:0 可直接打印。
 * 运行：node tools/layout-preview.cjs
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = 'E:/electron-dist/A4排版输出';
const PNG = path.join(DIR, 'A4排版-打印版-300dpi.png');
const OUT = path.join(DIR, 'A4排版-标注预览.html');

/* 与 layout-a4.cjs 一致的版面数值（mm） */
const CELL_W = 24.3, CELL_H = 34;
const GAP_X = 2.37, GAP_Y = 2.12;        // 2.4mm 目标经像素取整（28px）
const M_LR = 12.78, M_T = 5.0, M_B = 4.91;
const COLS = 7, ROWS = 8, N = COLS * ROWS;
const CONTENT_W = COLS * CELL_W + (COLS - 1) * GAP_X;   // 194.0
const CONTENT_H = ROWS * CELL_H + (ROWS - 1) * GAP_Y;   // 287.1

const png64 = 'data:image/png;base64,' + fs.readFileSync(PNG).toString('base64');

/* ---------- SVG 标注构件（mm 坐标） ---------- */
function dimH(x1, x2, y, label, color) {
  return `<g stroke="${color}" stroke-width="0.18" fill="none">
    <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/>
    <line x1="${x1}" y1="${y - 0.9}" x2="${x1}" y2="${y + 0.9}"/>
    <line x1="${x2}" y1="${y - 0.9}" x2="${x2}" y2="${y + 0.9}"/>
    <text x="${(x1 + x2) / 2}" y="${y - 0.7}" text-anchor="middle" font-size="2.6" fill="${color}" stroke="none">${label}</text>
  </g>`;
}
function dimV(y1, y2, x, label, color) {
  return `<g stroke="${color}" stroke-width="0.18" fill="none">
    <line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/>
    <line x1="${x - 0.9}" y1="${y1}" x2="${x + 0.9}" y2="${y1}"/>
    <line x1="${x - 0.9}" y1="${y2}" x2="${x + 0.9}" y2="${y2}"/>
    <text x="${x + 1.1}" y="${(y1 + y2) / 2 + 0.9}" font-size="2.6" fill="${color}" stroke="none">${label}</text>
  </g>`;
}

const yProbe = M_T + CELL_H / 2;                 // 行 1 中线
const xProbe = M_LR + CELL_W / 2;                // 列 1 中线
const yGapV = M_T + CELL_H + GAP_Y / 2;          // 行 1-2 间隙中线

const svg = `
<svg id="anno" viewBox="0 0 210 297" xmlns="http://www.w3.org/2000/svg">
  <rect x="0.3" y="0.3" width="209.4" height="296.4" fill="none" stroke="#e11d48" stroke-width="0.3" stroke-dasharray="2.5 1.5"/>
  <rect x="${M_LR}" y="${M_T}" width="${CONTENT_W}" height="${CONTENT_H}" fill="none" stroke="#2563eb" stroke-width="0.25" stroke-dasharray="1.5 1"/>
  <rect x="${M_LR}" y="${M_T}" width="${CELL_W}" height="${CELL_H}" fill="none" stroke="#e11d48" stroke-width="0.35"/>
  <text x="${M_LR + CELL_W / 2}" y="${M_T + CELL_H / 2 - 2}" text-anchor="middle" font-size="3" fill="#e11d48" font-weight="bold">① 单张</text>
  <text x="${M_LR + CELL_W / 2}" y="${M_T + CELL_H / 2 + 1.8}" text-anchor="middle" font-size="3" fill="#e11d48" font-weight="bold">24.3 × 34 mm</text>
  ${dimH(M_LR + CELL_W, M_LR + CELL_W + GAP_X, yProbe, GAP_X.toFixed(1), '#059669')}
  ${dimV(M_T + CELL_H, M_T + CELL_H + GAP_Y, M_LR + CELL_W + 2, GAP_Y.toFixed(2), '#059669')}
  ${dimH(0, M_LR, 18, '边距 ' + M_LR.toFixed(1), '#d97706')}
  ${dimV(0, M_T, 12, M_T.toFixed(1), '#d97706')}
  ${dimH(0, CONTENT_W, 293, '版心 ' + CONTENT_W.toFixed(1) + ' mm', '#2563eb')}
  <text x="105" y="291.5" text-anchor="middle" font-size="4.2" fill="#111" font-weight="bold">${COLS} 列 × ${ROWS} 行 = ${N} 张 · A4 210×297mm · 照片等比无拉伸</text>
</svg>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>A4 排版标注预览 · ${N} 张 · 24.3×34mm</title>
<style>
  @page { size: A4; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #3a3f4b; font-family: "Microsoft YaHei", sans-serif; }
  .toolbar {
    position: sticky; top: 0; z-index: 9; display: flex; gap: 14px; align-items: center;
    padding: 10px 18px; background: #1f2430; color: #e5e9f2; font-size: 14px;
  }
  .toolbar b { color: #7cc4ff; }
  .toolbar label { cursor: pointer; user-select: none; }
  .sheet-wrap { display: flex; justify-content: center; padding: 18px 0 40px; }
  .sheet { position: relative; width: 210mm; min-height: 297mm; background: #fff;
           box-shadow: 0 6px 30px rgba(0,0,0,.5); }
  .sheet img { display: block; width: 210mm; height: 297mm; }
  .sheet svg { position: absolute; inset: 0; width: 210mm; height: 297mm; }
  body.no-anno #anno { display: none; }
  @media print {
    .toolbar { display: none; }
    body { background: #fff; }
    .sheet-wrap { padding: 0; }
    .sheet { box-shadow: none; }
  }
</style>
</head>
<body>
<div class="toolbar">
  <span><b>A4 排版预览</b>｜${COLS} 列 × ${ROWS} 行 = ${N} 张｜单张 24.3×34mm｜横隙 2.37mm（2.4mm 档）｜纵隙 2.12mm｜边距 左右12.78 / 上5.0 / 下4.9mm</span>
  <label><input type="checkbox" id="tg" checked> 显示标注</label>
  <button onclick="window.print()" style="padding:4px 14px;cursor:pointer">打印（输出为无标注净版）</button>
</div>
<div class="sheet-wrap"><div class="sheet">
  <img src="${png64}" alt="A4 排版">
  ${svg}
</div></div>
<script>
  document.getElementById('tg').addEventListener('change', function () {
    document.body.classList.toggle('no-anno', !this.checked);
  });
</script>
</body>
</html>`;

fs.writeFileSync(OUT, html);
console.log('HTML => ' + OUT + '（' + (fs.statSync(OUT).size / 1048576).toFixed(1) + ' MB）');
