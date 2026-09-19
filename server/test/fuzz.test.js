'use strict';

/**
 * 模糊测试：拿"带种子的随机垃圾"去轰服务端。
 *
 * 手写用例只能覆盖我想到的情况；这里用确定性随机（同一种子每次结果一样，失败可复现）
 * 生成几千条畸形消息，验证三件事：
 *   1) 服务端不许崩（进程还在、/healthz 还正常）
 *   2) 不许把非法状态存进房间（广播出去的每一笔标注都必须满足不变量）
 *   3) 轰完之后服务依旧可用（新客户端能正常进房）
 */
const test = require('node:test');
const assert = require('node:assert');
const { WebSocket } = require('ws');

const { createRoomServer } = require('../server.js');
const P = require('../protocol.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOM = P.roomKey('模糊测试', '');

/** 确定性随机（mulberry32）：失败时换个种子就能复现，不靠运气 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

function randVal(rnd) {
  switch (Math.floor(rnd() * 14)) {
    case 0: return null;
    case 1: return undefined;
    case 2: return rnd() * 1e6 - 5e5;
    case 3: return 'x'.repeat(Math.floor(rnd() * 120));
    case 4: return { 嵌套: true, arr: [1, 2, 3] };
    case 5: return [1, 2, 3];
    case 6: return NaN;
    case 7: return Infinity;
    case 8: return true;
    case 9: return '';
    case 10: return '../../etc/passwd';
    case 11: return '😀'.repeat(20);
    case 12: return Math.floor(rnd() * 10);
    default: return `p${Math.floor(rnd() * 1e6)}`;
  }
}

const TYPES = ['pos', 'anno', 'map', 'ping', 'hello', 'welcome', 'peer-pos', 'peer-map', '未知类型', '', 'anno', 'pos', 'map'];

function randMsg(rnd) {
  const m = { t: pick(rnd, TYPES) };
  const keys = ['map', 'x', 'z', 'y', 'hdg', 'ts', 'id', 'kind', 'color', 'width', 'pts', 'trail', 'op', 'room', 'nick', 'pid', 'v', 'pad'];
  const n = 1 + Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) m[pick(rnd, keys)] = randVal(rnd);
  // 偶尔来一发超大帧（触发 64KB 上限）
  if (rnd() < 0.01) m.pad = 'x'.repeat(70 * 1024);
  return m;
}

/**
 * "半合法"消息：结构是对的，只故意弄坏一两个字段。
 * 纯随机数据几乎全会被拒，光靠它不变量检查就是摆设；这一半才能真正压到校验逻辑。
 */
function semiValidMsg(rnd, counter) {
  const kind = pick(rnd, [...P.KINDS, 'pen', 'circle']);
  const m = {
    t: pick(rnd, ['anno', 'anno', 'anno', 'pos', 'map']),
    op: pick(rnd, ['add', 'add', 'add', 'del']),
    map: pick(rnd, ['woods', 'customs', '', null, '../../x', 'a'.repeat(80)]),
    id: pick(rnd, [`f${counter}`, '', 'ok_id-1', 'x'.repeat(60), '../../etc']),
    kind,
    color: pick(rnd, ['#ffffff', '#ABCDEF', 'red', '', null, '#12345']),
    width: pick(rnd, [1, 4, 20, 0, 999, -3, 'abc', null]),
    pts: pick(rnd, [
      [{ x: 1, z: 2 }, { x: 3, z: 4 }],
      [{ x: 1, z: 2 }],
      [],
      [{ x: 1, z: 2 }, { x: NaN, z: 4 }, { x: 3, z: 4 }],
      Array.from({ length: P.LIMITS.PTS_MAX + 5 }, (_, i) => ({ x: i, z: i })),
      [{ x: 'a', z: 2 }, { x: 3, z: 4 }],
    ]),
    x: pick(rnd, [1, -1, 0, NaN, 'x', null]),
    z: pick(rnd, [2, -2, 0, Infinity, 'z', null]),
    ts: pick(rnd, [Date.now(), 0, NaN, 'now']),
    trail: pick(rnd, [[{ x: 1, z: 1 }, { x: 2, z: 2 }], [], null, 'nope']),
  };
  return m;
}

async function start(opts = {}) {
  const srv = createRoomServer({ host: '127.0.0.1', port: 0, logLevel: 'error', ...opts });
  const port = await new Promise((res) => srv.start(res));
  return { srv, port, url: `ws://127.0.0.1:${port}/ws` };
}

function connect(url, name) {
  const ws = new WebSocket(url);
  const msgs = [];
  const state = { closed: null, opened: false };
  ws.on('open', () => {
    state.opened = true;
  });
  ws.on('message', (d) => {
    try {
      msgs.push(JSON.parse(d.toString('utf8')));
    } catch {}
  });
  ws.on('close', (code) => {
    state.closed = code;
  });
  ws.on('error', () => {});
  return {
    ws,
    msgs,
    state,
    name,
    hello: (nick = name, pid) => ws.send(JSON.stringify({ t: 'hello', v: P.PROTO, room: ROOM, nick, pid })),
  };
}

async function until(fn, timeout = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

/** 广播出来的每一笔标注都必须满足不变量（服务端不许把非法数据转出去） */
function assertAnnoInvariants(msgs, label) {
  const adds = msgs.filter((m) => m.t === 'anno' && m.op === 'add');
  for (const a of adds) {
    assert.ok(P.KINDS.has(a.kind), `${label}: 非法 kind 被转发了 -> ${a.kind}`);
    assert.ok(/^[A-Za-z0-9_-]{1,40}$/.test(String(a.owner || '')), `${label}: owner 非法 -> ${a.owner}`);
    assert.ok(/^[A-Za-z0-9_-]{1,40}$/.test(String(a.id || '')), `${label}: id 非法 -> ${a.id}`);
    assert.ok(Array.isArray(a.pts) && a.pts.length >= 2, `${label}: 点数不足却转发了`);
    assert.ok(a.pts.length <= P.LIMITS.PTS_MAX, `${label}: 点数超上限却转发了`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(String(a.color)), `${label}: 颜色非法 -> ${a.color}`);
    assert.ok(Number.isFinite(a.width) && a.width >= 1 && a.width <= 20, `${label}: 粗细越界 -> ${a.width}`);
    for (const p of a.pts) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), `${label}: 坐标不是有限数`);
    }
  }
}

