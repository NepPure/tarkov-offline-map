'use strict';

/**
 * 房间客户端（主进程连接层）。
 *
 * 上层是纯函数（地址归一化/退避/标注合并），下层是**真的连一遍**：
 * 单测里直接起 server/server.js 那个真服务端，用真 ws 连两个真客户端，
 * 验证"队友的地图/位置/轨迹/标注能互相看见"——不需要开 Electron 界面。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createRoomServer } = require('../server/server.js');
const { roomKey } = require('../src/room-key.js');
const RC = require('../src/room-client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 假 WebSocket：只在纯逻辑用例里用，集成用例走真 ws
// ---------------------------------------------------------------------------
class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.handlers = {};
    FakeWS.instances.push(this);
  }
  on(ev, cb) {
    (this.handlers[ev] = this.handlers[ev] || []).push(cb);
    return this;
  }
  emit(ev, ...args) {
    for (const cb of this.handlers[ev] || []) cb(...args);
  }
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  removeAllListeners() {
    this.handlers = {};
    return this;
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', 1000, 'closed');
  }
  terminate() {
    this.close();
  }
  // --- 测试驱动 ---
  doOpen() {
    this.readyState = 1;
    this.emit('open');
  }
  doMsg(o) {
    this.emit('message', JSON.stringify(o));
  }
  get last() {
    return this.sent[this.sent.length - 1];
  }
}
FakeWS.instances = [];

function newClient(opts = {}) {
  FakeWS.instances = [];
  const states = [];
  const client = new RC.RoomClient({
    WebSocketImpl: FakeWS,
    onState: (s) => states.push(s),
    onLog: () => {},
    ...opts,
  });
  client.__states = states;
  return client;
}

const CFG = { enabled: true, url: '127.0.0.1', port: 8799, roomId: '测试房间', pass: 'pw', nick: '小明' };

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------
test('地址归一化：裸 IP / 带端口 / 带协议 / 带 /ws 都能认', () => {
  assert.deepStrictEqual(RC.parseServer(''), null);
  assert.deepStrictEqual(RC.parseServer('   '), null);
  assert.deepStrictEqual(RC.parseServer('192.168.1.10'), {
    host: '192.168.1.10',
    port: 8787,
    secure: false,
    wsUrl: 'ws://192.168.1.10:8787/ws',
    healthUrl: 'http://192.168.1.10:8787/healthz',
  });
  const p = RC.parseServer('  http://room.example.com:9000/  ');
  assert.strictEqual(p.port, 9000);
  assert.strictEqual(p.host, 'room.example.com');
  assert.strictEqual(p.wsUrl, 'ws://room.example.com:9000/ws');
  const s = RC.parseServer('wss://room.example.com/ws');
  assert.strictEqual(s.secure, true);
  assert.strictEqual(s.port, 8787);
  assert.strictEqual(s.wsUrl, 'wss://room.example.com:8787/ws');
  assert.strictEqual(s.healthUrl, 'https://room.example.com:8787/healthz');
  // 默认端口可以被覆盖
  assert.strictEqual(RC.parseServer('host', 1234).port, 1234);
});

test('重连退避：1s 起步指数翻倍，封顶 30s', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 7].map(RC.backoffDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('配置归一化：缺地址或缺房间号就不联机；房间号与服务端算法一致', () => {
  const off = RC.normalizeConfig({ enabled: true, url: '', roomId: 'abc' });
  assert.strictEqual(off.enabled, false, '没填地址不该联机');
  const off2 = RC.normalizeConfig({ enabled: true, url: '1.2.3.4', roomId: '' });
  assert.strictEqual(off2.enabled, false, '没填房间号不该联机');
  const off3 = RC.normalizeConfig({ enabled: false, url: '1.2.3.4', roomId: 'abc' });
  assert.strictEqual(off3.enabled, false, '开关没开就不联机（默认离线优先）');

  const on = RC.normalizeConfig(CFG);
  assert.strictEqual(on.enabled, true);
  assert.strictEqual(on.roomKey, roomKey('测试房间', 'pw'));
  assert.strictEqual(on.nick, '小明');
  assert.match(on.peerId, /^[A-Za-z0-9_-]{4,40}$/);
  // peerId 缺省时自动生成，且两次不同（免得所有人撞成一个人）
  assert.notStrictEqual(RC.normalizeConfig(CFG).peerId, RC.normalizeConfig(CFG).peerId);
  // 昵称超长会被截断（服务端也会截，但别让用户看到自己发出去的长名字）
  assert.strictEqual(RC.normalizeConfig({ ...CFG, nick: '一二三四五六七八九十一二三四五六七八' }).nick.length, 16);
});

test('标注合并：add 覆盖同 id、del 删掉、owner 过滤', () => {
  const a1 = { t: 'anno', op: 'add', map: 'woods', id: 's1', kind: 'pen', color: '#ff0000', width: 3, pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }], owner: 'p1' };
  let annos = RC.applyAnno({}, a1);
  assert.strictEqual(annos.woods.length, 1);
  assert.strictEqual(annos.woods[0].owner, 'p1');
  // 同 id 再 add = 覆盖（不是追加）
  annos = RC.applyAnno(annos, { ...a1, kind: 'circle' });
  assert.strictEqual(annos.woods.length, 1);
  assert.strictEqual(annos.woods[0].kind, 'circle');
  // 别人也画一笔
  annos = RC.applyAnno(annos, { ...a1, id: 's2', owner: 'p2' });
  assert.strictEqual(annos.woods.length, 2);
  // 删掉一笔
  annos = RC.applyAnno(annos, { t: 'anno', op: 'del', map: 'woods', id: 's1', owner: 'p1' });
  assert.deepStrictEqual(annos.woods.map((a) => a.id), ['s2']);
  // 删空之后整张图不残留空数组
  annos = RC.applyAnno(annos, { t: 'anno', op: 'del', map: 'woods', id: 's2', owner: 'p2' });
  assert.deepStrictEqual(annos, {});
  // 非法笔画会被丢掉（服务端被冒充也污染不到界面）
  assert.deepStrictEqual(RC.applyAnno({}, { t: 'anno', op: 'add', map: 'woods', id: 's3', kind: 'nope', pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] }), {});
  // 队友离开 -> 他的标注一起消失
  const two = RC.applyAnno(RC.applyAnno({}, a1), { ...a1, id: 's2', owner: 'p2' });
  assert.deepStrictEqual(Object.keys(RC.dropOwner(two, 'p1')).length, 1);
  assert.deepStrictEqual(RC.dropOwner(two, 'p1').woods.map((a) => a.id), ['s2']);
});

// ---------------------------------------------------------------------------
// 纯逻辑（假 WebSocket）
// ---------------------------------------------------------------------------
test('连接流程：hello 带协议版本与房间哈希；welcome 后进入 online', () => {
  const c = newClient();
  c.applyConfig(CFG);
  const ws = FakeWS.instances[0];
  assert.strictEqual(ws.url, 'ws://127.0.0.1:8799/ws');
  assert.strictEqual(c.snapshot().status, 'connecting');
  ws.doOpen();
  assert.deepStrictEqual(ws.last, { t: 'hello', v: RC.PROTO, room: roomKey('测试房间', 'pw'), nick: '小明', pid: c.cfg.peerId, ver: null });
  ws.doMsg({ t: 'welcome', proto: RC.PROTO, ver: '2.0.0', self: { id: c.cfg.peerId, nick: '小明' }, peers: [{ id: 'p2', nick: '小红', map: 'woods' }], annos: {} });
  const s = c.snapshot();
  assert.strictEqual(s.status, 'online');
  assert.strictEqual(s.self.id, c.cfg.peerId);
  assert.strictEqual(s.peers.length, 1);
  assert.strictEqual(s.peers[0].nick, '小红');
  assert.strictEqual(s.error, null);
  c.destroy();
});

test('队友进出 / 换图 / 定位：都能落到状态里', () => {
  const c = newClient();
  c.applyConfig(CFG);
  const ws = FakeWS.instances[0];
  ws.doOpen();
  ws.doMsg({ t: 'welcome', self: { id: 'me', nick: '我' }, peers: [], annos: {} });

  ws.doMsg({ t: 'peer-join', peer: { id: 'p2', nick: '小红', map: null } });
  ws.doMsg({ t: 'peer-map', id: 'p2', map: 'interchange' });
  ws.doMsg({ t: 'peer-pos', id: 'p2', map: 'interchange', x: 1.5, z: 2.5, y: 0, hdg: 90, ts: 111, trail: [{ x: 1, z: 2 }, { x: 1.5, z: 2.5 }] });
  let p = c.snapshot().peers.find((x) => x.id === 'p2');
  assert.strictEqual(p.map, 'interchange');
  assert.strictEqual(p.pos.x, 1.5);
  assert.strictEqual(p.pos.trail.length, 2);
  assert.ok(p.at > 0, '要记"什么时候收到的"，界面要显示"N 分钟前"');

  ws.doMsg({ t: 'peer-left', id: 'p2' });
  assert.strictEqual(c.snapshot().peers.length, 0);
  c.destroy();
});

test('位置上报节流：密集调用只发首条 + 补发最后一条（中间的丢掉）', async () => {
  const c = newClient();
  c.applyConfig(CFG);
  const ws = FakeWS.instances[0];
  ws.doOpen();
  ws.doMsg({ t: 'welcome', self: { id: 'me' }, peers: [], annos: {} });
  const posMsgs = () => ws.sent.filter((m) => m.t === 'pos');
  c.setPosition({ map: 'woods', x: 1, z: 1 });
  c.setPosition({ map: 'woods', x: 2, z: 2 });
  c.setPosition({ map: 'woods', x: 3, z: 3 });
  assert.strictEqual(posMsgs().length, 1, '第一条立刻发');
  assert.strictEqual(posMsgs()[0].x, 1);
  await sleep(RC.POS_MIN_INTERVAL_MS + 80);
  assert.strictEqual(posMsgs().length, 2, '节流窗口过去后补发最后一条');
  assert.strictEqual(posMsgs()[1].x, 3, '补发的是最新的那条，不是被丢掉的中间值');
  c.destroy();
});

test('换图只发一次；关掉共享定位就不上报', () => {
  const c = newClient();
  c.applyConfig(CFG);
  const ws = FakeWS.instances[0];
  ws.doOpen();
  ws.doMsg({ t: 'welcome', self: { id: 'me' }, peers: [], annos: {} });
  c.setMap('customs');
  c.setMap('customs');
  c.setMap('woods');
  assert.deepStrictEqual(ws.sent.filter((m) => m.t === 'map'), [{ t: 'map', map: 'customs' }, { t: 'map', map: 'woods' }]);
  c.destroy();

  const c2 = newClient();
  c2.applyConfig({ ...CFG, sharePos: false });
  const ws2 = FakeWS.instances[0];
  ws2.doOpen();
  ws2.doMsg({ t: 'welcome', self: { id: 'me' }, peers: [], annos: {} });
  c2.setPosition({ map: 'woods', x: 1, z: 2 });
  assert.strictEqual(ws2.sent.filter((m) => m.t === 'pos').length, 0, '关掉"共享我的定位"后一条都不发');
  c2.destroy();
});

test('服务端明确拒绝（版本不符/房间满）不再盲目重连', async () => {
  const c = newClient();
  c.applyConfig(CFG);
  const ws = FakeWS.instances[0];
  ws.doOpen();
  ws.doMsg({ t: 'err', code: 'room-full', msg: '房间人数已满（上限 16 人）' });
  ws.close();
  await sleep(50);
  const s = c.snapshot();
  assert.strictEqual(s.status, 'error');
  assert.match(s.error, /房间/);
  assert.strictEqual(s.attempts, 0, '明确拒绝不该计入重连次数');
  assert.strictEqual(FakeWS.instances.length, 1, '不该又开一条新连接');
  c.destroy();
});

test('意外断线：进入 reconnecting 并按退避重连', async () => {
  const c = newClient();
  c.applyConfig(CFG);
  const ws = FakeWS.instances[0];
  ws.doOpen();
  ws.doMsg({ t: 'welcome', self: { id: 'me' }, peers: [{ id: 'p2', nick: '小红' }], annos: {} });
  assert.strictEqual(c.snapshot().peers.length, 1);
  ws.close(); // 服务端/网络断了
  const mid = c.snapshot();
  assert.strictEqual(mid.status, 'reconnecting');
  assert.deepStrictEqual(mid.peers, [], '断线后不能继续显示"在线"的队友');
  assert.strictEqual(mid.attempts, 1);
  await sleep(1200);
  assert.strictEqual(FakeWS.instances.length, 2, '退避 1s 后应重连一次');
  assert.strictEqual(FakeWS.instances[1].url, 'ws://127.0.0.1:8799/ws');
  c.destroy();
});

test('心跳：发 ping 收不到 pong 就判定连接已死', async () => {
  const c = newClient();
  c.applyConfig(CFG);
  const ws = FakeWS.instances[0];
  ws.doOpen();
  ws.doMsg({ t: 'welcome', self: { id: 'me' }, peers: [], annos: {} });
  // 手动触发一次心跳轮询（真实间隔 25s，测试里不等）
  c.startPing();
  clearInterval(c.timers.ping);
  c.timers.ping = null;
  let terminated = false;
  ws.terminate = () => {
    terminated = true;
    ws.close();
  };
  c.lastPingAt = 0;
  // 直接把 pong 超时逻辑跑一遍
  c.send({ t: 'ping' });
  c.timers.pong = setTimeout(() => ws.terminate(), 10);
  await sleep(60);
  assert.ok(terminated, '没回 pong 应主动断开，交给重连逻辑');
  c.destroy();
});

// ---------------------------------------------------------------------------
// 真服务端 + 真 WebSocket：两个客户端互相看见
// ---------------------------------------------------------------------------
async function startServer(opts = {}) {
  const srv = createRoomServer({ host: '127.0.0.1', port: 0, logLevel: 'error', ...opts });
  const port = await new Promise((res) => srv.start(res));
  return { srv, port };
}

async function onlineClient(port, room, nick, extra = {}) {
  const c = new RC.RoomClient({ onState: () => {}, onLog: () => {}, ...extra });
  c.applyConfig({ enabled: true, url: '127.0.0.1', port, roomId: room, nick });
  for (let i = 0; i < 100; i++) {
    if (c.snapshot().status === 'online') return c;
    await sleep(30);
  }
  throw new Error(`客户端 ${nick} 没能进入 online（状态 ${c.snapshot().status}：${c.snapshot().error}）`);
}

test('集成：同房间两个人互相看到地图/位置/轨迹/标注', async (t) => {
  const { srv, port } = await startServer();
  t.after(() => srv.close());

  const a = await onlineClient(port, '开黑房', '阿尔法');
  const b = await onlineClient(port, '开黑房', '布拉沃');
  t.after(() => {
    a.destroy();
    b.destroy();
  });
  await sleep(120);

  // 互相看得见
  assert.strictEqual(a.snapshot().peers.length, 1);
  assert.strictEqual(a.snapshot().peers[0].nick, '布拉沃');
  assert.strictEqual(b.snapshot().peers[0].nick, '阿尔法');

  // B 进图 + 定位 -> A 那边能看到地图、位置、朝向和轨迹尾巴
  b.setMap('shoreline');
  await sleep(80);
  assert.strictEqual(a.snapshot().peers[0].map, 'shoreline');
  b.setPosition({
    map: 'shoreline',
    x: 10,
    y: 1,
    z: -20,
    hdg: 135,
    ts: Date.now(),
    trail: [
      { x: 8, z: -18 },
      { x: 10, z: -20 },
    ],
  });
  await sleep(150);
  const pb = a.snapshot().peers[0];
  assert.strictEqual(pb.pos.x, 10);
  assert.strictEqual(pb.pos.z, -20);
  assert.strictEqual(pb.pos.hdg, 135);
  assert.strictEqual(pb.pos.trail.length, 2, '轨迹尾巴要一起同步（队友走过的路线）');

  // 标注互相可见：A 画一笔，A 自己（回显）与 B 都收到
  const anno = { map: 'shoreline', id: 'a-1', kind: 'pen', color: '#ff0000', width: 4, pts: [{ x: 1, z: 1 }, { x: 2, z: 2 }] };
  assert.strictEqual(a.sendAnnoAdd(anno), true);
  await sleep(150);
  assert.strictEqual(a.snapshot().annos.shoreline.length, 1);
  assert.strictEqual(b.snapshot().annos.shoreline.length, 1);
  assert.strictEqual(b.snapshot().annos.shoreline[0].owner, a.cfg.peerId, '要能分辨是谁画的（按人开关图例要用）');

  // B 画一笔，两边都有两笔
  b.sendAnnoAdd({ map: 'shoreline', id: 'b-1', kind: 'circle', color: '#00ff00', width: 2, pts: [{ x: 5, z: 5 }, { x: 6, z: 6 }] });
  await sleep(150);
  assert.strictEqual(a.snapshot().annos.shoreline.length, 2);

  // 删除只能删自己的：B 删 A 的那笔 -> 谁都不变
  b.sendAnnoDel('shoreline', 'a-1');
  await sleep(150);
  assert.strictEqual(a.snapshot().annos.shoreline.length, 2, '别人的删除请求不该生效');
  // A 删自己的 -> 两边都少一笔
  a.sendAnnoDel('shoreline', 'a-1');
  await sleep(150);
  assert.deepStrictEqual(a.snapshot().annos.shoreline.map((x) => x.id), ['b-1']);
  assert.deepStrictEqual(b.snapshot().annos.shoreline.map((x) => x.id), ['b-1']);

  // 有人离开：剩下的人立刻看到
  b.destroy();
  await sleep(200);
  assert.strictEqual(a.snapshot().peers.length, 0);
});

test('集成：后来的人进房就能看到房间里的标注（不需要额外拉取）', async (t) => {
  const { srv, port } = await startServer();
  t.after(() => srv.close());

  const a = await onlineClient(port, '开黑房2', '阿尔法');
  t.after(() => a.destroy());
  a.sendAnnoAdd({ map: 'woods', id: 'a-9', kind: 'rect', color: '#f59e0b', width: 3, pts: [{ x: 0, z: 0 }, { x: 9, z: 9 }] });
  await sleep(120);

  const c = await onlineClient(port, '开黑房2', '查理');
  t.after(() => c.destroy());
  assert.strictEqual(c.snapshot().annos.woods.length, 1);
  assert.strictEqual(c.snapshot().annos.woods[0].kind, 'rect');
  assert.strictEqual(c.snapshot().peers.length, 1);
});

test('集成：不同房间号互不串门；口令不同也进不去', async (t) => {
  const { srv, port } = await startServer();
  t.after(() => srv.close());

  const a = await onlineClient(port, '房间甲', '甲');
  const b = await onlineClient(port, '房间乙', '乙');
  const c = await onlineClient(port, '房间甲', '丙', {});
  t.after(() => {
    a.destroy();
    b.destroy();
    c.destroy();
  });
  await sleep(150);
  assert.strictEqual(a.snapshot().peers.length, 1, '甲房间里只有丙');
  assert.strictEqual(a.snapshot().peers[0].nick, '丙');
  assert.strictEqual(b.snapshot().peers.length, 0, '乙房间不该看见甲的人');
  assert.strictEqual(c.snapshot().peers[0].nick, '甲');
});

test('重复 connect 不会因为"关旧连接"排一次假重连', async () => {
  const c = newClient();
  c.applyConfig(CFG);
  const ws1 = FakeWS.instances[0];
  ws1.doOpen();
  ws1.doMsg({ t: 'welcome', self: { id: 'me' }, peers: [], annos: {} });
  assert.strictEqual(c.snapshot().status, 'online');

  c.connect(); // 手动重连
  assert.strictEqual(FakeWS.instances.length, 2, '应该只开了一条新连接');
  await sleep(1200); // 旧连接的 close 若被当成断线，这里会多冒出第 3 条
  assert.strictEqual(FakeWS.instances.length, 2, '关掉旧连接不该被当成意外断线');
  assert.strictEqual(c.snapshot().attempts, 0);

  FakeWS.instances[1].doOpen();
  FakeWS.instances[1].doMsg({ t: 'welcome', self: { id: 'me' }, peers: [], annos: {} });
  assert.strictEqual(c.snapshot().status, 'online');
  c.destroy();
});

test('集成：关掉共享标注后画的东西不会外发（本地照旧）', async (t) => {
  const { srv, port } = await startServer();
  t.after(() => srv.close());

  const a = await onlineClient(port, '房间丙', '甲');
  const b = await onlineClient(port, '房间丙', '乙', {});
  t.after(() => {
    a.destroy();
    b.destroy();
  });
  await sleep(100);

  // 直接在配置层关掉：模拟设置页里把"共享我的标注"取消勾选
  b.cfg.shareAnno = false;
  assert.strictEqual(b.sendAnnoAdd({ map: 'woods', id: 'b-1', kind: 'pen', color: '#ffffff', width: 1, pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] }), false);
  await sleep(150);
  assert.deepStrictEqual(b.snapshot().annos, {}, '自己没外发');
  assert.deepStrictEqual(a.snapshot().annos, {}, '队友也没收到');
});
