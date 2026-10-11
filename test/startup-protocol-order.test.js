'use strict';

/**
 * 启动顺序不变量：`app://` 的协议处理器必须先于**任何窗口创建**。
 *
 * 背景（用户反馈的"每次启动弹一个系统框，标题是『获取打开此'app'链接的应用』"）：
 * createSplashWindow() 一执行就 loadURL('app://renderer/splash.html')。若那一刻
 * protocol.handle('app', …) 还没注册，Chromium 不认这个自定义 scheme，会把这次顶层
 * 导航当**外部协议**交给 Windows ShellExecute，于是弹出系统对话框。
 *
 * efb85aa（"启动图窗口提前创建"）为了缩短冷启动空档，把 createSplashWindow() 挪到了
 * app.whenReady() 第一行、registerAppProtocol() 之前，正好踩中这个坑。这条测试负责钉住顺序。
 *
 * 注意：必须先在 whenReady 的**回调体**里找调用点，不能对整个文件 indexOf ——
 * 否则 `registerAppProtocol` 会先命中函数定义（main.js 靠前处）、`createSplashWindow()`
 * 会命中函数定义，即便 bug 还在也会假通过。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const WHEN_READY = 'app.whenReady().then(() => {';

/**
 * 切出 app.whenReady() 的回调体，避免命中上方那些同名**函数定义**。
 * 同时丢掉整行注释：说明性注释里提到 `registerAppProtocol()` 是很正常的事，
 * 不该被当成"又一次调用"（第一版就是这么误报的）。
 */
function whenReadyBody(main) {
  const at = main.indexOf(WHEN_READY);
  assert.ok(at > -1, `main.js 里找不到 ${WHEN_READY}`);
  // 回调体结束于文件里第一个顶格的 `});`
  const end = main.indexOf('\n});\n', at);
  const body = end > at ? main.slice(at, end) : main.slice(at);
  // 只丢"整行都是注释"的行 —— 不能无脑 strip `//`，否则 'app://…' 这类字符串会被截断
  return body.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
}

test('启动顺序：app:// 协议先注册，窗口后创建', () => {
  const body = whenReadyBody(read('main.js'));

  const regAt = body.indexOf('registerAppProtocol()');
  assert.ok(regAt > -1, 'whenReady 里没调用 registerAppProtocol()：app:// 根本不会被注册');
  assert.strictEqual(
    body.indexOf('registerAppProtocol()', regAt + 1), -1,
    'whenReady 里重复注册了 app:// 协议'
  );

  // 本次修复的核心：启动图窗口必须排在协议注册之后
  const splashAt = body.indexOf('createSplashWindow()');
  assert.ok(splashAt > -1, 'whenReady 里没创建启动图窗口');
  assert.ok(
    splashAt > regAt,
    '启动图窗口早于 app:// 协议注册：Chromium 会把 app:// 当外部协议交给系统，' +
      '弹出「获取打开此\'app\'链接的应用」系统对话框'
  );

  // 推广成不变量：任何窗口创建都不许排在协议注册之前（启动图只是最容易踩的那个）
  const windows = [...body.matchAll(/create[A-Za-z]*Window\(/g)].map((m) => ({ name: m[0], at: m.index }));
  assert.ok(windows.length > 0, '一个窗口创建调用都没匹配到，说明这段匹配方式已经和 main.js 脱节了');
  for (const w of windows) {
    assert.ok(
      w.at > regAt,
      `${w.name} 排在 registerAppProtocol() 之前：窗口一创建就 loadURL('app://…')，会被系统接管`
    );
  }
});
