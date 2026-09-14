'use strict';

/**
 * 应用主进程：
 *  - 窗口：主地图窗 + 圆形小地图悬浮窗
 *  - 服务：日志监听（自动识别地图）、截图监听（定位）
 *  - 状态中枢：把 map/floor/position/heading/trail 广播给所有窗口
 *  - 协议：app:// 提供本地数据（renderer 同源 fetch SVG/JSON）
 *  - 纯离线：无任何网络请求
 */
const { app, BrowserWindow, ipcMain, dialog, protocol, net, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { pathToFileURL } = require('url');
const os = require('os');

const mapsData = require('./src/maps-data');
const { LogWatcher } = require('./src/log-watcher');
const { ScreenshotWatcher } = require('./src/screenshot-watcher');
const { RAIDCODE_TO_MAPKEY, MAPKEY_TO_SVG } = require('./src/constants');

// 固定 userData 目录（保证开发环境与打包后共用同一份配置）
app.setPath('userData', path.join(app.getPath('appData'), 'tarkov-offline-map'));

const APP_TITLE = '塔可夫离线地图';
const REPO_ROOT = __dirname;
const DATA_DIR = path.join(REPO_ROOT, 'data');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const DEFAULT_SCREENSHOTS_DIR = path.join(
  os.homedir(), 'Documents', 'Escape from Tarkov', 'Screenshots'
);
const DEFAULT_LOGS_DIR = path.join(os.homedir(), 'Documents', 'Escape from Tarkov', 'Logs');

/** 自动探测游戏安装目录（注册表 + 常见路径），返回现有的日志/截图目录 */
function detectGameDirs() {
  const logsCandidates = [];
  const shotCandidates = [DEFAULT_SCREENSHOTS_DIR];

  // 1) 注册表卸载信息 -> 游戏根目录
  const regKeys = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EscapeFromTarkov',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EscapeFromTarkov',
  ];
  for (const key of regKeys) {
    try {
      const out = execSync(`reg query "${key}" /v UninstallString`, { encoding: 'utf-8', timeout: 4000 });
      const m = out.match(/UninstallString\s+REG_SZ\s+(.+)/);
      if (m) {
        const raw = m[1].trim().replace(/^"|"$/g, '');
        const root = raw.replace(/[\\/]Uninstall\.exe$/i, '');
        if (root) {
          logsCandidates.push(path.join(root, 'build', 'Logs'), path.join(root, 'Logs'));
          shotCandidates.push(path.join(root, 'build', 'Screenshots'), path.join(root, 'Screenshots'));
        }
      }
    } catch {}
  }
  // 2) Steam / 常见安装位置
  const roots = [
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Escape from Tarkov',
    'C:\\Program Files\\Steam\\steamapps\\common\\Escape from Tarkov',
    'C:\\Battlestate Games\\EFT',
    'C:\\Games\\Escape from Tarkov',
  ];
  for (const r of roots) logsCandidates.push(path.join(r, 'build', 'Logs'), path.join(r, 'Logs'));
  logsCandidates.push(DEFAULT_LOGS_DIR);

  const firstExisting = (list) => list.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || null;

  return {
    logsPath: firstExisting(logsCandidates) || DEFAULT_LOGS_DIR,
    screenshotsPath: firstExisting(shotCandidates) || DEFAULT_SCREENSHOTS_DIR,
  };
}

function loadSettings() {
  const defaults = {
    logsPath: DEFAULT_LOGS_DIR,
    screenshotsPath: DEFAULT_SCREENSHOTS_DIR,
    miniVisible: false,
    miniScale: 1.0,
    miniRadius: 55,
    miniOpacity: 0.9,
    miniFollowMainZoom: false, // 小地图缩放依据: false=小地图自身, true=跟随互动地图缩放
    mapOpacity: 1.0,
    rotateWithHeading: false,
    followPlayer: true,
    autoZoom: true,             // 定位自动缩放
    autoCenter: true,           // 定位自动居中
    showAllMarkers: true,       // 表层显示全部标记
    autoFloor: true,            // 自动切换地图图层
    sound: true,                // 声音提示
    autoDeleteScreenshots: false, // 自动删除截图文件
    markerScale: 1,             // 标记大小乘数
    markerToggles: null,        // 由渲染层管理（null = 全部开启）
  };
  let merged = defaults;
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    merged = { ...defaults, ...raw, markerToggles: { ...defaults.markerToggles, ...(raw.markerToggles || {}) } };
  } catch {}
  // 配置中的目录无效时，自动探测游戏目录兜底
  const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };
  if (!exists(merged.logsPath) || !exists(merged.screenshotsPath)) {
    const det = detectGameDirs();
    if (!exists(merged.logsPath) && exists(det.logsPath)) merged.logsPath = det.logsPath;
    if (!exists(merged.screenshotsPath) && exists(det.screenshotsPath)) merged.screenshotsPath = det.screenshotsPath;
  }
  return merged;
}

