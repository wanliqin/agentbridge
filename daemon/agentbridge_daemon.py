#!/usr/local/bin/python3.13
"""AgentBridge daemon

- HTTP 127.0.0.1:10088  POST /command  {"action","args","session","browser"?}
- WS   127.0.0.1:10089  浏览器扩展主动出站连接端（MV3 service worker 无法监听端口）
- 鉴权：共享 token 存 ~/.agentbridge/identity.json（600），HTTP 用
  Authorization: Bearer <token>，WS 握手路径带 ?token=。
- 请求-响应配对：每条命令分配唯一 uuid，等待匹配 id 的回包（30s 超时），
  不匹配的消息直接忽略 —— 避免 CDP 式消息竞争。
- 多浏览器：扩展注册时上报 browser_id，HTTP 请求可选 "browser" 字段路由，
  默认路由到最近活跃的连接。

手动启动：直接运行本脚本（或经 scripts/install.sh --with-launchd 装 launchd）。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import secrets
import sys
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import websockets

# ---------------------------------------------------------------------------
# 路径与配置
# ---------------------------------------------------------------------------

ROOT = Path.home() / ".agentbridge"
IDENTITY_FILE = ROOT / "identity.json"
RECORDINGS_DIR = ROOT / "recordings"
SCREENSHOTS_DIR = ROOT / "screenshots"
LOGS_DIR = ROOT / "logs"

HTTP_HOST, HTTP_PORT = "127.0.0.1", 10088
WS_HOST, WS_PORT = "127.0.0.1", 10089
COMMAND_TIMEOUT = 30  # 扩展回包超时（秒）

for d in (ROOT, RECORDINGS_DIR, SCREENSHOTS_DIR, LOGS_DIR):
    d.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOGS_DIR / "daemon.log"),
        logging.StreamHandler(sys.stderr),
    ],
)
log = logging.getLogger("agentbridge")


def load_or_create_token() -> str:
    """读取共享 token；不存在则自生成（install.sh 也会生成，二者兼容）。"""
    if IDENTITY_FILE.exists():
        data = json.loads(IDENTITY_FILE.read_text())
        token = data.get("token")
        if token:
            return token
    token = secrets.token_hex(32)
    IDENTITY_FILE.write_text(json.dumps({"token": token, "created": time.time()}, indent=2))
    os.chmod(IDENTITY_FILE, 0o600)  # 仅属主可读写，token 不落日志
    log.info("已生成新 token: %s", IDENTITY_FILE)
    return token


TOKEN = load_or_create_token()

# ---------------------------------------------------------------------------
# WS 连接注册表与命令配对（全部归属 asyncio 事件循环线程）
# ---------------------------------------------------------------------------


class ExtensionConn:
    """一个已连接的浏览器扩展实例。"""

    def __init__(self, ws, browser_id: str):
        self.ws = ws
        self.browser_id = browser_id
        self.last_active = time.time()


extensions: dict[str, ExtensionConn] = {}       # browser_id → 连接
pending: dict[str, asyncio.Future] = {}          # 命令 id → Future（唯一 id 配对）
session_browser: dict[str, str] = {}             # session → browser_id 路由记忆
ws_loop: asyncio.AbstractEventLoop | None = None


class AgentBridgeError(Exception):
    """业务错误，code 会原样返回给 HTTP 调用方。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


async def ws_handler(ws) -> None:
    """扩展接入：校验 token + browser_id，之后只收命令回包。"""
    # websockets 15 新 API：握手信息在 ws.request（Request 对象）上
    query = urllib.parse.parse_qs(urllib.parse.urlparse(ws.request.path).query)
    token = (query.get("token") or [""])[0]
    if token != TOKEN:
        log.warning("WS 拒绝：token 错误，来自 %s", ws.remote_address)
        await ws.close(code=4401, reason="unauthorized")
        return
    browser_id = (query.get("browser_id") or [""])[0] or ("br-" + uuid.uuid4().hex[:8])

    # 同一 browser_id 重连时踢掉旧连接
    old = extensions.get(browser_id)
    if old is not None:
        try:
            await old.ws.close(code=4000, reason="replaced")
        except Exception:
            pass
    conn = ExtensionConn(ws, browser_id)
    extensions[browser_id] = conn
    log.info("扩展已连接: %s（当前 %d 个）", browser_id, len(extensions))
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            conn.last_active = time.time()
            mid = msg.get("id")
            fut = pending.get(mid) if mid else None
            if fut is None or fut.done():
                continue  # 关键：忽略不匹配/已完成的回包，防消息竞争
            pending.pop(mid, None)
            fut.set_result(msg)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        if extensions.get(browser_id) is conn:
            del extensions[browser_id]
        log.info("扩展已断开: %s（剩余 %d 个）", browser_id, len(extensions))


