'use strict';

/**
 * 解析器：截图文件名 -> 位置；游戏日志行 -> 地图事件
 */
const {
  SCREENSHOT_RE_STRICT,
  SCREENSHOT_RE_TOLERANT,
  BUNDLE_TO_RAIDCODE,
} = require('./constants');

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
  const ts = tsMatch ? new Date(tsMatch[1].replace(' ', 'T') + 'Z').getTime() : null;

  // 1) scene preset path:maps/factory_day_preset.bundle rcid:factory_day.scenespreset.asset
  const preset = line.match(/scene preset path:maps\/([a-z0-9_]+?)(?:_preset)?\.bundle/i);
  if (preset) {
    const bundle = preset[1] + '_preset';
    const raidCode = BUNDLE_TO_RAIDCODE[bundle] || BUNDLE_TO_RAIDCODE[preset[1] + '_preset'] || null;
    return { type: 'scene-preset', ts, bundleName: preset[1], raidCode };
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

  return null;
}

module.exports = { parseScreenshotFilename, parseLogLine };