function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch {}
}

let settings = null;

// ---------------------------------------------------------------------------
// 应用状态（广播给所有窗口）
// ---------------------------------------------------------------------------
const state = {
  mapId: null,        // detail.id
  mapKey: null,
  floor: 'auto',      // 'auto' | svgLayer 名
  position: null,     // {x, y(高度), z}
  quaternion: null,
  headingDeg: null,
  trail: [],          // [{x, z, at, file}]
  lastMapSource: null, // 'logs' | 'manual' | 'screenshot-check'
  logSummary: null,   // {session, version, lastEvent}
  mapsVersion: null,
};

let lastStateWrite = 0;

function broadcast(patch) {
  Object.assign(state, patch);
  const payload = { ...state, config: settings };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('state', payload);
  }
  // 运行状态转储（便于排查：地图识别/会话/监听状态/定位）
  // 关键变化立即落盘；高频位置更新最多每 500ms 一次
  const important = ['mapId', 'mapKey', 'position', 'lastFile', 'logWatcherStatus', 'shotWatcherStatus', 'floor']
    .some((k) => Object.prototype.hasOwnProperty.call(patch, k));
  const now = Date.now();
  if (important || now - lastStateWrite > 500) {
    lastStateWrite = now;
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), 'state.json'), JSON.stringify({
        at: new Date().toISOString(),
        mapKey: state.mapKey,
        mapName: state.mapId && mapsData.getById(state.mapId) ? mapsData.getById(state.mapId).name : null,
        lastMapSource: state.lastMapSource,
        position: state.position,
        headingDeg: state.headingDeg,
        trailLen: state.trail ? state.trail.length : 0,
        lastFile: state.lastFile || null,
        logWatcher: state.logWatcherStatus || null,
        shotWatcher: state.shotWatcherStatus || null,
      }, null, 2));
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// app:// 协议：renderer 静态资源与数据文件
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    // app://renderer/map.html -> host='renderer', path='/map.html'
    // 我们把 host+pathname 拼成仓库相对路径: renderer/map.html
    const rel = decodeURIComponent(url.hostname + url.pathname).replace(/^\/+/, '');
    const full = path.normalize(path.join(REPO_ROOT, rel));
    if (!full.startsWith(REPO_ROOT)) return new Response('forbidden', { status: 403 });
    try {
      const st = fs.statSync(full);
      const type = full.endsWith('.html') ? 'text/html'
        : full.endsWith('.css') ? 'text/css'
        : full.endsWith('.js') ? 'text/javascript'
        : full.endsWith('.svg') ? 'image/svg+xml'
        : full.endsWith('.json') ? 'application/json'
        : full.endsWith('.png') ? 'image/png'
        : full.endsWith('.webp') ? 'image/webp'
        : 'application/octet-stream';
      return new Response(fs.readFileSync(full), {
        headers: { 'content-type': type, 'cache-control': 'no-store' },
        status: 200,
      });
    } catch (e) {
      return new Response(String(e.message || e), { status: 404 });
    }
  });
}

// ---------------------------------------------------------------------------
// 状态流转
// ---------------------------------------------------------------------------
function applyLogEvent(ev) {
  let raidCode = null;
  if (ev.type === 'scene-preset') raidCode = ev.raidCode;
  else if (ev.type === 'network-game-create') raidCode = ev.raidCode;
  else if (ev.type === 'transit') return; // 仅参考

  if (raidCode) {
    const key = RAIDCODE_TO_MAPKEY[raidCode];
    const detail = key && mapsData.getByKey(key);
    if (detail && detail.id !== state.mapId) {
      broadcast({ mapId: detail.id, mapKey: detail.key, floor: 'auto', lastMapSource: 'logs' });
    }
  }
  broadcast({ logSummary: { ...state.logSummary, lastEvent: ev } });
}

