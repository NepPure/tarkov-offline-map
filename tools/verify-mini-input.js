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
 *        dist\塔科夫离线地图-1.2.3.exe --remote-debugging-port=9222
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
  if (opts.delta !== undefined) args.push('-Delta', String(Math.round(opts.delta)));
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
  const away = { x: bounds0.x - 140, y: bounds0.y - 90 };

  // 起始状态固定：光标挪开 + 明确"未锁定"，避免上一轮遗留状态影响判定
  ps('move', away);
  await sleep(400);
  await mapEval(`window.api.setConfig({ miniClickThrough: false })`);
  await sleep(800);
  report.miniStatus = await mapEval(`window.api.miniStatus()`);

  // 空闲态（光标不在雷达上）：小条应当是隐藏的
  const idle = await miniEval(`(() => {
    const bar = document.getElementById('mini-lockbar');
    const r = bar.getBoundingClientRect();
    return {
      barOpacityIdle: Number(getComputedStyle(bar).opacity),
      barRectCss: { x: r.left, y: r.top, w: r.width, h: r.height },
    };
  })()`);

  // 让真实光标进入窗口（雷达没有常驻按钮，这里只用于后续悬停）
  ps('move', center);
  await sleep(300);
  const view = await miniEval(`(() => {
    const root = document.getElementById('mini-root');
    const bar = document.getElementById('mini-lockbar');
    const lockBtn = document.getElementById('mini-lock');
    const unlockBtn = document.getElementById('mini-unlock');
    return {
      dpr: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
      hudToolbar: !!document.querySelector('.mini-hud'),
      barButtons: [lockBtn.textContent.trim(), unlockBtn.textContent.trim()],
      lockBtnTabIndex: lockBtn.tabIndex,
      unlockBtnTabIndex: unlockBtn.tabIndex,
      lockBtnShown: getComputedStyle(lockBtn).display !== 'none',
      unlockBtnShown: getComputedStyle(unlockBtn).display !== 'none',
      bodyClip: getComputedStyle(document.body).clipPath,
      rootClip: getComputedStyle(root).clipPath,
      rotate: window.__view.rotate,
      rot: window.__view.view.rot,
    };
  })()`);
  view.barOpacityIdle = idle.barOpacityIdle;
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

  // ------------------------------------------------- 1) 「锁」：未锁定时靠近才出现，点它开启点击穿透
  const barRect0 = idle.barRectCss;
  const barAt = { x: bounds0.x + barRect0.x + barRect0.w / 2, y: bounds0.y + barRect0.y + barRect0.h / 2 };
  await ps('move', barAt);
  await sleep(400);
  report.lockBar = {
    rectCss: barRect0,
    at: barAt,
    opacityOnApproach: await miniEval(`Number(getComputedStyle(document.getElementById('mini-lockbar')).opacity)`),
    lockShown: await miniEval(`getComputedStyle(document.getElementById('mini-lock')).display !== 'none'`),
    unlockShown: await miniEval(`getComputedStyle(document.getElementById('mini-unlock')).display !== 'none'`),
  };
  // 真实点「锁」-> 开启点击穿透
  ps('click', barAt);
  await sleep(700);
  report.clickThrough = {
    settingAfterLockClick: await mapEval(`window.api.getConfig().then((c) => !!c.miniClickThrough)`),
  };
  // 把光标挪开（不在雷达上）-> 点不着的部分生效：主进程应是穿透状态
  await ps('move', away);
  await sleep(400);
  report.clickThrough.lockedIgnoreAway = (await mapEval(`window.api.miniStatus()`)).ignoreMouseEvents;
  await ps('move', { x: center.x, y: center.y });
  await sleep(300);
  // 锁定时把鼠标"放在雷达上"（圆盘中心）-> 显示「解锁」，但鼠标仍穿透
  await sleep(300);
  report.clickThrough.hotOnDisc = {
    hotClass: await miniEval(`document.body.classList.contains('hot')`),
    barLive: await miniEval(`document.body.classList.contains('bar-live')`),
    unlockShown: await miniEval(`getComputedStyle(document.getElementById('mini-unlock')).display !== 'none'`),
    stillClickThrough: (await mapEval(`window.api.miniStatus()`)).ignoreMouseEvents,
  };
  // 真实点圆盘中心：事件应穿过去，雷达既不拖动也不移动
  ps('click', { x: center.x, y: center.y });
  await sleep(400);
  report.clickThrough.dragStartedWhileLocked = await miniEval(`document.body.classList.contains('dragging')`);
  report.clickThrough.boundsUnchangedWhileLocked = (await bounds()).x === bounds0.x;

  // 移到「解锁」小条上 -> 只在这一小块临时恢复交互，按钮可点
  const barRect = await miniEval(`(() => {
    const r = document.getElementById('mini-lockbar').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  report.clickThrough.barRectCss = barRect;
  const barAt2 = { x: bounds0.x + barRect.x + barRect.w / 2, y: bounds0.y + barRect.y + barRect.h / 2 };
  report.clickThrough.barAt = barAt2;
  await ps('move', barAt2);
  await sleep(600);
  report.clickThrough.hoverInteractive = (await mapEval(`window.api.miniStatus()`)).ignoreMouseEvents;
  report.clickThrough.barLive = await miniEval(`document.body.classList.contains('bar-live')`);
  report.clickThrough.unlockShownWhenLocked = await miniEval(`getComputedStyle(document.getElementById('mini-unlock')).display !== 'none'`);

  // 真实点「解锁」-> 关掉点击穿透
  //（先用 CDP 按住验证"不触发拖动"，松开正好就是那次点击）
  const unlockRect = await miniEval(`(() => {
    const r = document.getElementById('mini-unlock').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  await input('mousePressed', unlockRect.x + unlockRect.w / 2, unlockRect.y + unlockRect.h / 2);
  await sleep(200);
  const barDragStarted = await miniEval(`document.body.classList.contains('dragging')`);
  await input('mouseReleased', unlockRect.x + unlockRect.w / 2, unlockRect.y + unlockRect.h / 2);
  report.barDragStarted = barDragStarted;
  await sleep(700);
  report.clickThrough.afterUnlockClick = {
    setting: await mapEval(`window.api.getConfig().then((c) => !!c.miniClickThrough)`),
    ignore: (await mapEval(`window.api.miniStatus()`)).ignoreMouseEvents,
    lockShown: await miniEval(`getComputedStyle(document.getElementById('mini-lock')).display !== 'none'`),
  };

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
    sizeChanged: { w: bounds2.width - bounds0.width, h: bounds2.height - bounds0.height },
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

  // ------------------------------------------------- 4.5) 滚轮缩放（真实滚轮事件）
  const scaleBefore = await miniEval(`Math.round(window.__view.view.scale * 1000) / 1000`);
  ps('wheel', { x: center.x, y: center.y, delta: 120 });
  await sleep(300);
  ps('wheel', { x: center.x, y: center.y, delta: 120 });
  await sleep(300);
  const scaleIn = await miniEval(`Math.round(window.__view.view.scale * 1000) / 1000`);
  ps('wheel', { x: center.x, y: center.y, delta: -120 });
  ps('wheel', { x: center.x, y: center.y, delta: -120 });
  await sleep(300);
  const scaleBack = await miniEval(`Math.round(window.__view.view.scale * 1000) / 1000`);
  report.wheel = { scaleBefore, scaleIn, scaleBack, zoomedIn: scaleIn > scaleBefore, zoomedBack: scaleBack < scaleIn };

  // ------------------------------------------------- 5) 结论
  const expected = DELTA;
  const checks = {
    '窗口不可键盘聚焦': status0.focusable === false,
    '雷达没有常驻工具条（按钮仅靠近时出现）': view.hudToolbar === false && view.barOpacityIdle === 0,
    '锁 / 解锁两个按钮都在雷达上': view.barButtons.join('/') === '锁/解锁',
    '两个按钮都不可 Tab 聚焦': view.lockBtnTabIndex === -1 && view.unlockBtnTabIndex === -1,
    '圆盘裁剪在 #mini-root 而非 body': view.bodyClip === 'none' && /circle/.test(view.rootClip || ''),
    '默认固定地图方向（不随视角旋转）': view.rotate === false && view.rot === 0,
    '未锁定时靠近才显示（此时显示「锁」）': report.lockBar.opacityOnApproach === 1
      && report.lockBar.lockShown === true && report.lockBar.unlockShown === false,
    '按在「锁」上不触发拖动': report.barDragStarted === false,
    '点「锁」即开启点击穿透并写回配置': report.clickThrough.settingAfterLockClick === true
      && report.clickThrough.lockedIgnoreAway === true,
    '点击穿透：锁定时真实点击不落到雷达上': report.clickThrough.dragStartedWhileLocked === false
      && report.clickThrough.boundsUnchangedWhileLocked === true,
    '锁定后鼠标放在雷达上就显示「解锁」（鼠标仍穿透）': report.clickThrough.hotOnDisc.hotClass === true
      && report.clickThrough.hotOnDisc.unlockShown === true
      && report.clickThrough.hotOnDisc.stillClickThrough === true,
    '移到小条上才临时接管鼠标（此时才可点）': report.clickThrough.barLive === true
      && report.clickThrough.unlockShownWhenLocked === true
      && report.clickThrough.hoverInteractive === false,
    '点「解锁」即关闭点击穿透并写回配置': report.clickThrough.afterUnlockClick.setting === false
      && report.clickThrough.afterUnlockClick.ignore === false
      && report.clickThrough.afterUnlockClick.lockShown === true,
    '滚轮仍可缩放雷达': report.wheel.zoomedIn === true && report.wheel.zoomedBack === true,
    '按下圆盘进入拖动会话': dragStarted === true,
    '拖动精确跟随真实光标': Math.abs(report.drag.movedDip.x - expected) <= 3
      && Math.abs(report.drag.movedDip.y - expected) <= 3,
    '拖动不会把窗口越拖越大': report.drag.sizeChanged.w === 0 && report.drag.sizeChanged.h === 0,
    '松手后位置被记忆': !!saved && !!bounds2 && saved.x === bounds2.x && saved.y === bounds2.y,
    '可拖回原位置': report.dragRestored.backToOrigin === true,
  };
  report.checks = checks;
  report.PASS = Object.values(checks).every(Boolean);
  console.log(JSON.stringify(report, null, 1));
  process.exit(report.PASS ? 0 : 1);
})().catch((e) => { console.error('[fatal]', e.message); process.exit(2); });
