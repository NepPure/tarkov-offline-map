'use strict';

/**
 * 房间成员在地图上的显示规则（纯函数，便于单测）。
 *
 * 显示约定：
 *   - 每个人的颜色由 peerId 哈希决定 —— 同一个 id 在任何人的客户端上都是同一个颜色，
 *     不需要服务端下发颜色（服务端也就少一份状态）；
 *   - 图标用**昵称第一个字** + 朝向箭头（用户定的：昵称第一个字作为地图上的图例带箭头）；
 *   - 位置是"他最后一次按截图键"的位置，所以要能看出新旧：超过 2 分钟算旧、超过 10 分钟算很旧。
 */

/** 队友配色（刻意避开玩家自己的青色 #22d3ee，免得"哪个是我"看不清） */
export const PEER_PALETTE = [
  '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#fb7185',
  '#4ade80', '#f97316', '#e879f9', '#facc15', '#86efac',
];

/** FNV-1a：小、快、稳定，不需要密码学强度 */
export function hashId(id) {
  const s = String(id == null ? '' : id);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 同一个人在任何客户端上颜色一致 */
export function peerColor(id) {
  return PEER_PALETTE[hashId(id) % PEER_PALETTE.length];
}

/** 地图上/图例里显示的"图标"：昵称第一个字（英文转大写，emoji 不会被劈成半个） */
export function peerInitial(nick) {
  const cps = Array.from(String(nick == null ? '' : nick).trim());
  if (!cps.length) return '?';
  const ch = cps[0];
  return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
}

/**
 * 显示用昵称：重名时补一个短 id（`小明#3f2`），不然地图上两个"小明"没法区分。
 * all 里同一个昵称出现多次才补。
 */
export function peerLabel(peer, all = []) {
  const nick = String((peer && peer.nick) || '队友');
  const dup = all.filter((p) => p && p.nick === nick).length > 1;
  return dup && peer && peer.id ? `${nick}#${String(peer.id).slice(-3)}` : nick;
}

/** 相对时间：位置是事件式的（按截图键才有），所以"多久以前"必须能看出来 */
export function relTime(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = Math.max(0, Math.round((now - t) / 1000));
  if (d < 5) return '刚刚';
  if (d < 60) return `${d} 秒前`;
  if (d < 3600) return `${Math.round(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.round(d / 3600)} 小时前`;
  return `${Math.round(d / 86400)} 天前`;
}

/** 位置有多旧：'fresh' | 'stale'（>2 分钟）| 'old'（>10 分钟） */
export function staleLevel(at, now = Date.now(), freshMs = 120000, oldMs = 600000) {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return 'fresh';
  const age = now - t;
  if (age > oldMs) return 'old';
  if (age > freshMs) return 'stale';
  return 'fresh';
}

/** 这个人在当前这张图上吗（有定位，且定位就是这张图） */
export function peerOnMap(peer, mapId) {
  if (!peer) return false;
  const m = (peer.pos && peer.pos.map) || peer.map;
  return !!mapId && m === mapId && !!peer.pos;
}

/** 地图上要画的队友：只画"在同一张图且有定位"的人 */
export function peersOnMap(peers, mapId) {
  return (Array.isArray(peers) ? peers : []).filter((p) => peerOnMap(p, mapId));
}

/** 成员顺序：按昵称排，昵称相同按 id（每次广播顺序稳定，图例不会跳来跳去） */
export function sortPeers(peers) {
  return [...(Array.isArray(peers) ? peers : [])].sort((a, b) => {
    const an = String((a && a.nick) || '');
    const bn = String((b && b.nick) || '');
    if (an !== bn) return an.localeCompare(bn, 'zh-Hans-CN');
    return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
  });
}

/**
 * 图例里那一行的说明文字：
 *   - 在同图：昵称
 *   - 在别的图：昵称（在 立交桥）
 *   - 还没定位：昵称（还没定位）
 */
export function peerLegendLabel(peer, all = []) {
  const base = peerLabel(peer, all);
  if (peer && peer.pos) return base;
  if (peer && peer.map) return `${base}（在${peer.mapName || '别的图'}）`;
  return `${base}（还没定位）`;
}

/**
 * 这个人当前在本图有几样东西要画（位置 + 标注）。
 * 图例右侧的数字就取它 —— 0 表示他现在不在这张图上。
 */
export function peerItemCount(peer, peerAnnosForMap = 0) {
  if (!peer || !peer.pos) return 0;
  return 1 + (Array.isArray(peerAnnosForMap) ? peerAnnosForMap.length : peerAnnosForMap || 0);
}

/**
 * 图例是否需要重建的指纹：成员、昵称、是否在当前图、他在本图有几笔标注。
 * 位置每秒都在更新，不需要跟着重排图例（否则用户展开的分组会一直被打断）。
 */
export function peersSignature(peers, mapId, annosByMap = {}) {
  return sortPeers(peers)
    .map((p) => {
      const annos = (annosByMap && annosByMap[mapId]) || [];
      const mine = annos.filter((a) => a && a.owner === p.id).length;
      return `${p.id}:${p.nick}:${peerOnMap(p, mapId) ? 1 : 0}:${mine}:${p.pos ? 1 : 0}`;
    })
    .join('|');
}
