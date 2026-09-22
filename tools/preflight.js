#!/usr/bin/env node
'use strict';

/**
 * 发布前闸门：一条命令把"能不能发 v<version>"查清楚。
 *
 * 查这些（每条都是以前真踩过或差一点踩到的坑）：
 *   1) 工作区是否干净、领先远端哪些提交（发布内容可追溯）
 *   2) 版本号是否三处一致：package.json / server/package.json / docker-compose 的镜像 tag
 *      （compose 指着不存在的 tag 是最容易犯的错）
 *   3) tag 是否已经存在（本地/远端）—— 别把已有版本覆盖掉
 *   4) 客户端 + 服务端测试全绿（可选 --no-tests 跳过）
 *   5) 打包产物：exe 存不存在、是不是比源码旧（旧了就提醒重建）、asar 内容检查
 *   6) 服务端镜像内容检查（可选，会跑一次 npm ci --omit=dev）
 *
 * 用法：
 *   node tools/preflight.js                 # 全套
 *   node tools/preflight.js --no-tests      # 跳过测试（快速看别的）
 *   node tools/preflight.js --with-image     # 额外跑一次"镜像内容"验收
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const results = [];
function check(name, ok, detail, warnOnly = false) {
  const status = ok ? 'PASS' : warnOnly ? 'WARN' : 'FAIL';
  results.push({ name, ok: !!ok, warnOnly, detail });
  console.log(`${status === 'PASS' ? 'PASS' : status === 'WARN' ? 'WARN' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || ROOT, encoding: 'utf-8', shell: process.platform === 'win32' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf-8'));
const pkg = readJson('package.json');
const srvPkg = readJson(path.join('server', 'package.json'));
const version = pkg.version;
const tag = `v${version}`;

console.log(`塔科夫地图 ${version} —— 发布前检查\n`);

// ---------------------------------------------------------------- 1) git
const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out;
const dirty = sh('git', ['status', '--porcelain']).out;
const ahead = sh('git', ['log', '--oneline', 'origin/main..HEAD']).out.split('\n').filter(Boolean);
check('工作区干净（没有未提交的改动）', dirty === '', dirty ? dirty.split('\n').length + ' 个文件有改动' : `分支 ${branch}`);
check('有可以发布的提交（领先 origin/main）', ahead.length > 0, `${ahead.length} 个提交：${ahead[0] || '-'}`);

// ---------------------------------------------------------------- 2) 版本一致
check('客户端与服务端版本号一致', pkg.version === srvPkg.version, `package.json ${pkg.version} / server ${srvPkg.version}`);
const compose = fs.readFileSync(path.join(ROOT, 'server', 'docker-compose.yml'), 'utf-8');
const imageTag = `ghcr.io/neppure/tarkov-offline-map-server:${srvPkg.version}`;
check('docker-compose 指的镜像 tag = 当前版本', compose.includes(imageTag), imageTag);
const artifact = `dist/塔科夫地图-${version}.exe`;

// ---------------------------------------------------------------- 3) tag 是否已存在
const localTag = sh('git', ['tag', '--list', tag]).out;
// 注意：ls-remote 失败（断网/代理不通）时它的输出是那句 fatal 报错，非空。
// 直接拿输出当"远端已有这个 tag"会给出一个吓人的假警报 —— 联网失败要说成联网失败。
const remoteRes = sh('git', ['ls-remote', '--tags', 'origin', tag]);
const remoteAsked = remoteRes.code === 0;
const remoteTag = remoteAsked ? remoteRes.out : '';
check(`tag ${tag} 尚未存在（不会覆盖已发布版本）`, remoteAsked && !localTag && !remoteTag,
  remoteAsked
    ? `本地=${localTag || '无'} 远端=${remoteTag ? '已存在' : '无'}`
    : `远端查询失败（断网 / 代理不通？）：${(remoteRes.out || '').split('\n')[0]}`,
  true);

// ---------------------------------------------------------------- 4) 测试
if (has('--no-tests')) {
  console.log('SKIP  测试（--no-tests）');
} else {
  console.log('      跑客户端测试…');
  const c = sh('npm', ['test'], { shell: true });
  const cLine = (c.out.match(/# pass \d+/) || [''])[0];
  const cFail = Number((c.out.match(/# fail (\d+)/) || [0, '1'])[1]);
  check('客户端测试全绿', c.code === 0 && cFail === 0, cLine);
  console.log('      跑服务端测试…');
  const s = sh('npm', ['--prefix', 'server', 'run', 'test'], { shell: true });
  const sLine = (s.out.match(/# pass \d+/) || [''])[0];
  const sFail = Number((s.out.match(/# fail (\d+)/) || [0, '1'])[1]);
  check('服务端测试全绿（含 Dockerfile/compose 一致性）', s.code === 0 && sFail === 0, sLine);
}

// ---------------------------------------------------------------- 5) 打包产物

/** 某个目录里最新的源码改动时间（跳过依赖/产物目录） */
const newestSrc = (dir) => {
  let best = 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) {
      if (['node_modules', 'test', 'data', 'dist', 'dist-server', 'build', '.git'].includes(f.name)) continue;
      best = Math.max(best, newestSrc(full));
    } else if (/\.(js|html|css|json)$/.test(f.name)) {
      best = Math.max(best, fs.statSync(full).mtimeMs);
    }
  }
  return best;
};

