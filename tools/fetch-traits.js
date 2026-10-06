#!/usr/bin/env node
/**
 * 赛季特质快照（构建期跑一次）—— 「赛季特质」页签的数据源
 *
 * 数据源: https://www.eftarkov.com/Traits 页面上服务端渲染的 trait-card 按钮：
 *   data-trait-id / data-trait-name / data-trait-category / data-trait-points /
 *   data-trait-conflicts(JSON 数组) / data-trait-conflict-names(JSON 对象)
 *   页面里那个 window.TARKOV_TRAITS 只有 ids，真正的字段都在 DOM 上，所以从标签解析。
 *
 * 输出: data/traits-dump.json
 * 用法: node tools/fetch-traits.js
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'data', 'traits-dump.json');
const PAGE = 'https://www.eftarkov.com/Traits';

const unescapeAttr = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

(async () => {
  const r = await fetch(PAGE, { headers: { 'user-agent': 'tarkov-offline-map/2.5' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const html = await r.text();
  const traits = [];
  for (const m of html.matchAll(/<button[^>]*data-trait-id="[^"]*"[^>]*>/g)) {
    const tag = m[0];
    const attr = (k) => {
      const mm = tag.match(new RegExp(k + "='([^']*)'")) || tag.match(new RegExp(k + '="([^"]*)"'));
      return mm ? unescapeAttr(mm[1]) : null;
    };
    const id = attr('data-trait-id');
    if (!id) continue;
    let conflicts = [];
    let conflictNames = {};
    try { conflicts = JSON.parse(attr('data-trait-conflicts') || '[]'); } catch {}
    try { conflictNames = JSON.parse(attr('data-trait-conflict-names') || '{}'); } catch {}
    traits.push({
      id,
      name: attr('data-trait-name'),
      category: attr('data-trait-category'),
      points: Number(attr('data-trait-points')) || 0,
      conflicts,
      conflictNames,
    });
  }
  if (!traits.length) throw new Error('没解析出任何特质（站点结构可能变了）');
  const payload = {
    fetchedAt: new Date().toISOString(),
    source: PAGE,
    attribution: '赛季特质来自「逃离塔科夫中文Wiki」（https://www.eftarkov.com/Traits）。',
    traits,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload));
  const byCat = traits.reduce((a, t) => (a[t.category] = (a[t.category] || 0) + 1, a), {});
  console.log(`[out] ${OUT} ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
  console.log(`[out] 特质 ${traits.length}（${Object.entries(byCat).map(([k, v]) => k + '=' + v).join(' ')}）`);
})();
