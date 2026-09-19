'use strict';

/**
 * 应用主进程：
 *  - 窗口：主地图窗 + 圆形小地图悬浮窗
 *  - 服务：日志监听（自动识别地图）、截图监听（定位）
 *  - 状态中枢：把 map/floor/position/heading/trail 广播给所有窗口
 *  - 协议：app:// 提供本地数据（renderer 同源 fetch SVG/JSON）
 *  - 纯离线：无任何网络请求
 */
const { app, BrowserWindow, ipcMain, dialog, protocol, net, Menu, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { pathToFileURL } = require('url');
const os = require('os');

const mapsData = require('./src/maps-data');
const annotations = require('./src/annotations');
const { LogWatcher } = require('./src/log-watcher');
const { ScreenshotWatcher } = require('./src/screenshot-watcher');
const roomClientModule = require('./src/room-client');
const { RoomClient, probeServer, randomPeerId } = roomClientModule;
const { RAIDCODE_TO_MAPKEY, MAPKEY_TO_SVG } = require('./src/constants');
const { clampToWorkArea, dragTarget, defaultPos } = require('./src/mini-geometry');

// 固定 userData 目录（保证开发环境与打包后共用同一份配置）
app.setPath('userData', path.join(app.getPath('appData'), 'tarkov-offline-map'));

const APP_TITLE = '塔可夫地图';
const REPO_ROOT = __dirname;
const DATA_DIR = path.join(REPO_ROOT, 'data');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const ANNOTATIONS_FILE = path.join(app.getPath('userData'), 'annotations.json');
let annoSaveTimer = null;

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
    miniPos: null,               // 小地图悬浮窗位置 {x,y}（拖动后自动记忆）
    miniRadius: 55,
    miniOpacity: 0.9,            // 雷达整体透明度（默认"有一点点透明"）
    miniRotate: false,           // 雷达是否随角色朝向旋转（默认 false = 固定地图方向）
    miniAutoCenter: true,        // 定位后自动居中到玩家
    miniAutoFloor: true,         // 按玩家高度自动切换楼层层级
    miniClickThrough: false,     // 点击穿透：看得到、点不着（悬停右下"解锁"小块可恢复）
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
    labelScale: 1,              // 地名文字大小乘数
    markerToggles: null,        // 由渲染层管理（null = 全部开启）
    // 任务侧边栏：勾选的任务 id + 面板状态（由渲染层管理，这里只给默认值）
    quests: {
      checked: [],              // 已勾选（"我接了的任务"），跨图/跨会话保留
      open: true,               // 面板是否展开
      mapOnly: true,            // 只看当前地图
      locationOnly: true,       // 只看有地点的
      showKill: false,          // 显示击杀/刷怪区（默认关：区域很大很糊）
      checkedOnly: false,       // 只看已勾选
      trader: '',               // 商人过滤（空 = 全部）
      levelMax: 0,              // 等级上限（0 = 不限）
      opacity: 0.25,            // 区域填充透明度
    },
    // 房间联机（v2.0）：默认**不联机**，什么都不填时一行网络代码都不会执行
    room: {
      enabled: false,           // 总开关
      url: '',                  // 服务器地址（IP 或域名，可带端口/协议）
      port: 8787,
      roomId: '',               // 房间号（你们自己商量的暗号）
      pass: '',                 // 口令（可空）
      nick: '',                 // 昵称（地图上用第一个字 + 箭头）
      peerId: '',               // 身份标识（自动生成，用来固定颜色与图例开关）
      sharePos: true,           // 共享我的定位
      shareAnno: true,          // 共享我的标注
    },
  };
  let merged = defaults;
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    merged = {
      ...defaults,
      ...raw,
      markerToggles: { ...defaults.markerToggles, ...(raw.markerToggles || {}) },
      room: { ...defaults.room, ...(raw.room || {}) },
    };
  } catch {}
  // 身份标识第一次用的时候生成一次就固定下来：换房间/重连/重启后颜色和图例勾选不会跳
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(String(merged.room.peerId || ''))) {
    merged.room.peerId = randomPeerId();
  }
  // 一次性迁移：0.18 是"每个任务一个颜色 + 实心圆点"时代的老默认值，现在任务标记
  // 统一成图例的橘色半透明样式（默认 0.25）。只搬"恰好还是老默认"的存档，
  // 用户自己调过的数值（0.20/0.30…）不动。
  if (merged.quests && Number(merged.quests.opacity) === 0.18) merged.quests.opacity = 0.25;
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
  positionAt: null,    // 最近一次截图定位的时间戳（用于判断轨迹是不是上一局的）
  trail: [],          // [{x, z, at, file}]
  lastMapSource: null, // 'logs' | 'manual' | 'screenshot-check'
  logSummary: null,   // {session, version, lastEvent}
  mapsVersion: null,
  appVersion: null,   // 关于页面显示用（app.getVersion()）
};

let lastStateWrite = 0;

function broadcast(patch) {
  Object.assign(state, patch);
  // 换图（日志识别 / 手动选图 / 楼层）顺手上报给房间：队友能看到"他在哪张图"
  if (room && Object.prototype.hasOwnProperty.call(patch, 'mapId')) room.setMap(state.mapId);
  const payload = { ...state, config: settings, room: room ? room.snapshot() : null };
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
  let newRaid = false;
  if (ev.type === 'scene-preset') { raidCode = ev.raidCode; newRaid = true; }
  else if (ev.type === 'network-game-create') { raidCode = ev.raidCode; newRaid = true; }
  else if (ev.type === 'transit') return; // 仅参考

  // 进图行 = 新一局（或过图）：上一局的玩家位置与轨迹都不再适用，
  // 否则新局一开始就会在图上留一条上一局的假路线，并且玩家箭头停在旧位置。
  // 只在"轨迹比这次进图更旧"时才清：应用启动/重连日志时会回放历史进图行，
  // 那种情况下不能把当前这一局的定位抹掉。
  if (newRaid && (state.positionAt == null || !Number.isFinite(ev.ts) || state.positionAt < ev.ts)) {
    const had = (state.trail && state.trail.length) || state.position;
    if (had) appLog(`new raid (${ev.bundle || ev.raidCode || ev.type}): 清空轨迹 ${state.trail.length} 点 + 玩家位置`);
    broadcast({
      trail: [], position: null, quaternion: null, headingDeg: null,
      positionAt: null, lastFile: null, floor: 'auto',
    });
  }

  if (raidCode) {
    const key = RAIDCODE_TO_MAPKEY[raidCode];
    const detail = key && mapsData.getByKey(key);
    if (!detail) {
      appLog(`UNMAPPED raidCode: ${raidCode} by ${ev.type} (日志里有这张图，但表里没有)`);
    } else if (detail.id !== state.mapId) {
      appLog(`map switch -> ${detail.key} (${detail.name}) by ${ev.type} raidCode=${raidCode}`);
      broadcast({ mapId: detail.id, mapKey: detail.key, floor: 'auto', lastMapSource: 'logs' });
    }
  }
  // 认不出来的 bundle 由 logWatcherStatus('unknown-map') 统一记日志（见 startWatchers）
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
    positionAt: pos.at || Date.now(),
    lastFile: pos.file,
  });
  pushPosition(); // 房间里的队友也要看到这次定位（截图定位是事件式的，有就发）
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
let miniWatchdog = null;
let miniHidden = false; // 小地图当前是否处于"隐藏"意图（hide() 与 blur 事件有竞态，靠它兜住）
let pinnedState = null; // 图钉化时的原窗口状态
const MINI_SIZE = 300;  // 小地图窗口边长（CSS px）

