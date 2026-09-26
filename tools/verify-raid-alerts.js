#!/usr/bin/env node
/**
 * 战局提示音验收（E2E）：真起客户端 + 往"假日志会话目录"里追加**真实格式**的日志行。
 *
 * 验的是需求原话那三条：提示音只在「开始匹配 / 匹配到了 / 进图倒计时最后几秒」响，
 * 截图定位与换图都不响。这里连主进程的定时器（倒计时那几声）一起验，不是只验纯函数。
 *
 * 隔离：临时 userData（TAKOV_USER_DATA）+ 临时 logs/screenshots 目录，不碰你的真实配置与日志。
 *
 * 用法: node tools/verify-raid-alerts.js [--port=9333] [--keep]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9333));
const ROOT = path.join(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 隔离配置：日志目录里先放一个"空会话"，脚本再往里追加日志行 */
function makeProfile() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'takov-alert-'));
  const shots = path.join(userData, 'shots');
  const logs = path.join(userData, 'logs');
  const name = 'log_2026.09.26_22-00-00_1.1.5.1.47510';
  const session = path.join(logs, name);
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(session, { recursive: true });
  const logFile = path.join(session, `${name.replace('log_', '')} application_000.log`);
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    logsPath: logs,
    screenshotsPath: shots,
    sound: true,            // 提示音开着（本机听不到，但广播的状态能验）
    alertLeadSec: 1,        // 只响 1 声，测试快一点
    autoDeleteScreenshots: false,
    miniVisible: false,
    room: { enabled: false },
  }, null, 2));
  return { userData, shots, logs, logFile };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** 游戏日志写的是本机本地时间，格式 `YYYY-MM-DD HH:mm:ss.SSS` */
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};
/** 一行真实格式的游戏日志（消息部分照抄真实日志，只把时间戳换成"现在"） */
const line = (msg, level = 'Info') => `${stamp()}|1.1.5.1.47510|${level}|application|${msg}\n`;

