# 塔科夫地图 · 房间服务端

给客户端「房间（联机）」功能用的小服务端：**同一房间的人互相看到位置、朝向、轨迹和手动标注**。

设计目标只有一个字：轻。

- 单进程、单文件（`server.js` + `protocol.js`），运行时**只有一个依赖** `ws`
- 没有数据库、没有账号、没有房间列表：房间就是内存里的一张表，空了自动回收
- 默认**不落盘**（`PERSIST=1` 才写文件），空载内存 40–80MB（基本是 Node 自身开销）
- 房间里人人平等：没有房主、没有管理、没有踢人；唯一一条约束是"只能删自己的标注"
- 服务端只转发**位置点 / 标注 / 昵称**这三样，不碰游戏日志、不碰截图

---

## 一分钟起服务

**方式 A：docker compose（推荐，Linux/NAS/软路由）**

```bash
cd server
docker compose up -d          # 起
docker compose logs -f        # 看日志
docker compose down           # 停
```

**方式 B：一条 docker run**

```bash
docker run -d --name tarkov-room -p 8787:8787 --restart unless-stopped \
  ghcr.io/neppure/tarkov-offline-map-server:2.1.0
```

**方式 C：Windows 单文件 exe（不想装 Node / Docker 就用这个）**

从 [Releases](https://github.com/NepPure/tarkov-offline-map/releases/latest) 下载
`tarkov-offline-map-server-<版本>-win-x64.exe`（约 82MB，Node SEA 打出来的单文件，**双击就能开**），
或者自己构建：

```powershell
npm ci
npm run dist:server         # -> dist-server\tarkov-offline-map-server-<版本>-win-x64.exe（自带启动自检）
node tools/verify-server-exe.js   # 端到端验收：真起 exe + 两个真客户端走一遍联机
```

双击启动后，窗口里会**直接打印该填什么**：

```
  塔科夫地图 · 房间服务端 v2.1.0（协议 v2）
  正在监听：0.0.0.0:8787
  客户端「设置 → 房间（联机）」里填：
      服务器地址 = 192.168.31.101   （以太网）  端口 = 8787
  健康检查 http://127.0.0.1:8787/healthz    状态页 http://127.0.0.1:8787/
```

命令行开关（等价的环境变量写在括号里，优先级：**命令行 > 环境变量 > 默认值**）：

```powershell
tarkov-offline-map-server-2.1.0-win-x64.exe                      # 默认 0.0.0.0:8787，纯内存
tarkov-offline-map-server-2.1.0-win-x64.exe --port 9000          # 换端口
tarkov-offline-map-server-2.1.0-win-x64.exe --persist --data-dir D:\room-annos   # 标注落盘，重启不丢
tarkov-offline-map-server-2.1.0-win-x64.exe --max-room-peers 8 --log-level debug
tarkov-offline-map-server-2.1.0-win-x64.exe --help               # 全部开关
```

| 开关 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--host` | `HOST` | `0.0.0.0` | 监听地址 |
| `--port` | `PORT` | `8787` | 监听端口（`0` = 让系统挑一个空闲端口） |
| `--max-room-peers` | `MAX_ROOM_PEERS` | `16` | 单房间人数上限 |
| `--room-ttl` | `ROOM_TTL` | `600` | 房间空了以后保留多少秒 |
| `--max-conn-per-ip` | `MAX_CONN_PER_IP` | `8` | 单 IP 并发连接上限 |
| `--max-annos-per-room` | `MAX_ANNOS_PER_ROOM` | `2000` | 单房间标注总数上限 |
| `--pos-min-interval-ms` | `POS_MIN_INTERVAL_MS` | `200` | 位置消息最小间隔 |
| `--save-debounce-ms` | `SAVE_DEBOUNCE_MS` | `5000` | 落盘防抖 |
| `--persist` | `PERSIST=1` | 关 | 标注落盘（纯内存 vs 重启不丢） |
| `--data-dir` | `DATA_DIR` | `/data`（Windows 上建议自己指定，例如 `D:\room-annos`） | 落盘目录 |
| `--log-level` | `LOG_LEVEL` | `info` | `error`/`warn`/`info`/`debug` |
| `--public-status` / `--public-status=0` | `PUBLIC_STATUS=0` | 开 | 匿名状态页 |
| `--trust-proxy` | `TRUST_PROXY=1` | 关 | 反代时按 `X-Forwarded-For` 限流 |

> - 端口要放行：队友连不进来，先看 Windows 防火墙（第一次启动会弹"允许访问"）或云安全组
> - 这个 exe 是**未签名**的：SmartScreen 提示"未知发布者"时选"仍要运行"
> - 停止：按 `Ctrl+C`；双击启动的话直接关掉那个黑窗口
> - 它就是个普通进程：想开机自启就丢进"启动"文件夹或做成任务计划（不需要管理员权限）

**方式 D：不用 docker，直接用 Node 裸跑**

```bash
cd server
npm ci --omit=dev
PORT=8787 node server.js                 # 也支持命令行： node server.js --port 8787 --persist
```

起来之后：

```bash
curl http://127.0.0.1:8787/healthz
# {"ok":true,"name":"tarkov-offline-map-server","ver":"2.1.0","proto":2,"uptime":3,"rooms":0,"peers":0,...}
```

浏览器打开 `http://<服务器IP>:8787/` 能看到一行纯文本状态（房间数、在线人数、内存占用，**不含任何房间标识**）。

## 客户端怎么连

客户端顶栏 **设置 → 房间（联机）**：

| 字段 | 说明 |
|---|---|
| 服务器地址 | 这台机器的内网 IP 或域名，例如 `192.168.1.10`；填了 `http://` 也会被自动去掉 |
| 端口 | 默认 `8787` |
| 房间号 | 你们自己商量的暗号（建议 6–8 位随机字符），知道房间号的人就能进 |
| 口令 | 可选。填了以后房间号+口令一起哈希，等于多一层 |
| 昵称 | 地图上会用**昵称第一个字**加上朝向箭头画出你；同一昵称不冲突，会带短 id 区分 |

点「测试连接」会请求 `/healthz`，能看到协议版本对不对；再点「加入房间」才开始连。

> 端口要放行：Windows 防火墙 / 云服务器安全组都要允许 8787（或你自己映射的端口）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `MAX_ROOM_PEERS` | `16` | 单房间人数上限 |
| `ROOM_TTL` | `600` | 房间空了以后在内存里保留多少秒（0 = 立刻回收） |
| `MAX_CONN_PER_IP` | `8` | 单 IP 并发连接上限（防一个人开一堆连接） |
| `MAX_ANNOS_PER_ROOM` | `2000` | 单房间标注总数上限 |
| `POS_MIN_INTERVAL_MS` | `200` | 位置消息最小间隔，更密的直接丢 |
| `PERSIST` | `0` | `1` = 标注落盘（重启不丢） |
| `DATA_DIR` | `/data` | 落盘目录（`PERSIST=1` 时用） |
| `PUBLIC_STATUS` | `1` | `0` = 关掉匿名状态页（只留 `/healthz`） |
| `TRUST_PROXY` | `0` | `1` = 按 `X-Forwarded-For` 第一段识别客户端 IP（反代时打开） |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |

## 落盘（可选）

默认纯内存：容器重启，房间里的标注就没了（每个人本地还有自己那份，不影响自己看）。
想让房间的标注跨重启保留：

```yaml
environment:
  PERSIST: "1"
volumes:
  - room-data:/data
```

- 每个房间一个文件：`/data/<房间标识>.json`，**先写 .tmp 再 rename**，断电不会留半个 JSON
- 写入有 5 秒防抖；`SIGTERM` / `SIGINT` 时会立刻 flush
- bind mount（不用命名卷）时记得让容器用户 `1000:1000` 有写权限，否则日志里会出现"落盘失败"

## 公网部署（wss）

默认是明文 `ws://`：**内网/自建服务器完全够用**，公网建议套一层反代上 `wss://`（客户端填 `wss://` 地址时会自动用加密连接）。

nginx：

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 300s;   # 心跳是 30s，别让反代提前掐断
}
location /healthz {
    proxy_pass http://127.0.0.1:8787;
}
```

Caddy：

```
room.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

