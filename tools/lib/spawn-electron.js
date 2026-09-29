'use strict';

/**
 * 验收脚本共用的「起一个隔离 Electron 实例」。**这是唯一允许起被测进程的地方。**
 *
 * 抽这个模块是因为启动阶段踩过的坑，症状都一样（窗口一闪就没 / 脚本报"没等到主窗口"），
 * 但原因完全不同，而且都极难从界面上看出来：
 *
 *   1) **stdio 尽量别用管道**：主进程启动时会 `execSync('reg query …')` 探测游戏目录，
 *      而 `execSync` 默认把子进程的 stderr 继承给父进程 —— 父进程 stderr 是管道时
 *      （受限沙箱、无控制台启动器、CI、某些终端），管道一断就是 `EPIPE: broken pipe`，
 *      未捕获异常直接弹「A JavaScript error occurred in the main process」然后退出。
 *      所以这里默认把 stdout/stderr 写进**日志文件**，读日志用返回的 `tail()`。
 *   2) **受限环境里 Chromium 的 GPU 子进程可能建不出来**：主线会
 *      `GPU process launch failed: error_code=18` 刷十行然后
 *      `FATAL: GPU process isn't usable. Goodbye.` 直接退出 —— 窗口画出来 2~4 秒后就没。
 *      默认参数（= 发布同款）先试；确认是这个签名才追加**最小让步** `--disable-gpu-sandbox`
 *      （只关 GPU 进程那层沙箱，渲染进程沙箱和业务代码都不动），并把 `degraded` 标记
 *      一路带到验收报告里 —— 让步必须可见，绝不让"放宽后的绿"冒充"发布配置的绿"。
 *
 * 用法：
 *   const { launchReady } = require('./lib/spawn-electron');
 *   const { app, target, degraded } = await launchReady({ port, userData: prof.userData, cwd: ROOT });
 *   // ... 用 target.webSocketDebuggerUrl 跑断言；收尾 app.kill()
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { sleep, targets } = require('./cdp');

const ROOT = path.join(__dirname, '..', '..');

/** 窗口被挡住时 Chromium 会停止出帧、captureScreenshot 会卡住 —— 测试实例一律带上 */
const STABILITY_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

/** 子进程建不出来时 Chromium 打的签名（这是我们唯一会追加让步参数的依据） */
const CHILD_PROCESS_FAILURE = [
  /GPU process isn't usable/i,
  /GPU process launch failed/i,
  /Renderer process launch-failed/i,
  /Failed to create (?:a )?(?:GPU|renderer)/i,
];

/** 最小让步：只关 GPU 进程沙箱（正常机器/CI 上用不到，见文件头第 2 条） */
const DEGRADED_ARGS = ['--disable-gpu-sandbox'];

/**
 * 更大一级让步：整个 Chromium 进程沙箱关掉。
 *
 * 某些宿主（受限宿主 / 作业对象里跑的自动化外壳 / 无交互桌面的启动器）里，连
 * 发布同款和上面那级最小让步都会启动即退：进程 ~200ms 内以 0x80000003
 * （STATUS_BREAKPOINT，Chromium 沙箱初始化失败的 __debugbreak）退出，而且
 * 一行日志都不打 —— 所以不能只靠日志签名判定，必须把「启动即死」本身当成重试依据。
 * 它只在最后一级尝试，且 degraded 会一路带进报告，让步永远可见。
 */
const NO_SANDBOX_ARGS = ['--no-sandbox'];

/** 额外启动参数：`TAKOV_ELECTRON_ARGS="--no-sandbox"`（给了就完全按它来，不再自动探测） */
function extraArgs(env = process.env) {
  return String(env.TAKOV_ELECTRON_ARGS || '').trim().split(/\s+/).filter(Boolean);
}

/**
 * 组装传给 Electron 的参数表（纯函数，便于单测）。
 * 开关放在最前面：Chromium 只认"第一个非开关参数（应用路径）之前"的那批开关。
 */
function buildArgs({ port, appPath = '.', args = [], stability = true, env = process.env } = {}) {
  const out = [...extraArgs(env)];
  if (stability) out.push(...STABILITY_ARGS);
  if (port) out.push(`--remote-debugging-port=${port}`);
  out.push(appPath);
  out.push(...args);
  return out;
}

/** Electron 可执行文件：允许用 TAKOV_ELECTRON 覆盖（测打包版/其它版本时用） */
function electronBin(env = process.env) {
  if (env.TAKOV_ELECTRON) return env.TAKOV_ELECTRON;
  return require('electron'); // 包路径（electron/index.js 导出 exe 路径）
}

/** 日志里有没有"Chromium 子进程建不出来"的签名 */
function hasChildProcessFailure(logText) {
  const s = String(logText || '');
  return CHILD_PROCESS_FAILURE.some((re) => re.test(s));
}

