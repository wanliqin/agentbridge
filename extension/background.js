// AgentBridge background service worker (MV3)
// 职责：作为 WebSocket 客户端主动出站连本地 daemon（MV3 SW 无法监听端口），
// 接收命令后分发执行（chrome.* API / content.js / chrome.debugger），再回包。
// 请求-响应通过唯一 id 配对，daemon 侧等待匹配 id，避免消息竞争。

importScripts("config.js"); // 提供 AGENTBRIDGE_TOKEN / AGENTBRIDGE_WS_URL

// ---------------------------------------------------------------------------
// 常量与状态
// ---------------------------------------------------------------------------

const WS_URL = (typeof AGENTBRIDGE_WS_URL !== "undefined" && AGENTBRIDGE_WS_URL) || "ws://127.0.0.1:10089/";
const TOKEN = (typeof AGENTBRIDGE_TOKEN !== "undefined" && AGENTBRIDGE_TOKEN) || "";
const KEEPALIVE_ALARM = "agentbridge-keepalive";

let ws = null;
let wsOpen = false;
let reconnectDelay = 1000; // 指数退避：1s → 2s → ... → 30s 封顶
let browserId = null;

// session 名 → { groupId, activeTabId }。SW 可能被回收，丢失后按 tabGroup 标题重建。
const sessions = new Map();
// 正在进行网络监听的 tabId → { requests: Map(requestId → entry), order: [requestId] }
const networkSessions = new Map();
// 正在自动应答 JS 对话框的 tabId → { accept, promptText }
const dialogSessions = new Map();
// session 名 → frameId（最后一次 snapshot 所在 frame，ref 类操作路由回同一 frame）
const sessionFrames = new Map();

// ---------------------------------------------------------------------------
// browser_id：随机生成并持久化，多浏览器/多扩展实例借此区分
// ---------------------------------------------------------------------------

async function getBrowserId() {
  if (browserId) return browserId;
  const data = await chrome.storage.local.get("agentbridge_browser_id");
  if (data.agentbridge_browser_id) {
    browserId = data.agentbridge_browser_id;
  } else {
    browserId = "br-" + crypto.randomUUID();
    await chrome.storage.local.set({ agentbridge_browser_id: browserId });
  }
  return browserId;
}

// ---------------------------------------------------------------------------
// WebSocket 客户端（指数退避自动重连）
// ---------------------------------------------------------------------------

let connecting = false; // 防止并发 connectWS（guard 竞态会产生僵尸重连链）

async function connectWS() {
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  try {
    const bid = await getBrowserId();
    const url = WS_URL + "?token=" + encodeURIComponent(TOKEN) + "&browser_id=" + encodeURIComponent(bid);
    // 关键：用局部变量持有本次 socket。onclose 里若发现全局 ws 已指向
    // 别的连接（被 daemon 以 4000 replaced 踢掉的旧连接），直接忽略，
    // 绝不再触发重连——否则两个连接互相踢会形成无限重连链。
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return; // 过期连接，忽略
      wsOpen = true;
      reconnectDelay = 1000; // 连上后重置退避
      console.log("[AgentBridge] WS connected as", bid);
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      handleCommand(ev.data).catch((e) => console.error("[AgentBridge] command error", e));
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return; // 被替换的旧连接：静默消亡，不重连
      wsOpen = false;
      ws = null;
      scheduleReconnect();
    };
    sock.onerror = () => {
      // onclose 会随后触发，统一在那里重连
    };
  } catch (e) {
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function scheduleReconnect() {
  setTimeout(() => connectWS(), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

// chrome.alarms 兜底唤醒 SW（WS 活跃时 daemon ping 也能保活，双保险）
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM && !wsOpen) connectWS();
});
chrome.runtime.onStartup.addListener(() => connectWS());
chrome.runtime.onInstalled.addListener(() => connectWS());

// ---------------------------------------------------------------------------
// 命令入口：解析 → 分发 → 回包（id 配对在 daemon 侧完成，这里原样回 id）
// ---------------------------------------------------------------------------

async function handleCommand(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type !== "command" || !msg.id) return; // 忽略非命令消息（含 daemon ping/pong）
  const { id, action, args = {}, session } = msg;
  let reply;
  try {
    const result = await dispatch(action, args, session || "default");
    reply = { id, ok: true, result: result === undefined ? null : result };
  } catch (e) {
    reply = { id, ok: false, error: String((e && e.message) || e) };
  }
  if (wsOpen && ws) ws.send(JSON.stringify(reply));
}

