#!/usr/bin/env node
/**
 * 真·多客户端联机验收：**一个服务端 + 两个真 Electron 客户端**。
 *
 * 和 tools/verify-room.js 的区别：
 *   - verify-room.js：一个真客户端 + 脚本队友（跑得快，适合开发时回归）
 *   - 这个脚本：两个真客户端互相看（连截图定位 -> 房间 -> 对方地图这条完整链路都真跑）
 *
 * 脚本自己起服务端、自己拉两个客户端（第二个用 TAKOV_USER_DATA 换配置目录，互不干扰），
 * 跑完把两个客户端、服务端都收掉，并还原第一个客户端（也就是你日常用的那份）的配置。
 *
 * 用法：
 *   node tools/verify-room-2clients.js
 *   node tools/verify-room-2clients.js --port=8799 --keep    # 不自动关，留着看
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const SRV_PORT = Number(arg('port', 8799));
const CDP_A = Number(arg('cdp-a', 9222));
const CDP_B = Number(arg('cdp-b', 9223));
const KEEP = process.argv.includes('--keep');
const ART = path.join(ROOT, 'test-artifacts');
const ROOM = `双端验收-${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ------------------------------------------------------------------ CDP
async function targets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

function cdp(wsUrl, calls) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const out = [];
    ws.onopen = async () => {
      for (const [method, params] of calls) {
        const myId = ++id;
        const p = new Promise((res) => pending.set(myId, res));
        ws.send(JSON.stringify({ id: myId, method, params }));
        out.push(await p);
      }
      ws.close();
      resolve(out.map((m) => {
        const r = m && m.result;
        if (r && r.exceptionDetails) {
          const d = r.exceptionDetails;
          return { __error: (d.exception && (d.exception.description || d.exception.value)) || d.text };
        }
        if (r && r.data) return r.data;
        return r && 'result' in r ? r.result.value : m;
      }));
    };
    ws.onerror = (e) => reject(new Error(`ws error ${e.message || ''}`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    };
  });
}

function makeClient(port, label) {
  let ws = null;
  const api = {
    label,
    async attach() {
      for (let i = 0; i < 80; i++) {
        try {
          const t = (await targets(port)).find((x) => x.url.endsWith('/map.html'));
          if (t) {
            ws = t.webSocketDebuggerUrl;
            return true;
          }
        } catch {}
        await sleep(250);
      }
      return false;
    },
    ev(expr) {
      return cdp(ws, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]).then((r) => r[0]);
    },
    async shot(file) {
      const data = await cdp(ws, [['Page.captureScreenshot', { format: 'png' }]]);
      if (typeof data[0] === 'string') {
        fs.mkdirSync(ART, { recursive: true });
        fs.writeFileSync(path.join(ART, file), Buffer.from(data[0], 'base64'));
        console.log(`      截图 -> test-artifacts/${file}`);
      }
    },
    /** 填房间卡片并加入（走界面按钮，不是直接调 API） */
    async join(url, roomId, nick) {
      await api.ev('location.reload()');
      await sleep(2500);
      await api.ev(`document.querySelector('#btn-settings').click()`);
      await sleep(300);
      await api.ev(`(() => {
        const set = (sel, v) => { document.querySelector(sel).value = v; };
        set('#set-room-url', ${JSON.stringify(url)});
        set('#set-room-port', '${SRV_PORT}');
        set('#set-room-id', ${JSON.stringify(roomId)});
        set('#set-room-nick', ${JSON.stringify(nick)});
        document.querySelector('#set-room-enabled').checked = true;
        return true;
      })()`);
      await api.ev(`document.querySelector('#room-connect').click()`);
      await api.ev(`document.querySelector('#settings-dialog').open && document.querySelector('#settings-dialog').close()`);
      for (let i = 0; i < 60; i++) {
        const st = await api.ev('window.api.roomStatus()');
        if (st && st.status === 'online') return st;
        await sleep(250);
      }
      throw new Error(`${label} 没能进入 online`);
    },
  };
  return api;
}

