'use strict';

/**
 * 房间服务端的协议层：纯函数，不碰网络、不碰磁盘 —— 只做"校验 + 归一化"，便于单测。
 *
 * 设计原则（服务端要"非常非常轻量"）：
 *   - 文本帧 JSON，字段名故意取短（x/z/hdg），位置消息带宽就是这么省下来的；
 *   - 服务端不认识"任务/赛季文件"这些客户端概念，只转发"位置"和"标注"两样；
 *   - 一切来自客户端的输入都当成不可信：数值必须 finite、字符串必须限长、笔数有点数上限。
 *
 * 客户端 → 服务端：hello / map / pos / anno / newraid / ping
 * 服务端 → 客户端：welcome / peer-join / peer-left / peer-map / peer-pos / peer-reset / anno / pong / err
 */
const crypto = require('crypto');

const PROTO = 2; // 协议大版本：不一致直接拒（客户端会提示"服务端版本不匹配"）

/**
 * 服务端能力清单（写在 welcome 里）。
 * 客户端只会用两端都声明过的能力，所以**加能力不用动 PROTO**：
 * 新客户端连老服务端 = 该功能静默关闭，老客户端连新服务端 = 忽略不认识的字段。
 * quests = 允许客户端共享"我勾选的任务"（整份任务 id 列表，服务端只做校验与转发）。
 */
const CAPS = ['quests'];

const LIMITS = {
  NICK_MAX: 16,
  MAP_ID_MAX: 64,
  ANNO_ID_MAX: 40,
  TRAIL_MAX: 200,        // 一次位置消息最多带多少个轨迹点（客户端本地留 200 个）
  PTS_MAX: 3000,         // 单笔标注最多多少个点（和客户端 src/annotations.js 保持一致）
  STROKES_PER_MAP: 400,  // 每张图最多多少笔（同上）
  ROOM_ANNOS_MAX: 2000,  // 单个房间所有图加起来最多多少笔
  QUESTS_MAX: 200,       // 一个人最多共享多少个勾选任务（和客户端 src/room-client.js 一致）
  FRAME_MAX: 64 * 1024,  // 单帧上限：超了直接断开（客户端正常一帧最多几 KB）
};

