'use strict';

import { MapView, MARKER_GROUPS, makeProjection } from './common/map-view.js';
import { filterTasks, groupTasks, taskLocation, taskSummary, typeLabel, stageBucket, locationsByMap, otherMapsWithLocation } from './common/quest-filter.js';

const $ = (sel) => document.querySelector(sel);
const api = window.api;

const state = {
  maps: [],
  detail: null,
  applyState: null,
  cfg: null,
  season: null,        // 赛季文件刷点数据（data/season-documents.json）
  lastMapId: null,
  lastPosFile: null,
};

const view = new MapView($('#map-root'));
window.__view = view; // 可视化自检用

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function init() {
  state.maps = await api.listMaps();
  // 转移点文字要用"地图 id -> 中文名"（数据里 description 只写"前往"时靠它补目的地）
  const mapNames = new Map();
  for (const m of state.maps) if (m.id && m.name && !mapNames.has(m.id)) mapNames.set(m.id, m.name);
  view.setMapNames(mapNames);
  state.cfg = await api.getConfig();
  state.applyState = await api.getState();
  // 赛季文件刷点（版本活动：在地图上找赛季文件）——静态快照，离线可用
  try {
    state.season = await (await fetch('app://data/season-documents.json')).json();
  } catch (e) {
    console.warn('赛季文件数据缺失（可运行 npm run fetch:season）', e);
    state.season = null;
  }

  // 地图下拉（用 id 作 value）
  const sel = $('#map-select');
  sel.innerHTML = '<option value="">-- 选择地图 --</option>' +
    state.maps.filter((m) => m.hasSvg).map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
  sel.addEventListener('change', () => { if (sel.value) api.selectMap({ id: sel.value }); });

  // 按钮
  // 说明：所有顶栏按钮点完都主动 blur()，避免焦点留在按钮上时按空格/回车（Tab 导航后很容易发生）
  // 把开关又切一次——这正是"按一下 Tab 再点小地图，小地图就没了"的来源之一。
  const onToggle = (sel, fn) => {
    $(sel).addEventListener('click', (e) => {
      fn(e);
      e.currentTarget.blur();
    });
  };
  onToggle('#btn-follow', (e) => {
    const on = e.currentTarget.classList.toggle('active');
    view.setViewMode({ follow: on });
  });
  onToggle('#btn-rotate', (e) => {
    const on = e.currentTarget.classList.toggle('active');
    view.setViewMode({ rotate: on });
  });
  onToggle('#btn-mini', async () => {
    const visible = await api.toggleMini();
    $('#btn-mini').classList.toggle('active', visible);
  });
  onToggle('#btn-legend', (e) => {
    $('#legend-panel').classList.toggle('collapsed');
    e.currentTarget.classList.toggle('active', !$('#legend-panel').classList.contains('collapsed'));
  });
  $('#legend-close').addEventListener('click', () => {
    $('#legend-panel').classList.add('collapsed');
    $('#btn-legend').classList.remove('active');
  });
  // 窄视口（高 DPI 缩放时 CSS 视口可能只有 ~950px）默认折叠图例，保证地图可视面积
  if (window.innerWidth < 1180) {
    $('#legend-panel').classList.add('collapsed');
    $('#btn-legend').classList.remove('active');
  }
  $('#legend-all').addEventListener('click', () => setAllToggles(true));
  $('#legend-none').addEventListener('click', () => setAllToggles(false));
  $('#btn-import').addEventListener('click', async () => {
    const res = await api.pickScreenshot();
    if (res && res.error) alert(res.error);
  });
  $('#btn-settings').addEventListener('click', openSettings);

  // 尺子测距
  onToggle('#btn-measure', (e) => {
    const on = e.currentTarget.classList.toggle('active');
    view.setMeasureMode(on);
    $('#measure-tip').classList.toggle('hidden', !on);
  });
  // 图钉化主窗口
  onToggle('#btn-pin', async (e) => {
    const pinned = await api.togglePin();
    e.currentTarget.classList.toggle('active', pinned);
  });
  // 标记点击 -> 信息卡片
  view.onMarkerClick = (m) => showInfoCard(m);
  // 点地图上的任务区域中心点/刷新点 -> 任务详情卡
  view.onQuestClick = (item, zone) => showQuestCard(item, zone);
  bindShotViewer();
  initQuests();
  initAnnos();

  // 应用初始配置到视图
  view.setMarkerToggles(state.cfg.markerToggles);
  view.setShowAllHeights(state.cfg.showAllMarkers !== false);
  view.setViewMode({ follow: state.cfg.autoCenter !== false });
  view.setMarkerScale(state.cfg.markerScale || 1);
  view.setLabelScale(state.cfg.labelScale || 1);
  $('#btn-follow').classList.toggle('active', state.cfg.autoCenter !== false);
  applyAutoZoom(state.cfg.autoZoom !== false);

  // 视口变化 -> 同步小地图
  view.onViewChange = (viewport) => api.syncViewport(viewport);
  view.onPlayerSettled = onPlayerSettled;

  // 主进程状态推送
  api.onState((s) => applyMainState(s));
  await applyMainState(state.applyState);
}

function setAllToggles(on) {
  const toggles = {};
  for (const key of Object.keys(MARKER_GROUPS)) toggles[key] = on;
  // 也要覆盖"别的图上出现过、当前图例里没有"的组（例如 reserve 的银行保险箱、
  // 其它赛季文件类型）：否则全关之后切到那张图，这些组仍然是开着的。
  for (const key of Object.keys(view.markerToggles || {})) toggles[key] = on;
  for (const gid of view.allGroupIds()) toggles[gid] = on;
  api.setConfig({ markerToggles: toggles });
  view.setMarkerToggles(toggles);
  renderLegend();
}

// ---------------------------------------------------------------------------
// 图例面板：按大类分组，每组一个"批量显示/隐藏"的组开关（三态：全开/部分/全关）
// 组头左侧的小三角可折叠该组（面板很长时很方便），折叠状态在重绘后保持
// ---------------------------------------------------------------------------
const collapsedLegendGroups = new Set();