def pick_conn(browser: str | None, session: str | None) -> ExtensionConn:
    """路由：显式 browser > session 记忆 > 最近活跃连接。"""
    if not extensions:
        raise AgentBridgeError("NO_EXTENSION", "没有浏览器扩展连接。请确认 Chrome 已加载 AgentBridge 扩展且 daemon 地址/token 正确。")
    if browser:
        conn = extensions.get(browser)
        if conn is None:
            raise AgentBridgeError("BROWSER_NOT_FOUND", f"browser '{browser}' 未连接，已连接: {list(extensions)}")
        return conn
    if session and session in session_browser:
        conn = extensions.get(session_browser[session])
        if conn is not None:
            return conn
    return max(extensions.values(), key=lambda c: c.last_active)


async def route_command(action: str, args: dict, session: str | None, browser: str | None, timeout: float = COMMAND_TIMEOUT) -> dict:
    """把命令发给扩展并等待匹配 id 的回包。"""
    conn = pick_conn(browser, session)
    cmd_id = uuid.uuid4().hex
    fut = ws_loop.create_future()
    pending[cmd_id] = fut
    try:
        await conn.ws.send(json.dumps({
            "type": "command", "id": cmd_id,
            "action": action, "args": args or {}, "session": session,
        }))
        reply = await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError:
        raise AgentBridgeError("TIMEOUT", f"扩展响应超时（{timeout}s），action={action}")
    finally:
        pending.pop(cmd_id, None)
    conn.last_active = time.time()
    if session:
        session_browser[session] = conn.browser_id
    if not reply.get("ok"):
        raise AgentBridgeError("EXTENSION_ERROR", str(reply.get("error", "unknown")))
    return reply.get("result")


# ---------------------------------------------------------------------------
# record：事件落盘与回放（start/stop 由扩展执行，list 本地，replay 逐条回放）
# ---------------------------------------------------------------------------


def recording_path(name: str) -> Path:
    safe = "".join(c for c in name if c.isalnum() or c in "-_")
    if not safe:
        raise AgentBridgeError("BAD_ARGS", "record 需要合法的 name（字母数字-_）")
    return RECORDINGS_DIR / f"{safe}.json"


# 记录每个 session 正在进行的录制名，stop 不带 --name 时沿用 start 的名字
active_record_names: dict[tuple[str, str], str] = {}


