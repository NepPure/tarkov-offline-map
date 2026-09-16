#!/usr/bin/env node
/**
 * 小地图"真实输入"验收：用系统级鼠标输入（SetCursorPos + mouse_event）而不是合成事件，
 * 验证四件事：
 *   1) 小地图窗口可以拖动（按住圆盘 -> 窗口精确跟随光标，松手后位置被记忆）
 *   2) 顶部工具条按钮能被真实鼠标点到（窗口 focusable:false 也不能影响点击）
 *   3) 按在工具条按钮上不会误触发拖动
 *   4) 窗口位置可以随手拖回原处
 *
 * 用法:
 *   1) 启动应用（dev 或打包版）并带远程调试端口：
 *        npx electron . --remote-debugging-port=9222
 *        dist\塔可夫离线地图-1.2.3.exe --remote-debugging-port=9222
 *   2) node tools/verify-mini-input.js [--port=9222] [--delta=40]
 *
 * 注意：PowerShell 的 Cursor.Position 是"DPI 虚拟化"后的坐标（等于 Electron 的 DIP），
 *       所以这里直接用 DIP，不要再乘缩放系数。
 * 安全：检测到游戏在前台（EscapeFromTarkov*）时直接跳过真实点击/移动，
 *       避免把点击送进游戏（比如误开枪）。此时只做只读检查。
 */
const path = require('path');
const { execFileSync } = require('child_process');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9222));
const DELTA = Number(arg('delta', 40)); // 拖动位移（DIP）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PS = path.join(__dirname, 'input.ps1');

function ps(action, opts = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS, action];
  if (opts.x !== undefined) args.push('-X', String(Math.round(opts.x)));
  if (opts.y !== undefined) args.push('-Y', String(Math.round(opts.y)));
  return execFileSync('powershell', args, { encoding: 'utf8', timeout: 20000 }).trim();
}
const cursorPos = () => ps('cursor').split(',').map(Number);

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