function renderLegend() {
  const body = $('#legend-body');
  const legend = view.getLegend ? view.getLegend() : [];
  body.innerHTML = '';
  for (const group of legend) {
    const sec = document.createElement('div');
    sec.className = 'legend-section';

    const head = document.createElement('label');
    head.className = 'legend-group';
    head.innerHTML = `
      <span class="legend-caret"></span>
      <input type="checkbox" class="legend-group-box" />
      <span class="legend-group-name"></span>
      <span class="legend-count"></span>`;
    head.querySelector('.legend-group-name').textContent = group.label;
    const box = head.querySelector('input');
    const caret = head.querySelector('.legend-caret');
    const countEl = head.querySelector('.legend-count');
    const isCollapsed = () => collapsedLegendGroups.has(group.id);
    const paintCaret = () => { caret.textContent = isCollapsed() ? '▸' : '▾'; };
    caret.title = '折叠 / 展开本组';
    caret.addEventListener('click', (e) => {
      e.preventDefault(); // 阻止 label 把点击转成勾选框
      e.stopPropagation();
      if (isCollapsed()) collapsedLegendGroups.delete(group.id);
      else collapsedLegendGroups.add(group.id);
      sec.classList.toggle('collapsed', isCollapsed());
      paintCaret();
    });
    const syncHead = () => {
      const on = group.items.filter((it) => view.markerToggles[it.id] !== false).length;
      box.checked = on === group.items.length;
      box.indeterminate = on > 0 && on < group.items.length;
      countEl.textContent = `${on}/${group.items.length}`;
      sec.classList.toggle('all-off', on === 0);
    };
    syncHead();
    paintCaret();
    sec.classList.toggle('collapsed', isCollapsed());
    box.addEventListener('change', () => {
      const toggles = {};
      for (const it of group.items) toggles[it.id] = box.checked;
      api.setConfig({ markerToggles: toggles });
      view.setMarkerToggles(toggles);
      renderLegend();
    });
    sec.appendChild(head);

    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'legend-items';
    for (const it of group.items) {
      const row = document.createElement('label');
      row.className = 'legend-item';
      const checked = view.markerToggles[it.id] !== false;
      // 图例图标 = 该组在地图上实际会出现的图标（最多 3 个），这样"地图上看到的图标图例里一定有"
      const iconList = (it.icons && it.icons.length ? it.icons : it.icon ? [it.icon] : []).slice(0, 3);
      const iconHtml = it.swatch
        ? legendSwatch(it.swatch, it.color)
        : iconList.length
          ? `<span class="legend-icons">${iconList.map((f) => `<img class="legend-icon" src="app://data/icons/${f}" alt="">`).join('')}</span>`
          : it.id === 'label'
            ? '<span class="legend-glyph" title="地图上的地名文字">Aa</span>'
            : `<span class="legend-dot" style="background:${it.color}"></span>`;
      row.innerHTML = `
        <input type="checkbox" ${checked ? 'checked' : ''} data-group="${it.id}">
        ${iconHtml}
        <span class="legend-name" title="${it.label}">${it.label}</span>
        <span class="legend-count">${it.count}</span>`;
      row.querySelector('input').addEventListener('change', (e) => {
        const gid = e.target.dataset.group;
        const toggles = {};
        toggles[gid] = e.target.checked;
        api.setConfig({ markerToggles: toggles });
        view.setMarkerToggles(toggles);
        syncHead(); // 只更新组头状态，不重建面板（避免滚动位置跳动）
      });
      itemsWrap.appendChild(row);
    }
    sec.appendChild(itemsWrap);
    body.appendChild(sec);
  }
}

// ---------------------------------------------------------------------------
// 高级设置对话框
// ---------------------------------------------------------------------------
function openSettings() {
  const c = state.cfg;
  $('#set-logs').value = c.logsPath || '';
  $('#set-shots').value = c.screenshotsPath || '';
  $('#set-auto-zoom').checked = c.autoZoom !== false;
  $('#set-auto-center').checked = c.autoCenter !== false;
  $('#set-all-markers').checked = c.showAllMarkers !== false;
  $('#set-auto-floor').checked = c.autoFloor !== false;
  $('#set-sound').checked = c.sound !== false;
  $('#set-auto-delete').checked = !!c.autoDeleteScreenshots;
  $('#set-mini').checked = !!c.miniVisible;
  $('#set-map-opacity').value = c.mapOpacity ?? 1;
  $('#set-mini-opacity').value = c.miniOpacity ?? 0.9;
  $('#set-mini-radius').value = c.miniRadius ?? 55;
  $('#set-mini-rotate').checked = !!c.miniRotate;
  $('#set-mini-auto-center').checked = c.miniAutoCenter !== false;
  $('#set-mini-auto-floor').checked = c.miniAutoFloor !== false;
  $('#set-mini-click-through').checked = !!c.miniClickThrough;
  $('#set-mini-follow').checked = !!c.miniFollowMainZoom;
  $('#set-marker-scale').value = c.markerScale ?? 1;
  $('#set-label-scale').value = c.labelScale ?? 1;
  $('#set-quest-opacity').value = quest.ui.opacity;
  $('#set-quest-auto-open').checked = quest.ui.autoOpen !== false;
  $('#settings-dialog').showModal();
}

async function saveSettings() {
  const patch = {
    logsPath: $('#set-logs').value.trim(),
    screenshotsPath: $('#set-shots').value.trim(),
    autoZoom: $('#set-auto-zoom').checked,
    autoCenter: $('#set-auto-center').checked,
    showAllMarkers: $('#set-all-markers').checked,
    autoFloor: $('#set-auto-floor').checked,
    sound: $('#set-sound').checked,
    autoDeleteScreenshots: $('#set-auto-delete').checked,
    miniVisible: $('#set-mini').checked,
    mapOpacity: Number($('#set-map-opacity').value),
    miniOpacity: Number($('#set-mini-opacity').value),
    miniRadius: Number($('#set-mini-radius').value),
    miniFollowMainZoom: $('#set-mini-follow').checked,
    miniRotate: $('#set-mini-rotate').checked,
    miniAutoCenter: $('#set-mini-auto-center').checked,
    miniAutoFloor: $('#set-mini-auto-floor').checked,
    miniClickThrough: $('#set-mini-click-through').checked,
    markerScale: Number($('#set-marker-scale').value),
    labelScale: Number($('#set-label-scale').value),
  };
  state.cfg = { ...state.cfg, ...patch };
  await api.setConfig(patch);

  // 应用到视图
  view.setShowAllHeights(patch.showAllMarkers);
  view.setViewMode({ follow: patch.autoCenter });
  applyAutoZoom(patch.autoZoom);
  view.setMapOpacity(patch.mapOpacity);
  view.setMarkerScale(patch.markerScale);
  view.setLabelScale(patch.labelScale);
  $('#btn-mini').classList.toggle('active', patch.miniVisible);

  // 任务标记
  quest.ui.opacity = Number($('#set-quest-opacity').value) || 0.18;
  quest.ui.autoOpen = $('#set-quest-auto-open').checked;
  view.setQuestOpacity(quest.ui.opacity);
  saveQuestCfg();
}

// ---------------------------------------------------------------------------
// 状态应用
// ---------------------------------------------------------------------------
let autoZoom = true;

function applyAutoZoom(v) { autoZoom = v !== false; }

