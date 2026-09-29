#!/usr/bin/env node
/**
 * 「设置页即时生效 + 雷达窗口大小 + 新定位重新居中」端到端验收。
 *
 * 对着用户报的三条：
 *   1) 雷达拖动（Ctrl 平移过圆盘里的地图）之后再按截图键定位，玩家停在偏心位置不回中
 *   2) 设置里没有雷达图大小的调节
 *   3) 设置页要响应式、大小/透明度等实时变化，去掉「保存 / 取消」
 *
 * 全程用 CDP 驱动 + 往临时截图目录丢"假截图"触发真实定位链路，
 * **不碰系统光标、不注入任何键鼠**（拖动窗口那种手势要真实光标，这里改为直接操作
 * 渲染层的视野偏移量 window.__mini.setPan，语义等价：偏移留没留下来）。
 *
 * 脚本自己起一个**隔离实例**（TAKOV_USER_DATA 指到临时目录），不读写你日常那份配置。
 *
 * 用法:
 *   node tools/verify-settings-live.js [--port=9345] [--keep]
 *   --keep  跑完不删临时配置目录（要看 mini.log / app.log / settings.json 时用）
 */
const fs = require('fs');
const path = require('path');

// 起实例 / CDP / 断言 / 隔离配置目录都走 tools/lib（细节见各文件头注释）——
// 启动阶段那些坑（管道 stdio、受限环境里 Chromium 子进程建不出来）在 lib 里统一处理。
const { sleep, targets, cdp } = require('./lib/cdp');
const { createReport, makeProfile: isolatedProfile, PNG_1X1 } = require('./lib/suite');
const { launchReady } = require('./lib/spawn-electron');

const ROOT = path.join(__dirname, '..');
const ART = path.join(ROOT, 'test-artifacts');
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9345));
const KEEP = process.argv.includes('--keep');

const report = createReport('设置页即时生效 + 雷达大小 + 新定位重新居中 + 主窗口改大小');
const check = report.check;

/** 隔离配置：目录全在临时目录里，雷达从"关"开始，位置固定在屏幕中间偏左（改大小要验证圆盘中心不动） */
function makeProfile() {
  return isolatedProfile('takov-settings-live-', {
    miniVisible: false,
    miniSize: 300,
    miniRadius: 55,
    miniPos: { x: 600, y: 300 },
  }, { keep: KEEP });
}

/** 假截图名（游戏真实格式），坐标不同 = 新的一次定位 */
const shotName = (x, z, y = 3.2) =>
  `2026-09-18[22-00]_${x}, ${y}, ${z}_0.01518, 0.90924, -0.03197, 0.41476_15.47 (0).png`;

