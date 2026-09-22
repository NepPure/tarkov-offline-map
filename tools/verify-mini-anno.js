#!/usr/bin/env node
/**
 * 雷达（圆形小地图）上显示标注的验收。
 *
 * 验证三档配置（默认"我的 + 队友的"）+ 与图例开关的联动：
 *   1) 主窗口画一笔 -> 雷达上立刻出现（默认 miniAnnos = all）
 *   2) miniAnnos = off  -> 雷达上标注消失
 *   3) miniAnnos = mine -> 自己的标注又出现
 *   4) 图例里关掉「我的标注」-> 主窗口与雷达一起隐藏（两个窗口共用图例开关）
 *   5) 收尾：标注与配置原样写回
 *
 * 全程用 CDP 合成鼠标事件（不碰系统光标），标注画在海关上。
 *
 * 用法:
 *   npx electron . --remote-debugging-port=9222
 *   node tools/verify-mini-anno.js [--port=9222]
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

/** 一次 CDP 调用（带超时：窗口被遮挡时截图会卡住，至少要让 finally 跑得到） */
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

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const list = await targets();
  const mapTarget = list.find((t) => t.url.endsWith('/map.html'));
  if (!mapTarget) throw new Error('未找到主窗口（用 --remote-debugging-port 启动了吗？）');
  const mapEval = (expr) => cdp(mapTarget.webSocketDebuggerUrl, [
    ['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }],
  ]).then((r) => r[0]);

  const miniTargetOf = async () => {
    const l = await targets();
    return l.find((t) => t.url.endsWith('/minimap.html')) || null;
  };
  let miniTarget = await miniTargetOf();

  const cfg0 = await mapEval('window.api.getConfig()');
  if (!cfg0) throw new Error('拿不到配置');
  const toggles0 = cfg0.markerToggles || null;
  const origAnnos = await mapEval('window.api.getAnnotations()');
  const miniWasOn = await mapEval('window.api.miniStatus().then((s) => !!(s && s.enabled))');

  let mapId = null;
  let miniEval = async () => null;

  const radarDom = async () => miniEval(`({
    items: document.querySelectorAll('.anno-layer .anno-item').length,
    peers: document.querySelectorAll('.anno-layer .peer-anno').length,
    draft: document.querySelectorAll('.anno-layer .anno-draft').length,
  })`);

  const wait = async (fn, ms = 6000, step = 250) => {
    const until = Date.now() + ms;
    let last = null;
    while (Date.now() < until) {
      last = await fn();
      if (last) return last;
      await sleep(step);
    }
    return last;
  };

  try {
    // 雷达没开就先开（临时），并等窗口出来
    if (!miniWasOn) {
      await mapEval('window.api.setConfig({ miniVisible: true })');
      miniTarget = await wait(() => miniTargetOf(), 8000, 300);
    }
    check('小地图雷达窗口存在', !!miniTarget, miniTarget ? miniTarget.url : '没找到 minimap.html（设置里开一下"小地图雷达"）');
    if (!miniTarget) throw new Error('没有雷达窗口，后面的断言没法做');
    miniEval = (expr) => cdp(miniTarget.webSocketDebuggerUrl, [
      ['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }],
    ]).then((r) => r[0]);

    // 切到海关并清掉本图标注（结束会还原）
    await mapEval(`window.api.selectMap({ key: 'customs' })`);
    await sleep(1600);
    mapId = await mapEval('window.__view && window.__view.detail ? window.__view.detail.id : null');
    check('已切到海关', !!mapId, String(mapId));
    await mapEval(`(async () => { const all = await window.api.getAnnotations(); delete all[${JSON.stringify(mapId)}]; await window.api.setAnnotations(all); return true; })()`);
    await mapEval(`window.api.setConfig({ miniAnnos: 'all' })`);
    await sleep(1200);

    // 1) 主窗口画一笔 -> 雷达（默认 all）要跟着出现
    const drawn = await mapEval(`(() => {
      document.querySelector('.anno-tool[data-tool="pen"]').click();
      const stage = document.querySelector('.mapstage');
      const r = stage.getBoundingClientRect();
      const x1 = r.left + r.width * 0.32, y1 = r.top + r.height * 0.35;
      const x2 = r.left + r.width * 0.52, y2 = r.top + r.height * 0.5;
      stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x1, clientY: y1, button: 0 }));
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x1 + (x2 - x1) * t, clientY: y1 + (y2 - y1) * t }));
      }
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x2, clientY: y2, button: 0 }));
      document.querySelector('.anno-tool[data-tool="pen"]').click(); // 退出标注
      const list = window.__view.annos;
      return { count: list.length, mapDom: document.querySelectorAll('.anno-layer .anno-item').length };
    })()`);
    check('主窗口画上了一笔', !!drawn && drawn.count >= 1 && drawn.mapDom >= 1, JSON.stringify(drawn));

    const shown = await wait(async () => {
      const d = await radarDom();
      return d && d.items >= 1 ? d : null;
    }, 8000);
    check('雷达上出现了这一笔（默认"我的 + 队友的"）', !!shown && shown.items >= 1, JSON.stringify(shown));
    try {
      fs.mkdirSync(ART, { recursive: true });
      const data = await cdp(miniTarget.webSocketDebuggerUrl, [['Page.captureScreenshot', { format: 'png' }]], 8000);
      if (typeof data[0] === 'string') fs.writeFileSync(path.join(ART, 'mini-anno-on.png'), Buffer.from(data[0], 'base64'));
    } catch (e) {
      console.log(`      （雷达截图跳过：${e.message}）`);
    }

    // 2) 关掉（off）-> 雷达上不该有标注
    await mapEval(`window.api.setConfig({ miniAnnos: 'off' })`);
    const off = await wait(async () => {
      const d = await radarDom();
      return d && d.items === 0 && d.peers === 0 ? d : null;
    }, 6000);
    check('设成「不显示」-> 雷达上的标注消失', !!off && off.items === 0, JSON.stringify(off));

    // 3) 只显示我的（mine）-> 又出现
    await mapEval(`window.api.setConfig({ miniAnnos: 'mine' })`);
    const mine = await wait(async () => {
      const d = await radarDom();
      return d && d.items >= 1 ? d : null;
    }, 6000);
    check('设成「只显示我的」-> 我的标注回来', !!mine && mine.items >= 1, JSON.stringify(mine));

    // 4) 图例开关两个窗口共用：关掉「我的标注」-> 雷达同步消失
    await mapEval(`window.api.setConfig({ miniAnnos: 'all' })`);
    await sleep(600);
    await mapEval(`(() => { const row = [...document.querySelectorAll('#legend-body .legend-item')].find((r) => r.querySelector('input').dataset.group === 'anno'); row.querySelector('input').click(); return true; })()`);
    const legendOff = await wait(async () => {
      const d = await radarDom();
      return d && d.items === 0 ? d : null;
    }, 6000);
    check('图例里关掉「我的标注」-> 雷达也一起隐藏', !!legendOff && legendOff.items === 0, JSON.stringify(legendOff));
    await mapEval(`(() => { const row = [...document.querySelectorAll('#legend-body .legend-item')].find((r) => r.querySelector('input').dataset.group === 'anno'); row.querySelector('input').click(); return true; })()`);
    const legendOn = await wait(async () => {
      const d = await radarDom();
      return d && d.items >= 1 ? d : null;
    }, 6000);
    check('再把图例打开 -> 雷达上又出现', !!legendOn && legendOn.items >= 1, JSON.stringify(legendOn));
  } finally {
    await sleep(600);
    await mapEval(`window.api.setAnnotations(${JSON.stringify(origAnnos || {})})`).catch(() => {});
    if (toggles0) await mapEval(`window.api.setConfig({ markerToggles: ${JSON.stringify(toggles0)} })`).catch(() => {});
    await mapEval(`window.api.setConfig({ miniAnnos: ${JSON.stringify(cfg0.miniAnnos || 'all')} })`).catch(() => {});
    if (!miniWasOn) await mapEval('window.api.setConfig({ miniVisible: false })').catch(() => {});
    await sleep(1000);
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
