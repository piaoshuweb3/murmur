/* ==========================================================================
   murmur · Wave-5 E 线 —— 交易所 UI 专业化独立模块（exchange.js）
   ----------------------------------------------------------------------------
   Task 49-exc 纪律：
   · IIFE 自包含，唯一全局 window.MurmurExchange = { mount, unmount, I18N_KEYS }；
   · 只消费既有同源只读端点 /bourse 与 /meme/snapshot（API 基座解析与 app.js 完全一致：
     ?api= > localStorage("murmur-api") > "/api"），零新端点、零新 var、零外部依赖；
   · 诚实空态纪律：端点关/未就绪/不可达一律渲染诚实文案，绝不显示假数据；
     失败保留上次成功渲染并挂"降级"徽标；
   · i18n：内嵌 FALLBACK en/zh 字典并导出 I18N_KEYS 供主线程合入 i18n-ui.js；
     若主线程暴露 window.MURMUR_T(key, params)（合入后的真实全局翻译函数）则优先用之；
     语言跟随：MutationObserver 监听 <html lang>（setLang 会改写它）+ 每次 poll 重渲染；
   · 生命周期：60s 定时轮询、document.visibilitychange 暂停/恢复、6s AbortController
     超时、unmount 全量清理（定时器/观察器/在途请求/监听）；全程 catch，零 console error；
   · 不依赖 app.js 内部函数（fmtMurmur / chronTimeAgo 按真实语义复刻）。
   ========================================================================== */
