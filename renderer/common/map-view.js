'use strict';

/**
 * 地图视图引擎（主窗口与小地图共用）
 * - SVG 底图（按 data-layer 切换楼层，复刻原站 Vme 逻辑）
 * - 标记层（撤离点/转移点/boss/刷新点/钥匙锁/开关/危险/物资/固定武器/标签）
 * - 玩家标记 + 朝向扇形 + 轨迹
 * - 平移/缩放/跟随玩家/车头朝上
 * 纯渲染层，无 NodeAPI（通过 preload 暴露的 window.api 通信）
 */

export const MARKER_COLORS = {
  extract: '#4ade80',
  transit: '#38bdf8',
  boss: '#f87171',
  spawn: '#a78bfa',
  lock: '#fbbf24',
  switch: '#fb923c',
  hazard: '#f472b6',
  weapon: '#94a3b8',
  loose: '#facc15',
  label: 'rgba(255,255,255,0.75)',
};

/** 图例分组定义（含动态物资组 loot:<name> 与赛季文件组 season:<type>） */
export const MARKER_GROUPS = {
  extract_pmc: { label: 'PMC撤离点', color: '#4ade80' },
  extract_scav: { label: 'Scav撤离点', color: '#f59e0b' },
  extract_shared: { label: 'PMC·Scav共享', color: '#2dd4bf' },
  transit: { label: '马拉松转移点', color: '#38bdf8' },
  boss: { label: 'Boss刷新', color: '#f87171' },
  spawn: { label: '出生点', color: '#a78bfa' },
  lock: { label: '钥匙锁', color: '#fbbf24' },
  switch: { label: '开关', color: '#fb923c' },
  hazard: { label: '危险', color: '#f472b6' },
  weapon: { label: '固定武器', color: '#94a3b8' },
  loose: { label: '散落物资', color: '#facc15' },
  btrStop: { label: 'BTR站点', color: '#60a5fa' },
  label: { label: '地名', color: 'rgba(255,255,255,0.75)' },
};

const MARKER_LABELS = {
  extracts: '撤离点', transits: '转移点', bosses: 'Boss',
  spawns: '刷新点', locks: '钥匙锁', switches: '开关',
  hazards: '危险', loot: '物资', weapons: '固定武器', labels: '地名',
};

export class MapView {
  constructor(container, { mini = false } = {}) {
    this.container = container;
    this.mini = mini;
    this.detail = null;
    this.proj = null;
    this.px = null;              // 地图像素范围
    this.svgSize = { w: 100, h: 100 };
    this.view = { cx: 0, cy: 0, scale: 1, rot: 0 };
    this.player = null;
    this.heading = null;         // {screenAngleDeg}
    this.trail = [];
    this.floor = 'auto';
    this.follow = true;
    this.rotate = false;         // 车头朝上
    this.markerToggles = null;   // 由 setMarkerToggles 初始化（全部默认开启）
    this.showAllHeights = true;  // 表层显示全部标记
    this.layers = [];            // 可选楼层 [{name, svgLayer, extents}]
    this.baseLayer = null;
    this.layerReady = null;
    this.markerEls = [];
    this.markerCache = null;     // 当前地图标记列表 [{group,x,z,y,label,color,size}]
    this.seasonDocs = null;      // 当前地图的赛季文件刷点 [{uuid,itemId,x,y,z}]
    this.seasonTypes = null;     // 赛季文件类型元数据 { itemId: {type,name,shortName,icon,color} }
    this.seasonNo = null;        // 赛季编号（图例标题）
    this.markerScale = 1;        // 标记大小乘数（设置项）
    this.measureMode = false;    // 尺子测距
    this.measurePoints = [];     // [{x,z}]
    this.measurePending = false;
    this.nearestExfil = null;    // 最近撤离点标记（高亮）
    this.playerEl = null;
    this.trailEl = null;
    this.onViewChange = null;
    this.onPlayerSettled = null;
    this.onLegendChange = null;
    this.#buildDom();
    this.#bindEvents();
  }

