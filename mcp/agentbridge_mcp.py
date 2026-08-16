#!/Users/liqinwan/.local/share/uv/tools/kimi-cli/bin/python3
"""AgentBridge MCP Server — FastMCP stdio wrapper

把 AgentBridge daemon 的全部动作暴露为 MCP tools，内部经 HTTP 调
127.0.0.1:10088/command（带 Bearer token，token 从 ~/.agentbridge/identity.json 读取）。

用法 (MCP 配置):
  {
    "mcpServers": {
      "agentbridge": {
        "command": "/Users/liqinwan/.local/share/uv/tools/kimi-cli/bin/python3",
        "args": ["/Users/liqinwan/Documents/kimi/workspace/agentbridge/mcp/agentbridge_mcp.py"]
      }
    }
  }
"""

from __future__ import annotations

import json
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict, List, Optional

from mcp.server.fastmcp import FastMCP

DAEMON_URL = "http://127.0.0.1:10088/command"
IDENTITY_FILE = Path.home() / ".agentbridge" / "identity.json"


def _token() -> str:
    try:
        return json.loads(IDENTITY_FILE.read_text())["token"]
    except Exception as e:
        raise RuntimeError(f"无法读取 token（{IDENTITY_FILE}），请先运行 scripts/install.sh: {e}")


