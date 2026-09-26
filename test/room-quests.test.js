'use strict';

/**
 * 队友共享"我勾选的任务"：协议校验 + 客户端状态 + 渲染接线。
 *
 * 需求（用户原话）：
 *   - 勾选的任务也要能和队友共享；
 *   - 图例里有「XX勾选的任务」，和自己重复的任务**合并显示**、不重复画；
 *   - 鼠标放到地图上能看到是谁勾选的。
 *
 * 兼容性：这是**加能力**（服务端 welcome 里声明 caps: ['quests']），不升 PROTO ——
 * 新客户端连老服务端 = 该功能静默关闭，老客户端连新服务端 = 忽略不认识的字段。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const P = require('../server/protocol');
const RC = require('../src/room-client');

// 真实形状的任务 id（tarkov.dev 的 24 位 hex）
const T1 = '5a68760f86f7743cc55d8709';
const T2 = '5936d90786f7742b1420ba5b';
const T3 = '5c0e530286f7747fa1419862';

test('协议：sanitizeQuests 只认合法 id，去重、排序、限量、脏输入返回 null', () => {
  const sorted = [T1, T2].sort();
  assert.deepStrictEqual(P.sanitizeQuests({ ids: [T1, T2] }), sorted);
  assert.deepStrictEqual(P.sanitizeQuests({ ids: [T2, T1] }), sorted, '顺序规范化（集合语义）');
  assert.deepStrictEqual(P.sanitizeQuests({ ids: [T1, T1, T2] }), sorted, '去重');
  assert.deepStrictEqual(P.sanitizeQuests({ ids: [] }), [], '空数组合法（= 全取消）');
  assert.deepStrictEqual(P.sanitizeQuests({ ids: [T1, '', null, 42, '<script>', 'a b'] }), [T1], '非法项丢掉');
  assert.strictEqual(P.sanitizeQuests({ ids: 'not-an-array' }), null);
  assert.strictEqual(P.sanitizeQuests({}), null);
  assert.strictEqual(P.sanitizeQuests(null), null);
  // 上限：200 个（和客户端同一常量）
  const many = Array.from({ length: 500 }, (_, i) => `task${String(i).padStart(4, '0')}`);
  const capped = P.sanitizeQuests({ ids: many });
  assert.strictEqual(capped.length, P.LIMITS.QUESTS_MAX);
  assert.strictEqual(RC.QUEST_IDS_MAX, P.LIMITS.QUESTS_MAX, '两端上限必须一致');
  // 能力清单里必须有 quests，否则客户端不会发
  assert.ok(Array.isArray(P.CAPS) && P.CAPS.includes('quests'), '服务端要声明 quests 能力');
});

test('客户端：id 列表的清洗 / 服务端映射的归一化 / 人走了要清掉他的勾选', () => {
  assert.deepStrictEqual(RC.sanitizeQuestIds([T1, T1, 'bad id']), [T1]);
  assert.deepStrictEqual(RC.sanitizeQuestIds([T1, T2]), RC.sanitizeQuestIds([T2, T1]), '顺序无关（勾选是集合）');
  assert.strictEqual(RC.sanitizeQuestIds('x'), null);
  assert.deepStrictEqual(RC.normalizeQuests({ p1: [T1], p2: [T2, 'bad'] }), { p1: [T1], p2: [T2] });
  // 危险键：用 JSON.parse 造出真正的自有属性 __proto__（对象字面量那样写只是改原型）
  const evil = JSON.parse(`{"__proto__":["${T1}"],"constructor":["${T1}"],"p1":["${T1}"]}`);
  const norm = RC.normalizeQuests(evil);
  assert.deepStrictEqual(norm.p1, [T1]);
  assert.deepStrictEqual(Object.keys(norm), ['p1'], '危险键要丢掉（否则会污染原型）');
  assert.deepStrictEqual(RC.normalizeQuests(null), {});
  assert.deepStrictEqual(RC.normalizeQuests([T1]), {}, '数组不是合法映射');
  const q = { p1: [T1], p2: [T2] };
  assert.deepStrictEqual(RC.dropQuestOwner(q, 'p1'), { p2: [T2] });
  assert.strictEqual(RC.dropQuestOwner(q, 'nobody'), q, '没这个人就原样返回');
});

test('RoomClient：握手后整份发出、内容没变不重发、队友的勾选能收进来', () => {
  return (async () => {
    const sent = [];
    class FakeWS {
      constructor() {
        this.readyState = 1;
        this.sent = sent;
      }
      send(s) {
        sent.push(JSON.parse(s));
      }
      close() {}
      terminate() {}
      on() {}
    }
    const client = new RC.RoomClient({ WebSocketImpl: FakeWS, now: () => 1000, onLog: () => {} });
    client.cfg = { enabled: true, shareQuests: true, sharePos: true, shareAnno: true };
    client.ws = new FakeWS();

    // 服务端还没说支持 quests：不发（老服务端不会因为这个报错，但也没必要白发）
    assert.strictEqual(client.sendQuests([T1, T2]), false);
    assert.strictEqual(sent.filter((m) => m.t === 'quests').length, 0);

    // 服务端声明能力之后（welcome）：整份发一次
    client.onMessage(JSON.stringify({ t: 'welcome', self: { id: 'me', nick: '我' }, caps: ['quests'], peers: [], annos: {}, quests: { p9: [T2] } }));
    const questMsgs = sent.filter((m) => m.t === 'quests');
    assert.strictEqual(questMsgs.length, 1, '上线时要把我的勾选整份发一次');
    assert.deepStrictEqual(questMsgs[0].ids, RC.sanitizeQuestIds([T1, T2]));
    assert.deepStrictEqual(client.state.quests, { p9: [T2] }, 'welcome 里带的其他人的勾选要收下');
    assert.deepStrictEqual(client.state.peers, [], 'peers 里没写就不该凭空造人');

    // 内容没变：不重发
    assert.strictEqual(client.sendQuests([T2, T1]), false, '同一份勾选（顺序不同）不重复发');
    // 内容变了：再发
    assert.strictEqual(client.sendQuests([T1]), true);
    assert.deepStrictEqual(sent.filter((m) => m.t === 'quests').pop().ids, [T1]);

    // 队友改勾选 -> 整份覆盖（含空 = 他全取消了）
    client.onMessage(JSON.stringify({ t: 'peer-quests', id: 'p9', ids: [T1, T2] }));
    assert.deepStrictEqual(client.state.quests.p9, RC.sanitizeQuestIds([T1, T2]));
    client.onMessage(JSON.stringify({ t: 'peer-quests', id: 'p9', ids: [] }));
    assert.deepStrictEqual(client.state.quests.p9, []);
    // 不认识的字段/类型不许炸
    client.onMessage(JSON.stringify({ t: 'peer-quests' }));
    client.onMessage(JSON.stringify({ t: '什么鬼', ids: [T1] }));
    client.onMessage('not json');

    // 队友离开：他的勾选要一起清掉（不然图例里挂着一个走了的人）
    client.onMessage(JSON.stringify({ t: 'peer-join', peer: { id: 'p9', nick: '小明', quests: [T2] } }));
    assert.deepStrictEqual(client.state.quests.p9, [T2]);
    client.onMessage(JSON.stringify({ t: 'peer-left', id: 'p9' }));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(client.state.quests, 'p9'), false);
    assert.ok(!client.snapshot().peers.some((p) => p.id === 'p9'));

    // 关掉"共享勾选"：一个字都不发
    client.cfg = { enabled: true, shareQuests: false };
    const before = sent.filter((m) => m.t === 'quests').length;
    client.sendQuests([T2]);
    assert.strictEqual(sent.filter((m) => m.t === 'quests').length, before, '关了就不发');
  })();
});

test('peerQuestIndex + filterTasks：能筛"队友勾的"，两个筛选都开就是交集', () => {
  return (async () => {
    const { peerQuestIndex, filterTasks } = await import('../renderer/common/quest-filter.js');
    // 队友：p1 勾了 T2，p2 勾了 T2+T3（T2 是两人都勾的）
    const idx = peerQuestIndex({ p1: [T2], p2: [T2, T3], p3: [] });
    assert.deepStrictEqual([...idx.ids].sort(), [T2, T3].sort(), '有人勾过的任务集合');
    assert.deepStrictEqual(idx.byTask.get(T2), ['p1', 'p2'], '同一个任务要能列出所有勾选的队友');
    assert.deepStrictEqual(idx.byTask.get(T3), ['p2']);
    assert.deepStrictEqual([...idx.byPeer.keys()], ['p1', 'p2'], '空列表的人不算');
    assert.strictEqual(peerQuestIndex(null).ids.size, 0, '脏输入不抛');
    assert.strictEqual(peerQuestIndex({ p1: 'x' }).ids.size, 0);

    // 造 4 个任务：我勾了 T1/T3，队友勾了 T2/T3 -> 三种筛选结果各不相同
    const mk = (id) => ({ id, name: id, trader: 't', level: 0, maps: ['m'], objectives: [{ type: 'visit', zones: [{ map: 'm', x: 0, y: 0, z: 0 }], spots: [] }] });
    const tasks = [mk(T1), mk(T2), mk(T3), mk('other1')];
    const traders = new Map();
    const mine = new Set([T1, T3]);
    const base = { mapId: 'm', mapOnly: true, locationOnly: false };
    const ids = (list) => list.map((t) => t.id).sort();

    assert.deepStrictEqual(ids(filterTasks(tasks, traders, { ...base, checkedOnly: true, checked: mine })), [T1, T3].sort(), '只看我勾的');
    assert.deepStrictEqual(ids(filterTasks(tasks, traders, { ...base, peerCheckedOnly: true, peerChecked: idx.ids })), [T2, T3].sort(), '只看队友勾的');
    assert.deepStrictEqual(
      ids(filterTasks(tasks, traders, { ...base, checkedOnly: true, checked: mine, peerCheckedOnly: true, peerChecked: idx.ids })),
      [T3],
      '两个都开 = 只看我和队友都勾了的（交集）'
    );
    assert.deepStrictEqual(ids(filterTasks(tasks, traders, base)), [T1, T2, T3, 'other1'].sort(), '都不开 = 不按勾选过滤');
    // 没有队友勾选（没联机）时，开这个筛选就是空列表（界面会给解释性提示）
    assert.deepStrictEqual(filterTasks(tasks, traders, { ...base, peerCheckedOnly: true, peerChecked: peerQuestIndex({}).ids }), []);
  })();
});

test('questsFingerprint：内容变了才变（状态推送很频繁，不能每次都重算图层）', () => {
  return (async () => {
    const { questsFingerprint } = await import('../renderer/common/quest-filter.js');
    const a = questsFingerprint({ p1: [T1, T2] });
    assert.strictEqual(questsFingerprint({ p1: [T1, T2] }), a, '同样内容 -> 同样指纹');
    assert.strictEqual(questsFingerprint({ p1: [T2, T1] }), a, '顺序无关（集合语义）');
    assert.notStrictEqual(questsFingerprint({ p1: [T1] }), a, '少一个要变');
    assert.notStrictEqual(questsFingerprint({ p1: [T1, T2], p2: [T1] }), a, '多一个人要变');
    assert.strictEqual(questsFingerprint({ p1: [] }), questsFingerprint({}), '空列表等于没有');
    assert.strictEqual(typeof questsFingerprint(null), 'string', '脏输入也要返回字符串');
  })();
});

test('接线：服务端 / 客户端 / 渲染层三处都要接上（任何一处断了功能就是哑的）', () => {
  const html = read('renderer/map.html');
  const css = read('renderer/map.css');
  // 服务端
  const srv = read('server/server.js');
  assert.ok(srv.includes("case 'quests':"), '服务端要受理 quests 消息');
  assert.ok(srv.includes('function onQuests('), '缺少 onQuests');
  assert.ok(srv.includes("caps: P.CAPS"), 'welcome 要带能力清单');
  assert.ok(srv.includes('quests: questsFor(room)'), 'welcome 要带房间里已有的勾选');
  assert.ok(srv.includes("t: 'peer-quests'"), '变更要广播给其他人');
  assert.ok(/broadcast\(peer\.room, \{ t: 'peer-quests'[\s\S]{0,80}\}, peer\.id\)/.test(srv), '不回给发送者本人');
  assert.ok(srv.includes('if (peer.quests && peer.quests.length) out.quests = peer.quests'), '新加入的人要立刻看到别人勾了什么');

  // 客户端（主进程侧）
  const rc = read('src/room-client.js');
  assert.ok(rc.includes('sendQuests(ids)') && rc.includes('flushQuests()'), '要有整份发送');
  assert.ok(rc.includes("case 'peer-quests'"), '要收队友的勾选');
  assert.ok(rc.includes('this.flushQuests();'), '欢迎回来要补发一次');
  assert.ok(rc.includes('shareQuests'), '设置项要接上');
  const main = read('main.js');
  assert.ok(main.includes('function pushQuests()'), '主进程要有 pushQuests');
  assert.ok(main.includes('pushQuests();'), '进房/勾选变化时要推');

  // 渲染层：合并显示 + 图例项 + 悬停显示谁勾的
  const mv = read('renderer/common/map-view.js');
  assert.ok(mv.includes('item.mine'), '任务项要标"我自己也勾了"');
  assert.ok(mv.includes('item.peers'), '任务项要带勾选的队友 id');
  assert.ok(mv.includes('#questVisible('), '要按开关判断可见（合并后只要有一方可见就画）');
  assert.ok(mv.includes('`quest:peer:${pid}`'), '图例项 id 要按人分开');
  assert.ok(mv.includes('勾选的任务`'), '图例文字要是「XX勾选的任务」');
  assert.ok(mv.includes('ownersText'), '悬停要能看到是谁勾的');
  assert.ok(/titleNode\(`\$\{item\.label \|\| '任务'\}\$\{ownerTip\}/.test(mv), '任务标记的 tooltip 要带上勾选人');

  const mj = read('renderer/map.js');
  assert.ok(mj.includes('ownersOf'), '主窗口要按任务合并勾选人');
  assert.ok(mj.includes('mine: owners.has(') && mj.includes('peers,'), '要把 mine/peers 交给渲染层');
  assert.ok(mj.includes('questsFingerprint'), '队友勾选变了才重算');
  assert.ok(mj.includes('谁勾选了'), '卡片上要写谁勾选了');

  // 任务列表：筛选 + 角标 + 展开看具体是谁
  assert.ok(html.includes('id="qc-peer"'), '筛选区要有「队友勾选」chip');
  assert.ok(html.includes('队友勾选'), 'chip 文字要在界面上');
  assert.ok(mj.includes("chip('#qc-peer', 'peerCheckedOnly')"), 'chip 要接到 peerCheckedOnly');
  assert.ok(mj.includes('peerCheckedOnly: Boolean(quest.ui.peerCheckedOnly)'), '筛选要真的传给 filterTasks');
  assert.ok(mj.includes('peerChecked: peerIdx.ids'), '要把队友勾选的任务集合传进去');
  assert.ok(mj.includes('peerQuestIndex('), '要用 peerQuestIndex 建索引');
  assert.ok(mj.includes('peerCheckedOnly: Boolean(quest.ui.peerCheckedOnly),'), '筛选状态要存进配置');
  assert.ok(mj.includes('qbadge mine'), '自己的勾选要有「我」角标');
  assert.ok(mj.includes('qbadge peer'), '队友的勾选要有名字角标');
  assert.ok(mj.includes('questShortName') || mj.includes('peerShortName'), '角标名字要截断（长昵称不能撑爆布局）');
  assert.ok(mj.includes('quest-owner'), '展开明细要有一行"谁勾选"');
  assert.ok(mj.includes('questOwnersText(owners)'), '明细要写具体是谁');
  assert.ok(mj.includes('队友勾选 ${peerIdx.ids.size}'), '统计行要能看出队友勾了多少');
  assert.ok(mj.includes('还没有看到队友勾选的任务'), '没联机时开启该筛选要给解释');
  assert.ok(css.includes('.qbadge.mine') && css.includes('.qbadge.peer'), '两种角标的样式都要有');
  const mm = read('renderer/minimap.js');
  assert.ok(mm.includes('questCfg.peerQuests'), '雷达也要画队友勾选的任务');
  assert.ok(html.includes('id="set-room-quests"'), '设置页要有"共享勾选任务"开关');
});
