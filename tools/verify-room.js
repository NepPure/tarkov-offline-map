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
  const origToggles = await ev(`window.api.getConfig().then((c) => c.markerToggles || null)`);
  const origAnnos = await ev(`window.api.getAnnotations()`);
  console.log(`原房间配置: ${JSON.stringify(origRoom)}`);
  console.log(`原图例开关: ${Object.keys(origToggles || {}).length} 个（结束会还原）`);
  console.log(`原标注: ${JSON.stringify(Object.keys(origAnnos || {}))}（结束会还原）`);
  let peer = null;
  let scriptPeer = null;
  let joined = false;

  try {
    // 1) 离线优先：配置里关着就必须是 off。
    //    但用户自己可能已经把房间开着（他自己搭了服务端）—— 那这时"应该是连上的"，
    //    脚本不能反过来把"他开着联机"判成失败（第一次跑就是这么误报的）。
    const st0 = await ev(`window.api.roomStatus()`);
    if (origRoom && origRoom.enabled) {
      check('原配置里房间是开着的：启动后就该自己连上（联机没被吞掉）',
        !!st0 && st0.status !== 'off', `status=${st0 && st0.status}`);
      check('开着房间时顶栏胶囊是显示的',
        (await ev(`document.querySelector('#room-chip').classList.contains('hidden')`)) === false);
    } else {
      check('默认不联机（房间功能关闭时状态 off）', !!st0 && st0.status === 'off', `status=${st0 && st0.status}`);
      check('未联机时顶栏不显示状态胶囊', (await ev(`document.querySelector('#room-chip').classList.contains('hidden')`)) === true);
    }

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

    // 3a) 用设置页的「保存」开通（不是只有"加入房间"按钮管用）
    //     回归：以前 sameTarget 判定会把这条路径吞掉 —— 开关打开、字段没动 -> 认为"没变化" -> 一直不连
    await ev(`document.querySelector('#settings-ok').click()`);
    let chip = '';
    for (let i = 0; i < 40; i++) {
      chip = await ev(`document.querySelector('#room-chip').textContent`);
      if (/在线/.test(chip)) break;
      await sleep(150);
    }
    joined = true;
    check('设置里勾「启用房间」+ 点保存就能连上（不用非得点"加入房间"）', /在线/.test(chip), chip);
    const st1 = await ev(`window.api.roomStatus()`);
    check('主进程房间状态是 online', st1 && st1.status === 'online', JSON.stringify({ status: st1 && st1.status, self: st1 && st1.self }));

    // 3b) 「加入房间」按钮这条路也要通（先离开再重新加入）
    await ev(`document.querySelector('#btn-settings').click()`);
    await sleep(300);
    await ev(`document.querySelector('#room-disconnect').click()`);
    await sleep(400);
    await ev(`document.querySelector('#room-connect').click()`);
    let chip2 = '';
    for (let i = 0; i < 40; i++) {
      chip2 = await ev(`document.querySelector('#room-chip').textContent`);
      if (/在线/.test(chip2)) break;
      await sleep(150);
    }
    check('「加入房间」按钮也能连上', /在线/.test(chip2), chip2);

    // 3c) 提示行必须说真话（回归：以前它只在点按钮时写一次，之后没人管）。
    //     用户报的正是这个：顶栏已经写着"房间 N 人"，按钮旁边那句还挂着"正在加入…"。
    let hintOnline = '';
    for (let i = 0; i < 40; i++) {
      hintOnline = await ev(`document.querySelector('#room-hint').textContent`);
      if (/已加入房间/.test(hintOnline)) break;
      await sleep(150);
    }
    check('连上以后提示行说"已加入房间"，不会停在"正在加入…"', /已加入房间/.test(hintOnline), hintOnline);
    check('提示行颜色也跟着状态走（成功色）',
      /room-hint ok/.test(await ev(`document.querySelector('#room-hint').className`)),
      await ev(`document.querySelector('#room-hint').className`));

    // 3d) 关键回归：**配置一个字段都不改**再点一次「加入房间」。
    //     主进程那边 room:reconnect 会直接 no-op（已经在线，不想白折腾一条连接），
    //     以前这就让"正在加入…"永远留在提示行里 —— 现在必须立刻回到真实状态。
    const hintBefore = await ev(`document.querySelector('#room-hint').textContent`);
    await ev(`document.querySelector('#room-connect').click()`);
    await sleep(150);
    const hintJustAfter = await ev(`document.querySelector('#room-hint').textContent`);
    let hintBack = '';
    for (let i = 0; i < 40; i++) {
      hintBack = await ev(`document.querySelector('#room-hint').textContent`);
      if (/已加入房间/.test(hintBack)) break;
      await sleep(150);
    }
    check('配置没变时点「加入房间」：提示行回到"已加入房间"（不会卡在"正在加入…"）',
      /已加入房间/.test(hintBack), `点前="${hintBefore}" 点后立刻="${hintJustAfter}" → 稳定后="${hintBack}"`);
    check('重复点「加入房间」不会把已有连接踢掉',
      (await ev(`window.api.roomStatus()`)).status === 'online');
    // 关掉设置弹窗：后面要在地图上点队友标记（modal 会挡住鼠标命中）
    await ev(`document.querySelector('#settings-dialog').open && document.querySelector('#settings-dialog').close()`);
    await sleep(200);

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
    // 先把界面切到海关（只改运行状态，不写设置），这样"画在地图上"才可验收
    await ev(`window.api.selectMap({ key: 'customs' })`);
    for (let i = 0; i < 40; i++) {
      if (await ev(`!!(window.__view && window.__view.detail && window.__view.detail.key === 'customs')`)) break;
      await sleep(150);
    }
    const mapId = await ev(`window.__view.detail.id`);
    const useMap = mapId;
    check('界面已切到海关（后续"画在地图上"的验收基准）', !!useMap, String(useMap));
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

    // 6b) 真的画在地图上了：圆底 + 昵称首字 + 朝向箭头 + 虚线轨迹 + 名字/时间
    let mark = null;
    for (let i = 0; i < 40; i++) {
      mark = await ev(`(() => {
        const m = document.querySelector('.peer-mark');
        if (!m) return null;
        const arrow = m.querySelector('.peer-arrow');
        return {
          count: document.querySelectorAll('.peer-mark').length,
          initial: (m.querySelector('text') || {}).textContent || '',
          hasArrow: !!arrow,
          arrowTransform: arrow ? arrow.getAttribute('transform') : null,
          caption: [...m.querySelectorAll('text')].map((t) => t.textContent).join('|'),
          trails: document.querySelectorAll('.peer-trail').length,
          color: (m.querySelector('circle') || {}).getAttribute ? m.querySelector('circle').getAttribute('stroke') : null,
        };
      })()`);
      if (mark) break;
      await sleep(150);
    }
    check('地图上出现队友标记', !!mark && mark.count === 1, mark ? `count=${mark.count}` : 'none');
    check('标记里是昵称第一个字', !!mark && mark.initial === '假', mark && mark.initial);
    check('标记带朝向箭头', !!mark && mark.hasArrow && /rotate/.test(String(mark.arrowTransform)), mark && String(mark.arrowTransform));
    check('队友轨迹画成虚线', !!mark && mark.trails === 1, mark ? `trails=${mark.trails}` : '-');
    check('标记下面写了"昵称 · 多久以前"', !!mark && /假队友 · /.test(mark.caption), mark && mark.caption);
    check('队友标注也画在地图上（别人的笔画）', (await ev(`document.querySelectorAll('.peer-anno').length`)) >= 1);
    await shot('room-peer-on-map.png');

    // 6b-2) 雷达（小地图窗口）也要画队友：它是另一个渲染进程，单独查一遍
    const miniTarget = (await targets()).find((x) => x.url.endsWith('/minimap.html'));
    if (!miniTarget) {
      check('雷达窗口存在（设置里"小地图雷达"开着才会创建）', false, '没找到 minimap.html，跳过队友检查');
    } else {
      const miniWs = miniTarget.webSocketDebuggerUrl;
      const miniEv = (expr) => cdp(miniWs, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]).then((r) => r[0]);
      let miniOk = null;
      for (let i = 0; i < 40; i++) {
        miniOk = await miniEv(`({ marks: document.querySelectorAll('.peer-mark').length, initials: [...document.querySelectorAll('.peer-mark text')].map((t) => t.textContent).join('') })`);
        if (miniOk && miniOk.marks > 0) break;
        await sleep(150);
      }
      check('雷达上也画了队友（圆底 + 首字）', !!miniOk && miniOk.marks === 1 && miniOk.initials === '假', JSON.stringify(miniOk));

      // 6b-3) 队友跑出雷达显示范围：应该贴到圆边上，且方位和他真实所在的方位一致
      const bounds = await ev(`window.__view.detail.bounds`);
      const bx = (bounds[0][0] + bounds[1][0]) / 2;
      const bz = (bounds[0][1] + bounds[1][1]) / 2;
      peer.setPosition({ map: useMap, x: bx + 400, y: 0, z: bz + 400, hdg: 90, ts: Date.now() });
      let geom = null;
      for (let i = 0; i < 40; i++) {
        geom = await miniEv(`(() => {
          const v = window.__view;
          const el = document.querySelector('.mapstage');
          const rect = el.getBoundingClientRect();
          const cx = rect.width / 2, cy = rect.height / 2;
          const mark = document.querySelector('.peer-mark[data-off-range="1"]');
          if (!mark) return { found: false };
          const peer = v.peers[0];
          const p = v.getProjection().project(peer.pos.x, peer.pos.z);
          const vp = v.getViewport();
          const dx = p.x - vp.cx, dy = p.y - vp.cy;
          const cos = Math.cos(vp.rot), sin = Math.sin(vp.rot);
          const sx = (dx * cos - dy * sin) * vp.scale + rect.width / 2;
          const sy = (dx * sin + dy * cos) * vp.scale + rect.height / 2;
          const wantBearing = (Math.atan2(sy - cy, sx - cx) * 180) / Math.PI;
          const circle = mark.querySelector('circle');
          const b = circle.getBoundingClientRect();
          const mx = b.left + b.width / 2 - rect.left;
          const my = b.top + b.height / 2 - rect.top;
          return {
            found: true,
            wantBearing,
            gotBearing: Number(mark.getAttribute('data-bearing')),
            radarR: Number(mark.getAttribute('data-radar-r')),
            dist: Math.hypot(mx - cx, my - cy),
            unclampedDist: Math.hypot(sx - cx, sy - cy),
            hasChevron: !!mark.querySelector('.peer-offrange-chevron'),
            dashed: circle.getAttribute('stroke-dasharray'),
            radius: circle.getAttribute('r'),
          };
        })()`);
        if (geom && geom.found) break;
        await sleep(150);
      }
      check('雷达：队友出范围后被钳到圆边（不再画到窗口外）',
        !!geom && geom.found && Math.abs(geom.dist - geom.radarR) < 2 && geom.unclampedDist > geom.radarR + 30,
        geom && geom.found ? `贴边距圆心 ${Math.round(geom.dist)}px（圆边 ${geom.radarR}px，真实位置 ${Math.round(geom.unclampedDist)}px）` : '没找到出范围标记');
      const dBearing = geom && geom.found ? Math.abs(((geom.gotBearing - geom.wantBearing + 540) % 360) - 180) : 999;
      check('雷达：钳位后的方位与他真实方向一致', dBearing < 2,
        geom && geom.found ? `期望 ${Math.round(geom.wantBearing)}°，实际 ${geom.gotBearing}°` : '-');
      check('雷达：出范围标记带朝外箭头 + 虚线边框（一眼看出他在外面）',
        !!geom && geom.found && geom.hasChevron && !!geom.dashed, geom && geom.found ? `chevron=${geom.hasChevron} dash=${geom.dashed}` : '-');
      {
        const data = await cdp(miniWs, [['Page.captureScreenshot', { format: 'png' }]]);
        if (typeof data[0] === 'string') {
          fs.mkdirSync(ART, { recursive: true });
          fs.writeFileSync(path.join(ART, 'room-radar-offrange.png'), Buffer.from(data[0], 'base64'));
          console.log('      截图 -> test-artifacts/room-radar-offrange.png');
        }
      }

      // 回到范围内：不该再有出范围标记
      peer.setPosition({ map: useMap, x: bx, y: 0, z: bz, hdg: 0, ts: Date.now() });
      let backIn = null;
      for (let i = 0; i < 40; i++) {
        backIn = await miniEv(`({ marks: document.querySelectorAll('.peer-mark').length, off: document.querySelectorAll('.peer-mark[data-off-range="1"]').length })`);
        if (backIn && backIn.marks === 1 && backIn.off === 0) break;
        await sleep(150);
      }
      check('雷达：队友回到范围内后不再钳位', !!backIn && backIn.marks === 1 && backIn.off === 0, JSON.stringify(backIn));

      // 6b-4) 队友换图：他在这张图上的点必须消失，图例改成"他在哪张图"
      const woodsId = await ev(`window.api.listMaps().then((ms) => (ms.find((m) => m.key === 'woods') || {}).id || null)`);
      peer.setMap(woodsId);
      let moved = null;
      for (let i = 0; i < 40; i++) {
        moved = await ev(`(() => {
          const sec = [...document.querySelectorAll('.legend-section')].find((s) => /房间成员/.test(s.textContent));
          const row = sec && sec.querySelector('.legend-item');
          return {
            marks: document.querySelectorAll('.peer-mark').length,
            name: row ? row.querySelector('.legend-name').textContent.trim() : '',
            count: row ? Number(row.querySelector('.legend-count').textContent) : -1,
          };
        })()`);
        if (moved && moved.marks === 0) break;
        await sleep(150);
      }
      check('队友换图后：他在这张图上的标记消失', !!moved && moved.marks === 0, JSON.stringify(moved));
      check('队友换图后：图例改成"他在哪张图"（不再显示虚假的计数）',
        !!moved && /在森林/.test(moved.name) && moved.count === 0, moved ? `${moved.name} / count=${moved.count}` : '-');
      // 换回来 + 重新定位 -> 标记回来
      peer.setMap(useMap);
      peer.setPosition({ map: useMap, x: 100, y: 1, z: 200, hdg: 90, ts: Date.now(), trail: [{ x: 95, z: 198 }, { x: 100, z: 200 }] });
      let backAgain = null;
      for (let i = 0; i < 40; i++) {
        backAgain = await ev(`({ marks: document.querySelectorAll('.peer-mark').length })`);
        if (backAgain && backAgain.marks === 1) break;
        await sleep(150);
      }
      check('队友换回本图并重新定位后，标记又出现了', !!backAgain && backAgain.marks === 1, JSON.stringify(backAgain));
      // 把队友放回原来那个点（后面的用例还按 (100,200) 算）
      peer.setPosition({
        map: useMap, x: 100, y: 1, z: 200, hdg: 90, ts: Date.now(),
        trail: [{ x: 95, z: 198 }, { x: 100, z: 200 }],
      });
      await sleep(400);
    }

    // 6c) 右侧图例：一人一行（地图上画了谁，图例里就有谁）
    const legend = await ev(`(() => {
      const sec = [...document.querySelectorAll('.legend-section')].find((s) => /房间成员/.test(s.textContent));
      if (!sec) return null;
      const row = sec.querySelector('.legend-item');
      if (!row) return null;
      return {
        group: (sec.querySelector('.legend-group-name') || {}).textContent || '',
        name: (row.querySelector('.legend-name') || {}).textContent || '',
        count: Number((row.querySelector('.legend-count') || {}).textContent || 0),
        swatchText: (row.querySelector('svg.legend-swatch text') || {}).textContent || '',
        checked: row.querySelector('input').checked,
        id: row.querySelector('input').dataset.group,
      };
    })()`);
    check('右侧图例出现「房间成员」分组', !!legend && legend.group === '房间成员', legend && legend.group);
    check('图例图标也是昵称第一个字（不是圆点）', !!legend && legend.swatchText === '假', legend && legend.swatchText);
    check('图例计数 = 位置 + 标注数', !!legend && legend.count >= 2, legend ? String(legend.count) : '-');
    check('图例行 id = peer:<队友id>', !!legend && legend.id === `peer:${peer.cfg.peerId}`, legend && legend.id);

    // 6d) 按人开关：关掉这个人 -> 标记/轨迹/标注一起消失；再打开 -> 回来
    const toggle = (on) => ev(`(() => {
      const sec = [...document.querySelectorAll('.legend-section')].find((s) => /房间成员/.test(s.textContent));
      const box = sec.querySelector('.legend-item input');
      if (box.checked !== ${on}) box.click();
      return box.checked;
    })()`);
    await toggle(false);
    await sleep(400);
    const off = await ev(`({ marks: document.querySelectorAll('.peer-mark').length, trails: document.querySelectorAll('.peer-trail').length, annos: document.querySelectorAll('.peer-anno').length })`);
    check('取消勾选"某个人" -> 他的标记/轨迹/标注一起隐藏', off.marks === 0 && off.trails === 0 && off.annos === 0, JSON.stringify(off));
    await toggle(true);
    await sleep(400);
    const on = await ev(`({ marks: document.querySelectorAll('.peer-mark').length, annos: document.querySelectorAll('.peer-anno').length })`);
    check('重新勾选 -> 全部回来', on.marks === 1 && on.annos >= 1, JSON.stringify(on));

    // 6e) 点队友标记 -> 视野跳到他那儿
    const focus = await ev(`(() => {
      const m = document.querySelector('.peer-mark');
      if (!m) return null;
      // 必须点在圆心上：标记的 bbox 把下面的名字药丸也算进去了，点 bbox 中心会落进空隙
      const c = m.querySelector('circle');
      const r = c.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const el = document.elementFromPoint(x, y) || c;
      const stage = document.querySelector('.mapstage');
      stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
      const after = window.__view.getViewport();
      const want = window.__view.getProjection().project(100, 200);
      return { hit: el.tagName, dist: Math.hypot(after.cx - want.x, after.cy - want.y) };
    })()`);
    check('点队友标记会跳到他的位置', !!focus && focus.dist < 30, focus ? `命中 ${focus.hit}，偏差 ${Math.round(focus.dist)}px` : '-');

    // 6f) 反向：我画的标注要能同步给队友（带稳定 id）
    const selfId = (await ev(`window.api.roomStatus()`)).self.id;
    await ev(`document.querySelector('#btn-anno').click()`);
    await sleep(300);
    const drawn = await ev(`(() => {
      const stage = document.querySelector('.mapstage');
      const r = stage.getBoundingClientRect();
      const x1 = r.left + r.width * 0.3, y1 = r.top + r.height * 0.3;
      const x2 = r.left + r.width * 0.5, y2 = r.top + r.height * 0.5;
      stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x1, clientY: y1, button: 0 }));
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x1 + (x2 - x1) * t, clientY: y1 + (y2 - y1) * t }));
      }
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x2, clientY: y2, button: 0 }));
      const list = window.__view.annos;
      return { count: list.length, lastId: list.length ? list[list.length - 1].id : null };
    })()`);
    await ev(`document.querySelector('#anno-exit').click()`);
    check('画完一笔后本地有了稳定 id', !!drawn.lastId && /^[A-Za-z0-9_-]{1,40}$/.test(drawn.lastId), String(drawn.lastId));
    let mine = null;
    for (let i = 0; i < 40; i++) {
      const got = peer.snapshot().annos[useMap] || [];
      mine = got.find((a) => a.owner === selfId) || null;
      if (mine) break;
      await sleep(150);
    }
    check('我画的标注同步给了队友（owner = 我）', !!mine && mine.id === drawn.lastId, mine ? `id=${mine.id}` : '没收到');

    // 撤销/删掉这一笔 -> 队友那边也要消失
    await ev(`window.api.roomAnno({ op: 'del', map: ${JSON.stringify(useMap)}, id: ${JSON.stringify(drawn.lastId)} })`);
    let gone = false;
    for (let i = 0; i < 30; i++) {
      const got = peer.snapshot().annos[useMap] || [];
      if (!got.some((a) => a.id === drawn.lastId)) {
        gone = true;
        break;
      }
      await sleep(150);
    }
    check('删掉那一笔后队友那边也消失', gone);
    // 收尾：把这一笔从本地标注里删掉（用户原来的标注文件要原样还原）。
    // 注意必须**同时**清掉渲染层的待保存定时器：不然 600ms 后它会把这一笔又写回去，
    // 我们刚还原好的 annotations.json 就被覆盖了（第一次跑就是这么被改脏的）。
    await ev(`(async () => {
      const id = ${JSON.stringify(useMap)};
      if (window.__anno) {
        if (window.__anno.saveTimer) { clearTimeout(window.__anno.saveTimer); window.__anno.saveTimer = null; }
        delete window.__anno.store[id];
      }
      const all = await window.api.getAnnotations();
      delete all[id];
      await window.api.setAnnotations(all);
      return true;
    })()`);
    await sleep(800); // 等主进程那边的防抖落盘也走完，再让 finally 去做最终还原

    // 6g) 假队友脚本（README 让用户单人自测的那条命令）必须真能用
    const { spawn } = require('node:child_process');
    scriptPeer = spawn(
      process.execPath,
      [path.join(__dirname, 'fake-peer.js'), '--url', '127.0.0.1', '--port', String(srvPort),
        '--room', roomId, '--nick', '脚本队友', '--map', 'customs', '--seconds', '60'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let peerLog = '';
    scriptPeer.stdout.on('data', (d) => {
      peerLog += String(d);
    });
    scriptPeer.stderr.on('data', (d) => {
      peerLog += String(d);
    });
    let scripted = null;
    for (let i = 0; i < 60; i++) {
      scripted = await ev(`({ marks: document.querySelectorAll('.peer-mark').length, initials: [...document.querySelectorAll('.peer-mark text')].map((t) => t.textContent).join(',') })`);
      if (scripted && /脚/.test(scripted.initials)) break;
      await sleep(250);
    }
    check('npm run room:peer（假队友脚本）能连进来并被看到', !!scripted && /脚/.test(scripted.initials), JSON.stringify(scripted));
    let peerAnnos = 0;
    for (let i = 0; i < 40; i++) {
      peerAnnos = await ev(`document.querySelectorAll('.peer-anno').length`);
      if (peerAnnos >= 2) break; // 之前那位假队友的笔画 + 脚本队友画的圈
      await sleep(250);
    }
    check('脚本队友画的圈也画在地图上', peerAnnos >= 2, `peer-anno=${peerAnnos}`);
    scriptPeer.kill();
    let gonePeer = false;
    for (let i = 0; i < 40; i++) {
      if ((await ev(`document.querySelectorAll('.peer-mark').length`)) === 1) {
        gonePeer = true;
        break;
      }
      await sleep(250);
    }
    check('脚本队友退出后标记消失（只剩先前那位）', gonePeer, peerLog.split('\n')[0] || '');

    // 7) 离开房间
    await ev(`document.querySelector('#room-disconnect').click()`);
    let hintLeft = '';
    for (let i = 0; i < 30; i++) {
      hintLeft = await ev(`document.querySelector('#room-hint').textContent`);
      if (/已离开房间/.test(hintLeft)) break;
      await sleep(100);
    }
    check('「离开房间」后提示行说"已离开房间"', /已离开房间/.test(hintLeft), hintLeft);
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

    // 7b) 离线时画的标注，重新进房后必须补发。
    //     关键：**画完立刻进房**（同一个 CDP 调用里完成，中间没有任何等待）——
    //     渲染层要 600ms 防抖才把标注同步给主进程，所以进房那一刻主进程手里根本没有这一笔。
    //     以前补发是主进程做的，正好漏掉这一笔；现在由渲染层在"变成 online"那一刻补发。
    const offlineId = await ev(`(() => {
      document.querySelector('#btn-anno').click();
      const stage = document.querySelector('.mapstage');
      const r = stage.getBoundingClientRect();
      const x1 = r.left + r.width * 0.2, y1 = r.top + r.height * 0.25;
      const x2 = r.left + r.width * 0.35, y2 = r.top + r.height * 0.4;
      stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x1, clientY: y1, button: 0 }));
      for (let i = 1; i <= 6; i++) {
        const t = i / 6;
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x1 + (x2 - x1) * t, clientY: y1 + (y2 - y1) * t }));
      }
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x2, clientY: y2, button: 0 }));
      document.querySelector('#anno-exit').click();
      const list = window.__view.annos;
      const id = list.length ? list[list.length - 1].id : null;
      // 立刻进房（不等防抖）
      document.querySelector('#set-room-enabled').checked = true;
      document.querySelector('#room-connect').click();
      return id;
    })()`);
    check('离线画一笔后立刻进房（不给防抖留时间）', !!offlineId, String(offlineId));
    for (let i = 0; i < 40; i++) {
      const st = await ev(`window.api.roomStatus()`);
      if (st && st.status === 'online') break;
      await sleep(150);
    }
    joined = true;
    let backfilled = null;
    for (let i = 0; i < 50; i++) {
      const annos = peer.snapshot().annos[useMap] || [];
      backfilled = annos.find((a) => a.id === offlineId) || null;
      if (backfilled) break;
      await sleep(150);
    }
    check('重新进房后，离线画的那一笔补发给了队友', !!backfilled && backfilled.owner === selfId,
      backfilled ? `owner=${backfilled.owner}` : `队友没收到 ${offlineId}`);
    // 收尾：删掉这一笔（本地 + 房间），别把它留在用户文件里
    await ev(`(async () => {
      const id = ${JSON.stringify(useMap)};
      if (window.__anno) {
        if (window.__anno.saveTimer) { clearTimeout(window.__anno.saveTimer); window.__anno.saveTimer = null; }
        window.__anno.store[id] = (window.__anno.store[id] || []).filter((s) => s.id !== ${JSON.stringify(offlineId)});
        if (!window.__anno.store[id].length) delete window.__anno.store[id];
      }
      const all = await window.api.getAnnotations();
      if (all[id]) {
        all[id] = all[id].filter((s) => s.id !== ${JSON.stringify(offlineId)});
        if (!all[id].length) delete all[id];
      }
      await window.api.setAnnotations(all);
      await window.api.roomAnno({ op: 'del', map: id, id: ${JSON.stringify(offlineId)} });
      return true;
    })()`);
    await sleep(500);
  } finally {
    // 8) 收尾：还原。
    //    顺序有讲究：**先离开房间，再还原配置**。反过来的话，"离开房间"会把
    //    settings.room.enabled 改成 false —— 用户本来开着联机的话，收尾反而把他的开关关了
    //    （第一次跑就被这么坑了一道：还原检查报 enabled:false，其实是脚本自己关的）。
    try {
      if (peer) peer.destroy();
      if (scriptPeer) {
        try {
          scriptPeer.kill();
        } catch {}
      }
      if (joined && !(origRoom && origRoom.enabled)) await ev(`window.api.roomLeave()`);
      if (origRoom) {
        await ev(`window.api.setConfig({ room: ${JSON.stringify(origRoom)} })`);
      }
      if (origToggles) {
        // 房间成员的开关是动态长出来的，光"覆盖回去"删不掉，得显式传 null 清掉
        const cur = (await ev(`window.api.getConfig().then((c) => c.markerToggles || {})`)) || {};
        const restore = { ...origToggles };
        for (const k of Object.keys(cur)) if (!(k in origToggles)) restore[k] = null;
        await ev(`window.api.setConfig({ markerToggles: ${JSON.stringify(restore)} })`);
      }
      if (origAnnos) {
        await ev(`window.api.setAnnotations(${JSON.stringify(origAnnos)})`);
      }
      await ev(`document.querySelector('#settings-dialog').open && document.querySelector('#settings-dialog').close()`);
      const after = await ev(`window.api.getConfig().then((c) => c.room || null)`);
      check('收尾：房间配置已还原成用户原来的样子',
        JSON.stringify({ ...after, peerId: undefined }) === JSON.stringify({ ...origRoom, peerId: undefined }),
        JSON.stringify(after));
      const togAfter = await ev(`window.api.getConfig().then((c) => c.markerToggles || null)`);
      check('收尾：图例开关已还原', JSON.stringify(togAfter) === JSON.stringify(origToggles),
        `${Object.keys(togAfter || {}).length} 个开关`);
      const annoAfter = await ev(`window.api.getAnnotations()`);
      check('收尾：标注已还原', JSON.stringify(annoAfter) === JSON.stringify(origAnnos),
        JSON.stringify(Object.keys(annoAfter || {})));
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