async function dispatch(action, args, session) {
  switch (action) {
    case "navigate": return await actNavigate(args, session);
    case "find_tab": return await actFindTab(args, session);
    case "list_tabs": return await actListTabs();
    case "close_tab": return await actCloseTab(args, session);
    case "close_session": return await actCloseSession(session);
    case "snapshot": return await actSnapshot(args, session);
    case "click": return await actClick(args, session);
    case "fill": return await actFill(args, session);
    case "evaluate": return await actEvaluate(args, session);
    case "screenshot": return await actScreenshot(args, session);
    case "upload": return await actUpload(args, session);
    case "save_as_pdf": return await actSaveAsPdf(args, session);
    case "network": return await actNetwork(args, session);
    case "cdp": return await actCdp(args, session);
    case "press": return await actPress(args, session);
    case "hover": return await actHover(args, session);
    case "select": return await actSelect(args, session);
    case "scroll": return await actScroll(args, session);
    case "record": return await actRecord(args, session);
    case "extract": return await actExtract(args, session);
    case "wait": return await actWait(args, session);
    case "type": return await actType(args, session);
    case "wait_new_tab": return await actWaitNewTab(args, session);
    case "dialog": return await actDialog(args, session);
    case "frames": return await actFrames(args, session);
    default: throw new Error("unknown action: " + action);
  }
}

// ---------------------------------------------------------------------------
// session 管理：一个 session = 一个 tab group（标题即 session 名 / group_title）
// SW 重启后 sessions Map 会丢，resolveSession 会按 tabGroup 标题重建映射。
// ---------------------------------------------------------------------------

async function rebuildSessions() {
  sessions.clear();
  // tabs 一次取全后在本地按 groupId 归组，避免逐组 tabs.query 的 N+1 查询
  const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})]);
  const byGroup = new Map();
  for (const t of tabs) {
    if (t.groupId == null || t.groupId === -1) continue;
    if (!byGroup.has(t.groupId)) byGroup.set(t.groupId, []);
    byGroup.get(t.groupId).push(t);
  }
  for (const g of groups) {
    if (!g.title) continue;
    const gtabs = byGroup.get(g.id) || [];
    const active = gtabs.find((t) => t.active) || gtabs[gtabs.length - 1];
    sessions.set(g.title, { groupId: g.id, activeTabId: active ? active.id : null });
  }
}

async function resolveSession(session, create = false) {
  if (!sessions.has(session)) await rebuildSessions();
  if (sessions.has(session)) return sessions.get(session);
  if (!create) throw new Error('session "' + session + '" 不存在（没有对应 tab group）');
  return null; // 调用方负责创建
}

async function ensureTab(args, session) {
  // 返回 session 当前活跃 tab；不存在则新建 tab + tab group
  const existing = await resolveSession(session, true).catch(() => null);
  if (existing && existing.activeTabId != null) {
    try {
      return await chrome.tabs.get(existing.activeTabId);
    } catch { /* tab 已被手动关掉，重建 */ }
  }
  // 新 tab 先落在 about:blank，由 actNavigate 统一 tabs.update 导航，
  // 避免 create 带 url 后又 update 同 url 造成重复加载。
  // headless 下所有 tab 被关光后不存在 "current window"，
  // chrome.tabs.create 会报 "No current window" —— 先补一个窗口。
  let tab;
  try {
    tab = await chrome.tabs.create({ url: "about:blank", active: true });
  } catch (e) {
    if (String(e && e.message).includes("No current window")) {
      const win = await chrome.windows.create({ url: "about:blank", focused: true });
      tab = win.tabs[0];
    } else {
      throw e;
    }
  }
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  const title = args.group_title || session;
  await chrome.tabGroups.update(groupId, { title });
  sessions.set(session, { groupId, activeTabId: tab.id });
  return tab;
}

async function setActiveTab(session, tabId) {
  const s = sessions.get(session);
  if (s) s.activeTabId = tabId;
}

// ---------------------------------------------------------------------------
// tab 相关动作
// ---------------------------------------------------------------------------

