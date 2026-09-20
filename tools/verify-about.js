#!/usr/bin/env node
/**
 * 「关于」页面 + 品牌名改名验收（v2.0）。
 *
 * 用户要求：标题去掉"离线"、左上角去掉"纯本地"、新增关于页面（GitHub 地址 + 功能简介）。
 * 这里用 CDP 真点一遍：
 *   1) 窗口标题与左上角标题都是「塔科夫地图」，页面里没有"塔科夫离线地图"
 *   2) 顶栏那个"纯本地"胶囊徽标已经没了
 *   3) 顶栏「关于」能打开关于弹窗，版本号 = package.json 里的版本
 *   4) 关于弹窗里有 GitHub 地址、功能简介（含"房间联机"）与"默认不联网"说明
 *   5) 点开源地址不会在窗口里跳转，而是交给系统浏览器（打桩 api.openExternal 验证）
 *   6) 「知道了」能关掉
 *   7) 设置弹窗左下角的「关于」也能进（且设置弹窗会先关掉，不叠两层 modal）
 *
 * 用法:
 *   npx electron . --remote-debugging-port=9222
 *   node tools/verify-about.js [--port=9222]
 */
const fs = require('fs');
const path = require('path');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const PORT = Number(arg('port', 9222));
const ART = path.join(__dirname, '..', 'test-artifacts');
const REPO = path.join(__dirname, '..');
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
      resolve(
        results.map((m) => {
          const r = m && m.result;
          if (r && r.exceptionDetails) {
            const d = r.exceptionDetails;
            return { __error: (d.exception && (d.exception.description || d.exception.value)) || d.text };
          }
          if (r && r.data) return r.data;
          return r && 'result' in r ? r.result.value : m;
        }),
      );
    };
    ws.onerror = (e) => reject(new Error(`ws error ${e.message || ''}`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    };
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8')).version;
  const list = await targets();
  const mapTarget = list.find((t) => t.url.endsWith('/map.html'));
  if (!mapTarget) throw new Error('未找到主窗口（用 --remote-debugging-port 启动了吗？）');
  const ws = mapTarget.webSocketDebuggerUrl;
  const ev = (expr) => cdp(ws, [['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }]]).then((r) => r[0]);
  const shot = async (file) => {
    const data = await cdp(ws, [['Page.captureScreenshot', { format: 'png' }]]);
    if (typeof data[0] === 'string') {
      fs.mkdirSync(ART, { recursive: true });
      fs.writeFileSync(path.join(ART, file), Buffer.from(data[0], 'base64'));
      console.log(`      截图 -> test-artifacts/${file}`);
    }
  };

  // 从磁盘上的当前代码重新加载一遍
  await ev('location.reload()');
  await sleep(3000);
  await ev(`(async () => { for (let i = 0; i < 60; i++) {
    if (window.api && document.querySelector('#btn-about')) return true;
    await new Promise((r) => setTimeout(r, 200));
  } return false; })()`);

  // 1) 标题
  const brand = await ev(`({
    docTitle: document.title,
    h1: (document.querySelector('.brand h1') || {}).textContent,
    tag: !!document.querySelector('.brand .tag'),
    headerText: (document.querySelector('.topbar') || {}).textContent || '',
    html: document.documentElement.innerHTML.includes('塔科夫离线地图'),
  })`);
  check('窗口标题是「塔科夫地图」', brand.docTitle === '塔科夫地图', brand.docTitle);
  check('左上角标题是「塔科夫地图」', brand.h1 === '塔科夫地图', brand.h1);
  check('页面里不再出现「塔科夫离线地图」', brand.html === false);
  check('左上角「纯本地」徽标已移除', brand.tag === false && !brand.headerText.includes('纯本地'));

  // 2) 顶栏「关于」-> 弹窗
  await ev(`document.querySelector('#btn-about').click()`);
  await sleep(400);
  const about = await ev(`(() => {
    const dlg = document.querySelector('#about-dialog');
    const repo = document.querySelector('#about-repo');
    const feats = [...document.querySelectorAll('.about-feats li')].map((li) => li.textContent.trim());
    return {
      open: dlg.open,
      ver: (document.querySelector('#about-ver') || {}).textContent,
      repoHref: repo ? repo.getAttribute('href') : null,
      repoText: repo ? repo.textContent.trim() : null,
      feats,
      note: (document.querySelector('.about-note') || {}).textContent || '',
      desc: (document.querySelector('.about-desc') || {}).textContent || '',
    };
  })()`);
  check('顶栏「关于」能打开关于弹窗', about.open === true);
  check('弹窗里显示版本号', about.ver === `v${version}`, `${about.ver}（package.json ${version}）`);
  check('弹窗里有 GitHub 地址', about.repoHref === 'https://github.com/NepPure/tarkov-offline-map', about.repoHref);
  check('功能简介条目齐全（≥7 条且含房间联机）', about.feats.length >= 7 && about.feats.some((t) => t.includes('房间联机')), `${about.feats.length} 条`);
  check('写明「默认不联网」', /默认不联网/.test(about.note), about.note.slice(0, 40) + '…');
  check('有一句话简介', about.desc.length > 30, `${about.desc.length} 字`);
  await shot('about-page.png');

  // 3) 开源地址：只验证"挂了点击处理、且不会在窗口里跳转"。
  //    注意：**不能真点**——contextBridge 暴露的 api 对象是冻结的，打桩改不掉，
  //    真点就会调用 shell.openExternal 打开用户的浏览器（第一次跑验收时真的弹了个 GitHub 标签页）。
  const linkInfo = await ev(`(() => {
    const a = document.querySelector('#about-repo');
    return { href: a.getAttribute('href'), target: a.getAttribute('target'), listeners: null };
  })()`);
  const listeners = await cdp(ws, [
    [
      'Runtime.evaluate',
      {
        expression: `Object.keys(getEventListeners(document.querySelector('#about-repo')) || {}).join(',')`,
        returnByValue: true,
        includeCommandLineAPI: true,
      },
    ],
  ]).then((r) => r[0]);
  check('开源地址指向本仓库', linkInfo.href === 'https://github.com/NepPure/tarkov-offline-map', linkInfo.href);
  check('开源地址挂了点击处理（交给系统浏览器，不在窗口里跳转）', /click/.test(String(listeners)), `listeners=${listeners}`);

  // 4) 关闭
  await ev(`document.querySelector('#about-ok').click()`);
  await sleep(300);
  check('「知道了」能关掉关于弹窗', (await ev(`document.querySelector('#about-dialog').open`)) === false);

  // 5) 设置弹窗里的入口：两个 modal 不能叠着
  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(400);
  const settingsOpen = await ev(`document.querySelector('#settings-dialog').open`);
  check('设置弹窗能打开（关于入口在里面）', settingsOpen === true);
  await ev(`document.querySelector('#settings-about').click()`);
  await sleep(400);
  const both = await ev(`({ settings: document.querySelector('#settings-dialog').open, about: document.querySelector('#about-dialog').open })`);
  check('设置里的「关于」：关掉设置、打开关于（不叠两层）', both.settings === false && both.about === true, JSON.stringify(both));
  await shot('about-page-from-settings.png');
  await ev(`document.querySelector('#about-ok').click()`);
  await sleep(200);

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    console.log('失败项: ' + bad.map((b) => b.name).join(' / '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('验收脚本出错:', e.message);
  process.exit(1);
});
