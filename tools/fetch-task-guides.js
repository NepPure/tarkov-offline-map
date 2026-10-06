#!/usr/bin/env node
/**
 * 任务攻略快照脚本（构建期跑一次，之后应用完全离线）
 *
 * 数据源: https://www.eftarkov.com/task/<id>  （逃离塔科夫中文Wiki）
 *   - 任务描述（剧情全文，中文）
 *   - 提示（task-hint，例如"必须达到商人好感 LL2"）
 *   - 任务目标 / 物品收集 / 任务攻略（富文本，含内嵌截图）/ 任务完成对话 / 奖励
 *   - 任务配图 /uploads/task/<id>.webp（小图，直接内置）
 *   - 攻略截图 /uploads/infoImg/xxx.webp（大图，交给 fetch-task-shots.js 重编码）
 *   - 攻略里的地图深链 /map/<mapId>?marker=<markerId> —— 换成本软件自己的地图跳转
 *
 * 任务 id 与 json.tarkov.dev / 本软件 data/quests-dump.json 完全同源，可直接对应。
 *
 * 输出:
 *   data/task-guides.json     任务说明 + 攻略富文本（截图引用为 data-shot="<图片名>"）
 *   build/guide-assets.json   待下载图片清单（URL -> 本地文件名）
 *
 * 用法:
 *   node tools/fetch-task-guides.js               # 全量
 *   node tools/fetch-task-guides.js --limit=5     # 只抓前 5 个（冒烟）
 *   node tools/fetch-task-guides.js --only=<id>   # 只抓一个任务
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const BASE = 'https://www.eftarkov.com';
const OUT = path.join(REPO, 'data', 'task-guides.json');
const ASSETS = path.join(REPO, 'build', 'guide-assets.json');
const QUEST_DUMP = path.join(REPO, 'data', 'quests-dump.json');

const UA = 'tarkov-offline-map/2.5 (+https://github.com/neppure/tarkov-offline-map; open-source offline companion)';

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}`));
  return a && a.includes('=') ? a.split('=')[1] : dflt;
};
const LIMIT = Number(arg('limit', 0)) || 0;
const ONLY = arg('only', null);

// ---------- 文本工具 ----------
const decode = (s) => String(s)
  .replace(/&nbsp;/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HTML -> 纯文本（<br>/</p> 当换行） */
const plain = (s) => decode(String(s)
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
  .replace(/<[^>]+>/g, ''))
  .split('\n')
  .map((x) => x.replace(/[ \t]+/g, ' ').trim())
  .filter((x) => x.length)
  .join('\n')
  .trim();

/** 取某个 <div> 的 innerHTML（按 div 深度配对） */
function innerOfDiv(html, startIdx) {
  const open = html.indexOf('>', startIdx) + 1;
  const re = /<(\/?)div\b[^>]*>/gi;
  re.lastIndex = open;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] === '/') {
      depth--;
      if (depth === 0) return html.slice(open, m.index);
    } else depth++;
  }
  return html.slice(open);
}

/** 按 class 找第一个 div 的 innerHTML */
function divByClass(html, cls) {
  const i = html.search(new RegExp('<div[^>]*class="(?:[^"]*\\s)?' + cls.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '(?:[\\s"]|$)'));
  if (i < 0) return null;
  return innerOfDiv(html, i);
}

const SHOT_RE = /\/uploads\/infoImg\/([A-Za-z0-9_.-]+)/;
const ILLUS_RE = /\/uploads\/task\/([A-Za-z0-9_.-]+)/;
const BASE_ITEM_RE = /\/uploads\/base\/([0-9a-f]{24})-base-image\.webp/;

// ---------- 富文本白名单清洗 ----------
const ALLOW = new Set(['p', 'br', 'a', 'img', 'strong', 'b', 'em', 'i', 'ul', 'ol', 'li', 'h3', 'h4', 'code', 'span', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'td', 'th']);

