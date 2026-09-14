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

  /** 找出所有会话目录，按时间戳降序 */
  sessionDirs() {
    if (!this.root || !fs.existsSync(this.root)) return [];
    const out = [];
    for (const name of fs.readdirSync(this.root)) {
      const m = name.match(SESSION_DIR_RE);
      if (!m) continue;
      const full = path.join(this.root, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      // 规范时间戳: 2026.09.07_23-03-04 -> UTC
      const [y, mo, d, h, mi, se] = m[1].split(/[._-]/).map(Number);
      out.push({
        name,
        full,
        version: m[2],
        timestamp: Date.UTC(y, mo - 1, d, h, mi, se),
      });
    }
    out.sort((a, b) => b.timestamp - a.timestamp || b.name.localeCompare(a.name));
    return out;
  }

  scan(fileChanged) {
    const dirs = this.sessionDirs();
    if (dirs.length === 0) {
      if (this.currentDir) {
        this.currentDir = null;
        this.onStatus({ state: 'no-session', root: this.root });
      }
      return;
    }
    const latest = dirs[0];
    if (!this.currentDir || this.currentDir.full !== latest.full) {
      // 切换会话：关闭旧尾巴，打开最新会话（回补最近 128KB 历史）
      this.closeTails();
      this.currentDir = latest;
      this.openSession(latest, true);
      this.onStatus({ state: 'watching', root: this.root, session: latest.name, version: latest.version });
    }
    this.readTails(fileChanged);
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
          pos = Math.max(0, size - 128 * 1024);
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

  closeTails() {
    for (const [name, t] of this.tails) {
      try { fs.closeSync(t.fd); } catch {}
      this.tails.delete(name);
    }
    this.buffers.clear();
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
        if (ev) this.onEvent(ev);
      }
    }
  }
}

module.exports = { LogWatcher };
