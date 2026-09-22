'use strict';

/**
 * 定时自动截图（**模拟游戏截图键**）。
 *
 * 为什么是"模拟按键"而不是"应用自己截屏"：
 * 定位只能来自"游戏写出的带坐标截图"（文件名里有 x,y,z + 四元数，见 src/parsers.js）。
 * 应用自己截屏拿不到坐标，所以想让定位定时刷新，唯一办法是**替玩家按游戏截图键**。
 *
 * 安全边界（很重要）：
 *   - 只用 OS 级合成按键（user32 的 keybd_event），**不注入游戏进程、不读写游戏内存**；
 *   - 只有"游戏窗口在最前面"时才按（PowerShell 里用 GetForegroundWindow 判定进程名），
 *     免得把按键打到浏览器/聊天窗口上；
 *   - 默认关；连按 3 次都没拿到新定位就自动暂停（键位不对 / 不在局内），不会一直刷截图。
 *
 * 这个模块是纯 Node 的（只用 child_process），不 require electron —— 单测可以直接跑，
 * 也可以注入假的 press / 定时器 / spawn，CI 上永远不会真的往外发按键。
 */

const DEFAULT_KEY = 'PrintScreen';
const DEFAULT_INTERVAL_SEC = 30;
const MIN_INTERVAL_SEC = 5;
const MAX_INTERVAL_SEC = 600;
const PRESS_TIMEOUT_MS = 3000;   // 助手 3 秒不回就当这次失败（不会卡住后续）
const NO_EFFECT_LIMIT = 3;       // 连续这么多次"按下去了但没新定位"就暂停

/** 游戏进程名（不区分大小写）：只有它在前台才发按键 */
const GAME_PROCESS = 'EscapeFromTarkov';

/**
 * 键名 -> 虚拟键码。键名沿用浏览器 DOM 的 `e.code` 写法
 * （PrintScreen / F12 / KeyP / Digit1 / Numpad0 …），设置页里"按下按键"直接拿 `e.code` 填。
 * scan 只在个别键上有意义（PrintScreen 必须给 0x37 才是系统级截图键），
 * ext = 是否带 KEYEVENTF_EXTENDEDKEY（小键盘/方向键/Insert 那一批）。
 */
const KEY_TO_VK = {};
for (let i = 1; i <= 12; i++) KEY_TO_VK[`F${i}`] = { vk: 0x6f + i, scan: 0, ext: 0 };          // F1..F12
for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(65 + i);
  KEY_TO_VK[`Key${ch}`] = { vk: 0x41 + i, scan: 0, ext: 0 };                                  // KeyA..KeyZ
}
for (let i = 0; i <= 9; i++) {
  KEY_TO_VK[`Digit${i}`] = { vk: 0x30 + i, scan: 0, ext: 0 };                                 // Digit0..9
  KEY_TO_VK[`Numpad${i}`] = { vk: 0x60 + i, scan: 0, ext: 0 };                                // Numpad0..9
}
Object.assign(KEY_TO_VK, {
  PrintScreen: { vk: 0x2c, scan: 0x37, ext: 1 },
  Insert: { vk: 0x2d, scan: 0x52, ext: 1 },
  Delete: { vk: 0x2e, scan: 0x53, ext: 1 },
  Home: { vk: 0x24, scan: 0x47, ext: 1 },
  End: { vk: 0x23, scan: 0x4f, ext: 1 },
  PageUp: { vk: 0x21, scan: 0x49, ext: 1 },
  PageDown: { vk: 0x22, scan: 0x51, ext: 1 },
  Space: { vk: 0x20, scan: 0x39, ext: 0 },
  Enter: { vk: 0x0d, scan: 0x1c, ext: 1 },
  Escape: { vk: 0x1b, scan: 0x01, ext: 0 },
  Tab: { vk: 0x09, scan: 0x0f, ext: 0 },
  Backquote: { vk: 0xc0, scan: 0x29, ext: 0 },
  Minus: { vk: 0xbd, scan: 0x0c, ext: 0 },
  Equal: { vk: 0xbb, scan: 0x0d, ext: 0 },
  BracketLeft: { vk: 0xdb, scan: 0x1a, ext: 0 },
  BracketRight: { vk: 0xdd, scan: 0x1b, ext: 0 },
  Semicolon: { vk: 0xba, scan: 0x27, ext: 0 },
  Quote: { vk: 0xde, scan: 0x28, ext: 0 },
  Comma: { vk: 0xbc, scan: 0x33, ext: 0 },
  Period: { vk: 0xbe, scan: 0x34, ext: 0 },
  Slash: { vk: 0xbf, scan: 0x35, ext: 0 },
  Backslash: { vk: 0xdc, scan: 0x2b, ext: 0 },
  NumpadAdd: { vk: 0x6b, scan: 0x4e, ext: 0 },
  NumpadSubtract: { vk: 0x6d, scan: 0x4a, ext: 0 },
  NumpadMultiply: { vk: 0x6a, scan: 0x37, ext: 0 },
  NumpadDivide: { vk: 0x6f, scan: 0x35, ext: 1 },
  NumpadDecimal: { vk: 0x6e, scan: 0x53, ext: 0 },
  CapsLock: { vk: 0x14, scan: 0x3a, ext: 0 },
});

