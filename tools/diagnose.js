#!/usr/bin/env node
/**
 * 日志监听诊断：检查会话选择 / 文件匹配 / 回补内容 / 解析结果
 * 用法: node tools/diagnose.js [Logs根目录]
 */
const fs = require('fs');
const path = require('path');
const { SESSION_DIR_RE } = require('../src/constants');
const { parseLogLine } = require('../src/parsers');

const root = process.argv[2] || 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Escape from Tarkov\\build\\Logs';
console.log('Logs 根目录:', root, '存在:', fs.existsSync(root));

const dirs = fs.readdirSync(root)
  .filter((n) => SESSION_DIR_RE.test(n))
  .map((n) => ({ n, full: path.join(root, n), st: fs.statSync(path.join(root, n)) }))
  .filter((d) => d.st.isDirectory())
  .sort((a, b) => b.n.localeCompare(a.n));

console.log('\n会话目录（新→旧）:');
for (const d of dirs.slice(0, 4)) console.log('  ', d.n);

const latest = dirs[0];
console.log('\n最新会话:', latest.n);
const files = fs.readdirSync(latest.full);
console.log('目录内文件:');
for (const f of files) {
  const st = fs.statSync(path.join(latest.full, f));
  const match = / application_\d+\.log$/i.test(f);
  console.log(`   ${match ? '[命中]' : '[跳过]'} ${f}  ${st.size} bytes`);
}

const appFiles = files.filter((f) => / application_\d+\.log$/i.test(f)).sort();
for (const name of appFiles) {
  const full = path.join(latest.full, name);
  const size = fs.statSync(full).size;
  const from = Math.max(0, size - 128 * 1024);
  const buf = Buffer.alloc(size - from);
  const fd = fs.openSync(full, 'r');
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  console.log(`\n== ${name} ==`);
  console.log('  大小:', size, ' 回补起点:', from);
  console.log('  含 "scene preset":', text.includes('scene preset'));
  console.log('  含 "Location:":', text.includes('Location:'));
  console.log('  含 "NetworkGameCreate":', text.includes('NetworkGameCreate'));
  const lines = text.split('\n');
  let hits = 0;
  for (const line of lines) {
    const ev = parseLogLine(line);
    if (ev) { hits++; if (hits <= 5) console.log('  事件:', JSON.stringify(ev)); }
  }
  console.log('  解析出事件数:', hits);
}
