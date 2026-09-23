#!/usr/bin/env node
/**
 * 上游素材新鲜度检查：
 *  1. tarkov.dev GraphQL：maps 查询、GameMode 枚举、每张地图的 svgPath / 数据摘要
 *  2. 与本地 data/maps/*.svg 对比 sha256（判断底图是否更新）
 *  3. 与本地 data/maps-dump.json 对比（判断点位/撤离点/图例是否更新）
 *     —— 人工补录（data/manual-extracts.json）单独列出来，不计入"差异"
 * 用法: node tools/check-upstream.js [--gameMode regular|pve|season] [--json]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const API = 'https://api.tarkov.dev/graphql';

async function gql(query, variables) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 500));
  return j.data;
}

const MAP_FIELDS = `
  id name normalizedName tarkovDataId
  svgPath tilePath minZoom maxZoom
  projection
  extracts { id name }
  transits { id description }
  bosses { boss { name } }
  locks { id }
  switches { id }
  hazards { hazardType }
  lootContainers { lootContainer { name } }
  lootLoose { items { id } }
  spawns { zoneName }
  stationaryWeapons { stationaryWeapon { name } }
`;

(async () => {
  const modeArg = process.argv.find((a) => a.startsWith('--gameMode'));
  const gameMode = modeArg ? modeArg.split('=')[1] : 'regular';

  // 1) 枚举所有 gameMode
  const enumData = await gql('{ __type(name: "GameMode") { enumValues { name } } }');
  const modes = (enumData.__type?.enumValues || []).map((v) => v.name);
  console.log('[upstream] GameMode 枚举:', modes.join(', ') || '(无)');

  // 2) 逐个 gameMode 拉地图列表，比较数量
  for (const gm of modes.length ? modes : [gameMode]) {
    try {
      const d = await gql(`query($gm: GameMode){ maps(lang: zh, gameMode: $gm) { id name normalizedName } }`, { gm });
      console.log(`[upstream] gameMode=${gm} 地图 ${d.maps.length} 张:`, d.maps.map((m) => `${m.name}(${m.normalizedName})`).join(', '));
    } catch (e) {
      console.log(`[upstream] gameMode=${gm} 查询失败: ${String(e.message).slice(0, 200)}`);
    }
  }

  // 3) 拉当前模式完整地图数据，对比本地 dump
  const data = await gql(`query($gm: GameMode){ maps(lang: zh, gameMode: $gm) { ${MAP_FIELDS} } }`, { gm: gameMode });
  const local = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'maps-dump.json'), 'utf8'));
  const localByKey = new Map(local.maps.map((m) => [m.detail.key, m]));

  // 人工补录点位（data/manual-extracts.json）要算进"本地"，否则永远报假差异。
  // 上游将来自己补齐同 id 后，加载时会被跳过，这里的计数也就自然回落。
  let overlay = { maps: {} };
  const overlayPath = path.join(REPO, 'data', 'manual-extracts.json');
  if (fs.existsSync(overlayPath)) {
    try { overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8')); } catch (e) { console.warn('[warn] manual-extracts.json 解析失败:', e.message); }
  }
  const overlayCount = (detailId, field) => {
    const perMap = (overlay.maps || {})[detailId];
    const list = perMap && perMap[field];
    return Array.isArray(list) ? list.length : 0;
  };

  const report = [];
  for (const m of data.maps) {
    const key = m.normalizedName;
    const svgFile = m.svgPath ? m.svgPath.split('/').pop() : null;
    const localM = localByKey.get(key);
    const row = {
      key,
      name: m.name,
      upstream: {
        svg: svgFile,
        svgUrl: m.svgPath,
        tile: m.tilePath || null,
        counts: {
          extracts: m.extracts.length,
          transits: m.transits.length,
          bosses: m.bosses.length,
          locks: m.locks.length,
          switches: m.switches.length,
          hazards: m.hazards.length,
          lootContainers: m.lootContainers.length,
          lootLoose: m.lootLoose.length,
          spawns: m.spawns.length,
          stationaryWeapons: m.stationaryWeapons.length,
        },
      },
      local: localM
        ? {
            svg: localM.detail.svgPath ? localM.detail.svgPath.split('/').pop() : null,
            // counts 只算快照本身（与上游逐项可比）；人工补录单独列在 manual 里
            counts: {
              extracts: (localM.detail.extracts || []).length,
              transits: (localM.detail.transits || []).length,
              bosses: (localM.detail.bosses || []).length,
              locks: (localM.detail.locks || []).length,
              switches: (localM.detail.switches || []).length,
              hazards: (localM.detail.hazards || []).length,
              lootContainers: (localM.detail.lootContainers || []).length,
              lootLoose: (localM.detail.lootLoose || []).length,
              spawns: (localM.detail.spawns || []).length,
              stationaryWeapons: (localM.detail.stationaryWeapons || []).length,
            },
            manual: Object.fromEntries(
              ['extracts', 'transits', 'locks', 'switches'].map((k) => [k, overlayCount(localM.detail.id, k)]).filter(([, v]) => v > 0),
            ),
          }
        : null,
      svgChanged: null,
    };
    report.push(row);
    const c = row.upstream.counts;
    const l = row.local?.counts;
    const man = row.local?.manual || {};
    const manKeys = Object.keys(man);
    const diffKeys = l ? Object.keys(c).filter((k) => c[k] !== l[k]) : [];
    console.log(
      `\n[map] ${m.name} (${key})`,
      `\n  上游: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ')}`,
      l ? `\n  本地: ${Object.entries(l).map(([k, v]) => `${k}=${v}`).join(' ')}` : '\n  本地: 缺失',
      diffKeys.length ? `\n  ⚠ 差异: ${diffKeys.map((k) => `${k} ${l[k]}→${c[k]}`).join(', ')}` : l ? '\n  ✓ 计数一致' : '',
      manKeys.length ? `\n  ＋人工补录(manual-extracts.json): ${manKeys.map((k) => `${k}=${man[k]}`).join(' ')}（上游缺这些点位，不是本地多出来的错）` : ''
    );
  }

  // 4) SVG 哈希对比
  console.log('\n[svg] 底图对比：');
  const svgDir = path.join(REPO, 'data', 'maps');
  const seen = new Map();
  for (const m of data.maps) {
    if (!m.svgPath) continue;
    const file = m.svgPath.split('/').pop();
    if (seen.has(file)) { console.log(`  ${file}: (重复引用，已比对)`); continue; }
    const localPath = path.join(svgDir, file);
    if (!fs.existsSync(localPath)) { seen.set(file, 'missing'); console.log(`  ${file}: ⚠ 本地缺失`); continue; }
    const localBuf = fs.readFileSync(localPath);
    const localHash = crypto.createHash('sha256').update(localBuf).digest('hex');
    let rsp;
    try { rsp = await fetch(m.svgPath); } catch (e) { console.log(`  ${file}: 下载失败 ${e.message}`); continue; }
    if (!rsp.ok) { console.log(`  ${file}: ⚠ 上游 ${rsp.status}`); continue; }
    const upBuf = Buffer.from(await rsp.arrayBuffer());
    const upHash = crypto.createHash('sha256').update(upBuf).digest('hex');
    const same = localHash === upHash;
    seen.set(file, same ? 'same' : 'changed');
    console.log(`  ${file}: ${same ? '✓ 一致' : `⚠ 已更新 本地 ${localBuf.length}B → 上游 ${upBuf.length}B`} (${localHash.slice(0, 12)} vs ${upHash.slice(0, 12)})`);
    if (!same) {
      const outDir = path.join(REPO, 'build', 'upstream-svg');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, file), upBuf);
      console.log(`     ↳ 已保存到 build/upstream-svg/${file}`);
    }
  }

  fs.writeFileSync(path.join(REPO, 'build', 'upstream-report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), gameMode, modes, report }, null, 2));
  console.log('\n[report] build/upstream-report.json 已保存');
})().catch((e) => { console.error('[fatal]', e); process.exit(1); });
