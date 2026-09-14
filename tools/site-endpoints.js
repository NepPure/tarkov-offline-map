#!/usr/bin/env node
// 列出站点 bundle 中出现的接口名
const fs = require('fs');
const path = require('path');
const t = fs.readFileSync(path.join(__dirname, '..', 'build', 'site', 'main.js'), 'utf8');
const set = new Map();
const add = (k) => set.set(k, (set.get(k) || 0) + 1);
for (const m of t.matchAll(/\/v2\/tarkov\/([A-Za-z0-9_]+)/g)) add('socket: ' + m[1]);
for (const m of t.matchAll(/\/api\/tarkov\/([A-Za-z0-9_/-]+)/g)) add('rest:   ' + m[1]);
for (const m of t.matchAll(/iM[A-Z][A-Za-z0-9_]{2,}/g)) add('iM:     ' + m[0]);
console.log([...set.entries()].map(([k, v]) => `${k} x${v}`).join('\n'));
