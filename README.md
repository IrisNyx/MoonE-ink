# MoonE-ink · 墨水屏纸条

MoonE-ink（服务内部名为 Ephemera）是一套自托管的墨水屏出版系统：作者模型通过 **MCP** 投稿，服务用真实的 Chromium 把文字排成 540 × 960 的纸页，再通过局域网或 HTTPS 送到墨水屏上。人类在网页控制台里查看原稿与最终排版、配置设备、版式、落款、排版工和天气。

服务端与设备固件源码都在本仓库。仓库里的 `src/` 是 Node.js 服务，`firmware-source/` 是 PlatformIO 固件工程。

> 当前公开安装包针对 **Windows x64 + LILYGO T5 4.7 S3 Pro Lite（H752-01）** 做过本地启动与构建检查。板型不同请不要直接刷入附件固件；其他系统、板型不宣称支持。

---

## 目录

- [它能做什么](#它能做什么)
- [硬件与当前限制](#硬件与当前限制)
- [本机部署（手把手）](#本机部署手把手)
- [VPS 部署（手把手）](#vps-部署手把手)
- [自定义图片：目前是占位符](#自定义图片目前是占位符)
- [常见问题](#常见问题)
- [从源码构建与固件](#从源码构建与固件)
- [参考项目、协议与隐私](#参考项目协议与隐私)
- [给自动化代理的配置手册](AGENT-SETUP.md)

---

## 它能做什么

### 作者模型经 MCP 投稿

作者模型连接 `/mcp` 时只看到两个工具（公开安装包已把作者凭据的 `tool_view` 设为 `author`）：

- `ephemera_publish`：提交一篇稿件。带当前可用体裁的目录和写作指引；普通散文直接填 `body`，诗、电报、行程单等结构稿用 `content.kind` 指定体裁。
- `ephemera_peek`：回看自己的作品、当前作品和未读；写气象简报前必须先调用 `ephemera_peek(scope=weather)` 读取已配置地点的真实预报。

控制台和网页管理接口不经过 MCP；管理员在网页控制台里查看、配置和管理，作者模型拿不到这些能力。作者 MCP 凭据与网页控制台的管理员凭据是两套独立密钥：作者凭据在配置里撤销或替换，管理员凭据在控制台或私有部署配置中更换。

MCP 端点是 Streamable HTTP、无会话状态，稿件和状态都落在服务的 SQLite 里：连接断开不会丢失已接受的投稿。作者每次投稿都会生成新的请求标识，所以重试一次投稿等于再投一篇，不会自动去重；客户端应避免重复提交。

### 22 种内置体裁

服务内置以下体裁（`weekly-chart` 周谱只保留历史与预览，当前共 21 种接受新投稿）：

醒来纸、便签、周谱、气象简报、残月黄历、明信片、登机牌、行程单、护照盖章页、海关申报单、欠条、票根、电报、号外、处方笺、健诊表、夜航日志、某夜星空、诗、御神签、印记徽、节目单。

大多数版式是单页；便签、醒来纸（附刊）、行程单、护照、海关、夜航日志、印记徽、节目单支持真实分页，最多 16 页。分页由 Chromium 中真实排版后的尺寸与溢出测量逐页确认，不是按字数估算。

### 真实渲染，不是模板截图

- 竖版输出为 **540 × 960** 的 PNG，以及墨水屏用的 `epaper-540x960-gray4-v1` 帧：每像素 4 bit、每行 270 字节、整帧 259,200 字节。
- 部分版式（明信片、票根、诗的横版）输出 **960 × 540**，对应 `epaper-960x540-gray4-v1` 帧：每行 480 字节、整帧同样 259,200 字节。设备通道是否提供横版由 `deviceChannel.allowed_profiles` 决定。
- 纸张纯白、主要文字纯黑，灰色只用于次要信息与装饰；不做抗锯齿之外的抖动。
- 排版器版本、Chromium 版本、字体子集清单都会记录进渲染清单；排版器、浏览器和字体都锁定版本，相同稿件与相同日期重复渲染得到字节一致的图像。
- 正文按作者原文逐字渲染，不做 Unicode 归一化、不去空行、不擅自改写；放不下就按稳定错误码失败，而不是缩小字号或裁切。

### 网页控制台

打开 `http://127.0.0.1:8765/console`（本机）或你的 HTTPS 域名。控制台包含：

- **总览**：服务是否在线、排版是否可用、设备通道状态、当前画面、未读数、最近报错。
- **投稿浏览**：左侧稿件列表，右侧最终排版原图；可展开作者原文、排版工补写内容和纯文字稿。
- **版式与落款**：每个内置版式的说明、触发建议、示例预览；各体裁的落款，主标志、辅助标志，以及五种表情/角色图。
- **排版工**：配置 OpenAI Chat Completions 兼容端点或 Ephemera 桥，设置模型、密钥、时间预算和四步提示词，并可测试文字、结构化输出、看图三项能力。
- **天气预报**：接入和风天气（QWeather）API，搜索地点、获取实时与三日预报；未启用时不伪造天气数据。
- **MCP 配置**：配置了 `auth.console_bearer_file` 且文件内容与作者凭据匹配时，显示可复制的作者端点和作者 Bearer；端点区分本机、局域网、公网。
- **设备**：第一次配置的完整流程——浏览器经 USB 校验并刷入固件、写 Wi-Fi、配对，等待设备持久确认。
- **报错与回执**：出版失败原因、设备事件和回执。
- **账户**：查看服务信息；未由部署配置托管管理员凭据时，可在这里轮换管理员 Bearer。

### 设备通道与固件

- 控制台“第一次配置”会自动生成**一次性配对码**（默认 15 分钟、5 次尝试），并通过 USB 配置流程交给设备。
- 设备通过 HTTPS（或受信任的局域网 HTTP）配对，拿到独立设备凭据。
- 设备按帧下载授权过的灰度资源，逐页校验字节长度和 SHA-256，写入缓存，再上报 cached / presented / acknowledged 等回执。
- 固件工程按 `lilygo-t5-47-s3-pro-lite-h752-01` 板型定义，包含 LVGL 8.4.0 界面、设置/诊断页、阅读器入口和主屏 App。
- 控制台的“设备 → 第一次配置”通过浏览器 Web Serial 直接写串口，Wi-Fi 密码不会经过任何 HTTP 请求。

### 数据持久化

- 所有稿件、排版、资产、请求账本都存在服务自己的数据目录（SQLite + 内容寻址文件），不依赖外部数据库或消息队列。
- 服务端投稿账本对同一 `(instance, caller, request_id)` 只产生一次结果；作者工具每次调用使用新的 `request_id`，所以客户端重试会被记为另一篇新稿。
- 提供全停机的备份、校验、同实例迁移和灾难恢复命令（`scripts/data-admin.mjs`）。仓库内的脚本已按当前数据库 schema 校验；1.0.0 安装包内附带的旧脚本若报 `unsupported data schema`，请改用仓库最新脚本或新发布包。

---

## 硬件与当前限制

**已验证范围**

- 服务：Windows x64，Node.js 24。
- 设备：LILYGO T5 4.7 S3 Pro Lite（H752-01），540 × 960 竖屏。
- 公开安装包只对上述组合做过本地启动/构建检查；首次 USB 刷写、跨设备局域网、长期续航仍需要不同用户实机复验。

**尚未完成或不要误认为可用**

- **续航仍在实机观察**，不承诺“一充可用几天”。频繁刷新、Wi-Fi 和电池状态都会影响结果。
- **TF 卡阅读器未完成**：固件保留了入口和原生 TXT 解析基础，但 TF 卡适配与书目扫描、后台索引、加密进度存储和离线中文字体包尚未接通。目前进入阅读器只会看到插卡/状态页。
- **周谱**保留历史与预览，但不接受新投稿。
- **自制版式工作台**只预留了只读接口，不能在控制台里设计并提交新模板。
- **公开安装包的启动脚本目前前台运行**，关闭窗口即停止，没有内置开机自启；VPS 可用 systemd，Windows 可用计划任务或进程守护工具。
- 设备 Wi-Fi 需要 **2.4 GHz**；5 GHz-only 网络连不上。

---

## 本机部署（手把手）

本机部署分两种：普通用户直接下载 Release 安装包；开发者从源码运行。

### 方式 A：使用 Release 安装包（推荐普通用户）

**准备**

1. Windows 10/11 x64 电脑。
2. [Node.js 24 或更新版本](https://nodejs.org/)。
3. 能传数据的 USB 线（不是只能充电的线）。
4. LILYGO T5 4.7 S3 Pro Lite（H752-01）墨水屏。
5. 电脑和墨水屏都连同一个 **2.4 GHz Wi-Fi**。
6. 最新版 Chrome 或 Edge。首次运行需要联网下载排版用 Chromium。

**步骤**

1. 打开本仓库的 [Releases](https://github.com/IrisNyx/MoonE-ink/releases/latest)，下载最新的 `ephemera-mcp-service-*-public-win32-x64.zip`。
2. **完整解压**到一个固定文件夹。不要只拿走 `firmware.bin` 或某个单独文件；脚本、依赖、固件和排版器都在这个完整目录里。
3. 查电脑的局域网 IPv4 地址：在 PowerShell 运行 `ipconfig`，找到当前 Wi-Fi/以太网适配器的 `IPv4 地址`，例如 `192.168.1.25`。后面用你自己的地址替换示例。
4. 在解压目录打开 PowerShell，运行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-public.ps1 -LanAddress 192.168.1.25
   ```

   首次运行会在安装包**同级**创建 `ephemera-private` 目录，生成管理员与作者两把随机 Bearer，保存数据，并把 Chromium 安装到私人目录。以后重启用同一命令即可；窗口要保持打开。

   > 不带 `-LanAddress` 时服务只监听 `127.0.0.1`，墨水屏连不进来。要让设备走局域网，必须传电脑的局域网 IPv4。

5. 在这台电脑的 Chrome/Edge 打开 <http://127.0.0.1:8765/console>。
   首次登录使用 `ephemera-private\secrets\owner-bearer.txt` 里的**管理员 Bearer**。这是人类控制台用的，不要发给作者模型。
   控制台“总览”应显示服务在线、排版可用。
6. 用 USB 线连接墨水屏。在控制台 **设备 → 第一次配置** 中填写 Wi-Fi 名称、密码和设备名称，确认服务器地址指向刚才电脑的局域网 IPv4，然后点击 **连接 USB 并安装**。
   浏览器会请求选择串口、写入固件、配置 Wi-Fi 并配对。等控制台显示“安装完成”再拔线。刷机必须在电脑本机的 `localhost`/`127.0.0.1` 页面操作，因为 Web Serial 只在该安全上下文中可用。
7. 给作者模型接 MCP：在控制台 **MCP 配置** 复制**作者端点**，Bearer 使用 `ephemera-private\secrets\author-bearer.txt`。
   本机端点通常是 `http://127.0.0.1:8765/mcp`；同一局域网的另一台设备要换成电脑的局域网地址。
   **不要把管理员 Bearer 当作者 Bearer 用。**
8. 可选配置：在“排版工”设置模型和分步提示词；在“天气预报”设置和风天气 API、地点；在“版式与落款”设置落款、标志与五种表情图。这些外部密钥和个性化数据只保存在本机私人目录。

**运行期间**

- 关闭 PowerShell 窗口服务就停止。
- 投稿后可在控制台“投稿浏览”同时看纯文字和排版原图；在墨水屏上阅读、翻页，返回主页后从“纸匣”找未读与最近记录。
- 控制台“设备”可看电量、连接状态和最近回执。
- 备份：先停止服务，再运行 `node scripts/data-admin.mjs backup --data-dir <数据目录> --config <配置> --output <新备份目录>`。

### 方式 B：从源码运行（Windows / macOS / Linux）

适合开发、调试或需要改代码的人。

**1. 安装依赖并编译**

```bash
git clone https://github.com/IrisNyx/MoonE-ink.git
cd MoonE-ink
npm ci
npm run typecheck
npm run build
```

**2. 生成私人配置**

```bash
cp config.example.json config.local.json
```

编辑 `config.local.json`，至少修改这些字段：

| 字段 | 说明 |
| --- | --- |
| `server.host` | 本机保持 `127.0.0.1`；要让局域网设备访问，改成 `0.0.0.0`，并把电脑局域网 IP 加进 `network.allowedHosts`。 |
| `server.dataDir` | 服务独占的数据目录，例如 `D:/ephemera-data` 或 `/var/lib/ephemera`。不要放在源码目录里。 |
| `server.timezone` | IANA 时区，例如 `Asia/Shanghai`。 |
| `network.allowedHosts` | 允许的 Host 头。局域网访问时加入电脑 IP。 |
| `auth.credentials[].token_sha256` | 作者 Bearer 的 SHA-256 十六进制摘要。 |
| `auth.credentials[].tool_view` | 作者凭据设为 `author`，模型才会只看到投稿和回看两个工具。 |
| `auth.console_bearer_file` | 可选。指向一个存放**作者原始 Bearer** 的文件；设置后控制台“MCP 配置”才能显示可复制的作者凭据。文件不要放进仓库。 |
| `deviceChannel.enabled` | 要接墨水屏就设为 `true`。 |
| `deviceChannel.owner_token_sha256` | 管理员 Bearer 的 SHA-256 摘要。 |
| `deviceChannel.publisher_caller_ids` | 允许向设备发布稿件的 `caller_id`。 |
| `deviceChannel.public_endpoint` | 设备要访问的服务根地址；局域网填 `http://192.168.1.25:8765`，VPS 填 HTTPS 域名。 |

MCP 凭据在配置里只写 SHA-256 摘要；可选的 `auth.console_bearer_file` 是例外，它指向一个存放**作者原始 Token** 的文件，供控制台显示。生成摘要：

```bash
node -e "const{createHash}=require('node:crypto');console.log(createHash('sha256').update('你的原始Token').digest('hex'))"
```

原始 Token 自己保存好；服务只在配置和数据库里保存摘要，不能从摘要反推出原始值。

**3. 安装排版用 Chromium**

`playwright-core` 不随 npm 自动下载浏览器。指定一个私人缓存目录并安装锁定版本：

```bash
# Windows PowerShell
$env:PLAYWRIGHT_BROWSERS_PATH="$PWD\.browsers"
node node_modules/playwright-core/cli.js install chromium

# macOS / Linux
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.browsers"
node node_modules/playwright-core/cli.js install chromium
```

**4. 启动**

```bash
node dist/src/index.js --config config.local.json
```

看到类似 `{"event":"listening","host":"127.0.0.1","port":8765}` 即启动成功。

- 控制台：<http://127.0.0.1:8765/console>
- 如果启用了设备通道，管理员登录用你设置 `deviceChannel.owner_token_sha256` 时对应的原始管理员 Token。
- 如果部署配置里没有管理员凭据（例如没有启用设备通道），首次启动会在数据目录生成 `owner-bootstrap.txt`，用其中一次性凭据在控制台完成首次初始化。

停止：POSIX 下 `Ctrl+C` 或 `SIGTERM` 会优雅退出；Windows 下建议由守护进程传入 `--stop-on-stdin-eof` 并在关闭管道时请求停止。

退出码：`0` 正常停止、`1` 运行时异常、`2` 配置或参数错误、`3` 数据目录不可用、`4` 端口监听失败。

---

## VPS 部署（手把手）

> 官方公开安装包目前只验证到 Windows x64。下面是**从源码**在 Linux VPS 上的通用部署方式，需要你在自己的机器上复验。VPS 只跑服务，**USB 刷机仍然在你自己的电脑上做**——浏览器通过 Web Serial 操作本机 USB，设备随后经 Wi-Fi 连到 VPS。

以下以 Ubuntu 22.04/24.04 + Nginx + systemd 为例。

### 1. 安装 Node.js 24

```bash
sudo apt update
sudo apt install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 应为 v24.x 或更高
```

### 2. 放置代码并编译

```bash
sudo mkdir -p /opt/mooneink
sudo chown "$USER":"$USER" /opt/mooneink
git clone https://github.com/IrisNyx/MoonE-ink.git /opt/mooneink/app
cd /opt/mooneink/app
npm ci
npm run build
```

### 3. 安装 Chromium 及系统依赖

```bash
export PLAYWRIGHT_BROWSERS_PATH=/opt/mooneink/browsers
node node_modules/playwright-core/cli.js install chromium
sudo env PLAYWRIGHT_BROWSERS_PATH=/opt/mooneink/browsers node node_modules/playwright-core/cli.js install-deps chromium
```

`install-deps` 会通过 apt 安装无头 Chromium 需要的系统库（会请求 sudo）。安装完确认 `/opt/mooneink/browsers/chromium-1234` 和 `chromium_headless_shell-1234` 存在，并把目录归属切回运行用户：

```bash
sudo chown -R "$USER":"$USER" /opt/mooneink/browsers
```

Ubuntu 24.04 默认限制非特权用户命名空间，Chromium 沙箱可能因此无法启动。若排版报 `render_failed`，先看 `journalctl -u mooneink` 中的 Chromium 启动错误，再按发行版文档调整；不要用 root 运行整个服务来绕过沙箱。

### 4. 准备数据目录与配置

```bash
sudo mkdir -p /var/lib/mooneink
sudo chown "$USER":"$USER" /var/lib/mooneink
cp config.example.json /opt/mooneink/config.json
```

编辑 `/opt/mooneink/config.json`，重点：

```jsonc
{
  "server": {
    "host": "127.0.0.1",              // 只让本机 Nginx 访问
    "port": 8765,
    "dataDir": "/var/lib/mooneink",   // 数据目录，不要放在代码里
    "timezone": "Asia/Shanghai",
    "worker": {                       // 可省略；以下是默认值
      "leaseDurationMs": 120000,
      "pollIntervalMs": 2000
    }
  },
  "network": {
    "allowedHosts": ["127.0.0.1", "ephemera.example.com"],
    "allowedOrigins": []
  },
  "auth": {
    "mode": "static-bearer",
    "console_bearer_file": "/opt/mooneink/secrets/author-bearer.txt",
    "credentials": [
      {
        "credential_id": "cred_author",
        "caller_id": "author_01",
        "token_sha256": "<作者Token的SHA-256>",
        "tool_view": "author",
        "revoked": false
      }
    ]
  },
  "deviceChannel": {
    "enabled": true,
    "owner_token_sha256": "<管理员Token的SHA-256>",
    "public_endpoint": "https://ephemera.example.com",
    "channel_id": "channel_default",
    "publisher_caller_ids": ["author_01"],
    "allowed_profiles": ["epaper-540x960-gray4-v1"]  // 需要横版时加入 "epaper-960x540-gray4-v1"
  },
  "logging": {
    "level": "info"                   // 可省略；默认 info
  }
}
```

要点：

- `server.host` 保持 `127.0.0.1`，公网入口只由 Nginx 提供。
- `network.allowedHosts` 必须包含你的公网域名，否则反向代理转发过来的 Host 头会被拒绝。
- `deviceChannel.public_endpoint` 写公网 **HTTPS 根地址**，不要带路径、查询串或账号密码。
- 管理员 Token 与作者 Token 应不同；管理员 Token 只给控制台，作者 Token 只给模型。

生成摘要：

```bash
node -e "const{createHash}=require('node:crypto');console.log(createHash('sha256').update(process.argv[1]).digest('hex'))" '你的原始Token'
```

把**作者原始 Token** 写到 `auth.console_bearer_file` 指向的文件，权限设为仅服务用户可读；控制台的“MCP 配置”会读取它来显示可复制的作者凭据。它的 SHA-256 必须与某个 `tool_view: "author"` 凭据的 `token_sha256` 一致，否则控制台不会显示：

```bash
mkdir -p /opt/mooneink/secrets
printf '%s\n' '作者原始Token' > /opt/mooneink/secrets/author-bearer.txt
chmod 700 /opt/mooneink/secrets
chmod 600 /opt/mooneink/secrets/author-bearer.txt
```

管理员原始 Token 不写进服务配置，自己保存好，用于登录网页控制台。

### 5. 用 systemd 常驻

创建 `/etc/systemd/system/mooneink.service`：

```ini
[Unit]
Description=MoonE-ink Ephemera service
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/mooneink/app
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/mooneink/browsers
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/src/index.js --config /opt/mooneink/config.json
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

把 `User` 换成实际用户，并确保该用户能读写 `/var/lib/mooneink` 和 `/opt/mooneink/browsers`。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mooneink
sudo systemctl status mooneink
curl http://127.0.0.1:8765/healthz
```

`/healthz` 只返回进程存活状态，可匿名访问。

### 6. Nginx 反向代理与 HTTPS

先装 Nginx 和 Certbot：

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/mooneink`（先只写 80 端口，证书由下一步的 Certbot 自动补上）：

```nginx
server {
    listen 80;
    server_name ephemera.example.com;

    client_max_body_size 1m;

    # 作者模型接入的 MCP 端点，需要公网可达
    location = /mcp {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;          # SSE 保活帧
        proxy_read_timeout 180s;      # terminal-v1 投稿可能等到渲染完成
    }

    # 设备通道：配对、取帧、回执
    location /device/ {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # 控制台只对自己的 IP 开放；按需替换成你的固定 IP
    location /console {
        allow 203.0.113.10;
        deny all;
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /admin/ {
        allow 203.0.113.10;
        deny all;
        client_max_body_size 20m;   # 个性化图片以 base64 JSON 上传，2 MiB PNG 会超过 1m
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用配置并申请证书（Certbot 会自动加上 443 监听、证书路径和 HTTP→HTTPS 跳转）：

```bash
sudo ln -s /etc/nginx/sites-available/mooneink /etc/nginx/sites-enabled/mooneink
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d ephemera.example.com
```

如果 IP 不固定，不能写 `allow`，可以改用 Nginx Basic Auth 再叠加控制台自己的管理员登录，或者只通过 SSH 隧道访问控制台：

```bash
ssh -L 8765:127.0.0.1:8765 youruser@your-vps
# 然后在本机打开 http://127.0.0.1:8765/console
```

这样公网只暴露 `/mcp` 和 `/device/`，控制台不直接对外。

### 7. 设备配对与首次刷机

- 在能访问控制台的浏览器里打开 `https://ephemera.example.com/console`（或 SSH 隧道下的本机地址），登录管理员。
- 控制台 **设备 → 第一次配置**：用 USB 连接墨水屏，选择串口，填写 2.4 GHz Wi-Fi 和密码，服务器地址会自动使用 `deviceChannel.public_endpoint`，然后点击 **连接 USB 并安装**。
- 浏览器会完成固件写入、Wi-Fi 配置和配对；设备之后独立经 Wi-Fi 连 VPS。
- 如果控制台是通过 SSH 隧道以 `http://127.0.0.1:8765` 打开的，Web Serial 可用；如果是普通局域网 IP 的 HTTP 页面，则不可用，因为浏览器不把它当作安全上下文。

### 8. 防火墙与运维

- 只开放 22（SSH）、80、443；8765 不要对公网开放。
- 备份前先停服务，再执行全停机备份：

  ```bash
  sudo systemctl stop mooneink
  node scripts/data-admin.mjs backup \
    --data-dir /var/lib/mooneink \
    --config /opt/mooneink/config.json \
    --output /backup/mooneink-$(date +%F)
  node scripts/data-admin.mjs verify --backup /backup/mooneink-$(date +%F)
  sudo systemctl start mooneink
  ```

  如果 `backup` 报 `unsupported data schema`，说明你用的是 1.0.0 安装包内附带的旧 `data-admin`；改用仓库最新脚本或新发布包，不要继续 `restore`。

- 迁移到新机器用 `restore --mode migrate`；灾难恢复用 `restore --mode disaster`，后者会轮换实例身份并把恢复时仍在处理的稿件标记为 `unknown_after_restore`，不会自动发布。

---

## 自定义图片：目前是占位符

**请先注意：在未上传自定义图片时，主标志、辅助标志和五种表情/角色图会显示同一张黑白玫瑰占位图（便签的辅助标志位使用内置几何装饰）。**

- 占位图位于 [`assets/public/rose-placeholder.svg`](assets/public/rose-placeholder.svg)（PNG 同目录），是一张黑白玫瑰，用来标出可替换的图片位置。
- 在控制台上传自己的图片后，对应位置会显示你的视觉形象。
- 五种状态分别是：**普通、高兴、悲伤、思考、趴下**。醒来纸、御神签、号外和行程单会按内容选用不同状态；你可以先上传一张通用图，再逐步替换。

### 推荐上传尺寸

上传入口：控制台 **版式与落款**。

格式要求：**PNG，单张不超过 2 MiB**；建议透明背景。以下是建议制作尺寸，不是服务器硬性限制；系统会按版面等比缩放。

| 个性化位置 | 建议原图尺寸 | 说明 |
| --- | --- | --- |
| 主标志 | **512 × 512 px** | 正方形，图形四周留一点透明边；实际版面通常以约 150 px 或更小显示。 |
| 辅助标志 | **256 × 256 px** | 正方形，尽量简化细节；实际版面常约 40 px。 |
| 五种表情/角色图 | **640 × 480 px** | 横向构图、透明背景、主体居中；实际显示常只有约 96 × 68 px 至 112 × 76 px。 |

墨水屏是灰度屏。建议用白、纯黑和一档中灰构图，并在小尺寸下检查眼睛、线条和透明边是否仍然清楚。上传后先在控制台看版式预览，再到实机确认。各版式的落款也在同一页单独配置；启用排版工后，未填写的小落款位可由它按规则补全，主要正文不会因此被改写。

---

## 常见问题

| 现象 | 先检查什么 |
| --- | --- |
| 控制台打不开 | PowerShell 窗口/服务是否还在运行；地址是否为本机 `http://127.0.0.1:8765/console`；端口是否被占用。VPS 上检查 `systemctl status mooneink` 和 Nginx。 |
| 浏览器不能刷机 | 必须用支持 Web Serial 的新版 Chrome/Edge，在电脑本机的 `localhost`/`127.0.0.1` 页面打开；确认 USB 线能传数据。 |
| 设备只插线才刷新 | 看控制台“设备”的电量、连接状态和最近回执；确认服务没有随窗口关闭；确认设备连的是 2.4 GHz Wi-Fi。 |
| 作者连不上 MCP | 分清本机地址、局域网地址和公网 HTTPS；端点路径是 `/mcp`；凭据必须用**作者** Bearer，不是管理员 Bearer。 |
| 投稿不能排版 | 首次 Chromium 下载是否成功；`PLAYWRIGHT_BROWSERS_PATH` 是否指向含 `chromium-1234` 的目录；控制台“报错与回执”有具体错误码。 |
| VPS 上返回 403 | `network.allowedHosts` 是否包含公网域名；Nginx 是否传了 `Host $host`。 |
| 设备在 VPS 上连不上 | `deviceChannel.public_endpoint` 是否为公网 HTTPS 根地址；Nginx 是否转发了 `/device/`；防火墙是否放行 443。 |
| 上传图片没反应 | 是否为 PNG、是否超过 2 MiB；控制台会提示具体错误。建议使用透明背景，但服务只校验 PNG 格式和大小。 |
| 备份报 `unsupported data schema` | 1.0.0 安装包内附带的 `data-admin` 旧于服务数据库 schema；改用仓库最新脚本或新发布包，不要继续 restore。 |

---

## 从源码构建与固件

服务端要求 Node.js **24+**（使用内置 `node:sqlite`，无原生插件）。依赖版本全部锁定在 `package-lock.json`。

```bash
npm ci
npm run typecheck
npm run build
```

这里的 `typecheck` 和 `build` 是服务端构建检查。

固件工程在 `firmware-source/`，使用 PlatformIO：

```bash
cd firmware-source
pio run -e mooneink_t5_pro_lite
```

请先确认你的板型是 H752-01；不同板型的内存类型、分区和显示后端可能不同。固件源码里包含的阅读器仍缺 TF 卡适配与书目扫描、中文书籍排版和离线中文字体包，当前不能当作可用的阅读器。

---

## 参考项目、协议与隐私

### 参考项目

本项目的纸张排版代码改编自 [**marikagura/kimi-room**](https://github.com/marikagura/kimi-room)（AGPL-3.0）。改动说明和第三方字体清单见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

字体为 OFL-1.1 授权，许可证文本见 [`licenses/`](licenses/)。

### 开源协议

本项目按 [**AGPL-3.0-only**](LICENSE) 发布。

如果你修改本服务并通过网络向他人提供，需要按 AGPL 的要求向这些网络用户显著提供对应源码的获取入口。仓库里已有源码，但线上部署仍应自行设置并核对源码下载入口，不要把私人工作目录当作源码地址。

### 隐私与安全

- 不要把数据库、Bearer、Wi-Fi 密码、天气/模型 API Key、上传的私人图片或 `ephemera-private` 推送到公开仓库。
- MCP 与管理员凭据在配置和数据库中都只保存 SHA-256 摘要；可选的 `console_bearer_file` 是你自己放置的原始作者 Token 文件，请把权限限制为服务用户可读。
- 管理员与作者使用不同 Bearer，并分别撤销。
- 公网部署只暴露必要的 `/mcp` 与 `/device/`；控制台建议限制 IP、加代理认证，或只走 SSH 隧道。
- 提交 Issue 前请去掉日志中的密钥、住址、稿件私人正文和设备标识。