// ---------------------------------------------------------------------------
// 小地图窗口健康检查：透明无边框窗口在 Windows 上可能被系统吞掉层级/停止重绘/崩溃，
// 一旦发生就"看起来窗口消失了"。这里做日志 + 自愈（置顶、强制重绘、必要时重建）。
// ---------------------------------------------------------------------------
function miniLog(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  console.log('[mini]', msg);
  try {
    const file = path.join(app.getPath('userData'), 'mini.log');
    try { if (fs.statSync(file).size > 256 * 1024) fs.writeFileSync(file, ''); } catch {}
    fs.appendFileSync(file, line);
  } catch {}
}

// 地图识别诊断日志（userData/app.log）：记录会话切换、地图切换、认不出来的图。
// 用户报"没切换地图"时，先看这个文件就能定位是日志没读到、还是 bundle 名没认出来。
function appLog(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  console.log('[app]', msg);
  try {
    const file = path.join(app.getPath('userData'), 'app.log');
    try { if (fs.statSync(file).size > 512 * 1024) fs.writeFileSync(file, ''); } catch {}
    fs.appendFileSync(file, line);
  } catch {}
}

function miniAlive() {
  return !!miniWin && !miniWin.isDestroyed();
}

function miniStatus() {
  const alive = miniAlive();
  let scaleFactor = null;
  if (alive) {
    try { scaleFactor = screen.getDisplayMatching(miniWin.getBounds()).scaleFactor; } catch {}
  }
  return {
    enabled: !!(settings && settings.miniVisible),
    alive,
    visible: alive ? miniWin.isVisible() : false,
    crashed: alive ? miniWin.webContents.isCrashed() : false,
    focusable: alive && typeof miniWin.isFocusable === 'function' ? miniWin.isFocusable() : null,
    ignoreMouseEvents: !!miniIgnoreMouse,
    scaleFactor,
    bounds: alive ? miniWin.getBounds() : null,
  };
}

// 点击穿透状态（Electron 没有对应的读取 API，自己记一份）
let miniIgnoreMouse = false;
// 解锁小条：位置由渲染层上报（DIP，相对窗口左上角），命中判定在主进程做
// （实测 Windows 上 setIgnoreMouseEvents(true,{forward:true}) 并不会把真实鼠标移动
//   转发给渲染层，所以只能像拖动那样在主进程轮询光标）
//   near  = 光标放在雷达圆盘上（或小条上）  -> 让渲染层把「锁/解锁」显示出来
//   onBar = 光标正好在小条上               -> 临时恢复交互，按钮才点得到
let miniUnlockRect = null;
let miniUnlockNear = false;
let miniUnlockOnBar = false;
let miniUnlockTimer = null;

function stopMiniUnlockWatch() {
  if (miniUnlockTimer) { clearInterval(miniUnlockTimer); miniUnlockTimer = null; }
  // 解锁后必须把"放在雷达上"的状态清掉，否则渲染层会一直显示锁/解锁小条
  if (miniUnlockNear || miniUnlockOnBar) {
    miniUnlockNear = false;
    miniUnlockOnBar = false;
    if (miniAlive()) {
      try { miniWin.webContents.send('mini:lock-hot', { near: false, onBar: false }); } catch {}
    }
  }
}

/** 锁定（点击穿透）期间轮询光标：放在雷达上显示按钮，只在小条上才接管鼠标 */
function startMiniUnlockWatch() {
  stopMiniUnlockWatch();
  if (!miniAlive() || !settings.miniClickThrough) return;
  miniUnlockTimer = setInterval(() => {
    if (!miniAlive() || !settings.miniClickThrough) return stopMiniUnlockWatch();
    try {
      const b = miniWin.getBounds();
      const c = screen.getCursorScreenPoint();
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      const rDisc = b.width / 2 + 4; // 圆盘半径（窗口是正方形，圆盘铺满）
      const dx = c.x - cx, dy = c.y - cy;
      const onDisc = dx * dx + dy * dy <= rDisc * rDisc;
      const r = miniUnlockRect || { x: b.width - 60, y: b.height - 30, w: 52, h: 24 }; // 兜底：右下角
      const pad = 6;
      const onBar = c.x >= b.x + r.x - pad && c.x <= b.x + r.x + r.w + pad
        && c.y >= b.y + r.y - pad && c.y <= b.y + r.y + r.h + pad;
      const near = onDisc || onBar;
      if (near !== miniUnlockNear || onBar !== miniUnlockOnBar) {
        miniUnlockNear = near;
        miniUnlockOnBar = onBar;
        miniWin.setIgnoreMouseEvents(!onBar, { forward: true });
        miniIgnoreMouse = !onBar;
        try { miniWin.webContents.send('mini:lock-hot', { near, onBar }); } catch {}
        miniLog(`lock bar near=${near} onBar=${onBar} -> mouse ${onBar ? 'interactive' : 'click-through'}`);
      }
    } catch (e) { miniLog('unlock watch failed: ' + e.message); }
  }, 60);
}

/** 应用"点击穿透"设置：锁定时鼠标事件直接穿到游戏里 */
function applyMiniClickThrough() {
  if (!miniAlive()) { stopMiniUnlockWatch(); return; }
  const locked = !!settings.miniClickThrough;
  try {
    miniWin.setIgnoreMouseEvents(locked, { forward: true });
    miniIgnoreMouse = locked;
    if (locked) startMiniUnlockWatch(); else stopMiniUnlockWatch();
    miniLog(`click-through ${locked ? 'on' : 'off'}`);
  } catch (e) { miniLog('click-through failed: ' + e.message); }
}

function broadcastMiniStatus() {
  try { broadcast({ miniStatus: miniStatus() }); } catch {}
}

/** 重新置顶（不抢焦点）。注意：绝不作用于隐藏状态的窗口——
 *  Windows 上对隐藏窗口调用 setAlwaysOnTop/moveTop 会把它重新显示出来，
 *  会导致"点了关闭小地图又自己冒出来"。 */
function miniReassert() {
  if (!miniAlive()) return;
  try {
    if (miniHidden || !miniWin.isVisible()) return;
    miniWin.setAlwaysOnTop(true, 'screen-saver');
    miniWin.moveTop();
  } catch (e) { miniLog('reassert failed: ' + e.message); }
}

