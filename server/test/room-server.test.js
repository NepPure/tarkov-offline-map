'use strict';

/**
 * 房间服务端集成测试：真起一个 HTTP+WS 服务端（内存态），用真的 WebSocket 客户端跑一遍。
 * 客户端用 Node 22 自带的全局 WebSocket，所以除了服务端自己的 ws 依赖，不需要别的测试替身。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createRoomServer } = require('../server.js');
const P = require('../protocol.js');

const ROOM = P.roomKey('测试房间', 'pw');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 用 node:http 而不是 fetch：undici 的 keep-alive 连接会让测试进程迟迟不退出
 * （node --test 要等事件循环空了才收尾），这里强制 connection: close。
 */
function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: pathname, agent: false, headers: { connection: 'close' } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, text: data }));
      },
    );
    req.on('error', reject);
  });
}

async function healthOf(port) {
  return JSON.parse((await httpGet(port, '/healthz')).text);
}

async function start(opts = {}) {
  const srv = createRoomServer({ host: '127.0.0.1', port: 0, logLevel: 'error', ...opts });
  const port = await new Promise((res) => srv.start(res));
  return { srv, port, url: `ws://127.0.0.1:${port}/ws` };
}

/** 一个假客户端：收消息进队列，next(类型) 按类型取（同类消息按下标先进先出） */
function makePeer(url, { nick = '小明', pid, v = P.PROTO, room = ROOM } = {}) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  let closedInfo = null;

  ws.addEventListener('message', (ev) => {
    let msg = null;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const i = waiters.findIndex((w) => w.t === msg.t);
    if (i >= 0) {
      waiters.splice(i, 1)[0].resolve(msg);
      return;
    }
    inbox.push(msg);
  });
  ws.addEventListener('error', () => {});
  const closedPromise = new Promise((res) => {
    ws.addEventListener('close', (ev) => {
      closedInfo = { code: ev.code, reason: ev.reason };
      res(closedInfo);
    });
  });

  const api = {
    ws,
    inbox,
    closed: () => closedPromise,
    get closedInfo() {
      return closedInfo;
    },
    open: () =>
      new Promise((res, rej) => {
        ws.addEventListener('open', () => res(api), { once: true });
        ws.addEventListener('error', (e) => rej(new Error(`连接失败: ${e.message || 'error'}`)), { once: true });
      }),
    send: (o) => ws.send(JSON.stringify(o)),
    hello: (over = {}) => api.send({ t: 'hello', v, room, nick, pid, ...over }),
    next(t, timeout = 3000) {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等「${t}」超时；已收到 ${JSON.stringify(inbox)}`)), timeout);
        waiters.push({
          t,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
    /** 断言"某类消息没来过"：等一小会儿再看队列 */
    async none(t, ms = 250) {
      await sleep(ms);
      return inbox.find((m) => m.t === t) || null;
    },
    close: () => {
      try {
        ws.close();
      } catch {}
    },
  };
  return api;
}

async function join(url, opts = {}) {
  const p = makePeer(url, opts);
  await p.open();
  p.hello();
  const w = await p.next('welcome');
  return { p, w };
}

// ---------------------------------------------------------------------------
test('进房：welcome 带回协议版本、自己的身份与房间快照；/healthz 可用', async (t) => {
  const { srv, port, url } = await start();
  t.after(() => srv.close());

  const { p, w } = await join(url, { nick: '小明' });
  t.after(() => p.close());

  assert.strictEqual(w.proto, P.PROTO);
  assert.match(w.ver, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(w.self.nick, '小明');
  assert.ok(w.self.id.length >= 4);
  assert.deepStrictEqual(w.peers, []);
  assert.deepStrictEqual(w.annos, {});

  const h = await healthOf(port);
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.proto, P.PROTO);
  assert.strictEqual(h.peers, 1);
  assert.strictEqual(h.rooms, 1);
  assert.strictEqual(h.persist, false);

  // 匿名状态页：不含房间标识（不然等于把暗号贴墙上）
  const text = (await httpGet(port, '/')).text;
  assert.match(text, /在线 1 人/);
  assert.ok(!text.includes(ROOM.slice(0, 12)), '状态页不该出现房间标识');
});

test('第二个人进房：老成员收到 peer-join，新人的 welcome 里有老成员', async (t) => {
  const { srv, url } = await start();
  t.after(() => srv.close());

  const { p: a } = await join(url, { nick: '阿尔法', pid: 'peerAAAA1' });
  const { p: b, w } = await join(url, { nick: '布拉沃', pid: 'peerBBBB2' });
  t.after(() => {
    a.close();
    b.close();
  });

  const j = await a.next('peer-join');
  assert.strictEqual(j.peer.id, 'peerBBBB2');
  assert.strictEqual(j.peer.nick, '布拉沃');
  assert.strictEqual(j.peer.map, null, '还没上报地图时是 null');

  assert.strictEqual(w.peers.length, 1);
  assert.strictEqual(w.peers[0].id, 'peerAAAA1');
  assert.strictEqual(w.peers[0].nick, '阿尔法');

  // 有人离开要通知剩下的人
  b.close();
  const left = await a.next('peer-left');
  assert.strictEqual(left.id, 'peerBBBB2');
});

test('地图与定位：广播给队友（不回自己），轨迹裁到上限', async (t) => {
  const { srv, url } = await start();
  t.after(() => srv.close());

  const { p: a } = await join(url, { nick: 'A', pid: 'peerAAAA1' });
  const { p: b } = await join(url, { nick: 'B', pid: 'peerBBBB2' });
  t.after(() => {
    a.close();
    b.close();
  });
  await a.next('peer-join');

  b.send({ t: 'map', map: 'interchange' });
  const pm = await a.next('peer-map');
  assert.deepStrictEqual([pm.id, pm.map], ['peerBBBB2', 'interchange']);

  b.send({
    t: 'pos',
    map: 'interchange',
    x: 10.126,
    z: -20.004,
    y: 3.5,
    hdg: 123.4,
    trail: Array.from({ length: 300 }, (_, i) => ({ x: i, z: i * 2 })),
  });
  const pp = await a.next('peer-pos');
  assert.strictEqual(pp.id, 'peerBBBB2');
  assert.strictEqual(pp.x, 10.13);
  assert.strictEqual(pp.z, -20);
  assert.strictEqual(pp.hdg, 123.4);
  assert.strictEqual(pp.trail.length, P.LIMITS.TRAIL_MAX);
  assert.strictEqual(pp.trail[0].x, 100, '裁的是末尾 200 个点（保留最近走过的路）');

  // 位置不回给自己（省一半流量）
  assert.strictEqual(await b.none('peer-pos'), null, '发送者不该收到自己的位置回显');

  // 位置消息限速：同一时刻连发两条，只应到一条
  b.send({ t: 'pos', map: 'interchange', x: 11, z: 21 });
  b.send({ t: 'pos', map: 'interchange', x: 12, z: 22 });
  const first = await a.next('peer-pos');
  assert.strictEqual(first.x, 11, '先到的应该是第一条');
  assert.strictEqual(await a.none('peer-pos', 300), null, '200ms 内的第二条位置应被限速丢掉');
  await sleep(220);
  b.send({ t: 'pos', map: 'interchange', x: 13, z: 23 });
  const pp2 = await a.next('peer-pos');
  assert.strictEqual(pp2.x, 13);
});

test('标注：add 广播给所有人（含自己）、后来的人从 welcome 拿到；只能删自己的', async (t) => {
  const { srv, url } = await start();
  t.after(() => srv.close());

  const { p: a } = await join(url, { nick: 'A', pid: 'peerAAAA1' });
  const { p: b } = await join(url, { nick: 'B', pid: 'peerBBBB2' });
  t.after(() => {
    a.close();
    b.close();
  });
  await a.next('peer-join');

  a.send({ t: 'anno', op: 'add', map: 'woods', id: 's1', kind: 'pen', color: '#ff0000', width: 3, pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] });
  const echo = await a.next('anno');
  assert.strictEqual(echo.op, 'add');
  assert.strictEqual(echo.owner, 'peerAAAA1');
  assert.strictEqual(echo.id, 's1');
  const seenByB = await b.next('anno');
  assert.strictEqual(seenByB.owner, 'peerAAAA1');
  assert.strictEqual(seenByB.pts.length, 2);

  // 后来的人进房就能看到（不需要额外拉取）
  const { p: c, w } = await join(url, { nick: 'C', pid: 'peerCCCC3' });
  t.after(() => c.close());
  assert.strictEqual(w.annos.woods.length, 1);
  assert.strictEqual(w.annos.woods[0].owner, 'peerAAAA1');
  assert.strictEqual(w.annos.woods[0].kind, 'pen');

  // B 删不掉 A 的（房间里人人平等，但这一条防手滑）
  b.send({ t: 'anno', op: 'del', map: 'woods', id: 's1' });
  assert.strictEqual(await a.none('anno'), null, '别人的删除请求不该生效');
  assert.strictEqual(await c.none('anno'), null);

  // B 也不能用 A 的 id 覆盖
  b.send({ t: 'anno', op: 'add', map: 'woods', id: 's1', kind: 'circle', pts: [{ x: 9, z: 9 }, { x: 8, z: 8 }] });
  assert.strictEqual(await a.none('anno'), null, '别人的 id 不能被覆盖');

  // 自己删自己的可以
  a.send({ t: 'anno', op: 'del', map: 'woods', id: 's1' });
  const del = await b.next('anno');
  assert.deepStrictEqual([del.op, del.id, del.owner], ['del', 's1', 'peerAAAA1']);
  const { p: d, w: w2 } = await join(url, { nick: 'D', pid: 'peerDDDD4' });
  t.after(() => d.close());
  assert.deepStrictEqual(w2.annos, {}, '删掉之后新进房的人看不到');
});

test('协议版本不一致：明确报错并断开，不做半吊子兼容', async (t) => {
  const { srv, url } = await start();
  t.after(() => srv.close());

  const p = makePeer(url, { v: 1, nick: '老客户端' });
  await p.open();
  p.hello();
  const err = await p.next('err');
  assert.strictEqual(err.code, 'bad-version');
  const info = await p.closed();
  assert.strictEqual(info.code, 4001);
});

test('第一帧必须是 hello / 房间标识非法：都拒', async (t) => {
  const { srv, url } = await start();
  t.after(() => srv.close());

  const p = makePeer(url, {});
  await p.open();
  p.send({ t: 'pos', map: 'woods', x: 1, z: 2 });
  const err = await p.next('err');
  assert.strictEqual(err.code, 'need-hello');
  assert.strictEqual((await p.closed()).code, 4007);

  const q = makePeer(url, { room: 'not-a-room-key' });
  await q.open();
  q.hello({ room: 'not-a-room-key' });
  const err2 = await q.next('err');
  assert.strictEqual(err2.code, 'bad-room');
  assert.strictEqual((await q.closed()).code, 4002);
});

test('房间满：拒绝第三个人，房里的人不受影响', async (t) => {
  const { srv, url } = await start({ maxRoomPeers: 2 });
  t.after(() => srv.close());

  const { p: a } = await join(url, { nick: 'A', pid: 'peerAAAA1' });
  const { p: b } = await join(url, { nick: 'B', pid: 'peerBBBB2' });
  t.after(() => {
    a.close();
    b.close();
  });

  const c = makePeer(url, { nick: 'C', pid: 'peerCCCC3' });
  await c.open();
  c.hello();
  const err = await c.next('err');
  assert.strictEqual(err.code, 'room-full');
  assert.strictEqual((await c.closed()).code, 4003);

  // 房里的两个人照旧通信
  b.send({ t: 'map', map: 'customs' });
  const pm = await a.next('peer-map');
  assert.strictEqual(pm.map, 'customs');
});

test('同一身份重连：旧连接被顶掉，新连接拿到房间快照', async (t) => {
  const { srv, url } = await start();
  t.after(() => srv.close());

  const { p: a } = await join(url, { nick: 'A', pid: 'peerAAAA1' });
  t.after(() => a.close());

  const b1 = makePeer(url, { nick: 'B', pid: 'peerBBBB2' });
  await b1.open();
  b1.hello();
  await b1.next('welcome');
  await a.next('peer-join');

  const b2 = makePeer(url, { nick: 'B', pid: 'peerBBBB2' });
  await b2.open();
  b2.hello();
  const w = await b2.next('welcome');
  t.after(() => b2.close());

  const err = await b1.next('err');
  assert.strictEqual(err.code, 'replaced');
  assert.strictEqual((await b1.closed()).code, 4005);
  assert.strictEqual(w.peers.length, 1, '重连后房间里还是 A + B 两个人');
  assert.strictEqual(w.peers[0].id, 'peerAAAA1');
});

test('超大帧直接被拒（ws 层 1009）', async (t) => {
  const { srv, url } = await start();
  t.after(() => srv.close());

  const { p } = await join(url, { nick: 'A' });
  p.send({ t: 'pos', map: 'woods', x: 1, z: 2, pad: 'x'.repeat(P.LIMITS.FRAME_MAX + 1024) });
  const info = await p.closed();
  assert.strictEqual(info.code, 1009, `超长帧应以 1009 断开，实际 ${info.code}`);
});

test('房间空置后按 TTL 回收（内存不会只涨不跌）', async (t) => {
  const { srv, port, url } = await start({ roomTtlMs: 150 });
  t.after(() => srv.close());

  const { p } = await join(url, { nick: 'A' });
  p.close();
  await p.closed();
  await sleep(400);
  const h = await healthOf(port);
  assert.strictEqual(h.rooms, 0);
  assert.strictEqual(h.peers, 0);
});

test('可选落盘：PERSIST=1 时房间重建后标注还在', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takov-room-'));
  const { srv, url } = await start({ persist: true, dataDir: dir, saveDebounceMs: 5 });
  const { p } = await join(url, { nick: 'A', pid: 'peerAAAA1' });
  p.send({ t: 'anno', op: 'add', map: 'woods', id: 's1', kind: 'arrow', color: '#00ff00', width: 5, pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] });
  await p.next('anno');
  await sleep(60);
  p.close();
  await p.closed();
  await new Promise((r) => srv.close(r));

  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.endsWith('.json')), `应该写出房间文件，实际 ${files.join(',')}`);

  // 新进程（新实例）拿到同一个 dataDir -> 进房就能看到旧标注
  const s2 = await start({ persist: true, dataDir: dir });
  t.after(() => s2.srv.close());
  const { p: q, w } = await join(s2.url, { nick: 'B', pid: 'peerBBBB2' });
  t.after(() => q.close());
  assert.strictEqual(w.annos.woods.length, 1);
  assert.strictEqual(w.annos.woods[0].kind, 'arrow');
  assert.strictEqual(w.annos.woods[0].owner, 'peerAAAA1');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('不落盘时不会碰磁盘：默认纯内存', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takov-room0-'));
  const { srv, url } = await start({ persist: false, dataDir: dir });
  const { p } = await join(url, { nick: 'A' });
  p.send({ t: 'anno', op: 'add', map: 'woods', id: 's1', kind: 'pen', pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] });
  await p.next('anno');
  srv.flushAll();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'PERSIST=0 时不该写任何文件');
  p.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
