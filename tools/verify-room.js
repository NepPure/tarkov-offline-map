#!/usr/bin/env node
/**
 * 房间联机验收（v2.0）。
 *
 * 脚本自己起一个**真服务端**（server/server.js，随机端口），再用 CDP 驱着界面走一遍：
 *   1) 默认不联机：没填地址时状态是 off（离线优先的硬承诺）
 *   2) 设置页填地址/房间号 -> 「测试连接」探活成功
 *   3) 「加入房间」-> 顶栏胶囊变成"在线"
 *   4) 另一个**真客户端**（src/room-client.js）以队友身份进同一个房间
 *      -> 界面显示 2 人、主进程房间快照里能看到队友
 *   5) 队友上报地图/位置/轨迹 -> 客户端收得到（M3 起还会画在地图上）
 *   6) 队友画一笔标注 -> 客户端收得到，且带 owner（右侧按人开关图例要用）
 *   7) 「离开房间」-> 回到未联机，胶囊隐藏
 *   8) 收尾：把设置里的房间配置**原样还原**（这台机器是用户自己的配置，不能留脏数据）
 *
 * 用法:
 *   npx electron . --remote-debugging-port=9222
 *   node tools/verify-room.js [--port=9222]
 */
const fs = require('fs');
const path = require('path');

