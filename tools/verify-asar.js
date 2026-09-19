// 校验打包产物里的 app.asar 是否真的含目标版本的代码
//   node test-artifacts/check-release-asar.mjs <app.asar 路径>
//
// 分成两类检查：
//   1) 文件清单（用 @electron/asar 列目录）—— 共用的协议文件、ws 依赖、服务端本体不能进包
//   2) 源码字符串（直接搜 asar 字节）—— 功能代码在不在
// 注意：注释里的词也会被搜到（比如解释历史的"纯本地"），所以负面清单只查**用户可见**的形态。
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const p = process.argv[2];
const buf = fs.readFileSync(p);
const has = (s) => buf.includes(Buffer.from(s, 'utf8'));

let fail = 0;
const ok = (cond, label) => {
  if (!cond) fail++;
  console.log(`${cond ? 'OK  ' : (label.startsWith('不应含') ? 'BAD ' : 'MISS')}  ${label}`);
};

// ---- 1) 文件清单 ----
let files = [];
try {
  const asar = require('@electron/asar');
  files = asar.listPackage(p).map((f) => f.replace(/\\/g, '/'));
} catch (e) {
  console.log(`WARN  @electron/asar 不可用（${e.message}），跳过清单检查`);
}
const hasFile = (suffix) => files.some((f) => f === suffix || f.endsWith(`/${suffix}`));
if (files.length) {
  ok(hasFile('server/protocol.js'), '清单含 server/protocol.js（客户端与服务端共用的协议定义）');
  ok(hasFile('node_modules/ws/package.json'), '清单含 node_modules/ws（Electron 主进程没有全局 WebSocket）');
  ok(files.some((f) => f.startsWith('/src/') && f.endsWith('room-client.js')), '清单含 src/room-client.js');
  ok(files.some((f) => f.endsWith('renderer/common/room.js')), '清单含 renderer/common/room.js');
  ok(!hasFile('server/server.js'), '不应含 server/server.js（服务端本体不该进客户端安装包）');
  ok(!hasFile('server/Dockerfile'), '不应含 server/Dockerfile');
}

// ---- 2) 源码字符串 ----
const need = [
  // 1.3.x 的任务/标注/日志修复（回归）
  'QUEST_BOX', 'transitLabel', 'setMapNames', 'quest-dot', 'locationsByMap',
  'otherMapsWithLocation', 'quest-hint', 'openMissing', 'syncLastMap',
  // 2.0.0 房间联机
  'RoomClient', 'setPeers', 'setPeerAnnos', 'peer-mark', 'peer-trail', '房间成员',
  'room:test', 'room:anno', 'pushAnnotations', 'syncAnnosToRoom', 'makeAnnoId',
  // 雷达出范围贴边方位指示
  'clampToRadar', 'data-off-range', 'peer-offrange-chevron',
  // 2.0.0 界面：改名 + 关于页
  '塔可夫地图', 'about-dialog', 'about-repo',
];
for (const n of need) ok(has(n), `含 ${n}`);

const bad = [
  'QUEST_COLORS', 'questColor', "e.name || '转移点';",
  '<span class="tag">纯本地</span>', '塔可夫离线地图',
];
for (const n of bad) ok(!has(n), `不应含 ${n}`);

const i = buf.indexOf(Buffer.from('"version"', 'utf8'));
if (i >= 0) console.log('package.json 片段: ' + JSON.stringify(buf.subarray(i, i + 32).toString('utf8')));
console.log(`asar 文件条目数: ${files.length}`);

console.log(fail === 0 ? '\nASAR-CHECK PASS' : `\nASAR-CHECK FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