/** 老版本/手写常见的别名（用户直接手打时更友好） */
const KEY_ALIASES = {
  prtsc: 'PrintScreen',
  prtscr: 'PrintScreen',
  print: 'PrintScreen',
  printscreen: 'PrintScreen',
  snapshot: 'PrintScreen',
  esc: 'Escape',
  return: 'Enter',
  spacebar: 'Space',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  capslock: 'CapsLock',
};

/**
 * 归一化键名：去空格/连字符/下划线 + 忽略大小写，认不出来返回 null。
 * 兼容 `Print Screen` / `printscreen` / `p` / `F12` / `num1`。
 */
function normalizeKeyName(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/[\s_-]+/g, '');
  if (!s) return null;
  const lower = s.toLowerCase();
  for (const name of Object.keys(KEY_TO_VK)) {
    if (name.toLowerCase() === lower) return name;
  }
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if (/^[a-z]$/.test(lower)) return KEY_TO_VK[`Key${lower.toUpperCase()}`] ? `Key${lower.toUpperCase()}` : null;
  if (/^\d$/.test(s)) return KEY_TO_VK[`Digit${s}`] ? `Digit${s}` : null;
  const num = lower.match(/^numpad?(\d)$/) || lower.match(/^num(\d)$/);
  if (num) return KEY_TO_VK[`Numpad${num[1]}`] ? `Numpad${num[1]}` : null;
  return null;
}

/** 间隔夹到 5~600 秒（默认 30） */
function clampIntervalSec(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_SEC;
  return Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, Math.round(n)));
}

/** 干跑：只记状态、不真的发按键（自动化验收用，避免往用户机器上打按键） */
function dryRunRequested(argv = process.argv, env = process.env) {
  return !!(env && String(env.TAKOV_AUTOSHOT_DRY) === '1') || (Array.isArray(argv) && argv.includes('--autoshot-dry'));
}

/**
 * 定时器 + 决策。所有外部依赖都可注入，单测里 tick() 手动调、定时器是假的。
 *
 * 跳过原因（stats().lastSkip）：disabled / paused / busy / not-in-raid / no-dir / interval
 * 按下结果（stats().lastResult）：ok | dry | skip:not-foreground | err
 */
class AutoShotRunner {
  /**
   * @param {object} opts
   * @param {(o:{key:string}) => Promise<string>} [opts.press] 真正去按（返回上面那几种结果）
   * @param {Function} [opts.log]
   * @param {Function} [opts.now]
   * @param {Function} [opts.setInterval] 注入假的（单测不建真定时器）
   * @param {Function} [opts.clearInterval]
   * @param {boolean} [opts.dryRun]
   */
  constructor(opts = {}) {
    this.press = opts.press || (() => Promise.resolve('err'));
    this.log = opts.log || (() => {});
    this.now = opts.now || (() => Date.now());
    this.setInterval = opts.setInterval || setInterval;
    this.clearInterval = opts.clearInterval || clearInterval;
    this.dryRun = !!opts.dryRun;
    this.cfg = { enabled: false, intervalSec: DEFAULT_INTERVAL_SEC, key: DEFAULT_KEY };
    this.ctx = { inRaid: false, dirOk: true };
    this.timer = null;
    this.busy = false;
    this.paused = false;
    this.pauseReason = null;
    this.lastAt = 0;
    this.lastResult = null;
    this.lastSkip = 'disabled';
    this.presses = 0;
    this.noEffect = 0;
    // 状态回调：状态有变化时把 stats() 推给主进程（主进程再节流广播给窗口）。
    // 忘了接这根线的话，界面上的"上次按下/为什么没按/是否暂停"会一直停在旧值 —— 踩过。
    this.onStatus = opts.onStatus || null;
  }