(function () {
  "use strict";

  /* ============================== i18n ============================== */
  // 内嵌双语字典（英文为权威 fallback；zh 全量）。主线程合入 i18n-ui.js 后，
  // 这些键在 7 语界面里走站点统一管线；未合入前本模块用此字典自持。
  const I18N_KEYS = {
    "exch.title": { en: "exchange · the bourse", zh: "交易所 · 行情带" },
    "exch.ariaPanel": { en: "exchange — the bourse tape and the meme watchlist", zh: "交易所 — 行情带与 meme 观察名单" },
    "exch.disabled": { en: "the tape is not enabled on this deployment (BOURSE_ENABLED=false)", zh: "本部署未启用行情带（BOURSE_ENABLED=false）" },
    "exch.awaiting": { en: "tape enabled — awaiting the first sampled cron", zh: "行情带已启用 · 等待首个采样 cron" },
    "exch.offline": { en: "the tape is unreachable right now", zh: "行情带暂时不可达" },
    "exch.stale": { en: "live read failed — showing the last good data", zh: "实时读取失败 · 显示上次成功数据" },
    "exch.fever": { en: "tape fever", zh: "行情热度" },
    "exch.feelHot": { en: "hot", zh: "火热" },
    "exch.feelQuiet": { en: "quiet", zh: "平静" },
    "exch.feelCool": { en: "cool", zh: "降温" },
    "exch.ariaGauge": { en: "tape fever {v}, {s}", zh: "行情热度 {v}，{s}" },
    "exch.breakLevel": { en: "breakout · 0.8", zh: "突破线 · 0.8" },
    "exch.volTitle": { en: "community volume · last hour", zh: "社区成交量 · 近 1 小时" },
    "exch.ariaSpark": { en: "community volume sparkline, {n} of 60 samples", zh: "社区成交量折线，已采 {n}/60 点" },
    "exch.sampling": { en: "sampling · {n}/60", zh: "采集中 · {n}/60" },
    "exch.trades": { en: "trades this tick", zh: "本 tick 笔数" },
    "exch.volume": { en: "volume", zh: "成交量" },
    "exch.treasury": { en: "to the treasury", zh: "流入国库" },
    "exch.silent": { en: "silent ticks", zh: "静默 tick" },
    "exch.tapeTitle": { en: "recent scratches on the tape", zh: "行情带近期刻痕" },
    "exch.noEvents": { en: "the tape is blank — nothing worth carving yet", zh: "纸带空白——暂无值得铭刻之事" },
    "exch.updated": { en: "tape updated {ago} ago", zh: "纸带更新于 {ago} 前" },
    "exch.whaleOn": { en: "a whale-sized community leg moved this tick", zh: "本 tick 出现鲸鱼级社区转账" },
    "exch.whaleLine": { en: "whale · {who} moved {amt}", zh: "鲸鱼 · {who} 移动了 {amt}" },
    "exch.kind.FEVER_BREAKOUT": { en: "breakout", zh: "突破" },
    "exch.kind.WHALE_MOVE": { en: "whale", zh: "鲸鱼" },
    "exch.kind.TREASURY_MILESTONE": { en: "treasury", zh: "国库" },
    "exch.kind.LONG_SILENCE": { en: "silence", zh: "静默" },
    "exch.watchTitle": { en: "meme watchlist", zh: "meme 观察名单" },
    "exch.ariaWatch": { en: "meme watchlist, {n} tokens", zh: "meme 观察名单，{n} 个代币" },
    "exch.memeOff": { en: "meme channel off — nothing is being sampled (MEME_ENABLED=false)", zh: "meme 通道未启用 · 未采样（MEME_ENABLED=false）" },
    "exch.memeDegraded": { en: "meme sampling degraded — no trustworthy token data right now", zh: "meme 采样降级 · 暂无可信代币数据" },
    "exch.memeOffline": { en: "meme snapshot unreachable", zh: "meme 快照不可达" },
    "exch.noSignals": { en: "no candidate tokens this tick", zh: "本 tick 暂无候选代币" },
    "exch.regime": { en: "regime", zh: "状态" },
    "exch.colToken": { en: "token", zh: "代币" },
    "exch.colHeat": { en: "heat", zh: "热度" },
    "exch.colRisk": { en: "rug risk", zh: "rug 风险" },
    "exch.detailReasons": { en: "signals", zh: "信号" },
    "exch.detailLiquidity": { en: "liquidity", zh: "流动性" },
    "exch.detailPrice": { en: "price", zh: "价格" },
    "exch.detailAddr": { en: "address", zh: "地址" },
    "exch.skelNote": { en: "reading the tape…", zh: "正在读取行情带…" },
    "exch.liveChip": { en: "live", zh: "实时" },
    "exch.notLiveChip": { en: "read-only", zh: "只读" },
  };

  // 当前语言：页面 setLang() 会把 <html lang> 写成 en/zh/fr/…，此处只映射到字典的两语。
  let curLang = "en";
  function detectLang() {
    try {
      const l = (document.documentElement.getAttribute("lang") || "en").toLowerCase();
      curLang = l.indexOf("zh") === 0 ? "zh" : "en";
    } catch { curLang = "en"; }
  }
  // 翻译入口：优先主线程暴露的全局翻译函数（合入 I18N_KEYS 后由主线程挂 window.MURMUR_T），
  // 否则用内嵌字典；{x} 占位符替换语义与站点 t() 一致。
  function t(key, params) {
    try {
      if (typeof window.MURMUR_T === "function") {
        const s = window.MURMUR_T(key, params);
        if (typeof s === "string" && s && s !== key) return s;
      }
    } catch { /* 全局翻译器异常 → 落回内嵌字典，绝不让 UI 空白 */ }
    const entry = I18N_KEYS[key];
    let s = entry ? (entry[curLang] != null ? entry[curLang] : entry.en) : key;
    if (params) {
      for (const k of Object.keys(params)) {
        if (params[k] == null) continue;
        s = s.split("{" + k + "}").join(String(params[k]));
      }
    }
    return s;
  }

  /* ============================ 小工具（复刻站点语义） ============================ */
  // fmtMurmur 复刻：4.89M 风格紧凑标记（与 app.js fmtMurmur 同语义，独立实现不依赖内部函数）。
  function fmtMurmur(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "–";
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n * 100) / 100);
  }
  // 相对时间复刻（chronTimeAgo 同语义：42s / 5m / 3h / 2d，语言中立）。
  function timeAgo(ts) {
    const s = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60); if (m < 60) return m + "m";
    const h = Math.floor(m / 60); if (h < 48) return h + "h";
    return Math.floor(h / 24) + "d";
  }
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  // 短地址：0xabc…def（观察名单只有合约地址，无符号字段——诚实按地址展示）
  function shortAddr(a) {
    const s = String(a || "");
    if (s.length <= 12) return s;
    return s.slice(0, 6) + "…" + s.slice(-4);
  }
  const SVG_NS = "http://www.w3.org/2000/svg";
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgEl(name, attrs) {
    const n = document.createElementNS(SVG_NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  /* ============================ API 基座（与 app.js 一致） ============================ */
  function apiBase() {
    try {
      const p = new URLSearchParams(location.search).get("api");
      if (p) return p;
      const ls = localStorage.getItem("murmur-api");
      if (ls) return ls;
    } catch { /* localStorage 可能被禁 → 默认同源 /api */ }
    return "/api";
  }

  /* ============================ 模块状态 ============================ */
  const VOL_MAX = 60;              // sparkline 环形缓冲：60 点 × 60s ≈ 1 小时窗口
  const POLL_MS = 60000;           // 与漏斗卡同拍：数据按 cron 节奏前进
  const FETCH_TIMEOUT_MS = 6000;   // 6s 超时 AbortController

  let root = null;                 // 挂载根（.exch-panel）
  let ownRoot = false;             // 根是否由本模块创建（决定 unmount 时是否移除节点）
  let mounted = false;
  let timer = null;
  let inflight = null;             // 在途轮询的 AbortController（暂停/卸载时 abort）
  let langObs = null;              // <html lang> 观察器
  let onVis = null;                // visibilitychange 监听引用

  let bourse = null;               // 最近一次成功的 /bourse payload
  let bourseStale = false;         // 最近一次 /bourse 拉取失败（保留旧渲染 + 降级徽标）
  let meme = null;                 // 最近一次成功的 /meme/snapshot payload
  let memeState = "loading";       // loading | off | degraded | data | stale | fail
  let volBuf = [];                 // volumeMurmur 环形缓冲（客户端自采，非服务器历史）
  let expanded = new Set();        // 观察名单展开明细的 token 集合（跨渲染保持）
  // 面板级模式：skeleton（首拉未归）| data（bourse 数据在渲染）| empty（bourse 整面板诚实空态）。
  // bourse 空态优先：一旦整面板空态，观察名单渲染即被门控，避免两路 poll 交替重画（振荡）。
  let panelMode = "skeleton";

  // DOM 引用（buildSkeleton 时缓存）
  let refs = {};

  /* ============================ 拉取（fail-soft） ============================ */
  async function getJSON(path) {
    const ctrl = new AbortController();
    inflight = ctrl;
    const timerId = setTimeout(() => { try { ctrl.abort(); } catch { /* 已 abort */ } }, FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(apiBase() + path, { cache: "no-store", signal: ctrl.signal });
      if (r.status === 501) {
        // 501 = 可选特性明确关闭（body 是 {enabled:false}）——是"诚实关闭"不是网络故障
        try {
          const j = await r.json();
          if (j && j.enabled === false) return { disabled: true };
        } catch { /* body 不可解析 → 按失败处理 */ }
        return null;
      }
      if (!r.ok) throw new Error("http " + r.status);      // 其余非 2xx = 真失败 → 走 fail-soft 降级路径
      return await r.json();
    } finally {
      clearTimeout(timerId);
      if (inflight === ctrl) inflight = null;
    }
  }

  async function pollBourse() {
    try {
      const j = await getJSON("/bourse");
      if (j && j.disabled) { bourse = null; bourseStale = false; if (mounted) panelEmpty("exch.disabled"); return; }
      if (j && typeof j === "object" && j.enabled !== false) {
        bourse = j; bourseStale = false;
        // 成交量环形缓冲：只在拿到真实数值时推进（60s 一点 ≈ 1h 窗口）
        const v = Number(j.volumeMurmur);
        if (Number.isFinite(v)) { volBuf.push(v); if (volBuf.length > VOL_MAX) volBuf.shift(); }
        renderBourse();
        return;
      }
      // 未就绪（live:false / 空对象）→ 诚实等待态
      bourse = null; bourseStale = false; if (mounted) panelEmpty("exch.awaiting");
    } catch {
      // fail-soft：保留上次成功渲染 + 降级徽标；从未成功过 → 诚实不可达态
      if (bourse) { bourseStale = true; renderBourse(); }
      else { bourseStale = false; if (mounted) panelEmpty("exch.offline"); }
    }
  }

  async function pollMeme() {
    try {
      const j = await getJSON("/meme/snapshot");
      if (j && j.disabled) { meme = null; memeState = "off"; renderMeme(); return; }
      if (j && typeof j === "object") {
        if (j.armed === false) { meme = null; memeState = "off"; renderMeme(); return; }
        if (j.degraded) { meme = null; memeState = "degraded"; renderMeme(); return; }
        meme = j; memeState = "data"; renderMeme(); return;
      }
      meme = null; memeState = "fail"; renderMeme();
    } catch {
      if (meme) { memeState = "stale"; renderMeme(); }   // 保留上次成功渲染
      else { memeState = "fail"; renderMeme(); }
    }
  }

  function pollAll() {
    // 两路独立 fail-soft，互不拖累；本函数自身绝不抛出
    pollBourse();
    pollMeme();
  }

  /* ============================ 骨架与静态结构 ============================ */
  // 整面板级诚实空态（唯一实现；panelMode 门控防止与 meme 渲染交替重画）。
  function panelEmpty(key) {
    if (!mounted || !root) return;
    if (!refs.body || !refs.body.isConnected) buildSkeleton();
    panelMode = "empty";
    refs.body.textContent = "";
    const box = el("div", "exch-empty");
    box.setAttribute("role", "note");
    box.appendChild(el("b", null, t(key)));
    box.appendChild(el("div", "exch-skel w40"));   // 一条静止占位线，面板高度不至于塌陷
    refs.body.appendChild(box);
    setLive(false);
  }

  function setLive(on) {
    if (!refs.liveChip) return;
    refs.liveChip.textContent = on ? t("exch.liveChip") : t("exch.notLiveChip");
    refs.liveChip.className = "exch-live" + (on ? " on" : "");
  }

  // 表盘几何：240° 弧。数学角 210° → −30°（屏幕上左下 → 顶 → 右下，顺时针）。
  const G = { cx: 100, cy: 112, r: 76, start: 210, sweep: 240 };
  function polar(r, deg) {
    const rad = (deg * Math.PI) / 180;
    return [G.cx + r * Math.cos(rad), G.cy - r * Math.sin(rad)];
  }
  const fmt = (n) => (Math.round(n * 100) / 100).toString();

  function buildGaugeSvg() {
    const svg = svgEl("svg", { viewBox: "0 0 200 158", "aria-hidden": "true" });
    const defs = svgEl("defs", {});
    // 冷色 → 琥珀 → 热三段渐变（色值全部走 styles.css 既有地球色 token）
    const grad = svgEl("linearGradient", { id: "exch-grad-fever", x1: "0", y1: "0", x2: "1", y2: "0" });
    const s0 = svgEl("stop", { offset: "0%" }); s0.setAttribute("style", "stop-color:var(--aggregate)");
    const s1 = svgEl("stop", { offset: "52%" }); s1.setAttribute("style", "stop-color:var(--explore)");
    const s2 = svgEl("stop", { offset: "100%" }); s2.setAttribute("style", "stop-color:var(--agitate)");
    grad.append(s0, s1, s2);
    defs.appendChild(grad);
    svg.appendChild(defs);

    const [sx, sy] = polar(G.r, G.start);
    const [ex, ey] = polar(G.r, G.start - G.sweep);
    const d = `M ${fmt(sx)} ${fmt(sy)} A ${G.r} ${G.r} 0 1 1 ${fmt(ex)} ${fmt(ey)}`;
    // pathLength=100 → dasharray 直接用 fever*100 插值
    svg.appendChild(svgEl("path", { d, class: "exch-gauge-track", pathLength: "100", "stroke-width": "9" }));
    const fill = svgEl("path", { d, class: "exch-gauge-fill", pathLength: "100", "stroke-width": "9" });
    fill.setAttribute("style", "stroke:url(#exch-grad-fever)");
    fill.setAttribute("stroke-dasharray", "0 100");
    svg.appendChild(fill);
    // 0.8 breakout 刻度线（FEVER_BREAKOUT_LEVEL，与后端 bourse.ts 阈值一致）
    const [t1x, t1y] = polar(66, G.start - G.sweep * 0.8);
    const [t2x, t2y] = polar(86, G.start - G.sweep * 0.8);
    svg.appendChild(svgEl("line", {
      x1: fmt(t1x), y1: fmt(t1y), x2: fmt(t2x), y2: fmt(t2y), class: "exch-gauge-tick",
    }));
    return svg;
  }

  function buildSparkSvg() {
    const svg = svgEl("svg", { viewBox: "0 0 240 54", preserveAspectRatio: "none", "aria-hidden": "true" });
    const defs = svgEl("defs", {});
    const grad = svgEl("linearGradient", { id: "exch-grad-spark", x1: "0", y1: "0", x2: "0", y2: "1" });
    const s0 = svgEl("stop", { offset: "0%" }); s0.setAttribute("style", "stop-color:var(--accent)"); s0.setAttribute("stop-opacity", "0.45");
    const s1 = svgEl("stop", { offset: "100%" }); s1.setAttribute("style", "stop-color:var(--accent)"); s1.setAttribute("stop-opacity", "0");
    grad.append(s0, s1);
    defs.appendChild(grad);
    svg.appendChild(defs);
    svg.appendChild(svgEl("path", { class: "exch-spark-area", d: "" }));
    svg.appendChild(svgEl("polyline", { class: "exch-spark-line", points: "" }));
    return svg;
  }

  function buildSkeleton() {
    panelMode = "skeleton";
    root.textContent = "";
    refs = {};

    // ---- 头 ----
    const head = el("div", "exch-head");
    const title = el("span", "exch-title", t("exch.title"));
    const live = el("span", "exch-live", t("exch.notLiveChip"));
    head.append(title, live);
    root.appendChild(head);
    refs.liveChip = live;
    root.setAttribute("aria-label", t("exch.ariaPanel"));

    // ---- 体：左右两列（窄视口自动单列，见 CSS） ----
    const body = el("div", "exch-body");
    const left = el("div", "exch-col-left");
    const right = el("div", "exch-col-right");

    // 左列 · 表盘
    left.appendChild(el("div", "exch-sub", t("exch.fever")));
    const gwrap = el("div", "exch-gauge");
    gwrap.setAttribute("role", "img");
    gwrap.appendChild(buildGaugeSvg());
    const gcenter = el("div", "exch-gauge-center");
    const gnum = el("div", "exch-gauge-num", "–");
    const gword = el("div", "exch-gauge-word", "–");
    gcenter.append(gnum, gword);
    gwrap.appendChild(gcenter);
    left.appendChild(gwrap);
    const gcap = el("div", "exch-gauge-cap");
    gcap.appendChild(el("span", null, "0.0"));
    gcap.appendChild(el("span", null, t("exch.breakLevel")));
    gcap.appendChild(el("span", null, "1.0"));
    left.appendChild(gcap);
    refs.gaugeWrap = gwrap; refs.gaugeNum = gnum; refs.gaugeWord = gword;

    // 左列 · 成交量 sparkline
    left.appendChild(el("div", "exch-sub", t("exch.volTitle")));
    const swrap = el("div", "exch-spark");
    swrap.setAttribute("role", "img");
    swrap.appendChild(buildSparkSvg());
    const snote = el("div", "exch-spark-note", t("exch.sampling", { n: "0" }));
    swrap.appendChild(snote);
    left.appendChild(swrap);
    refs.sparkWrap = swrap; refs.sparkSvg = swrap.querySelector("svg");
    refs.sparkNote = snote; refs.sparkLine = swrap.querySelector("polyline"); refs.sparkArea = swrap.querySelector("path.exch-spark-area");

    // 左列 · 微观四格
    const micro = el("dl", "exch-micro");
    refs.micro = {};
    for (const [key, label] of [["trades", "exch.trades"], ["volume", "exch.volume"], ["treasury", "exch.treasury"], ["silent", "exch.silent"]]) {
      const cell = el("div");
      cell.appendChild(el("dt", null, t(label)));
      const dd = el("dd", null, "–");
      cell.appendChild(dd);
      micro.appendChild(cell);
      refs.micro[key] = dd;
    }
    left.appendChild(micro);

    // 左列 · whale 行 + 更新脚注
    const whale = el("div", "exch-whale");
    whale.hidden = true;
    left.appendChild(whale);
    refs.whale = whale;
    const foot = el("div", "exch-foot");
    const upd = el("div", null, "");
    const stale = el("span", "exch-stale", t("exch.stale"));
    stale.hidden = true;
    foot.append(upd, stale);
    left.appendChild(foot);
    refs.updated = upd; refs.staleChip = stale;

    // 右列 · tape 事件流
    right.appendChild(el("div", "exch-sub", t("exch.tapeTitle")));
    const tapeScroll = el("div", "exch-tape-scroll");
    tapeScroll.appendChild(el("div", "exch-skel w80"));
    tapeScroll.appendChild(el("div", "exch-skel w60"));
    right.appendChild(tapeScroll);
    refs.tape = tapeScroll;

    // 右列 · meme 观察名单
    const wsub = el("div", "exch-sub");
    const wtitle = el("span", "exch-watch-head");
    wtitle.appendChild(el("span", null, t("exch.watchTitle")));
    const regime = el("span", "exch-regime", "–");
    regime.hidden = true;
    wtitle.appendChild(regime);
    wsub.appendChild(wtitle);
    right.appendChild(wsub);
    refs.regime = regime;
    const wcols = el("div", "exch-wcols");
    wcols.append(el("span", null, t("exch.colToken")), el("span", null, t("exch.colHeat")), el("span", null, t("exch.colRisk")));
    wcols.hidden = true;
    right.appendChild(wcols);
    refs.wcols = wcols;
    const watch = el("div", "exch-watch");
    watch.setAttribute("aria-label", t("exch.watchTitle"));
    watch.appendChild(el("div", "exch-skel w60"));
    right.appendChild(watch);
    refs.watch = watch;

    body.append(left, right);
    root.appendChild(body);
    refs.body = body;
  }

  /* ============================ 渲染 · bourse ============================ */
  // 注意：meme 与 bourse 共用面板体；bourse 空态优先（panelMode 门控 renderMeme），
  // 因此空态→数据态的重建由 ensureBody() 在下一次数据渲染前统一完成。

  // 确保渲染挂点真实在 DOM 上：bourse 空态恢复数据态、或 refs 被外力清空时重建骨架。
  function ensureBody() {
    if (!root) return false;
    if (panelMode === "empty" || !refs.body || !refs.body.isConnected || !refs.gaugeWrap || !refs.gaugeWrap.isConnected) {
      buildSkeleton();
    }
    return true;
  }

  function feverWord(f) {
    return f > 0.6 ? t("exch.feelHot") : f < 0.2 ? t("exch.feelCool") : t("exch.feelQuiet"); // 与站点 bourse.feel 阈值一致
  }
  function feverClass(f) { return f > 0.6 ? "hot" : f < 0.2 ? "cool" : "quiet"; }

  function renderBourse() {
    if (!mounted || !bourse || !ensureBody()) return;
    panelMode = "data";
    const b = bourse;

    // ---- 表盘：dasharray 插值 + 中心数字/状态词 ----
    const fever = clamp01(Number(b.fever) || 0);
    if (refs.gaugeWrap) {
      const fillPath = refs.gaugeWrap.querySelector(".exch-gauge-fill");
      if (fillPath) fillPath.setAttribute("stroke-dasharray", (fever * 100).toFixed(1) + " 100");
      refs.gaugeNum.textContent = (fever * 100).toFixed(1) + "%";
      refs.gaugeWord.textContent = feverWord(fever);
      refs.gaugeWord.className = "exch-gauge-word " + feverClass(fever);
      refs.gaugeWrap.setAttribute("aria-label", t("exch.ariaGauge", { v: (fever * 100).toFixed(1) + "%", s: feverWord(fever) }));
    }

    // ---- sparkline：环形缓冲 → polyline + 面积渐变；<2 点诚实"采集中" ----
    drawSpark();

    // ---- 微观四格 ----
    if (refs.micro) {
      refs.micro.trades.textContent = Number.isFinite(Number(b.txCount)) ? Number(b.txCount).toLocaleString() : "–";
      refs.micro.volume.textContent = fmtMurmur(b.volumeMurmur);
      refs.micro.treasury.textContent = fmtMurmur(b.treasuryInMurmur);
      refs.micro.silent.textContent = Number.isFinite(Number(b.silentTicks)) ? Number(b.silentTicks).toLocaleString() : "–";
    }

    // ---- whale 行：payload 真实形状是 boolean（也兼容 string / {who,amount} 形状，同 app.js 容错） ----
    if (refs.whale) {
      const w = b.whale;
      let line = "";
      if (w === true) line = "♛ " + t("exch.whaleOn");
      else if (typeof w === "string" && w.trim()) line = "♛ " + w.trim();
      else if (w && typeof w === "object") {
        const who = w.who != null ? w.who : (w.id != null ? w.id : (w.fly != null ? w.fly : (w.address != null ? w.address : "")));
        const amt = w.amount != null ? w.amount : (w.volumeMurmur != null ? w.volumeMurmur : (w.murmur != null ? w.murmur : ""));
        if (String(who).trim() !== "" || String(amt).trim() !== "") line = "♛ " + t("exch.whaleLine", { who: String(who), amt: fmtMurmur(amt) });
      }
      refs.whale.textContent = line;
      refs.whale.hidden = line === "";
    }

    // ---- tape 事件流：events[] 倒序（最新在上），kind 着色，whale 行高亮 ----
    if (refs.tape) {
      refs.tape.textContent = "";
      const events = Array.isArray(b.events) ? b.events.slice() : [];
      events.reverse();                                     // 服务器按 kind 固定序产出 → 倒序 = 最新在前
      const shown = events.slice(0, 12);
      if (!shown.length) {
        refs.tape.appendChild(el("div", "exch-noev", t("exch.noEvents")));
      } else {
        for (const ev of shown) {
          const kind = String((ev && ev.kind) || "").toUpperCase();
          const row = el("div", "exch-ev" + (kind === "FEVER_BREAKOUT" ? " is-breakout" : kind === "WHALE_MOVE" ? " is-whale" : kind === "LONG_SILENCE" ? " is-silence" : ""));
          row.appendChild(el("span", "exch-ev-ico", ICONS[kind] || "·"));
          const klabel = t("exch.kind." + kind);
          row.appendChild(el("span", "exch-ev-kind", klabel.indexOf("exch.kind.") === 0 ? (ev && ev.kind ? String(ev.kind).toLowerCase() : "·") : klabel));
          row.appendChild(el("span", "exch-ev-detail", String((ev && ev.detail) != null ? ev.detail : "")));
          row.appendChild(el("span", "exch-ev-ago", ev && ev.ts ? timeAgo(Number(ev.ts)) : ""));
          refs.tape.appendChild(row);
        }
      }
    }

    // ---- 脚注：更新时间 + 降级徽标 ----
    if (refs.updated) refs.updated.textContent = b.updatedAt ? t("exch.updated", { ago: timeAgo(Number(b.updatedAt)) }) : "";
    if (refs.staleChip) refs.staleChip.hidden = !bourseStale;
    setLive(b.live === true);
  }

  // kind → 图标（与 app.js BOURSE_EV_ICONS 同源字符）
  const ICONS = { FEVER_BREAKOUT: "✷", WHALE_MOVE: "♛", TREASURY_MILESTONE: "⛃", LONG_SILENCE: "❄" };

  function drawSpark() {
    if (!refs.sparkSvg) return;
    const n = volBuf.length;
    refs.sparkNote.hidden = n >= 2;
    refs.sparkNote.textContent = t("exch.sampling", { n: String(n) });
    refs.sparkWrap.setAttribute("aria-label", t("exch.ariaSpark", { n: String(n) }));
    if (n < 2) { refs.sparkLine.setAttribute("points", ""); refs.sparkArea.setAttribute("d", ""); return; }
    const W = 240, H = 54, PAD = 3;
    let max = 0;
    for (const v of volBuf) if (v > max) max = v;
    const xs = (i) => PAD + (i / (n - 1)) * (W - 2 * PAD);         // 最新点在右
    const ys = (v) => H - PAD - (max > 0 ? (v / max) : 0) * (H - 2 * PAD);
    const pts = volBuf.map((v, i) => fmt(xs(i)) + "," + fmt(ys(v))).join(" ");
    refs.sparkLine.setAttribute("points", pts);
    refs.sparkArea.setAttribute("d", `M ${fmt(xs(0))},${H - PAD} L ${pts.split(" ").join(" L ")} L ${fmt(xs(n - 1))},${H - PAD} Z`);
  }

  /* ============================ 渲染 · meme watchlist ============================ */
  // 链分组顺序（payload 真实 chain 值：solana | base | eth | arc，未知值兜底排最后）
  const CHAIN_ORDER = ["solana", "base", "eth", "arc"];
  const CHAIN_LABEL = { solana: "Solana", base: "Base", eth: "Ethereum", arc: "Arc" };
  // rug-risk 阈值（与后端 indicators.ts RUG_RISK 裁决一致：holderConcentration > 0.45 / liquidityHealth < 0.3）
  const RISK_HI = 0.45, RISK_MID = 0.3;

  function riskClass(risk) { return risk >= RISK_HI ? "hi" : risk >= RISK_MID ? "mid" : ""; }

  function renderMeme() {
    if (!mounted || !refs.watch || !ensureBody()) return;
    if (panelMode === "empty") return;   // bourse 整面板诚实空态优先：观察名单让位，不交替重画

    // regime 徽标（board 级：payload 里 regime 是整板状态，不是逐 token 字段——诚实按整板展示）
    if (refs.regime) {
      if (memeState === "data" && meme && meme.regime) {
        refs.regime.hidden = false;
        refs.regime.textContent = String(meme.regime).toLowerCase();
        refs.regime.className = "exch-regime r-" + String(meme.regime).replace(/[^A-Z_]/g, "");
      } else {
        refs.regime.hidden = true;
      }
    }

    refs.watch.textContent = "";
    if (memeState === "loading") {
      refs.watch.appendChild(el("div", "exch-skel w60"));
      refs.watch.appendChild(el("div", "exch-skel w40"));
      refs.wcols.hidden = true;
      return;
    }
    if (memeState === "off") {
      refs.watch.appendChild(el("div", "exch-wnote", t("exch.memeOff")));
      refs.wcols.hidden = true; return;
    }
    if (memeState === "degraded") {
      refs.watch.appendChild(el("div", "exch-wnote", t("exch.memeDegraded")));
      refs.wcols.hidden = true; return;
    }
    if (memeState === "fail") {
      refs.watch.appendChild(el("div", "exch-wnote", t("exch.memeOffline")));
      refs.wcols.hidden = true; return;
    }
    if (memeState === "stale") {
      refs.watch.appendChild(el("div", "exch-wnote", t("exch.stale")));
      // 继续渲染上次成功数据（若有）
    }
    if (!meme || !Array.isArray(meme.topSignals)) { refs.wcols.hidden = true; return; }
    const signals = meme.topSignals.filter((s) => s && typeof s === "object");
    if (!signals.length) {
      refs.watch.appendChild(el("div", "exch-wnote", t("exch.noSignals")));
      refs.wcols.hidden = true;
      return;
    }

    refs.wcols.hidden = false;
    refs.watch.setAttribute("aria-label", t("exch.ariaWatch", { n: String(signals.length) }));

    // 按链分组（以真实 payload 为准：出现什么链渲染什么链，组内保持服务器排序）
    const groups = new Map();
    for (const s of signals) {
      const c = String(s.chain || "").toLowerCase();
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(s);
    }
    const order = CHAIN_ORDER.filter((c) => groups.has(c))
      .concat([...groups.keys()].filter((c) => !CHAIN_ORDER.includes(c)));

    for (const chain of order) {
      const list = groups.get(chain);
      const head = el("div", "exch-chain");
      head.appendChild(el("span", null, CHAIN_LABEL[chain] || chain));
      head.appendChild(el("em", null, String(list.length)));
      refs.watch.appendChild(head);
      for (const s of list) {
        refs.watch.appendChild(watchRow(s, chain));
        if (expanded.has(String(s.token))) refs.watch.appendChild(watchDetail(s));
      }
    }
  }

  function watchRow(s, chain) {
    const score = clamp01(Number(s.score));
    const conc = Number(s.holderConcentration);              // rug-risk 数值 = top-10 持仓集中度（payload 缺失 → "–"）
    const hasRisk = Number.isFinite(conc);
    const rc = hasRisk ? riskClass(conc) : "";

    const row = el("button", "exch-wrow" + (rc ? " risk-" + rc : ""));
    row.type = "button";
    row.setAttribute("aria-expanded", expanded.has(String(s.token)) ? "true" : "false");
    const label = shortAddr(s.token) + " · " + (CHAIN_LABEL[chain] || chain) + " · " + (hasRisk ? (conc * 100).toFixed(0) + "%" : "–");
    row.setAttribute("aria-label", label);
    row.title = t("exch.colToken") + ": " + String(s.token || "–");

    const tok = el("span", "exch-wtok", shortAddr(s.token));
    const heat = el("span", "exch-wheat");
    const track = el("span", "exch-wtrack");
    const fill = el("span", "exch-wfill");
    fill.style.width = (score * 100).toFixed(1) + "%";
    track.appendChild(fill);
    heat.append(track, el("span", "exch-wscore", (score * 100).toFixed(0) + "%"));
    const risk = el("span", "exch-wrisk" + (rc ? " " + rc : ""), hasRisk ? (conc * 100).toFixed(0) + "%" : "–");

    row.append(tok, heat, risk);
    row.addEventListener("click", () => {
      const key = String(s.token);
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      renderMeme();                                          // 重新渲染以展开/收起明细（诚实数据，缺就是 –）
    });
    return row;
  }

  function watchDetail(s) {
    const det = el("dl", "exch-wdetail");
    const add = (dtKey, dd) => { det.appendChild(el("dt", null, t(dtKey))); det.appendChild(el("dd", null, dd)); };
    const reasons = Array.isArray(s.reasons) && s.reasons.length ? s.reasons.join(" · ") : "–";
    add("exch.detailReasons", reasons);
    const liq = Number(s.liquidityUsd);
    add("exch.detailLiquidity", Number.isFinite(liq) ? "$" + Math.round(liq).toLocaleString() : "–");
    const px = Number(s.priceUsd);
    add("exch.detailPrice", Number.isFinite(px) && px > 0 ? "$" + px.toPrecision(4) : "–");
    add("exch.detailAddr", String(s.token || "–"));
    return det;
  }

  /* ============================ 生命周期 ============================ */
  function startTimer() {
    stopTimer();
    timer = setInterval(() => { try { pollAll(); } catch { /* 轮询永不破面板 */ } }, POLL_MS);
  }
  function stopTimer() {
    if (timer != null) { clearInterval(timer); timer = null; }
  }

  function onVisibility() {
    try {
      if (document.hidden) { stopTimer(); if (inflight) { try { inflight.abort(); } catch { /* noop */ } } }
      else { pollAll(); startTimer(); }
    } catch { /* 可见性处理失败不外泄 */ }
  }

  function mount(target) {
    try {
      const host = target || document.getElementById("exchange-panel") || document.querySelector("[data-exchange-mount]");
      if (!host || host.nodeType !== 1) return false;
      if (mounted) unmount();                                 // 幂等重挂
      detectLang();
      if (host.classList.contains("exch-panel")) { root = host; ownRoot = false; }
      else { root = el("section", "exch-panel"); host.appendChild(root); ownRoot = true; }
      root.hidden = false;
      buildSkeleton();
      mounted = true;
      // 立即拉一次，然后 60s 定时；页面隐藏时暂停、可见时恢复
      pollAll();
      startTimer();
      onVis = onVisibility;
      document.addEventListener("visibilitychange", onVis);
      // 语言跟随：站点 setLang() 改写 <html lang> → 立即用当前缓存数据重渲染
      langObs = new MutationObserver(() => { try { detectLang(); rerender(); } catch { /* 重渲染失败不外泄 */ } });
      langObs.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
      return true;
    } catch {
      return false;                                           // 挂载失败静默：绝不影响主场景
    }
  }

  function unmount() {
    try {
      stopTimer();
      if (inflight) { try { inflight.abort(); } catch { /* noop */ } inflight = null; }
      if (langObs) { langObs.disconnect(); langObs = null; }
      if (onVis) { document.removeEventListener("visibilitychange", onVis); onVis = null; }
      if (root && ownRoot && root.parentNode) root.parentNode.removeChild(root);
      else if (root) { root.textContent = ""; root.hidden = true; }
    } catch { /* 清理失败静默 */ }
    root = null; refs = {}; mounted = false;
    bourse = null; meme = null; volBuf = []; expanded = new Set(); bourseStale = false; memeState = "loading"; panelMode = "skeleton";
  }

  // 用当前缓存数据全量重绘（语言切换共用；周期刷新走各 render 自身的 ensureBody 守卫）
  function rerender() {
    try {
      if (!mounted) return;
      if (bourse) renderBourse();
      else { buildSkeleton(); pollAll(); }                    // 无缓存数据 → 重建骨架并补拉
      renderMeme();
    } catch { /* 重渲染永不破面板 */ }
  }

  /* ============================ 导出 + 约定自挂载 ============================ */
  window.MurmurExchange = { mount, unmount, I18N_KEYS };

  // 集成约定：index.html 提供 <section id="exchange-panel" class="exch-panel" hidden></section>，
  // 本脚本（defer）在 DOM 就绪后自动挂载；主线程也可手动 MurmurExchange.mount(el)。
  function autoBoot() {
    try { mount(null); } catch { /* 自挂载失败静默：主页面不受影响 */ }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoBoot, { once: true });
  else autoBoot();
})();
