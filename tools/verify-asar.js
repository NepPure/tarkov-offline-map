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
  // 无 SVG 的地图（实验室/迷宫/破冰船）的瓦片底图必须一起打进包，否则那三张图又变成"只有标记没有地面"
  ok(files.some((f) => f.startsWith('/data/tiles/') && f.endsWith('.png')), '清单含 data/tiles 瓦片底图（实验室/迷宫/破冰船）');
}

// ---- 2) 源码字符串 ----
const need = [
  // 1.3.x 的任务/标注/日志修复（回归）
  'QUEST_BOX', 'transitLabel', 'setMapNames', 'quest-dot', 'locationsByMap',
  'otherMapsWithLocation', 'quest-hint', 'openMissing', 'syncLastMap',
  // 2.0.0 房间联机
  'RoomClient', 'setPeers', 'setPeerAnnos', 'peer-mark', 'peer-trail',
  'room:test', 'room:anno', 'pushMyAnnosToRoom', 'syncAnnosToRoom', 'makeAnnoId',
  // 2.1：队友位置/轨迹/绘图三个图例分组 + 新局清队友残留（newraid/peer-reset）
  '队友位置', '队友轨迹', '队友绘图', 'peer:pos:', 'peer:trail:', 'peer:anno:', 'newraid', 'peer-reset',
  // 雷达上显示标注（三档）+ 定时自动截图（模拟截图键）
  'miniAnnos', 'set-mini-annos', 'autoShot', 'set-autoshot', 'AutoShotRunner', 'auto-shot', 'PrintScreen',
  // 椭圆工具（椭圆取代了老"圆心+半径"的圆）
  'ellipse', 'annoEllipseFromCorners', 'squareCorner',
  // 雷达出范围贴边方位指示
  'clampToRadar', 'data-off-range', 'peer-offrange-chevron',
  // 2.0.0 界面：改名 + 关于页
  '塔科夫地图', 'about-dialog', 'about-repo',
  // 2.0.1：状态提示行只说真话（由状态推导）+ 握手看门狗
  'roomHint', '已加入房间', 'handshakeTimeoutMs', 'roomHintManual',
  // 2.0.2：实验室/迷宫/破冰船的瓦片底图 + 设置页小地图开关真正开关窗口 + JSON 读取容错 BOM
  //        + 楼层改下拉框（#floor-select）
  'satelliteLayout', 'raster-base', 'app://data/tiles/', 'hasBasemap', 'applyMiniVisible', 'readJsonFile',
  'floor-select',
  // 2.1.1：战局提示音（匹配等待服务器 / 匹配到了 / 进图倒计时最后几秒）
  'raidAlert', 'BEEP_TONES', 'match-queue', 'match-found', 'MatchingCompleted', 'GameSpawned', 'GameStarting',
  'alertLeadSec', 'set-alert-lead',
  // 2.1.1：队友共享勾选任务（合并显示 + 「XX勾选的任务」图例 + 悬停看是谁勾的）
  'quest:peer:', 'peer-quests', 'sendQuests', 'shareQuests', 'set-room-quests', 'questsFingerprint',
  // 2.1.1：任务列表里能看出是谁勾的（我/队友角标）+「队友勾选」筛选 + 展开看具体是谁
  'qc-peer', 'peerQuestIndex', 'peerCheckedOnly', '队友勾选', 'qbadge mine', 'quest-owner',
  // 2.1.1：任务明细里的「进图要带」黄色高亮
  '进图要带', 'questBringList', 'quest-bring',
  // 2.1.1：设置页目录按钮
  'util:pick-folder', 'util:open-path', 'set-logs-pick',
];
for (const n of need) ok(has(n), `含 ${n}`);

const bad = [
  'QUEST_COLORS', 'questColor', "e.name || '转移点';",
  '<span class="tag">纯本地</span>', '塔科夫离线地图',
  // 2.0.2 改名：游戏叫「逃离塔科夫」，"塔可夫"是错别字，包里不许再出现
  '塔可夫',
  // 2.1.1：主窗口的"图钉化（缩小并置顶）"整个功能已删除，不许回潮
  'btn-pin', 'window:pin', 'togglePin', '图钉化',
];
for (const n of bad) ok(!has(n), `不应含 ${n}`);

const i = buf.indexOf(Buffer.from('"version"', 'utf8'));
if (i >= 0) console.log('package.json 片段: ' + JSON.stringify(buf.subarray(i, i + 32).toString('utf8')));
console.log(`asar 文件条目数: ${files.length}`);

console.log(fail === 0 ? '\nASAR-CHECK PASS' : `\nASAR-CHECK FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
