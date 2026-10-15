/* ============================================================
 * brush.js — 蒙版手动修补/擦除笔刷
 * 修补  : 白色写入蒙版（恢复为人像前景）
 * 擦除  : destination-out（抹除为背景）
 * 支持触控（Pointer Events），画布坐标自动映射工作图坐标。
 * 增强：中点二次贝塞尔平滑（笔画无棱角）、getCoalescedEvents 全采样（快拖不断线）、
 *       数位板压感（pen 线宽随压力变化）、亚像素微动跳过（减少重绘）。
 * ============================================================ */
'use strict';

window.Brush = (function () {

  /* 蒙版只用到 alpha 通道（白色=人像、透明=背景），快照仅存单通道，体积为 ImageData 的 1/4。 */
  function snapMask(st) {
    var w = st.maskCanvas.width, h = st.maskCanvas.height;
    var d = st.maskCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    var alpha = new Uint8Array(w * h);
    for (var i = 0, p = 3; p < d.length; i++, p += 4) alpha[i] = d[p];
    return { w: w, h: h, alpha: alpha };
  }

  function restoreMask(st, snap) {
    if (!snap) return;
    var w = snap.w, h = snap.h;
    var img = st.maskCanvas.getContext('2d').createImageData(w, h);
    var d = img.data;
    for (var i = 0, p = 0; i < snap.alpha.length; i++, p += 4) {
      d[p] = 255; d[p + 1] = 255; d[p + 2] = 255; d[p + 3] = snap.alpha[i];
    }
    st.maskCanvas.getContext('2d').putImageData(img, 0, 0);
  }

  function attach(canvas, st, hooks) {
    var painting = false;
    var pointers = {};
    var pointerCount = 0;
    /* 拖动期间缓存画布矩形与坐标比例，避免每次 pointermove 强制重排（卡顿主因） */
    var rectCache = null;
    var sx = 1, sy = 1, ox = 0, oy = 0, sizeWork = 2;
    /* 笔画平滑状态：last=上一个原始点，lastMid=上一段中点（二次贝塞尔平滑用） */
    var last = null, lastMid = null;
    /* 数位板压感：pointerType === 'pen' 时线宽随 e.pressure 变化 */
    var penMode = false;

    /* CSS px → 工作图坐标；存在缩放视图（st.viewTf：work→画布 px）时取逆变换 */
    function workPoint(e) {
      return {
        x: (e.clientX - rectCache.left) * sx + ox,
        y: (e.clientY - rectCache.top) * sy + oy
      };
    }

    function setStyle(ctx, w) {
      ctx.save();
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (st.brushMode === 'restore') {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = '#FFFFFF';
        ctx.fillStyle = '#FFFFFF';
      } else {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.fillStyle = 'rgba(0,0,0,1)';
      }
    }

    /* 笔画起点：实心圆点 */
    function dot(p, w) {
      var ctx = st.maskCanvas.getContext('2d');
      setStyle(ctx, w);
      ctx.beginPath();
      ctx.arc(p.x, p.y, w / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (hooks && hooks.onChange) hooks.onChange();
    }

    /* 笔画延伸：中点二次贝塞尔平滑——
       以相邻两事件点的中点为端、上一事件点为控制点，消除折线棱角且不滞后跟手 */
    function segmentTo(p, pressure) {
      if (!last) return;
      if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 0.25) return; // 亚像素微动不重绘
      var ctx = st.maskCanvas.getContext('2d');
      var w = penMode
        ? Math.max(2, sizeWork * (0.35 + 0.65 * (pressure || 0.5)))
        : sizeWork;
      var mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
      setStyle(ctx, w);
      ctx.beginPath();
      ctx.moveTo(lastMid.x, lastMid.y);
      ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
      ctx.stroke();
      ctx.restore();
      lastMid = mid;
      last = p;
      if (hooks && hooks.onChange) hooks.onChange();
    }

    /* 笔画收尾：补最后半段（中点 → 落点），保证笔画完整落在抬起位置 */
    function finishStroke() {
      if (last && lastMid && (Math.abs(last.x - lastMid.x) > 0.1 || Math.abs(last.y - lastMid.y) > 0.1)) {
        var ctx = st.maskCanvas.getContext('2d');
        setStyle(ctx, sizeWork);
        ctx.beginPath();
        ctx.moveTo(lastMid.x, lastMid.y);
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
        ctx.restore();
        if (hooks && hooks.onChange) hooks.onChange();
      }
      last = null;
      lastMid = null;
    }

    canvas.addEventListener('pointerdown', function (e) {
      if (e.button === 1 || e.button === 2) return;     // 中/右键留给平移等手势
      if (st.mattePanActive) return;                    // 平移/捏合模式不落笔
      pointers[e.pointerId] = true;
      pointerCount++;
      if (pointerCount > 1) {                           // 第二指按下：结束当前笔画，交给缩放
        if (painting) {
          painting = false;
          finishStroke();
          if (hooks && hooks.onStrokeEnd) hooks.onStrokeEnd();
        }
        return;
      }
      painting = true;
      penMode = e.pointerType === 'pen' && e.pressure > 0;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 指针已释放或合成事件时忽略 */ }
      rectCache = canvas.getBoundingClientRect();
      var kc = canvas.width / (rectCache.width || 1);   // CSS px → 画布 px
      var tf = st.viewTf;                               // work → 画布 px（缩放视图）
      if (tf && tf.scale > 0) {
        sx = kc / tf.scale;
        sy = kc / tf.scale;
        ox = -tf.tx / tf.scale;
        oy = -tf.ty / tf.scale;
      } else {
        sx = st.workCanvas.width / (rectCache.width || 1);
        sy = st.workCanvas.height / (rectCache.height || 1);
        ox = 0; oy = 0;
      }
      sizeWork = Math.max(2, st.brushSize * sx);
      if (hooks && hooks.onStrokeStart) hooks.onStrokeStart(snapMask(st));
      last = lastMid = null;
      var p0 = workPoint(e);
      last = lastMid = p0;
      dot(p0, penMode ? Math.max(2, sizeWork * (0.35 + 0.65 * e.pressure)) : sizeWork);
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!painting || pointerCount > 1) return;
      /* getCoalescedEvents：取浏览器本次事件前批量合并的全部原始采样点，
         快速拖动时不再丢采样 → 笔画连贯无断线（Chromium 对 mouse/touch/pen 均支持） */
      var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (evs && evs.length) {
        for (var i = 0; i < evs.length; i++) segmentTo(workPoint(evs[i]), evs[i].pressure);
      } else {
        segmentTo(workPoint(e), e.pressure);
      }
      e.preventDefault();
    });

    function stop(e) {
      delete pointers[e.pointerId];
      if (pointerCount > 0) pointerCount--;
      if (!painting) return;
      painting = false;
      finishStroke();
      if (hooks && hooks.onStrokeEnd) hooks.onStrokeEnd();
    }
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
  }

  return { attach: attach, snapMask: snapMask, restoreMask: restoreMask };
})();
