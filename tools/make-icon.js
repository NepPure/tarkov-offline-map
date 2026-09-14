#!/usr/bin/env node
/**
 * 生成应用图标 build/icon.png (512x512)
 * 纯 Node 实现（zlib + 手写 PNG/CRC），不依赖任何第三方库。
 * 用法: node tools/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

// ---------------------------------------------------------------- 画布
const px = new Uint8Array(SIZE * SIZE * 4); // RGBA

function setPx(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const sa = a / 255;
  px[i] = px[i] * (1 - sa) + r * sa;
  px[i + 1] = px[i + 1] * (1 - sa) + g * sa;
  px[i + 2] = px[i + 2] * (1 - sa) + b * sa;
  px[i + 3] = Math.min(255, px[i + 3] + a);
}

/** 圆角矩形（含 2x2 超采样抗锯齿） */
function roundRect(x0, y0, w, h, rad, color, alpha = 255) {
  const [r, g, b] = color;
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x++) {
      let hit = 0;
      for (const oy of [0.25, 0.75]) {
        for (const ox of [0.25, 0.75]) {
          const fx = x + ox, fy = y + oy;
          if (fx < x0 || fy < y0 || fx > x0 + w || fy > y0 + h) continue;
          const dx = Math.max(x0 + rad - fx, fx - (x0 + w - rad), 0);
          const dy = Math.max(y0 + rad - fy, fy - (y0 + h - rad), 0);
          if (Math.hypot(dx, dy) <= rad) hit++;
        }
      }
      if (hit > 0) setPx(x, y, r, g, b, (alpha * hit) / 4);
    }
  }
}

/** 圆 */
function circle(cx, cy, rad, color, alpha = 255) {
  const [r, g, b] = color;
  const d = rad + 1;
  for (let y = Math.floor(cy - d); y <= cy + d; y++) {
    for (let x = Math.floor(cx - d); x <= cx + d; x++) {
      let hit = 0;
      for (const oy of [0.25, 0.75]) {
        for (const ox of [0.25, 0.75]) {
          if (Math.hypot(x + ox - cx, y + oy - cy) <= rad) hit++;
        }
      }
      if (hit > 0) setPx(x, y, r, g, b, (alpha * hit) / 4);
    }
  }
}

/** 线段（粗线，矩形填充） */
function line(x1, y1, x2, y2, width, color, alpha = 255) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    circle(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, color, alpha);
  }
}

// ---------------------------------------------------------------- 图形
const BG = [11, 14, 19];
const PANEL = [22, 28, 38];
const GRID = [46, 58, 74];
const CYAN = [34, 211, 238];
const GREEN = [74, 222, 128];
const YELLOW = [250, 204, 21];

// 圆角底板
roundRect(16, 16, SIZE - 32, SIZE - 32, 96, BG, 255);
roundRect(40, 40, SIZE - 80, SIZE - 80, 72, PANEL, 255);

// 地图网格（像地图底图）
for (let i = 1; i <= 4; i++) {
  const p = 40 + ((SIZE - 80) / 5) * i;
  line(p, 60, p, SIZE - 60, 6, GRID, 150);
  line(60, p, SIZE - 60, p, 6, GRID, 150);
}

// 建筑块（抽象地图轮廓）
roundRect(96, 300, 130, 130, 14, [58, 70, 86], 255);
roundRect(250, 320, 90, 110, 12, [58, 70, 86], 255);
roundRect(150, 150, 100, 90, 12, [58, 70, 86], 255);
roundRect(300, 170, 120, 100, 12, [58, 70, 86], 255);

// 定位图钉（主体圆 + 尖端）
const pinX = 250, pinY = 250, pinR = 62;
circle(pinX, pinY, pinR, CYAN, 255);
// 尖端三角
for (let y = 0; y < 90; y++) {
  const half = Math.max(0, (1 - y / 90) * 46);
  for (let x = -half; x <= half; x++) setPx(Math.round(pinX + x), Math.round(pinY + pinR * 0.35 + y), 34, 211, 238, 255);
}
// 中心孔
circle(pinX, pinY - 6, 24, PANEL, 255);

// 点缀：撤离点绿点 + 物资黄点
circle(140, 210, 16, GREEN, 255);
circle(366, 420, 16, YELLOW, 255);
circle(390, 200, 12, YELLOW, 255);

// ---------------------------------------------------------------- PNG 编码
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log('icon written:', OUT, png.length, 'bytes');