async function applyMainState(s) {
  if (!s) return;
  const wantedId = s.mapId;

  // 1) 地图切换
  if (wantedId && (!state.detail || state.detail.id !== wantedId)) {
    try {
      const entry = state.maps.find((m) => m.id === wantedId) || null;
      const resolved = await loadMapDetail(entry, s.mapKey);
      if (resolved) {
        state.detail = resolved;
        $('#empty-hint').classList.remove('show');
        const sel = $('#map-select');
        if (sel.value !== entry?.id) sel.value = entry?.id || '';
        renderFloorButtons(resolved);
        renderLegend();
        if (state.cfg.sound !== false) beep('map');
      }
    } catch (e) { console.error('map load failed', e); }
  } else if (!wantedId && state.maps.length) {
    $('#empty-hint').classList.add('show');
  }

  // 2) 玩家位置（切图期间也能更新）
  if (s.position && s.quaternion) {
    const prev = view.player;
    const isNewPos = !prev || Math.abs(prev.x - s.position.x) > 0.001 || Math.abs(prev.z - s.position.z) > 0.001;
    view.setPlayer(s.position, s.quaternion);
    view.setTrail(s.trail);
    // 最近撤离点指引（迷路核心）
    const near = view.highlightNearestExtract(s.position.x, s.position.z);
    $('#st-exfil').textContent = near ? `最近撤离: ${near.label} · ${Math.round(near.meters)}米` : '最近撤离: -';
    if (isNewPos && autoZoom) {
      // 定位自动缩放：以玩家为中心显示约 130m 跨度
      const proj = view.getProjection();
      if (proj) {
        const p = proj.project(s.position.x, s.position.z);
        const probe = proj.project(s.position.x + 65, s.position.z);
        const probeZ = proj.project(s.position.x, s.position.z + 65);
        const perMeterX = Math.hypot(probe.x - p.x, probe.y - p.y) / 65;
        const perMeterZ = Math.hypot(probeZ.x - p.x, probeZ.y - p.y) / 65 || perMeterX;
        const perMeter = Math.max(perMeterX, perMeterZ);
        const w = $('#map-root').getBoundingClientRect().width || 1200;
        if (perMeter > 0.0001) {
          view.view.scale = Math.min(60, Math.max(0.01, (w / 130) / perMeter));
          view.setViewport({ ...view.getViewport() });
        }
      }
    }
    if (state.cfg.sound !== false) beep('pos');
  } else if (view.player) {
    // 新一局（进图日志清空了位置）：抹掉上一局的玩家点与轨迹，撤离指引也复位
    view.clearPlayer();
    $('#st-exfil').textContent = '最近撤离: -';
  }

  // 3) 楼层
  if (s.floor && state.cfg.autoFloor !== false) view.setFloor(s.floor);

  // 4) 状态栏
  if (state.detail) {
    $('#st-map').textContent = `地图: ${state.detail.name}`;
    $('#st-source').textContent = `识别: ${s.lastMapSource === 'logs' ? '游戏日志' : s.lastMapSource === 'manual' ? '手动' : '-'}`;
    const bosses = (state.detail.bosses || []).slice(0, 3).map((b) => `${b.boss?.name}${b.spawnChance ? ` ${Math.round(b.spawnChance * 100)}%` : ''}`).join(' / ');
    $('#st-boss').textContent = bosses ? `Boss: ${bosses}` : 'Boss: -';
  }
  const lw = s.logWatcherStatus, sw = s.shotWatcherStatus;
  const logEl = $('#st-log'), shotEl = $('#st-shot');
  if (lw) {
    logEl.textContent = `日志: ${lw.state === 'watching' ? (lw.session || '监听中') : lw.state}`;
    logEl.className = lw.state === 'watching' ? 'ok' : 'bad';
  }
  if (sw) {
    shotEl.textContent = `截图: ${sw.state === 'watching' ? '监听中' : sw.state}`;
    shotEl.className = sw.state === 'watching' ? 'ok' : 'err';
  }

  // 5) 小地图雷达真实状态（进程侧的健康检查结果），避免"按钮显示开着但其实窗口已经没了"
  if (s.miniStatus) {
    const ms = s.miniStatus;
    const running = ms.enabled && ms.alive && ms.visible && !ms.crashed;
    const btn = $('#btn-mini');
    btn.classList.toggle('active', !!ms.enabled);
    btn.title = ms.enabled
      ? (running ? '小地图雷达运行中（点击关闭）' : '小地图雷达异常，点击恢复')
      : '显示/隐藏圆形小地图';
    if (ms.enabled && !running) {
      btn.classList.add('warn');
      console.warn('[mini] 状态异常，主进程看门狗会自动重建：', JSON.stringify(ms));
    } else {
      btn.classList.remove('warn');
    }
  }

  // 6) 地图变了 -> 任务侧边栏跟着切到"本图"（勾选状态与跨图保留无关，不动）
  const mapId = state.detail ? state.detail.id : null;
  if (mapId !== quest.lastMapId) refreshQuests({ autoOpen: true });
}

function onPlayerSettled(pos, heading) {
  $('#st-pos').textContent = pos ? `位置: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}` : '位置: -';
  $('#st-heading').textContent = heading ? `朝向: ${Math.round(heading.yawDeg)}°` : '朝向: -';
  $('#st-floor').textContent = `楼层: ${view.floor === 'auto' ? '自动' : view.floor}`;
}

async function loadMapDetail(entry, mapKey) {
  try {
    const json = await (await fetch('app://data/maps-dump.json')).json();
    const detail = json.maps.map((m) => m.detail).find((d) => d.id === entry?.id)
      || json.maps.map((m) => m.detail).find((d) => d.key === mapKey);
    if (!detail) { $('#empty-hint').classList.add('show'); return null; }
    let svgText = null;
    if (detail.svgPath) {
      const file = detail.svgPath.split('/').pop();
      try { svgText = await (await fetch(`app://data/maps/${file}`)).text(); } catch (e) { console.warn('SVG 缺失', file, e); }
    }
    await view.setMap(detail, svgText);
    // 赛季文件刷点按当前地图 id 注入（无刷点的地图自动为空）
    view.setSeasonDocuments(state.season, detail.id);
    // 手动标注也按地图分开注入（换图不会串味）
    view.setAnnotations(anno.store[detail.id] || []);
    return detail;
  } catch (e) {
    console.error('loadMapDetail failed', e);
    return null;
  }
}

function renderFloorButtons(detail) {
  const wrap = $('#floor-buttons');
  const SHORT = {
    '2nd Floor': '2F', '3rd Floor': '3F', '4th Floor': '4F', '5th Floor': '5F',
    '1st Floor': '1F', Basement: '地下', Underground: '地下', Tunnels: '隧道',
    Garage: '车库', 'Second Level': '2层', Technical: '技术层',
  };
  const layers = [{ name: '一层', svgLayer: detail.svgLayer, extents: [] }, ...(detail.layers || [])];
  wrap.innerHTML = '';
  for (const [idx, l] of layers.entries()) {
    const btn = document.createElement('button');
    btn.textContent = idx === 0 ? '一层' : (SHORT[l.name] || l.name);
    btn.title = l.name;
    btn.dataset.layer = l.svgLayer || l.name;
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      view.setFloor(btn.dataset.layer);
    });
    wrap.appendChild(btn);
  }
  if (detail.layers?.length) {
    const auto = document.createElement('button');
    auto.textContent = '自动';
    auto.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      view.setFloor('auto');
    });
    wrap.appendChild(auto);
  }
  const floor = state.applyState?.floor;
  if (!floor || floor === 'auto' || floor === detail.svgLayer) wrap.querySelector('button')?.classList.add('active');
}

// ---------------------------------------------------------------------------
// 标记信息卡片
// ---------------------------------------------------------------------------
function showInfoCard(m) {
  const card = $('#info-card');
  const pos = view.player;
  const dist = pos ? Math.hypot(m.x - pos.x, m.z - pos.z) : null;
  let extra = '';
  if (m.seasonType) {
    const shot = m.seasonImageLocal
      ? `<div class="ref-shot-wrap">
           <img class="ref-shot" id="ref-shot" src="app://data/${m.seasonImageLocal}" alt="位置参考截图">
           <div class="ref-shot-hint">位置参考截图 · 点击可放大查看（滚轮缩放/拖动平移）</div>
         </div>`
      : '';
    extra = `
      <div class="row"><b>赛季文件</b> · ${escapeHtml(m.seasonType.name)}</div>
      <div class="row">位置编号: ${escapeHtml(String(m.uuid || '').slice(0, 8) || '-')}</div>
      ${m.seasonType.description ? `<div class="row desc">${escapeHtml(m.seasonType.description).replace(/\n/g, '<br>')}</div>` : ''}
      ${shot}`;
  }
  card.innerHTML = `
    <button class="close" id="info-close">×</button>
    <h4>${escapeHtml(m.shortLabel || m.label)}</h4>
    <div class="row">类型: ${groupLabel(m.group)}</div>
    <div class="row">坐标: ${m.x.toFixed(1)}, ${m.y ? m.y.toFixed(1) : '-'}, ${m.z.toFixed(1)}</div>
    ${dist != null ? `<div class="row">距你: ${dist.toFixed(0)} 米</div>` : ''}
    ${extra}
    <div class="row">${escapeHtml(m.label)}</div>`;
  card.classList.remove('hidden');
  card.querySelector('#info-close').addEventListener('click', () => card.classList.add('hidden'));
  const shotEl = card.querySelector('#ref-shot');
  if (shotEl) {
    shotEl.addEventListener('click', () => openShotViewer(m.seasonImageLocal, `${m.seasonType?.name || '赛季文件'} · ${m.x.toFixed(1)}, ${m.y.toFixed(1)}, ${m.z.toFixed(1)}`));
  }
}

