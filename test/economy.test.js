'use strict';

/**
 * 经济/攻略离线数据：完整性与自洽性。
 *
 * 这些 JSON 都是构建期快照（tools/fetch-*.js），一旦上游改字段名或抓取脚本回归，
 * 应用里表现出来就是"价格全是空的"或"攻略一片空白" —— 所以在这里把关键不变量钉死：
 *   1) 规模：物品/弹药/防具/钥匙/交换/制作/藏身处 的数量下限
 *   2) 自洽：价格字段类型、商人 id 能对上、每格价值算得出来、交换/制作的物品 id 认得
 *   3) 攻略：任务页快照覆盖率 + 引用的截图文件名合法（截图包可以缺，但占比不能崩）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const eco = read('data/economy-dump.json');
const market = read('data/market-dump.json');
const itemById = new Map(eco.items.map((i) => [i.id, i]));

test('经济数据：规模与股票字段', () => {
  assert.ok(eco.items.length >= 5000, `物品太少: ${eco.items.length}`);
  assert.ok(eco.ammo.length >= 190, `弹药太少: ${eco.ammo.length}`);
  assert.ok(eco.gear.length >= 300, `防具太少: ${eco.gear.length}`);
  assert.ok(eco.keys.length >= 200, `钥匙太少: ${eco.keys.length}`);
  assert.ok(eco.categories.length >= 100, `分类太少: ${eco.categories.length}`);
  assert.ok(eco.modes.includes('regular') && eco.modes.includes('pve'), '必须两种模式都有');
  assert.ok(Object.keys(eco.traders).length >= 8, '商人表太少');
});

test('经济数据：两套模式的价格都有，且 PVE/PVP 确实不同', () => {
  const withBoth = eco.items.filter((i) => i.p && i.p.regular && i.p.pve && i.p.regular.avg && i.p.pve.avg);
  assert.ok(withBoth.length > 1000, `双模式都有价的物品太少: ${withBoth.length}`);
  const diff = withBoth.filter((i) => i.p.regular.avg !== i.p.pve.avg);
  assert.ok(diff.length / withBoth.length > 0.8, 'PVE 与 PVP 价格几乎一样 —— 很可能抓错模式了');
});

test('经济数据：价格字段与商人 id 自洽', () => {
  const traderIds = new Set(Object.keys(eco.traders));
  let badSell = 0;
  let badPrice = 0;
  for (const it of eco.items) {
    for (const mode of ['regular', 'pve']) {
      const p = it.p && it.p[mode];
      if (!p) continue;
      for (const key of ['base', 'last', 'avg', 'low24', 'high24']) {
        if (p[key] != null && (!Number.isFinite(p[key]) || p[key] < 0)) badPrice++;
      }
      for (const s of p.sell || []) if (!traderIds.has(s.t)) badSell++;
    }
  }
  assert.strictEqual(badPrice, 0, `有 ${badPrice} 个非法价格`);
  assert.strictEqual(badSell, 0, `有 ${badSell} 个商人 id 对不上 traders 表`);
});

test('经济数据：每格价值可算（宽高都是正数）', () => {
  const bad = eco.items.filter((i) => !(Number(i.w) > 0 && Number(i.h) > 0));
  assert.strictEqual(bad.length, 0, `有 ${bad.length} 件物品的格数非法`);
  const ledx = itemById.get('5c0530ee86f774697952d952');
  assert.ok(ledx, 'LEDX 应该在物品表里（口径校验用）');
  assert.strictEqual(ledx.w * ledx.h, 1);
});

test('经济数据：48h 涨跌幅是百分数（不是被放大 100 倍的数）', () => {
  // 曾经的 bug：tarkov.dev 的 changeLast48hPercent 本来就是百分数（-0.96 = -0.96%），
  // 抓取脚本又乘了一次 100，于是资料库上所有涨跌幅都放大 100 倍。这里用"绝对值"交叉验证把它钉死。
  const vals = [];
  for (const it of eco.items) {
    for (const mode of ['regular', 'pve']) {
      const p = it.p && it.p[mode];
      if (p && p.ch48p != null) vals.push(p.ch48p);
    }
  }
  assert.ok(vals.length > 2000, `带涨跌幅的物品太少: ${vals.length}`);
  const extreme = vals.filter((v) => Math.abs(v) > 200).length;
  assert.ok(extreme / vals.length < 0.02, `涨跌幅疑似被放大: ${extreme}/${vals.length} 超过 ±200%`);

  // 与 changeLast48h / 当前价 交叉验证（允许上游取样时点不同带来的偏差）
  let checked = 0;
  let agree = 0;
  for (const it of eco.items) {
    const p = it.p && it.p.regular;
    if (!p || p.ch48p == null || p.ch48 == null || !p.last) continue;
    // 上游算涨跌幅用的基准价取的是"扫描那一刻"的价，和 last/avg 都不完全相等，
    // 所以两条基准都试一下，任意一条对得上就算吻合。
    const bases = [p.last - p.ch48, p.avg ? p.avg - p.ch48 : null].filter((b) => b);
    if (!bases.length) continue;
    checked++;
    const ok = bases.some((b) => Math.abs((p.ch48 / b) * 100 - p.ch48p) <= Math.max(1, Math.abs(p.ch48p) * 0.35));
    if (ok) agree++;
  }
  assert.ok(checked > 1000, `可比对的样本太少: ${checked}`);
  assert.ok(agree / checked > 0.8, `涨跌幅与绝对变化对不上: ${(agree / checked * 100).toFixed(1)}%`);
});

test('交换/制作/藏身处：数量与物品 id 命中率', () => {
  assert.ok(market.barters.length >= 1500, `交换配方太少: ${market.barters.length}`);
  assert.ok(market.crafts.length >= 400, `制作配方太少: ${market.crafts.length}`);
  assert.strictEqual(market.hideout.modules.length, 26, '藏身处模块数应为 26');

  let total = 0;
  let known = 0;
  const scan = (list) => {
    for (const r of list || []) {
      total++;
      if (itemById.has(r.item)) known++;
    }
  };
  for (const b of market.barters) { scan(b.require); scan(b.reward); }
  for (const c of market.crafts) { scan(c.require); scan(c.reward); }
  for (const m of market.hideout.modules) for (const lv of m.levels) scan(lv.requirements);
  assert.ok(total > 5000, `材料条目太少: ${total}`);
  assert.ok(known / total > 0.97, `物品 id 命中率过低: ${(known / total * 100).toFixed(1)}%`);
});

test('任务攻略：覆盖率与截图引用合法', () => {
  assert.ok(exists('data/task-guides.json'), '缺少 data/task-guides.json（npm run fetch:guides）');
  const g = read('data/task-guides.json');
  const list = Object.values(g.guides || {});
  assert.ok(list.length >= 500, `攻略快照太少: ${list.length}`);
  const withGuide = list.filter((x) => x.guideHtml).length;
  assert.ok(withGuide >= 250, `带攻略正文的任务太少: ${withGuide}`);
  assert.ok(list.filter((x) => x.description).length >= 450, '任务描述覆盖不足');

  // 攻略里引用的截图都必须有合法文件名（data-shot 只允许 [A-Za-z0-9_.-]）
  let refs = 0;
  let bad = 0;
  for (const x of list) {
    for (const m of String(x.guideHtml || '').matchAll(/data-shot="([^"]+)"/g)) {
      refs++;
      if (!/^[A-Za-z0-9_.-]+$/.test(m[1])) bad++;
    }
  }
  assert.ok(refs > 1000, `攻略截图引用太少: ${refs}`);
  assert.strictEqual(bad, 0, `有 ${bad} 个非法截图名`);

  // 每个任务都必须给得出中文 Wiki 链接
  assert.ok(list.every((x) => /^https:\/\/www\.eftarkov\.com\/task\/[0-9a-f]{24}$/.test(x.wikiUrl)), 'wikiUrl 格式不对');
});
