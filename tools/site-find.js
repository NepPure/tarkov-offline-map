#!/usr/bin/env node
// 在站点 bundle 里定位关键词并打印上下文（避免 grep 工具截断超长压缩行）
const fs = require('fs');
const path = require('path');
const file = process.argv[2] || 'main.js';
const pat = process.argv[3];
const before = Number(process.argv[4] || 600);
const after = Number(process.argv[5] || 900);
const max = Number(process.argv[6] || 6);
const txt = fs.readFileSync(path.join(__dirname, '..', 'build', 'site', file), 'utf8');
const re = new RegExp(pat, 'g');
let m, n = 0;
while ((m = re.exec(txt)) && n < max) {
  n++;
  const s = Math.max(0, m.index - before);
  const e = Math.min(txt.length, m.index + after);
  process.stdout.write(`\n===== #${n} @${m.index} =====\n`);
  process.stdout.write(txt.slice(s, e).replace(/([;{}])/g, '$1\n'));
  process.stdout.write('\n');
}
if (!n) process.stdout.write('(no match)\n');
