#!/usr/bin/env node
/**
 * 队友共享勾选任务 + 「进图要带」验收（E2E）：真起客户端 + 真起房间服务端 + 一个假队友。
 *
 * 验的是这几条需求：
 *   1) 我勾的任务会共享给队友（假队友要收到 quests 消息）
 *   2) 队友勾的任务画在我的图上，**同一个任务两人都勾只画一次**（合并），
 *      鼠标悬停/列表/明细都能看出"是谁勾的"
 *   3) 任务列表里能看出是我勾的还是队友勾的（`我` / 昵称 角标）
 *   4) 新增的「队友勾选」筛选真的能筛；和「已勾选」两个都开 = 只看交集
 *   5) 图例里有「XX勾选的任务」，关掉只隐藏"只被他勾"的任务
 *   6) 展开明细最上面是黄色高亮的「进图要带」（钥匙/要带物品）
 *
 * 隔离：临时 userData（TAKOV_USER_DATA）+ 内存态服务端，不碰你的真实配置与房间。
 *
 * 用法: node tools/verify-quest-share.js [--port=9334] [--keep]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9334));
const ROOT = path.join(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { createRoomServer } = require('../server/server.js');
const P = require('../server/protocol.js');
const ROOM_ID = '自检共享勾选';
const ROOM_PASS = 'pw';
const MY_PID = 'peerMEEE';
const PEER_PID = 'peerAGAN';
const PEER_NICK = '阿甘';

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

function cdp(wsUrl, calls, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    let done = false;
    const pending = new Map();
    const results = [];
    const hard = setTimeout(() => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      reject(new Error(`CDP 超时（${timeoutMs}ms）：${calls.map((c) => c[0]).join(',')}`));
    }, timeoutMs);
    ws.onopen = async () => {
      for (const [method, params] of calls) {
        const myId = ++id;
        const p = new Promise((res) => pending.set(myId, res));
        ws.send(JSON.stringify({ id: myId, method, params }));
        results.push(await p);
      }
      ws.close();
      if (done) return;
      done = true;
      clearTimeout(hard);
      resolve(results.map((m) => {
        const r = m && m.result;
        if (r && r.exceptionDetails) {
          const d = r.exceptionDetails;
          return { __error: (d.exception && (d.exception.description || d.exception.value)) || d.text };
        }
        if (r && r.data) return r.data;
        return r && 'result' in r ? r.result.value : m;
      }));
    };
    ws.onerror = (e) => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      reject(new Error('ws error ' + (e.message || '')));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    };
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function makeProfile(port) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'takov-questshare-'));
  const shots = path.join(userData, 'shots');
  const logs = path.join(userData, 'logs');
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    logsPath: logs,
    screenshotsPath: shots,
    sound: false,
    miniVisible: false,
    room: {
      enabled: true,
      url: '127.0.0.1',
      port,
      roomId: ROOM_ID,
      pass: ROOM_PASS,
      nick: '我',
      peerId: MY_PID,
      sharePos: false,
      shareAnno: false,
      shareQuests: true,
    },
  }, null, 2));
  return { userData, shots, logs };
}

/** 假队友：收消息进队列，next(t) 按类型取 */
function makePeer(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    let m = null;
    try { m = JSON.parse(e.data); } catch { return; }
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) { waiters.splice(i, 1)[0].resolve(m); return; }
    inbox.push(m);
  });
  ws.addEventListener('error', () => {});
  return {
    open: () => new Promise((res, rej) => {
      ws.addEventListener('open', () => res(true), { once: true });
      ws.addEventListener('error', (e) => rej(new Error(`假队友连不上: ${e.message || 'error'}`)), { once: true });
    }),
    send: (o) => ws.send(JSON.stringify(o)),
    hello: () => ws.send(JSON.stringify({ t: 'hello', v: P.PROTO, room: P.roomKey(ROOM_ID, ROOM_PASS), nick: PEER_NICK, pid: PEER_PID })),
    next(t, timeout = 8000) {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`假队友等「${t}」超时；已收到 ${JSON.stringify(inbox).slice(0, 300)}`)), timeout);
        waiters.push({ t, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    close: () => { try { ws.close(); } catch {} },
  };
}

