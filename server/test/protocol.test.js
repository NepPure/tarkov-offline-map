'use strict';

/**
 * 房间服务端：协议层的纯函数测试 + 与客户端 src/room-key.js 的交叉校验。
 * 这些用例不需要网络，跑得飞快。
 */
const test = require('node:test');
const assert = require('node:assert');

const P = require('../protocol.js');
const clientKey = require('../../src/room-key.js');

test('协议版本与上限：改这些数字会让老客户端连不上，必须是显式决定', () => {
  assert.strictEqual(P.PROTO, 2);
  assert.strictEqual(P.LIMITS.FRAME_MAX, 64 * 1024);
  assert.ok(P.LIMITS.TRAIL_MAX >= 100, '轨迹尾巴至少留 100 个点，不然画不出路线');
  assert.ok(P.LIMITS.STROKES_PER_MAP >= 100);
});

test('房间号推导：客户端与服务端两份实现必须完全一致', () => {
  const cases = [
    ['123456', ''],
    ['123456', 'pw'],
    ['中文房间', '密码'],
    [' 前后有空格 ', ''],
    ['a-b_c.d', 'x'],
  ];
  for (const [id, pass] of cases) {
    assert.strictEqual(P.roomKey(id, pass), clientKey.roomKey(id, pass), `roomKey(${id},${pass}) 两份实现不一致`);
  }
  // 32 位十六进制
  assert.match(P.roomKey('123456', ''), /^[0-9a-f]{32}$/);
  // 口令不同 -> 房间不同（房间号即暗号，口令只是加一层）
  assert.notStrictEqual(P.roomKey('123456', 'a'), P.roomKey('123456', 'b'));
  // 空房间号 -> 空串（调用方据此判定"没填"）
  assert.strictEqual(P.roomKey('   ', ''), '');
  assert.strictEqual(P.roomKey(null, ''), '');
  // 交叉校验的另一半：客户端也要认服务端的房间标识
  assert.ok(clientKey.isRoomKey(P.roomKey('abc', '')));
});

test('房间标识校验：非十六进制 / 太短 / 太长都拒', () => {
  assert.strictEqual(P.normRoomKey(P.roomKey('abc')), P.roomKey('abc'));
  assert.strictEqual(P.normRoomKey('ABCDEF0123456789'), 'abcdef0123456789'); // 大小写归一
  assert.strictEqual(P.normRoomKey('xyz'), null);
  assert.strictEqual(P.normRoomKey('a'.repeat(65)), null);
  assert.strictEqual(P.normRoomKey(''), null);
  assert.strictEqual(P.normRoomKey(null), null);
});

test('昵称：去控制字符、压缩空白、按码点截断、空则兜底', () => {
  assert.strictEqual(P.normNick('  小明  '), '小明');
  assert.strictEqual(P.normNick('a\u0000b\nc'), 'abc');
  assert.strictEqual(P.normNick(''), '玩家');
  assert.strictEqual(P.normNick(null), '玩家');
  assert.strictEqual(P.normNick('一二三四五六七八九十一二三四五六七八'), '一二三四五六七八九十一二三四五六');
  // emoji 不能被劈成半个（按码点截断）
  assert.strictEqual(P.normNick('😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'), '😀'.repeat(16));
});

test('帧解析：超长 / 非 JSON / 数组 / 缺 t 都拒', () => {
  assert.deepStrictEqual(P.parseFrame(JSON.stringify({ t: 'ping' })), { ok: true, data: { t: 'ping' } });
  assert.strictEqual(P.parseFrame('not json').code, 'bad-json');
  assert.strictEqual(P.parseFrame('[1,2]').code, 'bad-json');
  assert.strictEqual(P.parseFrame(JSON.stringify({ a: 1 })).code, 'bad-json');
  assert.strictEqual(P.parseFrame(JSON.stringify({ t: 'x'.repeat(30) })).code, 'bad-json');
  const big = JSON.stringify({ t: 'pos', pad: 'x'.repeat(P.LIMITS.FRAME_MAX) });
  assert.strictEqual(P.parseFrame(big).code, 'too-large');
});