(async () => {
  const prof = makeProfile();
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

  const append = (msg, level) => fs.appendFileSync(prof.logFile, line(msg, level));

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
    const ev = (expr) => cdp(mapWs, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]).then((r) => r[0]);

    // 在渲染层记录主进程广播的每一次提示音（就是"该不该响"的权威信号）。
    // 按 at 去重：渲染层也是按 at 去重后响一次，所以"不同 at 的条数" = 真正响了几次。
    await ev(`(() => {
      window.__alerts = [];
      window.api.onState((s) => {
        const a = s && s.raidAlert;
        if (!a || !a.at) return;
        if (window.__alerts.some((x) => x.at === a.at)) return;
        window.__alerts.push({ kind: a.kind, at: a.at, remain: a.remain, t: Date.now() });
      });
      return true;
    })()`);
    const alerts = () => ev('window.__alerts || []');
    const kinds = async () => (await alerts()).map((a) => a.kind);

    // 日志监听先认到会话（否则追加的行不会被读）
    let sessionSeen = false;
    for (let i = 0; i < 20; i++) {
      const st = await ev('window.api.getState().then((s) => s.logWatcherStatus || null)');
      if (st && st.state === 'watching' && st.session) { sessionSeen = true; break; }
      await sleep(250);
    }
    check('日志监听已挂上假会话', sessionSeen, sessionSeen ? 'watching' : '没等到 logWatcherStatus');

    // ---------------------------------------------------------------- ① 开始匹配
    append('Matching with group id: 14722920', 'Debug');
    await sleep(1500);
    let k = await kinds();
    check('① 开始匹配 -> 响一声（match-queue）', k.length === 1 && k[0] === 'match-queue', JSON.stringify(k));

    // ---------------------------------------------------------------- 中间阶段不响
    append('MatchingCompleted:57.91 real:64.28 diff:6.36');
    await sleep(1400);
    append('GamePrepared:57.95 real:64.32 diff:6.36');
    append('GamePooled:69.7(11.28) real:76.46(11.66) diff:6.76');
    append('GameRunned:71.84(2.13) real:81.69(5.23) diff:9.85');
    append('PlayerSpawnEvent:72.5(0.58) real:82.35(0.58) diff:9.84');
    await sleep(1400);
    k = await kinds();
    check('② 匹配到了 -> 响一声（match-found）', k.length === 2 && k[1] === 'match-found', JSON.stringify(k));

    // 换图（进图行）不该单独响：这是"定位/换图不响"的需求
    append('scene preset path:maps/factory_day_preset.bundle rcid:factory_day.scenespreset.asset');
    await sleep(1600);
    const mapAfter = await ev('window.__view && window.__view.detail ? window.__view.detail.key : null');
    k = await kinds();
    check('换图（进图行）本身不响', k.length === 2, `地图=${mapAfter} kinds=${JSON.stringify(k)}`);

    // 截图定位不该响：往截图目录扔一张带坐标的截图
    fs.writeFileSync(path.join(prof.shots, '2026-09-26[22-00]_58.02, 1.75, 49.47_0.01518, 0.90924, -0.03197, 0.41476_15.47 (0).png'), 'fake');
    await sleep(2200);
    const hasPos = await ev('!!(window.api.getState && true) && !!(window.__view && window.__view.player)');
    k = await kinds();
    check('截图定位不响（player 已定位但没有任何提示）', hasPos === true && k.length === 2, `player=${hasPos} kinds=${JSON.stringify(k)}`);

    // ---------------------------------------------------------------- ③ 倒计时最后几秒
    const spawnedAt = Date.now();
    append('GameSpawned:73(0.5) real:82.94(0.59) diff:9.94');
    await sleep(1200);
    k = await kinds();
    check('倒计时开始时不立刻响（要等最后几秒）', k.length === 2, JSON.stringify(k));
    await sleep(9000); // GameSpawned + 9s = 最后 1 秒（alertLeadSec=1）
    const all = await alerts();
    const ticks = all.filter((a) => a.kind === 'countdown');
    check('③ 倒计时最后几秒响（countdown）', ticks.length === 1, JSON.stringify(all.map((a) => a.kind)));
    const delta = ticks.length ? ticks[0].t - spawnedAt : -1;
    check('倒计时提示落点正确（GameSpawned 后 8~11 秒 = 最后 1 秒）', delta >= 8000 && delta <= 11000, `Δ=${delta}ms remain=${ticks.length ? ticks[0].remain : '-'}`);

    // ---------------------------------------------------------------- 提前进图要补一声
    append('GameStarting:98.82(25.82) real:109.35(26.4) diff:10.52');
    await sleep(1400);
    append('GameStarted:110.54(11.72) real:121.37(12.02) diff:10.83');
    await sleep(1200);
    const before = (await alerts()).length;
    append('Matching with group id: 14731346', 'Debug'); // 下一局
    await sleep(1500);
    append('MatchingCompleted:231.14 real:239.71 diff:8.57');
    await sleep(1400);
    append('GameSpawned:238.54(10) real:252.38(10.34) diff:13.84');
    await sleep(2500);
    append('GameStarting:247.28(8.74) real:261.76(9.38) diff:14.48'); // 比预计早 -> 立刻补一声
    await sleep(1600);
    const after = await alerts();
    const newOnes = after.slice(before).map((a) => a.kind);
    check('新一局照样响（不会只响第一局）', newOnes[0] === 'match-queue' && newOnes[1] === 'match-found', JSON.stringify(newOnes));
    check('倒计时提前结束 -> 立刻补一声（而且只补一声，不再等原来那个定时器）',
      newOnes.filter((x) => x === 'countdown').length === 1, JSON.stringify(newOnes));

    // ---------------------------------------------------------------- 主进程日志
    await sleep(600);
    const appLog = path.join(prof.userData, 'app.log');
    const logText = fs.existsSync(appLog) ? fs.readFileSync(appLog, 'utf-8') : '';
    check('每次响铃都写进 app.log（可对数）', /\[alert\] 响铃/.test(logText),
      (logText.split('\n').filter((l) => l.includes('[alert]')).slice(-2).join(' | ') || '（app.log 里没有 [alert] 行）').slice(0, 160));
  } finally {
    kill();
    await sleep(600);
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
