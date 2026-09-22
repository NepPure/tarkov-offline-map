#!/usr/bin/env node
/**
 * 手动标注（画笔/路径/直线/箭头/椭圆/矩形/橡皮）验收。
 *
 * 全程用 CDP 合成鼠标事件（不碰系统光标），画在海关上：
 *   1) 工具条常驻顶栏（不再有「标注」开关与「完成」按钮）-> 点工具即进入标注
 *   2) 六种工具都能落笔；椭圆 = 对角拖拽内接椭圆，按住 Shift = 正圆
 *   3) 图例里有「我的标注」，能一键隐藏/显示，计数跟着走
 *   4) 橡皮点掉一笔、撤销一笔
 *   5) 防抖落盘 -> api.getAnnotations() 里有数据
 *   6) 换图不串味；换回来还在；重载页面后仍在（真持久化）
 *   7) 再点同一个工具（或 Esc）退出标注，地图恢复拖动
 *   8) 结束前把标注文件恢复原样
 *
 * 用法:
 *   npx electron . --remote-debugging-port=9222
 *   node tools/verify-annotations.js [--port=9222]
 */
const fs = require('fs');
const path = require('path');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9222));
const ART = path.join(__dirname, '..', 'test-artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

/**
 * 一次 CDP 调用。**必须带超时**：页面在重载/卡住时，evaluate 有可能永远不回，
 * 脚本就会一直挂着（挂住 = finally 里的"还原标注"跑不到 -> 用户数据被留在脏状态）。
 */
function cdp(wsUrl, calls, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    let done = false;
    const pending = new Map();
    const results = [];
    const hard = setTimeout(() => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      reject(new Error(`CDP 超时（${timeoutMs}ms）：${calls.map((c) => c[0]).join(',')}`));
    }, timeoutMs);
    ws.onopen = async () => {
      for (const [method, params] of calls) {
        const myId = ++id;
        const p = new Promise((res) => pending.set(myId, res));
        ws.send(JSON.stringify({ id: myId, method, params }));
        results.push(await p);
      }
      ws.close();
      if (done) return;
      done = true;
      clearTimeout(hard);
      resolve(results.map((m) => {
        const r = m && m.result;
        if (r && r.exceptionDetails) {
          const d = r.exceptionDetails;
          return { __error: (d.exception && (d.exception.description || d.exception.value)) || d.text };
        }
        if (r && r.data) return r.data;
        return r && 'result' in r ? r.result.value : m;
      }));
    };
    ws.onerror = (e) => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      reject(new Error('ws error ' + (e.message || '')));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    };
  });
}

/**
 * 标注文件在磁盘上的备份路径。
 * 为什么要有它：脚本正常结束会还原标注，但**被强杀/超时**时 finally 跑不到，
 * 磁盘上就会留下验收期间多画的笔画。有了这份备份，下次跑脚本会先把它还原回去。
 */
const ANNO_BACKUP = path.join(ART, 'annotations-backup.json');

