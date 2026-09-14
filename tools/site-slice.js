#!/usr/bin/env node
// 打印站点 bundle 指定偏移附近的原始代码
const fs = require('fs');
const path = require('path');
const file = process.argv[2] || 'main.js';
const center = Number(process.argv[3] || 0);
const before = Number(process.argv[4] || 800);
const after = Number(process.argv[5] || 4000);
const txt = fs.readFileSync(path.join(__dirname, '..', 'build', 'site', file), 'utf8');
const s = Math.max(0, center - before);
const e = Math.min(txt.length, center + after);
process.stdout.write(txt.slice(s, e));
process.stdout.write('\n');
