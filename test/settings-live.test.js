'use strict';

/**
 * 设置面板「即时生效」的映射表与取值规则。
 *
 * 这一组测试的重点是**别再漏接控件**：设置页没有「保存 / 取消」之后，
 * 忘了绑定的控件表现就是"点了没反应、也没提示"，从界面上根本看不出来。
 * 所以这里对着 renderer/map.html 逐个数：每个 `#set-*` 控件要么在 LIVE_FIELDS 里，
 * 要么在 LIVE_ACTIONS 里（只做事、不写配置的按钮）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

test('设置页的每个控件都有归宿（LIVE_FIELDS 或 LIVE_ACTIONS）', () => {
  return (async () => {
    const { LIVE_FIELDS, LIVE_ACTIONS } = await import('../renderer/common/settings-live.js');
    const html = read('renderer/map.html');
    const dialog = html.slice(html.indexOf('id="settings-dialog"'), html.indexOf('id="about-dialog"'));
    // 只看真正的表单控件（input / select / textarea）：纯展示的提示行不需要绑定
    const ids = [
      ...[...dialog.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="(set-[a-z0-9-]+)"/g)].map((m) => m[1]),
      ...[...dialog.matchAll(/id="(set-[a-z0-9-]+)"[^>]*\btype="(?:range|checkbox|text|number|password)"/g)].map((m) => m[1]),
    ];
    const uniq = [...new Set(ids)];
    // 按钮（只做事）单独数一遍
    const buttons = [...dialog.matchAll(/<button\b[^>]*\bid="([a-z0-9-]+)"/g)].map((m) => m[1]);
    assert.ok(uniq.length >= 20, `设置页控件太少（${uniq.length} 个），HTML 是不是被改坏了？`);

    const wired = new Set(LIVE_FIELDS.map((f) => f.sel.replace(/^#/, '')));
    const actions = new Set(LIVE_ACTIONS.map((s) => s.replace(/^#/, '')));
    const missing = uniq.filter((id) => !wired.has(id) && !actions.has(id));
    assert.deepStrictEqual(missing, [], `这些设置控件既没绑配置、也不在动作白名单里：${missing.join(', ')}`);
    for (const b of buttons) {
      assert.ok(actions.has(b) || wired.has(b), `按钮 #${b} 既没绑配置也不在动作白名单里`);
    }

    // 反向：映射表里的选择器必须在 HTML 里真实存在（改名了要一起改）
    const idSet = new Set([...uniq, ...buttons, 'settings-dialog']);
    const dangling = LIVE_FIELDS.map((f) => f.sel.replace(/^#/, '')).filter((id) => !idSet.has(id));
    assert.deepStrictEqual(dangling, [], `LIVE_FIELDS 里这些控件在设置页找不到：${dangling.join(', ')}`);
    const danglingActions = [...actions].filter((id) => !idSet.has(id));
    assert.deepStrictEqual(danglingActions, [], `LIVE_ACTIONS 里这些控件在设置页找不到：${danglingActions.join(', ')}`);
  })();
});

test('设置页没有「保存 / 取消」按钮，只有「关闭」', () => {
  const html = read('renderer/map.html');
  const dialog = html.slice(html.indexOf('id="settings-dialog"'), html.indexOf('id="about-dialog"'));
  assert.ok(!/id="settings-ok"/.test(dialog), '还在用旧的「保存」按钮');
  assert.ok(/id="settings-close"/.test(dialog), '缺少「关闭」按钮');
  assert.ok(!/>\s*取消\s*</.test(dialog.slice(dialog.indexOf('dialog-actions'))), '设置页还留着「取消」按钮');
  assert.ok(/settings-live/.test(dialog), '缺少「改动即时生效」的说明行');
});

test('即时生效的接线：map.js 真的在跑 bindLiveSettings，且不再引用 settings-ok', () => {
  const js = read('renderer/map.js');
  assert.ok(/bindLiveSettings\(\)/.test(js), 'map.js 没有调用 bindLiveSettings');
  assert.ok(/from '\.\/common\/settings-live\.js'/.test(js), 'map.js 没有引入 settings-live');
  assert.ok(!/settings-ok/.test(js), 'map.js 还在引用已删除的 #settings-ok');
  assert.ok(!/function saveSettings/.test(js), '旧的 saveSettings 还留着（会和即时生效打架）');
});

test('取值规则：勾选 / 滑块 / 整数 / 文本 / 口令', () => {
  return (async () => {
    const { readLiveValue } = await import('../renderer/common/settings-live.js');
    assert.strictEqual(readLiveValue({ kind: 'bool' }, { checked: true }), true);
    assert.strictEqual(readLiveValue({ kind: 'bool' }, { checked: false }), false);
    assert.strictEqual(readLiveValue({ kind: 'num', min: 0.2, max: 1 }, { value: '0.85' }), 0.85);
    // 夹到区间里（滑块范围被改小、手改配置文件都不会越界）
    assert.strictEqual(readLiveValue({ kind: 'num', min: 0.2, max: 1 }, { value: '5' }), 1);
    assert.strictEqual(readLiveValue({ kind: 'num', min: 0.2, max: 1 }, { value: '0' }), 0.2);
    // 空值 / 乱写 -> fallback，而不是 NaN 或 0
    assert.strictEqual(readLiveValue({ kind: 'int', min: 1, max: 10, fallback: 3 }, { value: '' }), 3);
    assert.strictEqual(readLiveValue({ kind: 'int', min: 1, max: 10, fallback: 3 }, { value: 'abc' }), 3);
    assert.strictEqual(readLiveValue({ kind: 'int', min: 1, max: 10, fallback: 3 }, { value: '99' }), 10);
    assert.strictEqual(readLiveValue({ kind: 'int', min: 1, max: 10, fallback: 3 }, { value: '4.6' }), 5);
    // 文本去掉首尾空白；口令保持原样（口令里的空格是有意义的）
    assert.strictEqual(readLiveValue({ kind: 'str' }, { value: '  C:\\EFT\\Logs  ' }), 'C:\\EFT\\Logs');
    assert.strictEqual(readLiveValue({ kind: 'raw' }, { value: '  abc def  ' }), '  abc def  ');
    assert.strictEqual(readLiveValue({ kind: 'str' }, { value: null }), '');
  })();
});

test('补丁是嵌套结构（room.sharePos / autoShot.key / quests.opacity）', () => {
  return (async () => {
    const { patchFor, setPath } = await import('../renderer/common/settings-live.js');
    assert.deepStrictEqual(patchFor({ path: 'room.sharePos', kind: 'bool' }, { checked: true }), { room: { sharePos: true } });
    assert.deepStrictEqual(patchFor({ path: 'autoShot.key', kind: 'str' }, { value: 'F12' }), { autoShot: { key: 'F12' } });
    assert.deepStrictEqual(patchFor({ path: 'quests.opacity', kind: 'num', min: 0, max: 1 }, { value: '0.4' }), { quests: { opacity: 0.4 } });
    assert.deepStrictEqual(patchFor({ path: 'miniSize', kind: 'int', min: 180, max: 560, fallback: 300 }, { value: '420' }), { miniSize: 420 });
    // 不改到传进来的对象（调用方常常复用）
    const base = { room: { url: 'a' } };
    const out = setPath(base, 'room.port', 1);
    assert.deepStrictEqual(out, { room: { url: 'a', port: 1 } });
    assert.deepStrictEqual(base, { room: { url: 'a' } });
  })();
});

test('事件选择：滑块/开关/下拉框实时（input），文本与数字框失焦才写（change）', () => {
  return (async () => {
    const { liveEventFor } = await import('../renderer/common/settings-live.js');
    assert.strictEqual(liveEventFor({ type: 'range' }), 'input');
    assert.strictEqual(liveEventFor({ type: 'checkbox' }), 'input');
    assert.strictEqual(liveEventFor({ tagName: 'SELECT', type: 'select-one' }), 'input');
    assert.strictEqual(liveEventFor({ type: 'text' }), 'change');
    assert.strictEqual(liveEventFor({ type: 'number' }), 'change');
    assert.strictEqual(liveEventFor({}), 'change');
  })();
});

test('雷达窗口大小：控件在设置页、字段进了映射表、主进程认这个字段', () => {
  return (async () => {
    const { fieldOf } = await import('../renderer/common/settings-live.js');
    const f = fieldOf('#set-mini-size');
    assert.ok(f, '设置页缺少「雷达窗口大小」的映射');
    assert.strictEqual(f.path, 'miniSize');
    assert.strictEqual(f.min, 180);
    assert.strictEqual(f.max, 560);

    const html = read('renderer/map.html');
    assert.ok(/id="set-mini-size"[^>]*type="range"|type="range"[^>]*id="set-mini-size"/.test(html),
      '#set-mini-size 应该是个滑块');
    const main = read('main.js');
    assert.ok(/miniSize:\s*\d+/.test(main), 'main.js 的默认配置里没有 miniSize');
    assert.ok(/clampMiniSize/.test(main), 'main.js 没有用 clampMiniSize 兜住非法尺寸');
    assert.ok(/hasOwnProperty\.call\(patch, 'miniSize'\)/.test(main), 'config:set 里没有处理 miniSize（改了不会生效）');
    assert.ok(!/MINI_SIZE\s*=/.test(main), 'main.js 里还有写死的 MINI_SIZE 常量（会和新设置打架）');
    // 打开设置时要把它填成当前值，否则滑块永远停在 HTML 默认值上
    assert.ok(/\$\('#set-mini-size'\)\.value = c\.miniSize/.test(read('renderer/map.js')), 'openSettings 没有回填雷达窗口大小');
  })();
});
