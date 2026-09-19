'use strict';

/**
 * 房间客户端（主进程持有）。
 *
 * 为什么放在主进程而不是渲染进程：
 *   - 有两个窗口（主地图 + 圆形小地图）都要用同一份房间数据，主进程是天然的唯一真源；
 *   - 渲染进程重载（比如切图/刷新）不会把连接抖掉；
 *   - 将来要换成自签 TLS 或者走代理，也不用碰渲染层的 CSP。
 *
 * 这个模块是纯 Node 的（只用 ws + node:http），不 require electron —— 所以单测里可以
 * 直接起一个真服务端、连两个真客户端跑完整流程，不需要开界面。
 *
 * 房间号在这里推导（src/room-key.js），服务端只见到哈希。
 */
const http = require('http');
const https = require('https');
const { roomKey } = require('./room-key');
const P = require('../server/protocol');

const PROTO = P.PROTO;
const DEFAULT_PORT = 8787;
const POS_MIN_INTERVAL_MS = 200;   // 位置消息最小间隔（和服务端限速一致）
const PING_INTERVAL_MS = 25000;    // 应用层心跳
const PONG_TIMEOUT_MS = 10000;     // 心跳没回就判定连接已死
const MAX_BACKOFF_MS = 30000;

/** 指数退避：1s, 2s, 4s, 8s, 16s, 30s, 30s… */
function backoffDelay(attempt) {
  const n = Math.max(0, Math.min(20, Math.floor(attempt) || 0));
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** n);
}

/**
 * 把用户填的地址归一化成连接信息。
 * 允许的写法： `192.168.1.10` / `192.168.1.10:9000` / `ws://host:8787/ws` /
 *             `wss://room.example.com` / `http://host:8787`
 * 返回 null 表示没填。
 */
function parseServer(input, defaultPort = DEFAULT_PORT) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return null;
  let secure = false;
  let rest = raw;
  const m = /^(wss?|https?):\/\//i.exec(raw);
  if (m) {
    secure = /^(wss|https)$/i.test(m[1]);
    rest = raw.slice(m[0].length);
  }
  rest = rest.replace(/\/+$/, '');
  rest = rest.replace(/\/ws$/i, '');
  if (!rest) return null;
  let host = rest;
  let port = defaultPort;
  const c = rest.lastIndexOf(':');
  if (c > 0 && !rest.includes(']')) {
    const maybePort = rest.slice(c + 1);
    if (/^\d{1,5}$/.test(maybePort)) {
      port = Math.max(1, Math.min(65535, Number(maybePort)));
      host = rest.slice(0, c);
    }
  }
  if (!host) return null;
  const scheme = secure ? 'wss' : 'ws';
  const httpScheme = secure ? 'https' : 'http';
  return {
    host,
    port,
    secure,
    wsUrl: `${scheme}://${host}:${port}/ws`,
    healthUrl: `${httpScheme}://${host}:${port}/healthz`,
  };
}

/** 探活：GET /healthz，给设置页的「测试连接」用 */
function probeServer(input, defaultPort = DEFAULT_PORT, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const info = parseServer(input, defaultPort);
    if (!info) return resolve({ ok: false, error: '没填服务器地址' });
    const mod = info.secure ? https : http;
    const req = mod.get(info.healthUrl, { timeout: timeoutMs, headers: { connection: 'close' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, error: `服务端返回 ${res.statusCode}`, server: info });
        let body = null;
        try {
          body = JSON.parse(data);
        } catch {
          return resolve({ ok: false, error: '服务端返回的不是 JSON', server: info });
        }
        if (!body || body.ok !== true) return resolve({ ok: false, error: '服务端健康检查未通过', server: info });
        const protoOk = Number(body.proto) === PROTO;
        resolve({
          ok: true,
          protoOk,
          ver: body.ver || null,
          proto: body.proto || null,
          maxRoomPeers: body.maxRoomPeers || null,
          persist: !!body.persist,
          server: info,
          error: protoOk ? null : `协议不匹配：服务端 v${body.proto}，客户端 v${PROTO}`,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: `连接超时（${timeoutMs}ms）`, server: info });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message || String(e), server: info }));
  });
}