// ---------------------------------------------------------------------------
// 任务标记详情卡（类似赛季文件那张卡：点地图上的任务区域/刷新点就能看）
// ---------------------------------------------------------------------------
/** 地图 id -> 中文名（任务行/提示里显示"位置在森林"用） */
function mapNameOf(mapId) {
  const m = quest.dump && quest.dump.maps && quest.dump.maps[mapId];
  return (m && m.name) || '未知地图';
}

function questItemName(id) {
  if (!id) return '';
  const n = quest.dump && quest.dump.items && quest.dump.items[id];
  // 约 13% 的物品是任务专用、连公开物品表里都没有名字，这时给个短 id 便于自己查
  return n || `未收录物品(${String(id).slice(0, 6)}…)`;
}

/** 点地图上的任务点 -> 详情卡 */
function showQuestCard(item, zone) {
  const card = $('#info-card');
  const task = quest.dump && quest.dump.tasks.find((t) => t.id === item.id);
  if (!task) return;
  const trader = quest.tradersById.get(task.trader);
  // zone/spot 都是 dump 里的同一个对象，用引用相等找回它属于哪个目标
  const obj = (task.objectives || []).find((o) => [...(o.zones || []), ...(o.spots || [])].includes(zone)) || (task.objectives || [])[0] || null;
  const isSpot = Boolean(obj && (obj.spots || []).includes(zone));

  const st = stageBucket(task.stage);
  const rows = [];
  rows.push(`<div class="row">${escapeHtml(trader ? `${trader.name}${trader.nickname ? ` · ${trader.nickname}` : ''}` : '未知商人')} · Lv${task.level || 0} · ${st.label}${task.stage ? `（前置链 ${task.stage}）` : ''}${task.kappa ? ' · <b>Kappa</b>' : ''}${task.lightkeeper ? ' · <b>灯塔</b>' : ''}</div>`);
  if (obj) {
    rows.push(`<div class="row">${isSpot ? '刷新点' : '区域'}属于目标: <b>${escapeHtml(typeLabel(obj.type))}</b>${obj.optional ? '（可选）' : ''} ${escapeHtml(obj.text || '')}${obj.count > 1 ? ` ×${obj.count}` : ''}</div>`);
  }
  if (zone) {
    const y = Number.isFinite(zone.y) ? zone.y : 0;
    const floor = zone.top != null && zone.bottom != null ? ` · 高度 ${zone.bottom.toFixed(1)}~${zone.top.toFixed(1)}m` : '';
    rows.push(`<div class="row">坐标: ${zone.x.toFixed(1)}, ${y.toFixed(1)}, ${zone.z.toFixed(1)}${floor}</div>`);
    const me = view.player;
    if (me) rows.push(`<div class="row">距你: ${Math.hypot(zone.x - me.x, zone.z - me.z).toFixed(0)} 米</div>`);
  }
  if (obj && obj.item) rows.push(`<div class="row">任务物品: ${escapeHtml(questItemName(obj.item))}</div>`);
  const keys = [];
  for (const grp of (obj && obj.requiredKeys) || []) for (const k of grp || []) keys.push(questItemName(k));
  if (keys.length) rows.push(`<div class="row">需要钥匙: ${escapeHtml(keys.join('、'))}</div>`);
  if (obj && obj.itemIds && obj.itemIds.length) {
    const names = obj.itemIds.slice(0, 6).map((i) => questItemName(i));
    rows.push(`<div class="row desc">可交/可拾取（共 ${obj.itemTotal || obj.itemIds.length} 件）: ${escapeHtml(names.join('、'))}${(obj.itemTotal || obj.itemIds.length) > 6 ? ' 等' : ''}</div>`);
  }
  const reqNames = (task.requires || []).map((id) => {
    const t = quest.dump.tasks.find((x) => x.id === id);
    return t ? t.name : null;
  }).filter(Boolean);
  if (reqNames.length) rows.push(`<div class="row">前置任务: ${escapeHtml(reqNames.slice(0, 4).join('、'))}${reqNames.length > 4 ? ' 等' : ''}</div>`);

  card.innerHTML = `
    <button class="close" id="info-close">×</button>
    <h4>${escapeHtml(task.name)}</h4>
    ${rows.join('\n')}
    <div class="info-actions">
      ${zone ? '<button id="qc-goto">定位到这里</button>' : ''}
      <button id="qc-side">在侧边栏展开</button>
      ${task.wiki ? '<button id="qc-wiki">打开 Wiki</button>' : ''}
      <button id="qc-check">${quest.checked.has(task.id) ? '取消勾选' : '勾选此任务'}</button>
    </div>
    <div class="row muted">任务数据来自 tarkov.dev 离线快照${quest.dump.fetchedAt ? `（${String(quest.dump.fetchedAt).slice(0, 10)}）` : ''}${task.wiki ? '' : ' · 无 wiki 链接'}</div>`;
  card.classList.remove('hidden');

  card.querySelector('#info-close').addEventListener('click', () => card.classList.add('hidden'));
  const goto = card.querySelector('#qc-goto');
  if (goto) goto.addEventListener('click', () => focusWorld(zone.x, zone.z));
  card.querySelector('#qc-side').addEventListener('click', () => focusQuest(task.id));
  const wiki = card.querySelector('#qc-wiki');
  if (wiki) wiki.addEventListener('click', () => api.openExternal(task.wiki));
  card.querySelector('#qc-check').addEventListener('click', () => {
    if (quest.checked.has(task.id)) quest.checked.delete(task.id);
    else quest.checked.add(task.id);
    refreshQuests();
    saveQuestCfg();
    card.classList.add('hidden');
  });
}

// ---------------------------------------------------------------------------
// 参考截图查看器：滚轮缩放 + 拖动平移，点击空白或 Esc 关闭
// ---------------------------------------------------------------------------
const shotViewer = {
  scale: 1, tx: 0, ty: 0, dragging: false,
};
function openShotViewer(relPath, caption) {
  if (!relPath) return;
  const wrap = $('#shot-viewer');
  const img = $('#shot-viewer-img');
  shotViewer.scale = 1; shotViewer.tx = 0; shotViewer.ty = 0;
  img.src = `app://data/${relPath}`;
  img.style.transform = 'translate(0px, 0px) scale(1)';
  $('#shot-viewer-caption').textContent = caption || '';
  wrap.classList.remove('hidden');
}
function closeShotViewer() {
  $('#shot-viewer').classList.add('hidden');
  $('#shot-viewer-img').removeAttribute('src');
}
function bindShotViewer() {
  const wrap = $('#shot-viewer');
  const img = $('#shot-viewer-img');
  const apply = () => { img.style.transform = `translate(${shotViewer.tx}px, ${shotViewer.ty}px) scale(${shotViewer.scale})`; };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeShotViewer(); });
  $('#shot-viewer-close').addEventListener('click', closeShotViewer);
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    shotViewer.scale = Math.max(0.4, Math.min(8, shotViewer.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    apply();
  }, { passive: false });
  let sx = 0, sy = 0, stx = 0, sty = 0;
  img.addEventListener('mousedown', (e) => {
    e.preventDefault();
    shotViewer.dragging = true; sx = e.clientX; sy = e.clientY; stx = shotViewer.tx; sty = shotViewer.ty;
    img.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!shotViewer.dragging) return;
    shotViewer.tx = stx + (e.clientX - sx);
    shotViewer.ty = sty + (e.clientY - sy);
    apply();
  });
  window.addEventListener('mouseup', () => { shotViewer.dragging = false; img.classList.remove('dragging'); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#shot-viewer').classList.contains('hidden')) { e.stopPropagation(); closeShotViewer(); }
  }, true);
  $('#shot-viewer').addEventListener('dblclick', () => { shotViewer.scale = 1; shotViewer.tx = 0; shotViewer.ty = 0; apply(); });
}

