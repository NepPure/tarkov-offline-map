#!/usr/bin/env node
/**
 * 打包版深度验收：用 CDP（--remote-debugging-port）连到打包后的渲染进程，
 * 真实读取地图/标记/图例状态，验证赛季文件刷点与 BTR 站点在 exe 里可用。
 *
 * 用法:
 *   dist\塔可夫离线地图-1.1.0.exe --remote-debugging-port=9222
 *   node tools/verify-exe-cdp.js [--port=9222] [--map=lighthouse]
 */
const path = require('path');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9222));
const WANT_MAP = arg('map', null);

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

  // 1) 若指定地图，通过日志广播之外的路径无法切换；此处直接调用视图 API 检查数据装配
  if (WANT_MAP) {
    await evalJs(`(async () => {
      const json = await (await fetch('app://data/maps-dump.json')).json();
      const d = json.maps.map((m) => m.detail).find((x) => x.key === ${JSON.stringify(WANT_MAP)});
      const svg = await (await fetch('app://data/maps/' + d.svgPath.split('/').pop())).text();
      await window.__view.setMap(d, svg);
      const sd = await (await fetch('app://data/season-documents.json')).json();
      window.__view.setSeasonDocuments(sd, d.id);
      return true;
    })()`);
    await sleep(800);
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
})().catch((e) => { console.error('[fatal]', e.message); process.exit(1); });