const EMPTY_STATE = () => ({
  enabled: false,
  status: 'off',      // off | connecting | online | reconnecting | error
  error: null,
  server: null,       // {host, port, secure}
  self: null,         // {id, nick}
  peers: [],          // [{id, nick, map, pos, at}]
  annos: {},          // mapId -> [笔画]（只含别人的）
  roomHint: null,     // 房间标识前 6 位（排查用，不是暗号）
  onlineSince: null,
  attempts: 0,
});

class RoomClient {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.onState] 状态变化回调（主进程广播给窗口用）
   * @param {Function} [opts.onLog]   日志回调
   * @param {Function} [opts.now]     取时间（单测可注入）
   * @param {Function} [opts.WebSocketImpl] 注入假 WebSocket（单测）
   */
  constructor(opts = {}) {
    this.onState = opts.onState || (() => {});
    this.onLog = opts.onLog || (() => {});
    this.now = opts.now || (() => Date.now());
    this.WebSocketImpl = opts.WebSocketImpl || require('ws');
    this.state = EMPTY_STATE();
    this.ws = null;
    this.cfg = null;          // 归一化后的房间配置
    this.timers = { reconnect: null, ping: null, pong: null, pos: null };
    this.pendingPos = null;   // 被节流挡住、等着补发的位置
    this.lastPosAt = 0;
    this.lastPingAt = 0;
    this.closedByUs = false;
  }

  // ------------------------------------------------------------------ 对外
  /**
   * 应用配置（设置页改了地址/房间号/昵称都走这里）。
   * 返回 true 表示"现在应该在房间里"。
   */
  applyConfig(roomCfg) {
    const next = normalizeConfig(roomCfg);
    const prev = this.cfg;
    this.cfg = next;
    this.state.enabled = next.enabled;
    if (!next.enabled) {
      this.disconnect('已关闭房间功能');
      return false;
    }
    const changed = !prev || !sameTarget(prev, next);
    if (changed) {
      this.onLog(`房间配置变化 -> ${next.server.host}:${next.server.port} 昵称=${next.nick}`);
      this.connect();
    }
    return true;
  }

  connect() {
    if (!this.cfg || !this.cfg.enabled || !this.cfg.server) return;
    this.stopTimers();
    this.closedByUs = false;
    if (this.ws) {
      // 先把旧连接的监听摘掉再关：直接 close() 会触发 onClose，那会被当成"意外断线"
      // 又排一次重连（实测会多出一轮无意义的 1005 重连）。
      const old = this.ws;
      this.ws = null;
      try {
        if (old.removeAllListeners) old.removeAllListeners();
      } catch {}
      try {
        old.close();
      } catch {}
    }
    const { wsUrl } = this.cfg.server;
    this.setState({ status: this.state.attempts ? 'reconnecting' : 'connecting', error: null, server: { ...this.cfg.server } });
    this.onLog(`连接房间 ${wsUrl}`);
    let ws;
    try {
      ws = new this.WebSocketImpl(wsUrl);
    } catch (e) {
      this.fail(e.message || String(e));
      return;
    }
    this.ws = ws;
    ws.on('open', () => this.onOpen());
    ws.on('message', (raw) => this.onMessage(raw));
    ws.on('close', (code, reason) => this.onClose(code, reason));
    ws.on('error', (e) => this.onLog(`连接错误：${e && e.message ? e.message : e}`));
  }

  disconnect(reason = '主动断开') {
    this.stopTimers();
    this.closedByUs = true;
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        if (old.removeAllListeners) old.removeAllListeners();
      } catch {}
      try {
        old.close();
      } catch {}
    }
    const keep = this.state.enabled && this.cfg && this.cfg.enabled;
    this.state = { ...EMPTY_STATE(), enabled: keep, server: this.cfg && this.cfg.server ? { ...this.cfg.server } : null, status: keep ? 'off' : 'off' };
    if (reason) this.onLog(`离开房间：${reason}`);
    this.emit();
  }

  /** 我在哪张图（换图/进图时调用，去重 + 未进房时忽略） */
  setMap(mapId) {
    const map = P.normMap(mapId);
    if (!map || map === this.myMap) return;
    this.myMap = map;
    this.send({ t: 'map', map });
  }

  /** 上报定位（带轨迹尾巴）；节流合并，保证最后一条一定会发出去 */
  setPosition(pos) {
    if (!pos || !this.cfg || !this.cfg.sharePos) return;
    const msg = {
      t: 'pos',
      map: pos.map,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      hdg: pos.hdg,
      ts: pos.ts,
      trail: Array.isArray(pos.trail) ? pos.trail : undefined,
    };
    const now = this.now();
    if (now - this.lastPosAt >= POS_MIN_INTERVAL_MS) {
      this.lastPosAt = now;
      this.send(msg);
      return;
    }
    // 太密了：只留最后一条，等节流窗口过去再补发（丢掉中间的，位置本来就是"最新覆盖旧"）
    this.pendingPos = msg;
    if (!this.timers.pos) {
      const wait = Math.max(0, POS_MIN_INTERVAL_MS - (now - this.lastPosAt));
      this.timers.pos = setTimeout(() => {
        this.timers.pos = null;
        const p = this.pendingPos;
        this.pendingPos = null;
        if (p) {
          this.lastPosAt = this.now();
          this.send(p);
        }
      }, wait);
      if (this.timers.pos.unref) this.timers.pos.unref();
    }
  }

  /** 我画了一笔（服务端会回显，统一 id 与顺序） */
  sendAnnoAdd(anno) {
    if (!this.cfg || !this.cfg.shareAnno) return false;
    return this.send({ t: 'anno', op: 'add', map: anno.map, id: anno.id, kind: anno.kind, color: anno.color, width: anno.width, pts: anno.pts });
  }

  sendAnnoDel(mapId, id) {
    if (!this.cfg || !this.cfg.shareAnno) return false;
    return this.send({ t: 'anno', op: 'del', map: mapId, id });
  }

  /** 给设置页/状态栏看的快照 */
  snapshot() {
    return {
      ...this.state,
      peers: this.state.peers.map((p) => ({ ...p })),
      annos: this.state.annos,
    };
  }

  // ------------------------------------------------------------------ 内部
  setState(patch) {
    Object.assign(this.state, patch);
    this.emit();
  }

  emit() {
    try {
      this.onState(this.snapshot());
    } catch (e) {
      this.onLog(`状态回调出错：${e.message}`);
    }
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      this.onLog(`发送失败：${e.message}`);
      return false;
    }
  }

  stopTimers() {
    for (const k of Object.keys(this.timers)) {
      if (this.timers[k]) {
        clearTimeout(this.timers[k]);
        clearInterval(this.timers[k]);
        this.timers[k] = null;
      }
    }
  }

  onOpen() {
    this.onLog('连接已建立，发送 hello');
    this.myMap = null;
    this.send({
      t: 'hello',
      v: PROTO,
      room: this.cfg.roomKey,
      nick: this.cfg.nick,
      pid: this.cfg.peerId,
      ver: this.cfg.ver,
    });
  }

  onHello() {
    this.state.attempts = 0;
    this.setState({ status: 'online', error: null, onlineSince: this.now() });
    this.startPing();
    if (this.onOnline) this.onOnline();
  }

  startPing() {
    if (this.timers.ping) clearInterval(this.timers.ping);
    this.timers.ping = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      this.lastPingAt = this.now();
      this.send({ t: 'ping' });
      if (this.timers.pong) clearTimeout(this.timers.pong);
      this.timers.pong = setTimeout(() => {
        this.onLog(`心跳 ${PONG_TIMEOUT_MS}ms 没回应，判定连接已断`);
        try {
          this.ws.terminate ? this.ws.terminate() : this.ws.close();
        } catch {}
      }, PONG_TIMEOUT_MS);
      if (this.timers.pong.unref) this.timers.pong.unref();
    }, PING_INTERVAL_MS);
    if (this.timers.ping.unref) this.timers.ping.unref();
  }

  onMessage(raw) {
    let m = null;
    try {
      m = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      return;
    }
    if (m && m.t === 'pong' && this.timers.pong) {
      clearTimeout(this.timers.pong);
      this.timers.pong = null;
    }
    switch (m.t) {
      case 'welcome': {
        this.state.self = m.self || null;
        this.state.roomHint = null;
        this.state.peers = (m.peers || []).map((p) => ({ id: p.id, nick: p.nick, map: p.map || null, pos: p.pos || null, at: this.now() }));
        this.state.annos = normalizeAnnos(m.annos);
        this.onHello();
        this.onLog(`已在房间里：${(m.peers || []).length} 个队友，${countAnnos(m.annos)} 笔标注`);
        this.emit();
        return;
      }
      case 'peer-join': {
        const p = m.peer || {};
        if (!p.id || p.id === (this.state.self && this.state.self.id)) return;
        this.state.peers = [...this.state.peers.filter((x) => x.id !== p.id), { id: p.id, nick: p.nick, map: p.map || null, pos: p.pos || null, at: this.now() }];
        this.onLog(`队友加入：${p.nick}`);
        this.emit();
        return;
      }
      case 'peer-left': {
        const before = this.state.peers.length;
        this.state.peers = this.state.peers.filter((x) => x.id !== m.id);
        // 人走了，他的标注也一并从本地视图里去掉（服务端的标注在房间回收前还留着）
        this.state.annos = dropOwner(this.state.annos, m.id);
        if (before !== this.state.peers.length) this.onLog(`队友离开：${m.id}`);
        this.emit();
        return;
      }
      case 'peer-map': {
        this.patchPeer(m.id, { map: m.map || null });
        this.emit();
        return;
      }
      case 'peer-pos': {
        this.patchPeer(m.id, { map: m.map || null, pos: pickPos(m), at: this.now() });
        this.emit();
        return;
      }
      case 'anno': {
        this.state.annos = applyAnno(this.state.annos, m);
        this.emit();
        return;
      }
      case 'err': {
        const fatal = ['bad-version', 'bad-room', 'room-full', 'replaced'].includes(m.code);
        this.onLog(`服务端拒绝：${m.code} ${m.msg || ''}`);
        if (fatal) {
          // 重连也是同样的结果：标记成致命错误并停止重连，把原因显示给用户
          this.fatal = m.code;
          this.closedByUs = true;
          this.setState({ status: 'error', error: m.msg || m.code });
        } else {
          this.setState({ error: m.msg || m.code });
        }
        return;
      }
      default:
        return;
    }
  }

  patchPeer(id, patch) {
    let hit = false;
    this.state.peers = this.state.peers.map((p) => {
      if (p.id !== id) return p;
      hit = true;
      return { ...p, ...patch };
    });
    if (!hit) {
      // 没见过的 id（比如刚重连、peer-join 丢了）：先占个位置，等下一帧补齐昵称
      this.state.peers = [...this.state.peers, { id, nick: '队友', map: patch.map || null, pos: patch.pos || null, at: this.now() }];
    }
  }

  onClose(code, reason) {
    this.stopTimers();
    if (this.closedByUs) return;
    const why = `连接断开（code=${code}${reason ? ` ${reason}` : ''}）`;
    if (this.fatal) {
      this.setState({ status: 'error', error: this.state.error || this.fatal });
      this.onLog(`${why}，服务端已明确拒绝，不再重连`);
      return;
    }
    this.state.attempts += 1;
    const delay = backoffDelay(this.state.attempts - 1);
    this.setState({ status: 'reconnecting', error: null, peers: [], annos: {} });
    this.onLog(`${why}，${Math.round(delay / 1000)}s 后重连（第 ${this.state.attempts} 次）`);
    this.timers.reconnect = setTimeout(() => {
      this.timers.reconnect = null;
      this.connect();
    }, delay);
    if (this.timers.reconnect.unref) this.timers.reconnect.unref();
  }

  fail(msg) {
    this.setState({ status: 'error', error: msg });
    this.state.attempts += 1;
    const delay = backoffDelay(this.state.attempts - 1);
    this.timers.reconnect = setTimeout(() => {
      this.timers.reconnect = null;
      this.connect();
    }, delay);
    if (this.timers.reconnect.unref) this.timers.reconnect.unref();
  }

  /** 进程退出时收尾：别再挂着定时器 */
  destroy() {
    this.disconnect('');
    this.onState = () => {};
  }
}