const { createRoomServer } = require('../server/server.js');
const { RoomClient } = require('../src/room-client.js');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9222));
const ART = path.join(__dirname, '..', 'test-artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

function cdp(wsUrl, calls) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const results = [];
    ws.onopen = async () => {
      for (const [method, params] of calls) {
        const myId = ++id;
        const p = new Promise((res) => pending.set(myId, res));
        ws.send(JSON.stringify({ id: myId, method, params }));
        results.push(await p);
      }
      ws.close();
      resolve(
        results.map((m) => {
          const r = m && m.result;
          if (r && r.exceptionDetails) {
            const d = r.exceptionDetails;
            return { __error: (d.exception && (d.exception.description || d.exception.value)) || d.text };
          }
          if (r && r.data) return r.data;
          return r && 'result' in r ? r.result.value : m;
        }),
      );
    };
    ws.onerror = (e) => reject(new Error(`ws error ${e.message || ''}`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    };
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  // 真服务端（随机端口，纯内存）
  const srv = createRoomServer({ host: '127.0.0.1', port: 0, logLevel: 'error' });
  const srvPort = await new Promise((res) => srv.start(res));
  const roomId = `验收房-${Date.now().toString(36)}`;
  console.log(`服务端: 127.0.0.1:${srvPort}  房间号: ${roomId}`);

  const list = await targets();
  const t = list.find((x) => x.url.endsWith('/map.html'));
  if (!t) throw new Error('未找到主窗口（用 --remote-debugging-port 启动了吗？）');
  const ws = t.webSocketDebuggerUrl;
  const ev = (expr) => cdp(ws, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]).then((r) => r[0]);
  const shot = async (file) => {
    const data = await cdp(ws, [['Page.captureScreenshot', { format: 'png' }]]);
    if (typeof data[0] === 'string') {
      fs.mkdirSync(ART, { recursive: true });
      fs.writeFileSync(path.join(ART, file), Buffer.from(data[0], 'base64'));
      console.log(`      截图 -> test-artifacts/${file}`);
    }
  };

  await ev('location.reload()');
  await sleep(3000);
  await ev(`(async () => { for (let i = 0; i < 60; i++) {
    if (window.api && document.querySelector('#room-chip')) return true;
    await new Promise((r) => setTimeout(r, 200));
  } return false; })()`);

  const origRoom = await ev(`window.api.getConfig().then((c) => c.room || null)`);
  console.log(`原房间配置: ${JSON.stringify(origRoom)}`);
  let peer = null;
  let joined = false;

  try {
    // 1) 默认不联机
    const st0 = await ev(`window.api.roomStatus()`);
    check('默认不联机（房间功能关闭时状态 off）', st0 && st0.status === 'off', `status=${st0 && st0.status}`);
    check('未联机时顶栏不显示状态胶囊', (await ev(`document.querySelector('#room-chip').classList.contains('hidden')`)) === true);

    // 2) 设置页填参数 + 测试连接
    await ev(`document.querySelector('#btn-settings').click()`);
    await sleep(400);
    const cardOk = await ev(`(() => {
      const c = document.querySelector('.room-card');
      return !!c && c.querySelector('#set-room-url') !== null && c.querySelector('#room-test') !== null;
    })()`);
    check('设置页里有「房间（联机）」卡片', cardOk === true);
    await ev(`(() => {
      const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; };
      set('#set-room-url', '127.0.0.1');
      set('#set-room-port', '${srvPort}');
      set('#set-room-id', ${JSON.stringify(roomId)});
      set('#set-room-nick', '验收号');
      document.querySelector('#set-room-enabled').checked = true;
      return true;
    })()`);
    await ev(`document.querySelector('#room-test').click()`);
    let hint = '';
    for (let i = 0; i < 40; i++) {
      hint = await ev(`document.querySelector('#room-hint').textContent`);
      if (/连接成功|失败/.test(hint)) break;
      await sleep(150);
    }
    check('「测试连接」探活成功（/healthz）', /连接成功/.test(hint), hint);
    await shot('room-settings.png');

    // 3) 加入房间
    await ev(`document.querySelector('#room-connect').click()`);
    let chip = '';
    for (let i = 0; i < 40; i++) {
      chip = await ev(`document.querySelector('#room-chip').textContent`);
      if (/在线/.test(chip)) break;
      await sleep(150);
    }
    joined = true;
    check('「加入房间」后顶栏显示在线', /在线/.test(chip), chip);
    const st1 = await ev(`window.api.roomStatus()`);
    check('主进程房间状态是 online', st1 && st1.status === 'online', JSON.stringify({ status: st1 && st1.status, self: st1 && st1.self }));

    // 4) 队友进房（真客户端，真 WebSocket）
    peer = new RoomClient({ onLog: () => {} });
    peer.applyConfig({ enabled: true, url: '127.0.0.1', port: srvPort, roomId, nick: '假队友' });
    for (let i = 0; i < 100; i++) {
      if (peer.snapshot().status === 'online') break;
      await sleep(40);
    }
    check('队友客户端进房成功', peer.snapshot().status === 'online', peer.snapshot().status);
    let peers = [];
    for (let i = 0; i < 40; i++) {
      peers = await ev(`window.api.roomStatus().then((s) => (s && s.peers) || [])`);
      if (peers.length) break;
      await sleep(150);
    }
    check('客户端看到队友进房', peers.length === 1 && peers[0].nick === '假队友', JSON.stringify(peers.map((p) => p.nick)));
    chip = await ev(`document.querySelector('#room-chip').textContent`);
    check('顶栏人数变成 2 人', /2 人/.test(chip), chip);
    await shot('room-online.png');

    // 5) 队友上报地图 + 定位 + 轨迹
    const mapId = await ev(`window.api.getState().then((s) => s.mapId)`);
    const useMap = mapId || '5704e554d2720bac5b8b456e';
    peer.setMap(useMap);
    peer.setPosition({
      map: useMap,
      x: 100,
      y: 1,
      z: 200,
      hdg: 90,
      ts: Date.now(),
      trail: [{ x: 95, z: 198 }, { x: 100, z: 200 }],
    });
    let p1 = null;
    for (let i = 0; i < 40; i++) {
      const ps = await ev(`window.api.roomStatus().then((s) => (s && s.peers) || [])`);
      p1 = ps[0] || null;
      if (p1 && p1.pos) break;
      await sleep(150);
    }
    check('客户端收到队友的位置', !!p1 && p1.pos && p1.pos.x === 100 && p1.pos.z === 200, JSON.stringify(p1 && p1.pos));
    check('客户端收到队友的朝向', !!p1 && p1.pos && p1.pos.hdg === 90, p1 && p1.pos ? String(p1.pos.hdg) : '-');
    check('客户端收到队友的轨迹尾巴', !!p1 && p1.pos && Array.isArray(p1.pos.trail) && p1.pos.trail.length === 2);
    check('队友的地图 id 一起同步过来', !!p1 && p1.map === useMap, p1 ? String(p1.map) : '-');

    // 6) 队友画一笔标注
    peer.sendAnnoAdd({ map: useMap, id: 'peer-anno-1', kind: 'pen', color: '#22d3ee', width: 4, pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] });
    let annos = null;
    for (let i = 0; i < 40; i++) {
      annos = await ev(`window.api.roomStatus().then((s) => (s && s.annos) || {})`);
      if (annos && annos[useMap] && annos[useMap].length) break;
      await sleep(150);
    }
    const got = annos && annos[useMap] ? annos[useMap][0] : null;
    check('客户端收到队友的标注', !!got && got.kind === 'pen', JSON.stringify(got && got.kind));
    check('标注带 owner（右侧按人开关图例要用）', !!got && got.owner === peer.cfg.peerId, got ? String(got.owner) : '-');

    // 7) 离开房间
    await ev(`document.querySelector('#room-disconnect').click()`);
    let st2 = null;
    for (let i = 0; i < 40; i++) {
      st2 = await ev(`window.api.roomStatus()`);
      if (st2 && st2.status === 'off') break;
      await sleep(150);
    }
    joined = false;
    check('「离开房间」后回到未联机', st2 && st2.status === 'off', `status=${st2 && st2.status}`);
    check('离开后顶栏胶囊隐藏', (await ev(`document.querySelector('#room-chip').classList.contains('hidden')`)) === true);
    check('离开后不再显示队友', ((await ev(`window.api.roomStatus().then((s) => (s && s.peers) || [])`)) || []).length === 0);
  } finally {
    // 8) 收尾：还原（先还原配置，再关掉可能的连接）
    try {
      if (peer) peer.destroy();
      if (origRoom) {
        await ev(`window.api.setConfig({ room: ${JSON.stringify(origRoom)} })`);
      }
      if (joined) await ev(`window.api.roomLeave()`);
      await ev(`document.querySelector('#settings-dialog').open && document.querySelector('#settings-dialog').close()`);
      const after = await ev(`window.api.getConfig().then((c) => c.room || null)`);
      check('收尾：房间配置已还原成用户原来的样子',
        JSON.stringify({ ...after, peerId: undefined }) === JSON.stringify({ ...origRoom, peerId: undefined }),
        JSON.stringify(after));
    } catch (e) {
      console.log(`收尾时出错（请手工检查设置里的房间配置）：${e.message}`);
    }
    await new Promise((r) => srv.close(r));
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    console.log('失败项: ' + bad.map((b) => b.name).join(' / '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('验收脚本出错:', e.message);
  process.exit(1);
});
