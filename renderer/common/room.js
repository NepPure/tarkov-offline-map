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
 * 设置页里那一行提示文字 —— 由**真实状态**推出来，不是一个"点按钮时写一次就没人管"的字符串。
 *
 * 这里踩过一个真坑：点「加入房间」时先在提示行写"正在加入…"，之后没有任何地方更新它。
 * 如果房间配置一个字段都没改，主进程的 room:reconnect 会直接 no-op（已经在线/正在连，
 * 不想白折腾一条连接），于是那句"正在加入…"就永远留在那儿 —— 旁边却已经写着"房间 2 人"，
 * 自己跟自己打架。现在提示行每次刷新都由状态重算，谁也没法把它写死。
 *
 * @returns {{text: string, cls: string}|null} null = 不写提示（未联机时留空）
 */
export function roomHint(room) {
  const st = (room && room.status) || 'off';
  const peers = room && Array.isArray(room.peers) ? room.peers.length : 0;
  if (st === 'connecting') return { text: '正在加入…', cls: 'room-hint' };
  if (st === 'reconnecting') {
    const n = Number(room && room.attempts) || 1;
    // 从没在线过 -> 是"连不上"；在线过再断 -> 是"断了重连"（两种情况用户要做的事不一样）
    const ever = !!(room && room.onlineSince);
    return { text: `${ever ? '连接断了' : '连不上服务端'}，正在自动重试…（第 ${n} 次）`, cls: 'room-hint' };
  }
  if (st === 'online') {
    return peers
      ? { text: `已加入房间：当前 ${peers + 1} 人（含你，另有 ${peers} 位队友）`, cls: 'room-hint ok' }
      : { text: '已加入房间：当前就你 1 个人（队友进来会自己出现）', cls: 'room-hint ok' };
  }
  if (st === 'error') return { text: `加入失败：${(room && room.error) || '未知错误'}`, cls: 'room-hint bad' };
  return null;
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
      // 带上 p.map / mapName：还没定位的人换了图，图例那行会从"（在森林）"变成"（在海关）"，
      // 指纹不带上就会一直显示他在旧图。
      return `${p.id}:${p.nick}:${p.map || ''}:${p.mapName || ''}:${peerOnMap(p, mapId) ? 1 : 0}:${mine}:${p.pos ? 1 : 0}`;
    })
    .join('|');
}

// ---------------------------------------------------------------------------
// 共享内容跟着"谁在线"走
//
// 踩过的坑（用户报的）：队友画了一堆标注并共享，他退出房间后**标注还挂在图上** ——
// 右边他的图例行已经没了（图例是按 peers 生成的），可笔画还画着，两边对不上。
//
// 根因：服务端**会保留**离场者的标注（这是有意的：他回来时大家还能看到，不用重画），
// 而且 welcome 会把房间里所有标注一次性发给新加入/重连的人 —— 那些标注的 owner 可能
// 早就不在房间里了。所以"画不画"不能只看有没有这笔标注，必须再看**owner 此刻在不在**。
//
// 过滤放在渲染层（不改客户端那份原始数据）：他人一回来，同一份数据立刻又能画出来。
// ---------------------------------------------------------------------------

/** 此刻**真的在房间里**的队友 id 集合（不含自己：我自己的标注走本地文件） */
export function onlinePeerIds(room) {
  const selfId = room && room.self ? room.self.id : null;
  const out = new Set();
  for (const p of (room && Array.isArray(room.peers) ? room.peers : [])) {
    if (p && p.id && p.id !== selfId) out.add(p.id);
  }
  return out;
}

const asOwnerSet = (online) => (online instanceof Set ? online : new Set(Array.isArray(online) ? online : []));

/**
 * 只保留"在场队友"画的共享标注（按 owner 过滤，返回**新**映射，不改原数据）。
 * @param {object} annosByMap mapId -> [笔画]
 * @param {Set|string[]} online 在场队友 id（见 onlinePeerIds）
 */
export function annosOfOnlinePeers(annosByMap, online) {
  const alive = asOwnerSet(online);
  const out = {};
  for (const [mapId, list] of Object.entries(annosByMap || {})) {
    const keep = (Array.isArray(list) ? list : []).filter((a) => a && a.owner && alive.has(a.owner));
    if (keep.length) out[mapId] = keep;
  }
  return out;
}

/** 只保留"在场队友"共享的勾选任务（peerId -> [任务 id]） */
export function questsOfOnlinePeers(quests, online) {
  const alive = asOwnerSet(online);
  const out = {};
  for (const [pid, ids] of Object.entries(quests || {})) {
    if (alive.has(pid)) out[pid] = Array.isArray(ids) ? ids : [];
  }
  return out;
}

/**
 * 房间快照 -> "只含此刻在场的人"的视图：peers / status / self 原样，
 * annos 与 quests 按在场者过滤。
 *
 * 渲染层每次收到状态推送都过一遍它，于是"共享标注 / 共享勾选"天然跟着上下线走：
 * 人走了立刻从图上消失（图例本来就已经没他了），人回来立刻又能看到，不用重发。
 */
export function pruneRoomToOnline(room) {
  if (!room) return null;
  const online = onlinePeerIds(room);
  return {
    ...room,
    annos: annosOfOnlinePeers(room.annos, online),
    quests: questsOfOnlinePeers(room.quests, online),
  };
}