function groupLabel(group) {
  const map = {
    extract_pmc: 'PMC撤离点', extract_scav: 'Scav撤离点', extract_shared: 'PMC·Scav共享',
    transit: '马拉松转移点', boss: 'Boss', spawn: '出生点', lock: '钥匙锁',
    switch: '开关', hazard: '危险', weapon: '固定武器', loose: '散落物资',
    btrStop: 'BTR站点', label: '地名',
  };
  if (group && group.startsWith('loot:')) return '物资箱';
  if (group && group.startsWith('season:')) return '赛季文件刷点';
  return map[group] || group;
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// 提示音（Web Audio，无外部资源）
// ---------------------------------------------------------------------------
let audioCtx = null;
function beep(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const notes = kind === 'map' ? [660, 880] : [880];
    notes.forEach((freq, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.06, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.1);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.1);
    });
  } catch {}
}

// 设置面板保存
$('#settings-ok').addEventListener('click', () => saveSettings());

/** 图例里没有现成素材的类别（任务区域/刷新点/玩家/轨迹/标注）用内联小图 */
function legendSwatch(kind, color) {
  const c = color || '#f59e0b';
  if (kind === 'zone') return `<svg class="legend-swatch" viewBox="0 0 20 20"><rect x="3" y="5" width="14" height="10" rx="1" fill="${c}" fill-opacity="0.25" stroke="${c}" stroke-width="1.6"/></svg>`;
  if (kind === 'spot') return `<svg class="legend-swatch" viewBox="0 0 20 20"><circle cx="10" cy="10" r="5.5" fill="${c}" fill-opacity="0.18" stroke="${c}" stroke-width="1.6" stroke-dasharray="3 2"/></svg>`;
  if (kind === 'player') return `<svg class="legend-swatch" viewBox="0 0 20 20"><circle cx="10" cy="10" r="6" fill="${c}" fill-opacity="0.25"/><path d="M16.5 10 L5.5 5.2 L8.4 10 L5.5 14.8 Z" fill="${c}" stroke="#0b0e13" stroke-width="1"/></svg>`;
  if (kind === 'trail') return `<svg class="legend-swatch" viewBox="0 0 20 20"><polyline points="2.5,14.5 7.5,7 12.5,11.5 17.5,4.5" fill="none" stroke="${c}" stroke-width="2.2" opacity="0.85"/></svg>`;
  if (kind === 'pen') return `<svg class="legend-swatch" viewBox="0 0 20 20"><path d="M3 15 C6.5 6, 11.5 16.5, 17 5.5" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/></svg>`;
  return '';
}

// ---------------------------------------------------------------------------
// 手动标注（画笔 / 路径 / 箭头 / 圆 / 矩形；按地图分开存）
// ---------------------------------------------------------------------------
const ANNO_COLORS = ['#f87171', '#fbbf24', '#4ade80', '#38bdf8', '#c084fc', '#ffffff'];
const ANNO_DEFAULT = { tool: 'pen', color: '#f87171', width: 4 };
const ANNO_HINTS = {
  pen: '画笔：按住左键拖动即可画，松开完成',
  path: '路径：逐点点击，双击或回车结束（规划路线用）',
  line: '直线：按住左键从起点拖到终点',
  arrow: '箭头：按住左键从起点拖到终点',
  circle: '圆：从圆心按住往外拖',
  rect: '矩形：按住左键拖出对角',
  erase: '橡皮：点一下要删掉的那一笔',
};
const anno = {
  store: {},                 // { mapId: [stroke] }（世界坐标）
  active: false,
  style: { ...ANNO_DEFAULT },
  saveTimer: null,
};
window.__anno = anno; // 可视化自检用（tools/verify-annotations.js）

function currentAnnos() {
  const id = currentMapId();
  return id ? anno.store[id] || [] : [];
}

async function initAnnos() {
  try {
    anno.store = (await api.getAnnotations()) || {};
  } catch (e) {
    console.warn('标注数据读取失败（不影响使用）', e);
    anno.store = {};
  }

  $('#anno-colors').innerHTML = ANNO_COLORS
    .map((c, i) => `<button class="anno-color${i === 0 ? ' active' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`)
    .join('');

  $('#btn-anno').addEventListener('click', (e) => {
    view.setDrawMode(anno.active ? null : { ...anno.style });
    e.currentTarget.blur();
  });
  $('#anno-exit').addEventListener('click', () => view.setDrawMode(null));
  $('#anno-undo').addEventListener('click', () => { view.undoAnno(); renderLegend(); });
  $('#anno-clear').addEventListener('click', () => {
    const n = currentAnnos().length;
    if (!n) return;
    if (!confirm(`清空本图 ${n} 笔标注？（其它地图的标注不受影响）`)) return;
    view.clearAnnos();
    renderLegend();
  });
  for (const btn of document.querySelectorAll('.anno-tool')) {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      anno.style.tool = tool;
      document.querySelectorAll('.anno-tool').forEach((b) => b.classList.toggle('active', b === btn));
      if (!anno.active) view.setDrawMode({ ...anno.style });
      else view.setDrawMode({ ...anno.style });
      btn.blur();
    });
  }
  for (const btn of document.querySelectorAll('#anno-widths button')) {
    btn.addEventListener('click', () => {
      anno.style.width = Number(btn.dataset.width) || 4;
      document.querySelectorAll('#anno-widths button').forEach((b) => b.classList.toggle('active', b === btn));
      view.setAnnoStyle({ width: anno.style.width });
      btn.blur();
    });
  }
  for (const btn of document.querySelectorAll('.anno-color')) {
    btn.addEventListener('click', () => {
      anno.style.color = btn.dataset.color;
      document.querySelectorAll('.anno-color').forEach((b) => b.classList.toggle('active', b === btn));
      view.setAnnoStyle({ color: anno.style.color });
      btn.blur();
    });
  }

  // 标注变化 -> 记到当前地图 + 防抖落盘；顺手更新图例里的笔数
  view.onAnnoChange = (list) => {
    const id = currentMapId();
    if (id) anno.store[id] = list;
    scheduleAnnoSave();
    renderLegend();
  };
  view.onDrawModeChange = (mode) => {
    anno.active = Boolean(mode);
    $('#btn-anno').classList.toggle('active', anno.active);
    $('#anno-bar').classList.toggle('hidden', !anno.active);
    if (mode) {
      anno.style = { tool: mode.tool, color: mode.color, width: mode.width };
      $('#anno-hint').textContent = ANNO_HINTS[mode.tool] || '';
      document.querySelectorAll('.anno-tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === mode.tool));
      document.querySelectorAll('#anno-widths button').forEach((b) => b.classList.toggle('active', Number(b.dataset.width) === mode.width));
      document.querySelectorAll('.anno-color').forEach((b) => b.classList.toggle('active', b.dataset.color === mode.color));
    }
  };

  // Ctrl+Z 撤销、回车结束路径（只在标注模式下）
  window.addEventListener('keydown', (e) => {
    if (!anno.active) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'z') {
      e.preventDefault();
      view.undoAnno();
      renderLegend();
    } else if (e.key === 'Enter') {
      view.finishPath();
    }
  });
}

function scheduleAnnoSave() {
  clearTimeout(anno.saveTimer);
  anno.saveTimer = setTimeout(() => {
    api.setAnnotations(anno.store).catch(() => {});
  }, 600);
}

// ---------------------------------------------------------------------------
// 任务侧边栏
//
// 思路：不猜"玩家接了哪些任务"（日志里拿不到可靠状态），而是把完整任务库做成
// 离线可搜索的清单（商人 -> 阶段），玩家勾选自己在做的，地点就画到地图上。
// 勾选状态按存档长期保留；地图识别、楼层高度是自动的。
// ---------------------------------------------------------------------------
const QUEST_UI_DEFAULT = {
  open: true, mapOnly: true, locationOnly: true, showKill: false, checkedOnly: false,
  trader: '', levelMax: 0, query: '', opacity: 0.25, autoOpen: true,
};
const MAX_DRAWN_TASKS = 40; // 一张图上同时画太多任务会糊成一片，超出只在列表里提示
const MAX_ROWS = 400;       // 列表一次最多画多少行（搜索/筛选后一般远小于此）

