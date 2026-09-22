#!/usr/bin/env node
'use strict';

/**
 * 假队友：一个纯脚本客户端，连进同一个房间，在地图上走来走去并画一笔标注。
 *
 * 用途：**一台电脑也能看效果**（真队友要两台机器，或者两个客户端实例）。
 * 它走的是和真客户端一模一样的那套代码（src/room-client.js + 真 WebSocket），
 * 所以它能看到的、你能看到的，都和真人联机一致。
 *
 * 用法（先在另一个窗口 `npm run room` 起服务端）：
 *   node tools/fake-peer.js --room 测试房 --nick 假队友
 *   node tools/fake-peer.js --room 测试房 --nick 小明 --map customs --speed 40
 *
 * 参数：
 *   --url     服务端地址（默认 127.0.0.1）
 *   --port    端口（默认 8787）
 *   --room    房间号（默认 测试房）
 *   --pass    口令（默认空）
 *   --nick    昵称（默认 假队友；地图上用第一个字）
 *   --map     在哪张图走（地图 id 或 kebab-case key，默认 customs）
 *   --seconds 跑多少秒（默认 300；到点自动离开）
 *   --speed   移动速度（米/秒，默认 25）
 *   --no-anno 不画标注
 */
const { RoomClient } = require('../src/room-client');
const mapsData = require('../src/maps-data');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const num = (name, def) => {
  const v = Number(arg(name, def));
  return Number.isFinite(v) ? v : def;
};

const URL_ = String(arg('url', '127.0.0.1'));
const PORT = num('port', 8787);
const ROOM = String(arg('room', '测试房'));
const PASS = String(arg('pass', ''));
const NICK = String(arg('nick', '假队友'));
const MAP_ARG = String(arg('map', 'customs'));
const SECONDS = num('seconds', 300);
const SPEED = num('speed', 25);
const DRAW = !argv.includes('--no-anno');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function main() {
  mapsData.load(path.join(__dirname, '..', 'data', 'maps-dump.json'));
  const detail = mapsData.getByKey(MAP_ARG) || mapsData.getById(MAP_ARG);
  if (!detail) {
    console.error(`找不到地图 ${MAP_ARG}（用 kebab-case key，例如 customs / woods / interchange）`);
    process.exit(1);
  }
  const b = detail.bounds;
  const cx = (b[0][0] + b[1][0]) / 2;
  const cz = (b[0][1] + b[1][1]) / 2;
  const radius = Math.min(Math.abs(b[1][0] - b[0][0]), Math.abs(b[1][1] - b[0][1])) / 4;

  const client = new RoomClient({
    onLog: (m) => console.log(`[假队友] ${m}`),
    onState: () => {},
  });
  client.applyConfig({ enabled: true, url: URL_, port: PORT, roomId: ROOM, pass: PASS, nick: NICK });

  const started = Date.now();
  let angle = 0;
  const trail = [];
  let drew = false;
  const timer = setInterval(() => {
    if (client.snapshot().status !== 'online') return;
    const elapsed = (Date.now() - started) / 1000;
    if (elapsed > SECONDS) return;
    const t = elapsed * SPEED;
    // 在地图中心附近绕圈走，每 2 秒报一次定位（和真客户端一样：带最近 200 点轨迹）
    angle += (SPEED / Math.max(1, radius)) * 2;
    const x = cx + Math.cos(angle) * Math.min(radius, 120);
    const z = cz + Math.sin(angle) * Math.min(radius, 120);
    trail.push({ x, z });
    if (trail.length > 200) trail.shift();
    client.setMap(detail.id);
    client.setPosition({ map: detail.id, x, y: 0, z, hdg: (angle * 180) / Math.PI, ts: Date.now(), trail: [...trail] });

    if (DRAW && !drew && trail.length >= 3) {
      drew = true;
      client.sendAnnoAdd({
        map: detail.id,
        id: `fake${Date.now().toString(36)}`,
        kind: 'ellipse',
        color: '#f472b6',
        width: 3,
        pts: [
          { x: x - 25, z: z - 25 },
          { x: x + 25, z: z + 25 },
        ],
      });
      console.log('[假队友] 画了一个椭圆（队友应该能看到，右侧图例里也能单独关掉我）');
    }
  }, 2000);

  const stop = () => {
    console.log('\n[假队友] 离开房间');
    clearInterval(timer);
    client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setTimeout(stop, (SECONDS + 3) * 1000);

  console.log(`[假队友] ${NICK} 前往 ${URL_}:${PORT} 房间「${ROOM}」，在地图 ${detail.name}（${detail.id}）绕圈 ${SECONDS}s`);
  console.log('[假队友] Ctrl+C 结束');
}

main();