/** 看门狗：小地图"消失"时自动恢复；同时周期性强制重绘防透明表面变空白 */
function startMiniWatchdog() {
  if (miniWatchdog) clearInterval(miniWatchdog);
  miniWatchdog = setInterval(() => {
    if (!settings || !settings.miniVisible) return;
    if (process.argv.includes('--visual-test')) console.log('[mini] watchdog tick', JSON.stringify(miniStatus()));
    try {
      if (!miniAlive()) { miniLog('watchdog: window missing -> recreate'); createMiniWindow('watchdog'); return; }
      if (miniWin.webContents.isCrashed()) { miniLog('watchdog: crashed -> reload'); miniWin.webContents.reload(); return; }
      if (!miniWin.isVisible()) { miniLog('watchdog: hidden -> show'); miniHidden = false; miniWin.show(); return; }
      // 尺寸自愈：拖动/系统 DPI 取整可能让窗口越变越大，这里纠正回正方形
      const wb = miniWin.getBounds();
      if (wb.width !== MINI_SIZE || wb.height !== MINI_SIZE) {
        miniLog(`watchdog: size ${wb.width}x${wb.height} -> ${MINI_SIZE}`);
        placeMini(wb.x, wb.y);
        broadcastMiniStatus();
      }
      miniReassert();
      miniWin.webContents.invalidate();
    } catch (e) { miniLog('watchdog error: ' + e.message); }
  }, 2500);
}

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
    stopMiniDrag('main-closed');
    stopMiniPan('main-closed');
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

// ---------------------------------------------------------------------------
// 小地图拖动：渲染层按下 -> 主进程按光标位置移动窗口
// （渲染层 mousemove 只在指针位于窗口内可靠；主进程轮询光标则移出窗口也不丢）
// ---------------------------------------------------------------------------
let miniDrag = null; // { timer, offset:{x,y}, started }

function miniWorkArea(point) {
  try {
    const d = point ? screen.getDisplayNearestPoint(point) : screen.getPrimaryDisplay();
    return d.workArea;
  } catch {
    return screen.getPrimaryDisplay().workArea;
  }
}

/** 把悬浮窗钉回"正方形 + 指定位置"。
 *  坑：Windows 上 150% 缩放（DIP→物理像素取整）时，反复 setPosition 会让窗口尺寸
 *  每次"漂"大 1px，拖动几秒就从 300 变成 700+。所以拖动时一律用 setBounds 带上尺寸。 */
function placeMini(x, y) {
  if (!miniAlive()) return;
  const b = miniWin.getBounds();
  if (b.width === MINI_SIZE && b.height === MINI_SIZE && b.x === x && b.y === y) return;
  miniWin.setBounds({ x, y, width: MINI_SIZE, height: MINI_SIZE }, false);
}

function stopMiniDrag(reason = 'release') {
  if (!miniDrag) return;
  clearInterval(miniDrag.timer);
  miniDrag = null;
  if (miniAlive()) {
    try {
      const b = miniWin.getBounds();
      settings.miniPos = { x: b.x, y: b.y };
      saveSettings();
      // 松手时把尺寸也钉回来（防御：历史版本累积放大过的窗口会立刻恢复正常）
      if (b.width !== MINI_SIZE || b.height !== MINI_SIZE) {
        miniLog(`drag end: size ${b.width}x${b.height} -> ${MINI_SIZE}`);
        placeMini(b.x, b.y);
      }
      miniWin.webContents.invalidate();
      broadcastMiniStatus();
      miniLog(`drag end (${reason}) pos=${b.x},${b.y}`);
    } catch (e) { miniLog('drag end failed: ' + e.message); }
  } else {
    miniLog(`drag end (${reason}) 无窗口`);
  }
}

function startMiniDrag() {
  if (!miniAlive() || miniWin.isDestroyed()) return false;
  if (miniDrag) stopMiniDrag('restart');
  const b = miniWin.getBounds();
  const cursor = screen.getCursorScreenPoint();
  const offset = { x: cursor.x - b.x, y: cursor.y - b.y };
  const started = Date.now();
  miniLog(`drag start cursor=${cursor.x},${cursor.y} offset=${offset.x},${offset.y} bounds=${b.x},${b.y} size=${b.width}x${b.height}`);
  miniDrag = {
    offset,
    started,
    timer: setInterval(() => {
      if (!miniAlive()) return stopMiniDrag('window-gone');
      if (Date.now() - started > 15000) return stopMiniDrag('timeout');
      if (!miniWin.isVisible()) return stopMiniDrag('hidden');
      try {
        const c = screen.getCursorScreenPoint();
        const next = dragTarget(c, offset, MINI_SIZE, miniWorkArea(c));
        placeMini(next.x, next.y);
      } catch (e) { stopMiniDrag('error: ' + e.message); }
    }, 12),
  };
  return true;
}

// ---------------------------------------------------------------------------
// 雷达"Ctrl + 拖动 = 平移圆盘里的地图"
// 和拖动窗口一样由主进程按真实光标位置轮询，而不是让渲染层收 pointermove：
//  - 透明无边框窗口上 setPointerCapture 不可靠，光标一离开 300px 圆盘事件就断了，
//    表现为"按住 Ctrl 拖，地图只动一点点"；
//  - 主进程轮询则光标移到哪、甚至移出屏幕都不会丢。
// 主进程只负责报光标位置，真正的平移换算在渲染层（和主窗口地图拖动共用一份数学）。
// ---------------------------------------------------------------------------
let miniPan = null; // { timer, started, last:{x,y} }

function stopMiniPan(reason = 'release') {
  if (!miniPan) return;
  clearInterval(miniPan.timer);
  miniPan = null;
  miniLog(`pan end (${reason})`);
  if (miniAlive()) { try { miniWin.webContents.invalidate(); } catch {} }
}

function startMiniPan() {
  if (!miniAlive() || miniWin.isDestroyed()) return null;
  if (miniPan) stopMiniPan('restart');
  const cursor = screen.getCursorScreenPoint();
  const started = Date.now();
  miniLog(`pan start cursor=${cursor.x},${cursor.y}`);
  miniPan = {
    started,
    last: { x: cursor.x, y: cursor.y },
    timer: setInterval(() => {
      if (!miniAlive()) return stopMiniPan('window-gone');
      if (Date.now() - started > 15000) return stopMiniPan('timeout');
      try {
        const c = screen.getCursorScreenPoint();
        if (c.x === miniPan.last.x && c.y === miniPan.last.y) return;
        miniPan.last = { x: c.x, y: c.y };
        miniWin.webContents.send('mini:pan', { x: c.x, y: c.y });
      } catch (e) { stopMiniPan('error: ' + e.message); }
    }, 12),
  };
  return cursor; // 渲染层拿它当基准点
}

