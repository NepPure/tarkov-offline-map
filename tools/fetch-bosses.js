#!/usr/bin/env node
/**
 * BOSS 数据快照（构建期跑一次，应用里完全离线）
 *
 * 数据源: https://member.kaedeori.com/api/tarkov/boss/list?lang=zh&gameMode=<mode>
 *   regular = gameMode=pvp，pve = gameMode=pve；返回 { code, data: { data: [...] } }
 * 条目字段: id,name,normalizedName,imagePortraitLink,maxSpawnChance,mapNames[],
 *           spawnLocationNames[],spawnLocationCount,maps[{mapId,mapKey,mapName,...}]
 * 响应缓存到 build/upstream/bosses-<mode>.json（--refresh 强制重抓），
 * 头像下到 data/boss-portraits/<id>.webp，已是 >0 字节的文件跳过。
 *
 * 输出: data/bosses-dump.json
 *   { fetchedAt, source, attribution, modes: { regular: [...原始条目], pve: [...] } }
 *
 * 用法:
 *   node tools/fetch-bosses.js [--mode=regular,pve] [--refresh] [--cache=build/upstream]
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'data', 'bosses-dump.json');
const PORTRAITS = path.join(REPO, 'data', 'boss-portraits');
const API = 'https://member.kaedeori.com/api/tarkov/boss/list';
const UA = 'tarkov-offline-map/2.5 (+https://github.com/neppure/tarkov-offline-map)';

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}`));
  return a && a.includes('=') ? a.split('=')[1] : dflt;
};
const CACHE = path.resolve(REPO, arg('cache', path.join('build', 'upstream')));
const MODES = arg('mode', 'regular,pve').split(',').filter(Boolean);
const REFRESH = process.argv.includes('--refresh');
const GAME_MODE = { regular: 'pvp', pve: 'pve' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(label, fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { lastErr = e; await sleep(800 * (i + 1)); }
  }
  throw new Error(`${label} 失败：${lastErr && lastErr.message}`);
}

async function fetchBosses(mode) {
  const file = path.join(CACHE, `bosses-${mode}.json`);
  if (!REFRESH && fs.existsSync(file) && fs.statSync(file).size > 256) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && j.data && Array.isArray(j.data.data)) return j.data.data;
    } catch (e) { console.warn(`[warn] ${mode} boss 缓存解析失败，改用联网：${e.message}`); }
  }
  const url = `${API}?lang=zh&gameMode=${GAME_MODE[mode] || mode}`;
  const text = await retry(`${mode} boss`, async () => {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  });
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`[fetch] ${mode} boss ${(text.length / 1024).toFixed(1)} KB`);
  const j = JSON.parse(text);
  if (!j || !j.data || !Array.isArray(j.data.data)) throw new Error(`${url} 返回结构异常`);
  return j.data.data;
}

async function portrait(id, url) {
  if (!id || !url) return { status: 'none' };
  const file = path.join(PORTRAITS, `${id}.webp`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return { status: 'skip', bytes: fs.statSync(file).size };
  try {
    const buf = await retry(`头像 ${id}`, async () => {
      const r = await fetch(url, { headers: { 'user-agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    }, 2);
    fs.mkdirSync(PORTRAITS, { recursive: true });
    fs.writeFileSync(file, buf);
    return { status: 'ok', bytes: buf.length };
  } catch (e) {
    console.warn(`  [warn] 头像 ${id} 缺失：${e.message}`);
    return { status: 'fail', error: String(e.message).slice(0, 80) };
  }
}

(async () => {
  const modes = {};
  let ok = 0, skip = 0, fail = 0, bytes = 0;

  for (const mode of MODES) {
    const list = await fetchBosses(mode);
    modes[mode] = list;
    console.log(`[boss] ${mode} ${list.length} 个（gameMode=${GAME_MODE[mode] || mode}）`);
    if (list.length < 15) console.warn(`[warn] ${mode} 只有 ${list.length} 个 BOSS（预期 >=15）`);
  }

  const seen = new Set();
  for (const mode of MODES) {
    for (const b of modes[mode]) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      const r = await portrait(b.id, b.imagePortraitLink);
      if (r.status === 'ok') { ok++; bytes += r.bytes; }
      else if (r.status === 'skip') { skip++; bytes += r.bytes; }
      else if (r.status === 'fail') fail++;
    }
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    source: 'member.kaedeori.com/api/tarkov/boss/list',
    attribution: 'BOSS 数据来自 tarkov.dev，经 kaedeori 中文站整理；游戏素材版权归 Battlestate Games 所有。',
    modes,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  const size = fs.statSync(OUT).size;

  console.log(`[out] ${OUT} ${(size / 1024).toFixed(1)} KB`);
  console.log(`[out] BOSS ${Object.entries(modes).map(([m, v]) => m + ' ' + v.length).join(' / ')} 合计去重 ${seen.size}`);
  console.log(`[out] 头像 ok ${ok} 跳过 ${skip} 失败 ${fail} 共 ${(bytes / 1048576).toFixed(2)} MB -> ${PORTRAITS}`);
})();
