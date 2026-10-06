#!/usr/bin/env node
/**
 * BTR 路线与时刻表快照（构建期跑一次）
 *
 * 数据源: https://www.eftarkov.com/btr 页面里内联的 JSON（<script type="application/json">）
 *   结构: { version, maps: [{ key, name, raidDuration, spawnChance, stopDuration,
 *           sourceWidth, sourceHeight, background(SVG 路径), backgroundAspect,
 *           groups:[{key,name}], stops:[{id,name,x,y}],
 *           routes:[{id,name,group,spawnTime,path:[{x,y}...]}] }], manualGeometry }
 *   x/y 是**该图 SVG 的像素坐标**（与地图底图同一套），所以以后可以直接画在地图上。
 *
 * 输出: data/btr-dump.json
 * 用法: node tools/fetch-btr.js
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'data', 'btr-dump.json');
const PAGE = 'https://www.eftarkov.com/btr';

(async () => {
  const r = await fetch(PAGE, { headers: { 'user-agent': 'tarkov-offline-map/2.5' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const html = await r.text();
  const m = html.match(/(\{"version":\d+,"maps":[\s\S]*?\})\s*<\/script>/);
  if (!m) throw new Error('页面上没找到 BTR 内联 JSON（站点结构可能变了）');
  const raw = JSON.parse(m[1]);
  const payload = {
    fetchedAt: new Date().toISOString(),
    source: PAGE,
    attribution: 'BTR 路线与站点来自「逃离塔科夫中文Wiki」（https://www.eftarkov.com/btr），数据源自 TarkovBTR 社区整理。',
    version: raw.version || null,
    maps: (raw.maps || []).map((mp) => ({
      key: mp.key,
      name: mp.name,
      raidDuration: mp.raidDuration ?? null,
      spawnChance: mp.spawnChance ?? null,
      stopDuration: mp.stopDuration ?? null,
      sourceWidth: mp.sourceWidth ?? null,
      sourceHeight: mp.sourceHeight ?? null,
      background: mp.background || null,
      groups: mp.groups || [],
      stops: (mp.stops || []).map((s) => ({ id: s.id, name: s.name, x: s.x, y: s.y })),
      routes: (mp.routes || []).map((rt) => ({
        id: rt.id, name: rt.name, group: rt.group || 'all',
        spawnTime: rt.spawnTime ?? null,
        path: (rt.path || []).map((p) => ({ x: p.x, y: p.y })),
      })),
    })),
  };
  fs.writeFileSync(OUT, JSON.stringify(payload));
  const stops = payload.maps.reduce((a, m2) => a + m2.stops.length, 0);
  const routes = payload.maps.reduce((a, m2) => a + m2.routes.length, 0);
  console.log(`[out] ${OUT} ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
  console.log(`[out] 有 BTR 的图 ${payload.maps.length}（${payload.maps.map((m2) => m2.name).join('/')}）站点 ${stops} 路线 ${routes}`);
})();
