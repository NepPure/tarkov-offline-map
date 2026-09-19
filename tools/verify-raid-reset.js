#!/usr/bin/env node
/**
 * "新一局要清掉上一局轨迹/玩家点"端到端验收。
 *
 * 做法：把应用的 logsPath / screenshotsPath 临时指到 %TEMP% 下的假目录，
 * 用假日志行 + 假截图文件名走**完整管线**（日志监听 -> 解析 -> 状态广播 -> 渲染层），
 * 全程不碰真实游戏日志，也不需要真实鼠标。测完把配置原样写回。
 *
 * 验证：
 *   1) 截图定位后：玩家点存在、轨迹有多于 0 个点
 *   2) 追加一行"进图日志"（新一局）后：玩家点消失、轨迹清空
 *   3) 回放"比当前定位更旧"的进图行（应用重启/重连时的日志回放）**不会**误清当前定位
 *
 * 用法:
 *   npx electron . --remote-debugging-port=9222
 *   node tools/verify-raid-reset.js [--port=9222]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9222));
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

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** 最小的合法 PNG（1x1）：截图监听只读文件名，这里只要是个能读的文件即可 */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

function ts(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000`;
}

/** 假会话目录：与真实命名一致（log_<ts>_<ver> + "<前缀> application_000.log"） */
function makeFakeLogs(root, bundle, rcid) {
  const session = 'log_2026.09.18_21-00-14_1.1.5.1.47473';
  const dir = path.join(root, session);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '2026.09.18_21-00-14_1.1.5.1.47473 application_000.log');
  fs.writeFileSync(file, `2026-09-18 21:00:14.000|1.1.5.1.47473|Info|application|scene preset path:maps/${bundle}.bundle rcid:${rcid}.scenespreset.asset\n`);
  return { dir, file };
}

const appendPreset = (file, bundle, rcid, when) =>
  fs.appendFileSync(file, `${ts(when)}|1.1.5.1.47473|Info|application|scene preset path:maps/${bundle}.bundle rcid:${rcid}.scenespreset.asset\n`);

(async () => {
  const list = await targets();
  const mapTarget = list.find((t) => t.url.endsWith('/map.html'));
  const miniTarget = list.find((t) => t.url.endsWith('/minimap.html'));
  if (!mapTarget) throw new Error('未找到主窗口（--remote-debugging-port 启动了吗？）');
  const evalIn = (t, expr) => cdp(t.webSocketDebuggerUrl, [
    ['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }],
  ]).then((r) => r[0]);
  const mapEval = (expr) => evalIn(mapTarget, expr);
  const miniEval = (expr) => (miniTarget ? evalIn(miniTarget, expr) : Promise.resolve(null));

  const cfg0 = await mapEval('window.api.getConfig()');
  if (!cfg0) throw new Error('拿不到配置');
  console.log(`原配置: logsPath=${cfg0.logsPath}\n        screenshotsPath=${cfg0.screenshotsPath}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raid-reset-'));
  const logsRoot = path.join(tmp, 'Logs');
  const shots = path.join(tmp, 'Screenshots');
  fs.mkdirSync(logsRoot, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });
  const { file: logFile } = makeFakeLogs(logsRoot, 'woods_preset', 'woods');

  // 迷你窗开着才检查得到渲染层；主窗口状态检查不依赖它
  const miniOn = await mapEval('window.api.miniStatus().then((s) => !!(s && s.enabled))');

  const miniDom = () => miniEval(`(() => {
    const g = window.__view.playerEl, tr = window.__view.trailEl;
    return { player: !!window.__view.player, playerDom: g ? g.innerHTML.length : -1, trailPts: tr ? (tr.getAttribute('points') || '').split(' ').filter(Boolean).length : -1 };
  })()`);
  const mapDom = () => mapEval(`(() => {
    const v = window.__view; if (!v) return null;
    const g = v.playerEl, tr = v.trailEl;
    return { player: !!v.player, playerDom: g ? g.innerHTML.length : -1, trailPts: tr ? (tr.getAttribute('points') || '').split(' ').filter(Boolean).length : -1 };
  })()`);

  try {
    // --- 切到假目录 ---
    await mapEval(`window.api.setConfig({ logsPath: ${JSON.stringify(logsRoot)}, screenshotsPath: ${JSON.stringify(shots)} })`);
    await sleep(1600);

    const st1 = await mapEval('window.api.getState()');
    check('已切到假日志目录并被跟踪', st1.logWatcherStatus && st1.logWatcherStatus.state === 'watching',
      JSON.stringify(st1.logWatcherStatus && st1.logWatcherStatus.session || st1.logWatcherStatus));
    check('假进图行被识别为森林', st1.mapKey === 'woods', `mapKey=${st1.mapKey}`);

    // --- 丢一张假截图 -> 定位 + 轨迹 ---
    const shotName = '2026-09-18[22-00]_120.50, 3.20, -40.75_0.01518, 0.90924, -0.03197, 0.41476_15.47 (0).png';
    fs.writeFileSync(path.join(shots, shotName), PNG_1x1);
    await sleep(2000);
    const st2 = await mapEval('window.api.getState()');
    check('假截图产生了定位', !!st2.position, JSON.stringify(st2.position));
    check('轨迹已记录该点', (st2.trail || []).length >= 1, `trail=${(st2.trail || []).length}`);

    const dom2 = miniOn ? await miniDom() : await mapDom();
    const tag = miniOn ? '雷达' : '主窗口';
    check(`${tag}上画出了玩家点与轨迹`, dom2 && dom2.player && dom2.playerDom > 0 && dom2.trailPts >= 1,
      JSON.stringify(dom2));

    // --- 新一局（进图行时间晚于定位时间）-> 必须清空 ---
    await sleep(1100); // 保证进图行的时间戳晚于定位时间
    appendPreset(logFile, 'customs_preset', 'bigmap', new Date());
    await sleep(2000);
    const st3 = await mapEval('window.api.getState()');
    check('新一局清空了玩家位置', !st3.position, `position=${JSON.stringify(st3.position)}`);
    check('新一局清空了轨迹', (st3.trail || []).length === 0, `trail=${(st3.trail || []).length}`);
    check('新一局切到了海关', st3.mapKey === 'customs', `mapKey=${st3.mapKey}`);
    const dom3 = miniOn ? await miniDom() : await mapDom();
    check(`${tag}上的玩家点/轨迹 DOM 也清掉了`,
      dom3 && !dom3.player && dom3.playerDom === 0 && dom3.trailPts === 0, JSON.stringify(dom3));

    // --- 回放"更旧"的进图行：不能把当前定位抹掉 ---
    fs.writeFileSync(path.join(shots, '2026-09-18[22-05]_130.50, 3.20, -30.75_0.01518, 0.90924, -0.03197, 0.41476_15.47 (0).png'), PNG_1x1);
    await sleep(1800);
    const st4 = await mapEval('window.api.getState()');
    check('重新定位回来', !!st4.position, JSON.stringify(st4.position));

    const old = new Date(Date.now() - 3600 * 1000); // 1 小时前的进图行（模拟日志回放/重连）
    appendPreset(logFile, 'woods_preset', 'woods', old);
    await sleep(1800);
    const st5 = await mapEval('window.api.getState()');
    check('回放旧进图行不会误清当前定位（轨迹保留）',
      !!st5.position && (st5.trail || []).length >= 1,
      `position=${!!st5.position} trail=${(st5.trail || []).length}`);
  } finally {
    // 原样写回配置（回放的是旧进图行，不会影响你当前这一局的定位）
    await mapEval(`window.api.setConfig({ logsPath: ${JSON.stringify(cfg0.logsPath)}, screenshotsPath: ${JSON.stringify(cfg0.screenshotsPath)} })`).catch(() => {});
    await sleep(1200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
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
