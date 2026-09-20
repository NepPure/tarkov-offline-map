'use strict';

/**
 * 圆形小地图悬浮窗：跟随玩家 + 车头朝上 + 缩放
 */
import { MapView, metersToScreen, panCenterAfterDrag } from './common/map-view.js';

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

// 雷达视野偏移（地图像素）：Ctrl 拖动圆盘 = 平移圆盘里的地图，而不是移动悬浮窗。
// 偏移叠加在"跟随玩家居中"之上——玩家照旧跟随，只是不再固定在圆心（相当于往某侧多看一点）。
// Ctrl + 双击 归零；换图（新一局）也会自动归零。
const panOffset = { x: 0, y: 0 };

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

/**
 * 本地瓦片底图清单（实验室/迷宫/破冰船这类没有 SVG 的图）。
 * 主进程扫盘后经 listMaps 下发；只取一次，之后换图直接查。
 */
let tileMeta = null;
async function tileDirsFor(mapId) {
  if (tileMeta === null) {
    try { tileMeta = await api.listMaps(); } catch { tileMeta = []; }
  }
  const m = tileMeta.find((x) => x.id === mapId);
  return (m && m.tiles) || null;
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
  view.view.cx = p.x + panOffset.x;
  view.view.cy = p.y + panOffset.y;
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
    panOffset.x = 0; // 换图（新一局）：上一张图的偏移没有意义，回到居中
    panOffset.y = 0;
    let svgText = null;
    if (detail.svgPath) {
      const file = detail.svgPath.split('/').pop();
      try { svgText = await (await fetch(`app://data/maps/${file}`)).text(); } catch {}
    }
    await view.setMap(detail, svgText, { tileDirs: await tileDirsFor(s.mapId) });
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
  } else if (view.player) {
    // 新一局（进图日志已清空位置）：抹掉上一局的玩家点与轨迹，视野回退到"还没定位"的状态
    view.clearPlayer();
    panOffset.x = 0;
    panOffset.y = 0;
    centerOnMap();
  }
  // 楼层：默认按玩家高度自动切层；关掉后固定在地图基础层
  // （基础层用 view.baseLayer：SVG 图是 detail.svgLayer，瓦片图是它的第一层）
  if (miniAutoFloor) view.setFloor('auto');
  else view.setFloor(view.baseLayer || (detail && detail.svgLayer) || 'auto');
  // 房间成员：雷达上也画队友（离得近的时候比主窗口更有用）
  if (s.room) {
    const myId = s.room.self ? s.room.self.id : null;
    view.setPeers(Array.isArray(s.room.peers) ? s.room.peers : []);
    view.setPeerAnnos(((s.room.annos || {})[s.mapId] || []).filter((a) => a && a.owner !== myId));
  }
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
// Ctrl + 拖动 = 拖动圆盘里面的地图（平移视野），窗口不动，见下面 beginMapPan。
// ---------------------------------------------------------------------------
let windowDragging = false;
let mapPanning = false;
let panPointerId = null;
let panStart = null; // {x, y, ox, oy, rot, scale}

