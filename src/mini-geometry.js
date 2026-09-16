'use strict';

/**
 * 小地图悬浮窗的几何计算（纯函数，便于单测）
 *
 * 拖动实现：渲染层按下时告知主进程 -> 主进程记录"光标到窗口原点的偏移"，
 * 之后按固定频率读取真实光标位置并 setPosition(光标 - 偏移)。
 * 用主进程轮询而不是渲染层 mousemove：指针移出小窗口（甚至移出屏幕）也不会丢事件。
 */

const KEEP_VISIBLE = 80; // 至少保留 80px 在屏幕内，避免窗口被拖到看不见的地方

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

module.exports = { clampToWorkArea, dragTarget, defaultPos, KEEP_VISIBLE };