// ---------------------------------------------------------------------------
// 纯函数助手（单测直接打）
// ---------------------------------------------------------------------------
function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const server = parseServer(cfg.url, Number(cfg.port) || DEFAULT_PORT);
  const roomId = String(cfg.roomId == null ? '' : cfg.roomId).trim();
  const nick = P.normNick(cfg.nick || '玩家');
  const peerId = /^[A-Za-z0-9_-]{4,40}$/.test(String(cfg.peerId || '')) ? String(cfg.peerId) : randomPeerId();
  const key = roomId ? roomKey(roomId, cfg.pass || '') : '';
  const enabled = !!cfg.enabled && !!server && !!key;
  return {
    enabled,
    server,
    roomId,
    roomKey: key,
    nick,
    peerId,
    pass: String(cfg.pass == null ? '' : cfg.pass),
    sharePos: cfg.sharePos !== false,
    shareAnno: cfg.shareAnno !== false,
    ver: cfg.ver || null,
  };
}

function randomPeerId() {
  const crypto = require('crypto');
  return `p${crypto.randomBytes(6).toString('hex')}`;
}

function sameTarget(a, b) {
  return (
    !!a.server &&
    !!b.server &&
    a.server.host === b.server.host &&
    a.server.port === b.server.port &&
    a.server.secure === b.server.secure &&
    a.roomKey === b.roomKey &&
    a.nick === b.nick &&
    a.peerId === b.peerId
  );
}

