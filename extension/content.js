// AgentBridge content script
// 职责：a11y 快照（@e refs）、元素定位/点击/填充、contenteditable 兼容、
// 事件录制器（click/input/change/submit/Enter）、正文提取（text/markdown/dom）。
// 运行在隔离世界，不受页面 CSP 影响。

(() => {
  if (window.__agentbridgeContentLoaded) return; // background 重注入时防重复
  window.__agentbridgeContentLoaded = true;

  // -------------------------------------------------------------------------
  // role 映射：INPUT 按 type 细分，其余按标签/显式 role
  // -------------------------------------------------------------------------

  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
    "menuitem", "tab", "option", "switch", "slider", "spinbutton",
  ]);

  function getRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.toLowerCase();
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      if (type === "range") return "slider";
      return "textbox";
    }
    const tagMap = {
      A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox",
      SUMMARY: "button", H1: "heading", H2: "heading", H3: "heading",
      H4: "heading", H5: "heading", H6: "heading",
    };
    return tagMap[el.tagName] || el.tagName.toLowerCase();
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    // 视口上下两屏内的元素才纳入快照，控制快照体积
    const vh = window.innerHeight, vw = window.innerWidth;
    return rect.bottom >= -vh && rect.right >= -vw && rect.top <= vh * 2 && rect.left <= vw * 2;
  }

  function getName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const lbl = document.getElementById(labelledBy);
      if (lbl) return (lbl.innerText || "").trim();
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    const title = el.getAttribute("title");
    if (title) return title.trim();
    if (el.tagName === "INPUT" && ["submit", "button", "reset"].includes((el.type || "").toLowerCase())) {
      return (el.value || "").trim();
    }
    return (el.innerText || "").trim().substring(0, 200);
  }

  // -------------------------------------------------------------------------
  // 深度遍历：TreeWalker 不穿透 shadow root，递归下钻 open shadow DOM
  // （closed shadow root 无法访问，属于平台限制）
  // -------------------------------------------------------------------------

  function* walkElements(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      yield node;
      if (node.shadowRoot) yield* walkElements(node.shadowRoot);
    }
  }

  // -------------------------------------------------------------------------
  // 快照：遍历 DOM（含 open shadow root），给可交互元素打 data-ai-ref="e1..eN"，
  // 输出文本化 a11y 树
  // -------------------------------------------------------------------------

  function buildSnapshot() {
    for (const el of walkElements(document.body)) {
      if (el.hasAttribute("data-ai-ref")) el.removeAttribute("data-ai-ref");
    }
    const lines = [];
    const refs = [];
    let counter = 1;

    for (const node of walkElements(document.body)) {
      if (!isVisible(node)) continue;
      const role = getRole(node);
      const interactive = INTERACTIVE_TAGS.has(node.tagName) || INTERACTIVE_ROLES.has(role);
      if (!interactive) continue;
      const name = getName(node);
      if (!name && node.tagName !== "INPUT" && node.tagName !== "TEXTAREA") continue;
      const ref = "e" + counter++;
      node.setAttribute("data-ai-ref", ref);
      const typeAttr = node.tagName === "INPUT" ? ` type="${(node.type || "text").toLowerCase()}"` : "";
      const valueAttr = (node.tagName === "INPUT" && ["checkbox", "radio"].includes((node.type || "").toLowerCase()))
        ? (node.checked ? " checked" : "") : "";
      lines.push(`[ref=${ref}] ${role}${typeAttr} "${name.replace(/\n/g, " ").substring(0, 120)}"${valueAttr}`);
      refs.push({ ref, role, tag: node.tagName.toLowerCase(), name });
    }
    return { snapshot: lines.join("\n"), element_count: refs.length, url: location.href, title: document.title };
  }

  // -------------------------------------------------------------------------
  // 元素定位：@eN ref 或 CSS selector
  // -------------------------------------------------------------------------

  function resolveEl(msg) {
    let el = null;
    if (msg.ref) {
      // querySelector 找不到 shadow root 内的 ref，走深度遍历
      for (const node of walkElements(document.body)) {
        if (node.getAttribute("data-ai-ref") === msg.ref) { el = node; break; }
      }
    } else if (msg.selector) el = document.querySelector(msg.selector);
    if (!el) throw new Error("元素未找到: " + (msg.ref ? "@" + msg.ref : msg.selector) + "（页面可能已变化，请重新 snapshot）");
    return el;
  }

  function centerCoords(el) {
    el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }

  // -------------------------------------------------------------------------
  // fill：input/textarea（设 value + input/change 事件，clear-and-insert 语义）
  // 与 contenteditable（ProseMirror/Lexical 等，设 textContent + input 事件）
  // -------------------------------------------------------------------------

  function fillElement(el, value) {
    el.scrollIntoView({ behavior: "instant", block: "center" });
    el.focus();
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      // 用原生 setter 赋值，兼容 React 等框架的受控组件
      const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true, kind: el.tagName.toLowerCase(), length: value.length };
    }
    if (el.isContentEditable) {
      el.textContent = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true })); // 与 input/textarea 分支语义对齐
      return { filled: true, kind: "contenteditable", length: value.length };
    }
    throw new Error("目标元素不可填充（既不是 input/textarea 也不是 contenteditable）");
  }

  // -------------------------------------------------------------------------
  // 事件录制器：捕获阶段监听，CSS selector 生成优先级 id > name > attr > 路径
  // -------------------------------------------------------------------------

  const recorder = { active: false, events: [] };

  function cssSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const name = el.getAttribute && el.getAttribute("name");
    if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
    for (const attr of ["data-testid", "data-test", "aria-label", "placeholder", "type"]) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) return `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(v)}"]`;
    }
    // 路径兜底：从 body 逐级 nth-of-type
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 8) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ");
  }

  function recordEvent(type, e) {
    const el = e.target;
    if (!el || !el.tagName) return;
    const evt = { type, selector: cssSelector(el), timestamp: Date.now(), url: location.href };
    if (type === "input" || type === "change") {
      if (el.type === "password") evt.value = "***"; // 密码不落盘
      else if (el.isContentEditable) evt.value = el.textContent;
      else evt.value = el.value !== undefined ? el.value : null;
      // input 高频：合并同一 selector 的连续 input 事件，只留最后值
      const prev = recorder.events[recorder.events.length - 1];
      if (type === "input" && prev && prev.type === "input" && prev.selector === evt.selector) {
        prev.value = evt.value;
        prev.timestamp = evt.timestamp;
        return;
      }
    }
    if (type === "keydown") evt.key = e.key;
    recorder.events.push(evt);
  }

  const CAPTURE = [
    ["click", (e) => recordEvent("click", e)],
    ["input", (e) => recordEvent("input", e)],
    ["change", (e) => recordEvent("change", e)],
    ["submit", (e) => recordEvent("submit", e)],
    ["keydown", (e) => { if (e.key === "Enter") recordEvent("keydown", e); }],
  ];

  function recordStart() {
    if (recorder.active) return { started: true, note: "已在录制中" };
    recorder.events = [];
    recorder.active = true;
    CAPTURE.forEach(([type, fn]) => document.addEventListener(type, fn, true)); // 捕获阶段，抢先于页面脚本
    return { started: true };
  }

  function recordStop() {
    if (!recorder.active) return { stopped: true, events: recorder.events, note: "未在录制" };
    recorder.active = false;
    CAPTURE.forEach(([type, fn]) => document.removeEventListener(type, fn, true));
    return { stopped: true, events: recorder.events, count: recorder.events.length };
  }

  // -------------------------------------------------------------------------
  // extract：text=Readability 风格正文 / markdown=结构化转 md / dom=完整 outerHTML
  // -------------------------------------------------------------------------

  function extractText() {
    // Readability 简化版：剔除 nav/aside/footer/script/style，按段落文本密度找主体
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("nav,aside,footer,script,style,noscript,iframe,header[role=banner],[role=navigation],[role=contentinfo],form")
      .forEach((n) => n.remove());
    let best = null, bestScore = 0;
    clone.querySelectorAll("article,main,section,div").forEach((el) => {
      const paras = el.querySelectorAll("p");
      let score = 0;
      paras.forEach((p) => { score += (p.innerText || "").trim().length; });
      // 链接密度高的块（导航/列表）降权
      const linkText = Array.from(el.querySelectorAll("a")).reduce((s, a) => s + (a.innerText || "").length, 0);
      const total = (el.innerText || "").length || 1;
      if (linkText / total > 0.5) score *= 0.3;
      if (score > bestScore) { bestScore = score; best = el; }
    });
    const text = (best ? best.innerText : clone.innerText || "").trim();
    return { mode: "text", text, length: text.length, url: location.href, title: document.title };
  }

  function extractMarkdown() {
    const lines = [];
    const walk = (el) => {
      for (const node of el.children) {
        const tag = node.tagName;
        const text = (node.innerText || "").trim();
        if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(tag)) continue;
        const h = tag.match(/^H([1-6])$/);
        if (h) { if (text) lines.push("#".repeat(Number(h[1])) + " " + text); continue; }
        if (tag === "P") { if (text) lines.push(text); continue; }
        if (tag === "UL" || tag === "OL") {
          node.querySelectorAll(":scope > li").forEach((li, i) => {
            const t = (li.innerText || "").trim().replace(/\n/g, " ");
            if (t) lines.push((tag === "OL" ? `${i + 1}. ` : "- ") + t);
          });
          continue;
        }
        if (tag === "A") {
          const href = node.getAttribute("href");
          if (text && href) lines.push(`[${text}](${href})`);
          continue;
        }
        if (tag === "BLOCKQUOTE") { if (text) lines.push("> " + text.replace(/\n/g, "\n> ")); continue; }
        if (tag === "PRE") { if (text) lines.push("```\n" + text + "\n```"); continue; }
        if (["DIV", "SECTION", "ARTICLE", "MAIN"].includes(tag)) walk(node);
      }
    };
    walk(document.body);
    const md = lines.join("\n\n");
    return { mode: "markdown", markdown: md, length: md.length, url: location.href, title: document.title };
  }

  function extractDom() {
    const html = document.documentElement.outerHTML;
    return { mode: "dom", html, length: html.length, url: location.href, title: document.title };
  }

  // -------------------------------------------------------------------------
  // 消息分发
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        let result;
        switch (msg.kind) {
          case "snapshot": result = buildSnapshot(); break;
          case "click": {
            const el = resolveEl(msg);
            el.scrollIntoView({ behavior: "instant", block: "center" });
            el.click();
            result = { clicked: msg.ref ? "@" + msg.ref : msg.selector, trusted: false };
            break;
          }
          case "coords": result = centerCoords(resolveEl(msg)); break;
          case "focus": { const el = resolveEl(msg); el.scrollIntoView({ behavior: "instant", block: "center" }); el.focus(); result = { focused: true }; break; }
          case "fill": result = fillElement(resolveEl(msg), msg.value); break;
          case "select": {
            const el = resolveEl(msg);
            if (el.tagName !== "SELECT") throw new Error("目标不是 <select> 元素");
            let opt = null;
            if (msg.value !== undefined) opt = Array.from(el.options).find((o) => o.value === String(msg.value));
            else if (msg.label !== undefined) opt = Array.from(el.options).find((o) => (o.text || "").trim() === String(msg.label));
            else if (msg.index !== undefined) opt = el.options[msg.index];
            if (!opt) throw new Error("未找到匹配的 option（value/label/index）");
            el.value = opt.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            result = { selected: opt.value, label: (opt.text || "").trim() };
            break;
          }
          case "scroll": {
            const dir = msg.direction, amt = msg.amount || 800;
            if (dir === "up") window.scrollBy(0, -amt);
            else if (dir === "down") window.scrollBy(0, amt);
            else if (dir === "left") window.scrollBy(-amt, 0);
            else if (dir === "right") window.scrollBy(amt, 0);
            else if (dir === "top") window.scrollTo(0, 0);
            else if (dir === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
            else throw new Error("未知滚动方向: " + dir);
            result = { scrolled: dir, amount: amt };
            break;
          }
          case "scroll_to": { const el = resolveEl(msg); el.scrollIntoView({ behavior: "instant", block: "center" }); result = { scrolled_to: true }; break; }
          case "extract":
            if (msg.mode === "markdown") result = extractMarkdown();
            else if (msg.mode === "dom") result = extractDom();
            else result = extractText();
            break;
          case "record_start": result = recordStart(); break;
          case "record_stop": result = recordStop(); break;
          default: throw new Error("未知 content 命令: " + msg.kind);
        }
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // 异步 sendResponse
  });
})();
