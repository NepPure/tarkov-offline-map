# 塔科夫离线实时地图 (tarkov-offline-map)

[![Build & Release (Windows)](https://github.com/NepPure/tarkov-offline-map/actions/workflows/build.yml/badge.svg)](https://github.com/NepPure/tarkov-offline-map/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/NepPure/tarkov-offline-map)](https://github.com/NepPure/tarkov-offline-map/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

纯本地的《逃离塔科夫》实时地图辅助工具：
**监听游戏日志自动识别当前地图 + 监听截图目录自动定位玩家 + 悬浮小地图**。
启动和运行完全不依赖任何服务器（无网络请求、无遥测）。

## 下载（Windows 免安装）

到 [Releases](https://github.com/NepPure/tarkov-offline-map/releases/latest) 下载
`塔可夫离线地图-<版本>.exe`（portable 单文件，双击即用，约 145MB，内含离线地图数据与赛季文件参考截图），
校验值见同页 `SHA256SUMS.txt`。

- 未做代码签名：SmartScreen 提示"未知发布者"时选择"仍要运行"
- 游戏需使用**无边框/窗口化**模式，悬浮小地图 / 图钉化地图才能显示在游戏画面之上
- 打 tag（`v1.2.0` 这种）或手动触发 Actions 会自动构建并发布新的 Release

## 原理

1. **自动识图**：塔科夫每次进局会在 `文档\Escape from Tarkov\Logs\log_<时间>_<版本>\` 写入
   `application_*.log`。日志中的
   - `scene preset path:maps/<bundle>_preset.bundle`（进图加载）
   - `Location: <raidCode>`（NetworkGameCreate，进局时刻）
   即可确定 raidCode → 地图。监听器持续追加读取最新会话日志，自动切换地图。

2. **截图定位**：游戏中按 `Print Screen`，截图文件名携带玩家坐标与朝向：
   `2026-09-07[23-05]_58.02, 1.75, 49.47_0.01518, 0.90924, -0.03197, 0.41476_15.47 (0).png`
   → 世界坐标 `(x=58.02, y=1.75 高度, z=49.47)` + 朝向四元数。
   监听截图目录新增文件即在地图上标记玩家位置 + 朝向扇形 + 走过的轨迹。

全部地图数据为**中文**（地图/撤离点/Boss/钥匙/物资/地名等），一次快照后完全离线。
右侧"标记点"图例面板可按类型配置图钉显示（PMC/Scav 撤离点、转移点、各类物资箱、
Boss、出生点、散落物资、BTR 站点、**赛季文件刷点**、地名…），与"高级设置"（定位自动缩放/居中、
表层显示全部标记、自动切换图层、声音提示、自动删除截图文件、小地图雷达参数等）均持久化到本地设置文件。

3. **赛季文件刷点（版本活动找东西）**：每个赛季有 8 类"赛季文件"（PMC 人员档案 / 医疗 / 财务 /
   员工 / 技术 / 蓝图 / 测试 / 项目文件）在各图固定刷点，社区提交 + 官方审核后公开。
   快照工具按地图抓取已审核通过的刷点（含参考坐标与类型元数据），地图上以**物品图标 + 中文名药丸 +
   类型色圆底**标出，图例里按文件类型分别开关，点击标记给出中文说明与坐标。
   每个刷点还附带社区提交的**位置参考截图（419 张原图，webp，约 73MB）**：点标记后卡片内嵌缩略图，
   再点一下弹出大图查看器（滚轮缩放 / 拖动平移 / 双击复位 / Esc 关闭），离线也能一眼看到文件长什么样、
   在哪个角落。

3. **坐标→像素**（与原站投影数学一致）：

   ```js
   transform = [0.239, 168.65, 0.239, 136.35]   // 以 Customs 为例
   像素x = rotate(x, z, coordinateRotation).x * transform[0] + transform[1]
   像素y = rotate(x, z, coordinateRotation).y * -transform[2] + transform[3]
   ```

4. **楼层判定**：`z`(高度) 落在各楼层 `layers[].extents[].height` 区间且位于该层区域矩形内 → 自动切层
   （SVG 底图按 `data-layer` 分组：Ground_Level / First_Floor / Second_Floor / ...）。

## 目录结构

```
tarkov-offline-map/
├─ main.js                   Electron 主进程（窗口 + 日志/截图监听 + 状态广播 + app:// 协议）
├─ preload.js                contextBridge API
├─ src/
│  ├─ constants.js           bundle→raidCode→地图 映射表、正则
│  ├─ maps-data.js           data/maps-dump.json 加载与查询
│  ├─ projection.js          投影/四元数/朝向（复刻原站公式）
│  ├─ parsers.js             截图文件名 & 日志行解析
│  ├─ log-watcher.js         日志目录监听（新会话切换 + 追加读 + 启动回补）
│  └─ screenshot-watcher.js  截图目录监听
├─ renderer/
│  ├─ common/map-view.js     地图渲染引擎（SVG 底图/楼层/标记/玩家/轨迹/平移缩放）
│  ├─ map.html|css|js        主地图窗口
│  └─ minimap.html|js        圆形小地图悬浮窗
├─ data/
│  ├─ maps-dump.json         15 张地图完整配置（投影/楼层/撤离点/boss/物资/BTR…）
│  ├─ maps/*.svg             各图 SVG 底图（内含全部楼层 data-layer）
│  ├─ season-documents.json  赛季文件刷点（419 个点 / 14 张图 / 8 类文件，含中文元数据与参考截图路径）
│  ├─ season-images/         位置参考截图原图（419 张 webp，约 73MB，离线可看）
│  └─ icons/                 标记图标 + season_<类型>.webp 赛季文件图标
├─ tools/
│  ├─ fetch-all.js           数据快照脚本（重新拉取地图配置 + SVG）
│  ├─ fetch-season.js        赛季文件刷点快照（含中文名/说明/图标）
│  ├─ fetch-season-images.js 赛季文件位置参考截图下载（原图）
│  ├─ check-svg-pack.js      对比上游互动地图素材包，判断底图是否更新
│  ├─ check-upstream.js      上游数据新鲜度检查（tarkov.dev / 站台版本）
│  ├─ diff-dump.js           两份地图快照逐点 diff（更新后核对差异）
│  ├─ probe-socket.js        按 gameMode 探测站台数据（pvp/pve/赛季）
│  ├─ diagnose.js            诊断真实游戏日志（会话/文件/事件）
│  └─ simulate.js            用 samples 跑完整管线验证
├─ samples/                  真实样本（日志 + 截图）
└─ test/                     node:test 单测（解析器 + 数据完整性）
```

## 使用

```bash
npm install        # 首次（安装 electron）
npm start          # 启动
npm run smoke      # 冒烟自检（启动 3 秒后自动退出）
npm run visual-test  # 可视化自检：自动注入工厂位置并截屏到 test-artifacts/（主窗口+小地图）
```

启动后：
- **自动探测游戏目录**（注册表卸载信息 + Steam 常见路径 + 文档目录），也可在"设置"中手动指定
- 游戏进局后地图自动切换；按 `Print Screen` 后即见定位（截图文件名携带坐标与朝向）
- 顶栏：地图下拉、楼层切换（含"自动"）、定位自动居中、车头朝上、小地图雷达、标记点、尺子测距、图钉化、导入截图、设置
- 右侧"标记点图例"按类型开关图钉（撤离点/转移点/Boss/钥匙锁/各类物资箱/BTR 站点/赛季文件刷点/地名…）
  - "赛季文件刷点"按文件类型分别开关，图标即物品图标，点标记看中文说明、坐标与**位置参考截图**（可放大）
- 状态栏显示 **最近撤离点 + 距离**（迷路时最实用）
- 关闭主窗口 = 完全退出（小地图雷达一并关闭）

配置文件：`%APPDATA%\tarkov-offline-map\settings.json`（开发与打包版共用）
运行状态转储：`%APPDATA%\tarkov-offline-map\state.json`（排查识别/定位问题用）

## 打包 Windows 一键运行 exe

```bash
npm run dist      # electron-builder portable -> dist\塔可夫离线地图-<version>.exe
```

- 产物为 **免安装单文件 exe**（v1.2.0 起约 145MB，含 73MB 赛季文件参考截图），双击即用，自带图标与版本信息
- 若构建报 `winCodeSign ... Cannot create symbolic link`（Windows 未开启开发者模式/未提权），
  可手工填充缓存后重试：
  ```powershell
  $c = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
  & node_modules\7zip-bin\win\x64\7za.exe x (Get-ChildItem $c -Filter *.7z | Select -First 1).FullName "-o$c\winCodeSign-2.6.0" '-x!darwin' -y
  ```
  或临时在 package.json 的 `build.win` 中加 `"signAndEditExecutable": false`（内层 exe 将不带图标/版本信息）
  （GitHub Actions 的 windows-latest 有权限创建符号链接，CI 上不会遇到这个问题）

## 持续集成 / 自动发布

`.github/workflows/build.yml`：

| 事件 | 行为 |
|---|---|
| push 到 `main` / PR | 装依赖 → 单测 → 离线管线模拟 → 构建 portable exe → 作为 Actions artifact 上传（保留 30 天） |
| push tag `v*` | 同上，并**自动创建 GitHub Release**，上传 exe 与 `SHA256SUMS.txt` |
| 手动 `workflow_dispatch` | 可填版本号（临时写入 package.json 参与构建），构建并发布 Release |

发布本地新版本：

```bash
npm version 1.2.1 --no-git-tag-version   # 改版本号（可省略，手工触发时也能填）
git commit -am "chore: v1.2.1"
git tag v1.2.1 && git push origin main --tags
```

## 验证

```bash
npm test                 # 单元测试（解析器/投影/映射 + 赛季数据完整性），15 个用例
npm run simulate         # 用 samples 里的日志+截图跑完整管线
node tools/diagnose.js   # 诊断真实游戏日志：会话选择/文件匹配/事件解析
npm run visual-test      # 真实输入事件自检：滚轮缩放/拖拽/测距/图钉/赛季文件，截屏到 test-artifacts/
powershell -File tools/verify-exe.ps1      # 打包版验收：启动 exe -> 截屏 -> 读状态 -> 关主窗口确认零残留
node tools/verify-exe-cdp.js               # 打包版深检（需 exe 带 --remote-debugging-port=9222 启动）
node tools/scan-privacy.js                 # 开源前扫描样例里的账号ID/邮箱/token
```

## 数据更新（游戏大版本更新后）

```bash
npm i socket.io-client           # 首次
npm run fetch:data               # 重新拉取地图配置与 SVG（默认站台版本见 tools/fetch-all.js）
npm run fetch:season             # 重新拉取赛季文件刷点 + 类型图标
npm run fetch:season:images      # 下载赛季文件位置参考截图原图（约 73MB）
npm run fetch:icons              # 补齐标记图标
node tools/check-svg-pack.js     # 对比上游素材包，确认底图是否真的变了
node tools/diff-dump.js          # 与旧快照逐点 diff（撤离点/危险区/BTR 等）
```

### 已知上游状态（2026-09-14 核查）

- 站台静态版本 **4.10.7**（此前快照为 4.10.2），互动地图素材包更新为 `interactive-map/2026-09-13.1`
- 底图：仅 `Reserve.svg` 变化；`Lighthouse.svg` 与 tarkov.dev 上游一致（其最后更新为 2025-11，
  **尚未重画 1.1.5.0 灯塔重做后的地形**，官方/社区底图同步前以游戏内实际地形为准）
- 点位数据：灯塔新增 **8 个 BTR 站点**（1.1.5.0 重做）、森林 8 个、街区 6 个；立交桥撤离点
  10→9、实验室撤离点 6→7；新增 `btrTracking`（BTR 实时位置，需联网，本项目不使用）
- 赛季文件刷点：419 个（赛季 1），覆盖除码头外 14 张图；`码头` 无刷点

## 目录说明补充

`samples/screenshots/*.png` 是**占位图**（内容无关紧要，管线只解析文件名里的坐标与四元数），
避免把个人游戏截图放进公开仓库。真实日志样本中的账号标识已替换为占位值。

## 免责声明

本项目仅读取玩家自己的游戏日志与截图文件，不注入进程、不读写游戏内存。
塔科夫官方禁止任何第三方辅助工具，仅供学习与离线/单人模式自用，风险自负。
地图数据来源：tarkov.dev / the-hideout 开源底图 + kaedeori 站点的公开只读数据快照；
游戏素材版权归 Battlestate Games 所有（详见 [LICENSE](LICENSE)）。
