#!/usr/bin/env node
/**
 * 任务物品需求快照（构建期跑一次）—— 「收集清单」页签的数据源
 *
 * 数据源: member.kaedeori.com/api/tarkov/task/requirements?lang=zh&gameMode={pve|pvp}
 *   返回 { data: { data: { <itemId>: [{ name(任务中文名), traderName, count, foundInRaid }] } } }
 *   注意：**只有 pve / pvp 两种 gameMode**，传 regular 会返回空对象（踩过）。
 *   本应用内部把 pvp 记为 regular，所以这里做一次映射。
 *
 * 输出: data/requirements-dump.json  { fetchedAt, source, attribution, modes: { regular, pve } }
 *
 * 用法: node tools/fetch-requirements.js [--refresh]
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'data', 'requirements-dump.json');
const BASE = 'https://member.kaedeori.com/api/tarkov/task/requirements';

(async () => {
  const modes = {};
  for (const [apiMode, key] of [['pvp', 'regular'], ['pve', 'pve']]) {
    const url = `${BASE}?lang=zh&gameMode=${apiMode}`;
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'tarkov-offline-map/2.5' } });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    const j = await r.json();
    const data = (j && j.data && j.data.data) || {};
    modes[key] = data;
    console.log(`[req] ${key}: ${Object.keys(data).length} 件物品有任务需求`);
  }
  const payload = {
    fetchedAt: new Date().toISOString(),
    source: 'member.kaedeori.com/api/tarkov/task/requirements',
    attribution: '任务物品需求来自 tarkov.dev，经 kaedeori 中文站整理；游戏素材版权归 Battlestate Games 所有。',
    modes,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.log(`[out] ${OUT} ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
})();