function applyPosition(pos) {
  const detail = state.mapId ? mapsData.getById(state.mapId) : null;
  const headingDeg = pos.quaternion ? require('./src/projection').quaternionToEuler(pos.quaternion)[0] : null;
  const trail = [...state.trail, { x: pos.x, z: pos.z, at: pos.at, file: pos.file }].slice(-200);
  broadcast({
    position: { x: pos.x, y: pos.y, z: pos.z },
    quaternion: pos.quaternion,
    headingDeg,
    trail,
    lastFile: pos.file,
  });
  // 自动删除截图文件（读取后删除）
  if (settings.autoDeleteScreenshots && pos.file) {
    const full = path.join(settings.screenshotsPath, pos.file);
    fs.unlink(full, () => {});
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
let mainWin = null;
let miniWin = null;
let pinnedState = null; // 图钉化时的原窗口状态

function createMainWindow() {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  mainWin = new BrowserWindow({
    width: Math.min(1600, Math.max(1100, wa.width - 80)),
    height: Math.min(1000, Math.max(700, wa.height - 80)),
    minWidth: 900, minHeight: 560,
    backgroundColor: '#0b0e13',
    title: APP_TITLE,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWin.maximize(); // 高 DPI 缩放下最大化，保证足够的 CSS 视口
  mainWin.loadURL('app://renderer/map.html');
  // 关闭主窗口 = 退出程序（同时销毁悬浮小地图，避免残留进程）
  mainWin.on('closed', () => {
    mainWin = null;
    if (miniWin && !miniWin.isDestroyed()) miniWin.destroy();
    miniWin = null;
    if (process.platform !== 'darwin') app.quit();
  });

  // 布局自检：--debug-layout 时打印关键区域尺寸
  if (process.argv.includes('--debug-layout')) {
    mainWin.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const r = await mainWin.webContents.executeJavaScript(`(() => {
            const rect = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 }; };
            const p = document.querySelector('#legend-panel');
            return {
              viewport: [window.innerWidth, window.innerHeight], dpr: window.devicePixelRatio,
              topbar: rect('.topbar'), mapRoot: rect('#map-root'), statusbar: rect('.statusbar'),
              legend: rect('#legend-panel'), legendCollapsed: p ? p.classList.contains('collapsed') : null,
              controlsOverflow: (() => { const c = document.querySelector('.controls'); return c ? [c.scrollWidth, c.clientWidth] : null; })(),
              bodyScroll: [document.body.scrollWidth, document.body.clientWidth],
            };
          })()`);
          console.log('[layout]', JSON.stringify(r));
        } catch (e) { console.error('[layout] dump failed', e); }
      }, 3500);
    });
  }
}