async function actNavigate(args, session) {
  if (!args.url) throw new Error("navigate 需要 args.url");
  const tab = await ensureTab(args, session);
  sessionFrames.delete(session); // 导航后旧 frame 的 ref 全部失效，路由复位到顶层 frame
  await chrome.tabs.update(tab.id, { url: args.url, active: true });
  // 先等导航真正开始（旧页面的 complete 会造成误判提前返回）
  let cur = tab;
  let deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    cur = await chrome.tabs.get(tab.id);
    if (cur.status === "loading") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // 再等加载完成（最多 15s）
  deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (cur.status === "complete") break;
    await new Promise((r) => setTimeout(r, 200));
    cur = await chrome.tabs.get(tab.id);
  }
  return { tabId: tab.id, url: cur.url, title: cur.title, status: cur.status };
}

async function actFindTab(args, session) {
  const tabs = await chrome.tabs.query({});
  const matches = tabs.filter((t) => {
    if (args.url && !(t.url || "").includes(args.url)) return false;
    if (args.title && !(t.title || "").includes(args.title)) return false;
    return true;
  }).map((t) => ({ tabId: t.id, url: t.url, title: t.title, groupId: t.groupId, active: t.active }));
  if (args.adopt !== false && matches.length > 0) {
    // SW 重启后 sessions 可能为空，先尝试按 tabGroup 重建再认领
    await resolveSession(session).catch(() => null);
    if (sessions.has(session)) await setActiveTab(session, matches[0].tabId);
    await chrome.tabs.update(matches[0].tabId, { active: true });
  }
  return { count: matches.length, tabs: matches };
}

async function actListTabs() {
  // 组标题一次取全，避免逐 tab 调 tabGroups.get 的 N+1 查询
  const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
  const titles = new Map(groups.map((g) => [g.id, g.title || null]));
  const out = tabs.map((t) => ({
    tabId: t.id, windowId: t.windowId, url: t.url, title: t.title, active: t.active,
    groupId: t.groupId,
    group: t.groupId && t.groupId !== -1 ? (titles.get(t.groupId) ?? null) : null,
  }));
  return { count: out.length, tabs: out };
}

async function actCloseTab(args, session) {
  let tabId = args.tab_id;
  if (tabId == null) {
    const s = await resolveSession(session);
    tabId = s.activeTabId;
  }
  if (tabId == null) throw new Error("没有可关闭的 tab");
  await chrome.tabs.remove(tabId);
  const s = sessions.get(session);
  if (s && s.activeTabId === tabId) s.activeTabId = null;
  return { closed: tabId };
}

async function actCloseSession(session) {
  const s = await resolveSession(session);
  const tabs = await chrome.tabs.query({ groupId: s.groupId });
  const ids = tabs.map((t) => t.id);
  if (ids.length) await chrome.tabs.remove(ids);
  sessions.delete(session);
  return { closed_tabs: ids.length, session };
}

// ---------------------------------------------------------------------------
// content.js 消息桥
// ---------------------------------------------------------------------------

async function sendToContent(tabId, payload, frameId = 0) {
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, payload, { frameId });
  } catch (e) {
    // content script 可能未注入（如刚导航的页面），注入后重试一次
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] });
    resp = await chrome.tabs.sendMessage(tabId, payload, { frameId });
  }
  if (!resp) throw new Error("content.js 无响应");
  if (!resp.ok) throw new Error(resp.error || "content.js 执行失败");
  return resp.result;
}

async function activeTabIdOf(session) {
  const s = await resolveSession(session);
  if (s.activeTabId == null) throw new Error('session "' + session + '" 没有活跃 tab，请先 navigate');
  return s.activeTabId;
}

// ---------------------------------------------------------------------------
// frame 路由：content.js 以 all_frames 注入每个 iframe。args.frame 可显式指定
// （frameId、序号或 url 子串）；未指定时沿用该 session 最后一次 snapshot 的
// frame，保证 @eN ref 能路由回产出它的那个 frame。
// ---------------------------------------------------------------------------

async function resolveFrameId(tabId, frame) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  if (!frames.length) throw new Error("无法枚举 tab 的 frame");
  const raw = String(frame).trim();
  let f = null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    f = frames.find((x) => x.frameId === n) || frames[n] || null;
  } else {
    f = frames.find((x) => (x.url || "").includes(raw));
  }
  if (!f) throw new Error('未找到 frame: ' + raw + '（可用 frames action 查看全部 frame）');
  return f.frameId;
}

async function contentTarget(session, args) {
  const tabId = await activeTabIdOf(session);
  let frameId = sessionFrames.get(session) || 0;
  if (args && args.frame !== undefined && args.frame !== null && args.frame !== "") {
    frameId = await resolveFrameId(tabId, args.frame);
  }
  return { tabId, frameId };
}

