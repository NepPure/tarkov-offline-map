'use strict';

/**
 * changelog 生成器（tools/make-changelog.js）：纯函数 + 真仓库冒烟。
 *
 * 这东西决定 Release 正文长什么样，所以既要验"约定式提交怎么分类"，也要拿**真实提交区间**
 * 跑一遍（tag 之间），确认要点、分类、完整提交列表真的都在。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CL = require('../tools/make-changelog');

test('parseConventional：type(scope)!: 标题 的解析与宽容', () => {
  assert.deepStrictEqual(CL.parseConventional('feat(mini): 雷达画任务点'), { type: 'feat', scope: 'mini', breaking: false, title: '雷达画任务点' });
  assert.deepStrictEqual(CL.parseConventional('fix: 修个 bug'), { type: 'fix', scope: null, breaking: false, title: '修个 bug' });
  assert.deepStrictEqual(CL.parseConventional('chore(release)!: 不兼容改动'), { type: 'chore', scope: 'release', breaking: true, title: '不兼容改动' });
  assert.deepStrictEqual(CL.parseConventional('FEAT(UI): 大写也能认'), { type: 'feat', scope: 'UI', breaking: false, title: '大写也能认' });
  // 非约定式 / 认不出的类型：原样当标题，不许抛
  for (const s of ['随便写的提交标题', 'wip: 没写完', 'Merge branch main', '']) {
    const r = CL.parseConventional(s);
    assert.strictEqual(r.type, null, `${s} 不该被认成约定式`);
    assert.strictEqual(r.title, String(s).trim());
  }
  assert.strictEqual(CL.parseConventional(null).title, '');
});

test('bodyBullets：只留要点、压空白、超长截断、上限加提示', () => {
  const body = [
    '开头这句不是要点，丢掉',
    '- 第一条要点，后面这句在提交正文里折了行',
    '  所以它其实属于上一条（不能丢，否则要点看着像被截断）',
    '  - 缩进更深的二级要点也要并进上一条',
    '',
    '-    多余空格   压成一个',
    '-',
    '结尾说明也丢掉',
  ].join('\n');
  const out = CL.bodyBullets(body, 10);
  assert.deepStrictEqual(out, [
    '第一条要点，后面这句在提交正文里折了行 所以它其实属于上一条（不能丢，否则要点看着像被截断） 缩进更深的二级要点也要并进上一条',
    '多余空格 压成一个',
  ]);
  assert.deepStrictEqual(CL.bodyBullets('', 5), []);
  assert.deepStrictEqual(CL.bodyBullets(null, 5), []);
  // 上限：超了就截断并说明还剩几条
  const many = Array.from({ length: 5 }, (_, i) => `- 要点${i}`).join('\n');
  const capped = CL.bodyBullets(many, 2);
  assert.strictEqual(capped.length, 3);
  assert.match(capped[2], /还有 3 条要点/);
  // 单条过长要截断，避免正文爆炸
  const long = CL.bodyBullets(`- ${'x'.repeat(500)}`, 5);
  assert.ok(long[0].length <= 200 && long[0].endsWith('…'));
});

test('parseGitLog / groupCommits：按分节归类，认不出的进"其它"', () => {
  const F = CL.FIELD;
  const R = CL.RECORD;
  const raw = [
    `h1${F}aaa1111${F}feat(mini): 雷达画任务点${F}- 要点 A`,
    `h2${F}bbb2222${F}fix: 修个 bug${F}- 要点 B`,
    `h3${F}ccc3333${F}docs: 写文档${F}`,
    `h4${F}ddd4444${F}test: 加测试${F}`,
    `h5${F}eee5555${F}chore: 杂务${F}`,
    `h6${F}fff6666${F}没有前缀的提交${F}`,
  ].join(R);

  const commits = CL.parseGitLog(raw);
  assert.strictEqual(commits.length, 6);
  assert.strictEqual(commits[0].type, 'feat');
  assert.strictEqual(commits[0].scope, 'mini');
  assert.strictEqual(commits[5].type, null);

  const groups = CL.groupCommits(commits);
  const byId = Object.fromEntries(groups.map((g) => [g.id, g.commits.map((c) => c.short)]));
  assert.deepStrictEqual(byId.feat, ['aaa1111']);
  assert.deepStrictEqual(byId.fix, ['bbb2222']);
  assert.deepStrictEqual(byId.docs, ['ccc3333']);
  assert.deepStrictEqual(byId.test, ['ddd4444']);
  assert.deepStrictEqual(byId.other, ['eee5555', 'fff6666'], 'chore 与没前缀的都归"其它"');
  // 顺序 = 分节定义顺序（feat 在最前），空分组不出现
  assert.strictEqual(groups[0].id, 'feat');
  assert.ok(!groups.some((g) => g.id === 'refactor'));
  // 脏输入不抛
  assert.deepStrictEqual(CL.parseGitLog(''), []);
  assert.deepStrictEqual(CL.parseGitLog(null), []);
  assert.deepStrictEqual(CL.groupCommits([]), []);
});

test('renderChangelog：标题/对比链接/分节/要点/完整提交/破坏性标记', () => {
  const commits = [
    { hash: 'h1', short: 'aaa1111', subject: 'feat(mini): 雷达画任务点', body: '- 要点 A\n- 要点 B', type: 'feat', scope: 'mini', breaking: false, title: '雷达画任务点' },
    { hash: 'h2', short: 'bbb2222', subject: 'fix!: 不兼容的修复', body: '', type: 'fix', scope: null, breaking: true, title: '不兼容的修复' },
  ];
  const md = CL.renderChangelog({
    version: '9.9.9', date: '2026-01-02', from: 'v9.9.8', to: 'v9.9.9',
    repoUrl: 'https://github.com/o/r/', commits,
  });
  assert.match(md, /^## 塔科夫地图 9\.9\.9（2026-01-02）/m);
  assert.match(md, /`v9\.9\.8\.\.\.v9\.9\.9` · 2 个提交/);
  assert.match(md, /\[完整对比\]\(https:\/\/github\.com\/o\/r\/compare\/v9\.9\.8\.\.\.v9\.9\.9\)/, '仓库地址结尾的 / 要去掉，不能拼出 //');
  assert.match(md, /### ✨ 新功能/);
  assert.match(md, /### 🐛 修复与性能/);
  assert.match(md, /\*\*mini\*\*：雷达画任务点 \[`aaa1111`\]\(https:\/\/github\.com\/o\/r\/commit\/aaa1111\)/);
  assert.match(md, /  - 要点 A/);
  assert.match(md, /⚠️ \*\*破坏性变更\*\*/);
  assert.match(md, /### 完整提交/);
  assert.match(md, /- \[`bbb2222`\]\(https:\/\/github\.com\/o\/r\/commit\/bbb2222\) \*\*修复\*\*：不兼容的修复/, '完整列表里标题要去掉 type 前缀');
  // 没有提交 / 没有仓库地址 / 首个版本（没有 from）都要能出东西
  const empty = CL.renderChangelog({ version: '1.0.0', commits: [] });
  assert.match(empty, /没有代码提交/);
  const noRepo = CL.renderChangelog({ version: '1.0.0', commits, repoUrl: '' });
  assert.ok(!noRepo.includes('http'), '没有仓库地址时不该出现链接');
  assert.match(noRepo, /`aaa1111`/);
  const first = CL.renderChangelog({ version: '1.0.0', commits, repoUrl: 'https://x/y', from: '' });
  assert.match(first, /2 个提交/);
  assert.ok(!first.includes('compare'), '没有上一个 tag 时不生成对比链接');
});