/** 上一次被中断留下的备份：先还原，再说一声 */
async function restoreInterruptedBackup(ev) {
  if (!fs.existsSync(ANNO_BACKUP)) return false;
  try {
    const bak = JSON.parse(fs.readFileSync(ANNO_BACKUP, 'utf-8'));
    await ev(`window.api.setAnnotations(${JSON.stringify(bak)})`);
    fs.unlinkSync(ANNO_BACKUP);
    console.log(`      （发现上次被中断的验收：已把标注还原成 ${Object.keys(bak).length} 张图 / ${Object.values(bak).reduce((n, l) => n + l.length, 0)} 笔）`);
    return true;
  } catch (e) {
    console.log(`      （备份存在但还原失败：${e.message}；文件在 ${ANNO_BACKUP}）`);
    return false;
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** 页面里注入的合成绘制助手（mousedown 打在地图舞台上，move/up 打在 window 上，跟真实操作一致） */
const HELPERS = `(() => {
  const stage = () => document.querySelector('.mapstage');
  window.__drawDrag = (x1, y1, x2, y2, steps = 8, shift = false) => {
    stage().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x1, clientY: y1, button: 0, shiftKey: shift }));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x1 + (x2 - x1) * t, clientY: y1 + (y2 - y1) * t, shiftKey: shift }));
    }
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x2, clientY: y2, button: 0, shiftKey: shift }));
    return true;
  };
  window.__drawClick = (x, y) => {
    stage().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    return true;
  };
  window.__pickTool = (tool) => {
    // 注意：工具是"点一下进入、再点一下退出"的开关 —— 这里只在没选中时才点，
    // 否则连续选同一个工具会把自己关掉（曾经导致"Shift 正圆"那一步什么都没画出来）
    const b = document.querySelector('.anno-tool[data-tool="' + tool + '"]');
    if (!b) return false;
    if (!b.classList.contains('active')) b.click();
    return true;
  };
  window.__exitAnno = () => {
    const active = document.querySelector('.anno-tool.active');
    if (active) active.click();
    return !window.__view.drawMode;
  };
  return true;
})()`;

const ANNO_STATE = `(() => {
  const v = window.__view;
  const bar = document.querySelector('#anno-bar');
  const cancel = document.querySelector('#anno-cancel');
  return {
    active: Boolean(v.drawMode),
    tool: v.drawMode ? v.drawMode.tool : null,
    color: v.drawMode ? v.drawMode.color : null,
    width: v.drawMode ? v.drawMode.width : null,
    annos: (v.annos || []).length,
    dom: document.querySelectorAll('.anno-layer .anno-item, .anno-layer .anno-draft').length,
    // 工具条常驻顶栏：不再有 hidden，且必须是 .topbar 的后代
    barVisible: Boolean(bar) && !bar.classList.contains('hidden'),
    barInTopbar: Boolean(bar && bar.closest('.topbar')),
    hasExitButton: Boolean(document.querySelector('#anno-exit')),
    hasAnnoToggle: Boolean(document.querySelector('#btn-anno')),
    hasHint: Boolean(document.querySelector('#anno-hint')),
    hasCancel: Boolean(cancel),
    cancelDisabled: cancel ? cancel.disabled : null,
    activeTools: [...document.querySelectorAll('.anno-tool.active')].map((b) => b.dataset.tool),
    legend: (() => {
      const row = [...document.querySelectorAll('#legend-body .legend-item')].find((r) => r.querySelector('input').dataset.group === 'anno');
      return row ? { count: Number(row.querySelector('.legend-count').textContent), checked: row.querySelector('input').checked, swatch: !!row.querySelector('svg.legend-swatch') } : null;
    })(),
  };
})()`;

/** 取最后画出来的那一笔的包围盒（客户端坐标，用来验椭圆/矩形） */
const LAST_BBOX = `(() => {
  const nodes = [...document.querySelectorAll('.anno-layer .anno-item')];
  const el = nodes[nodes.length - 1];
  if (!el) return null;
  const pts = (el.getAttribute('points') || '').split(' ').filter(Boolean).map((p) => p.split(',').map(Number));
  if (pts.length < 3) return null;
  const r = document.querySelector('.mapstage').getBoundingClientRect();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return {
    tag: el.tagName,
    n: pts.length,
    left: Math.min(...xs) + r.left,
    top: Math.min(...ys) + r.top,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
})()`;

(async () => {
  const list = await targets();
  const mapTarget = list.find((t) => t.url.endsWith('/map.html'));
  if (!mapTarget) throw new Error('未找到主窗口（用 --remote-debugging-port 启动了吗？）');
  const ws = mapTarget.webSocketDebuggerUrl;
  const ev = (expr) => cdp(ws, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]).then((r) => r[0]);
  // 截图只是留证据：窗口被挡住时 Chromium 不出帧，Page.captureScreenshot 会一直等
  // （以前这一等就是把整个脚本挂住，finally 跑不到、用户的标注留在脏状态）。所以这里失败也不影响验收。
  const shot = async (file) => {
    try {
      const data = await cdp(ws, [['Page.captureScreenshot', { format: 'png' }]], 8000);
      if (typeof data[0] === 'string') {
        fs.mkdirSync(ART, { recursive: true });
        fs.writeFileSync(path.join(ART, file), Buffer.from(data[0], 'base64'));
        console.log(`      截图 -> test-artifacts/${file}`);
      }
    } catch (e) {
      console.log(`      （截图跳过：${e.message}）`);
    }
  };

  // 上一次被强杀/超时留下的备份先还原（否则"原样"会把脏数据当成用户的原始数据备份下来）
  fs.mkdirSync(ART, { recursive: true });
  await restoreInterruptedBackup(ev).catch(() => {});

  const orig = await ev('window.api.getAnnotations()');
  // 落盘备份：脚本被强杀时 finally 跑不到，下一次运行靠这份文件把标注还原回去
  try { fs.writeFileSync(ANNO_BACKUP, JSON.stringify(orig)); } catch {}
  const countFor = (obj, id) => (obj && obj[id] ? obj[id].length : 0);
  let mapId = null;
  let toggles0 = null;

  try {
    // 先重载（跑磁盘上的当前代码），**再**切到海关并取 mapId：
    // 脚本后面全都按这个 id 存取标注。以前是先取 id 后切图，
    // 只要 app 启动时停在别的图（比如日志把图切到海岸线），整轮存取就全错位了。
    await ev('location.reload()');
    await sleep(3500);
    await ev(`(async () => { for (let i = 0; i < 60; i++) {
      if (window.__view && window.__view.detail && window.api) return true;
      await new Promise((r) => setTimeout(r, 200));
    } return false; })()`);
    await ev(`window.api.selectMap({ key: 'customs' })`);
    await sleep(1600);
    await ev(HELPERS);
    mapId = await ev(`window.__view.detail.id`);
    // 「我的标注」这一行图例验收要来回点，先把用户原本的图例开关记下来，结束还原
    // （否则用户本来是关的，跑完验收就变成开的了）
    toggles0 = await ev(`window.api.getConfig().then((c) => c.markerToggles || null)`);
    const mapKey = await ev(`window.__view.detail.key`);
    console.log(`原标注: ${JSON.stringify(Object.keys(orig || {}))}（海关 ${countFor(orig, mapId)} 笔）`);
    check('已切到海关（后续都按这个地图 id 存取）', mapKey === 'customs' && Boolean(mapId), `key=${mapKey} mapId=${mapId}`);
    // 干净起点：清掉海关上的历史标注
    await ev(`(async () => { const all = await window.api.getAnnotations(); delete all[${JSON.stringify(mapId)}]; await window.api.setAnnotations(all); return true; })()`);
    // 渲染层手里那份也得清干净：它只在"打开这张图"时读一次，主进程里删掉不影响它，
    // 不清的话后面所有"几笔"的断言都会把用户原有的笔画一起算进去（计数飘忽的根源）。
    await ev(`(() => {
      if (window.__anno) window.__anno.store[${JSON.stringify(mapId)}] = [];
      window.__view.setAnnotations([]);
      return (window.__view.annos || []).length;
    })()`);
    await sleep(400);

    // 1) 工具条常驻顶栏（没有「标注」开关、没有那行说明、没有旧「完成」按钮）：点工具就进入标注
    let st0 = await ev(ANNO_STATE);
    check('工具条常驻顶栏（没有「标注」开关与「完成」按钮）',
      st0.barVisible && st0.barInTopbar && !st0.hasExitButton && !st0.hasAnnoToggle,
      JSON.stringify({ visible: st0.barVisible, inTopbar: st0.barInTopbar, exit: st0.hasExitButton, toggle: st0.hasAnnoToggle }));
    check('没有多余的提示行（用户要求删掉）', !st0.hasHint, `#anno-hint=${st0.hasHint}`);
    check('有「取消」按钮，且没进标注时是禁用的', st0.hasCancel && st0.cancelDisabled === true,
      JSON.stringify({ hasCancel: st0.hasCancel, disabled: st0.cancelDisabled }));
    check('一开始没有工具是选中的（地图还能拖）', !st0.active && st0.activeTools.length === 0, JSON.stringify(st0.activeTools));

    await ev(`window.__pickTool('pen')`);
    await sleep(400);
    let st = await ev(ANNO_STATE);
    check('点工具进入标注模式（「取消」同时变成可点）',
      st.active && st.tool === 'pen' && st.activeTools.includes('pen') && st.cancelDisabled === false,
      JSON.stringify({ active: st.active, tool: st.tool, tools: st.activeTools, cancelDisabled: st.cancelDisabled }));

    // 2) 拖动型工具（椭圆单独验：它必须是"对角拖拽 = 内接椭圆"）
    const tools = [['pen', 620, 420, 780, 520], ['line', 640, 560, 800, 600], ['arrow', 660, 640, 860, 700], ['ellipse', 700, 760, 800, 800]];
    for (const [tool, x1, y1, x2, y2] of tools) {
      await ev(`window.__pickTool(${JSON.stringify(tool)})`);
      await sleep(120);
      await ev(`window.__drawDrag(${x1}, ${y1}, ${x2}, ${y2})`);
      await sleep(160);
    }
    // 椭圆：拖出来的多边形包围盒要 ≈ 拖拽的那个矩形（QQ 截图那种内接椭圆）
    const ellBox = await ev(LAST_BBOX);
    check('椭圆 = 对角拖拽的外接矩形', Boolean(ellBox) && ellBox.tag === 'polygon' && ellBox.n === 32
      && Math.abs(ellBox.width - 100) < 4 && Math.abs(ellBox.height - 40) < 4,
      JSON.stringify(ellBox));
    // 按住 Shift：拖 200x40 -> 画出来必须是 200x200 的正圆
    await ev(`window.__pickTool('ellipse')`);
    await sleep(120);
    await ev(`window.__drawDrag(520, 660, 720, 700, 8, true)`);
    await sleep(200);
    const circleBox = await ev(LAST_BBOX);
    check('椭圆 + Shift = 正圆（包围盒宽高相等）',
      Boolean(circleBox) && circleBox.tag === 'polygon' && Math.abs(circleBox.width - circleBox.height) < 4 && Math.abs(circleBox.width - 200) < 6,
      JSON.stringify(circleBox));
    await ev(`window.__pickTool('rect')`);
    await sleep(120);
    await ev(`window.__drawDrag(820, 430, 940, 520)`);
    await sleep(160);

    // 3) 路径：三次点击 + 结束
    await ev(`window.__pickTool('path')`);
    await sleep(120);
    await ev(`window.__drawClick(620, 860)`);
    await ev(`window.__drawClick(760, 900)`);
    await ev(`window.__drawClick(900, 840)`);
    await sleep(150);
    const drafting = await ev(`(window.__view._annoDraft ? window.__view._annoDraft.pts.length : 0)`);
    await ev(`window.__view.finishPath()`);
    await sleep(200);
    st = await ev(ANNO_STATE);
    check('画笔/直线/箭头/椭圆/矩形/路径 都能落笔（7 笔）', st.annos === 7, `annos=${st.annos} 路径草稿点数=${drafting}`);
    check('标注图层画出了对应元素', st.dom === 7, `dom=${st.dom}`);
    check('图例里有「我的标注」且计数跟上、用内联小图', st.legend && st.legend.count === 7 && st.legend.swatch,
      JSON.stringify(st.legend));
    await shot('anno-drawn.png');

    // 4) 图例开关能隐藏/显示
    await ev(`(() => { const row = [...document.querySelectorAll('#legend-body .legend-item')].find((r) => r.querySelector('input').dataset.group === 'anno');
      row.querySelector('input').click(); return true; })()`);
    await sleep(400);
    const hidden = await ev(ANNO_STATE);
    check('图例里关掉「我的标注」-> 地图上隐藏', hidden.dom === 0 && hidden.annos === 7, `dom=${hidden.dom} annos=${hidden.annos}`);
    await ev(`(() => { const row = [...document.querySelectorAll('#legend-body .legend-item')].find((r) => r.querySelector('input').dataset.group === 'anno');
      row.querySelector('input').click(); return true; })()`);
    await sleep(400);
    const shown = await ev(ANNO_STATE);
    check('再打开 -> 恢复显示', shown.dom === 7, `dom=${shown.dom}`);

    // 5) 橡皮 + 撤销（橡皮要点在线上：直接取第一笔的屏幕中点，别靠猜坐标）
    await ev(`window.__pickTool('erase')`);
    await sleep(150);
    const hit = await ev(`(() => {
      const el = document.querySelector('.anno-layer .anno-item');
      if (!el) return null;
      const pts = (el.getAttribute('points') || '').split(' ').filter(Boolean).map((p) => p.split(',').map(Number));
      if (pts.length < 2) return null;
      const a = pts[0];
      const b = pts[pts.length - 1];
      const r = document.querySelector('.mapstage').getBoundingClientRect();
      return { x: r.left + (a[0] + b[0]) / 2, y: r.top + (a[1] + b[1]) / 2 };
    })()`);
    check('能取到第一笔的屏幕中点（橡皮要点的位置）', Boolean(hit), JSON.stringify(hit));
    await ev(`window.__drawClick(${hit.x}, ${hit.y})`);
    await sleep(300);
    const erased = await ev(ANNO_STATE);
    check('橡皮点一下能删掉一笔', erased.annos === 6, `annos=${erased.annos}`);
    await ev(`window.__view.undoAnno()`);
    await sleep(300);
    const undone = await ev(ANNO_STATE);
    check('撤销再少一笔', undone.annos === 5, `annos=${undone.annos}`);

    // 6) 持久化（防抖 600ms + 主进程 500ms）
    await sleep(1500);
    const savedAll = await ev('window.api.getAnnotations()');
    check('标注已写入文件（重启后仍在）', countFor(savedAll, mapId) === 5, `保存了 ${countFor(savedAll, mapId)} 笔`);

    // 7) 换图不串味 + 换回来还在
    await ev(`window.api.selectMap({ key: 'factory' })`);
    await sleep(1600);
    const other = await ev(ANNO_STATE);
    check('换到别的图看不到这张图的标注', other.annos === 0 && other.dom === 0, JSON.stringify({ annos: other.annos, dom: other.dom }));
    await ev(`window.api.selectMap({ key: 'customs' })`);
    await sleep(1600);
    const back = await ev(ANNO_STATE);
    check('切回海关标注还在', back.annos === 5 && back.dom === 5, JSON.stringify({ annos: back.annos, dom: back.dom }));

    // 8) 重载页面（真持久化，不靠内存）
    await ev('location.reload()');
    await sleep(3500);
    await ev(`(async () => { for (let i = 0; i < 60; i++) {
      if (window.__view && window.__view.detail && window.api) return true;
      await new Promise((r) => setTimeout(r, 200));
    } return false; })()`);
    await ev(`window.api.selectMap({ key: 'customs' })`);
    await sleep(1600);
    const afterReload = await ev(ANNO_STATE);
    check('重载页面后标注仍在（从文件读回）', afterReload.annos === 5, `annos=${afterReload.annos}`);

    // 9) 清空只清当前图
    await ev(`window.__view.clearAnnos()`);
    await sleep(1200);
    const clearedAll = await ev('window.api.getAnnotations()');
    check('清空后本图没标注了（其它图不受影响）', countFor(clearedAll, mapId) === 0, `本图 ${countFor(clearedAll, mapId)} 笔 / 键=${Object.keys(clearedAll).join(',')}`);

    // 10) 退出标注：点「取消」（等价于 Esc / 再点一次当前工具），工具条照旧常驻
    await ev(`document.querySelector('#anno-cancel').click()`);
    await sleep(300);
    const exited = await ev(ANNO_STATE);
    check('点「取消」退出标注（工具条常驻、按钮回到禁用、地图恢复拖动）',
      !exited.active && exited.barVisible && exited.activeTools.length === 0 && exited.cancelDisabled === true,
      JSON.stringify({ active: exited.active, visible: exited.barVisible, tools: exited.activeTools, cancelDisabled: exited.cancelDisabled }));
    // 再点一次当前工具也等于退出
    await ev(`window.__pickTool('pen')`);
    await sleep(200);
    await ev(`window.__exitAnno()`);
    await sleep(300);
    const toggleExit = await ev(ANNO_STATE);
    check('再点同一个工具也能退出标注', !toggleExit.active, JSON.stringify({ active: toggleExit.active }));
    // 顺手验一下 Esc 也能退出
    await ev(`window.__pickTool('rect')`);
    await sleep(200);
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    const escExited = await ev(ANNO_STATE);
    check('Esc 也能退出标注', !escExited.active, JSON.stringify({ active: escExited.active }));
    await ev(`window.__exitAnno()`).catch(() => {});
  } finally {
    await sleep(800);
    await ev(`window.api.setAnnotations(${JSON.stringify(orig || {})})`).catch(() => {});
    // 图例开关还原（验收期间点过「我的标注」那一行）
    if (toggles0) await ev(`window.api.setConfig({ markerToggles: ${JSON.stringify(toggles0)} })`).catch(() => {});
    await sleep(900);
    const restored = await ev('window.api.getAnnotations()').catch(() => ({}));
    // 还原成功就把磁盘备份删掉（还原失败/超时则留着，下次跑脚本会自动救回来）
    const okRestore = JSON.stringify(restored) === JSON.stringify(orig);
    if (okRestore) { try { fs.unlinkSync(ANNO_BACKUP); } catch {} }
    else console.log(`      ⚠ 标注没还原到位，备份留在 ${ANNO_BACKUP}（下次跑本脚本会自动还原）`);
    console.log(`      （已恢复原标注：本图 ${countFor(restored, mapId)} 笔；备份${okRestore ? '已删除' : '保留'}）`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('；'));
    process.exit(1);
  }
})().catch((e) => {
  console.error('验收失败：', e.message);
  process.exit(2);
});
