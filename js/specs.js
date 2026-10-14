/* ============================================================
 * specs.js — 证件照规格模板库
 * 每个模板：毫米尺寸、300DPI 标准像素、头部参考线（占照片高度比例）
 * head.top   头顶参考线
 * head.eye   眼睛参考线
 * head.chin  下巴参考线
 * ============================================================ */
'use strict';

window.SPECS = [
  { id: '1inch',    name: '一寸',       desc: '25×35mm',  mmW: 25, mmH: 35, pxW: 295, pxH: 413, dpi: 300, head: { top: 0.10, eye: 0.42, chin: 0.72 } },
  { id: '2inch-s',  name: '小二寸',     desc: '33×48mm',  mmW: 33, mmH: 48, pxW: 390, pxH: 567, dpi: 300, head: { top: 0.08, eye: 0.40, chin: 0.74 } },
  { id: '2inch',    name: '二寸',       desc: '35×49mm',  mmW: 35, mmH: 49, pxW: 413, pxH: 579, dpi: 300, head: { top: 0.08, eye: 0.40, chin: 0.74 } },
  { id: '2inch-l',  name: '大二寸',     desc: '35×53mm',  mmW: 35, mmH: 53, pxW: 413, pxH: 626, dpi: 300, head: { top: 0.08, eye: 0.38, chin: 0.76 } },
  { id: 'passport', name: '护照',       desc: '33×48mm',  mmW: 33, mmH: 48, pxW: 390, pxH: 567, dpi: 300, head: { top: 0.08, eye: 0.40, chin: 0.76 } },
  { id: 'visa',     name: '签证',       desc: '51×51mm',  mmW: 51, mmH: 51, pxW: 600, pxH: 600, dpi: 300, head: { top: 0.12, eye: 0.44, chin: 0.76 } },
  { id: 'driver',   name: '驾驶证',     desc: '22×32mm',  mmW: 22, mmH: 32, pxW: 260, pxH: 378, dpi: 300, head: { top: 0.14, eye: 0.44, chin: 0.72 } },
  { id: 'social',   name: '社保照',     desc: '26×32mm',  mmW: 26, mmH: 32, pxW: 307, pxH: 378, dpi: 300, head: { top: 0.12, eye: 0.42, chin: 0.72 } }
];

window.SpecUtil = (function () {
  function byId(id) {
    for (var i = 0; i < window.SPECS.length; i++) {
      if (window.SPECS[i].id === id) return window.SPECS[i];
    }
    return window.SPECS[0];
  }
  return { byId: byId };
})();