  /** 配置来了：校验键名与间隔，开关跟着起停定时器 */
  applyConfig(autoShot) {
    const c = autoShot && typeof autoShot === 'object' ? autoShot : {};
    const enabled = !!c.enabled;
    const key = normalizeKeyName(c.key) || DEFAULT_KEY;
    const intervalSec = clampIntervalSec(c.intervalSec);
    const changed = key !== this.cfg.key || intervalSec !== this.cfg.intervalSec || enabled !== this.cfg.enabled;
    this.cfg = { enabled, key, intervalSec };
    if (enabled && changed) {
      // 重新开启 / 改键 / 改间隔 = 给一次重试机会（上次可能因为"连续没效果"暂停了）
      this.paused = false;
      this.pauseReason = null;
      this.noEffect = 0;
      this.lastAt = 0; // 改了设置就立刻试一次，不用再等一个完整间隔
      this.lastSkip = enabled ? 'interval' : 'disabled';
    }
    if (enabled) this.start();
    else this.stop();
    this.pushStatus();
    return this.cfg;
  }

  /** 局内 / 截图目录是否可用（主进程每次状态变化时喂进来） */
  setContext(patch = {}) {
    let changed = false;
    for (const k of ['inRaid', 'dirOk']) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      const v = !!patch[k];
      if (this.ctx[k] !== v) {
        this.ctx[k] = v;
        changed = true;
      }
    }
    if (changed) this.pushStatus();
    return this.ctx;
  }

  start() {
    if (this.timer) return;
    this.timer = this.setInterval(() => this.tick(), 1000);
    if (this.timer && typeof this.timer === 'object' && this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      this.clearInterval(this.timer);
      this.timer = null;
    }
    this.busy = false;
  }

  /** 每秒跑一次：到了间隔就按一下（不阻塞，press 是 Promise） */
  tick() {
    const now = this.now();
    const { enabled, intervalSec, key } = this.cfg;
    if (!enabled) return this.#skip('disabled', now);
    if (this.paused) return this.#skip(this.pauseReason || 'paused', now);
    if (this.busy) return this.#skip('busy', now);
    if (!this.ctx.inRaid) return this.#skip('not-in-raid', now);
    if (!this.ctx.dirOk) return this.#skip('no-dir', now);
    // lastAt = 0 表示"还没按过"（刚开启/刚改设置）-> 立刻按一次，不用等一个完整间隔
    if (this.lastAt && now - this.lastAt < intervalSec * 1000) return this.#skip('interval', now);

    this.lastAt = now;
    this.busy = true;
    this.presses += 1;
    const run = this.dryRun
      ? Promise.resolve('dry')
      : Promise.resolve().then(() => this.press({ key }));
    return run
      .then((r) => this.#after(typeof r === 'string' && r ? r : 'ok'))
      .catch((e) => this.#after(`err:${(e && e.message) || e}`));
  }

  /** 拿到一次新定位：说明按键真的生效了，清掉"连续没效果"的计数（必要时解除暂停） */
  notePosition() {
    const wasPaused = this.paused && this.pauseReason === 'no-effect';
    if (wasPaused) {
      this.paused = false;
      this.pauseReason = null;
      this.log('自动截图：又拿到定位了，已恢复自动按键');
    }
    if (this.noEffect) this.noEffect = 0;
    if (wasPaused) this.pushStatus();
  }

  stats() {
    const { enabled, key, intervalSec } = this.cfg;
    return {
      enabled,
      key,
      intervalSec,
      presses: this.presses,
      lastAt: this.lastAt || null,
      lastResult: this.lastResult,
      lastSkip: this.lastSkip,
      paused: this.paused,
      pauseReason: this.pauseReason,
      running: !!this.timer,
      busy: this.busy,
      noEffect: this.noEffect,
      inRaid: this.ctx.inRaid,
      dirOk: this.ctx.dirOk,
      nextInMs: enabled && this.lastAt ? Math.max(0, this.lastAt + intervalSec * 1000 - this.now()) : 0,
      dryRun: this.dryRun,
    };
  }

  pushStatus() {
    if (!this.onStatus) return;
    try {
      this.onStatus(this.stats());
    } catch (e) {
      this.log(`自动截图：状态回调出错 ${(e && e.message) || e}`);
    }
  }

  #skip(reason, now) {
    if (this.lastSkip !== reason) {
      this.lastSkip = reason;
      this.pushStatus();
    }
    return reason;
  }

  #after(result) {
    this.busy = false;
    this.lastResult = result;
    if (result === 'ok' || result === 'dry') {
      this.noEffect += 1;
      // 每次按下都记一行：排查"功能开了但没反应"时，看 app.log 就知道到底按没按
      this.log(`自动截图：按下 ${this.cfg.key} -> ${result}（第 ${this.presses} 次，连续无效果 ${this.noEffect}/${NO_EFFECT_LIMIT}）`);
      if (this.noEffect >= NO_EFFECT_LIMIT) {
        this.paused = true;
        this.pauseReason = 'no-effect';
        this.log(`自动截图已暂停：连续 ${NO_EFFECT_LIMIT} 次按下都没拿到新定位（键位不对？不在局内？）`);
      }
    } else if (result !== 'skip:not-foreground') {
      this.log(`自动截图：这次没按成（${result}）`);
    }
    this.pushStatus();
    return result;
  }
}

