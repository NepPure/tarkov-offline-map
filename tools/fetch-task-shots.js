#!/usr/bin/env node
/**
 * 任务攻略截图内置脚本（构建期跑一次）
 *
 * 输入: data/task-guides.json（fetch-task-guides.js 产出，里面的 shots/illustration 是文件名）
 *      build/guide-assets.json（URL -> 本地文件名）
 * 处理:
 *   1) 并发下载原图到 build/shot-raw/（已存在则跳过，可断点续跑）
 *   2) 调 Python(Pillow) 重编码到目标宽度/质量 -> data/task-shots/<name>.webp
 *      - 攻略截图（/uploads/infoImg/*）体积大，必须重编码（原图 2560x1440 约 600KB）
 *      - 任务配图（/uploads/task/*.webp，4~25KB）直接复制，不重编码
 *   3) 写 data/task-shots/manifest.json（给渲染层查真实文件尺寸）
 *
 * 本软件是"全量内置"的离线版：这些图片进仓库/进 exe，不做运行时下载。
 *
 * 用法:
 *   node tools/fetch-task-shots.js --python=<python.exe> [--width=1600] [--quality=82] [--jobs=8]
 *   node tools/fetch-task-shots.js --manifest-only         # 只重扫已有文件写 manifest
 *   node tools/fetch-task-shots.js --limit=20              # 冒烟
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const GUIDES = path.join(REPO, 'data', 'task-guides.json');
const ASSETS = path.join(REPO, 'build', 'guide-assets.json');
const RAW = path.join(REPO, 'build', 'shot-raw');
const OUTDIR = path.join(REPO, 'data', 'task-shots');
const MANIFEST = path.join(OUTDIR, 'manifest.json');
const ENC_JOBS = path.join(RAW, 'jobs.json');
const ENC_OUT = path.join(RAW, 'enc-out.json');

const UA = 'tarkov-offline-map/2.5 (+https://github.com/neppure/tarkov-offline-map; open-source offline companion)';

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}`));
  return a && a.includes('=') ? a.split('=')[1] : dflt;
};
const WIDTH = Number(arg('width', 1600));
const QUALITY = Number(arg('quality', 82));
const JOBS = Number(arg('jobs', 8));
const LIMIT = Number(arg('limit', 0)) || 0;
const PYTHON = arg('python', process.env.TARKOV_PYTHON || 'python');
const MANIFEST_ONLY = process.argv.includes('--manifest-only');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const extOf = (url) => (url.match(/\.([a-z0-9]+)(?:\?|$)/i) || [, 'webp'])[1].toLowerCase();

async function download(url, dst, tries = 4) {
  if (fs.existsSync(dst) && fs.statSync(dst).size > 0) return 'skip';
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('empty');
      fs.writeFileSync(dst, buf);
      return 'ok';
    } catch (e) {
      lastErr = e;
      await sleep(500 * (i + 1));
    }
  }
  throw new Error(`${url}: ${lastErr && lastErr.message}`);
}

function writeManifest(extra) {
  const files = fs.existsSync(OUTDIR) ? fs.readdirSync(OUTDIR).filter((f) => f.endsWith('.webp')) : [];
  const manifest = {};
  let bytes = 0;
  for (const f of files) {
    const s = fs.statSync(path.join(OUTDIR, f));
    bytes += s.size;
    manifest[f.replace(/\.webp$/, '')] = { file: f, bytes: s.size };
  }
  fs.writeFileSync(MANIFEST, JSON.stringify({ generatedAt: new Date().toISOString(), width: WIDTH, quality: QUALITY, count: files.length, bytes, ...extra, files: manifest }, null, 1));
  return { count: files.length, bytes };
}

(async () => {
  fs.mkdirSync(RAW, { recursive: true });
  fs.mkdirSync(OUTDIR, { recursive: true });

  if (MANIFEST_ONLY) {
    const m = writeManifest({});
    console.log(`[manifest] ${m.count} 张，${(m.bytes / 1024 / 1024).toFixed(1)} MB`);
    return;
  }

  const assets = JSON.parse(fs.readFileSync(ASSETS, 'utf8')).images;
  let list = assets;
  if (LIMIT) list = list.slice(0, LIMIT);
  console.log(`[shots] 待处理 ${list.length} 张（宽 ${WIDTH} q${QUALITY}）`);

  // ---- 1) 下载 ----
  let done = 0, ok = 0, skip = 0;
  const failures = [];
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const a = list[cursor++];
      const url = `https://www.eftarkov.com${a.url}`;
      const ext = extOf(a.url);
      const raw = path.join(RAW, `${a.name}.${ext}`);
      try {
        const r = await download(url, raw);
        if (r === 'ok') ok++; else skip++;
      } catch (e) {
        failures.push({ name: a.name, url, error: String(e.message).slice(0, 160) });
      }
      done++;
      if (done % 25 === 0) process.stdout.write(`\r[dl] ${done}/${list.length} 新下 ${ok} 跳过 ${skip} 失败 ${failures.length}   `);
      await sleep(20);
    }
  }
  await Promise.all(Array.from({ length: JOBS }, worker));
  process.stdout.write(`\r[dl] ${done}/${list.length} 新下 ${ok} 跳过 ${skip} 失败 ${failures.length}      \n`);

  // ---- 2) 重编码 ----
  const jobs = [];
  for (const a of list) {
    const ext = extOf(a.url);
    const raw = path.join(RAW, `${a.name}.${ext}`);
    if (!fs.existsSync(raw)) continue;
    const dst = path.join(OUTDIR, `${a.name}.webp`);
    if (a.kind === 'task') {
      // 任务配图很小，直接复制（保留可能的透明通道）
      fs.copyFileSync(raw, dst);
      continue;
    }
    jobs.push({ name: a.name, url: `https://www.eftarkov.com${a.url}`, src: raw, dst });
  }
  fs.writeFileSync(ENC_JOBS, JSON.stringify(jobs));
  console.log(`[enc] ${jobs.length} 张需要重编码 -> ${PYTHON}`);
  const r = spawnSync(PYTHON, [path.join('tools', 'lib', 'reencode.py'), path.relative(REPO, ENC_JOBS), String(WIDTH), String(QUALITY), path.relative(REPO, ENC_OUT)], { cwd: REPO, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0) {
    console.error('[enc] 失败 exit=' + r.status);
    console.error(String(r.stderr).slice(0, 2000));
    process.exitCode = 1;
  }
  const enc = fs.existsSync(ENC_OUT) ? JSON.parse(fs.readFileSync(ENC_OUT, 'utf8')) : [];
  const encErr = enc.filter((x) => x.error);

  // ---- 3) manifest ----
  const sizes = {};
  for (const x of enc) if (!x.error) sizes[x.name] = { w: x.w, h: x.h, bytes: x.bytes };
  const m = writeManifest({ sizes, failures });
  console.log(`[out] ${m.count} 张，${(m.bytes / 1024 / 1024).toFixed(1)} MB（重编码失败 ${encErr.length}，下载失败 ${failures.length}）`);
  if (failures.length) console.log('[fail] ' + failures.slice(0, 10).map((f) => f.name).join(', '));
})();