// ---------------------------------------------------------------------------
// 真实按键状态助手（Windows）
// 坑：雷达窗口 focusable:false（键盘焦点在游戏那边），实测渲染层 pointerdown 里的
// e.ctrlKey 可能是 false —— 于是"按住 Ctrl 拖动"会被当成"拖动窗口"。
// 解决办法：直接问系统。启动时拉一个常驻 PowerShell，问一次 Ctrl 是否按着（毫秒级往返），
// 拿不到就返回 null，调用方退回 ctrlKey 判定。
// ---------------------------------------------------------------------------
let keyHelper = null; // { proc, queue: [], buf: '', dead: bool }

const KEY_HELPER_PS = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$o = [Console]::Out',
  '$i = [Console]::In',
  'while ($true) {',
  '  $line = $i.ReadLine()',
  '  if ($line -eq $null) { break }',
  '  if ([System.Windows.Forms.Control]::ModifierKeys -band [System.Windows.Forms.Keys]::Control) { $o.WriteLine("1") } else { $o.WriteLine("0") }',
  '  $o.Flush()',
  '}',
].join('\n');

function startKeyHelper() {
  if (keyHelper) return;
  try {
    const proc = require('child_process').spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', KEY_HELPER_PS,
    ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    keyHelper = { proc, queue: [], buf: '', dead: false };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      keyHelper.buf += chunk;
      let i;
      while ((i = keyHelper.buf.indexOf('\n')) >= 0) {
        const line = keyHelper.buf.slice(0, i).trim();
        keyHelper.buf = keyHelper.buf.slice(i + 1);
        const resolve = keyHelper.queue.shift();
        if (resolve) resolve(line === '1' ? true : line === '0' ? false : null);
      }
    });
    const fail = () => {
      if (!keyHelper) return;
      keyHelper.dead = true;
      while (keyHelper.queue.length) keyHelper.queue.shift()(null);
    };
    proc.on('error', fail);
    proc.on('exit', fail);
  } catch { keyHelper = null; }
}

/** Ctrl 现在按着吗？拿不到返回 null */
function ctrlKeyDown() {
  if (!keyHelper || keyHelper.dead || !keyHelper.proc.stdin.writable) return Promise.resolve(null);
  return new Promise((resolve) => {
    keyHelper.queue.push(resolve);
    try { keyHelper.proc.stdin.write('?\n'); } catch { resolve(null); }
    setTimeout(() => {
      const i = keyHelper && keyHelper.queue.indexOf(resolve);
      if (i >= 0) { keyHelper.queue.splice(i, 1); resolve(null); } // 超时兜底
    }, 800);
  });
}

function stopKeyHelper() {
  if (!keyHelper) return;
  try { keyHelper.proc.stdin.end(); } catch {}
  try { keyHelper.proc.kill(); } catch {}
  keyHelper = null;
}

