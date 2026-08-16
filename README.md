# AgentBridge

通用 AI 浏览器控制插件：任何 AI/Agent 通过本地接口完全操控 Chromium 浏览器 —— 标签页管理、快照/内容提取、点击/填表（含 **trusted 真实输入事件**）、截图、流量监听、操作录制回放、原始 CDP 透传。

## 架构

MV3 service worker 无法监听端口，因此**扩展主动 WebSocket 出站连接 daemon**，daemon 对外提供 HTTP：

```
任何 AI/Agent ──HTTP POST /command──> daemon 127.0.0.1:10088
 (curl / CLI / MCP)                   │ 路由 + token 鉴权 + id 配对(30s 超时)
                                      └──WebSocket :10089──> 扩展 background.js
                                                                ├── content.js: 快照/@e refs/录制/填充/提取
                                                                └── chrome.debugger: trusted 输入/网络监听/PDF/CDP
```

- 鉴权：共享 token 存 `~/.agentbridge/identity.json`（600 权限）。HTTP 用 `Authorization: Bearer <token>`，扩展 WS 握手路径带 `?token=`。daemon 只绑 127.0.0.1。
- 多浏览器：多个扩展可同时连接，各自上报随机 `browser_id`（存 `chrome.storage.local`）。HTTP 请求可选 `"browser"` 字段指定目标，默认路由到最近活跃连接；`session` 命中过的浏览器会被记忆。
- session 语义（WebBridge 兼容）：**一个 session = 一个 Chrome tab group**，`group_title` 设组名，`close_session` 关整组。

## 安装

```bash
cd ~/Documents/kimi/workspace/agentbridge
./scripts/install.sh                 # 生成 token、写扩展 config.js、软链 CLI
./scripts/install.sh --with-launchd  # 可选：launchd 开机自启 daemon
```

手动启动 daemon（不装 launchd 时每次需要）：

```bash
~/Documents/kimi/workspace/agentbridge/daemon/agentbridge_daemon.py
```

加载扩展到 Chrome：`chrome://extensions` → 打开**开发者模式** → **加载已解压的扩展程序** → 选择 `extension/` 目录。扩展连上后 daemon 日志出现 `扩展已连接: br-xxxx`。

### Chrome 137+ 的 --load-extension 限制（重要）

品牌版 Google Chrome 137+ 已**忽略** `--load-extension`（启动日志明确报 `--load-extension is not allowed in Google Chrome, ignoring`），所以：

- **日常 Chrome**：只能手动按上面步骤加载一次（持久化在 profile，之后自动生效）。
- **AI 浏览器**（`~/.local/bin/launch-ai-browser.py`）：每次启动自动通过 CDP `Extensions.loadUnpacked`（browser 级 WebSocket，9222 端口）装载 workspace 里的最新代码，无需手动操作。注意 `Extensions.loadUnpacked` **不持久化**，重启后必须重新装载——这正是启动脚本每次装一遍的原因。同理，**绝不能**给启动参数加 `--disable-extensions-except`，它会把手动/CDP 加载的扩展禁用掉。

### launchd 自启的 TCC 坑

launchd 拉起的进程以 launchd 为责任主体，**没有 ~/Documents 的 TCC 权限**（叠加 EDR 拦截时 `open()` 直接挂死）。因此 `install.sh --with-launchd` 会把 daemon **拷贝**到 `~/.agentbridge/bin/` 运行，workspace 仍是源码主副本——改了 `daemon/agentbridge_daemon.py` 后需重跑 `install.sh --with-launchd` 让拷贝生效。

## 动作表

| action | 关键参数 | 说明 |
|---|---|---|
| `navigate` | `url`, `group_title?` | 导航 session 当前 tab；首次自动建 tab group |
| `find_tab` | `url?`, `title?` | 按子串找 tab，首个匹配设为 session 活跃 tab |
| `list_tabs` | — | 全部 tab（含 group 信息） |
| `close_tab` | `tab_id?` | 关指定/活跃 tab |
| `close_session` | — | 关整个 tab group |
| `snapshot` | `frame?` | a11y 文本树，元素打 `@eN` ref；穿透 open shadow DOM；`frame` 指定 iframe（frameId/序号/url 子串） |
| `click` | `ref`/`selector`, `trusted?`, `frame?` | 默认 synthetic；`trusted=true` 走 debugger 真实点击（坐标基于顶层视口，iframe 内请用 synthetic） |
| `fill` | `ref`/`selector`, `value`, `frame?` | input/textarea/contenteditable，clear-and-insert |
| `type` | `text`, `ref`/`selector?`, `delay?`, `frame?` | **trusted** 键盘输入；`delay>0` 逐字符模拟真人打字，`delay=0` 用 `Input.insertText` |
| `wait` | `ref`/`selector` 或 `text`, `state?`, `timeout?` | MutationObserver 等元素/文本出现（visible）或消失（gone），免轮询 |
| `wait_new_tab` | `url?`, `timeout?` | 等 `window.open` 新 tab，自动纳入 session 的 tab group 并设为活跃 |
| `dialog` | `op=start|stop`, `accept?`, `prompt_text?` | 自动应答 alert/confirm/prompt，防止自动化被对话框卡死 |
| `frames` | — | 列出活跃 tab 的全部 frame（配合 `frame` 参数使用） |
| `evaluate` | `expression`, `frame?` | MAIN world，支持 async/await，returnByValue |
| `screenshot` | `format`, `quality?`, `path?`, `full?` | 存 `~/.agentbridge/screenshots/` 或指定路径；`full=true` 走 CDP 截全页 |
| `upload` | `selector`, `files[]` | debugger `DOM.setFileInputFiles` |
| `save_as_pdf` | `path?`, `landscape?` | debugger `Page.printToPDF` |
| `network` | `op=start|stop|list|detail`, `request_id?` | Network domain；detail 含 headers+body |
| `cdp` | `method`, `params?` | chrome.debugger 原始透传 |
| `press` | `key`, `selector?` | **trusted** 键盘事件（可选先聚焦）；支持组合键 `Control+A`/`Shift+Enter` |
| `hover` | `ref`/`selector` | **trusted** 悬停 |
| `select` | `ref`/`selector`, `value`/`label`/`index` | 下拉框选值 |
| `scroll` | `direction`, `amount` 或 `selector` | 滚动窗口；带 `selector`+`direction` 时为容器内滚动（聊天记录、长列表 div） |
| `record` | `op=start|stop|list|replay`, `name?` | 录制存 `~/.agentbridge/recordings/<name>.json`；replay 用 trusted 点击回放 |
| `extract` | `mode=text|markdown|dom` | 正文提取 / 转 markdown / 完整渲染 DOM |

