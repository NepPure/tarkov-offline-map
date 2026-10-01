'use strict';

/**
 * 游戏日志监听器：
 *  - 扫描 Logs 根目录下的 log_YYYY.MM.DD_HH-MM-SS_<ver> 会话目录
 *  - 跟踪"最新会话"，追加读取其 application_*.log
 *  - 分析行事件（地图切到哪个 raidCode）
 *  - 监听目录变化自动切换到新会话
 * 纯 Node 实现（无第三方依赖），回调风格。
 */
const fs = require('fs');
const path = require('path');
const { SESSION_DIR_RE } = require('./constants');
const { parseLogLine } = require('./parsers');

const POLL_INTERVAL = 700; // ms
const BACKFILL_BYTES = 2 * 1024 * 1024; // 启动时回补解析的字节数
const SYNC_SCAN_BYTES = 8 * 1024 * 1024; // 启动定位"当前地图"时最多回扫的字节数

class LogWatcher {
  /**
   * @param {string} root  Logs 根目录（如 ...\Escape from Tarkov\Logs）
   * @param {(event:object) => void} onEvent
   * @param {(info:object) => void} [onStatus]
   */
  constructor(root, onEvent, onStatus) {
    this.root = root;
    this.onEvent = onEvent;
    this.onStatus = onStatus || (() => {});
    this.currentDir = null; // 当前会话目录
    this.tails = new Map(); // 文件名 -> {pos, fd}
    this.buffers = new Map(); // 文件名 -> 残余半行
    this.timer = null;
    this.started = false;
    this.needSync = null; // 切换会话后需要回扫定位当前地图的目录
    this.sawMapEvent = false; // 回补窗口里是否已经解析出地图行
  }

