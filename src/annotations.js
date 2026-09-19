'use strict';

/**
 * 手动标注存储（画笔/路径/箭头/圆/矩形）。
 *
 * 存在 userData/annotations.json，结构：
 *   { "<mapId>": [ { kind, color, width, pts: [{x, z}, ...] }, ... ] }
 * 坐标是**世界坐标**（和截图定位同一套），所以缩放/旋转/换图都不会跑位。
 *
 * 这里只做"清洗 + 读写"：不接受非法 kind/颜色/NaN 坐标，并对数量设上限，
 * 免得一个坏文件把渲染层拖死。
 */
const fs = require('fs');

const KINDS = new Set(['pen', 'path', 'line', 'arrow', 'circle', 'rect']);
const MAX_STROKES_PER_MAP = 400;   // 每张图最多多少笔
const MAX_POINTS_PER_STROKE = 3000; // 单笔最多多少点（自由画笔会很长）
const MAX_MAPS = 200;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

let DATA = {};

function clampWidth(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 4;
  return Math.max(1, Math.min(20, Math.round(n)));
}

function sanitizePoint(p) {
  if (!p || typeof p !== 'object') return null;
  const x = Number(p.x);
  const z = Number(p.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 };
}

function sanitizeStroke(s) {
  if (!s || typeof s !== 'object') return null;
  if (!KINDS.has(s.kind)) return null;
  const pts = Array.isArray(s.pts) ? s.pts.map(sanitizePoint).filter(Boolean) : [];
  if (pts.length < 2) return null;
  return {
    kind: s.kind,
    color: COLOR_RE.test(String(s.color)) ? String(s.color).toLowerCase() : '#f87171',
    width: clampWidth(s.width),
    pts: pts.slice(0, MAX_POINTS_PER_STROKE),
  };
}

/** 清洗任意输入 -> 合法结构（导出便于单测） */
function sanitize(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let maps = 0;
  for (const [mapId, list] of Object.entries(raw)) {
    if (typeof mapId !== 'string' || !mapId) continue;
    if (maps++ >= MAX_MAPS) break;
    if (!Array.isArray(list)) continue;
    const strokes = list.map(sanitizeStroke).filter(Boolean).slice(0, MAX_STROKES_PER_MAP);
    if (strokes.length) out[mapId] = strokes;
  }
  return out;
}

function load(file) {
  try {
    DATA = sanitize(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch {
    DATA = {};
  }
  return DATA;
}

function get() {
  return DATA;
}

function set(next) {
  DATA = sanitize(next);
  return DATA;
}

function save(file) {
  try {
    fs.writeFileSync(file, JSON.stringify(DATA));
    return true;
  } catch {
    return false;
  }
}

function stats() {
  let strokes = 0;
  let points = 0;
  for (const list of Object.values(DATA)) {
    strokes += list.length;
    for (const s of list) points += s.pts.length;
  }
  return { maps: Object.keys(DATA).length, strokes, points };
}

module.exports = { load, get, set, save, sanitize, stats, KINDS, MAX_STROKES_PER_MAP, MAX_POINTS_PER_STROKE };
