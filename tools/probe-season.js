#!/usr/bin/env node
// 探测赛季文件(season document)相关 REST 接口
const BASE = 'https://member.kaedeori.com';

async function get(p) {
  const r = await fetch(BASE + p, { headers: { accept: 'application/json', 'user-agent': 'tarkov-offline-map-dev' } });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
  return { status: r.status, j };
}

(async () => {
  const cfg = await get('/api/tarkov/season-document/config');
  console.log('--- /api/tarkov/season-document/config', cfg.status);
  console.log(JSON.stringify(cfg.j).slice(0, 1500));
  if (cfg.j && cfg.j.data) {
    const d = cfg.j.data;
    console.log('currentSeason=', d.currentSeason, 'maps=', (d.maps || []).length, 'documents=', (d.documents || []).length);
    console.log('maps:', JSON.stringify(d.maps).slice(0, 400));
    console.log('documents[0..3]:', JSON.stringify((d.documents || []).slice(0, 4)));
  }
  const maps = cfg.j?.data?.maps || [];
  const targets = maps.slice(0, 3);
  for (const m of targets) {
    const id = m.id || m.mapId || m.tarkovMapId;
    const l = await get(`/api/tarkov/season-document/location/list?mapId=${encodeURIComponent(id)}`);
    console.log(`\n--- location/list mapId=${id} (${m.name || m.mapName || '?'})`, l.status);
    const locs = l.j?.data ?? l.j;
    const arr = Array.isArray(locs) ? locs : locs?.list || locs?.locations || [];
    console.log('count=', Array.isArray(arr) ? arr.length : '(not array)', JSON.stringify(arr).slice(0, 1200));
  }
})().catch((e) => console.error('[fatal]', e));
