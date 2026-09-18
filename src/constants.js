'use strict';

/**
 * 全局常量与映射表
 * 映射表来源：枫织梦境 Web 端源码 (main.js) 中提取的地图定义，
 * 与 data/maps-dump.json 中每张图的 id 一一对应。
 */

// ---------------------------------------------------------------------------
// 场景 Bundle 名 → 地图 raidCode（来自原站 _pe 表）
// 日志 scene preset path:maps/<bundleName>_preset.bundle
// ---------------------------------------------------------------------------
// 注意：日志里绝大多数是 "maps/<name>_preset.bundle"，但立交桥是 "maps/shopping_mall.bundle"
// （全游戏唯一一个不带 _preset 的），两种写法都要查得到，否则立交桥永远识别不出来。
const BUNDLE_TO_RAIDCODE = {
  city_1st_iteration_preset: 'TarkovStreets',
  city_1st_iteration: 'TarkovStreets',
  city_preset: 'TarkovStreets',
  city: 'TarkovStreets',
  customs_preset: 'bigmap',
  customs: 'bigmap',
  factory_day_preset: 'factory4_day',
  factory_day: 'factory4_day',
  factory_night_preset: 'factory4_night',
  factory_night: 'factory4_night',
  laboratory_preset: 'laboratory',
  laboratory: 'laboratory',
  labyrinth_preset: 'Labyrinth',
  labyrinth: 'Labyrinth',
  lighthouse_preset: 'Lighthouse',
  lighthouse: 'Lighthouse',
  rezerv_base_preset: 'RezervBase',
  rezerv_base: 'RezervBase',
  sandbox_preset: 'Sandbox',
  sandbox: 'Sandbox',
  sandbox_high_preset: 'Sandbox_high',
  sandbox_high: 'Sandbox_high',
  sandbox_start_preset: 'Sandbox_start',
  sandbox_start: 'Sandbox_start',
  sandbox_sl: 'Sandbox_start',
  shopping_mall_preset: 'Interchange',
  shopping_mall: 'Interchange',
  shoreline_preset: 'Shoreline',
  shoreline: 'Shoreline',
  woods_preset: 'Woods',
  woods: 'Woods',
};

// ---------------------------------------------------------------------------
// 第二信号：同一行末尾的 rcid:<Asset>.<ScenesPreset>.asset
// 万一以后 bundle 命名又变了（例如某张图去掉了 _preset），这里还能兜住。
// 取值来自真实日志统计（1.1.x）。
// ---------------------------------------------------------------------------
const RCID_TO_RAIDCODE = {
  bigmap: 'bigmap',
  city: 'TarkovStreets',
  factory_day: 'factory4_day',
  factory_night: 'factory4_night',
  laboratory: 'laboratory',
  labyrinth: 'Labyrinth',
  lighthouse: 'Lighthouse',
  rezerv_base: 'RezervBase',
  sandbox: 'Sandbox',
  sandbox_high: 'Sandbox_high',
  sandbox_sl: 'Sandbox_start',
  shopping_mall: 'Interchange',
  shoreline: 'Shoreline',
  woods: 'Woods',
};

// ---------------------------------------------------------------------------
// raidCode → 地图 key（data/maps-dump.json 的 detail.key 字段，kebab-case）
// 说明：Ground Zero 与 Ground Zero 21+ 共用 key 'ground-zero'（同一张图底图/投影），
//       夜间工厂与工厂共用 key 'factory'；会话识别仅需区分到这一层。
// ---------------------------------------------------------------------------
const RAIDCODE_TO_MAPKEY = {
  Sandbox: 'ground-zero',
  Sandbox_high: 'ground-zero',
  Sandbox_start: 'ground-zero',
  bigmap: 'customs',
  factory4_day: 'factory',
  factory4_night: 'factory',
  Woods: 'woods',
  Interchange: 'interchange',
  Shoreline: 'shoreline',
  RezervBase: 'reserve',
  Lighthouse: 'lighthouse',
  TarkovStreets: 'streets-of-tarkov',
  laboratory: 'the-lab',
  Labyrinth: 'the-labyrinth',
};

// 地图 key → 仓库 data/maps/ 下的 SVG 文件名（与 maps-dump 的 svgPath basename 对应）
const MAPKEY_TO_SVG = {
  terminal: 'Terminal.svg',
  streets: 'StreetsOfTarkov.svg',
  groundZero: 'GroundZero.svg',
  groundZero21: 'GroundZero.svg',
  customs: 'Customs.svg',
  factory: 'Factory.svg',
  nightFactory: 'Factory.svg',
  woods: 'Woods.svg',
  interchange: 'Interchange.svg',
  shoreline: 'Shoreline.svg',
  reserve: 'Reserve.svg',
  lighthouse: 'Lighthouse.svg',
  // theLab / icebreaker / labyrinth 目前仅瓦片（无 SVG），走"无底图"模式
};

// 会话目录名: log_2026.09.07_23-03-04_1.1.0.1.46911
const SESSION_DIR_RE = /^log_(\d{4}\.\d{2}\.\d{2}_\d{2}-\d{2}-\d{2})_(.+)$/;

// 截图文件名正则（原站正则 + 放宽空白容错）
// 例: 2026-09-07[23-05]_58.02, 1.75, 49.47_0.01518, 0.90924, -0.03197, 0.41476_15.47 (0).png
const SCREENSHOT_RE_STRICT =
  /([0-9.-]+),\s*([0-9.-]+),\s*([0-9.-]+)_([0-9.-]+),\s*([0-9.-]+),\s*([0-9.-]+),\s*([0-9.-]+)/i;
const SCREENSHOT_RE_TOLERANT =
  /(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)_\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i;

module.exports = {
  BUNDLE_TO_RAIDCODE,
  RCID_TO_RAIDCODE,
  RAIDCODE_TO_MAPKEY,
  MAPKEY_TO_SVG,
  SESSION_DIR_RE,
  SCREENSHOT_RE_STRICT,
  SCREENSHOT_RE_TOLERANT,
};
