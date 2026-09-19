#!/usr/bin/env node
/**
 * 雷达手势生命周期验收（纯 CDP 合成输入，不动系统光标；游戏在前台也能跑）。
 *
 * 背景：平移/拖动现在都由**主进程轮询真实光标**驱动（透明窗口上渲染层 pointermove 不可靠），
 * 所以 CDP 合成事件没法真正推动地图 —— 这个工具改为验收"判定与生命周期"这类真正会出错的地方：
 *
 *   1) Ctrl 按下 -> 进入平移态（body.panning），主进程记 `pan start`，且**不能**触发窗口拖动
 *   2) 松手      -> 主进程记 `pan end (release)`（回归防线：曾经漏掉收尾，一直拖到 15s 超时）
 *   3) Ctrl 双击 -> 触发 `pan-reset`（不依赖会被 preventDefault 掐掉的 dblclick 事件）
 *   4) 源码防线 -> pointerup 处理里必须同时收尾"平移"和"窗口拖动"
 *
 * 用法:
 *   npx electron . --remote-debugging-port=9222
 *   node tools/verify-mini-pan.js [--port=9222]
 */
const fs = require('fs');
const path = require('path');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9222));
const CTRL = 2; // CDP modifiers: Alt=1, Ctrl=2, Meta=4, Shift=8
const MINI_LOG = path.join(process.env.APPDATA || '', 'tarkov-offline-map', 'mini.log');

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
      resolve(results.map((m) => {
        const r = m && m.result;
        if (r && r.exceptionDetails) {
          const d = r.exceptionDetails;
          return { __error: (d.exception && (d.exception.description || d.exception.value)) || d.text };
        }
        return r && 'result' in r ? r.result.value : m;
      }));
    };
    ws.onerror = (e) => reject(new Error('ws error ' + (e.message || '')));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    };
  });
}

const logLines = () => {
  try { return fs.readFileSync(MINI_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const countIn = (lines, needle, since) => lines.slice(since).filter((l) => l.includes(needle)).length;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const list = await targets();
  const mapTarget = list.find((t) => t.url.endsWith('/map.html'));
  const miniTarget = list.find((t) => t.url.endsWith('/minimap.html'));
  if (!miniTarget) throw new Error('未找到小地图窗口（先在主界面打开"小地图雷达"）');
  const evalIn = (t, expr) => cdp(t.webSocketDebuggerUrl, [
    ['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }],
  ]).then((r) => r[0]);
  const miniEval = (expr) => evalIn(miniTarget, expr);
  const mapEval = (expr) => (mapTarget ? evalIn(mapTarget, expr) : Promise.resolve(null));

  const mouse = (type, x, y, modifiers, clickCount = 1) => cdp(miniTarget.webSocketDebuggerUrl, [[
    'Input.dispatchMouseEvent',
    { type, x, y, modifiers, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount },
  ]]).then((r) => r[0]);

  const cfg0 = await mapEval('window.api.getConfig()');
  const ct0 = cfg0 ? !!cfg0.miniClickThrough : false;
  await mapEval('window.api.setConfig({ miniClickThrough: false })');
  await sleep(600);

  const cx = 150, cy = 150;
  try {
    // ---- 1) Ctrl 按下 + 松手：平移生命周期 ----
    let since = logLines().length;
    await mouse('mousePressed', cx, cy, CTRL);
    await sleep(150);
    const during = await miniEval('document.body.className');
    await mouse('mouseMoved', cx + 40, cy + 25, CTRL);
    await sleep(150);
    await mouse('mouseReleased', cx + 40, cy + 25, CTRL);
    await sleep(600);
    const after = await miniEval('document.body.className');
    let lines = logLines();

    check('Ctrl 按下进入平移态（body.panning），不是拖窗口',
      /\bpanning\b/.test(during) && !/\bdragging\b/.test(during), `body="${during}"`);
    check('主进程记到 pan start', countIn(lines, 'pan start', since) >= 1, `${countIn(lines, 'pan start', since)} 条`);
    check('Ctrl 手势不会触发窗口拖动', countIn(lines, 'drag start', since) === 0, `${countIn(lines, 'drag start', since)} 条 drag start`);
    check('松手后退出平移态', !/\bpanning\b/.test(after), `body="${after}"`);
    check('松手立刻收尾（pan end release，而不是 15s 超时）',
      countIn(lines, 'pan end (release)', since) >= 1 && countIn(lines, 'pan end (timeout)', since) === 0,
      lines.slice(since).filter((l) => l.includes('pan end')).join(' | ') || '(无)');

    // ---- 2) Ctrl 双击：偏移归零（不靠 dblclick 事件） ----
    since = logLines().length;
    await mouse('mousePressed', cx, cy, CTRL, 1);
    await mouse('mouseReleased', cx, cy, CTRL, 1);
    await sleep(90);
    await mouse('mousePressed', cx, cy, CTRL, 2);
    await mouse('mouseReleased', cx, cy, CTRL, 2);
    await sleep(800);
    lines = logLines();
    check('Ctrl + 双击触发 pan-reset（自己判定双击）', countIn(lines, 'pan-reset', since) >= 1,
      `${countIn(lines, 'pan-reset', since)} 条`);
    check('双击期间不会误开窗口拖动', countIn(lines, 'drag start', since) === 0,
      `${countIn(lines, 'drag start', since)} 条 drag start`);

    // ---- 3) 源码防线：松手时必须两种手势都收尾 ----
    const src = await miniEval("fetch('app://renderer/minimap.js').then((r) => r.text())");
    const ok = typeof src === 'string' &&
      /pointerup',\s*\(e\)\s*=>\s*\{[^}]*endMapPan\(e\)[^}]*endWindowDrag\(\)/.test(src);
    check('pointerup 处理同时收尾"平移"与"窗口拖动"（防回归）', ok,
      ok ? '' : '源码里没找到 pointerup -> endMapPan + endWindowDrag');
  } finally {
    await mapEval(`window.api.setConfig({ miniClickThrough: ${ct0} })`).catch(() => {});
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
