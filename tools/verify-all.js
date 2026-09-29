#!/usr/bin/env node
'use strict';

/**
 * UI 验收一键 runner —— 固化入口，以后只敲这一条命令。
 *
 *   npm run verify                  # 默认跑本机可自证的全部套件（dev + ui）
 *   npm run verify -- --group=dev   # 只跑自起实例那组（CI 用这个）
 *   npm run verify -- --list        # 列出所有套件与需要手动跑的命令
 *   npm run verify -- --only=raster,room
 *
 * 它负责四件事，正是以前每个脚本各写一遍、跑完还得人工汇总的部分：
 *   1) **环境自检**：先起一个隔离实例，判断"发布同款参数"能不能起来；
 *      起不来才逐级让步（先 --disable-gpu-sandbox，再 --no-sandbox），并在报告里记明。
 *   2) **attach 类套件不用你手动开窗口**：runner 自己起一个隔离实例（动态端口、临时配置目录），
 *      把 --port 交给脚本，跑完连实例带配置一起收掉。
 *   3) **逐套件流式输出 + 超时兜底**：一个套件卡住不影响后面的，超时就整棵进程树收掉。
 *   4) **机器可读报告**：test-artifacts/verify-report.json（带 git HEAD / Electron 版本 / 让步标记），
 *      退出码即结论 —— CI 与本地同一套判定。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { launchReady } = require('./lib/spawn-electron');
const { makeProfile } = require('./lib/suite');

const ROOT = path.join(__dirname, '..');
const ART = path.join(ROOT, 'test-artifacts');
const listArg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const has = (f) => process.argv.includes(f);

/**
 * 套件清单。kind 决定谁来起被测进程：
 *   spawn  —— 脚本自己起实例（多客户端/自带服务端的那些）
 *   attach —— runner 起一个隔离实例，脚本只连 CDP
 *   manual —— 需要打包产物 / 真实鼠标 / 你自己的服务端地址，只能手动跑（runner 只列命令）
 */
