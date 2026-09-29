'use strict';

/**
 * 验收脚本共用的极简 CDP 客户端（Chrome DevTools Protocol over WebSocket）。
 *
 * 只用 Node 内置的 fetch / WebSocket，不引第三方依赖 —— 验收脚本要能在
 * `npm ci --omit=dev` 的干净环境里跑。所有等待都是"条件满足即返回 + 硬超时"，
 * 没有固定 sleep：窗口被遮挡、进程已死时截图会永远不回，硬超时保证脚本能走到收尾。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 列出调试端口下的所有页面（进程没起来时 fetch 会抛，调用方自己决定重试） */
async function targets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

/**
 * 在一条新 ws 上顺序执行若干 CDP 调用，返回映射后的结果数组。
 * 每次求值新开一条 ws：这些调用都是低频的，省掉长连接的断线重连逻辑。
 * @param {string} wsUrl
 * @param {Array<[string, object]>} calls [[方法名, 参数], ...]
 * @param {number} [timeoutMs]
 */
function cdp(wsUrl, calls, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    let done = false;
    const pending = new Map();
    const results = [];
    const hard = setTimeout(() => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      reject(new Error(`CDP 超时（${timeoutMs}ms）：${calls.map((c) => c[0]).join(',')}`));
    }, timeoutMs);
    ws.onopen = async () => {
      for (const [method, params] of calls) {
        const myId = ++id;
        const p = new Promise((res) => pending.set(myId, res));
        ws.send(JSON.stringify({ id: myId, method, params }));
        results.push(await p);
      }
      ws.close();
      if (done) return;
      done = true;
      clearTimeout(hard);
      resolve(results.map((m) => {
        const r = m && m.result;
        if (r && r.exceptionDetails) {
          const d = r.exceptionDetails;
          return { __error: (d.exception && (d.exception.description || d.exception.value)) || d.text };
        }
        if (r && r.data) return r.data;
        return r && 'result' in r ? r.result.value : m;
      }));
    };
    ws.onerror = (e) => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      reject(new Error('ws error ' + (e.message || '')));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    };
  });
}

/** 求值一个表达式并返回它的值；表达式里抛异常时把异常抛到脚本里（方便定位） */
async function evaluate(wsUrl, expr, timeoutMs = 15000) {
  const v = await cdp(wsUrl, [
    ['Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }],
  ], timeoutMs);
  const r = v[0];
  if (r && r.__error) throw new Error(r.__error);
  return r;
}

/**
 * 等一个条件成立；返回最后一次的值（超时也返回它，调用方自己判真假）。
 * @param {() => Promise<any>} fn
 */
async function waitFor(fn, timeoutMs = 8000, step = 250) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() >= until) return last;
    await sleep(step);
  }
}

/**
 * 等某个页面出现。
 * @param {number} port
 * @param {(t: object) => boolean} match
 * @returns {Promise<object|null>} 超时返回 null
 */
function waitForTarget(port, match, timeoutMs = 30000, step = 250) {
  return waitFor(async () => {
    try { return (await targets(port)).find(match) || null; } catch { return null; }
  }, timeoutMs, step);
}

/** 截图到文件（目录不存在会建）；返回写入的路径 */
async function screenshot(wsUrl, file, timeoutMs = 20000) {
  const r = await cdp(wsUrl, [['Page.captureScreenshot', { format: 'png' }]], timeoutMs);
  const data = r[0];
  if (!data || typeof data !== 'string') throw new Error('截图失败: ' + JSON.stringify(data));
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

module.exports = { sleep, targets, cdp, evaluate, waitFor, waitForTarget, screenshot };
