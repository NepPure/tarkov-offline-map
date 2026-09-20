#!/usr/bin/env node
/**
 * 真·多客户端联机自检：拿**你自己部署的服务端**跑一遍完整链路，并留截图。
 *
 * 和另外两个脚本的分工：
 *   - tools/verify-room.js           本机起服务端 + 1 个真客户端（开发回归，最快）
 *   - tools/verify-room-2clients.js  本机起服务端 + 2 个真客户端（自动化验收）
 *   - 这个脚本                        连**远端真实服务端**（wss:// 也行）+ N 个真客户端，
 *                                     走"往截图目录扔带坐标的截图 -> 自动定位 -> 同步给队友"
 *                                     这条真链路，最后把每个客户端的大图 + 雷达截图存下来。
 *
 * 每个客户端一份独立配置目录（TAKOV_USER_DATA），截图目录也各自独立 ——
 * 你真实的 settings.json / 截图文件夹 / 日常那份客户端一律不受影响。
 *
 * 用法：
 *   node tools/verify-room-live.js --url=wss://example.invalid --port=443 --room=联机自检
 *   node tools/verify-room-live.js --url=192.168.1.10 --port=8787 --room=123 --clients=4
 *   node tools/verify-room-live.js ... --keep      # 跑完不关客户端，留着自己点着玩
 *
 * 跑完截图在 test-artifacts/live-*.png
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=').slice(1).join('=') : d;
};
const HAS = (f) => process.argv.includes(f);
const SRV_URL = arg('url', 'wss://example.invalid');
const SRV_PORT = Number(arg('port', 443));
const ROOM = arg('room', `联机自检-${Date.now().toString(36)}`);
const PASS = arg('pass', '');
const N = Math.max(2, Math.min(4, Number(arg('clients', 3))));
const BASE_CDP = Number(arg('cdp', 9222));
const KEEP = HAS('--keep');
const ART = path.join(ROOT, 'test-artifacts');
const NICKS = ['甲号', '乙号', '丙号', '丁号'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const LOG_FILE = path.join(ART, '联机自检-运行日志.txt');
/** 打印 + 同时落一份 UTF-8 日志（PowerShell 重定向会写成 UTF-16，中文会乱，所以自己写） */
function say(line) {
  console.log(line);
  try {
    fs.mkdirSync(ART, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {}
}
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ------------------------------------------------------------------ CDP
async function targets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

/** 一次 CDP 调用，带超时兜底：渲染进程忙（大地图重排/重绘）时不能让脚本干等 */
function cdp(wsUrl, calls, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    let done = false;
    const pending = new Map();
    const out = [];
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      reject(new Error(`CDP 调用超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      fn(arg);
    };
    ws.onopen = async () => {
      try {
        for (const [method, params] of calls) {
          const myId = ++id;
          const p = new Promise((res) => pending.set(myId, res));
          ws.send(JSON.stringify({ id: myId, method, params }));
          out.push(await p);
        }
      } catch (e) {
        finish(reject, e);
        return;
      }
      finish(resolve, out.map((m) => {
        const r = m && m.result;
        if (r && r.exceptionDetails) return { __error: r.exceptionDetails.text };
        if (r && r.data) return r.data;
        return r && 'result' in r ? r.result.value : m;
      }));
    };
    ws.onerror = (e) => finish(reject, new Error(`ws error ${e.message || ''}`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    };
  });
}

/** 一个真客户端：独立配置目录 + 独立截图目录 + 独立调试端口 */
function makeClient(i) {
  const nick = NICKS[i];
  const cdpPort = BASE_CDP + i;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `takov-live-${i}-`));
  const shots = path.join(userData, 'shots');
  const logs = path.join(userData, 'logs');
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });

  // 拿用户日常那份 settings.json 当底子（这样雷达窗口是开的，才看得到小地图效果），但：
  //   - 截图目录 / 日志目录都换成自己的临时目录
  //       · 假的定位截图不会掉进用户真实的截图文件夹
  //       · 不会去啃用户真实的游戏日志（否则启动时回放昨天那局的进图行，会把演示的图切走，
  //         也会在用户真在游戏里时跟着乱切）
  //   - 房间先关掉：别让这个临时实例一启动就用用户的身份连进他真实的房间
  //   - 玩家/轨迹两个图例开关临时打开：演示截图里要能看到"自己"（用户自己那份是关着的）
  const live = path.join(process.env.APPDATA || '', 'tarkov-offline-map', 'settings.json');
  if (fs.existsSync(live)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(live, 'utf8'));
      cfg.screenshotsPath = shots;
      cfg.logsPath = logs;
      cfg.sound = false;
      cfg.autoDeleteScreenshots = false;
      cfg.room = { ...(cfg.room || {}), enabled: false };
      // 身份必须每个客户端各不相同！settings.json 里那份 peerId 直接抄过来的话，
      // N 个客户端就是"同一个人"，服务端会把先来的踢掉（err=相同身份在别处重连），
      // 表现就是"在线 · 1 人"、永远看不到队友。删掉它让每个实例自己生成一个。
      delete cfg.room.peerId;
      cfg.markerToggles = { ...(cfg.markerToggles || {}), player: true, trail: true };
      fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(cfg, null, 2));
    } catch {}
  }

  const proc = spawn(require('electron'), [
    '.',
    `--remote-debugging-port=${cdpPort}`,
    // N 个窗口叠在一起时，被挡住的那个渲染进程会被 Chromium 判定为"不可见"而停止出帧，
    // 于是 Page.captureScreenshot 一直等不到新帧（卡到超时）。这三个开关关掉那套节流。
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ], {
    cwd: ROOT,
    env: { ...process.env, TAKOV_USER_DATA: userData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const api = {
    nick, cdpPort, userData, shots, proc, ws: null, miniWs: null,
    async attach() {
      for (let i = 0; i < 100; i++) {
        try {
          const list = await targets(cdpPort);
          const t = list.find((x) => x.url.endsWith('/map.html'));
          if (t) {
            api.ws = t.webSocketDebuggerUrl;
            const mini = list.find((x) => x.url.endsWith('/minimap.html'));
            api.miniWs = mini ? mini.webSocketDebuggerUrl : null;
            return true;
          }
        } catch {}
        await sleep(250);
      }
      return false;
    },
    ev(expr) {
      return cdp(api.ws, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]).then((r) => r[0]);
    },
    miniEv(expr) {
      if (!api.miniWs) return Promise.resolve(null);
      return cdp(api.miniWs, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]).then((r) => r[0]);
    },
    async shot(file, which = 'map') {
      const target = which === 'mini' ? api.miniWs : api.ws;
      // 抓之前把窗口提到最前：被别的窗口挡住时 Chromium 可能不出帧，截图就会卡住
      try { await cdp(target, [['Page.bringToFront']], 15000); } catch {}
      await sleep(300);
      // 按窗口原尺寸抓。试过用 Emulation 把视口改成 1600x1000 让图小一点，结果
      // 大地图（上万个标记）要按新尺寸整体重排，captureScreenshot 直接卡住几分钟 —— 别改。
      const data = await cdp(target, [['Page.captureScreenshot', { format: 'png' }]], 90000);
      if (typeof data[0] === 'string') {
        fs.mkdirSync(ART, { recursive: true });
        fs.writeFileSync(path.join(ART, file), Buffer.from(data[0], 'base64'));
        say(`      截图 -> test-artifacts/${file}（${(Buffer.from(data[0], 'base64').length / 1048576).toFixed(2)}MB）`);
        return true;
      }
      return false;
    },
    /** 往自己的截图目录扔一张"带坐标的截图"（文件名就是游戏那种格式） */
    dropShot(x, y, z, yawDeg) {
      const rad = (yawDeg * Math.PI) / 360; // 四元数用半角
      const name = `live-check_${Math.round(Date.now() / 1000)}_${i}${Math.round(Math.random() * 1e4)}_` +
        `${x}, ${y}, ${z}_0, ${Math.sin(rad).toFixed(5)}, 0, ${Math.cos(rad).toFixed(5)}_15.47.png`;
      const p = path.join(shots, name);
      fs.writeFileSync(p, PNG_1x1);
      return p;
    },
  };
  return api;
}

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// 站位：海关东侧一片空地，彼此 15~25 米，朝向各不相同（箭头一眼能看出区别）
const SPOTS = [
  [[123.5, 4.5, -67.25], [128.5, 4.5, -62.25]],
  [[140.0, 4.5, -55.0], [143.5, 4.5, -52.0]],
  [[112.0, 4.5, -78.0], [115.5, 4.5, -75.0]],
  [[133.0, 4.5, -70.0], [136.0, 4.5, -67.0]],
];
const YAWS = [0, 90, 200, 300];

// ------------------------------------------------------------------ 主流程
(async () => {
  try { fs.writeFileSync(LOG_FILE, ''); } catch {}
  say(`服务端: ${SRV_URL}:${SRV_PORT}   房间: ${ROOM}   客户端数: ${N}`);
  say(`时间: ${new Date().toLocaleString('zh-CN')}   节点: ${process.version}   目录: ${ROOT}`);
  const clients = [];
  const cleanup = () => {
    for (const c of clients) {
      try { c.proc.kill(); } catch {}
    }
  };
  process.on('exit', cleanup);

  try {
    // 1) 起 N 个真客户端
    for (let i = 0; i < N; i++) clients.push(makeClient(i));
    const attached = [];
    for (const c of clients) attached.push(await c.attach());
    check(`${N} 个真客户端都起来了（各自独立配置目录）`, attached.every(Boolean),
      clients.map((c) => `${c.nick}:${c.cdpPort}`).join(' '));
    if (!attached.every(Boolean)) throw new Error('有客户端没能连上调试端口');

    // 2) 各自进同一个房间（走界面按钮，不是直接调 API）——并行，别让先连上的那个
    //    孤零零挂着"在线 · 1 人"太久（看着像没生效）
    await Promise.all(clients.map(async (c) => {
      await c.ev(`location.reload()`);
      await sleep(2200);
      // 先确认它监听的是**自己那份**截图目录：这是"假截图能不能触发真流程"的前提
      const st = await c.ev(`window.api.getState()`);
      const watchDir = st && st.shotWatcherStatus && st.shotWatcherStatus.dir;
      check(`${c.nick} 监听的是自己的临时截图目录`, watchDir === c.shots,
        watchDir ? String(watchDir).replace(c.userData, '<自己的临时目录>') : '读不到');
      const ok = await c.ev(`(async () => {
        const set = (sel, v) => { document.querySelector(sel).value = v; };
        set('#set-room-url', ${JSON.stringify(SRV_URL)});
        set('#set-room-port', '${SRV_PORT}');
        set('#set-room-id', ${JSON.stringify(ROOM)});
        set('#set-room-pass', ${JSON.stringify(PASS)});
        set('#set-room-nick', ${JSON.stringify(c.nick)});
        document.querySelector('#set-room-enabled').checked = true;
        // 这两个共享开关必须显式勾上！它们的状态来自界面复选框，而界面没打开过的话
        // 就是 HTML 默认的"未勾选" —— 房间连上了、人也看到了，但位置和标注一个都不发，
        // 表现就是"在线 · 3 人"却看不到任何队友的标记（第一次跑就是栽在这儿）
        document.querySelector('#set-room-pos').checked = true;
        document.querySelector('#set-room-anno').checked = true;
        return true;
      })()`);
      if (ok && ok.__error) throw new Error(`填表失败：${ok.__error}`);
      await c.ev(`document.querySelector('#room-connect').click()`);
      let st2 = null;
      for (let i = 0; i < 80; i++) {
        st2 = await c.ev('window.api.roomStatus()');
        if (st2 && (st2.status === 'online' || st2.status === 'error')) break;
        await sleep(250);
      }
      check(`${c.nick} 连上你的服务端并进房`, !!st2 && st2.status === 'online',
        st2 ? `status=${st2.status} id=${st2.self && st2.self.id}${st2.error ? ` err=${st2.error}` : ''}` : '没反应');
      const rcfg = await c.ev(`window.api.getConfig().then((c) => c.room)`);
      check(`${c.nick} 「共享定位」「共享标注」都真的开着`, !!rcfg && rcfg.sharePos === true && rcfg.shareAnno === true,
        rcfg ? `sharePos=${rcfg.sharePos} shareAnno=${rcfg.shareAnno}` : '读不到配置');
      await c.ev(`document.querySelector('#settings-dialog').open && document.querySelector('#settings-dialog').close()`);
    }));

    // 3) 互相看得见（人数 = N）
    const ids = [];
    for (const c of clients) {
      let peers = [];
      for (let i = 0; i < 32; i++) {
        const s = await c.ev('window.api.roomStatus()');
        peers = (s && s.peers) || [];
        if (s && s.self) ids.push(s.self.id);
        if (peers.length >= N - 1) break;
        await sleep(250);
      }
      const chip = await c.ev(`document.querySelector('#room-chip').textContent`);
      check(`${c.nick} 看到另外 ${N - 1} 位队友`, peers.length === N - 1,
        `peers=[${peers.map((p) => p.nick).join(',')}] 顶栏="${chip}"`);
    }
    check('每个客户端的身份各不相同（复制配置会撞身份，服务端会互相踢）',
      new Set(ids).size === N, ids.join(' / '));

    // 4) 大家都在海关（同一张图才互相画得出来）
    for (const c of clients) {
      await c.ev(`window.api.selectMap({ key: 'customs' })`);
      for (let i = 0; i < 32; i++) {
        if (await c.ev(`!!(window.__view && window.__view.detail && window.__view.detail.key === 'customs')`)) break;
        await sleep(200);
      }
    }
    const m = await clients[0].ev(`({ id: window.__view.detail.id, name: window.__view.detail.name })`);
    const keys = [];
    for (const c of clients) keys.push(await c.ev(`window.__view.detail && window.__view.detail.key`));
    check('所有客户端都在海关（同一张图才互相画得出来）', keys.every((k) => k === 'customs'),
      `${m && m.name} (${m && m.id}) · ${keys.join(',')}`);

    // 5) 真链路：每人两张带坐标的截图 -> 自动定位 -> 同步给队友（两张才有轨迹线）
    for (const c of clients) {
      await c.ev(`window.api.selectMap({ key: 'customs' })`);
      await sleep(400);
    }
    for (let i = 0; i < N; i++) {
      const c = clients[i];
      for (const [x, y, z] of SPOTS[i]) {
        c.dropShot(x, y, z, YAWS[i]);
        await sleep(1200); // 让文件监听 + 解析 + 上报都走完
      }
      const mine = await c.ev(`window.api.getState().then((s) => s.position)`);
      check(`${c.nick}：截图被识别成自己的定位`, !!mine && Math.abs(mine.x - SPOTS[i][1][0]) < 0.01,
        mine ? `${mine.x}, ${mine.y}, ${mine.z}` : '没识别到');
    }
    // 自己的标记（玩家箭头 + 青色轨迹）—— 用户那份配置里 player/trail 两个图例开关是关着的，
    // 所以日常看不到自己；演示配置临时打开，这里也断言一下确实画出来了
    for (const c of clients) {
      const self = await c.ev(`(() => {
        const trail = document.querySelector('polyline[stroke="#22d3ee"]');
        return {
          pulse: document.querySelectorAll('.player-pulse').length,
          trailPts: trail ? (trail.getAttribute('points') || '').split(' ').filter(Boolean).length : 0,
        };
      })()`);
      const hdg = await c.ev(`window.api.getState().then((s) => Math.round(s.headingDeg || 0))`);
      check(`${c.nick} 地图上画出"自己"（玩家标记 + 朝向）`, !!self && self.pulse >= 1,
        `玩家标记=${self && self.pulse} 航向≈${hdg}° 自己的轨迹点=${self && self.trailPts}`);
    }
    for (const c of clients) {
      let got = [];
      for (let i = 0; i < 32; i++) {
        const s = await c.ev('window.api.roomStatus()');
        got = ((s && s.peers) || []).filter((p) => p.pos && p.pos.map === m.id);
        if (got.length >= N - 1) break;
        await sleep(250);
      }
      const trails = got.map((p) => (p.pos.trail || []).length);
      check(`${c.nick} 收到全部队友的定位`, got.length === N - 1,
        got.map((p) => `${p.nick}(${p.pos.x},${p.pos.z} 航向${p.pos.hdg})`).join(' ') || '一个都没收到');
      check(`${c.nick} 收到队友的轨迹尾巴`, got.length === N - 1 && trails.every((t) => t >= 2),
        got.length ? `各 ${trails.join('/')} 个点` : '没有队友数据');
    }

    // 6) 地图/雷达上真的画出来了
    for (const c of clients) {
      let marks = null;
      for (let i = 0; i < 32; i++) {
        marks = await c.ev(`({
          marks: document.querySelectorAll('.peer-mark').length,
          initials: [...document.querySelectorAll('.peer-mark text')].map((t) => t.textContent).join(''),
          arrows: [...document.querySelectorAll('.peer-arrow')].map((a) => a.getAttribute('transform')).join(' | '),
          trails: document.querySelectorAll('.peer-trail').length,
          legend: (() => {
            const sec = [...document.querySelectorAll('.legend-section')].find((s) => /房间成员/.test(s.textContent));
            return sec ? [...sec.querySelectorAll('.legend-item')].map((r) => r.querySelector('.legend-name').textContent.trim()) : [];
          })(),
        })`);
        if (marks && marks.marks >= N - 1) break;
        await sleep(250);
      }
      check(`${c.nick} 地图上画出 ${N - 1} 个队友标记`, !!marks && marks.marks === N - 1,
        marks ? `图标=${marks.initials} 轨迹=${marks.trails} 箭头=${marks.arrows}` : 'none');
      check(`${c.nick} 右侧「房间成员」一人一行`, !!marks && marks.legend.length === N - 1,
        marks ? marks.legend.join(' / ') : '-');
    }

    // 7) 雷达（小地图窗口）也画出来
    for (const c of clients) {
      if (!c.miniWs) {
        check(`${c.nick} 雷达窗口存在`, false, '没找到 minimap.html（设置里"小地图雷达"没开？）');
        continue;
      }
      let radar = null;
      for (let i = 0; i < 32; i++) {
        radar = await c.miniEv(`({
          marks: document.querySelectorAll('.peer-mark').length,
          off: document.querySelectorAll('.peer-mark[data-off-range="1"]').length,
          chevrons: document.querySelectorAll('.peer-offrange-chevron').length,
          initials: [...document.querySelectorAll('.peer-mark text')].map((t) => t.textContent).join(''),
          self: document.querySelectorAll('.player-pulse').length,
        })`);
        if (radar && radar.marks >= N - 1) break;
        await sleep(250);
      }
      check(`${c.nick} 雷达上也画出 ${N - 1} 个队友`, !!radar && radar.marks === N - 1,
        radar ? `图标=${radar.initials} 贴边=${radar.off} 朝外箭头=${radar.chevrons}` : 'none');
      check(`${c.nick} 雷达上也有"自己"`, !!radar && radar.self >= 1, `玩家标记=${radar && radar.self}`);
    }

    // 8) 标注互看：甲画一笔 -> 乙丙那边出现（带 owner，能按人开关）
    const drawn = await clients[0].ev(`(() => {
      document.querySelector('#btn-anno').click();
      const stage = document.querySelector('.mapstage');
      const r = stage.getBoundingClientRect();
      const x1 = r.left + r.width * 0.34, y1 = r.top + r.height * 0.42;
      const x2 = r.left + r.width * 0.58, y2 = r.top + r.height * 0.62;
      stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x1, clientY: y1, button: 0 }));
      for (let i = 1; i <= 10; i++) {
        const t = i / 10;
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x1 + (x2 - x1) * t, clientY: y1 + (y2 - y1) * t }));
      }
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x2, clientY: y2, button: 0 }));
      document.querySelector('#anno-exit').click();
      const list = window.__view.annos;
      return list.length ? list[list.length - 1].id : null;
    })()`);
    check('甲画了一笔标注（带稳定 id）', !!drawn, String(drawn));
    for (const c of clients.slice(1)) {
      let n = 0;
      for (let i = 0; i < 32; i++) {
        n = await c.ev(`document.querySelectorAll('.peer-anno').length`);
        if (n >= 1) break;
        await sleep(250);
      }
      check(`${c.nick} 看到了甲画的标注`, n >= 1, `peer-anno=${n}`);
    }

    // 9) 把视野框到三个人都在（截图好看），然后拍大图 + 雷达图
    const fitExpr = `(() => {
      const v = window.__view;
      const proj = v.getProjection();
      const pts = ${JSON.stringify(SPOTS.slice(0, N).flat())}.map(([x, y, z]) => proj.project(x, z));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      const r = document.querySelector('.mapstage').getBoundingClientRect();
      const scale = Math.min((r.width * 0.5) / Math.max(1, x1 - x0), (r.height * 0.5) / Math.max(1, y1 - y0));
      v.setViewport({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale, rot: 0 });
      v.setViewMode({ follow: false });
      return { scale: Number(scale.toFixed(3)), w: Math.round(r.width), h: Math.round(r.height) };
    })()`;
    for (const c of clients) {
      const fit = await c.ev(fitExpr);
      check(`${c.nick}：视野框住三个人`, !!fit && fit.scale > 0, fit ? `zoom=${fit.scale} 视口=${fit.w}x${fit.h}` : '-');
      await sleep(600);
      try {
        await c.shot(`live-${c.nick}-map.png`, 'map');
        if (c.miniWs) await c.shot(`live-${c.nick}-radar.png`, 'mini');
      } catch (e) {
        check(`${c.nick} 截图`, false, e.message);
      }
    }

    // 9b) 雷达边缘渲染（队友跑到显示范围外）。
    //     这是最容易画错的场景：算错方位 -> 队友出现在相反的边上；忘记钳位 -> 标记跑到窗口外
    //     （看起来就是"队友消失了"）。所以四个方向各来一遍，而且每一步都**独立算一遍**
    //     "按他的真实世界坐标，他应该出现在雷达的哪个方位"，再和渲染出来的位置比 ——
    //     只读 data-bearing 属性等于拿自己的输出验自己。
    const observer = clients[0];
    const rover = clients[1];
    const base = SPOTS[0][1]; // 以甲号为中心
    const roverId = ((await rover.ev('window.api.roomStatus()')) || {}).self.id;
    const radarGeom = `(() => {
      const v = window.__view;
      const el = document.querySelector('.mapstage');
      const rect = el.getBoundingClientRect();
      const cx = rect.width / 2, cy = rect.height / 2;
      const mark = document.querySelector('.peer-mark[data-peer="${roverId}"]');
      if (!mark) return { found: false, total: document.querySelectorAll('.peer-mark').length };
      const peer = (v.peers || []).find((p) => String(p.id) === ${JSON.stringify(roverId)});
      if (!peer || !peer.pos) return { found: false, why: '队友没有定位' };
      // 把"他的真实世界坐标"按雷达当前的投影/缩放/旋转算到屏幕坐标，得到"他该在哪个方位"
      const q = v.getProjection().project(peer.pos.x, peer.pos.z);
      const vp = v.getViewport();
      const dx = q.x - vp.cx, dy = q.y - vp.cy;
      const cos = Math.cos(vp.rot), sin = Math.sin(vp.rot);
      const sx = (dx * cos - dy * sin) * vp.scale + rect.width / 2;
      const sy = (dx * sin + dy * cos) * vp.scale + rect.height / 2;
      const circle = mark.querySelector('circle');
      const b = circle.getBoundingClientRect();
      const mx = b.left + b.width / 2 - rect.left;
      const my = b.top + b.height / 2 - rect.top;
      return {
        found: true,
        off: mark.getAttribute('data-off-range') === '1',
        wantBearing: (Math.atan2(sy - cy, sx - cx) * 180) / Math.PI,
        // 真正"渲染出来"的方位：直接量图标圆心相对雷达圆心的像素方位
        gotBearing: (Math.atan2(my - cy, mx - cx) * 180) / Math.PI,
        attrBearing: mark.getAttribute('data-bearing') === null ? null : Number(mark.getAttribute('data-bearing')),
        radarR: Number(mark.getAttribute('data-radar-r')),
        radius: Math.min(rect.width, rect.height) / 2,
        dist: Math.hypot(mx - cx, my - cy),
        trueDist: Math.hypot(sx - cx, sy - cy),
        inWindow: mx >= 0 && my >= 0 && mx <= rect.width && my <= rect.height,
        chevron: !!mark.querySelector('.peer-offrange-chevron'),
        dashed: circle.getAttribute('stroke-dasharray'),
      };
    })()`;
    const bearingTable = [];
    const DIRS = [
      { label: '正东', dx: 1, dz: 0 },
      { label: '正南', dx: 0, dz: 1 },
      { label: '正西', dx: -1, dz: 0 },
      { label: '正北', dx: 0, dz: -1 },
    ];
    for (const dir of DIRS) {
      // 先把他的轨迹清掉（换图会清本地轨迹），否则几次瞬移会在雷达上留下一串横穿圆心的虚线
      await rover.ev(`window.api.selectMap({ key: 'woods' })`);
      await sleep(250);
      await rover.ev(`window.api.selectMap({ key: 'customs' })`);
      await sleep(250);
      rover.dropShot(base[0] + dir.dx * 400, 4.5, base[2] + dir.dz * 400, 90);
      await sleep(900);
      rover.dropShot(base[0] + dir.dx * 380, 4.5, base[2] + dir.dz * 380, 90); // 第二张 -> 圆边附近一小段轨迹
      let g = null;
      for (let i = 0; i < 32; i++) {
        g = await observer.miniEv(radarGeom);
        if (g && g.found && g.off) break;
        await sleep(250);
      }
      const dB = g && g.found && g.off ? Math.abs(((g.gotBearing - g.wantBearing + 540) % 360) - 180) : 999;
      const attrDB = g && g.found && g.off && g.attrBearing !== null
        ? Math.abs(((g.attrBearing - g.wantBearing + 540) % 360) - 180)
        : 999;
      bearingTable.push({
        dir: dir.label,
        want: g && g.found ? Math.round(g.wantBearing) : null,
        got: g && g.off ? Math.round(g.gotBearing) : null,
        dist: g && g.found ? Math.round(g.dist) : null,
        R: g && g.found ? g.radarR : null,
        trueDist: g && g.found ? Math.round(g.trueDist) : null,
      });
      check(`雷达·${dir.label} 400 米外：标记贴在圆边上（没画到窗口外）`,
        !!g && g.found && g.off && Math.abs(g.dist - g.radarR) <= 2 && g.trueDist > g.radarR + 50 && g.inWindow,
        g && g.found
          ? `贴边距圆心 ${Math.round(g.dist)}px / 圆边 ${g.radarR}px；他的真实位置在 ${Math.round(g.trueDist)}px 处（在窗口内=${g.inWindow}）`
          : '没出现出范围标记');
      check(`雷达·${dir.label}：渲染出来的方位与他真实方位一致（期望值是独立算的）`, dB < 3,
        g && g.found
          ? `期望 ${Math.round(g.wantBearing)}° 渲染在 ${Math.round(g.gotBearing)}°（差 ${dB.toFixed(1)}°）；标记自带属性写的 ${g.attrBearing}°（差 ${attrDB.toFixed(1)}°）`
          : '-');
      if (dir.label === '正东') {
        check('雷达：出范围标记带朝外箭头 + 虚线边框（一眼看出他在更外面）',
          !!g && g.found && g.off && g.chevron && !!g.dashed,
          g && g.found ? `朝外箭头=${g.chevron} 虚线=${g.dashed}` : '-');
      }
      try {
        await observer.shot(`live-甲号-雷达-队友在${dir.label}外.png`, 'mini');
      } catch (e) {
        check(`雷达·${dir.label} 截图`, false, e.message);
      }
    }
    // 回到范围里：不该再贴边，标记就画在他真实的位置上
    await rover.ev(`window.api.selectMap({ key: 'woods' })`);
    await sleep(250);
    await rover.ev(`window.api.selectMap({ key: 'customs' })`);
    await sleep(250);
    rover.dropShot(base[0] + 12, 4.5, base[2] + 12, 90);
    await sleep(900);
    rover.dropShot(base[0] + 15, 4.5, base[2] + 15, 90);
    let near = null;
    for (let i = 0; i < 32; i++) {
      near = await observer.miniEv(radarGeom);
      if (near && near.found && !near.off) break;
      await sleep(250);
    }
    const nB = near && near.found ? Math.abs(((near.gotBearing - near.wantBearing + 540) % 360) - 180) : 999;
    check('雷达：队友回到范围内后不再贴边（画在他真实位置上，方位也对得上）',
      !!near && near.found && !near.off && Math.abs(near.dist - near.trueDist) <= 2 && near.trueDist < near.radius - 5 && nB < 3,
      near && near.found
        ? `渲染在距圆心 ${Math.round(near.dist)}px、真实位置 ${Math.round(near.trueDist)}px（雷达半径 ${Math.round(near.radius)}px）期望 ${Math.round(near.wantBearing)}° 渲染 ${Math.round(near.gotBearing)}°`
        : '没找到标记');
    try {
      await observer.shot('live-甲号-雷达-队友在范围内.png', 'mini');
    } catch (e) {
      check('在范围内的雷达截图', false, e.message);
    }
    say(`      雷达方位对照表：${bearingTable.map((b) => `${b.dir} 期望${b.want}°/实际${b.got}°`).join('  ')}`);
    rover.dropShot(SPOTS[1][1][0], 4.5, SPOTS[1][1][2], YAWS[1]); // 放回原位
    await sleep(1200);

    // 10) 按人开关：甲关掉乙 -> 乙的标记/轨迹/标注在甲的大图和雷达上一起消失，再打开
    const first = clients[0];
    const other = clients[1];
    const toggle = (on) => first.ev(`(() => {
      const sec = [...document.querySelectorAll('.legend-section')].find((s) => /房间成员/.test(s.textContent));
      const rows = [...sec.querySelectorAll('.legend-item')];
      const row = rows.find((r) => /${other.nick}/.test(r.querySelector('.legend-name').textContent));
      const box = row.querySelector('input');
      if (box.checked !== ${on}) box.click();
      return box.checked;
    })()`);
    await toggle(false);
    await sleep(700);
    const hidden = await first.ev(`({ map: document.querySelectorAll('.peer-mark').length, trails: document.querySelectorAll('.peer-trail').length })`);
    const hiddenRadar = await first.miniEv(`document.querySelectorAll('.peer-mark').length`);
    check(`${first.nick} 关掉「${other.nick}」后只剩 ${N - 2} 个标记（大图 + 雷达同步）`,
      !!hidden && hidden.map === N - 2 && hiddenRadar === N - 2,
      `大图=${hidden && hidden.map} 轨迹=${hidden && hidden.trails} 雷达=${hiddenRadar}`);
    try {
      await first.shot('live-甲号-hide-乙号.png', 'map');
    } catch (e) {
      check('按人开关的截图', false, e.message);
    }
    await toggle(true);
    await sleep(700);
    const back = await first.ev(`document.querySelectorAll('.peer-mark').length`);
    check(`${first.nick} 重新勾上后标记回来`, back === N - 1, `marks=${back}`);

    // 11) 提示行说真话（2.0.1 的修复，顺便看一眼）
    const hint = await first.ev(`document.querySelector('#room-hint').textContent`);
    check('提示行与真实状态一致（不是"正在加入…"）', /已加入房间/.test(String(hint)), String(hint));
  } catch (e) {
    check('自检过程没有异常', false, e.message);
  } finally {
    if (KEEP) {
      say(`\n（--keep：客户端留着没关，调试端口 ${clients.map((c) => c.cdpPort).join(' / ')}）`);
    } else {
      for (const c of clients) {
        try { c.proc.kill(); } catch {}
      }
      await sleep(1500);
      for (const c of clients) {
        try { fs.rmSync(c.userData, { recursive: true, force: true }); } catch {}
      }
    }
  }

  const bad = results.filter((r) => !r.ok);
  say(`\n${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    say('失败项: ' + bad.map((b) => b.name).join(' / '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('自检脚本出错:', e.message);
  process.exit(1);
});