// ---------------------------------------------------------------------------
// 快照 / 点击 / 填充 / 选择 / 滚动 / 提取
// ---------------------------------------------------------------------------

async function actSnapshot(args, session) {
  const { tabId, frameId } = await contentTarget(session, args);
  const result = await sendToContent(tabId, { kind: "snapshot" }, frameId);
  sessionFrames.set(session, frameId); // 后续 ref 操作路由回这个 frame
  return { ...result, frameId };
}

function refOrSelector(args) {
  // 定位统一入口：优先 @eN 快照引用，其次 CSS selector
  if (args.ref) return { ref: String(args.ref).replace(/^@/, "") };
  if (args.selector) return { selector: args.selector };
  throw new Error("需要 args.ref（@eN）或 args.selector（CSS）");
}

async function actClick(args, session) {
  const { tabId, frameId } = await contentTarget(session, args);
  const target = refOrSelector(args);
  // 先解析坐标：content.js 会识别勾选类控件（自定义 checkbox/switch）并改返
  // 可视方块的中心坐标；勾选控件一律走 trusted 通道，普通元素行为不变。
  // 注意：CDP 坐标基于顶层视口，iframe 内元素的 trusted 点击坐标会偏移，
  // iframe 场景请用非 trusted 点击（el.click() 不受此限）
  const rect = await sendToContent(tabId, { kind: "coords", ...target }, frameId);
  if (args.trusted || rect.checkable) {
    await trustedClickAt(tabId, rect.x, rect.y);
    return { clicked: target, trusted: true, x: rect.x, y: rect.y, ...(rect.checkable ? { checkable: true } : {}) };
  }
  return await sendToContent(tabId, { kind: "click", ...target }, frameId);
}

async function actFill(args, session) {
  const { tabId, frameId } = await contentTarget(session, args);
  if (args.value === undefined) throw new Error("fill 需要 args.value");
  return await sendToContent(tabId, { kind: "fill", ...refOrSelector(args), value: String(args.value) }, frameId);
}

async function actSelect(args, session) {
  const { tabId, frameId } = await contentTarget(session, args);
  return await sendToContent(tabId, { kind: "select", ...refOrSelector(args), value: args.value, label: args.label, index: args.index }, frameId);
}

async function actScroll(args, session) {
  const { tabId, frameId } = await contentTarget(session, args);
  if (args.selector || args.ref) {
    // 带 direction/amount 时为容器内滚动（聊天记录、长列表 div），否则只是滚到可见
    if (args.direction || args.amount) {
      return await sendToContent(tabId, {
        kind: "scroll", ...refOrSelector(args),
        direction: args.direction || "down", amount: args.amount || 800,
      }, frameId);
    }
    return await sendToContent(tabId, { kind: "scroll_to", ...refOrSelector(args) }, frameId);
  }
  return await sendToContent(tabId, { kind: "scroll", direction: args.direction || "down", amount: args.amount || 800 }, frameId);
}

async function actExtract(args, session) {
  const { tabId, frameId } = await contentTarget(session, args);
  return await sendToContent(tabId, { kind: "extract", mode: args.mode || "text" }, frameId);
}

// ---------------------------------------------------------------------------
// wait：等元素/文本出现或消失（content.js MutationObserver 实现）
// ---------------------------------------------------------------------------

async function actWait(args, session) {
  const { tabId, frameId } = await contentTarget(session, args);
  const payload = { kind: "wait", state: args.state || "visible" };
  if (args.text) payload.text = String(args.text);
  else Object.assign(payload, refOrSelector(args));
  if (args.timeout) payload.timeout = args.timeout;
  return await sendToContent(tabId, payload, frameId);
}

// ---------------------------------------------------------------------------
// type：trusted 逐字符输入（fill 是合成赋值，少数站点能识别）
// delay>0 时逐字符发 key 事件模拟真人打字；否则 Input.insertText 一次性插入
// ---------------------------------------------------------------------------