const KINDS = new Set(['pen', 'path', 'line', 'arrow', 'ellipse', 'rect']);
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ROOM_KEY_RE = /^[0-9a-f]{16,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAP_RE = /^[A-Za-z0-9_-]{1,64}$/;
// 任务 id：比通用 id 稍严（数据源是 hex，但允许 - 与 _ 便于以后换源）
const QUEST_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

// ---------------------------------------------------------------------------
// 房间号
// ---------------------------------------------------------------------------
/** 和 src/room-key.js 必须完全一致（交叉校验见 server/test/protocol.test.js） */
function roomKey(roomId, pass = '') {
  const id = String(roomId == null ? '' : roomId).trim();
  if (!id) return '';
  return crypto
    .createHash('sha256')
    .update(id + '\u0000' + String(pass == null ? '' : pass), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function normRoomKey(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return ROOM_KEY_RE.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// 基础归一化
// ---------------------------------------------------------------------------
/** 昵称：去掉控制字符与首尾空白，按"码点"截断（别把 emoji 劈成半个） */
function normNick(v) {
  let s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  const cps = Array.from(s);
  if (cps.length > LIMITS.NICK_MAX) s = cps.slice(0, LIMITS.NICK_MAX).join('');
  return s || '玩家';
}

function normMap(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return MAP_RE.test(s) ? s : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

function clampWidth(v) {
  const n = num(v);
  if (n === null) return 4;
  return Math.max(1, Math.min(20, Math.round(n)));
}

function sanitizePoint(p) {
  if (!p || typeof p !== 'object') return null;
  const x = num(p.x);
  const z = num(p.z);
  if (x === null || z === null) return null;
  return { x: round2(x), z: round2(z) };
}

// ---------------------------------------------------------------------------
// 帧
// ---------------------------------------------------------------------------
/** 解析一帧文本：返回 {ok:true,data} 或 {ok:false,code} */
function parseFrame(raw, maxBytes = LIMITS.FRAME_MAX) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  if (buf.length > maxBytes) return { ok: false, code: 'too-large' };
  let data;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch {
    return { ok: false, code: 'bad-json' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, code: 'bad-json' };
  if (typeof data.t !== 'string' || data.t.length > 24) return { ok: false, code: 'bad-json' };
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// 位置
// ---------------------------------------------------------------------------
/**
 * 归一化一条定位：{map,x,z,y,hdg,ts,trail?}
 * 坐标体系与客户端一致（世界坐标，y 是高度，hdg 是朝向角度）。
 * 位置一定带地图 id —— 顺手就同步了"我在哪张图"，不用再多一条消息。
 */
function sanitizePos(msg, now = Date.now()) {
  if (!msg || typeof msg !== 'object') return null;
  const map = normMap(msg.map);
  if (!map) return null;
  const x = num(msg.x);
  const z = num(msg.z);
  if (x === null || z === null) return null;
  const y = num(msg.y);
  const hdg = num(msg.hdg);
  const ts = num(msg.ts);
  const out = {
    map,
    x: round2(x),
    z: round2(z),
    y: y === null ? 0 : round2(y),
    hdg: hdg === null ? null : round2(hdg),
    ts: ts === null ? now : Math.round(ts),
  };
  if (Array.isArray(msg.trail) && msg.trail.length) {
    const trail = [];
    for (const p of msg.trail.slice(-LIMITS.TRAIL_MAX)) {
      const pt = sanitizePoint(p);
      if (pt) trail.push(pt);
    }
    if (trail.length >= 2) out.trail = trail; // 单点画不出线，不如不发
  }
  return out;
}

// ---------------------------------------------------------------------------
// 标注
// ---------------------------------------------------------------------------
/**
 * 归一化一条标注操作。
 * add 需要完整笔画；del 只需要 map + id（服务端按 owner 判定能不能删）。
 */
function sanitizeAnno(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const op = msg.op === 'add' ? 'add' : msg.op === 'del' ? 'del' : null;
  if (!op) return null;
  const map = normMap(msg.map);
  if (!map) return null;
  const id = typeof msg.id === 'string' && ID_RE.test(msg.id) ? msg.id : null;
  if (!id) return null;
  if (op === 'del') return { op, map, id };
  if (!KINDS.has(msg.kind)) return null;
  const pts = Array.isArray(msg.pts)
    ? msg.pts.map(sanitizePoint).filter(Boolean).slice(0, LIMITS.PTS_MAX)
    : [];
  if (pts.length < 2) return null;
  return {
    op,
    map,
    id,
    kind: msg.kind,
    color: COLOR_RE.test(String(msg.color)) ? String(msg.color).toLowerCase() : '#f87171',
    width: clampWidth(msg.width),
    pts,
  };
}

// ---------------------------------------------------------------------------
// 勾选任务（"我勾选了哪些任务"，整份覆盖）
// ---------------------------------------------------------------------------
/**
 * 归一化一份任务 id 列表：去重、限量、按 id 规则过滤。
 * 任务 id 是 tarkov.dev 的 24 位 hex，但这里只按"通用安全 id"校验（不写死长度，
 * 免得哪天数据源换 id 规则就得改协议）；服务端**不认识任务内容**，只负责转发。
 * @returns {string[]|null} 非法输入返回 null（调用方忽略这一帧）
 */
function sanitizeQuests(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (!Array.isArray(msg.ids)) return null;
  const out = [];
  const seen = new Set();
  for (const v of msg.ids) {
    if (out.length >= LIMITS.QUESTS_MAX) break;
    const s = typeof v === 'string' ? v : '';
    if (!QUEST_ID_RE.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  // 规范化顺序：同一份集合无论客户端按什么顺序发，服务端存/转发的都是同一个列表
  // （客户端也这么排，于是"内容没变"能直接按字符串比出来）
  out.sort();
  return out;
}

/** 从落盘文件里读回来的笔画也要过一遍（文件可能被手改坏） */
function sanitizeStoredAnno(raw, owner) {
  if (!raw || typeof raw !== 'object' || !KINDS.has(raw.kind)) return null;
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
  if (!id) return null;
  const pts = Array.isArray(raw.pts) ? raw.pts.map(sanitizePoint).filter(Boolean).slice(0, LIMITS.PTS_MAX) : [];
  if (pts.length < 2) return null;
  return {
    id,
    op: 'add',
    kind: raw.kind,
    color: COLOR_RE.test(String(raw.color)) ? String(raw.color).toLowerCase() : '#f87171',
    width: clampWidth(raw.width),
    pts,
    owner: typeof owner === 'string' && ID_RE.test(owner) ? owner : String(raw.owner || ''),
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : 0,
  };
}

module.exports = {
  PROTO,
  CAPS,
  LIMITS,
  KINDS,
  roomKey,
  normRoomKey,
  normNick,
  normMap,
  parseFrame,
  sanitizePos,
  sanitizeAnno,
  sanitizeQuests,
  sanitizeStoredAnno,
  clampWidth,
};
