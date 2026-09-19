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
      { kind: 'circle', color: '#000000', width: 2, pts: [{ x: 5, z: 5 }] },                 // 点太少
      { kind: 'pen', color: '#000000', width: 2, pts: [{ x: 9, z: 9 }, { x: 9, z: 9 }] },
    ],
    '': [{ kind: 'pen', color: '#000000', width: 2, pts: [{ x: 1, z: 1 }, { x: 2, z: 2 }] }], // 空 mapId
    broken: 'not-an-array',
  };
  const clean = ann.sanitize(raw);
  assert.deepStrictEqual(Object.keys(clean), ['customs']);
  // 合法的是：原始第 1 笔、颜色/宽度被修正的第 3 笔、最后一笔（NaN 那笔点数不足被丢）
  assert.strictEqual(clean.customs.length, 3);
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
