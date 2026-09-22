#!/usr/bin/env node
/**
 * 服务端**单文件 exe** 的端到端验收（tools/make-server-exe.js 的产物）。
 *
 * 做法：
 *   1) 找到 exe（默认取 dist-server 里最新的那个），跑一下 --version / --help
 *   2) 用 `--port 0` 真的起一个实例（stdout 重定向到文件：读管道在本机沙箱/父进程里有时收不到数据）
 *   3) 从启动横幅解析出端口 -> GET /healthz
 *   4) 用仓库里那份**真客户端**（src/room-client.js）连两个进来走一遍联机：
 *      进房 / 互看位置与轨迹 / 椭圆标注同步 / 开新局清残留（newraid -> peer-reset）/ 离开
 *   5) 收尾关掉 exe，确认进程真的退了
 *
 * 用法：
 *   node tools/verify-server-exe.js                    # 验收 dist-server 里最新的 exe
 *   node tools/verify-server-exe.js --exe dist-server\xxx.exe
 *   node tools/verify-server-exe.js --keep             # 留着进程看（调试用）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist-server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const KEEP = process.argv.includes('--keep');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function findExe() {
  const explicit = arg('exe', null);
  if (explicit) return path.resolve(explicit);
  if (!fs.existsSync(OUT_DIR)) return null;
  const list = fs.readdirSync(OUT_DIR).filter((f) => f.toLowerCase().endsWith('.exe')).map((f) => path.join(OUT_DIR, f));
  if (!list.length) return null;
  return list.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 3000, headers: { connection: 'close' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function waitOnline(client, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (client.snapshot().status === 'online') return true;
    await sleep(100);
  }
  return false;
}

async function waitFor(fn, ms = 6000, step = 120) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    last = fn();
    if (last) return last;
    await sleep(step);
  }
  return last;
}

(async () => {
  const exePath = findExe();
  check('找到服务端 exe（先跑 npm run dist:server）', !!exePath && fs.existsSync(exePath),
    exePath ? `${path.relative(ROOT, exePath)}（${(fs.statSync(exePath).size / 1048576).toFixed(1)}MB）` : 'dist-server 里没有 .exe');
  if (!exePath || !fs.existsSync(exePath)) process.exit(1);

  // 1) 一次性开关
  const v = spawnSync(exePath, ['--version'], { encoding: 'utf-8', timeout: 20000, env: { ...process.env, TARKOV_NO_PAUSE: '1' } });
  check('exe --version 能跑（真的是个能自启动的单文件）', v.status === 0 && /v\d+\.\d+\.\d+/.test(v.stdout || ''),
    `${(v.stdout || '').trim()}${v.status !== 0 ? ` exit=${v.status}` : ''}`);
  const h = spawnSync(exePath, ['--help'], { encoding: 'utf-8', timeout: 20000, env: { ...process.env, TARKOV_NO_PAUSE: '1' } });
  check('exe --help 能列出命令行开关', h.status === 0 && /--port/.test(h.stdout || '') && /--persist/.test(h.stdout || ''),
    (h.stdout || '').split('\n').find((l) => l.includes('--port')) || '（没有 --port）');

  // 2) 真起一个实例（端口 0 = 让系统挑一个空闲端口，避免和用户自己的服务端撞）
  const logFile = path.join(os.tmpdir(), `takov-server-exe-${Date.now()}.log`);
  fs.writeFileSync(logFile, '');
  const fd = fs.openSync(logFile, 'a');
  const proc = spawn(exePath, ['--port', '0', '--log-level', 'info'], {
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: { ...process.env, TARKOV_NO_PAUSE: '1', PERSIST: '0', HOST: '127.0.0.1' },
  });
  const readLog = () => { try { return fs.readFileSync(logFile, 'utf-8'); } catch { return ''; } };

  let port = null;
  try {
    for (let i = 0; i < 40 && !port; i++) {
      await sleep(250);
      const m = readLog().match(/正在监听：[^:\n]*:(\d+)/);
      if (m) port = Number(m[1]);
      else if (/启动失败/.test(readLog())) break;
    }
    check('exe 起得来并从横幅里报出监听端口', !!port, port ? `端口 ${port}` : readLog().trim().slice(-200));
    check('启动横幅里列了内网地址（照着填客户端就行）', /服务器地址 = \d+\.\d+\.\d+\.\d+/.test(readLog()),
      (readLog().split('\n').find((l) => l.includes('服务器地址')) || '').trim());

    const hp = port ? await health(port) : null;
    check('GET /healthz 返回 ok（协议版本对得上）', !!hp && hp.ok === true, JSON.stringify(hp && { ver: hp.ver, proto: hp.proto }));

    // 3) 真客户端走一遍联机
    const { RoomClient } = require('../src/room-client');
    const roomId = `exe验收-${Date.now().toString(36)}`;
    const a = new RoomClient({ onLog: () => {} });
    const b = new RoomClient({ onLog: () => {} });
    a.applyConfig({ enabled: true, url: '127.0.0.1', port, roomId, nick: '甲号' });
    b.applyConfig({ enabled: true, url: '127.0.0.1', port, roomId, nick: '乙号' });
    check('两个真客户端都进房了（走的是 exe 里的 WebSocket 服务）', (await waitOnline(a)) && (await waitOnline(b)),
      `${a.snapshot().status} / ${b.snapshot().status}`);

    const bSeesA = await waitFor(() => b.snapshot().peers.find((p) => p.nick === '甲号') || null);
    check('乙看得到甲进房', !!bSeesA, bSeesA ? bSeesA.id : '-');

    a.setMap('customs');
    a.setPosition({ map: 'customs', x: 100, y: 1, z: 200, hdg: 90, ts: Date.now(), trail: [{ x: 95, z: 198 }, { x: 100, z: 200 }] });
    const posSeen = await waitFor(() => {
      const p = b.snapshot().peers.find((x) => x.nick === '甲号');
      return p && p.pos && Array.isArray(p.pos.trail) && p.pos.trail.length >= 2 ? p : null;
    });
    check('位置 + 轨迹同步过来（定位链路）', !!posSeen, posSeen ? `x=${posSeen.pos.x} z=${posSeen.pos.z} trail=${posSeen.pos.trail.length}` : '没收到');

    // 椭圆标注（新 kind）：顺便验服务端认识它
    a.sendAnnoAdd({
      map: 'customs', id: 'exe1', kind: 'ellipse', color: '#f87171', width: 4,
      pts: [{ x: 10, z: 10 }, { x: 30, z: 24 }],
    });
    const annoSeen = await waitFor(() => (b.snapshot().annos.customs || []).find((x) => x.id === 'exe1') || null);
    check('椭圆标注同步过来（kind=ellipse，服务端认识新类型）', !!annoSeen && annoSeen.kind === 'ellipse',
      annoSeen ? `${annoSeen.kind} owner=${annoSeen.owner}` : '没收到');

    // 开新局：对方旧点要被抹掉（newraid -> peer-reset）
    const dropped = a.newRaid();
    const wiped = await waitFor(() => {
      const p = b.snapshot().peers.find((x) => x.nick === '甲号');
      return p && !p.pos ? p : null;
    });
    check('newraid -> peer-reset：乙这边甲的旧点被抹掉（新局清残留）', !!wiped, `本机清了 ${dropped} 个；乙看到 pos=${wiped ? '已清' : '还在'}`);

    a.destroy();
    const left = await waitFor(() => (b.snapshot().peers.some((p) => p.nick === '甲号') ? null : true));
    check('客户端断开后房间成员消失（peer-left）', left === true);
    b.destroy();
  } finally {
    if (!KEEP) {
      try { proc.kill(); } catch {}
      // 等它真的退（Windows 上是 TerminateProcess，通常几十毫秒；给足 6 秒再看）
      let exited = proc.exitCode !== null || proc.signalCode !== null;
      for (let i = 0; i < 30 && !exited; i++) {
        await sleep(200);
        exited = proc.exitCode !== null || proc.signalCode !== null;
      }
      check('关掉 exe 后进程真的退了（没有残留）', exited, `exitCode=${proc.exitCode} signal=${proc.signalCode}`);
    }
    try { fs.closeSync(fd); } catch {}
    if (!KEEP) {
      try { fs.unlinkSync(logFile); } catch {}
    } else {
      console.log(`      （--keep：实例还在跑，端口 ${port}，日志 ${logFile}）`);
    }
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    console.log('失败项: ' + bad.map((x) => x.name).join(' / '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('验收脚本出错:', e.stack || e.message);
  process.exit(2);
});