test('renderChangelog：header 模板里的 {version}/{date} 会被替换', () => {
  const md = CL.renderChangelog({
    version: '2.2.0', date: '2026-09-26', commits: [],
    header: '# 发布 {version}\n日期 {date}\n\n---\n',
  });
  assert.match(md, /^# 发布 2\.2\.0\n日期 2026-09-26/);
  assert.ok(md.indexOf('# 发布') < md.indexOf('## 塔科夫地图'), '固定说明要排在生成内容前面');
});

test('真仓库冒烟：v2.1.0..v2.2.0 能生成出分类、要点与完整提交列表', { skip: !hasTag('v2.1.0') || !hasTag('v2.2.0') }, () => {
  const commits = CL.readCommits('v2.1.0', 'v2.2.0');
  assert.ok(commits.length >= 6, `区间里应该有 6 个提交，实际 ${commits.length}`);
  const md = CL.renderChangelog({ version: '2.2.0', date: '2026-09-26', from: 'v2.1.0', to: 'v2.2.0', repoUrl: 'https://github.com/NepPure/tarkov-offline-map', commits });
  // 三件套：分节标题、要点、完整提交列表
  assert.match(md, /### ✨ 新功能/);
  assert.match(md, /### 📝 文档/);
  assert.match(md, /### 完整提交/);
  assert.match(md, /战局提示音/, '功能提交的标题要在里面');
  assert.match(md, /队友共享勾选任务/);
  assert.match(md, /灯塔缺失的撤离点/, '旧提交也要被带上（它们都属于这个版本）');
  assert.match(md, /^  - /m, '要有正文要点');
  // 每条提交都在"完整提交"里出现一次
  for (const c of commits) assert.ok(md.includes(`commit/${c.short}`), `${c.short} 没进完整提交列表`);
  // 上一个 tag 的自动探测
  assert.strictEqual(CL.previousTag('v2.2.0'), 'v2.1.0');
});

function hasTag(tag) {
  try {
    const out = require('node:child_process')
      .execFileSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out !== '';
  } catch {
    return false;
  }
}
