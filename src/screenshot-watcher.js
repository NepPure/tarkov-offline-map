'use strict';

/**
 * 截图目录监听器（沿用原客户端思路：fs.watch + 文件名解析）
 * 新截图（文件名携带位置/朝向）→ onPosition({x,y,z,quaternion,file,at})
 */
const fs = require('fs');
const path = require('path');
const { parseScreenshotFilename } = require('./parsers');

class ScreenshotWatcher {
  /**
   * @param {string} dir 截图目录（默认 文档\Escape from Tarkov\Screenshots）
   * @param {(pos) => void} onPosition
   * @param {(info) => void} [onStatus]
   */
  constructor(dir, onPosition, onStatus) {
    this.dir = dir;
    this.onPosition = onPosition;
    this.onStatus = onStatus || (() => {});
    this.seen = new Map(); // name -> {size, mtimeMs}
    this.watcher = null;
    this.rescanTimer = null;
  }

  start() {
    if (!this.dir && !fs.existsSync(this.dir)) {
      this.onStatus({ state: 'missing', dir: this.dir });
      return;
    }
    this.rescan(true);
    try {
      this.watcher = fs.watch(this.dir, (event, filename) => {
        if (!filename) return;
        // 部分环境 rename/change 事件不稳定，节流 + 延迟再确认
        if (this.rescanTimer) clearTimeout(this.rescanTimer);
        this.rescanTimer = setTimeout(() => this.rescan(false), 80);
      });
      this.onStatus({ state: 'watching', dir: this.dir });
    } catch (e) {
      // FS 事件不可用时退化为轮询
      this.onStatus({ state: 'polling', dir: this.dir, error: e.message });
      this.rescanTimer = setInterval(() => this.rescan(true), 1000);
    }
  }

  stop() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.rescanTimer) { clearInterval(this.rescanTimer); this.rescanTimer = null; }
  }

  setDir(dir) {
    this.stop();
    this.dir = dir;
    this.seen.clear();
    this.start();
  }

  rescan(initial) {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.png')) continue;
      const full = path.join(this.dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const prev = this.seen.get(name);
      const sig = `${st.size}:${st.mtimeMs}`;
      if (prev && prev === sig) continue;
      this.seen.set(name, sig);
      const parsed = parseScreenshotFilename(name);
      if (!parsed) continue;
      if (!initial) this.onPosition({ ...parsed, at: Date.now() });
    }
  }

  /** 手动导入一张截图（最近一次） */
  latest() {
    let names;
    try { names = fs.readdirSync(this.dir); } catch { return null; }
    const pngs = names.filter((n) => n.toLowerCase().endsWith('.png')).sort();
    for (let i = pngs.length - 1; i >= 0; i--) {
      const parsed = parseScreenshotFilename(pngs[i]);
      if (parsed) return parsed;
    }
    return null;
  }
}

module.exports = { ScreenshotWatcher };
