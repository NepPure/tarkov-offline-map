#!/usr/bin/env node
/**
 * 下载标记图标素材（一次执行，之后离线可用）
 * 原站图标规则:  https://cdn.kaedeori.com/uploads/tarkov/map-icons/<name>.png
 *             https://cdn.kaedeori.com/assets/tarkov/images/<name>.png
 * 输出: data/icons/<name>.png  +  data/icons/manifest.json
 * 用法: node tools/fetch-icons.js
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'icons');
const MAP_ICONS = 'https://cdn.kaedeori.com/uploads/tarkov/map-icons/';
const ASSETS = 'https://cdn.kaedeori.com/assets/tarkov/images/';

// 图标文件名清单（qpe 映射后的最终文件名；:assets 表示来自 assets/tarkov/images/）
const ICON_KEYS = [
  // 容器
  'container_cash-register', 'container_safe', 'container_buried-barrel-cache', 'container_dead-scav',
  'container_drawer', 'container_duffle-bag', 'container_grenade-box', 'container_ground-cache',
  'container_jacket', 'container_medbag-smu06', 'container_medcase', 'container_crate',
  'container_pc-block', 'container_plastic-suitcase', 'container_toolbox', 'container_weapon-box',
  'container_wooden-ammo-box', 'container_wooden-crate',
  // 散落物资
  'loose_loot', 'loose_loot_high:assets', 'loose_loot_favorite:assets',
  // 撤离/转移
  'extract_pmc', 'extract_scav', 'extract_shared', 'extract_transit',
  // 杂项
  'hazard', 'key', 'lock', 'quest_item', 'quest_objective',
  'spawn_sniper_scav', 'spawn_boss', 'spawn_bloodhound', 'spawn_bot_pmc:assets',
  'spawn_cultist-priest', 'spawn_pmc', 'spawn_rogue', 'spawn_scav',
  'stationarygun', 'switch', 'btr_stop',
];

// Boss 独立图标（assets 目录）
const BOSS_EXTRA = ['boss_glukhar:assets', 'boss_kaban:assets', 'boss_killa:assets', 'boss_knight:assets',
  'boss_kollontay:assets', 'boss_reshala:assets', 'boss_sanitar:assets', 'boss_shadow_of_tagilla:assets',
  'boss_shturman:assets', 'boss_tagilla:assets', 'boss_zryachiy:assets'];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = { fetchedAt: new Date().toISOString(), files: {} };
  const seen = new Set();

  async function grab(key, fromAssets = false) {
    const base = fromAssets ? ASSETS : MAP_ICONS;
    const url = base + key + '.png';
    if (seen.has(key)) return;
    seen.add(key);
    try {
      const rsp = await fetch(url);
      if (!rsp.ok) { console.log('MISS', key, rsp.status); return; }
      fs.writeFileSync(path.join(OUT, key + '.png'), Buffer.from(await rsp.arrayBuffer()));
      manifest.files[key] = { from: fromAssets ? 'assets' : 'map-icons' };
      console.log('OK  ', key);
    } catch (e) { console.log('ERR ', key, e.message); }
  }

  for (const item of [...ICON_KEYS, ...BOSS_EXTRA]) {
    const [key, tag] = item.split(':');
    await grab(key, tag === 'assets');
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('DONE', Object.keys(manifest.files).length, 'icons ->', OUT);
})();