async function actType(args, session) {
  const { tabId, frameId } = await contentTarget(session, args);
  if (args.text === undefined || args.text === null) throw new Error("type 需要 args.text");
  const text = String(args.text);
  if (args.selector || args.ref) {
    await sendToContent(tabId, { kind: "focus", ...refOrSelector(args) }, frameId);
  }
  const delay = Number(args.delay) || 0;
  await withDebuggerLocked(tabId, async () => {
    if (delay <= 0) {
      await dbgSend(tabId, "Input.insertText", { text });
      return;
    }
    for (const ch of text) {
      const info = KEY_MAP[ch] || { key: ch, code: ch.length === 1 && /[a-z0-9]/i.test(ch) ? "Key" + ch.toUpperCase() : ch, keyCode: ch.toUpperCase().charCodeAt(0) };
      await dbgSend(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, text: ch });
      await dbgSend(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode });
      await new Promise((r) => setTimeout(r, delay));
    }
  });
  return { typed: text.length, trusted: true, delay };
}

// ---------------------------------------------------------------------------
// wait_new_tab：click 触发 window.open 后捕获新 tab，并纳入 session 的 tab group
// ---------------------------------------------------------------------------

async function actWaitNewTab(args, session) {
  const s = await resolveSession(session).catch(() => null);
  const timeout = Math.min(Number(args.timeout) || 10000, 60000);
  const known = new Set((await chrome.tabs.query({})).map((t) => t.id));
  const tab = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onCreated.removeListener(fn);
      reject(new Error("wait_new_tab 超时（" + timeout + "ms），没有等到新 tab"));
    }, timeout);
    const fn = (t) => {
      if (known.has(t.id)) return;
      if (args.url && !((t.url || "") + (t.pendingUrl || "")).includes(args.url)) return;
      clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(fn);
      resolve(t);
    };
    chrome.tabs.onCreated.addListener(fn);
  });
  let adopted = false;
  if (s) {
    try {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: s.groupId });
      s.activeTabId = tab.id;
      adopted = true;
    } catch { /* group 可能刚被删，仅不收养 */ }
  }
  return { tabId: tab.id, url: tab.url || tab.pendingUrl || null, title: tab.title || null, adopted };
}

// ---------------------------------------------------------------------------
// dialog：自动应答 alert/confirm/prompt（监听期间保持 attach，与 network 同理）
// ---------------------------------------------------------------------------

async function actDialog(args, session) {
  const tabId = await activeTabIdOf(session);
  const op = args.op || "start";
  if (op === "start") {
    const cfg = { accept: args.accept !== false, promptText: args.prompt_text };
    if (!dialogSessions.has(tabId)) {
      await dbgAttach(tabId);
      try {
        await dbgSend(tabId, "Page.enable", {});
      } catch (e) {
        await dbgDetach(tabId);
        throw e;
      }
    }
    dialogSessions.set(tabId, cfg);
    return { started: true, tabId, accept: cfg.accept };
  }
  if (op === "stop") {
    const had = dialogSessions.delete(tabId);
    // 只有 network 也没在占用 attach 时才 detach
    if (had && !networkSessions.has(tabId)) await dbgDetach(tabId);
    return { stopped: true, tabId, was_active: had };
  }
  throw new Error("dialog 需要 args.op: start|stop（start 可选 accept / prompt_text）");
}

// ---------------------------------------------------------------------------
// frames：列出 session 活跃 tab 的全部 frame（配合 args.frame 使用）
// ---------------------------------------------------------------------------

async function actFrames(args, session) {
  const tabId = await activeTabIdOf(session);
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  return {
    count: frames.length,
    current: sessionFrames.get(session) || 0,
    frames: frames.map((f) => ({ frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId })),
  };
}

// ---------------------------------------------------------------------------
// evaluate：MAIN world 执行，支持 async/await，returnByValue
// ---------------------------------------------------------------------------

async function actEvaluate(args, session) {
  const { tabId, frameId } = await contentTarget(session, args);
  const expr = args.expression || args.script;
  if (!expr) throw new Error("evaluate 需要 args.expression");
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      func: async (code) => {
        // 间接 eval 在页面 MAIN world 全局作用域执行，await 支持 Promise 返回值
        const r = await (0, eval)(code);
        try { return JSON.parse(JSON.stringify(r === undefined ? null : r)); }
        catch { return String(r); } // 不可序列化对象降级为字符串
      },
      args: [expr],
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/eval|csp|content security policy/i.test(msg)) {
      throw new Error(msg + "（页面 CSP 禁止 eval，MAIN world 无法执行，可用 cdp action 调 Runtime.evaluate 替代）");
    }
    throw e;
  }
  const r = results && results[0];
  if (!r) throw new Error("evaluate 无结果");
  return { value: r.result };
}

// ---------------------------------------------------------------------------
// 截图 / PDF / 上传
// ---------------------------------------------------------------------------

