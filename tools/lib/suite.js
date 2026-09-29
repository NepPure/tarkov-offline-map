'use strict';

/**
 * 验收套件的"外壳"：断言计数、隔离配置目录、假截图。
 *
 * 抽出来的原因很实际：以前每个 verify-*.js 都自己写一遍 check/summary/临时目录，
 * 结果就是 21 个脚本 21 种写法，跑一遍要人工汇总，失败也说不清是哪一项。
 * 现在统一：
 *   - `createReport()` 打印 `PASS/FAIL  名字  — 细节`，收尾打印 `N/M 通过`，
 *     有失败就把 `process.exitCode` 设成 1（CI 与 runner 只看退出码）；
 *   - 设了 `TAKOV_VERIFY_REPORT=<路径>` 时还会写一份机器可读的 JSON 给 runner 汇总；
 *   - `makeProfile()` 造一份完全隔离的配置目录（临时目录 + shots/logs），
 *     **绝不碰用户日常那份 settings.json / annotations.json**。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 断言 + 汇总 + 退出码 */
function createReport(title) {
  const results = [];
  const check = (name, ok, detail) => {
    const hit = !!ok;
    results.push({ name, ok: hit, detail: detail === undefined ? '' : String(detail) });
    console.log(`${hit ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    return hit;
  };
  const failed = () => results.filter((r) => !r.ok);
  return {
    title,
    results,
    check,
    get total() { return results.length; },
    get passed() { return results.length - failed().length; },
    get failed() { return failed(); },
    summary() {
      const f = failed();
      return `${title}：${results.length - f.length}/${results.length} 通过`
        + (f.length ? `，失败 ${f.length} 项：${f.map((x) => x.name).join('、')}` : '，全绿');
    },
    /** 打印汇总 + 落报告 + 定退出码；返回是否全绿 */
    finish() {
      const line = this.summary();
      console.log('\n' + line);
      const out = process.env.TAKOV_VERIFY_REPORT;
      if (out) {
        try {
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, JSON.stringify({
            title, total: results.length, passed: this.passed,
            failed: failed().map((r) => ({ name: r.name, detail: r.detail })),
            results,
          }, null, 2));
        } catch (e) {
          console.log('（报告写入失败：' + e.message + '）');
        }
      }
      if (failed().length) process.exitCode = 1;
      return failed().length === 0;
    },
  };
}

const WORKSPACE = path.join(__dirname, '..', '..');
let tmpRootCache = null;

/**
 * 隔离配置的临时根目录：默认放工作区里的 test-artifacts/profiles。
 *
 * 为什么不直接用 os.tmpdir()：**受限宿主会给子进程（Electron）限制 %TEMP% 的写入** ——
 * 症状是 Chromium 连自己的 Code Cache / DevToolsActivePort 都建不出来（日志里一串
 * 拒绝访问 (0x5)），主进程写 app.log / settings.json 也会被静默吞掉（appLog 的 try/catch）。
 * 结果就是「验收里没有 app.log」这种看着像功能坏了、其实是环境的事。工作区里可写，
 * 而且跑完照样按 profile 删干净（run 目录在 .gitignore 的 test-artifacts/ 下）。
 *
 * 覆盖方式：TAKOV_VERIFY_TMP=<目录>；工作区建不出来时回退 os.tmpdir()。
 */
function tmpRoot() {
  if (tmpRootCache) return tmpRootCache;
  const env = process.env.TAKOV_VERIFY_TMP;
  if (env) { fs.mkdirSync(env, { recursive: true }); tmpRootCache = env; return env; }
  const ws = path.join(WORKSPACE, 'test-artifacts', 'profiles');
  try { fs.mkdirSync(ws, { recursive: true }); tmpRootCache = ws; return ws; }
  catch { tmpRootCache = os.tmpdir(); return tmpRootCache; }
}

/** 建一个隔离的临时目录（前缀区分套件）；profile 全落在 tmpRoot() 下 */
function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(tmpRoot(), prefix));
}

/**
 * 造一份隔离配置：目录全在临时目录里，房间关掉，别带用户身份。
 * @param {string} prefix 临时目录前缀（如 'takov-raster-'）
 * @param {object} [settings] 覆盖/追加的配置项
 * @param {{keep?: boolean}} [opts] keep=true 时不自动删（排查用）
 */
function makeProfile(prefix, settings = {}, opts = {}) {
  const userData = mkTempDir(prefix);
  const shots = path.join(userData, 'shots');
  const logs = path.join(userData, 'logs');
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    screenshotsPath: shots,
    logsPath: logs,
    sound: false,
    autoDeleteScreenshots: false,
    markerToggles: null,        // 全部标记打开
    miniVisible: false,         // 雷达默认关，验"勾上真的会开"
    room: { enabled: false },   // 绝不拿用户身份连真实房间
    ...settings,
  }, null, 2));
  return {
    userData,
    shots,
    logs,
    keep: !!opts.keep,
    path: (...p) => path.join(userData, ...p),
    read: (name) => { try { return fs.readFileSync(path.join(userData, name), 'utf-8'); } catch { return ''; } },
    cleanup() {
      if (this.keep) {
        console.log('（保留隔离配置目录：' + userData + '）');
        return;
      }
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
    },
  };
}

/** 游戏真实格式的假截图名：坐标不同 = 新的一次定位 */
const shotName = (x, z, y = 3.2) =>
  `2026-09-18[22-00]_${x}, ${y}, ${z}_0.01518, 0.90924, -0.03197, 0.41476_15.47 (0).png`;

/** 往隔离截图目录里丢一张 1x1 假截图（走真实定位链路用） */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
function writeShot(shotsDir, pos, name) {
  fs.mkdirSync(shotsDir, { recursive: true });
  const file = path.join(shotsDir, name || shotName(pos.x, pos.z, pos.y));
  fs.writeFileSync(file, PNG_1X1);
  return file;
}

module.exports = { createReport, makeProfile, mkTempDir, tmpRoot, shotName, writeShot, PNG_1X1 };
