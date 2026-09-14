#!/usr/bin/env node
/**
 * 离线模拟：用仓库 samples/ 里的真实日志 + 截图跑一遍完整管线
 * （日志监听 -> 自动识图；截图监听 -> 定位），打印结果并断言。
 * 用法: node tools/simulate.js
 */
const path = require('path');

const REPO = path.join(__dirname, '..');
const mapsData = require('../src/maps-data');
const { LogWatcher } = require('../src/log-watcher');
const { ScreenshotWatcher } = require('../src/screenshot-watcher');
const projection = require('../src/projection');

const LOGS = path.join(REPO, 'samples', 'logs');
const SHOTS = path.join(REPO, 'samples', 'screenshots');
const DUMP = path.join(REPO, 'data', 'maps-dump.json');

mapsData.load(DUMP);

let detectedMap = null;
let detectedPos = null;

const log = new LogWatcher(LOGS, (ev) => {
  console.log('[log-event]', JSON.stringify(ev));
  if (ev.type === 'scene-preset' || ev.type === 'network-game-create') {
    const key = require('../src/constants').RAIDCODE_TO_MAPKEY[ev.raidCode];
    if (key) {
      const d = mapsData.getByKey(key);
      if (d) { detectedMap = d; console.log('  -> 地图识别为:', d.name, d.key); }
    }
  }
}, (info) => console.log('[log-status]', JSON.stringify(info)));

log.start();

const shot = new ScreenshotWatcher(SHOTS, (pos) => {
  console.log('[screenshot]', pos.file, '->', pos.x, pos.y, pos.z, 'quat=', pos.quaternion.map((v) => v.toFixed(4)).join(','));
  detectedPos = pos;
}, (info) => console.log('[shot-status]', JSON.stringify(info)));

shot.start();

// 模拟"新截图"（真实 fs.watch 不会对初始目录触发，这里先清空 seen 再触发一次）
setTimeout(() => {
  shot.seen.clear();
  shot.rescan(false);
}, 500);

setTimeout(() => {
  log.stop();
  shot.stop();
  console.log('\n===== 验证结果 =====');
  const okMap = detectedMap && detectedMap.key === 'factory';
  console.log('地图识别:', detectedMap ? `${detectedMap.name} (${detectedMap.key})` : '失败', okMap ? '✔' : '✘');
  // 期望定位: 58.02, 1.75, 49.47
  const okPos = detectedPos && Math.abs(detectedPos.x - 58.02) < 0.01 && Math.abs(detectedPos.z - 49.47) < 0.01;
  console.log('截图定位:', detectedPos ? `(${detectedPos.x}, ${detectedPos.y}, ${detectedPos.z})` : '失败', okPos ? '✔' : '✘');
  if (detectedPos) {
    const yaw = projection.quaternionToEuler(detectedPos.quaternion)[0];
    console.log('朝向(yaw):', yaw.toFixed(2), '°');
    const p = projection.makeProjection(detectedMap);
    const px = p.project(detectedPos.x, detectedPos.z);
    console.log('投影像素:', px.x.toFixed(1), px.y.toFixed(1));
  }
  const pass = okMap && okPos;
  console.log('\n总体:', pass ? 'PASS ✔' : 'FAIL ✘');
  process.exit(pass ? 0 : 1);
}, 2500);