def _call(action: str, args: Optional[Dict[str, Any]] = None, session: str = "default",
          browser: Optional[str] = None, timeout: float = 60.0) -> Dict[str, Any]:
    """统一调用 daemon，错误格式 {code, message} 转为可读报错。"""
    body: Dict[str, Any] = {"action": action, "args": args or {}, "session": session}
    if browser:
        body["browser"] = browser
    req = urllib.request.Request(
        DAEMON_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {_token()}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8"))
            raise RuntimeError(f"[{payload.get('code')}] {payload.get('message')}")
        except json.JSONDecodeError:
            raise RuntimeError(f"daemon HTTP {e.code}: {e.reason}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"无法连接 daemon（127.0.0.1:10088），请先启动 daemon/agentbridge_daemon.py: {e.reason}")
    return payload.get("result")


mcp = FastMCP("agentbridge")


@mcp.tool()
def browser_status() -> Dict[str, Any]:
    """Check daemon status and connected browser extensions."""
    return _call("status")


@mcp.tool()
def browser_navigate(url: str, session: str = "default", group_title: Optional[str] = None) -> Dict[str, Any]:
    """Navigate a session's tab to a URL. A session maps to a Chrome tab group (created on first use)."""
    args: Dict[str, Any] = {"url": url}
    if group_title:
        args["group_title"] = group_title
    return _call("navigate", args, session)


@mcp.tool()
def browser_snapshot(session: str = "default") -> Dict[str, Any]:
    """Get an accessibility snapshot of the current page with interactive elements marked by @e refs."""
    return _call("snapshot", {}, session)


@mcp.tool()
def browser_click(ref: Optional[str] = None, selector: Optional[str] = None,
                  trusted: bool = False, session: str = "default") -> Dict[str, Any]:
    """Click an element by @e ref (from snapshot) or CSS selector. trusted=True sends a real OS-level click via chrome.debugger (isTrusted=true)."""
    return _call("click", {"ref": ref, "selector": selector, "trusted": trusted}, session)


@mcp.tool()
def browser_fill(value: str, ref: Optional[str] = None, selector: Optional[str] = None,
                 session: str = "default") -> Dict[str, Any]:
    """Fill an input/textarea/contenteditable element (clear-and-insert) by @e ref or CSS selector."""
    return _call("fill", {"ref": ref, "selector": selector, "value": value}, session)


@mcp.tool()
def browser_evaluate(expression: str, session: str = "default") -> Dict[str, Any]:
    """Evaluate a JavaScript expression in the page MAIN world (async/await supported)."""
    return _call("evaluate", {"expression": expression}, session)


@mcp.tool()
def browser_screenshot(format: str = "jpeg", quality: Optional[int] = None,
                       path: Optional[str] = None, full: bool = False,
                       session: str = "default") -> Dict[str, Any]:
    """Capture the tab. full=True captures the whole page (beyond viewport). Saved to ~/.agentbridge/screenshots/ or the given path."""
    args: Dict[str, Any] = {"format": format}
    if quality is not None:
        args["quality"] = quality
    if path:
        args["path"] = path
    if full:
        args["full"] = True
    return _call("screenshot", args, session)


@mcp.tool()
def browser_press(key: str, selector: Optional[str] = None, session: str = "default") -> Dict[str, Any]:
    """Press a key as a trusted event. Supports single keys (Enter, Escape, ArrowDown, a, ...) and combos (Control+A, Shift+Enter, Meta+Shift+P). Optionally focus a selector first."""
    return _call("press", {"key": key, "selector": selector}, session)


@mcp.tool()
def browser_hover(ref: Optional[str] = None, selector: Optional[str] = None,
                  session: str = "default") -> Dict[str, Any]:
    """Hover over an element by @e ref or CSS selector (trusted mouse event)."""
    return _call("hover", {"ref": ref, "selector": selector}, session)


@mcp.tool()
def browser_select(ref: Optional[str] = None, selector: Optional[str] = None,
                   value: Optional[str] = None, label: Optional[str] = None,
                   index: Optional[int] = None, session: str = "default") -> Dict[str, Any]:
    """Select an option in a <select> dropdown by value, label, or index."""
    return _call("select", {"ref": ref, "selector": selector, "value": value, "label": label, "index": index}, session)


@mcp.tool()
def browser_scroll(direction: str = "down", amount: int = 800,
                   selector: Optional[str] = None, session: str = "default") -> Dict[str, Any]:
    """Scroll the page (up/down/left/right/top/bottom) or scroll an element into view."""
    return _call("scroll", {"direction": direction, "amount": amount, "selector": selector}, session)


@mcp.tool()
def browser_extract(mode: str = "text", session: str = "default") -> Dict[str, Any]:
    """Extract page content: mode=text (Readability-style main content), markdown (headings/lists/links as md), dom (full rendered outerHTML)."""
    return _call("extract", {"mode": mode}, session)


@mcp.tool()
def browser_network(op: str, request_id: Optional[str] = None, session: str = "default") -> Dict[str, Any]:
    """Network capture via chrome.debugger: op=start|stop|list|detail. detail needs request_id and returns headers+body."""
    args: Dict[str, Any] = {"op": op}
    if request_id:
        args["request_id"] = request_id
    return _call("network", args, session)


@mcp.tool()
def browser_record(op: str, name: Optional[str] = None, session: str = "default") -> Dict[str, Any]:
    """Record user interactions: op=start|stop|list|replay. Recordings are stored at ~/.agentbridge/recordings/<name>.json; replay re-plays with trusted clicks."""
    args: Dict[str, Any] = {"op": op}
    if name:
        args["name"] = name
    return _call("record", args, session, timeout=600.0)


@mcp.tool()
def browser_tabs(session: str = "default") -> Dict[str, Any]:
    """List all browser tabs with group info."""
    return _call("list_tabs", {}, session)


@mcp.tool()
def browser_find_tab(url: Optional[str] = None, title: Optional[str] = None,
                     session: str = "default") -> Dict[str, Any]:
    """Find tabs by URL/title substring; the first match becomes the session's active tab."""
    return _call("find_tab", {"url": url, "title": title}, session)


@mcp.tool()
def browser_close_tab(tab_id: Optional[int] = None, session: str = "default") -> Dict[str, Any]:
    """Close a tab by id, or the session's active tab when omitted."""
    return _call("close_tab", {"tab_id": tab_id}, session)


@mcp.tool()
def browser_close_session(session: str = "default") -> Dict[str, Any]:
    """Close the whole session (its Chrome tab group and all tabs in it)."""
    return _call("close_session", {}, session)


@mcp.tool()
def browser_upload(selector: str, files: List[str], session: str = "default") -> Dict[str, Any]:
    """Set files on a file input (<input type=file>) matched by CSS selector. files are absolute paths."""
    return _call("upload", {"selector": selector, "files": files}, session)


@mcp.tool()
def browser_save_as_pdf(path: Optional[str] = None, landscape: bool = False,
                        session: str = "default") -> Dict[str, Any]:
    """Save the current page as PDF (chrome.debugger Page.printToPDF)."""
    return _call("save_as_pdf", {"path": path, "landscape": landscape}, session)


@mcp.tool()
def browser_cdp(method: str, params: Optional[Dict[str, Any]] = None,
                session: str = "default") -> Dict[str, Any]:
    """Raw CDP passthrough via chrome.debugger: any method + params."""
    return _call("cdp", {"method": method, "params": params or {}}, session)


if __name__ == "__main__":
    mcp.run()
