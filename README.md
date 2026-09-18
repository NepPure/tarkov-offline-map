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
│  ├─ mini-geometry.js       小地图悬浮窗拖动/钳位几何（纯函数，带单测）
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
│  ├─ verify-exe.ps1         打包版验收（启动/截屏/零残留）
│  ├─ verify-exe-cdp.js      打包版深检（标记/赛季文件/截图查看器/小地图）
│  ├─ verify-mini-input.js   小地图真实鼠标输入验收（拖动/按钮/位置记忆）
│  ├─ input.ps1              系统级鼠标输入助手（SetCursorPos / mouse_event）
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
- 右侧"标记点图例"按**大类分组**，每组前面都有一个**批量显示/隐藏**的组开关（三态：全开 / 部分选中 / 全关）：
  撤离·转移·交通 / Boss·出生点 / 钥匙锁·开关 / 危险·固定武器 / 赛季文件刷点 / 物资箱·散落物资 / 地名，
  组内再按具体类型单独开关；面板顶部"全开 / 全关"一次控制所有大类
  - "赛季文件刷点"按文件类型分别开关，图标即物品图标，点标记看中文说明、坐标与**位置参考截图**（可放大）
- 地图上的**地名文字**为"白色内色 + 深色外框"（先描边后填充，笔画平滑、与底图对比明显），
  大小可在"设置 → 地名文字大小"按 0.8x~2.5x 调整
- 状态栏显示 **最近撤离点 + 距离**（迷路时最实用）
- 关闭主窗口 = 完全退出（小地图雷达一并关闭）

### 圆形小地图雷达怎么用

雷达上**默认没有任何按钮**：所有开关都在"设置 → 圆形小地图雷达"里调。

| 操作 | 效果 |
|---|---|
| 按住圆盘任意位置拖动 | 移动悬浮窗位置（松手记住，重启后还在原处；拖出屏幕会自动钳回） |
| 滚轮 | 缩放（以光标为中心），一直可用 |
| 点击地图空白/标记 | 不改变视野：雷达始终跟随玩家，不会"点一下地图就飞走" |
| Tab / 空格 / 回车 | 与雷达完全无关（窗口 `focusable:false`，唯一点得到的"解锁"小块也是 `tabindex="-1"`） |

| 设置项（设置 → 圆形小地图雷达） | 默认 | 说明 |
|---|---|---|
| 启用小地图雷达 | 关 | 开启独立圆形小地图窗口 |
| 整体透明度 | 0.9 | 默认"有一点点透明"，0.2~1 可调 |
| 显示半径(米) | 55 | 圆盘铺满多少米（也就是雷达看多远） |
| 随角色朝向旋转 | **关** | 关 = 地图方向固定（正北朝上，不随视角变化） |
| 定位后自动居中 | 开 | 关掉后只更新玩家点与轨迹，不再把视野拉回玩家 |
| 按玩家高度自动切换楼层 | 开 | 关掉后固定显示地图基础层 |
| 点击穿透 | 关 | 开 = 雷达**看得到、点不着**（鼠标直接作用到游戏） |
| 缩放跟随互动地图 | 关 | 关 = 按自己的显示半径 |

**点击穿透（看得到点不着）+「锁 / 解锁」小按钮**：两个按钮都在雷达右下角，**鼠标靠近才出现**（平时完全透明不挡地图）。

- 未锁定：鼠标放在雷达上 -> 淡出显示「锁」，点它开启点击穿透（鼠标直接作用到游戏）
- 已锁定：鼠标放在雷达上 -> 淡出显示「解锁」，**但鼠标仍旧穿透**；把鼠标移到这个小条上才会临时接管鼠标，
  点一下「解锁」即关闭穿透并写回设置
- 也可以在"设置 → 圆形小地图雷达 → 点击穿透"里直接开关

（实现：穿透状态下 Windows 不会把真实鼠标移动转发给渲染层 —— `setIgnoreMouseEvents(true,{forward:true})`
实测收不到 mousemove，所以"放在雷达上就显示"的命中判定由主进程按光标 60ms 轮询，
和拖动用的是同一套办法：圆盘内 -> 只显示按钮；小条上 -> 才 `setIgnoreMouseEvents(false)` 接管鼠标。）

雷达上的图标与主窗口**完全一致**：只画图标本体，不加任何底盘 / 圆形背景（撤离点就是那块绿色盾牌图标、
Boss 就是头像、钥匙就是钥匙、赛季文件就是文件图标），大小跟随"设置 → 标记大小"，
默认比早期版本放大约 2.4 倍，主窗口与雷达共用同一套图例开关。
赛季文件刷点同样标在小地图上（找文件不用切回主窗口）。

为避免小圆盘里"糊成一团"，雷达会**按视口裁剪**并做两级降噪：

- 标记数超过 90 个时，依次丢掉"最不关键"的层级（地名文字 → 散落物资/出生点 → 各类物资箱），
  只保留撤离点/Boss/转移点/钥匙锁/开关/危险/固定武器/赛季文件/BTR 站点等关键点
- 再超过 260 个（还没定位、视野被拉到很宽时）按重要度硬截断
- 主窗口不受影响：地图上依旧是全量标记，图钉开关也对两个窗口同时生效

还没定位过（没按过 PrintScreen）时，雷达以**地图中心 + 显示半径**作为初始视野，
而不是缩到整张图（否则上千个标记会糊在一起）。