/**
 * 常驻 PowerShell 助手（Windows）：读一行命令 -> 发一次按键。
 *   `?`                -> 回 "1"/"0"：游戏窗口是不是在最前面
 *   `<vk>,<scan>,<ext>` -> 游戏在前台就 keybd_event 按下+抬起并回 "ok"，否则回 "skip"
 *
 * 惰性启动：只有真的要按时才起进程；关掉功能/退出应用要 stop() 收干净。
 */
const AUTO_SHOT_PS = [
  'Add-Type -Namespace TkKey -Name Native -MemberDefinition @"',
  '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);',
  '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);',
  '"@',
  `$game = ${JSON.stringify(GAME_PROCESS)}`,
  '$i = [Console]::In',
  '$o = [Console]::Out',
  'function Game-Foreground {',
  '  $fg = [TkKey.Native]::GetForegroundWindow()',
  '  $fpid = 0',
  '  [void][TkKey.Native]::GetWindowThreadProcessId($fg, [ref]$fpid)',
  '  $name = ""',
  '  try { $name = (Get-Process -Id $fpid -ErrorAction Stop).ProcessName } catch {}',
  '  return ($name -ieq $game)',
  '}',
  'while ($true) {',
  '  $line = $i.ReadLine()',
  '  if ($line -eq $null) { break }',
  '  try {',
  '    if ($line -eq "?") {',
  '      if (Game-Foreground) { $o.WriteLine("1") } else { $o.WriteLine("0") }',
  '    } elseif (Game-Foreground) {',
  '      $p = $line.Split(",")',
  '      $vk = [byte][int]$p[0]',
  '      $scan = [byte][int]$p[1]',
  '      $flags = 0',
  '      if ([int]$p[2] -ne 0) { $flags = 1 }',
  '      [TkKey.Native]::keybd_event($vk, $scan, [uint32]$flags, [System.UIntPtr]::Zero)',
  '      Start-Sleep -Milliseconds 40',
  '      [TkKey.Native]::keybd_event($vk, $scan, [uint32]($flags -bor 2), [System.UIntPtr]::Zero)',
  '      $o.WriteLine("ok")',
  '    } else {',
  '      $o.WriteLine("skip")',
  '    }',
  '  } catch { $o.WriteLine("err") }',
  '  $o.Flush()',
  '}',
].join('\n');

