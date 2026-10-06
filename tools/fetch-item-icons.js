#!/usr/bin/env node
/**
 * 物品图标全量内置（本软件是"全量内置"离线版，构建期跑一次）
 *
 * 物品 id 来源优先级:
 *   1) data/economy-dump.json 的 items[].id
 *   2) build/upstream/regular-items.json 的 data.items[].id
 *   3) build/upstream/regular-items_en.json（fetch-upstream 的备用命名）
 *   都没有就报错退出，提示先跑 node tools/fetch-economy.js
 *
 * 每个 id 下两张图（assets.tarkov.dev）:
 *   <id>-icon.webp        <- https://assets.tarkov.dev/<id>-icon.webp
 *   <id>-grid.webp        <- https://assets.tarkov.dev/<id>-grid-image.webp
 * 网格图可能 404，允许缺失，不报错退出。已存在且 >0 字节的跳过，失败重试 3 次（指数退避）。
 *
 * 输出: data/item-icons/ 与 data/item-icons/manifest.json
 *   { generatedAt, iconCount, gridCount, bytes, missing: [id...], gridMissing: [id...] }
 *
 * 用法:
 *   node tools/fetch-item-icons.js [--jobs=16] [--limit=100] [--force]
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const OUTDIR = path.join(REPO, 'data', 'item-icons');
const MANIFEST = path.join(OUTDIR, 'manifest.json');
const ECON = path.join(REPO, 'data', 'economy-dump.json');
const ASSETS = 'https://assets.tarkov.dev';
const UA = 'tarkov-offline-map/2.5 (+https://github.com/neppure/tarkov-offline-map)';

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}`));
  return a && a.includes('=') ? a.split('=')[1] : dflt;
};
const JOBS = Math.max(1, Number(arg('jobs', 16)));
const LIMIT = Number(arg('limit', 0)) || 0;
const FORCE = process.argv.includes('--force');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1048576).toFixed(2);

function itemIds() {
  const push = (arr, list) => {
    for (const x of arr) {
      const id = typeof x === 'string' ? x : x && x.id;
      if (id) list.push(id);
    }
  };
  const ids = [];
  if (fs.existsSync(ECON)) {
    const j = JSON.parse(fs.readFileSync(ECON, 'utf8'));
    push(j.items || [], ids);
    if (ids.length) return { ids, from: 'data/economy-dump.json' };
  }
  for (const name of ['regular-items.json', 'regular-items_en.json']) {
    const file = path.join(REPO, 'build', 'upstream', name);
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8')).data || {};
    const items = Array.isArray(data.items) ? data.items : Object.values(data.items || {});
    push(items, ids);
    if (ids.length) return { ids, from: `build/upstream/${name}` };
  }
  throw new Error('找不到物品 id：先跑 node tools/fetch-economy.js（或 node tools/fetch-upstream.js --only=items）');
}

async function download(url, file) {
  if (!FORCE && fs.existsSync(file) && fs.statSync(file).size > 0) return { status: 'skip', bytes: fs.statSync(file).size };
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA } });
      if (r.status === 404) return { status: '404' };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      return { status: 'ok', bytes: buf.length };
    } catch (e) {
      lastErr = e;
      await sleep(400 * 2 ** i);
    }
  }
  return { status: 'fail', error: String(lastErr && lastErr.message).slice(0, 60) };
}

(async () => {
  const { ids: all, from } = itemIds();
  const ids = LIMIT ? all.slice(0, LIMIT) : all;
  fs.mkdirSync(OUTDIR, { recursive: true });
  console.log(`[icon] ${ids.length} 个物品（来源 ${from}，并发 ${JOBS}）`);

  let cursor = 0, iconOk = 0, iconSkip = 0, gridOk = 0, gridSkip = 0, bytes = 0;
  const missing = [], gridMissing = [], fails = [];

  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const icon = await download(`${ASSETS}/${id}-icon.webp`, path.join(OUTDIR, `${id}-icon.webp`));
      if (icon.status === 'ok') { iconOk++; bytes += icon.bytes; }
      else if (icon.status === 'skip') { iconSkip++; bytes += icon.bytes; }
      else { missing.push(id); fails.push(`${id}-icon: ${icon.status}${icon.error ? ' ' + icon.error : ''}`); }

      const grid = await download(`${ASSETS}/${id}-grid-image.webp`, path.join(OUTDIR, `${id}-grid.webp`));
      if (grid.status === 'ok') { gridOk++; bytes += grid.bytes; }
      else if (grid.status === 'skip') { gridSkip++; bytes += grid.bytes; }
      else if (grid.status === 'fail') fails.push(`${id}-grid: ${grid.error}`);
      else gridMissing.push(id);
    }
  }
  await Promise.all(Array.from({ length: Math.min(JOBS, ids.length || 1) }, worker));

  const iconCount = iconOk + iconSkip;
  const gridCount = gridOk + gridSkip;
  const manifest = {
    generatedAt: new Date().toISOString(),
    iconCount,
    gridCount,
    bytes,
    missing,
    gridMissing,
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest));

  if (missing.length) console.warn(`[warn] ${missing.length} 张图标缺失`);
  if (fails.length) console.warn(`[warn] ${fails.length} 次下载最终失败，例如 ${fails.slice(0, 3).join('; ')}`);

  console.log(`[out] ${MANIFEST} 图标 ${iconCount} 网格 ${gridCount} 缺失 ${missing.length} 共 ${mb(bytes)} MB`);
  console.log(`[out] 目录 ${OUTDIR}`);
})();
