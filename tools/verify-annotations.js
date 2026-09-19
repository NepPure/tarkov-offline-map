#!/usr/bin/env node
/**
 * 手动标注（画笔/路径/箭头/圆/矩形/橡皮）验收。
 *
 * 全程用 CDP 合成鼠标事件（不碰系统光标），画在海关上：
 *   1) 顶栏「标注」开关 -> 工具条出现
 *   2) 五种拖动型工具 + 路径（点击加点）都能落笔
 *   3) 图例里有「我的标注」，能一键隐藏/显示，计数跟着走
 *   4) 橡皮点掉一笔、撤销一笔
 *   5) 防抖落盘 -> api.getAnnotations() 里有数据
 *   6) 换图不串味；换回来还在；重载页面后仍在（真持久化）
 *   7) 结束前把标注文件恢复原样
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

function cdp(wsUrl, calls) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const results = [];
    ws.onopen = async () => {
      for (const [method, params] of calls) {
        const myId = ++id;
        const p = new Promise((res) => pending.set(myId, res));
        ws.send(JSON.stringify({ id: myId, method, params }));
        results.push(await p);
      }
      ws.close();
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
    ws.onerror = (e) => reject(new Error('ws error ' + (e.message || '')));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    };
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** 页面里注入的合成绘制助手（mousedown 打在地图舞台上，move/up 打在 window 上，跟真实操作一致） */
const HELPERS = `(() => {
  const stage = () => document.querySelector('.mapstage');
  window.__drawDrag = (x1, y1, x2, y2, steps = 8) => {
    stage().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x1, clientY: y1, button: 0 }));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x1 + (x2 - x1) * t, clientY: y1 + (y2 - y1) * t }));
    }
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x2, clientY: y2, button: 0 }));
    return true;
  };
  window.__drawClick = (x, y) => {
    stage().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    return true;
  };
  window.__pickTool = (tool) => { document.querySelector('.anno-tool[data-tool="' + tool + '"]').click(); return true; };
  return true;
})()`;

const ANNO_STATE = `(() => {
  const v = window.__view;
  return {
    active: Boolean(v.drawMode),
    tool: v.drawMode ? v.drawMode.tool : null,
    color: v.drawMode ? v.drawMode.color : null,
    width: v.drawMode ? v.drawMode.width : null,
    annos: (v.annos || []).length,
    dom: document.querySelectorAll('.anno-layer .anno-item, .anno-layer .anno-draft').length,
    barHidden: document.querySelector('#anno-bar').classList.contains('hidden'),
    legend: (() => {
      const row = [...document.querySelectorAll('#legend-body .legend-item')].find((r) => r.querySelector('input').dataset.group === 'anno');
      return row ? { count: Number(row.querySelector('.legend-count').textContent), checked: row.querySelector('input').checked, swatch: !!row.querySelector('svg.legend-swatch') } : null;
    })(),
  };
})()`;

