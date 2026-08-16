#!/bin/bash
# AgentBridge 安装脚本
# 1) 生成共享 token → ~/.agentbridge/identity.json（600，已存在则不覆盖）
# 2) 把 token 写入扩展 config.js（扩展 WS 握手用）
# 3) 软链 CLI → ~/.local/bin/agentbridge
# 4) 可选 --with-launchd：生成并加载 launchd 自启 plist
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AB_DIR="$HOME/.agentbridge"
IDENTITY="$AB_DIR/identity.json"
PLIST="$HOME/Library/LaunchAgents/com.agentbridge.daemon.plist"

mkdir -p "$AB_DIR"/{recordings,screenshots,logs,pdfs} "$HOME/.local/bin"

# --- 1) token：不存在才生成 --------------------------------------------------
if [ ! -f "$IDENTITY" ]; then
  TOKEN="$(openssl rand -hex 32)"
  printf '{\n  "token": "%s",\n  "created": %s\n}\n' "$TOKEN" "$(date +%s)" > "$IDENTITY"
  chmod 600 "$IDENTITY"
  echo "[install] 已生成 token -> ${IDENTITY} (chmod 600)"
else
  chmod 600 "$IDENTITY"
  TOKEN="$(/usr/bin/python3 -c "import json;print(json.load(open('$IDENTITY'))['token'])")"
  echo "[install] 复用已有 token"
fi

# --- 2) 扩展 config.js -------------------------------------------------------
cat > "$PROJECT_DIR/extension/config.js" <<EOF
// AgentBridge 扩展配置文件 —— 由 scripts/install.sh 生成，请勿手改。
// token 与 ~/.agentbridge/identity.json 保持一致，仅用于本机 loopback 连接。
const AGENTBRIDGE_TOKEN = "$TOKEN";
const AGENTBRIDGE_WS_URL = "ws://127.0.0.1:10089/";
EOF
echo "[install] 已写入 extension/config.js"

# --- 3) CLI 软链 -------------------------------------------------------------
chmod +x "$PROJECT_DIR/cli/agentbridge" "$PROJECT_DIR/daemon/agentbridge_daemon.py"
ln -sf "$PROJECT_DIR/cli/agentbridge" "$HOME/.local/bin/agentbridge"
echo "[install] CLI 已软链 → ~/.local/bin/agentbridge"

# --- 4) 可选 launchd ----------------------------------------------------------
if [ "${1:-}" = "--with-launchd" ]; then
  # 注意：launchd 拉起的进程以 launchd 为责任主体，没有 ~/Documents 的 TCC 权限
  # （再叠加上 EDR 拦截，open() 会直接挂死，实测复现）。所以 daemon 必须拷贝到
  # Documents 之外运行，不能用 Documents 里的路径或软链。
  mkdir -p "$AB_DIR/bin"
  cp "$PROJECT_DIR/daemon/agentbridge_daemon.py" "$AB_DIR/bin/agentbridge_daemon.py"
  echo "[install] daemon 已拷贝 → $AB_DIR/bin/agentbridge_daemon.py（workspace 为源码主副本）"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentbridge.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/python3.13</string>
    <string>$AB_DIR/bin/agentbridge_daemon.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$AB_DIR/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$AB_DIR/logs/launchd.err.log</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "[install] launchd 已加载 → $PLIST"
else
  echo "[install] 跳过 launchd（需要开机自启请运行: $0 --with-launchd）"
  echo "[install] 手动启动 daemon: $PROJECT_DIR/daemon/agentbridge_daemon.py"
fi

echo "[install] 完成。下一步：chrome://extensions 开发者模式 → 加载已解压扩展 → 选择 $PROJECT_DIR/extension"
