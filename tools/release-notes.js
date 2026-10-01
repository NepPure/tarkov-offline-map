#!/usr/bin/env node
'use strict';

/**
 * 把 CHANGELOG.md 里对应版本的那一节抽出来，补进 Release 正文。
 *
 * 为什么需要：Release 页面以前只有一段固定模板 + GitHub 自动生成的条目（很多时候只剩一行
 * "Full Changelog" 对比链接），而本项目的 CHANGELOG 是手工按提交整理的（新功能 / 修复 / 测试，
 * 写清了原因和验证方式）—— 那才是用户真正要看的东西。现在：
 *   - 发布时由 .github/workflows/build.yml 自动把它拼进 release 正文；
 *   - 历史 Release 也能用同一条命令补齐（见下面的用法）。
 *
 * 幂等：正文里用 <!-- CHANGELOG:START/END --> 包一段，重复跑只会替换那一段，不会越补越多。
 *
 * 用法：
 *   node tools/release-notes.js --list                    # 列出 CHANGELOG 里有哪些版本
 *   node tools/release-notes.js --version 2.4.1           # 只打印这一节
 *   node tools/release-notes.js --version 2.4.1 --body body.md --out out.md
 *
 * 补一条历史 Release：
 *   gh release view v2.4.1 --json body -q .body > body.md
 *   node tools/release-notes.js --version 2.4.1 --body body.md --out body.md
 *   gh release edit v2.4.1 --notes-file body.md
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARK_START = '<!-- CHANGELOG:START -->';
const MARK_END = '<!-- CHANGELOG:END -->';

/** 版本小节标题：## [2.4.1] — 2026-10-01 / ## 2.4.1 / ## [v2.4.1](链接) 都认 */
const VERSION_IN_HEADING_RE = /^\[?v?(\d+\.\d+\.\d+)\]?/;
const HEADING_RE = /^##\s+(.*)$/;

/**
 * 切出 CHANGELOG 里的所有版本小节（含标题与正文，去掉尾部的 --- 分隔线与空行）。
 * 小节在**下一个 ## 标题**（任何标题）处结束。
 * @returns {Array<{version:string, date:string, heading:string, text:string}>}
 */
function parseSections(md) {
  const out = [];
  let cur = null;
  for (const line of String(md || '').split(/\r?\n/)) {
    const h = HEADING_RE.exec(line);
    if (h) {
      if (cur) out.push(finish(cur));
      const v = VERSION_IN_HEADING_RE.exec(h[1]);
      cur = v ? { version: v[1], date: (h[1].match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '', heading: line, lines: [] } : null;
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) out.push(finish(cur));
  return out;
}

function finish(s) {
  // 标题里的方括号：CHANGELOG 用 [2.4.1] + 文末引用定义来跳 Release 页；
  // 但 Release 正文里没有那些定义，原样贴过去会显示成 "[2.4.1]" 这种字面量 —— 所以这里去掉方括号
  // （带真链接的写法 [2.4.1](url) 不动，那个到哪儿都能渲染）。
  const heading = s.heading.replace(/^(##\s+)\[(\d+\.\d+\.\d+)\](\s|$)/, '$1$2$3');
  let text = [heading, ...s.lines].join('\n').replace(/\s+$/, '');
  text = text.replace(/\n-{3,}\s*$/, '').replace(/\s+$/, ''); // 尾部的 --- 不属于这一节
  return { version: s.version, date: s.date, heading, text };
}

/** 取某个版本的正文；没有这一节时返回 null（调用方要给出人话的错误） */
function sectionFor(md, version) {
  const want = String(version || '').trim().replace(/^v/, '');
  const hit = parseSections(md).find((s) => s.version === want);
  return hit ? hit.text : null;
}

/**
 * 把 CHANGELOG 小节插进 Release 正文（幂等）。
 *   - 已经有 <!-- CHANGELOG:START/END -->：整段替换（重发同一个 tag 不会越补越多）
 *   - 没有标记：插到第一个 ## 标题 / **Full Changelog** 之前 —— GitHub 把我们的正文
 *     拼在自动生成条目前面，所以这里插在它前面，最终顺序就是 模板 -> CHANGELOG -> 自动条目
 */
function insertChangelog(body, section) {
  const text = String(body == null ? '' : body);
  const block = MARK_START + '\n' + String(section || '').trim() + '\n' + MARK_END;
  const i = text.indexOf(MARK_START);
  const j = text.indexOf(MARK_END);
  if (i >= 0 && j > i) return text.slice(0, i) + block + text.slice(j + MARK_END.length);
  const cuts = [/^##\s/m.exec(text), /^\*\*Full Changelog\*\*/m.exec(text)]
    .filter(Boolean).map((m) => m.index).sort((a, b) => a - b);
  if (!cuts.length) return text.replace(/\s+$/, '') + '\n\n' + block + '\n';
  const at = cuts[0];
  return text.slice(0, at).replace(/\s+$/, '') + '\n\n' + block + '\n\n' + text.slice(at);
}

/** 模板 + CHANGELOG 小节 -> 最终正文（模板里的多余空行会收掉） */
function releaseBody(template, section) {
  const tpl = String(template == null ? '' : template).replace(/\s+$/, '');
  return tpl ? insertChangelog(tpl, section) : insertChangelog('', section).replace(/^\n+/, '');
}

function main() {
  const argv = process.argv.slice(2);
  const val = (name, dflt) => {
    const eq = argv.find((x) => x.startsWith('--' + name + '='));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
  };
  const file = val('changelog', path.join(ROOT, 'CHANGELOG.md'));
  const md = fs.readFileSync(file, 'utf-8');
  if (argv.includes('--list')) {
    for (const s of parseSections(md)) console.log(s.version + (s.date ? '  ' + s.date : ''));
    return;
  }
  const version = val('version', '');
  if (!version) {
    console.error('用法: node tools/release-notes.js --version <x.y.z> [--body <现有正文文件>] [--out <输出文件>] [--list]');
    process.exitCode = 2;
    return;
  }
  const section = sectionFor(md, version);
  if (!section) {
    console.error('CHANGELOG.md 里没有 ' + version + ' 这一节 —— 先补上再发（可用 npm run changelog 草拟）');
    process.exitCode = 1;
    return;
  }
  const bodyFile = val('body', '');
  const out = bodyFile && fs.existsSync(bodyFile)
    ? insertChangelog(fs.readFileSync(bodyFile, 'utf-8'), section)
    : releaseBody('', section);
  const outFile = val('out', '');
  if (outFile) fs.writeFileSync(outFile, out);
  else process.stdout.write(out);
}

module.exports = { parseSections, sectionFor, insertChangelog, releaseBody, MARK_START, MARK_END };

if (require.main === module) main();
