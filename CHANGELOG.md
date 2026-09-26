# 更新日志

本项目的每个版本都打语义化 tag（`v2.2.0`），Release 页面上有对应版本的说明与下载：
<https://github.com/NepPure/tarkov-offline-map/releases>

这个文件由开发者按**提交记录**手工整理（每个提交的正文里本来就写清了"改了什么、为什么、怎么验"）。
想按提交记录草拟一份（例如准备下次发布时）：

```bash
npm run changelog                                  # 上一 tag..HEAD，直接打到屏幕
npm run changelog -- --from v2.1.0 --to HEAD       # 指定区间
```

---

## [2.2.0] — 2026-09-26

### 新功能

- **战局提示音**：只在三个时刻响——开始匹配（日志 `Matching with group id`，在等服务器）、
  匹配到了（`MatchingCompleted`）、**进图倒计时的最后几秒**（倒计时从 `GameSpawned` 开始、
  `GameStarting` 结束，实测 10.3s，4 局一致）。三种音色可分辨；"最后几秒"可在设置里调 1~10 秒
  （默认 3）。**截图定位、队友定位、换图一律不响**（这些是常态高频事件）。启动时回补的历史日志
  （>30s）不会补响一串；`app.log` 里有 `[alert] 响铃 …` 行可对时间。
- **队友共享勾选任务**：勾选的任务会同步给同房间的队友，队友图上会画出你勾的任务；
  **同一个任务两人都勾了只画一次**（合并显示），鼠标悬停能看到"是谁勾的"。
  右侧图例的「任务标记」组里每人一行 **「XX勾选的任务」**，关掉只隐藏"只被他勾"的任务。
- **任务面板的队友勾选**：新增筛选 chip **「队友勾选」**（与「已勾选」是**交集**语义：
  两个都开 = 只看我和队友都勾了的）；任务行上有 **`我`** / 队友昵称角标，
  展开明细第一行写「谁勾选：你 + 阿甘」，底部统计行显示"队友勾选 N"。
- **「进图要带」黄色高亮**：任务展开后最上面一块列出**钥匙**（同组多把按"或"显示）与
  **要带进图放置/使用的任务物品**（带数量）；折叠状态的任务行上有 `🔑带N` / `📦带N` 角标。
  `findItem`（进图去捡）与 `giveItem`（任务界面交）刻意不列，免得清单变长还误导。
- **设置页目录按钮**：游戏日志目录 / 截图目录各加「选择文件夹…」与「打开文件夹」按钮
  （选目录只填进输入框，点「保存」才落盘、才重启监听）。

### 修复

- **雷达上的字不再整体消失**：上限裁剪与"给谁写名字"改为按"重要度 + 离圆心距离"挑，
  修掉旧逻辑"关键标记超过 6 个就一个名字都不写"、"密集区第一刀丢掉全部地名"导致的
  字整体消失/来回跳。
- **雷达画勾选的任务点**，并同步主窗口的地图中文名字典、表层标记开关与任务区域透明度
  （任务图形按圆盘裁剪，避免小窗堆 DOM）。
- **提示音不会再被反复重带**：`raidAlert` 改为"广播后即清"的事件语义
  （此前它留在状态里，后续每条推送都带一遍，窗口重载时可能补响一次）。
- **图例「XX勾选的任务」的计数**改为只算"真的会画出来"的任务，跟着开关变化
  （此前关掉后数字不变，违反"图例必须反映地图上画了什么"的约束）。
- 灯塔 5 个上游缺漏的撤离点（含**通往军事基地的载具撤离点**）以人工补录 overlay 的形式补齐
  （`data/manual-extracts.json`，上游数据补齐后会自动跳过）。
- 定位精度回归：确认链路上没有任何取整（解析保留全部小数、投影往返 <1e-9m、1cm 不量化）。

### 变更 / 移除

- **移除主窗口的「图钉化（置顶）」功能**：按需求主界面不再置顶，顶栏按钮、渲染层接线、
  `window:pin` IPC 与 `preload.togglePin` 一并删除；悬浮雷达的置顶保留（那是它能显示在游戏上的前提），
  并加了 4 条"不许回来"的回归断言。

### 文档与验收

- README / server README 同步：提示音的三个日志锚点与实测时间线、"哪些不响"、
  共享勾选的合并规则与图例项、进图要带、目录按钮；验收清单与计数一并更新。
- 新增三个**自起隔离实例**的端到端验收（不碰真实配置）：
  `tools/verify-raid-alerts.js`（11 项，往假日志里追加真实格式日志行）、
  `tools/verify-quest-share.js`（24 项，真服务端 + 假队友）、`tools/verify-mini-quest.js`（10 项）。
