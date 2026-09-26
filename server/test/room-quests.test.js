'use strict';

/**
 * 房间服务端：勾选任务的转发（集成测试，真起服务端 + 真 WebSocket）。
 *
 * 验的是"服务端只是个不认内容的转发器"这件事：
 *   - welcome 里声明 caps: ['quests'] 并把房间里已有的勾选带上
 *   - 收到 quests -> 广播 peer-quests（不回给发送者本人）
 *   - 空数组也要广播（= 他全取消了，不然队友那边一直挂着他的旧勾选）
 *   - 脏数据（非数组/超长/非法 id/重复）被过滤，连接不受影响
 */
const test = require('node:test');
const assert = require('node:assert');

const { createRoomServer } = require('../server.js');
const P = require('../protocol.js');

const ROOM = P.roomKey('勾选任务房间', 'pw');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T1 = '5a68760f86f7743cc55d8709';
const T2 = '5936d90786f7742b1420ba5b';

async function start() {
  const srv = createRoomServer({ host: '127.0.0.1', port: 0, logLevel: 'error' });
  const port = await new Promise((res) => srv.start(res));
  return { srv, url: `ws://127.0.0.1:${port}/ws` };
}

function makePeer(url, { nick = '小明', pid, room = ROOM } = {}) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
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
  const api = {
    ws,
    inbox,
    open: () =>
      new Promise((res, rej) => {
        ws.addEventListener('open', () => res(api), { once: true });
        ws.addEventListener('error', (e) => rej(new Error(`连接失败: ${e.message || 'error'}`)), { once: true });
      }),
    send: (o) => ws.send(JSON.stringify(o)),
    hello: () => api.send({ t: 'hello', v: P.PROTO, room, nick, pid }),
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

test('服务端：welcome 带能力与已有勾选，变更广播给其他人，空列表也广播', async () => {
  const { srv, url } = await start();
  try {
    const { p: a, w: wa } = await join(url, { nick: 'A', pid: 'peerAAAA' });
    assert.ok(Array.isArray(wa.caps) && wa.caps.includes('quests'), 'welcome 要声明 quests 能力');
    assert.deepStrictEqual(wa.quests, {}, '刚开始房间里没人有勾选');

    // A 报上自己的勾选（故意乱序 + 重复，服务端要规范化）
    a.send({ t: 'quests', ids: [T2, T1, T1] });
    // 自己不该收到 peer-quests（客户端本来就有一份）
    assert.strictEqual(await a.none('peer-quests'), null, '不该回给发送者本人');

    // B 后进来：welcome 里要能直接看到 A 的勾选（不用等下一次变更）
    const { p: b, w: wb } = await join(url, { nick: 'B', pid: 'peerBBBB' });
    assert.deepStrictEqual(wb.quests.peerAAAA, [T1, T2].sort(), 'welcome 要带房间里已有的勾选');
    const inPeers = (wb.peers || []).find((x) => x.id === 'peerAAAA');
    assert.deepStrictEqual(inPeers.quests, [T1, T2].sort(), '成员信息里也要带（点开图例就能看到）');

    // B 改勾选 -> A 收到 peer-quests
    b.send({ t: 'quests', ids: [T1] });
    const got = await a.next('peer-quests');
    assert.strictEqual(got.id, 'peerBBBB');
    assert.deepStrictEqual(got.ids, [T1]);

    // 空数组也要广播（= 他全取消了）
    b.send({ t: 'quests', ids: [] });
    const cleared = await a.next('peer-quests');
    assert.deepStrictEqual(cleared.ids, [], '取消勾选要让队友知道');

    // C 再进来：B 已经清空了，welcome 里不该有他
    const { w: wc } = await join(url, { nick: 'C', pid: 'peerCCCC' });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(wc.quests, 'peerBBBB'), false, '取消干净的人不该还挂在 welcome 里');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(wc.quests, 'peerAAAA'), true, 'A 的勾选还在');

    a.close();
    b.close();
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('服务端：脏数据被过滤，连接照常（不崩、不断）', async () => {
  const { srv, url } = await start();
  try {
    const { p: a } = await join(url, { nick: 'A', pid: 'peerAAAA' });
    const { p: b } = await join(url, { nick: 'B', pid: 'peerBBBB' });

    // 非数组 / 缺字段：直接忽略（不该广播、也不该断开）
    a.send({ t: 'quests', ids: 'nope' });
    a.send({ t: 'quests' });
    a.send({ t: 'quests', ids: [T1, '', 42, null, 'x'.repeat(200)] });
    const got = await b.next('peer-quests');
    assert.deepStrictEqual(got.ids, [T1], '只有合法的那个活下来');

    // 超长：截到上限（200），连接仍然健在
    const many = Array.from({ length: 500 }, (_, i) => `task${String(i).padStart(4, '0')}`);
    a.send({ t: 'quests', ids: many });
    const capped = await b.next('peer-quests');
    assert.strictEqual(capped.ids.length, P.LIMITS.QUESTS_MAX);

    // 未知消息类型：静默忽略（老服务端遇到新消息就是这个行为，所以不升 PROTO 也安全）
    a.send({ t: '完全没见过的类型', ids: [T1] });
    assert.strictEqual(await b.none('peer-quests'), null, '未知类型不该产生广播');
    a.send({ t: 'ping' });
    const pong = await a.next('pong');
    assert.ok(pong, '连接还活着');

    a.close();
    b.close();
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
