/* ============================================================
 * static-server.js — 内置静态服务（Electron 主进程用）
 * 随机端口监听 127.0.0.1，服务于应用根目录（asar 内文件可直接读）。
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream'
};

function createStaticServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        let urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath === '/') urlPath = '/index.html';
        const filePath = path.join(root, urlPath);
        if (!filePath.startsWith(root)) {
          res.writeHead(403);
          return res.end('Forbidden');
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            return res.end('Not Found');
          }
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
          });
          res.end(data);
        });
      } catch (e) {
        res.writeHead(500);
        res.end('Error');
      }
    });

    server.on('error', reject);
    // 随机可用端口，仅监听本机回环
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

module.exports = { createStaticServer };
