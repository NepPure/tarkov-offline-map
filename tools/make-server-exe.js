#!/usr/bin/env node
'use strict';

/**
 * 把房间服务端打成 **Windows 单文件 exe**（Node SEA：官方 Single Executable Application）。
 *
 * 产物：`dist-server/tarkov-offline-map-server-<版本>-win-x64.exe`，双击即启动（监听 0.0.0.0:8787），
 * 不需要装 Node、也不需要 Docker —— 给不想碰 docker 的 Windows 用户一条路。
 *
 * 做法（三步，都是官方推荐）：
 *   1) esbuild 把 server/server.js 连同 ws 打成一个自包含的 CJS 文件
 *      （SEA 的 blob 是单文件，不能有相对 require）；
 *   2) `node --experimental-sea-config` 生成 SEA blob；
 *   3) 复制一份当前 node.exe，用 postject 把 blob 注入（NODE_SEA_BLOB + 官方 sentinel fuse）。
 *
 * 打完之后默认会做一次**真启动自检**：跑 `exe --version`、`exe --help`，
 * 再用 `exe --port 0` 起一个实例、请求 /healthz 确认返回 ok，然后关掉。
 *
 * 用法：
 *   node tools/make-server-exe.js                 # 构建 + 自检
 *   node tools/make-server-exe.js --no-smoke      # 只构建
 *   node tools/make-server-exe.js --keep-temp     # 保留中间产物（排查用）
 *
 * 注意：SEA 的 exe 与平台绑定 —— 只能在 Windows 上打出 Windows exe（CI 里跑 windows-latest）。
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const OUT_DIR = path.join(ROOT, process.env.TARKOV_SERVER_EXE_OUT || 'dist-server');
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const NO_SMOKE = hasFlag('--no-smoke');
const KEEP_TEMP = hasFlag('--keep-temp');

// Node 官方的 SEA 注入约定（见 nodejs/node 文档 "Single executable applications"）
// fuse 这串必须**逐字符**和 node.exe 里的一致（少一个字母就会报 "Could not find the sentinel"）：
// 可以从二进制里直接确认：node -e "console.log(require('fs').readFileSync(process.execPath).indexOf(Buffer.from('NODE_SEA_FUSE_')))"
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const SEA_RESOURCE = 'NODE_SEA_BLOB';

const serverPkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf-8'));
const version = serverPkg.version;
const exeName = `tarkov-offline-map-server-${version}-win-x64.exe`;
const exePath = path.join(OUT_DIR, exeName);
const tmpDir = path.join(OUT_DIR, '.tmp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (p) => (fs.statSync(p).size / 1048576).toFixed(1);
const log = (msg) => console.log(`[server-exe] ${msg}`);

function die(msg) {
  console.error(`\n[server-exe] 失败：${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1) esbuild 打包
// ---------------------------------------------------------------------------
async function bundle() {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    die('缺少 esbuild：先跑 `npm install`（它是 devDependency）');
  }
  const outfile = path.join(tmpDir, 'server-sea.cjs');
  log('打包 server/server.js（含 ws）…');
  await esbuild.build({
    entryPoints: [path.join(SERVER_DIR, 'server.js')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    logLevel: 'warning',
    legalComments: 'none',
    // ws 的可选加速依赖：装了就快一点、没装也能跑（ws 自己在 try/catch 里 require）。
    // 在 SEA 里它们本来也加载不到，留成运行时 require 让它走 ws 的兜底分支。
    external: ['bufferutil', 'utf-8-validate'],
  });
  const text = fs.readFileSync(outfile, 'utf-8');
  // blob 里不能有相对 require 残留（SEA 解析不到）：这里做个兜底断言
  const relRequire = text.match(/require\(["']\.{1,2}\//);
  if (relRequire) die(`打包结果里还有相对 require（${relRequire[0]}），SEA 跑不起来`);
  if (!text.includes(version)) log(`提示：打包结果里没看到版本号 ${version}（不影响运行）`);
  log(`打包完成：${outfile}（${(fs.statSync(outfile).size / 1024).toFixed(0)}KB）`);
  return outfile;
}

// ---------------------------------------------------------------------------
// 2) SEA blob
// ---------------------------------------------------------------------------
function makeBlob(bundlePath) {
  const blobPath = path.join(tmpDir, 'server-sea.blob');
  const cfgPath = path.join(tmpDir, 'sea-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }, null, 2));
  log('生成 SEA blob…');
  const r = spawnSync(process.execPath, ['--experimental-sea-config', cfgPath], { encoding: 'utf-8' });
  if (r.status !== 0 || !fs.existsSync(blobPath)) {
    die(`生成 blob 失败：${(r.stderr || r.stdout || '').trim().split('\n').slice(-4).join(' / ')}`);
  }
  log(`blob 完成（${(fs.statSync(blobPath).size / 1024).toFixed(0)}KB）`);
  return blobPath;
}

// ---------------------------------------------------------------------------
// 3) 复制 node.exe + 注入
//
// 为什么注入要单开一个进程（真踩过）：
// postject 内部是个 emscripten 模块，它把结果放回堆上的 typed array，而 api.js 用的是
// `Buffer.from(data.buffer)`。构建脚本里先跑过 esbuild（堆已经长过一次）之后再调用注入，
// 堆再次增长会让之前那个 ArrayBuffer 失效 —— postject 拿去搜 sentinel 的内存就成空的了，
// 报 "Could not find the sentinel ... in the binary"。
// 单开一个"只做注入"的新进程（--inject-only），堆从零开始，稳定成功。
// ---------------------------------------------------------------------------
async function injectInto(exe, blob) {
  const postject = require('postject');
  await postject.inject(exe, SEA_RESOURCE, fs.readFileSync(blob), { sentinelFuse: SEA_FUSE });
}

async function injectExe(blobPath) {
  try {
    require('postject');
  } catch {
    die('缺少 postject：先跑 `npm install`（它是 devDependency）');
  }
  log(`复制 ${path.basename(process.execPath)}（${mb(process.execPath)}MB）作为宿主…`);
  fs.copyFileSync(process.execPath, exePath);
  log('注入 SEA blob（单开一个干净进程做注入）…');
  const r = spawnSync(process.execPath, [__filename, '--inject-only', exePath, blobPath], {
    encoding: 'utf-8',
    timeout: 180000,
    // stdio 继承：这个环境里父进程读子进程管道有时收不到数据，继承最稳，CI 里也一样
    stdio: process.env.TARKOV_SERVER_EXE_QUIET ? 'ignore' : 'inherit',
  });
  if (r.status !== 0) die(`注入失败（exit ${r.status}）`);
  log(`产物：${exePath}（${mb(exePath)}MB）`);
}

// ---------------------------------------------------------------------------
// 4) 自检：真启动一次
// ---------------------------------------------------------------------------
function runOneShot(args) {
  const r = spawnSync(exePath, args, { encoding: 'utf-8', timeout: 20000, env: { ...process.env, TARKOV_NO_PAUSE: '1' } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function getHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 3000, headers: { connection: 'close' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function smoke() {
  log('自检 1/3：--version');
  const v = runOneShot(['--version']);
  if (v.code !== 0 || !v.out.includes(version)) die(`--version 输出不对：${JSON.stringify(v.out.slice(0, 200))}（exit ${v.code}）`);
  log(`      OK -> ${v.out.trim()}`);

  log('自检 2/3：--help');
  const h = runOneShot(['--help']);
  if (h.code !== 0 || !h.out.includes('--port')) die(`--help 输出不对：${JSON.stringify(h.out.slice(0, 200))}`);
  log('      OK（用法里能看到 --port 等开关）');

  log('自检 3/3：真起一个实例（--port 0）并请求 /healthz');
  // 子进程输出重定向到文件：这里的沙箱/父进程可能读不了管道，文件最稳
  const outFile = path.join(tmpDir, 'smoke.log');
  fs.writeFileSync(outFile, '');
  const fd = fs.openSync(outFile, 'a');
  const child = spawn(exePath, ['--port', '0', '--log-level', 'info'], {
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: { ...process.env, TARKOV_NO_PAUSE: '1', PERSIST: '0' },
  });
  let health = null;
  try {
    let port = null;
    for (let i = 0; i < 40 && !port; i++) {
      await sleep(250);
      const text = fs.readFileSync(outFile, 'utf-8');
      const m = text.match(/正在监听：[^:\n]*:(\d+)/);
      if (m) port = Number(m[1]);
      else if (/启动失败/.test(text)) die(`实例启动失败：${text.trim().split('\n').slice(-3).join(' / ')}`);
    }
    if (!port) die(`没等到监听端口，日志：${fs.readFileSync(outFile, 'utf-8').trim().slice(-300)}`);
    for (let i = 0; i < 20 && !health; i++) {
      health = await getHealth(port);
      if (!health) await sleep(250);
    }
    if (!health || health.ok !== true) die(`/healthz 没返回 ok：${JSON.stringify(health)}（日志：${fs.readFileSync(outFile, 'utf-8').trim().slice(-200)}）`);
    log(`      OK -> ${JSON.stringify({ ver: health.ver, proto: health.proto, peers: health.peers })}（端口 ${port}）`);
    console.log(fs.readFileSync(outFile, 'utf-8').split('\n').filter(Boolean).slice(0, 8).map((l) => `      | ${l}`).join('\n'));
  } finally {
    try { child.kill(); } catch {}
    try { fs.closeSync(fd); } catch {}
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
async function runBuild() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) die(`Node 版本太低（${process.versions.node}）：SEA 需要 Node 20+`);
  if (process.platform !== 'win32') {
    die(`SEA 产物与平台绑定：当前是 ${process.platform}，Windows exe 只能在 Windows 上打（CI 用 windows-latest）`);
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.rmSync(exePath, { force: true });

  const bundlePath = await bundle();
  const blobPath = makeBlob(bundlePath);
  await injectExe(blobPath);
  if (!NO_SMOKE) await smoke();
  else log('跳过自检（--no-smoke）');

  if (!KEEP_TEMP) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  } else {
    log(`中间产物保留在 ${tmpDir}`);
  }
  console.log(`\n[server-exe] 完成：${exePath}（${mb(exePath)}MB）  v${version}`);
  console.log(`[server-exe] 双击启动，或命令行： ${exeName} --port 8787 --persist --data-dir D:\\room-annos`);
}

// 入口：--inject-only 只在子进程里做注入；否则跑完整构建
if (hasFlag('--inject-only')) {
  const i = argv.indexOf('--inject-only');
  const exe = argv[i + 1];
  const blob = argv[i + 2];
  if (!exe || !blob) die('--inject-only 用法：--inject-only <exe> <blob>');
  injectInto(exe, blob)
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`[server-exe] 注入失败：${(e && e.message) || e}`);
      process.exit(1);
    });
} else {
  runBuild().catch((e) => die((e && e.stack) || String(e)));
}