const exePath = path.join(ROOT, artifact);
if (!fs.existsSync(exePath)) {
  check('打包产物存在', false, `${artifact} 不存在（跑 npm run dist）`);
} else {
  const exeMtime = fs.statSync(exePath).mtimeMs;
  // 源码里最新的改动时间：main.js / src / renderer / server 的源码
  const srcMtime = Math.max(
    fs.statSync(path.join(ROOT, 'main.js')).mtimeMs,
    newestSrc(path.join(ROOT, 'src')),
    newestSrc(path.join(ROOT, 'renderer')),
    newestSrc(path.join(ROOT, 'server')),
  );
  const fresh = exeMtime > srcMtime;
  check('打包产物比源码新（不是旧包）', fresh,
    fresh ? `${artifact}（${(fs.statSync(exePath).size / 1048576).toFixed(1)}MB）` : '有源码改动晚于这个包，建议重新 npm run dist');
  const asar = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
  if (fs.existsSync(asar)) {
    const a = sh('node', ['tools/verify-asar.js', asar]);
    check('打包内容检查通过（含本版本代码、不含服务端本体）', a.code === 0, (a.out.match(/asar 文件条目数: \d+/) || [''])[0]);
  } else {
    check('能找到 win-unpacked/resources/app.asar', false, '跑一次 npm run dist 就有了');
  }
}

// 服务端单文件 exe（npm run dist:server）—— 可选交付路径，缺了只提醒不拦发布
{
  const srvName = `tarkov-offline-map-server-${srvPkg.version}-win-x64.exe`;
  const srvExe = path.join(ROOT, 'dist-server', srvName);
  if (fs.existsSync(srvExe)) {
    const srvMtime = fs.statSync(srvExe).mtimeMs;
    const srvSrc = Math.max(
      newestSrc(path.join(ROOT, 'server')),
      fs.statSync(path.join(ROOT, 'tools', 'make-server-exe.js')).mtimeMs,
    );
    const freshSrv = srvMtime > srvSrc;
    check('服务端 exe 比源码新（不是旧包）', freshSrv,
      freshSrv ? `${srvName}（${(fs.statSync(srvExe).size / 1048576).toFixed(1)}MB）`
        : '服务端源码改动晚于这个 exe，建议重新 npm run dist:server', true);
  } else {
    check('服务端 exe 存在（可选，CI 会构建）', false, `没找到 dist-server/${srvName}（本地跑 npm run dist:server）`, true);
  }
}

// ---------------------------------------------------------------- 6) 镜像内容
if (has('--with-image')) {
  console.log('      跑服务端镜像内容验收（会 npm ci --omit=dev）…');
  const img = sh('node', ['tools/verify-server-image.js']);
  const line = (img.out.match(/\d+\/\d+ 通过/) || [''])[0];
  check('镜像内容可用（文件集/依赖/健康检查/真客户端进房）', img.code === 0, line);
} else {
  console.log('SKIP  镜像内容验收（加 --with-image 才跑；真正的镜像由 CI 构建）');
}

// ---------------------------------------------------------------- 结论
const failed = results.filter((r) => !r.ok && !r.warnOnly);
const warned = results.filter((r) => !r.ok && r.warnOnly);
console.log(`\n${results.filter((r) => r.ok).length} 项通过${warned.length ? `，${warned.length} 项提醒` : ''}${failed.length ? `，${failed.length} 项未通过` : ''}`);
if (failed.length) {
  console.log('未通过：' + failed.map((f) => f.name).join('；'));
  process.exit(1);
}
console.log(`
发布就绪。推这两条即可（CI 会构建 exe Release + ghcr 服务端镜像）：
  git push origin main
  git tag ${tag} && git push origin ${tag}`);
