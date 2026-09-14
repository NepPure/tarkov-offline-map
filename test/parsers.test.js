'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { parseScreenshotFilename, parseLogLine } = require('../src/parsers');
const { RAIDCODE_TO_MAPKEY, BUNDLE_TO_RAIDCODE } = require('../src/constants');
const projection = require('../src/projection');
const mapsData = require('../src/maps-data');

const DUMP = path.join(__dirname, '..', 'data', 'maps-dump.json');

test('截图文件名解析（真实样本）', () => {
  const name = '2026-09-07[23-05]_58.02, 1.75, 49.47_0.01518, 0.90924, -0.03197, 0.41476_15.47 (0).png';
  const r = parseScreenshotFilename(name);
  assert.ok(r, 'should parse');
  assert.strictEqual(r.x, 58.02);
  assert.strictEqual(r.y, 1.75);
  assert.strictEqual(r.z, 49.47);
  assert.deepStrictEqual(r.quaternion.map((v) => Number(v.toFixed(5))), [0.01518, 0.90924, -0.03197, 0.41476]);
});

test('无坐标截图文件名返回 null', () => {
  assert.strictEqual(parseScreenshotFilename('2026-09-07[23-03] (0).png'), null);
});

test('日志 scene preset 解析', () => {
  const line = '2026-09-07 23:04:12.853|1.1.0.1.46911|Info|application|scene preset path:maps/factory_day_preset.bundle rcid:factory_day.scenespreset.asset';
  const ev = parseLogLine(line);
  assert.strictEqual(ev.type, 'scene-preset');
  assert.strictEqual(ev.raidCode, 'factory4_day');
});

test('日志 NetworkGameCreate 解析', () => {
  const line = `2026-07-05 10:49:59.752|1.0.6.0.45949|Debug|application|TRACE-NetworkGameCreate profileStatus: 'Profileid: 000000000000000000000000, Status: Busy, RaidMode: Online, Ip: 203.0.113.7, Port: 17022, Location: bigmap, Sid: CN-HK03G009_6a49c573c7fa78ba4d6164fc_05.07.26_05-46-18, GameMode: deathmatch, shortId: QH849V'`;
  const ev = parseLogLine(line);
  assert.strictEqual(ev.type, 'network-game-create');
  assert.strictEqual(ev.raidCode, 'bigmap');
});

test('日志 LocationLoaded / Transit 解析', () => {
  assert.strictEqual(parseLogLine('2026-09-07 23:04:25.917|1.1.0.1.46911|Info|application|LocationLoaded:8.9 real:13.88 diff:4.98').type, 'location-loaded');
  assert.strictEqual(parseLogLine('2026-09-07 23:04:29.205|1.1.0.1.46911|Info|application|[Transit] Flag:None, RaidId:6a9ed27e74417e5ad601b297, Count:0, Locations:factory4_day ->').type, 'transit');
});

test('raidCode -> 地图映射（工厂）', () => {
  assert.strictEqual(RAIDCODE_TO_MAPKEY['factory4_day'], 'factory');
  assert.strictEqual(RAIDCODE_TO_MAPKEY['bigmap'], 'customs');
  assert.strictEqual(RAIDCODE_TO_MAPKEY['laboratory'], 'the-lab');
});

test('bundle 映射表（关键项）', () => {
  assert.strictEqual(BUNDLE_TO_RAIDCODE['factory_day_preset'], 'factory4_day');
  assert.strictEqual(BUNDLE_TO_RAIDCODE['customs_preset'], 'bigmap');
  assert.strictEqual(BUNDLE_TO_RAIDCODE['shopping_mall'], 'Interchange');
});

test('投影：工厂截图坐标 (58.02, 49.47) 落在工厂 map 像素范围内', () => {
  mapsData.load(DUMP);
  const d = mapsData.getByKey('factory');
  assert.ok(d, 'factory detail exists');
  const proj = projection.makeProjection(d);
  const p = proj.project(58.02, 49.47);
  const b = projection.mapPixelBounds(d, proj);
  assert.ok(p.x >= b.minX - 1 && p.x <= b.maxX + 1, `x in bounds, got ${p.x}`); 
  assert.ok(p.y >= b.minY - 1 && p.y <= b.maxY + 1, `y in bounds, got ${p.y}`);
});

test('四元数朝向：x=0 朝"上"（+z 世界方向）', () => {
  // 绕 Y 轴 0° -> yaw=0；绕 Y 轴 90° -> 头朝 +x
  const q0 = [0, 0, 0, 1];
  const yaw0 = projection.quaternionToEuler(q0)[0];
  assert.ok(Math.abs(yaw0) < 0.001);
  const q90 = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const yaw90 = projection.quaternionToEuler(q90)[0];
  assert.ok(Math.abs(yaw90 - 90) < 0.01, `yaw90=${yaw90}`);
});

test('无 SVG 地图也能解析数据（实验室）', () => {
  mapsData.load(DUMP);
  const d = mapsData.getByKey('the-lab');
  assert.ok(d);
  assert.ok(!d.svgPath || !d.svgLayer); // 该图无 SVG，走标记模式
  assert.ok(d.extracts.length > 0);
});
