/* ============================================================
 * brush.js — 蒙版手动修补/擦除笔刷
 * 修补  : 白色写入蒙版（恢复为人像前景）
 * 擦除  : destination-out（抹除为背景）
 * 支持触控（Pointer Events），画布坐标自动映射工作图坐标。
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
    var last = null;
    var pointers = {};
    /* 拖动期间缓存画布矩形与坐标比例，避免每次 pointermove 强制重排（卡顿主因） */
    var rectCache = null;
    var sx = 1, sy = 1, ox = 0, oy = 0, sizeWork = 2;

    /* CSS px → 工作图坐标；存在缩放视图（st.viewTf：work→画布 px）时取逆变换 */
    function workPoint(e) {
      return {
        x: (e.clientX - rectCache.left) * sx + ox,
        y: (e.clientY - rectCache.top) * sy + oy
      };
    }

    function strokeTo(p) {
      var ctx = st.maskCanvas.getContext('2d');
      ctx.save();
      ctx.lineWidth = sizeWork;
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
      ctx.beginPath();
      ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      if (last) {
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.restore();
      last = p;
      if (hooks && hooks.onChange) hooks.onChange();
    }

    canvas.addEventListener('pointerdown', function (e) {
      if (e.button === 1 || e.button === 2) return;     // 中/右键留给平移等手势
      if (st.mattePanActive) return;                    // 平移/捏合模式不落笔
      pointers[e.pointerId] = true;
      if (Object.keys(pointers).length > 1) {           // 第二指按下：结束当前笔画，交给缩放
        if (painting) {
          painting = false;
          last = null;
          if (hooks && hooks.onStrokeEnd) hooks.onStrokeEnd();
        }
        return;
      }
      painting = true;
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
      last = null;
      strokeTo(workPoint(e));
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!painting || Object.keys(pointers).length > 1) return;
      strokeTo(workPoint(e));
      e.preventDefault();
    });

    function stop(e) {
      delete pointers[e.pointerId];
      if (!painting) return;
      painting = false;
      last = null;
      if (hooks && hooks.onStrokeEnd) hooks.onStrokeEnd();
    }
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
  }

  return { attach: attach, snapMask: snapMask, restoreMask: restoreMask };
})();