  // ------------------------------------------------------------------ DOM
  #buildDom() {
    this.el = document.createElement('div');
    this.el.className = 'mapstage';
    this.el.innerHTML = `
      <svg class="mapstage-svg" xmlns="http://www.w3.org/2000/svg">
        <g class="world"></g>
      </svg>
      <div class="mapstage-overlay"></div>
    `;
    this.container.appendChild(this.el);
    this.svg = this.el.querySelector('.mapstage-svg');
    this.worldG = this.el.querySelector('.world');
    this.overlay = this.el.querySelector('.mapstage-overlay');
    this.#resetOverlay();
  }

  // 屏幕坐标覆盖层（玩家/标记/轨迹），需要真实 <svg> 容器
  #resetOverlay() {
    const ns = 'http://www.w3.org/2000/svg';
    this.overlay.innerHTML = '';
    this.overlaySvg = document.createElementNS(ns, 'svg');
    this.overlaySvg.setAttribute('width', '100%');
    this.overlaySvg.setAttribute('height', '100%');
    this.overlay.appendChild(this.overlaySvg);
  }

  #bindEvents() {
    let dragging = false, sx = 0, sy = 0, scx = 0, scy = 0, moved = 0;
    this.el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = 0;
      this.pressX = e.clientX; this.pressY = e.clientY;
      sx = e.clientX; sy = e.clientY; scx = this.view.cx; scy = this.view.cy;
      this.el.classList.add('dragging');
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      moved += Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy);
      // 空间平移 = 屏幕位移 / 缩放（含车头朝上旋转的逆变换）
      const dx = e.clientX - sx, dy = e.clientY - sy;
      const cos = Math.cos(this.view.rot), sin = Math.sin(this.view.rot);
      this.view.cx = scx - (dx * cos + dy * sin) / this.view.scale;
      this.view.cy = scy - (-dx * sin + dy * cos) / this.view.scale;
      this.follow = false;
      this.#requestRender();
    });
    window.addEventListener('mouseup', (e) => {
      if (!dragging) return;
      dragging = false;
      this.el.classList.remove('dragging');
      // 单击（非拖拽、且非标记点）：尺子取点
      const onMarker = e.target instanceof Element && e.target.closest('.map-marker');
      if (moved < 5 && !onMarker) this.#mapClick(e.clientX, e.clientY);
    });
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const rect = this.el.getBoundingClientRect();
      this.#zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    }, { passive: false });
    // 双击放大（以光标为中心）
    this.el.addEventListener('dblclick', (e) => {
      const rect = this.el.getBoundingClientRect();
      this.#zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1.6);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.measurePoints = [];
        this.measurePending = false;
        this.#renderOverlay();
      }
    });
    // 小地图点击可设视野中心
    if (this.mini) {
      this.el.addEventListener('click', (e) => {
        const rect = this.el.getBoundingClientRect();
        const p = this.#screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        if (p) { this.view.cx = p.px; this.view.cy = p.py; this.#emitView(); }
      });
    }
  }

  /** rAF 节流渲染（拖拽/滚轮高频路径） */
  #requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.#renderTransform();
      this.#renderOverlay();
    });
  }

  /** 地图空白处单击：尺子取点等 */
  #mapClick(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    const p = this.#screenToWorld(clientX - rect.left, clientY - rect.top);
    if (!p) return;
    if (this.measureMode) {
      const wp = this.proj ? this.proj.unproject(p.px, p.py) : null;
      if (wp) {
        if (this.measurePending && this.measurePoints.length === 1) {
          this.measurePoints.push({ x: wp.x, z: wp.z });
          this.measurePending = false;
        } else {
          this.measurePoints = [{ x: wp.x, z: wp.z }];
          this.measurePending = true;
        }
        this.#renderOverlay();
        this.#emitView();
      }
    }
  }

  /** 尺子测距开关 */
  setMeasureMode(on) {
    this.measureMode = !!on;
    if (!on) {
      this.measurePoints = [];
      this.measurePending = false;
    }
    this.#renderOverlay();
    if (this.onMeasureModeChange) this.onMeasureModeChange(this.measureMode);
  }

  #zoomAt(mx, my, factor) {
    const p = this.#screenToWorld(mx, my);
    if (!p) return;
    this.view.scale = Math.max(0.01, Math.min(60, this.view.scale * factor));
    // 缩放时保持光标下的地图点不动
    this.#retarget(mx, my, p.px, p.py);
  }

  #screenToWorld(sx, sy) {
    const r = this.el.getBoundingClientRect();
    const dx = sx - r.width / 2, dy = sy - r.height / 2;
    const cos = Math.cos(-this.view.rot), sin = Math.sin(-this.view.rot);
    const ux = (dx * cos - dy * sin) / this.view.scale;
    const uy = (dx * sin + dy * cos) / this.view.scale;
    return { px: this.view.cx + ux, py: this.view.cy + uy };
  }

  #worldToScreen(px, py) {
    const r = this.el.getBoundingClientRect();
    const dx = px - this.view.cx, dy = py - this.view.cy;
    const cos = Math.cos(this.view.rot), sin = Math.sin(this.view.rot);
    return {
      x: (dx * cos - dy * sin) * this.view.scale + r.width / 2,
      y: (dx * sin + dy * cos) * this.view.scale + r.height / 2,
    };
  }

  #retarget(sx, sy, px, py) {
    const r = this.el.getBoundingClientRect();
    const nx = this.#worldToScreen(px, py);
    this.view.cx += (sx - nx.x) / this.view.scale;
    this.view.cy += (sy - nx.y) / this.view.scale;
    this.#renderTransform();
    this.#renderOverlay(); // 标记覆盖层必须随视图一起重算
  }

  // ------------------------------------------------------------------ Map
  async setMap(detail, svgText) {
    this.detail = detail;
    this.proj = makeProjection(detail);
    this.px = mapPixelBounds(detail, this.proj);
    this.baseLayer = detail.svgLayer || null;
    this.layers = (detail.layers || []).map((l) => ({
      name: l.name, svgLayer: l.svgLayer || l.name, extents: l.extents || [],
    }));
    window.__viewDebug = {
      detailKey: detail.key,
      transform: detail.transform,
      rotation: detail.coordinateRotation,
      bounds: detail.bounds,
      px: this.px,
      svgLayer: detail.svgLayer,
    };
    // 构建底图
    this.worldG.innerHTML = '';
    this.markerEls = [];
    this.markerCache = null;
    this.markerCounts = null;
    this.#resetOverlay();
    this.#buildBase(svgText);
    this.#buildOverlay();
    await this.loadIcons();
    // 视野：以地图中心为起点
    this.view.cx = this.px.minX + this.px.width / 2;
    this.view.cy = this.px.minY + this.px.height / 2;
    const r = this.el.getBoundingClientRect();
    const fitScale = Math.min(r.width / Math.max(this.px.width, 1), r.height / Math.max(this.px.height, 1)) * (this.mini ? 1 : 0.95);
    this.view.scale = Math.max(fitScale, 0.02);
    this.refScale = this.view.scale; // 图标缩放参考（适配整图时的缩放比）
    this.#renderTransform();
    this.#renderOverlay();
    this.#emitView();
    return this.px;
  }

  setSvgSize(w, h) { this.svgSize = { w, h }; }

  #buildBase(svgText) {
    if (!svgText) return;
    try {
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      const root = doc.documentElement;
      const vb = root.getAttribute('viewBox');
      if (vb) {
        const [a, b, c, d] = vb.trim().split(/\s+/).map(Number);
        this.setSvgSize(d - a, d - b);
        this.svg.setAttribute('viewBox', `0 0 ${d - a} ${d - b}`);
      }
      // 复制原始 SVG 并隐藏非当前层
      const clone = root.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.removeAttribute('width'); clone.removeAttribute('height');
      clone.setAttribute('x', this.px.minX);
      clone.setAttribute('y', this.px.minY);
      clone.setAttribute('width', this.px.width);
      clone.setAttribute('height', this.px.height);
      clone.setAttribute('preserveAspectRatio', 'none');
      this.baseSvg = clone;
      this.worldG.appendChild(clone);
      this.#applyFloor();
    } catch (e) {
      console.error('SVG import failed', e);
    }
  }

  /** 楼层切换：显示 data-layer===当前层 的组（原站 Vme 逻辑） */
  setFloor(floor) {
    this.floor = floor;
    this.#applyFloor();
    this.#renderOverlay();
    this.#emitView();
  }

  #applyFloor() {
    if (!this.baseSvg) return;
    const target = this.#resolveFloorLayer();
    // 只切换"顶层图层组"（g[data-layer]），嵌套子组随父级显隐（复刻原站 Vme 语义）
    let groups = Array.from(this.baseSvg.querySelectorAll('g[data-layer]'));
    if (groups.length === 0) {
      groups = Array.from(this.baseSvg.children).filter((c) => c.tagName === 'g');
    }
    let found = 0;
    for (const g of groups) {
      const layer = g.getAttribute('data-layer') || g.getAttribute('id');
      if (!layer) continue;
      if (layer === target) {
        g.removeAttribute('style');
        g.setAttribute('display', 'block');
        found++;
      } else {
        g.setAttribute('display', 'none');
      }
    }
    // 若该层无可切换组，则全部显示（兜底）
    if (!found) for (const g of groups) { g.removeAttribute('style'); g.setAttribute('display', 'block'); }
  }

  /** 解析当前应显示的楼层 svgLayer 名 */
  #resolveFloorLayer() {
    if (this.floor !== 'auto' && this.floor) return this.floor;
    // 自动楼层：根据玩家高度与 extents 判定
    if (this.player) {
      const p = this.player;
      for (const l of this.layers) {
        for (const ext of l.extents) {
          const [lo, hi] = ext.height;
          if (p.y < lo || p.y > hi) continue;
          if (this.#inExtent(ext, p.x, p.z)) return l.svgLayer;
        }
      }
    }
    return this.baseLayer;
  }

  #inExtent(ext, x, z) {
    if (!ext.bounds) return false;
    for (const rect of ext.bounds) {
      const [x1, z1] = rect[0], [x2, z2] = rect[1];
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
      if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ Players & markers
  setPlayer(pos, quat) {
    this.player = pos ? { x: pos.x, y: pos.y ?? pos.z ?? 0, z: pos.z } : null;
    // 注意：我们的 position 字段 {x, y=高度, z}
    if (this.player && pos) this.player.y = pos.y;
    this.heading = (pos && quat) ? headingAngle(this.detail, quat, this.proj) : null;
    this.#renderOverlay();
    if (this.follow && this.player) this.#centerOnPlayer(false);
    if (this.onPlayerSettled) this.onPlayerSettled(this.player, this.heading);
  }

  setTrail(trail) {
    this.trail = trail || [];
    this.#renderOverlay();
  }

  setMarkerToggles(toggles) {
    if (!this.markerToggles) {
      const defaults = {};
      for (const key of Object.keys(MARKER_GROUPS)) defaults[key] = true;
      this.markerToggles = defaults;
    }
    this.markerToggles = { ...this.markerToggles, ...toggles };
    this.#renderOverlay();
  }

  /** 当前图例全部组 id（含动态物资组），供"全部/无"使用 */
  allGroupIds() {
    return this.getLegend().flatMap((item) =>
      item.children && item.children.length ? item.children.map((c) => c.id) : [item.id]
    );
  }

  setShowAllHeights(v) {
    this.showAllHeights = v !== false;
    this.#renderOverlay();
  }

  setMapOpacity(v) {
    if (this.svg) this.svg.style.opacity = String(v);
  }

  /** 图标素材清单（data/icons/manifest.json） */
  async loadIcons() {
    try {
      const m = await (await fetch('app://data/icons/manifest.json')).json();
      this.iconSet = new Set(Object.keys(m.files || {}));
    } catch {
      this.iconSet = new Set();
    }
  }

  /** 标记 -> 图标文件名（无则 null） */
  #iconFor(m) {
    if (!this.iconSet) return null;
    const has = (k) => this.iconSet.has(k);
    if (m.group === 'extract_pmc' && has('extract_pmc')) return 'extract_pmc.png';
    if (m.group === 'extract_scav' && has('extract_scav')) return 'extract_scav.png';
    if (m.group === 'extract_shared' && has('extract_shared')) return 'extract_shared.png';
    if (m.group === 'transit' && has('extract_transit')) return 'extract_transit.png';
    if (m.group === 'boss') {
      const boss = String(m.boss || '');
      if (boss && has('boss_' + boss)) return 'boss_' + boss + '.png';
      return has('spawn_boss') ? 'spawn_boss.png' : null;
    }
    if (m.group === 'lock') return has('key') ? 'key.png' : has('lock') ? 'lock.png' : null;
    if (m.group === 'switch') return has('switch') ? 'switch.png' : null;
    if (m.group === 'hazard') return has('hazard') ? 'hazard.png' : null;
    if (m.group === 'weapon') return has('stationarygun') ? 'stationarygun.png' : null;
    if (m.group === 'btrStop') return has('btr_stop') ? 'btr_stop.png' : has('switch') ? 'switch.png' : null;
    // 赛季文件：用物品自身图标（data/icons/season_<type>.webp，由 tools/fetch-season.js 下载）
    if (m.group.startsWith('season:')) {
      const type = m.seasonType?.type || m.group.slice(7);
      return `season_${type}.webp`;
    }
    if (m.group === 'spawn') {
      if (m.sides === 'scav' && has('spawn_scav')) return 'spawn_scav.png';
      if (has('spawn_pmc')) return 'spawn_pmc.png';
      if (has('spawn_bot_pmc')) return 'spawn_bot_pmc.png';
      return null;
    }
    if (m.group === 'loose') {
      if (m.highValue && has('loose_loot_high')) return 'loose_loot_high.png';
      return has('loose_loot_favorite') ? 'loose_loot_favorite.png' : null;
    }
    if (m.group.startsWith('loot:')) {
      let name = m.group.slice(5).toLowerCase().replace(/\s+/g, '-');
      const alias = {
        'bank-safe': 'safe', 'bank-cash-register': 'cash-register', 'dead-civilian': 'dead-scav',
        'pmc-body': 'dead-scav', 'lab-technician-body': 'dead-scav', 'scav-body': 'dead-scav',
        'cash-register-tar2-2': 'cash-register', 'shturmans-stash': 'weapon-box',
        'medical-supply-crate': 'crate', 'ration-supply-crate': 'crate',
        'technical-supply-crate': 'crate', 'wooden-ammo-box': 'wooden-ammo-box',
      };
      name = alias[name] || name;
      const key = 'container_' + name;
      if (has(key)) return key + '.png';
      return has('container_crate') ? 'container_crate.png' : null;
    }
    return null;
  }

  /** 是否显示名称标签（相对参考缩放判定，随缩放大小时标尺变化） */
  #labelVisible(m) {
    if (this.mini) return false;
    if (m.group === 'spawn' || m.group === 'loose' || m.group === 'label') return false;
    const always = ['extract_pmc', 'extract_scav', 'extract_shared', 'transit', 'boss'];
    if (always.includes(m.group)) return true;
    // 赛季文件刷点与 BTR 站点始终显示中文名（版本活动找东西靠它）
    if (m.group.startsWith('season:') || m.group === 'btrStop') return true;
    // 物资/锁/开关/危险/武器等：放大到参考缩放的 0.6 倍后显示标签，避免密集区域重叠
    const ref = this.refScale || this.view.scale;
    return this.view.scale >= ref * 0.6;
  }

  /**
   * 赛季文件刷点数据（data/season-documents.json）
   * @param {object} data 全量数据 { season, types, maps }
   * @param {string} mapId 当前地图 id（tarkov map id）
   */
  setSeasonDocuments(data, mapId) {
    this.seasonTypes = data?.types || null;
    this.seasonNo = data?.season || null;
    const entry = data?.maps ? data.maps[mapId] : null;
    this.seasonDocs = entry?.points?.length ? entry.points : null;
    this.markerCache = null;
    this.markerCounts = null;
    this.#renderOverlay();
  }

  setViewMode({ follow, rotate }) {
    if (follow !== undefined) this.follow = follow;
    if (rotate !== undefined) this.rotate = rotate;
    if (this.follow && this.player) this.#centerOnPlayer(true);
  }

  #centerOnPlayer(recompute) {
    if (!this.player || !this.proj) return;
    const p = this.proj.project(this.player.x, this.player.z);
    this.view.cx = p.x;
    this.view.cy = p.y;
    if (this.rotate && this.heading) {
      // 车头朝上：地图旋转，使得朝向指向屏幕上方
      this.view.rot = (this.heading.screenAngleDeg + 90) * Math.PI / 180;
    } else {
      this.view.rot = 0;
    }
    this.#renderTransform();
    this.#renderOverlay();
    this.#emitView();
  }

  // ------------------------------------------------------------------ Render
  #renderTransform() {
    const r = this.el.getBoundingClientRect();
    (window.__rects = window.__rects || []).push([Math.round(r.width), Math.round(r.height), Math.round(this.view.scale * 100) / 100]);
    if (window.__rects.length > 8) window.__rects.shift();
    this.svg.setAttribute('viewBox', `0 0 ${r.width || 100} ${r.height || 100}`);
    const t = `translate(${r.width / 2} ${r.height / 2}) rotate(${(this.view.rot * 180) / Math.PI}) scale(${this.view.scale}) translate(${-this.view.cx} ${-this.view.cy})`;
    this.worldG.setAttribute('transform', t);
  }

  #buildOverlay() {
    const ns = 'http://www.w3.org/2000/svg';
    this.overlaySvg.innerHTML = '';
    this.trailEl = document.createElementNS(ns, 'polyline');
    this.trailEl.setAttribute('fill', 'none');
    this.trailEl.setAttribute('stroke', '#22d3ee');
    this.trailEl.setAttribute('stroke-width', '2');
    this.trailEl.setAttribute('opacity', '0.7');
    this.overlaySvg.appendChild(this.trailEl);
    this.playerEl = document.createElementNS(ns, 'g');
    this.overlaySvg.appendChild(this.playerEl);
  }

  #renderOverlay() {
    if (!this.detail) return;
    // 玩家
    if (this.playerEl && this.player && this.proj) {
      const p = this.proj.project(this.player.x, this.player.z);
      const s = this.#worldToScreen(p.x, p.y);
      const size = this.mini ? 14 : 18;
      const rot = this.heading ? this.heading.screenAngleDeg : 0;
      this.playerEl.innerHTML = `
        <g transform="translate(${s.x} ${s.y})">
          <circle r="${size * 0.7}" fill="rgba(34,211,238,0.25)" class="player-pulse"></circle>
          <g transform="rotate(${rot})">
            <path d="M${size} 0 L${-size * 0.6} ${-size * 0.6} L${-size * 0.3} 0 L${-size * 0.6} ${size * 0.6} Z"
                  fill="#22d3ee" stroke="#0b0e13" stroke-width="1.5"></path>
          </g>
        </g>`;
      // 轨迹
      const pts = this.trail.map((t) => {
        const q = this.proj.project(t.x, t.z);
        const s2 = this.#worldToScreen(q.x, q.y);
        return `${s2.x},${s2.y}`;
      });
      this.trailEl.setAttribute('points', pts.join(' '));
      this.trailEl.setAttribute('stroke-width', String(this.mini ? 2 : Math.max(2, 2.5 / this.view.scale * 2)));
    }
    // 标记（图标 + 中文名标签，复刻原站样式）
    const markers = this.#visibleMarkers();
    const frag = document.createDocumentFragment();
    this.markerEls = [];
    // 标记大小（复刻原站逻辑：屏幕尺寸恒定≈24px/文字12px，乘以用户"标记大小"设置，
    // 并随缩放轻微增长；下限保证整图视图仍可辨识）
    const ref = this.refScale || this.view.scale;
    const sf = this.mini ? 1 : Math.max(0.55, Math.min(1.8, Math.pow(this.view.scale / (ref || 1), 0.2))) * this.markerScale;
    for (const m of markers) {
      const px = this.proj.project(m.x, m.z);
      const s = this.#worldToScreen(px.x, px.y);
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      el.setAttribute('transform', `translate(${s.x} ${s.y})`);
      // 撤离点区域轮廓
      if (m.outline && m.group.startsWith('extract')) {
        const pts = m.outline.map((q) => {
          const pr = this.proj.project(q.x, q.z);
          const so = this.#worldToScreen(pr.x, pr.y);
          return `${so.x},${so.y}`;
        }).join(' ');
        const poly = document.createElementNS(ns(), 'polygon');
        poly.setAttribute('points', pts);
        poly.setAttribute('fill', m.color);
        poly.setAttribute('fill-opacity', '0.12');
        poly.setAttribute('stroke', m.color);
        poly.setAttribute('stroke-width', this.mini ? '1' : String(1.5 / this.view.scale));
        poly.setAttribute('transform', `translate(${-s.x} ${-s.y})`);
        el.appendChild(poly);
      }
      // 图标 + 标签（复刻原站：图标 24px 级 / 文字 12px 级，随"标记大小"设置与缩放微调）
      const icon = this.#iconFor(m);
      const baseSize = m.group === 'boss' ? 30 : (m.group.startsWith('loot:') ? 22 : 26);
      const iconSize = this.mini ? 12 : Math.max(10, baseSize * sf);
      const label = this.#labelVisible(m) ? (m.shortLabel || m.label) : null;
      const fs = this.mini ? 0 : Math.max(8, 12 * sf);
      if (icon) {
        // 赛季文件刷点：图标下加深色圆底 + 类型色描边，和普通图标区分开
        if (m.group.startsWith('season:')) {
          const halo = document.createElementNS(ns(), 'circle');
          halo.setAttribute('r', String(iconSize / 2 + 3));
          halo.setAttribute('fill', m.color);
          halo.setAttribute('fill-opacity', '0.28');
          halo.setAttribute('stroke', m.color);
          halo.setAttribute('stroke-width', '1.6');
          el.appendChild(halo);
        }
        const img = document.createElementNS(ns(), 'image');
        img.setAttribute('href', 'app://data/icons/' + icon);
        img.setAttribute('x', String(-iconSize / 2));
        img.setAttribute('y', String(-iconSize / 2));
        img.setAttribute('width', String(iconSize));
        img.setAttribute('height', String(iconSize));
        img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        el.appendChild(img);
        if (label) el.appendChild(labelPill(label, iconSize, fs));
        // 最近撤离点高亮圈
        if (this.nearestExfil && m === this.nearestExfil) {
          const ring = document.createElementNS(ns(), 'circle');
          ring.setAttribute('r', String(iconSize / 2 + 5));
          ring.setAttribute('fill', 'none');
          ring.setAttribute('stroke', '#fef08a');
          ring.setAttribute('stroke-width', '2');
          ring.setAttribute('class', 'exfil-ring');
          el.appendChild(ring);
        }
      } else if (m.group === 'label') {
        const text = document.createElementNS(ns(), 'text');
        const fsLabel = this.mini ? 6 : Math.max(6, Math.min(14, 11 * sf));
        text.setAttribute('x', '0'); text.setAttribute('y', '-2');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', String(fsLabel));
        text.setAttribute('fill', m.color);
        text.setAttribute('stroke', '#0b0e13');
        text.setAttribute('stroke-width', '0.6');
        text.setAttribute('opacity', '0.85');
        text.textContent = m.label;
        el.appendChild(text);
      } else {
        const rad = this.mini ? 3.5 : Math.max(2.5, 6 / this.view.scale);
        const dot = document.createElementNS(ns(), 'circle');
        dot.setAttribute('r', String(rad));
        dot.setAttribute('fill', m.color);
        dot.setAttribute('stroke', '#0b0e13');
        dot.setAttribute('stroke-width', '1.2');
        el.appendChild(dot);
      }
      el.appendChild(titleNode(m.label));
      el.classList.add('map-marker');
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onMarkerClick && this.onMarkerClick(m);
      });
      frag.appendChild(el);
      this.markerEls.push(el);
      m._el = el;
    }
    const old = this.overlaySvg.querySelectorAll('.map-marker');
    old.forEach((o) => o.remove());
    this.overlaySvg.appendChild(frag);
    this.#renderMeasure();
  }

  /** 尺子测距覆盖层 */
  #renderMeasure() {
    const g = this.overlaySvg.querySelector('#measure-layer');
    if (g) g.remove();
    if (!this.measureMode || this.measurePoints.length === 0) return;
    const nsx = ns();
    const grp = document.createElementNS(nsx, 'g');
    grp.setAttribute('id', 'measure-layer');
    const pts = this.measurePoints.map((p) => {
      const px = this.proj.project(p.x, p.z);
      return this.#worldToScreen(px.x, px.y);
    });
    if (pts.length >= 2) {
      const line = document.createElementNS(nsx, 'line');
      line.setAttribute('x1', pts[0].x); line.setAttribute('y1', pts[0].y);
      line.setAttribute('x2', pts[1].x); line.setAttribute('y2', pts[1].y);
      line.setAttribute('stroke', '#fbbf24'); line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-dasharray', '6 4');
      grp.appendChild(line);
      const d = Math.hypot(this.measurePoints[1].x - this.measurePoints[0].x, this.measurePoints[1].z - this.measurePoints[0].z);
      const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      const txt = document.createElementNS(nsx, 'text');
      txt.setAttribute('x', String(mx)); txt.setAttribute('y', String(my - 6));
      txt.setAttribute('text-anchor', 'middle');
      const fsM = Math.max(9, Math.min(14, 11 * (this.markerScale || 1)));
      txt.setAttribute('font-size', String(fsM));
      txt.setAttribute('fill', '#fbbf24');
      txt.setAttribute('stroke', '#0b0e13');
      txt.setAttribute('stroke-width', '0.8');
      txt.textContent = `${d.toFixed(0)} 米`;
      grp.appendChild(txt);
    }
    for (const [i, p] of pts.entries()) {
      const c = document.createElementNS(nsx, 'circle');
      c.setAttribute('cx', String(p.x)); c.setAttribute('cy', String(p.y));
      c.setAttribute('r', i === 0 ? '5' : '4');
      c.setAttribute('fill', i === 0 ? '#fbbf24' : '#ff7f50');
      c.setAttribute('stroke', '#0b0e13');
      c.setAttribute('stroke-width', '1.5');
      grp.appendChild(c);
    }
    this.overlaySvg.appendChild(grp);
  }

  setMarkerScale(v) {
    this.markerScale = v > 0 ? v : 1;
    this.#renderOverlay();
  }

  setNearestExfil(m) {
    this.nearestExfil = m || null;
    this.#renderOverlay();
  }

  /** 从标记缓存中找出距 (x,z) 最近的撤离点并高亮，返回 {label, meters} */
  highlightNearestExtract(x, z) {
    if (!this.markerCache) this.markerCache = this.#buildMarkers();
    let best = null, bestD = Infinity;
    for (const m of this.markerCache) {
      if (!m.group.startsWith('extract')) continue;
      const d = Math.hypot(m.x - x, m.z - z);
      if (d < bestD) { bestD = d; best = m; }
    }
    this.setNearestExfil(best);
    return best ? { label: best.shortLabel || best.label, meters: bestD } : null;
  }

  // 标记（先取候选，再按"图钉开关"与"楼层高度"过滤）
  #visibleMarkers() {
    if (!this.markerCache) this.markerCache = this.#buildMarkers();
    const picks = [];
    for (const m of this.markerCache) {
      if (this.markerToggles && this.markerToggles[m.group] === false) continue;
      if (!this.showAllHeights && !this.#heightInCurrentFloor(m.y)) continue;
      picks.push(m);
    }
    return picks;
  }

  #heightInCurrentFloor(h) {
    const target = this.#resolveFloorLayer();
    if (!target) return true;
    for (const l of this.layers) {
      if (l.svgLayer !== target && l.svgLayer !== this.baseLayer) continue;
      if (!l.extents || l.extents.length === 0) return true;
      for (const ext of l.extents) {
        const [lo, hi] = ext.height;
        if (h >= lo - 0.5 && h <= hi + 0.5) return true;
      }
    }
    return false;
  }

  /** 构建当前地图的标记列表（含分组/坐标/颜色），并缓存计数供图例使用 */
  #buildMarkers() {
    const detail = this.detail;
    const out = [];
    const counts = {};
    const push = (group, x, z, height, label, extra = {}) => {
      const def = MARKER_GROUPS[group] || {};
      const m = {
        group,
        x, z,
        y: height,
        label,
        color: extra.color || def.color || '#fff',
        size: extra.size || null,
        dashed: extra.dashed,
        outline: extra.outline,
        ...extra,
      };
      out.push(m);
      counts[group] = (counts[group] || 0) + 1;
    };
    const p = (obj) => (obj ? { x: obj.x, z: obj.z, y: obj.y } : null);

    for (const e of detail.extracts || []) {
      const faction = String(e.faction || '').toLowerCase();
      const group = faction === 'scav' ? 'extract_scav' : faction === 'shared' || faction === 'pmc/scav' ? 'extract_shared' : 'extract_pmc';
      push(group, e.position.x, e.position.z, e.position.y, `撤离点[${e.faction}]: ${e.name}`, { outline: e.outline, shortLabel: e.name });
    }
    for (const e of detail.transits || []) {
      const q = p(e.position) || p(e);
      if (q) push('transit', q.x, q.z, q.y, `转移点: ${e.name || '马拉松转移'}`, { dashed: true, shortLabel: e.name || '转移点' });
    }
    if (detail.bosses?.length) {
      const zones = new Map();
      for (const s of detail.spawns || []) zones.set(s.zoneName, s.position);
      for (const b of detail.bosses) {
        const loc = b.spawnLocations?.[0];
        const pos = (loc && zones.get(loc.spawnKey)) || zones.get(loc?.name);
        if (pos) push('boss', pos.x, pos.z, pos.y, `Boss[${Math.round((b.spawnChance || 0) * 100)}%]: ${b.boss?.name}`, { boss: b.boss?.normalizedName || b.boss?.id, shortLabel: b.boss?.name });
      }
    }
    for (const s of detail.spawns || []) push('spawn', s.position.x, s.position.z, s.position.y, `出生点: ${s.zoneName}`, { sides: (s.sides || []).join(',') });
    for (const l of detail.locks || []) push('lock', l.position.x, l.position.z, l.position.y, `钥匙锁: ${l.key?.name} (${l.lockType || 'door'})`, { shortLabel: l.key?.name });
    for (const sw of detail.switches || []) {
      const q = p(sw.position) || p(sw);
      if (q) push('switch', q.x, q.z, q.y, `开关: ${sw.name}`, { shortLabel: sw.name });
    }
    for (const h of detail.hazards || []) {
      const q = p(h.position) || p(h);
      if (q) push('hazard', q.x, q.z, q.y, `危险: ${h.name || h.hazard?.name || ''}`, { shortLabel: h.name || h.hazard?.name });
    }
    for (const lc of detail.lootContainers || []) {
      const name = lc.lootContainer?.name || '物资';
      push('loot:' + (lc.lootContainer?.normalizedName || name), lc.position.x, lc.position.z, lc.position.y, `物资箱: ${name}`, { color: '#facc15', shortLabel: name });
    }
    for (const lc of detail.lootLoose || []) {
      const q = p(lc.position);
      if (!q) continue;
      push('loose', q.x, q.z, q.y, `散落物资${lc.highValue ? ' ★高价值' : ''}`, { color: lc.highValue ? '#fde047' : '#facc15', highValue: !!lc.highValue });
    }
    for (const w of detail.stationaryWeapons || []) push('weapon', w.position.x, w.position.z, w.position.y, `固定武器: ${w.stationaryWeapon?.name}`, { shortLabel: w.stationaryWeapon?.name });
    // BTR 站点（1.1.5.0 灯塔/森林/街区新增；字段为扁平的 x/y/z）
    for (const b of detail.btrStops || []) {
      const q = p(b.position) || p(b);
      if (q) push('btrStop', q.x, q.z, q.y, `BTR站点: ${b.name || b.id}`, { shortLabel: b.name || 'BTR站点', btrId: b.id });
    }
    // 赛季文件刷点（版本活动：在地图上找赛季文件）
    for (const s of this.seasonDocs || []) {
      const t = (this.seasonTypes && this.seasonTypes[s.itemId]) || null;
      const type = t?.type || s.type || s.itemId;
      const zh = t?.name || type;
      const short = t?.shortName || type;
      push(`season:${type}`, s.x, s.z, s.y, `赛季文件: ${zh}（${num(s.x)}, ${num(s.y)}, ${num(s.z)}）`, {
        shortLabel: short,
        seasonType: t || { type, name: zh, shortName: short, icon: `season_${type}.webp`, color: '#f59e0b' },
        seasonImage: s.image || null,
        seasonImageLocal: s.imageLocal || null,
        uuid: s.uuid,
        color: t?.color || '#f59e0b',
      });
    }
    for (const lb of detail.labels || []) {
      const [x, z] = lb.position;
      push('label', x, z, 0, lb.text, { color: 'rgba(255,255,255,0.75)', size: 'label' });
    }
    this.markerCounts = counts;
    return out;
  }

  /** 图例（含动态物资组与赛季文件组）：[{id,label,color,count}] */
  getLegend() {
    if (!this.detail) return [];
    if (!this.markerCache) this.markerCache = this.#buildMarkers();
    const counts = this.markerCounts || {};
    const defs = [];
    // 赛季文件刷点（版本活动，放在最前；每个文件类型一个开关，图标用文件自身图标）
    const season = [];
    for (const key of Object.keys(counts)) {
      if (!key.startsWith('season:')) continue;
      const type = key.slice(7);
      const meta = Object.values(this.seasonTypes || {}).find((t) => t && t.type === type) || null;
      season.push({
        id: key,
        label: meta?.name || type,
        shortLabel: meta?.shortName || type,
        icon: meta?.icon || `season_${type}.webp`,
        color: meta?.color || '#f59e0b',
        count: counts[key],
      });
    }
    if (season.length) {
      const order = Object.values(this.seasonTypes || {}).map((t) => t.type);
      season.sort((a, b) => order.indexOf(a.id.slice(7)) - order.indexOf(b.id.slice(7)));
      defs.push({ id: 'group-season', label: `图例 · 赛季文件刷点${this.seasonNo ? `（赛季 ${this.seasonNo}）` : ''}`, children: season });
    }
    for (const input of ['extract_pmc', 'extract_scav', 'extract_shared', 'transit']) {
      const d = MARKER_GROUPS[input];
      if (counts[input]) defs.push({ id: input, label: d.label, color: d.color, count: counts[input] });
    }
    // 物资容器分类
    const loot = [];
    for (const key of Object.keys(counts)) {
      if (!key.startsWith('loot:')) continue;
      const name = key.slice(5);
      const zh = this.#zhLootName(name);
      loot.push({ id: key, label: zh, color: '#facc15', count: counts[key] });
    }
    defs.push({ id: 'group-loot', label: '图例 · 物资箱', children: loot });
    for (const input of ['boss', 'spawn', 'lock', 'switch', 'hazard', 'btrStop', 'loose', 'weapon', 'label']) {
      const d = MARKER_GROUPS[input];
      if (counts[input]) defs.push({ id: input, label: d.label, color: d.color, count: counts[input] });
    }
    return defs;
  }

  #zhLootName(raw) {
    const map = {
      safe: '保险箱', 'bank-safe': '银行保险箱', jacket: '夹克衫', 'dead-scav': 'Scav尸体', 'dead-civilian': '平民尸体',
      drawer: '抽屉', 'duffle-bag': '旅行包', 'medbag-smu06': '医疗物资', medcase: '医疗箱', crate: '物资箱',
      'weapon-box': '武器箱', toolbox: '工具箱', 'plastic-suitcase': '塑料手提箱', 'cash-register': '收银机',
      'grenade-box': '手雷箱', 'pc-block': '电脑组', 'buried-barrel-cache': '掩埋桶藏点', 'ground-cache': '地面藏点',
      'wooden-crate': '木箱', 'wooden-ammo-box': '木弹药箱', 'pmc-body': 'PMC尸体', 'technical-supply-crate': '技术物资箱',
      'medical-supply-crate': '医疗物资箱', 'ration-supply-crate': '口粮物资箱', 'metal-crate': '金属箱', 'safe-2': '保险箱',
      'rusty-box': '锈铁箱', 'plastic-crate': '塑料箱', 'bodily-cache': '藏匿点', 'сache': '掩埋桶', 'medcase-2': '医疗箱',
    };
    const key = String(raw).toLowerCase().trim().replace(/\s+/g, '-');
    return map[key] || map[String(raw).toLowerCase()] || raw;
  }

  // ------------------------------------------------------------------ Sync
  getViewport() {
    return { cx: this.view.cx, cy: this.view.cy, scale: this.view.scale, rot: this.view.rot };
  }

  setViewport(vp) {
    if (!vp) return;
    this.view.cx = vp.cx; this.view.cy = vp.cy; this.view.scale = vp.scale; this.view.rot = vp.rot || 0;
    this.#renderTransform();
    this.#renderOverlay();
  }

  #emitView() {
    if (this.onViewChange) this.onViewChange(this.getViewport());
  }

  getMapPixelBounds() { return this.px; }
  getProjection() { return this.proj; }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function ns() { return 'http://www.w3.org/2000/svg'; }

