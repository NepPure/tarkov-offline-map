'use strict';

/**
 * 雷达（圆形小地图）上显示标注：三档模式 + 接线检查。
 *
 * 纯函数直接断言；接线部分按项目习惯做静态检查（这几处任何一处断了，
 * 症状都是"设置了没反应"，很难从界面上看出来）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

test('雷达标注模式：认不出来的一律回默认 all', () => {
  return (async () => {
    const { normalizeMiniAnnoMode, filterAnnosForMini, MINI_ANNO_MODES } = await import('../renderer/common/map-view.js');

    assert.deepStrictEqual(MINI_ANNO_MODES, ['off', 'mine', 'all']);
    assert.strictEqual(normalizeMiniAnnoMode('off'), 'off');
    assert.strictEqual(normalizeMiniAnnoMode('mine'), 'mine');
    assert.strictEqual(normalizeMiniAnnoMode('all'), 'all');
    // 老配置里没这个字段 / 手改坏 / 大小写与空白
    assert.strictEqual(normalizeMiniAnnoMode(undefined), 'all');
    assert.strictEqual(normalizeMiniAnnoMode(null), 'all');
    assert.strictEqual(normalizeMiniAnnoMode(''), 'all');
    assert.strictEqual(normalizeMiniAnnoMode('  ALL '), 'all');
    assert.strictEqual(normalizeMiniAnnoMode('Mine'), 'mine');
    assert.strictEqual(normalizeMiniAnnoMode('乱写'), 'all');
    assert.strictEqual(normalizeMiniAnnoMode(0), 'all');
  })();
});

test('雷达标注过滤：off 都不画 / mine 只画自己的 / all 两样都画', () => {
  return (async () => {
    const { filterAnnosForMini } = await import('../renderer/common/map-view.js');
    const mine = [{ id: 'a1' }, { id: 'a2' }];
    const peers = [{ id: 'b1', owner: 'p2' }];

    assert.deepStrictEqual(filterAnnosForMini('off', mine, peers), { mine: [], peers: [] });
    const onlyMine = filterAnnosForMini('mine', mine, peers);
    assert.deepStrictEqual(onlyMine.mine, mine);
    assert.deepStrictEqual(onlyMine.peers, []);
    const all = filterAnnosForMini('all', mine, peers);
    assert.deepStrictEqual(all.mine, mine);
    assert.deepStrictEqual(all.peers, peers);
    // 非法模式 = 默认 all
    assert.deepStrictEqual(filterAnnosForMini('nope', mine, peers), { mine, peers });
    // 广播里的 room 快照可能缺字段：非数组当空处理，绝不抛
    assert.deepStrictEqual(filterAnnosForMini('all', undefined, null), { mine: [], peers: [] });
    assert.deepStrictEqual(filterAnnosForMini('mine', 'x', {}), { mine: [], peers: [] });
  })();
});

test('接线：雷达重取标注靠 annosAt，主进程在标注变更后广播它', () => {
  const mm = read('renderer/minimap.js');
  assert.match(mm, /import \{[^}]*normalizeMiniAnnoMode[^}]*filterAnnosForMini[^}]*\} from '\.\/common\/map-view\.js'/,
    '雷达要 import 两个纯函数');
  assert.ok(mm.includes('normalizeMiniAnnoMode(s.config.miniAnnos)'), '模式要来自配置');
  assert.ok(mm.includes('view.setAnnotations(split.mine)'), '雷达要画我自己的标注');
  assert.ok(mm.includes('view.setPeerAnnos(split.peers)'), '雷达上队友的标注也要受模式控制');
  assert.ok(mm.includes('s.annosAt') && mm.includes('lastAnnosAt'), '只在 annosAt 变了才重取（不做每秒 IPC）');
  assert.ok(mm.includes('detail.id === wantMap'), '异步取标注后要校验地图没变（否则笔画会串到别的图）');

  const main = read('main.js');
  assert.ok(main.includes('broadcast({ annosAt: Date.now() })'), '标注存盘后要广播 annosAt');
  assert.ok(main.includes("miniAnnos: 'all'"), '默认"我的 + 队友的"');
  assert.ok(main.includes('annosAt: null'), 'state 里要有 annosAt');
});

test('接线：设置页有"雷达上显示标注"三档下拉，保存时写进配置', () => {
  const html = read('renderer/map.html');
  assert.ok(html.includes('id="set-mini-annos"'), '缺少 #set-mini-annos');
  for (const v of ['off', 'mine', 'all']) {
    assert.match(html, new RegExp(`<option value="${v}">`), `缺少选项 ${v}`);
  }
  // 三档对应的中文说明要在界面上（用户不看代码）
  assert.ok(html.includes('不显示') && html.includes('只显示我的') && html.includes('我的 + 队友的'));

  const js = read('renderer/map.js');
  assert.ok(js.includes("$('#set-mini-annos').value"), '打开设置要回填');
  assert.ok(js.includes("miniAnnos: $('#set-mini-annos').value"), '保存设置要提交');
  assert.ok(js.includes("['off', 'mine', 'all'].includes(c.miniAnnos)"), '旧配置里的非法值要兜住');
});
