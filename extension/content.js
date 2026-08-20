// AgentBridge content script
// 职责：a11y 快照（@e refs，含自定义 checkbox/switch 控件识别与状态推断）、
// 元素定位/点击（勾选控件自动落可视方块）/填充、contenteditable 兼容、
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
  // 勾选类控件识别（自定义 checkbox/switch 组件）
  // 自定义组件常把原生 input 隐藏、真实状态挂在 label/容器的 class 上，
  // 标准 a11y 遍历既看不到控件也读不到状态，这里按多信号单独收集。
  // -------------------------------------------------------------------------

  const CHECKABLE_CLASS_RE = /checkbox|switch|toggle/i;
  const GROUP_CLASS_RE = /group|list/i; // 容器 token（如 xxx-checkbox-group）不是单个控件
  const STATE_CLASS_RE = /selected|checked|active/i;
  const ON_TOKEN_RE = /(^|[-_])on([-_]|$)/i;

  function classTokens(el) {
    const cls = el.className;
    if (typeof cls !== "string" || !cls) return [];
    return cls.split(/\s+/).filter(Boolean);
  }

  function hasCheckableClass(el) {
    return classTokens(el).some((t) => CHECKABLE_CLASS_RE.test(t) && !GROUP_CLASS_RE.test(t));
  }

  function hasStateClass(el) {
    return classTokens(el).some((t) => STATE_CLASS_RE.test(t) || ON_TOKEN_RE.test(t));
  }

  // 元素若是勾选控件本体，返回 kind（checkbox/radio/switch），否则 null
  function checkableKind(el) {
    if (el.tagName === "INPUT") {
      const t = (el.type || "").toLowerCase();
      return t === "checkbox" || t === "radio" ? t : null;
    }
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "checkbox" || role === "switch" || role === "radio") return role;
    if (hasCheckableClass(el)) {
      return /switch|toggle/i.test(classTokens(el).join(" ")) ? "switch" : "checkbox";
    }
    return null;
  }

  // 原生 input 的控件根：向上最多 4 级找 label / 勾选类 class 的包装元素
  function controlRootFor(el) {
    if (el.tagName !== "INPUT") return el;
    let cur = el.parentElement, depth = 0;
    while (cur && depth < 4) {
      if (cur.tagName === "LABEL" || checkableKind(cur)) return cur;
      cur = cur.parentElement; depth++;
    }
    return el;
  }

  // el 是否可视为勾选控件根（含"label 包裹勾选 input"的常见结构）
  function asCheckableRoot(el) {
    if (checkableKind(el)) return controlRootFor(el);
    if (el.tagName === "LABEL" && el.querySelector('input[type="checkbox"],input[type="radio"]')) return el;
    return null;
  }

  // 收集页面全部勾选控件的根元素（Map: root → kind）
  function collectCheckControls() {
    const roots = new Map();
    for (const el of walkElements(document.body)) {
      let kind = null;
      if (el.tagName === "INPUT") {
        kind = checkableKind(el);
      } else {
        const role = (el.getAttribute("role") || "").toLowerCase();
        if (role === "checkbox" || role === "switch" || role === "radio") {
          kind = role;
        } else if (hasCheckableClass(el)
          && !el.querySelector('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="switch"],[role="radio"]')) {
          // 纯 class 自定义控件：内部没有任何原生/ARIA 控件时才算，
          // 避免把包装层和内层视觉方块重复收集
          kind = /switch|toggle/i.test(classTokens(el).join(" ")) ? "switch" : "checkbox";
        }
      }
      if (!kind) continue;
      const root = controlRootFor(el);
      if (roots.has(root)) continue;
      // 跳过嵌套在已收集控件内部的内层元素（如视觉方块 span）
      let nested = false;
      for (const r of roots.keys()) {
        if (r.contains(root)) { nested = true; break; }
      }
      if (!nested) roots.set(root, kind);
    }
    return roots;
  }

  // 勾选状态多信号判定：aria-checked > input.checked 与 class 一致 > 冲突时信 class
  // （自定义组件的 input.checked 常是摆设，真实状态挂在 label/容器 class 上）
  // inferred=true 表示该状态是推断值
  function resolveCheckState(root) {
    const input = root.tagName === "INPUT" ? root : root.querySelector('input[type="checkbox"],input[type="radio"]');
    const ariaHolder = root.hasAttribute("aria-checked") ? root : root.querySelector("[aria-checked]");
    if (ariaHolder) return { checked: ariaHolder.getAttribute("aria-checked") === "true", inferred: false };
    let classOn = false;
    const rels = [root, root.parentElement, root.parentElement && root.parentElement.parentElement, ...root.children];
    for (const r of rels) {
      if (r && hasStateClass(r)) { classOn = true; break; }
    }
    if (input) {
      if (!!input.checked === classOn) return { checked: classOn, inferred: false };
      return { checked: classOn, inferred: true }; // 信号冲突：信 class
    }
    return { checked: classOn, inferred: true };
  }

  // 从 click 目标元素定位所属勾选控件根：向上最多 4 级，向下仅在恰好包含
  // 唯一控件时下钻。目标本身是 BUTTON/A 等原生交互元素时不向上接管，
  // 避免误接管 label 内的 "?" 帮助按钮。
  function findCheckableRoot(el) {
    if (!el || !el.tagName) return null;
    const self = asCheckableRoot(el);
    if (self) return self;
    if (!/^(BUTTON|A|SELECT|TEXTAREA)$/.test(el.tagName)) {
      let cur = el.parentElement, depth = 0;
      while (cur && cur !== document.body && depth < 4) {
        const root = asCheckableRoot(cur);
        if (root) return root;
        cur = cur.parentElement; depth++;
      }
    }
    if (el.querySelectorAll) {
      const inner = el.querySelectorAll('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="switch"],[role="radio"]');
      if (inner.length === 1) return controlRootFor(inner[0]);
    }
    return null;
  }

  // 选控件内部最像"可视方块"的小元素作为点击点：优先 input 的父级小元素
  // （自定义组件常见结构），其次方形/近方形、无文本、≤48px 的后代元素，
  // 避开文本和 tooltip 按钮
  function pickCheckableClickTarget(root) {
    const input = root.tagName === "INPUT" ? root : root.querySelector('input[type="checkbox"],input[type="radio"]');
    if (input && input.parentElement && input.parentElement !== root && root.contains(input.parentElement)) {
      const p = input.parentElement;
      const r = p.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.width <= 48 && r.height <= 48 && !(p.innerText || "").trim()) return p;
    }
    if (input) {
      const r = input.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.width <= 48 && r.height <= 48) return input;
    }
    let best = null, bestScore = -1;
    for (const c of root.querySelectorAll("span,i,svg,div")) {
      const r = c.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.width > 48 || r.height > 48) continue;
      const ratio = r.width / r.height;
      if (ratio < 0.5 || ratio > 2) continue;
      if ((c.innerText || "").trim()) continue;
      if (c.querySelector("button,a")) continue;
      const score = (48 - Math.max(r.width, r.height)) / 48
        + (c.tagName === "SPAN" || c.tagName === "I" ? 0.5 : 0)
        - c.childElementCount * 0.01;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best) return best;
    // 根元素自身不大且不含按钮/链接时，点根本身
    const rr = root.getBoundingClientRect();
    if (rr.width > 0 && rr.width <= 64 && rr.height <= 48 && !root.querySelector("button,a")) return root;
    return null;
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
    const controls = collectCheckControls();
    const lines = [];
    const refs = [];
    let counter = 1;
    let hasInferred = false;

    for (const node of walkElements(document.body)) {
      if (!isVisible(node)) continue;
      const ctlKind = controls.get(node);
      if (ctlKind) {
        const name = getName(node);
        if (!name && node.tagName !== "INPUT") continue;
        const ref = "e" + counter++;
        node.setAttribute("data-ai-ref", ref);
        const st = resolveCheckState(node);
        if (st.inferred) hasInferred = true;
        const state = (st.checked ? "checked" : "unchecked") + (st.inferred ? "?" : "");
        lines.push(`[ref=${ref}] ${ctlKind} "${name.replace(/\n/g, " ").substring(0, 120)}" [${state}]`);
        refs.push({ ref, role: ctlKind, tag: node.tagName.toLowerCase(), name, checked: st.checked, inferred: st.inferred });
        continue;
      }
      const role = getRole(node);
      // 被自定义包装（label 等）代表的勾选 input 不再单独列行，避免与控件根重复
      if (node.tagName === "INPUT" && checkableKind(node) && controlRootFor(node) !== node) continue;
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
    if (hasInferred) lines.push("（勾选状态带 ? 为多信号推断值）");
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
  // wait：MutationObserver 监听 DOM 变化，等元素/文本出现或消失，免轮询
  // -------------------------------------------------------------------------

  function waitFor(msg) {
    const timeout = Math.min(Number(msg.timeout) || 10000, 60000);
    const state = msg.state || "visible"; // visible | gone
    const deadline = Date.now() + timeout;
    return new Promise((resolve, reject) => {
      const check = () => {
        let ok;
        if (msg.text) {
          const has = (document.body.innerText || "").includes(msg.text);
          ok = state === "gone" ? !has : has;
        } else {
          let el = null;
          try { el = resolveEl(msg); } catch { el = null; }
          ok = state === "gone" ? !el : !!(el && isVisible(el));
        }
        if (ok) {
          obs.disconnect();
          resolve({ waited: true, state, ...(msg.text ? { text: msg.text } : { target: msg.ref ? "@" + msg.ref : msg.selector }) });
          return true;
        }
        if (Date.now() > deadline) {
          obs.disconnect();
          reject(new Error("wait 超时（" + timeout + "ms）：" + (msg.text ? "文本 " + JSON.stringify(msg.text) : (msg.ref ? "@" + msg.ref : msg.selector)) + " 未变为 " + state));
          return true;
        }
        return false;
      };
      const obs = new MutationObserver(() => check());
      if (check()) return;
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    });
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
            const root = findCheckableRoot(el);
            // 勾选类控件落到可视方块上点，避免落在文本或 tooltip 按钮上
            const target = root ? (pickCheckableClickTarget(root) || root) : el;
            target.scrollIntoView({ behavior: "instant", block: "center" });
            target.click();
            result = { clicked: msg.ref ? "@" + msg.ref : msg.selector, trusted: false, ...(root ? { checkable: true } : {}) };
            break;
          }
          case "coords": {
            const el = resolveEl(msg);
            const root = findCheckableRoot(el);
            const target = root ? (pickCheckableClickTarget(root) || root) : el;
            result = { ...centerCoords(target), ...(root ? { checkable: true } : {}) };
            break;
          }
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
            // 带目标元素时为容器内滚动（聊天记录、长列表 div），否则滚整个 window
            const target = (msg.ref || msg.selector) ? resolveEl(msg) : null;
            const scroller = target
              ? (target.scrollHeight > target.clientHeight || target.scrollWidth > target.clientWidth ? target : null)
              : null;
            if (target && !scroller) throw new Error("目标元素不是可滚动容器");
            const by = (x, y) => (scroller ? scroller.scrollBy(x, y) : window.scrollBy(x, y));
            const to = (x, y) => (scroller ? scroller.scrollTo(x, y) : window.scrollTo(x, y));
            if (dir === "up") by(0, -amt);
            else if (dir === "down") by(0, amt);
            else if (dir === "left") by(-amt, 0);
            else if (dir === "right") by(amt, 0);
            else if (dir === "top") to(scroller ? scroller.scrollLeft : 0, 0);
            else if (dir === "bottom") to(scroller ? scroller.scrollLeft : 0, scroller ? scroller.scrollHeight : document.documentElement.scrollHeight);
            else throw new Error("未知滚动方向: " + dir);
            result = { scrolled: dir, amount: amt, container: !!scroller };
            break;
          }
          case "scroll_to": { const el = resolveEl(msg); el.scrollIntoView({ behavior: "instant", block: "center" }); result = { scrolled_to: true }; break; }
          case "wait": result = await waitFor(msg); break;
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
