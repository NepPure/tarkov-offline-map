#!/usr/bin/env node
'use strict';

/**
 * 用**提交记录**生成 changelog / Release 正文（纯 Node，无依赖，可单测）。
 *
 * 为什么不用 GitHub 自带的 generate_release_notes：
 *   本项目是"直接推 main + 打 tag"的流程，没有 PR，GitHub 只会甩一串裸提交标题，
 *   而我们每个提交的正文里本来就写清了"改了什么、为什么、怎么验"（中文约定式提交）。
 *   这个脚本按 `type(scope): 标题` 分组，把正文要点整理成分节的 Release 说明。
 *
 * 用法：
 *   node tools/make-changelog.js                          # 上一 tag..HEAD，打到屏幕
 *   node tools/make-changelog.js --version 2.2.0 --out release/CHANGELOG.md
 *   node tools/make-changelog.js --from v2.1.0 --to HEAD --max-bullets 8
 *   node tools/make-changelog.js --header .github/release-header.md   # 正文前面套一段固定说明
 *
 * 退出码：0 正常（即使区间里没有提交）；1 参数/git 出错。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIELD = '\u001f'; // 字段分隔（git pretty 的 %x1f）
const RECORD = '\u001e'; // 记录分隔（%x1e）

/** 约定式提交的分节（顺序 = 输出顺序；认不出的类型归到最后一节） */
const SECTIONS = [
  { id: 'feat', title: '✨ 新功能', types: ['feat'] },
  { id: 'fix', title: '🐛 修复与性能', types: ['fix', 'perf'] },
  { id: 'refactor', title: '♻️ 重构与内部调整', types: ['refactor'] },
  { id: 'docs', title: '📝 文档', types: ['docs'] },
  { id: 'test', title: '🧪 测试与验收', types: ['test'] },
  { id: 'other', title: '🔧 构建 / CI / 其它', types: ['build', 'ci', 'chore', 'style', 'revert'] },
];

const TYPE_LABEL = {
  feat: '新功能', fix: '修复', perf: '性能', refactor: '重构', docs: '文档',
  test: '测试', build: '构建', ci: 'CI', chore: '杂务', style: '风格', revert: '回滚',
};

/**
 * 解析 `type(scope)!: 标题` 形式的提交标题。
 * 认不出来也不报错：type=null，标题原样保留（很多老提交不是约定式的）。
 * @param {string} subject
 */
function parseConventional(subject) {
  const s = String(subject == null ? '' : subject).trim();
  const m = s.match(/^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/);
  if (!m) return { type: null, scope: null, breaking: false, title: s };
  const type = m[1].toLowerCase();
  if (!TYPE_LABEL[type]) return { type: null, scope: null, breaking: false, title: s };
  return { type, scope: m[2] || null, breaking: Boolean(m[3]), title: m[4].trim() };
}

/** 把一段提交正文整理成要点：只留 `- ` / `* ` 开头的行，去掉纯装饰行 */
function bodyBullets(body, maxBullets = 12) {
  const lines = String(body == null ? '' : body).split('\n');
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (!m) {
      // 不是要点行：**缩进的续行**（中文提交正文里经常折行）并到上一条，
      // 否则要点看着像被截断（"…广播后立即清空 raidAlert，"就是这么来的）
      if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += ` ${line.trim().replace(/\s+/g, ' ')}`;
      continue;
    }
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (!text || /^[-*]+$/.test(text)) continue;
    // 二级要点（缩进更深的 - x）也并进上一条
    if (/^\s{2,}\S/.test(line) && out.length) out[out.length - 1] += ` ${text}`;
    else out.push(text);
  }
  // 二级要点（缩进更深的 - x）在上面的循环里会并进父项，这里再把过长的截一下
  const trimmed = out.map((t) => (t.length > 200 ? `${t.slice(0, 199)}…` : t));
  if (trimmed.length <= maxBullets) return trimmed;
  return [...trimmed.slice(0, maxBullets), `…（还有 ${trimmed.length - maxBullets} 条要点，详见提交）`];
}

/** 原始 git log 文本 -> 提交对象数组 */
function parseGitLog(raw) {
  return String(raw == null ? '' : raw)
    .split(RECORD)
    .map((r) => r.replace(/^\n+/, ''))
    .filter((r) => r.trim())
    .map((rec) => {
      const [hash, short, subject, ...rest] = rec.split(FIELD);
      const body = rest.join(FIELD).replace(/\s+$/, '');
      const parsed = parseConventional(subject);
      return { hash, short, subject, body, ...parsed };
    })
    .filter((c) => c.hash && c.subject);
}

