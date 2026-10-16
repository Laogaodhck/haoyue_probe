/* ============================================================
 * zip.js — 最小 ZIP 打包器（store 不压缩，PNG 本身已压缩）
 * 用途：多页排版导出时打包为单个 ZIP，只弹一次保存对话框。
 * 纯字节操作，无依赖。
 * ============================================================ */
'use strict';

window.ZipUtil = (function () {

  /* ---------- CRC32（IEEE，查表法） ---------- */
  var crcTable = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
  function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }

  /* 当前时间 → DOS 时间/日期字段 */
  function dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: (((d.getFullYear() - 1980) & 0x7F) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  /* files: [{name, data:Uint8Array}] → Promise<Blob>（application/zip） */
  function store(files) {
    var dt = dosDateTime(new Date());
    var enc = new TextEncoder();
    var locals = [];      // 本地文件头 + 文件名 + 数据
    var central = [];     // 中央目录字节
    var cdSize = 0;
    var offset = 0;

    files.forEach(function (f) {
      var nameBytes = enc.encode(f.name);
      var data = f.data;
      var crc = crc32(data);

      /* 本地文件头：签名 / 版本20 / UTF-8标志 / store / 时间 / 日期 / CRC / 压缩前后大小 / 名长 */
      var local = [].concat(
        u32(0x04034b50), u16(20), u16(0x0800), u16(0),
        u16(dt.time), u16(dt.date), u32(crc),
        u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0)
      );
      locals.push(new Uint8Array(local), nameBytes, data);

      /* 中央目录项 */
      central.push(new Uint8Array([].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0),
        u16(dt.time), u16(dt.date), u32(crc),
        u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset)
      )), nameBytes);

      offset += local.length + nameBytes.length + data.length;
    });

    cdSize = central.reduce(function (s, p) { return s + p.length; }, 0);

    /* EOCD：签名 / 盘号 / 盘上条目数 / 总条目数 / 目录大小 / 目录偏移 / 注释长 */
    var eocd = new Uint8Array([].concat(
      u32(0x06054b50), u16(0), u16(0),
      u16(files.length), u16(files.length),
      u32(cdSize), u32(offset), u16(0)
    ));

    return new Blob(locals.concat(central, [eocd]), { type: 'application/zip' });
  }

  return { store: store, crc32: crc32 };
})();