(async () => {
  const srv = createRoomServer({ host: '127.0.0.1', port: 0, logLevel: 'error' });
  const port = await new Promise((r) => srv.start(r));
  const prof = makeProfile(port);
  const proc = spawn(require('electron'), [
    '.',
    `--remote-debugging-port=${PORT}`,
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ], {
    cwd: ROOT,
    env: { ...process.env, TAKOV_USER_DATA: prof.userData, HTTP_PROXY: '', HTTPS_PROXY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = [];
  proc.stdout.on('data', (d) => tail.push(String(d)));
  proc.stderr.on('data', (d) => tail.push(String(d)));
  const kill = () => {
    try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    try { proc.kill(); } catch {}
  };

  let peer = null;
  try {
    // ---------------------------------------------------------------- 起客户端
    let mapWs = null;
    for (let i = 0; i < 120; i++) {
      try {
        const t = (await targets()).find((x) => x.url.endsWith('/map.html'));
        if (t) { mapWs = t.webSocketDebuggerUrl; break; }
      } catch {}
      await sleep(250);
    }
    if (!mapWs) throw new Error(`客户端没起来（端口 ${PORT}）；输出：\n${tail.join('').slice(-1200)}`);
    // 表达式抛异常时要直接炸出来（否则拿到 {__error} 会一路装成"返回了个怪东西"）
    const ev = async (expr) => {
      const v = await cdp(mapWs, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]).then((r) => r[0]);
      if (v && typeof v === 'object' && v.__error) throw new Error(`页面里执行失败：${String(v.__error).split('\n')[0]}`);
      return v;
    };

    // 房间连上（服务端在起客户端之前就起来了）
    let online = null;
    for (let i = 0; i < 40; i++) {
      online = await ev('window.api.roomStatus().then((s) => (s && s.status) || null)');
      if (online === 'online') break;
      await sleep(300);
    }
    check('客户端已连上本地房间服务端', online === 'online', String(online));

    // ---------------------------------------------------------------- 假队友进房
    peer = makePeer(`ws://127.0.0.1:${port}/ws`);
    await peer.open();
    peer.hello();
    const welcome = await peer.next('welcome');
    check('服务端 welcome 声明了 quests 能力', Array.isArray(welcome.caps) && welcome.caps.includes('quests'), JSON.stringify(welcome.caps));

    // 等渲染层初始化完成再操作：地图下拉被填充 = init() 已经走到注册 onState 之后，
    // 否则此刻 selectMap 的广播会赶在监听器注册之前发出，直接被丢掉（踩过）。
    let pageReady = false;
    for (let i = 0; i < 60; i++) {
      pageReady = await ev(`!!(document.querySelector('#map-select') && document.querySelector('#map-select').options.length > 1 && window.__quest && window.__view)`);
      if (pageReady === true) break;
      await sleep(250);
    }
    check('渲染层初始化完成（地图下拉已填充 / __view 与任务库就位）', pageReady === true, String(pageReady));

    // ---------------------------------------------------------------- 我勾一个任务
    await ev(`window.api.selectMap({ key: 'customs' })`);
    // 等地图与任务库都就绪（7MB maps-dump + 880KB quests-dump，别抢跑）
    let ready = null;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      ready = await ev(`(() => ({
        map: !!(window.__view && window.__view.detail),
        quests: !!(window.__quest && window.__quest.dump),
        mapId: window.__view && window.__view.detail ? window.__view.detail.id : null,
      }))()`);
      if (ready && ready.map && ready.quests && ready.mapId) break;
    }
    check('海关已加载 + 任务库已就绪', !!(ready && ready.map && ready.quests), JSON.stringify(ready));

    const candidates = await ev(`(() => {
      const v = window.__view, q = window.__quest;
      const mapId = v.detail.id;
      const out = [];
      for (const t of (q.dump && q.dump.tasks) || []) {
        let zones = 0, spots = 0;
        for (const o of t.objectives || []) {
          for (const z of o.zones || []) if (!z.map || z.map === mapId) zones++;
          for (const s of o.spots || []) if (!s.map || s.map === mapId) spots++;
        }
        if (zones || spots) out.push({ id: t.id, name: t.name, zones, spots });
        if (out.length >= 30) break;
      }
      return out;
    })()`);
    check('找到本图有地点的任务候选', Array.isArray(candidates) && candidates.length >= 2,
      Array.isArray(candidates) ? `${candidates.length} 个` : String(candidates));
    if (!Array.isArray(candidates) || candidates.length < 2) throw new Error('候选任务不足，后面的断言没法做');

    const toggle = (id, name, on) => ev(`(async () => {
      const box = document.querySelector('#quest-q');
      box.value = ${JSON.stringify(name)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const row = document.querySelector('#quest-list .quest-row[data-task-id=' + JSON.stringify(${JSON.stringify(id)}) + ']');
      if (!row) return { row: false };
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb.checked !== ${on ? 'true' : 'false'}) cb.click();
      await new Promise((r) => setTimeout(r, 900));
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return { row: true, checked: cb.checked, items: (window.__view.questItems || []).length };
    })()`);

    // 找一个"勾上就能画出来"的任务（击杀类默认不画，可能要试几个）
    let mine = null;
    for (const cand of (candidates || []).slice(0, 8)) {
      const r = await toggle(cand.id, cand.name, true);
      if (r && r.row && r.items >= 1) { mine = cand; break; }
      if (r && r.row) await toggle(cand.id, cand.name, false);
    }
    check('勾选的任务画到了地图上', !!mine, mine ? mine.name : '8 个候选都没画出来');

    // 共享出去（勾选 -> config:set -> 主进程 pushQuests -> 服务端广播 peer-quests 给其他人）
    let shared = null;
    try {
      // 注意：服务端**不回显给本人**，队友收到的是 peer-quests（带着我的 peerId），不是 quests
      shared = await peer.next('peer-quests', 8000);
    } catch (e) {
      shared = null;
    }
    check('假队友收到了我共享的勾选任务（peer-quests）',
      !!shared && shared.id === MY_PID && Array.isArray(shared.ids) && shared.ids.includes(mine && mine.id),
      shared ? JSON.stringify(shared).slice(0, 140) : '没收到');

    // ---------------------------------------------------------------- 队友勾：一个相同的 + 一个只他勾的
    const peerOnly = (candidates || []).find((c) => !mine || c.id !== mine.id) || null;
    check('还有一个"只队友勾"的候选任务', !!peerOnly, peerOnly ? peerOnly.name : '没有第二个候选');
    peer.send({ t: 'quests', ids: [mine.id, peerOnly.id] });
    await sleep(1500);

    // 合并显示：同一个任务只画一次，且能看出是谁勾的
    const merged = await ev(`(() => {
      const items = window.__view.questItems || [];
      const same = items.filter((it) => it.id === ${JSON.stringify(mine.id)});
      const only = items.filter((it) => it.id === ${JSON.stringify(peerOnly.id)});
      return {
        sameCount: same.length,
        mine: same[0] ? same[0].mine : null,
        peers: same[0] ? same[0].peers : null,
        ownersText: same[0] ? same[0].ownersText : null,
        onlyCount: only.length,
        onlyMine: only[0] ? only[0].mine : null,
        onlyPeers: only[0] ? only[0].peers : null,
      };
    })()`);
    check('两人都勾的任务只画一次（合并，不重复）', merged.sameCount === 1, `画了 ${merged.sameCount} 次`);
    check('合并项同时标出"我也勾了"和队友', merged.mine === true && Array.isArray(merged.peers) && merged.peers.includes(PEER_PID), JSON.stringify(merged));
    check('合并项的勾选人是"你 + 阿甘"', typeof merged.ownersText === 'string' && merged.ownersText.includes('你') && merged.ownersText.includes(PEER_NICK), String(merged.ownersText));
    check('只被队友勾的任务也在图上（但不是"我勾的"）', merged.onlyCount === 1 && merged.onlyMine === false && merged.onlyPeers.includes(PEER_PID), JSON.stringify({ n: merged.onlyCount, mine: merged.onlyMine }));

    // ---------------------------------------------------------------- 列表角标
    const badges = await ev(`(() => {
      const rowOf = (id) => document.querySelector('#quest-list .quest-row[data-task-id=' + JSON.stringify(id) + ']');
      const read = (id) => {
        const r = rowOf(id);
        if (!r) return null;
        return {
          mine: !!r.querySelector('.qbadge.mine'),
          peers: [...r.querySelectorAll('.qbadge.peer')].map((e) => e.textContent.trim() + '|' + e.title),
          rowChecked: r.classList.contains('checked'),
        };
      };
      return { shared: read(${JSON.stringify(mine.id)}), peerOnly: read(${JSON.stringify(peerOnly.id)}) };
    })()`);
    check('列表里"我 + 队友都勾"的行：有「我」角标 + 队友昵称角标',
      !!badges.shared && badges.shared.mine && badges.shared.peers.length === 1 && badges.shared.peers[0].includes(PEER_NICK),
      JSON.stringify(badges.shared));
    check('列表里"只队友勾"的行：没有「我」角标，但有队友角标、且行不显示为已勾选',
      !!badges.peerOnly && badges.peerOnly.mine === false && badges.peerOnly.peers.length === 1 && badges.peerOnly.rowChecked === false,
      JSON.stringify(badges.peerOnly));

    // ---------------------------------------------------------------- 展开明细：谁勾选的
    const detail = await ev(`(async () => {
      const row = document.querySelector('#quest-list .quest-row[data-task-id=' + JSON.stringify(${JSON.stringify(mine.id)}) + ']');
      if (!row) return null;
      row.querySelector('.quest-row-main').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      const owner = row.querySelector('.quest-detail .quest-owner');
      return { owner: owner ? owner.textContent.replace(/\\s+/g, ' ').trim() : null, all: row.querySelector('.quest-detail') ? row.querySelector('.quest-detail').textContent.slice(0, 80) : null };
    })()`);
    check('展开明细写着"谁勾选：你 + 阿甘"',
      !!detail && !!detail.owner && detail.owner.includes('你') && detail.owner.includes(PEER_NICK),
      JSON.stringify(detail && detail.owner));

    // ---------------------------------------------------------------- 「队友勾选」筛选
    const chipState = () => ev(`(() => ({
      checked: document.querySelector('#qc-checked').classList.contains('active'),
      peer: document.querySelector('#qc-peer').classList.contains('active'),
    }))()`);
    const rowIds = () => ev(`[...document.querySelectorAll('#quest-list .quest-row')].map((r) => r.dataset.taskId)`);
    const clickChip = (sel) => ev(`(() => { document.querySelector('${sel}').click(); return true; })()`);

    // 只开「队友勾选」
    await clickChip('#qc-peer');
    await clickChip('#qc-map'); // 关掉「本图」让列表更全（免得别的筛选干扰）
    await sleep(400);
    let st = await chipState();
    let ids = await rowIds();
    check('开「队友勾选」-> 列表里有队友勾的任务',
      st.peer === true && ids.includes(peerOnly.id) && ids.includes(mine.id),
      `chips=${JSON.stringify(st)} 命中=${ids.filter((x) => x === peerOnly.id || x === mine.id).length}`);

    // 再开「已勾选」-> 变成交集：只剩"我也勾了"的那个
    await clickChip('#qc-checked');
    await sleep(400);
    st = await chipState();
    ids = await rowIds();
    check('两个筛选都开 = 只看交集（只剩我和队友都勾的那个）',
      st.checked === true && st.peer === true && ids.includes(mine.id) && !ids.includes(peerOnly.id),
      `勾选=${ids.includes(mine.id)} 只他勾=${ids.includes(peerOnly.id)}`);

    // 只开「已勾选」-> 队友独有的那个不该出现（但队友勾的合并项还在，因为我也勾了）
    await clickChip('#qc-peer');
    await sleep(400);
    ids = await rowIds();
    check('只开「已勾选」-> 只列我勾的（队友独有任务不出现）',
      ids.includes(mine.id) && !ids.includes(peerOnly.id), `命中我=${ids.includes(mine.id)} 命中他=${ids.includes(peerOnly.id)}`);
    await clickChip('#qc-checked'); // 恢复
    await clickChip('#qc-map');     // 恢复本图
    await sleep(400);

    // ---------------------------------------------------------------- 图例：XX勾选的任务
    const legend = await ev(`window.__view.getLegend().flatMap((g) => g.items).filter((it) => it.id.startsWith('quest:peer:'))`);
    check('图例里有「阿甘勾选的任务」那一项',
      Array.isArray(legend) && legend.length === 1 && legend[0].id === `quest:peer:${PEER_PID}` && /勾选的任务$/.test(legend[0].label) && legend[0].count >= 1,
      JSON.stringify(legend));

    const afterToggle = await ev(`(async () => {
      const row = [...document.querySelectorAll('#legend-body .legend-item')].find((r) => r.querySelector('input').dataset.group === 'quest:peer:${PEER_PID}');
      if (!row) return { found: false };
      const input = row.querySelector('input');
      input.click();
      await new Promise((r) => setTimeout(r, 600));
      const items = window.__view.getLegend().flatMap((g) => g.items).filter((it) => it.id.startsWith('quest:peer:'));
      const toggleOff = window.__view.markerToggles['quest:peer:${PEER_PID}'] === false;
      input.click();
      await new Promise((r) => setTimeout(r, 500));
      const back = window.__view.getLegend().flatMap((g) => g.items).filter((it) => it.id.startsWith('quest:peer:'));
      return { found: true, toggleOff, countAfterOff: items.length ? items[0].count : -1, countBack: back.length ? back[0].count : -1 };
    })()`);
    check('关掉那一项 -> 只隐藏"只被他勾"的任务（计数从 2 掉到 1，我勾的那个照旧画）',
      afterToggle.found === true && afterToggle.toggleOff === true && afterToggle.countAfterOff === 1,
      JSON.stringify(afterToggle));
    check('再打开那一项 -> 计数回到 2（开关是活的，不是一次性）',
      afterToggle.countBack === 2, JSON.stringify(afterToggle));

    // ---------------------------------------------------------------- 「进图要带」
    // 挑一个"要钥匙 + 在本图有地点"的任务（否则会被"本图/有地点"筛选挡在列表外，找不到行）
    const bring = await ev(`(async () => {
      const mapId = window.__view.detail.id;
      const tasks = (window.__quest.dump && window.__quest.dump.tasks) || [];
      const hasKey = (t) => (t.objectives || []).some((o) => (o.requiredKeys || []).length);
      const onMap = (t) => (t.objectives || []).some((o) => (o.zones || []).some((z) => !z.map || z.map === mapId) || (o.spots || []).some((s) => !s.map || s.map === mapId));
      const t = tasks.find((x) => hasKey(x) && onMap(x)) || tasks.find(hasKey);
      if (!t) return { found: false };
      const box = document.querySelector('#quest-q');
      const search = async (v) => { box.value = v; box.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 500)); };
      await search(t.name);
      let row = document.querySelector('#quest-list .quest-row[data-task-id=' + JSON.stringify(t.id) + ']');
      // 兜底：被"本图"挡住就把本图关掉再搜一遍
      if (!row) {
        document.querySelector('#qc-map').click();
        await search(t.name);
        row = document.querySelector('#quest-list .quest-row[data-task-id=' + JSON.stringify(t.id) + ']');
        document.querySelector('#qc-map').click();
      }
      if (!row) { await search(''); return { found: true, row: false, name: t.name }; }
      const badge = row.querySelector('.qbadge.bring');
      row.querySelector('.quest-row-main').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      const block = row.querySelector('.quest-detail .quest-bring');
      const keys = block ? [...block.querySelectorAll('.qb-keys')].map((e) => e.textContent.trim()) : [];
      const out = {
        found: true, row: true, name: t.name,
        badge: badge ? badge.textContent.trim() : null,
        block: block ? block.textContent.replace(/\\s+/g, ' ').trim() : null,
        keys,
        yellow: block ? getComputedStyle(block).borderLeftColor : null,
      };
      await search('');
      return out;
    })()`);
    check('要钥匙的任务：折叠行有黄色「带N」角标', !!bring && bring.row === true && !!bring.badge,
      `${bring && bring.name} → ${bring && bring.badge}`);
    check('展开明细最上面有「进图要带」并列出钥匙',
      !!bring && !!bring.block && bring.block.startsWith('进图要带') && (bring.keys || []).some((k) => k.includes('钥匙')),
      String(bring && bring.block).slice(0, 100));
    check('「进图要带」是黄色高亮（rgba(250,204,21)）',
      !!bring && /250,\s*204,\s*21/.test(String(bring.yellow)), String(bring && bring.yellow));
  } finally {
    if (peer) peer.close();
    kill();
    await sleep(600);
    await new Promise((r) => srv.close(r));
    if (!KEEP) {
      for (let i = 0; i < 6; i++) {
        try { fs.rmSync(prof.userData, { recursive: true, force: true }); break; } catch { await sleep(300); }
      }
    } else {
      console.log(`[keep] 临时配置目录: ${prof.userData}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('；'));
    process.exit(1);
  }
})().catch((e) => {
  console.error('验收失败：', e.message);
  process.exit(2);
});
