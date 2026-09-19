#!/usr/bin/env node
/**
 * 任务侧边栏验收（CDP 合成事件 + DOM 断言，全程不动系统鼠标/键盘）。
 *
 * 覆盖：
 *   1) 数据加载：任务库规模、中文商人下拉
 *   2) 列表：按"商人 -> 阶段"分组（阶段顺序必须递增），行数受筛选影响
 *   3) 搜索：任务名命中、目标文字命中（"医疗"这类只出现在目标描述里的词）
 *   4) 勾选 -> 地图图层真的画出来了（polygon/中心点/刷新点），取消勾选后清掉
 *   5) 勾选写进配置（长期保留），楼层切换不炸
 *   6) 结束前把配置原样写回，并截屏到 test-artifacts/
 *
 * 用法:
 *   npx electron . --remote-debugging-port=9222
 *   node tools/verify-quests.js [--port=9222]
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

(async () => {
  const list = await targets();
  const mapTarget = list.find((t) => t.url.endsWith('/map.html'));
  if (!mapTarget) throw new Error('未找到主窗口（用 --remote-debugging-port 启动了吗？）');
  const wsUrl = mapTarget.webSocketDebuggerUrl;
  const ev = (expr) => cdp(wsUrl, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]).then((r) => r[0]);
  const shot = async (file) => {
    const data = await cdp(wsUrl, [['Page.captureScreenshot', { format: 'png' }]]);
    if (typeof data[0] === 'string') {
      fs.mkdirSync(ART, { recursive: true });
      fs.writeFileSync(path.join(ART, file), Buffer.from(data[0], 'base64'));
      console.log(`      截图 -> test-artifacts/${file}`);
    }
  };

  const cfg0 = await ev('window.api.getConfig()');
  const questCfg0 = cfg0 && cfg0.quests ? cfg0.quests : null;
  console.log(`原配置: quests.checked=${questCfg0 ? (questCfg0.checked || []).length : 'null'} 个`);

  let checkedId = null;
  let origMap = null;
  let toggles0 = null;
  try {
    // 先重载一次：保证跑的是磁盘上的当前代码（改完渲染层不用重启应用）
    await ev('location.reload()');
    await sleep(3500);
    const loaded = await ev(`(async () => {
      for (let i = 0; i < 60; i++) {
        if (window.__quest && window.__quest.dump && window.__view && window.__view.detail) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    })()`);
    if (!loaded) console.log('      警告：重载后等待初始化超时，继续跑（可能会失败）');
    // 验收过程会切来切去，先记下当前地图，结束时还原
    origMap = await ev(`window.__view && window.__view.detail ? window.__view.detail.key : null`);

    // 抓运行时报错（我改动的代码一旦抛异常，这里能看到）
    await ev(`(() => { if (!window.__errs) { window.__errs = []; const oe = console.error;
      console.error = (...a) => { try { window.__errs.push(a.map((x) => (x && x.message) || String(x)).join(' ')); } catch {} oe(...a); }; } return true; })()`);

    // 先归零：验收自己从"干净状态"开始（否则上一次运行留下的勾选会让断言翻车）
    await ev(`(() => {
      window.__quest.checked.clear();
      const c = document.querySelector('#qc-checked'); c.click(); c.click();
      return window.__quest.checked.size;
    })()`);
    await sleep(700); // 等渲染层的防抖保存落盘

    // ---------- 1) 数据加载 ----------
    const ready = await ev(`(async () => {
      const q = window.__quest;
      for (let i = 0; i < 60 && !(q && q.dump); i++) await new Promise((r) => setTimeout(r, 200));
      return q && q.dump ? { tasks: q.dump.tasks.length, traders: q.dump.traders.length, maps: Object.keys(q.dump.maps).length } : null;
    })()`);
    check('任务库加载成功', ready && ready.tasks > 400, JSON.stringify(ready));

    const traderOpts = await ev(`document.querySelectorAll('#quest-trader option').length`);
    check('商人下拉有选项', traderOpts >= 10, `${traderOpts} 个`);

    // ---------- 2) 先切一张地图，让"本图"筛选有依据 ----------
    await ev(`window.api.selectMap({ key: 'customs' })`);
    await sleep(1500);
    const mapOk = await ev(`(() => { const v = window.__view; return v && v.detail ? { key: v.detail.key, id: v.detail.id } : null; })()`);
    check('已切到海关（手动选图）', mapOk && mapOk.key === 'customs', JSON.stringify(mapOk));

    // ---------- 3) 分组：商人 -> 阶段 ----------
    const groups = await ev(`(() => {
      return [...document.querySelectorAll('#quest-list .quest-trader-group')].map((sec) => ({
        trader: sec.querySelector('.quest-trader-name').textContent,
        en: sec.querySelector('.quest-trader-en').textContent,
        count: sec.querySelector('.quest-trader-count').textContent,
        stages: [...sec.querySelectorAll('.quest-stage-head')].map((h) => h.children[1].textContent),
        rows: sec.querySelectorAll('.quest-row').length,
      }));
    })()`);
    check('列表按商人分组渲染', Array.isArray(groups) && groups.length >= 2, `${groups ? groups.length : 0} 个商人大组`);
    check('每个商人大组都有阶段小节', groups && groups.every((g) => g.stages.length >= 1),
      groups ? groups.slice(0, 3).map((g) => `${g.trader}[${g.stages.join(',')}]`).join(' ') : '');
    const ORDER = ['起始', '前期', '中期', '后期', '终局'];
    const badOrder = (groups || []).filter((g) => g.stages.map((s) => ORDER.indexOf(s)).some((i, k, arr) => i < 0 || (k && i < arr[k - 1])));
    check('阶段顺序递增（起始->前期->中期->后期->终局）', badOrder.length === 0,
      badOrder.length ? badOrder.map((g) => `${g.trader}:${g.stages.join('/')}`).join(' ') : '');

    // ---------- 4) 搜索（任务名 / 目标文字） ----------
    const before = await ev(`document.querySelectorAll('#quest-list .quest-row').length`);
    await ev(`(() => { const el = document.querySelector('#quest-q'); el.value = '医疗'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(500);
    const search = await ev(`(() => {
      const q = window.__quest;
      const ids = [...document.querySelectorAll('#quest-list .quest-row')].map((r) => r.dataset.taskId);
      const bad = ids.filter((id) => {
        const t = q.dump.tasks.find((x) => x.id === id);
        if (!t) return true;
        return !(String(t.name).includes('医疗') || (t.objectives || []).some((o) => String(o.text || '').includes('医疗')));
      });
      return { rows: ids.length, bad: bad.length, sample: ids.slice(0, 3) };
    })()`);
    check('搜索"医疗"命中的行确实都含关键词（含只出现在目标描述里的）',
      search && search.rows >= 1 && search.bad === 0, JSON.stringify(search));
    check('搜索收窄了列表', search && search.rows < before, `${before} -> ${search ? search.rows : '?'}`);

    await ev(`(() => { const el = document.querySelector('#quest-q'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(500);
    const cleared = await ev(`document.querySelectorAll('#quest-list .quest-row').length`);
    check('清空搜索后列表恢复', cleared === before, `${cleared} vs ${before}`);

    // ---------- 5) 勾选 -> 地图图层 ----------
    checkedId = await ev(`(() => {
      const row = document.querySelector('#quest-list .quest-row');
      if (!row) return null;
      row.querySelector('input[type=checkbox]').click();
      return row.dataset.taskId;
    })()`);
    await sleep(600);
    const layer1 = await ev(`(() => {
      const v = window.__view;
      const polys = document.querySelectorAll('.quest-layer polygon');
      const dots = document.querySelectorAll('.quest-layer .quest-dot');
      const spots = document.querySelectorAll('.quest-layer .quest-spot');
      const pts = polys.length ? polys[0].getAttribute('points') : '';
      const finite = pts ? pts.split(' ').every((p) => p.split(',').every((n) => Number.isFinite(Number(n)))) : false;
      const d = dots.length ? dots[0] : null;
      return { checked: window.__quest.checked.size, items: (v.questItems || []).length, polys: polys.length, dots: dots.length, spots: spots.length, finite,
        dotTag: d ? d.tagName : null, dotSize: d ? (d.getAttribute('r') || d.getAttribute('width')) : null };
    })()`);
    check('勾选被记录', layer1 && layer1.checked === 1, JSON.stringify(layer1));
    check('地图上画出了任务区域（多边形坐标有限且成对）', layer1 && layer1.polys >= 1 && layer1.finite, JSON.stringify(layer1));
    check('地点标记是可点的橘色小框（.quest-dot 是 rect 且有尺寸）',
      layer1 && layer1.dots >= 1 && Number(layer1.dotSize) > 0 && layer1.dotTag === 'rect',
      `dots=${layer1 ? layer1.dots : 0} tag=${layer1 ? layer1.dotTag : null} size=${layer1 ? layer1.dotSize : null}`);

    // 任务标记的样式必须和图例里的 swatch 一致：统一橘色半透明（曾经是"每个任务一个颜色 + 实心圆点"，
    // 地图上冒出绿/紫圆点，和图例的橘色框对不上 —— 用户直接截图反馈过）
    const questColors = await ev(`(() => {
      const els = [...document.querySelectorAll('.quest-layer polygon, .quest-layer .quest-dot, .quest-layer .quest-spot')];
      const colors = new Set();
      let translucent = 0;
      for (const e of els) {
        const c = String(e.getAttribute('stroke') || e.getAttribute('fill') || '').toLowerCase();
        if (c) colors.add(c);
        const fo = e.getAttribute('fill-opacity');
        if (fo != null && Number(fo) < 0.9) translucent++;
      }
      return { n: els.length, colors: [...colors], translucent };
    })()`);
    check('任务标记统一用图例的橘色 #f59e0b（不再每个任务一个颜色）',
      questColors && questColors.n > 0 && questColors.colors.length === 1 && questColors.colors[0] === '#f59e0b',
      JSON.stringify(questColors));
    check('任务标记都是半透明的（区域/小框/虚线圈，不是实心圆点）',
      questColors && questColors.translucent === questColors.n, JSON.stringify(questColors));
    await shot('quest-sidebar-checked.png');

    // 点地图上的区域中心点 -> 弹任务详情卡（点开后可再"在侧边栏展开"）
    const clickBack = await ev(`(() => {
      const dot = document.querySelector('.quest-layer .quest-dot');
      if (!dot) return 'no-dot';
      dot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(400);
    const focused = await ev(`(() => {
      const c = document.querySelector('#info-card');
      return { cardVisible: !!c && !c.classList.contains('hidden'), title: c && c.querySelector('h4') ? c.querySelector('h4').textContent : null };
    })()`);
    check('点地图上的区域点会弹出任务详情卡', clickBack === 'ok' && focused.cardVisible && focused.title,
      JSON.stringify({ clickBack, focused }));
    await ev(`(() => { const b = document.querySelector('#info-close'); if (b) b.click(); return true; })()`);
    await sleep(200);

    // ---------- 6) 楼层切换 ----------
    await ev(`window.api.setFloor('Second_Floor')`);
    await sleep(600);
    await ev(`window.api.setFloor('auto')`);
    await sleep(400);
    const afterFloor = await ev(`document.querySelectorAll('.quest-layer polygon, .quest-layer .quest-dot').length`);
    check('切换楼层后任务图层仍在（没被清掉）', afterFloor >= 1, `${afterFloor} 个元素`);

    // ---------- 7) 勾选持久化 ----------
    await sleep(700);
    const saved = await ev('window.api.getConfig().then((c) => (c.quests && c.quests.checked) || [])');
    check('勾选已写入配置（重启后仍在）', Array.isArray(saved) && saved.includes(checkedId), JSON.stringify(saved));

    // ---------- 8) 取消勾选 -> 图层清空 ----------
    await ev(`(() => { const row = document.querySelector('#quest-list .quest-row[data-task-id="${checkedId}"]'); if (row) row.querySelector('input[type=checkbox]').click(); return true; })()`);
    await sleep(600);
    const layer2 = await ev(`(() => ({ checked: window.__quest.checked.size, items: (window.__view.questItems || []).length, polys: document.querySelectorAll('.quest-layer polygon').length }))()`);
    check('取消勾选后地图上的标记清掉', layer2 && layer2.checked === 0 && layer2.items === 0 && layer2.polys === 0, JSON.stringify(layer2));

    // ---------- 9) 图例图标必须覆盖地图上实际用到的每个图标 ----------
    // 这一步要求"地图上有标记"才有意义：用户可能只开着任务图层（其余组全关），
    // 所以先全开（结束时会连 markerToggles 一起还原），别让验收依赖用户的开关状态。
    const toggles0cfg = cfg0 && cfg0.markerToggles ? cfg0.markerToggles : null;
    toggles0 = toggles0cfg;
    await ev(`(() => { const b = document.querySelector('#legend-all'); if (b) b.click(); return true; })()`);
    await sleep(900);
    const coverage = await ev(`(() => {
      const mapIcons = new Set([...document.querySelectorAll('.mapstage-overlay .map-marker image')].map((e) => (e.getAttribute('href') || '').split('/').pop()));
      const legendIcons = new Set([...document.querySelectorAll('#legend-body img.legend-icon')].map((e) => (e.getAttribute('src') || '').split('/').pop()));
      return { mapIcons: mapIcons.size, legendIcons: legendIcons.size, missing: [...mapIcons].filter((f) => !legendIcons.has(f)) };
    })()`);
    check('地图上用到的每个图标都能在图例里找到（含 Scav 出生点这类同组不同图）',
      coverage && coverage.missing.length === 0 && coverage.mapIcons > 3,
      `${coverage ? coverage.mapIcons : '?'} 种图标 / 图例 ${coverage ? coverage.legendIcons : '?'} 种 / 缺 ${coverage ? coverage.missing.join(',') || '无' : '?'}`);

    const legendRows = await ev(`(() => [...document.querySelectorAll('#legend-body .legend-item')].map((r) => ({
      id: r.querySelector('input').dataset.group,
      name: r.querySelector('.legend-name').textContent,
      icons: [...r.querySelectorAll('img.legend-icon')].map((e) => (e.getAttribute('src') || '').split('/').pop()).join(','),
      swatch: r.querySelector('svg.legend-swatch') ? true : false,
    })))()`);
    const spawnRow = (legendRows || []).find((r) => r.name.includes('出生点'));
    check('"出生点"图例同时给出 PMC 与 Scav 图标', spawnRow && spawnRow.icons.includes('spawn_pmc') && spawnRow.icons.includes('spawn_scav'),
      JSON.stringify(spawnRow || null));

    // "地图上画了什么，图例里就必须有什么"：任务区域/刷新点/玩家/轨迹也要有图例项
    const wantIds = ['quest:zone', 'quest:spot', 'player', 'trail'];
    const haveIds = new Set((legendRows || []).map((r) => r.id));
    check('任务区域/刷新点/玩家/轨迹 都在图例里', wantIds.every((id) => haveIds.has(id)),
      `缺: ${wantIds.filter((id) => !haveIds.has(id)).join(',') || '无'}`);
    const swatchOk = wantIds.every((id) => {
      const r = (legendRows || []).find((x) => x.id === id);
      return r && r.swatch;
    });
    check('这四类用的是内联小图（不是圆点）', swatchOk, JSON.stringify((legendRows || []).filter((r) => wantIds.includes(r.id)).map((r) => `${r.id}:${r.swatch ? 'swatch' : 'dot'}`)));

    // 图例开关必须真的能关掉任务图层（先重新勾一个，否则上一步已经清空了）
    await ev(`(() => { const row = document.querySelector('#quest-list .quest-row'); if (row) row.querySelector('input[type=checkbox]').click(); return true; })()`);
    await sleep(700);
    const polygonsBefore = await ev(`document.querySelectorAll('.quest-layer polygon').length`);
    check('重新勾选后区域又画出来了', polygonsBefore >= 1, `polygons=${polygonsBefore}`);
    const zoneToggle = await ev(`(() => {
      const row = [...document.querySelectorAll('#legend-body .legend-item')].find((r) => r.querySelector('input').dataset.group === 'quest:zone');
      if (!row) return 'missing';
      const box = row.querySelector('input');
      box.click();
      return 'clicked';
    })()`);
    await sleep(500);
    const zoneHidden = await ev(`document.querySelectorAll('.quest-layer polygon').length`);
    check('图例里关掉"任务区域"能真的把区域隐藏', zoneToggle === 'clicked' && zoneHidden === 0, `polygons=${zoneHidden}`);
    await ev(`(() => {
      const row = [...document.querySelectorAll('#legend-body .legend-item')].find((r) => r.querySelector('input').dataset.group === 'quest:zone');
      if (row) row.querySelector('input').click();
      return true;
    })()`);
    await sleep(500);
    const zoneBack = await ev(`document.querySelectorAll('.quest-layer polygon').length`);
    check('再打开能恢复显示', zoneBack >= 1, `polygons=${zoneBack}`);

    // ---------- 10) 点地图上的任务点 -> 详情卡 ----------
    // 确定性挑一个"当前地图有区域"的任务勾上（不要随便点第一行——它可能已经勾着，会被点掉）
    const target = await ev(`(() => {
      const q = window.__quest; const mapId = window.__view.detail.id;
      const t = q.dump.tasks.find((x) => (x.objectives || []).some((o) => (o.zones || []).some((z) => z.map === mapId && z.outline)));
      if (!t) return null;
      q.checked.add(t.id);
      const c = document.querySelector('#qc-checked'); c.click(); c.click();
      return { id: t.id, name: t.name };
    })()`);
    await sleep(800);
    check('准备：已勾选一个"本图有区域"的任务', Boolean(target), JSON.stringify(target));
    const clicked = await ev(`(() => {
      const dot = document.querySelector('.quest-layer .quest-dot');
      if (!dot) return false;
      dot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    const cardState = await ev(`(() => {
      const c = document.querySelector('#info-card');
      if (!c) return null;
      return {
        visible: !c.classList.contains('hidden'),
        title: c.querySelector('h4') ? c.querySelector('h4').textContent : null,
        rows: [...c.querySelectorAll('.row')].map((r) => r.textContent.trim()),
        buttons: [...c.querySelectorAll('.info-actions button')].map((b) => b.textContent),
      };
    })()`);
    const rowText = cardState && cardState.rows ? cardState.rows.join(' | ') : '';
    check('点地图上的任务点会弹出详情卡', clicked && cardState && cardState.visible && cardState.title === (target && target.name),
      JSON.stringify(cardState).slice(0, 260));
    check('详情卡里有商人/等级/阶段/坐标', /Lv\d+/.test(rowText) && /坐标:/.test(rowText), rowText.slice(0, 200));
    check('详情卡有可用的操作按钮', cardState && cardState.buttons.length >= 3, JSON.stringify(cardState && cardState.buttons));
    await shot('quest-card.png');

    // 详情卡里的"定位到这里"应该真的动视野（先把视野挪开，免得"本来就在那儿"误判）
    await ev(`(() => { const v = window.__view; const b = v.getMapPixelBounds();
      v.setViewport({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: 1, rot: 0 });
      v.setViewMode({ follow: false }); return true; })()`);
    await sleep(300);
    const before10 = await ev(`JSON.stringify(window.__view.getViewport())`);
    await ev(`(() => { const b = document.querySelector('#qc-goto'); if (b) b.click(); return true; })()`);
    await sleep(400);
    const after10 = await ev(`JSON.stringify(window.__view.getViewport())`);
    check('详情卡"定位到这里"改变了视野', before10 !== after10, `${before10} -> ${after10}`);

    // 详情卡的"在侧边栏展开"应该回到侧边栏并高亮该任务
    await ev(`(() => { const b = document.querySelector('#qc-side'); if (b) b.click(); return true; })()`);
    await sleep(500);
    const sideState = await ev(`(() => {
      const row = document.querySelector('#quest-list .quest-row.hot');
      return { hasHot: !!row, id: row ? row.dataset.taskId : null, expanded: document.querySelectorAll('#quest-list .quest-detail').length };
    })()`);
    check('详情卡"在侧边栏展开"会高亮并展开该任务', sideState.hasHot && sideState.expanded >= 1, JSON.stringify(sideState));

    // 收起详情卡，避免挡住后面的操作
    await ev(`(() => { const b = document.querySelector('#info-close'); if (b) b.click(); return true; })()`);
    await sleep(300);

    // ---------- 10b) 勾选的任务"位置在别的图"：必须明确提示 + 一键切图 ----------
    // 真实反馈（2026-09-19）：勾了「铁鸟坠落」（位置在森林），但地图停在灯塔/立交桥
    // -> 地图上空的，用户以为任务标记功能坏了。这条把"会提示 / 点了能切过去 / 过去了真有标记"锁住。
    const other = await ev(`(async () => {
      const q = window.__quest;
      const mapId = window.__view.detail.id;
      const mapsOf = (x) => (x.objectives || []).flatMap((o) => [...(o.zones || []), ...(o.spots || [])]).map((z) => z.map).filter(Boolean);
      const t = q.dump.tasks.find((x) => {
        const ms = mapsOf(x);
        return ms.length && !ms.includes(mapId) && x.objectives.some((o) => (o.zones || []).some((z) => z.outline));
      });
      if (!t) return null;
      q.checked.clear();
      q.checked.add(t.id);
      // 让这一行可见：关掉"本图 / 有地点"筛选，再按任务名搜索
      const chipOff = (id) => { const c = document.querySelector(id); if (c.classList.contains('active')) c.click(); };
      chipOff('#qc-map'); chipOff('#qc-loc');
      const box = document.querySelector('#quest-q');
      box.value = t.name;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const row = document.querySelector('#quest-list .quest-row[data-task-id="' + t.id + '"]');
      const hint = document.querySelector('#quest-hint');
      const go = hint.querySelector('.quest-hint-go');
      return {
        id: t.id, name: t.name, maps: [...new Set(mapsOf(t))],
        rowFound: !!row,
        badge: row && row.querySelector('.qbadge.elsewhere') ? row.querySelector('.qbadge.elsewhere').textContent : null,
        nocord: !!(row && row.querySelector('.qbadge.nocord')),
        noLocClass: !!(row && row.classList.contains('no-loc')),
        items: (window.__view.questItems || []).length,
        hintVisible: !hint.classList.contains('hidden'),
        hintText: hint.textContent.slice(0, 120),
        goText: go ? go.textContent : null,
      };
    })()`);
    check('准备：已勾选一个"本图没位置、别的图有"的任务', Boolean(other && other.rowFound), JSON.stringify(other && { id: other.id, name: other.name }));
    check('这类任务在本图不画任何标记（这是数据/地图不匹配，不是丢标记）', other && other.items === 0, `items=${other ? other.items : '?'}`);
    check('任务行上有「位置在 XX」徽标并且变淡', other && other.badge && other.noLocClass && !other.nocord,
      JSON.stringify(other && { badge: other.badge, noLoc: other.noLocClass }));
    check('面板弹出"本图没有位置"横幅 + 可点的切图按钮', other && other.hintVisible && other.goText,
      JSON.stringify(other && { hint: other.hintText, go: other.goText }));
    await shot('quest-elsewhere-hint.png');

    // 展开明细也应该写明"位置在别的图"
    const detailText = await ev(`(async () => {
      const row = document.querySelector('#quest-list .quest-row.no-loc');
      if (!row) return null;
      row.querySelector('.quest-row-main').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const d = row.querySelector('.quest-detail');
      return d ? d.textContent.slice(0, 160) : null;
    })()`);
    check('展开明细写明"这张图没有该任务的位置"', Boolean(detailText && /没有该任务的位置|没有这个任务的坐标/.test(detailText)),
      String(detailText).slice(0, 120));

    // 点横幅上的按钮：真的切到那张图，并且任务标记出现
    await ev(`(() => { const b = document.querySelector('#quest-hint .quest-hint-go'); if (b) b.click(); return true; })()`);
    await sleep(1800);
    const afterSwitch = await ev(`(() => ({
      mapId: window.__view.detail ? window.__view.detail.id : null,
      mapKey: window.__view.detail ? window.__view.detail.key : null,
      items: (window.__view.questItems || []).length,
      markers: document.querySelectorAll('.quest-layer .quest-dot, .quest-layer .quest-spot').length,
      hintHidden: document.querySelector('#quest-hint').classList.contains('hidden'),
    }))()`);
    check('横幅上的"切到 XX"按钮真的换了地图', other && afterSwitch && other.maps.includes(afterSwitch.mapId),
      JSON.stringify(afterSwitch));
    check('切过去之后任务标记真的画出来了', afterSwitch && (afterSwitch.items >= 1 || afterSwitch.markers >= 1),
      `items=${afterSwitch ? afterSwitch.items : '?'} markers=${afterSwitch ? afterSwitch.markers : '?'}`);
    check('切图后"本图没有位置"横幅消失', afterSwitch && afterSwitch.hintHidden === true, JSON.stringify(afterSwitch));
    await shot('quest-elsewhere-switched.png');

    // 收尾：取消勾选 / 清空搜索 / 恢复筛选，别影响后面的步骤
    await ev(`(() => {
      window.__quest.checked.clear();
      const box = document.querySelector('#quest-q'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true }));
      const chipOn = (id) => { const c = document.querySelector(id); if (!c.classList.contains('active')) c.click(); };
      chipOn('#qc-map'); chipOn('#qc-loc');
      return true;
    })()`);
    await sleep(600);

    // ---------- 11) 面板收起/展开 ----------
    const panel = await ev(`(() => {
      document.querySelector('#quest-close').click();
      const a = document.querySelector('#quest-panel').classList.contains('collapsed');
      document.querySelector('#btn-quests').click();
      const b = document.querySelector('#quest-panel').classList.contains('collapsed');
      return { afterClose: a, afterToggle: b };
    })()`);
    check('面板可收起 / 再点顶栏按钮展开', panel && panel.afterClose === true && panel.afterToggle === false, JSON.stringify(panel));
  } finally {
    // 配置原样写回（把验收期间的勾选/面板状态恢复）
    // 注意：渲染层的 saveQuestCfg 有 400ms 防抖，必须先等它落盘再写回，
    // 否则刚写回去的设置会被那个延迟保存覆盖掉（上一次就是这么漏出来的）。
    await sleep(800);
    if (questCfg0) {
      await ev(`window.api.setConfig({ quests: ${JSON.stringify(questCfg0)} })`).catch(() => {});
      await sleep(500);
    }
    // 地图也还原（10b 会切到别的图验证"切过去真有标记"）
    if (origMap) {
      await ev(`window.api.selectMap({ key: ${JSON.stringify(origMap)} })`).catch(() => {});
      await sleep(400);
    }
    // 图例开关还原（第 9 步为了验"图标全覆盖"点过全开）
    if (toggles0) {
      await ev(`window.api.setConfig({ markerToggles: ${JSON.stringify(toggles0)} })`).catch(() => {});
      await sleep(400);
    }
  }

  const errs = await ev('window.__errs || []');
  check('渲染层没有 console.error', Array.isArray(errs) && errs.length === 0, JSON.stringify(errs).slice(0, 300));

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
