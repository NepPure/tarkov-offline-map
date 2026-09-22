#!/usr/bin/env node
'use strict';

/**
 * 塔科夫地图 · 房间服务端（v2.0）
 * ---------------------------------------------------------------------------
 * 目标就一个字：轻。没有数据库、没有账号、没有落盘依赖（可选开关），
 * 一个 Node 进程 + 一张内存表，几十 MB 内存就能挂住整个小队甚至几百人。
 *
 * 房间里的每一个人都是平等的：没有房主、没有管理、没有踢人，
 * 唯一的约束是"只能删自己的标注"（防手滑，见 onAnno）。
 *
 * 传输：WebSocket 文本帧 JSON。房间号不在 URL 里，也不落日志明文
 * （客户端发来的是 sha256 结果，日志只打前 6 位），所以反代的 access log 也不会泄房间。
 *
 * 环境变量：
 *   HOST=0.0.0.0           监听地址
 *   PORT=8787              监听端口
 *   MAX_ROOM_PEERS=16      单房间人数上限
 *   ROOM_TTL=600           房间空了以后保留多少秒（0 = 立刻销毁）
 *   MAX_CONN_PER_IP=8      单 IP 并发连接上限
 *   MAX_ANNOS_PER_ROOM=2000  单房间标注总数上限
 *   POS_MIN_INTERVAL_MS=200  位置消息最小间隔（更密的直接丢）
 *   PERSIST=0              1 = 标注落盘（默认关，纯内存）
 *   DATA_DIR=/data         落盘目录（PERSIST=1 时才有用）
 *   PUBLIC_STATUS=1        1 = 允许匿名访问 / 看一行状态（0 = 关掉）
 *   TRUST_PROXY=0          1 = 用 X-Forwarded-For 的第一段当客户端 IP
 *   LOG_LEVEL=info         error | warn | info | debug
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const P = require('./protocol');

const PKG = require('./package.json');
const SERVER_VERSION = PKG.version;
const SERVER_NAME = PKG.name;

const CLOSE = {
  badVersion: 4001,
  badRoom: 4002,
  roomFull: 4003,
  badFrame: 4004,
  replaced: 4005,
  rateLimit: 4006,
  needHello: 4007,
};

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
function envStr(key, def) {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
}

function envInt(key, def, min, max) {
  const n = Number(envStr(key, def));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function loadConfig(over = {}) {
  const cfg = {
    host: envStr('HOST', '0.0.0.0'),
    port: envInt('PORT', 8787, 0, 65535),
    maxRoomPeers: envInt('MAX_ROOM_PEERS', 16, 2, 256),
    roomTtlMs: envInt('ROOM_TTL', 600, 0, 86400) * 1000,
    maxConnPerIp: envInt('MAX_CONN_PER_IP', 8, 1, 512),
    maxAnnosPerRoom: envInt('MAX_ANNOS_PER_ROOM', 2000, 10, 100000),
    posMinIntervalMs: envInt('POS_MIN_INTERVAL_MS', 200, 0, 5000),
    saveDebounceMs: envInt('SAVE_DEBOUNCE_MS', 5000, 0, 60000),
    persist: envStr('PERSIST', '0') === '1',
    dataDir: envStr('DATA_DIR', '/data'),
    publicStatus: envStr('PUBLIC_STATUS', '1') !== '0',
    trustProxy: envStr('TRUST_PROXY', '0') === '1',
    logLevel: envStr('LOG_LEVEL', 'info'),
  };
  Object.assign(cfg, over); // 测试里注入 { port: 0 } 之类
  return cfg;
}

// ---------------------------------------------------------------------------
// 服务端
// ---------------------------------------------------------------------------
function createRoomServer(opts = {}) {
  const cfg = loadConfig(opts);
  const logLevel = LEVELS[cfg.logLevel] === undefined ? LEVELS.info : LEVELS[cfg.logLevel];
  const startedAt = Date.now();

  /** @type {Map<string, Room>} 房间标识 -> 房间（纯内存，重启即清） */
  const rooms = new Map();
  const connPerIp = new Map();

  function log(level, ...args) {
    if (LEVELS[level] > logLevel) return;
    console.log(`[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)}`, ...args);
  }

  const short = (key) => String(key || '').slice(0, 6);

  // -------------------------------------------------------------- 发送
  function send(ws, obj) {
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  function sendErr(ws, code, msg, closeCode) {
    send(ws, { t: 'err', code, msg });
    if (closeCode) {
      try {
        ws.close(closeCode, code);
      } catch {}
    }
  }

  function broadcast(room, obj, exceptId = null) {
    const raw = JSON.stringify(obj);
    for (const peer of room.peers.values()) {
      if (exceptId && peer.id === exceptId) continue;
      if (peer.ws.readyState !== 1) continue;
      try {
        peer.ws.send(raw);
      } catch {}
    }
  }

  // -------------------------------------------------------------- 房间
  function roomFile(key) {
    return path.join(cfg.dataDir, `${key}.json`);
  }

  function loadAnnos(room) {
    if (!cfg.persist) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(roomFile(room.key), 'utf-8'));
    } catch {
      return;
    }
    const annos = raw && typeof raw === 'object' && raw.annos && typeof raw.annos === 'object' ? raw.annos : {};
    let count = 0;
    for (const [mapId, list] of Object.entries(annos)) {
      const map = P.normMap(mapId);
      if (!map || !Array.isArray(list)) continue;
      const byMap = new Map();
      for (const item of list.slice(0, P.LIMITS.STROKES_PER_MAP)) {
        const a = P.sanitizeStoredAnno(item, item && item.owner);
        if (!a) continue;
        byMap.set(a.id, { ...a, map });
      }
      if (byMap.size) {
        room.annos.set(map, byMap);
        count += byMap.size;
      }
    }
    room.annoCount = count;
    if (count) log('info', `room ${short(room.key)} 从磁盘恢复 ${count} 笔标注`);
  }

  function saveRoom(room) {
    if (!cfg.persist || !room.dirty) return;
    const out = { v: P.PROTO, at: new Date().toISOString(), annos: {} };
    for (const [mapId, byMap] of room.annos) {
      out.annos[mapId] = [...byMap.values()].map(({ id, kind, color, width, pts, owner, at }) => ({ id, kind, color, width, pts, owner, at }));
    }
    room.dirty = false;
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      const tmp = `${roomFile(room.key)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out)); // 先写临时文件再 rename：断电也不会留半个 JSON
      fs.renameSync(tmp, roomFile(room.key));
      log('debug', `room ${short(room.key)} 落盘 ${room.annoCount} 笔`);
    } catch (e) {
      log('warn', `落盘失败 ${short(room.key)}: ${e.message}`);
      room.dirty = true; // 下次再试
    }
  }

  function markDirty(room) {
    if (!cfg.persist) return;
    room.dirty = true;
    if (room.saveTimer) return;
    room.saveTimer = setTimeout(() => {
      room.saveTimer = null;
      saveRoom(room);
    }, cfg.saveDebounceMs);
    if (room.saveTimer.unref) room.saveTimer.unref(); // 待写的定时器不该拖着进程不让退出
  }

  function getRoom(key) {
    let room = rooms.get(key);
    if (room) return room;
    room = {
      key,
      peers: new Map(),
      annos: new Map(), // mapId -> Map(annoId -> stroke{...,owner})
      annoCount: 0,
      dirty: false,
      saveTimer: null,
      gcTimer: null,
    };
    rooms.set(key, room);
    loadAnnos(room);
    log('info', `room ${short(key)} 创建`);
    return room;
  }

  function scheduleGc(room) {
    if (room.gcTimer) return;
    const ttl = cfg.roomTtlMs;
    const fire = () => {
      room.gcTimer = null;
      if (room.peers.size) return;
      saveRoom(room);
      rooms.delete(room.key);
      log('info', `room ${short(room.key)} 回收（空置 ${Math.round(ttl / 1000)}s）`);
    };
    if (ttl <= 0) return fire();
    room.gcTimer = setTimeout(fire, ttl);
    if (room.gcTimer.unref) room.gcTimer.unref();
  }

  function annosFor(room) {
    const out = {};
    for (const [mapId, byMap] of room.annos) {
      const list = [...byMap.values()];
      if (list.length) out[mapId] = list;
    }
    return out;
  }

  function peerPublic(peer) {
    const out = { id: peer.id, nick: peer.nick, map: peer.map || null };
    if (peer.pos) out.pos = peer.pos;
    return out;
  }

  // -------------------------------------------------------------- 消息
  function onHello(ws, m) {
    if (Number(m.v) !== P.PROTO) {
      log('info', `拒绝连接：协议 v${m.v}（服务端 v${P.PROTO}）`);
      sendErr(ws, 'bad-version', `服务端协议 v${P.PROTO}，客户端是 v${m.v}，请升级其中一端`, CLOSE.badVersion);
      return;
    }
    const key = P.normRoomKey(m.room);
    if (!key) {
      sendErr(ws, 'bad-room', '房间号非法', CLOSE.badRoom);
      return;
    }
    const nick = P.normNick(m.nick);
    const pid = typeof m.pid === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(m.pid) ? m.pid : crypto.randomBytes(6).toString('hex');

    const room = getRoom(key);
    if (room.gcTimer) {
      clearTimeout(room.gcTimer);
      room.gcTimer = null;
    }

    // 同一个身份重连：把旧连接顶掉（手机切网/客户端重启时经常留下半死的旧连接一直占位）
    const old = room.peers.get(pid);
    if (old && old.ws !== ws) {
      room.peers.delete(pid);
      old.room = null;
      old.ws.peer = null;
      send(old.ws, { t: 'err', code: 'replaced', msg: '相同身份在别处重连' });
      try {
        old.ws.close(CLOSE.replaced, 'replaced');
      } catch {}
    }

    if (room.peers.size >= cfg.maxRoomPeers) {
      sendErr(ws, 'room-full', `房间人数已满（上限 ${cfg.maxRoomPeers} 人）`, CLOSE.roomFull);
      log('info', `拒绝 ${short(key)}：房间满（${room.peers.size}/${cfg.maxRoomPeers}）`);
      return;
    }

    const peer = {
      id: pid,
      nick,
      ws,
      room,
      map: null,
      pos: null,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      lastPosAt: 0,
      dropped: 0,
    };
    room.peers.set(pid, peer);
    ws.peer = peer;
    ws.helloDone = true;
    ws.roomKey = key;

    send(ws, {
      t: 'welcome',
      proto: P.PROTO,
      ver: SERVER_VERSION,
      self: { id: pid, nick },
      peers: [...room.peers.values()].filter((p) => p.id !== pid).map(peerPublic),
      annos: annosFor(room),
    });
    broadcast(room, { t: 'peer-join', peer: peerPublic(peer) }, pid);
    log('info', `join ${short(key)} nick=${nick} id=${pid} 人数=${room.peers.size}`);
  }

  function onMap(peer, m) {
    const map = P.normMap(m.map);
    if (!map || map === peer.map) return;
    peer.map = map;
    // 换图 = 上一张图上的定位作废。客户端进新局时本来就把自己的位置/轨迹清掉了，
    // 这里不跟着清的话，队友图上会一直停着一个"旧图上的假点"，图例还会说他在那张图上。
    peer.pos = null;
    // 和位置一样不回给本人；pos:null 明确告诉其他人"把他之前的点抹掉"
    broadcast(peer.room, { t: 'peer-map', id: peer.id, map, pos: null }, peer.id);
  }

  /**
   * 新一局：把他记的定位抹掉，并告诉其他人"他那个点作废"。
   * 客户端进新局时会自己清本机那份，但"他开新局"这件事只有服务端能转达给其他人 ——
   * 少了这条，没在局内（或没识别到新局）的队友屏幕上会一直停着他的旧点。
   */
  function onNewRaid(peer) {
    if (!peer.pos) return;
    peer.pos = null;
    broadcast(peer.room, { t: 'peer-reset', id: peer.id }, peer.id);
  }

  function onPos(peer, m) {
    const now = Date.now();
    // 位置是高频消息：太密的直接丢，但不明确报错（客户端本来就是"有定位才发"）
    if (now - peer.lastPosAt < cfg.posMinIntervalMs) {
      peer.dropped += 1;
      if (peer.dropped > 200) {
        sendErr(peer.ws, 'rate-limit', '位置上报过于频繁', CLOSE.rateLimit);
      }
      return;
    }
    const pos = P.sanitizePos(m, now);
    if (!pos) return;
    peer.dropped = 0;
    peer.lastPosAt = now;
    peer.map = pos.map;
    peer.pos = pos;
    peer.lastSeen = now;
    // 不回给发送者本人：客户端自己就有这份位置，回显只是白烧一倍流量
    broadcast(peer.room, { t: 'peer-pos', id: peer.id, ...pos }, peer.id);
  }

  function onAnno(peer, m) {
    const a = P.sanitizeAnno(m);
    if (!a) return;
    const room = peer.room;
    const byMap = room.annos.get(a.map) || new Map();

    if (a.op === 'add') {
      const existed = byMap.has(a.id);
      if (!existed && room.annoCount >= cfg.maxAnnosPerRoom) {
        sendErr(peer.ws, 'anno-limit', '房间标注数量已达上限');
        return;
      }
      if (!existed && byMap.size >= P.LIMITS.STROKES_PER_MAP) {
        sendErr(peer.ws, 'anno-limit', '这张图的标注数量已达上限');
        return;
      }
      const prev = byMap.get(a.id);
      if (prev && prev.owner !== peer.id) return; // 别人的 id 不能被你覆盖
      byMap.set(a.id, { ...a, map: a.map, owner: peer.id, at: Date.now() });
      room.annos.set(a.map, byMap);
      if (!existed) room.annoCount += 1;
      markDirty(room);
      broadcast(room, { t: 'anno', ...a, owner: peer.id }); // 含发送者本人：id/顺序由服务端兜底
      return;
    }

    // del：只能删自己的（房间里人人平等，这一条只是防手滑/防误删）
    const prev = byMap.get(a.id);
    if (!prev) return;
    if (prev.owner !== peer.id) {
      log('debug', `del 被拒：${peer.id} 想删 ${prev.owner} 的 ${a.id}`);
      return;
    }
    byMap.delete(a.id);
    room.annoCount -= 1;
    if (!byMap.size) room.annos.delete(a.map);
    markDirty(room);
    broadcast(room, { t: 'anno', op: 'del', map: a.map, id: a.id, owner: peer.id });
  }

  function onMessage(ws, raw) {
    const parsed = P.parseFrame(raw, P.LIMITS.FRAME_MAX);
    if (!parsed.ok) {
      log('debug', `非法帧（${parsed.code}）来自 ${ws.ip || '?'}`);
      sendErr(ws, parsed.code, '帧非法或过大', CLOSE.badFrame);
      return;
    }
    const m = parsed.data;
    if (!ws.helloDone) {
      if (m.t !== 'hello') {
        sendErr(ws, 'need-hello', '第一帧必须是 hello', CLOSE.needHello);
        return;
      }
      return onHello(ws, m);
    }
    const peer = ws.peer;
    if (!peer) return;
    peer.lastSeen = Date.now();
    switch (m.t) {
      case 'ping':
        return send(ws, { t: 'pong', now: Date.now() });
      case 'map':
        return onMap(peer, m);
      case 'pos':
        return onPos(peer, m);
      case 'newraid':
        return onNewRaid(peer);
      case 'anno':
        return onAnno(peer, m);
      default:
        return; // 未知类型静默忽略：以后加消息类型时老服务端不会炸
    }
  }

  function onClose(ws) {
    const peer = ws.peer;
    ws.peer = null;
    if (!peer || !peer.room) return;
    const room = peer.room;
    peer.room = null;
    if (room.peers.get(peer.id) === peer) {
      room.peers.delete(peer.id);
      broadcast(room, { t: 'peer-left', id: peer.id });
      log('info', `leave ${short(room.key)} id=${peer.id} 人数=${room.peers.size}`);
    }
    if (!room.peers.size) scheduleGc(room);
  }

  // -------------------------------------------------------------- HTTP
  function health() {
    let peers = 0;
    for (const room of rooms.values()) peers += room.peers.size;
    const mem = process.memoryUsage();
    return {
      ok: true,
      name: SERVER_NAME,
      ver: SERVER_VERSION,
      proto: P.PROTO,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      rooms: rooms.size,
      peers,
      maxRoomPeers: cfg.maxRoomPeers,
      persist: cfg.persist,
      rssMB: Math.round(mem.rss / 1048576),
    };
  }

  function statusText() {
    const h = health();
    const up = `${Math.floor(h.uptime / 3600)}h${Math.floor((h.uptime % 3600) / 60)}m${h.uptime % 60}s`;
    return [
      `${SERVER_NAME} v${SERVER_VERSION}（协议 v${P.PROTO}）`,
      `运行 ${up} · 房间 ${h.rooms} 个 · 在线 ${h.peers} 人 · 内存 ${h.rssMB}MB`,
      `上限：每房间 ${h.maxRoomPeers} 人 · 单帧 ${Math.round(P.LIMITS.FRAME_MAX / 1024)}KB · 落盘 ${h.persist ? '开' : '关'}`,
      '健康检查：GET /healthz    WebSocket：/ws',
    ].join('\n');
  }

  function json(res, code, body) {
    const data = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(data),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(data);
  }

  function clientIp(req) {
    if (cfg.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || '?';
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/healthz') return json(res, 200, health());
    if (url.pathname === '/' || url.pathname === '/status') {
      if (!cfg.publicStatus) return json(res, 404, { ok: false, error: 'not found' });
      const body = statusText();
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(body);
    }
    return json(res, 404, { ok: false, error: 'not found' });
  });

  const wss = new WebSocketServer({
    noServer: true,
    // 注意：不要关 clientTracking —— 心跳和优雅关闭都要遍历 wss.clients
    maxPayload: P.LIMITS.FRAME_MAX,
    perMessageDeflate: false, // 位置消息很小，压缩只会白烧 CPU
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {}
    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    const used = connPerIp.get(ip) || 0;
    if (used >= cfg.maxConnPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      log('warn', `拒绝 ${ip}：连接数超限（${used}）`);
      return;
    }
    connPerIp.set(ip, used + 1);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.ip = ip;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.helloDone = false;
    ws.peer = null;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => onMessage(ws, raw));
    ws.on('error', () => {});
    ws.on('close', () => {
      onClose(ws);
      const n = (connPerIp.get(ws.ip) || 1) - 1;
      if (n <= 0) connPerIp.delete(ws.ip);
      else connPerIp.set(ws.ip, n);
    });
  });

  // 心跳：30 秒 ping 一次，上一轮没回 pong 的直接掐掉（半死连接不会永远挂在房间里）
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {}
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    }
  }, 30000);
  if (heartbeat.unref) heartbeat.unref();

  // -------------------------------------------------------------- 生命周期
  function start(cb) {
    server.listen(cfg.port, cfg.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
      log('info', `${SERVER_NAME} v${SERVER_VERSION} 监听 ${cfg.host}:${port}（协议 v${P.PROTO}，落盘 ${cfg.persist ? '开' : '关'}）`);
      if (cb) cb(port);
    });
    return server;
  }

  function flushAll() {
    for (const room of rooms.values()) {
      if (room.saveTimer) {
        clearTimeout(room.saveTimer);
        room.saveTimer = null;
      }
      saveRoom(room);
    }
  }

  function close(cb) {
    clearInterval(heartbeat);
    flushAll();
    // 直接强拆连接，不等 WebSocket 挥手：一是关得快，二是避免"客户端半天不回应 ->
    // wss.close() 的回调永不触发 -> 整个进程关不掉"（这个坑在单测里真的踩到过）。
    for (const ws of wss.clients) {
      try {
        ws.terminate();
      } catch {}
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cb && cb();
    };
    wss.close(() => {});
    server.close(finish);
    setTimeout(() => {
      try {
        server.closeAllConnections();
      } catch {}
    }, 200);
    setTimeout(finish, 1500).unref(); // 兜底：绝不让调用方永远等下去
  }

  return { cfg, server, wss, rooms, health, statusText, start, close, flushAll, log };
}

// ---------------------------------------------------------------------------
// 命令行参数（Windows 单文件 exe / 一条命令启动都靠它）
//
// 优先级：命令行 > 环境变量 > 默认值。命令行只是把同样的开关写得更顺手 ——
// 在 Windows 上设环境变量很别扭，而双击 exe 时连命令行都没有，就全用默认值。
//   tarkov-map-server.exe --port 9000 --max-room-peers 8 --persist --data-dir D:\room
// ---------------------------------------------------------------------------
const FLAG_TO_CFG = {
  host: 'host',
  port: 'port',
  'max-room-peers': 'maxRoomPeers',
  'room-ttl': 'roomTtlSec',              // 秒（内部会 x1000）
  'max-conn-per-ip': 'maxConnPerIp',
  'max-annos-per-room': 'maxAnnosPerRoom',
  'pos-min-interval-ms': 'posMinIntervalMs',
  'save-debounce-ms': 'saveDebounceMs',
  'data-dir': 'dataDir',
  'log-level': 'logLevel',
  persist: 'persist',
  'public-status': 'publicStatus',
  'trust-proxy': 'trustProxy',
};
const BOOL_FLAGS = new Set(['persist', 'public-status', 'trust-proxy']);
const INT_FLAGS = {
  port: [8787, 0, 65535],
  maxRoomPeers: [16, 2, 256],
  roomTtlSec: [600, 0, 86400],
  maxConnPerIp: [8, 1, 512],
  maxAnnosPerRoom: [2000, 10, 100000],
  posMinIntervalMs: [200, 0, 5000],
  saveDebounceMs: [5000, 0, 60000],
};

/**
 * 解析命令行：返回 { over, help, version, unknown }。
 * over 直接喂给 createRoomServer()（loadConfig 会 Object.assign 上去）。
 * 认不出来的参数一律忽略 —— Windows/SEA 会在 argv 里塞自己的东西，不该因此启动失败。
 */
function parseArgs(argv = []) {
  const over = {};
  const unknown = [];
  let help = false;
  let version = false;
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const raw = String(list[i] == null ? '' : list[i]);
    if (!raw.startsWith('-')) continue;
    let body = raw.replace(/^-+/, '');
    let value = null;
    const eq = body.indexOf('=');
    if (eq >= 0) {
      value = body.slice(eq + 1);
      body = body.slice(0, eq);
    }
    const key = body.toLowerCase();
    if (key === 'h' || key === 'help') { help = true; continue; }
    if (key === 'v' || key === 'version') { version = true; continue; }
    const cfgKey = FLAG_TO_CFG[key];
    if (!cfgKey) { unknown.push(raw); continue; }
    const isBool = BOOL_FLAGS.has(key);
    if (value == null && !isBool) {
      const next = list[i + 1];
      if (next !== undefined && !String(next).startsWith('-')) {
        value = String(next);
        i += 1;
      }
    }
    if (isBool) {
      // --persist / --persist=1 / --persist=0 / --public-status=false
      const on = value == null ? true : !/^(0|false|no|off)$/i.test(String(value));
      over[cfgKey] = on;
      continue;
    }
    if (value == null) { unknown.push(raw); continue; }
    const intSpec = INT_FLAGS[cfgKey];
    if (intSpec) {
      const n = Number(value);
      over[cfgKey] = Number.isFinite(n)
        ? Math.max(intSpec[1], Math.min(intSpec[2], Math.round(n)))
        : intSpec[0];
    } else {
      over[cfgKey] = String(value);
    }
  }
  if (over.roomTtlSec !== undefined) {
    over.roomTtlMs = over.roomTtlSec * 1000;
    delete over.roomTtlSec;
  }
  return { over, help, version, unknown };
}

function usageText() {
  return [
    `${SERVER_NAME} v${SERVER_VERSION}（协议 v${P.PROTO}）—— 塔科夫地图 · 房间服务端`,
    '',
    '用法：',
    '  tarkov-map-server.exe                       用默认值启动（监听 0.0.0.0:8787）',
    '  tarkov-map-server.exe --port 9000           换端口',
    '  tarkov-map-server.exe --persist --data-dir D:\\room-annos   标注落盘（重启不丢）',
    '  tarkov-map-server.exe --help                看这一页',
    '',
    '命令行开关（等价的环境变量写在括号里，优先级：命令行 > 环境变量 > 默认值）：',
    '  --host <addr>                监听地址（HOST，默认 0.0.0.0）',
    '  --port <n>                   监听端口（PORT，默认 8787）',
    '  --max-room-peers <n>         单房间人数上限（MAX_ROOM_PEERS，默认 16）',
    '  --room-ttl <秒>              房间空了以后保留多久（ROOM_TTL，默认 600）',
    '  --max-conn-per-ip <n>        单 IP 并发连接上限（MAX_CONN_PER_IP，默认 8）',
    '  --max-annos-per-room <n>     单房间标注总数上限（MAX_ANNOS_PER_ROOM，默认 2000）',
    '  --pos-min-interval-ms <n>    位置消息最小间隔（POS_MIN_INTERVAL_MS，默认 200）',
    '  --save-debounce-ms <n>       落盘防抖（SAVE_DEBOUNCE_MS，默认 5000）',
    '  --persist                   标注落盘（PERSIST=1，默认关：纯内存）',
    '  --data-dir <dir>             落盘目录（DATA_DIR，默认 /data）',
    '  --log-level <lvl>            error|warn|info|debug（LOG_LEVEL，默认 info）',
    '  --public-status[=0]          匿名状态页开关（PUBLIC_STATUS，默认开）',
    '  --trust-proxy                反代时按 X-Forwarded-For 限流（TRUST_PROXY）',
    '',
    '停止：按 Ctrl+C（双击启动的话，直接关掉这个窗口）。',
  ].join('\n');
}

/** 本机内网 IPv4：启动时打出来，用户直接照着填客户端设置 */
function lanAddresses() {
  const out = [];
  try {
    const os = require('os');
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni && ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
      }
    }
  } catch {}
  return out;
}

function printBanner(cfg, port) {
  const lans = lanAddresses();
  const lines = ['', `  塔科夫地图 · 房间服务端 v${SERVER_VERSION}（协议 v${P.PROTO}）`, `  正在监听：${cfg.host}:${port}`];
  if (lans.length) {
    lines.push('  客户端「设置 → 房间（联机）」里填：');
    for (const l of lans) lines.push(`      服务器地址 = ${l.address}${l.name ? `   （${l.name}）` : ''}  端口 = ${port}`);
  } else {
    lines.push(`  客户端「设置 → 房间（联机）」里填：服务器地址 = 本机 IP   端口 = ${port}`);
  }
  lines.push(`  健康检查 http://127.0.0.1:${port}/healthz    状态页 http://127.0.0.1:${port}/`);
  lines.push(`  标注落盘：${cfg.persist ? `开（${cfg.dataDir}）` : '关（纯内存，重启即清）'}`);
  if (cfg.host === '0.0.0.0') lines.push('  队友要连进来：Windows 防火墙 / 云安全组要放行这个端口');
  lines.push('  停止：按 Ctrl+C（双击启动的话，关掉这个窗口即可）', '');
  console.log(lines.join('\n'));
}