反代时记得给服务端加 `TRUST_PROXY=1`，否则限流会按反代的 IP 算成一个人。

## 协议速查（v2）

文本帧 JSON。连接 `ws://<host>:<port>/ws`，**第一帧必须是 `hello`**，房间标识不在 URL 里
（所以反代的 access log 也记不到房间号）。

| 方向 | 消息 |
|---|---|
| ↑ | `hello{v:2,room,nick,pid}` |
| ↑ | `map{map}` — 我在哪张图（换图/进图各一次） |
| ↑ | `pos{map,x,y,z,hdg,ts,trail?}` — 定位（按了截图键才有新位置） |
| ↑ | `anno{op:"add"\|"del",map,id,kind,color,width,pts}` — `kind` 取 `pen/path/line/arrow/ellipse/rect` |
| ↑ | `newraid` — 我开新一局了（上一局的定位作废；不带字段） |
| ↑ | `ping` |
| ↓ | `welcome{proto,ver,self,peers[],annos{}}` — 进房快照 |
| ↓ | `peer-join{peer}` / `peer-left{id}` |
| ↓ | `peer-map{id,map}` — `peer-*` 系列都**不回给本人**，只表示"别人的状态变了" |
| ↓ | `peer-pos{id,map,x,y,z,hdg,ts,trail?}` |
| ↓ | `peer-reset{id}` — 他开新一局了：把他之前的点抹掉（`newraid` 的转达） |
| ↓ | `anno{op,map,id,...,owner}` — 含回显给发送者 |
| ↓ | `pong{now}` / `err{code,msg}` |