async function actScreenshot(args, session) {
  const tabId = await activeTabIdOf(session);
  const format = args.format === "png" ? "png" : "jpeg";
  const quality = format === "jpeg" && args.quality ? Math.max(0, Math.min(100, args.quality)) : undefined;
  // base64 交给 daemon 落盘（扩展端不写文件，路径由 daemon 统一管理）

  if (args.full) {
    // 全页截图：captureVisibleTab 只能截可视区，改走 CDP captureBeyondViewport
    const data = await withDebuggerLocked(tabId, async () => {
      const metrics = await dbgSend(tabId, "Page.getLayoutMetrics", {});
      const size = metrics.cssContentSize || metrics.contentSize;
      const params = { format, captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } };
      if (quality !== undefined) params.quality = quality;
      return await dbgSend(tabId, "Page.captureScreenshot", params);
    });
    return { format, base64: data.data, path: args.path || null, full: true };
  }

  // captureVisibleTab 截的是窗口当前活跃 tab，先把目标 tab 激活再截，避免截错
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  const opts = { format };
  if (quality !== undefined) opts.quality = quality;
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, opts);
  const base64 = dataUrl.split(",")[1];
  return { format, base64, path: args.path || null };
}

async function actSaveAsPdf(args, session) {
  const tabId = await activeTabIdOf(session);
  const params = { printBackground: true };
  if (args.landscape) params.landscape = true;
  if (args.scale) params.scale = args.scale;
  const data = await withDebuggerLocked(tabId, () => dbgSend(tabId, "Page.printToPDF", params));
  return { format: "pdf", base64: data.data, path: args.path || null };
}

async function actUpload(args, session) {
  const tabId = await activeTabIdOf(session);
  if (!args.selector || !Array.isArray(args.files) || !args.files.length) {
    throw new Error("upload 需要 args.selector 和 args.files（绝对路径数组）");
  }
  return await withDebuggerLocked(tabId, async () => {
    const doc = await dbgSend(tabId, "DOM.getDocument", { depth: 1 });
    const node = await dbgSend(tabId, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: args.selector });
    if (!node.nodeId) throw new Error("未找到文件输入框: " + args.selector);
    await dbgSend(tabId, "DOM.setFileInputFiles", { files: args.files, nodeId: node.nodeId });
    return { uploaded: args.files, selector: args.selector };
  });
}

// ---------------------------------------------------------------------------
// chrome.debugger 封装
// 纪律：network 监听期间保持 attach，stop 才 detach；其余按需 attach 用完即 detach，
// 避免 debugger 黄条常驻。chrome.debugger API 内部已完成命令 id 配对。
// ---------------------------------------------------------------------------

function dbgSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(method + ": " + err.message));
      else resolve(result || {});
    });
  });
}

function dbgAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error("debugger attach 失败: " + err.message));
      else resolve();
    });
  });
}

function dbgDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve()); // 已 detach 时静默忽略
  });
}

async function withDebugger(tabId, fn) {
  // 网络监听 / 对话框自动应答期间的 attach 由各自生命周期管理，不随用随 detach
  const persistent = networkSessions.has(tabId) || dialogSessions.has(tabId);
  if (!persistent) await dbgAttach(tabId);
  try {
    return await fn();
  } finally {
    if (!persistent) await dbgDetach(tabId);
  }
}

// 同一 tab 的 debugger 操作串行化：并发 withDebugger 会因 attach 冲突
// （"Another debugger is already attached"）失败，按 tab 排队执行
const dbgLocks = new Map(); // tabId → 上一个操作的 Promise

function withDebuggerLocked(tabId, fn) {
  const prev = dbgLocks.get(tabId) || Promise.resolve();
  const next = prev.then(() => withDebugger(tabId, fn));
  // 链条吞掉异常，保证后续操作不受前序失败影响
  dbgLocks.set(tabId, next.catch(() => {}));
  return next;
}

// debugger 被外部断开（如用户点了黄条的"取消"）时清理网络监听/对话框状态
chrome.debugger.onDetach.addListener((source) => {
  // 用户点黄条"取消"/tab 关闭等活跃期断开：停止监听并同步持久化清单。
  // SW 被挂起导致的自动 detach 不会触发本事件（SW 已不在），持久化清单
  // 会保留下来供 restoreNetworkSessions 恢复。
  if (source.tabId == null) return;
  dialogSessions.delete(source.tabId);
  if (networkSessions.delete(source.tabId)) persistNetworkTabs();
});

