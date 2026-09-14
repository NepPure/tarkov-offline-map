#!/usr/bin/env node
/**
 * 数据快照脚本：
 *  - 从 kaedeori 服务端拉取全部地图配置（一次即可，之后运行不再需要服务器）
 *  - 下载每张地图的 SVG 底图到 data/maps/
 *  - 可选 --tiles：为无 SVG 的地图（实验室/冰船/迷宫）下载瓦片金字塔到 data/tiles/<map>_<layer>/<z>/<x>/<y>.png
 *
 * 依赖: npm i socket.io-client
 * 用法: node tools/fetch-all.js [--tiles]
 */
const { io } = require('socket.io-client');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const BASE = 'https://member.kaedeori.com';
const CHANNEL = 'tarkov';
// 站台静态版本号需与线上一致（见 https://member.kaedeori.com 的 /assets/tarkov/static/<版本>/main.js）
const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}`));
  return a && a.includes('=') ? a.split('=')[1] : dflt;
};
const VERSION = arg('version', '4.10.7');
const GAME_MODE = arg('gameMode', 'pve');
const OUT = arg('out', path.join('data', 'maps-dump.json'));
// --lang zh 抓中文数据（地图/撤离点/Boss/物资/标签...名称中文化）
const LANG = arg('lang', 'zh');

(async () => {
  const hash = crypto.createHash('md5').update(`${CHANNEL}${VERSION}`).digest('hex');
  const s = io(BASE, { reconnection: false, timeout: 25000, transports: ['websocket'], query: { channel: CHANNEL, version: VERSION, token: '', hash } });
  await new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej); });
  console.log('[socket] connected');

  const { data: list } = await s.timeout(60000).emitWithAck('/v2/tarkov/iMGetMapList', { lang: LANG, gameMode: GAME_MODE });
  const maps = [];
  for (const m of list) {
    const res = await s.timeout(60000).emitWithAck('/v2/tarkov/iMGetMapDetail', { id: m.id, lang: LANG, gameMode: GAME_MODE });
    maps.push({ id: m.id, name: m.name, detail: res.data });
    console.log('[map]', m.name, 'bounds=', JSON.stringify(res.data.bounds), 'svg=', res.data.svgPath ? 'yes' : 'no');
  }
  fs.writeFileSync(path.resolve(REPO, OUT), JSON.stringify({ fetchedAt: new Date().toISOString(), source: BASE, version: VERSION, gameMode: GAME_MODE, lang: LANG, maps }, null, 2));
  console.log('[data] saved ->', OUT);

  const svgDir = path.resolve(REPO, arg('svgDir', path.join('data', 'maps')));
  fs.mkdirSync(svgDir, { recursive: true });
  const seen = new Set();
  for (const m of maps) {
    const svg = m.detail.svgPath;
    if (!svg) continue;
    const file = svg.split('/').pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const rsp = await fetch(svg);
    if (!rsp.ok) { console.warn('[svg] FAIL', file, rsp.status); continue; }
    fs.writeFileSync(path.join(svgDir, file), Buffer.from(await rsp.arrayBuffer()));
    console.log('[svg]', file);
  }

  if (process.argv.includes('--tiles')) {
    // 无 SVG 的地图：下载瓦片金字塔（起点 zoom2，终点 min(maxZoom,6)）
    for (const m of maps) {
      const d = m.detail;
      if (d.svgPath) continue;
      const targets = [];
      if (d.tilePath) targets.push({ layer: 'main', tilePath: d.tilePath });
      for (const l of d.layers || []) if (l.tilePath) targets.push({ layer: l.name || l.svgLayer, tilePath: l.tilePath });
      for (const t of targets) {
        await downloadPyramid(t.tilePath, path.join(REPO, 'data', 'tiles', `${d.key}_${String(t.layer).replace(/\W+/g, '_')}`), d.minZoom ?? 2, Math.min(d.maxZoom ?? 6, 6));
      }
    }
  }
  s.close();
  process.exit(0);
})().catch((e) => { console.error('[fatal]', e); process.exit(1); });

async function downloadPyramid(tilePath, outDir, zMin, zMax) {
  fs.mkdirSync(outDir, { recursive: true });
  for (let z = zMin; z <= zMax; z++) {
    const n = Math.pow(2, z);
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const u = tilePath.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
        const out = path.join(outDir, String(z), String(x), `${y}.png`);
        if (fs.existsSync(out)) continue;
        try {
          const rsp = await fetch(u);
          if (!rsp.ok) continue;
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, Buffer.from(await rsp.arrayBuffer()));
        } catch {}
      }
    }
    console.log(`[tiles] ${path.basename(outDir)} z=${z} done`);
  }
}
