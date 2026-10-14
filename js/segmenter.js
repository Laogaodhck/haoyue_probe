/* ============================================================
 * segmenter.js — 人像分割（MediaPipe Image Segmenter，本地 WASM 推理）
 * 优先 selfie_multiclass_256x256（背景/头发/皮肤/衣服六分类，边缘更准），
 * 加载失败自动回退 selfie_segmenter（人/背景二分类）。
 *
 * 精准度增强管线（全部本地推理，断网可用）：
 *   1) 粗分割：整图一次推理，得到全图人像置信度锚点
 *   2) 高分辨率分块精修：大图切 512px 重叠瓦片逐块推理，
 *      模型内部仅把单块缩到 256 而非整图缩到 256，
 *      发丝/衣缘等细节有效分辨率成倍提升；
 *      瓦片按到边距离加权融入粗分割结果（过渡平滑无接缝）
 *   3) 分类感知增强（多分类模型的头发/衣服专属通道）：
 *      头发主导像素置信度 ×1.3、衣服主导 ×1.25（白衣服与浅背景难分，
 *      模型置信度天然偏低），配合滞后阈值逐像素下调，把发丝/白衣
 *      拉回二值化可达区间；头发区再用小半径导向滤波吸附单根发丝、
 *      中值滤波放宽为 3/9 多数票防止细丝被切
 *   4) 遮罩清理：滞后阈值二值化（无灰晕，弱阈值连通生长）→ 3×3 多数值滤波去噪点
 *      → 连通域清理（保留最大人像域 + 面积达 3% 的次级域如合影第二人）
 *      → 孔洞填充（被身体包围的背景洞全部补齐）
 * 依赖 vendor/mediapipe/vision_bundle.iife.js 暴露的 window.__mpVision
 * 输出：workCanvas（限边工作图）+ maskCanvas（白色=人像，透明=背景）
 * ============================================================ */
'use strict';

