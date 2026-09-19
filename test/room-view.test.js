'use strict';

/**
 * 房间成员在地图上的显示规则（纯函数）+ 渲染层接线（静态检查）。
 * 真正的渲染效果由 tools/verify-room.js 在界面上验收（CDP）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let R = null;
test('载入 room 显示模块', async () => {
  R = await import('../renderer/common/room.js');
  assert.ok(R.peerColor && R.peerInitial && R.peersSignature);
});

test('颜色：同一个人在任何客户端上都是同一个颜色，且避开玩家自己的青色', () => {
  const a = R.peerColor('peerAAAA1');
  const b = R.peerColor('peerAAAA1');
  assert.strictEqual(a, b, '同一个 id 必须稳定同色');
  assert.match(a, /^#[0-9a-f]{6}$/i);
  // 调色板里不能有玩家自己的青色（#22d3ee），否则"哪个是我"会看错
  const seen = new Set(R.PEER_PALETTE.map((c) => c.toLowerCase()));
  assert.ok(!seen.has('#22d3ee'), '队友配色不能和玩家箭头撞色');
  // 不同的人大概率不同色（抽 12 个 id 至少 5 种颜色）
  const colors = new Set(Array.from({ length: 12 }, (_, i) => R.peerColor(`peer${i}`)));
  assert.ok(colors.size >= 5, `颜色区分度太低：${[...colors].join(',')}`);
});

test('图标：昵称第一个字（英文转大写、emoji 不劈半）', () => {
  assert.strictEqual(R.peerInitial('小明'), '小');
  assert.strictEqual(R.peerInitial('alice'), 'A');
  assert.strictEqual(R.peerInitial('😀玩家'), '😀');
  assert.strictEqual(R.peerInitial('  阿强 '), '阿');
  assert.strictEqual(R.peerInitial(''), '?');
  assert.strictEqual(R.peerInitial(null), '?');
});

test('重名队友要能区分（补短 id），不重名就干净显示', () => {
  const peers = [{ id: 'aaaa1111', nick: '小明' }, { id: 'bbbb2222', nick: '小明' }, { id: 'cccc3333', nick: '小红' }];
  assert.strictEqual(R.peerLabel(peers[0], peers), '小明#111');
  assert.strictEqual(R.peerLabel(peers[1], peers), '小明#222');
  assert.strictEqual(R.peerLabel(peers[2], peers), '小红');
});

test('相对时间：位置是拍脑袋式的（按截图键才有），多久以前必须能看出来', () => {
  const now = 1_700_000_000_000;
  assert.strictEqual(R.relTime(now - 1000, now), '刚刚');
  assert.strictEqual(R.relTime(now - 23_000, now), '23 秒前');
  assert.strictEqual(R.relTime(now - 5 * 60_000, now), '5 分钟前');
  assert.strictEqual(R.relTime(now - 3 * 3600_000, now), '3 小时前');
  assert.strictEqual(R.relTime(0, now), '');
  assert.strictEqual(R.relTime(undefined, now), '');
  // 新旧分级：2 分钟算旧、10 分钟算很旧（界面上要淡下去）
  assert.strictEqual(R.staleLevel(now - 10_000, now), 'fresh');
  assert.strictEqual(R.staleLevel(now - 3 * 60_000, now), 'stale');
  assert.strictEqual(R.staleLevel(now - 20 * 60_000, now), 'old');
});

test('只画"同一张图且有定位"的人；没定位的人只在图例里说明去处', () => {
  const peers = [
    { id: 'p1', nick: '甲', map: 'woods', pos: { map: 'woods', x: 1, z: 2 } },
    { id: 'p2', nick: '乙', map: 'shoreline', pos: null },
    { id: 'p3', nick: '丙', map: 'customs', pos: { map: 'customs', x: 3, z: 4 } },
  ];
  assert.deepStrictEqual(R.peersOnMap(peers, 'woods').map((p) => p.id), ['p1']);
  assert.deepStrictEqual(R.peersOnMap(peers, 'customs').map((p) => p.id), ['p3']);
  assert.deepStrictEqual(R.peersOnMap(peers, 'interchange'), []);
  assert.strictEqual(R.peerOnMap(peers[1], 'shoreline'), false, '没定位就不画点（图例里写明在别的图）');
  assert.strictEqual(R.peerLegendLabel({ ...peers[1], mapName: '海岸线' }, peers), '乙（在海岸线）');
  assert.strictEqual(R.peerLegendLabel(peers[1], peers), '乙（在别的图）');
  assert.strictEqual(R.peerLegendLabel({ id: 'p9', nick: '丁' }, []), '丁（还没定位）');
  assert.strictEqual(R.peerLegendLabel(peers[0], peers), '甲');
});

test('成员排序稳定（图例不会每次广播都跳来跳去）', () => {
  const peers = [{ id: 'b2', nick: '乙' }, { id: 'a1', nick: '甲' }, { id: 'c3', nick: '丙' }];
  const s1 = R.sortPeers(peers).map((p) => p.nick);
  const s2 = R.sortPeers([...peers].reverse()).map((p) => p.nick);
  assert.deepStrictEqual(s1, s2);
  assert.deepStrictEqual(s1, ['丙', '甲', '乙'].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
});

test('图例指纹：成员/昵称/是否在本图/本图标注数变了才重建', () => {
  const peers = [{ id: 'p1', nick: '甲', map: 'woods', pos: { map: 'woods', x: 1, z: 2 } }];
  const base = R.peersSignature(peers, 'woods', {});
  assert.strictEqual(base, R.peersSignature([...peers], 'woods', {}), '没变就不重建');
  assert.notStrictEqual(base, R.peersSignature([...peers, { id: 'p2', nick: '乙' }], 'woods', {}), '有人加入要重建');
  assert.notStrictEqual(base, R.peersSignature(peers, 'customs', {}), '换图后"在不在本图"会变，要重建');
  const annos = { woods: [{ id: 'a1', owner: 'p1', kind: 'pen' }] };
  assert.notStrictEqual(base, R.peersSignature(peers, 'woods', annos), '他画了一笔，计数要变');
});

test('雷达边缘钳位：圆外的队友按同样方位贴到圆边上', async () => {
  const { clampToRadar } = await import('../renderer/common/map-view.js');
  const cx = 150, cy = 150, R = 131;
  // 圆内：原样不动
  const inside = clampToRadar(cx + 50, cy, cx, cy, R);
  assert.deepStrictEqual({ x: inside.x, y: inside.y, clamped: inside.clamped }, { x: cx + 50, y: cy, clamped: false });
  assert.strictEqual(inside.bearing, 0);
  // 正右方很远：拉到 (cx+R, cy)，方位 0
  const right = clampToRadar(cx + 900, cy, cx, cy, R);
  assert.strictEqual(right.clamped, true);
  assert.ok(Math.abs(right.x - (cx + R)) < 1e-6 && Math.abs(right.y - cy) < 1e-6);
  assert.strictEqual(Math.round(right.bearing), 0);
  // 正下方（屏幕 y 向下）：方位 +90
  const down = clampToRadar(cx, cy + 500, cx, cy, R);
  assert.ok(Math.abs(down.y - (cy + R)) < 1e-6);
  assert.strictEqual(Math.round(down.bearing), 90);
  // 左上 45°：方位 -135，且到圆心的距离正好是 R
  const upleft = clampToRadar(cx - 400, cy - 400, cx, cy, R);
  assert.strictEqual(upleft.clamped, true);
  assert.ok(Math.abs(upleft.bearing + 135) < 1e-6);
  assert.ok(Math.abs(Math.hypot(upleft.x - cx, upleft.y - cy) - R) < 1e-6);
  // 边界与退化
  assert.strictEqual(clampToRadar(cx + R, cy, cx, cy, R).clamped, false, '正好在圆边上不算出界');
  assert.strictEqual(clampToRadar(cx, cy, cx, cy, R).clamped, false, '正好在圆心不能算出界');
});

test('渲染层接线：队友图层、图例分组、点击、雷达同步都在', () => {
  const mv = read('renderer/common/map-view.js');
  assert.ok(mv.includes("import { peerColor, peerInitial, peerLabel, relTime, staleLevel, peerLegendLabel } from './room.js';"));
  assert.ok(mv.includes('setPeers(list)') && mv.includes('setPeerAnnos(list)'), '缺少 setPeers/setPeerAnnos');
  assert.ok(mv.includes('#renderPeers()'), '缺少队友渲染');
  assert.match(mv, /id: 'g-room',\s*\n\s*label: '房间成员'/, '图例里必须有「房间成员」分组');
  assert.ok(mv.includes('`peer:${p.id}`'), '每个成员一个图例开关 id');
  assert.ok(mv.includes("this.#off(`peer:${peer.id}`)"), '队友标记要受图例开关控制');
  assert.ok(mv.includes("this.#off(`peer:${s.owner}`)"), '队友的标注要受同一个开关控制');
  assert.ok(mv.includes('data-peer'), '队友标记要带 data-peer（点击跳转用）');
  assert.ok(mv.includes('onPeerClick'), '缺少队友点击回调');

  const mj = read('renderer/map.js');
  assert.ok(mj.includes('function applyRoomView(roomState)'), '缺少 applyRoomView');
  assert.ok(mj.includes('view.setPeers(peers)') && mj.includes('view.setPeerAnnos(mine)'));
  assert.ok(mj.includes('peersSignature(peers, mapId, annosByMap)'), '图例要按指纹重建');
  assert.ok(mj.includes("kind === 'peer'"), '图例 swatch 要支持队友（圆底+首字）');
  assert.ok(mj.includes('escapeHtml(initial'), '队友昵称来自网络，进 innerHTML 前必须转义');
  assert.ok(mj.includes('view.onPeerClick = (peer) =>'), '点队友标记要能跳过去');

  const mm = read('renderer/minimap.js');
  assert.ok(mm.includes('view.setPeers(') && mm.includes('view.setPeerAnnos('), '雷达也要画队友');
  // 雷达是固定半径的圆：出范围的队友必须钳到边上（否则标记跑到窗口外，等于"队友消失了"）
  assert.ok(mv.includes('clampToRadar(s.x, s.y, cx, cy, radarR)'), '雷达上要调用 clampToRadar');
  assert.ok(mv.includes("g.setAttribute('data-off-range', '1')"), '出范围的标记要能看出来（验收脚本靠它断言）');
  assert.ok(mv.includes('peer-offrange-chevron'), '出范围时要有朝外的箭头指明方位');
});