(async () => {
  const list = await targets();
  const mapTarget = list.find((t) => t.url.endsWith('/map.html'));
  const miniTarget = list.find((t) => t.url.endsWith('/minimap.html'));
  if (!miniTarget) throw new Error('未找到小地图窗口（先在主界面打开"小地图雷达"）');
  const evalIn = (target, expr) => cdp(target.webSocketDebuggerUrl, [
    ['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }],
  ]).then((r) => r[0]);
  const miniEval = (expr) => evalIn(miniTarget, expr);
  const mapEval = (expr) => (mapTarget ? evalIn(mapTarget, expr) : Promise.resolve(null));
  const bounds = () => mapEval(`window.api.miniStatus().then((s) => s.bounds)`);
  const input = (type, x, y) => cdp(miniTarget.webSocketDebuggerUrl, [[
    'Input.dispatchMouseEvent',
    { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 },
  ]]).then((r) => r[0]);
  const dragPress = () => input('mousePressed', 150, 150);
  const dragRelease = () => input('mouseReleased', 150, 150);

  const report = { port: PORT, deltaDip: DELTA };

  const status0 = await mapEval(`window.api.miniStatus()`);
  report.miniStatus = status0;
  if (!status0 || !status0.bounds) throw new Error('拿不到小地图窗口位置（miniStatus.bounds）');
  const bounds0 = status0.bounds;
  const center = { x: bounds0.x + bounds0.width / 2, y: bounds0.y + bounds0.height / 2 };

  // 让真实光标进入窗口 -> HUD 才会 display:flex（否则 rect 全 0，点不到按钮）
  ps('move', center);
  await sleep(300);
  const view = await miniEval(`(() => {
    const root = document.getElementById('mini-root');
    const hud = document.querySelector('.mini-hud');
    const btn = document.getElementById('m-rotate');
    const r = btn.getBoundingClientRect();
    return {
      dpr: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
      hudDisplay: getComputedStyle(hud).display,
      hudTabIndex: Array.from(hud.querySelectorAll('button')).map((b) => b.tabIndex),
      buttonCenterCss: { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height },
      bodyClip: getComputedStyle(document.body).clipPath,
      rootClip: getComputedStyle(root).clipPath,
      rotateActive: btn.classList.contains('active'),
      cursorCss: getComputedStyle(document.body).cursor,
    };
  })()`);
  report.miniView = view;

  const foreground = ps('foreground');
  report.foreground = foreground;
  if (/EscapeFromTarkov/i.test(foreground)) {
    report.skipped = '游戏在前台：跳过一切真实鼠标输入（避免误点击进游戏）。请在游戏不在前台时重跑。';
    console.log(JSON.stringify(report, null, 1));
    return;
  }

  const cursor0 = await cursorPos();
  report.cursorStart = cursor0;

  // ------------------------------------------------- 1) 真实鼠标点击工具条按钮
  const clickAt = {
    x: bounds0.x + view.buttonCenterCss.x,
    y: bounds0.y + view.buttonCenterCss.y,
  };
  report.hudClickAt = clickAt;
  ps('click', clickAt);
  await sleep(500);
  const afterClick = await miniEval(`document.getElementById('m-rotate').classList.contains('active')`);
  const boundsAfterClick = await bounds();
  report.hudClick = {
    before: view.rotateActive,
    after: afterClick,
    toggled: afterClick !== view.rotateActive,
    boundsUnchanged: boundsAfterClick.x === bounds0.x && boundsAfterClick.y === bounds0.y,
  };
  ps('click', clickAt); // 恢复原状
  await sleep(300);
  report.hudClickRestored = await miniEval(`document.getElementById('m-rotate').classList.contains('active')`);

  // ------------------------------------------------- 2) 按在按钮上不应触发拖动
  await ps('move', clickAt);
  await sleep(200);
  await input('mousePressed', view.buttonCenterCss.x, view.buttonCenterCss.y);
  await sleep(200);
  const hudDragStarted = await miniEval(`document.body.classList.contains('dragging')`);
  await input('mouseReleased', view.buttonCenterCss.x, view.buttonCenterCss.y);
  report.hudDragStarted = hudDragStarted;

  // ------------------------------------------------- 3) 拖动窗口：精确跟随真实光标
  await dragPress();
  await sleep(200);
  const dragStarted = await miniEval(`document.body.classList.contains('dragging')`);
  const cursorAtDragStart = await cursorPos();
  const physTarget = { x: cursorAtDragStart[0] + DELTA, y: cursorAtDragStart[1] + DELTA };
  ps('move', physTarget);
  await sleep(600);
  const bounds1 = await bounds();
  await dragRelease();
  await sleep(500);
  const bounds2 = await bounds();
  const saved = await mapEval(`window.api.getConfig().then((c) => c.miniPos)`);
  report.dragStarted = dragStarted;
  report.drag = {
    cursorAtDragStart,
    cursorMovedTo: physTarget,
    boundsBefore: bounds0,
    boundsDuringDrag: bounds1,
    boundsAfterRelease: bounds2,
    movedDip: { x: bounds1.x - bounds0.x, y: bounds1.y - bounds0.y },
    savedMiniPos: saved,
  };

  // ------------------------------------------------- 4) 拖回原位置
  const cursorNow = await cursorPos();
  await dragPress();
  await sleep(200);
  ps('move', { x: cursorNow[0] + (bounds0.x - bounds2.x), y: cursorNow[1] + (bounds0.y - bounds2.y) });
  await sleep(600);
  await dragRelease();
  await sleep(400);
  const bounds3 = await bounds();
  report.dragRestored = {
    bounds: bounds3,
    backToOrigin: Math.abs(bounds3.x - bounds0.x) <= 3 && Math.abs(bounds3.y - bounds0.y) <= 3,
  };

  // 光标归位
  ps('move', { x: cursor0[0], y: cursor0[1] });

  // ------------------------------------------------- 5) 结论
  const expected = DELTA;
  const checks = {
    '窗口不可键盘聚焦': status0.focusable === false,
    '小地图按钮不可 Tab 聚焦': view.hudTabIndex.every((t) => t === -1),
    '圆盘裁剪在 #mini-root 而非 body': view.bodyClip === 'none' && /circle/.test(view.rootClip || ''),
    '悬停后工具条可见': view.hudDisplay === 'flex',
    '真实鼠标点击工具条按钮生效': report.hudClick.toggled === true,
    '点击按钮不会移动窗口': report.hudClick.boundsUnchanged === true,
    '按在按钮上不触发拖动': hudDragStarted === false,
    '按下圆盘进入拖动会话': dragStarted === true,
    '拖动精确跟随真实光标': Math.abs(report.drag.movedDip.x - expected) <= 3
      && Math.abs(report.drag.movedDip.y - expected) <= 3,
    '松手后位置被记忆': !!saved && !!bounds2 && saved.x === bounds2.x && saved.y === bounds2.y,
    '可拖回原位置': report.dragRestored.backToOrigin === true,
  };
  report.checks = checks;
  report.PASS = Object.values(checks).every(Boolean);
  console.log(JSON.stringify(report, null, 1));
  process.exit(report.PASS ? 0 : 1);
})().catch((e) => { console.error('[fatal]', e.message); process.exit(2); });
