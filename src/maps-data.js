'use strict';

/**
 * 地图数据加载与查询
 * data/maps-dump.json 结构: { maps: [ { id, name, detail } ] }
 * detail 含: key, name, transform, coordinateRotation, bounds, svgPath, svgLayer,
 *            layers(楼层), extracts, transits, bosses, spawns, btrStops,
 *            locks, switches, hazards, lootContainers, lootLoose, stationaryWeapons, labels
 */
const fs = require('fs');
const path = require('path');

let DATA = null; // { maps, byId, byKey }

function load(dumpPath) {
  const raw = JSON.parse(fs.readFileSync(dumpPath, 'utf-8'));
  const maps = raw.maps;
  const byId = new Map();
  const byKey = new Map();
  for (const m of maps) {
    const detail = m.detail;
    if (!detail) continue;
    byId.set(detail.id || m.id, detail);
    if (detail.key && !byKey.has(detail.key)) byKey.set(detail.key, detail);
    if (!byKey.has(m.id)) byKey.set(m.id, detail);
  }
  DATA = { maps, byId, byKey };
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
    .map((d) => ({ id: d.id, key: d.key, name: d.name, hasSvg: Boolean(d.svgPath && d.svgLayer) }));
}

module.exports = { load, get, getById, getByKey, findByName, listMaps };
