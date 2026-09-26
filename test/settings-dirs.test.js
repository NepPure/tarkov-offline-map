'use strict';

/**
 * 设置页的"目录"：游戏日志目录 / 截图目录都能用系统文件夹选择框挑，
 * 也能一键在资源管理器里打开（手输路径照样能用）。
 *
 * 全是静态接线检查：这几处任何一处断了，表现都是"点了没反应"。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const IDS = ['set-logs-pick', 'set-logs-open', 'set-shots-pick', 'set-shots-open'];

test('设置页：两个目录各有"选择文件夹…"与"打开文件夹"，且不会把弹窗提交掉', () => {
  const html = read('renderer/map.html');
  for (const id of IDS) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
    // 设置弹窗是 <form method="dialog">：不写 type="button" 的按钮会直接关掉弹窗
    // （表现就是"点了按钮，设置页没了、改动也没保存"）
    assert.match(html, new RegExp(`<button type="button" id="${id}"`), `#${id} 必须是 type="button"`);
  }
  assert.ok(html.includes('id="set-logs"') && html.includes('id="set-shots"'), '两个路径输入框要还在（仍可手输）');
  assert.ok(/选择文件夹/.test(html) && /打开文件夹/.test(html), '按钮上的中文说明要在界面上');

  const css = read('renderer/map.css');
  assert.ok(css.includes('.settings-form .dir-row'), '按钮要有个紧凑的排布样式');
});

test('接线：目录按钮 -> preload -> 主进程（只选目录 / 只开已存在的路径）', () => {
  const js = read('renderer/map.js');
  for (const id of IDS) {
    assert.ok(js.includes(`$('#${id}').addEventListener`), `#${id} 没有接线`);
  }
  assert.ok(js.includes('async function pickDirInto') && js.includes('async function openDir'), '缺少目录按钮的实现');
  assert.ok(js.includes('api.pickFolder(') && js.includes('api.openPath('), '要走 preload 暴露的 IPC');
  assert.ok(/pickDirInto[\s\S]{0,800}?input\.value = res\.path/.test(js), '选完要填进输入框');
  // 选目录只填输入框：落盘交给「保存」（避免点错就换目录、顺手重启监听）
  assert.ok(!/async function pickDirInto[\s\S]{0,900}?api\.setConfig/.test(js), '选择目录不该直接写配置');
  assert.ok(js.includes('if (res && res.error) alert(res.error)'), '失败要说出来，别静默');

  const pre = read('preload.js');
  assert.ok(pre.includes("ipcRenderer.invoke('util:pick-folder'"), '缺少 pickFolder');
  assert.ok(pre.includes("ipcRenderer.invoke('util:open-path'"), '缺少 openPath');

  const main = read('main.js');
  assert.ok(main.includes("ipcMain.handle('util:pick-folder'"), '缺少目录选择 IPC');
  assert.ok(main.includes("properties: ['openDirectory'"), '只选目录（别混进文件选择）');
  assert.ok(main.includes('isDirectory()'), '选择框的默认路径要确实是目录才用');
  assert.ok(main.includes("ipcMain.handle('util:open-path'"), '缺少打开目录 IPC');
  assert.ok(main.includes('shell.openPath(') && main.includes('shell.showItemInFolder('), '目录用 openPath、文件用 showItemInFolder');
  assert.ok(main.includes('目录不存在'), '路径不存在要给出可读的原因');
});
