#!/usr/bin/env node
/**
 * 渲染层诊断：窗口"白屏/空的/点了没反应"时先跑这个。
 *
 * 它起一个**隔离实例**（TAKOV_USER_DATA 指到临时目录，不碰你日常那份配置），重载页面，
 * 然后把渲染层的异常、console 报错，以及关键 DOM 状态一并打出来。
 *
 * 为什么需要它：渲染层里一个语法错误就会让整页停在半初始化状态 —— `window.__view` 照样存在
 * （它是模块顶层赋的值），可下拉是空的、地图加载不出来。这种情况下验收脚本只会给出一串
 * 莫名其妙的 FAIL，真正的原因（SyntaxError）藏在 DevTools 里。这个工具就是把它捞出来。
 *
 * 用法:
 *   node tools/diagnose-renderer.js [--port=9333] [--wait=6000]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9333));
const WAIT = Number(arg('wait', 6000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeProfile() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'takov-diag-'));
  fs.mkdirSync(path.join(userData, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    screenshotsPath: path.join(userData, 'shots'),
    logsPath: path.join(userData, 'logs'),
    sound: false, miniVisible: false, markerToggles: null, room: { enabled: false },
  }, null, 2));
  return userData;
}

(async () => {
  const userData = makeProfile();
  const proc = spawn(require('electron'), [
    '.', `--remote-debugging-port=${PORT}`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  ], { cwd: ROOT, env: { ...process.env, TAKOV_USER_DATA: userData }, stdio: ['ignore', 'pipe', 'pipe'] });
  const tail = [];
  proc.stdout.on('data', (d) => tail.push(String(d)));
  proc.stderr.on('data', (d) => tail.push(String(d)));

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.url.endsWith('/map.html'));
      if (t) { wsUrl = t.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(300);
  }
  if (!wsUrl) {
    console.log('没等到 map.html 的调试目标 —— 客户端没起来？');
    try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    process.exit(1);
  }

  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      events.push('EXCEPTION ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      events.push(m.params.type.toUpperCase() + ' ' + m.params.args.map((a) => a.value || a.description || a.type).join(' '));
    }
    if (m.method === 'Log.entryAdded') {
      const en = m.params.entry;
      if (en.level === 'error' || en.level === 'warning') events.push(`LOG[${en.level}] ${en.text}`);
    }
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable', {});
  await send('Log.enable', {});
  await send('Page.enable', {});
  await send('Page.reload', { ignoreCache: true });   // 重载一次，把加载期抛的错也抓全
  await sleep(WAIT);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __error: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : r;
  };
  console.log('--- DOM 状态 ---');
  console.log('选图下拉选项数  :', await ev(`document.querySelectorAll('#map-select option').length`));
  console.log('楼层下拉选项数  :', await ev(`document.querySelectorAll('#floor-select option').length`));
  console.log('window.__view   :', await ev(`!!window.__view`));
  console.log('__viewDebug     :', JSON.stringify(await ev(`window.__viewDebug || null`)));
  console.log('地图数据条数    :', await ev(`window.api.listMaps().then((m) => m.length)`));
  console.log('空状态提示可见  :', await ev(`document.querySelector('#empty-hint').classList.contains('show')`));

  console.log('\n--- 渲染层报错 / 警告 ---');
  console.log(events.length ? [...new Set(events)].join('\n') : '(无)');
  console.log('\n--- 主进程输出尾部 ---');
  console.log(tail.join('').slice(-1200) || '(空)');

  try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  try { proc.kill(); } catch {}
  await sleep(800);
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(userData, { recursive: true, force: true }); break; } catch { await sleep(300); }
  }
  process.exit(0);
})();