const SUITES = [
  // ---------------------------------------------------------------- 自起实例
  {
    id: 'settings-live', title: '设置页即时生效 + 雷达大小 + 新定位重新居中 + 主窗口改大小',
    script: 'verify-settings-live.js', kind: 'spawn', group: 'dev', port: 9345, timeoutMs: 240000,
  },
  {
    id: 'raster', title: '瓦片底图（实验室/迷宫/破冰船）+ 楼层下拉 + 雷达开关',
    script: 'verify-raster.js', kind: 'spawn', group: 'dev', port: 9333, timeoutMs: 240000,
  },
  {
    id: 'raid-alerts', title: '战局提示音（假日志走真实管线）',
    script: 'verify-raid-alerts.js', kind: 'spawn', group: 'dev', port: 9333, timeoutMs: 240000,
  },
  {
    id: 'quest-share', title: '队友共享勾选任务 + 进图要带',
    script: 'verify-quest-share.js', kind: 'spawn', group: 'dev', port: 9334, timeoutMs: 240000,
  },
  {
    id: 'room-2clients', title: '真·两客户端联机（截图定位 -> 房间 -> 对方地图）',
    script: 'verify-room-2clients.js', kind: 'spawn', group: 'dev', port: 8799, timeoutMs: 420000,
  },

  // ---------------------------------------------------------------- 由 runner 起客户端
  { id: 'room', title: '房间联机界面（进房/队友图例/离场清理）', script: 'verify-room.js', kind: 'attach', group: 'ui', timeoutMs: 240000 },
  { id: 'about', title: '关于页面', script: 'verify-about.js', kind: 'attach', group: 'ui' },
  { id: 'annotations', title: '手动标注（六种工具/椭圆/撤销/图例）', script: 'verify-annotations.js', kind: 'attach', group: 'ui' },
  { id: 'quests', title: '任务侧边栏（搜索/勾选/详情/一键切图）', script: 'verify-quests.js', kind: 'attach', group: 'ui' },
  { id: 'mini-anno', title: '雷达显示标注（三档 + 图例联动）', script: 'verify-mini-anno.js', kind: 'attach', group: 'ui' },
  { id: 'mini-quest', title: '雷达与主地图一致（勾选任务点也在雷达上）', script: 'verify-mini-quest.js', kind: 'attach', group: 'ui' },
  { id: 'mini-pan', title: '雷达 Ctrl+拖动平移（CDP 合成输入）', script: 'verify-mini-pan.js', kind: 'attach', group: 'ui' },
  { id: 'raid-reset', title: '新一局清场（假日志 + 假截图走完整管线）', script: 'verify-raid-reset.js', kind: 'attach', group: 'ui' },
  {
    id: 'autoshot', title: '定时自动截图（干跑，不发真实按键）',
    script: 'verify-autoshot.js', kind: 'attach', group: 'ui',
    appArgs: ['--autoshot-dry'], appEnv: { TAKOV_AUTOSHOT_DRY: '1' },
  },

  // ---------------------------------------------------------------- 手动（默认不跑，--list 会列命令）
  {
    id: 'mini-input', title: '雷达真实鼠标输入（会抢系统光标）',
    script: 'verify-mini-input.js', kind: 'attach', group: 'input', port: 9222,
    manual: '会用 SetCursorPos + mouse_event 真实点击，跑之前先确认没在游戏里：\n  npx electron . --remote-debugging-port=9222\n  node tools/verify-mini-input.js',
  },
  {
    id: 'exe-tiles', title: '打包版同款验收（瓦片/版本/雷达）',
    script: 'verify-exe-tiles.js', kind: 'spawn', group: 'pkg',
    manual: '需要当轮打包产物：npm run dist && node tools/verify-exe-tiles.js',
  },
  {
    id: 'exe-cdp', title: '打包版深检（标记/赛季/截图查看器/雷达）',
    script: 'verify-exe-cdp.js', kind: 'attach', group: 'pkg',
    manual: 'dist\\win-unpacked\\塔科夫地图.exe --remote-debugging-port=9222\n  node tools/verify-exe-cdp.js',
  },
  { id: 'server-exe', title: '服务端 exe 端到端', script: 'verify-server-exe.js', kind: 'manual', group: 'pkg', manual: 'npm run dist:server && node tools/verify-server-exe.js' },
  { id: 'server-image', title: '服务端镜像内容（照 Dockerfile 复刻）', script: 'verify-server-image.js', kind: 'manual', group: 'pkg', manual: 'node tools/verify-server-image.js' },
  { id: 'asar', title: '打包产物里的代码对不对版', script: 'verify-asar.js', kind: 'manual', group: 'pkg', manual: 'node tools/verify-asar.js dist\\win-unpacked\\resources\\app.asar' },
  { id: 'room-live', title: '连真实服务端的多客户端自检', script: 'verify-room-live.js', kind: 'manual', group: 'live', manual: 'node tools/verify-room-live.js --url=wss://你的域名 --port=443 --room=联机自检 --clients=3' },
];

/** runner 自己起的实例占用的端口从这儿往后排 */
const PORT_BASE = Number(listArg('port-base', 9400));

function gitHead() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  return (r.stdout || '').trim() || 'unknown';
}
function electronVersion() {
  try { return require('electron/package.json').version; } catch { return 'unknown'; }
}

/** 起一个隔离实例给 attach 类套件用 */
async function startClient(suite, port, env) {
  const prof = makeProfile(`takov-verify-${suite.id}-`);
  const { app, target, degraded } = await launchReady({
    port,
    userData: prof.userData,
    cwd: ROOT,
    args: suite.appArgs || [],
    env: { ...env, ...(suite.appEnv || {}) },
    match: (t) => t.url.endsWith('/map.html'),
    timeoutMs: 60000,
  });
  return { app, target, degraded, prof };
}