const quest = {
  dump: null,
  tradersById: new Map(),
  checked: new Set(),
  ui: { ...QUEST_UI_DEFAULT },
  expanded: new Set(),
  collapsedTraders: new Set(),
  collapsedStages: new Set(),
  lastMapId: '__none__',
  loading: null,
  saveTimer: null,
  searchTimer: null,
};
window.__quest = quest; // 可视化自检用（tools/verify-quests.js）

/** 展开/收起任务侧边栏（面板、顶栏按钮、信息卡片让位 三处状态保持一致） */
function setQuestPanelOpen(open) {
  $('#quest-panel').classList.toggle('collapsed', !open);
  $('#btn-quests').classList.toggle('active', Boolean(open));
  document.body.classList.toggle('quest-open', Boolean(open));
  quest.ui.open = Boolean(open);
}

/** 初始化：读配置、绑事件、后台预取任务库 */
function initQuests() {
  const cfg = (state.cfg && state.cfg.quests) || {};
  quest.ui = { ...QUEST_UI_DEFAULT, ...cfg };
  quest.checked = new Set(Array.isArray(cfg.checked) ? cfg.checked : []);
  view.setQuestOpacity(quest.ui.opacity);

  const panel = $('#quest-panel');
  // 窄视口（高 DPI 缩放时 CSS 视口可能只有 ~950px）先收起，别把地图挤没了（与图例面板一致）
  setQuestPanelOpen(quest.ui.open !== false && window.innerWidth >= 1180);

  // 顶栏开关
  $('#btn-quests').addEventListener('click', () => {
    setQuestPanelOpen(panel.classList.contains('collapsed'));
    saveQuestCfg();
  });
  $('#quest-close').addEventListener('click', () => {
    setQuestPanelOpen(false);
    saveQuestCfg();
  });

  // 搜索（防抖，输入时列表实时收窄）
  $('#quest-q').addEventListener('input', (e) => {
    quest.ui.query = e.target.value;
    clearTimeout(quest.searchTimer);
    quest.searchTimer = setTimeout(() => refreshQuests(), 120);
  });

  // 筛选 chips
  const chip = (sel, key) => {
    const btn = $(sel);
    btn.classList.toggle('active', Boolean(quest.ui[key]));
    btn.addEventListener('click', () => {
      quest.ui[key] = !quest.ui[key];
      btn.classList.toggle('active', quest.ui[key]);
      refreshQuests();
      saveQuestCfg();
    });
  };
  chip('#qc-map', 'mapOnly');
  chip('#qc-loc', 'locationOnly');
  chip('#qc-checked', 'checkedOnly');
  chip('#qc-kill', 'showKill');

  $('#quest-trader').addEventListener('change', (e) => {
    quest.ui.trader = e.target.value;
    refreshQuests();
    saveQuestCfg();
  });
  $('#quest-level').addEventListener('change', (e) => {
    quest.ui.levelMax = Number(e.target.value) || 0;
    refreshQuests();
    saveQuestCfg();
  });
  $('#quest-reset').addEventListener('click', () => {
    if (!quest.checked.size) return;
    if (!confirm(`清空全部 ${quest.checked.size} 个已勾选任务？（地图上的标记也会一起消失）`)) return;
    quest.checked.clear();
    refreshQuests();
    saveQuestCfg();
  });

  // 快捷键：Ctrl+F 聚焦搜索框（别和游戏冲突，只在窗口已聚焦时生效）
  window.addEventListener('keydown', (e) => {
    const key = String(e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 'f') {
      e.preventDefault();
      setQuestPanelOpen(true);
      $('#quest-q').focus();
      $('#quest-q').select();
    }
  });

  // 后台预取（不阻塞首屏）
  ensureQuestData().then(() => refreshQuests()).catch(() => refreshQuests());
}

