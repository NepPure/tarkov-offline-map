'use strict';

/**
 * 服务端的各种"守卫"行为：连接数上限、公开状态页开关、反代 IP 识别、
 * 位置限速熔断、标注数量上限、未知消息兼容性。
 *
 * 这些平时都是"出事了才想起来"的分支，用单测钉住，改代码时不会悄悄失效。
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WebSocket } = require('ws');

const { createRoomServer } = require('../server.js');
const P = require('../protocol.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOM = P.roomKey('守卫测试', '');

async function start(opts = {}) {
  const srv = createRoomServer({ host: '127.0.0.1', port: 0, logLevel: 'error', ...opts });
  const port = await new Promise((res) => srv.start(res));
  return { srv, port, url: `ws://127.0.0.1:${port}/ws` };
}

/** 用 ws 库直连（能拿到握手失败时的 HTTP 响应，Node 自带的 WebSocket 看不到） */
function rawConnect(url, opts = {}) {
  const ws = new WebSocket(url, opts);
  const msgs = [];
  const state = { statusCode: null, opened: false, closed: null, err: null };
  ws.on('open', () => {
    state.opened = true;
  });
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString('utf8'))));
  ws.on('close', (code, reason) => {
    state.closed = { code, reason: String(reason || '') };
  });
  ws.on('error', (e) => {
    state.err = e.message;
  });
  ws.on('unexpected-response', (_req, res) => {
    state.statusCode = res.statusCode;
    res.resume();
  });
  return { ws, msgs, state, hello: (nick = '甲', pid) => ws.send(JSON.stringify({ t: 'hello', v: P.PROTO, room: ROOM, nick, pid })) };
}

/** 等某个条件成立（或超时） */
async function until(fn, timeout = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

function httpGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, agent: false, headers: { connection: 'close', ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
  });
}

test('单 IP 连接数上限：超了直接 429，连 WS 握手都不给', async (t) => {
  const { srv, port, url } = await start({ maxConnPerIp: 2 });
  t.after(() => srv.close());

  const a = rawConnect(url);
  const b = rawConnect(url);
  await until(() => a.state.opened && b.state.opened);
  assert.ok(a.state.opened && b.state.opened, '前两条应该连得上');

  const c = rawConnect(url);
  await until(() => c.state.statusCode !== null || c.state.opened);
  assert.strictEqual(c.state.statusCode, 429, `第三条应该被 429 拒掉，实际 ${c.state.statusCode}`);
  a.ws.close();
  b.ws.close();
  c.ws.close();
});

test('TRUST_PROXY=1：按 X-Forwarded-For 识别客户端（反代后面限流才不会算成一个人）', async (t) => {
  const { srv, url } = await start({ maxConnPerIp: 1, trustProxy: true });
  t.after(() => srv.close());

  const a = rawConnect(url, { headers: { 'x-forwarded-for': '10.0.0.1' } });
  await until(() => a.state.opened);
  // 同一个 IP 再来一条：应该被拒
  const b = rawConnect(url, { headers: { 'x-forwarded-for': '10.0.0.1' } });
  await until(() => b.state.statusCode !== null);
  assert.strictEqual(b.state.statusCode, 429, '同一个 XFF 应该算同一个人');
  // 换个 XFF：虽然 socket 都是 127.0.0.1，但应被当成另一个客户端放行
  const c = rawConnect(url, { headers: { 'x-forwarded-for': '10.0.0.2' } });
  await until(() => c.state.opened || c.state.statusCode !== null);
  assert.ok(c.state.opened, `换了 XFF 应该放行，实际 status=${c.state.statusCode}`);
  a.ws.close();
  b.ws.close();
  c.ws.close();
});

test('PUBLIC_STATUS=0：关掉匿名状态页，但健康检查照旧（docker healthcheck 不能死）', async (t) => {
  const { srv, port } = await start({ publicStatus: false });
  t.after(() => srv.close());

  const root = await httpGet(port, '/');
  assert.strictEqual(root.status, 404);
  const health = await httpGet(port, '/healthz');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(JSON.parse(health.text).ok, true);
});

test('位置上报太密会熔断（4006），不会让一个人把服务端刷爆', async (t) => {
  const { srv, url } = await start();
  t.after(() => srv.close());

  const p = rawConnect(url);
  await until(() => p.state.opened);
  p.hello('刷屏侠');
  await until(() => p.msgs.some((m) => m.t === 'welcome'));
  // 服务端位置限速是 200ms 一条，连续丢 200 条以上就熔断
  for (let i = 0; i < 260; i++) p.ws.send(JSON.stringify({ t: 'pos', map: 'woods', x: i, z: i }));
  await until(() => p.msgs.some((m) => m.t === 'err' && m.code === 'rate-limit') || p.state.closed);
  const err = p.msgs.find((m) => m.t === 'err');
  assert.ok(err && err.code === 'rate-limit', `应该收到 rate-limit，实际 ${JSON.stringify(p.msgs.slice(-3))}`);
  p.ws.close();
});