async def handle_record(args: dict, session: str | None, browser: str | None) -> dict:
    op = args.get("op")
    if op == "list":
        items = []
        for p in sorted(RECORDINGS_DIR.glob("*.json")):
            try:
                data = json.loads(p.read_text())
                items.append({"name": p.stem, "events": len(data.get("events", [])), "saved_at": data.get("saved_at")})
            except Exception:
                items.append({"name": p.stem, "events": None, "error": "无法解析"})
        return {"count": len(items), "recordings": items}

    rkey = (browser or "", session or "")
    if op == "start":
        name = args.get("name") or session or "default"
        active_record_names[rkey] = name
        result = await route_command("record", {"op": "start"}, session, browser)
        result["name"] = name
        return result

    name = args.get("name") or active_record_names.get(rkey) or session or "default"
    path = recording_path(name)

    if op == "stop":
        result = await route_command("record", {"op": "stop"}, session, browser)
        events = result.get("events", [])
        path.write_text(json.dumps({"name": name, "saved_at": time.time(), "events": events}, ensure_ascii=False, indent=2))
        active_record_names.pop(rkey, None)
        return {"stopped": True, "name": name, "count": len(events), "path": str(path)}

    if op == "replay":
        if not path.exists():
            raise AgentBridgeError("NOT_FOUND", f"录制不存在: {path}")
        events = json.loads(path.read_text()).get("events", [])
        interval = float(args.get("interval", 0.3))  # 回放间隔，默认 300ms
        played, errors = 0, []
        for i, evt in enumerate(events):
            etype = evt.get("type")
            try:
                if etype == "click":
                    await route_command("click", {"selector": evt["selector"], "trusted": True}, session, browser)
                elif etype in ("input", "change"):
                    if evt.get("value") is not None:
                        await route_command("fill", {"selector": evt["selector"], "value": evt["value"]}, session, browser)
                elif etype == "keydown" and evt.get("key"):
                    await route_command("press", {"key": evt["key"], "selector": evt.get("selector")}, session, browser)
                # submit 事件通常由 Enter/click 触发，跳过避免重复提交
                played += 1
            except AgentBridgeError as e:
                errors.append({"index": i, "event": evt.get("type"), "error": e.message})
            if i < len(events) - 1:
                await asyncio.sleep(interval)
        return {"replayed": played, "total": len(events), "errors": errors, "name": name}

    raise AgentBridgeError("BAD_ARGS", "record 需要 args.op: start|stop|list|replay")


# ---------------------------------------------------------------------------
# 动作分发（HTTP 线程 → asyncio 桥接在此汇合）
# ---------------------------------------------------------------------------


async def dispatch(action: str, args: dict, session: str | None, browser: str | None) -> dict:
    if action == "record":
        return await handle_record(args, session, browser)

    if action == "status":
        return {
            "daemon": "ok",
            "browsers": [{"browser_id": c.browser_id, "last_active": c.last_active} for c in extensions.values()],
            "sessions": dict(session_browser),
        }

    result = await route_command(action, args, session, browser)

    # base64 产物统一在 daemon 侧落盘
    if action == "screenshot" and isinstance(result, dict) and result.get("base64"):
        return save_binary(result, default_ext=result.get("format", "jpeg"), out_dir=SCREENSHOTS_DIR)
    if action == "save_as_pdf" and isinstance(result, dict) and result.get("base64"):
        return save_binary(result, default_ext="pdf", out_dir=ROOT / "pdfs")
    return result


