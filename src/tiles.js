'use strict';

/**
 * 瓦片底图（实验室 / 迷宫 / 破冰船这类没有 SVG 的图）。
 *
 * 原站对这些图走"卫星图"路径：把瓦片金字塔拼成一张画布当底图。
 * 它的层级是**固定 zoom=3** 的（原站 uQe：zoom = min(maxZoom, max(minZoom, 3))），
 * 也就是每层只有 8×8 = 64 块 —— 所以离线只需要下这一层就够，见 tools/fetch-all.js。
 *
 * 本地布局与 CDN 保持一致，只是把主机名换成 data/tiles：
 *   https://…/assets/maps/labs_v4/1st/{z}/{x}/{y}.png
 *     -> data/tiles/labs_v4/1st/3/0/1.png
 * 渲染层按 tileDirs 里的目录名拼 app://data/tiles/<dir>/<z>/<x>/<y>.png，
 * 目录名本身只在这里算（主进程扫盘后经 listMaps 下发，两边不会各写一套规则）。
 */

const fs = require('fs');
const path = require('path');

/** 原站固定的卫星图层级 */
const SATELLITE_ZOOM = 3;

/**
 * 远端瓦片路径 -> data/tiles 下的相对目录。
 * 取 /assets/maps/ 之后、/{z} 之前的那一段，原样保留层级。
 *   例: .../assets/maps/labs_v4/1st/{z}/{x}/{y}.png -> 'labs_v4/1st'
 * 拿不到 /assets/maps/ 时退化成"去掉协议头与文件名"，保证仍能得到一个稳定目录。
 */
function tileBaseOf(tilePath) {
  const s = String(tilePath || '');
  if (!s) return null;
  const tag = '/assets/maps/';
  const i = s.indexOf(tag);
  let tail = i >= 0 ? s.slice(i + tag.length) : s.replace(/^[a-z]+:\/\/[^/]+/, '').replace(/^\/+/, '');
  const j = tail.indexOf('/{z}');
  tail = j >= 0 ? tail.slice(0, j) : tail.replace(/\/[^/]*$/, '');
  const dir = tail.replace(/^\/+|\/+$/g, '');
  return dir || null;
}

/** 某个瓦片层的本地绝对目录（不管存不存在） */
function tileLayerDir(dataRoot, tilePath) {
  const rel = tileBaseOf(tilePath);
  if (!rel) return null;
  return path.join(dataRoot, 'tiles', ...rel.split('/'));
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * 这张图本地已经下过哪些瓦片层。
 * 返回 { 远端 tilePath: '相对 data/tiles 的目录' }，一个都没有时返回 null。
 *
 * 逐个 tilePath 判断（而不是"基础层在就算有"）：少下某一层时那一层的楼层按钮
 * 干脆不出现，总好过点开一片空白。
 */
function localTileDirs(dataRoot, detail) {
  if (!detail || !detail.tilePath) return null;
  const wanted = [detail.tilePath, ...(detail.layers || []).map((l) => l.tilePath)].filter(Boolean);
  const out = {};
  for (const tp of wanted) {
    const dir = tileLayerDir(dataRoot, tp);
    if (!dir || out[tp]) continue;
    if (isDir(path.join(dir, String(SATELLITE_ZOOM)))) out[tp] = tileBaseOf(tp);
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { SATELLITE_ZOOM, tileBaseOf, tileLayerDir, localTileDirs };
