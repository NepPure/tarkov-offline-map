#!/usr/bin/env node
/**
 * 打包版（dist/*.exe）验收：瓦片底图 + 设置页小地图开关。
 *
 * 为什么要单独写一个启动器：手工起 exe 时很容易踩两个坑 ——
 *   1) 忘了给 TAKOV_USER_DATA，验收过程会写你日常那份配置
 *   2) 用 PowerShell 写 settings.json（Set-Content -Encoding UTF8 会带 BOM），
 *      JSON.parse 直接抛、loadSettings 静默回落默认值，于是"配置里明明是开着的，雷达却没出来"
 * 这里统一用 Node 造隔离配置目录（不带 BOM），起 exe，跑检查，最后杀掉进程树 + 清理。
 *
 * 用法:
 *   node tools/verify-exe-tiles.js                 # 取 dist 下最新的 exe
 *   node tools/verify-exe-tiles.js --exe=dist/塔科夫地图-2.0.2.exe --port=9223
 *   node tools/verify-exe-tiles.js --keep          # 出问题时不删临时配置目录（看 app.log / mini.log）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9223));
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取 dist 下最新的 exe（打包产物按版本号命名，靠 mtime 挑最稳） */
function newestExe() {
  const dir = path.join(ROOT, 'dist');
  const list = fs.readdirSync(dir).filter((f) => f.endsWith('.exe'))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!list.length) throw new Error('dist 下没有 exe，先跑 npm run dist');
  return path.join(dir, list[0].f);
}

/** 隔离配置目录：房间关掉、小地图开着（要验的就是它），目录全在临时目录里 */
function makeProfile() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'takov-exe-'));
  const shots = path.join(userData, 'shots');
  const logs = path.join(userData, 'logs');
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  // 注意：这里必须是不带 BOM 的 UTF-8，否则 JSON.parse 会抛、配置被静默丢弃
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    screenshotsPath: shots,
    logsPath: logs,
    sound: false,
    autoDeleteScreenshots: false,
    markerToggles: null,
    miniVisible: true,
    room: { enabled: false },
  }, null, 2));
  return userData;
}

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

