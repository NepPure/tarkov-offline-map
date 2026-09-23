'use strict';

/**
 * 地图数据加载与查询
 * data/maps-dump.json 结构: { maps: [ { id, name, detail } ] }
 * detail 含: key, name, transform, coordinateRotation, bounds, svgPath, svgLayer,
 *            layers(楼层), extracts, transits, bosses, spawns, btrStops,
 *            locks, switches, hazards, lootContainers, lootLoose, stationaryWeapons, labels
 *
 * 底图有两种：早期图的 svgPath（矢量）与实验室/迷宫/破冰船的 tilePath（原站卫星图瓦片）。
 * 后者需要 data/tiles 下真的下过瓦片才算可用，见 src/tiles.js。
 *
 * 上游缺漏的点位补在 data/manual-extracts.json，加载时由 applyOverlay 合并（见下）。
 */
const fs = require('fs');
const path = require('path');
const { localTileDirs } = require('./tiles');

const OVERLAY_FILE = 'manual-extracts.json';

let DATA = null; // { maps, byId, byKey, tileDirs: Map<detailId, {...}>, manual: {applied, maps} }

/**
 * 合并人工补录点位（data/manual-extracts.json）。
 *
 * 为什么要有这个：上游（kaedeori 站台，与 tarkov.dev 同源）的地图数据本身有缺漏，
 * 典型如灯塔缺「通往军事基地的路（载具撤离点）」等 5 条撤离点（游戏内实际存在）。
 * maps-dump.json 是抓取脚本的产物、会被 `npm run fetch:data` 整体覆盖，所以补录
 * 一律放 overlay 文件，在这里合并进 detail，抓取多少次都不会丢。
 *
 * 合并规则：按 detail[id] 分图，键名即 detail 里的数组字段（extracts/transits/...）；
 * 同 id 已存在（上游后来自己补上了）则跳过，避免重复。
 *
 * @returns {{applied: number, maps: string[], skipped: number}}
 */
function applyOverlay(maps, dataRoot, file = OVERLAY_FILE) {
  const stat = { applied: 0, skipped: 0, maps: [] };
  const p = path.isAbsolute(file) ? file : path.join(dataRoot, file);
  if (!fs.existsSync(p)) return stat;
  let ov;
  try {
    ov = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('[maps-data] manual-extracts.json 解析失败，已忽略:', e.message);
    return stat;
  }
  const ovMaps = (ov && ov.maps) || {};
  for (const m of maps) {
    const detail = m.detail;
    if (!detail) continue;
    const entry = ovMaps[detail.id] || ovMaps[m.id];
    if (!entry) continue;
    for (const [key, list] of Object.entries(entry)) {
      if (key.startsWith('_') || !Array.isArray(list)) continue;
      if (!Array.isArray(detail[key])) detail[key] = [];
      const ids = new Set(detail[key].map((x) => x && x.id).filter(Boolean));
      for (const item of list) {
        if (item && item.id && ids.has(item.id)) { stat.skipped++; continue; }
        detail[key].push(item);
        if (item && item.id) ids.add(item.id);
        stat.applied++;
      }
    }
    if (!stat.maps.includes(detail.id)) stat.maps.push(detail.id);
  }
  return stat;
}

function load(dumpPath, opts = {}) {
  const raw = JSON.parse(fs.readFileSync(dumpPath, 'utf-8'));
  const maps = raw.maps;
  const dataRoot = opts.dataRoot || path.dirname(dumpPath);
  const manual = applyOverlay(maps, dataRoot, opts.overlayPath || OVERLAY_FILE);
  const byId = new Map();
  const byKey = new Map();
  const tileDirs = new Map();
  for (const m of maps) {
    const detail = m.detail;
    if (!detail) continue;
    byId.set(detail.id || m.id, detail);
    if (detail.key && !byKey.has(detail.key)) byKey.set(detail.key, detail);
    if (!byKey.has(m.id)) byKey.set(m.id, detail);
    // 本地瓦片只扫一次盘（listMaps 每次切图都会被调用，不能每次都 stat）
    const td = localTileDirs(dataRoot, detail);
    if (td) tileDirs.set(detail.id || m.id, td);
  }
  DATA = { maps, byId, byKey, tileDirs, manual };
  return DATA;
}

function get() {
  if (!DATA) throw new Error('maps data not loaded');
  return DATA;
}

function getById(id) {
  return DATA.byId.get(id) || null;
}

function getByKey(key) {
  return DATA.byKey.get(key) || null;
}

function findByName(name) {
  const n = String(name || '').toLowerCase();
  for (const m of DATA.maps) {
    const d = m.detail;
    if (!d) continue;
    if (d.name && d.name.toLowerCase() === n) return d;
    if (d.normalizedName && d.normalizedName === n) return d;
    if (d.key && d.key === n) return d;
  }
  return null;
}

/** 列出全部地图（用于下拉选择 / 小地图列表） */
function listMaps() {
  return DATA.maps
    .map((m) => m.detail)
    .filter(Boolean)
    .map((d) => {
      const tiles = DATA.tileDirs.get(d.id) || null;
      return {
        id: d.id,
        key: d.key,
        name: d.name,
        hasSvg: Boolean(d.svgPath && d.svgLayer),
        // 瓦片底图：远端 tilePath -> 本地 data/tiles 目录（渲染层直接拿去拼 app:// 地址）
        tiles,
        hasBasemap: Boolean((d.svgPath && d.svgLayer) || tiles),
      };
    });
}

/**
 * 人工补录点位（overlay）合并统计：{ applied, skipped, maps }
 * 启动时打日志用，也方便验收脚本断言。
 */
function manualStats() {
  return DATA ? DATA.manual : null;
}

module.exports = { load, get, getById, getByKey, findByName, listMaps, applyOverlay, manualStats, OVERLAY_FILE };
