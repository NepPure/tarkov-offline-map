'use strict';

/**
 * 坐标投影（复刻原站投影数学，保证与线上版完全一致）
 *
 * 世界坐标: (x, z) 为水平面, y 为高度（截图文件名第二位）。
 * transform = [scaleX, offsetX, scaleY, offsetY]，coordinateRotation 为度。
 *
 * project(x, z) -> {x: px, y: py} 地图像素坐标（SVG viewBox 空间）。
 * 瓦片（卫星图）模式下每级缩放再乘 2^zoom。
 */

/**
 * 计算投影信息 bounds（用于视图范围）
 */
function makeProjection(detail) {
  const [n, r, i, a] = detail.transform || [];
  const rotation = (detail.coordinateRotation || 0) * Math.PI / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    rotation,
    transform: [n, r, i, a],
    project(x, z) {
      const rx = x * cos - z * sin;
      const rz = x * sin + z * cos;
      return { x: rx * n + r, y: rz * -i + a };
    },
    unproject(px, py) {
      const x0 = (px - r) / n;
      const z0 = (py - a) / -i;
      return { x: x0 * cos + z0 * sin, z: -x0 * sin + z0 * cos };
    },
  };
}

/**
 * 计算地图像素范围（SVG viewBox 即此范围）
 */
function mapPixelBounds(detail, proj) {
  const p = proj || makeProjection(detail);
  const [c1, c2] = detail.bounds;
  const pts = [
    p.project(c1[0], c1[1]),
    p.project(c1[0], c2[1]),
    p.project(c2[0], c1[1]),
    p.project(c2[0], c2[1]),
  ];
  const xs = pts.map((pt) => pt.x);
  const ys = pts.map((pt) => pt.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/**
 * 四元数 -> 欧拉角 [yaw(deg), pitch(deg), roll(deg)]（原站 Xpe 公式）
 * 输入 [x, y, z, w]
 */
function quaternionToEuler(q) {
  const t = q[0], n = q[1], r = q[2], i = q[3];
  const roll = Math.atan2(2 * (i * t + r * n), 1 - 2 * (t * t + r * r));
  const pitch = Math.asin(Math.max(Math.min(2 * (i * r - n * t), 1), -1));
  const yaw = Math.atan2(2 * (i * n + t * r), 1 - 2 * (r * r + n * n));
  return [yaw * 180 / Math.PI, pitch * 180 / Math.PI, roll * 180 / Math.PI];
}

/**
 * 求朝向对应的（世界水平面）方向向量与屏幕角度
 * 原站逻辑：heading = (sin(yaw), cos(yaw))，再把 (x,z) 与 (x+dx, z+dz) 分别投影，
 * 用投影后像素差算屏幕角度 —— 自动兼容 coordinateRotation。
 *
 * 返回 { worldDx, worldDz, screenAngleDeg }；screenAngle 0° = 屏幕右方，顺时针为正（SVG 坐标 y 向下）。
 */
function headingScreenAngle(detail, quaternion, proj) {
  if (!detail || !quaternion || quaternion.length < 4) return null;
  const yawDeg = quaternionToEuler(quaternion)[0];
  const rad = (yawDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dz = Math.cos(rad);
  const p = proj || makeProjection(detail);
  const a = p.project(0, 0);
  const b = p.project(dx, dz);
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const angle = (Math.atan2(sy, sx) * 180) / Math.PI;
  return { worldDx: dx, worldDz: dz, screenAngleDeg: angle };
}

module.exports = { makeProjection, mapPixelBounds, quaternionToEuler, headingScreenAngle };