function cdp(wsUrl, calls) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const out = [];
    ws.onopen = async () => {
      for (const [m, pa] of calls) {
        const i = ++id;
        const q = new Promise((r) => pending.set(i, r));
        ws.send(JSON.stringify({ id: i, method: m, params: pa }));
        out.push(await q);
      }
      ws.close();
      resolve(out.map((x) => {
        const r = x && x.result;
        if (r && r.exceptionDetails) return { __error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
        return r && 'result' in r ? r.result.value : r;
      }));
    };
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) pending.get(m.id)(m);
    };
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const exe = arg('exe') ? path.resolve(ROOT, arg('exe')) : newestExe();
  if (!fs.existsSync(exe)) throw new Error(`exe 不存在: ${exe}`);
  const userData = makeProfile();
  console.log(`[exe] ${path.relative(ROOT, exe)}`);
  console.log(`[exe] 隔离配置目录 ${userData}`);

  const proc = spawn(exe, [`--remote-debugging-port=${PORT}`], {
    env: { ...process.env, TAKOV_USER_DATA: userData },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  const tail = [];
  proc.stdout.on('data', (d) => tail.push(String(d)));
  proc.stderr.on('data', (d) => tail.push(String(d)));

  const kill = () => {
    try { spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    try { proc.kill(); } catch {}
  };

  try {
    let ws = null;
    for (let i = 0; i < 90; i++) {
      try {
        const list = await targets();
        const t = list.find((x) => x.url.endsWith('/map.html'));
        if (t) { ws = t.webSocketDebuggerUrl; break; }
      } catch {}
      await sleep(500);
    }
    if (!ws) throw new Error(`没能连上 exe 的渲染进程（CDP ${PORT}）`);
    const ev = (expr) => cdp(ws, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]).then((r) => r[0]);
    for (let i = 0; i < 60; i++) {
      if (await ev(`!!(window.api && window.__view)`).catch(() => false)) break;
      await sleep(250);
    }

    // ---- 版本号：exe 报出来的必须与 package.json 一致
    const pkgVer = require('../package.json').version;
    const appVer = await ev(`window.api.getState().then((s) => s.appVersion)`);
    check('打包版版本号与 package.json 一致', appVer === pkgVer, `exe=${appVer} / package.json=${pkgVer}`);

    // ---- 隔离是否生效：配置目录必须指向临时目录，别去碰日常那份
    const cfg = await ev(`window.api.getConfig()`);
    check('隔离生效（截图/日志目录都在临时目录里）',
      cfg && String(cfg.screenshotsPath).startsWith(userData) && cfg.sound === false,
      cfg ? `shots=${cfg.screenshotsPath}` : '读不到配置');

    // ---- 小地图：配置里是开 -> 必须开出来；设置页取消勾选 + 保存 -> 必须关掉
    let mini = null;
    for (let i = 0; i < 30; i++) {
      mini = await ev(`window.api.miniStatus()`);
      if (mini && mini.visible) break;
      await sleep(300);
    }
    check('配置里开着雷达 -> 启动后窗口真的在', mini && mini.visible === true, JSON.stringify(mini));
    await ev(`document.querySelector('#btn-settings').click()`);
    await sleep(400);
    const checked = await ev(`document.querySelector('#set-mini').checked`);
    check('设置页复选框反映真实状态（勾着）', checked === true, String(checked));
    await ev(`(() => { document.querySelector('#set-mini').checked = false; document.querySelector('#settings-ok').click(); return true; })()`);
    let off = null;
    for (let i = 0; i < 20; i++) {
      off = await ev(`window.api.miniStatus()`);
      if (off && off.visible === false) break;
      await sleep(300);
    }
    check('设置里取消勾选 + 保存 -> 雷达窗口关掉',
      off && off.enabled === false && off.visible === false, JSON.stringify(off));

    // ---- 品牌名：游戏叫「逃离塔科夫」，界面里不许再有错字「塔可夫」
    const brand = await ev(`({
      title: document.title,
      h1: document.querySelector('h1').textContent,
      wrong: document.documentElement.innerHTML.includes('塔可夫'),
    })`);
    check('打包版品牌名 = 塔科夫地图，且没有错字「塔可夫」',
      brand && brand.title === '塔科夫地图' && brand.h1 === '塔科夫地图' && brand.wrong === false,
      JSON.stringify(brand));

    // ---- 楼层：下拉框（旧的一排按钮已经拆掉）
    const floorUi = await ev(`({
      hasSelect: !!document.querySelector('#floor-select'),
      legacyButtons: document.querySelectorAll('#floor-buttons button').length,
    })`);
    check('楼层是下拉框、旧的一排按钮已移除',
      floorUi && floorUi.hasSelect === true && floorUi.legacyButtons === 0, JSON.stringify(floorUi));

    // ---- 瓦片底图：直接复用专门的检查脚本（它有自己的退出码）
    console.log('\n--- 瓦片底图（tools/verify-exe-cdp.js --tiles）---');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'verify-exe-cdp.js'), `--port=${PORT}`, '--tiles'], { encoding: 'utf-8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const lines = out.split('\n').filter((l) => /cdp\] (版本|tiles)|TILES-CHECK/.test(l));
    lines.forEach((l) => console.log(l.trim()));
    check('打包版瓦片底图检查通过', r.status === 0, r.status === 0 ? 'TILES-CHECK PASS' : `退出码 ${r.status}`);
  } finally {
    kill();
    if (!KEEP) {
      for (let i = 0; i < 5; i++) {
        try { fs.rmSync(userData, { recursive: true, force: true }); break; } catch { await sleep(400); }
      }
      if (fs.existsSync(userData)) console.warn(`[warn] 临时配置目录没删干净: ${userData}`);
    } else {
      console.log(`[keep] 临时配置目录: ${userData}`);
    }
  }

  const bad = results.filter((x) => !x.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 项通过${bad.length ? '，失败: ' + bad.map((b) => b.name).join(' | ') : ''}`);
  if (bad.length) {
    console.log('\n--- exe 输出尾部 ---');
    console.log(tail.join('').slice(-1500));
    process.exitCode = 1;
  }
})().catch((e) => { console.error('[verify-exe] 失败:', e.message || e); process.exitCode = 1; });
