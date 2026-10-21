# MoonE-ink / Ephemera · Agent Setup

面向自动化代理的配置与验收手册。按本文件执行；这里只写可验证的事实和命令。

```yaml
project: MoonE-ink
service: ephemera
runtime: Node.js >= 24
default_port: 8765
mcp_endpoint: /mcp
console_path: /console
admin_api_prefix: /admin/v1
author_tools:
  - ephemera_publish
  - ephemera_peek
chromium_revision: "1234"
license: AGPL-3.0-only
```

---

## 0. 硬约束

1. Node.js 必须是 **24 或更新版本**；服务使用内置 `node:sqlite`。
2. 排版使用锁定的 Chromium revision **1234**（`playwright-core` 1.62.0）。没有它服务仍能启动，但 `publish` 能力为 `false`，投稿会被拒绝。
3. 配置文件是 **strict JSON**：未知字段会让进程以退出码 `2` 退出。
4. 作者凭据必须显式设置 `"tool_view": "author"`。省略时默认值不是作者工具面。
5. 管理只走网页控制台和 `/admin/v1/*`，不经过 MCP。不要把管理员 Bearer 交给作者模型。
6. 永远不要把原始 Token、数据库、Wi-Fi 密码、天气/模型 API Key 或 `ephemera-private` 写入源码目录或提交到 Git。
7. 公网部署只开放 `/mcp` 和 `/device/`；`/console` 与 `/admin/` 必须限制来源（IP allowlist、代理认证或 SSH 隧道）。
8. USB 刷机只能由人类在 Chrome/Edge 的 `localhost` 或 HTTPS 页面完成；代理无法代替 Web Serial 操作。

---

## 1. 选择部署路径

| 条件 | 路径 | 说明 |
| --- | --- | --- |
| Windows x64，普通用户，Release 可用 | A. Release 安装包 | 不需要编译；脚本自动生成配置、密钥和 Chromium。 |
| 需要改代码，或本机开发 | B. 源码运行 | Windows/macOS/Linux 均可。 |
| Linux VPS，公网 HTTPS | C. 源码 + systemd + Nginx | 服务只监听 `127.0.0.1`，由 Nginx 对外。 |

先确认发布资产：

```bash
gh release view v1.0.1 -R IrisNyx/MoonE-ink --json assets --jq '.assets[].name'
# 期望包含：
# ephemera-mcp-service-1.0.1-public-win32-x64.zip
# ephemera-mcp-service-1.0.1-public-win32-x64.zip.sha256
```

---

## 2. 路径 A：Windows Release 安装包

### 2.1 下载并解压

1. 下载 `ephemera-mcp-service-*-public-win32-x64.zip`。
2. 完整解压到一个固定目录。不要只取其中的 `firmware.bin`。
3. 安装 Node.js 24+。
4. 查本机局域网 IPv4：

```powershell
ipconfig
```

记下当前 Wi-Fi/以太网适配器的 IPv4，例如 `192.168.1.25`。

### 2.2 启动

在解压目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-public.ps1 -LanAddress 192.168.1.25
```

脚本行为：

- 在安装包**同级**创建 `ephemera-private`，包括 `config.json`、`data/`、`secrets/`、`browsers/`。
- 生成两把随机 Bearer：
  - 管理员：`ephemera-private\secrets\owner-bearer.txt`
  - 作者：`ephemera-private\secrets\author-bearer.txt`
- 首次运行下载 Chromium；之后复用。
- 前台运行；关闭窗口即停止。代理执行时应放到后台进程或单独的终端，不要把等待前台进程当成启动失败。

代理验收：

```powershell
curl.exe -s http://127.0.0.1:8765/healthz
# 期望：{"status":"ok","uptime_sec":...}
```

控制台：<http://127.0.0.1:8765/console>

Windows 首次监听 `0.0.0.0:8765` 时可能弹出防火墙提示；只允许专用/局域网网络。设备连不上时先确认 Windows 防火墙允许 8765 的局域网入站。

### 2.3 人类必须完成的步骤

1. 用管理员 Bearer 登录控制台。
2. USB 连接墨水屏。
3. 进入 **设备 → 第一次配置**，填写 2.4 GHz Wi-Fi、密码、设备名。
4. 确认服务器地址是电脑的局域网地址。
5. 点击 **连接 USB 并安装**，等待“安装完成”。

代理可以准备好 URL、Bearer 文件和检查清单，但不能代替这一步。

---

## 3. 路径 B：源码运行（本机）

### 3.1 编译

```bash
git clone https://github.com/IrisNyx/MoonE-ink.git
cd MoonE-ink
npm ci
npm run typecheck
npm run build
```

### 3.2 生成密钥

执行一次，得到 JSON：

```bash
node -e "const c=require('node:crypto');const mk=()=>{const t=c.randomBytes(32).toString('base64url');return {token:t,sha256:c.createHash('sha256').update(t).digest('hex')}};console.log(JSON.stringify({author:mk(),owner:mk()}))"
```

输出示例结构：

```json
{
  "author": { "token": "<作者原始Token>", "sha256": "<64位小写hex>" },
  "owner":  { "token": "<管理员原始Token>", "sha256": "<64位小写hex>" }
}
```

映射：

| 值 | 写到哪里 |
| --- | --- |
| `author.sha256` | `auth.credentials[].token_sha256` |
| `author.token` | `auth.console_bearer_file` 指向的文件，权限 `600` |
| `owner.sha256` | `deviceChannel.owner_token_sha256` |
| `owner.token` | 只交给人类登录控制台；不要写进配置 |

Token 允许字符为 `[A-Za-z0-9._~+/=-]`，长度 32–512。上面生成的是 43 字符 base64url。

### 3.3 安装 Chromium

Windows PowerShell：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH="$PWD\.browsers"
node node_modules/playwright-core/cli.js install chromium
```

