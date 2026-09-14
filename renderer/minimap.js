'use strict';

/**
 * 圆形小地图悬浮窗：跟随玩家 + 车头朝上 + 缩放
 */
import { MapView } from './common/map-view.js';

const api = window.api;

const view = new MapView(document.getElementById('mini-root'), { mini: true });
let detail = null;
let RADIUS_M = 55;
let miniFollowMainZoom = false;

async function getDetail(mapId) {
  const json = await (await fetch('app://data/maps-dump.json')).json();
  return json.maps.map((m) => m.detail).find((d) => d.id === mapId) || null;
}

function centerOnPlayer(zoomToRadius = false) {
  if (!view.player || !detail) return;
  const p = view.proj.project(view.player.x, view.player.z);
  view.view.cx = p.x;
  view.view.cy = p.y;
  if (zoomToRadius) {
    const w = document.getElementById('mini-root').getBoundingClientRect().width || 296;
    const a = view.proj.project(view.player.x + RADIUS_M, view.player.z);
    const dx = Math.abs(a.x - p.x);
    if (dx > 0.0001) view.view.scale = Math.min(60, Math.max(0.01, w / (2 * dx)));
  }
  if (document.getElementById('m-rotate').classList.contains('active') && view.heading) {
    view.view.rot = ((view.heading.screenAngleDeg + 90) * Math.PI) / 180;
  } else {
    view.view.rot = 0;
  }
  view.setViewport({ cx: view.view.cx, cy: view.view.cy, scale: view.view.scale, rot: view.view.rot });
}

async function applyState(s) {
  if (!s || !s.mapId) return;
  if (!detail || detail.id !== s.mapId) {
    detail = await getDetail(s.mapId);
    if (!detail) return;
    let svgText = null;
    if (detail.svgPath) {
      const file = detail.svgPath.split('/').pop();
      try { svgText = await (await fetch(`app://data/maps/${file}`)).text(); } catch {}
    }
    await view.setMap(detail, svgText);
  }
  if (s.config) {
    view.setMarkerToggles(s.config.markerToggles);
    view.setMarkerScale(s.config.markerScale || 1);
    RADIUS_M = s.config.miniRadius || 55;
    miniFollowMainZoom = !!s.config.miniFollowMainZoom;
    api.setMiniOpacity(s.config.miniOpacity ?? 0.9);
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
