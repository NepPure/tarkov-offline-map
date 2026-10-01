'use strict';

/**
 * Release 正文里的 CHANGELOG（tools/release-notes.js）。
 *
 * 需求：Release 页面要带上 CHANGELOG 里这一版的内容（以前只有一段固定模板 + GitHub 自动生成的
 * 条目，很多时候只剩一行对比链接）。这个小工具被两条路用：
 *   - CI：.github/workflows/build.yml 发布时自动拼进去；
 *   - 手工：补历史 Release（gh release view --json body > body.md，跑一遍再 gh release edit）。
 *
 * 盯住三件事：切得出这一节、插得进正文（幂等，重发同一个 tag 不会越补越多）、缺这一节要报错。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RN = require('../tools/release-notes');

const SAMPLE = [
  '# 更新日志',
  '',
  '开头这段不属于任何版本。',
  '',
  '## [2.4.1] — 2026-10-01',
  '',
  '### 修复',
  '',
  '- 第一条',
  '- 第二条',
  '',
  '---',
  '',
  '## [2.4.0] — 2026-10-01',
  '',
  '### 新功能',
  '',
  '- 图例大类可以单独关掉文字',
  '',
  '---',
  '',
  '## 历史版本（v1.x）',
  '',
  '| 版本 | 日期 |',
  '| --- | --- |',
  '| v1.2.0 | 2026-09-14 |',
  '',
  '[2.2.0]: https://example.com/v2.2.0',
  '',
].join('\n');

test('parseSections：只认 x.y.z 小节，非版本标题（历史版本表格）不算，尾部 --- 不进正文', () => {
  const secs = RN.parseSections(SAMPLE);
  assert.deepStrictEqual(secs.map((s) => s.version), ['2.4.1', '2.4.0']);
  assert.strictEqual(secs[0].date, '2026-10-01');
  assert.ok(secs[0].text.endsWith('- 第二条'), '尾部 --- 与空行要去掉：' + JSON.stringify(secs[0].text.slice(-20)));
  assert.ok(!/历史版本/.test(secs[1].text), '下一个 ## 标题即结束');
  assert.ok(!/- 图例/.test(secs[0].text), '不许串到下一节');
});

test('sectionFor：标题里的 [2.4.1] 方括号在正文里去掉（Release 页没有引用定义，会显示成字面量）', () => {
  const s = RN.sectionFor(SAMPLE, '2.4.1');
  assert.ok(s.startsWith('## 2.4.1 — 2026-10-01'), s.split('\n')[0]);
  // 补零/带 v 前缀的写法也能查
  assert.ok(RN.sectionFor(SAMPLE, 'v2.4.0').startsWith('## 2.4.0 — 2026-10-01'));
  // 带真链接的标题不动
  const linked = RN.sectionFor('## [2.5.0](https://x/y) — 2026-10-02\n\n- a\n', '2.5.0');
  assert.ok(linked.startsWith('## [2.5.0](https://x/y)'), linked.split('\n')[0]);
  assert.strictEqual(RN.sectionFor(SAMPLE, '9.9.9'), null, '没有的版本必须返回 null（调用方要报错）');
});

test('insertChangelog：插在自动生成条目前面，模板原样保留', () => {
  const body = '**塔科夫地图 2.4.1** — 说明\n\n- 条目\n\n**Full Changelog**: https://x/compare/a...b\n';
  const out = RN.insertChangelog(body, RN.sectionFor(SAMPLE, '2.4.1'));
  assert.ok(out.startsWith('**塔科夫地图 2.4.1** — 说明'), '模板在最前面');
  assert.ok(out.indexOf(RN.MARK_START) > out.indexOf('- 条目'), 'CHANGELOG 在模板之后');
  assert.ok(out.indexOf(RN.MARK_START) < out.indexOf('**Full Changelog**'), 'CHANGELOG 要在自动条目之前');
  assert.ok(out.includes('- 第二条'));
  assert.ok(out.endsWith('**Full Changelog**: https://x/compare/a...b\n'), '自动条目原样保留在最后');
});

test('insertChangelog：幂等 —— 再跑一遍只替换那一段，不会越补越多', () => {
  const once = RN.insertChangelog('模板\n\n**Full Changelog**: x\n', RN.sectionFor(SAMPLE, '2.4.0'));
  const twice = RN.insertChangelog(once, RN.sectionFor(SAMPLE, '2.4.0'));
  assert.strictEqual(twice, once, '同样的小节跑两次结果必须一样');
  assert.strictEqual(twice.split(RN.MARK_START).length - 1, 1, '只应有一段标记');

  // 同一篇正文换成别的小节：替换而不是追加
  const swapped = RN.insertChangelog(once, RN.sectionFor(SAMPLE, '2.4.1'));
  assert.strictEqual(swapped.split(RN.MARK_START).length - 1, 1);
  assert.ok(swapped.includes('## 2.4.1') && !swapped.includes('图例大类可以单独关掉文字'));
});

test('insertChangelog / releaseBody：正文里没有任何标题时直接追加（不会丢内容）', () => {
  const out = RN.insertChangelog('只有一段说明\n', '- 内容');
  assert.ok(out.startsWith('只有一段说明'));
  assert.ok(out.includes('- 内容'));
  const rb = RN.releaseBody('模板\n\n\n', '- 内容');
  assert.strictEqual(rb, '模板\n\n' + RN.MARK_START + '\n- 内容\n' + RN.MARK_END + '\n');
});

test('真仓库：CHANGELOG 里每个已发布版本都切得出小节（含当前版本）', () => {
  const md = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');
  const versions = RN.parseSections(md).map((s) => s.version);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  for (const v of ['2.4.1', '2.4.0', '2.3.1', '2.3.0']) {
    assert.ok(versions.includes(v), 'CHANGELOG 缺 ' + v + ' 这一节');
    const s = RN.sectionFor(md, v);
    assert.ok(s.split('\n').length > 3, v + ' 这一节看起来是空的');
  }
  assert.ok(versions.includes(pkg.version), 'package.json 的版本 ' + pkg.version + ' 在 CHANGELOG 里没有小节');
});

test('接线：workflow 用这个脚本拼正文（body_path），server workflow 不许碰正文', () => {
  const build = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf-8');
  assert.ok(/node tools\/release-notes\.js/.test(build), 'build.yml 没有调用 release-notes.js');
  assert.ok(/body_path:/.test(build), 'build.yml 没有用 body_path 传正文（那就带不上 CHANGELOG）');
  const server = fs.readFileSync(path.join(ROOT, '.github/workflows/server.yml'), 'utf-8');
  assert.ok(!/body_path:/.test(server) && !/generate_release_notes/.test(server),
    'server.yml 只管挂资产，碰正文会把 build.yml 写好的 changelog 覆盖掉');
});
