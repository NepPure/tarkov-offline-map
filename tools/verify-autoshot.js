#!/usr/bin/env node
/**
 * 定时自动截图（模拟游戏截图键）验收。
 *
 * ⚠️ **必须**用干跑模式启动客户端，否则这个脚本会真的往系统里发按键：
 *   PowerShell:  $env:TAKOV_AUTOSHOT_DRY=1 ; npx electron . --remote-debugging-port=9222
 *   cmd:         set TAKOV_AUTOSHOT_DRY=1 && npx electron . --remote-debugging-port=9222
 *   或者给应用加参数：npx electron . --autoshot-dry --remote-debugging-port=9222
 *
 * 做法（不碰真实游戏日志，也不需要真实鼠标）：
 *   1) 把 logsPath / screenshotsPath 临时指到 %TEMP% 下的假目录
 *   2) 造一行"进图日志" -> 状态变成"局内"（自动截图只在这之后才会按）
 *   3) 打开自动截图、间隔设成 5 秒：
 *      - 状态里 enabled / key / intervalSec / dryRun / running 都要对
 *      - presses 要随时间递增（真的到了间隔才按）
 *      - 干跑模式永远拿不到新定位 -> 连续 3 次后必须自动暂停并说明原因
 *      - 重新开关一次能解除暂停；关掉后 running=false（定时器收干净）
 *   4) 键名归一化与非法键名兜底
 *   5) 收尾：把配置原样写回
 *
 * 用法:
 *   npx electron . --remote-debugging-port=9222
 *   node tools/verify-autoshot.js [--port=9222]
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

/** 一次 CDP 调用（带超时：任何一步卡住都要能抛出来，走 finally 还原配置） */
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

/** 假会话目录：与真实命名一致（log_<ts>_<ver> + "<前缀> application_000.log"） */
function makeFakeLogs(root, bundle, rcid) {
  const session = 'log_2026.09.18_21-00-14_1.1.5.1.47473';
  const dir = path.join(root, session);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '2026.09.18_21-00-14_1.1.5.1.47473 application_000.log');
  fs.writeFileSync(file, `2026-09-18 21:00:14.000|1.1.5.1.47473|Info|application|scene preset path:maps/${bundle}.bundle rcid:${rcid}.scenespreset.asset\n`);
  return { dir, file };
}

