#!/usr/bin/env node
/**
 * 瓦片底图（实验室/迷宫/破冰船）+ 楼层下拉 + 设置页小地图开关 的端到端验收。
 *
 * 三件此前会出问题的事：
 *   1) 没有 SVG 的图不画底图 —— 实验室切过去只有标记没有地面，选图下拉里也没有它
 *   2) 设置页"启用小地图雷达"只写配置不动窗口 —— 顶栏开着雷达、进设置取消勾选、保存，
 *      窗口照样挂在桌面上
 *   3) 楼层是一排按钮 —— 破冰船 16 层甲板把顶栏撑成两行（现在是下拉框，"自动"默认）
 *
 * 脚本自己起一个**隔离实例**（TAKOV_USER_DATA 指到临时目录），全程不读写你日常那份配置。
 *
 * 用法:
 *   node tools/verify-raster.js [--port=9333] [--keep]
 *   --keep  跑完不删临时配置目录（出问题时要看 mini.log / app.log 时用）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ART = path.join(ROOT, 'test-artifacts');
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9333));
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

/** 极简 CDP：按顺序发若干条命令（与 tools/verify-annotations.js 同款） */
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

/** 造一份隔离配置：目录全在临时目录里，房间关掉，别带用户身份 */
function makeProfile() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'takov-raster-'));
  const shots = path.join(userData, 'shots');
  const logs = path.join(userData, 'logs');
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    screenshotsPath: shots,
    logsPath: logs,
    sound: false,
    autoDeleteScreenshots: false,
    markerToggles: null,       // 全部标记打开，截图里才看得到东西
    miniVisible: false,        // 小地图从"关"开始，才能验证勾上真的会开
    room: { enabled: false },  // 绝不拿用户身份连进真实房间
  }, null, 2));
  return { userData, shots, logs };
}

