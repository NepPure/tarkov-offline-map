'use strict';

/**
 * 顶栏「固定地图方向」按钮（曾经叫"车头朝上"，语义相反）：
 *   - 按钮**亮着 = 固定地图方向**（地图始终正北朝上），这是默认值
 *   - 关掉 = 随角色朝向旋转
 *   - 配置里存的是反过来的 `rotateWithHeading`，所以 按钮态 = !rotateWithHeading
 *
 * 这种"反相"的接线最容易在某次重构里被悄悄改回来（改回来以后默认行为就变了，
 * 而且界面上完全看不出来），所以用静态断言钉住。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const html = read('renderer/map.html');
const js = read('renderer/map.js');
const mv = read('renderer/common/map-view.js');

test('顶栏按钮：文案是「固定地图方向」，默认就是选中（亮着）', () => {
  const btn = html.match(/<button id="btn-rotate"[^>]*>[^<]*<\/button>/);
  assert.ok(btn, 'map.html 里找不到 #btn-rotate');
  const [full] = btn;
  assert.ok(full.includes('固定地图方向'), `按钮文案应该是「固定地图方向」，实际：${full}`);
  assert.match(full, /class="toggle active"/, '默认必须是选中状态（固定地图方向 = 默认行为）');
  assert.match(full, /title="[^"]*正北[^"]*"/, 'title 里要写清"地图始终正北朝上"');
  assert.match(full, /title="[^"]*关掉[^"]*随角色朝向旋转[^"]*"/, 'title 里要写清"关掉 = 随角色朝向旋转"');
  // "车头朝上"这个说法不再出现在界面上（用户觉得不常用）
  assert.ok(!html.includes('车头朝上'), 'map.html 里不该再有"车头朝上"');
  assert.ok(!read('README.md').includes('车头朝上'), 'README 里不该再有"车头朝上"');
});

test('顶栏按钮：点击逻辑是反相（亮着 = 不旋转），并且会持久化', () => {
  // 点击：fixed = 按钮态；rotate = !fixed；配置里存 rotateWithHeading = !fixed
  assert.match(js, /onToggle\('#btn-rotate'[\s\S]{0,300}?const fixed = e\.currentTarget\.classList\.toggle\('active'\)/,
    '按钮态的含义应该是"固定地图方向"');
  assert.match(js, /view\.setViewMode\(\{ rotate: !fixed \}\)/, '亮着时不能旋转（rotate = !fixed）');
  assert.match(js, /api\.setConfig\(\{ rotateWithHeading: !fixed \}\)/, '要落盘（配置里的键是 rotateWithHeading）');

  // 初始化：从配置反推出按钮态，并应用到视图
  assert.match(js, /const fixedDirection = state\.cfg\.rotateWithHeading !== true/,
    '初始化要按"默认固定方向"来：只有明确 true 才随朝向旋转');
  assert.match(js, /\$\('#btn-rotate'\)\.classList\.toggle\('active', fixedDirection\)/, '按钮亮灭要跟配置一致');
  assert.match(js, /view\.setViewMode\(\{ rotate: !fixedDirection \}\)/, '初始化也要把旋转角设对');
});

test('MapView：旋转角只在"随朝向旋转"时非 0，且切换后立刻重画', () => {
  assert.match(mv, /#targetRotation\(\)\s*\{[\s\S]{0,200}?this\.rotate && this\.heading/,
    '#targetRotation 应该只在 rotate 且拿到 heading 时给角度');
  assert.match(mv, /#targetRotation\(\)\s*\{[\s\S]{0,220}?: 0;/, '否则固定 0（正北朝上）');
  // 只切方向（follow 关着 / 标注模式里）也要立刻重画，不能等下一次定位
  assert.match(mv, /else if \(rotate !== undefined\) this\.#applyRotation\(\)/,
    '切换固定方向后要立刻按新角度重画');
  assert.match(mv, /#applyRotation\(\)\s*\{[\s\S]{0,200}?#renderTransform\(\)/, '#applyRotation 里要真正重画');
  assert.ok(!mv.includes('#centerOnPlayer(recompute)'), '那个没人用的 recompute 参数应该已经删掉');
});
