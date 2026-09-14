#!/usr/bin/env node
// 把 bundle 指定区间写成 UTF-8 文本文件，便于用 read 工具阅读
const fs = require('fs');
const path = require('path');
const [file, startA, endA, out] = process.argv.slice(2);
const txt = fs.readFileSync(path.join(__dirname, '..', 'build', 'site', file), 'utf8');
const s = Math.max(0, Number(startA));
const e = Math.min(txt.length, Number(endA));
const body = txt.slice(s, e);
// 在 } , ; 后插入换行，便于阅读
const pretty = body.replace(/([;{}])/g, '$1\n');
fs.writeFileSync(path.join(__dirname, '..', 'build', out), `// ${file} [${s}..${e}]\n` + pretty, 'utf8');
console.log('wrote', out, pretty.length, 'chars');
