'use strict';

/**
 * 房间号的推导（纯函数，客户端和服务端各有一份实现）。
 *
 * 用户只填"房间号 + 可选口令"，两者拼起来取 sha256 的前 32 位十六进制作为房间标识：
 *   - 服务端只见到这个哈希，见不到房间号明文，日志里也只打印前 6 位；
 *   - 没有房间列表可以枚举（除非猜到房间号），也不需要账号体系。
 *
 * 服务端那份在 server/protocol.js 里，两份必须一致：
 * server/test/protocol.test.js 会交叉校验，谁改了算法都会红。
 */
const crypto = require('crypto');

const ROOM_KEY_RE = /^[0-9a-f]{16,64}$/;
const NICK_MAX = 16;

/** 房间号 + 口令 -> 房间标识（空房间号返回空串，调用方据此判定"没填"） */
function roomKey(roomId, pass = '') {
  const id = String(roomId == null ? '' : roomId).trim();
  if (!id) return '';
  return crypto
    .createHash('sha256')
    .update(id + '\u0000' + String(pass == null ? '' : pass), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/** 校验一个"房间标识"是否合法（服务端收到客户端上报时用） */
function isRoomKey(v) {
  return typeof v === 'string' && ROOM_KEY_RE.test(v);
}

module.exports = { roomKey, isRoomKey, ROOM_KEY_RE, NICK_MAX };