async function main() {
  const { userData } = makeProfile();
  const proc = spawn(require('electron'), [
    '.',
    `--remote-debugging-port=${PORT}`,
    // 窗口被挡住时 Chromium 会停止出帧，captureScreenshot 会卡住
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ], {
    cwd: ROOT,
    env: { ...process.env, TAKOV_USER_DATA: userData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = [];
  proc.stdout.on('data', (d) => tail.push(String(d)));
  proc.stderr.on('data', (d) => tail.push(String(d)));

  const kill = () => {
    try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    try { proc.kill(); } catch {}
  };

  try {
    let mapWs = null;
    for (let i = 0; i < 120; i++) {
      try {
        const list = await targets();
        const t = list.find((x) => x.url.endsWith('/map.html'));
        if (t) { mapWs = t.webSocketDebuggerUrl; break; }
      } catch {}
      await sleep(250);
    }
    if (!mapWs) throw new Error('没能连上主窗口（CDP ' + PORT + '）');
    // 每次求值新开一条 ws：这些调用都是低频的，省掉长连接的断线重连逻辑
    const ev = async (expr) => {
      const r = await cdp(mapWs, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]);
      const v = r[0];
      if (v && v.__error) throw new Error(v.__error);
      return v;
    };
    const shot = async (file) => {
      const r = await cdp(mapWs, [['Page.captureScreenshot', { format: 'png' }]]);
      const data = r[0];
      if (!data || typeof data !== 'string') throw new Error('截图失败: ' + JSON.stringify(data));
      fs.mkdirSync(ART, { recursive: true });
      fs.writeFileSync(path.join(ART, file), Buffer.from(data, 'base64'));
      return path.join('test-artifacts', file);
    };

    // 等页面把地图加载完（init() 是异步的）
    for (let i = 0; i < 60; i++) {
      const ready = await ev(`!!(window.api && window.__view)`).catch(() => false);
      if (ready) break;
      await sleep(250);
    }

    // ---------------------------------------------------------------- 1) 数据层
    const maps = await ev(`window.api.listMaps()`);
    const byKey = (k) => (maps || []).find((m) => m.key === k);
    for (const key of ['the-lab', 'the-labyrinth', 'icebreaker']) {
      const m = byKey(key);
      check(`地图列表包含 ${key} 且带瓦片底图`,
        m && m.hasBasemap && m.tiles && Object.keys(m.tiles).length > 0,
        m ? `层数=${Object.keys(m.tiles || {}).length}` : '不存在');
    }
    const labId = byKey('the-lab') && byKey('the-lab').id;

    // 先确认页面真的初始化完了。渲染层一旦抛异常（比如语法错误），window.__view 照样存在、
    // 但下拉是空的、后面每一条检查都会莫名其妙地失败 —— 那种时候要直接说"渲染层挂了"，
    // 而不是让人从十条 FAIL 里去猜。（排查细节用 tools/diagnose-renderer.js）
    let inited = false;
    for (let i = 0; i < 60; i++) {
      inited = await ev(`document.querySelectorAll('#map-select option').length > 1`).catch(() => false);
      if (inited) break;
      await sleep(250);
    }
    if (!inited) {
      throw new Error('页面没有初始化完（选图下拉是空的）—— 渲染层多半抛异常了，跑 node tools/diagnose-renderer.js 看报错');
    }

    // 下拉里真的能选到（选图列表按 hasBasemap 过滤）
    const opts = await ev(`[...document.querySelectorAll('#map-select option')].map(o => o.textContent)`);
    check('选图下拉里有"实验室"', (opts || []).some((t) => String(t).includes('实验室')), (opts || []).join(' / '));

    // ---------------------------------------------------------------- 2) 切到实验室
    await ev(`window.api.selectMap({ id: ${JSON.stringify(labId)} })`);
    let dbg = null;
    for (let i = 0; i < 40; i++) {
      dbg = await ev(`window.__viewDebug || null`);
      if (dbg && dbg.detailKey === 'the-lab' && dbg.tiles) break;
      await sleep(250);
    }
    check('实验室已加载并启用了瓦片底图', !!(dbg && dbg.tiles), dbg ? JSON.stringify(dbg.tiles) : '没有 __viewDebug.tiles');
    if (dbg && dbg.tiles) {
      const t = dbg.tiles;
      check('固定 zoom=3 / tileSize=175 / 单块 21.875',
        t.zoom === 3 && t.tileSize === 175 && Math.abs(t.step - 21.875) < 1e-9,
        `zoom=${t.zoom} tileSize=${t.tileSize} step=${t.step}`);
      check('瓦片索引范围 = x0..7, y1..6', String(t.range) === '0,7,1,6', String(t.range));
      check('三个楼层的目录都在', (t.dirs || []).length === 3, (t.dirs || []).join(', '));
    }

    // 图像元素：数量、落位、URL 能取到
    const imgs = await ev(`(() => {
      const q = document.querySelectorAll('.raster-base g[data-layer]');
      const want = [...q].find(g => g.getAttribute('display') !== 'none');
      if (!want) return null;
      const list = [...want.querySelectorAll('image')];
      return {
        layer: want.getAttribute('data-layer'),
        n: list.length,
        boxes: list.slice(0, 3).map(im => [im.getAttribute('x'), im.getAttribute('y'), im.getAttribute('width'), im.getAttribute('height')]),
        urls: list.map(im => im.getAttribute('href')),
      };
    })()`);
    check('一层渲染出 48 张瓦片图（8×6）', imgs && imgs.n === 48, imgs ? `层=${imgs.layer} 数量=${imgs.n}` : '没有可见的瓦片层');
    if (imgs) {
      const b = imgs.boxes[0];
      check('瓦片落位 = (x*step, y*step)，边长 step',
        b && Math.abs(Number(b[0]) - 0) < 1e-9 && Math.abs(Number(b[1]) - 21.875) < 1e-9
          && Math.abs(Number(b[2]) - 21.875) < 1e-9 && Math.abs(Number(b[3]) - 21.875) < 1e-9,
        JSON.stringify(b));
      const probe = await ev(`(async () => {
        let ok = 0, bad = 0;
        for (const u of ${JSON.stringify(imgs.urls)}) {
          try { const r = await fetch(u); if (r.ok) ok++; else bad++; } catch { bad++; }
        }
        return { ok, bad };
      })()`);
      // 实验室一层有 16 个角是空的（CDN 上本来就没有），这里只要求"能取到的都取到了"
      check('瓦片文件基本都能取到（缺的都是 CDN 本来就没有的空角）',
        probe && probe.ok >= 40 && probe.bad <= 16, JSON.stringify(probe));
    }

    // 楼层下拉：默认"自动"，一层/二层/技术层都在里面
    const floors = await ev(`({
      shown: !document.querySelector('#floor-picker').classList.contains('hidden'),
      value: document.querySelector('#floor-select').value,
      opts: [...document.querySelectorAll('#floor-select option')].map(o => o.textContent),
    })`);
    check('楼层是下拉框且默认"自动"',
      floors && floors.shown === true && floors.value === 'auto', JSON.stringify(floors));
    check('楼层选项 = 自动/一层/二层/技术层',
      floors && floors.opts.join(',') === '自动（按你所在高度）,一层,二层,技术层', (floors && floors.opts || []).join(','));

    // 切到二层：一层的组要隐掉，二层的组要出来
    const floor = await ev(`(async () => {
      const sel = document.querySelector('#floor-select');
      sel.value = 'Second Level';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      const st = document.querySelector('#st-floor').textContent;
      const gs = [...document.querySelectorAll('.raster-base g[data-layer]')];
      return { st, gs: gs.map(g => [g.getAttribute('data-layer'), g.getAttribute('display')]) };
    })()`);
    check('选到二层后只显示二层', floors && floor && Array.isArray(floor.gs)
      && floor.gs.find(([k]) => k === 'Second Level')?.[1] !== 'none'
      && floor.gs.find(([k]) => k === '一层')?.[1] === 'none', JSON.stringify(floor && floor.gs));
    check('状态栏楼层立刻跟着变（不等下一次广播）', floor && floor.st === '楼层: Second Level', floor && floor.st);

    // 手动选的层必须扛得住后续的状态广播（以前主进程那份一直是 auto，会把它按回去）
    await sleep(1500);
    const held = await ev(`(async () => ({
      value: document.querySelector('#floor-select').value,
      floor: window.__view.floor,
      state: (await window.api.getState()).floor,
    }))()`);
    check('手动选的层不会被下一次广播按回自动',
      held && held.value === 'Second Level' && held.floor === 'Second Level' && held.state === 'Second Level',
      JSON.stringify(held));

    // ---------------------------------------------------------------- 3) 截图（人工核对底图与标记是否对齐）
    // 先把楼层选回"自动"再截：上面刚切到二层，不然截出来的二层看着像"底图没画出来"
    await ev(`(() => {
      const sel = document.querySelector('#floor-select');
      sel.value = 'auto';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    const labShot = await shot('verify-lab-full.png');
    const zoomShot = await ev(`(() => {
      const d = window.__view.detail;
      const e = (d.extracts || [])[0];
      if (!e) return null;
      const p = window.__view.proj.project(e.position.x, e.position.z);
      window.__view.setViewport({ cx: p.x, cy: p.y, scale: 22, rot: 0 });
      window.__view.setViewMode({ follow: false });
      return e.name;
    })()`);
    await sleep(300);
    const labZoomShot = await shot('verify-lab-extract.png');
    console.log(`      · 全图截图 ${labShot}`);
    console.log(`      · 撤离点「${zoomShot}」特写 ${labZoomShot}`);

    // 迷宫 + 破冰船也过一遍（只验证不报错、瓦片层建得出来）
    for (const key of ['the-labyrinth', 'icebreaker']) {
      const id = byKey(key).id;
      await ev(`window.api.selectMap({ id: ${JSON.stringify(id)} })`);
      let d2 = null;
      for (let i = 0; i < 40; i++) {
        d2 = await ev(`window.__viewDebug || null`);
        if (d2 && d2.detailKey === key && d2.tiles) break;
        await sleep(250);
      }
      check(`${key} 也能画出瓦片底图`, !!(d2 && d2.tiles),
        d2 && d2.tiles ? `层数=${(d2.tiles.dirs || []).length} 范围=${d2.tiles.range}` : '没有瓦片');
      if (key === 'the-labyrinth') { await sleep(300); console.log(`      · 迷宫截图 ${await shot('verify-labyrinth.png')}`); }
      if (key === 'icebreaker') {
        // 破冰船 16 层甲板：下拉里应当是 16 层（中文名，按高度从下到上）+ 一个"自动"
        const pick = await ev(`[...document.querySelectorAll('#floor-select option')].map(o => o.textContent)`);
        check('破冰船楼层下拉 = 自动 + 16 层甲板（中文名、按高度从下到上）',
          Array.isArray(pick) && pick.length === 17 && pick[0].startsWith('自动')
          && pick[1] === '控制室' && pick[2] === '轮机舱' && pick[16] === '舰桥顶' && pick.includes('医务室'),
          (pick || []).join(' / '));
        console.log(`      · 破冰船截图 ${await shot('verify-icebreaker.png')}`);
      }
    }

    // 有 SVG 的图不能被瓦片逻辑带坏：切到海关，底图仍是 SVG，楼层下拉照旧
    const customsId = byKey('customs').id;
    await ev(`window.api.selectMap({ id: ${JSON.stringify(customsId)} })`);
    let svgState = null;
    for (let i = 0; i < 40; i++) {
      svgState = await ev(`({
        key: window.__viewDebug && window.__viewDebug.detailKey,
        tiles: window.__viewDebug && window.__viewDebug.tiles,
        svg: document.querySelectorAll('.world > svg').length,
        shown: !document.querySelector('#floor-picker').classList.contains('hidden'),
        value: document.querySelector('#floor-select').value,
        opts: [...document.querySelectorAll('#floor-select option')].map(o => o.textContent),
      })`);
      if (svgState && svgState.key === 'customs' && svgState.svg >= 1) break;
      await sleep(250);
    }
    check('海关仍走 SVG 底图（没被瓦片逻辑带坏）',
      svgState && svgState.tiles === null && svgState.svg >= 1, JSON.stringify(svgState));
    check('海关楼层下拉 = 自动/一层/二层/三层/四层/地下（默认自动）',
      svgState && svgState.shown === true && svgState.value === 'auto'
      && svgState.opts.join(',') === '自动（按你所在高度）,一层,二层,三层,四层,地下',
      (svgState && svgState.opts || []).join(','));

    // 只有一层的图（迷宫/森林/灯塔）不该占着这块地方
    const labyId = byKey('the-labyrinth').id;
    await ev(`window.api.selectMap({ id: ${JSON.stringify(labyId)} })`);
    await sleep(900);
    const single = await ev(`({
      key: window.__viewDebug && window.__viewDebug.detailKey,
      hidden: document.querySelector('#floor-picker').classList.contains('hidden'),
    })`);
    check('只有一层的地图把楼层下拉收起来', single && single.key === 'the-labyrinth' && single.hidden === true, JSON.stringify(single));

    // ---------------------------------------------------------------- 4) 设置页的小地图开关
    await ev(`window.api.selectMap({ id: ${JSON.stringify(labId)} })`);
    await sleep(400);
    const before = await ev(`window.api.miniStatus()`);
    check('初始状态：小地图没开', before && before.enabled === false, JSON.stringify(before));

    // 勾上 -> 窗口必须真的出现
    await ev(`window.api.setConfig({ miniVisible: true })`);
    let on = null;
    for (let i = 0; i < 20; i++) {
      on = await ev(`window.api.miniStatus()`);
      if (on && on.alive && on.visible) break;
      await sleep(300);
    }
    check('设置里勾上"启用小地图雷达" -> 窗口真的开出来',
      on && on.enabled === true && on.alive === true && on.visible === true, JSON.stringify(on));

    // 取消勾选 -> 窗口必须真的关掉（这就是用户报的那条）
    await ev(`window.api.setConfig({ miniVisible: false })`);
    let off = null;
    for (let i = 0; i < 20; i++) {
      off = await ev(`window.api.miniStatus()`);
      if (off && off.enabled === false && off.visible === false) break;
      await sleep(300);
    }
    check('取消勾选小地图 -> 窗口真的关掉',
      off && off.enabled === false && off.visible === false, JSON.stringify(off));

    // 顶栏按钮的高亮也要跟着走（不能按钮亮着但窗口没了）
    const btnActive = await ev(`document.querySelector('#btn-mini').classList.contains('active')`);
    check('顶栏小地图按钮同步取消高亮', btnActive === false, String(btnActive));

    // 用户报的那条路径，按界面上真实的点法再走一遍：
    // 顶栏开雷达 -> 进设置（复选框必须是勾着的）-> 取消勾选 -> 保存 -> 窗口关掉
    await ev(`window.api.toggleMini()`);
    for (let i = 0; i < 20; i++) {
      const st = await ev(`window.api.miniStatus()`);
      if (st && st.visible) break;
      await sleep(300);
    }
    await ev(`document.querySelector('#btn-settings').click()`);
    await sleep(300);
    const checkedWhenOn = await ev(`document.querySelector('#set-mini').checked`);
    check('雷达开着时，设置页那个复选框也是勾上的（不再显示旧状态）', checkedWhenOn === true, String(checkedWhenOn));
    await ev(`(() => {
      document.querySelector('#set-mini').checked = false;
      document.querySelector('#settings-ok').click();
      return true;
    })()`);
    let afterSave = null;
    for (let i = 0; i < 20; i++) {
      afterSave = await ev(`window.api.miniStatus()`);
      if (afterSave && afterSave.visible === false) break;
      await sleep(300);
    }
    check('设置里取消勾选 + 保存 -> 雷达窗口真的关掉（用户报的那一条）',
      afterSave && afterSave.enabled === false && afterSave.visible === false, JSON.stringify(afterSave));
  } finally {
    kill();
    if (!KEEP) {
      // 刚 taskkill 完文件句柄还攥在渲染进程手里，立刻删会 EBUSY —— 退让一下再删
      for (let i = 0; i < 5; i++) {
        try { fs.rmSync(userData, { recursive: true, force: true }); break; } catch { await sleep(300); }
      }
      if (fs.existsSync(userData)) console.warn(`[warn] 临时配置目录没删干净: ${userData}`);
    } else {
      console.log(`[keep] 临时配置目录: ${userData}`);
    }
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 项通过${bad.length ? '，失败: ' + bad.map((b) => b.name).join(' | ') : ''}`);
  if (bad.length) {
    console.log('\n--- 客户端输出尾部 ---');
    console.log(tail.join('').slice(-2000));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[verify-raster] 失败:', e.message || e);
  process.exitCode = 1;
});
