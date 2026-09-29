'use strict';

/**
 * 设置面板的「即时生效」映射表 + 取值规则（纯函数，便于单测）。
 *
 * 背景：设置页里没有「保存 / 取消」了 —— 拖一下滑块、勾一个开关**立刻**生效，
 * 于是"某个控件没接上线"就变成"这个设置点了没反应"，而且没有任何提示。
 * 所以这里做一张**唯一的**控件 -> 配置字段映射表，由 tools 里的静态检查保证
 * 设置页的每个 `#set-*` 控件都在这张表里（漏一个就测试失败）。
 *
 * 事件的选择（由控件类型决定，见 liveEventFor）：
 *   - 滑块 / 复选框 / 下拉框：input（拖动过程中就要实时变化）
 *   - 文本框 / 数字框：change（失焦或回车才落盘 —— 目录每敲一个字就重启监听会把
 *     "进图自动切图"搞坏，这是踩过的坑）
 */

/** 取值方式：bool 勾选 | num 数值 | int 整数 | str 去空白文本 | raw 原样文本（口令） */
export const LIVE_KINDS = ['bool', 'num', 'int', 'str', 'raw'];

export const LIVE_FIELDS = [
  // ---- 目录（文本：失焦/回车生效）----
  { sel: '#set-logs', path: 'logsPath', kind: 'str' },
  { sel: '#set-shots', path: 'screenshotsPath', kind: 'str' },
  // ---- 定位与显示 ----
  { sel: '#set-auto-zoom', path: 'autoZoom', kind: 'bool' },
  { sel: '#set-auto-center', path: 'autoCenter', kind: 'bool' },
  { sel: '#set-all-markers', path: 'showAllMarkers', kind: 'bool' },
  { sel: '#set-auto-floor', path: 'autoFloor', kind: 'bool' },
  { sel: '#set-map-opacity', path: 'mapOpacity', kind: 'num', min: 0.2, max: 1, fallback: 1 },
  { sel: '#set-marker-scale', path: 'markerScale', kind: 'num', min: 0.5, max: 2, fallback: 1 },
  { sel: '#set-label-scale', path: 'labelScale', kind: 'num', min: 0.8, max: 2.5, fallback: 1 },
  // ---- 任务标记 ----
  { sel: '#set-quest-opacity', path: 'quests.opacity', kind: 'num', min: 0.05, max: 0.6, fallback: 0.25 },
  { sel: '#set-quest-auto-open', path: 'quests.autoOpen', kind: 'bool' },
  // ---- 提示与行为 ----
  { sel: '#set-sound', path: 'sound', kind: 'bool' },
  { sel: '#set-alert-lead', path: 'alertLeadSec', kind: 'int', min: 1, max: 10, fallback: 3 },
  { sel: '#set-auto-delete', path: 'autoDeleteScreenshots', kind: 'bool' },
  // ---- 圆形小地图雷达（大小/透明度/半径都是实时变化的主力）----
  { sel: '#set-mini', path: 'miniVisible', kind: 'bool' },
  { sel: '#set-mini-opacity', path: 'miniOpacity', kind: 'num', min: 0.2, max: 1, fallback: 0.9 },
  { sel: '#set-mini-size', path: 'miniSize', kind: 'int', min: 180, max: 560, fallback: 300 },
  { sel: '#set-mini-radius', path: 'miniRadius', kind: 'num', min: 20, max: 200, fallback: 55 },
  { sel: '#set-mini-rotate', path: 'miniRotate', kind: 'bool' },
  { sel: '#set-mini-auto-center', path: 'miniAutoCenter', kind: 'bool' },
  { sel: '#set-mini-auto-floor', path: 'miniAutoFloor', kind: 'bool' },
  { sel: '#set-mini-click-through', path: 'miniClickThrough', kind: 'bool' },
  { sel: '#set-mini-follow', path: 'miniFollowMainZoom', kind: 'bool' },
  { sel: '#set-mini-annos', path: 'miniAnnos', kind: 'str' },
  // ---- 自动截图 ----
  { sel: '#set-autoshot', path: 'autoShot.enabled', kind: 'bool' },
  { sel: '#set-autoshot-interval', path: 'autoShot.intervalSec', kind: 'int', min: 5, max: 600, fallback: 30 },
  { sel: '#set-autoshot-key', path: 'autoShot.key', kind: 'str' },
  // ---- 房间（联机）----
  { sel: '#set-room-enabled', path: 'room.enabled', kind: 'bool' },
  { sel: '#set-room-url', path: 'room.url', kind: 'str' },
  { sel: '#set-room-port', path: 'room.port', kind: 'int', min: 1, max: 65535, fallback: 8787 },
  { sel: '#set-room-id', path: 'room.roomId', kind: 'str' },
  { sel: '#set-room-pass', path: 'room.pass', kind: 'raw' },
  { sel: '#set-room-nick', path: 'room.nick', kind: 'str' },
  { sel: '#set-room-pos', path: 'room.sharePos', kind: 'bool' },
  { sel: '#set-room-anno', path: 'room.shareAnno', kind: 'bool' },
  { sel: '#set-room-quests', path: 'room.shareQuests', kind: 'bool' },
];

/** 设置页里"只做事、不写配置"的控件（选了目录、打开文件夹、按下按键捕获…） */
export const LIVE_ACTIONS = [
  '#set-logs-pick', '#set-logs-open', '#set-shots-pick', '#set-shots-open',
  '#set-autoshot-capture', '#settings-about', '#settings-close',
  '#room-test', '#room-connect', '#room-disconnect',
];

/** 一个控件该在哪个事件上即时生效 */
export function liveEventFor(el) {
  const type = String((el && el.type) || '').toLowerCase();
  if (type === 'range' || type === 'checkbox') return 'input';
  if (el && String(el.tagName || '').toUpperCase() === 'SELECT') return 'input';
  return 'change';
}

/** 按 kind 把控件里的值读成配置值（数值一律夹到 min~max，空值回 fallback） */
export function readLiveValue(field, el) {
  const kind = field.kind || 'str';
  const raw = el ? el.value : '';
  if (kind === 'bool') return !!(el && el.checked);
  if (kind === 'str') return String(raw == null ? '' : raw).trim();
  if (kind === 'raw') return String(raw == null ? '' : raw);
  // 数字框被清空时 Number('') === 0，那是"合法数字"，会悄悄把设置改成 0/下限；
  // 所以空字符串要当成"没填" -> 回退到 fallback
  const text = String(raw == null ? '' : raw).trim();
  let n = text === '' ? NaN : Number(text);
  if (!Number.isFinite(n)) n = field.fallback != null ? field.fallback : 0;
  if (kind === 'int') n = Math.round(n);
  if (field.min != null) n = Math.max(field.min, n);
  if (field.max != null) n = Math.min(field.max, n);
  return n;
}

/** 把 'a.b.c' 写进对象（返回新对象；中间层也复制一份，不做原地修改） */
export function setPath(target, path, value) {
  const parts = String(path).split('.');
  const out = { ...(target || {}) };
  let cur = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const next = cur[k];
    cur[k] = next && typeof next === 'object' ? { ...next } : {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return out;
}

/** 一个控件 -> 一份配置补丁（给主进程 config:set 用） */
export function patchFor(field, el) {
  return setPath({}, field.path, readLiveValue(field, el));
}

/** 按控件选择器找映射（找不到返回 null） */
export function fieldOf(sel) {
  return LIVE_FIELDS.find((f) => f.sel === sel) || null;
}
