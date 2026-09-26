'use strict';

/**
 * 解析器：截图文件名 -> 位置；游戏日志行 -> 地图事件
 */
const {
  SCREENSHOT_RE_STRICT,
  SCREENSHOT_RE_TOLERANT,
  BUNDLE_TO_RAIDCODE,
  RCID_TO_RAIDCODE,
} = require('./constants');

/**
 * bundle 名 / rcid 名 -> raidCode
 * 日志里 14 张图中有 13 个是 "<name>_preset.bundle"，只有立交桥是 "shopping_mall.bundle"，
 * 所以这里不能无脑拼 _preset：带后缀和不带后缀都要试一遍，最后用同一行的 rcid 兜底。
 * @param {string} base bundle 名（已去掉 _preset 后缀）
 * @param {string|null} rcid 同一行 rcid: 后的资源名
 * @returns {string|null}
 */
function resolveRaidCode(base, rcid) {
  const b = String(base || '').toLowerCase().replace(/_preset$/, '');
  if (b) {
    for (const key of [`${b}_preset`, b]) {
      if (BUNDLE_TO_RAIDCODE[key]) return BUNDLE_TO_RAIDCODE[key];
    }
  }
  const r = String(rcid || '').toLowerCase();
  if (r) {
    for (const key of [r, r.replace(/_/g, '')]) {
      if (RCID_TO_RAIDCODE[key]) return RCID_TO_RAIDCODE[key];
    }
  }
  return null;
}

/**
 * 解析截图文件名
 * 例: 2026-09-07[23-05]_58.02, 1.75, 49.47_0.01518, 0.90924, -0.03197, 0.41476_15.47 (0).png
 * 返回 { x, y(高度), z, quaternion:[x,y,z,w], extra } 或 null
 */
function parseScreenshotFilename(name) {
  if (!name || !name.toLowerCase().endsWith('.png')) return null;
  const m = name.match(SCREENSHOT_RE_STRICT) || name.match(SCREENSHOT_RE_TOLERANT);
  if (!m) return null;
  const num = (s) => Number(s);
  const q = [num(m[4]), num(m[5]), num(m[6]), num(m[7])];
  if (q.some((v) => !Number.isFinite(v))) return null;
  const result = {
    x: num(m[1]),
    y: num(m[2]),
    z: num(m[3]),
    quaternion: q,
    file: name,
  };
  // 文件名中四元数后可能还有一段数字（如 _15.47），保留备用
  const tail = SCREENSHOT_RE_TOLERANT.exec(name);
  if (tail) {
    const rest = name.slice(tail.index + tail[0].length);
    const extra = rest.match(/(-?\d+(?:\.\d+)?)/);
    if (extra) result.extra = Number(extra[1]);
  }
  return result;
}

/**
 * 解析日志行 -> 事件
 * 行格式: 2026-09-07 23:18:12.829|1.0.5.0.45581|Info|application|scene preset path:...
 */
function parseLogLine(line) {
  if (typeof line !== 'string' || !line) return null;
  const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\|/);
  // 游戏日志写的是**本机本地时间**（与会话目录名/文件时间一致），所以按本地时区解析。
  // 早先按 UTC 解析（末尾拼 'Z'），在 UTC+8 机器上会让时间戳比真实值大 8 小时，
  // 于是"这次进图行是不是比当前定位更新"的判断永远为真 —— 启动/重连回放历史进图行
  // 会把当前这一局的定位和轨迹误清掉。
  const ts = tsMatch ? new Date(tsMatch[1].replace(' ', 'T')).getTime() : null;

  // 1) scene preset path:maps/factory_day_preset.bundle rcid:factory_day.scenespreset.asset
  //    （立交桥为 maps/shopping_mall.bundle，不带 _preset）
  const preset = line.match(/scene preset path:\s*maps\/([A-Za-z0-9_]+)\.bundle/i);
  if (preset) {
    const bundle = preset[1];
    const bundleName = bundle.replace(/_preset$/i, '');
    const rcidMatch = line.match(/rcid:\s*([A-Za-z0-9_]+)/i);
    const rcid = rcidMatch ? rcidMatch[1] : null;
    return {
      type: 'scene-preset',
      ts,
      bundleName,
      bundle,
      rcid,
      raidCode: resolveRaidCode(bundleName, rcid),
    };
  }

  // 2) 局内登场：TRACE-NetworkGameCreate profileStatus: '... Location: factory4_day ...'
  const gameCreate = line.match(/TRACE-NetworkGameCreate[\s\S]*?Location:\s*([A-Za-z0-9_]+)/i);
  if (gameCreate) {
    return { type: 'network-game-create', ts, raidCode: gameCreate[1] };
  }

  // 3) LocationLoaded:11.11 real:15.54 diff:4.43
  const loaded = line.match(/LocationLoaded:/i);
  if (loaded) {
    return { type: 'location-loaded', ts };
  }

  // 4) [Transit] Flag:Common, RaidId:..., Count:0, Locations:factory4_day ->
  const transit = line.match(/\[Transit\][\s\S]*?Locations:\s*([A-Za-z0-9_]+)\s*->/i);
  if (transit) {
    return { type: 'transit', ts, fromRaidCode: transit[1] };
  }

  // 5) 匹配 / 进图阶段（战局提示音只认这几行，见 src/raid-alerts.js）
  //    实测（1.1.5.1 PvE，4 个会话 6 局）：
  //      Matching with group id: N        <- 开始匹配（等待服务器）
  //        +16~28s   LocationLoaded
  //        +197~209s MatchingCompleted    <- 匹配到了
  //        +17~18s   GamePrepared/GameCreated -> GamePooled
  //        +7s       GameRunned -> GameSpawn -> PlayerSpawnEvent
  //        +10.3s    GameSpawned          <- 倒计时开始（两个会话各两局都是 10.3s）
  //        +9.4~10.3s GameStarting        <- 倒计时结束 / 开始进入地图
  //        +12s      GameStarted          <- 已经在局内
  const phase = line.match(RAID_PHASE_RE);
  if (phase) {
    const token = phase[1];
    if (token.startsWith('Matching with group id')) {
      return { type: 'matching-start', ts, groupId: phase[2] || null };
    }
    return { type: RAID_PHASE_TYPES[token] || 'raid-phase', ts, token };
  }

  return null;
}

/**
 * 匹配 / 进图阶段的行（战局提示音靠这几行，见 src/raid-alerts.js）。
 * 只认 "…|application|<token>" 这种消息开头的行，不会误伤正文里提到这些词的其它行。
 * 注意 GameSpawn: 与 GameSpawned: 靠冒号区分（GameSpawned 不会命中 GameSpawn:）。
 */
const RAID_PHASE_RE = /\|application\|(Matching with group id:\s*(\d+)|MatchingCompleted:|GamePrepared:|GameCreated:|GamePooled:|GameRunned:|GameSpawn:|PlayerSpawnEvent:|GameSpawned:|GameStarting:|GameStarted:)/;

const RAID_PHASE_TYPES = {
  'MatchingCompleted:': 'matching-completed',
  'GamePrepared:': 'game-prepared',
  'GameCreated:': 'game-created',
  'GamePooled:': 'game-pooled',
  'GameRunned:': 'game-runned',
  'GameSpawn:': 'game-spawn',
  'PlayerSpawnEvent:': 'player-spawn',
  'GameSpawned:': 'game-spawned',
  'GameStarting:': 'game-starting',
  'GameStarted:': 'game-started',
};

module.exports = { parseScreenshotFilename, parseLogLine, resolveRaidCode, RAID_PHASE_TYPES };
