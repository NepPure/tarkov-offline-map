'use strict';

/**
 * 手动标注：存储清洗 + 命中判定几何。
 *
 * 回归重点：
 *  1) 坏数据（非法 kind / 颜色 / NaN 坐标 / 超长）不能进渲染层
 *  2) 橡皮的命中判定（点到线段距离 / 点在多边形内）要对
 *  3) 世界坐标 -> 屏幕的往返在带旋转的地图上也要成立
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ann = require('../src/annotations.js');

test('标注存储：清洗掉非法数据', () => {
  const raw = {
    customs: [
      { kind: 'pen', color: '#F87171', width: 4, pts: [{ x: 1, z: 2 }, { x: 3.456, z: 4.444 }] },
      { kind: 'teleport', color: '#fff', width: 4, pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] }, // 非法 kind
      { kind: 'pen', color: 'red', width: 999, pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] },       // 非法颜色 + 超宽
      { kind: 'pen', color: '#000000', width: 2, pts: [{ x: NaN, z: 2 }, { x: 3, z: 4 }] },  // NaN 坐标
      { kind: 'ellipse', color: '#000000', width: 2, pts: [{ x: 5, z: 5 }] },                // 点太少
      { kind: 'circle', color: '#000000', width: 2, pts: [{ x: 5, z: 5 }, { x: 6, z: 6 }] }, // 老 kind 彻底不认
      { kind: 'ellipse', color: '#000000', width: 2, pts: [{ x: 7, z: 7 }, { x: 8, z: 8 }] }, // 新的椭圆：要留下
      { kind: 'pen', color: '#000000', width: 2, pts: [{ x: 9, z: 9 }, { x: 9, z: 9 }] },
    ],
    '': [{ kind: 'pen', color: '#000000', width: 2, pts: [{ x: 1, z: 1 }, { x: 2, z: 2 }] }], // 空 mapId
    broken: 'not-an-array',
  };
  const clean = ann.sanitize(raw);
  assert.deepStrictEqual(Object.keys(clean), ['customs']);
  // 合法的是：原始第 1 笔、颜色/宽度被修正的第 3 笔、椭圆那笔、最后一笔（NaN 那笔点数不足被丢）
  assert.strictEqual(clean.customs.length, 4);
  assert.strictEqual(clean.customs.filter((s) => s.kind === 'ellipse').length, 1, '椭圆要保留');
  assert.strictEqual(clean.customs.some((s) => s.kind === 'circle'), false, '老 circle 不再被接受');
  // 颜色小写化、坐标四舍五入到两位
  assert.strictEqual(clean.customs[0].color, '#f87171');
  assert.deepStrictEqual(clean.customs[0].pts[1], { x: 3.46, z: 4.44 });
  // 非法颜色回退、宽度钳制到 20
  assert.strictEqual(clean.customs[1].color, '#f87171');
  assert.strictEqual(clean.customs[1].width, 20);
  // NaN 点被剔除后点数不足 -> 整笔丢掉
  assert.strictEqual(clean.customs.some((s) => s.kind === 'pen' && s.pts.length < 2), false);
});

test('标注存储：单笔点数与每图笔数有上限', () => {
  const many = Array.from({ length: ann.MAX_STROKES_PER_MAP + 20 }, () => ({
    kind: 'line', color: '#ffffff', width: 3, pts: [{ x: 1, z: 1 }, { x: 2, z: 2 }],
  }));
  const clean = ann.sanitize({ customs: many });
  assert.strictEqual(clean.customs.length, ann.MAX_STROKES_PER_MAP);

  const long = Array.from({ length: ann.MAX_POINTS_PER_STROKE + 50 }, (_, i) => ({ x: i, z: i }));
  const clean2 = ann.sanitize({ customs: [{ kind: 'pen', color: '#ffffff', width: 3, pts: long }] });
  assert.strictEqual(clean2.customs[0].pts.length, ann.MAX_POINTS_PER_STROKE);
});

test('标注存储：写盘 / 读回一致（含每笔的 id）', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anno-')), 'annotations.json');
  const data = { customs: [{ kind: 'rect', color: '#38bdf8', width: 6, pts: [{ x: 10, z: 20 }, { x: 30, z: 40 }] }] };
  ann.set(data);
  const assigned = ann.get();
  // v2.0：每笔都会拿到一个稳定 id（房间联机靠它做增删同步与 owner 校验）
  assert.match(assigned.customs[0].id, ann.ID_RE);
  assert.ok(ann.save(file));
  ann.load(file);
  assert.deepStrictEqual(ann.get(), assigned, '读回来的 id 必须一模一样');
  assert.deepStrictEqual(ann.stats(), { maps: 1, strokes: 1, points: 2 });

  // 文件里已经带 id 的不能被换掉
  const keep = ann.sanitize({ customs: [{ id: 'abc123', kind: 'pen', color: '#ffffff', width: 2, pts: [{ x: 1, z: 1 }, { x: 2, z: 2 }] }] });
  assert.strictEqual(keep.customs[0].id, 'abc123');
  // 非法 id（会被当成键用过）要重新分配
  const fixed = ann.sanitize({ customs: [{ id: '../../etc', kind: 'pen', color: '#ffffff', width: 2, pts: [{ x: 1, z: 1 }, { x: 2, z: 2 }] }] });
  assert.match(fixed.customs[0].id, ann.ID_RE);
  // 同一张图里两笔不能撞 id（不然删一笔会把另一笔也删了）
  const two = ann.sanitize({ customs: [
    { kind: 'pen', color: '#ffffff', width: 2, pts: [{ x: 1, z: 1 }, { x: 2, z: 2 }] },
    { kind: 'pen', color: '#ffffff', width: 2, pts: [{ x: 3, z: 3 }, { x: 4, z: 4 }] },
  ] });
  assert.notStrictEqual(two.customs[0].id, two.customs[1].id);

  // 文件坏掉时不能抛，退化成空
  fs.writeFileSync(file, '{ 这不是 json');
  ann.load(file);
  assert.deepStrictEqual(ann.get(), {});
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('命中判定：点到线段距离 / 折线距离 / 多边形内部', () => {
  return (async () => {
    const { distToSegment, polylineHitDistance, pointInPolygon, clampAnnoWidth } = await import('../renderer/common/map-view.js');

    assert.strictEqual(distToSegment(0, 0, -5, 0, 5, 0), 0);
    assert.strictEqual(distToSegment(0, 3, -5, 0, 5, 0), 3);
    assert.strictEqual(distToSegment(9, 0, -5, 0, 5, 0), 4);
    // 退化成一个点时按点距算
    assert.strictEqual(distToSegment(3, 4, 0, 0, 0, 0), 5);

    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    assert.strictEqual(polylineHitDistance(line, 5, 2), 2);
    assert.strictEqual(polylineHitDistance(line, 12, 5), 2);
    assert.ok(polylineHitDistance(line, 5, 5) > 4);          // 折线内部（没闭合）不算命中
    // 闭合后 (5,5) 正好落在收尾那条斜边上 -> 判定为命中
    assert.ok(polylineHitDistance(line, 5, 5, true) < 0.001);

    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    assert.strictEqual(pointInPolygon(square, 5, 5), true);
    assert.strictEqual(pointInPolygon(square, 15, 5), false);
    assert.strictEqual(pointInPolygon(square, -1, 5), false);

    assert.strictEqual(clampAnnoWidth(0), 1);
    assert.strictEqual(clampAnnoWidth(999), 20);
    assert.strictEqual(clampAnnoWidth('abc'), 4);
  })();
});

test('椭圆：对角拖拽 = 内接椭圆；Shift = 正圆', () => {
  return (async () => {
    const { annoEllipseFromCorners, squareCorner } = await import('../renderer/common/map-view.js');

    // 拖拽的两个角就是外接矩形的对角：圆心 = 中点，两半径 = 边长一半
    const e = annoEllipseFromCorners({ x: 10, z: 20 }, { x: 30, z: 50 });
    assert.deepStrictEqual(e, { cx: 20, cz: 35, rx: 10, rz: 15 });
    // 反着拖（右下 -> 左上）结果一样
    assert.deepStrictEqual(annoEllipseFromCorners({ x: 30, z: 50 }, { x: 10, z: 20 }), e);
    // 退化：同一个点 -> 半径为 0（渲染成一点，不会崩）
    assert.deepStrictEqual(annoEllipseFromCorners({ x: 1, z: 2 }, { x: 1, z: 2 }), { cx: 1, cz: 2, rx: 0, rz: 0 });

    // Shift：取两条边里较长的那条当边长，方向沿用拖拽方向 -> 宽高相等（屏幕上是正圆）
    assert.deepStrictEqual(squareCorner({ x: 0, z: 0 }, { x: 30, z: 10 }), { x: 30, z: 30 });
    assert.deepStrictEqual(squareCorner({ x: 0, z: 0 }, { x: 10, z: 30 }), { x: 30, z: 30 });
    // 四个方向的符号都要对
    assert.deepStrictEqual(squareCorner({ x: 0, z: 0 }, { x: -30, z: 10 }), { x: -30, z: 30 });
    assert.deepStrictEqual(squareCorner({ x: 0, z: 0 }, { x: -10, z: -30 }), { x: -30, z: -30 });
    // 正方形再约束还是自己
    assert.deepStrictEqual(squareCorner({ x: 5, z: 5 }, { x: 15, z: 15 }), { x: 15, z: 15 });
    // 约束后的包围盒确实等边（世界坐标等边 -> 投影后仍是正圆：投影是旋转 + 等比缩放）
    const sq = squareCorner({ x: 4, z: -7 }, { x: 20, z: 2 });
    const box = annoEllipseFromCorners({ x: 4, z: -7 }, sq);
    assert.strictEqual(box.rx, box.rz);
  })();
});

test('标注工具条：常驻顶栏、有「取消」退出按钮、没有多余的提示行', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'map.html'), 'utf-8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'map.js'), 'utf-8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'map.css'), 'utf-8');

  // 工具条在顶栏里（第二行），七个工具齐全
  assert.match(html, /<header class="topbar">[\s\S]*?id="anno-bar"[\s\S]*?<\/header>/);
  for (const tool of ['pen', 'path', 'line', 'arrow', 'ellipse', 'rect', 'erase']) {
    assert.ok(html.includes(`data-tool="${tool}"`), `缺少工具 ${tool}`);
  }
  // 「取消」按钮存在、默认禁用（没进标注模式时没意义），由 JS 按模式启用
  assert.match(html, /<button id="anno-cancel"[^>]*disabled>取消<\/button>/, '缺少 #anno-cancel（取消）按钮');
  assert.ok(js.includes("$('#anno-cancel').addEventListener"), '「取消」按钮没接上');
  assert.ok(js.includes("$('#anno-cancel').disabled = !mode"), '「取消」要跟着标注模式启用/禁用');
  assert.ok(js.includes('view.setDrawMode(null)'), '「取消」应该是退出标注模式');

  // 用户明确要求：不要那行说明文字
  assert.ok(!html.includes('anno-hint'), '提示行应该已经删掉');
  assert.ok(!js.includes('ANNO_HINTS'), 'ANNO_HINTS 应该已经删掉（提示改回各按钮的 title）');
  assert.ok(!css.includes('.anno-hint'), 'CSS 里的 .anno-hint 应该已经删掉');
  // 每个工具自己的说明留在 title（悬停能看到）
  assert.match(html, /data-tool="ellipse" title="[^"]*Shift[^"]*"/, '椭圆按钮的 title 要写清 Shift = 正圆');
});