function sanitize(html, shots) {
  let out = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  out = out.replace(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g, (all, slash, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOW.has(t)) return '';
    if (t === 'br') return '<br>';
    if (slash) return `</${t}>`;
    if (t === 'img') {
      const src = (attrs.match(/src="([^"]*)"/) || [])[1] || '';
      const m = src.match(SHOT_RE);
      if (!m) return '';
      const name = m[1].replace(/\.[a-z]+$/i, '');
      shots.add(name);
      const alt = decode((attrs.match(/alt="([^"]*)"/) || [])[1] || '');
      return `<img data-shot="${esc(name)}" alt="${esc(alt)}">`;
    }
    if (t === 'a') {
      const href = decode((attrs.match(/href="([^"]*)"/) || [])[1] || '');
      const mm = href.match(/^\/map\/([0-9a-f]{24})(?:\?[^"']*?marker=([A-Za-z0-9_-]+))?/i);
      if (mm) return `<a data-map="${mm[1]}"${mm[2] ? ` data-marker="${esc(mm[2])}"` : ''} href="#">`;
      const mi = href.match(/^\/item\/([0-9a-f]{24})/i);
      if (mi) return `<a data-item="${mi[1]}" href="#">`;
      const mt = href.match(/^\/task\/([0-9a-f]{24})/i);
      if (mt) return `<a data-task="${mt[1]}" href="#">`;
      if (/^https?:\/\//i.test(href)) return `<a href="${esc(href)}" target="_blank" rel="noreferrer">`;
      return '<a>';
    }
    if (t === 'td' || t === 'th') {
      const span = (attrs.match(/colspan="(\d+)"/) || [])[1];
      return span ? `<${t} colspan="${span}">` : `<${t}>`;
    }
    return `<${t}>`;
  });
  return out.replace(/(\s){2,}/g, ' ').replace(/>\s+</g, '><').trim();
}

// ---------- 抓取 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      lastErr = e;
      await sleep(600 * (i + 1));
    }
  }
  throw new Error(`${url}: ${lastErr && lastErr.message}`);
}

/** 任务列表分页 -> 全站任务 id（wiki 每页 20 条，直到某页没有新 id） */
async function wikiTaskIds() {
  const ids = new Set();
  for (let page = 1; page <= 60; page++) {
    const html = await fetchText(`${BASE}/task?page=${page}`);
    const found = [...html.matchAll(/href="\/task\/([0-9a-f]{24})"/g)].map((m) => m[1]);
    const fresh = found.filter((id) => !ids.has(id));
    for (const id of found) ids.add(id);
    process.stdout.write(`\r[list] page ${page}: +${fresh.length} (total ${ids.size})   `);
    if (!fresh.length && page > 1) break;
    if (!found.length) break;
  }
  process.stdout.write('\n');
  return [...ids];
}

/** 解析一个任务页 */
function parseTask(html, id) {
  const shots = new Set();
  const head = html.slice(0, html.indexOf('task-detail-main') > 0 ? html.indexOf('task-detail-main') : html.length);

  const name = plain((head.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '') || null;
  const descHtml = (head.match(/<p class="[^"]*leading-relaxed[^"]*"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '';
  const description = plain(descHtml) || null;

  const hints = [];
  for (const m of html.matchAll(/<div class="task-hint[^"]*"[^>]*>([\s\S]*?)<\/div>/g)) {
    const t = plain(m[1]);
    if (t) hints.push(t);
  }

  const meta = {};
  const chips = [...head.matchAll(/<span class="px-2\.5 py-1[^"]*"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => plain(m[1])).filter(Boolean);
  if (chips.length) meta.trader = chips[0];
  if (chips.length > 1) meta.map = chips[1];
  if (chips.length > 2) meta.level = chips[2];
  const upd = (html.match(/更新于\s*([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]+)/) || [])[1];
  if (upd) meta.updatedAt = upd;
  const views = (html.match(/([0-9,]+)\s*浏览/) || [])[1];
  if (views) meta.views = Number(views.replace(/,/g, ''));

  // 主栏 section：h2 标题 + 紧随的块
  const sections = [];
  const mainIdx = html.indexOf('task-detail-main');
  const mainHtml = mainIdx < 0 ? '' : html.slice(mainIdx, html.indexOf('task-detail-sidebar'));
  const h2re = /<h2[^>]*>([\s\S]*?)<\/h2>/g;
  for (const m of mainHtml.matchAll(h2re)) {
    const title = plain(m[1]);
    if (!title) continue;
    const blockStart = mainHtml.lastIndexOf('<div', m.index);
    if (blockStart < 0) continue;
    const chunk = innerOfDiv(mainHtml, blockStart).replace(/<h2[^>]*>[\s\S]*?<\/h2>/, '');
    const html2 = sanitize(chunk, shots);
    if (!html2) continue;
    sections.push({ title, html: html2, text: plain(html2) });
  }

  // 物品收集（结构化）
  const itemRequirements = [];
  const reqBlock = divByClass(html, 'task-item-requirements-list');
  if (reqBlock) {
    for (const m of reqBlock.matchAll(/<div class="task-required-item"([^>]*)>([\s\S]*?)(?=<div class="task-required-item"|$)/g)) {
      const attrs = m[1];
      const b = m[2];
      // 两种块：`物品收集` 带 data-task-required-item + data-needed；
      // `物品需求` 只有 <a href="/item/<id>">（没有 data-*），所以再兜一层 href / 底图。
      const itemId = (attrs.match(/data-task-required-item="([0-9a-f]{24})"/) || [])[1]
        || (b.match(/href="\/item\/([0-9a-f]{24})"/) || [])[1]
        || (b.match(BASE_ITEM_RE) || [])[1]
        || null;
      const needed = Number((attrs.match(/data-needed="(\d+)"/) || [])[1] || 0) || null;
      const kind = (attrs.match(/data-kind="([^"]*)"/) || [])[1] || null;
      const nm = plain((b.match(/class="task-required-item-name"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
      itemRequirements.push({ itemId, name: nm || null, count: needed, kind, foundInRaid: /战局中/.test(plain(b)) });
    }
  }

  // 奖励卡片（保 HTML + 文本）
  const rewardsHtml = sanitize(divByClass(html, 'task-rewards-card') || '', shots);

  // 配图 + 攻略截图
  const illus = (html.match(ILLUS_RE) || [])[1] || null;
  for (const m of html.matchAll(/\/uploads\/infoImg\/([A-Za-z0-9_.-]+)/g)) shots.add(m[1].replace(/\.[a-z]+$/i, ''));

  const guideBlock = divByClass(html, 'rich-guide-content');
  const guideHtml = guideBlock ? sanitize(guideBlock, shots) : null;

  return {
    id,
    name,
    wikiUrl: `${BASE}/task/${id}`,
    ...meta,
    illustration: illus,
    description,
    hints,
    guideHtml,
    guideText: guideHtml ? plain(guideHtml) : null,
    sections: sections.filter((s) => s.title !== '任务攻略'),
    rewardsHtml: rewardsHtml || null,
    itemRequirements,
    shots: [...shots],
  };
}

// ---------- 主流程 ----------
(async () => {
  const dump = JSON.parse(fs.readFileSync(QUEST_DUMP, 'utf8'));
  const ourIds = (dump.tasks || []).map((t) => t.id);

  let ids;
  if (ONLY) ids = [ONLY];
  else {
    const wikiIds = await wikiTaskIds();
    ids = [...new Set([...ourIds, ...wikiIds])];
    const onlyWiki = wikiIds.filter((id) => !ourIds.includes(id));
    console.log(`[ids] 本地 ${ourIds.length} + wiki 独有 ${onlyWiki.length} = ${ids.length}`);
    if (onlyWiki.length) console.log('[ids] wiki 独有（本软件任务表里还没有）: ' + onlyWiki.join(', '));
  }
  if (LIMIT) ids = ids.slice(0, LIMIT);
  console.log(`[task] 开始抓取 ${ids.length} 个任务页…`);

  const guides = {};
  const assetUrls = new Map(); // url -> filename
  const failures = [];
  let done = 0;

  const CONC = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        const html = await fetchText(`${BASE}/task/${id}`);
        const g = parseTask(html, id);
        guides[id] = g;
        if (g.illustration) assetUrls.set(`/uploads/task/${g.illustration}`, g.illustration);
        for (const s of g.shots) {
          const m = html.match(new RegExp('/uploads/infoImg/(' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.[a-z]+)'));
          assetUrls.set(`/uploads/infoImg/${m ? m[1] : s + '.webp'}`, (m ? m[1] : s + '.webp').replace(/\.[a-z]+$/i, ''));
        }
      } catch (e) {
        failures.push({ id, error: String(e.message).slice(0, 120) });
      }
      done++;
      if (done % 10 === 0) process.stdout.write(`\r[task] ${done}/${ids.length}  失败 ${failures.length}  `);
      await sleep(60);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stdout.write(`\r[task] ${done}/${ids.length} 完成，失败 ${failures.length}      \n`);

  const payload = {
    fetchedAt: new Date().toISOString(),
    source: 'https://www.eftarkov.com/task/<id>',
    siteName: '逃离塔科夫中文Wiki',
    siteUrl: 'https://www.eftarkov.com',
    attribution: '任务说明、攻略与截图来自「逃离塔科夫中文Wiki」（https://www.eftarkov.com），本软件为开源非商业项目，内容版权归原作者所有。',
    count: Object.keys(guides).length,
    failures,
    guides,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  fs.writeFileSync(ASSETS, JSON.stringify({
    generatedAt: payload.fetchedAt,
    source: BASE,
    images: [...assetUrls.entries()].map(([url, name]) => ({ url, name, kind: url.includes('/task/') ? 'task' : 'guide' })),
  }, null, 1));

  const withGuide = Object.values(guides).filter((g) => g.guideHtml).length;
  const withShots = Object.values(guides).filter((g) => g.shots.length).length;
  const shotTotal = Object.values(guides).reduce((a, g) => a + g.shots.length, 0);
  console.log(`[out] ${OUT} ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`[out] 有攻略正文 ${withGuide}/${Object.keys(guides).length}，有截图 ${withShots}，截图总数 ${shotTotal}，待下载资源 ${assetUrls.size}`);
  console.log(`[out] ${ASSETS}`);
})();
