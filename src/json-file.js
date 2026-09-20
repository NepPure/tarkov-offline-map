'use strict';

/**
 * 读 JSON 文件时容错掉 UTF-8 BOM。
 *
 * 为什么需要：用记事本、或 PowerShell 5.1 的 `Set-Content -Encoding UTF8`，打开再保存一份
 * settings.json / annotations.json，文件头会多出 EF BB BF。Node 用 'utf-8' 读文件**不会**
 * 帮你去掉它，于是 JSON.parse 直接抛；而两个调用方都是 try/catch 兜底 ——
 * 结果不是报错，而是**静默**当成空文件：设置全回落默认值、自己画的标注整份消失。
 */
const fs = require('fs');

/** 读文件 -> 去掉开头的 BOM -> JSON.parse */
function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
}

module.exports = { readJsonFile };