/** 跑一个套件脚本，返回 {ok, code, ms, report} */
function runScript(suite, args, env, timeoutMs) {
  const started = Date.now();
  const script = path.join(__dirname, suite.script);
  const reportFile = path.join(ART, `verify-${suite.id}.json`);
  try { fs.rmSync(reportFile, { force: true }); } catch {}
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: { ...env, TAKOV_VERIFY_REPORT: reportFile },
      stdio: 'inherit',
    });
    let timer = null;
    const done = (code, note) => {
      if (timer) clearTimeout(timer);
      let report = null;
      try { report = JSON.parse(fs.readFileSync(reportFile, 'utf-8')); } catch {}
      resolve({ ok: code === 0 && !note, code, note, ms: Date.now() - started, report });
    };
    timer = setTimeout(() => {
      console.log(`\n!! 套件 ${suite.id} 超时（${Math.round(timeoutMs / 1000)}s），整棵进程树收掉`);
      try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      try { proc.kill(); } catch {}
      done(124, `超时 ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);
    proc.on('exit', (code) => done(code == null ? 1 : code));
    proc.on('error', (e) => done(1, 'spawn 失败：' + e.message));
  });
}

function printList() {
  const groups = [...new Set(SUITES.map((s) => s.group))];
  console.log('套件清单（默认跑 dev + ui；--group=<组> 指定；--only=<id,id> 单个）\n');
  for (const g of groups) {
    console.log(`[${g}]`);
    for (const s of SUITES.filter((x) => x.group === g)) {
      const how = s.kind === 'manual' ? '手动' : s.kind === 'attach' ? 'runner 起客户端' : '自起实例';
      console.log(`  ${s.id.padEnd(14)} ${how.padEnd(16)} ${s.title}`);
      if (s.manual) console.log(`                 ${s.manual.split('\n').join('\n                 ')}`);
    }
    console.log('');
  }
}

async function main() {
  if (has('--list')) return printList();

  const only = (listArg('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const groups = (listArg('group', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const skip = (listArg('skip', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const timeoutOverride = Number(listArg('timeout', 0)) * 1000;
  const keep = has('--keep');
  const killOnFail = has('--fail-fast');

  const selected = SUITES.filter((s) => {
    if (only.length) return only.includes(s.id);
    if (groups.length) return groups.includes(s.group);
    return s.group === 'dev' || s.group === 'ui';
  });
  if (!selected.length) {
    console.log('没有选中任何套件。用 --list 看清单。');
    process.exitCode = 2;
    return;
  }
  const manualOnes = selected.filter((s) => s.kind === 'manual');
  const runnable = selected.filter((s) => s.kind !== 'manual');
  const explicitGroup = groups.length || only.length; // 明确点名就要跑 pkg/input 里的（除了纯 manual）

  fs.mkdirSync(ART, { recursive: true });
  const env = { ...process.env };
  const results = [];
  const cleanups = [];

  // ---------------------------------------------------------------- 环境自检
  console.log('=== 环境自检：起一个隔离实例，看"发布同款参数"能不能起来 ===');
  const probePort = PORT_BASE;
  const probeProf = makeProfile('takov-verify-probe-');
  let probe = null;
  let degradedEnv = false;
  try {
    probe = await launchReady({
      port: probePort, userData: probeProf.userData, cwd: ROOT,
      match: (t) => t.url.endsWith('/map.html'), timeoutMs: 60000,
    });
    if (probe.degraded) {
      degradedEnv = true;
      env.TAKOV_ELECTRON_ARGS = (probe.usedArgs || []).join(' ');
      console.log(`环境自检：⚠ 这个宿主里发布同款参数起不来，已按让步参数 ${env.TAKOV_ELECTRON_ARGS} 运行；`
        + '报告里会记明「本次非发布同款参数」，degraded=true。');
      if (env.TAKOV_ELECTRON_ARGS === '--disable-gpu-sandbox') {
        console.log('          只关 GPU 进程沙箱，渲染沙箱与业务代码都没动；CI / 你自己的终端上不会走这条路。');
      } else {
        console.log('          已关 Chromium 进程沙箱（--no-sandbox，沙箱初始化在受限宿主里会启动即退）；业务代码一行没放宽。');
      }
    } else {
      console.log(`环境自检：发布同款参数可用（主窗口就绪，端口 ${probePort}）`);
    }
  } catch (e) {
    console.log('环境自检失败：' + e.message);
    console.log('这个 shell 起不了真实窗口，UI 验收没法在这里做。');
    process.exitCode = 3;
    return;
  } finally {
    if (probe) probe.app.kill();
    probeProf.cleanup();
  }

  try {
    // ------------------------------------------------------------ 逐个套件
    let idx = 0;
    for (const suite of runnable) {
      const port = PORT_BASE + 1 + (idx++);
      const t0 = Date.now();
      console.log(`\n===== [${suite.group}] ${suite.id} — ${suite.title} =====`);
      let client = null;
      let out;
      try {
        let scriptArgs = [];
        let scriptEnv = env;
        if (suite.kind === 'attach') {
          client = await startClient(suite, port, env);
          if (client.degraded) degradedEnv = true;
          scriptArgs = ['--port=' + port];
          // 脚本要读隔离实例的 mini.log / app.log 时，TAKOV_USER_DATA 必须与客户端一致
          scriptEnv = { ...env, TAKOV_USER_DATA: client.prof.userData };
        } else if (suite.port !== false) {
          scriptArgs = ['--port=' + port];
        }
        out = await runScript(suite, scriptArgs, scriptEnv, timeoutOverride || suite.timeoutMs || 240000);
      } catch (e) {
        out = { ok: false, code: 1, note: e.message, ms: Date.now() - t0, report: null };
        console.log('套件起不来：' + e.message);
      } finally {
        if (client) {
          client.app.kill();
          if (!keep) client.prof.cleanup();
          cleanups.push(client.prof.userData);
        }
      }
      const counted = out.report ? `${out.report.passed}/${out.report.total}` : '—';
      results.push({ ...suite, ...out, counted, degraded: !!(client && client.degraded) });
      if (killOnFail && !out.ok) break;
    }
  } finally {
    // 手动套件：只打印命令，不假装跑过
    for (const s of manualOnes) {
      console.log(`\n（跳过 ${s.id}：${s.manual.split('\n')[0]}）`);
      results.push({ ...s, ok: null, skipped: true, ms: 0, counted: '—' });
    }
    // ------------------------------------------------------------ 汇总
    console.log('\n===== UI 验收汇总 =====');
    const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
    console.log(`${pad('套件', 18)}${pad('结果', 8)}${pad('项数', 10)}用时`);
    for (const r of results) {
      const verdict = r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
      console.log(`${pad(r.id, 18)}${pad(verdict, 8)}${pad(r.counted, 10)}${(r.ms / 1000).toFixed(1)}s${r.note ? '  ' + r.note : ''}`);
    }
    const ran = results.filter((r) => !r.skipped);
    const bad = ran.filter((r) => !r.ok);
    console.log(`\n合计：跑了 ${ran.length} 个套件，${ran.length - bad.length} 绿，${bad.length} 红`
      + (results.filter((r) => r.skipped).length ? `，${results.filter((r) => r.skipped).length} 个只列了手动命令` : '')
      + (degradedEnv ? `；⚠ 本次用了让步参数（${env.TAKOV_ELECTRON_ARGS || '未知'}）` : '；发布同款参数'));

    const report = {
      generatedAt: new Date().toISOString(),
      gitHead: gitHead(),
      electron: electronVersion(),
      node: process.version,
      degraded: degradedEnv,
      launchEnv: env.TAKOV_ELECTRON_ARGS || '',
      suites: results.map((r) => ({
        id: r.id, title: r.title, group: r.group, kind: r.kind,
        skipped: !!r.skipped, ok: r.ok, code: r.code, note: r.note || '',
        ms: r.ms, counted: r.counted,
        failedCases: r.report ? r.report.failed : undefined,
      })),
    };
    fs.writeFileSync(path.join(ART, 'verify-report.json'), JSON.stringify(report, null, 2));
    console.log(`报告：test-artifacts/verify-report.json`);
    if (bad.length) process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('runner 崩了：' + (e && e.stack || e));
    process.exitCode = 1;
  });
}

module.exports = { SUITES, PORT_BASE };