test('模糊：6000 条随机垃圾帧之后，服务端还活着、状态还合法、服务还能用', async (t) => {
  const { srv, port, url } = await start();
  t.after(() => srv.close());

  // 一个"健康旁观者"：全程待在房间里，检查服务端转发出来的东西合不合法
  const watcher = connect(url, '观察者');
  await until(() => watcher.state.opened);
  watcher.hello('观察者', 'peerWATCH1');
  await until(() => watcher.msgs.some((m) => m.t === 'welcome'));

  const rnd = mulberry32(20260920);

  // ---- 阶段一：还没 hello 就乱发 -> 必须被 need-hello 拒掉（不能让它继续乱喷）----
  const rude = connect(url, '没礼貌');
  await until(() => rude.state.opened);
  for (let i = 0; i < 20; i++) {
    try {
      rude.ws.send(JSON.stringify(randMsg(rnd)));
    } catch {}
  }
  assert.ok(await until(() => rude.msgs.some((m) => m.t === 'err' && m.code === 'need-hello')), '没 hello 就发消息应该被拒');
  assert.ok(await until(() => rude.state.closed !== null), '并且断开这条连接');
  rude.ws.close();

  // ---- 阶段二：两条先正常进房，再乱喷 2000 条（一半纯随机、一半半合法）----
  const spammers = [];
  for (let i = 0; i < 2; i++) {
    const sp = connect(url, `喷子${i}`);
    spammers.push(sp);
    await until(() => sp.state.opened);
    sp.hello(`喷子${i}`, `peerSPAM${i}`);
    await until(() => sp.msgs.some((m) => m.t === 'welcome'));
  }
  for (let i = 0; i < 2000; i++) {
    const sp = spammers[i % spammers.length];
    if (sp.ws.readyState !== 1) continue;
    const msg = i % 2 === 0 ? randMsg(rnd) : semiValidMsg(rnd, i);
    try {
      sp.ws.send(JSON.stringify(msg));
    } catch {}
  }
  await sleep(600);

  // ---- 阶段三：非 JSON 的裸字节 / 空帧（会被 bad-json 拒掉）----
  const raw = connect(url, '裸字节');
  await until(() => raw.state.opened);
  raw.hello('裸字节', 'peerRAW01');
  await until(() => raw.msgs.some((m) => m.t === 'welcome'));
  raw.ws.send('这不是 JSON');
  raw.ws.send('');
  raw.ws.send('{"t":');
  assert.ok(await until(() => raw.msgs.some((m) => m.t === 'err' && m.code === 'bad-json')), '裸字节应该收到 bad-json');
  raw.ws.close();

  // 1) 服务端还活着
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.strictEqual(health.ok, true, '模糊测试后 /healthz 必须仍然正常');
  assert.ok(health.rooms >= 1, '房间还在');
  assert.ok(Number.isFinite(health.rssMB) && health.rssMB < 1024, `内存别炸：${health.rssMB}MB`);

  // 2) 转发出来的每一笔标注都合法（先确认确实有数据被转发，别让检查空转）
  const forwarded = watcher.msgs.filter((m) => m.t === 'anno' && m.op === 'add');
  assert.ok(forwarded.length >= 3, `半合法数据应该有一部分被接受并转发，实际 ${forwarded.length}`);
  assertAnnoInvariants(watcher.msgs, '模糊测试');
  // 广播的地图 id 也必须是干净的
  for (const a of watcher.msgs.filter((m) => m.t === 'anno')) {
    assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(String(a.map || '')), `地图 id 非法被转发 -> ${a.map}`);
  }

  // 3) 服务还能用：新客户端正常进房、正常通信、正常标注
  const fresh = connect(url, '新来的');
  await until(() => fresh.state.opened);
  fresh.hello('新来的', 'peerFRESH1');
  assert.ok(await until(() => fresh.msgs.some((m) => m.t === 'welcome')), '轰完之后新客户端仍能进房');
  fresh.ws.send(JSON.stringify({ t: 'anno', op: 'add', map: 'reserve', id: 'ok1', kind: 'pen', color: '#ffffff', width: 2, pts: [{ x: 1, z: 1 }, { x: 2, z: 2 }] }));
  assert.ok(await until(() => fresh.msgs.some((m) => m.t === 'anno' && m.id === 'ok1')), '正常标注仍能写入并回显');
  assert.ok(await until(() => watcher.msgs.some((m) => m.t === 'anno' && m.id === 'ok1')), '正常标注仍能广播给房间里的人');

  for (const sp of spammers) sp.ws.close();
  watcher.ws.close();
  fresh.ws.close();
});