async function main() {
  const prof = makeProfile();
  // 起实例、等主窗口、收尾都在 lib 里；受限环境会自动用最小让步参数并告诉我们
  const launcher = await launchReady({
    port: PORT,
    userData: prof.userData,
    cwd: ROOT,
    match: (t) => t.url.endsWith('/map.html'),
    timeoutMs: 60000,
  });
  const app = launcher.app;
  const mapTarget = launcher.target;
  if (launcher.degraded) console.log(`（本机 shell 受限：本次用让步参数 ${(launcher.usedArgs || []).join(' ')} 起测试实例）`);
  const kill = () => app.kill();

  try {
    const mapEval = (expr) => cdp(mapTarget.webSocketDebuggerUrl, [
      ['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }],
    ]).then((r) => r[0]);
    const miniTargetOf = async () => (await targets(PORT)).find((t) => t.url.endsWith('/minimap.html')) || null;
    let miniTarget = null;
    const miniEval = (expr) => (miniTarget
      ? cdp(miniTarget.webSocketDebuggerUrl, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]).then((r) => r[0])
      : Promise.resolve(null));

    /** 等一个条件成立（返回最后一次的值） */
    const wait = async (fn, ms = 8000, step = 250) => {
      const until = Date.now() + ms;
      let last = null;
      while (Date.now() < until) {
        last = await fn();
        if (last) return last;
        await sleep(step);
      }
      return last;
    };

    // 渲染层初始化完成（下拉被填充 = init() 已走过注册 onState 那一步）
    const ready = await wait(() => mapEval(
      `!!(document.querySelector('#map-select') && document.querySelector('#map-select').options.length > 1 && window.__view && window.__settings && window.__quest)`,
    ), 40000, 400);
    check('渲染层初始化完成（地图下拉已填充 / __view 与 __settings 就位）', ready === true, String(ready));
    if (ready !== true) throw new Error('渲染层没就绪，后面的断言没法做');

    await mapEval(`window.api.selectMap({ key: 'customs' })`);
    await sleep(1500);

    // ---------------------------------------------------------------- 设置页
    await mapEval(`document.getElementById('btn-settings').click()`);
    await sleep(400);
    const dlg = await mapEval(`(() => {
      const d = document.getElementById('settings-dialog');
      if (!d || !d.open) return { open: false };
      const actions = d.querySelector('.dialog-actions');
      return {
        open: true,
        hasSave: !!d.querySelector('#settings-ok'),
        hasClose: !!d.querySelector('#settings-close'),
        actionTexts: [...actions.querySelectorAll('button')].map((b) => b.textContent.trim()),
        live: (d.querySelector('.settings-live') || {}).textContent || '',
        width: d.getBoundingClientRect().width,
        vw: window.innerWidth,
        overflowX: d.scrollWidth - d.clientWidth,
        gridCols: getComputedStyle(d.querySelector('.settings-grid')).gridTemplateColumns,
        // computed 值会被浏览器解析成具体轨道宽度，"auto-fit" 只存在于样式规则原文里
        gridRule: (() => {
          try {
            for (const ss of document.styleSheets) {
              let rules; try { rules = ss.cssRules; } catch { continue; }
              for (const r of rules || []) {
                if (r.selectorText === '.settings-grid' && /auto-fit/.test(r.style.gridTemplateColumns)) return r.style.gridTemplateColumns;
              }
            }
          } catch {}
          return '';
        })(),
        rangeVals: d.querySelectorAll('.range-val').length,
        ranges: d.querySelectorAll('input[type=range]').length,
      };
    })()`);
    check('设置页能打开', !!dlg && dlg.open === true, JSON.stringify(dlg && dlg.open));
    check('没有「保存」按钮了', dlg && dlg.hasSave === false, `hasSave=${dlg && dlg.hasSave}`);
    check('没有「取消」按钮，只有「关闭」',
      !!dlg && dlg.hasClose === true && !dlg.actionTexts.includes('取消') && !dlg.actionTexts.includes('保存'),
      `按钮：${(dlg && dlg.actionTexts || []).join(' / ')}`);
    check('写着"改动即时生效"', !!dlg && /即时生效/.test(dlg.live), (dlg && dlg.live || '').slice(0, 40));
    check('对话框不超出视口宽度（响应式）',
      !!dlg && dlg.width <= dlg.vw * 0.94 + 2 && dlg.overflowX <= 1,
      `宽 ${dlg && Math.round(dlg.width)} / 视口 ${dlg && dlg.vw}，横向溢出 ${dlg && dlg.overflowX}`);
    check('网格是 auto-fit（跟着宽度自己重排）', !!dlg && /auto-fit/.test(dlg.gridRule || ''), dlg && (dlg.gridRule || dlg.gridCols));

    // 每个滑块右边都有当前值
    check('每个滑块右边都显示当前值', !!dlg && dlg.rangeVals === dlg.ranges && dlg.ranges >= 6,
      `徽标 ${dlg && dlg.rangeVals} / 滑块 ${dlg && dlg.ranges}`);

    // 窄视口：网格必须收成一列
    await cdp(mapTarget.webSocketDebuggerUrl, [['Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false }]]);
    await sleep(400);
    const narrow = await mapEval(`(() => {
      const d = document.getElementById('settings-dialog');
      const cols = getComputedStyle(d.querySelector('.settings-grid')).gridTemplateColumns.trim();
      return { cols, count: cols ? cols.split(/\\s+/).length : 0, width: d.getBoundingClientRect().width, vw: window.innerWidth, overflowX: d.scrollWidth - d.clientWidth };
    })()`);
    await cdp(mapTarget.webSocketDebuggerUrl, [['Emulation.clearDeviceMetricsOverride']]);
    await sleep(300);
    check('窄视口（700px）设置页收成一列且不横向溢出',
      !!narrow && narrow.count === 1 && narrow.overflowX <= 1 && narrow.width <= narrow.vw,
      `列数 ${narrow && narrow.count}，宽 ${narrow && Math.round(narrow.width)} / ${narrow && narrow.vw}`);

    // 滑块即时生效：不点任何按钮，只派发 input
    await mapEval(`(() => {
      const el = document.querySelector('#set-marker-scale');
      el.value = '1.5';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const liveScale = await wait(async () => {
      const cfg = await mapEval('window.api.getConfig()');
      const v = await mapEval('window.__view.markerScale');
      return cfg && Math.abs(cfg.markerScale - 1.5) < 1e-6 && Math.abs(v - 1.5) < 1e-6
        ? { cfg: cfg.markerScale, view: v, badge: await mapEval(`document.querySelectorAll('#settings-dialog .range-val')[[...document.querySelectorAll('#settings-dialog input[type=range]')].findIndex((e) => e.id === 'set-marker-scale')].textContent`) }
        : null;
    }, 4000, 200);
    check('拖滑块（只派发 input，没点保存）立刻写进配置并生效',
      !!liveScale, liveScale ? `config=${liveScale.cfg} view=${liveScale.view} 徽标=${liveScale.badge}` : '配置没变');
    check('滑块右边的数值也跟着变', !!liveScale && liveScale.badge === '1.5', liveScale && `徽标=${liveScale.badge}`);
    // 「自动记住」：主进程要把改动落盘到隔离配置目录的 settings.json，而不是只活在内存里
    const persisted = await wait(async () => {
      try { const c = JSON.parse(prof.read('settings.json')); return Math.abs(c.markerScale - 1.5) < 1e-6 ? c.markerScale : null; } catch { return null; }
    }, 4000, 200);
    check('改动自动落盘（settings.json 记住拖动后的值，不用点保存）', persisted === 1.5, `settings.json markerScale=${persisted}`);
    await mapEval(`(() => { const el = document.querySelector('#set-marker-scale'); el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(300);

    // ---------------------------------------------------------------- 雷达：启用 + 大小
    await mapEval(`(() => { const el = document.querySelector('#set-mini'); el.checked = true; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    miniTarget = await wait(() => miniTargetOf(), 10000, 300);
    const st1 = await wait(async () => {
      const s = await mapEval('window.api.miniStatus()');
      return s && s.alive && s.visible ? s : null;
    }, 8000);
    check('勾「启用小地图雷达」（没点保存）雷达窗口就出来了', !!st1, JSON.stringify(st1 && st1.bounds));
    check('顶栏那个开关也跟着亮了',
      (await mapEval(`document.getElementById('btn-mini').classList.contains('active')`)) === true);
    if (!miniTarget) throw new Error('没有雷达窗口，后面的断言没法做');
    const miniReady = await wait(() => miniEval('!!window.__mini && !!window.__view.proj && !!window.__view.detail'), 15000, 300);
    check('雷达渲染层就绪（__mini 与地图都到位）', miniReady === true, String(miniReady));

    const boundsOf = () => mapEval('window.api.miniStatus().then((s) => s && s.bounds)');
    const centerOf = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    const b300 = await boundsOf();
    check('雷达初始大小 = 配置里的 300', !!b300 && b300.width === 300 && b300.height === 300, JSON.stringify(b300));

    // 拖「雷达窗口大小」滑块 -> 窗口立刻变大，且圆盘中心不动
    await mapEval(`(() => { const el = document.querySelector('#set-mini-size'); el.value = '420'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const b420 = await wait(async () => {
      const b = await boundsOf();
      return b && b.width === 420 && b.height === 420 ? b : null;
    }, 6000, 200);
    check('拖「雷达窗口大小」立刻把窗口变成 420x420', !!b420, JSON.stringify(b420));
    const c0 = centerOf(b300 || { x: 0, y: 0, width: 300, height: 300 });
    const c1 = centerOf(b420 || c0);
    check('改大小以圆盘中心为基准（你盯着的那块地图不跳）',
      Math.abs(c0.x - c1.x) <= 2 && Math.abs(c0.y - c1.y) <= 2,
      `中心 ${Math.round(c0.x)},${Math.round(c0.y)} -> ${Math.round(c1.x)},${Math.round(c1.y)}`);
    const disc = await wait(async () => {
      const w = await miniEval('window.__mini && window.__mini.discWidth()');
      return typeof w === 'number' && Math.abs(w - 420) < 2 ? w : null;
    }, 5000, 200);
    check('雷达圆盘也跟着变成 420', typeof disc === 'number', `discWidth=${disc}`);

    // ---------------------------------------------------------------- 定位：居中 + 半径
    const centered = () => miniEval(`(() => {
      const v = window.__view;
      if (!v.player || !v.proj) return null;
      const p = v.proj.project(v.player.x, v.player.z);
      return { dx: v.view.cx - p.x, dy: v.view.cy - p.y, pan: window.__mini.pan(), disc: window.__mini.discWidth() };
    })()`);
    const radiusRatio = () => miniEval(`(async () => {
      const mod = await import('./common/map-view.js');
      const v = window.__view;
      if (!v.player || !v.proj) return null;
      const R = window.__mini.radiusM();
      const d = mod.metersToScreen(v.proj, v.player.x, v.player.z, R);
      return { ratio: (d * v.view.scale) / (window.__mini.discWidth() / 2), R };
    })()`);

    fs.writeFileSync(path.join(prof.shots, shotName('-120.50', '210.25')), PNG_1X1);
    const pos1 = await wait(() => mapEval('window.api.getState().then((s) => s.position)'), 8000, 250);
    check('假截图产生了定位（走的是真实截图监听链路）', !!pos1, JSON.stringify(pos1));
    const c2 = await wait(centered, 6000, 200);
    check('定位后玩家在雷达圆心',
      !!c2 && Math.abs(c2.dx) < 0.5 && Math.abs(c2.dy) < 0.5,
      c2 ? `偏移 ${c2.dx.toFixed(2)},${c2.dy.toFixed(2)}` : '读不到');
    const rr = await radiusRatio();
    check('「显示半径(米)」真的等于圆盘半径（改大小之后没跑偏）',
      !!rr && Math.abs(rr.ratio - 1) < 0.02, rr ? `比例 ${rr.ratio.toFixed(3)}（半径 ${rr.R} 米）` : '读不到');

    // ---------------------------------------------------------------- 用户报的第 1 条
    // Ctrl 平移过圆盘里的地图 -> 视野偏移；别的状态推送不能把它撤销
    await miniEval(`(window.__mini.setPan(120, 60), true)`);
    await sleep(300);
    await mapEval(`window.api.setConfig({ markerScale: 1.2 })`);
    await sleep(700);
    const shifted = await centered();
    check('平移出来的视野偏移会留着（切个图例/改个设置不会被拉回玩家）',
      !!shifted && Math.abs(shifted.dx - 120) < 1 && Math.abs(shifted.dy - 60) < 1
        && Math.abs(shifted.pan.x - 120) < 1 && Math.abs(shifted.pan.y - 60) < 1,
      shifted ? `偏移 ${shifted.dx.toFixed(1)},${shifted.dy.toFixed(1)} pan=${JSON.stringify(shifted.pan)}` : '读不到');
    await mapEval(`window.api.setConfig({ markerScale: 1 })`);

    // 再定位 -> 必须重新居中（这就是用户报的那条）
    fs.writeFileSync(path.join(prof.shots, shotName('-160.75', '238.50')), PNG_1X1);
    const pos2 = await wait(async () => {
      const p = await mapEval('window.api.getState().then((s) => s.position)');
      return p && Math.abs(p.x - -160.75) < 0.01 ? p : null;
    }, 8000, 250);
    check('第二张假截图被识别成新的一次定位', !!pos2, JSON.stringify(pos2));
    const c3 = await wait(async () => {
      const c = await centered();
      return c && Math.abs(c.dx) < 0.5 && Math.abs(c.dy) < 0.5 ? c : null;
    }, 6000, 200);
    check('再定位 -> 视野偏移归零、玩家回到圆心（用户报的第 1 条）',
      !!c3, c3 ? `偏移 ${c3.dx.toFixed(2)},${c3.dy.toFixed(2)}（pan=${JSON.stringify(c3.pan)}）`
        : `没回中：${JSON.stringify(await centered())}`);

    // 关掉「定位后自动居中」-> 定位既不能抢视野中心、也不能动偏移
    await mapEval(`(() => { const el = document.querySelector('#set-mini-auto-center'); el.checked = false; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(500);
    await miniEval(`(window.__mini.setPan(-80, 40), true)`);
    await sleep(200);
    const vpBefore = await miniEval('window.__mini.viewport()');
    fs.writeFileSync(path.join(prof.shots, shotName('-90.25', '180.00')), PNG_1X1);
    await wait(async () => {
      const p = await mapEval('window.api.getState().then((s) => s.position)');
      return p && Math.abs(p.x - -90.25) < 0.01 ? p : null;
    }, 8000, 250);
    await sleep(600);
    const vpAfter = await miniEval('window.__mini.viewport()');
    const c4 = await centered();
    check('关掉「定位后自动居中」后，定位不抢视野（视野中心一格没动）',
      !!vpBefore && !!vpAfter && Math.abs(vpBefore.cx - vpAfter.cx) < 0.5 && Math.abs(vpBefore.cy - vpAfter.cy) < 0.5,
      `${JSON.stringify(vpBefore && { cx: Math.round(vpBefore.cx), cy: Math.round(vpBefore.cy) })} -> ${JSON.stringify(vpAfter && { cx: Math.round(vpAfter.cx), cy: Math.round(vpAfter.cy) })}`);
    check('关掉「定位后自动居中」后视野偏移也保留',
      !!c4 && Math.abs(c4.pan.x + 80) < 1 && Math.abs(c4.pan.y - 40) < 1,
      c4 ? `pan=${JSON.stringify(c4.pan)}` : '读不到');
    // 打开回来 -> 下一次定位重新居中
    await mapEval(`(() => { const el = document.querySelector('#set-mini-auto-center'); el.checked = true; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(400);
    fs.writeFileSync(path.join(prof.shots, shotName('-100.00', '200.00')), PNG_1X1);
    await wait(async () => {
      const p = await mapEval('window.api.getState().then((s) => s.position)');
      return p && Math.abs(p.x - -100) < 0.01 ? p : null;
    }, 8000, 250);
    const c5 = await wait(centered, 6000, 200);
    check('重新勾上「定位后自动居中」-> 下一次定位又回圆心',
      !!c5 && Math.abs(c5.dx) < 0.5 && Math.abs(c5.dy) < 0.5,
      c5 ? `偏移 ${c5.dx.toFixed(2)},${c5.dy.toFixed(2)}` : '读不到');

    // 显示半径：拖滑块就生效（不用等下一次定位）
    await mapEval(`(() => { const el = document.querySelector('#set-mini-radius'); el.value = '120'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const rr2 = await wait(async () => {
      const r = await radiusRatio();
      return r && Math.abs(r.R - 120) < 0.01 && Math.abs(r.ratio - 1) < 0.02 ? r : null;
    }, 5000, 200);
    check('拖「显示半径(米)」立刻生效（不等到下一次定位）',
      !!rr2, rr2 ? `半径 ${rr2.R} 米，比例 ${rr2.ratio.toFixed(3)}` : JSON.stringify(await radiusRatio()));

    // 整体透明度：滑块 -> 窗口不透明度（不是配置写没写，而是真的落到窗口上）
    const opBefore = await mapEval('window.api.miniStatus().then(() => window.api.getConfig().then((c) => c.miniOpacity))');
    await mapEval(`(() => { const el = document.querySelector('#set-mini-opacity'); el.value = '0.5'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const opAfter = await wait(async () => {
      const o = await mapEval('window.api.getConfig().then((c) => c.miniOpacity)');
      return Math.abs(o - 0.5) < 1e-6 ? o : null;
    }, 4000, 200);
    check('拖「整体透明度」立刻写进配置', opAfter === 0.5, `${opBefore} -> ${opAfter}`);
    await mapEval(`window.api.setConfig({ miniOpacity: 0.9 })`);

    // ---------------------------------------------------------------- 主窗口改大小：底图 / 标记 / 图例不许错位
    // 等价于"拖主窗口右下角改大小"：viewBox 与覆盖层里的屏幕坐标都必须按新尺寸重算，
    // 否则底图被 preserveAspectRatio 整体缩放居中、标记停在旧坐标 —— 看着就是"图例和地图背景错位"。
    const layoutProbe = () => mapEval(`(() => {
      const root = document.querySelector('#map-root');
      const r = root.getBoundingClientRect();
      const svg = root.querySelector('.mapstage-svg');
      const world = root.querySelector('.world');
      const pl = window.__view && window.__view.playerEl;
      // 玩家箭头的 translate 在内层 g 上（playerEl 本身没有 transform）
      const pg = pl && pl.querySelector('g[transform]');
      const m = pg && /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(pg.getAttribute('transform') || '');
      const legend = document.querySelector('#legend-panel').getBoundingClientRect();
      const work = document.querySelector('#workarea').getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        viewBox: svg ? svg.getAttribute('viewBox') : null,
        worldT: world ? world.getAttribute('transform') : null,
        player: m ? { x: Math.round(Number(m[1])), y: Math.round(Number(m[2])) } : null,
        legendRight: Math.round(legend.right), workRight: Math.round(work.right),
        legendW: Math.round(legend.width), vw: window.innerWidth,
      };
    })()`);
    const lay1 = await layoutProbe();
    const target = { width: Math.max(1000, Math.round((lay1 && lay1.vw ? lay1.vw : 1400) * 0.72)), height: 800 };
    await cdp(mapTarget.webSocketDebuggerUrl, [['Emulation.setDeviceMetricsOverride', { ...target, deviceScaleFactor: 1, mobile: false }]]);
    const lay2 = await wait(async () => {
      const l = await layoutProbe();
      return l && Math.abs(l.w - target.width) <= 2 ? l : null;
    }, 5000, 200);
    check('改大小后 #map-root 拿到新尺寸', !!lay2, lay2 ? `${lay2.w}x${lay2.h}（目标宽 ${target.width}）` : JSON.stringify(await layoutProbe()));
    check('底图 viewBox 跟着新尺寸重算（不再被缩放/居中带偏）',
      !!lay2 && lay2.viewBox === `0 0 ${lay2.w} ${lay2.h}`,
      lay2 ? `viewBox="${lay2.viewBox}" / 容器 ${lay2.w}x${lay2.h}` : '读不到');
    check('世界变换的平移量 = 新尺寸的一半（底图居中，不是旧中心）',
      !!lay2 && lay2.worldT && lay2.worldT.startsWith(`translate(${lay2.w / 2} ${lay2.h / 2})`),
      lay2 ? String(lay2.worldT).slice(0, 60) : '读不到');
    check('玩家标记仍在地图正中（底图与标记不错位）',
      !!lay2 && lay2.player && Math.abs(lay2.player.x - lay2.w / 2) <= 1 && Math.abs(lay2.player.y - lay2.h / 2) <= 1,
      lay2 ? `玩家 ${JSON.stringify(lay2.player)} / 中心 ${lay2.w / 2},${lay2.h / 2}` : '读不到');
    check('图例仍然贴着工作区右边缘（宽度不变）',
      !!lay2 && Math.abs(lay2.legendRight - lay2.workRight) <= 1 && Math.abs(lay2.legendW - (lay1 ? lay1.legendW : lay2.legendW)) <= 1,
      lay2 ? `图例右 ${lay2.legendRight} / 工作区右 ${lay2.workRight}，宽 ${lay2.legendW}` : '读不到');
    await cdp(mapTarget.webSocketDebuggerUrl, [['Emulation.clearDeviceMetricsOverride']]);
    await sleep(500);

    // 截图留证
    try {
      fs.mkdirSync(ART, { recursive: true });
      // 对话框此时可能已经被上面的操作留在打开状态：重新确保它开着，截一张设置页
      await mapEval(`(() => { const d = document.getElementById('settings-dialog'); if (!d.open) d.showModal(); d.scrollTop = 0; return true; })()`);
      await sleep(400);
      const shot1 = await cdp(mapTarget.webSocketDebuggerUrl, [['Page.captureScreenshot', { format: 'png' }]], 9000);
      if (typeof shot1[0] === 'string') fs.writeFileSync(path.join(ART, 'settings-live.png'), Buffer.from(shot1[0], 'base64'));
      const shot2 = await cdp(miniTarget.webSocketDebuggerUrl, [['Page.captureScreenshot', { format: 'png' }]], 9000);
      if (typeof shot2[0] === 'string') fs.writeFileSync(path.join(ART, 'settings-live-mini.png'), Buffer.from(shot2[0], 'base64'));
      console.log(`      截图：${path.join(ART, 'settings-live.png')} / settings-live-mini.png`);
    } catch (e) {
      console.log(`      （截图跳过：${e.message}）`);
    }
  } finally {
    kill();
    await sleep(600);
    prof.cleanup();
  }

  if (!report.finish()) process.exit(1);
}

main().catch((e) => {
  console.error('验收失败：', e && e.message ? e.message : e);
  process.exit(2);
});