window.Matting = (function () {

  var segmenter = null;
  var initPromise = null;
  var MAX_DIM = 1600;      // 工作图长边上限（控制内存与性能）
  var TILE = 512;          // 精修瓦片边长
  var OVERLAP = 96;        // 瓦片重叠宽度（加权融合过渡带）
  var TILED_MIN = 800;     // 长边超过该值才启用分块精修

  function vision() {
    if (!window.__mpVision) {
      throw new Error('MediaPipe 运行时未加载');
    }
    return window.__mpVision;
  }

  function createSegmenter(modelPath) {
    return vision().FilesetResolver
      .forVisionTasks('vendor/mediapipe/wasm')
      .then(function (fileset) {
        return vision().ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: modelPath },
          runningMode: 'IMAGE',
          outputConfidenceMasks: true,
          outputCategoryMask: false
        });
      });
  }

  function init() {
    if (initPromise) return initPromise;
    initPromise = createSegmenter('vendor/mediapipe/models/selfie_multiclass_256x256.tflite')
      .catch(function (e) {
        // 多分类模型（头发/皮肤/衣服细分，边缘更准）加载失败时回退基础模型
        console.warn('多分类模型加载失败，回退基础分割模型:', e);
        return createSegmenter('vendor/mediapipe/models/selfie_segmenter.tflite');
      })
      .then(function (s) { segmenter = s; });
    return initPromise;
  }

  function isReady() { return segmenter !== null; }

  /* 原图 → 限边工作图 */
  function makeWorkCanvas(image) {
    var w = image.naturalWidth || image.width;
    var h = image.naturalHeight || image.height;
    var k = Math.min(1, MAX_DIM / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(image, 0, 0, c.width, c.height);
    return c;
  }

  /* 依据边界置信度均值挑选“人像”通道（双通道模型防呆） */
  function pickPersonMask(masks) {
    if (masks.length === 1) {
      return { mask: masks[0], arr: new Float32Array(masks[0].getAsFloat32Array()), w: masks[0].width, h: masks[0].height };
    }
    var best = null, bestBorder = Infinity;
    for (var i = 0; i < masks.length; i++) {
      var arr = new Float32Array(masks[i].getAsFloat32Array());
      var w = masks[i].width, h = masks[i].height;
      var sum = 0, n = 0;
      for (var x = 0; x < w; x++) {
        sum += arr[x] + arr[(h - 1) * w + x]; n += 2;
      }
      for (var y = 0; y < h; y++) {
        sum += arr[y * w] + arr[y * w + w - 1]; n += 2;
      }
      var borderAvg = sum / n;
      if (borderAvg < bestBorder) { bestBorder = borderAvg; best = { mask: masks[i], arr: arr, w: w, h: h }; }
    }
    return best;
  }

  /* 置信度通道经 8bit alpha 画布重采样到目标分辨率（0..1 浮点） */
  function resampleF32(src, w, h, tw, th) {
    var tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    var tctx = tmp.getContext('2d');
    var timg = tctx.createImageData(w, h);
    for (var j = 0, q = 3; j < src.length; j++, q += 4) timg.data[q] = Math.round(src[j] * 255);
    tctx.putImageData(timg, 0, 0);
    var dst = document.createElement('canvas');
    dst.width = tw; dst.height = th;
    var dctx = dst.getContext('2d');
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(tmp, 0, 0, tw, th);
    var back = dctx.getImageData(0, 0, tw, th).data;
    var out = new Float32Array(tw * th);
    for (var p = 0, r = 3; p < out.length; p++, r += 4) out[p] = back[r] / 255;
    return out;
  }

  /* MediaPipe 结果 → 人像置信度 { conf, hair, clothes, w, h }
   * 多分类模型（6 通道：背景/头发/身体皮肤/脸部皮肤/衣服/其他）时，
   * 额外带出头发与衣服通道（0..1，已重采样到期望分辨率）供分类感知增强；
   * 二分类回退模型时 hair/clothes 为 null。 */
  function extractPersonConf(result, expectW, expectH) {
    var masks = result.confidenceMasks;
    var m;
    var hair = null, clothes = null;
    if (masks.length >= 3) {
      var bg = new Float32Array(masks[0].getAsFloat32Array());
      var conf = new Float32Array(bg.length);
      for (var i = 0; i < bg.length; i++) conf[i] = 1 - bg[i];
      if (masks.length >= 6) { // 6 通道多分类：0背景 1头发 2身体皮肤 3脸部皮肤 4衣服 5其他
        hair = new Float32Array(masks[1].getAsFloat32Array());
        clothes = new Float32Array(masks[4].getAsFloat32Array());
      }
      m = { conf: conf, w: masks[0].width, h: masks[0].height };
    } else {
      var picked = pickPersonMask(masks);
      m = { conf: picked.arr, w: picked.w, h: picked.h };
    }
    if (m.w !== expectW || m.h !== expectH) {
      // 罕见的分辨率不一致：经画布拉伸重采样到期望分辨率（8bit 精度足够）
      m.conf = resampleF32(m.conf, m.w, m.h, expectW, expectH);
      if (hair) hair = resampleF32(hair, m.w, m.h, expectW, expectH);
      if (clothes) clothes = resampleF32(clothes, m.w, m.h, expectW, expectH);
      m.w = expectW; m.h = expectH;
    }
    m.hair = hair; m.clothes = clothes;
    return m;
  }

  /* 对任一画布做一次人像分割，返回其原始分辨率的置信度 */
  function segmentConf(canvas) {
    var result = segmenter.segment(canvas);
    try {
      return extractPersonConf(result, canvas.width, canvas.height).conf;
    } finally {
      if (result && result.close) result.close();
    }
  }

  /* ---------- 瓦片加权融合 ---------- */
  /* 轴向权重：瓦片中部=1，靠近边缘线性衰减到 0；与图像边界重合的边不衰减（无需过渡） */
  function axisWeight(p, len, over, isFirst, isLast) {
    var w0 = isFirst ? 1 : Math.min(1, p / over);
    var w1 = isLast ? 1 : Math.min(1, (len - 1 - p) / over);
    return Math.min(w0, w1);
  }

  /* 让渡事件循环：rAF 保证进度文字真正绘制一帧后再继续重活 */
  function yieldUI() {
    return new Promise(function (r) {
      if (window.requestAnimationFrame) {
        window.requestAnimationFrame(function () { setTimeout(r, 0); });
      } else {
        setTimeout(r, 0);
      }
    });
  }

  /* 大图分块精修：返回与工作图同尺寸的融合置信度 */
  async function tiledRefine(work, base, report) {
    var W = work.width, H = work.height;
    var STEP = TILE - OVERLAP;
    var xs = [], ys = [];
    for (var x0 = 0; x0 < W; x0 += STEP) xs.push(x0);
    for (var y0 = 0; y0 < H; y0 += STEP) ys.push(y0);
    var total = xs.length * ys.length;
    var done = 0;

    var acc = new Float32Array(W * H);
    var wacc = new Float32Array(W * H);
    var tc = document.createElement('canvas');
    var tctx = tc.getContext('2d', { willReadFrequently: true });

    for (var yi = 0; yi < ys.length; yi++) {
      for (var xi = 0; xi < xs.length; xi++) {
        var tx = xs[xi], ty = ys[yi];
        var tw = Math.min(TILE, W - tx), th = Math.min(TILE, H - ty);
        tc.width = tw; tc.height = th;
        tctx.drawImage(work, tx, ty, tw, th, 0, 0, tw, th);
        var tconf = segmentConf(tc);
        for (var y = 0; y < th; y++) {
          var wy = axisWeight(y, th, OVERLAP, ty === 0, ty + th === H);
          var rowT = y * tw, rowG = (ty + y) * W + tx;
          for (var x = 0; x < tw; x++) {
            var wt = wy * axisWeight(x, tw, OVERLAP, tx === 0, tx + tw === W);
            var gi = rowG + x;
            acc[gi] += tconf[rowT + x] * wt;
            wacc[gi] += wt;
          }
        }
        done++;
        report('AI 高分辨率边缘精修 ' + done + '/' + total);
        await yieldUI();
      }
    }

    var out = new Float32Array(W * H);
    for (var i = 0; i < out.length; i++) {
      var s = wacc[i];
      var v;
      if (s > 0.01) {
        var wt2 = Math.min(1, s);
        v = (acc[i] / s) * wt2 + base[i] * (1 - wt2);
      } else {
        v = base[i];
      }
      /* 防过度裁切：粗分割高置信的人像区（脸部/衣服主体）不允许被瓦片稀释削弱，
         瓦片只负责细化边缘，不回收主体 */
      if (base[i] >= 0.75 && v < base[i]) v = base[i];
      out[i] = v;
    }
    return out;
  }

  /* ---------- 导向滤波边缘精修（零依赖，纯本地） ---------- */
  /* 模型内部仅 256px，输出上采样后边缘偏离真实轮廓；导向滤波以原图灰度为引导，
     把遮罩边缘吸附到真实发丝/衣缘处：平坦区平滑、边缘区按 I 的梯度对齐 */

  /* 可分离滑动窗口均值（前缀和实现，O(N)，边界窗口收缩） */
  function boxBlur(src, w, h, r) {
    var N = w * h;
    var tmp = new Float32Array(N);
    var out = new Float32Array(N);
    var pre = new Float64Array(Math.max(w, h) + 1);
    var x, y, i;
    // 水平
    for (y = 0; y < h; y++) {
      var row = y * w;
      pre[0] = 0;
      for (x = 0; x < w; x++) pre[x + 1] = pre[x] + src[row + x];
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        tmp[row + x] = (pre[x1] - pre[x0]) / (x1 - x0);
      }
    }
    // 垂直
    for (x = 0; x < w; x++) {
      pre[0] = 0;
      for (y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
      for (y = 0; y < h; y++) {
        var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
        out[y * w + x] = (pre[y1] - pre[y0]) / (y1 - y0);
      }
    }
    return out;
  }

  /* 灰度导向滤波：I=引导图(0..1)，p=输入置信度；q = meanA*I + meanB */
  function guidedFilter(conf, lum, w, h, r, eps) {
    var N = w * h;
    var meanI = boxBlur(lum, w, h, r);
    var meanP = boxBlur(conf, w, h, r);
    var IP = new Float32Array(N), II = new Float32Array(N);
    for (var i = 0; i < N; i++) { IP[i] = lum[i] * conf[i]; II[i] = lum[i] * lum[i]; }
    var meanIP = boxBlur(IP, w, h, r);
    var meanII = boxBlur(II, w, h, r);
    var a = new Float32Array(N), b = new Float32Array(N);
    for (var j = 0; j < N; j++) {
      var varI = Math.max(0, meanII[j] - meanI[j] * meanI[j]);
      a[j] = (meanIP[j] - meanI[j] * meanP[j]) / (varI + eps);
      b[j] = meanP[j] - a[j] * meanI[j];
    }
    var meanA = boxBlur(a, w, h, r);
    var meanB = boxBlur(b, w, h, r);
    var q = new Float32Array(N);
    for (var k = 0; k < N; k++) {
      var v = meanA[k] * lum[k] + meanB[k];
      q[k] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    return q;
  }

  /* ---------- 遮罩清理（纯 Uint8Array 运算） ---------- */

  /* ---------- 分类感知增强（头发 / 白色衣服） ---------- */
  /* 多分类模型的头发/衣服通道携带了 1-背景 之外的空间语义：
     头发丝细、白衣服与浅背景难分，二者置信度天然偏低。
     在像素的专属通道占优时对其增益提升，把原本落在阈值之下的
     发丝/白衣像素拉回二值化可达区间（增益后仍须通过滞后阈值连通性检验）。 */
  function classBoost(conf, hair, clothes) {
    if (!hair && !clothes) return conf;
    for (var i = 0; i < conf.length; i++) {
      var h = hair ? hair[i] : 0;
      var c = clothes ? clothes[i] : 0;
      if (h > 0.25) { var b1 = Math.min(1, h * 1.3); if (b1 > conf[i]) conf[i] = b1; }
      if (c > 0.3) { var b2 = Math.min(1, c * 1.25); if (b2 > conf[i]) conf[i] = b2; }
    }
    return conf;
  }

  /* 分类感知阈值下调量：头发/衣服主导像素的强/弱阈值都适度降低，
     与 classBoost 配合——boost 负责「拉高置信度」，gain 负责「降低门槛」 */
  function classGain(hair, clothes) {
    var gain = new Float32Array(hair.length);
    for (var i = 0; i < gain.length; i++) {
      var h = hair ? hair[i] : 0;
      var c = clothes ? clothes[i] : 0;
      gain[i] = Math.min(0.15, h * 0.10 + c * 0.15);
    }
    return gain;
  }

  /* 滞后阈值二值化：强阈值定种子，弱阈值沿连通生长。
     头发等细结构在模型输出中置信度常落在强弱之间，单阈值会整片切掉；
     只要与强置信主体连通就保留（发丝连着头），孤立的背景弱噪声则被丢弃。
     gain（可选）：逐像素阈值下调量（分类感知），有效阈值 = T - gain[i]，下限 0.15 */
  function hysteresisBin(conf, w, h, strongT, weakT, gain) {
    var N = w * h;
    var bin = new Uint8Array(N);   // 1=强种子/已收录
    var weak = new Uint8Array(N);  // 1=弱置信待定
    var i, x, y;
    for (i = 0; i < N; i++) {
      var g = gain ? gain[i] : 0;
      var st = strongT - g; if (st < 0.15) st = 0.15;
      var wt = weakT - g; if (wt < 0.15) wt = 0.15;
      var v = conf[i];
      if (v >= st) bin[i] = 1;
      else if (v >= wt) weak[i] = 1;
    }
    var stack = new Int32Array(N);
    var sp = 0;
    for (i = 0; i < N; i++) if (bin[i]) stack[sp++] = i;
    function push(q) {
      if (weak[q]) { weak[q] = 0; bin[q] = 1; stack[sp++] = q; }
    }
    while (sp > 0) {
      var p = stack[--sp];
      x = p % w; y = (p / w) | 0;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    return bin; // 未被强主体连通的 weak 保持 0 → 孤立弱噪声被丢弃
  }

  /* 3×3 多数值滤波：去除孤立噪点，平滑锯齿。
     hairMask（可选）：头发主导像素放宽为 3/9 多数票——
     5/9 多数票会把 1–2px 宽的发丝整根切掉，头发区须宽容 */
  function medianFilter3(bin, w, h, hairMask) {
    var out = new Uint8Array(bin.length);
    for (var y = 0; y < h; y++) {
      var y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (var x = 0; x < w; x++) {
        var x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        var n = 0;
        for (var yy = y0; yy <= y1; yy++) {
          var row = yy * w;
          for (var xx = x0; xx <= x1; xx++) n += bin[row + xx];
        }
        var idx = y * w + x;
        var need = (hairMask && hairMask[idx]) ? 3 : 5;
        out[idx] = n >= need ? 1 : 0;
      }
    }
    return out;
  }

  /* 连通域清理：保留最大人像域；其余域面积 ≥ 最大域 3% 才保留（合影第二人等） */
  function cleanComponents(bin, w, h) {
    var N = w * h;
    var label = new Int32Array(N);          // 0=未访问
    var stack = new Int32Array(N);
    var comps = [];                          // {id, size, pixels? 不存像素，改用二次扫描}
    var cur = 0;
    var sizes = [0];                         // sizes[cid]
    for (var start = 0; start < N; start++) {
      if (bin[start] !== 1 || label[start] !== 0) continue;
      cur++;
      var sp = 0, size = 0;
      stack[sp++] = start;
      label[start] = cur;
      while (sp > 0) {
        var p = stack[--sp];
        size++;
        var px = p % w, py = (p / w) | 0;
        if (px > 0 && bin[p - 1] === 1 && label[p - 1] === 0) { label[p - 1] = cur; stack[sp++] = p - 1; }
        if (px < w - 1 && bin[p + 1] === 1 && label[p + 1] === 0) { label[p + 1] = cur; stack[sp++] = p + 1; }
        if (py > 0 && bin[p - w] === 1 && label[p - w] === 0) { label[p - w] = cur; stack[sp++] = p - w; }
        if (py < h - 1 && bin[p + w] === 1 && label[p + w] === 0) { label[p + w] = cur; stack[sp++] = p + w; }
      }
      sizes[cur] = size;
      comps.push(cur);
    }
    if (comps.length <= 1) return bin;
    var biggest = 0;
    for (var i = 0; i < comps.length; i++) if (sizes[comps[i]] > sizes[biggest]) biggest = comps[i];
    var minKeep = Math.max(50, sizes[biggest] * 0.03);
    var keep = new Uint8Array(cur + 1);
    keep[biggest] = 1;
    for (var j = 0; j < comps.length; j++) {
      if (sizes[comps[j]] >= minKeep) keep[comps[j]] = 1;
    }
    var out = new Uint8Array(N);
    for (var k = 0; k < N; k++) out[k] = keep[label[k]] ? bin[k] : 0;
    return out;
  }

  /* 人像触边补实：证件照下半身常被照片底边裁断，模型对贴边区域置信度不稳，
     会在遮罩底边留下锯齿状缺口；判定人像延伸出画面后，边界过渡带内的
     背景缺口若「纵向邻近人体前景」（向上/向内 LOOK 窗口内有人像）才补为前景，
     避免把角落里真正的背景一起填掉（换红蓝底会露白角） */
  function solidifyBorders(bin, w, h) {
    var bandY = Math.max(8, Math.round(h * 0.05));
    var bandX = Math.max(8, Math.round(w * 0.05));
    var LOOK = Math.max(48, Math.round(h * 0.08)); // 纵向邻近判定窗口：覆盖更高的贴底缺口
    var EDGE_FRAC = 0.25;  // 边界线附近人像占比 ≥ 此值 → 认为人像被画面裁断
    var SPAN_MIN = 0.04;   // 行/列内人像 ≥ 此比例才处理（防误处理背景噪声）

    /* dir: -1 = 缺口向上找人体（底边），+1 = 向下找（顶边） */
    function rowSpan(y, dir) {
      var row = y * w, first = -1, last = -1, cnt = 0;
      for (var x = 0; x < w; x++) if (bin[row + x]) { if (first < 0) first = x; last = x; cnt++; }
      if (first < 0 || cnt < w * SPAN_MIN) return;
      for (var x2 = first; x2 <= last; x2++) {
        if (bin[row + x2]) continue;
        for (var k = 1; k <= LOOK; k++) {
          var yy = y + dir * k;
          if (yy < 0 || yy >= h) break;
          if (bin[yy * w + x2]) { bin[row + x2] = 1; break; } // 纵向紧邻人体 → 补
        }
      }
    }
    function colSpan(x) {
      var first = -1, last = -1, cnt = 0;
      for (var y = 0; y < h; y++) if (bin[y * w + x]) { if (first < 0) first = y; last = y; cnt++; }
      if (first < 0 || cnt < h * SPAN_MIN) return;
      for (var y2 = first; y2 <= last; y2++) {
        if (bin[y2 * w + x]) continue;
        // 纵向邻近判定：缺口上/下沿列方向 LOOK 窗口内有人像 → 补（边缘轮廓抖动产生的竖向缺口）
        var hit = false;
        for (var k2 = 1; k2 <= LOOK; k2++) {
          if (y2 - k2 >= 0 && bin[(y2 - k2) * w + x]) { hit = true; break; }
          if (y2 + k2 < h && bin[(y2 + k2) * w + x]) { hit = true; break; }
        }
        if (hit) bin[y2 * w + x] = 1;
      }
    }
    function rowCnt(y) { var c = 0, row = y * w; for (var x = 0; x < w; x++) c += bin[row + x]; return c; }
    function colCnt(x) { var c = 0; for (var y = 0; y < h; y++) c += bin[y * w + x]; return c; }

    var y, t;
    // 底边：最后 3 行中任一行人像占比达标即触发
    var bottomHit = false;
    for (t = 1; t <= 3 && t <= h; t++) if (rowCnt(h - t) >= w * EDGE_FRAC) { bottomHit = true; break; }
    if (bottomHit) for (y = Math.max(0, h - bandY); y < h; y++) rowSpan(y, -1);
    // 顶边
    var topHit = false;
    for (t = 0; t < 3 && t < h; t++) if (rowCnt(t) >= w * EDGE_FRAC) { topHit = true; break; }
    if (topHit) for (y = 0; y < Math.min(bandY, h); y++) rowSpan(y, 1);
    // 左右两边
    var rightHit = false;
    for (t = 1; t <= 3 && t <= w; t++) if (colCnt(w - t) >= h * EDGE_FRAC) { rightHit = true; break; }
    if (rightHit) for (var xr = Math.max(0, w - bandX); xr < w; xr++) colSpan(xr);
    var leftHit = false;
    for (t = 0; t < 3 && t < w; t++) if (colCnt(t) >= h * EDGE_FRAC) { leftHit = true; break; }
    if (leftHit) for (var xl = 0; xl < Math.min(bandX, w); xl++) colSpan(xl);
  }

  /* 孔洞填充：从图像边界对背景洪泛，未到达的背景即身体包围的洞 → 填为前景 */
  function fillHoles(bin, w, h) {
    var N = w * h;
    var reach = new Uint8Array(N);
    var stack = new Int32Array(N);
    var sp = 0;
    function push(p) { if (bin[p] === 0 && reach[p] === 0) { reach[p] = 1; stack[sp++] = p; } }
    for (var x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (var y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp > 0) {
      var p = stack[--sp];
      var px = p % w, py = (p / w) | 0;
      if (px > 0) push(p - 1);
      if (px < w - 1) push(p + 1);
      if (py > 0) push(p - w);
      if (py < h - 1) push(p + w);
    }
    for (var i = 0; i < N; i++) {
      if (bin[i] === 0 && reach[i] === 0) bin[i] = 1; // 未被边界背景到达 → 内部孔洞
    }
  }

  /* 二值遮罩 → 白色人像画布（alpha 0/255，无灰晕） */
  function binaryToCanvas(bin, w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(w, h);
    var d = img.data;
    for (var i = 0, j = 0; i < bin.length; i++, j += 4) {
      d[j] = 255; d[j + 1] = 255; d[j + 2] = 255;
      d[j + 3] = bin[i] ? 255 : 0;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* 主入口：image → { workCanvas, maskCanvas }；onProgress(text) 可选进度回调 */
  async function segment(image, onProgress) {
    var report = onProgress || function () {};
    await init();
    var work = makeWorkCanvas(image);

    // 1) 粗分割：整图推理，建立全图人像置信度锚点
    report('AI 智能识别人像…');
    await yieldUI();
    var coarse;
    var res = segmenter.segment(work);
    try {
      coarse = extractPersonConf(res, work.width, work.height);
    } finally {
      if (res && res.close) res.close();
    }
    var baseConf = coarse.conf;

    // 2) 大图分块精修（长边 ≥ 800 时启用）
    var conf;
    if (Math.max(work.width, work.height) >= TILED_MIN) {
      conf = await tiledRefine(work, baseConf, report);
    } else {
      conf = baseConf;
    }

    // 3) 导向滤波边缘精修：以原图灰度为引导，遮罩边缘吸附到真实发丝/衣缘
    report('AI 边缘对齐…');
    await yieldUI();
    var W = work.width, H = work.height;
    var wctx = work.getContext('2d', { willReadFrequently: true });
    var wd = wctx.getImageData(0, 0, W, H).data;
    var lum = new Float32Array(W * H);
    for (var li = 0, lj = 0; li < lum.length; li++, lj += 4) {
      lum[li] = (0.299 * wd[lj] + 0.587 * wd[lj + 1] + 0.114 * wd[lj + 2]) / 255;
    }
    var guided = guidedFilter(conf, lum, W, H,
      Math.max(6, Math.round(Math.min(W, H) * 0.01)), 8e-4);
    /* 与原置信度混合：导向滤波只主导边缘吸附，避免把纹理丰富的衣服/脸部区域过度纠偏 */
    for (var gi = 0; gi < conf.length; gi++) {
      conf[gi] = guided[gi] * 0.75 + conf[gi] * 0.25;
    }

    // 3.5) 头发细节导向滤波：头发主导区用小半径低 eps 二次精修，
    //      把遮罩边缘吸附到单根发丝级轮廓（大半径 pass 负责整体边缘）
    var hair = coarse.hair, clothes = coarse.clothes;
    if (hair) {
      var gSmall = guidedFilter(conf, lum, W, H, 4, 1.5e-4);
      for (var hi = 0; hi < conf.length; hi++) {
        if (hair[hi] > 0.3) conf[hi] = gSmall[hi] * 0.6 + conf[hi] * 0.4;
      }
    }

    // 3.6) 分类感知增强：头发/白衣服专属通道增益 + 阈值下调（须在二值化之前）
    classBoost(conf, hair, clothes);

    // 4) 二值化（滞后阈值：强 0.5 / 弱 0.35，头发/衣服主导区阈值适度下调）
    report('遮罩去噪与精修…');
    await yieldUI();
    var gain = (hair || clothes) ? classGain(hair, clothes) : null;
    var bin = hysteresisBin(conf, W, H, 0.5, 0.35, gain);
    var hairMask = null;
    if (hair) {
      hairMask = new Uint8Array(W * H);
      for (var hm = 0; hm < hairMask.length; hm++) hairMask[hm] = hair[hm] > 0.3 ? 1 : 0;
    }
    bin = medianFilter3(bin, W, H, hairMask);
    solidifyBorders(bin, W, H);  // 先补实贴边缺口，避免身体碎块被连通域清理误删
    bin = cleanComponents(bin, W, H);
    fillHoles(bin, W, H);

    return { workCanvas: work, maskCanvas: binaryToCanvas(bin, W, H) };
  }

  return {
    init: init, segment: segment, isReady: isReady,
    /* 内部纯算法函数，供 Node 冒烟测试（不依赖 DOM） */
    _test: { axisWeight: axisWeight, medianFilter3: medianFilter3, cleanComponents: cleanComponents, fillHoles: fillHoles, solidifyBorders: solidifyBorders, boxBlur: boxBlur, guidedFilter: guidedFilter, hysteresisBin: hysteresisBin, classBoost: classBoost, classGain: classGain }
  };
})();
