#!/usr/bin/env node
/**
 * 数据快照脚本：
 *  - 从 kaedeori 服务端拉取全部地图配置（一次即可，之后运行不再需要服务器）
 *  - 下载每张地图的 SVG 底图到 data/maps/
 *  - 可选 --tiles：为无 SVG 的地图（实验室/冰船/迷宫）下载瓦片底图到 data/tiles/<原始路径>/3/<x>/<y>.png
 *    （实际逻辑在 tools/fetch-tiles.js，也可以单独跑 npm run fetch:tiles）
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
    // 无 SVG 的地图（实验室/冰船/迷宫）：瓦片底图交给 tools/fetch-tiles.js。
    // 原站的卫星图只有固定 zoom=3 这一层 —— 这里以前照着 minZoom..maxZoom 去扫，
    // z=4/5/6 在 CDN 上根本不存在，白跑两万多次 404。
    const { fetchTiles } = require('./fetch-tiles');
    await fetchTiles({ maps });
  }
  s.close();
  process.exit(0);
})().catch((e) => { console.error('[fatal]', e); process.exit(1); });