**trusted 事件**（`press`/`hover`/`click trusted`）经 `chrome.debugger Input.dispatch*Event` 发送，`isTrusted=true`，可通过检测 synthetic 事件的站点。

## curl 示例

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.agentbridge/identity.json'))['token'])")
H="Authorization: Bearer $TOKEN"
U=http://127.0.0.1:10088/command

curl -s -X POST $U -H "$H" -d '{"action":"navigate","args":{"url":"https://example.com"},"session":"demo"}'
curl -s -X POST $U -H "$H" -d '{"action":"snapshot","session":"demo"}'
curl -s -X POST $U -H "$H" -d '{"action":"extract","args":{"mode":"text"},"session":"demo"}'
curl -s -X POST $U -H "$H" -d '{"action":"screenshot","args":{"format":"jpeg"},"session":"demo"}'
curl -s -X POST $U -H "$H" -d '{"action":"network","args":{"op":"start"},"session":"demo"}'
curl -s -X POST $U -H "$H" -d '{"action":"close_session","session":"demo"}'
```

错误格式统一为 `{"code": "...", "message": "..."}`（如 `NO_EXTENSION`/`TIMEOUT`/`UNAUTHORIZED`）。

## CLI

```bash
agentbridge navigate https://example.com --session demo
agentbridge snapshot --session demo
agentbridge click @e3 --trusted --session demo
agentbridge fill @e5 "hello" --session demo
agentbridge network start --session demo
agentbridge record start --name login --session demo
agentbridge press Enter --selector "#q" --session demo
agentbridge tabs
agentbridge close session --session demo
```

输出均为 JSON，`code=0` 成功。

## MCP 配置

```json
{
  "mcpServers": {
    "agentbridge": {
      "command": "/Users/liqinwan/.local/share/uv/tools/kimi-cli/bin/python3",
      "args": ["/Users/liqinwan/Documents/kimi/workspace/agentbridge/mcp/agentbridge_mcp.py"]
    }
  }
}
```

tools：`browser_navigate` / `browser_snapshot` / `browser_click` / `browser_fill` / `browser_type` / `browser_wait` / `browser_wait_new_tab` / `browser_dialog` / `browser_frames` / `browser_evaluate` / `browser_screenshot` / `browser_press` / `browser_hover` / `browser_select` / `browser_scroll` / `browser_extract` / `browser_network` / `browser_record` / `browser_tabs` / `browser_find_tab` / `browser_close_tab` / `browser_close_session` / `browser_upload` / `browser_save_as_pdf` / `browser_cdp` / `browser_status`。

## chrome.debugger 黄条说明

`chrome.debugger` attach 时浏览器顶部会出现"正在调试此浏览器"黄条。AgentBridge 的纪律：

- `network start` / `dialog start` 后**保持 attach**（监听必需），对应 `stop` 立即 detach；
- trusted 输入 / PDF / CDP 透传**按需 attach，用完即 detach**（同 tab 自动串行排队），黄条只闪现；
- 用户手动点黄条"取消"会导致正在进行的网络监听/对话框应答失效（状态自动清理，可重新 start）。

## token 安全

- daemon 仅绑定 `127.0.0.1`，不暴露局域网；
- `identity.json` 权限 600，token 不写入任何日志；
- HTTP 无 token 一律 401；WS 握手 token 错误直接关闭（4401）；
- 泄露处置：删除 `~/.agentbridge/identity.json` 后重跑 `install.sh` 并重载扩展。

## 已知限制

- 快照只覆盖视口上下约两屏内的可交互元素（控制体积）；
- closed shadow root 无法穿透（平台限制）；
- iframe 内元素的 **trusted** 点击/悬停坐标基于顶层视口会偏移，iframe 内请用 synthetic 点击；
- `record` 不录制密码框实际值（落盘为 `***`），replay 无法还原密码输入；
- replay 按 selector 回放，页面结构大变后可能失败；
- 扩展 SW 被回收后 session 映射按 tab group 标题重建，手动改组名会导致 session 失联。
