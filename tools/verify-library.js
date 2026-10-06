#!/usr/bin/env node
/**
 * 资料库窗口验收（v2.5）：真开一个窗口，真点每一个页签。
 *
 * 覆盖的回归点：
 *   1) 主窗口顶栏能打开资料库（走 `api.openLibrary`，不是新窗口里的假路由）
 *   2) 10 个页签都在，且**每一个**都能渲染出内容（不是白屏、不是只有表头）
 *   3) 物品页数据真的加载了（表格行数 > 0），搜索能过滤，模式（PVP/PVE）切换会改价格
 *   4) 页面上不出现明显坏值（undefined / NaN / null ₽ / [object Object]）
 *   5) 顺手留一张截图给人工看：test-artifacts/verify-library.png
 *
 * 用法:
 *   npx electron . --remote-debugging-port=9222 --no-sandbox --disable-gpu
 *   node tools/verify-library.js [--port=9222]
 */
const path = require('path');
const { sleep, targets, evaluate, waitFor, waitForTarget, screenshot } = require('./lib/cdp');
const { createReport } = require('./lib/suite');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9222));
const ART = path.join(__dirname, '..', 'test-artifacts');

/** 页面上所有可点元素的文字（页签/按钮都靠它对上，不依赖具体 class 名） */
const TEXTS = `[...document.querySelectorAll('button,a,[role="tab"],li')].map(e => (e.textContent || '').trim()).filter(Boolean)`;
const ROWS = `document.querySelectorAll('table tbody tr').length`;
const BAD = `(function(){const t=document.body.innerText||'';const hits=[];for(const p of ['undefined','NaN','[object Object]','null ₽','Infinity']) if(t.includes(p)) hits.push(p);return hits;})()`;

/** 按可见文字点一个元素（找不到就返回 false） */
const clickByText = (text) => `(function(){
  const want = ${JSON.stringify(text)};
  const els = [...document.querySelectorAll('button,a,[role="tab"],li,div')];
  const hit = els.find(e => (e.textContent || '').trim() === want)
    || els.find(e => (e.textContent || '').trim().startsWith(want) && e.children.length <= 3);
  if (!hit) return false;
  hit.click();
  return true;
})()`;

(async () => {
  const rep = createReport('资料库窗口');

  const list = await targets(PORT).catch(() => []);
  const mapT = list.find((t) => /map\.html/.test(t.url));
  rep.check('主窗口在（先 npm start 或 npx electron .）', !!mapT);
  if (!mapT) { rep.summary(); process.exitCode = 1; return; }

  // 打开资料库
  await evaluate(mapT.webSocketDebuggerUrl, `window.api.openLibrary({})`).catch(() => {});
  const libT = await waitForTarget(PORT, (t) => /library\.html/.test(t.url), 20000);
  rep.check('资料库窗口打开', !!libT, libT ? libT.url : '20s 内没等到 library.html');
  if (!libT) { rep.summary(); process.exitCode = 1; return; }
  const ws = libT.webSocketDebuggerUrl;

  // 数据加载（8MB JSON，给足时间）
  const rows = await waitFor(async () => {
    const n = await evaluate(ws, ROWS).catch(() => 0);
    return Number(n) > 0 ? Number(n) : 0;
  }, 30000);
  rep.check('物品页表格有数据', rows > 0, `${rows} 行`);

  const texts = await evaluate(ws, TEXTS).catch(() => []);
  const joined = (texts || []).join('|');
  const wants = ['物品', '弹药', '防具', '钥匙', '藏身处', '制作', '交换', '倒卖', 'BOSS', 'BTR', '收集', '仪式圈', '特质', '来源'];
  const missing = wants.filter((w) => !joined.includes(w));
  rep.check('14 个页签都在', missing.length === 0, missing.length ? '缺少: ' + missing.join(',') : wants.join('/'));

  const bad = await evaluate(ws, BAD).catch(() => []);
  rep.check('页面无坏值', Array.isArray(bad) && bad.length === 0, (bad || []).join(','));

  // 模式切换：PVP/PVE 价格必须不同
  const priceOf = `(function(){
    const tr = document.querySelector('table tbody tr');
    if (!tr) return null;
    const t = tr.innerText || '';
    const m = t.match(/[0-9][0-9,]{2,}/g);
    return m ? m.join(',') : null;
  })()`;
  const before = await evaluate(ws, priceOf).catch(() => null);
  const switched = await evaluate(ws, clickByText('PVP')).catch(() => false);
  await sleep(600);
  let afterPvp = await evaluate(ws, priceOf).catch(() => null);
  if (switched && afterPvp === before) {
    await evaluate(ws, clickByText('PVE')).catch(() => {});
    await sleep(600);
    afterPvp = await evaluate(ws, priceOf).catch(() => null);
  }
  rep.check('模式切换按钮存在', !!switched);
  rep.check('切换模式后价格会变', !!before && !!afterPvp && before !== afterPvp, `${before} -> ${afterPvp}`);

  // 搜索过滤
  const setQuery = (q) => `(function(){
    const el = document.querySelector('input[type="search"]') || document.querySelector('input[type="text"]') || document.querySelector('input');
    if (!el) return false;
    el.value = ${JSON.stringify(q)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
  const beforeRows = await evaluate(ws, ROWS).catch(() => 0);
  const typed = await evaluate(ws, setQuery('急救')).catch(() => false);
  await sleep(700);
  const afterRows = await evaluate(ws, ROWS).catch(() => 0);
  rep.check('搜索框存在', !!typed);
  rep.check('搜索能过滤（行数变少且 > 0）', afterRows > 0 && afterRows < beforeRows, `${beforeRows} -> ${afterRows}`);
  await evaluate(ws, setQuery('')).catch(() => {});
  await sleep(400);

  // 逐个页签点开：内容区必须有东西
  for (const w of wants) {
    const ok = await evaluate(ws, clickByText(w)).catch(() => false);
    await sleep(900);
    const info = await evaluate(ws, `(function(){
      const t = document.body.innerText || '';
      return { len: t.length, rows: document.querySelectorAll('table tbody tr').length };
    })()`).catch(() => null);
    const good = ok && info && info.len > 400;
    rep.check(`页签「${w}」有内容`, good, info ? `文字 ${info.len} 字 / ${info.rows} 行` : '取不到内容');
  }

  await screenshot(ws, path.join(ART, 'verify-library.png')).then(
    (p) => rep.check('截图已保存', true, p),
    (e) => rep.check('截图已保存', false, String(e.message).slice(0, 120)),
  );

  rep.summary();
  process.exitCode = rep.failed.length ? 1 : 0;
})();