/**
 * @param {object} opts
 * @param {Function} [opts.spawn] 注入 child_process.spawn（单测用假的）
 * @param {Function} [opts.log]
 * @param {string} [opts.command] powershell 可执行名（默认 powershell）
 * @returns {{press:(key:string)=>Promise<string>, gameForeground:()=>Promise<boolean|null>, alive:()=>boolean, stop:()=>void}}
 */
function createKeyPressHelper(opts = {}) {
  const spawnFn = opts.spawn || require('child_process').spawn;
  const log = opts.log || (() => {});
  const command = opts.command || 'powershell';
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : PRESS_TIMEOUT_MS;
  let proc = null;
  let buf = '';
  let dead = false;
  const queue = []; // 每项：{ resolve, timer }

  const fail = (why) => {
    if (!proc && dead) return;
    dead = true;
    log(`自动截图助手不可用（${why}）`);
    while (queue.length) {
      const item = queue.shift();
      clearTimeout(item.timer);
      item.resolve('err');
    }
    proc = null;
  };

  const onLine = (line) => {
    const item = queue.shift();
    if (!item) return;
    clearTimeout(item.timer);
    item.resolve(line || 'err');
  };

  const start = () => {
    if (proc || dead) return proc;
    try {
      proc = spawnFn(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', AUTO_SHOT_PS], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (e) {
      dead = true;
      proc = null;
      log(`自动截图助手启动失败：${(e && e.message) || e}`);
      return null;
    }
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        onLine(line);
      }
    });
    proc.on('error', (e) => fail((e && e.message) || 'error'));
    proc.on('exit', (code) => fail(`exit ${code}`));
    return proc;
  };

  /** 发一行命令，等一行回复；超时算失败（绝不卡住定时器） */
  const ask = (line, okMap) => new Promise((resolve) => {
    start();
    if (dead || !proc || !proc.stdin || !proc.stdin.writable) return resolve('err');
    const item = {
      resolve: (raw) => resolve(okMap ? (okMap[raw] !== undefined ? okMap[raw] : 'err') : raw),
      timer: null,
    };
    item.timer = setTimeout(() => {
      const i = queue.indexOf(item);
      if (i >= 0) queue.splice(i, 1);
      resolve('err');
    }, timeoutMs);
    // 故意不 unref：最多 3 秒，而且只在"一次按键还在飞"的时候存在。
    // unref 掉的话，进程里一旦没有别的活动，这个"等回复"会被直接掐断（调用方永远等不到结果）。
    queue.push(item);
    try {
      proc.stdin.write(`${line}\n`);
    } catch (e) {
      const i = queue.indexOf(item);
      if (i >= 0) queue.splice(i, 1);
      clearTimeout(item.timer);
      resolve('err');
    }
  });

  return {
    /** 按一次键：返回 'ok' | 'skip:not-foreground' | 'err' */
    press(key) {
      const info = KEY_TO_VK[key];
      if (!info) return Promise.resolve('err');
      return ask(`${info.vk},${info.scan},${info.ext}`, { ok: 'ok', skip: 'skip:not-foreground' });
    },
    /** 游戏窗口在前台吗（拿不到返回 null） */
    gameForeground() {
      return ask('?', { 1: true, 0: false }).then((v) => (v === true || v === false ? v : null));
    },
    alive: () => !!proc && !dead,
    stop() {
      // 还没等到回复的调用方要立刻拿到结果（否则定时器/退出流程会挂着一个 pending promise）
      while (queue.length) {
        const item = queue.shift();
        clearTimeout(item.timer);
        item.resolve('err');
      }
      if (proc) {
        try {
          if (proc.stdin && proc.stdin.writable) proc.stdin.end();
        } catch {}
        try {
          proc.kill();
        } catch {}
      }
      proc = null;
      dead = false;
      buf = '';
    },
  };
}

module.exports = {
  AutoShotRunner,
  createKeyPressHelper,
  normalizeKeyName,
  clampIntervalSec,
  dryRunRequested,
  KEY_TO_VK,
  AUTO_SHOT_PS,
  GAME_PROCESS,
  DEFAULT_KEY,
  DEFAULT_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  NO_EFFECT_LIMIT,
  PRESS_TIMEOUT_MS,
};
