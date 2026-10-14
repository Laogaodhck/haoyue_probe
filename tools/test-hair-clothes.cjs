/* ============================================================
 * test-hair-clothes.cjs — 分类感知增强（头发/白衣服）纯算法直测
 * 直测 Matting._test，不依赖 DOM/模型
 * ============================================================ */
'use strict';
global.window = {};
eval(require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'segmenter.js'), 'utf8'));
var T = window.Matting._test;

var pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}

/* ---------- 1. 滞后阈值：gain 关闭（回归旧行为） ---------- */
var conf = new Float32Array([0.6, 0.30, 0.28, 0, 0]); // 中间 0.30<0.35 弱阈值以下 → 断链
var bin = T.hysteresisBin(conf, 5, 1, 0.5, 0.35);
assert(bin[0] === 1 && bin[1] === 0 && bin[2] === 0, '无 gain：弱阈值以下像素断链丢弃（旧行为回归）');

/* ---------- 2. 滞后阈值：分类 gain 降低门槛后连通保留 ---------- */
var gain = new Float32Array([0, 0.10, 0.10, 0, 0]);
var bin2 = T.hysteresisBin(conf, 5, 1, 0.5, 0.35, gain); // 有效弱阈值 0.25
assert(bin2[0] === 1 && bin2[1] === 1 && bin2[2] === 1, 'gain=0.10：0.30/0.28 连通生长保留（头发/白衣增益路径）');

/* ---------- 3. gain 钳制与下限 ---------- */
var gain2 = new Float32Array([0.9, 0, 0, 0, 0]); // 0.5-0.9 → 下限 0.15
var bin3 = T.hysteresisBin(new Float32Array([0.16, 0, 0, 0, 0]), 5, 1, 0.5, 0.35, gain2);
assert(bin3[0] === 1, 'gain 过大时有效阈值钳制下限 0.15');

/* ---------- 4. classBoost（Float32Array 存在 32 位精度，用容差比较） ---------- */
var EPS = 1e-6;
var c1 = new Float32Array([0.40, 0.90, 0.40]);
var hair = new Float32Array([0.50, 0.50, 0.20]);   // 前两个头发主导
var clothes = new Float32Array([0, 0, 0.45]);       // 第三个衣服主导
T.classBoost(c1, hair, clothes);
assert(Math.abs(c1[0] - Math.min(1, 0.5 * 1.3)) < EPS && c1[0] > 0.4, '头发 0.5 → 置信度提升到 0.65');
assert(Math.abs(c1[1] - 0.90) < EPS, '已高置信度不被增益覆盖');
assert(Math.abs(c1[2] - Math.min(1, 0.45 * 1.25)) < EPS && c1[2] > 0.4, '衣服 0.45 → 置信度提升到 0.5625（白衣服）');
var c2 = new Float32Array([0.40]);
T.classBoost(c2, null, null);
assert(Math.abs(c2[0] - 0.40) < EPS, '二分类回退模型：classBoost 直通');

/* ---------- 5. classGain ---------- */
var g1 = T.classGain(new Float32Array([0.5]), new Float32Array([0.6]));
assert(Math.abs(g1[0] - (0.05 + 0.09)) < 1e-5, 'gain = hair*0.10 + clothes*0.15');
var g2 = T.classGain(new Float32Array([1]), new Float32Array([1]));
assert(Math.abs(g2[0] - 0.15) < EPS, 'gain 上限钳制 0.15');

/* ---------- 6. 中值滤波：头发区宽容保细丝 ---------- */
// 5x5 全 0，中间列 y1..y3 为 1（1px 竖线）
function lineBin() {
  var b = new Uint8Array(25);
  b[1 * 5 + 2] = 1; b[2 * 5 + 2] = 1; b[3 * 5 + 2] = 1;
  return b;
}
var b1 = T.medianFilter3(lineBin(), 5, 5);
assert(b1[2 * 5 + 2] === 0, '无 hairMask：5/9 多数票切掉 1px 细丝（旧行为回归）');
var hm = new Uint8Array(25);
hm[1 * 5 + 2] = 1; hm[2 * 5 + 2] = 1; hm[3 * 5 + 2] = 1;
var b2 = T.medianFilter3(lineBin(), 5, 5, hm);
assert(b2[2 * 5 + 2] === 1, 'hairMask：3/9 宽容多数票保留发丝中心');
assert(b2[1 * 5 + 2] === 0 && b2[3 * 5 + 2] === 0, 'hairMask：不足 3 票的端点仍修剪');

/* ---------- 7. 组合管线冒烟：boost + gain 联动（模拟白衣区域） ---------- */
// 7x1：人物主体(0.9) | 白衣过渡(0.30) | 白衣(0.32) | 白衣(0.32) | 背景(0.05)...
var confW = new Float32Array([0.9, 0.30, 0.32, 0.32, 0.05, 0.05, 0.05]);
var clothesW = new Float32Array([0.05, 0.5, 0.6, 0.6, 0.02, 0.02, 0.02]);
var hairW = new Float32Array(7);
T.classBoost(confW, hairW, clothesW);
var gainW = T.classGain(hairW, clothesW);
var binW = T.hysteresisBin(confW, 7, 1, 0.5, 0.35, gainW);
assert(binW[1] === 1 && binW[2] === 1 && binW[3] === 1, '白衣服区域：boost+gain 后与主体连通保留');
assert(binW[4] === 0 && binW[5] === 0, '真背景仍被丢弃（不外溢）');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
