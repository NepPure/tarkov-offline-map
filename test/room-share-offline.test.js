'use strict';

/**
 * 离场队友的共享内容必须**跟着下线**（真服务端 + 两个真客户端，不需要 GUI）。
 *
 * 用户报的：队友在地图上画了标注并共享，他退出房间后**标注还挂在图上**，
 * 右边却没他的图例了。根因见 renderer/common/room.js 顶部那段注释：
 * 服务端**有意保留**离场者的标注（他回来还能看到、不用重画），而且新加入/重连时的
 * `welcome` 会把房间里所有标注一次性发过来 —— owner 可能早就不在房间里了。
 *
 * 这个测试把整条链路真跑一遍（ws 真连、服务端真广播），断言：
 *   1) 人在场时：他的标注/勾选在我这边是"可见"的；
 *   2) 他一走：原始数据还在（这样他回来能立刻恢复），但**过滤后为空** —— 图上/图例里都不该有他；
 *   3) 根因复现：他走之后**新进房的人**拿到 welcome，里面仍然带着他的笔画（服务端保留），
 *      但过滤后同样不画 —— 修之前这一步就会把离线队友的笔画画到新人的图上；
 *   4) 他回来（同一个 peerId）：立刻又可见，**不需要他重发标注**（勾选会按协议整份重发）。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createRoomServer } = require('../server/server.js');
const { RoomClient } = require('../src/room-client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等一个条件成立（超时返回 null，附上最后一次的值由调用方断言） */
async function waitFor(fn, ms = 5000, step = 40) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(step);
  }
}

function startServer() {
  const srv = createRoomServer({ host: '127.0.0.1', port: 0, logLevel: 'error' });
  return new Promise((resolve) => {
    srv.start((port) => resolve({ srv, port }));
  });
}

function join(port, roomId, peerId, nick) {
  const c = new RoomClient({ onState: () => {}, onLog: () => {} });
  c.applyConfig({
    enabled: true, url: '127.0.0.1', port, roomId, pass: '', nick, peerId,
    sharePos: true, shareAnno: true, shareQuests: true, ver: '2.2.0',
  });
  return c;
}

const online = (c) => waitFor(() => c.snapshot().status === 'online');

test('离场队友的共享标注/勾选：人在就画、人走就下线、回来又出现', async (t) => {
  const { pruneRoomToOnline } = await import('../renderer/common/room.js');
  const { srv, port } = await startServer();
  const roomId = `离线验收-${Date.now().toString(36)}`;

  const A = join(port, roomId, 'peerAAAAA1', '甲号');
  const B = join(port, roomId, 'peerBBBBB1', '乙号');
  t.after(() => { try { A.destroy(); } catch {} try { B.destroy(); } catch {} srv.close(); });

  assert.ok(await online(A), '甲应该能进房');
  assert.ok(await online(B), '乙应该能进房');
  assert.ok(await waitFor(() => B.snapshot().peers.some((p) => p.id === 'peerAAAAA1')), '乙应该看得到甲');

  // ---- 1) 人在场：共享的标注与勾选都可见 ----
  A.sendAnnoAdd({ id: 'anno-1', map: 'woods', kind: 'pen', color: '#f87171', width: 4, pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] });
  const gotAnno = await waitFor(() => (B.snapshot().annos.woods || []).length === 1);
  assert.ok(gotAnno, '乙应该收到甲画的标注');
  assert.strictEqual(B.snapshot().annos.woods[0].owner, 'peerAAAAA1', '标注要带 owner（按人开关/过滤都要用）');
  assert.strictEqual(pruneRoomToOnline(B.snapshot()).annos.woods.length, 1, '人在场时，过滤后依然要画出来');

  A.sendQuests(['taskAAAAAA', 'taskBBBBBB']);
  const gotQuests = await waitFor(() => ((B.snapshot().quests || {}).peerAAAAA1 || []).length === 2);
  assert.ok(gotQuests, '乙应该收到甲共享的勾选任务');
  assert.deepStrictEqual(Object.keys(pruneRoomToOnline(B.snapshot()).quests), ['peerAAAAA1'], '人在场时勾选也要算');

  // ---- 2) 甲退出房间：原始数据留着（他回来要立刻恢复），但过滤后必须为空 ----
  A.disconnect('验收：甲退出房间');
  assert.ok(await waitFor(() => B.snapshot().peers.length === 0), '甲走了，乙的成员表里不该还有他');

  const raw = B.snapshot();
  assert.strictEqual((raw.annos.woods || []).length, 1,
    '客户端那份原始数据要留着 —— 否则他回来只能靠重发（而退出后只补发当前这张图）');
  const pruned = pruneRoomToOnline(raw);
  assert.deepStrictEqual(pruned.annos, {}, '甲不在房间里 -> 他的标注一笔都不该画（用户报的那条）');
  assert.deepStrictEqual(pruned.quests, {}, '他的共享勾选也要一起下线（图例/任务面板都不该再算他）');
  assert.strictEqual((raw.quests || {}).peerAAAAA1, undefined, '勾选直接从客户端状态里清掉（他重进房会整份重发）');

  // ---- 3) 根因复现：他走之后新进房的人，welcome 里仍然带着他的笔画 ----
  const C = join(port, roomId, 'peerCCCCC1', '丙号');
  t.after(() => { try { C.destroy(); } catch {} });
  assert.ok(await online(C), '丙应该能进房');
  const seeByNewcomer = await waitFor(() => (C.snapshot().annos.woods || []).length === 1);
  assert.ok(seeByNewcomer, '服务端确实把"离线队友的标注"也发给了新进房的人（这就是 bug 的来源）');
  assert.ok(!C.snapshot().peers.some((p) => p.id === 'peerAAAAA1'), '丙的成员表里没有甲（甲已经不在房间里了）');
  assert.deepStrictEqual(pruneRoomToOnline(C.snapshot()).annos, {}, '新进房的人也不该画一个不在房间里的人的笔画');

  // ---- 4) 甲带着同一个 peerId 回来：标注不用重发就恢复；勾选按主进程的做法补一遍 ----
  const A2 = join(port, roomId, 'peerAAAAA1', '甲号');
  t.after(() => { try { A2.destroy(); } catch {} });
  assert.ok(await online(A2), '甲应该能重新进房');
  assert.ok(await waitFor(() => B.snapshot().peers.some((p) => p.id === 'peerAAAAA1')), '乙应该又看到甲了');
  assert.strictEqual(pruneRoomToOnline(B.snapshot()).annos.woods.length, 1,
    '甲一回来，同一份数据立刻又能画出来（他没重发过标注 —— 重连不做全量补发）');
  // 勾选是"整份覆盖"协议，靠持有方在每次进房时重推：主进程 syncRoom -> onOnline -> pushQuests()
  // 会把 settings.quests.checked 再发一遍（见 main.js）。这里照做，验"回来之后又算他"。
  A2.sendQuests(['taskAAAAAA', 'taskBBBBBB']);
  assert.ok(await waitFor(() => ((B.snapshot().quests || {}).peerAAAAA1 || []).length === 2),
    '回来后勾选补发一次就该恢复（协议是整份覆盖，不靠服务端留存）');
  assert.deepStrictEqual(pruneRoomToOnline(B.snapshot()).quests.peerAAAAA1,
    ['taskAAAAAA', 'taskBBBBBB'], '恢复的就是甲原来那两个（丙的空勾选不参与）');

  // 丙也应当恢复（他一直在房间里，靠的是本地留着的那份）
  assert.strictEqual(pruneRoomToOnline(C.snapshot()).annos.woods.length, 1, '丙那边也一样立刻恢复');
});
