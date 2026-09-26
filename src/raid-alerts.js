'use strict';

/**
 * 战局提示音的状态机（纯逻辑：不碰定时器、不碰音频，方便单测）。
 *
 * 需求：提示音**只**在这三个时刻响
 *   1) 开始匹配（在等服务器）        <- 日志 `Matching with group id: N`
 *   2) 匹配到了                      <- 日志 `MatchingCompleted:`
 *   3) 进图倒计时的最后几秒           <- 倒计时从 `GameSpawned` 开始，`GameStarting` 是结束
 * 截图定位、队友位置、换图、进图本身一律不响。
 *
 * 时序是**真实日志量出来的**（1.1.5.1 PvE，4 个会话 6 局，见 test/raid-alerts.test.js）：
 *
 *   Matching with group id: N        开始匹配（等待服务器）
 *     +16~28s    LocationLoaded
 *     +197~209s  MatchingCompleted   匹配到了
 *     +17~18s    GamePooled
 *     +7s        GameRunned -> GameSpawn -> PlayerSpawnEvent
 *     +10.3s     GameSpawned         倒计时开始（4 局全是 10.3s）
 *     +9.4~10.3s GameStarting        倒计时结束 / 开始进图
 *     +12s       GameStarted         已经在局内
 *
 * 所以倒计时长度取 10s（COUNTDOWN_SEC），提示落在它的最后 leadSec 秒（默认 3s => 剩 3/2/1 秒各一声）。
 * 万一 `GameStarting` 比预计来得早（机器快/组队里别人先加载完），没响完的**立刻补一声**，
 * 免得该进图了却静悄悄。
 */

const STALE_MS = 30_000;   // 比这更旧的日志行不响：启动时会回补 2MB 历史，别一上来炸一串声音
const COUNTDOWN_SEC = 10;  // GameSpawned -> GameStarting 的实测长度
const LEAD_SEC = 3;        // "最后几秒"开始响（1~10）
const MIN_LEAD_SEC = 1;
const MAX_LEAD_SEC = 10;
const MIN_COUNTDOWN_SEC = 3;
const MAX_COUNTDOWN_SEC = 60;

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now] 取当前时间（测试里塞假时钟）
 * @param {number} [opts.staleMs] 过期阈值
 * @param {number} [opts.countdownSec] 倒计时长度
 * @param {number} [opts.leadSec] 最后几秒开始响
 * @param {(msg: string) => void} [opts.log] 诊断日志（写进 app.log 便于和现实对照）
 */
function createRaidAlerts(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : STALE_MS;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  let countdownSec = clampInt(opts.countdownSec, MIN_COUNTDOWN_SEC, MAX_COUNTDOWN_SEC, COUNTDOWN_SEC);
  let leadSec = clampInt(opts.leadSec, MIN_LEAD_SEC, MAX_LEAD_SEC, LEAD_SEC);

  let phase = 'idle';   // idle | matching | found | countdown | entering | in-raid
  let scheduled = [];   // [{kind:'countdown', at, remain}] 还没响的
  const stats = { queue: 0, found: 0, ticks: 0, lastKind: null, lastAt: null };

  function clearScheduled() {
    scheduled = [];
  }

  /** 倒计时提示的时间点：从结束时刻往前数 leadSec 个整秒（remain = 还剩几秒） */
  function scheduleCountdown(baseTs) {
    const end = baseTs + countdownSec * 1000;
    const out = [];
    for (let i = leadSec; i >= 1; i--) out.push({ kind: 'countdown', at: end - i * 1000, remain: i });
    scheduled = out;
  }

  function mark(kind, at) {
    stats.lastKind = kind;
    stats.lastAt = at;
  }

  return {
    get phase() { return phase; },
    get stats() { return { ...stats }; },
    get countdownSec() { return countdownSec; },
    get leadSec() { return leadSec; },

    setLeadSec(v) { leadSec = clampInt(v, MIN_LEAD_SEC, MAX_LEAD_SEC, leadSec); },
    setCountdownSec(v) { countdownSec = clampInt(v, MIN_COUNTDOWN_SEC, MAX_COUNTDOWN_SEC, countdownSec); },

    /** 重新开始（换根日志/手动清场时用） */
    reset() {
      phase = 'idle';
      clearScheduled();
    },

    /**
     * 喂一条日志事件。
     * @returns {Array<{kind:string, at:number, remain?:number}>} 立刻要响的提示（0~1 条）
     */
    feed(ev) {
      if (!ev || typeof ev.type !== 'string') return [];
      const ts = Number.isFinite(ev.ts) ? ev.ts : now();
      // 历史回放（应用在局内才启动、或回补 2MB 尾巴）：过去的事不响
      if (now() - ts > staleMs) return [];
      switch (ev.type) {
        case 'matching-start':
          phase = 'matching';
          clearScheduled();
          stats.queue++;
          mark('match-queue', ts);
          log(`[alert] 开始匹配（等待服务器） group=${ev.groupId || '-'}`);
          return [{ kind: 'match-queue', at: ts }];
        case 'matching-completed':
          phase = 'found';
          clearScheduled();
          stats.found++;
          mark('match-found', ts);
          log('[alert] 匹配到了');
          return [{ kind: 'match-found', at: ts }];
        case 'game-spawned':
          phase = 'countdown';
          scheduleCountdown(ts);
          log(`[alert] 进入地图倒计时（约 ${countdownSec}s，最后 ${leadSec}s 提示）`);
          return [];
        case 'game-starting': {
          // 倒计时结束 = 真的要进图了：还没响完的立刻补一声，别静悄悄进去
          const missed = scheduled.some((s) => s.at > ts);
          clearScheduled();
          phase = 'entering';
          if (missed) {
            stats.ticks++;
            mark('countdown', ts);
            log('[alert] 倒计时提前结束 -> 立刻提示');
            return [{ kind: 'countdown', at: ts, remain: 0 }];
          }
          return [];
        }
        case 'game-started':
          phase = 'in-raid';
          clearScheduled();
          return [];
        case 'scene-preset': // 进图（新一局）
          phase = 'in-raid';
          clearScheduled();
          return [];
        case 'network-game-create':
          phase = 'in-raid';
          return [];
        default:
          return [];
      }
    },

    /**
     * 到点了该响哪些（主进程按 nextAt() 排一个定时器，到点调它）。
     * @param {number} [atMs] 当前时间
     */
    due(atMs = now()) {
      if (!scheduled.length) return [];
      const out = scheduled.filter((s) => s.at <= atMs);
      if (!out.length) return [];
      scheduled = scheduled.filter((s) => s.at > atMs);
      for (const s of out) {
        stats.ticks++;
        mark('countdown', s.at);
        log(`[alert] 进图倒计时 ${s.remain} 秒`);
      }
      return out;
    },

    /** 下一个待响提示的时刻（没有 = null）：主进程用它排定时器 */
    nextAt() {
      return scheduled.length ? Math.min(...scheduled.map((s) => s.at)) : null;
    },
  };
}

module.exports = {
  createRaidAlerts,
  STALE_MS,
  COUNTDOWN_SEC,
  LEAD_SEC,
  MIN_LEAD_SEC,
  MAX_LEAD_SEC,
};