function createMiniWindow(reason = 'startup') {
  if (miniWin && !miniWin.isDestroyed()) {
    miniHidden = false;
    if (!miniWin.isVisible()) miniWin.show();
    miniWin.setAlwaysOnTop(true, 'screen-saver');
    miniWin.moveTop();
    try { miniWin.webContents.invalidate(); } catch {}
    applyMiniClickThrough();
    miniLog(`reuse (${reason}) visible=${miniWin.isVisible()}`);
    broadcastMiniStatus();
    return miniWin;
  }
  const size = MINI_SIZE;
  const saved = settings.miniPos && Number.isFinite(settings.miniPos.x) && Number.isFinite(settings.miniPos.y)
    ? settings.miniPos : null;
  const pos = saved ? clampToWorkArea(saved.x, saved.y, size, miniWorkArea(saved)) : defaultPos(size, miniWorkArea(null));
  miniWin = new BrowserWindow({
    width: size, height: size,
    x: pos.x, y: pos.y,
    frame: false, transparent: true, resizable: false, movable: true,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    // 不可获得键盘焦点：Tab/空格/回车绝不会落到小地图的四个按钮上
    // （原来在小地图上按 Tab 会在按钮间循环，空格一按就把开关切了）
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  miniWin.setIgnoreMouseEvents(false);
  miniIgnoreMouse = false;
  try { miniWin.setFocusable(false); } catch {}
  miniLog(`created (${reason}) bounds=${JSON.stringify(miniWin.getBounds())}`);
  miniWin.loadURL('app://renderer/minimap.html');
  try { miniWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}

  miniWin.on('closed', () => { miniLog('closed'); stopMiniDrag('closed'); stopMiniPan('closed'); stopMiniUnlockWatch(); miniWin = null; miniHidden = false; broadcastMiniStatus(); });
  miniWin.on('hide', () => { miniHidden = true; stopMiniDrag('hide'); stopMiniPan('hide'); miniLog('hide'); broadcastMiniStatus(); });
  miniWin.on('show', () => { miniHidden = false; miniLog('show'); miniReassert(); });
  miniWin.on('minimize', () => { miniLog('minimize -> restore'); try { miniWin.restore(); } catch {} });
  miniWin.on('moved', () => {
    // 非拖动路径（系统/其他代码）移动后也记住位置
    if (!miniDrag && miniAlive()) {
      const b = miniWin.getBounds();
      settings.miniPos = { x: b.x, y: b.y };
    }
  });
  miniWin.on('focus', () => {
    // 透明无边框窗口在 Windows 上被点击/激活后可能不重绘（表现为"窗口突然没了"）
    miniLog('focus -> invalidate + reassert');
    try { miniWin.webContents.invalidate(); } catch {}
    miniReassert();
  });
  miniWin.on('blur', () => { miniLog('blur'); stopMiniDrag('blur'); miniReassert(); });
  miniWin.on('unresponsive', () => { miniLog('unresponsive'); stopMiniDrag('unresponsive'); stopMiniPan('unresponsive'); });
  miniWin.on('responsive', () => miniLog('responsive'));
  miniWin.webContents.on('did-finish-load', () => {
    miniLog('did-finish-load');
    try { miniWin.webContents.invalidate(); } catch {}
    applyMiniClickThrough();
    miniReassert();
  });
  miniWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    miniLog(`did-fail-load ${code} ${desc} ${url} -> reload`);
    stopMiniDrag('did-fail-load');
    stopMiniPan('did-fail-load');
    setTimeout(() => { if (miniAlive()) miniWin.webContents.reload(); }, 800);
  });
  miniWin.webContents.on('render-process-gone', (_e, details) => {
    miniLog('render-process-gone ' + JSON.stringify(details));
    stopMiniDrag('render-gone');
    stopMiniPan('render-gone');
    setTimeout(() => { if (miniAlive()) { miniLog('reload after crash'); miniWin.webContents.reload(); } }, 500);
  });
  broadcastMiniStatus();
  return miniWin;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function setupIpc() {
  ipcMain.handle('state:get', () => state);
  ipcMain.handle('config:get', () => settings);
  ipcMain.handle('config:set', (_e, patch) => {
    const roomChanged = patch && Object.prototype.hasOwnProperty.call(patch, 'room');
    settings = {
      ...settings,
      ...patch,
      markerToggles: { ...settings.markerToggles, ...(patch.markerToggles || {}) },
      room: { ...settings.room, ...((patch && patch.room) || {}) },
    };
    saveSettings();
    syncWatchers();
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'miniClickThrough')) applyMiniClickThrough();
    // 房间配置变了（开关/地址/房间号/昵称/共享项）才重新握手
    if (roomChanged) syncRoom();
    broadcast({}); // 立刻把新配置推给所有窗口（雷达的透明度/方向/楼层/穿透等）
    return settings;
  });
  // 房间：探活（设置页"测试连接"）
  ipcMain.handle('room:test', async (_e, cfg) => {
    const target = cfg && cfg.url ? cfg : settings.room;
    const res = await probeServer(target.url, Number(target.port) || undefined);
    appLog(`[room] 测试连接 ${target.url}:${target.port} -> ${res.ok ? `OK ver=${res.ver} proto=${res.proto}` : `失败 ${res.error}`}`);
    return res;
  });
  ipcMain.handle('room:status', () => (room ? room.snapshot() : null));
  ipcMain.handle('room:reconnect', () => {
    // 已经在连/已连上就不要重来一遍（"加入房间"会先写配置触发连接，再调这里兜底）
    const st = room ? room.snapshot().status : 'off';
    if (st === 'online' || st === 'connecting') return room.snapshot();
    appLog('[room] 手动重连');
    if (room) {
      room.fatal = null;
      room.connect();
    }
    return room ? room.snapshot() : null;
  });
  ipcMain.handle('room:leave', () => {
    appLog('[room] 手动离开房间');
    settings = { ...settings, room: { ...settings.room, enabled: false } };
    saveSettings();
    if (room) room.applyConfig({ ...settings.room, ver: app.getVersion() });
    broadcast({});
    return room ? room.snapshot() : null;
  });
  ipcMain.handle('map:list', () => mapsData.listMaps());
  ipcMain.handle('map:select', (_e, { key, id }) => {
    const detail = key ? mapsData.getByKey(key) : mapsData.getById(id);
    if (detail) {
      // 手动换图：上一张图的定位/轨迹在新图上没有意义（否则会出现横穿地图的假路线）
      const changed = detail.id !== state.mapId;
      broadcast({
        mapId: detail.id, mapKey: detail.key, floor: 'auto', lastMapSource: 'manual',
        ...(changed ? { trail: [], position: null, quaternion: null, headingDeg: null, positionAt: null, lastFile: null } : {}),
      });
    }
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
    // 状态自愈：如果配置是"开着"但窗口其实已经不见（被系统吞掉/崩溃/隐藏），
    // 点一次就直接恢复，而不是先关再开
    const alive = miniAlive() && miniWin.isVisible();
    if (settings.miniVisible && !alive) {
      miniLog('toggle: enabled but missing -> restore');
      createMiniWindow('toggle-restore');
    } else {
      settings.miniVisible = !settings.miniVisible;
      if (settings.miniVisible) createMiniWindow('toggle-on');
      else if (miniAlive()) { miniHidden = true; miniLog('toggle: user hide'); miniWin.hide(); }
    }
    saveSettings();
    broadcastMiniStatus();
    return settings.miniVisible;
  });
  ipcMain.handle('mini:ensure', () => {
    settings.miniVisible = true;
    saveSettings();
    createMiniWindow('ensure');
    return miniStatus();
  });
  ipcMain.handle('mini:opacity', (_e, opacity) => {
    if (!miniAlive()) return;
    const o = Number(opacity);
    if (!Number.isFinite(o)) return;
    // 永不全透明：setOpacity(0) 会让窗口"看着消失"但仍吃掉鼠标点击
    miniWin.setOpacity(Math.max(0.2, Math.min(1, o)));
  });
  // 拖动小地图（移动窗口本身，不是平移地图）
  ipcMain.handle('mini:drag-start', () => startMiniDrag());
  ipcMain.handle('mini:drag-end', () => { stopMiniDrag('release'); return settings.miniPos || null; });
  // Ctrl + 拖动：平移圆盘里的地图（不动窗口）；返回按下时的光标位置作为换算基准
  ipcMain.handle('mini:pan-start', () => startMiniPan());
  ipcMain.handle('mini:pan-end', () => { stopMiniPan('release'); return true; });
  // 渲染层诊断（写进 userData/mini.log）：记按下时看到的修饰键状态，
  // 万一"Ctrl 拖不动"能一眼看出是 ctrlKey 没送到、还是平移本身没生效
  ipcMain.handle('mini:probe', (_e, msg) => { miniLog(`probe ${JSON.stringify(msg)}`); return true; });
  // 诊断用：直接问 Windows"Ctrl 现在是不是按着的"（渲染层拿到的 ctrlKey 实测可能是 false）
  ipcMain.handle('mini:ctrl-state', async () => {
    const real = await ctrlKeyDown();
    if (real !== null) return real;
    // 助手不可用：退回一次性查询（慢，但只是个诊断/保底路径）
    return new Promise((resolve) => {
      try {
        require('child_process').execFile('powershell', [
          '-NoProfile', '-NonInteractive', '-Command',
          'Add-Type -AssemblyName System.Windows.Forms; ' +
          'if ([System.Windows.Forms.Control]::ModifierKeys -band [System.Windows.Forms.Keys]::Control) { "1" } else { "0" }',
        ], { timeout: 4000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() === '1'));
      } catch { resolve(null); }
    });
  });
  ipcMain.handle('mini:status', () => miniStatus());
  // 点击穿透开关（写配置）；锁定期间由主进程轮询光标，悬停"解锁"小块时临时恢复交互
  ipcMain.handle('mini:click-through', (_e, on) => {
    settings.miniClickThrough = !!on;
    saveSettings();
    applyMiniClickThrough();
    broadcastMiniStatus();
    broadcast({});
    return miniStatus();
  });
  // 渲染层上报"解锁"小块位置（用于锁定时命中判定）
  ipcMain.on('mini:unlock-rect', (_e, rect) => {
    if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y)) {
      miniUnlockRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    }
  });
  // 渲染层活动（指针进入/按下）时刷新窗口：透明窗口被点击后偶发停止重绘
  ipcMain.handle('mini:ping', () => {
    miniReassert();
    if (miniAlive()) { try { miniWin.webContents.invalidate(); } catch {} }
    return miniStatus();
  });
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
  // 任务详情卡里的"打开 Wiki"：只放行 https，其它一律忽略
  ipcMain.handle('util:open-external', (_e, url) => {
    const u = String(url || '');
    if (!/^https:\/\//i.test(u)) return false;
    shell.openExternal(u).catch(() => {});
    return true;
  });
  // 手动标注：独立文件（不塞进 settings.json），写入做 500ms 防抖
  ipcMain.handle('annotations:get', () => annotations.get());
  ipcMain.handle('annotations:set', (_e, data) => {
    const next = annotations.set(data);
    clearTimeout(annoSaveTimer);
    annoSaveTimer = setTimeout(() => {
      annotations.save(ANNOTATIONS_FILE);
      const st = annotations.stats();
      appLog(`annotations saved: ${st.maps} 图 / ${st.strokes} 笔 / ${st.points} 点`);
    }, 500);
    return next;
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
  // 只有路径**真的变了**才重建监听器。
  // 以前是无条件 setRoot()：而 setRoot() = stop()+start()，stop() 会关掉文件尾巴，
  // 但 currentDir 没变 -> scan() 不会走"切换会话"分支 -> 不会重新打开日志文件 ->
  // 监听器一直读到 0 行,瞎到下次换会话为止。也就是说：游戏里随便动一下设置
  // （拖小地图、切图例、勾任务……任何一次 config:set）都会让"进图不切图"。
  // 反过来，重启还会重放回补窗口里的历史进图行，把地图抢回去（曾形成 700ms 死循环）。
  if (logWatcher && logWatcher.root !== settings.logsPath) logWatcher.setRoot(settings.logsPath);
  if (shotWatcher && shotWatcher.dir !== settings.screenshotsPath) shotWatcher.setDir(settings.screenshotsPath);
}

function startWatchers() {
  logWatcher = new LogWatcher(settings.logsPath, (ev) => applyLogEvent(ev), (s) => {
    if (s.state === 'watching') appLog(`log session: ${s.session} (${s.version}) root=${s.root}`);
    else if (s.state === 'unknown-map') appLog(`UNKNOWN map bundle: ${s.bundle} (rcid=${s.rcid}) sample=${s.sample}`);
    else appLog(`log watcher: ${s.state}${s.message ? ' ' + s.message : ''}`);
    broadcast({ logWatcherStatus: s });
  });
  shotWatcher = new ScreenshotWatcher(settings.screenshotsPath, (pos) => applyPosition(pos), (s) => {
    broadcast({ shotWatcherStatus: s });
  });
  logWatcher.start();
  shotWatcher.start();
}

// ---------------------------------------------------------------------------
// 房间联机（v2.0，默认关）
// ---------------------------------------------------------------------------
let room = null;

/** 房间配置变了才动手：没开就不连；开了且地址/房间号/昵称变了才重连 */
function syncRoom() {
  if (!room) {
    room = new RoomClient({
      onState: () => broadcast({ roomAt: Date.now() }),
      onLog: (msg) => appLog(`[room] ${msg}`),
      onOnline: () => {
        // 刚进房：把"我在哪张图"和最近一次定位补一遍，队友不用等下一次换图/截图
        room.setMap(state.mapId);
        pushPosition();
      },
    });
  }
  const on = room.applyConfig({ ...settings.room, ver: app.getVersion() });
  appLog(`[room] ${on ? `联机中 -> ${settings.room.url}:${settings.room.port}` : '未联机（房间功能关闭）'}`);
  broadcast({ roomAt: Date.now() });
  return on;
}

/** 把当前定位（含轨迹尾巴）推给房间；没有定位时什么也不做 */
function pushPosition() {
  if (!room || !state.mapId || !state.position) return;
  room.setPosition({
    map: state.mapId,
    x: state.position.x,
    y: state.position.y,
    z: state.position.z,
    hdg: state.headingDeg,
    ts: state.positionAt || Date.now(),
    trail: (state.trail || []).map((p) => ({ x: p.x, z: p.z })),
  });
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
        // 地名文字样式：白色内色 + 深色外框 + paint-order=stroke（平滑）
        placeLabels: Array.from(document.querySelectorAll('.map-marker text'))
          .filter((t) => t.getAttribute('paint-order') === 'stroke')
          .slice(0, 4)
          .map((t) => ({ text: t.textContent, fs: t.getAttribute('font-size'), fill: t.getAttribute('fill'), stroke: t.getAttribute('stroke'), sw: t.getAttribute('stroke-width') })),
        labelScale: window.__view.labelScale,
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
    // 看门狗只在配置为"开启"时工作，这里显式打开（与用户实际用法一致）
    settings.miniVisible = true;
    saveSettings();
    createMiniWindow('visual-test');
    broadcastMiniStatus();
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
        // getLegend() 会在缓存为空时重建，避免刚好撞上 setSeasonDocuments 清缓存导致统计为 0
        const legend = window.__view.getLegend();
        const groups = {};
        for (const m of (window.__view.markerCache || [])) groups[m.group] = (groups[m.group] || 0) + 1;
        return {
          legendSections: Array.from(document.querySelectorAll('.legend-group-name')).map((t) => t.textContent),
          legendGroupStates: Array.from(document.querySelectorAll('.legend-group')).map((h) => ({
            name: h.querySelector('.legend-group-name').textContent,
            state: h.querySelector('.legend-count').textContent,
            checked: h.querySelector('input').checked,
            indeterminate: h.querySelector('input').indeterminate,
          })),
          legendIcons: document.querySelectorAll('.legend-icon').length,
          seasonRows: Array.from(document.querySelectorAll('.legend-item'))
            .filter((r) => r.querySelector('input').dataset.group.startsWith('season:'))
            .map((r) => r.innerText.replace(/\\s+/g, ' ')),
          legendSeasonCount: ((legend.find((g) => g.id === 'g-season') || {}).items || [])
            .reduce((a, c) => a + c.count, 0),
          seasonCount: (groups['season:pmc'] || 0) + (groups['season:technical'] || 0),
          btrStops: groups.btrStop,
        };
      })()`);
      console.log('[visual] LIGHTHOUSE:', JSON.stringify(season));
      const img = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'lighthouse.png'), img.toPNG());
      console.log('[visual] lighthouse.png saved');
      // 关掉全部"赛季文件"图钉 -> 标记数应正好减少 seasonCount（验证图钉开关生效）
      // 注意：setMap 内部有 await（读图标清单），此刻 DOM 可能正好是空的，先强制重绘一次再数
      const settleMarkers = async () => {
        await mainWin.webContents.executeJavaScript(`(() => { const v = window.__view; v.setViewport(v.getViewport()); return true; })()`);
        await new Promise((r) => setTimeout(r, 250));
        return mainWin.webContents.executeJavaScript(`document.querySelectorAll('.map-marker').length`);
      };
      const before = await settleMarkers();
      await mainWin.webContents.executeJavaScript(`(() => {
        const rows = Array.from(document.querySelectorAll('.legend-item'))
          .filter((r) => r.querySelector('input').dataset.group.startsWith('season:'));
        for (const r of rows) { const i = r.querySelector('input'); if (i.checked) i.click(); }
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 400));
      const after = await mainWin.webContents.executeJavaScript(`document.querySelectorAll('.map-marker').length`);
      console.log('[visual] season 图钉开关: ' + before + ' -> ' + after + ' (应减少 ' + season.seasonCount + ')');      const img2 = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'season-off.png'), img2.toPNG());
      // 恢复图钉
      await mainWin.webContents.executeJavaScript(`(() => {
        const rows = Array.from(document.querySelectorAll('.legend-item'))
          .filter((r) => r.querySelector('input').dataset.group.startsWith('season:'));
        for (const r of rows) { const i = r.querySelector('input'); if (!i.checked) i.click(); }
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      // 大类批量开关：点"物资箱 · 散落物资"组头 -> 该组全部关闭，标记数应正好减少该组数量
      const markersBeforeGroup = await settleMarkers();
      const groupBefore = await mainWin.webContents.executeJavaScript(`(() => {
        const h = Array.from(document.querySelectorAll('.legend-group'))
          .find((x) => x.querySelector('.legend-group-name').textContent.includes('物资'));
        if (!h) return null;
        const items = Array.from(document.querySelectorAll('.legend-item'))
          .filter((r) => r.querySelector('input').dataset.group.startsWith('loot:') || r.querySelector('input').dataset.group === 'loose');
        const sum = items.reduce((a, r) => a + Number(r.querySelector('.legend-count').textContent || 0), 0);
        return { name: h.querySelector('.legend-group-name').textContent, state: h.querySelector('.legend-count').textContent, items: items.length, sum, markers: document.querySelectorAll('.map-marker').length };
      })()`);
      await mainWin.webContents.executeJavaScript(`(() => {
        const h = Array.from(document.querySelectorAll('.legend-group'))
          .find((x) => x.querySelector('.legend-group-name').textContent.includes('物资'));
        h.querySelector('input').click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      const groupAfter = await mainWin.webContents.executeJavaScript(`(() => {
        const h = Array.from(document.querySelectorAll('.legend-group'))
          .find((x) => x.querySelector('.legend-group-name').textContent.includes('物资'));
        const el = document.getElementById('legend-none');
        return {
          state: h.querySelector('.legend-count').textContent,
          checked: h.querySelector('input').checked,
          indeterminate: h.querySelector('input').indeterminate,
          markers: document.querySelectorAll('.map-marker').length,
        };
      })()`);
      console.log('[visual] LEGEND-GROUP 批量开关:', JSON.stringify({
        before: { ...groupBefore, markers: markersBeforeGroup },
        after: groupAfter,
        expectDrop: groupBefore && groupBefore.sum,
        actualDrop: groupBefore ? markersBeforeGroup - groupAfter.markers : null,
      }));
      // 组内单个开关 -> 组头应变三态（部分选中）；再恢复整组
      const partial = await mainWin.webContents.executeJavaScript(`(() => {
        const r = Array.from(document.querySelectorAll('.legend-item'))
          .find((x) => x.querySelector('input').dataset.group === 'loose');
        if (!r) return null;
        r.querySelector('input').click();
        const h = Array.from(document.querySelectorAll('.legend-group'))
          .find((x) => x.querySelector('.legend-group-name').textContent.includes('物资'));
        return { state: h.querySelector('.legend-count').textContent, checked: h.querySelector('input').checked, indeterminate: h.querySelector('input').indeterminate };
      })()`);
      console.log('[visual] LEGEND-GROUP 组头三态:', JSON.stringify(partial));
      // 组头小三角：折叠该组（面板很长时用），折叠后组内行不可见
      const collapse = await mainWin.webContents.executeJavaScript(`(() => {
        const secs = Array.from(document.querySelectorAll('.legend-section'));
        const sec = secs.find((s) => s.querySelector('.legend-group-name').textContent.includes('物资'));
        const visibleRows = () => Array.from(sec.querySelectorAll('.legend-item')).filter((r) => r.offsetParent !== null).length;
        const total = sec.querySelectorAll('.legend-item').length;
        const before = visibleRows();
        sec.querySelector('.legend-caret').click();
        const after = visibleRows();
        const collapsed = sec.classList.contains('collapsed');
        sec.querySelector('.legend-caret').click();
        return { total, before, after, collapsed, restored: visibleRows(), stillCollapsed: sec.classList.contains('collapsed') };
      })()`);
      console.log('[visual] LEGEND-GROUP 折叠:', JSON.stringify(collapse));
      await mainWin.webContents.executeJavaScript(`(() => {
        const h = Array.from(document.querySelectorAll('.legend-group'))
          .find((x) => x.querySelector('.legend-group-name').textContent.includes('物资'));
        if (h.querySelector('.legend-count').textContent.split('/')[0] !== h.querySelector('.legend-count').textContent.split('/')[1]) h.querySelector('input').click();
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

  // 小地图"消失"自愈验证：把用户遇到的三类触发方式真跑一遍
  setTimeout(async () => {
    const health = {};
    try {
      // 0) 初始状态
      health.initial = miniStatus();

      // 1) 被系统隐藏/最小化（Win+D、被游戏盖住后 hide）-> 看门狗应自动 show
      if (miniAlive()) miniWin.hide();
      const hideSamples = [];
      for (let i = 0; i < 7; i++) {
        await new Promise((r) => setTimeout(r, 500));
        hideSamples.push(miniAlive() ? miniWin.isVisible() : 'gone');
      }
      health.hideSamples = hideSamples;
      health.afterHide = miniStatus();

      // 2) 渲染进程崩溃（透明窗口 OOM/GPU 掉线）-> 应自动 reload 并恢复
      if (miniAlive()) miniWin.webContents.forcefullyCrashRenderer();
      await new Promise((r) => setTimeout(r, 2500));
      const reloaded = miniAlive() ? await miniWin.webContents.executeJavaScript('document.readyState').catch(() => 'load-failed') : 'no-window';
      health.afterCrash = { ...miniStatus(), readyState: reloaded };

      // 3) 窗口被直接销毁 + 配置仍为开启 -> 主界面点一次按钮应"恢复"而不是"关闭"
      if (miniAlive()) miniWin.destroy();
      await new Promise((r) => setTimeout(r, 600));
      health.afterDestroy = miniStatus();
      const clicked = await mainWin.webContents.executeJavaScript(`(() => {
        document.getElementById('btn-mini').click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 1200));
      health.afterOneClick = { clicked, ...miniStatus() };

      // 4) 顶栏按钮点击后不应残留键盘焦点（防止随后空格/回车再次切换）
      health.buttonHasFocus = await mainWin.webContents.executeJavaScript(
        `document.activeElement && document.activeElement.id === 'btn-mini'`
      );
      health.buttonActive = await mainWin.webContents.executeJavaScript(
        `document.getElementById('btn-mini').classList.contains('active')`
      );
      console.log('[visual] MINI-HEALTH:', JSON.stringify(health));

      // 5) mini.log 记录
      try {
        const log = fs.readFileSync(path.join(app.getPath('userData'), 'mini.log'), 'utf8').trim().split('\n');
        console.log('[visual] mini.log tail:', JSON.stringify(log.slice(-8)));
      } catch (e) { console.log('[visual] mini.log 缺失:', e.message); }

      // 6) 用户主动关闭雷达：必须保持关闭（看门狗/reassert 都不许把它弄回来）
      await mainWin.webContents.executeJavaScript(`document.getElementById('btn-mini').click(); true`);
      const offSamples = [];
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 600));
        offSamples.push(miniAlive() ? miniWin.isVisible() : 'gone');
      }
      health.afterUserOff = { samples: offSamples, status: miniStatus() };
      // 再点一次按钮应重新打开
      await mainWin.webContents.executeJavaScript(`document.getElementById('btn-mini').click(); true`);
      await new Promise((r) => setTimeout(r, 1200));
      health.afterUserOn = miniStatus();
      console.log('[visual] MINI-HEALTH-2:', JSON.stringify({ afterUserOff: health.afterUserOff, afterUserOn: health.afterUserOn }));

      // 6.5) 拖动与焦点：真实 PointerEvent 走一遍"按下圆盘 -> 主进程拖动会话 -> 松手记忆位置"
      if (miniAlive()) {
        health.focusable = typeof miniWin.isFocusable === 'function' ? miniWin.isFocusable() : null;
        const before = miniWin.getBounds();
        // 雷达上不再有任何按钮；按在"解锁"小块上不许触发拖动
        health.hudPointerDown = await miniWin.webContents.executeJavaScript(`(() => {
          const b = document.getElementById('mini-unlock');
          b.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
          return document.body.classList.contains('dragging');
        })()`);
        health.mapPointerDown = await miniWin.webContents.executeJavaScript(`(() => {
          const el = document.querySelector('.mapstage');
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: r.width / 2, clientY: r.height / 2, bubbles: true, cancelable: true }));
          return document.body.classList.contains('dragging');
        })()`);
        await new Promise((r) => setTimeout(r, 300));
        health.duringDrag = { dragging: !!miniDrag, bounds: miniWin.getBounds() };
        health.pointerUp = await miniWin.webContents.executeJavaScript(`(() => {
          window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
          return document.body.classList.contains('dragging');
        })()`);
        await new Promise((r) => setTimeout(r, 300));
        health.afterDrag = {
          dragging: !!miniDrag,
          movedBy: { x: miniWin.getBounds().x - before.x, y: miniWin.getBounds().y - before.y },
          size: miniWin.getBounds().width + 'x' + miniWin.getBounds().height,
          savedMiniPos: settings.miniPos,
        };
        // 没有按钮可 Tab 聚焦；圆盘裁剪在 #mini-root
        health.hudTabIndex = await miniWin.webContents.executeJavaScript(
          `document.getElementById('mini-unlock').tabIndex`
        );
        health.bodyClip = await miniWin.webContents.executeJavaScript(
          `({ body: getComputedStyle(document.body).clipPath, root: getComputedStyle(document.getElementById('mini-root')).clipPath })`
        );
        health.rotFixed = await miniWin.webContents.executeJavaScript(
          `({ rotate: window.__view.rotate, rot: window.__view.view.rot })`
        );
        health.iconSizes = await miniWin.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.map-marker image')).map((i) => Number(i.getAttribute('width'))).slice(0, 12)`
        );
        health.badgeShapes = await miniWin.webContents.executeJavaScript(`(() => {
          const out = {};
          for (const g of document.querySelectorAll('.map-marker')) {
            const f = g.firstElementChild;
            if (!f || f.tagName === 'title') continue;
            const key = f.tagName === 'polygon' ? 'polygon' : f.tagName;
            out[key] = (out[key] || 0) + 1;
          }
          return out;
        })()`);
        // 点击穿透：开 -> 主进程 ignoreMouseEvents=true 且小块出现；关 -> 恢复
        health.clickThrough = {};
        await mainWin.webContents.executeJavaScript(`window.api.setConfig({ miniClickThrough: true })`);
        await new Promise((r) => setTimeout(r, 600));
        health.clickThrough.on = {
          status: miniStatus().ignoreMouseEvents,
          lockShown: await miniWin.webContents.executeJavaScript(`getComputedStyle(document.getElementById('mini-lock')).display !== 'none'`),
          unlockShown: await miniWin.webContents.executeJavaScript(`getComputedStyle(document.getElementById('mini-unlock')).display !== 'none'`),
          bodyLocked: await miniWin.webContents.executeJavaScript(`document.body.classList.contains('locked')`),
        };
        // 悬停"解锁"小块属于真实光标相关的行为，由 tools/verify-mini-input.js 用系统级输入验收；
        // 这里只验证点它就能关掉穿透（渲染层的 click 路径）
        await miniWin.webContents.executeJavaScript(`document.getElementById('mini-unlock').click(); true`);
        await new Promise((r) => setTimeout(r, 600));
        health.clickThrough.unlockByChip = { setting: !!settings.miniClickThrough, status: miniStatus().ignoreMouseEvents };
        console.log('[visual] MINI-DRAG:', JSON.stringify({
          focusable: health.focusable, hud: health.hudPointerDown, map: health.mapPointerDown,
          duringDrag: health.duringDrag, pointerUp: health.pointerUp, afterDrag: health.afterDrag,
          tabIndex: health.hudTabIndex, clip: health.bodyClip, rotFixed: health.rotFixed,
          iconSizes: health.iconSizes, badges: health.badgeShapes, clickThrough: health.clickThrough,
        }));
      }

      // 7) 恢复现场：确保小地图最终处于可见状态并截图
      if (!miniAlive()) createMiniWindow('visual-test-restore');
      await new Promise((r) => setTimeout(r, 1500));
      console.log('[visual] MINI final:', JSON.stringify(miniStatus()));
      if (miniAlive()) {
        const img2 = await miniWin.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'mini-recovered.png'), img2.toPNG());
        console.log('[visual] mini-recovered.png saved');
      }
    } catch (e) { console.error('[visual] mini health test failed', e); }
    console.log('[visual] renderer errors:', errors.length ? JSON.stringify(errors, null, 2) : 'NONE');
    app.exit(0);
  }, 20000);
}
app.whenReady().then(() => {
  settings = loadSettings();
  mapsData.load(path.join(DATA_DIR, 'maps-dump.json'));
  // 手动标注（世界坐标，独立文件）
  annotations.load(ANNOTATIONS_FILE);
  appLog(`annotations loaded: ${JSON.stringify(annotations.stats())}`);
  state.mapsVersion = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'maps-dump.json'), 'utf-8')).fetchedAt || null;
  state.appVersion = app.getVersion();

  registerAppProtocol();
  Menu.setApplicationMenu(null);
  startKeyHelper(); // 常驻"Ctrl 是否按着"助手（雷达的 Ctrl 拖动用它判定）
  setupIpc();
  createMainWindow();
  startWatchers();
  syncRoom(); // 房间功能（默认关：settings.room.enabled = false 时这里什么都不做）
  if (settings.miniVisible) createMiniWindow('startup');
  startMiniWatchdog();

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
  if (miniWatchdog) { clearInterval(miniWatchdog); miniWatchdog = null; }
  stopMiniDrag('quit');
  stopMiniPan('quit');
  stopKeyHelper();
  if (logWatcher) logWatcher.stop();
  if (shotWatcher) shotWatcher.stop();
  if (room) room.destroy();
});
