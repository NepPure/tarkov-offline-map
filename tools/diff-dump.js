#!/usr/bin/env node
/**
 * 对比两份 maps-dump（本地快照 vs 新抓取），输出点位级差异
 * 用法: node tools/diff-dump.js data/maps-dump.json build/maps-dump-4.10.7.json
 */
const fs = require('fs');
const path = require('path');

const [aPath = 'data/maps-dump.json', bPath = 'build/maps-dump-4.10.7.json'] = process.argv.slice(2);
const A = JSON.parse(fs.readFileSync(path.resolve(aPath), 'utf8'));
const B = JSON.parse(fs.readFileSync(path.resolve(bPath), 'utf8'));

console.log(`A: ${aPath}  fetchedAt=${A.fetchedAt} version=${A.version || '?'}`);
console.log(`B: ${bPath}  fetchedAt=${B.fetchedAt} version=${B.version || '?'}`);

const key = (m) => m.detail.key + '|' + m.name;
const aMap = new Map(A.maps.map((m) => [key(m), m]));
const bMap = new Map(B.maps.map((m) => [key(m), m]));

const round = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);
const posKey = (p) => `${round(p?.x)},${round(p?.y)},${round(p?.z)}`;

const ABS = ['extracts', 'transits', 'locks', 'switches', 'hazards', 'lootContainers', 'lootLoose', 'spawns', 'stationaryWeapons', 'bosses', 'labels', 'btrStops'];

let identical = 0;
for (const [k, a] of aMap) {
  const b = bMap.get(k);
  if (!b) { console.log(`\n[缺失] B 中没有 ${k}`); continue; }
  const lines = [];
  const da = a.detail, db = b.detail;
  if (da.svgPath !== db.svgPath) lines.push(`  svgPath: ${da.svgPath} -> ${db.svgPath}`);
  for (const f of ['transform', 'coordinateRotation', 'bounds', 'projection', 'minZoom', 'maxZoom']) {
    if (JSON.stringify(da[f]) !== JSON.stringify(db[f])) lines.push(`  ${f}: ${JSON.stringify(da[f])} -> ${JSON.stringify(db[f])}`);
  }
  for (const arr of ABS) {
    const la = da[arr] || [], lb = db[arr] || [];
    if (la.length !== lb.length) { lines.push(`  ${arr}: ${la.length} -> ${lb.length}`); continue; }
    // 位置集合比较
    const sa = new Set(la.map((e) => posKey(e.position)));
    const sb = new Set(lb.map((e) => posKey(e.position)));
    let moved = 0, nameChanged = 0;
    for (const s of sa) if (!sb.has(s)) moved++;
    for (let i = 0; i < la.length; i++) {
      const na = la[i].name || la[i].description || la[i].hazardType || la[i].lockType || la[i].zoneName || la[i].lootContainer?.name || la[i].text || '';
      const nb = lb[i].name || lb[i].description || lb[i].hazardType || lb[i].lockType || lb[i].zoneName || lb[i].lootContainer?.name || lb[i].text || '';
      if (na !== nb) nameChanged++;
    }
    if (moved) lines.push(`  ${arr}: ${moved} 个点位位置变化（共 ${la.length}）`);
    if (nameChanged) lines.push(`  ${arr}: ${nameChanged} 个名称变化`);
  }
  if (lines.length) console.log(`\n[差异] ${k}\n${lines.join('\n')}`);
  else identical++;
}
console.log(`\n[汇总] 完全一致 ${identical}/${aMap.size} 张`);
for (const [k] of bMap) if (!aMap.has(k)) console.log(`[新增] B 中有 ${k}`);