/**
 * 起一个隔离实例（不做任何就绪判断，配套 launchReady 用）。
 * @returns {{proc, bin, args, logFile, tail, kill, alive}}
 */
function launchApp(opts = {}) {
  const {
    port, userData, cwd = ROOT, appPath = '.', args = [], logFile,
    stability = true, env = process.env,
  } = opts;
  const bin = opts.bin || electronBin(env);
  const argv = buildArgs({ port, appPath, args, stability, env });
  const log = logFile || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'takov-app-log-')), 'electron.log');
  const fd = fs.openSync(log, 'a');
  const proc = spawn(bin, argv, {
    cwd,
    env: { ...env, ...(userData ? { TAKOV_USER_DATA: userData } : {}) },
    stdio: ['ignore', fd, fd],
    windowsHide: false,
  });
  proc.on('exit', () => { try { fs.closeSync(fd); } catch {} });
  return {
    proc,
    bin,
    args: argv,
    logFile: log,
    get alive() { return proc.exitCode === null && !proc.killed; },
    tail: (lines = 25) => {
      try { return fs.readFileSync(log, 'utf-8').split('\n').slice(-lines).join('\n'); } catch { return ''; }
    },
    kill: () => {
      try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      try { proc.kill(); } catch {}
    },
  };
}

/** 等页面出现，或者进程先死（立刻返回，不干等到超时） */
async function waitForTargetOrExit(port, app, match, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const t = (await targets(port)).find(match);
      if (t) return t;
    } catch {}
    if (!app.alive) return null;
    if (Date.now() >= until) return null;
    await sleep(250);
  }
}

/**
 * 起实例并等到目标页面出现；只有确认是"子进程建不出来"才用让步参数重试一次。
 * @param {object} opts 同 launchApp，另有：
 * @param {(t: object) => boolean} [opts.match] 目标页面匹配（默认任意页面）
 * @param {number} [opts.timeoutMs]  单次尝试的就绪超时（默认 30s）
 * @returns {Promise<{app, target, degraded, attempts}>}
 */
async function launchReady(opts = {}) {
  const {
    port, cwd = ROOT, userData, appPath = '.', args = [], logFile,
    stability = true, env = process.env,
    match = () => true, timeoutMs = 30000,
  } = opts;
  const explicit = extraArgs(env);
  // 明确给了开关就完全听调用方的；否则按「发布同款 -> 最小让步 -> 关沙箱」三级递进
  const candidates = explicit.length
    ? [explicit]
    : [[], DEGRADED_ARGS, NO_SANDBOX_ARGS];
  const attempts = [];
  for (let i = 0; i < candidates.length; i++) {
    const extra = candidates[i];
    const app = launchApp({ port, cwd, userData, appPath, args: [...extra, ...args], logFile, stability, env });
    attempts.push({ extra, pid: app.proc.pid });
    const target = await waitForTargetOrExit(port, app, match, timeoutMs);
    if (target) return { app, target, degraded: extra.length > 0, usedArgs: extra, attempts };
    const log = app.tail(80);
    const childFailure = hasChildProcessFailure(log);
    const died = !app.alive; // 沙箱初始化失败会「启动即退、且不打日志」，必须单独认
    app.kill();
    await sleep(500); // 让端口/进程树彻底释放，再决定要不要重试
    const last = i === candidates.length - 1;
    if (!childFailure && !died) {
      // 进程活着、只是没等到目标页面 —— 这是真问题，别拿让步参数把它盖过去
      throw new Error(`实例起来了但没等到目标页面（端口 ${port}）${explicit.length ? '' : '，且日志里没有子进程失败签名'}；日志尾部：\n${log.slice(-1500)}`);
    }
    if (last) {
      throw new Error(`已经用了 ${extra.join(' ') || '发布同款参数'} 还是起不来`
        + `（${died ? '启动即退' : '子进程失败'}，exitCode=${app.proc.exitCode}）；日志尾部：\n${log.slice(-1500)}`);
    }
    const next = candidates[i + 1];
    if (next === NO_SANDBOX_ARGS) {
      console.log(`（受限宿主：实例启动即退（沙箱初始化失败，STATUS_BREAKPOINT），改用最后一级让步参数 ${next.join(' ')} 重试；`
        + '只关测试实例的 Chromium 进程沙箱，业务代码没有放宽，报告里会记明）');
    } else {
      console.log(`（受限环境：Chromium 子进程建不出来，改用最小让步参数 ${next.join(' ')} 重试；`
        + '只影响测试实例的 GPU 进程沙箱，不动业务代码）');
    }
  }
  throw new Error('实例启动失败（没有可用的参数组合）');
}

module.exports = {
  launchApp,
  launchReady,
  waitForTargetOrExit,
  buildArgs,
  extraArgs,
  electronBin,
  hasChildProcessFailure,
  STABILITY_ARGS,
  DEGRADED_ARGS,
  NO_SANDBOX_ARGS,
  CHILD_PROCESS_FAILURE,
  ROOT,
};
