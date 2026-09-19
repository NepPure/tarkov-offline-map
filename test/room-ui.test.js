'use strict';

/**
 * 房间联机的接线（静态检查）：界面元素、preload API、主进程挂钩、打包清单。
 * 这些点任何一处断了，功能就会"看着有按钮、点了一点反应都没有"，所以用测试钉住。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

test('设置页里有完整的房间卡片，顶栏有状态胶囊', () => {
  const html = read('renderer/map.html');
  for (const id of [
    'room-chip', 'room-state', 'set-room-enabled', 'set-room-url', 'set-room-port',
    'set-room-id', 'set-room-pass', 'set-room-nick', 'set-room-pos', 'set-room-anno',
    'room-test', 'room-connect', 'room-disconnect', 'room-hint',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  }
  // 房间卡片里的按钮必须在 form 里也不会误提交（设置弹窗是 method=dialog 的表单）
  for (const id of ['room-test', 'room-connect', 'room-disconnect']) {
    assert.match(html, new RegExp(`<button type="button" id="${id}"`), `#${id} 必须写明 type="button"`);
  }
  assert.ok(html.includes('默认关'), '卡片里要写清楚"默认关/不填就不联网"');
});

test('preload 暴露了房间 API', () => {
  const pre = read('preload.js');
  for (const k of ['roomTest', 'roomStatus', 'roomReconnect', 'roomLeave']) {
    assert.ok(pre.includes(`${k}:`), `preload 缺少 ${k}`);
    assert.ok(pre.includes(`'room:`), 'preload 里应该有 room: 开头的 IPC 通道');
  }
  assert.ok(pre.includes("'room:test'") && pre.includes("'room:leave'"));
});

test('主进程：配置变化重连、广播带房间状态、换图/定位上报、退出时收尾', () => {
  const main = read('main.js');
  assert.ok(main.includes('const { RoomClient, probeServer, randomPeerId } = roomClientModule;'));
  assert.ok(main.includes('room: room ? room.snapshot() : null'), '广播里要带上房间快照');
  assert.ok(main.includes("if (room && Object.prototype.hasOwnProperty.call(patch, 'mapId')) room.setMap(state.mapId);"), '换图要上报');
  assert.ok(main.includes('pushPosition()'), '定位要上报');
  assert.ok(main.includes('if (roomChanged) syncRoom();'), '房间配置变了才重新握手');
  assert.ok(main.includes('if (room) room.destroy();'), '退出时要收尾（别留着定时器/连接）');
  assert.ok(main.includes("ipcMain.handle('room:test'"), '缺少 room:test');
  assert.ok(main.includes("ipcMain.handle('room:leave'"), '缺少 room:leave');
  // 默认必须是不联机：离线优先是产品的硬承诺
  assert.match(main, /room:\s*\{[\s\S]*?enabled: false,/, 'settings.room.enabled 默认必须是 false');
});

test('渲染层：设置读写、状态渲染、三个按钮都接上了', () => {
  const js = read('renderer/map.js');
  assert.match(js, /function roomFormPatch\(\)/, '缺少 roomFormPatch()');
  assert.match(js, /function renderRoomStatus\(room\)/, '缺少 renderRoomStatus()');
  assert.ok(js.includes('room: roomFormPatch(),'), '保存设置时要带上房间配置');
  assert.ok(js.includes("$('#room-test').addEventListener"), '测试连接按钮没接');
  assert.ok(js.includes("$('#room-connect').addEventListener"), '加入房间按钮没接');
  assert.ok(js.includes("$('#room-disconnect').addEventListener"), '离开房间按钮没接');
  assert.ok(js.includes('renderRoomStatus(state.room)'), '主进程状态到了要刷新房间显示');
  // 客户端与主进程必须用同一个协议版本
  const rc = require('../src/room-client.js');
  const proto = require('../server/protocol.js');
  assert.strictEqual(rc.PROTO, proto.PROTO, '客户端/服务端协议版本必须一致');
});

test('打包清单里带上了共用的协议文件（否则打包版一进设置页就报错）', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.files.includes('server/protocol.js'), 'electron-builder 的 files 里必须包含 server/protocol.js');
  assert.ok(pkg.dependencies && pkg.dependencies.ws, 'ws 必须是运行时依赖（Electron 主进程没有全局 WebSocket）');
  // 服务端自己的依赖与镜像配置
  const sp = JSON.parse(read('server/package.json'));
  assert.ok(sp.dependencies.ws);
  assert.ok(fs.existsSync(path.join(ROOT, 'server', 'Dockerfile')));
  assert.ok(fs.existsSync(path.join(ROOT, 'server', 'docker-compose.yml')));
  assert.ok(fs.existsSync(path.join(ROOT, '.github', 'workflows', 'server.yml')));
});
