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
let miniRotate = false;      // 固定地图方向（默认）；true = 随角色朝向旋转
let miniAutoCenter = true;   // 定位后自动居中到玩家
let miniAutoFloor = true;    // 按玩家高度自动切换楼层层级
let clickThrough = false;    // 点击穿透状态（来自配置）

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
  // 固定地图方向（默认）：rot 恒为 0；开启"随朝向旋转"才按朝向转
  if (miniRotate && view.heading) {
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
    miniRotate = !!s.config.miniRotate;              // 默认 false = 固定地图方向
    miniAutoCenter = s.config.miniAutoCenter !== false;
    miniAutoFloor = s.config.miniAutoFloor !== false;
    api.setMiniOpacity(s.config.miniOpacity ?? 0.9);
    setClickThrough(!!s.config.miniClickThrough);
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
    view.rotate = miniRotate;
    const wasNull = !view.player;
    view.setPlayer(s.position, s.quaternion);
    view.setTrail(s.trail);
    // 自动居中：关掉后只更新玩家点/轨迹，不再把视野拉回玩家（配合手动缩放查看周边）
    if (miniAutoCenter || wasNull) centerOnPlayer(wasNull);
  }
  // 楼层：默认按玩家高度自动切层；关掉后固定在地图基础层
  if (miniAutoFloor) view.setFloor('auto');
  else view.setFloor((detail && detail.svgLayer) || 'auto');
}

api.onState((s) => applyState(s));
api.getState().then((s) => applyState(s));

// 小地图忽略主窗口的平移；仅在"缩放跟随互动地图"开启时同步缩放（默认按自身半径）
api.onViewportSync((vp) => {
  if (!view.player) return;
  if (miniFollowMainZoom) view.view.scale = vp.scale;
  centerOnPlayer(false);
});

// ---------------------------------------------------------------------------
// 窗口拖动：圆盘任意位置按下即可拖动悬浮窗位置
// 真正的移动在主进程完成（按真实光标位置 setBounds），所以指针移出小窗口
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
  // 右下角"锁 / 解锁"小条照旧可点；点击穿透状态下不接管鼠标
  if (e.target instanceof Element && e.target.closest('#mini-lockbar')) return;
  if (clickThrough) return;
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
window.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' || e.key === ' ' || e.key === 'Enter') e.preventDefault();
}, true);

// ---------------------------------------------------------------------------
// 点击穿透（"能看到点不着"）+ 右下角"靠近才出现"的 锁 / 解锁 小按钮
//
// 未锁定：窗口正常接收鼠标，悬停就显示「锁」，点它开启穿透。
// 已锁定：窗口穿透，渲染层收不到鼠标移动（实测 Windows 上 forward:true 也不会
//   把真实鼠标移动转给渲染层），所以由主进程按光标轮询这个小条的位置判定"靠近"，
//   靠近时临时恢复交互并通知渲染层把「解锁」显示出来，点它就关掉穿透。
// ---------------------------------------------------------------------------
const lockBar = document.getElementById('mini-lockbar');
const lockBtn = document.getElementById('mini-lock');
const unlockBtn = document.getElementById('mini-unlock');

function reportLockBarRect() {
  const r = lockBar.getBoundingClientRect();
  if (r.width > 0) api.miniUnlockRect({ x: r.left, y: r.top, w: r.width, h: r.height });
}

function setClickThrough(on) {
  if (clickThrough === on) return;
  clickThrough = on;
  document.body.classList.toggle('locked', on);
  requestAnimationFrame(reportLockBarRect);
}

// 主进程判定"光标放在雷达上 / 正好在小条上"后通知：
//   near  -> 把「锁 / 解锁」显示出来（锁定时靠它，未锁定时用 CSS hover）
//   onBar -> 只在这一小块上临时恢复交互，其余区域仍然穿透（点不着）
api.onLockHot((state) => {
  const hot = typeof state === 'object' && state ? state : { near: !!state, onBar: !!state };
  document.body.classList.toggle('hot', !!hot.near);
  document.body.classList.toggle('bar-live', !!hot.onBar);
});

lockBtn.addEventListener('click', (e) => {
  e.preventDefault();
  lockBtn.blur();
  api.miniClickThrough(true); // 锁定：开启点击穿透
});

unlockBtn.addEventListener('click', (e) => {
  e.preventDefault();
  unlockBtn.blur();
  api.miniClickThrough(false); // 解锁：关闭点击穿透
});

window.addEventListener('load', () => requestAnimationFrame(reportLockBarRect));
