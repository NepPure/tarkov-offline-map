'use strict';

/**
 * 小地图悬浮窗的几何计算（纯函数，便于单测）
 *
 * 拖动实现：渲染层按下时告知主进程 -> 主进程记录"光标到窗口原点的偏移"，
 * 之后按固定频率读取真实光标位置并 setPosition(光标 - 偏移)。
 * 用主进程轮询而不是渲染层 mousemove：指针移出小窗口（甚至移出屏幕）也不会丢事件。
 */

const KEEP_VISIBLE = 80; // 至少保留 80px 在屏幕内，避免窗口被拖到看不见的地方

// 雷达窗口边长（DIP）：默认 300，可用设置里的滑块在 180~560 之间调
const MINI_SIZE_DEFAULT = 300;
const MINI_SIZE_MIN = 180;
const MINI_SIZE_MAX = 560;

/**
 * 雷达窗口边长：认不出来（老配置 / 手改坏）一律回默认，并夹到可用范围。
 * 上下限和设置页滑块的范围一致（renderer/map.html#set-mini-size）。
 */
function clampMiniSize(v, def = MINI_SIZE_DEFAULT, min = MINI_SIZE_MIN, max = MINI_SIZE_MAX) {
  // null/undefined/空串 = "没有这个设置" -> 默认值（注意 Number('') === 0，不能直接 Number）
  if (v == null || String(v).trim() === '') return def;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/**
 * 改尺寸时以**圆盘中心**为基准（用户正盯着的那块地图不动），再钳进工作区。
 * 不用"左上角锚定"是因为雷达通常贴在游戏画面的某个角落，从中心扩/缩最不跳。
 */
function resizeAroundCenter(bounds, size, workArea, keep = KEEP_VISIBLE) {
  const b = bounds || {};
  const w = Number.isFinite(Number(b.width)) ? Number(b.width) : size;
  const h = Number.isFinite(Number(b.height)) ? Number(b.height) : size;
  const cx = (Number(b.x) || 0) + w / 2;
  const cy = (Number(b.y) || 0) + h / 2;
  return clampToWorkArea(cx - size / 2, cy - size / 2, size, workArea, keep);
}

/** 把窗口原点钳制到工作区内（至少保留 KEEP_VISIBLE 像素可见） */
function clampToWorkArea(x, y, size, workArea, keep = KEEP_VISIBLE) {
  const wa = workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  const minX = wa.x - size + keep;
  const maxX = wa.x + wa.width - keep;
  const minY = wa.y;
  const maxY = wa.y + wa.height - keep;
  return {
    x: Math.round(Math.min(Math.max(x, minX), maxX)),
    y: Math.round(Math.min(Math.max(y, minY), maxY)),
  };
}

/** 拖动中的目标位置：光标位置 - 按下时记录的偏移 */
function dragTarget(cursor, offset, size, workArea) {
  return clampToWorkArea(cursor.x - offset.x, cursor.y - offset.y, size, workArea);
}

/** 默认位置：主显示器右上角 */
function defaultPos(size, workArea, margin = 24) {
  const wa = workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  return clampToWorkArea(wa.x + wa.width - size - margin, wa.y + margin, size, wa);
}

module.exports = {
  clampToWorkArea, dragTarget, defaultPos, KEEP_VISIBLE,
  clampMiniSize, resizeAroundCenter, MINI_SIZE_DEFAULT, MINI_SIZE_MIN, MINI_SIZE_MAX,
};
