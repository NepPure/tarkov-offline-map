'use strict';

/**
 * 圆形小地图悬浮窗：跟随玩家 + 车头朝上 + 缩放
 */
import { MapView, metersToScreen } from './common/map-view.js';

const api = window.api;

const view = new MapView(document.getElementById('mini-root'), { mini: true });
window.__view = view; // 可视化自检 / CDP 验收用（与主窗口一致）
let detail = null;
let RADIUS_M = 55;
let miniFollowMainZoom = false;

// 赛季文件刷点（版本活动找东西）：离线快照，主窗口与小地图都标出来
let seasonData = null;
const seasonReady = (async () => {
  try {
    seasonData = await (await fetch('app://data/season-documents.json')).json();
  } catch {
    seasonData = null;
  }
})();

async function getDetail(mapId) {
  const json = await (await fetch('app://data/maps-dump.json')).json();
  return json.maps.map((m) => m.detail).find((d) => d.id === mapId) || null;
}

/** 以 (x,z) 为中心时，让半径 RADIUS_M 正好铺满圆盘的缩放（小地图的"标准视野"） */
function radiusScale(x, z) {
  const w = document.getElementById('mini-root').getBoundingClientRect().width || 296;
  // RADIUS_M 米在 scale=1 时的屏幕像素 -> 让它等于圆盘半径(w/2)
  const dist = Math.max(metersToScreen(view.proj, x, z, RADIUS_M), 1e-6);
  return Math.min(60, Math.max(0.01, (w / 2) / dist));
}

function centerOnPlayer(zoomToRadius = false) {
  if (!view.player || !detail) return;
  const p = view.proj.project(view.player.x, view.player.z);
  view.view.cx = p.x;
  view.view.cy = p.y;
  if (zoomToRadius) view.view.scale = radiusScale(view.player.x, view.player.z);
  if (document.getElementById('m-rotate').classList.contains('active') && view.heading) {
    view.view.rot = ((view.heading.screenAngleDeg + 90) * Math.PI) / 180;
  } else {
    view.view.rot = 0;
  }
  view.setViewport({ cx: view.view.cx, cy: view.view.cy, scale: view.view.scale, rot: view.view.rot });
}

/**
 * 还没有玩家位置时（截图定位前）：以地图中心按"标准视野"显示，
 * 而不是缩到整张图——否则上千个标记会挤成一团浆糊（大图标下尤其明显）。
 */
function centerOnMap() {
  if (!detail || !view.proj) return;
  const px = view.getMapPixelBounds();
  const cx = px.minX + px.width / 2, cy = px.minY + px.height / 2;
  const w = view.proj.unproject(cx, cy);
  view.view.cx = cx;
  view.view.cy = cy;
  view.view.scale = radiusScale(w.x, w.z);
  view.view.rot = 0;
  view.setViewport({ cx: view.view.cx, cy: view.view.cy, scale: view.view.scale, rot: 0 });
}

async function applyState(s) {
  if (!s || !s.mapId) return;
  // 配置先落地（RADIUS_M 影响标准视野的缩放）
  if (s.config) {
    view.setMarkerToggles(s.config.markerToggles);
    view.setMarkerScale(s.config.markerScale || 1);
    view.setLabelScale(s.config.labelScale || 1);
    RADIUS_M = s.config.miniRadius || 55;
    miniFollowMainZoom = !!s.config.miniFollowMainZoom;
    api.setMiniOpacity(s.config.miniOpacity ?? 0.9);
  }
  if (!detail || detail.id !== s.mapId) {
    detail = await getDetail(s.mapId);
    if (!detail) return;
    let svgText = null;
    if (detail.svgPath) {
      const file = detail.svgPath.split('/').pop();
      try { svgText = await (await fetch(`app://data/maps/${file}`)).text(); } catch {}
    }
    await view.setMap(detail, svgText);
    // 赛季文件刷点（离线快照）：小地图上也标出来，找文件时不用切回主窗口
    await seasonReady;
    if (seasonData) view.setSeasonDocuments(seasonData, detail.id);
    // 还没定位过 -> 先给一个标准视野（地图中心 + 半径尺度），避免整图缩略时的标记糊成一团
    if (!view.player) centerOnMap();
  }
  if (s.position && s.quaternion) {
    view.rotate = document.getElementById('m-rotate').classList.contains('active');
    const wasNull = !view.player;
    view.setPlayer(s.position, s.quaternion);
    view.setTrail(s.trail);
    centerOnPlayer(wasNull);
  }
  if (s.floor) view.setFloor(s.floor);
}

api.onState((s) => applyState(s));
api.getState().then((s) => applyState(s));

// 小地图忽略主窗口的平移；仅在"缩放跟随互动地图"开启时同步缩放（默认按自身半径）
api.onViewportSync((vp) => {
  if (!view.player) return;
  if (miniFollowMainZoom) view.view.scale = vp.scale;
  centerOnPlayer(false);
});

document.getElementById('m-rotate').addEventListener('click', (e) => {
  e.currentTarget.classList.toggle('active');
  centerOnPlayer(false);
});
document.getElementById('m-zoom-in').addEventListener('click', () => {
  view.view.scale = Math.min(60, view.view.scale * 1.25);
  centerOnPlayer(false);
});
document.getElementById('m-zoom-out').addEventListener('click', () => {
  view.view.scale = Math.max(0.01, view.view.scale / 1.25);
  centerOnPlayer(false);
});
document.getElementById('m-reset').addEventListener('click', () => centerOnPlayer(true));

// ---------------------------------------------------------------------------
// 窗口拖动：圆盘任意位置（HUD 按钮除外）按下即可拖动悬浮窗位置
// 真正的移动在主进程完成（按真实光标位置 setPosition），所以指针移出小窗口
// 甚至移出屏幕都不会中断拖动；松手后位置会记忆到配置里。
// ---------------------------------------------------------------------------
let windowDragging = false;

function beginWindowDrag() {
  if (windowDragging) return;
  windowDragging = true;
  document.body.classList.add('dragging');
  api.miniDragStart();
}

function endWindowDrag() {
  if (!windowDragging) return;
  windowDragging = false;
  document.body.classList.remove('dragging');
  api.miniDragEnd();
}

document.body.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // HUD 按钮照旧点击；其余位置都是"拖窗口"的把手
  if (e.target instanceof Element && e.target.closest('.mini-hud')) return;
  e.preventDefault();
  api.miniPing();
  beginWindowDrag();
});
window.addEventListener('pointerup', endWindowDrag);
window.addEventListener('pointercancel', endWindowDrag);
window.addEventListener('blur', endWindowDrag);

// 透明悬浮窗被点击/悬停后偶发停止重绘：让主进程刷新一次
document.body.addEventListener('pointerenter', () => api.miniPing());

// 键盘兜底：小地图窗口永远不响应 Tab/空格/回车
// （主进程已设 focusable:false，这里再挡一层，避免焦点跑到四个按钮上）
window.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' || e.key === ' ' || e.key === 'Enter') e.preventDefault();
}, true);

// HUD 按钮点完立即失焦，避免焦点滞留后被空格/回车重复触发
for (const btn of document.querySelectorAll('.mini-hud button')) {
  btn.addEventListener('click', (e) => e.currentTarget.blur());
}
