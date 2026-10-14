// Convert MediaPipe ESM bundle to IIFE classic script (offline file:// friendly)
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'vendor', 'mediapipe');
let src = fs.readFileSync(path.join(dir, 'vision_bundle.mjs'), 'utf8');
const m = src.match(/export\{([^}]+)\};?/);
if (!m) { console.log('NO EXPORT FOUND'); process.exit(1); }
const pairs = m[1].split(',').map(s => s.trim()).filter(Boolean).map(p => {
  const mm = p.match(/^(\S+)\s+as\s+(\S+)$/);
  return mm ? [mm[2], mm[1]] : [p.split('.')[0] || p, p];
});
const obj = pairs.map(([alias, local]) => JSON.stringify(alias) + ':' + local).join(',');
const globalStmt = 'window.__mpVision={' + obj + '};';
src = src.slice(0, m.index) + globalStmt + src.slice(m.index + m[0].length);
src = src.replace(/\/\/# sourceMappingURL=.*$/m, '');
fs.writeFileSync(path.join(dir, 'vision_bundle.iife.js'), src);
console.log('converted, exports:', pairs.length);
console.log(pairs.filter(p => ['FilesetResolver', 'ImageSegmenter', 'ImageSegmenterResult'].includes(p[0])));