(async () => {
  const list = await targets();
  const mapTarget = list.find((t) => t.url.endsWith('/map.html'));
  if (!mapTarget) throw new Error('未找到主窗口（用 --remote-debugging-port 启动了吗？）');
  const mapEval = (expr) => cdp(mapTarget.webSocketDebuggerUrl, [
    ['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }],
  ]).then((r) => r[0]);

  const cfg0 = await mapEval('window.api.getConfig()');
  if (!cfg0) throw new Error('拿不到配置');
  const st0 = await mapEval('window.api.getState()');
  const dry0 = st0 && st0.autoShotStatus ? st0.autoShotStatus.dryRun : false;
  check('这次跑在干跑模式（不会真的发按键）', dry0 === true,
    '请用 TAKOV_AUTOSHOT_DRY=1 或 --autoshot-dry 启动客户端再跑这个脚本');
  if (!dry0) {
    console.log('\n已中止：没有干跑模式时这个脚本会往系统里发真实按键，太危险。');
    process.exit(3);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autoshot-'));
  const logsRoot = path.join(tmp, 'Logs');
  const shots = path.join(tmp, 'Screenshots');
  fs.mkdirSync(logsRoot, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });
  makeFakeLogs(logsRoot, 'customs_preset', 'bigmap');

  const status = () => mapEval('window.api.getState().then((s) => s.autoShotStatus)');
  const waitFor = async (fn, ms = 20000, step = 300) => {
    const until = Date.now() + ms;
    let last = null;
    while (Date.now() < until) {
      last = await status();
      if (fn(last)) return last;
      await sleep(step);
    }
    return last;
  };

  try {
    // 1) 切到假目录（进图日志 -> "局内"）+ 打开自动截图（间隔 5 秒，键 F12）
    await mapEval(`window.api.setConfig({ logsPath: ${JSON.stringify(logsRoot)}, screenshotsPath: ${JSON.stringify(shots)} })`);
    await sleep(1800);
    const raid = await mapEval('window.api.getState()');
    check('假进图日志已识别（局内成立）', raid.mapKey === 'customs', `mapKey=${raid.mapKey}`);

    await mapEval(`window.api.setConfig({ autoShot: { enabled: true, intervalSec: 5, key: 'F12' } })`);
    const st1 = await waitFor((s) => s && s.enabled && s.inRaid && s.presses >= 1, 20000);
    check('状态里开关/键位/间隔/运行中/局内都对',
      !!st1 && st1.enabled === true && st1.key === 'F12' && st1.intervalSec === 5 && st1.running === true && st1.inRaid === true,
      JSON.stringify(st1));
    check('真的按了（presses 递增）', !!st1 && st1.presses >= 1, st1 ? `presses=${st1.presses} lastResult=${st1.lastResult}` : '-');
    check('干跑模式的结果是 dry（没有真发按键）', !!st1 && st1.lastResult === 'dry', st1 && st1.lastResult);

    // 2) 间隔没到不该重复按：连着一小会儿，presses 不能超过 1
    const early = await status();
    await sleep(2000);
    const stillEarly = await status();
    check('间隔没到不重复按', stillEarly && stillEarly.presses <= early.presses + 1,
      `presses ${early.presses} -> ${stillEarly.presses}（间隔 5s）`);

    // 3) 干跑模式下永远没有新定位 -> 连续 3 次后自动暂停
    const paused = await waitFor((s) => s && s.paused === true, 25000);
    check('连续 3 次没拿到新定位 -> 自动暂停',
      !!paused && paused.paused === true && paused.pauseReason === 'no-effect',
      paused ? `presses=${paused.presses} pauseReason=${paused.pauseReason}` : '-');
    check('暂停时给出的原因能读懂（界面上会显示这句）',
      !!paused && paused.lastSkip === 'no-effect', paused && paused.lastSkip);
    const pressesAtPause = paused ? paused.presses : -1;
    await sleep(6000);
    const afterPause = await status();
    check('暂停后不再按了', !!afterPause && afterPause.presses === pressesAtPause,
      `presses ${pressesAtPause} -> ${afterPause && afterPause.presses}`);

    // 4) 重新开关一次 = 给一次重试机会
    await mapEval(`window.api.setConfig({ autoShot: { enabled: false } })`);
    await sleep(600);
    const off = await status();
    check('关掉后定时器收干净（running=false）', !!off && off.enabled === false && off.running === false, JSON.stringify(off));
    await mapEval(`window.api.setConfig({ autoShot: { enabled: true, intervalSec: 5, key: 'F12' } })`);
    const resumed = await waitFor((s) => s && s.enabled && s.paused === false, 8000);
    check('重新打开后暂停被解除', !!resumed && resumed.enabled === true && resumed.paused === false, JSON.stringify(resumed));

    // 5) 键名归一化 + 非法键名兜底
    await mapEval(`window.api.setConfig({ autoShot: { enabled: true, intervalSec: 30, key: 'print screen' } })`);
    await sleep(600);
    check('键名写法宽容（print screen -> PrintScreen）', (await status()).key === 'PrintScreen', (await status()).key);
    await mapEval(`window.api.setConfig({ autoShot: { enabled: true, intervalSec: 30, key: '鼠标4' } })`);
    await sleep(600);
    const bad = await status();
    check('非法键名回默认键（不会静默失联）', bad.key === 'PrintScreen', bad.key);

    // 6) 间隔夹到 5~600
    await mapEval(`window.api.setConfig({ autoShot: { enabled: true, intervalSec: 1, key: 'F12' } })`);
    await sleep(600);
    check('间隔下限 5 秒', (await status()).intervalSec === 5, String((await status()).intervalSec));
    await mapEval(`window.api.setConfig({ autoShot: { enabled: true, intervalSec: 9999, key: 'F12' } })`);
    await sleep(600);
    check('间隔上限 600 秒', (await status()).intervalSec === 600, String((await status()).intervalSec));
  } finally {
    // 原样写回：自动截图配置 + 目录
    await mapEval(`window.api.setConfig({
      logsPath: ${JSON.stringify(cfg0.logsPath)},
      screenshotsPath: ${JSON.stringify(cfg0.screenshotsPath)},
      autoShot: ${JSON.stringify(cfg0.autoShot || { enabled: false, intervalSec: 30, key: 'PrintScreen' })}
    })`).catch(() => {});
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