/** 载入任务库（只需一次；走 app:// 静态协议，和图标/地图同一套） */
function ensureQuestData() {
  if (quest.dump) return Promise.resolve(quest.dump);
  if (quest.loading) return quest.loading;
  quest.loading = (async () => {
    const res = await fetch('app://data/quests-dump.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const dump = await res.json();
    quest.dump = dump;
    quest.tradersById = new Map((dump.traders || []).map((t) => [t.id, t]));
    // 商人下拉：只列真的有任务的商人
    const used = new Map();
    for (const t of dump.tasks || []) used.set(t.trader, (used.get(t.trader) || 0) + 1);
    const sel = $('#quest-trader');
    const opts = (dump.traders || [])
      .filter((t) => used.has(t.id))
      .sort((a, b) => (used.get(b.id) || 0) - (used.get(a.id) || 0))
      .map((t) => `<option value="${t.id}">${t.name}（${used.get(t.id)}）</option>`)
      .join('');
    sel.innerHTML = `<option value="">全部商人</option>${opts}`;
    sel.value = quest.ui.trader || '';
    $('#quest-level').value = String(quest.ui.levelMax || 0);
    return dump;
  })();
  quest.loading.catch((e) => {
    console.warn('任务数据缺失（可运行 npm run fetch:quests 生成）', e);
  });
  return quest.loading;
}

function saveQuestCfg() {
  clearTimeout(quest.saveTimer);
  quest.saveTimer = setTimeout(() => {
    api.setConfig({
      quests: {
        checked: [...quest.checked],
        open: quest.ui.open !== false,
        mapOnly: quest.ui.mapOnly !== false,
        locationOnly: quest.ui.locationOnly !== false,
        showKill: Boolean(quest.ui.showKill),
        checkedOnly: Boolean(quest.ui.checkedOnly),
        trader: quest.ui.trader || '',
        levelMax: Number(quest.ui.levelMax) || 0,
        opacity: Number(quest.ui.opacity) || 0.18,
        autoOpen: quest.ui.autoOpen !== false,
      },
    }).catch(() => {});
  }, 400);
}

function currentMapId() {
  return state.detail ? state.detail.id : null;
}

/** 当前地图上、已勾选、有地点可画的任务 -> 交给渲染层
 *  注意：这里刻意不受侧边栏的搜索/筛选影响 —— 地图上永远显示"你勾选的全部"，
 *  否则一搜索就会把地图上的标记也一起搜没，很容易以为勾选丢了。 */
function syncQuestLayer() {
  const mapId = currentMapId();
  if (!mapId || !quest.dump) {
    view.setQuests([]);
    return 0;
  }
  const items = [];
  for (const task of quest.dump.tasks || []) {
    if (!quest.checked.has(task.id)) continue;
    const loc = taskLocation(task, mapId, { showKill: quest.ui.showKill });
    if (!loc.zones.length && !loc.spots.length) continue;
    const tr = quest.tradersById.get(task.trader);
    items.push({
      id: task.id,
      label: `${task.name}${tr ? ` · ${tr.name}` : ''}`,
      zones: loc.zones,
      spots: loc.spots,
    });
    if (items.length >= MAX_DRAWN_TASKS) break;
  }
  view.setQuests(items);
  return items.length;
}

/** 重画侧边栏 + 同步地图图层 */
function refreshQuests({ autoOpen = false } = {}) {
  const panel = $('#quest-panel');
  const list = $('#quest-list');
  const keepScroll = list.scrollTop;
  quest.lastMapId = currentMapId();

  if (!quest.dump) {
    list.innerHTML = '<div class="quest-empty">正在加载任务数据…</div>';
    $('#quest-stat').textContent = '未加载';
    return;
  }

  const tasks = quest.dump.tasks || [];
  const mapId = currentMapId();
  const filtered = filterTasks(tasks, quest.tradersById, {
    query: quest.ui.query,
    traderId: quest.ui.trader,
    mapId,
    mapOnly: quest.ui.mapOnly !== false,
    locationOnly: quest.ui.locationOnly !== false,
    checkedOnly: Boolean(quest.ui.checkedOnly),
    checked: quest.checked,
    showKill: Boolean(quest.ui.showKill),
    levelMax: Number(quest.ui.levelMax) || 0,
  });
  const drawn = syncQuestLayer();
  renderLegend(); // 任务/玩家图例项的数量要跟着更新（"地图上有的图例里必有"）

  // 地图刚识别出来时自动展开（有任务在看才有意义；设置里能关）
  if (autoOpen && quest.ui.autoOpen !== false && quest.ui.open === false && quest.checked.size) {
    setQuestPanelOpen(true);
  }

  list.innerHTML = '';
  if (!tasks.length) {
    list.innerHTML = '<div class="quest-empty">任务数据是空的。<br>请运行 <code>npm run fetch:quests</code> 重新生成 <code>data/quests-dump.json</code>。</div>';
  } else if (!filtered.length) {
    const hint = quest.ui.checkedOnly
      ? '还没有勾选任何任务。<br>取消"已勾选"筛选，搜索任务名后点左侧方框勾选。'
      : (quest.ui.mapOnly !== false && mapId ? '当前地图没有符合筛选的任务。<br>试试关掉"本图"或"有地点"。' : '没有匹配的任务，换个关键词试试。');
    list.innerHTML = `<div class="quest-empty">${hint}</div>`;
  } else {
    const groups = groupTasks(filtered, quest.tradersById);
    const frag = document.createDocumentFragment();
    const counter = { rows: 0 };
    for (const g of groups) {
      if (counter.rows >= MAX_ROWS) break;
      frag.appendChild(questTraderSection(g, mapId, counter));
    }
    list.appendChild(frag);
    if (counter.rows >= MAX_ROWS) {
      const more = document.createElement('div');
      more.className = 'quest-empty';
      more.textContent = `只显示了前 ${MAX_ROWS} 条，用搜索或筛选缩小范围`;
      list.appendChild(more);
    }
  }
  list.scrollTop = keepScroll;

  // 状态栏
  const mapName = state.detail ? state.detail.name : null;
  const checkedOnMap = [...quest.checked].filter((id) => {
    const t = tasks.find((x) => x.id === id);
    return t && mapId && (t.maps || []).includes(mapId);
  }).length;
  $('#quest-stat').textContent = mapName
    ? `本图 ${filtered.length} 个 · 已勾选 ${quest.checked.size}（本图 ${checkedOnMap}）· 画了 ${drawn}`
    : `共 ${tasks.length} 个任务 · 已勾选 ${quest.checked.size}（等待识别地图）`;
  const badge = $('#quest-badge');
  badge.textContent = String(quest.checked.size);
  badge.classList.toggle('empty', quest.checked.size === 0);

  // 勾了任务但地图上什么都没出现时，必须明确告诉用户"位置在别的图 / 压根没有坐标"，
  // 否则会以为任务标记功能坏了（真实反馈：勾了"铁鸟坠落"，但当时在灯塔 -> 地图上空的）。
  const hint = $('#quest-hint');
  if (hint) {
    hint.innerHTML = '';
    const checkedTasks = [...quest.checked].map((id) => tasks.find((t) => t.id === id)).filter(Boolean);
    const noCoord = checkedTasks.filter((t) => locationsByMap(t, { showKill: quest.ui.showKill }).length === 0).length;
    const elsewhere = new Map();
    if (mapId) {
      for (const t of checkedTasks) {
        for (const m of otherMapsWithLocation(t, mapId, { showKill: quest.ui.showKill })) {
          elsewhere.set(m.mapId, (elsewhere.get(m.mapId) || 0) + 1);
        }
      }
    }
    if (mapId && quest.checked.size && drawn === 0 && (elsewhere.size || noCoord)) {
      const txt = document.createElement('span');
      txt.className = 'quest-hint-text';
      txt.textContent = `勾选的 ${quest.checked.size} 个任务在这张图上没有位置`;
      hint.appendChild(txt);
      const top = [...elsewhere.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      for (const [mid, n] of top) {
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'quest-hint-go';
        go.textContent = `切到 ${mapNameOf(mid)}（${n}）`;
        go.addEventListener('click', () => api.selectMap({ id: mid }));
        hint.appendChild(go);
      }
      if (noCoord) {
        const s = document.createElement('span');
        s.className = 'quest-hint-text';
        s.textContent = `另有 ${noCoord} 个任务公开数据里没有坐标（只有文字目标）`;
        hint.appendChild(s);
      }
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }
  }
}

/** 一个商人分组（含阶段小节） */
function questTraderSection(group, mapId, counter) {
  const sec = document.createElement('section');
  sec.className = 'quest-trader-group';
  const collapsed = quest.collapsedTraders.has(group.trader.id);
  sec.classList.toggle('collapsed', collapsed);

  const checkedInGroup = group.stages.reduce((n, s) => n + s.tasks.filter((t) => quest.checked.has(t.id)).length, 0);
  const head = document.createElement('div');
  head.className = 'quest-trader-head';
  head.innerHTML = `
    <span class="legend-caret">${collapsed ? '▸' : '▾'}</span>
    <span class="quest-trader-name"></span>
    <span class="quest-trader-en"></span>
    <span class="quest-trader-count"></span>`;
  head.querySelector('.quest-trader-name').textContent = group.trader.name;
  head.querySelector('.quest-trader-en').textContent = group.trader.nickname || '';
  const countEl = head.querySelector('.quest-trader-count');
  countEl.innerHTML = checkedInGroup
    ? `<span class="quest-trader-checked">✓${checkedInGroup}</span> / ${group.count}`
    : String(group.count);
  head.addEventListener('click', () => {
    if (quest.collapsedTraders.has(group.trader.id)) quest.collapsedTraders.delete(group.trader.id);
    else quest.collapsedTraders.add(group.trader.id);
    sec.classList.toggle('collapsed', quest.collapsedTraders.has(group.trader.id));
    head.querySelector('.legend-caret').textContent = sec.classList.contains('collapsed') ? '▸' : '▾';
  });
  sec.appendChild(head);

  for (const stage of group.stages) {
    const sSec = document.createElement('div');
    sSec.className = 'quest-stage-group';
    const sKey = `${group.trader.id}:${stage.order}`;
    sSec.classList.toggle('collapsed', quest.collapsedStages.has(sKey));
    const sHead = document.createElement('div');
    sHead.className = 'quest-stage-head';
    sHead.innerHTML = `<span class="legend-caret">${quest.collapsedStages.has(sKey) ? '▸' : '▾'}</span><span>${stage.label}</span><span class="quest-stage-line"></span><span>${stage.tasks.length}</span>`;
    sHead.addEventListener('click', () => {
      if (quest.collapsedStages.has(sKey)) quest.collapsedStages.delete(sKey);
      else quest.collapsedStages.add(sKey);
      sSec.classList.toggle('collapsed', quest.collapsedStages.has(sKey));
      sHead.querySelector('.legend-caret').textContent = sSec.classList.contains('collapsed') ? '▸' : '▾';
    });
    sSec.appendChild(sHead);

    const rows = document.createElement('div');
    rows.className = 'quest-rows';
    for (const task of stage.tasks) {
      if (counter && counter.rows >= MAX_ROWS) break;
      rows.appendChild(questRow(task, mapId));
      if (counter) counter.rows++;
    }
    sSec.appendChild(rows);
    sec.appendChild(sSec);
  }
  return sec;
}

/** 单个任务行 */
function questRow(task, mapId) {
  const row = document.createElement('div');
  const checked = quest.checked.has(task.id);
  row.className = 'quest-row' + (checked ? ' checked' : '');
  row.dataset.taskId = task.id;

  // 注意：这里用 div 而不是 label —— label 会让"点任务名"变成切换勾选框，
  // 而点击任务名应该是展开目标明细、点方框才是勾选。
  const main = document.createElement('div');
  main.className = 'quest-row-main';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => {
    if (box.checked) quest.checked.add(task.id);
    else quest.checked.delete(task.id);
    row.classList.toggle('checked', box.checked);
    refreshQuests();
    saveQuestCfg();
  });

  const text = document.createElement('div');
  text.className = 'quest-row-text';
  const name = document.createElement('div');
  name.className = 'quest-row-name';
  name.textContent = task.name;
  name.title = task.wiki ? `${task.name}\n${task.wiki}` : task.name;
  const sub = document.createElement('div');
  sub.className = 'quest-row-sub';
  sub.textContent = taskSummary(task, mapId, quest.dump.maps, { showKill: quest.ui.showKill });
  const badges = document.createElement('div');
  badges.className = 'quest-row-badges';
  const st = stageBucket(task.stage);
  // 本图有没有可画的东西：没有就说清楚位置在别的图（或者公开数据里压根没坐标）
  const loc = taskLocation(task, mapId, { showKill: quest.ui.showKill });
  let locBadge = '';
  if (!loc.zones.length && !loc.spots.length) {
    const names = otherMapsWithLocation(task, mapId, { showKill: quest.ui.showKill })
      .slice(0, 2)
      .map((m) => mapNameOf(m.mapId))
      .join('/');
    locBadge = names
      ? `<span class="qbadge elsewhere" title="这张图上没有该任务的位置，展开可以切过去">位置在 ${escapeHtml(names)}</span>`
      : '<span class="qbadge nocord" title="公开任务数据里没有这个任务的坐标，只有文字目标">无坐标</span>';
    row.classList.add('no-loc');
  }
  badges.innerHTML = `
    <span class="qbadge lv">Lv${task.level || 0}</span>
    <span class="qbadge stage">${st.label}${task.stage ? ` · 链${task.stage}` : ''}</span>
    ${task.kappa ? '<span class="qbadge kappa">Kappa</span>' : ''}
    ${locBadge}`;
  text.append(name, sub, badges);
  main.append(box, text);
  row.appendChild(main);

  // 展开：目标明细（点任务名展开，勾选框不触发）
  main.addEventListener('click', (e) => {
    if (e.target === box) return;
    if (quest.expanded.has(task.id)) quest.expanded.delete(task.id);
    else quest.expanded.add(task.id);
    const old = row.querySelector('.quest-detail');
    if (old) old.remove();
    else row.appendChild(questDetail(task, mapId));
  });
  if (quest.expanded.has(task.id)) row.appendChild(questDetail(task, mapId));
  return row;
}

/** 目标明细：类型 + 中文描述 + （有地点时）定位按钮 */
function questDetail(task, mapId) {
  const wrap = document.createElement('div');
  wrap.className = 'quest-detail';
  const loc = taskLocation(task, mapId, { showKill: quest.ui.showKill });
  const located = [...loc.zones.map((z) => z), ...loc.spots.map((s) => s)];
  for (const o of task.objectives || []) {
    const line = document.createElement('div');
    line.className = 'quest-obj' + (o.optional ? ' optional' : '');
    const tag = document.createElement('span');
    tag.className = 'quest-obj-type';
    tag.textContent = typeLabel(o.type) + (o.count > 1 ? ` ×${o.count}` : '');
    const txt = document.createElement('span');
    txt.className = 'quest-obj-text';
    txt.textContent = o.text || '（无描述）';
    line.append(tag, txt);

    // 这个目标在当前地图上有没有点可去
    const target = (o.zones || []).find((z) => !mapId || z.map === mapId) || (o.spots || []).find((s) => !mapId || s.map === mapId);
    if (target) {
      const go = document.createElement('button');
      go.className = 'quest-obj-go';
      go.textContent = '定位';
      go.title = '把这个地点移到地图中央';
      go.addEventListener('click', (e) => {
        e.stopPropagation();
        focusWorld(target.x, target.z);
      });
      line.appendChild(go);
    }
    wrap.appendChild(line);
  }
  if (!task.objectives || !task.objectives.length) {
    const none = document.createElement('div');
    none.className = 'quest-obj';
    none.textContent = '（没有目标数据）';
    wrap.appendChild(none);
  }
  if (!located.length) {
    const none = document.createElement('div');
    none.className = 'quest-obj quest-obj-none';
    if (!mapId) {
      none.textContent = '还没有识别到地图，无法定位';
    } else {
      const others = otherMapsWithLocation(task, mapId, { showKill: quest.ui.showKill });
      if (others.length) {
        none.textContent = `这张图（${mapNameOf(mapId)}）没有该任务的位置，位置在：`;
        for (const m of others.slice(0, 3)) {
          const go = document.createElement('button');
          go.type = 'button';
          go.className = 'quest-obj-go';
          go.textContent = `切到 ${mapNameOf(m.mapId)}（${m.zones + m.spots} 个点）`;
          go.addEventListener('click', (e) => {
            e.stopPropagation();
            api.selectMap({ id: m.mapId });
          });
          none.appendChild(go);
        }
      } else {
        none.textContent = '公开任务数据里没有这个任务的坐标（只有文字目标，例如"上交物品/达到某等级"）';
      }
    }
    wrap.appendChild(none);
  }
  return wrap;
}

/** 侧边栏里点某个任务（或点地图上的区域点）：展开并滚动到它 */
function focusQuest(taskId) {
  if (!taskId || !quest.dump) return;
  setQuestPanelOpen(true);
  quest.expanded.add(taskId);
  // 任务可能被筛选条件挡着，先放开过滤再找
  if (quest.ui.checkedOnly && !quest.checked.has(taskId)) { quest.ui.checkedOnly = false; $('#qc-checked').classList.remove('active'); }
  if (quest.ui.trader) { quest.ui.trader = ''; $('#quest-trader').value = ''; }
  if (quest.ui.levelMax) { quest.ui.levelMax = 0; $('#quest-level').value = '0'; }
  refreshQuests();
  const row = $(`#quest-list .quest-row[data-task-id="${taskId}"]`);
  if (row) {
    row.scrollIntoView({ block: 'center' });
    row.classList.add('hot');
    setTimeout(() => row.classList.remove('hot'), 2200);
  }
}

/** 把世界坐标移到地图中央（定位按钮用；顺便关掉"自动居中"，否则下一张截图就把视野抢回去） */
function focusWorld(x, z) {
  if (!state.detail) return;
  const proj = makeProjection(state.detail);
  const p = proj.project(x, z);
  const vp = view.getViewport();
  const rect = $('#map-root').getBoundingClientRect();
  // 目标：约 45m 跨度铺满短边（用投影的像素/米比例算，兼容旋转过的地图）
  const a = proj.project(0, 0);
  const b = proj.project(45, 0);
  const c = proj.project(0, 45);
  const perMeter = Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - a.x, c.y - a.y)) / 45 || 0.2;
  const target = Math.min(rect.width, rect.height) / (45 * perMeter);
  const scale = Math.max(vp.scale, Math.min(60, target));
  view.setViewport({ cx: p.x, cy: p.y, scale, rot: vp.rot });
  view.setViewMode({ follow: false });
  $('#btn-follow').classList.remove('active');
}

init().catch((e) => {
  console.error(e);
  document.querySelector('#empty-hint p').textContent = '初始化失败: ' + e.message;
  $('#empty-hint').classList.add('show');
});
