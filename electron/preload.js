/* ============================================================
 * preload.js — 渲染进程安全桥接
 * 仅暴露打印能力（读打印机 + 静默打印图片），不暴露 Node 能力。
 * ============================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('haoyuePrint', {
  isDesktop: true,
  listPrinters: () => ipcRenderer.invoke('print:listPrinters'),
  showPrinterProperties: (printerName) => ipcRenderer.invoke('print:showProperties', printerName),
  printImage: (payload) => ipcRenderer.invoke('print:printImage', payload)
});

console.log('[haoyue] 打印桥接已就绪');