test('位置归一化：只认 finite 数值，轨迹裁到上限，单点不发', () => {
  const now = 1700000000000;
  const pos = P.sanitizePos({
    map: 'woods',
    x: 1.234,
    z: 2.3456,
    y: 3.999,
    hdg: 90.5,
    trail: Array.from({ length: 250 }, (_, i) => ({ x: i, z: i * 2 })),
  }, now);
  assert.strictEqual(pos.map, 'woods');
  assert.strictEqual(pos.x, 1.23);
  assert.strictEqual(pos.z, 2.35);
  assert.strictEqual(pos.y, 4);
  assert.strictEqual(pos.hdg, 90.5);
  assert.strictEqual(pos.ts, now, '没带时间戳就用服务端时间');
  assert.strictEqual(pos.trail.length, P.LIMITS.TRAIL_MAX, '轨迹要裁到上限（保留的是末尾 200 个）');
  assert.strictEqual(pos.trail[0].x, 50);

  // 单点轨迹画不出线，直接不带
  assert.strictEqual(P.sanitizePos({ map: 'woods', x: 1, z: 2, trail: [{ x: 1, z: 2 }] }).trail, undefined);
  // 坏数据
  assert.strictEqual(P.sanitizePos({ map: 'woods', x: 'NaN', z: 2 }), null);
  assert.strictEqual(P.sanitizePos({ map: '', x: 1, z: 2 }), null);
  assert.strictEqual(P.sanitizePos({ map: 'woods', x: 1 }), null);
  assert.strictEqual(P.sanitizePos(null), null);
  // 地图 id 里的怪字符会被拒（客户端用的是 kebab-case id）
  assert.strictEqual(P.sanitizePos({ map: '../etc/passwd', x: 1, z: 2 }), null);
});

test('标注归一化：add 要完整笔画，del 只要 id；颜色/粗细兜底', () => {
  const add = P.sanitizeAnno({ op: 'add', map: 'woods', id: 'a1', kind: 'pen', color: '#FF0000', width: 99, pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] });
  assert.strictEqual(add.color, '#ff0000');
  assert.strictEqual(add.width, 20, '粗细要钳位');
  assert.strictEqual(add.pts.length, 2);

  // 颜色非法 -> 用默认红
  assert.strictEqual(P.sanitizeAnno({ op: 'add', map: 'woods', id: 'a1', kind: 'pen', color: 'red', pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] }).color, '#f87171');
  // 单点笔画不要
  assert.strictEqual(P.sanitizeAnno({ op: 'add', map: 'woods', id: 'a1', kind: 'pen', pts: [{ x: 1, z: 2 }] }), null);
  // 未知 kind 不要
  assert.strictEqual(P.sanitizeAnno({ op: 'add', map: 'woods', id: 'a1', kind: 'spray', pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] }), null);
  // del 不需要 pts
  assert.deepStrictEqual(P.sanitizeAnno({ op: 'del', map: 'woods', id: 'a1' }), { op: 'del', map: 'woods', id: 'a1' });
  // id 必须安全（会被当成文件名/键用过）
  assert.strictEqual(P.sanitizeAnno({ op: 'del', map: 'woods', id: '../../x' }), null);
  assert.strictEqual(P.sanitizeAnno({ op: 'del', map: 'woods', id: '' }), null);
  assert.strictEqual(P.sanitizeAnno({ op: 'nope', map: 'woods', id: 'a1' }), null);
});

test('落盘数据读回来也要清洗（文件可能被手改坏）', () => {
  const ok = P.sanitizeStoredAnno({ id: 'a1', kind: 'ellipse', color: '#00ff00', width: 3, pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }], owner: 'peer1', at: 5 }, 'peer1');
  assert.strictEqual(ok.owner, 'peer1');
  assert.strictEqual(ok.kind, 'ellipse');
  // 老版本"圆心 + 半径"的 circle 已经不认了（启用 ellipse 后不做旧数据兼容）
  assert.strictEqual(P.sanitizeStoredAnno({ id: 'a1', kind: 'circle', pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] }, 'peer1'), null);
  assert.strictEqual(P.sanitizeStoredAnno({ id: 'a1', kind: 'nope', pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] }, 'peer1'), null);
  assert.strictEqual(P.sanitizeStoredAnno({ id: 'a b', kind: 'pen', pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] }, 'peer1'), null);
  assert.strictEqual(P.sanitizeStoredAnno({ id: 'a1', kind: 'pen', pts: [{ x: 1, z: 2 }] }, 'peer1'), null);
  assert.strictEqual(P.sanitizeStoredAnno(null, 'peer1'), null);
});