// ---------------------------------------------------------------------------
// trusted 输入（isTrusted=true，可过检测 synthetic 事件的站点）
// ---------------------------------------------------------------------------

async function trustedClickAt(tabId, x, y) {
  await withDebuggerLocked(tabId, async () => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      const p = { type, x, y };
      if (type !== "mouseMoved") { p.button = "left"; p.clickCount = 1; }
      await dbgSend(tabId, "Input.dispatchMouseEvent", p);
    }
  });
}

const KEY_MAP = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32 },
};

// CDP modifiers 位掩码：Alt=1 Control=2 Meta=4 Shift=8
const MOD_BITS = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

async function actPress(args, session) {
  const { tabId, frameId } = await contentTarget(session, args);
  const raw = args.key;
  if (!raw) throw new Error("press 需要 args.key（如 Enter/Escape/Control+A）");
  if (args.selector || args.ref) {
    // 可选先聚焦目标元素，再发键
    await sendToContent(tabId, { kind: "focus", ...refOrSelector(args) }, frameId);
  }
  // 支持组合键："Control+A"、"Shift+Enter"、"Meta+Shift+P"
  const parts = String(raw).split("+").map((p) => p.trim()).filter(Boolean);
  let modifiers = 0;
  while (parts.length > 1 && MOD_BITS[parts[0].toLowerCase()] !== undefined) {
    modifiers |= MOD_BITS[parts.shift().toLowerCase()];
  }
  const key = parts.join("+") || raw; // 修饰词耗尽时（如 key="+"）按原样处理
  const info = KEY_MAP[key] || (key.length === 1
    ? { key, code: "Key" + key.toUpperCase(), keyCode: key.toUpperCase().charCodeAt(0) }
    : { key, code: key, keyCode: 0 });
  // Shift+可打印字符时大写 text，保证产出正确字符
  const text = key.length === 1 ? ((modifiers & 8) ? key.toUpperCase() : key) : undefined;
  await withDebuggerLocked(tabId, async () => {
    const down = { type: "keyDown", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode };
    if (modifiers) down.modifiers = modifiers;
    if (text !== undefined) down.text = text; // 可打印字符需要 text 字段才会产生输入
    await dbgSend(tabId, "Input.dispatchKeyEvent", down);
    const up = { type: "keyUp", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode };
    if (modifiers) up.modifiers = modifiers;
    await dbgSend(tabId, "Input.dispatchKeyEvent", up);
  });
  return { pressed: raw, trusted: true };
}

async function actHover(args, session) {
  const { tabId, frameId } = await contentTarget(session, args);
  const rect = await sendToContent(tabId, { kind: "coords", ...refOrSelector(args) }, frameId);
  await withDebuggerLocked(tabId, async () => {
    await dbgSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
    // 轻微抖动模拟真人鼠标轨迹，触发 hover 监听
    await dbgSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + 1, y: rect.y + 1 });
  });
  return { hovered: true, trusted: true, x: rect.x, y: rect.y };
}

// ---------------------------------------------------------------------------
// network：chrome.debugger Network domain，监听期间保持 attach
// ---------------------------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  // JS 对话框自动应答（dialog start 期间保持 attach + Page.enable）
  if (method === "Page.javascriptDialogOpening") {
    const cfg = dialogSessions.get(tabId);
    if (cfg) {
      const p = { accept: cfg.accept };
      if (cfg.promptText !== undefined) p.promptText = String(cfg.promptText);
      dbgSend(tabId, "Page.handleJavaScriptDialog", p).catch(() => {});
    }
    return;
  }
  if (!networkSessions.has(tabId)) return;
  const buf = networkSessions.get(tabId);
  if (method === "Network.requestWillBeSent") {
    buf.requests.set(params.requestId, {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      requestHeaders: params.request.headers,
      status: null,
      mimeType: null,
    });
    buf.order.push(params.requestId);
    // 上限保护：最多保留 2000 条，防内存膨胀
    if (buf.order.length > 2000) buf.requests.delete(buf.order.shift());
  } else if (method === "Network.responseReceived") {
    const e = buf.requests.get(params.requestId);
    if (e) {
      e.status = params.response.status;
      e.mimeType = params.response.mimeType;
      e.responseHeaders = params.response.headers;
    }
  } else if (method === "Network.loadingFinished") {
    const e = buf.requests.get(params.requestId);
    if (e) e.encodedDataLength = params.encodedDataLength;
  }
});

