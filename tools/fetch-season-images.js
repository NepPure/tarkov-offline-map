#!/usr/bin/env node
/**
 * 下载赛季文件"位置参考截图"原图（离线可看）
 *
 * 来源: data/season-documents.json 里每个刷点的 image URL（站台公开 CDN，webp 原图）
 * 输出: data/season-images/<uuid>.webp  + 回写 imageLocal 字段
 *
 * 用法: node tools/fetch-season-images.js [--concurrency=4] [--force]
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const DOCS = path.join(REPO, 'data', 'season-documents.json');
const OUT_DIR = path.join(REPO, 'data', 'season-images');
const CACHE = path.join(REPO, 'build', 'season-image-cache');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}`));
  return a && a.includes('=') ? a.split('=')[1] : d;
};
const CONC = Math.max(1, Number(arg('concurrency', 4)));
const FORCE = process.argv.includes('--force');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOne(point) {
  const name = `${point.uuid}.webp`;
  const out = path.join(OUT_DIR, name);
  if (!FORCE && fs.existsSync(out) && fs.statSync(out).size > 1024) {
    point.imageLocal = `season-images/${name}`;
    return { cached: true, bytes: fs.statSync(out).size };
  }
  const cacheFile = path.join(CACHE, name);
  if (!FORCE && fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 1024) {
    fs.copyFileSync(cacheFile, out);
    point.imageLocal = `season-images/${name}`;
    return { cached: true, bytes: fs.statSync(out).size };
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(point.image, { headers: { accept: 'image/webp,image/*' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(out, buf);
      point.imageLocal = `season-images/${name}`;
      return { bytes: buf.length };
    } catch (e) {
      if (attempt === 3) return { error: e.message };
      await sleep(400 * attempt);
    }
  }
}

(async () => {
  const doc = JSON.parse(fs.readFileSync(DOCS, 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const points = [];
  for (const entry of Object.values(doc.maps)) for (const p of entry.points) points.push(p);
  console.log(`[images] 共 ${points.length} 张参考截图，并发 ${CONC}`);

  let done = 0, bytes = 0, failed = 0, cached = 0;
  const queue = [...points];
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const p = queue.shift();
      const r = await fetchOne(p);
      done++;
      if (r.error) { failed++; if (failed <= 5) console.warn('[images] 失败', p.uuid, r.error); }
      else { bytes += r.bytes; if (r.cached) cached++; }
      if (done % 50 === 0) console.log(`[images] ${done}/${points.length} ... ${(bytes / 1048576).toFixed(1)}MB`);
    }
  }));

  doc.images = {
    fetchedAt: new Date().toISOString(),
    count: points.length - failed,
    bytes,
    note: '位置参考截图原图（站台公开 CDN，webp）。点击地图上的赛季文件标记即可在弹窗查看该刷新点实景。',
  };
  fs.writeFileSync(DOCS, JSON.stringify(doc, null, 2));
  const total = fs.readdirSync(OUT_DIR).reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0);
  console.log(`[images] 完成: 新增/命中 ${done - failed}（其中已存在 ${cached}）/ 失败 ${failed}`);
  console.log(`[images] data/season-images/ 目录合计 ${(total / 1048576).toFixed(1)}MB`);
})().catch((e) => { console.error('[fatal]', e); process.exit(1); });