/** 双击 exe 时窗口别一闪就没：出错/退出前等用户按一下回车 */
function pauseBeforeExit(code) {
  const canPause = process.stdin.isTTY && !process.env.TARKOV_NO_PAUSE && !process.env.CI;
  if (!canPause) {
    process.exit(code);
    return;
  }
  console.log('  按回车键关闭窗口…');
  try { process.stdin.resume(); } catch {}
  const bye = () => process.exit(code);
  try { process.stdin.once('data', bye); } catch { setTimeout(bye, 100); }
  setTimeout(bye, 120000).unref();
}

function main() {
  const parsed = parseArgs(process.argv.slice(1));
  if (parsed.help) { console.log(usageText()); return; }
  if (parsed.version) { console.log(`${SERVER_NAME} v${SERVER_VERSION}（协议 v${P.PROTO}）`); return; }
  const srv = createRoomServer(parsed.over);
  if (parsed.unknown.length) console.log(`  提示：忽略了不认识的参数 ${parsed.unknown.join(' ')}（--help 看用法）`);

  srv.server.on('error', (e) => {
    const hint = e && e.code === 'EADDRINUSE'
      ? `端口 ${srv.cfg.port} 已被占用（是不是已经开着一个服务端？换 --port 再试）`
      : (e && e.message) || String(e);
    console.error(`\n  启动失败：${hint}\n`);
    pauseBeforeExit(1);
  });

  srv.start((port) => printBanner(srv.cfg, port));

  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`[${new Date().toISOString()}] INFO  收到 ${sig}，正在关闭…`);
    srv.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (e) => {
    console.error(`\n  未捕获异常：${(e && e.stack) || e}\n`);
    pauseBeforeExit(1);
  });
}

// ---------------------------------------------------------------------------
// 直接运行（require 引入时不自动监听，方便单测）
// SEA（tools/make-server-exe.js 打出来的单文件 exe）里 require.main 不一定是本模块，
// 所以额外认一下 node:sea 的 isSea()。
// ---------------------------------------------------------------------------
const IS_SEA = (() => {
  try { return require('node:sea').isSea(); } catch { return false; }
})();

if (require.main === module || IS_SEA) main();

module.exports = { createRoomServer, parseArgs, usageText, PROTO: P.PROTO, LIMITS: P.LIMITS, SERVER_VERSION };
