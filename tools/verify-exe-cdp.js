#!/usr/bin/env node
/**
 * 打包版深度验收：用 CDP（--remote-debugging-port）连到打包后的渲染进程，
 * 真实读取地图/标记/图例状态，验证赛季文件刷点与 BTR 站点在 exe 里可用。
 *
 * 用法:
 *   dist\塔科夫离线地图-1.1.0.exe --remote-debugging-port=9222
 *   node tools/verify-exe-cdp.js [--port=9222] [--map=lighthouse]
 */
const path = require('path');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9222));
const WANT_MAP = arg('map', null);
const WANT_TILES = process.argv.includes('--tiles');

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
        if (process.env.CDP_DEBUG) console.log('[cdp][raw]', JSON.stringify(m).slice(0, 700));
        const r = m && m.result;
        if (r && r.exceptionDetails) {
          const d = r.exceptionDetails;
          return { __error: (d.exception && (d.exception.description || d.exception.value)) || d.text };
        }
        return r && 'result' in r ? r.result.value : m;
      }));
    };
    ws.onerror = (e) => reject(new Error('ws error ' + (e.message || '')));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
  });
}

(async () => {
  let list = [];
  for (let i = 0; i < 20; i++) {
    try { list = await targets(); if (list.length) break; } catch {}
    await sleep(1000);
  }
  console.log('[cdp] targets:', list.map((t) => `${t.type}:${t.url}`).join(' , ') || '(none)');
  const page = list.find((t) => t.url.endsWith('/map.html')) || list.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到渲染页面（请带 --remote-debugging-port=9222 启动 exe）');
  console.log('[cdp] using page:', page.url);

  const evalJs = (expr) => cdp(page.webSocketDebuggerUrl, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]);

  // 1) 若指定地图，走**真实换图路径**（api.selectMap -> 主进程广播 -> 渲染层加载底图）。
  //    以前这里是直接 fetch SVG 再 __view.setMap(...)，对没有 SVG 的图（实验室/迷宫/破冰船）
  //    会在 d.svgPath.split 上直接抛，而且绕过了"主进程扫盘下发瓦片目录"这条链路。
  if (WANT_MAP) {
    await evalJs(`(async () => {
      const list = await window.api.listMaps();
      const m = list.find((x) => x.key === ${JSON.stringify(WANT_MAP)});
      if (!m) throw new Error('地图列表里没有 ${WANT_MAP}');
      return window.api.selectMap({ id: m.id });
    })()`);
    for (let i = 0; i < 40; i++) {
      const k = await evalJs(`window.__viewDebug && window.__viewDebug.detailKey`);
      if (k === WANT_MAP) break;
      await sleep(250);
    }
    await sleep(500);
  }

  const info = await evalJs(`(() => {
    const v = window.__view;
    const groups = {};
    for (const m of (v.markerCache || [])) groups[m.group] = (groups[m.group] || 0) + 1;
    return {
      mapKey: v.detail && v.detail.key,
      domMarkers: document.querySelectorAll('.map-marker').length,
      seasonGroups: Object.keys(groups).filter((k) => k.startsWith('season:')).map((k) => k + '=' + groups[k]),
      btrStops: groups.btrStop || 0,
      legendGroups: v.getLegend().map((g) => g.label + '[' + g.items.length + ']:' + g.items.map((c) => c.label + ' x' + c.count).join(' | ')),
      legendIconCount: document.querySelectorAll('.legend-icon').length,
      legendGroupBoxes: document.querySelectorAll('.legend-group-box').length,
      seasonIconSrc: (() => { const i = document.querySelector('img.legend-icon'); return i ? i.getAttribute('src') : null; })(),
      seasonIconOk: (() => {
        const i = document.querySelector('img.legend-icon');
        return i ? (i.complete && i.naturalWidth > 0) : null;
      })(),
      title: document.title,
    };
  })()`);
  console.log('[cdp] renderer state:', JSON.stringify(info, null, 1));

  // 1.5) 打包版报出来的版本号必须与 package.json 一致（别拿旧包当新版本发出去）
  const pkgVer = require('../package.json').version;
  const appVerRaw = await evalJs(`window.api.getState().then((s) => s.appVersion)`);
  const appVer = Array.isArray(appVerRaw) ? appVerRaw[0] : appVerRaw;
  const verOk = appVer === pkgVer;
  console.log(`[cdp] 版本: exe=${JSON.stringify(appVer)} / package.json=${pkgVer}  ${verOk ? 'OK' : 'MISMATCH'}`);
  if (!verOk) process.exitCode = 1;

  // 2) 校验赛季图标真的解码成功（打包版 app:// + webp MIME）
  const iconCheck = await evalJs(`(async () => {
    const sd = await (await fetch('app://data/season-documents.json')).json();
    const out = [];
    for (const t of Object.values(sd.types)) {
      const ok = await new Promise((res) => {
        const img = new Image();
        img.onload = () => res(img.naturalWidth + 'x' + img.naturalHeight);
        img.onerror = () => res('FAIL');
        img.src = 'app://data/icons/' + t.icon;
      });
      out.push(t.type + ':' + ok);
    }
    return out;
  })()`);
  console.log('[cdp] season icons:', JSON.stringify(iconCheck));
  // 3) 赛季文件参考截图：点标记 -> 卡片缩略图 -> 大图查看器（打包版 app:// + webp 关键路径）
  const shot = await evalJs(`(async () => {
    const v = window.__view;
    const m = (v.markerCache || []).find((x) => String(x.group).startsWith('season:'));
    if (!m) return { error: 'no season marker' };
    v.onMarkerClick && v.onMarkerClick(m);
    const thumb = document.getElementById('ref-shot');
    if (!thumb) return { error: 'no #ref-shot in card' };
    await thumb.decode().catch(() => {});
    const thumbOk = thumb.complete && thumb.naturalWidth > 0;
    thumb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const big = document.getElementById('shot-viewer-img');
    await big.decode().catch(() => {});
    const viewerOpen = !document.getElementById('shot-viewer').classList.contains('hidden');
    const bigOk = big.complete && big.naturalWidth > 0;
    return {
      caption: document.getElementById('shot-viewer-caption').textContent,
      thumbSrc: thumb.getAttribute('src'),
      thumbOk, thumbSize: thumb.naturalWidth + 'x' + thumb.naturalHeight,
      viewerOpen, bigOk, bigSize: big.naturalWidth + 'x' + big.naturalHeight,
    };
  })()`);
  console.log('[cdp] season reference screenshot:', JSON.stringify(shot));

  // 4) 小地图雷达（打包版）：状态自愈 + 视口裁剪 + 不透明底盘
  const miniTarget = (await targets()).find((t) => t.url.endsWith('/minimap.html'));
  if (!miniTarget) {
    console.log('[cdp] minimap target 缺失（雷达可能被关闭）');
  } else {
    const miniEval = (expr) => cdp(miniTarget.webSocketDebuggerUrl, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]);
    const miniState = await miniEval(`(() => {
      const root = document.getElementById('mini-root');
      const sizes = Array.from(document.querySelectorAll('.map-marker image')).map((i) => Number(i.getAttribute('width')));
      const shapes = {};
      for (const g of document.querySelectorAll('.map-marker')) {
        const f = g.firstElementChild;
        if (!f || f.tagName === 'title') continue;
        const key = f.tagName === 'polygon' ? 'polygon' : f.tagName;
        shapes[key] = (shapes[key] || 0) + 1;
      }
      const bar = document.getElementById('mini-lockbar').getBoundingClientRect();
      const lockBtn = document.getElementById('mini-lock');
      const unlockBtn = document.getElementById('mini-unlock');
      return {
        backdrop: getComputedStyle(root).backgroundImage.includes('radial-gradient'),
        rootClip: getComputedStyle(root).clipPath,
        bodyClip: getComputedStyle(document.body).clipPath,
        domMarkers: document.querySelectorAll('.map-marker').length,
        allMarkers: (window.__view && window.__view.markerCache || []).length,
        player: !!document.querySelector('.mapstage-overlay svg g g'),
        iconMin: sizes.length ? Math.min(...sizes) : null,
        iconMax: sizes.length ? Math.max(...sizes) : null,
        firstChildTags: shapes,
        miniLabels: document.querySelectorAll('.map-marker text').length,
        hudToolbar: !!document.querySelector('.mini-hud'),
        lockBar: {
          idleOpacity: Number(getComputedStyle(document.getElementById('mini-lockbar')).opacity),
          buttons: [lockBtn.textContent.trim(), unlockBtn.textContent.trim()],
          tabIndex: [lockBtn.tabIndex, unlockBtn.tabIndex],
          center: { x: Math.round(bar.left + bar.width / 2), y: Math.round(bar.top + bar.height / 2) },
        },
        rotate: window.__view.rotate,
        rot: window.__view.view.rot,
        labelScale: window.__view.labelScale,
      };
    })()`);
    console.log('[cdp] minimap:', JSON.stringify(miniState));

    // 关闭 -> 必须保持关闭；再打开 -> 必须恢复（打包版走同一套 IPC）
    const clickBtn = `document.getElementById('btn-mini').click(); true`;
    await evalJs(clickBtn);
    await sleep(3500);
    const afterOff = await evalJs(`({ title: document.getElementById('btn-mini').title, active: document.getElementById('btn-mini').classList.contains('active') })`);
    const offTargets = (await targets()).filter((t) => t.url.endsWith('/minimap.html')).length;
    console.log('[cdp] 关闭雷达后: 按钮=' + JSON.stringify(afterOff) + ' minimap targets=' + offTargets);
    await evalJs(clickBtn);
    await sleep(2000);
    const onTargets = (await targets()).filter((t) => t.url.endsWith('/minimap.html')).length;
    const afterOn = await evalJs(`({ title: document.getElementById('btn-mini').title, active: document.getElementById('btn-mini').classList.contains('active'), focused: document.activeElement && document.activeElement.id })`);
    console.log('[cdp] 重新打开后: 按钮=' + JSON.stringify(afterOn) + ' minimap targets=' + onTargets);
  }
  // 5) 瓦片底图（实验室/迷宫/破冰船）：打包版里 data/tiles 有没有被正确打进 asar.unpacked、
  //    app:// 能不能取到、楼层切不切得动。--tiles 会给出退出码，可直接当发版闸门用。
  if (WANT_TILES) {
    // evalJs 返回的是"每条命令的结果数组"，这里只发一条，取 [0]
    const ev1 = async (expr) => { const r = await evalJs(expr); return Array.isArray(r) ? r[0] : r; };
    const fails = [];
    const cases = ['the-lab', 'the-labyrinth', 'icebreaker'];
    for (const key of cases) {
      const sel = await ev1(`(async () => {
        const list = await window.api.listMaps();
        const m = list.find((x) => x.key === ${JSON.stringify(key)});
        if (!m || !m.hasBasemap) return { error: '地图列表里没有底图' };
        await window.api.selectMap({ id: m.id });
        return { layers: Object.keys(m.tiles || {}).length };
      })()`);
      if (sel && sel.__error) { fails.push(`${key}: ${sel.__error}`); continue; }
      if (!sel || sel.error) { fails.push(`${key}: ${(sel && sel.error) || 'selectMap 失败'}`); continue; }
      let t = null;
      for (let i = 0; i < 40; i++) {
        t = await ev1(`window.__viewDebug && window.__viewDebug.detailKey === ${JSON.stringify(key)} ? window.__viewDebug.tiles : null`);
        if (t) break;
        await sleep(250);
      }
      if (!t) { fails.push(`${key}: 没启用瓦片底图`); continue; }
      const probe = await ev1(`(async () => {
        const gs = [...document.querySelectorAll('.raster-base g[data-layer]')];
        const g = gs.find((x) => x.getAttribute('display') !== 'none');
        if (!g) return { error: '没有可见的瓦片层' };
        const list = [...g.querySelectorAll('image')];
        let ok = 0, bad = 0;
        for (const im of list) {
          try { const r = await fetch(im.getAttribute('href')); if (r.ok) ok++; else bad++; } catch { bad++; }
        }
        return { layer: g.getAttribute('data-layer'), n: list.length, ok, bad,
                 box: [list[0].getAttribute('x'), list[0].getAttribute('y'), list[0].getAttribute('width')] };
      })()`);
      if (!probe || probe.__error) { fails.push(`${key}: ${(probe && probe.__error) || '探测失败'}`); continue; }
      if (probe.error) { fails.push(`${key}: ${probe.error}`); continue; }
      console.log(`[cdp] tiles ${key}: 层数=${sel.layers} zoom=${t.zoom} 当前层=${probe.layer} 图=${probe.n} 取到=${probe.ok} 缺=${probe.bad} 首块=${JSON.stringify(probe.box)}`);
      if (probe.bad > 16) fails.push(`${key}: ${probe.bad} 张瓦片取不到`);
      if (!probe.n) fails.push(`${key}: 当前层一张瓦片都没有`);
    }
    // 有 SVG 的图不能被瓦片逻辑带坏
    await ev1(`(async () => {
      const list = await window.api.listMaps();
      const m = list.find((x) => x.key === 'customs');
      await window.api.selectMap({ id: m.id });
      return true;
    })()`);
    await sleep(1200);
    const svgState = await ev1(`({ tiles: window.__viewDebug.tiles, svg: document.querySelectorAll('.world > svg').length })`);
    console.log('[cdp] tiles customs(SVG): ' + JSON.stringify(svgState));
    if (!svgState || svgState.tiles !== null || !(svgState.svg >= 1)) fails.push('海关的 SVG 底图被瓦片逻辑带坏了');
    console.log(fails.length ? `\nTILES-CHECK FAIL (${fails.length})\n  - ${fails.join('\n  - ')}` : '\nTILES-CHECK PASS');
    if (fails.length) process.exitCode = 1;
  }
})().catch((e) => { console.error('[fatal]', e.message); process.exit(1); });