function createMiniWindow() {
  if (miniWin && !miniWin.isDestroyed()) { miniWin.show(); return; }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const size = 300;
  miniWin = new BrowserWindow({
    width: size, height: size,
    x: width - size - 24, y: 24,
    frame: false, transparent: true, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  miniWin.setIgnoreMouseEvents(false);
  miniWin.loadURL('app://renderer/minimap.html');
  miniWin.on('closed', () => { miniWin = null; });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function setupIpc() {
  ipcMain.handle('state:get', () => state);
  ipcMain.handle('config:get', () => settings);
  ipcMain.handle('config:set', (_e, patch) => {
    settings = { ...settings, ...patch, markerToggles: { ...settings.markerToggles, ...(patch.markerToggles || {}) } };
    saveSettings();
    syncWatchers();
    return settings;
  });
  ipcMain.handle('map:list', () => mapsData.listMaps());
  ipcMain.handle('map:select', (_e, { key, id }) => {
    const detail = key ? mapsData.getByKey(key) : mapsData.getById(id);
    if (detail) broadcast({ mapId: detail.id, mapKey: detail.key, floor: 'auto', lastMapSource: 'manual' });
    return state;
  });
  ipcMain.handle('floor:set', (_e, floor) => { broadcast({ floor }); return state; });
  ipcMain.handle('window:pin', () => {
    if (!mainWin) return false;
    if (!pinnedState) {
      pinnedState = mainWin.getBounds();
      const wa = screen.getPrimaryDisplay().workArea;
      mainWin.setMinimumSize(360, 440);
      mainWin.setSize(430, 580);
      mainWin.setPosition(wa.x + wa.width - 470, wa.y + 90);
      mainWin.setAlwaysOnTop(true, 'screen-saver');
    } else {
      mainWin.setMinimumSize(1080, 680);
      mainWin.setSize(pinnedState.width, pinnedState.height);
      mainWin.setPosition(pinnedState.x, pinnedState.y);
      mainWin.setAlwaysOnTop(false);
      pinnedState = null;
    }
    return !!pinnedState;
  });
  ipcMain.handle('mini:toggle', () => {
    settings.miniVisible = !settings.miniVisible;
    saveSettings();
    if (settings.miniVisible) createMiniWindow(); else if (miniWin) miniWin.hide();
    return settings.miniVisible;
  });
  ipcMain.handle('mini:opacity', (_e, opacity) => { if (miniWin) miniWin.setOpacity(opacity); });
  ipcMain.handle('util:pick-screenshot', async () => {
    const r = await dialog.showOpenDialog(mainWin, {
      properties: ['openFile'], filters: [{ name: 'Screenshots', extensions: ['png'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const name = path.basename(r.filePaths[0]);
    const parsed = require('./src/parsers').parseScreenshotFilename(name);
    if (!parsed) return { error: '文件名中未找到坐标信息，请使用游戏内 PrintScreen 生成的截图' };
    applyPosition({ ...parsed, at: Date.now() });
    return parsed;
  });
  ipcMain.handle('view:sync', (_e, viewport) => {
    // 主图视口 -> 小地图
    if (miniWin && !miniWin.isDestroyed()) {
      miniWin.webContents.send('viewport:sync', viewport);
    }
  });
  ipcMain.handle('state:sync-mini', () => state);
  ipcMain.on('mini:resize', (_e, scale) => {
    if (miniWin) {
      const s = Math.round(240 * (scale || 1));
      miniWin.setSize(Math.min(s, 560), Math.min(s, 560));
    }
  });
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------
let logWatcher = null;
let shotWatcher = null;

function syncWatchers() {
  if (logWatcher) logWatcher.setRoot(settings.logsPath);
  if (shotWatcher) shotWatcher.setDir(settings.screenshotsPath);
}

function startWatchers() {
  logWatcher = new LogWatcher(settings.logsPath, (ev) => applyLogEvent(ev), (s) => {
    broadcast({ logWatcherStatus: s });
  });
  shotWatcher = new ScreenshotWatcher(settings.screenshotsPath, (pos) => applyPosition(pos), (s) => {
    broadcast({ shotWatcherStatus: s });
  });
  logWatcher.start();
  shotWatcher.start();
}

// ---------------------------------------------------------------------------
// 可视化自检（开发者工具）
// ---------------------------------------------------------------------------
async function runVisualTest() {
  const outDir = path.join(REPO_ROOT, 'test-artifacts');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const errors = [];
  mainWin.webContents.on('console-message', (event, level, message) => {
    const lvl = typeof level === 'object' ? level.level : level; // 兼容新旧签名
    if (lvl === 3 || lvl === 'error') errors.push(message);
  });
  mainWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[visual] did-fail-load', code, desc, url);
  });

  // 3 秒后注入工厂位置（模拟"日志识图 + 截图定位"完成态）
  setTimeout(() => {
    const factory = mapsData.getByKey('factory');
    if (factory) broadcast({ mapId: factory.id, mapKey: factory.key, floor: 'auto', lastMapSource: 'logs' });
    applyPosition({
      x: 58.02, y: 1.75, z: 49.47,
      quaternion: [0.01518, 0.90924, -0.03197, 0.41476],
      at: Date.now(), file: 'sim.png',
    });
    console.log('[visual] state injected');
  }, 3000);

  setTimeout(async () => {
    try {
      // 截图1: 主窗口（已自动注入工厂位置）
      const info = await mainWin.webContents.executeJavaScript(`({
        worldTransform: document.querySelector('.world')?.getAttribute('transform'),
        markers: document.querySelectorAll('.map-marker').length,
        player: !!document.querySelector('.mapstage-overlay svg g g'),
        legendRows: document.querySelectorAll('.legend-item').length,
        statusText: document.querySelector('.statusbar')?.innerText.slice(0, 200),
        pillTexts: Array.from(document.querySelectorAll('.map-marker text')).slice(0, 8).map(t => t.textContent),
        markerHtml: Array.from(document.querySelectorAll('.map-marker')).slice(0, 2).map(m => m.outerHTML.slice(0, 1400)),
        dbg: document.querySelector('.mapstage') ? window.__viewDebug : null,
      })`);
      console.log('[visual] MAIN:', JSON.stringify(info));
      const img = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'main.png'), img.toPNG());
      console.log('[visual] main.png saved');
      // 用"真实滚轮事件"缩放（走 onwheel 处理器路径，验证标记同步）
      const wheelRes = await mainWin.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('.mapstage');
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const s0 = window.__view.view.scale;
        for (let i = 0; i < 4; i++) {
          el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
        }
        const s1 = window.__view.view.scale;
        for (let i = 0; i < 7; i++) {
          el.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
        }
        const s2 = window.__view.view.scale;
        return { before: s0, zoomIn: s1, zoomBack: s2 };
      })()`);
      console.log('[visual] WHEEL:', JSON.stringify(wheelRes));
      // 放大后截图（图标应变大且仍与地图对齐）
      const imgIn = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'wheel-zoom-in.png'), imgIn.toPNG());
      console.log('[visual] wheel-zoom-in.png saved');
      // 缩小到整图视图（走滚轮路径）
      await mainWin.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('.mapstage');
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        for (let i = 0; i < 10; i++) {
          el.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
        }
        return true;
      })()`);
      await new Promise((r2) => setTimeout(r2, 300));
      const imgOut = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'wheel-zoom-out.png'), imgOut.toPNG());
      console.log('[visual] wheel-zoom-out.png saved');
      // 真实鼠标拖拽事件（验证标记跟随地图移动；rAF 节流渲染，需等一帧再断言）
      await mainWin.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('.mapstage');
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
        for (let i = 1; i <= 5; i++) {
          window.dispatchEvent(new MouseEvent('mousemove', { clientX: cx - i * 60, clientY: cy - i * 30, bubbles: true, cancelable: true }));
        }
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: cx - 300, clientY: cy - 150, bubbles: true, cancelable: true }));
        return true;
      })()`);
      await new Promise((r2) => setTimeout(r2, 350));
      const dragRes = await mainWin.webContents.executeJavaScript(`(() => {
        const grab = (sel) => document.querySelector(sel)?.getAttribute('transform');
        return { world: grab('.world'), m0: grab('.map-marker') };
      })()`);
      console.log('[visual] DRAG after:', JSON.stringify(dragRes));
      const imgDrag = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'drag.png'), imgDrag.toPNG());
      console.log('[visual] drag.png saved');
      // 尺子测距（真实点击路径）
      await mainWin.webContents.executeJavaScript(`window.__view.setMeasureMode(true); true`);
      await mainWin.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('.mapstage');
        const r = el.getBoundingClientRect();
        const click = (x, y) => {
          el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
          window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
        };
        click(r.left + r.width * 0.35, r.top + r.height * 0.45);
        click(r.left + r.width * 0.6, r.top + r.height * 0.55);
        return true;
      })()`);
      await new Promise((r2) => setTimeout(r2, 300));
      const imgMeasure = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'measure.png'), imgMeasure.toPNG());
      console.log('[visual] measure.png saved');
      await mainWin.webContents.executeJavaScript(`window.__view.setMeasureMode(false); true`);
      // 恢复到默认视图避免影响后续场景
      await mainWin.webContents.executeJavaScript(`
        window.__view.view.scale = window.__view.refScale * 1.6;
        window.__view.setViewport(window.__view.getViewport());
        true`);
    } catch (e) { console.error('[visual] main capture failed', e); }
  }, 6500);

  setTimeout(async () => {
    try {
      // 截图2: 打开高级设置对话框
      await mainWin.webContents.executeJavaScript(`document.getElementById('btn-settings').click(); true`);
      await new Promise((r) => setTimeout(r, 400));
      const img = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'settings.png'), img.toPNG());
      console.log('[visual] settings.png saved');
    } catch (e) { console.error('[visual] settings capture failed', e); }
  }, 8200);

  setTimeout(async () => {
    try {
      // 截图3: 关闭图例全部图钉 → 验证图钉配置生效
      await mainWin.webContents.executeJavaScript(`
        document.getElementById('settings-ok').click();
        document.getElementById('legend-panel').classList.remove('collapsed');
        document.getElementById('legend-none').click();
        true`);
      await new Promise((r) => setTimeout(r, 400));
      const img = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'legend-none.png'), img.toPNG());
      console.log('[visual] legend-none.png saved (markers=' +
        (await mainWin.webContents.executeJavaScript(`document.querySelectorAll('.map-marker').length`)) + ')');
      // 恢复全部图钉，避免配置持久化影响下一次演示
      await mainWin.webContents.executeJavaScript(`document.getElementById('legend-all').click(); true`);
    } catch (e) { console.error('[visual] legend-none capture failed', e); }
    createMiniWindow();
  }, 9500);

  setTimeout(async () => {
    try {
      // 截图4: 灯塔（1.1.5.0 新增 BTR 站点 8 个 + 赛季文件刷点 32 个）
      const lh = mapsData.getByKey('lighthouse');
      if (lh) broadcast({ mapId: lh.id, mapKey: lh.key, floor: 'auto', lastMapSource: 'logs' });
      // 等待切图与标记渲染完成（rAF 节流，需等实际绘制帧）
      await new Promise((r) => setTimeout(r, 900));
      const ready = await mainWin.webContents.executeJavaScript(`({
        dom: document.querySelectorAll('.map-marker').length,
        key: window.__view.detail?.key,
        cache: (window.__view.markerCache || []).length,
      })`);
      console.log('[visual] lighthouse ready', JSON.stringify(ready));
      const season = await mainWin.webContents.executeJavaScript(`(() => {
        const groups = {};
        for (const m of (window.__view.markerCache || [])) groups[m.group] = (groups[m.group] || 0) + 1;
        return {
          legendSections: Array.from(document.querySelectorAll('.legend-title')).map((t) => t.textContent),
          legendIcons: document.querySelectorAll('.legend-icon').length,
          seasonRows: Array.from(document.querySelectorAll('.legend-item'))
            .filter((r) => r.querySelector('input').dataset.group.startsWith('season:'))
            .map((r) => r.innerText.replace(/\\s+/g, ' ')),
          seasonCount: (groups['season:pmc'] || 0) + (groups['season:technical'] || 0),
          btrStops: groups.btrStop,
        };
      })()`);
      console.log('[visual] LIGHTHOUSE:', JSON.stringify(season));
      const img = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'lighthouse.png'), img.toPNG());
      console.log('[visual] lighthouse.png saved');
      // 关掉全部"赛季文件"图钉 -> 标记数应正好减少 seasonCount（验证图钉开关生效）
      const before = await mainWin.webContents.executeJavaScript(`document.querySelectorAll('.map-marker').length`);
      await mainWin.webContents.executeJavaScript(`(() => {
        const rows = Array.from(document.querySelectorAll('.legend-item'))
          .filter((r) => r.querySelector('input').dataset.group.startsWith('season:'));
        for (const r of rows) { const i = r.querySelector('input'); if (i.checked) i.click(); }
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 400));
      const after = await mainWin.webContents.executeJavaScript(`document.querySelectorAll('.map-marker').length`);
      console.log('[visual] season 图钉开关: ' + before + ' -> ' + after + ' (应减少 ' + season.seasonCount + ')');
      const img2 = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'season-off.png'), img2.toPNG());
      // 恢复图钉
      await mainWin.webContents.executeJavaScript(`(() => {
        const rows = Array.from(document.querySelectorAll('.legend-item'))
          .filter((r) => r.querySelector('input').dataset.group.startsWith('season:'));
        for (const r of rows) { const i = r.querySelector('input'); if (!i.checked) i.click(); }
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      // 截图5: 放大到某个赛季文件刷点 + 真实点击标记查看信息卡片
      const zoomed = await mainWin.webContents.executeJavaScript(`(() => {
        const v = window.__view;
        const m = (v.markerCache || []).find((x) => String(x.group).startsWith('season:'));
        if (!m) return null;
        const p = v.proj.project(m.x, m.z);
        v.follow = false;
        v.view.cx = p.x; v.view.cy = p.y; v.view.scale = 7;
        v.setViewport(v.getViewport());
        return { group: m.group, label: m.label };
      })()`);
      console.log('[visual] season zoom ->', JSON.stringify(zoomed));
      await new Promise((r) => setTimeout(r, 400));
      const img3 = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'season-detail.png'), img3.toPNG());
      const clicked = await mainWin.webContents.executeJavaScript(`(() => {
        const el = Array.from(document.querySelectorAll('.map-marker'))
          .find((e) => (e.querySelector('title')?.textContent || '').startsWith('赛季文件'));
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      const cardText = await mainWin.webContents.executeJavaScript(
        `document.getElementById('info-card').innerText.replace(/\\s+/g, ' ').slice(0, 200)`
      );
      console.log('[visual] season card clicked=' + clicked + ' card=' + JSON.stringify(cardText));
      const img4 = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'season-card.png'), img4.toPNG());
      // 参考截图缩略图是否真的加载（打包后 app:// + webp 关键路径）
      const thumb = await mainWin.webContents.executeJavaScript(`(() => {
        const i = document.getElementById('ref-shot');
        return i ? { src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth, h: i.naturalHeight } : null;
      })()`);
      console.log('[visual] ref-shot thumb =', JSON.stringify(thumb));
      // 点击缩略图 -> 打开大图查看器（真实鼠标事件）
      const viewerOpen = await mainWin.webContents.executeJavaScript(`(() => {
        const i = document.getElementById('ref-shot');
        if (!i) return false;
        i.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        const v = document.getElementById('shot-viewer');
        return !v.classList.contains('hidden');
      })()`);
      await new Promise((r) => setTimeout(r, 700));
      const viewerState = await mainWin.webContents.executeJavaScript(`(() => {
        const i = document.getElementById('shot-viewer-img');
        return { open: !document.getElementById('shot-viewer').classList.contains('hidden'), ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth, h: i.naturalHeight, caption: document.getElementById('shot-viewer-caption').textContent };
      })()`);
      console.log('[visual] shot viewer open=' + viewerOpen + ' state=' + JSON.stringify(viewerState));
      const img5 = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'season-shot.png'), img5.toPNG());
      // 滚轮放大 + Esc 关闭
      const zoomedShot = await mainWin.webContents.executeJavaScript(`(() => {
        const v = document.getElementById('shot-viewer');
        v.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
        v.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
        return document.getElementById('shot-viewer-img').style.transform;
      })()`);
      await mainWin.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
      await new Promise((r) => setTimeout(r, 200));
      const closed = await mainWin.webContents.executeJavaScript(`document.getElementById('shot-viewer').classList.contains('hidden')`);
      console.log('[visual] shot viewer transform=' + JSON.stringify(zoomedShot) + ' closedByEsc=' + closed);
      console.log('[visual] season-detail.png / season-card.png / season-shot.png saved');
    } catch (e) { console.error('[visual] lighthouse capture failed', e); }
  }, 10000);

  setTimeout(async () => {
    try {
      if (miniWin) {
        const miniInfo = await miniWin.webContents.executeJavaScript(`({
          readyState: document.readyState,
          mapstage: !!document.querySelector('.mapstage'),
          markers: document.querySelectorAll('.map-marker').length,
          player: !!document.querySelector('.mapstage-overlay svg g g'),
          worldTransform: document.querySelector('.world')?.getAttribute('transform'),
          rects: window.__rects || [],
        })`);
        console.log('[visual] MINI:', JSON.stringify(miniInfo));
        const img = await miniWin.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'mini.png'), img.toPNG());
        console.log('[visual] mini.png saved');
      }
    } catch (e) { console.error('[visual] mini capture failed', e); }
    console.log('[visual] renderer errors:', errors.length ? JSON.stringify(errors, null, 2) : 'NONE');
    app.exit(0);
  }, 19000);
}
app.whenReady().then(() => {
  settings = loadSettings();
  mapsData.load(path.join(DATA_DIR, 'maps-dump.json'));
  state.mapsVersion = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'maps-dump.json'), 'utf-8')).fetchedAt || null;

  registerAppProtocol();
  Menu.setApplicationMenu(null);
  setupIpc();
  createMainWindow();
  startWatchers();
  if (settings.miniVisible) createMiniWindow();

  // html 冒烟自检： npm run smoke（3 秒后自动退出）
  if (process.argv.includes('--smoke-test')) {
    setTimeout(() => {
      console.log('[smoke] OK windows=' + BrowserWindow.getAllWindows().length);
      app.exit(0);
    }, 4000);
  }

  // 可视化自检： npm run visual-test
  // 自动截取主窗口与小地图窗口到 test-artifacts/，并收集渲染层报错
  if (process.argv.includes('--visual-test')) runVisualTest();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (logWatcher) logWatcher.stop();
  if (shotWatcher) shotWatcher.stop();
});
