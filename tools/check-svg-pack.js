#!/usr/bin/env node
/**
 * 对比本地底图与新版互动地图素材包（versioned interactive-map pack）
 * 用法: node tools/check-svg-pack.js [packVersion]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const pack = process.argv[2] || '2026-09-13.1';
const BASE = `https://cdn.kaedeori.com/uploads/tarkov/interactive-map/${pack}/assets/maps/`;

(async () => {
  const dump = JSON.parse(fs.readFileSync(path.join(REPO, 'build', 'maps-dump-4.10.7.json'), 'utf8'));
  const localDir = path.join(REPO, 'data', 'maps');
  const outDir = path.join(REPO, 'build', 'pack-svg');
  fs.mkdirSync(outDir, { recursive: true });
  for (const m of dump.maps) {
    const url = m.detail.svgPath;
    if (!url) { console.log(`${m.name}: 无 SVG`); continue; }
    const file = url.split('/').pop();
    const localPath = path.join(localDir, file);
    const rsp = await fetch(url);
    if (!rsp.ok) { console.log(`${file}: 下载失败 ${rsp.status}`); continue; }
    const buf = Buffer.from(await rsp.arrayBuffer());
    fs.writeFileSync(path.join(outDir, file), buf);
    const upHash = crypto.createHash('sha256').update(buf).digest('hex');
    const localHash = fs.existsSync(localPath) ? crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex') : null;
    const same = localHash === upHash;
    console.log(`${file.padEnd(20)} ${same ? '✔ 相同' : '★ 已更新'}  本地 ${localHash ? localHash.slice(0, 12) : '(缺失)'} / 新版 ${upHash.slice(0, 12)}  字节 ${buf.length}`);
  }
})().catch((e) => { console.error('[fatal]', e); process.exit(1); });
