'use strict';

/**
 * 主窗口布局的硬约束（曾经踩过：顶栏加了"常驻标注工具条"这一行之后，
 * 左右两个浮窗还钉在固定的 top: 58px，于是压住了标注工具条）。
 *
 * 正确结构：
 *   header.topbar（可能有多行：控件行 + 常驻标注工具条）
 *   #workarea            <- 侧栏挂在这一层，上沿 = 顶栏下沿（顶栏几行都不怕）
 *     aside#quest-panel  <- 绝对定位浮窗（左）
 *     main#map-root      <- 地图（MapView 会 innerHTML 它，里面**不能**放侧栏）
 *     aside#legend-panel <- 绝对定位浮窗（右）
 *   aside.statusbar
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const html = read('renderer/map.html');
const css = read('renderer/map.css');

test('主窗口：两个浮窗挂在 #workarea 下，不在地图容器里', () => {
  const iWork = html.indexOf('id="workarea"');
  const iQuest = html.indexOf('id="quest-panel"');
  const iMap = html.indexOf('id="map-root"');
  const iLegend = html.indexOf('id="legend-panel"');
  const iStatus = html.indexOf('class="statusbar"');
  for (const [name, i] of [['#workarea', iWork], ['#quest-panel', iQuest], ['#map-root', iMap], ['#legend-panel', iLegend], ['状态栏', iStatus]]) {
    assert.ok(i > 0, `map.html 里找不到 ${name}`);
  }
  // 三个都在 #workarea 里，且状态栏在它外面（顺序无所谓：侧栏是绝对定位，
  // 但 workarea 必须"包住"地图与两个侧栏，收尾的 </div> 要在状态栏之前）
  assert.ok(iWork < iMap, '#workarea 应该在 #map-root 之前');
  assert.ok(iWork < iQuest, '#quest-panel 要在 #workarea 之后（即它里面）');
  assert.ok(iWork < iLegend, '#legend-panel 要在 #workarea 之后（即它里面）');
  const workareaClose = html.indexOf('</div>', Math.max(iQuest, iMap, iLegend));
  assert.ok(workareaClose > 0 && workareaClose < iStatus, '#workarea 的 </div> 应该在状态栏之前');

  // MapView 会 this.el.innerHTML = ...（this.el = #map-root），侧栏放进去会被抹掉
  const mainStart = html.lastIndexOf('<main', iMap);
  const mainEnd = html.indexOf('</main>', iMap);
  const mapRoot = html.slice(mainStart, mainEnd);
  assert.ok(!mapRoot.includes('<aside'), '#map-root 里不能放侧栏（MapView 会重置它的 innerHTML）');
  assert.ok(!mapRoot.includes('id="quest-panel"') && !mapRoot.includes('id="legend-panel"'));

  // 顶栏里带着常驻标注工具条
  assert.match(html, /<header class="topbar">[\s\S]*?id="anno-bar"[\s\S]*?<\/header>/, '标注工具条要在顶栏里');
});

test('主窗口 CSS：侧栏用「相对 workarea」的定位，不许再写死顶栏高度', () => {
  assert.match(css, /\.workarea \{[^}]*position:\s*relative[^}]*\}/, '.workarea 必须 position: relative（侧栏的定位基准）');
  assert.match(css, /\.workarea \{[^}]*display:\s*flex[^}]*\}/, '.workarea 用 flex 行布局（地图占满剩余宽度）');
  assert.match(css, /#map-root \{[^}]*flex:\s*1[^}]*\}/, '#map-root 要吃掉剩余宽度');

  /** 取把某选择器当"基础规则"的那一条（带 position: absolute 的那条，而不是 @media 里的覆写） */
  const baseRule = (sel) => {
    const re = new RegExp(`\\${sel} \\{[^}]*\\}`, 'g');
    const all = css.match(re) || [];
    const rule = all.find((r) => /position:\s*absolute/.test(r));
    assert.ok(rule, `map.css 里找不到 ${sel} 的基础规则（position: absolute）`);
    return rule;
  };
  for (const sel of ['.legend-panel', '.quest-panel']) {
    const rule = baseRule(sel);
    assert.match(rule, /top:\s*0/, `${sel} 应该 top: 0（= workarea 上沿）`);
    assert.match(rule, /bottom:\s*0/, `${sel} 应该 bottom: 0（= workarea 下沿，正好在状态栏上方）`);
    assert.ok(!/top:\s*58px/.test(rule), `${sel} 不能再写死 top: 58px（顶栏现在有两行）`);
    assert.ok(!/bottom:\s*34px/.test(rule), `${sel} 不能再写死 bottom: 34px（状态栏高度会变）`);
  }
  assert.ok(!/top:\s*58px/.test(css), 'map.css 里不该再有 "顶栏 58px" 这种写死的偏移');
});

test('滚动条：暗色主题自定义（细/圆角/悬停变亮），别用原生那种又宽又亮的', () => {
  assert.match(css, /::-webkit-scrollbar \{[^}]*width:\s*\d+px/, '要有 ::-webkit-scrollbar 宽度设置');
  assert.match(css, /::-webkit-scrollbar-thumb \{[^}]*border-radius:\s*999px/, '滑块要圆角');
  assert.match(css, /::-webkit-scrollbar-thumb \{[^}]*background-clip:\s*content-box/, '用透明边框把滑块收窄，看着才细');
  assert.match(css, /::-webkit-scrollbar-thumb:hover/, '要有效果（悬停变亮）');
  assert.match(css, /::-webkit-scrollbar-track \{[^}]*background:\s*transparent/, '轨道要透明（别留一条浅灰槽）');
  // 注意：一旦写了标准属性 scrollbar-width/scrollbar-color，Chromium 会忽略上面的 ::-webkit-* 规则
  assert.ok(!/scrollbar-width\s*:/.test(css), '别同时写 scrollbar-width（会让上面的规则失效）');
  assert.ok(!/scrollbar-color\s*:/.test(css), '别同时写 scrollbar-color（会让上面的规则失效）');
});
