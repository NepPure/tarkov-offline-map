#!/usr/bin/env node
// 在站点 bundle 中提取关键词上下文，用于研究原版功能实现
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'build', 'site');
const pats = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
for (const p of pats) {
  const re = new RegExp(p, 'gi');
  console.log(`\n===== /${p}/ =====`);
  let total = 0;
  for (const f of files) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    let m;
    while ((m = re.exec(txt))) {
      total++;
      if (total > 25) break;
      const s = Math.max(0, m.index - 130), e = Math.min(txt.length, m.index + 160);
      console.log(`[${f} @${m.index}] …${txt.slice(s, e).replace(/\n/g, ' ')}…`);
    }
    if (total > 25) break;
  }
  if (!total) console.log('(无匹配)');
}
