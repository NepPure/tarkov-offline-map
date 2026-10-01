#!/usr/bin/env node
'use strict';

/**
 * 图例大类「只看图标、不要文字」端到端验收。
 *
 * 需求：地图与雷达上，每一大类都能单独关掉文字。这里对着 UI 真的点一遍，量四件事：
 *   1) 每一个图例大类都有 Aa 勾选框；只有真的会写字的大类可点，地名/玩家/标注给说明并置灰
 *   2) 关掉某一大类的文字 -> 这一类在地图上的 <text> 变 0，而图标 (<image>) 一个不少
 *   3) 关掉文字**不影响**「这一类还画不画」（markerToggles 不变），两个开关互不干扰
 *   4) 同一个开关落到雷达（小地图）上：雷达上这一类的药丸也一起消失
 *
 * 用法（runner 会自动起隔离实例并给 --port）：
 *   npm run verify -- --only=legend-text
 *   npx electron . --remote-debugging-port=9222  &&  node tools/verify-legend-text.js
 */
const fs = require('fs');
const path = require('path');

const { sleep, cdp, evaluate, waitFor, waitForTarget, screenshot } = require('./lib/cdp');
const { createReport } = require('./lib/suite');

const ROOT = path.join(__dirname, '..');
const ART = path.join(ROOT, 'test-artifacts');
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith('--' + n));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9222));

const report = createReport('图例大类「只看图标不要文字」（主地图 + 雷达）');
const check = report.check;

/** 主地图：某一大类在图上的图标数 / 文字数（data-legend 见 map-view.js 的标记渲染） */
const MAIN_STAT = (gid) => `(() => {
  const els = [...document.querySelectorAll('#map-root .map-marker[data-legend="${gid}"]')];
  return {
    markers: els.length,
    icons: els.filter((e) => e.querySelector('image')).length,
    texts: els.filter((e) => e.querySelector('text')).length,
  };
})()`;

/** 雷达：把视野摆到某个撤离点上（雷达只画圆盘内、只给关键标记写名字），再数图标/文字 */
const RADAR_AT = `(() => {
  const v = window.__view;
  const m = (v.markerCache || []).find((q) => String(q.group).startsWith('extract'));
  if (!m) return null;
  const p = v.proj.project(m.x, m.z);
  v.setViewport({ cx: p.x, cy: p.y, scale: v.view.scale, rot: 0 });
  const els = [...document.querySelectorAll('.map-marker')];
  // 雷达上除了撤离类，别的关键目标（Boss / 赛季文件）也会写名字，所以要分开数：
  // 关掉"撤离 · 转移 · 交通"的文字，只该让这一类变哑，不该把整个雷达的文字都数成 0。
  const mine = els.filter((e) => e.getAttribute('data-legend') === 'g-extract');
  return {
    name: m.shortLabel || m.label,
    group: m.group,
    markers: els.length,
    icons: els.filter((e) => e.querySelector('image')).length,
    texts: els.filter((e) => e.querySelector('text')).length,
    extractIcons: mine.filter((e) => e.querySelector('image')).length,
    extractTexts: mine.filter((e) => e.querySelector('text')).length,
  };
})()`;

/** 图例每一行的状态（顺序与 getLegend 一致） */
const ROWS = `(() => {
  const legend = window.__view.getLegend();
  const secs = [...document.querySelectorAll('#legend-body .legend-section')];
  return legend.map((g, i) => {
    const sec = secs[i];
    const t = sec && sec.querySelector('.legend-text-box');
    const b = sec && sec.querySelector('.legend-group-box');
    const wrap = sec && sec.querySelector('.legend-text-toggle');
    return {
      id: g.id, label: g.label, text: !!g.text, rows: secs.length,
      hasTextBox: !!t, textDisabled: t ? t.disabled : null, textChecked: t ? t.checked : null,
      hasVisBox: !!b, visChecked: b ? b.checked : null,
      title: (wrap && wrap.title) || '', off: !!(wrap && wrap.classList.contains('off')),
    };
  });
})()`;

