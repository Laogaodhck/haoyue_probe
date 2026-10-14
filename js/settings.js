/* ============================================================
 * settings.js — 用户设置持久化（localStorage）
 * 记住上次使用的规格、底色、输出格式与 JPEG 质量。
 * ============================================================ */
'use strict';

(function (App) {

  var $ = App.ui.$;
  var State = App.State;
  var SETTINGS_KEY = 'haoyue-idphoto-settings';

  function save() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        spec: State.spec.id, bg: State.bg, fmt: State.fmt, quality: State.quality
      }));
    } catch (e) { /* 存储不可用时静默忽略 */ }
  }

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (!s) return;
      if (s.spec) State.spec = window.SpecUtil.byId(s.spec);
      if (s.bg) State.bg = s.bg;
      if (s.fmt === 'png' || s.fmt === 'jpeg') State.fmt = s.fmt;
      if (typeof s.quality === 'number') State.quality = Math.min(1, Math.max(0.5, s.quality));
    } catch (e) { }
  }

  function applyToUI() {
    document.querySelectorAll('input[name="fmt"]').forEach(function (r) {
      r.checked = r.value === State.fmt;
    });
    $('quality-row').hidden = State.fmt !== 'jpeg';
    $('quality').value = Math.round(State.quality * 100);
    $('quality-val').textContent = Math.round(State.quality * 100) + '%';
    $('custom-bg').value = /^#[0-9a-fA-F]{6}$/.test(State.bg) ? State.bg : '#FFFFFF';
    App.photo.syncBgSwatches();
  }

  App.settings = { save: save, load: load, applyToUI: applyToUI };
})(window.App);