// ------------------------------------------------------------------ 主流程
(async () => {
  // 1) 服务端（纯内存，随机房间）
  const srv = spawn(process.execPath, [path.join('server', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(SRV_PORT), HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', (d) => {
    srvLog += String(d);
  });
  srv.stderr.on('data', (d) => {
    srvLog += String(d);
  });
  const health = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${SRV_PORT}/healthz`);
        if (r.ok) return r.json();
      } catch {}
      await sleep(250);
    }
    return null;
  };
  const h = await health();
  check('服务端起来了（node server/server.js）', !!h && h.ok === true, h ? `v${h.ver} proto=${h.proto}` : srvLog.slice(0, 120));
  if (!h) process.exit(1);

  // 2) 两个真客户端（第二个换 userData，互不干扰）
  const altDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takov-alt-'));
  const electron = require('electron');
  const spawnClient = (cdpPort, userData) =>
    spawn(electron, ['.', `--remote-debugging-port=${cdpPort}`], {
      cwd: ROOT,
      env: userData ? { ...process.env, TAKOV_USER_DATA: userData } : { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const procA = spawnClient(CDP_A, null); // 甲：你日常这份配置（跑完会还原）
  const procB = spawnClient(CDP_B, altDir); // 乙：临时配置目录
  const A = makeClient(CDP_A, '甲');
  const B = makeClient(CDP_B, '乙');

  const cleanup = async () => {
    try {
      if (!KEEP) {
        procA.kill();
        procB.kill();
        srv.kill();
      }
    } catch {}
  };

  const origCfg = { room: null, toggles: null, annos: null };
  try {
    check('两个客户端都连上了调试端口', (await A.attach()) && (await B.attach()), `${CDP_A} / ${CDP_B}`);
    origCfg.room = await A.ev('window.api.getConfig().then((c) => c.room || null)');
    origCfg.toggles = await A.ev('window.api.getConfig().then((c) => c.markerToggles || null)');
    origCfg.annos = await A.ev('window.api.getAnnotations()');

    // 3) 两端进同一个房间
    const stA = await A.join('127.0.0.1', ROOM, '甲号');
    const stB = await B.join('127.0.0.1', ROOM, '乙号');
    check('甲进房', stA.status === 'online', `${stA.self.nick} / ${stA.self.id}`);
    check('乙进房', stB.status === 'online', `${stB.self.nick} / ${stB.self.id}`);

    // 4) 互相看得见
    const waitPeer = async (who, nick, field = 'peers') => {
      for (let i = 0; i < 60; i++) {
        const s = await who.ev('window.api.roomStatus()');
        const list = (s && s[field]) || [];
        const hit = list.find((p) => p.nick === nick);
        if (hit) return hit;
        await sleep(250);
      }
      return null;
    };
    const aSeesB = await waitPeer(A, '乙号');
    const bSeesA = await waitPeer(B, '甲号');
    check('甲看得到乙', !!aSeesB, aSeesB ? aSeesB.id : '-');
    check('乙看得到甲', !!bSeesA, bSeesA ? bSeesA.id : '-');
    const chipA = await A.ev(`document.querySelector('#room-chip').textContent`);
    check('甲顶栏显示 2 人', /2 人/.test(chipA), chipA);

    // 5) 同一个房间、同一张图：切到海关，两边都应该能画出对方
    for (const c of [A, B]) {
      await c.ev(`window.api.selectMap({ key: 'customs' })`);
      for (let i = 0; i < 40; i++) {
        if (await c.ev(`!!(window.__view && window.__view.detail && window.__view.detail.key === 'customs')`)) break;
        await sleep(200);
      }
    }
    const mapId = await A.ev('window.__view.detail.id');
    check('两个客户端都在海关（同一张图）', !!mapId, String(mapId));

    // 6) 真链路：往截图目录扔一张"带坐标的截图"，甲那边应当自动定位并把位置同步给乙
    const shotsDir = path.join(os.homedir(), 'Documents', 'Escape from Tarkov', 'Screenshots');
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const shotName = `2clients-verify_${Math.round(Date.now() / 1000)}_123.5, 4.5, -67.25_0, 0.90924, 0, 0.41476_15.47.png`;
    const shotName2 = `2clients-verify_${Math.round(Date.now() / 1000)}b_128.5, 4.5, -62.25_0, 0.90924, 0, 0.41476_15.47.png`;
    const shotName3 = `2clients-verify_${Math.round(Date.now() / 1000)}c_118.5, 4.5, -58.25_0, 0.90924, 0, 0.41476_15.47.png`;
    const shotPath = path.join(shotsDir, shotName);
    const shotPath2 = path.join(shotsDir, shotName2);
    const shotPath3 = path.join(shotsDir, shotName3);
    let shotDropped = false;
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      fs.writeFileSync(shotPath, png1x1);
      shotDropped = true;
    } catch (e) {
      console.log(`      （截图目录不可写，跳过真链路定位测试：${e.message}）`);
    }
    if (shotDropped) {
      const posA = await (async () => {
        for (let i = 0; i < 60; i++) {
          const s = await A.ev('window.api.getState()');
          if (s && s.position && Math.abs(s.position.x - 123.5) < 0.01) return s.position;
          await sleep(250);
        }
        return null;
      })();
      check('甲：截图被识别成定位（123.5 / -67.25）', !!posA && Math.abs(posA.z + 67.25) < 0.01, posA ? `${posA.x},${posA.y},${posA.z}` : '没识别到');
      // 再来一张：轨迹要两个点才画得成线（服务端会丢掉单点轨迹，客户端本地也一样）
      fs.writeFileSync(shotPath2, png1x1);
      const bPos = await (async () => {
        for (let i = 0; i < 60; i++) {
          const s = await B.ev('window.api.roomStatus()');
          const p = (s.peers || []).find((x) => x.nick === '甲号');
          if (p && p.pos && Array.isArray(p.pos.trail) && p.pos.trail.length >= 2) return p;
          await sleep(250);
        }
        return null;
      })();
      check('乙：收到了甲的两次定位与轨迹尾巴', !!bPos && bPos.pos.trail.length >= 2, bPos && bPos.pos ? `x=${bPos.pos.x} z=${bPos.pos.z} trail=${(bPos.pos.trail || []).length}` : '没收到轨迹');
      const bMark = await (async () => {
        for (let i = 0; i < 40; i++) {
          const m = await B.ev(`({ marks: document.querySelectorAll('.peer-mark').length, initials: [...document.querySelectorAll('.peer-mark text')].map((t) => t.textContent).join(',') })`);
          if (m && m.marks > 0) return m;
          await sleep(250);
        }
        return null;
      })();
      check('乙的地图上出现甲的标记（首字"甲"）', !!bMark && /甲/.test(bMark.initials), JSON.stringify(bMark));
      await B.shot('room-2clients-peer-on-map.png');
    }

    // 7) 甲画一笔 -> 乙能看到；乙按人关掉甲 -> 那一笔也跟着消失
    await A.ev(`document.querySelector('#btn-anno').click()`);
    await sleep(300);
    const drawnId = await A.ev(`(() => {
      const stage = document.querySelector('.mapstage');
      const r = stage.getBoundingClientRect();
      const x1 = r.left + r.width * 0.35, y1 = r.top + r.height * 0.4;
      const x2 = r.left + r.width * 0.55, y2 = r.top + r.height * 0.55;
      stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x1, clientY: y1, button: 0 }));
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x1 + (x2 - x1) * t, clientY: y1 + (y2 - y1) * t }));
      }
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x2, clientY: y2, button: 0 }));
      const list = window.__view.annos;
      return list.length ? list[list.length - 1].id : null;
    })()`);
    await A.ev(`document.querySelector('#anno-exit').click()`);
    const aId = stA.self.id;
    const bSeesAnno = await (async () => {
      for (let i = 0; i < 60; i++) {
        const mine = await B.ev(`window.api.roomStatus().then((s) => {
          const list = (s && s.annos && s.annos[${JSON.stringify(mapId)}]) || [];
          return list.find((a) => a.owner === ${JSON.stringify(aId)} && a.id === ${JSON.stringify(drawnId)}) || null;
        })`);
        if (mine) return mine;
        await sleep(250);
      }
      return null;
    })();
    check('乙收到甲画的标注（带 owner 与 id）', !!bSeesAnno, bSeesAnno ? `${bSeesAnno.kind} ${bSeesAnno.id}` : `id=${drawnId}`);
    const bAnnoNodes = await B.ev(`document.querySelectorAll('.peer-anno').length`);
    check('乙的地图上画出来了（.peer-anno）', bAnnoNodes >= 1, `count=${bAnnoNodes}`);
    const legendRow = await B.ev(`(() => {
      const sec = [...document.querySelectorAll('.legend-section')].find((s) => /房间成员/.test(s.textContent));
      if (!sec) return null;
      const rows = [...sec.querySelectorAll('.legend-item')].map((r) => ({
        name: r.querySelector('.legend-name').textContent.trim(),
        id: r.querySelector('input').dataset.group,
        checked: r.querySelector('input').checked,
      }));
      return rows;
    })()`);
    check('乙的图例里"甲号"一人一行', !!legendRow && legendRow.some((r) => /甲号/.test(r.name) && r.id === `peer:${aId}`), JSON.stringify(legendRow));
    // 关掉甲 -> 甲的标记与标注在乙这边一起消失
    await B.ev(`(() => {
      const sec = [...document.querySelectorAll('.legend-section')].find((s) => /房间成员/.test(s.textContent));
      const row = [...sec.querySelectorAll('.legend-item')].find((r) => r.querySelector('input').dataset.group === ${JSON.stringify(`peer:${aId}`)});
      if (row.querySelector('input').checked) row.querySelector('input').click();
      return true;
    })()`);
    await sleep(500);
    const bAfterOff = await B.ev(`({ marks: document.querySelectorAll('.peer-mark').length, annos: document.querySelectorAll('.peer-anno').length })`);
    check('乙关掉"甲号"后：他的标记与标注都隐藏', bAfterOff.marks === 0 && bAfterOff.annos === 0, JSON.stringify(bAfterOff));
    await B.ev(`(() => {
      const sec = [...document.querySelectorAll('.legend-section')].find((s) => /房间成员/.test(s.textContent));
      const row = [...sec.querySelectorAll('.legend-item')].find((r) => r.querySelector('input').dataset.group === ${JSON.stringify(`peer:${aId}`)});
      if (!row.querySelector('input').checked) row.querySelector('input').click();
      return true;
    })()`);
    await sleep(400);

    // 7) 甲换图（相当于进新局）：乙这边"他在这张图的点"必须消失，图例改成"他在哪张图"
    await A.ev(`window.api.selectMap({ key: 'woods' })`);
    let bMoved = null;
    for (let i = 0; i < 60; i++) {
      bMoved = await B.ev(`(() => {
        const sec = [...document.querySelectorAll('.legend-section')].find((s) => /房间成员/.test(s.textContent));
        const row = sec && sec.querySelector('.legend-item');
        return {
          marks: document.querySelectorAll('.peer-mark').length,
          name: row ? row.querySelector('.legend-name').textContent.trim() : '',
          count: row ? Number(row.querySelector('.legend-count').textContent) : -1,
        };
      })()`);
      if (bMoved && bMoved.marks === 0) break;
      await sleep(250);
    }
    check('甲换到森林后：乙图上他的标记消失（不留旧图上的假点）', !!bMoved && bMoved.marks === 0, JSON.stringify(bMoved));
    check('甲换到森林后：乙的图例显示"他在森林"且计数为 0',
      !!bMoved && /在森林/.test(bMoved.name) && bMoved.count === 0, bMoved ? `${bMoved.name} / count=${bMoved.count}` : '-');

    // 甲回到海关 + 再来一张截图 -> 乙图上重新出现他的标记
    await A.ev(`window.api.selectMap({ key: 'customs' })`);
    for (let i = 0; i < 40; i++) {
      if (await A.ev(`!!(window.__view && window.__view.detail && window.__view.detail.key === 'customs')`)) break;
      await sleep(200);
    }
    fs.writeFileSync(shotPath3, png1x1);
    let bBack = null;
    for (let i = 0; i < 60; i++) {
      bBack = await B.ev(`({ marks: document.querySelectorAll('.peer-mark').length })`);
      if (bBack && bBack.marks === 1) break;
      await sleep(250);
    }
    check('甲回到海关并重新定位后：乙图上又出现他的标记', !!bBack && bBack.marks === 1, JSON.stringify(bBack));

    // 8) 甲离开 -> 乙那边立刻少一个人
    await A.ev(`document.querySelector('#room-disconnect').click()`);
    let bPeers = null;
    for (let i = 0; i < 60; i++) {
      const s = await B.ev('window.api.roomStatus()');
      bPeers = (s && s.peers) || [];
      if (bPeers.length === 0) break;
      await sleep(250);
    }
    check('甲离开房间后乙那边人没了', Array.isArray(bPeers) && bPeers.length === 0, `peers=${(bPeers || []).length}`);

    // 收尾还原（甲用的是你日常那份配置）
    if (origCfg.room) {
      await A.ev(`window.api.setConfig({ room: ${JSON.stringify(origCfg.room)} })`);
    }
    if (origCfg.toggles) {
      const cur = (await A.ev(`window.api.getConfig().then((c) => c.markerToggles || {})`)) || {};
      const restore = { ...origCfg.toggles };
      for (const k of Object.keys(cur)) if (!(k in origCfg.toggles)) restore[k] = null;
      await A.ev(`window.api.setConfig({ markerToggles: ${JSON.stringify(restore)} })`);
    }
    await A.ev(`(async () => {
      if (window.__anno && window.__anno.saveTimer) { clearTimeout(window.__anno.saveTimer); window.__anno.saveTimer = null; }
      const all = await window.api.getAnnotations();
      for (const k of Object.keys(all)) {
        all[k] = all[k].filter((s) => !(s.id === ${JSON.stringify(drawnId)}));
        if (!all[k].length) delete all[k];
      }
      await window.api.setAnnotations(${JSON.stringify(origCfg.annos || {})});
      return true;
    })()`);
    await sleep(900);
    const roomAfter = await A.ev(`window.api.getConfig().then((c) => c.room || null)`);
    check('收尾：甲的配置已还原', JSON.stringify({ ...roomAfter, peerId: undefined }) === JSON.stringify({ ...origCfg.room, peerId: undefined }), JSON.stringify(roomAfter));
    const annoAfter = await A.ev(`window.api.getAnnotations()`);
    check('收尾：甲的标注已还原', JSON.stringify(annoAfter) === JSON.stringify(origCfg.annos || {}), JSON.stringify(Object.keys(annoAfter || {})));

    if (shotDropped) {
      for (const f of [shotPath, shotPath2, shotPath3]) {
        try {
          fs.unlinkSync(f);
        } catch {}
      }
      console.log('      已删除三张测试用截图');
    }
  } finally {
    if (KEEP) {
      console.log('\n--keep：服务端与两个客户端保持运行，自己看吧（Ctrl+C 结束本脚本不会关它们）');
    } else {
      await cleanup();
      await sleep(1500);
    }
    try {
      fs.rmSync(altDir, { recursive: true, force: true });
    } catch {}
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    console.log('失败项: ' + bad.map((b) => b.name).join(' / '));
    process.exit(1);
  }
})().catch(async (e) => {
  console.error('验收脚本出错:', e.message);
  process.exit(1);
});
