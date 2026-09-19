/**
 * 任务侧边栏的纯逻辑：搜索 / 筛选 / 分组（商人 -> 阶段）。
 *
 * 单独放一个模块是为了能直接单测（不碰 DOM），map.js 只负责画。
 * 数据来自 data/quests-dump.json（tools/fetch-quests.js 生成）。
 */

/** 阶段分档：由前置链深度（stage）归到玩家能理解的进度档位 */
export const STAGE_BUCKETS = [
  { order: 0, label: '起始', min: 0, max: 0 },
  { order: 1, label: '前期', min: 1, max: 2 },
  { order: 2, label: '中期', min: 3, max: 5 },
  { order: 3, label: '后期', min: 6, max: 10 },
  { order: 4, label: '终局', min: 11, max: Infinity },
];

export function stageBucket(stage) {
  const s = Number.isFinite(stage) ? stage : 0;
  for (const b of STAGE_BUCKETS) if (s >= b.min && s <= b.max) return b;
  return STAGE_BUCKETS[STAGE_BUCKETS.length - 1];
}

/** 目标类型 -> 中文 */
export const TYPE_LABELS = {
  visit: '到达',
  shoot: '击杀',
  giveItem: '上交物品',
  giveQuestItem: '上交任务物品',
  findItem: '拾取物品',
  findQuestItem: '拾取任务物品',
  plantItem: '放置物品',
  plantQuestItem: '放置任务物品',
  mark: '标记',
  extract: '撤离',
  buildWeapon: '组装武器',
  useItem: '使用物品',
  experience: '经验',
  skill: '技能',
  traderLevel: '商人等级',
  traderStanding: '商人好感',
  taskStatus: '任务状态',
  globalVariable: '全局变量',
  sellItem: '出售物品',
  dialogue: '对话',
};

export function typeLabel(type) {
  return TYPE_LABELS[type] || type || '目标';
}

/** 目标类型 -> 大类（用于筛选；击杀类的区域是刷怪区，默认不画） */
export function typeGroup(type) {
  switch (type) {
    case 'visit':
    case 'mark':
    case 'plantItem':
    case 'plantQuestItem':
    case 'extract':
      return 'place';
    case 'findItem':
    case 'findQuestItem':
    case 'giveItem':
    case 'giveQuestItem':
    case 'useItem':
    case 'sellItem':
      return 'item';
    case 'shoot':
      return 'kill';
    default:
      return 'other';
  }
}

/** 单个目标在当前地图上是否有可画的东西 */
function objectiveHasLocation(o, mapId) {
  const onMap = (m) => !mapId || m === mapId;
  const zones = (o.zones || []).filter((z) => onMap(z.map));
  const spots = (o.spots || []).filter((s) => onMap(s.map));
  return { zones, spots };
}

/**
 * 汇总一个任务在当前地图上的可画内容。
 * 注意：zones/spots 都带 map 字段，一张图可能有多份（ground-zero 的 PVE/PVP 变体等）。
 */
export function taskLocation(task, mapId, opts = {}) {
  const showKill = Boolean(opts.showKill);
  const zones = [];
  const spots = [];
  const texts = [];
  let totalObjectives = 0;
  for (const o of task.objectives || []) {
    totalObjectives++;
    const group = typeGroup(o.type);
    const hit = objectiveHasLocation(o, mapId);
    if (group === 'kill' && !showKill) {
      // 击杀区默认不画，但目标本身仍要在列表里显示
      continue;
    }
    zones.push(...hit.zones);
    spots.push(...hit.spots);
    for (const z of hit.zones) texts.push({ type: o.type, text: o.text });
    for (const s of hit.spots) texts.push({ type: o.type, text: o.text });
  }
  return { zones, spots, totalObjectives, locatedTexts: texts };
}

/** 任务是否有"可画的地点"（受 showKill 影响） */
export function taskHasLocation(task, mapId, opts = {}) {
  const loc = taskLocation(task, mapId, opts);
  return loc.zones.length > 0 || loc.spots.length > 0;
}

/**
 * 任务在**每张图**上各有多少可画的东西（与当前地图无关）。
 * 用来回答"我勾了这个任务，为什么地图上什么都没有"——因为它的位置在别的图。
 * 击杀类目标按 showKill 决定是否计入（和地图上画的一致）。
 * @returns {Array<{mapId:string, zones:number, spots:number}>} 点多的图在前
 */
