#!/usr/bin/env node
/**
 * 雷达（圆形小地图）与主地图"图上一致"的验收。
 *
 * 验证两件事：
 *   1) 主窗口**勾选的任务点**（区域多边形 / 物品刷新点）在雷达上也要画出来 ——
 *      同一份 quests-dump、同一份勾选状态，`view.questItems` 两边完全一致，
 *      并且把雷达视野移到该任务上时 DOM 里真的出现 `.quest-layer` 图形。
 *   2) 雷达上的字不会"整体消失"：上限裁剪与"给谁写名字"都按"重要度 + 离圆心距离"挑，
 *      30 个撤离点同时在场也必须标出（而不是一个名字都不写）。
 *
 * 全程用 CDP 合成事件 + 读 DOM（**不碰系统光标、不注入任何输入**），只在雷达/主窗口里跑 JS。
 *
 * 用法:
 *   npx electron . --remote-debugging-port=9222
 *   node tools/verify-mini-quest.js [--port=9222]
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
  const quests0 = cfg0.quests || null;
  const toggles0 = cfg0.markerToggles || null;
  const miniWasOn = await mapEval('window.api.miniStatus().then((s) => !!(s && s.enabled))');

  let mapId = null;
  let checkedId = null;
  let miniEval = async () => null;

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

  const radarQuestDom = () => miniEval(`({
    items: (window.__view.questItems || []).length,
    polys: document.querySelectorAll('.quest-layer polygon').length,
    dots: document.querySelectorAll('.quest-layer .quest-dot').length,
    spots: document.querySelectorAll('.quest-layer .quest-spot').length,
  })`);

  /** 按任务名筛选任务栏 -> 点那一行的勾选框（和玩家自己勾选走同一条路） */
  const toggleTask = (id, name, on) => mapEval(`(async () => {
    const box = document.querySelector('#quest-q');
    box.value = ${JSON.stringify(name)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const row = document.querySelector('#quest-list .quest-row[data-task-id=' + JSON.stringify(${JSON.stringify(id)}) + ']');
    if (!row) return { row: false };
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb.checked !== ${on ? 'true' : 'false'}) cb.click();
    await new Promise((r) => setTimeout(r, 900));
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return { row: true, checked: cb.checked, items: (window.__view.questItems || []).length };
  })()`);

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

    // 等渲染层初始化完成再操作：地图下拉被填充 = init() 已经走到注册 onState 之后，
    // 否则此刻 selectMap 的广播会赶在监听器注册之前发出，直接被丢掉（踩过）。
    let pageReady = false;
    for (let i = 0; i < 60; i++) {
      pageReady = await mapEval(`!!(document.querySelector('#map-select') && document.querySelector('#map-select').options.length > 1 && window.__quest && window.__view)`);
      if (pageReady === true) break;
      await sleep(250);
    }
    check('渲染层初始化完成（地图下拉已填充 / __view 与任务库就位）', pageReady === true, String(pageReady));

    // 切到海关（任务多、区域密），拿本图"有地点"的任务候选
    await mapEval(`window.api.selectMap({ key: 'customs' })`);
    await sleep(1600);
    mapId = await mapEval('window.__view && window.__view.detail ? window.__view.detail.id : null');
    check('已切到海关', !!mapId, String(mapId));

    const candidates = await mapEval(`(() => {
      const v = window.__view, q = window.__quest;
      const mapId = v.detail.id;
      const out = [];
      for (const t of (q.dump && q.dump.tasks) || []) {
        let zones = 0, spots = 0;
        for (const o of t.objectives || []) {
          for (const z of o.zones || []) if (!z.map || z.map === mapId) zones++;
          for (const s of o.spots || []) if (!s.map || s.map === mapId) spots++;
        }
        if (zones || spots) out.push({ id: t.id, name: t.name, zones, spots });
        if (out.length >= 25) break;
      }
      return out;
    })()`);
    check('本图能找到"有地点"的任务候选', Array.isArray(candidates) && candidates.length > 0,
      Array.isArray(candidates) ? `${candidates.length} 个候选` : String(candidates));

    // 勾选一个候选，直到主窗口真的画出任务标记（击杀类默认不画，所以可能要试几个）
    let picked = null;
    for (const cand of (candidates || []).slice(0, 8)) {
      const r = await toggleTask(cand.id, cand.name, true);
      if (r && r.row && r.items >= 1) { picked = cand; checkedId = cand.id; break; }
      if (r && r.row) await toggleTask(cand.id, cand.name, false);
    }
    check('勾选的任务在主窗口画出了标记', !!picked, picked ? `${picked.name}（区域 ${picked.zones} / 刷新点 ${picked.spots}）` : '试了 8 个候选都不画（可能是击杀类区域：默认不画刷怪区）');
    if (!picked) throw new Error('主窗口没画出任务标记，后面的比对没法做');

    const mainSide = await mapEval(`({
      items: (window.__view.questItems || []).length,
      polys: document.querySelectorAll('.quest-layer polygon').length,
      dots: document.querySelectorAll('.quest-layer .quest-dot').length,
      spots: document.querySelectorAll('.quest-layer .quest-spot').length,
    })`);

    // 1) 数据一致：两边算出的是同一批任务（同一份勾选、同一份 dump）
    const radarItems = await wait(async () => {
      const d = await radarQuestDom();
      return d && d.items >= 1 ? d : null;
    }, 8000);
    check('雷达拿到了同一批勾选任务（questItems 与主窗口一致）',
      !!radarItems && radarItems.items === mainSide.items,
      `主窗口 items=${mainSide.items} / 雷达 items=${radarItems ? radarItems.items : '?'}`);

    // 2) 真的画出来了：把雷达视野移到该任务上（没有定位时雷达默认看地图中心，任务可能在圆盘外）
    const radarDom = await miniEval(`(async () => {
      const v = window.__view;
      const it = (v.questItems || [])[0];
      if (!it) return { polys: 0, dots: 0, spots: 0, centered: false };
      const z = (it.zones || [])[0] || null;
      const sp = (it.spots || [])[0] || null;
      const at = z ? { x: z.x, z: z.z } : { x: sp.x, z: sp.z };
      const p = v.proj.project(at.x, at.z);
      v.setViewport({ cx: p.x, cy: p.y, scale: 1.2, rot: 0 });
      return {
        centered: true,
        polys: document.querySelectorAll('.quest-layer polygon').length,
        dots: document.querySelectorAll('.quest-layer .quest-dot').length,
        spots: document.querySelectorAll('.quest-layer .quest-spot').length,
      };
    })()`);
    check('雷达圆盘内真的画出了任务区域/刷新点',
      !!radarDom && radarDom.centered && (radarDom.polys + radarDom.dots + radarDom.spots) >= 1,
      JSON.stringify(radarDom));

    // 3) 图例开关两边共用：关掉「任务区域」-> 雷达上的多边形也消失
    await mapEval(`(() => { const row = [...document.querySelectorAll('#legend-body .legend-item')].find((r) => r.querySelector('input').dataset.group === 'quest:zone'); row.querySelector('input').click(); return true; })()`);
    const zoneOff = await wait(async () => {
      const d = await radarQuestDom();
      return d && d.polys === 0 ? d : null;
    }, 6000);
    check('图例里关掉「任务区域」-> 雷达上的多边形一起消失', !!zoneOff && zoneOff.polys === 0, JSON.stringify(zoneOff));
    await mapEval(`(() => { const row = [...document.querySelectorAll('#legend-body .legend-item')].find((r) => r.querySelector('input').dataset.group === 'quest:zone'); row.querySelector('input').click(); return true; })()`);
    await sleep(600);

    // 4) 回归：雷达上的字不会"整体消失"（旧实现在关键标记 >6 个时一个名字都不写）
    const pure = await miniEval(`(async () => {
      const mod = await import('./common/map-view.js');
      const many = Array.from({ length: 30 }, (_, i) => ({ group: 'extract_pmc', _miniD: i }));
      const labeled = mod.pickMiniLabeled(many, 6);
      const mix = [{ group: 'label', _miniD: 1 }];
      for (let i = 0; i < 100; i++) mix.push({ group: 'loot:crate', _miniD: i });
      const kept = mod.trimMiniMarkers(mix, 10);
      return {
        labeled: labeled.size,
        nearest: labeled.has(many[0]) && !labeled.has(many[29]),
        keepsLabel: kept.some((m) => m.group === 'label'),
        rankOk: mod.miniMarkerRank('extract_pmc') < mod.miniMarkerRank('label'),
      };
    })()`);
    check('雷达标名：30 个撤离点同时在场也标出最近的 6 个（不再一个都不标）',
      !!pure && pure.labeled === 6 && pure.nearest === true, JSON.stringify(pure));
    check('雷达降噪：密集区里地名不再被"整类丢掉"', !!pure && pure.keepsLabel === true, JSON.stringify(pure));

    // 5) 截图留证
    try {
      fs.mkdirSync(ART, { recursive: true });
      const data = await cdp(miniTarget.webSocketDebuggerUrl, [['Page.captureScreenshot', { format: 'png' }]], 8000);
      if (typeof data[0] === 'string') fs.writeFileSync(path.join(ART, 'mini-quest-on.png'), Buffer.from(data[0], 'base64'));
      console.log(`      截图：${path.join(ART, 'mini-quest-on.png')}`);
    } catch (e) {
      console.log(`      （雷达截图跳过：${e.message}）`);
    }
  } finally {
    await sleep(400);
    // 取消勾选（走 UI，免得只改了配置、界面还留着勾）
    if (checkedId) {
      const name = await mapEval(`(() => { const t = (window.__quest.dump.tasks || []).find((x) => x.id === ${JSON.stringify(checkedId)}); return t ? t.name : ''; })()`);
      if (name) await toggleTask(checkedId, name, false).catch(() => {});
    }
    await mapEval(`window.api.setConfig({ quests: ${JSON.stringify(quests0 || {})} })`).catch(() => {});
    if (toggles0) await mapEval(`window.api.setConfig({ markerToggles: ${JSON.stringify(toggles0)} })`).catch(() => {});
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