/** 点某一大类的 Aa 勾选框（走真实 change 事件 -> 配置 -> 广播） */
const CLICK_TEXT = (gid, on) => `(() => {
  const legend = window.__view.getLegend();
  const i = legend.findIndex((g) => g.id === '${gid}');
  const sec = document.querySelectorAll('#legend-body .legend-section')[i];
  const box = sec.querySelector('.legend-text-box');
  if (box.checked !== ${on}) { box.checked = ${on}; box.dispatchEvent(new Event('change', { bubbles: true })); }
  return { checked: box.checked, disabled: box.disabled };
})()`;

/** 点某一大类左边的显隐勾选框 */
const CLICK_VIS = (gid) => `(() => {
  const legend = window.__view.getLegend();
  const i = legend.findIndex((g) => g.id === '${gid}');
  const sec = document.querySelectorAll('#legend-body .legend-section')[i];
  sec.querySelector('.legend-group-box').click();
  return true;
})()`;

async function main() {
  const mapTarget = await waitForTarget(PORT, (t) => t.url.endsWith('/map.html'), 30000);
  if (!mapTarget) throw new Error('没找到主窗口（用 --remote-debugging-port 启动了吗？）');
  const wsMap = mapTarget.webSocketDebuggerUrl;
  const ev = (expr) => evaluate(wsMap, expr);

  const cfg0 = await ev('window.api.getConfig()');
  const labelToggles0 = (cfg0 && cfg0.labelToggles) || null;
  const toggles0 = (cfg0 && cfg0.markerToggles) || null;
  const miniWasOn = !!(cfg0 && cfg0.miniVisible);

  let miniTarget = null;
  const wsMini = () => miniTarget && miniTarget.webSocketDebuggerUrl;
  const mev = (expr) => (wsMini() ? evaluate(wsMini(), expr) : Promise.resolve(null));

  try {
    // ---------------------------------------------------------------- 准备：海关 + 图例面板
    const ready = await waitFor(() => ev("!!(window.__view && document.querySelector('#map-select') && document.querySelector('#map-select').options.length > 1)"), 40000, 400);
    check('渲染层初始化完成（地图下拉已填充 / __view 就位）', ready === true, String(ready));
    if (ready !== true) throw new Error('渲染层没就绪，后面的断言没法做');
    await ev("window.api.selectMap({ key: 'customs' })");
    const hasLegend = await waitFor(() => ev("document.querySelectorAll('#legend-body .legend-section').length > 0"), 15000, 300);
    check('图例面板已渲染出大类', hasLegend === true, String(hasLegend));

    // ---------------------------------------------------------------- 1) 组头结构
    const rows = await ev(ROWS);
    check('大类数量与图例一一对应（每一行都有 Aa 勾选框）',
      Array.isArray(rows) && rows.length > 4 && rows.every((r) => r.hasTextBox && r.hasVisBox && r.rows === rows.length),
      Array.isArray(rows) ? rows.length + ' 个大类' : String(rows));
    const wrongEnabled = (rows || []).filter((r) => r.textDisabled !== !r.text);
    check('只有会写字的大类才给可点的 Aa（其余置灰）',
      wrongEnabled.length === 0 && (rows || []).some((r) => r.text && r.textDisabled === false),
      wrongEnabled.length ? JSON.stringify(wrongEnabled.map((r) => r.id))
        : '可关文字：' + (rows || []).filter((r) => r.text).map((r) => r.id).join(','));
    const noTextRows = (rows || []).filter((r) => !r.text);
    check('没有文字的大类都有说明文案（不是点了没反应的死控件）',
      noTextRows.length > 0 && noTextRows.every((r) => r.title.length > 4 && r.off === true),
      noTextRows.map((r) => r.id + '：' + r.title).join('；'));
    const labelRow = (rows || []).find((r) => r.id === 'g-label');
    check('地名那一类明确提示「本身就是文字，用左边勾选框整类隐藏」',
      !!labelRow && /地名/.test(labelRow.title), labelRow ? labelRow.title : '找不到地名大类');
    const textRows = (rows || []).filter((r) => r.text);
    check('可关文字的大类覆盖了用户最常看的几类（撤离/Boss/物资/赛季…）',
      ['g-extract', 'g-loot', 'g-season', 'g-access', 'g-threat', 'g-hazard'].every((id) => textRows.some((r) => r.id === id)),
      textRows.map((r) => r.id).join(','));

    // ---------------------------------------------------------------- 2) 主地图：关掉文字只留图标
    const before = await ev(MAIN_STAT('g-extract'));
    check('准备：撤离大类在地图上既有图标也有文字',
      !!before && before.icons > 0 && before.texts > 0, JSON.stringify(before));
    const off = await ev(CLICK_TEXT('g-extract', false));
    const afterOff = await waitFor(async () => {
      const s = await ev(MAIN_STAT('g-extract'));
      return s && s.texts === 0 && s.markers === before.markers ? s : null;
    }, 6000, 200);
    check('关掉「撤离 · 转移 · 交通」的文字 -> 这一类只剩图标（图标一个不少）',
      !!off && off.checked === false && !!afterOff,
      afterOff ? '图标 ' + afterOff.icons + '/' + before.icons + '，文字 ' + afterOff.texts
        : JSON.stringify(await ev(MAIN_STAT('g-extract'))));
    const persisted = await ev("window.api.getConfig().then((c) => (c.labelToggles || {})['g-extract'])");
    check('选择落进配置（切图 / 重启后记得住）', persisted === false, String(persisted));
    const others = await ev(MAIN_STAT('g-threat'));
    check('别的大类不受影响（Boss 的名字照写）',
      !!others && (others.markers === 0 || others.texts > 0), JSON.stringify(others));
    const togglesAfter = await ev('window.api.getConfig().then((c) => c.markerToggles)');
    check('关文字不动「这一类还画不画」（markerToggles 一个键都没变）',
      JSON.stringify(togglesAfter) === JSON.stringify(toggles0), JSON.stringify(togglesAfter));
    const on = await ev(CLICK_TEXT('g-extract', true));
    const backOn = await waitFor(async () => {
      const s = await ev(MAIN_STAT('g-extract'));
      return s && s.texts > 0 ? s : null;
    }, 6000, 200);
    check('再勾回来 -> 文字立刻回来（开关双向都生效）', on && on.checked === true && !!backOn,
      backOn ? '文字 ' + backOn.texts : JSON.stringify(await ev(MAIN_STAT('g-extract'))));

    // ---------------------------------------------------------------- 3) 两个开关互不干扰
    const rowsA = await ev(ROWS);
    const rowA = (rowsA || []).find((r) => r.id === 'g-extract');
    await ev(CLICK_VIS('g-extract'));
    await sleep(400);
    const rowsB = await ev(ROWS);
    const rowB = (rowsB || []).find((r) => r.id === 'g-extract');
    check('点左边的显隐勾选框不会连带把 Aa 也点了（嵌套 label 的老毛病）',
      !!rowA && !!rowB && rowB.visChecked === !rowA.visChecked && rowB.textChecked === rowA.textChecked,
      JSON.stringify({ 显隐: rowA && rowA.visChecked, 现在显隐: rowB && rowB.visChecked, Aa: rowB && rowB.textChecked }));
    await ev(CLICK_VIS('g-extract'));
    await sleep(400);
    const rowC = (await ev(ROWS) || []).find((r) => r.id === 'g-extract');
    check('恢复：这一大类又画出来了（Aa 仍是勾上的）',
      !!rowC && rowC.visChecked === true && rowC.textChecked === true,
      JSON.stringify(rowC && { vis: rowC.visChecked, text: rowC.textChecked }));
    const beforeAllNone = await ev('window.api.getConfig().then((c) => c.labelToggles || null)');
    await ev("document.getElementById('legend-none').click()");
    await sleep(300);
    await ev("document.getElementById('legend-all').click()");
    await sleep(300);
    const afterAllNone = await ev('window.api.getConfig().then((c) => c.labelToggles || null)');
    check('「全开 / 全关」只管标记显隐，不会顺手改文字开关',
      JSON.stringify(afterAllNone || {}) === JSON.stringify(beforeAllNone || {}),
      JSON.stringify(beforeAllNone) + ' -> ' + JSON.stringify(afterAllNone));

    // ---------------------------------------------------------------- 4) 雷达：同一个开关
    await ev('window.api.setConfig({ miniVisible: true })');
    miniTarget = await waitForTarget(PORT, (t) => t.url.endsWith('/minimap.html'), 20000);
    check('雷达窗口已开启（和主窗口共用同一份配置）', !!miniTarget, miniTarget ? miniTarget.url : '没等到 minimap.html');
    if (miniTarget) {
      const radarReady = await waitFor(() => mev('!!(window.__view && window.__view.detail)'), 20000, 400);
      check('雷达已加载当前地图', radarReady === true, String(radarReady));
      const rOn = await mev(RADAR_AT);
      check('准备：雷达上这一类的撤离点带着名字',
        !!rOn && rOn.extractIcons > 0 && rOn.extractTexts > 0, JSON.stringify(rOn));
      await ev(CLICK_TEXT('g-extract', false));
      const rOff = await waitFor(async () => {
        const s = await mev(RADAR_AT);
        return s && s.extractTexts === 0 && s.extractIcons > 0 ? s : null;
      }, 8000, 300);
      check('主窗口关掉这一类文字 -> 雷达上同一类也只剩图标（别的大类照写）',
        !!rOff, rOff ? '这一类图标 ' + rOff.extractIcons + ' / 文字 ' + rOff.extractTexts
          + '；整个雷达文字 ' + rOff.texts : JSON.stringify(await mev(RADAR_AT)));
      await ev(CLICK_TEXT('g-extract', true));
      const rBack = await waitFor(async () => {
        const s = await mev(RADAR_AT);
        return s && s.extractTexts > 0 ? s : null;
      }, 8000, 300);
      check('勾回来 -> 雷达上的名字也回来', !!rBack, rBack ? '这一类文字 ' + rBack.extractTexts : JSON.stringify(await mev(RADAR_AT)));
      // 截图：把雷达摆在撤离点上，留一张「只有图标」的对照
      await mev(RADAR_AT);
      await sleep(300);
      await screenshot(wsMini(), path.join(ART, 'legend-text-mini.png')).catch(() => {});
    }

    // ---------------------------------------------------------------- 截图留证
    try {
      fs.mkdirSync(ART, { recursive: true });
      await ev("(() => { const p = document.getElementById('legend-panel'); p.classList.remove('collapsed'); document.getElementById('btn-legend').classList.add('active'); return true; })()");
      await sleep(400);
      await screenshot(wsMap, path.join(ART, 'legend-text.png'));
      // 图例面板单独来一张 2x 放大：Aa 开关的"可点 / 置灰"一眼能看清（整窗截图里太小）
      const box = await ev(`(() => {
        const r = document.getElementById('legend-panel').getBoundingClientRect();
        return { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)),
                 width: Math.round(r.width),
                 height: Math.min(Math.round(r.height), window.innerHeight - Math.round(r.top)) };
      })()`);
      if (box && box.width > 0 && box.height > 0) {
        const zoom = await cdp(wsMap, [
          ['Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 } }],
        ], 20000);
        if (typeof zoom[0] === 'string') {
          fs.writeFileSync(path.join(ART, 'legend-text-panel.png'), Buffer.from(zoom[0], 'base64'));
        }
      }
      console.log('      截图：' + path.join(ART, 'legend-text.png') + ' 与 legend-text-panel.png（图例放大）');
    } catch (e) {
      console.log('      （截图跳过：' + e.message + '）');
    }
  } finally {
    // 收尾：配置与雷达状态放回原样（隔离配置目录本来也会被 runner 删掉）
    try {
      await ev("window.api.setConfig({ labelToggles: " + JSON.stringify(labelToggles0) + " })");
      if (!miniWasOn) await ev('window.api.setConfig({ miniVisible: false })');
    } catch {}
  }

  if (!report.finish()) process.exit(1);
}

main().catch((e) => {
  console.error('验收失败：', e && e.message ? e.message : e);
  process.exit(2);
});
