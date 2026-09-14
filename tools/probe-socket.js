#!/usr/bin/env node
/**
 * 用 socket 接口探测不同 gameMode 下的地图数据（含是否有赛季文件刷点字段）
 * 用法: node tools/probe-socket.js [--version=4.10.7] [--gameModes=pvp,pve,season]
 */
const { io } = require('socket.io-client');
const crypto = require('crypto');

const BASE = 'https://member.kaedeori.com';
const CHANNEL = 'tarkov';
const VER_ARG = process.argv.find((a) => a.startsWith('--version'));
const VERSION = VER_ARG ? VER_ARG.split('=')[1] : '4.10.7';
const GM_ARG = process.argv.find((a) => a.startsWith('--gameModes'));
const MODES = (GM_ARG ? GM_ARG.split('=')[1] : 'pvp,pve,season').split(',');

(async () => {
  const hash = crypto.createHash('md5').update(`${CHANNEL}${VERSION}`).digest('hex');
  const s = io(BASE, { reconnection: false, timeout: 25000, transports: ['websocket'], query: { channel: CHANNEL, version: VERSION, token: '', hash } });
  await new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej); });
  console.log('[socket] connected, version =', VERSION);

  for (const gm of MODES) {
    try {
      const r = await s.timeout(60000).emitWithAck('/v2/tarkov/iMGetMapList', { lang: 'zh', gameMode: gm });
      const list = r.data || [];
      console.log(`\n[list] gameMode=${gm} 共 ${list.length} 张`);
      for (const m of list) console.log(`   ${m.name} | id=${m.id} | key=${m.normalizedName || m.key || '?'}`);
    } catch (e) {
      console.log(`\n[list] gameMode=${gm} 失败: ${String(e.message || e).slice(0, 120)}`);
    }
  }

  // 详情字段对比（灯塔）
  const LIGHTHOUSE = '5704e4dad2720bb55b8b4567';
  for (const gm of MODES) {
    try {
      const r = await s.timeout(60000).emitWithAck('/v2/tarkov/iMGetMapDetail', { id: LIGHTHOUSE, lang: 'zh', gameMode: gm });
      const d = r.data;
      console.log(`\n[detail] 灯塔 gameMode=${gm}:`, Object.keys(d).join(','));
      for (const k of Object.keys(d)) {
        if (/season|document|event|marker/i.test(k)) console.log(`   ★ ${k} =`, JSON.stringify(d[k]).slice(0, 600));
      }
      console.log('   counts:', JSON.stringify({ extracts: d.extracts?.length, lootLoose: d.lootLoose?.length, transitions: d.transits?.length }));
    } catch (e) {
      console.log(`\n[detail] 灯塔 gameMode=${gm} 失败: ${String(e.message || e).slice(0, 120)}`);
    }
  }
  s.close();
  process.exit(0);
})().catch((e) => { console.error('[fatal]', e); process.exit(1); });