配置文件：`%APPDATA%\tarkov-offline-map\settings.json`（开发与打包版共用）
运行状态转储：`%APPDATA%\tarkov-offline-map\state.json`（排查识别/定位问题用）
小地图窗口日志：`%APPDATA%\tarkov-offline-map\mini.log`（窗口被系统吞掉/崩溃/自动重建都会记录）
地图识别日志：`%APPDATA%\tarkov-offline-map\app.log`（会话切换/切图/认不出来的图，见下）

### 地图识别怎么工作 & "没切图"怎么排查

进图时游戏会往最新会话目录的 `* application_*.log` 写这样一行：

```
2026-09-18 21:21:48.057|1.1.5.1.47473|Info|application|scene preset path:maps/shopping_mall.bundle rcid:Shopping_Mall.ScenesPreset.asset
```

程序按 **bundle 名 → raidCode → 地图 key** 两级映射切图；bundle 名认不出来时再用同一行的 `rcid:` 兜底。
注意 14 张图里有 13 张是 `xxx_preset.bundle`，**只有立交桥是 `shopping_mall.bundle`**（不带 `_preset`）。
早期版本这里写死拼 `_preset` 去查表，于是立交桥永远查不到 → 进图不切图（现在两种写法都支持）。

`app.log` 里能直接看到判定过程：

| 日志行 | 含义 |
|---|---|
| `log session: log_2026.09.18_21-00-14_1.1.5.1.47473` | 正在跟踪哪个游戏日志会话 |
| `map switch -> interchange (立交桥) by scene-preset raidCode=Interchange` | 切图成功（含来源与 raidCode） |
| `UNKNOWN map bundle: xxx (rcid=Yyy)` | 游戏改了图名，需要补映射表（把这一行反馈即可） |
| `UNMAPPED raidCode: xxx` | raidCode 认出来了，但没对应到地图 |

另外两点加固：应用在**局内才启动**时会回扫日志尾部（最多 8MB）找**最后一条**地图行，所以中途开程序也能立刻对上当前图；
会话目录消失（游戏清理日志）时会松开文件句柄并报 `no-session`，不会攥着已删除的文件。

### 小地图雷达"消失"问题（已加固）

悬浮雷达是**无边框 + 透明 + 置顶**窗口，Windows 上这类窗口有几个已知坑，程序里都做了处理：

| 现象 | 原因 | 处理 |
|---|---|---|
| 点一下雷达就"没了" | 透明表面在被点击/激活后可能停止重绘：窗口还在，但一片空白 | 显示/悬停/拖动松手时主动 `invalidate()` 强制重绘，另加 2.5s 看门狗兜底 |
| 按过 Tab 后雷达消失 | 雷达窗口能拿到键盘焦点，Tab 在它的按钮间循环，空格/回车又把开关切一次 | 雷达窗口 `focusable:false`（系统层面就不给键盘焦点）+ 按钮 `tabindex="-1"` + `keydown` 拦截 Tab/空格；主窗口顶栏按钮点完即 `blur()`；v1.2.4 起雷达上干脆没有任何按钮 |
| 拖不动 / 只能待在右上角 | 无边框窗口没有标题栏，也没有实现拖动 | 按住圆盘任意位置即可拖动；由主进程按真实光标位置 `setBounds`（带尺寸）实现，指针移出窗口也不丢，位置写入配置 |
| 拖着拖着雷达越变越大 | Windows 150% 缩放下反复 `setPosition`（DIP↔物理像素取整）每次让尺寸多算 1px | 拖动改用 `setBounds` 每帧钉死 300×300；松手与 2.5s 看门狗再校正一次（`mini.log` 会记 `watchdog: size WxH -> 300`） |
| 被游戏窗口盖住 / Win+D 最小化 | 置顶层级丢失或被系统最小化 | 看门狗 + blur/focus 事件重新抬高到 `screen-saver` 级；被最小化立即 `restore()` |
| 窗口真的被销毁 / 渲染进程崩溃 | 透明窗口 OOM、GPU 掉线 | `render-process-gone` / `did-fail-load` 自动 reload；窗口没了自动重建；按钮变黄提示 |
| 按钮显示开着但其实没窗口 | 状态不同步 | 主进程广播 `miniStatus`，按钮反映真实状态；再点一次是"恢复"而不是"关闭" |

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
npm test                 # 单元测试（解析器/投影/映射 + 赛季数据完整性 + 地图几何/地名文字样式），27 个用例
npm run simulate         # 用 samples 里的日志+截图跑完整管线
node tools/diagnose.js   # 诊断真实游戏日志：会话选择/文件匹配/事件解析
npm run visual-test      # 真实输入事件自检：滚轮缩放/拖拽/测距/图钉/赛季文件/小地图拖动与焦点，截屏到 test-artifacts/
powershell -File tools/verify-exe.ps1      # 打包版验收：启动 exe -> 截屏 -> 读状态 -> 关主窗口确认零残留
node tools/verify-exe-cdp.js               # 打包版深检（需 exe 带 --remote-debugging-port=9222 启动）
node tools/verify-mini-input.js            # 系统级真实鼠标输入验收：小地图拖动跟随 + 工具条按钮可点 + 位置记忆
node tools/scan-privacy.js                 # 开源前扫描样例里的账号ID/邮箱/token
```

`tools/verify-mini-input.js` 用 `SetCursorPos` + `mouse_event`（真实输入，不是合成事件）验收小地图，
检测到游戏在前台时会自动跳过，避免把点击送进游戏。

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
