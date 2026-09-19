'use strict';

/**
 * 品牌名与"关于"页面（v2.0 用户明确要求的界面改动，用静态检查钉住，避免以后回退）：
 *   1) 标题去掉"离线" -> 塔可夫地图
 *   2) 左上角不再挂"纯本地"徽标（v2.0 起有可选的房间联机，"纯本地"不再准确）
 *   3) 新增"关于"弹窗：版本号 + GitHub 地址 + 功能简介
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

test('品牌名：标题里不再有"离线"，左上角不再有"纯本地"徽标', () => {
  const html = read('renderer/map.html');
  assert.ok(html.includes('<title>塔可夫地图</title>'), '窗口标题应为「塔可夫地图」');
  assert.ok(html.includes('<h1>塔可夫地图</h1>'), '左上角标题应为「塔可夫地图」');
  assert.ok(!html.includes('塔可夫离线地图'), 'map.html 里不该再有旧名字');
  assert.ok(!html.includes('纯本地'), '左上角「纯本地」徽标应已移除');

  const main = read('main.js');
  assert.ok(main.includes("const APP_TITLE = '塔可夫地图';"), '窗口标题常量应改名为「塔可夫地图」');
  assert.ok(!main.includes('塔可夫离线地图'), 'main.js 里不该再有旧名字');

  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.productName, '塔可夫地图');
  assert.strictEqual(pkg.build.productName, '塔可夫地图');
  assert.ok(!pkg.build.portable.artifactName.includes('离线'), 'exe 产物名不再带「离线」');
  assert.ok(!pkg.description.includes('纯本地'), '包描述里不该再写「纯本地」');

  const yml = read('.github/workflows/build.yml');
  assert.ok(!yml.includes('塔可夫离线地图'), 'Release 标题不该再有旧名字');
});

test('关于弹窗：版本号 / 开源地址 / 功能简介齐全，入口也都接好了', () => {
  const html = read('renderer/map.html');
  for (const id of ['about-dialog', 'about-ver', 'about-repo', 'btn-about', 'settings-about']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  }
  assert.match(
    html,
    /id="about-repo" href="https:\/\/github\.com\/NepPure\/tarkov-offline-map"/,
    '关于页必须给出 GitHub 地址',
  );
  for (const kw of ['日志识图', '截图定位', '悬浮小地图', '标记与图例', '任务清单', '手动标注', '房间联机']) {
    assert.ok(html.includes(kw), `关于页缺少功能说明：${kw}`);
  }

  const js = read('renderer/map.js');
  assert.match(js, /function openAbout\(\)/, 'map.js 里应有 openAbout()');
  assert.ok(js.includes("$('#btn-about').addEventListener('click', openAbout)"), '顶栏「关于」按钮要接上');
  assert.ok(js.includes("$('#about-dialog').showModal()"), 'openAbout 要打开关于弹窗');
  assert.ok(js.includes("$('#settings-about')"), '设置弹窗里也要有「关于」入口');
  assert.ok(js.includes('api.openExternal'), '开源地址应交给系统浏览器打开（渲染层不跳转）');
  assert.ok(js.includes('st.appVersion'), '版本号从主进程状态里取，不写死');

  const main = read('main.js');
  assert.ok(main.includes('state.appVersion = app.getVersion();'), '主进程应下发自己的版本号');
});
