'use strict';

/**
 * JSON 文件读取的 BOM 容错。
 *
 * 回归背景：用 PowerShell 5.1 的 `Set-Content -Encoding UTF8`（或旧版记事本）写一份
 * settings.json，文件头会带 EF BB BF；Node 用 'utf-8' 读出来是 "\uFEFF{...}"，
 * JSON.parse 直接抛，而调用方是 try/catch 兜底 —— 于是"不是报错，是被静默当成空文件"：
 * 设置全回落默认值、自己画的标注整份消失。这条就是踩到之后补的。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readJsonFile } = require('../src/json-file');

// 每个测试文件一个临时目录，跑完删掉（别在 %TEMP% 里留一地 takov-* 目录）
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'takov-json-'));
test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

function tmpFile(name, content) {
  const file = path.join(DIR, name);
  fs.writeFileSync(file, content);
  return file;
}

test('readJsonFile：带 UTF-8 BOM 的文件也能正常解析', () => {
  const file = tmpFile('bom.json', `\uFEFF${JSON.stringify({ miniVisible: true, n: 1 })}`);
  assert.deepStrictEqual(readJsonFile(file), { miniVisible: true, n: 1 });
});

test('readJsonFile：不带 BOM / 带空白的文件照旧', () => {
  assert.deepStrictEqual(readJsonFile(tmpFile('plain.json', '{"a":1}')), { a: 1 });
  assert.deepStrictEqual(readJsonFile(tmpFile('ws.json', '\n  {"a":2}\n')), { a: 2 });
});

test('readJsonFile：真的坏文件还是要抛（不能把错误吞掉）', () => {
  assert.throws(() => readJsonFile(tmpFile('bad.json', '\uFEFF{not json')));
});

test('标注存储：带 BOM 的 annotations.json 不会把画好的标注读丢', () => {
  const ann = require('../src/annotations');
  const strokes = {
    customs: [
      { kind: 'pen', color: '#f87171', width: 4, pts: [{ x: 1, z: 2 }, { x: 3, z: 4 }] },
    ],
  };
  const file = tmpFile('annotations.json', `\uFEFF${JSON.stringify(strokes)}`);
  const loaded = ann.load(file);
  assert.deepStrictEqual(Object.keys(loaded), ['customs'], 'BOM 不该让标注整份消失');
  assert.strictEqual(loaded.customs.length, 1);
  assert.strictEqual(loaded.customs[0].kind, 'pen');
});