(async () => {
  const list = await targets();
  const mapTarget = list.find((t) => t.url.endsWith('/map.html'));
  if (!mapTarget) throw new Error('未找到主窗口（用 --remote-debugging-port 启动了吗？）');
  const ws = mapTarget.webSocketDebuggerUrl;
  const ev = (expr) => cdp(ws, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]).then((r) => r[0]);
  const shot = async (file) => {
    const data = await cdp(ws, [['Page.captureScreenshot', { format: 'png' }]]);
    if (typeof data[0] === 'string') {
      fs.mkdirSync(ART, { recursive: true });
      fs.writeFileSync(path.join(ART, file), Buffer.from(data[0], 'base64'));
      console.log(`      截图 -> test-artifacts/${file}`);
    }
  };

  const orig = await ev('window.api.getAnnotations()');
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

    // 1) 打开标注
    await ev(`document.querySelector('#btn-anno').click()`);
    await sleep(400);
    let st = await ev(ANNO_STATE);
    check('点顶栏「标注」出现工具条并进入标注模式', st.active && !st.barHidden, JSON.stringify({ active: st.active, hidden: st.barHidden, tool: st.tool }));

    // 2) 五种拖动型工具
    const tools = [['pen', 620, 420, 780, 520], ['line', 640, 560, 800, 600], ['arrow', 660, 640, 860, 700], ['circle', 700, 760, 780, 760], ['rect', 820, 430, 940, 520]];
    for (const [tool, x1, y1, x2, y2] of tools) {
      await ev(`window.__pickTool(${JSON.stringify(tool)})`);
      await sleep(120);
      await ev(`window.__drawDrag(${x1}, ${y1}, ${x2}, ${y2})`);
      await sleep(160);
    }
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
    check('画笔/直线/箭头/圆/矩形/路径 都能落笔（6 笔）', st.annos === 6, `annos=${st.annos} 路径草稿点数=${drafting}`);
    check('标注图层画出了对应元素', st.dom === 6, `dom=${st.dom}`);
    check('图例里有「我的标注」且计数跟上、用内联小图', st.legend && st.legend.count === 6 && st.legend.swatch,
      JSON.stringify(st.legend));
    await shot('anno-drawn.png');

    // 4) 图例开关能隐藏/显示
    await ev(`(() => { const row = [...document.querySelectorAll('#legend-body .legend-item')].find((r) => r.querySelector('input').dataset.group === 'anno');
      row.querySelector('input').click(); return true; })()`);
    await sleep(400);
    const hidden = await ev(ANNO_STATE);
    check('图例里关掉「我的标注」-> 地图上隐藏', hidden.dom === 0 && hidden.annos === 6, `dom=${hidden.dom} annos=${hidden.annos}`);
    await ev(`(() => { const row = [...document.querySelectorAll('#legend-body .legend-item')].find((r) => r.querySelector('input').dataset.group === 'anno');
      row.querySelector('input').click(); return true; })()`);
    await sleep(400);
    const shown = await ev(ANNO_STATE);
    check('再打开 -> 恢复显示', shown.dom === 6, `dom=${shown.dom}`);

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
    check('橡皮点一下能删掉一笔', erased.annos === 5, `annos=${erased.annos}`);
    await ev(`window.__view.undoAnno()`);
    await sleep(300);
    const undone = await ev(ANNO_STATE);
    check('撤销再少一笔', undone.annos === 4, `annos=${undone.annos}`);

    // 6) 持久化（防抖 600ms + 主进程 500ms）
    await sleep(1500);
    const savedAll = await ev('window.api.getAnnotations()');
    check('标注已写入文件（重启后仍在）', countFor(savedAll, mapId) === 4, `保存了 ${countFor(savedAll, mapId)} 笔`);

    // 7) 换图不串味 + 换回来还在
    await ev(`window.api.selectMap({ key: 'factory' })`);
    await sleep(1600);
    const other = await ev(ANNO_STATE);
    check('换到别的图看不到这张图的标注', other.annos === 0 && other.dom === 0, JSON.stringify({ annos: other.annos, dom: other.dom }));
    await ev(`window.api.selectMap({ key: 'customs' })`);
    await sleep(1600);
    const back = await ev(ANNO_STATE);
    check('切回海关标注还在', back.annos === 4 && back.dom === 4, JSON.stringify({ annos: back.annos, dom: back.dom }));

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
    check('重载页面后标注仍在（从文件读回）', afterReload.annos === 4, `annos=${afterReload.annos}`);

    // 9) 清空只清当前图
    await ev(`window.__view.clearAnnos()`);
    await sleep(1200);
    const clearedAll = await ev('window.api.getAnnotations()');
    check('清空后本图没标注了（其它图不受影响）', countFor(clearedAll, mapId) === 0, `本图 ${countFor(clearedAll, mapId)} 笔 / 键=${Object.keys(clearedAll).join(',')}`);

    // 10) 退出标注模式
    await ev(`document.querySelector('#anno-exit').click()`);
    await sleep(300);
    const exited = await ev(ANNO_STATE);
    check('点「完成」退出标注（工具条收起、恢复拖地图）', !exited.active && exited.barHidden, JSON.stringify({ active: exited.active, hidden: exited.barHidden }));
  } finally {
    await sleep(800);
    await ev(`window.api.setAnnotations(${JSON.stringify(orig || {})})`).catch(() => {});
    // 图例开关还原（验收期间点过「我的标注」那一行）
    if (toggles0) await ev(`window.api.setConfig({ markerToggles: ${JSON.stringify(toggles0)} })`).catch(() => {});
    await sleep(900);
    const restored = await ev('window.api.getAnnotations()').catch(() => ({}));
    console.log(`      （已恢复原标注：本图 ${countFor(restored, mapId)} 笔）`);
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
