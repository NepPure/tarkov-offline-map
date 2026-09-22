'use strict';

/**
 * 定时自动截图（模拟游戏截图键）：键名归一化 + 决策逻辑 + PowerShell 助手的命令协议。
 *
 * 全程不碰真实按键/真实进程：
 *   - 定时器、now()、press() 全是注入的；
 *   - PowerShell 助手的 spawn 也用假的 ChildProcess（不启动任何进程）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const AS = require('../src/auto-shot.js');

// ---------------------------------------------------------------------------
// 键名 / 间隔
// ---------------------------------------------------------------------------
test('键名归一化：e.code 写法 + 常见别名都能认，认不出来返回 null', () => {
  assert.strictEqual(AS.normalizeKeyName('PrintScreen'), 'PrintScreen');
  assert.strictEqual(AS.normalizeKeyName('  print screen '), 'PrintScreen');
  assert.strictEqual(AS.normalizeKeyName('print-screen'), 'PrintScreen');
  assert.strictEqual(AS.normalizeKeyName('PRINTSCREEN'), 'PrintScreen');
  assert.strictEqual(AS.normalizeKeyName('prtsc'), 'PrintScreen');
  assert.strictEqual(AS.normalizeKeyName('F12'), 'F12');
  assert.strictEqual(AS.normalizeKeyName('f1'), 'F1');
  assert.strictEqual(AS.normalizeKeyName('KeyP'), 'KeyP');
  assert.strictEqual(AS.normalizeKeyName('p'), 'KeyP');
  assert.strictEqual(AS.normalizeKeyName('1'), 'Digit1');
  assert.strictEqual(AS.normalizeKeyName('num1'), 'Numpad1');
  assert.strictEqual(AS.normalizeKeyName('Numpad0'), 'Numpad0');
  assert.strictEqual(AS.normalizeKeyName('esc'), 'Escape');
  assert.strictEqual(AS.normalizeKeyName('Page Up'), 'PageUp');
  // 认不出来的一律 null（由调用方回默认键）
  for (const bad of ['', '   ', null, undefined, '鼠标4', 'Mouse4', 'PrintScreen2', '☃', 42, {}]) {
    assert.strictEqual(AS.normalizeKeyName(bad), null, `应该认不出：${String(bad)}`);
  }
});

test('虚拟键码表：截图键必须是系统级 PrintScreen（0x2C + scan 0x37 + 扩展位）', () => {
  assert.deepStrictEqual(AS.KEY_TO_VK.PrintScreen, { vk: 0x2c, scan: 0x37, ext: 1 });
  assert.strictEqual(AS.KEY_TO_VK.F1.vk, 0x70);
  assert.strictEqual(AS.KEY_TO_VK.F12.vk, 0x7b);
  assert.strictEqual(AS.KEY_TO_VK.KeyA.vk, 0x41);
  assert.strictEqual(AS.KEY_TO_VK.KeyZ.vk, 0x5a);
  assert.strictEqual(AS.KEY_TO_VK.Digit0.vk, 0x30);
  assert.strictEqual(AS.KEY_TO_VK.Numpad9.vk, 0x69);
  // 这一批必须带 KEYEVENTF_EXTENDEDKEY，不然某些键盘上收不到
  for (const k of ['PrintScreen', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Enter']) {
    assert.strictEqual(AS.KEY_TO_VK[k].ext, 1, `${k} 应该是扩展键`);
  }
  assert.strictEqual(AS.KEY_TO_VK.Space.ext, 0);
});

test('间隔夹到 5~600 秒，默认 30', () => {
  assert.strictEqual(AS.clampIntervalSec(30), 30);
  assert.strictEqual(AS.clampIntervalSec(1), 5);
  assert.strictEqual(AS.clampIntervalSec(0), 5);
  assert.strictEqual(AS.clampIntervalSec(-10), 5);
  assert.strictEqual(AS.clampIntervalSec(9999), 600);
  assert.strictEqual(AS.clampIntervalSec('45'), 45);
  assert.strictEqual(AS.clampIntervalSec('abc'), 30);
  assert.strictEqual(AS.clampIntervalSec(undefined), 30);
  assert.strictEqual(AS.clampIntervalSec(30.6), 31);
});

test('干跑开关：环境变量或启动参数任一命中', () => {
  assert.strictEqual(AS.dryRunRequested([], { TAKOV_AUTOSHOT_DRY: '1' }), true);
  assert.strictEqual(AS.dryRunRequested([], { TAKOV_AUTOSHOT_DRY: '0' }), false);
  assert.strictEqual(AS.dryRunRequested(['electron', '.', '--autoshot-dry'], {}), true);
  assert.strictEqual(AS.dryRunRequested(['electron', '.'], {}), false);
});

// ---------------------------------------------------------------------------
// 决策：什么时候按 / 什么时候不按
// ---------------------------------------------------------------------------
/** 一个可控的 runner：假定时器 + 假时钟 + 记录 press 调用 */
function makeRunner(opts = {}) {
  let clock = 1000;
  const calls = [];
  const timers = [];
  const runner = new AS.AutoShotRunner({
    now: () => clock,
    setInterval: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearInterval: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    press: (c) => {
      calls.push(c); // 所有用例都要能断言"按了几次、按的哪个键"
      return opts.press ? opts.press(c) : Promise.resolve('ok');
    },
    log: () => {},
    dryRun: !!opts.dryRun,
  });
  return {
    runner,
    calls,
    timers,
    advance: (ms) => { clock += ms; },
    at: () => clock,
    enabled: (patch = {}) => runner.applyConfig({ enabled: true, intervalSec: 30, key: 'PrintScreen', ...patch }),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('自动截图：关着 / 不在局内 / 目录不在 都不按', async () => {
  const t = makeRunner();
  await t.runner.tick();
  assert.strictEqual(t.calls.length, 0, '默认关着不该按');
  assert.strictEqual(t.runner.stats().lastSkip, 'disabled');

  t.enabled();
  assert.strictEqual(t.timers.length, 1, '开启后要挂上定时器');
  await t.runner.tick();
  assert.strictEqual(t.calls.length, 0, '还没进图不该按');
  assert.strictEqual(t.runner.stats().lastSkip, 'not-in-raid');

  t.runner.setContext({ inRaid: true, dirOk: false });
  await t.runner.tick();
  assert.strictEqual(t.calls.length, 0, '截图目录不在不该按');
  assert.strictEqual(t.runner.stats().lastSkip, 'no-dir');

  t.runner.setContext({ dirOk: true });
  await t.runner.tick();
  await flush();
  assert.strictEqual(t.calls.length, 1, '局内 + 目录正常 -> 按一次');
  assert.deepStrictEqual(t.calls[0], { key: 'PrintScreen' });
  assert.strictEqual(t.runner.stats().lastResult, 'ok');
});

test('自动截图：按间隔节流，不重复按；间隔到了再按一次', async () => {
  const t = makeRunner();
  t.enabled({ intervalSec: 30 });
  t.runner.setContext({ inRaid: true });
  await t.runner.tick();
  await flush();
  await t.runner.tick(); // 立刻再来一次：应该被间隔挡住
  assert.strictEqual(t.calls.length, 1);
  assert.strictEqual(t.runner.stats().lastSkip, 'interval');

  t.advance(29_000);
  await t.runner.tick();
  assert.strictEqual(t.calls.length, 1, '没到间隔不能按');
  t.advance(2_000); // 累计 31s
  await t.runner.tick();
  await flush();
  assert.strictEqual(t.calls.length, 2);
});

test('自动截图：上一次还没回来时不并发（busy）', async () => {
  const t = makeRunner({
    // 用真定时器放行：不然"等回复"期间事件循环是空的，测试进程会直接退出
    press: () => new Promise((r) => setTimeout(() => r('ok'), 60)),
  });
  t.enabled({ intervalSec: 5 });
  t.runner.setContext({ inRaid: true });
  const pending = t.runner.tick(); // 故意不 await：这一按要 60ms 才回来
  await Promise.resolve();
  assert.strictEqual(t.calls.length, 1);
  t.advance(10_000);
  await t.runner.tick();
  assert.strictEqual(t.calls.length, 1, '上一次没回来就不该再按');
  assert.strictEqual(t.runner.stats().lastSkip, 'busy');
  await pending;
  t.advance(10_000);
  await t.runner.tick();
  assert.strictEqual(t.calls.length, 2);
});

test('自动截图：连续 3 次按下去却没新定位 -> 暂停；拿到定位就恢复', async () => {
  const t = makeRunner();
  t.enabled({ intervalSec: 5 });
  t.runner.setContext({ inRaid: true });
  for (let i = 0; i < 3; i++) {
    await t.runner.tick();
    await flush();
    t.advance(6_000);
  }
  const st = t.runner.stats();
  assert.strictEqual(st.presses, 3);
  assert.strictEqual(st.paused, true);
  assert.strictEqual(st.pauseReason, 'no-effect');

  await t.runner.tick();
  assert.strictEqual(t.calls.length, 3, '暂停后不再按');
  assert.strictEqual(t.runner.stats().lastSkip, 'no-effect');

  // 用户手按了一次截图键 -> 有新定位 -> 自动恢复
  t.runner.notePosition();
  assert.strictEqual(t.runner.stats().paused, false);
  await t.runner.tick();
  await flush();
  assert.strictEqual(t.calls.length, 4);
});

test('自动截图：中途拿到定位会清零计数（不会被历史累积误暂停）', async () => {
  const t = makeRunner();
  t.enabled({ intervalSec: 5 });
  t.runner.setContext({ inRaid: true });
  await t.runner.tick(); await flush(); t.advance(6_000);
  t.runner.notePosition();                 // 第 1 次其实生效了
  await t.runner.tick(); await flush(); t.advance(6_000);
  t.runner.notePosition();                 // 第 2 次也生效
  await t.runner.tick(); await flush();
  assert.strictEqual(t.runner.stats().paused, false, '连续两次都拿到定位，不该暂停');
});

test('自动截图：游戏不在前台（skip）与助手报错（err）都不算"按了没效果"', async () => {
  let result = 'skip:not-foreground';
  const t = makeRunner({ press: () => Promise.resolve(result) });
  t.enabled({ intervalSec: 5 });
  t.runner.setContext({ inRaid: true });
  for (let i = 0; i < 4; i++) {
    await t.runner.tick();
    await flush();
    t.advance(6_000);
  }
  assert.strictEqual(t.runner.stats().lastResult, 'skip:not-foreground');
  assert.strictEqual(t.runner.stats().paused, false, '按键根本没发出去，不该判定为"没效果"');

  result = 'err';
  for (let i = 0; i < 4; i++) {
    await t.runner.tick();
    await flush();
    t.advance(6_000);
  }
  assert.strictEqual(t.runner.stats().lastResult, 'err');
  assert.strictEqual(t.runner.stats().paused, false);
});

test('自动截图：press 抛异常也不炸，记成 err', async () => {
  const t = makeRunner({ press: () => Promise.reject(new Error('boom')) });
  t.enabled({ intervalSec: 5 });
  t.runner.setContext({ inRaid: true });
  await t.runner.tick();
  await flush();
  assert.match(String(t.runner.stats().lastResult), /^err:boom/);
  assert.strictEqual(t.runner.stats().paused, false);
});

test('自动截图：改键/改间隔会重置节流与暂停；关掉后定时器收干净', async () => {
  const t = makeRunner({ intervalSec: 60 });
  t.enabled({ intervalSec: 60 });
  t.runner.setContext({ inRaid: true });
  await t.runner.tick();
  await flush();
  assert.strictEqual(t.calls.length, 1);

  // 改键：立刻重试（不必再等 60 秒）
  t.runner.applyConfig({ enabled: true, intervalSec: 60, key: 'F12' });
  await t.runner.tick();
  await flush();
  assert.strictEqual(t.calls.length, 2);
  assert.deepStrictEqual(t.calls[1], { key: 'F12' });

  // 关掉：定时器清掉、状态里 enabled=false
  t.runner.applyConfig({ enabled: false, intervalSec: 60, key: 'F12' });
  assert.strictEqual(t.timers.length, 0);
  assert.strictEqual(t.runner.stats().enabled, false);
});

test('自动截图：干跑模式只记状态，绝不调用 press', async () => {
  const t = makeRunner({ dryRun: true });
  t.enabled({ intervalSec: 5 });
  t.runner.setContext({ inRaid: true });
  for (let i = 0; i < 3; i++) {
    await t.runner.tick();
    await flush();
    t.advance(6_000);
  }
  assert.strictEqual(t.calls.length, 0, '干跑不该真的按键');
  const st = t.runner.stats();
  assert.strictEqual(st.presses, 3);
  assert.strictEqual(st.lastResult, 'dry');
  assert.strictEqual(st.dryRun, true);
  assert.strictEqual(st.paused, true, '干跑也照样会因为"没效果"暂停（验收脚本就验这个）');
});

test('自动截图：非法键名回默认键，间隔非法回默认值', () => {
  const t = makeRunner();
  t.runner.applyConfig({ enabled: true, intervalSec: 'x', key: '鼠标4' });
  const st = t.runner.stats();
  assert.strictEqual(st.key, 'PrintScreen');
  assert.strictEqual(st.intervalSec, 30);
});

test('自动截图：状态回调必须接上（界面上的"按了几次/为什么没按"全靠它）', async () => {
  // 回归：构造函数里曾经漏了 opts.onStatus，于是"按下/暂停"这些状态永远推不出去，
  // 界面上一直停在旧值（明明在按，状态里 presses 却一直是 0）。
  const seen = [];
  const calls = [];
  let clock = 1000;
  const runner = new AS.AutoShotRunner({
    now: () => clock,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    press: (c) => { calls.push(c); return Promise.resolve('ok'); },
    log: () => {},
    onStatus: (st) => seen.push(st),
  });
  runner.applyConfig({ enabled: true, intervalSec: 5, key: 'F12' });
  runner.setContext({ inRaid: true });
  assert.ok(seen.length >= 1, '开启时就该推一次状态');
  await runner.tick();
  await flush();
  const last = seen[seen.length - 1];
  assert.strictEqual(calls.length, 1, '真按了一次');
  assert.strictEqual(last.presses, 1, '按下之后状态里要看得到 presses=1');
  assert.strictEqual(last.lastResult, 'ok');
  assert.strictEqual(last.enabled, true);
  assert.strictEqual(last.running, true);
  // 再来一次（等过间隔）：状态继续推
  clock += 6000;
  await runner.tick(); await flush();
  const st2 = seen[seen.length - 1];
  assert.strictEqual(st2.presses, 2);
  assert.strictEqual(st2.busy, false);
  assert.strictEqual(typeof st2.paused, 'boolean');
});

test('自动截图：跳过原因变化时也会推状态', () => {
  const seen = [];
  const runner = new AS.AutoShotRunner({
    now: () => 1000,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    log: () => {},
    onStatus: (st) => seen.push(st),
  });
  runner.applyConfig({ enabled: true, intervalSec: 5, key: 'F12' });
  const before = seen.length;
  runner.setContext({ inRaid: true });
  assert.ok(seen.length > before, 'inRaid 变化要推一次');
  assert.strictEqual(seen[seen.length - 1].inRaid, true);
});

// ---------------------------------------------------------------------------
// PowerShell 助手：命令协议（用假的 ChildProcess，不启动真进程）
// ---------------------------------------------------------------------------
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.written = [];
  child.killed = false;
  child.stdin = {
    writable: true,
    write(line) { child.written.push(line); },
    end() { child.stdin.writable = false; },
  };
  child.kill = () => { child.killed = true; };
  child.reply = (line) => child.stdout.emit('data', `${line}\n`);
  return child;
}

function makeHelper(replies = {}) {
  const children = [];
  const spawn = () => {
    const child = makeFakeChild();
    children.push(child);
    return child;
  };
  const helper = AS.createKeyPressHelper({ spawn, log: () => {}, timeoutMs: 50 });
  return { helper, children, replies };
}

test('助手：按一次键只发一条 "vk,scan,ext"，收到 ok 才算成功', async () => {
  const { helper, children } = makeHelper();
  const p = helper.press('PrintScreen');
  assert.strictEqual(children.length, 1, '第一次按要惰性起进程');
  assert.deepStrictEqual(children[0].written, ['44,55,1\n']);
  children[0].reply('ok');
  assert.strictEqual(await p, 'ok');
  assert.strictEqual(helper.alive(), true);

  // 第二次复用同一个进程
  const p2 = helper.press('F12');
  assert.strictEqual(children.length, 1);
  assert.deepStrictEqual(children[0].written[1], '123,0,0\n');
  children[0].reply('skip');
  assert.strictEqual(await p2, 'skip:not-foreground');
});

test('助手：游戏不在前台时回 skip；未知键名直接 err（不碰进程）', async () => {
  const { helper, children } = makeHelper();
  assert.strictEqual(await helper.press('鼠标4'), 'err');
  assert.strictEqual(children.length, 0, '未知键名不该起进程');
});

test('助手：进程死了/超时都回 err（不会永远挂住）', async () => {
  const { helper, children } = makeHelper();
  const p = helper.press('F1');
  children[0].emit('exit', 1);
  assert.strictEqual(await p, 'err');
  assert.strictEqual(helper.alive(), false);

  // 超时路径：再起一个进程，它一直不回
  const { helper: h2, children: c2 } = makeHelper();
  const p2 = h2.press('F2');
  assert.strictEqual(c2.length, 1);
  assert.strictEqual(await p2, 'err', '超时也要有结果');
});

test('助手：gameForeground() 问的是同一个进程', async () => {
  const { helper, children } = makeHelper();
  const p = helper.gameForeground();
  assert.deepStrictEqual(children[0].written, ['?\n']);
  children[0].reply('1');
  assert.strictEqual(await p, true);
  const p2 = helper.gameForeground();
  children[0].reply('0');
  assert.strictEqual(await p2, false);
});

test('助手：stop() 收干净（不留下进程）', () => {
  const { helper, children } = makeHelper();
  helper.press('F1');
  assert.strictEqual(helper.alive(), true);
  helper.stop();
  assert.strictEqual(helper.alive(), false);
  assert.strictEqual(children[0].killed, true);
});

test('PS 脚本：只做按键，不碰游戏进程（做前台判定的白名单进程名）', () => {
  assert.match(AS.AUTO_SHOT_PS, /keybd_event/);
  assert.match(AS.AUTO_SHOT_PS, /GetForegroundWindow/);
  assert.match(AS.AUTO_SHOT_PS, /EscapeFromTarkov/);
  // 没有任何"注入/读写游戏内存"的 API
  assert.ok(!/OpenProcess|WriteProcessMemory|ReadProcessMemory|CreateRemoteThread/i.test(AS.AUTO_SHOT_PS));
});