macOS / Linux：

```bash
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.browsers"
node node_modules/playwright-core/cli.js install chromium
```

验收：

```bash
ls "$PLAYWRIGHT_BROWSERS_PATH" | grep -E 'chromium-1234|chromium_headless_shell-1234'
# Windows: dir $env:PLAYWRIGHT_BROWSERS_PATH
```

必须同时存在 `chromium-1234` 和 `chromium_headless_shell-1234`。

### 3.4 写配置

使用下面的模板，替换占位值。**所有路径建议写绝对路径。**

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 8765,
    "dataDir": "C:/mooneink-data",
    "timezone": "Asia/Shanghai"
  },
  "network": {
    "allowedHosts": ["localhost", "127.0.0.1", "[::1]", "192.168.1.25"],
    "allowedOrigins": []
  },
  "auth": {
    "mode": "static-bearer",
    "console_bearer_file": "C:/mooneink-secrets/author-bearer.txt",
    "credentials": [
      {
        "credential_id": "cred_author",
        "caller_id": "author_01",
        "token_sha256": "REPLACE_WITH_AUTHOR_SHA256",
        "tool_view": "author",
        "revoked": false
      }
    ]
  },
  "deviceChannel": {
    "enabled": true,
    "owner_token_sha256": "REPLACE_WITH_OWNER_SHA256",
    "public_endpoint": "http://192.168.1.25:8765",
    "channel_id": "channel_default",
    "publisher_caller_ids": ["author_01"],
    "allowed_profiles": ["epaper-540x960-gray4-v1"]
  },
  "logging": { "level": "info" }
}
```

不接设备时，把 `deviceChannel.enabled` 设为 `false`，删除 `owner_token_sha256` 和 `public_endpoint`，其余保留。

创建作者 Token 文件：

```bash
mkdir -p C:/mooneink-secrets
printf '%s\n' '作者原始Token' > C:/mooneink-secrets/author-bearer.txt
chmod 600 C:/mooneink-secrets/author-bearer.txt
```

Windows 权限可用：

```powershell
icacls C:\mooneink-secrets\author-bearer.txt /inheritance:r /grant:r "$env:USERNAME:(R)"
```

### 3.5 启动

```bash
node dist/src/index.js --config C:/mooneink-data/config.json
```

也可以把配置放到数据目录之外，例如 `C:/mooneink-config/config.json`。

启动成功的日志行：

```json
{"event":"listening","host":"0.0.0.0","port":8765}
{"event":"instance_ready","instance_id":"inst_...","schema_version":10,...}
{"event":"owner_management_ready","initialized":true}
```

如果看到：

```json
{"event":"renderer_unavailable","reason":"PLAYWRIGHT_BROWSERS_PATH is not configured"}
```

排版不可用。设置 `PLAYWRIGHT_BROWSERS_PATH` 后重启。

### 3.6 停止

- POSIX：`SIGINT` / `SIGTERM`。
- Windows：由守护进程传入 `--stop-on-stdin-eof`，然后关闭管道 stdin。

退出码：

| 码 | 含义 |
| --- | --- |
| `0` | 正常停止 |
| `1` | 运行时异常 |
| `2` | 配置或参数错误 |
| `3` | 数据目录不可用 |
| `4` | 端口监听失败 |

---

## 4. 路径 C：Linux VPS

以下以 Ubuntu 22.04/24.04 为例。

### 4.1 安装 Node.js 24

```bash
sudo apt update
sudo apt install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

