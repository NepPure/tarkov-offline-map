'use strict';

/**
 * 「进图要带」清单：纯函数 + 渲染接线。
 *
 * 需求（用户原话）：任务展开详情里要**黄色高亮**"进任务要带啥，比如钥匙之类的"。
 * 数据来源是任务目标上的 requiredKeys（钥匙，可能是一组"任意一把"）与
 * 放置/使用类目标的 questItem（要带进图的东西）；
 * findItem/findQuestItem（进图去捡）与 giveItem（在任务界面交）**不算**要带 ——
 * 混进来会让清单变得又长又误导。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const dump = require('../data/quests-dump.json');

const nameOf = (id) => (dump.items && dump.items[id]) || null;

test('questBringList：钥匙按"组"收（组内是或关系），物品只收要带进图的', () => {
  return (async () => {
    const { questBringList, formatBringKeys } = await import('../renderer/common/quest-filter.js');
    const task = {
      objectives: [
        // 进图去捡：钥匙要带，但"捡的东西"不算要带
        { type: 'findQuestItem', item: 'item-found', requiredKeys: [['key-a', 'key-b'], ['key-c']] },
        // 放置类：要带进去
        { type: 'plantQuestItem', item: 'item-plant', count: 2 },
        // 使用类：要带进去
        { type: 'useItem', item: 'item-use', count: 1 },
        // 上交类：在任务界面交，不用带进图
        { type: 'giveItem', item: 'item-give', itemIds: ['x1', 'x2'] },
        // 击杀类：什么都不用带
        { type: 'shoot', item: null },
      ],
    };
    const names = { 'key-a': '宿舍306钥匙', 'key-b': '宿舍308钥匙', 'key-c': '机械钥匙', 'item-found': '文件', 'item-plant': '血液样本', 'item-use': '信号枪', 'item-give': '金链' };
    const bring = questBringList(task, (id) => names[id] || id);
    assert.deepStrictEqual(bring.keys, [['宿舍306钥匙', '宿舍308钥匙'], ['机械钥匙']], '同组是"或"，不同组是"、"');
    assert.deepStrictEqual(bring.items, [{ name: '血液样本', count: 2 }, { name: '信号枪', count: 1 }]);
    assert.strictEqual(bring.empty, false);
    assert.strictEqual(formatBringKeys(bring.keys), '宿舍306钥匙 或 宿舍308钥匙、机械钥匙');

    // 去重：同一个钥匙写在两个目标里只列一次
    const dup = questBringList({ objectives: [{ type: 'visit', requiredKeys: [['k1']] }, { type: 'visit', requiredKeys: [['k1'], ['k2']] }] }, () => '同一把钥匙');
    assert.deepStrictEqual(dup.keys, [['同一把钥匙']], '重名/重复的钥匙只留一份');

    // 什么都不用带的（比如纯"上交物品"）-> empty
    const none = questBringList({ objectives: [{ type: 'giveItem', item: 'a' }, { type: 'experience' }] }, () => 'x');
    assert.strictEqual(none.empty, true);
    assert.deepStrictEqual(none.keys, []);
    assert.deepStrictEqual(none.items, []);

    // 脏输入不许抛
    for (const bad of [null, undefined, {}, { objectives: null }, { objectives: [null, { requiredKeys: null, type: 'plantItem' }] }]) {
      const r = questBringList(bad, () => '');
      assert.strictEqual(r.empty, true, `脏输入要安全返回：${JSON.stringify(bad)}`);
    }
    // itemName 抛异常也要兜住（渲染层查表失败不能让整个面板崩）
    const r2 = questBringList({ objectives: [{ type: 'plantQuestItem', item: 'i1' }] }, () => { throw new Error('boom'); });
    assert.deepStrictEqual(r2.items, [{ name: 'i1', count: 1 }], '拿不到中文名就退回 id');
  })();
});

test('真实任务数据：能挑出钥匙/要带物品，且都能拿到中文名', async () => {
  const { questBringList } = await import('../renderer/common/quest-filter.js');
  const tasks = dump.tasks || [];
  let keyTasks = 0;
  let itemTasks = 0;
  for (const t of tasks) {
    const bring = questBringList(t, nameOf);
    if (bring.keys.length) keyTasks++;
    if (bring.items.length) itemTasks++;
    for (const g of bring.keys) {
      for (const n of g) assert.ok(typeof n === 'string' && n.trim(), `钥匙名字为空：${t.name}`);
    }
    for (const it of bring.items) {
      assert.ok(typeof it.name === 'string' && it.name.trim(), `物品名字为空：${t.name}`);
      assert.ok(it.count >= 1);
    }
  }
  assert.ok(keyTasks >= 40, `要钥匙的任务应该不少（实测 57 个），现在只有 ${keyTasks}`);
  assert.ok(itemTasks >= 5, `要带物品的任务应该有几个，现在只有 ${itemTasks}`);

  // 抽样核对一个已知任务：目标里有 requiredKeys 的，清单里必须有钥匙
  const sample = tasks.find((t) => (t.objectives || []).some((o) => (o.requiredKeys || []).length));
  const b = questBringList(sample, nameOf);
  assert.ok(b.keys.length >= 1, `${sample.name} 应该有要带的钥匙`);
});

test('接线：侧边栏明细最上面有黄色高亮的「进图要带」，折叠行有角标', () => {
  const js = read('renderer/map.js');
  assert.ok(js.includes('questBringList(task, questItemName)'), '明细要用 questBringList');
  assert.ok(js.includes('questBringHtml(') && js.includes('questBringBox('), '要有 HTML/节点两种产出（卡片 + 侧边栏）');
  assert.ok(/function questDetail[\s\S]{0,600}?wrap\.appendChild\(questBringBox\(bring\)\)/.test(js), '「进图要带」要放在明细最上面');
  assert.ok(/card\.innerHTML = `[\s\S]{0,200}?questBringHtml\(/.test(js), '点击地图标记的任务卡片里也要有');
  assert.ok(js.includes('qbadge bring'), '折叠状态要有角标（不然要点开才知道）');
  assert.ok(js.includes('formatBringKeys(bring.keys)'), '钥匙的"或"关系要保留');

  const importLine = js.match(/import \{([^}]*)\} from '\.\/common\/quest-filter\.js'/);
  assert.ok(importLine && importLine[1].includes('questBringList') && importLine[1].includes('formatBringKeys'), '要 import 两个纯函数');

  const css = read('renderer/map.css');
  assert.ok(css.includes('.quest-bring'), '缺少 .quest-bring 样式');
  assert.ok(/\.quest-bring \{[\s\S]{0,200}?rgba\(250,204,21/.test(css), '黄色高亮（和需求一致）');
  assert.ok(css.includes('.qbadge.bring'), '角标样式也要有');
});
