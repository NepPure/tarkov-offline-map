'use strict';

/**
 * 任务数据加载（主进程侧）。
 *
 * data/quests-dump.json 由 tools/fetch-quests.js 生成（构建期快照，运行时完全离线）：
 *   { fetchedAt, source, attribution, traders[], maps{}, tasks[] }
 * 结构说明见 tools/fetch-quests.js 顶部注释。
 *
 * 渲染层的搜索/分组/筛选逻辑在 renderer/common/quest-filter.js（纯函数，可单测），
 * 这里只负责读取与基本校验，避免把纯逻辑塞进主进程。
 */
const fs = require('fs');

let DATA = null;

function load(dumpPath) {
  const raw = JSON.parse(fs.readFileSync(dumpPath, 'utf-8'));
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const traders = Array.isArray(raw.traders) ? raw.traders : [];
  DATA = {
    fetchedAt: raw.fetchedAt || null,
    source: raw.source || null,
    attribution: raw.attribution || null,
    traders,
    maps: raw.maps || {},
    tasks,
    stats: stats(tasks),
  };
  return DATA;
}

function stats(tasks) {
  let zones = 0;
  let spots = 0;
  let withZones = 0;
  let withSpots = 0;
  for (const t of tasks) {
    let z = 0;
    let s = 0;
    for (const o of t.objectives || []) {
      z += (o.zones || []).length;
      s += (o.spots || []).length;
    }
    zones += z;
    spots += s;
    if (z) withZones++;
    if (s) withSpots++;
  }
  return { tasks: tasks.length, zones, spots, withZones, withSpots };
}

function get() {
  if (!DATA) throw new Error('quests data not loaded');
  return DATA;
}

function isLoaded() {
  return Boolean(DATA);
}

/** 任务数据是否"够用"：没有任何任务时侧边栏应给出提示而不是空白 */
function summary() {
  const d = get();
  return { ...d.stats, fetchedAt: d.fetchedAt, traders: d.traders.length, maps: Object.keys(d.maps).length };
}

module.exports = { load, get, isLoaded, summary };