### 4.2 编译

```bash
sudo mkdir -p /opt/mooneink
sudo chown "$USER":"$USER" /opt/mooneink
git clone https://github.com/IrisNyx/MoonE-ink.git /opt/mooneink/app
cd /opt/mooneink/app
npm ci
npm run build
```

### 4.3 安装 Chromium

```bash
export PLAYWRIGHT_BROWSERS_PATH=/opt/mooneink/browsers
node node_modules/playwright-core/cli.js install chromium
sudo env PLAYWRIGHT_BROWSERS_PATH=/opt/mooneink/browsers node node_modules/playwright-core/cli.js install-deps chromium
sudo chown -R "$USER":"$USER" /opt/mooneink/browsers
```

验收：

```bash
test -d /opt/mooneink/browsers/chromium-1234
test -d /opt/mooneink/browsers/chromium_headless_shell-1234
```

Ubuntu 24.04 限制非特权用户命名空间时，Chromium 沙箱可能无法启动。先看 `journalctl -u mooneink`；不要用 root 运行整个服务来绕过。

### 4.4 配置

```bash
sudo mkdir -p /var/lib/mooneink /opt/mooneink/secrets
sudo chown "$USER":"$USER" /var/lib/mooneink /opt/mooneink/secrets
```

使用下面的模板。`allowedHosts` 必须包含公网域名；`public_endpoint` 必须是 HTTPS 根地址。

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8765,
    "dataDir": "/var/lib/mooneink",
    "timezone": "Asia/Shanghai"
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
        "token_sha256": "REPLACE_WITH_AUTHOR_SHA256",
        "tool_view": "author",
        "revoked": false
      }
    ]
  },
  "deviceChannel": {
    "enabled": true,
    "owner_token_sha256": "REPLACE_WITH_OWNER_SHA256",
    "public_endpoint": "https://ephemera.example.com",
    "channel_id": "channel_default",
    "publisher_caller_ids": ["author_01"],
    "allowed_profiles": ["epaper-540x960-gray4-v1"]
  },
  "logging": { "level": "info" }
}
```

写作者 Token 文件：

```bash
printf '%s\n' '作者原始Token' > /opt/mooneink/secrets/author-bearer.txt
chmod 700 /opt/mooneink/secrets
chmod 600 /opt/mooneink/secrets/author-bearer.txt
```

把填好的配置写到 `/opt/mooneink/config.json`，然后先做一次前台启动检查：

```bash
cd /opt/mooneink/app
PLAYWRIGHT_BROWSERS_PATH=/opt/mooneink/browsers node dist/src/index.js --config /opt/mooneink/config.json
# 期望看到 listening / instance_ready / owner_management_ready
# Ctrl+C 正常停止后再交给 systemd
```

### 4.5 systemd

`/etc/systemd/system/mooneink.service`：

```ini
[Unit]
Description=MoonE-ink Ephemera service
After=network.target