/** 坐标格式化（tooltip 用，避免 -0.00 之类） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(1) : '-';
}

function titleNode(text) {
  const t = document.createElementNS(ns(), 'title');
  t.textContent = String(text);
  return t;
}

function textWidth(text, fs) {
  let w = 0;
  for (const ch of String(text)) w += ch.charCodeAt(0) > 255 ? fs : fs * 0.55;
  return Math.max(fs, w);
}

/** 图标下方的中文名标签（深色药丸） */
function labelPill(text, iconSize, fs) {
  const w = textWidth(text, fs);
  const g = document.createElementNS(ns(), 'g');
  const rect = document.createElementNS(ns(), 'rect');
  rect.setAttribute('x', String(-w / 2 - 4));
  rect.setAttribute('y', String(iconSize / 2 + 1));
  rect.setAttribute('width', String(w + 8));
  rect.setAttribute('height', String(fs + 6));
  rect.setAttribute('rx', '3');
  rect.setAttribute('fill', 'rgba(8,11,16,0.72)');
  rect.setAttribute('stroke', 'rgba(255,255,255,0.14)');
  const textEl = document.createElementNS(ns(), 'text');
  textEl.setAttribute('x', '0');
  textEl.setAttribute('y', String(iconSize / 2 + fs + 3.5));
  textEl.setAttribute('text-anchor', 'middle');
  textEl.setAttribute('font-size', String(fs));
  textEl.setAttribute('fill', '#e8edf3');
  textEl.textContent = String(text);
  g.appendChild(rect);
  g.appendChild(textEl);
  return g;
}