test('房间标注总数上限：超了报 anno-limit，而不是把内存吃光', async (t) => {
  const { srv, url } = await start({ maxAnnosPerRoom: 3 });
  t.after(() => srv.close());

  const p = rawConnect(url);
  await until(() => p.state.opened);
  p.hello('画师');
  await until(() => p.msgs.some((m) => m.t === 'welcome'));
  for (let i = 0; i < 5; i++) {
    p.ws.send(JSON.stringify({ op: 'add', t: 'anno', map: 'woods', id: `s${i}`, kind: 'pen', color: '#ffffff', width: 2, pts: [{ x: i, z: i }, { x: i + 1, z: i + 1 }] }));
  }
  await until(() => p.msgs.some((m) => m.t === 'err' && m.code === 'anno-limit'));
  const adds = p.msgs.filter((m) => m.t === 'anno');
  assert.strictEqual(adds.length, 3, `只该存下 3 笔，实际 ${adds.length}`);
  assert.ok(p.msgs.some((m) => m.t === 'err' && m.code === 'anno-limit'));
  p.ws.close();
});

test('单张图标注上限（STROKES_PER_MAP）也拦得住', async (t) => {
  const { srv, url } = await start({ maxAnnosPerRoom: 5000 });
  t.after(() => srv.close());

  const p = rawConnect(url);
  await until(() => p.state.opened);
  p.hello('画师2');
  await until(() => p.msgs.some((m) => m.t === 'welcome'));
  const cap = P.LIMITS.STROKES_PER_MAP;
  for (let i = 0; i < cap + 2; i++) {
    p.ws.send(JSON.stringify({ op: 'add', t: 'anno', map: 'woods', id: `t${i}`, kind: 'pen', color: '#ffffff', width: 2, pts: [{ x: 1, z: 1 }, { x: 2, z: 2 }] }));
  }
  await until(() => p.msgs.some((m) => m.t === 'err' && m.code === 'anno-limit'), 4000);
  assert.strictEqual(p.msgs.filter((m) => m.t === 'anno').length, cap, `只该存下 ${cap} 笔`);
  p.ws.close();
});

test('未知消息类型被静默忽略（以后加消息类型，老服务端不会炸）', async (t) => {
  const { srv, url } = await start();
  t.after(() => srv.close());

  const p = rawConnect(url);
  await until(() => p.state.opened);
  p.hello('未来人');
  await until(() => p.msgs.some((m) => m.t === 'welcome'));
  p.ws.send(JSON.stringify({ t: '未来才有的消息', foo: 1 }));
  p.ws.send(JSON.stringify({ t: 'ping' }));
  assert.ok(await until(() => p.msgs.some((m) => m.t === 'pong')), '未知消息之后连接照旧可用（能收到 pong）');
  assert.ok(!p.state.closed, '不该因为未知消息断开');
  p.ws.close();
});

test('删不存在的标注：不报错也不广播（乱删别人的也无效）', async (t) => {
  const { srv, url } = await start();
  t.after(() => srv.close());

  const a = rawConnect(url);
  const b = rawConnect(url);
  await until(() => a.state.opened && b.state.opened);
  a.hello('甲', 'peerAAAA1');
  b.hello('乙', 'peerBBBB2');
  await until(() => a.msgs.some((m) => m.t === 'welcome') && b.msgs.some((m) => m.t === 'welcome'));
  await until(() => a.msgs.some((m) => m.t === 'peer-join'));

  // 删一个从没存在过的 id
  a.ws.send(JSON.stringify({ t: 'anno', op: 'del', map: 'woods', id: '不存在' }));
  // 乙也删一个不存在的
  b.ws.send(JSON.stringify({ t: 'anno', op: 'del', map: 'woods', id: '也不存在' }));
  await sleep(250);
  assert.deepStrictEqual(a.msgs.filter((m) => m.t === 'anno'), [], '不该有任何 anno 广播');
  assert.deepStrictEqual(b.msgs.filter((m) => m.t === 'anno'), []);
  assert.ok(!a.state.closed && !b.state.closed, '也不该断开');
  a.ws.close();
  b.ws.close();
});