test('模糊：位置刷屏最终会把那条连接熔断，但房间和别人不受影响', async (t) => {
  const { srv, port, url } = await start();
  t.after(() => srv.close());

  const good = connect(url, '老实人');
  await until(() => good.state.opened);
  good.hello('老实人', 'peerGOOD01');
  await until(() => good.msgs.some((m) => m.t === 'welcome'));

  const rnd = mulberry32(777);
  const spam = connect(url, '刷屏的');
  await until(() => spam.state.opened);
  spam.hello('刷屏的', 'peerSPAM01');
  await until(() => spam.msgs.some((m) => m.t === 'welcome'));
  for (let i = 0; i < 400; i++) {
    try {
      const m = randMsg(rnd);
      m.t = 'pos';
      m.map = 'woods';
      m.x = rnd() * 100;
      m.z = rnd() * 100;
      m.trail = [{ x: 1, z: 1 }, { x: 2, z: 2 }];
      spam.ws.send(JSON.stringify(m));
    } catch {}
  }
  assert.ok(await until(() => spam.state.closed !== null || spam.msgs.some((m) => m.t === 'err' && m.code === 'rate-limit'), 3000),
    '刷屏那条应该被熔断');
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.strictEqual(health.ok, true);
  // 老实人没被牵连
  good.ws.send(JSON.stringify({ t: 'ping' }));
  assert.ok(await until(() => good.msgs.some((m) => m.t === 'pong')), '别人的连接不受影响');
  good.ws.close();
  spam.ws.close();
});