// 与主进程 projection.js 相同实现（渲染层独立副本，避免跨进程依赖）
function makeProjection(detail) {
  const [n, r, i, a] = detail.transform || [];
  const rotation = ((detail.coordinateRotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  return {
    project(x, z) {
      const rx = x * cos - z * sin;
      const rz = x * sin + z * cos;
      return { x: rx * n + r, y: rz * -i + a };
    },
    unproject(px, py) {
      const x0 = (px - r) / n, z0 = (py - a) / -i;
      return { x: x0 * cos + z0 * sin, z: -x0 * sin + z0 * cos };
    },
  };
}

function mapPixelBounds(detail, proj) {
  const p = proj || makeProjection(detail);
  const [c1, c2] = detail.bounds;
  const pts = [
    p.project(c1[0], c1[1]), p.project(c1[0], c2[1]),
    p.project(c2[0], c1[1]), p.project(c2[0], c2[1]),
  ];
  const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function headingAngle(detail, quat, proj) {
  if (!detail || !quat || quat.length < 4) return null;
  const [q0, q1, q2, q3] = quat; // x,y,z,w
  const yawDeg = (Math.atan2(2 * (q3 * q1 + q0 * q2), 1 - 2 * (q2 * q2 + q1 * q1)) * 180) / Math.PI;
  const rad = (yawDeg * Math.PI) / 180;
  const dx = Math.sin(rad), dz = Math.cos(rad);
  const p = proj || makeProjection(detail);
  const a = p.project(0, 0), b = p.project(dx, dz);
  const screenAngleDeg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return { yawDeg, screenAngleDeg };
}