function pickPos(m) {
  return { map: m.map, x: m.x, y: m.y, z: m.z, hdg: m.hdg, ts: m.ts, trail: m.trail };
}

function normalizeAnnos(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [mapId, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const items = list
      .map((a) => sanitizeIncoming(a, a && a.owner))
      .filter(Boolean);
    if (items.length) out[mapId] = items;
  }
  return out;
}

function sanitizeIncoming(a, owner) {
  if (!a || typeof a !== 'object' || !P.KINDS.has(a.kind)) return null;
  const pts = Array.isArray(a.pts) ? a.pts.filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.z))) : [];
  if (pts.length < 2) return null;
  return {
    id: String(a.id || ''),
    kind: a.kind,
    color: /^#[0-9a-f]{6}$/i.test(String(a.color)) ? String(a.color).toLowerCase() : '#f87171',
    width: P.clampWidth(a.width),
    pts: pts.map((p) => ({ x: Number(p.x), z: Number(p.z) })),
    owner: String(owner || ''),
    at: Number.isFinite(Number(a.at)) ? Number(a.at) : 0,
  };
}

/** 收到一条标注广播：add 覆盖同 id，del 删掉 */
function applyAnno(annos, m) {
  const out = { ...annos };
  const mapId = String(m.map || '');
  if (!mapId) return annos;
  const list = Array.isArray(out[mapId]) ? [...out[mapId]] : [];
  const i = list.findIndex((a) => a.id === m.id);
  if (m.op === 'del') {
    if (i < 0) return annos;
    list.splice(i, 1);
  } else {
    const item = sanitizeIncoming(m, m.owner);
    if (!item) return annos;
    if (i >= 0) list[i] = item;
    else list.push(item);
  }
  if (list.length) out[mapId] = list;
  else delete out[mapId];
  return out;
}

function dropOwner(annos, owner) {
  const out = {};
  for (const [mapId, list] of Object.entries(annos)) {
    const keep = list.filter((a) => a.owner !== owner);
    if (keep.length) out[mapId] = keep;
  }
  return out;
}

function countAnnos(raw) {
  if (!raw || typeof raw !== 'object') return 0;
  return Object.values(raw).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}

module.exports = {
  RoomClient,
  parseServer,
  probeServer,
  backoffDelay,
  normalizeConfig,
  normalizeAnnos,
  applyAnno,
  dropOwner,
  randomPeerId,
  PROTO,
  DEFAULT_PORT,
  POS_MIN_INTERVAL_MS,
  MAX_BACKOFF_MS,
};
