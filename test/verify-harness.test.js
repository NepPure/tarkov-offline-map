'use strict';

/**
 * 验收基础设施自己的单测（tools/lib + verify-all 清单）。
 *
 * 目的很具体：让"固化"这层不会悄悄腐烂 ——
 *   - 有人改名/删了 verify-*.js，但 runner 清单没跟上 -> 这里红；
 *   - 有人手滑把开关拼到应用路径后面（Chromium 就不认了）-> buildArgs 用例红；
 *   - 有人把"受限环境让步"的判定写宽了（普通日志也当成启动失败）-> 这里红。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { buildArgs, extraArgs, hasChildProcessFailure, STABILITY_ARGS, DEGRADED_ARGS, NO_SANDBOX_ARGS } =
  require('../tools/lib/spawn-electron.js');
const { createReport, makeProfile, tmpRoot, shotName, writeShot } = require('../tools/lib/suite.js');
const { sleep, waitFor } = require('../tools/lib/cdp.js');
const { SUITES } = require('../tools/verify-all.js');

// ------------------------------------------------------------------ runner 清单
test('runner 清单：id 唯一、分组与类型合法', () => {
  const ids = SUITES.map((s) => s.id);
  assert.deepStrictEqual([...new Set(ids)], ids, 'id 有重复');
  for (const s of SUITES) {
    assert.ok(s.title && s.title.length > 2, `${s.id} 缺标题`);
    assert.ok(['spawn', 'attach', 'manual'].includes(s.kind), `${s.id} 类型不合法：${s.kind}`);
    assert.ok(['dev', 'ui', 'input', 'pkg', 'live'].includes(s.group), `${s.id} 分组不合法：${s.group}`);
    assert.ok(s.kind === 'manual' || /^verify-[a-z0-9-]+\.js$/.test(s.script), `${s.id} 脚本名不对`);
  }
});

test('runner 清单：脚本文件真的存在（改名/删除必须同步清单）', () => {
  for (const s of SUITES.filter((x) => x.kind !== 'manual')) {
    const p = path.join(ROOT, 'tools', s.script);
    assert.ok(fs.existsSync(p), `清单里的 ${s.id} 指向不存在的 ${s.script}`);
  }
});

test('runner 清单：手动套件必须给出可直接复制的命令', () => {
  for (const s of SUITES.filter((x) => x.kind === 'manual')) {
    assert.ok(s.manual && /node tools\/|npm run/.test(s.manual), `${s.id} 没有手动命令`);
  }
});

test('runner 清单：默认跑的套件只有 dev + ui（抢鼠标/打包产物/私有服务端不许默认跑）', () => {
  const byDefault = SUITES.filter((s) => s.group === 'dev' || s.group === 'ui');
  assert.ok(byDefault.length >= 10, `默认套件太少：${byDefault.length}`);
  for (const s of byDefault) {
    assert.ok(!s.manual, `${s.id} 既在默认组又要求手动`);
  }
  // 抢真实光标的那套永远不许进默认组
  const mouse = SUITES.find((s) => s.id === 'mini-input');
  assert.ok(mouse && mouse.group === 'input');
});

// ------------------------------------------------------------------ 启动参数
test('buildArgs：开关全部排在应用路径之前（Chromium 只认前面那批）', () => {
  const args = buildArgs({ port: 9333, env: { TAKOV_ELECTRON_ARGS: '--no-sandbox' } });
  const appIdx = args.indexOf('.');
  assert.ok(appIdx > 0, '必须有应用路径');
  assert.ok(args.indexOf('--no-sandbox') < appIdx, '额外开关必须在应用路径之前');
  assert.ok(args.includes('--remote-debugging-port=9333'));
  for (const a of STABILITY_ARGS) assert.ok(args.indexOf(a) < appIdx, `${a} 必须在应用路径之前`);
});

test('buildArgs：不带端口 / 不带稳定参数时也正确，可以启动打包版 exe', () => {
  const args = buildArgs({ appPath: 'C:\\app\\塔科夫地图.exe', stability: false, env: {} });
  assert.deepStrictEqual(args, ['C:\\app\\塔科夫地图.exe']);
});

test('extraArgs：空、单开关、多开关与多余空格', () => {
  assert.deepStrictEqual(extraArgs({}), []);
  assert.deepStrictEqual(extraArgs({ TAKOV_ELECTRON_ARGS: '' }), []);
  assert.deepStrictEqual(extraArgs({ TAKOV_ELECTRON_ARGS: '  --a  --b ' }), ['--a', '--b']);
});

test('hasChildProcessFailure：认出真实的 GPU 子进程失败，不误伤普通日志', () => {
  const real = '[123:0928/231618.891:ERROR:gpu_process_host.cc(976)] GPU process launch failed: error_code=18';
  const fatal = '[123:0928/231618.933:FATAL:gpu_data_manager_impl_private.cc(423)] GPU process isn\'t usable. Goodbye.';
  assert.ok(hasChildProcessFailure(real));
  assert.ok(hasChildProcessFailure(fatal));
  assert.ok(hasChildProcessFailure('Renderer process launch-failed'));
  assert.ok(!hasChildProcessFailure('[app] annotations loaded: {"maps":0,"strokes":0,"points":0}'));
  assert.ok(!hasChildProcessFailure(''));
  assert.ok(!hasChildProcessFailure(null));
  // 第一级让步只关 GPU 进程沙箱；更大一级（整个进程沙箱）单独命名、单独可见
  assert.deepStrictEqual(DEGRADED_ARGS, ['--disable-gpu-sandbox']);
  assert.deepStrictEqual(NO_SANDBOX_ARGS, ['--no-sandbox']);
});

// ------------------------------------------------------------------ 报告
test('createReport：计数、退出码、机器可读报告', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takov-report-'));
  const file = path.join(dir, 'r.json');
  const old = { code: process.exitCode, env: process.env.TAKOV_VERIFY_REPORT };
  process.env.TAKOV_VERIFY_REPORT = file;
  try {
    const rep = createReport('样例套件');
    rep.check('A', true);
    rep.check('B', false, '为什么失败');
    rep.check('C', 1);
    assert.strictEqual(rep.total, 3);
    assert.strictEqual(rep.passed, 2);
    assert.strictEqual(rep.failed.length, 1);
    assert.match(rep.summary(), /2\/3 通过/);
    assert.strictEqual(rep.finish(), false);
    assert.strictEqual(process.exitCode, 1, '有失败必须置退出码');
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.strictEqual(json.total, 3);
    assert.strictEqual(json.passed, 2);
    assert.deepStrictEqual(json.failed.map((f) => f.name), ['B']);
  } finally {
    process.exitCode = old.code;
    if (old.env === undefined) delete process.env.TAKOV_VERIFY_REPORT;
    else process.env.TAKOV_VERIFY_REPORT = old.env;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createReport：全绿不置退出码', () => {
  const old = process.exitCode;
  process.exitCode = 0;
  try {
    const rep = createReport('全绿');
    rep.check('只有一项', true);
    assert.strictEqual(rep.finish(), true);
    assert.strictEqual(process.exitCode, 0);
  } finally {
    process.exitCode = old;
  }
});

// ------------------------------------------------------------------ 隔离配置
test('makeProfile：配置全落在临时目录里，房间默认关，cleanup 删干净', () => {
  const prof = makeProfile('takov-test-');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(prof.userData, 'settings.json'), 'utf-8'));
    assert.strictEqual(cfg.screenshotsPath, prof.shots);
    assert.strictEqual(cfg.logsPath, prof.logs);
    assert.strictEqual(cfg.room.enabled, false, '默认绝不许连真实房间');
    assert.ok(fs.existsSync(prof.shots) && fs.existsSync(prof.logs));
    // 受限宿主里 %TEMP% 对 Electron 子进程不可写，profile 默认落在工作区的 test-artifacts/profiles
    assert.ok(prof.userData.startsWith(tmpRoot()), `profile 不在隔离根目录下：${prof.userData}`);
  } finally {
    prof.cleanup();
  }
  assert.ok(!fs.existsSync(prof.userData), 'cleanup 之后目录必须没了');
});

test('makeProfile：可覆盖字段，keep 时不删', () => {
  const prof = makeProfile('takov-test-keep-', { miniVisible: true, miniSize: 420 }, { keep: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(prof.userData, 'settings.json'), 'utf-8'));
  assert.strictEqual(cfg.miniVisible, true);
  assert.strictEqual(cfg.miniSize, 420);
  assert.strictEqual(cfg.markerToggles, null, '没覆盖的字段保持默认');
  prof.cleanup();
  assert.ok(fs.existsSync(prof.userData), 'keep 时必须保留');
  fs.rmSync(prof.userData, { recursive: true, force: true });
});

test('假截图：文件名是游戏真实格式，坐标不同就是不同文件', () => {
  const prof = makeProfile('takov-test-shot-');
  try {
    const a = shotName('-120.50', '210.25');
    assert.match(a, /^2026-09-18\[22-00\]_-120\.50, 3\.2, 210\.25_/);
    assert.match(a, /\.png$/);
    writeShot(prof.shots, { x: '-120.50', z: '210.25' });
    assert.ok(fs.existsSync(path.join(prof.shots, a)));
    assert.notStrictEqual(shotName('1', '2'), shotName('1', '3'));
  } finally {
    prof.cleanup();
  }
});

// ------------------------------------------------------------------ 等待工具
test('waitFor：条件成立立刻返回，超时返回最后一次的值（不干等到双倍时间）', async () => {
  let n = 0;
  const t0 = Date.now();
  const v = await waitFor(async () => (++n >= 2 ? 'ok' : null), 3000, 50);
  assert.strictEqual(v, 'ok');
  assert.ok(Date.now() - t0 < 1500, '应该在条件满足时就返回');
  const t1 = Date.now();
  const none = await waitFor(async () => null, 300, 100);
  assert.strictEqual(none, null);
  assert.ok(Date.now() - t1 < 1500, '超时时间要真的生效');
  await sleep(1);
});