// 正在监听的 tabId 列表持久化到 storage.session：SW 被挂起时 debugger 会被
// Chrome 自动 detach、内存态 networkSessions 丢失；SW 下次唤醒时按此清单
// 重新 attach 恢复监听（缓冲区不持久化，重启前捕获的请求会丢，只保证监听不断）。
const NETWORK_TABS_KEY = "agentbridge_network_tabs";

async function persistNetworkTabs() {
  try {
    await chrome.storage.session.set({ [NETWORK_TABS_KEY]: [...networkSessions.keys()] });
  } catch { /* storage 不可用时放弃持久化，不影响监听本身 */ }
}

async function restoreNetworkSessions() {
  let ids = [];
  try {
    ids = (await chrome.storage.session.get(NETWORK_TABS_KEY))[NETWORK_TABS_KEY] || [];
  } catch { return; }
  let changed = false;
  for (const tabId of ids) {
    if (networkSessions.has(tabId)) continue;
    try {
      await dbgAttach(tabId);
      await dbgSend(tabId, "Network.enable", {});
      networkSessions.set(tabId, { requests: new Map(), order: [] });
    } catch {
      changed = true; // tab 已关闭等，从清单剔除
    }
  }
  if (changed) await persistNetworkTabs();
}

async function actNetwork(args, session) {
  const op = args.op || args.subaction;
  const tabId = await activeTabIdOf(session);
  switch (op) {
    case "start": {
      if (networkSessions.has(tabId)) return { started: true, note: "已在监听中", tabId };
      await dbgAttach(tabId);
      try {
        await dbgSend(tabId, "Network.enable", {});
      } catch (e) {
        await dbgDetach(tabId);
        throw e;
      }
      networkSessions.set(tabId, { requests: new Map(), order: [] });
      await persistNetworkTabs();
      return { started: true, tabId };
    }
    case "stop": {
      const buf = networkSessions.get(tabId);
      networkSessions.delete(tabId);
      await persistNetworkTabs();
      await dbgSend(tabId, "Network.disable", {}).catch(() => {});
      await dbgDetach(tabId); // stop 即 detach，黄条不常驻
      return { stopped: true, tabId, captured: buf ? buf.order.length : 0 };
    }
    case "list": {
      const buf = networkSessions.get(tabId);
      if (!buf) throw new Error("该 tab 未在监听网络，请先 network start");
      const list = buf.order.map((id) => {
        const e = buf.requests.get(id);
        return { requestId: e.requestId, url: e.url, method: e.method, status: e.status, mimeType: e.mimeType };
      });
      return { count: list.length, requests: list };
    }
    case "detail": {
      const buf = networkSessions.get(tabId);
      if (!buf) throw new Error("该 tab 未在监听网络，请先 network start");
      const rid = args.request_id || args.requestId;
      const e = buf.requests.get(rid);
      if (!e) throw new Error("未找到 requestId: " + rid);
      let body = null, base64Encoded = false;
      try {
        const b = await dbgSend(tabId, "Network.getResponseBody", { requestId: rid });
        body = b.body;
        base64Encoded = !!b.base64Encoded;
      } catch { body = null; } // 部分请求（如重定向/缓存）无 body
      return { ...e, body, base64Encoded };
    }
    default:
      throw new Error("network 需要 args.op: start|stop|list|detail");
  }
}

// ---------------------------------------------------------------------------
// cdp：chrome.debugger 原始透传
// ---------------------------------------------------------------------------

async function actCdp(args, session) {
  const tabId = await activeTabIdOf(session);
  if (!args.method) throw new Error("cdp 需要 args.method");
  const result = await withDebuggerLocked(tabId, () => dbgSend(tabId, args.method, args.params || {}));
  return { method: args.method, result };
}

// ---------------------------------------------------------------------------
// record：content.js 录制，start 清空缓冲开始监听，stop 返回事件数组
// 事件落盘与 replay 调度由 daemon 负责。
// ---------------------------------------------------------------------------

async function actRecord(args, session) {
  const op = args.op;
  const tabId = await activeTabIdOf(session);
  if (op === "start") {
    return await sendToContent(tabId, { kind: "record_start" });
  } else if (op === "stop") {
    return await sendToContent(tabId, { kind: "record_stop" });
  }
  throw new Error("record 的 start/stop 由扩展执行；list/replay 由 daemon 处理");
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

connectWS();
restoreNetworkSessions(); // SW 唤醒时恢复此前未 stop 的网络监听