  start() {
    if (this.timer) return;
    this.scan(false);
    this.timer = setInterval(() => this.scan(true), POLL_INTERVAL);
    this.started = true;
    this.onStatus({
      state: 'watching',
      root: this.root,
      session: this.currentDir ? this.currentDir.name : null,
      version: this.currentDir ? this.currentDir.version : null,
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [name, t] of this.tails) {
      try { fs.closeSync(t.fd); } catch {}
      this.tails.delete(name);
    }
    this.started = false;
  }

  setRoot(root) {
    this.stop();
    this.root = root;
    this.start();
  }

  /**
   * 找出所有会话目录，按时间戳降序。
   *
   * 两条路：
   *   - 名字能解析（log_YYYY.MM.DD_H-mm-ss_版本）：用名字里的时间（原来的那条路）
   *   - 名字解析不出来（游戏再改命名格式）：只要目录里有 application_*.log 就当会话，
   *     用这些日志里最新的 mtime 排序 —— 游戏正在写的那个文件 mtime 一直跟着"现在"走，
   *     所以哪怕 BSG 下次又换格式，也不会再出现"进图不切图"（这次踩的就是这种坑）
   */
  sessionDirs() {
    if (!this.root || !fs.existsSync(this.root)) return [];
    const out = [];
    for (const name of fs.readdirSync(this.root)) {
      const full = path.join(this.root, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      const m = name.match(SESSION_DIR_RE);
      if (m) {
        // 规范时间戳: 2026.09.07_23-03-04 -> UTC（名字里写的是本机本地时间，这里按"本地时间当 UTC"统一）
        const [y, mo, d, h, mi, se] = m[1].split(/[._-]/).map(Number);
        out.push({
          name,
          full,
          version: m[2],
          timestamp: Date.UTC(y, mo - 1, d, h, mi, se),
        });
        continue;
      }
      const ts = fallbackSessionTs(full);
      if (ts != null) out.push({ name, full, version: null, timestamp: ts });
    }
    out.sort((a, b) => b.timestamp - a.timestamp || b.name.localeCompare(a.name));
    return out;
  }

  scan(fileChanged) {
    const dirs = this.sessionDirs();
    if (dirs.length === 0) {
      if (this.currentDir) {
        // 会话目录被清掉（游戏清理日志）：顺手关掉尾巴，别攥着已删除文件的句柄
        this.closeTails();
        this.currentDir = null;
        this.needSync = null;
        this.onStatus({ state: 'no-session', root: this.root });
      }
      return;
    }
    const latest = dirs[0];
    if (!this.currentDir || this.currentDir.full !== latest.full) {
      // 切换会话：关闭旧尾巴，打开最新会话（回补最近 2MB 历史）
      this.closeTails();
      this.currentDir = latest;
      this.openSession(latest, true);
      this.needSync = latest.full;
      this.sawMapEvent = false;
      this.onStatus({ state: 'watching', root: this.root, session: latest.name, version: latest.version });
    }
    // 会话目录先建、application_*.log 晚几百毫秒才建（实测：20:33:06.788 建目录，
    // 20:33:07.683 才建 application_000.log，而 700ms 轮询在 20:33:07.020 就看到了目录）。
    // openSession 只在"切换会话"那一次调用，扑空的话这个会话就永远没有尾巴 ——
    // 表现就是"进了图却不切图、定位也不动"。所以每次轮询都把新出现的日志文件补开。
    this.openMissing(this.currentDir);
    this.readTails(fileChanged);
    // 回补窗口里没解析出任何地图行时才做回扫：
    // 窗口是文件尾部，只要窗口里有一条地图行，那它必然就是最后一条，不需要再扫。
    if (this.needSync && !this.sawMapEvent) {
      const dir = this.needSync;
      this.needSync = null;
      this.syncLastMap(dir);
    } else if (this.needSync) {
      this.needSync = null;
    }
  }

  openSession(dir, backfill) {
    if (!fs.existsSync(dir.full)) return;
    const files = fs
      .readdirSync(dir.full)
      .filter((n) => / application_\d+\.log$/i.test(n))
      .sort((a, b) => a.localeCompare(b));
    for (const name of files) {
      const full = path.join(dir.full, name);
      let pos = 0;
      if (backfill) {
        try {
          const size = fs.statSync(full).size;
          pos = Math.max(0, size - BACKFILL_BYTES);
        } catch {}
      }
      try {
        const fd = fs.openSync(full, 'r');
        this.tails.set(name, { full, fd, pos });
        this.buffers.set(name, '');
      } catch (e) {
        this.onStatus({ state: 'error', message: `open ${full}: ${e.message}` });
      }
    }
  }

  /**
   * 补开会话目录里"后出现"的 application_*.log。
   * @param {object|null} dir 当前会话目录
   * @returns {boolean} 是否补开了新文件
   */
  openMissing(dir) {
    if (!dir) return false;
    let files;
    try {
      files = fs.readdirSync(dir.full).filter((n) => / application_\d+\.log$/i.test(n));
    } catch {
      return false;
    }
    let added = false;
    for (const name of files) {
      if (this.tails.has(name)) continue;
      const full = path.join(dir.full, name);
      // 从**末尾**开始跟：这个文件是"刚出现"的，里面的历史进图行不该再重放一遍
      // （重放会把地图抢回上一张图，还会和界面联动成死循环）。
      // 当前在哪张图交给 syncLastMap 只报"最后一条地图行"。
      let pos = 0;
      try {
        pos = fs.statSync(full).size;
      } catch {}
      try {
        const fd = fs.openSync(full, 'r');
        this.tails.set(name, { full, fd, pos });
        this.buffers.set(name, '');
        added = true;
      } catch (e) {
        this.onStatus({ state: 'error', message: `open ${full}: ${e.message}` });
      }
    }
    if (added) {
      // 补开的文件里可能已经有进图行了（轮到这次轮询时文件已经写了一截）：回扫兜底
      this.needSync = dir.full;
      this.sawMapEvent = false;
    }
    return added;
  }

  closeTails() {
    for (const [name, t] of this.tails) {
      try { fs.closeSync(t.fd); } catch {}
      this.tails.delete(name);
    }
    this.buffers.clear();
  }

  /**
   * 回扫会话日志，找出"最后一处能确定地图的日志行"并抛出对应事件。
   * 用于：应用在局内才启动、或会话很长导致进图行掉出回补窗口时，仍能立刻切到正确的图。
   * @param {string} dirFull 会话目录绝对路径
   */
  syncLastMap(dirFull) {
    let files;
    try {
      files = fs.readdirSync(dirFull).filter((n) => / application_\d+\.log$/i.test(n));
    } catch {
      return;
    }
    let best = null;
    for (const name of files) {
      const full = path.join(dirFull, name);
      let size;
      try { size = fs.statSync(full).size; } catch { continue; }
      const from = Math.max(0, size - SYNC_SCAN_BYTES);
      let buf;
      try {
        const fd = fs.openSync(full, 'r');
        buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        fs.closeSync(fd);
      } catch {
        continue;
      }
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const ev = parseLogLine(lines[i]);
        if (!ev) continue;
        if (ev.type !== 'scene-preset' && ev.type !== 'network-game-create') continue;
        if (ev.raidCode && (!best || (ev.ts || 0) >= (best.ts || 0))) best = ev;
        break; // 每个文件只看最后一条地图行
      }
    }
    if (best) this.onEvent(best);
  }

  readTails(fileChanged) {
    for (const [name, t] of this.tails) {
      let st;
      try { st = fs.statSync(t.full); } catch { continue; }
      if (st.size < t.pos) {
        // 文件被截断/轮转
        t.pos = 0;
        this.buffers.set(name, '');
      }
      if (st.size <= t.pos) continue;
      const readLen = Math.min(st.size - t.pos, 512 * 1024);
      const buf = Buffer.alloc(readLen);
      const n = fs.readSync(t.fd, buf, 0, readLen, t.pos);
      if (n <= 0) continue;
      t.pos += n;
      let text = this.buffers.get(name) + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      text = lines.pop();
      this.buffers.set(name, text);
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = parseLogLine(line);
        if (!ev) continue;
        // 认不出来的地图在这里报上去（只会写进诊断日志），下次遇到新版本改名的图能直接看到
        if (ev.type === 'scene-preset' && !ev.raidCode) {
          this.onStatus({ state: 'unknown-map', bundle: ev.bundle, rcid: ev.rcid, sample: line.trim().slice(0, 200) });
        }
        if ((ev.type === 'scene-preset' || ev.type === 'network-game-create') && ev.raidCode) {
          this.sawMapEvent = true;
        }
        this.onEvent(ev);
      }
    }
  }
}

/**
 * 目录名解析不出来的兜底：里面有 application_*.log 才算会话，
 * 返回这些文件里最新的 mtime（换算成与"名字时间戳"同一套刻度：本地时间当 UTC，两者才能一起排序）。
 * 一个都没有 / 目录读不了 -> null（不是会话目录）。
 * @param {string} dirFull 目录绝对路径
 * @returns {number|null}
 */
function fallbackSessionTs(dirFull) {
  try {
    const files = fs.readdirSync(dirFull).filter((n) => / application_\d+\.log$/i.test(n));
    if (!files.length) return null;
    let newest = 0;
    for (const f of files) {
      try { newest = Math.max(newest, fs.statSync(path.join(dirFull, f)).mtimeMs); } catch {}
    }
    if (!newest) return null;
    const d = new Date(newest);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  } catch {
    return null;
  }
}

module.exports = { LogWatcher, fallbackSessionTs };
