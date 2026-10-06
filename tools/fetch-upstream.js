#!/usr/bin/env node
/**
 * 上游数据缓存下载器（开发/构建期用，不进应用）
 *
 * 把 json.tarkov.dev 的快照下到 build/upstream/<mode>-<name>.json，
 * 供 fetch-economy.js / fetch-market.js 等构建脚本离线读取（--from-cache）。
 *
 * 已有且能 JSON.parse 出 .data 的文件默认跳过（可断点续跑）；--force 全部重下。
 * 下载先写 .part 再改名，避免半截文件被当成好缓存。
 *
 * 用法:
 *   node tools/fetch-upstream.js [--only=items,barters] [--mode=regular,pve] [--force] [--jobs=4]
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const DIR = path.join(REPO, 'build', 'upstream');
const BASE = 'https://json.tarkov.dev';

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}`));
  return a && a.includes('=') ? a.split('=')[1] : dflt;
};
const ONLY = arg('only', null);
const MODES = arg('mode', 'regular,pve').split(',');
const NAMES = (ONLY ? ONLY.split(',') : ['items', 'items_zh', 'barters', 'crafts', 'hideout', 'tasks', 'tasks_zh', 'traders', 'traders_zh', 'maps']);
const FORCE = process.argv.includes('--force');
const JOBS = Number(arg('jobs', 3));

const UA = 'tarkov-offline-map/2.5 (+https://github.com/neppure/tarkov-offline-map)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function good(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && 'data' in j;
  } catch { return false; }
}

async function one(mode, name) {
  const file = path.join(DIR, `${mode}-${name}.json`);
  if (!FORCE && fs.existsSync(file) && good(file)) return { mode, name, status: 'skip', bytes: fs.statSync(file).size };
  const url = `${BASE}/${mode}/${name}`;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      const tmp = file + '.part';
      fs.writeFileSync(tmp, text);
      JSON.parse(text);
      fs.renameSync(tmp, file);
      return { mode, name, status: 'ok', bytes: text.length };
    } catch (e) {
      lastErr = e;
      await sleep(800 * (i + 1));
    }
  }
  return { mode, name, status: 'fail', error: String(lastErr && lastErr.message).slice(0, 120) };
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const jobs = [];
  for (const mode of MODES) for (const name of NAMES) jobs.push([mode, name]);
  console.log(`[up] ${jobs.length} 个文件，并发 ${JOBS}`);
  let cursor = 0, ok = 0, skip = 0, fail = 0;
  const fails = [];
  async function worker() {
    while (cursor < jobs.length) {
      const [mode, name] = jobs[cursor++];
      const r = await one(mode, name);
      if (r.status === 'ok') { ok++; console.log(`  ok   ${mode}/${name} ${(r.bytes / 1048576).toFixed(2)} MB`); }
      else if (r.status === 'skip') { skip++; console.log(`  skip ${mode}/${name} ${(r.bytes / 1048576).toFixed(2)} MB`); }
      else { fail++; fails.push(`${mode}/${name}: ${r.error}`); console.log(`  FAIL ${mode}/${name} ${r.error}`); }
    }
  }
  await Promise.all(Array.from({ length: JOBS }, worker));
  console.log(`[up] 完成：新下 ${ok} 跳过 ${skip} 失败 ${fail}`);
  if (fails.length) { console.log(fails.join('\n')); process.exitCode = 1; }
})();
