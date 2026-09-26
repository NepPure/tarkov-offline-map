'use strict';

/**
 * 战局提示音：解析 + 状态机 + 接线。
 *
 * 需求（用户原话）：提示音只用在"匹配等待服务器 / 等到了 / 最后几秒进入地图倒计时"，
 * 截图与队友定位都不响。所以这里既验状态机（三个时刻各响一次、倒计时落在最后几秒），
 * 也验证渲染层**没有**任何"定位/换图"的提示音调用。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const { createRaidAlerts, STALE_MS, COUNTDOWN_SEC, LEAD_SEC, MIN_LEAD_SEC, MAX_LEAD_SEC } = require('../src/raid-alerts');
const { parseLogLine } = require('../src/parsers');

// 真实日志里的原行（1.1.5.1.47510，见下面的时间线），不是编的
const REAL_LINES = {
  'matching-start': '2026-09-26 19:39:10.246|1.1.5.1.47510|Debug|application|Matching with group id: 14722920',
  'matching-completed': '2026-09-26 19:40:14.533|1.1.5.1.47510|Info|application|MatchingCompleted:57.91 real:64.28 diff:6.36',
  'game-prepared': '2026-09-26 19:40:14.571|1.1.5.1.47510|Info|application|GamePrepared:57.95 real:64.32 diff:6.36',
  'game-created': '2026-09-26 19:40:15.039|1.1.5.1.47510|Info|application|GameCreated:58.41(0.45) real:64.79(0.47) diff:6.38',
  'game-pooled': '2026-09-26 19:40:26.711|1.1.5.1.47510|Info|application|GamePooled:69.7(11.28) real:76.46(11.66) diff:6.76',
  'game-runned': '2026-09-26 19:40:31.941|1.1.5.1.47510|Info|application|GameRunned:71.84(2.13) real:81.69(5.23) diff:9.85',
  'game-spawn': '2026-09-26 19:40:32.017|1.1.5.1.47510|Info|application|GameSpawn:71.92(0.08) real:81.77(0.07) diff:9.84',
  'player-spawn': '2026-09-26 19:40:32.606|1.1.5.1.47510|Info|application|PlayerSpawnEvent:72.5(0.58) real:82.35(0.58) diff:9.84',
  'game-spawned': '2026-09-26 19:40:33.196|1.1.5.1.47510|Info|application|GameSpawned:73(0.5) real:82.94(0.59) diff:9.94',
  'game-starting': '2026-09-26 19:40:59.599|1.1.5.1.47510|Info|application|GameStarting:98.82(25.82) real:109.35(26.4) diff:10.52',
  'game-started': '2026-09-26 19:41:11.626|1.1.5.1.47510|Info|application|GameStarted:110.54(11.72) real:121.37(12.02) diff:10.83',
};

test('解析：匹配/进图阶段的行能认出来（用的是真实日志原行）', () => {
  for (const [type, line] of Object.entries(REAL_LINES)) {
    const ev = parseLogLine(line);
    assert.ok(ev, `没认出来：${line}`);
    assert.strictEqual(ev.type, type, `${type} 认成了 ${ev.type}`);
    assert.ok(Number.isFinite(ev.ts), '时间戳要解析出来（否则"过期提示"判断不了）');
  }
  const start = parseLogLine(REAL_LINES['matching-start']);
  assert.strictEqual(start.groupId, '14722920', '要带 group id（诊断用）');

  // 同名前缀不能互相误伤：GameSpawn: 与 GameSpawned:
  assert.strictEqual(parseLogLine(REAL_LINES['game-spawn']).type, 'game-spawn');
  assert.strictEqual(parseLogLine(REAL_LINES['game-spawned']).type, 'game-spawned');
  // 老的三种事件不能被抢走
  assert.strictEqual(parseLogLine('2026-09-07 23:18:12.829|1.0.5.0.45581|Info|application|scene preset path:maps/factory_day_preset.bundle rcid:factory_day.scenespreset.asset').type, 'scene-preset');
  assert.strictEqual(parseLogLine('2026-09-07 23:18:12.829|1.0.5.0.45581|Info|application|LocationLoaded:11.11 real:15.54 diff:4.43').type, 'location-loaded');
  // 正文里提到这些词的行不该被当成阶段行（必须 |application| 之后就是 token）
  assert.strictEqual(parseLogLine('2026-09-07 23:18:12.829|1.0.5.0.45581|Debug|application|some log mentioning GameStarted:1 in the middle'), null);
});

test('状态机：三个时刻各响一次，倒计时落在最后几秒', () => {
  let clock = Date.parse('2026-09-26T19:39:10');
  const alerts = createRaidAlerts({ now: () => clock, leadSec: 3 });

  // 1) 开始匹配（等待服务器）
  let out = alerts.feed({ type: 'matching-start', ts: clock, groupId: '1' });
  assert.deepStrictEqual(out.map((a) => a.kind), ['match-queue'], '开始匹配要响一声');
  assert.strictEqual(alerts.phase, 'matching');
  assert.strictEqual(alerts.nextAt(), null, '这时候不该有排队的倒计时');

  // 中间那些阶段行不该响
  clock = Date.parse('2026-09-26T19:40:14');
  assert.deepStrictEqual(alerts.feed({ type: 'game-prepared', ts: clock }), []);
  assert.deepStrictEqual(alerts.feed({ type: 'game-pooled', ts: clock }), []);

  // 2) 匹配到了
  out = alerts.feed({ type: 'matching-completed', ts: clock });
  assert.deepStrictEqual(out.map((a) => a.kind), ['match-found'], '匹配到了要响一声（而且只有这一声）');

  // 3) 倒计时：GameSpawned 之后 ~10s 结束，最后 3 秒各响一次
  const spawned = Date.parse('2026-09-26T19:40:33');
  clock = spawned;
  assert.deepStrictEqual(alerts.feed({ type: 'game-spawned', ts: spawned }), [], '倒计时开始时先不响');
  assert.strictEqual(alerts.nextAt(), spawned + (COUNTDOWN_SEC - 3) * 1000, '第一个提示落在"还剩 3 秒"');

  assert.deepStrictEqual(alerts.due(spawned + 6000), [], '还没到点：不响');
  const t1 = alerts.due(spawned + 7000);
  assert.strictEqual(t1.length, 1);
  assert.strictEqual(t1[0].kind, 'countdown');
  assert.strictEqual(t1[0].remain, 3);
  assert.strictEqual(alerts.due(spawned + 7000).length, 0, '同一时刻不重复响');
  assert.strictEqual(alerts.due(spawned + 8000)[0].remain, 2);
  assert.strictEqual(alerts.due(spawned + 9000)[0].remain, 1);
  assert.strictEqual(alerts.nextAt(), null, '响完就没有排队的了');
  assert.strictEqual(alerts.due(spawned + 12000).length, 0, '倒计时过了不再补响');

  // 进图本身不额外响（需求只列了三个时刻）
  clock = Date.parse('2026-09-26T19:40:59');
  assert.deepStrictEqual(alerts.feed({ type: 'game-starting', ts: clock }), []);
  clock = Date.parse('2026-09-26T19:41:11');
  assert.deepStrictEqual(alerts.feed({ type: 'game-started', ts: clock }), []);
  assert.strictEqual(alerts.phase, 'in-raid');

  // 新一局：再来一次，照样响（状态要能自愈，不能只响第一局）
  clock += 600000;
  assert.deepStrictEqual(alerts.feed({ type: 'matching-start', ts: clock }).map((a) => a.kind), ['match-queue']);
  assert.strictEqual(alerts.stats.queue, 2);
  assert.strictEqual(alerts.stats.found, 1);
  assert.strictEqual(alerts.stats.ticks, 3, '倒计时一共响 3 次（3/2/1）');
});

test('状态机：开局前就在局内/历史回放不响；倒计时提前结束要立刻补一声', () => {
  let clock = Date.parse('2026-09-26T19:41:20');
  const alerts = createRaidAlerts({ now: () => clock, leadSec: 3 });

  // 历史回放（应用在局内才启动，回补 2MB 尾巴）：这些行都是几分钟前的，一声都不该响
  const old = clock - STALE_MS - 60000;
  for (const type of ['matching-start', 'matching-completed', 'game-spawned']) {
    assert.deepStrictEqual(alerts.feed({ type, ts: old }), [], `${type} 是历史行，不该响`);
  }
  assert.strictEqual(alerts.nextAt(), null, '历史行也不该排倒计时');
  // 刚刚发生的照响
  assert.strictEqual(alerts.feed({ type: 'matching-start', ts: clock }).length, 1);

  // 倒计时提前结束（别人先加载完 / 机器快）：没响完的立刻补一声，别静悄悄进图
  const alerts2 = createRaidAlerts({ now: () => clock, leadSec: 5 });
  const spawned = clock;
  alerts2.feed({ type: 'game-spawned', ts: spawned });
  assert.ok(alerts2.nextAt() > spawned, '排上了倒计时');
  const early = spawned + 3000; // 还没到第一个提示点
  const out = alerts2.feed({ type: 'game-starting', ts: early });
  assert.deepStrictEqual(out.map((a) => a.kind), ['countdown'], '提前进图要补一声');
  assert.strictEqual(alerts2.nextAt(), null, '补响之后不能再留着原来的定时器');
  assert.deepStrictEqual(alerts2.due(early + 30000), [], '不会再补响一串');

  // 已经响完的情况下再进图：不重复响
  const alerts3 = createRaidAlerts({ now: () => clock, leadSec: 2 });
  alerts3.feed({ type: 'game-spawned', ts: spawned });
  alerts3.due(spawned + 20000);
  assert.deepStrictEqual(alerts3.feed({ type: 'game-starting', ts: spawned + 20000 }), []);

  // 脏输入不抛
  assert.deepStrictEqual(alerts.feed(null), []);
  assert.deepStrictEqual(alerts.feed({}), []);
  assert.deepStrictEqual(alerts.feed({ type: '不认识的类型', ts: clock }), []);
});

test('状态机：leadSec/countdownSec 夹取 + reset', () => {
  const alerts = createRaidAlerts({ now: () => 0, leadSec: 999 });
  assert.strictEqual(alerts.leadSec, MAX_LEAD_SEC, '超上限夹住');
  alerts.setLeadSec(0);
  assert.strictEqual(alerts.leadSec, MIN_LEAD_SEC, '0 也要夹到下限');
  alerts.setLeadSec('abc');
  assert.strictEqual(alerts.leadSec, MIN_LEAD_SEC, '非法值保持原值（不变成 NaN）');
  assert.strictEqual(alerts.countdownSec, COUNTDOWN_SEC, '默认倒计时长度 = 实测值');
  alerts.setCountdownSec(1);
  assert.strictEqual(alerts.countdownSec, 3, '倒计时长度有下限（太短就没意义了）');

  alerts.feed({ type: 'game-spawned', ts: 0 });
  assert.ok(alerts.nextAt() !== null);
  alerts.reset();
  assert.strictEqual(alerts.nextAt(), null, 'reset 要清掉排队的提示');
  assert.strictEqual(alerts.phase, 'idle');
  assert.strictEqual(LEAD_SEC, 3, '默认"最后 3 秒"');
});

test('接线：主进程喂日志、广播 raidAlert；渲染层只认这三个 kind，没有定位/换图的提示音', () => {
  const main = read('main.js');
  assert.ok(main.includes("require('./src/raid-alerts')"), '主进程要用 raid-alerts');
  assert.ok(main.includes('feedRaidAlerts(ev)'), '日志事件要喂给状态机');
  assert.ok(main.includes('broadcast({ raidAlert:'), '提示要广播给渲染层');
  assert.ok(main.includes('scheduleRaidAlert()'), '倒计时的提示要排定时器（两条日志之间响）');
  assert.ok(main.includes('alertLeadSec'), '设置项要接上');
  assert.ok(main.includes('raidAlert: null'), 'state 里要有 raidAlert 字段');

  const js = read('renderer/map.js');
  assert.ok(js.includes('s.raidAlert'), '渲染层要按广播响铃');
  assert.ok(js.includes("'match-queue'") && js.includes("'match-found'") && js.includes('countdown'), '三种提示音都要有音色');
  // 明确删掉的：定位与换图不再响
  assert.ok(!js.includes("beep('pos')"), '截图定位不该响');
  assert.ok(!js.includes("beep('map')"), '换图不该响');
  assert.match(js, /const tone = BEEP_TONES\[kind\];\s*if \(!tone\) return;/, '未知 kind 要直接 return（不响）');
  // 只有"刚刚发生"的才响（窗口重载/启动拿到历史状态时不该突然响）
  assert.ok(js.includes('Date.now() - s.raidAlert.at <'), '要判新鲜度');

  const html = read('renderer/map.html');
  assert.ok(html.includes('id="set-alert-lead"'), '设置页要有"最后几秒"的输入框');
  assert.ok(html.includes('id="set-sound"'), '总开关还在');
  assert.match(html, /截图定位、队友位置、换图都不会响/, '要在界面上说清楚哪些不响');
});