> 老版本客户端/服务端不认识 `newraid`/`peer-reset`/`ellipse`：服务端对未知消息类型**静默忽略**
> （不会报错也不会断连），未知 `kind` 的笔画会被丢掉。协议大版本 `PROTO` 仍然是 2，
> 所以混用版本不会互相拒连；想拿到"新局清队友残留 + 椭圆标注同步"的完整效果，请把两端都更新。

`err` 的 `code`：`bad-version` / `bad-room` / `need-hello` / `room-full` / `too-large` / `bad-json` / `rate-limit` / `anno-limit` / `replaced`。

房间标识 = `sha256(房间号 + "\0" + 口令)` 的前 32 位十六进制。客户端和服务端各有一份实现，
`server/test/protocol.test.js` 会交叉校验 —— 改算法时两边必须同时改。

## 测试

```bash
cd server
npm test          # 8 个命令行参数用例 + 8 个协议用例 + 15 个真起服务的集成用例
                  # （真 WebSocket 客户端，含 newraid -> peer-reset）+ 8 个守卫行为用例 +
                  # 5 个 Dockerfile/compose 一致性用例
```

根目录下等价的一条命令：

```bash
npm run test:server     # 只跑服务端
npm run test:all        # 客户端 + 服务端
node tools/verify-server-image.js   # 不用 Docker 也能验镜像内容（照 Dockerfile 复刻文件集 + 跑健康检查原命令）
npm run dist:server                 # 打 Windows 单文件 exe（Node SEA，自带 --version/--help/真起服务的自检）
node tools/verify-server-exe.js     # exe 的端到端验收（起 exe + 两个真客户端走一遍联机）
```

CI（`.github/workflows/server.yml`）里两条交付路径都会构建：

- `image` job：Docker 镜像推到 `ghcr.io/neppure/tarkov-offline-map-server`（`main` → `:latest` 与 `:sha-xxxxxxx`；tag → `:X.Y.Z`）
- `win-exe` job：Windows 单文件 exe（Node SEA）→ 作为 Actions artifact 上传；
  推 tag 时会**挂到同一个 GitHub Release**（文件名 `tarkov-offline-map-server-<版本>-win-x64.exe`）

## 目录

```
server/
├─ server.js             HTTP + WebSocket + 房间表 + 命令行参数/启动横幅（约 700 行）
├─ protocol.js           纯函数：房间号、帧解析、位置/标注校验
├─ test/                 单测 + 集成测试（含命令行参数）
├─ Dockerfile            node:22-alpine，非 root，自带 HEALTHCHECK
├─ docker-compose.yml    一条命令起服务
└─ package.json          唯一依赖 ws
```

Windows 单文件 exe 的构建脚本在仓库根部：`tools/make-server-exe.js`（esbuild 打包 → SEA blob →
注入 node.exe），产物落在 `dist-server/`（已 gitignore）。
