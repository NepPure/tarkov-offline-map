'use strict';

import { MapView, MARKER_GROUPS } from './common/map-view.js';

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
  bindShotViewer();

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
      const iconHtml = it.icon
        ? `<img class="legend-icon" src="app://data/icons/${it.icon}" alt="">`
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
  $('#set-mini-follow').checked = !!c.miniFollowMainZoom;
  $('#set-marker-scale').value = c.markerScale ?? 1;
  $('#set-label-scale').value = c.labelScale ?? 1;
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

init().catch((e) => {
  console.error(e);
  document.querySelector('#empty-hint p').textContent = '初始化失败: ' + e.message;
  $('#empty-hint').classList.add('show');
});