function beginWindowDrag() {
  if (windowDragging) return;
  if (mapPanning) endMapPan(); // 两种手势互斥，别让上一次残留状态串味
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

/** Ctrl + 按下：开始平移"圆盘里的地图"（窗口本身不动） */
function beginMapPan(e) {
  if (mapPanning) return;
  if (windowDragging) endWindowDrag(); // 两种手势互斥
  mapPanning = true;
  panPointerId = e.pointerId;
  panStart = {
    x: e.clientX, y: e.clientY,
    cx: view.view.cx, cy: view.view.cy, // 记的是"当前视野中心"，两种居中模式下都对
    // 拖动过程中朝向可能变（随朝向旋转模式），按"按下那一刻"的角度换算，手感才稳
    rot: view.view.rot || 0,
    scale: view.view.scale || 1,
  };
  panBase = null;
  panMoved = false;
  document.body.classList.add('panning');
  api.miniPing();
  api.miniProbe({ ev: 'pan-begin', ctrl: e.ctrlKey, meta: e.metaKey, scale: panStart.scale, rot: panStart.rot });
  // 位置由主进程轮询真实光标后推送（见 main.js startMiniPan）：
  // 透明窗口上 setPointerCapture 不可靠，光标一离开 300px 圆盘事件就断，表现为"地图只动一点点"
  api.miniPanStart().then((base) => { panBase = base || null; }).catch(() => {});
}

/**
 * 把视野中心挪到 (cx,cy) 并同步"相对玩家的偏移"。
 * 自动居中开着时，偏移量保证玩家照旧跟随（只是不再固定在圆心）；
 * 自动居中关掉时，这就是一次普通的平移，视野不会被拉回去。
 */
function panToCenter(cx, cy) {
  if (view.player && detail) {
    const p = view.proj.project(view.player.x, view.player.z);
    panOffset.x = cx - p.x;
    panOffset.y = cy - p.y;
  }
  view.setViewport({ cx, cy, scale: view.view.scale, rot: view.view.rot });
}

// 主进程 12ms 轮询推送的真实光标位置（DIP，绝对坐标）：Delta 相对按下时的基准点算，
// 所以中途漏掉几条消息也不会累积误差
api.onMiniPan((p) => {
  if (!mapPanning || !panStart || !panBase || !p) return;
  const dx = p.x - panBase.x, dy = p.y - panBase.y;
  if (!panMoved) { panMoved = true; api.miniProbe({ ev: 'pan-move', dx, dy }); }
  pendingCenter = panCenterAfterDrag(panStart.cx, panStart.cy, panStart.scale, panStart.rot, dx, dy);
  scheduleCenter();
});

/** 平移/缩放这类高频路径统一走 rAF，避免每个更新都重建一遍标记 */
let centerRaf = 0;
let pendingCenter = null;
let panBase = null;   // 按下时主进程给的光标基准点
let panMoved = false; // 这一次平移是否真的动过（诊断用）
function scheduleCenter() {
  if (centerRaf) return;
  centerRaf = requestAnimationFrame(() => {
    centerRaf = 0;
    const c = pendingCenter;
    pendingCenter = null;
    if (c) panToCenter(c.cx, c.cy);
    else if (view.player) centerOnPlayer(false);
  });
}

function endMapPan(e) {
  // 不再按 pointerId 过滤：移动改由主进程推送，这里只要"松手/失焦"就收尾，
  // 免得因为 pointerId 对不上而卡在平移状态
  if (!mapPanning) return;
  mapPanning = false;
  panPointerId = null;
  panBase = null;
  document.body.classList.remove('panning');
  api.miniPanEnd();
  api.miniProbe({ ev: 'pan-end', moved: panMoved });
  panMoved = false;
  if (e && e.pointerId != null) { try { document.getElementById('mini-root').releasePointerCapture(e.pointerId); } catch {} }
}

/** 视野偏移归零（Ctrl + 双击） */
function resetPanOffset() {
  panOffset.x = 0;
  panOffset.y = 0;
  pendingCenter = null;
  api.miniProbe({ ev: 'pan-reset' });
  if (view.player) centerOnPlayer(false);
  else centerOnMap();
}

document.body.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // 右下角"锁 / 解锁"小条照旧可点；点击穿透状态下不接管鼠标
  if (e.target instanceof Element && e.target.closest('#mini-lockbar')) return;
  if (clickThrough) return;
  e.preventDefault();
  api.miniPing();
  // 诊断（写进 userData/mini.log）：渲染层看到的 ctrlKey vs Windows 的真实按键状态。
  // 实测雷达窗口（focusable:false，键盘焦点在游戏）里 ctrlKey 可能是 false，
  // 所以判定一律以"系统真实状态"为准，ctrlKey 只当快速路径。
  const localCtrl = !!(e.ctrlKey || e.metaKey);
  api.miniProbe({ ev: 'down', ctrl: e.ctrlKey, meta: e.metaKey, button: e.button, type: e.pointerType });

  const press = (isCtrl) => {
    if (isCtrl) {
      // Ctrl + 双击：视野偏移归零。
      // 注意不能靠 dblclick 事件：pointerdown 里 preventDefault 之后 Chromium 不再派发
      // 兼容鼠标事件（mousedown/click/dblclick），所以这里自己按"两次按下"判定。
      const now = performance.now();
      const isDouble = ctrlDown && now - ctrlDown.t < 450 && Math.hypot(e.clientX - ctrlDown.x, e.clientY - ctrlDown.y) < 8;
      ctrlDown = isDouble ? null : { t: now, x: e.clientX, y: e.clientY };
      if (isDouble) { resetPanOffset(); return; }
      beginMapPan(e);
    } else {
      ctrlDown = null;
      beginWindowDrag();
    }
  };

  if (localCtrl) { press(true); return; }
  // 渲染层没看到 Ctrl：向主进程确认真实按键状态（常驻助手，毫秒级）再决定，
  // 这样即使 ctrlKey 投递丢了，"按住 Ctrl 拖" 依旧能生效
  const seq = ++pressSeq;
  api.miniCtrlState()
    .then((real) => { if (seq === pressSeq) press(real === true); })
    .catch(() => { if (seq === pressSeq) press(false); });
});
let ctrlDown = null; // {t, x, y} 上一次 Ctrl 按下的位置（自己判定双击）
let pressSeq = 0;    // 松手会让未决的"这次按下"作废（点击比确认还快的情况）
// 保险：万一某个 Chromium 版本仍然派发 dblclick，这里做同样的归零（幂等）
document.body.addEventListener('dblclick', (e) => {
  if (e.target instanceof Element && e.target.closest('#mini-lockbar')) return;
  if (clickThrough) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  resetPanOffset();
});
// 松手/失焦：两边都必须收尾。
// 坑（踩过）：这里曾经只留了 endMapPan，漏掉 endWindowDrag —— 结果按一下之后
// 主进程的窗口拖动会一直跑到 15 秒超时才停，雷达跟着鼠标乱飘，后续操作全乱。
window.addEventListener('pointerup', (e) => { pressSeq++; endMapPan(e); endWindowDrag(); });
window.addEventListener('pointercancel', (e) => { pressSeq++; endMapPan(e); endWindowDrag(); });
window.addEventListener('blur', () => { pressSeq++; endMapPan(); endWindowDrag(); });

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