export function locationsByMap(task, opts = {}) {
  const showKill = Boolean(opts.showKill);
  const byMap = new Map();
  const bump = (mapId, kind) => {
    if (!mapId) return;
    if (!byMap.has(mapId)) byMap.set(mapId, { mapId, zones: 0, spots: 0 });
    byMap.get(mapId)[kind] += 1;
  };
  for (const o of task.objectives || []) {
    if (typeGroup(o.type) === 'kill' && !showKill) continue;
    for (const z of o.zones || []) bump(z.map, 'zones');
    for (const s of o.spots || []) bump(s.map, 'spots');
  }
  return [...byMap.values()].sort((a, b) => b.zones + b.spots - (a.zones + a.spots) || String(a.mapId).localeCompare(String(b.mapId)));
}

/** 除当前地图外，任务还有哪些图有可画的地点（用于"位置在别的图 · 切过去"提示） */
export function otherMapsWithLocation(task, mapId, opts = {}) {
  return locationsByMap(task, opts).filter((m) => m.mapId !== mapId);
}

function norm(s) {
  return String(s == null ? '' : s).toLowerCase();
}

/** 搜索匹配：名称 / 目标文字 / 商人 / id，空格分词，全部命中才算 */
export function matchesQuery(task, query, trader) {
  const q = norm(query).trim();
  if (!q) return true;
  const hay = [task.name, task.id];
  if (trader) hay.push(trader.name, trader.nickname, trader.slug);
  for (const o of task.objectives || []) hay.push(o.text, typeLabel(o.type));
  const text = norm(hay.join('\n'));
  return q.split(/\s+/).every((tok) => text.includes(tok));
}

/**
 * 过滤任务。
 * opts: { query, traderId, mapId, mapOnly, locationOnly, checkedOnly, checked, showKill, levelMax }
 */
export function filterTasks(tasks, tradersById, opts = {}) {
  const { query = '', traderId = '', mapId = null, mapOnly = true, locationOnly = true, checkedOnly = false, checked = null, showKill = false, levelMax = 0 } = opts;
  const out = [];
  for (const task of tasks) {
    if (traderId && task.trader !== traderId) continue;
    if (levelMax && (task.level || 0) > levelMax) continue;
    if (checkedOnly && !(checked && checked.has(task.id))) continue;
    if (mapOnly && mapId && !(task.maps || []).includes(mapId)) continue;
    const trader = tradersById.get(task.trader);
    if (!matchesQuery(task, query, trader)) continue;
    if (locationOnly && !taskHasLocation(task, mapOnly ? mapId : null, { showKill })) continue;
    out.push(task);
  }
  return out;
}

/**
 * 分组：商人 -> 阶段 -> 任务
 * 返回 [{ trader, count, stages: [{ order, label, tasks }] }]，只含非空分组。
 */
export function groupTasks(tasks, tradersById) {
  const byTrader = new Map();
  for (const t of tasks) {
    const tid = t.trader || '__none__';
    if (!byTrader.has(tid)) byTrader.set(tid, []);
    byTrader.get(tid).push(t);
  }
  const groups = [];
  for (const [tid, list] of byTrader) {
    const trader = tradersById.get(tid) || { id: tid, name: '其他', nickname: '' };
    const byStage = new Map();
    for (const t of list) {
      const b = stageBucket(t.stage);
      if (!byStage.has(b.order)) byStage.set(b.order, { order: b.order, label: b.label, tasks: [] });
      byStage.get(b.order).tasks.push(t);
    }
    const stages = [...byStage.values()].sort((a, b) => a.order - b.order);
    for (const s of stages) {
      s.tasks.sort((a, b) => (a.level || 0) - (b.level || 0) || String(a.name).localeCompare(String(b.name), 'zh'));
    }
    groups.push({ trader, count: list.length, stages });
  }
  groups.sort((a, b) => String(a.trader.name).localeCompare(String(b.trader.name), 'zh'));
  return groups;
}

/** 一行任务的摘要信息（副标题用） */
export function taskSummary(task, mapId, mapsIndex = null, opts = {}) {
  const loc = taskLocation(task, mapId, opts);
  const parts = [];
  if (loc.zones.length) parts.push(`${loc.zones.length} 个地点`);
  if (loc.spots.length) parts.push(`${loc.spots.length} 个刷新点`);
  if (!loc.zones.length && !loc.spots.length) parts.push(`${loc.totalObjectives} 个目标（无地点）`);
  if (mapsIndex && mapId && task.maps) {
    const names = task.maps.map((m) => (mapsIndex[m] && mapsIndex[m].name) || null).filter(Boolean);
    if (names.length) parts.push(names.slice(0, 3).join('/') + (names.length > 3 ? '…' : ''));
  }
  return parts.join(' · ');
}
