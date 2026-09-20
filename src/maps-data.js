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
 */
const fs = require('fs');
const path = require('path');
const { localTileDirs } = require('./tiles');

let DATA = null; // { maps, byId, byKey, tileDirs: Map<detailId, {...}> }

function load(dumpPath, opts = {}) {
  const raw = JSON.parse(fs.readFileSync(dumpPath, 'utf-8'));
  const maps = raw.maps;
  const dataRoot = opts.dataRoot || path.dirname(dumpPath);
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
  DATA = { maps, byId, byKey, tileDirs };
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

module.exports = { load, get, getById, getByKey, findByName, listMaps };