def save_binary(result: dict, default_ext: str, out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    raw = base64.b64decode(result["base64"])
    path = result.get("path")
    if not path:
        path = str(out_dir / f"{int(time.time() * 1000)}.{default_ext}")
    Path(path).expanduser().write_bytes(raw)
    return {"format": result.get("format", default_ext), "path": path, "sizeBytes": len(raw)}


def dispatch_sync(action: str, args: dict, session: str | None, browser: str | None, timeout: float) -> dict:
    """HTTP 线程 → asyncio WS 循环的桥接。"""
    future = asyncio.run_coroutine_threadsafe(dispatch(action, args, session, browser), ws_loop)
    try:
        return future.result(timeout=timeout)
    except AgentBridgeError:
        raise
    except Exception as e:
        # 含 concurrent.futures.TimeoutError
        raise AgentBridgeError("INTERNAL", f"{type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# HTTP 服务（stdlib ThreadingHTTPServer）
# ---------------------------------------------------------------------------


class CommandHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):  # 静默默认访问日志（含路径里的敏感信息）
        pass

    def _send(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        auth = self.headers.get("Authorization", "")
        return auth == f"Bearer {TOKEN}"

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"code": 0, "result": {"status": "ok", "browsers": len(extensions)}})
            return
        if self.path.startswith("/file"):
            self._serve_file()
            return
        self._send(404, {"code": "NOT_FOUND", "message": "仅支持 POST /command"})

    def _serve_file(self):
        """GET /file?path=<绝对路径>：供扩展拉取本地文件字节（browser_upload 用）。
        chrome.debugger 会话被 Chromium 禁止调 DOM.setFileInputFiles（Not allowed），
        文件经此通道交给扩展合成注入页面。"""
        if not self._authorized():
            self._send(401, {"code": "UNAUTHORIZED", "message": "token 无效，请检查 ~/.agentbridge/identity.json"})
            return
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        path = (query.get("path") or [""])[0]
        p = Path(path)
        if not path or not p.is_absolute() or not p.is_file():
            self._send(404, {"code": "NOT_FOUND", "message": f"文件不存在或不是绝对路径: {path}"})
            return
        try:
            data = p.read_bytes()
        except Exception as e:
            self._send(500, {"code": "READ_ERROR", "message": f"读取文件失败: {e}"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        log.info("已通过 /file 提供文件: %s（%d 字节）", path, len(data))

    def do_POST(self):
        if self.path != "/command":
            self._send(404, {"code": "NOT_FOUND", "message": "仅支持 POST /command"})
            return
        if not self._authorized():
            self._send(401, {"code": "UNAUTHORIZED", "message": "token 无效，请检查 ~/.agentbridge/identity.json"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send(400, {"code": "BAD_JSON", "message": "请求体必须是 JSON"})
            return

        action = body.get("action")
        args = body.get("args") or {}
        session = body.get("session")
        browser = body.get("browser")
        if not action:
            self._send(400, {"code": "BAD_ARGS", "message": "缺少 action 字段"})
            return

        # replay 耗时长（事件数 × 间隔），放宽 HTTP 侧等待；
        # wait / wait_new_tab 按调用方给的 timeout 放宽（扩展端上限 60s）
        if action == "record" and args.get("op") == "replay":
            wait = 600
        elif action in ("wait", "wait_new_tab"):
            wait = min(args.get("timeout", 10000) / 1000, 60) + 10
        else:
            wait = COMMAND_TIMEOUT + 5
        try:
            result = dispatch_sync(action, args, session, browser, timeout=wait)
            self._send(200, {"code": 0, "result": result})
        except AgentBridgeError as e:
            status = 504 if e.code == "TIMEOUT" else (503 if e.code in ("NO_EXTENSION", "BROWSER_NOT_FOUND") else 500)
            self._send(status, {"code": e.code, "message": e.message})


def run_ws_server() -> None:
    """独立线程跑 asyncio WS 服务。"""
    global ws_loop
    ws_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(ws_loop)

    async def keepalive_loop():
        """每 25s 给所有扩展发应用层消息。

        MV3 SW 约 30s 无活动就被 Chrome 回收，WS 协议层 ping/pong 不算活动，
        但收到应用层 WS 消息会重置 idle 计时器（Chrome 116+）。扩展端会忽略
        type != "command" 的消息，所以这只是保活帧。
        """
        while True:
            await asyncio.sleep(25)
            for conn in list(extensions.values()):
                try:
                    await conn.ws.send(json.dumps({"type": "keepalive"}))
                except Exception:
                    pass  # 发送失败说明连接正在关闭，由 ws_handler 清理

    async def main():
        # max_size 必须放大：截图/PDF 的 base64 回包可达数 MB（默认 1MiB 会直接把连接掐掉）
        async with websockets.serve(ws_handler, WS_HOST, WS_PORT, ping_interval=20, ping_timeout=20, max_size=100 * 1024 * 1024):
            log.info("WS 服务已启动: ws://%s:%d", WS_HOST, WS_PORT)
            asyncio.create_task(keepalive_loop())
            await asyncio.Future()  # 永久运行

    ws_loop.run_until_complete(main())


def main() -> None:
    t = threading.Thread(target=run_ws_server, name="ws-loop", daemon=True)
    t.start()
    # 等 WS loop 就绪
    for _ in range(100):
        if ws_loop is not None and ws_loop.is_running():
            break
        time.sleep(0.05)

    server = ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), CommandHandler)
    log.info("HTTP 服务已启动: http://%s:%d/command", HTTP_HOST, HTTP_PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("收到中断，退出")
        server.shutdown()


if __name__ == "__main__":
    main()
