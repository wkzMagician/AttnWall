(() => {
  const english = {
    "界面语言": "Language",
    "检查连接…": "Checking connection…",
    "检查当前页…": "Checking this page…",
    "连接配置": "Connection setup",
    "AttnWall 连接配置": "AttnWall connection setup",
    "粘贴连接配置": "Paste connection config",
    "连接": "Connect",
    "打开 AttnWall ↗": "Open AttnWall ↗",
    "断开": "Disconnect",
    "AI 应用": "AI apps",
    "未连接": "Not connected",
    "连接异常": "Connection error",
    "已配置": "Configured",
    "ChatGPT 会话": "ChatGPT conversation",
    "Codex Web 任务": "Codex Web task",
    "DeepSeek 会话": "DeepSeek conversation",
    "当前页不可同步": "This page cannot be synced",
    "配置格式错误，请从 AttnWall 设置页复制": "Invalid configuration. Copy it from AttnWall settings.",
    "连接地址不应包含密码、路径或参数": "The connection URL must not contain a password, path, or query.",
    "只允许 HTTPS 或本机 localhost HTTP": "Only HTTPS or localhost HTTP is allowed.",
    "未授予 AttnWall 服务的网络访问权限": "Network access to AttnWall was not granted.",
    "AttnWall 未响应": "AttnWall did not respond.",
    "已连接": "Connected",
    "已断开": "Disconnected",
    "已配置 · 等待会话": "Configured · Waiting for a session",
    "· 等待会话": "· Waiting for a session",
    "请先在扩展弹窗中连接 AttnWall": "Connect AttnWall in the extension popup first.",
    "会话地址尚未被扩展发现。请先在原网站打开该会话或从网站侧栏进入，然后重试。": "The extension has not found this session. Open it on the original site or enter it from the site sidebar, then try again.",
    "网页未加载可识别的历史消息。请在原网页打开此会话，并检查扩展是否启用。": "No readable conversation history was found. Open this conversation in the original tab and check that the extension is enabled.",
    "原网页正在切换会话，等待历史内容加载": "The original page is switching conversations. Waiting for history to load.",
    "原网页正在切换会话，尚未发送": "The original page switched conversations. Nothing was sent."
  };
  const chinese = Object.fromEntries(Object.entries(english).map(([source, translated]) => [translated, source]));

  const storageKey = "attnwallLocale";
  const supported = new Set(["zh-CN", "en"]);
  const defaultLocale = (navigator.language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  let locale = defaultLocale;
  let userChanged = false;
  const textState = new WeakMap();
  const attributeState = new WeakMap();
  const isPopup = location.protocol === "chrome-extension:";

  function translate(source) {
    if (!source) return source;
    const leading = source.match(/^\s*/u)?.[0] || "";
    const trailing = source.match(/\s*$/u)?.[0] || "";
    const core = source.slice(leading.length, source.length - trailing.length);
    if (!core) return source;
    const useEnglish = locale === "en";
    let translated = (useEnglish ? english : chinese)[core];
    if (translated === undefined) {
      const waiting = useEnglish
        ? core.replace(/ · 等待会话$/, " · Waiting for a session")
        : core.replace(/ · Waiting for a session$/, " · 等待会话");
      if (waiting !== core) translated = waiting;
    }
    return translated === undefined ? source : leading + translated + trailing;
  }

  function localizeText(node) {
    const element = node.parentElement;
    if (!element || element.closest("script,style,textarea,code,[data-i18n-skip]") || element.isContentEditable) return;
    const previous = textState.get(node);
    const source = previous && node.data === previous.rendered ? previous.source : node.data;
    const rendered = translate(source);
    textState.set(node, {source, rendered});
    if (node.data !== rendered) node.data = rendered;
  }

  function localizeAttribute(element, name) {
    const current = element.getAttribute(name);
    if (current === null) return;
    let states = attributeState.get(element);
    if (!states) {
      states = new Map();
      attributeState.set(element, states);
    }
    const previous = states.get(name);
    const source = previous && current === previous.rendered ? previous.source : current;
    const rendered = translate(source);
    states.set(name, {source, rendered});
    if (current !== rendered) element.setAttribute(name, rendered);
  }

  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      localizeText(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node;
    if (element.hasAttribute("data-i18n-skip")) return;
    for (const name of ["title", "aria-label", "placeholder"]) localizeAttribute(element, name);
    if (element.matches("script,style,textarea") || element.isContentEditable) return;
    for (const child of element.childNodes) visit(child);
  }

  function applyDocument() {
    if (!isPopup) return;
    document.documentElement.lang = locale;
    for (const select of document.querySelectorAll("[data-language-select]")) select.value = locale;
    if (document.body) visit(document.body);
  }

  function setLocale(next, {persist = true, markUserChange = false} = {}) {
    if (!supported.has(next)) return;
    locale = next;
    if (markUserChange) userChanged = true;
    if (persist) chrome.storage.local.set({[storageKey]: locale});
    applyDocument();
  }

  if (isPopup) {
    document.addEventListener("change", event => {
      if (event.target instanceof Element && event.target.matches("[data-language-select]")) {
        setLocale(event.target.value, {markUserChange: true});
      }
    });

    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "characterData") visit(record.target);
        else if (record.type === "attributes") visit(record.target);
        else for (const node of record.addedNodes) visit(node);
      }
    });
    if (document.body) observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["title", "aria-label", "placeholder"]
    });
  }

  try {
    chrome.storage.local.get(storageKey, result => {
      if (userChanged || !supported.has(result?.[storageKey])) return;
      setLocale(result[storageKey], {persist: false});
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      const next = changes?.[storageKey]?.newValue;
      if (area === "local" && supported.has(next)) setLocale(next, {persist: false});
    });
  } catch {}

  applyDocument();
  globalThis.AttnWallExtensionI18n = Object.freeze({
    getLocale: () => locale,
    t: translate,
    setLocale: next => setLocale(next, {markUserChange: true})
  });
})();