[Service]
Type=simple
User=YOUR_USER
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

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mooneink
curl -s http://127.0.0.1:8765/healthz
```

### 4.6 Nginx

```nginx
server {
    listen 80;
    server_name ephemera.example.com;

    client_max_body_size 1m;
    # 把 203.0.113.10 换成你实际的管理入口 IP；不固定就改用 Basic Auth 或 SSH 隧道

    location = /mcp {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 180s;
    }

    location /device/ {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location /console {
        allow 203.0.113.10;
        deny all;
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /admin/ {
        allow 203.0.113.10;
        deny all;
        client_max_body_size 20m;
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/mooneink /etc/nginx/sites-enabled/mooneink
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d ephemera.example.com
```

控制台也可以通过 SSH 隧道访问，避免暴露：

```bash
ssh -L 8765:127.0.0.1:8765 YOUR_USER@YOUR_VPS
# 本机打开 http://127.0.0.1:8765/console
```

---

## 5. 配置字段契约

加载器会为缺失的 `network`、`logging`、`deviceChannel`、`typesetter`、`server.worker` 填入默认对象。未知字段仍会被拒绝。

| 字段 | 必需 | 默认 | 约束 |
| --- | --- | --- | --- |
| `server.dataDir` | 是 | — | 服务独占目录；相对路径相对进程 cwd。 |
| `server.host` | 否 | `127.0.0.1` | 局域网用 `0.0.0.0`；公网保持 loopback。 |
| `server.port` | 否 | `8765` | `0` 表示随机端口。 |
| `server.timezone` | 否 | `UTC` | 合法 IANA 时区。 |
| `server.terminalPublishBudgetMs` | 否 | `20000` | 1000–120000。 |
| `server.maxHttpBodyBytes` | 否 | `262144` | 1024–16 MiB。 |
| `server.worker` | 否 | 见下 | 可省略整个块。 |
| `server.worker.leaseDurationMs` | 否 | `120000` | 1000–3600000。 |
| `server.worker.pollIntervalMs` | 否 | `2000` | 50–60000。 |
| `network.allowedHosts` | 否 | loopback 三项 | 必须包含请求的 Host 头；端口不参与匹配。 |
| `network.allowedOrigins` | 否 | `[]` | 空数组拒绝带 Origin 的跨源浏览器请求；`/mcp` 机器客户端和同源控制台请求不受影响。 |
| `auth.mode` | 是（配置了 `auth` 时） | — | 只能是 `static-bearer`。 |
| `auth.credentials[].credential_id` | 是 | — | `[A-Za-z0-9._:-]{1,128}`，不可重复。 |
| `auth.credentials[].caller_id` | 是 | — | 同上。 |
| `auth.credentials[].token_sha256` | 是 | — | 64 位小写 hex。 |
| `auth.credentials[].tool_view` | 否 | `internal` | **作者凭据必须写 `author`**。 |
| `auth.credentials[].revoked` | 否 | `false` | — |
| `auth.console_bearer_file` | 否 | — | 原始作者 Token 文件；相对路径相对配置文件目录。 |
| `deviceChannel.enabled` | 否 | `false` | — |
| `deviceChannel.owner_token_sha256` | 启用时是 | — | 64 位小写 hex。 |
| `deviceChannel.public_endpoint` | 否 | — | HTTPS，或私有/本地 HTTP；必须是根地址，无路径、查询、账号。 |
| `deviceChannel.channel_id` | 否 | `channel_default` | ID 模式。 |
| `deviceChannel.publisher_caller_ids` | 启用时是 | `[]` | 非空，且每个 caller 必须有未撤销的凭据。 |
| `deviceChannel.allowed_profiles` | 否 | 两种 profile | `epaper-540x960-gray4-v1`、`epaper-960x540-gray4-v1`。 |
| `deviceChannel.pairing_ttl_seconds` | 否 | `900` | 60–86400。 |
| `deviceChannel.pairing_max_attempts` | 否 | `5` | 1–20。 |
| `typesetter.enabled` | 否 | `false` | 启用时 endpoint/model/apiKeyEnv 必填；endpoint 需 HTTPS（loopback 除外）。 |
| `logging.level` | 否 | `info` | `debug` / `info` / `warn` / `error`。 |

配置错误在监听前发生，退出码 `2`。

---

## 6. MCP 接口

- 传输：Streamable HTTP，无会话。
- 地址：`http://<host>:<port>/mcp`。
- 认证：`Authorization: Bearer <作者Token>`。
- 作者凭据只看到两个工具：`ephemera_publish`、`ephemera_peek`。
- 没有 `initialize` 也可以直接 `tools/list` / `tools/call`（stateless fallback）。

### 6.1 `tools/list` 验收

```bash
AUTHOR_TOKEN='<作者原始Token>'
curl -sS -X POST http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $AUTHOR_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

期望 SSE 的 `data:` 行中包含且只包含：

```text
ephemera_publish, ephemera_peek
```

### 6.2 投稿冒烟

需要已配置 Chromium。测试数据目录里会真实产生一篇作品：

```bash
curl -sS -X POST http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $AUTHOR_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ephemera_publish","arguments":{"manuscript":{"schemaVersion":3,"intent":"note","body":"hello","genrePreference":"note"}}}}'
```

期望文本结果包含：

```json
{"status":"published","work":{"genre":"note","page_count":1}}
```

如果返回 `unsupported_glyph`，说明正文含字体子集未覆盖的字符；冒烟测试请用 ASCII。

### 6.3 语义

- `ephemera_publish` 每次调用生成新的 `request_id`；重试等于再投一篇，不会自动去重。
- 气象稿必须先调用 `ephemera_peek` 且 `scope=weather`，读取真实预报后再投稿。
- `ephemera_peek` 只返回调用者自己的作品；不是设备状态接口。
- `published` 只表示服务端已提交，不等于设备已缓存或已上屏。

---

## 7. 控制台与设备

### 7.1 控制台登录

- URL：`/console`
- 配置了 `deviceChannel.owner_token_sha256` 时，用对应的**原始管理员 Token**登录。
- 未配置管理员凭据时，首次启动在数据目录生成 `owner-bootstrap.txt`，用其中一次性凭据完成初始化。

### 7.2 设备首次配置（人类操作）

1. 在服务电脑上打开 `http://127.0.0.1:8765/console`，或在有 HTTPS 的设备上打开公网控制台。
2. 登录管理员。
3. **设备 → 第一次配置**。
4. 填写 2.4 GHz Wi-Fi、密码、设备名。
5. 确认服务器地址：
   - 局域网：`http://<电脑局域网IP>:8765`
   - VPS：`https://<域名>`
6. USB 连接设备，点击 **连接 USB 并安装**。

代理不能替代 Web Serial；到这一步应停下并把 URL、管理员 Bearer 文件位置和检查清单交给人类。

设备配对使用一次性码，默认 15 分钟、5 次尝试；码由安装流程自动生成。

### 7.3 设备通道配置要求

启用 `deviceChannel` 时：

- `owner_token_sha256` 必须存在。
- `publisher_caller_ids` 非空，且每个 caller 都有未撤销的凭据。
- `public_endpoint` 必须是设备可访问的根地址。
- 设备端只接受配置中 `allowed_profiles` 包含的灰度 profile。

---

## 8. 自定义图片

入口：控制台 **版式与落款**。

- 未上传时，标志与五种表情图显示黑白玫瑰占位图；便签辅助标志位使用内置几何装饰。
- 格式：PNG，单张 ≤ 2 MiB。透明背景是建议，服务只校验 PNG 和大小。
- 建议尺寸：

| 位置 | 建议原图 |
| --- | --- |
| 主标志 | 512 × 512 px |
| 辅助标志 | 256 × 256 px |
| 五种表情/角色图 | 640 × 480 px |

五种状态：普通、高兴、悲伤、思考、趴下。

上传接口是 `/admin/v1/console/personalization`，需要管理员会话和 CSRF；除非有浏览器自动化，优先让人类在控制台操作。

---

## 9. 故障排查

| 现象 | 检查 |
| --- | --- |
| 启动退出码 `2` | JSON 语法、未知字段、`token_sha256` 是否为 64 位小写 hex、时区是否合法。 |
| 退出码 `3` | 数据目录被另一个进程占用、锁文件不可读、schema 版本不支持。不要手动删除锁文件。 |
| 退出码 `4` | 端口被占用或 host 不可绑定。 |
| `renderer_unavailable` | `PLAYWRIGHT_BROWSERS_PATH` 未设置或目录不含 `chromium-1234` / `chromium_headless_shell-1234`。 |
| `/mcp` 返回 401 | 缺 Bearer 或 Token 与 `token_sha256` 不匹配。 |
| `/mcp` 返回 403 | Host 不在 `allowedHosts`，或凭据被撤销。 |
| VPS 代理返回 403 | Nginx 没传 `Host $host`，或 `allowedHosts` 缺少域名。 |
| 控制台返回 403 | Origin 不在 `allowedOrigins` 且不是同源请求。 |
| 设备连不上 VPS | `public_endpoint` 不是 HTTPS 根地址；Nginx 没转发 `/device/`；443 未放行。 |
| 上传图片 413 | Nginx `client_max_body_size` 太小；`/admin/` 至少 20m。 |
| Ubuntu 24.04 排版失败 | Chromium 沙箱/用户命名空间限制；看 `journalctl -u mooneink`。 |
| 中文投稿 `unsupported_glyph` | 字体子集未覆盖该字符；换字或先用 ASCII 冒烟。 |

---

## 10. 代理交付检查清单

- [ ] Node.js `>= 24`
- [ ] `npm ci && npm run build` 成功（源码路径）
- [ ] `PLAYWRIGHT_BROWSERS_PATH` 含 `chromium-1234` 和 `chromium_headless_shell-1234`
- [ ] 配置文件是 strict JSON，`server.dataDir` 为绝对路径
- [ ] 作者凭据 `tool_view` 为 `author`
- [ ] `deviceChannel.publisher_caller_ids` 与有效 `caller_id` 匹配
- [ ] `network.allowedHosts` 包含实际访问用的 Host
- [ ] 原始作者 Token 文件权限 `600`，且未提交
- [ ] 管理员原始 Token 只交给人类
- [ ] `/healthz` 返回 `{"status":"ok",...}`
- [ ] 作者 `tools/list` 恰好返回 `ephemera_publish`、`ephemera_peek`
- [ ] `/console` 可打开
- [ ] 设备刷机步骤已交给人类，且说明了 USB/Web Serial 限制
- [ ] 公网只开放 `/mcp` 与 `/device/`，控制台有限制来源
- [ ] 备份与迁移计划已与人类在停机窗口确认