/** 按分节分组（保持 git log 的顺序：新 -> 旧） */
function groupCommits(commits) {
  const groups = SECTIONS.map((s) => ({ ...s, commits: [] }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const c of commits) {
    const sec = groups.find((g) => g.types.includes(c.type)) || byId.get('other');
    sec.commits.push(c);
  }
  return groups.filter((g) => g.commits.length);
}

const stripTrailingSlash = (s) => String(s || '').replace(/\/+$/, '');

/** 渲染完整 Markdown */
function renderChangelog(opts = {}) {
  const version = opts.version ? String(opts.version) : '';
  const date = opts.date ? String(opts.date) : new Date().toISOString().slice(0, 10);
  const from = opts.from ? String(opts.from) : '';
  const to = opts.to && opts.to !== 'HEAD' ? String(opts.to) : '';
  const repoUrl = stripTrailingSlash(opts.repoUrl || '');
  const commits = Array.isArray(opts.commits) ? opts.commits : [];
  const maxBullets = Number.isFinite(opts.maxBullets) ? opts.maxBullets : 12;
  const header = String(opts.header || '').trim();

  const link = (hash) => (repoUrl ? `[\`${hash}\`](${repoUrl}/commit/${hash})` : `\`${hash}\``);
  const compare = from && to && repoUrl
    ? `${repoUrl}/compare/${from}...${to}`
    : (repoUrl ? `${repoUrl}/commits` : '');

  const lines = [];
  if (header) lines.push(header.replace(/\{version\}/g, version).replace(/\{date\}/g, date), '');
  lines.push(`## ${version ? `塔科夫地图 ${version}` : '更新内容'}${date ? `（${date}）` : ''}`);
  lines.push('');
  const bits = [];
  if (from && to) bits.push(`\`${from}...${to}\``);
  else if (from) bits.push(`\`${from}...HEAD\``);
  bits.push(`${commits.length} 个提交`);
  lines.push(`${bits.join(' · ')}${compare ? ` · [完整对比](${compare})` : ''}`);
  lines.push('');

  if (!commits.length) {
    lines.push('_这个区间里没有代码提交（可能只是版本号变更）。_', '');
  }

  for (const group of groupCommits(commits)) {
    lines.push(`### ${group.title}`, '');
    for (const c of group.commits) {
      const scope = c.scope ? `**${c.scope}**：` : '';
      const breaking = c.breaking ? ' ⚠️ **破坏性变更**' : '';
      lines.push(`- ${scope}${c.title} ${link(c.short)}${breaking}`);
      for (const b of bodyBullets(c.body, maxBullets)) lines.push(`  - ${b}`);
    }
    lines.push('');
  }

  lines.push('### 完整提交', '');
  for (const c of commits) {
    const type = c.type ? `**${TYPE_LABEL[c.type]}**` : '提交';
    const scope = c.scope ? `(${c.scope})` : '';
    lines.push(`- ${link(c.short)} ${type}${scope}：${c.subject.replace(/^[a-zA-Z]+(\([^)]*\))?!?:\s*/, '')}`);
  }
  lines.push('');

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/** 上一个 tag（形如 v1.2.3）：`git describe --tags --abbrev=0 <rev>^` */
function previousTag(to = 'HEAD') {
  const rev = `${to}^`;
  return gitOrNull(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', rev]);
}

function readCommits(from, to) {
  const range = from ? `${from}..${to}` : to;
  const raw = git(['log', '--no-merges', `--pretty=format:%H${FIELD}%h${FIELD}%s${FIELD}%b${RECORD}`, range]);
  return parseGitLog(raw);
}

function parseArgs(argv) {
  const out = { maxBullets: 12 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (k) => (a.includes('=') ? a.split('=').slice(1).join('=') : argv[++i]);
    if (a === '--from' || a.startsWith('--from=')) out.from = val('--from');
    else if (a === '--to' || a.startsWith('--to=')) out.to = val('--to');
    else if (a === '--version' || a.startsWith('--version=')) out.version = val('--version');
    else if (a === '--date' || a.startsWith('--date=')) out.date = val('--date');
    else if (a === '--repo' || a.startsWith('--repo=')) out.repoUrl = val('--repo');
    else if (a === '--out' || a.startsWith('--out=')) out.out = val('--out');
    else if (a === '--header' || a.startsWith('--header=')) out.header = val('--header');
    else if (a === '--max-bullets' || a.startsWith('--max-bullets=')) out.maxBullets = Number(val('--max-bullets')) || 12;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  return out;
}

function usage() {
  return [
    '用提交记录生成 changelog（默认打到标准输出）',
    '',
    '  node tools/make-changelog.js [选项]',
    '',
    '  --from <ref>         起始（不含），默认自动取上一个 v* tag',
    '  --to <ref>           结束（含），默认 HEAD',
    '  --version <v>        标题里的版本号，默认 package.json 的 version',
    '  --date <YYYY-MM-DD>  标题里的日期，默认今天',
    '  --repo <url>         仓库地址（生成提交/对比链接），默认 package.json 的 repository',
    '  --header <file>      在正文前面插入一段固定说明（文件里可用 {version} / {date}）',
    '  --max-bullets <n>    每条提交最多列几条正文要点（默认 12）',
    '  --out <file>         同时写入文件（目录会自动创建）',
    '',
  ].join('\n');
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = args.version || pkg.version;
  const repoUrl = args.repo || (pkg.repository && pkg.repository.url ? pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') : '');
  const to = args.to || 'HEAD';
  let from = args.from;
  if (from === undefined) from = previousTag(to) || '';
  const commits = readCommits(from, to);
  const header = args.header ? fs.readFileSync(path.join(ROOT, args.header), 'utf8') : '';
  const md = renderChangelog({ version, date: args.date, from, to, repoUrl, commits, maxBullets: args.maxBullets, header });

  process.stdout.write(md);
  if (args.out) {
    const out = path.join(ROOT, args.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, md);
    process.stderr.write(`\n[changelog] 已写入 ${args.out}（${commits.length} 个提交，${from || '首个版本'}..${to}）\n`);
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`changelog 生成失败：${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  SECTIONS,
  TYPE_LABEL,
  parseConventional,
  bodyBullets,
  parseGitLog,
  groupCommits,
  renderChangelog,
  previousTag,
  readCommits,
  parseArgs,
  main,
  FIELD,
  RECORD,
};
