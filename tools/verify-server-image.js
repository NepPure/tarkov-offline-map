#!/usr/bin/env node
/**
 * 没有 Docker 也能验证镜像"内容"是否是好的。
 *
 * 做法：完全照着 server/Dockerfile 的步骤在临时目录里复刻一遍镜像里的文件集：
 *   1) 只把 Dockerfile 里 COPY 的那几个文件放进"镜像目录"
 *   2) npm ci --omit=dev（和生产镜像同一条命令）
 *   3) 用 `node server.js` 起服务
 *   4) 跑 Dockerfile 里那条 **HEALTHCHECK 原命令**，看是否返回 0
 *   5) 再用一个真 WebSocket 客户端走一遍 hello -> 进房 -> 画一笔标注
 * 最后把临时目录删掉。
 *
 * 这样能抓住最常见的镜像事故：少 COPY 一个被 require 的文件、lock 文件没带、
 * 健康检查命令写错、只装 dev 依赖导致 ws 缺失……（真正的 alpine 基础镜像与
 * docker build 本身只能由 CI 验证）
 *
 * 用法： node tools/verify-server-image.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** 从 Dockerfile 里解析出"从构建上下文 COPY 进来的文件" */
function dockerCopyList(dockerfile) {
  const out = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    const s = line.trim();
    if (!/^COPY /i.test(s)) continue;
    const parts = s.split(/\s+/).slice(1);
    if (parts.some((p) => p.startsWith('--from='))) continue;
    if (parts.length < 2) continue;
    parts.pop();
    for (const src of parts) out.push(src.replace(/^\.\//, ''));
  }
  return out;
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

(async () => {
  const dockerfile = fs.readFileSync(path.join(SERVER, 'Dockerfile'), 'utf-8');
  const files = dockerCopyList(dockerfile);
  check('从 Dockerfile 解析出 COPY 清单', files.includes('server.js') && files.includes('package-lock.json'), files.join(', '));

  const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takov-image-'));
  let proc = null;
  try {
    for (const f of files) {
      const src = path.join(SERVER, f);
      if (!fs.existsSync(src)) {
        check(`镜像目录里放入 ${f}`, false, '源文件不存在');
        continue;
      }
      fs.copyFileSync(src, path.join(imgDir, path.basename(f)));
    }
    const present = fs.readdirSync(imgDir).sort();
    check('镜像目录内容 = Dockerfile 说的那几个文件', present.length === files.length, present.join(', '));

    // 2) npm ci --omit=dev（和 Dockerfile 同一条命令）
    const ci = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: imgDir,
      shell: true,
      encoding: 'utf-8',
    });
    check('npm ci --omit=dev 成功（lock 文件可用、依赖能装）', ci.status === 0, (ci.stderr || ci.stdout || '').trim().split('\n').slice(-1)[0] || '');
    const wsPkg = path.join(imgDir, 'node_modules', 'ws', 'package.json');
    check('运行时依赖 ws 装进去了', fs.existsSync(wsPkg), fs.existsSync(wsPkg) ? `ws ${JSON.parse(fs.readFileSync(wsPkg, 'utf-8')).version}` : '缺失');

    // 3) 起服务（和镜像一样：只靠镜像目录里的文件）
    const port = await freePort();
    proc = spawn(process.execPath, ['server.js'], {
      cwd: imgDir,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'warn', PERSIST: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    proc.stdout.on('data', (d) => {
      log += String(d);
    });
    proc.stderr.on('data', (d) => {
      log += String(d);
    });
    let up = false;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (r.ok) {
          up = true;
          break;
        }
      } catch {}
      await sleep(150);
    }
    check('镜像目录里 node server.js 起得来', up, up ? `端口 ${port}` : log.slice(0, 200));

    // 4) 跑 Dockerfile 里那条 HEALTHCHECK 原命令
    const hcLine = (dockerfile.match(/HEALTHCHECK[\s\S]*?CMD (.*)/) || [])[1] || '';
    const hcCmd = hcLine.replace(/^CMD\s*/, '').replace(/^\[|\]$/g, '').replace(/"/g, '');
    const hc = spawnSync(process.execPath, ['-e', hcCmd.replace(/^\s*node -e\s*/, '')], {
      cwd: imgDir,
      env: { ...process.env, PORT: String(port) },
      shell: false,
      encoding: 'utf-8',
    });
    check('Dockerfile 的 HEALTHCHECK 命令返回 0（健康）', hc.status === 0, `exit=${hc.status}`);
    // 换个不存在的端口，必须返回 1（否则"健康"是假的）
    const hcBad = spawnSync(process.execPath, ['-e', hcCmd.replace(/^\s*node -e\s*/, '')], {
      cwd: imgDir,
      env: { ...process.env, PORT: String(port + 1) },
      shell: false,
      encoding: 'utf-8',
    });
    check('端口没人监听时 HEALTHCHECK 返回 1（能真的发现故障）', hcBad.status === 1, `exit=${hcBad.status}`);

    // 5) 真 WebSocket 客户端走一遍（用仓库里那份客户端，不引服务端代码）
    const { RoomClient } = require('../src/room-client');
    const c = new RoomClient({ onLog: () => {} });
    c.applyConfig({ enabled: true, url: '127.0.0.1', port, roomId: '镜像验收', nick: '镜像号' });
    let online = false;
    for (let i = 0; i < 60; i++) {
      if (c.snapshot().status === 'online') {
        online = true;
        break;
      }
      await sleep(100);
    }
    check('真客户端能连上镜像目录里的服务端并进房', online, c.snapshot().status);
    c.sendAnnoAdd({ map: 'woods', id: 'img1', kind: 'pen', color: '#ffffff', width: 2, pts: [{ x: 1, z: 1 }, { x: 2, z: 2 }] });
    let echoed = false;
    for (let i = 0; i < 30; i++) {
      if ((c.snapshot().annos.woods || []).length) {
        echoed = true;
        break;
      }
      await sleep(100);
    }
    check('标注能存进去并回显（房间功能在镜像里真的能用）', echoed);
    c.destroy();
  } finally {
    if (proc) {
      try {
        proc.kill();
      } catch {}
    }
    await sleep(300);
    try {
      fs.rmSync(imgDir, { recursive: true, force: true });
    } catch {}
  }

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
