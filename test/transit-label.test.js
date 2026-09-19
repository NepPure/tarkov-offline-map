'use strict';

/**
 * 转移点标记的文字：必须写清"去哪张图"，不能一律写"转移点"。
 *
 * 回归背景（用户反馈）：地图上的转移点标记只显示"转移点"三个字，看不出通向哪里。
 * 根因是游戏数据里 `detail.transits[]` **没有 `name` 字段**，而代码拼的是
 * `e.name || '转移点'` → 永远走兜底分支。数据里真正有目的地的是 `description`
 * （如"前往中心区"）和目的地地图 `map.id`：
 *   - description 带地名 → 直接用（用户要求"直接用 description"）
 *   - description 只写"前往"（有 4 个）→ 用地名表把 map.id 翻成中文补上（"前往塔科夫街区"）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dump = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'maps-dump.json'), 'utf8'));

/** 和数据里/渲染层一样的地名表（同 id 的 PVP/PVE 变体只取第一个） */
function nameIndex() {
  const map = new Map();
  for (const m of dump.maps) if (m.detail && m.detail.id && !map.has(m.detail.id)) map.set(m.detail.id, m.detail.name);
  return map;
}

test('转移点文字：数据里每个转移点都能给出具体地名（不是"转移点"三个字）', async () => {
  const { transitLabel } = await import('../renderer/common/map-view.js');
  const names = nameIndex();
  let total = 0;
  const bad = [];
  for (const m of dump.maps) {
    for (const t of m.detail.transits || []) {
      total++;
      const label = transitLabel(t, names);
      const dest = label.replace(/^(前往|通往|转移到|去往)\s*/, '').trim();
      if (!dest || label === '转移点') bad.push(`${m.detail.key}: ${label}`);
    }
  }
  assert.ok(total >= 20, `转移点数据太少: ${total}`);
  assert.deepStrictEqual(bad, [], `这些转移点没写出目的地: ${bad.join(' / ')}`);
});

test('转移点文字：description 带地名就直接用；只写"前往"时用地名表补', async () => {
  const { transitLabel } = await import('../renderer/common/map-view.js');
  const names = new Map([['5714dc692459777137212e12', '塔科夫街区']]);
  // 用户要求：直接用 description
  assert.strictEqual(transitLabel({ description: '前往中心区' }, names), '前往中心区');
  assert.strictEqual(transitLabel({ description: ' 前往立交桥 ' }, names), '前往立交桥');
  // 只有"前往"时不能显示成"前往"，要用目的地地图名补齐
  assert.strictEqual(transitLabel({ description: '前往', map: { id: '5714dc692459777137212e12' } }, names), '前往塔科夫街区');
  assert.strictEqual(transitLabel({ description: '通往', map: { id: '5714dc692459777137212e12' } }, names), '通往塔科夫街区');
  // 都查不到才退回通用文案
  assert.strictEqual(transitLabel({ description: '前往' }, names), '转移点');
  assert.strictEqual(transitLabel({ description: '' }), '转移点');
  assert.strictEqual(transitLabel({}), '转移点');
  assert.strictEqual(transitLabel(null), '转移点');
  // 关键回归：老代码优先用 name（数据里根本没有这个字段）→ 一律显示"转移点"
  assert.strictEqual(transitLabel({ name: '马拉松转移', description: '前往实验室' }, names), '前往实验室');
});
