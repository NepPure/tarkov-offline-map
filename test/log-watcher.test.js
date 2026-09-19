'use strict';

/**
 * 日志监听器测试（纯 Node，不启动 Electron、不动鼠标）
 * 覆盖：
 *  1. 启动时能从最新会话日志里认出当前地图
 *  2. 进图那一行掉出回补窗口时，仍能靠"最后一条地图行"回扫认出来
 *  3. 局内换图（追加新行）能被读到
 *  4. 认不出来的图会通过 status 上报（用于诊断日志）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LogWatcher } = require('../src/log-watcher');

const SESSION = 'log_2026.09.18_21-00-14_1.1.5.1.47473';
const LOGNAME = '2026.09.18_21-00-14_1.1.5.1.47473 application_000.log';

function presetLine(ts, bundle, rcid) {
  return `${ts}|1.1.5.1.47473|Info|application|scene preset path:maps/${bundle}.bundle rcid:${rcid}.scenespreset.asset\n`;
}

function fillerLine(i) {
  // 不匹配任何解析规则的噪声行（模拟真实日志里的 GC/调试刷屏）
  return `2026-09-18 21:30:${String(i % 60).padStart(2, '0')}.000|1.1.5.1.47473|Debug|application|GC::CollectAsync iteration: ${i}.007080078s True\n`;
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'logw-'));
  fs.mkdirSync(path.join(root, SESSION));
  return root;
}

function logPath(root) {
  return path.join(root, SESSION, LOGNAME);
}

function startWatcher(root) {
  const events = [];
  const statuses = [];
  const w = new LogWatcher(root, (ev) => events.push(ev), (s) => statuses.push(s));
  w.start();
  return { w, events, statuses };
}

test('监听器：启动即认出当前地图（含立交桥）', () => {
  const root = makeRoot();
  fs.writeFileSync(logPath(root), presetLine('2026-09-18 21:21:48.057', 'shopping_mall', 'Shopping_Mall'));
  const { w, events, statuses } = startWatcher(root);
  try {
    assert.strictEqual(statuses[0].state, 'watching');
    const mapEvents = events.filter((e) => e.type === 'scene-preset');
    assert.strictEqual(mapEvents.length, 1);
    assert.strictEqual(mapEvents[0].raidCode, 'Interchange');
  } finally {
    w.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('监听器：进图行掉出回补窗口（>2MB 之后）仍能回扫认出', () => {
  const root = makeRoot();
  const parts = [presetLine('2026-09-18 21:39:04.360', 'factory_day_preset', 'factory_day')];
  let bytes = 0;
  let i = 0;
  while (bytes < 2.5 * 1024 * 1024) {
    const l = fillerLine(i++);
    parts.push(l);
    bytes += l.length;
  }
  fs.writeFileSync(logPath(root), parts.join(''));
  const { w, events } = startWatcher(root);
  try {
    const mapEvents = events.filter((e) => e.type === 'scene-preset');
    assert.ok(mapEvents.length >= 1, '应至少回扫出 1 个地图事件');
    assert.strictEqual(mapEvents[mapEvents.length - 1].raidCode, 'factory4_day');
  } finally {
    w.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('监听器：局内换图（追加新行）能读到', () => {
  const root = makeRoot();
  fs.appendFileSync(logPath(root), presetLine('2026-09-18 21:21:48.057', 'shopping_mall', 'Shopping_Mall'));
  const { w, events } = startWatcher(root);
  try {
    fs.appendFileSync(logPath(root), fillerLine(1));
    fs.appendFileSync(logPath(root), presetLine('2026-09-18 21:39:04.360', 'factory_day_preset', 'factory_day'));
    w.scan(true); // 等价于一次轮询
    const codes = events.filter((e) => e.type === 'scene-preset').map((e) => e.raidCode);
    assert.deepStrictEqual(codes, ['Interchange', 'factory4_day']);
  } finally {
    w.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('监听器：会话目录先出现、application 日志晚一步才建，也要能读到', () => {
  // 真实事故（2026-09-19 20:33）：目录 20:33:06.788 建、application_000.log 20:33:07.683 才建，
  // 而轮询在 20:33:07.020 就看到了目录 -> openSession 扑空 -> 整个会话没有尾巴 ->
  // 用户"进了图却不切图"。这里锁住"后出现的日志文件必须被补开"。
  const root = makeRoot(); // 只建了会话目录，还没有日志文件
  const { w, events } = startWatcher(root);
  try {
    assert.strictEqual(w.tails.size, 0, '文件还没出现时不该有尾巴');
    fs.writeFileSync(logPath(root), presetLine('2026-09-18 21:21:48.057', 'shopping_mall', 'Shopping_Mall'));
    w.scan(true); // 等价于一次轮询
    assert.deepStrictEqual(
      events.filter((e) => e.type === 'scene-preset').map((e) => e.raidCode),
      ['Interchange'],
      '晚出现的日志文件必须被补开并解析'
    );
    // 尾巴接上以后，继续追加（进图换图）也要读到
    fs.appendFileSync(logPath(root), presetLine('2026-09-18 21:39:04.360', 'woods_preset', 'woods'));
    w.scan(true);
    const codes = events.filter((e) => e.type === 'scene-preset').map((e) => e.raidCode);
    assert.deepStrictEqual(codes, ['Interchange', 'Woods']);
  } finally {
    w.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('监听器：重开（setRoot 同路径）不重放历史进图行，尾巴也不丢', () => {
  // 真实事故：config:set 里无条件 syncWatchers() -> setRoot() -> stop() 关掉尾巴，
  // 而 currentDir 没变 -> 不再打开文件 -> 监听器瞎到下次换会话（"进图不切图"）。
  // 现在：setRoot 必须重新打开文件；并且只报"最后一条地图行"，不重放历史。
  const root = makeRoot();
  fs.writeFileSync(logPath(root), [
    presetLine('2026-09-18 21:10:00.000', 'woods_preset', 'woods'),
    fillerLine(1),
    presetLine('2026-09-18 21:20:00.000', 'shopping_mall', 'Shopping_Mall'),
  ].join(''));
  const { w, events } = startWatcher(root);
  try {
    // 首次打开：回补整个尾部（保持原有行为）
    assert.deepStrictEqual(events.filter((e) => e.type === 'scene-preset').map((e) => e.raidCode), ['Woods', 'Interchange']);
    const before = events.length;
    w.setRoot(root);
    assert.strictEqual(w.tails.size, 1, '重开后必须重新打开日志文件，否则监听器会瞎掉');
    const after = events.slice(before).filter((e) => e.type === 'scene-preset').map((e) => e.raidCode);
    assert.deepStrictEqual(after, ['Interchange'], '重开只应报最后一条地图行（不重放 Woods）');
    // 重开之后继续追加进图行也要读到
    fs.appendFileSync(logPath(root), presetLine('2026-09-18 21:39:04.360', 'city_preset', 'TarkovStreets'));
    w.scan(true);
    assert.strictEqual(events.filter((e) => e.type === 'scene-preset').pop().raidCode, 'TarkovStreets');
  } finally {
    w.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('监听器：认不出来的图通过 status 上报 unknown-map', () => {
  const root = makeRoot();
  fs.writeFileSync(logPath(root), presetLine('2026-09-18 21:00:00.000', 'brand_new_map', 'Brand_New'));
  const { w, statuses } = startWatcher(root);
  try {
    const unknown = statuses.filter((s) => s.state === 'unknown-map');
    assert.strictEqual(unknown.length, 1);
    assert.strictEqual(unknown[0].bundle, 'brand_new_map');
    assert.strictEqual(unknown[0].rcid, 'Brand_New');
  } finally {
    w.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('监听器：没有会话目录时不崩溃，会话消失后报告 no-session', () => {
  const root = makeRoot();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'logw-none-'));
  fs.writeFileSync(logPath(root), presetLine('2026-09-18 21:00:00.000', 'woods_preset', 'woods'));
  const { w, statuses } = startWatcher(root);
  try {
    assert.strictEqual(statuses[0].state, 'watching');
    assert.strictEqual(statuses[0].session, SESSION);

    // 会话目录消失（游戏清理日志 / 换盘）-> 报 no-session，并松开文件句柄
    w.setRoot(empty);
    assert.ok(statuses.some((s) => s.state === 'no-session'), '应报告 no-session');
    assert.strictEqual(w.tails.size, 0, 'no-session 后不应再攥着文件句柄');
  } finally {
    w.stop();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
