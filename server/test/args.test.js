'use strict';

/**
 * 服务端命令行参数（Windows 单文件 exe / 裸跑都用它）。
 *
 * 重点：优先级是"命令行 > 环境变量 > 默认值"、数值要夹到合法区间、
 * 认不出来的参数一律忽略（Windows/SEA 会往 argv 里塞自己的东西，不能因此启动失败）。
 */
const test = require('node:test');
const assert = require('node:assert');

const { parseArgs, usageText, createRoomServer } = require('../server.js');

test('命令行：--key value 与 --key=value 两种写法都认', () => {
  assert.deepStrictEqual(parseArgs(['--port', '9000']).over, { port: 9000 });
  assert.deepStrictEqual(parseArgs(['--port=9000']).over, { port: 9000 });
  assert.deepStrictEqual(parseArgs(['--host', '127.0.0.1', '--log-level', 'debug']).over, { host: '127.0.0.1', logLevel: 'debug' });
  assert.deepStrictEqual(parseArgs(['--data-dir', 'D:\\room-annos']).over, { dataDir: 'D:\\room-annos' });
  assert.deepStrictEqual(parseArgs(['--max-annos-per-room=500']).over, { maxAnnosPerRoom: 500 });
});

test('命令行：--room-ttl 是秒，换算成内部的毫秒字段', () => {
  const p = parseArgs(['--room-ttl', '120']);
  assert.strictEqual(p.over.roomTtlMs, 120000);
  assert.strictEqual('roomTtlSec' in p.over, false, '不该把 sec 那个中间字段留给 loadConfig');
  assert.strictEqual(parseArgs(['--room-ttl', '0']).over.roomTtlMs, 0);
});

test('命令行：数值夹到合法区间，乱填回默认值', () => {
  assert.strictEqual(parseArgs(['--port', '99999']).over.port, 65535);
  // `--port -1`：负数被当成 flag（标准写法），所以不覆盖配置 -> 最终走默认 8787
  assert.strictEqual('port' in parseArgs(['--port', '-1']).over, false);
  // 显式 `--port=-1` 会走数值路径并夹到下限 0（0 = 让系统挑空闲端口）
  assert.strictEqual(parseArgs(['--port=-1']).over.port, 0);
  assert.strictEqual(parseArgs(['--port', '0']).over.port, 0, '0 = 让系统挑空闲端口（自检/测试要用）');
  assert.strictEqual(parseArgs(['--port', 'abc']).over.port, 8787);
  assert.strictEqual(parseArgs(['--max-room-peers', '1']).over.maxRoomPeers, 2);
  assert.strictEqual(parseArgs(['--max-room-peers', '9999']).over.maxRoomPeers, 256);
  assert.strictEqual(parseArgs(['--max-conn-per-ip', '0']).over.maxConnPerIp, 1);
  assert.strictEqual(parseArgs(['--pos-min-interval-ms', '99999']).over.posMinIntervalMs, 5000);
});

test('命令行：布尔开关支持 --x / --x=0 / --x=false', () => {
  assert.strictEqual(parseArgs(['--persist']).over.persist, true);
  assert.strictEqual(parseArgs(['--persist=1']).over.persist, true);
  assert.strictEqual(parseArgs(['--persist=0']).over.persist, false);
  assert.strictEqual(parseArgs(['--persist=false']).over.persist, false);
  assert.strictEqual(parseArgs(['--trust-proxy']).over.trustProxy, true);
  assert.strictEqual(parseArgs(['--public-status=off']).over.publicStatus, false);
});

test('命令行：--help / --version（含短写），并且不碰配置', () => {
  for (const f of [['--help'], ['-h']]) {
    const p = parseArgs(f);
    assert.strictEqual(p.help, true);
    assert.deepStrictEqual(p.over, {});
  }
  for (const f of [['--version'], ['-v']]) {
    const p = parseArgs(f);
    assert.strictEqual(p.version, true);
    assert.deepStrictEqual(p.over, {});
  }
  assert.match(usageText(), /--port/);
  assert.match(usageText(), /--persist/);
  assert.match(usageText(), /--data-dir/);
  assert.match(usageText(), /最多|优先级/);
});

test('命令行：认不出来的参数忽略并记下来（不能因此启动失败）', () => {
  const p = parseArgs(['--enable-logging', '--inspect=9229', '--port', '8888', '不是参数']);
  assert.deepStrictEqual(p.over, { port: 8888 });
  assert.deepStrictEqual(p.unknown, ['--enable-logging', '--inspect=9229']);
});

test('命令行：缺值的开关不会吃掉下一个 --flag', () => {
  const p = parseArgs(['--port', '--persist']);
  assert.strictEqual(p.over.persist, true);
  assert.strictEqual('port' in p.over, false);
  assert.deepStrictEqual(p.unknown, ['--port']);
  // 结尾缺值也不该抛
  assert.deepStrictEqual(parseArgs(['--port']).over, {});
});

test('命令行：解析结果直接喂 createRoomServer（端口 0 能真的起一个实例）', async () => {
  const { over } = parseArgs(['--port', '0', '--host', '127.0.0.1', '--log-level', 'error', '--max-room-peers', '4']);
  assert.strictEqual(over.port, 0);
  const srv = createRoomServer(over);
  assert.strictEqual(srv.cfg.port, 0, 'cfg 里保留 0（listen(0) 让系统挑端口）');
  assert.strictEqual(srv.cfg.maxRoomPeers, 4);
  const port = await new Promise((res) => srv.start(res));
  assert.ok(port > 0, `应该拿到真实端口，实际 ${port}`);
  await new Promise((res) => srv.close(res));
});