- 回归：客户端单测 188 项、服务端 47 项；`verify-quests` 41、`verify-room` 62、`verify-raster` 28、
  `verify-mini-anno` 8、`verify-raid-reset` 11、`verify-about` 15、`verify-autoshot` 15（干跑）、
  `npm run visual-test`（renderer errors: NONE）。

## [2.1.0] — 2026-09-22

- **定时自动截图**（默认关）：按设定间隔替你按一次游戏截图键，只在局内且游戏窗口在最前时按，
  连续 3 次没拿到新坐标自动暂停并说明原因；键名可配置（`PrintScreen` / `F12` / `KeyP`…）。
- **顶栏常驻标注工具条 + 「取消」**：进标注不用再翻设置；**椭圆**取代旧"圆心+半径"的圆
  （从一个角拖到对角，Shift = 正圆）。
- **队友内容拆成三组图例**（位置 / 轨迹 / 绘图，每人一行可单独关），**新一局自动清掉队友残留位置**。
- **雷达上显示标注**（三档：不显示 / 只显示我的 / 我的 + 队友的）。
- **服务端 Windows 单文件 exe**（Node SEA）与 ghcr 镜像；雷达出范围时按方位贴到圆边。
- 定位精度回归测试；`fixed` 位置的滚动条美化等。

## [2.0.2] — 2026-09-20

- 实验室 / 迷宫 / 破冰船的**瓦片底图**（无 SVG 的图也能看地面）+ 楼层改下拉框
  （破冰船 16 层甲板）。
- 状态提示行只说真话（由真实状态推导）、握手超时看门狗、窗口重载也带房间快照。
- 品牌名统一为「塔科夫地图」；JSON 读取容错 BOM。

## [2.0.1] — 2026-09-20

- 修复并加固联机体验：设置页勾选"启用房间"后不连接、IPv6 地址解析、身份被换掉、
  队友换图后旧点不消失、离线画完立刻进房漏同步那一笔。

## [2.0.0] — 2026-09-20

- **房间联机**（可选、默认关）：和队友互看位置、轨迹与手绘标注，按人按类开关；
  自带极轻量服务端（单进程、纯内存，`PERSIST=1` 才落盘）。
- 标题去掉"离线"、新增关于页面；发布前闸门 `tools/preflight.js`。

## 历史版本（v1.x）

从"离线地图 + 截图定位"起步，逐步加上日志自动识图、手动标注、任务侧边栏、赛季文件刷点等内容。
逐版说明见各自的 [Release](https://github.com/NepPure/tarkov-offline-map/releases)：

| 版本 | 日期 | 一句话 |
|---|---|---|
| [v1.3.1](https://github.com/NepPure/tarkov-offline-map/releases/tag/v1.3.1) | 2026-09-19 | 1.3 系列收尾修复 |
| [v1.3.0](https://github.com/NepPure/tarkov-offline-map/releases/tag/v1.3.0) | 2026-09-19 | 赛季文件刷点与位置参考截图 |
| [v1.2.5](https://github.com/NepPure/tarkov-offline-map/releases/tag/v1.2.5) | 2026-09-18 | 修复与体验打磨 |
| [v1.2.4](https://github.com/NepPure/tarkov-offline-map/releases/tag/v1.2.4) | 2026-09-18 | 悬浮小地图加固（透明窗口被系统吞掉/停止重绘） |
| [v1.2.3](https://github.com/NepPure/tarkov-offline-map/releases/tag/v1.2.3) | 2026-09-16 | 任务侧边栏与地图标记 |
| [v1.2.2](https://github.com/NepPure/tarkov-offline-map/releases/tag/v1.2.2) | 2026-09-15 | 修复 |
| [v1.2.1](https://github.com/NepPure/tarkov-offline-map/releases/tag/v1.2.1) | 2026-09-15 | 修复 |
| [v1.2.0](https://github.com/NepPure/tarkov-offline-map/releases/tag/v1.2.0) | 2026-09-14 | 首个公开版本：离线地图数据 + 截图定位 + 日志自动识图 |

[2.2.0]: https://github.com/NepPure/tarkov-offline-map/releases/tag/v2.2.0
[2.1.0]: https://github.com/NepPure/tarkov-offline-map/releases/tag/v2.1.0
[2.0.2]: https://github.com/NepPure/tarkov-offline-map/releases/tag/v2.0.2
[2.0.1]: https://github.com/NepPure/tarkov-offline-map/releases/tag/v2.0.1
[2.0.0]: https://github.com/NepPure/tarkov-offline-map/releases/tag/v2.0.0
