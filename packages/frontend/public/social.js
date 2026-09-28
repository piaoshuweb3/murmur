// ============================================================================
// murmur · Wave-5 S 线 —— 社交属性可视化独立模块（social.js）
// ----------------------------------------------------------------------------
// 定位：纯前端只读可视化面板。自建 IIFE，挂 window.MurmurSocial = { mount, unmount,
// I18N_KEYS }；与既有 app.js / styles.css / i18n*.js 零耦合（不改任何共享文件）。
//
// 数据纪律（Task 44 教训：先转储真实 payload 再写消费代码）：
//   生产环境实测（flyx402.xyz，2026-09-28 转储）：
//   · /state 顶层真实字段 = name/tickIndex/aliveCount/totalCount/cap/liveRetire/
//     vitality/resolverGas/collective/economy/market/lastCron/config —— 没有
//     nations/cities/war/territory/swarm 顶层域（规格 §5.1 的假设与真实不符，
//     按真实 payload 归位）：群体 mood/温度真实域 = state.collective
//     {temperature,regime,vitality,size,arousal,cohesion,rest,wingbeat,
//      states:{AGITATE,EXPLORE,AGGREGATE,REST},faps,valence}。
//   · /chronicle 在生产为 404 {"error":"no such endpoint"}；编年史真实端点 =
//     /annals（app.js pollAnnals 同款），支持 ?limit=1..500（默认 120）+
//     ?order=desc（默认）+?since/?before；返回 {enabled,era,eraName,eraRegime,
//     seq,order:"desc",count,entries:[{seq,tick,ts,kind,era,eraName,severity,
//     actors[],text,metrics,tokens,prevHash,hash}]}。
//   · 邦国/城市真实域 = /population → economy.dynasty.houses（economy.ts
//     houseRowFor 真实字段：{id,name,sigil,gen,foundedTick,members,live,deaths,
//     treasuryUsdc,earnedUsdc,capitalShare(0..1),tradition,vaultOnchainUsdc?,
//     homeZone?,controlsZones?}，服务端已 slice(0,8)）；economy 缺席/关旗 → 域缺席。
//   · 战役真实域 = /war（getWar：{enabled,armed,houses[],stats,wars[],state}），
//     wars[] 元素 = {warId,opened,resolved,attacker,defender,attackerName,
//     defenderName,stakeUsdc,potUsdc,powerA,powerB,deadline,secondsToDeadline,...}；
//     opened && !resolved 才是进行中（链上权威，胜过任何推断）。
//   · 每个字段访问都有存在性兜底（?? / 键检查 / Number.isFinite）；
//     任一数据域缺席 → 对应子组件整体不渲染（诚实空态，绝不灰显假占位）。
//
// 组件：
//   1. 社会脉搏条（全宽头部）—— state.collective.states 真实 mood 分布分段条
//      （复用既有 --agitate/--explore/--aggregate/--rest 行为态色板）+ regime
//      状态词 + 温度/躁动(arousal)/群情(valence)/心智数；collective 缺席但
//      market.temperature 在时退化为纯温度条；两者皆无 → "群体传感未就绪"。
//   2. 社会事件时间线 —— /annals 倒序，kind 图标 + 分类着色（战争=剑/红、宗教=
//      flame/琥珀、诗歌=quill/紫、发明=gear/蓝、领土=旗帜/绿；字符词汇与 app.js
//      CHRON_ICONS 同源），era 分组分隔线（纪元名从条目 tokens.eraName 恢复 +
//      live meta 补当前纪元，与 app.js renderChron 同语义，零硬编码），
//      hover/键盘聚焦展开全文，上限 30 条防溢出。
//   3. 邦国/城市卡 —— /population.economy.dynasty.houses 真实字段网格卡（纹章/
//      名称/世代/资本份额/心智数/肇基计时/控区数；卡左缘色 = 既有 houseColor
//      颜色词同源派生）；houses 空/缺席（当前线上真实态）→ 整卡组隐藏；
//      窗内编年史家族事件（HOUSE_FOUNDED/TERRITORY_SEIZED）仅作徽标注，绝不凭
//      空造家。
//   4. 战役横幅 —— 仅当 /war 数据域存在且 wars[] 有 opened&&!resolved 的进行中
//      战役时渲染：攻守双方 + 押注/奖池 + 裁决倒计时 + 最近领土易主（编年史
//      TERRITORY_SEIZED）标注；/war 不可达时以编年史 WAR_DECLARED/WAR_RESOLVED
//      推断兜底（仍为真实事件）；无战事零占位。
//
// 工程：60s 定时器 + visibilitychange 暂停 + mount 立即拉取；6s AbortController
// 超时；fail-soft（失败保留上次渲染）；语言跟随 html lang（MutationObserver）+
// localStorage(murmur:lang) 每次 T() 即时读取；优先尝试全局翻译桥
// window.MURMUR_T(key,params)（主线程把 I18N_KEYS 合入 i18n-ui.js 后即可接管），
// 否则用内嵌 en/zh 字典；unmount() 全量清理（定时器/监听/观察器/DOM）；
// 类名一律 soc- 前缀；不使用固定定位（桌面 absolute 右列、≤680px 并入既有
// 堆叠流），z-index=10 与既有面板同级；零 console error 纪律（全链路静默兜底）。
// ============================================================================

(function () {
  "use strict";

  // ---- 常量（与漏斗卡同水位的轮询/超时纪律） ----
  var POLL_MS = 60000;          // 60s 一轮（编年史推进缓慢，温度读数也无需更快）
  var FETCH_TIMEOUT_MS = 6000;  // 6s 超时 AbortController（任务硬约束）
  var ANNALS_LIMIT = 120;       // 每轮拉取的编年史条数（热环默认窗口，服务端上限 500）
  var TIMELINE_CAP = 30;        // 时间线渲染上限，防溢出（任务硬约束）
  var POLITY_CAP = 8;           // 邦国卡上限（与既有地名志卷 8 房上限同款纪律）

  // ==========================================================================
  // i18n —— 内嵌 en/zh 兜底字典；若主线程暴露 window.MURMUR_T(key, params) 则
  // 优先用（主线程把 I18N_KEYS 合入 i18n-ui.js 后即可无缝接管）；每次 poll 重渲染
  // 自然跟随语言。
  // ==========================================================================
  var I18N_KEYS = {
    "soc.panel.aria": { en: "swarm social read-out: mood pulse, chronicle timeline, polities and wars", zh: "群体社会读出：情绪脉搏、编年史时间线、邦国与战事" },
    "soc.title": { en: "social pulse", zh: "社会脉搏" },
    // ---- 脉搏条 ----
    "soc.pulse.unready": { en: "swarm sensing not ready — no collective read yet", zh: "群体传感未就绪——尚无群体读数" },
    "soc.pulse.aria": { en: "swarm mood distribution bar", zh: "群体情绪分布条" },
    "soc.pulse.minds": { en: "{n} minds", zh: "{n} 个心智" },
    "soc.pulse.temp": { en: "T {t}", zh: "温度 {t}" },
    "soc.pulse.arousal": { en: "agitation {v}", zh: "躁动 {v}" },
    "soc.pulse.valence": { en: "mood {v}", zh: "群情 {v}" },
    // 情绪态词（与既有行为态色板/种群面板词汇一致：躁动/探索/聚集/休憩）
    "soc.state.agitate": { en: "agitate", zh: "躁动" },
    "soc.state.explore": { en: "explore", zh: "探索" },
    "soc.state.aggregate": { en: "aggregate", zh: "聚集" },
    "soc.state.rest": { en: "rest", zh: "休憩" },
    // regime 状态词（与既有 i18n GLOSS.regime 词汇一致）
    "soc.regime.cold": { en: "cold", zh: "寒冷" },
    "soc.regime.calm": { en: "calm", zh: "平静" },
    "soc.regime.hot": { en: "hot", zh: "炽热" },
    // ---- 时间线 ----
    "soc.tl.title": { en: "swarm chronicle", zh: "群体纪事" },
    "soc.tl.eraDiv": { en: "era {era} · {name}", zh: "纪元 {era} · {name}" },
    "soc.tl.eraOnly": { en: "era {era}", zh: "纪元 {era}" },
    "soc.tl.tick": { en: "tick {n}", zh: "计时 {n}" },
    "soc.tl.more": { en: "+ {n} more in the annals", zh: "编年史中还有 {n} 条" },
    // ---- 邦国/城市卡 ----
    "soc.pol.title": { en: "polities", zh: "邦国 · 城市" },
    "soc.pol.gen": { en: "gen {n}", zh: "第 {n} 代" },
    "soc.pol.share": { en: "capital {s}", zh: "资本 {s}" },
    "soc.pol.seat": { en: "founded tick {n}", zh: "肇基于计时 {n}" },
    "soc.pol.zones": { en: "{n} zone(s)", zh: "{n} 片领地" },
    "soc.badge.founded": { en: "new house", zh: "新立" },
    "soc.badge.expanded": { en: "expanded", zh: "扩张" },
    "soc.badge.annexed": { en: "annexed", zh: "被吞并" },
    // ---- 战役横幅 ----
    "soc.war.ongoing": { en: "war · {atk} against {def}", zh: "战争 · {atk} 对 {def}" },
    "soc.war.stake": { en: "{s} USDC escrowed a side", zh: "双方各押 {s} USDC" },
    "soc.war.pot": { en: "pot {s} USDC", zh: "奖池 {s} USDC" },
    "soc.war.deadline": { en: "verdict in {t}", zh: "{t} 后裁决" },
    "soc.war.seized": { en: "{w} annexed {n} zone(s) from {l}", zh: "{w} 吞并了 {l} 的 {n} 片领土" }
  };

  /** 当前语言：localStorage(murmur:lang，与 i18n.js 同键) 优先 → html lang → 英文兜底。 */
  function detectLang() {
    try {
      var saved = localStorage.getItem("murmur:lang");
      if (saved === "zh" || saved === "en") return saved;
    } catch (e) { /* localStorage 可能被禁用 */ }
    var h = (document.documentElement.getAttribute("lang") || "").slice(0, 2).toLowerCase();
    return h === "zh" ? "zh" : "en";
  }

  /** 翻译：全局桥 window.MURMUR_T 优先（返回的串不等于键名才算命中）→ 内嵌字典 → 键名本身。 */
  function T(key, params) {
    if (typeof window.MURMUR_T === "function") {
      try {
        var s = window.MURMUR_T(key, params);
        if (typeof s === "string" && s && s !== key) return s;
      } catch (e) { /* 桥异常不影响本模块渲染 */ }
    }
    var L = detectLang();
    var entry = I18N_KEYS[key];
    var tpl = (entry && (entry[L] || entry.en)) || key;
    if (params) {
      tpl = String(tpl).replace(/\{(\w+)\}/g, function (m, k) {
        return params[k] == null ? "" : String(params[k]);
      });
    }
    return tpl;
  }

  // ==========================================================================
  // 小工具（全部与既有 app.js 同语义复刻：roman / 时间差 / fnv1a / 房色）
  // ==========================================================================
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clamp01(v) { v = Number(v); return isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n.toFixed(d) : null; }
  function signed(v, d) { var n = Number(v); return isFinite(n) ? (n > 0 ? "+" : "") + n.toFixed(d) : null; }
  /** 相对时间：与 app.js chronTimeAgo 同款（s/m/h/d）。 */
  function timeAgo(ts) {
    var t = Number(ts);
    if (!isFinite(t) || t <= 0) return "";
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60); if (m < 60) return m + "m";
    var h = Math.floor(m / 60); if (h < 48) return h + "h";
    return Math.floor(h / 24) + "d";
  }
  /** 倒计时跨度（战役裁决）：秒 → "3h 12m" / "5m" / "40s"。 */
  function fmtSpan(secs) {
    var s = Math.max(0, Math.floor(Number(secs) || 0));
    if (s >= 3600) return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
    if (s >= 60) return Math.floor(s / 60) + "m";
    return s + "s";
  }
  /** 罗马数字：与 app.js eraRoman 同表（纪元分隔线用小写）。 */
  function roman(n) {
    n = Number(n);
    if (!n || n <= 0) return String(n || "");
    var m = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"],
             [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
    var out = "", rest = n;
    for (var i = 0; i < m.length; i++) while (rest >= m[i][0]) { out += m[i][1]; rest -= m[i][0]; }
    return out;
  }
  var fnv1a = function (str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  };
  // 房族配色：与 app.js HOUSE_COLORS/HOUSE_FALLBACK/houseColor 同源复刻——
  // 纯视觉（颜色词家族名 → 色相；其余 fnv1a 散列到兜底色板），使卡片左缘色与地图层房色一致。
  var HOUSE_COLORS = {
    ochre: [196, 148, 60], ivory: [214, 206, 182], ashen: [148, 150, 154], vermilion: [198, 70, 48],
    amber: [214, 164, 64], slate: [110, 126, 146], sage: [140, 164, 120], plum: [150, 104, 140],
    teal: [86, 150, 150], rust: [170, 96, 60], indigo: [92, 102, 170], rose: [190, 110, 130],
    sable: [96, 84, 72], verdant: [120, 140, 96], azure: [96, 132, 176], crimson: [178, 58, 66]
  };
  var HOUSE_FALLBACK = [[176, 142, 86], [140, 104, 140], [96, 140, 138], [168, 110, 110], [124, 124, 168], [154, 110, 90]];
  function houseColorOf(name) {
    if (!name) return null;
    var k = String(name).toLowerCase();
    if (HOUSE_COLORS[k]) return HOUSE_COLORS[k];
    for (var w in HOUSE_COLORS) if (k.indexOf(w) !== -1) return HOUSE_COLORS[w];
    return HOUSE_FALLBACK[fnv1a(k) % HOUSE_FALLBACK.length];
  }

  // ==========================================================================
  // kind → 分类（着色）与图标。字符词汇与 app.js CHRON_ICONS 同源（TERRITORY_
  // SEIZED 按规格用旗帜 ⚑）；五个规格类别着色：战争=剑/红、宗教=flame/琥珀、
  // 诗歌=quill/紫、发明=gear/蓝、领土=旗帜/绿；其余类别落在铜金（纪元/家族/
  // 律法）或中性（市况/群像）上，保持纸面克制。映射表严格覆盖真实 ChronicleKind
  // 全集（chronicler.ts），零臆造 kind。
  // ==========================================================================
  var KIND_CATS = {
    // ⑨ 战争（红·剑）
    WAR_DECLARED: "war", WAR_RESOLVED: "war",
    // 信仰膜（琥珀·flame）
    PROPHET: "religion", SECT_FOUNDED: "religion", SCHISM: "religion", HOLY_DAY: "religion", SECT_FADE: "religion",
    // 诗歌/文风（紫·quill）：挽歌 + 习俗/风潮（文化叙事中最接近笔墨的两类）
    ELEGY: "poetry", TRADITION: "poetry", TREND: "poetry",
    // 创作/功业（蓝·gear）：首笔交易、里程碑、纪录、易主
    FIRST_TRADE: "invention", MILESTONE: "invention", RECORD_CONC: "invention", LEAD_CHANGE: "invention",
    // 领土（绿·旗帜）
    TERRITORY_SEIZED: "territory",
    // 家族/律法/纪元（铜金）
    HOUSE_FOUNDED: "polity", DYNASTY: "polity",
    ASSEMBLY: "law", DECREE: "law", TAX_LEVIED: "law",
    ERA_OPEN: "era", ERA_SHIFT: "era", ERA_PASSAGE: "era", EPOCH_OPEN: "era", EPOCH_CLOSE: "era",
    // 市况/群像（中性）
    MARKET_SHIFT: "market", CREDIT: "market", RUN: "market", CLASS: "market",
    COIN_FEVER: "market", WHALE_MOVE: "market", TREASURY_FLOW: "market", COIN_SILENCE: "market",
    FEUD: "crowd", ALLIANCE: "crowd", BETRAYAL: "crowd", REPUTATION: "crowd",
    FEAST: "crowd", PANIC: "crowd", HUDDLE: "crowd", STORM: "crowd", BIRTH: "crowd"
  };
  var KIND_ICONS = {
    WAR_DECLARED: "⚔", WAR_RESOLVED: "⚑", TAX_LEVIED: "⛃", TERRITORY_SEIZED: "⚑",
    PROPHET: "✹", SECT_FOUNDED: "✹", SCHISM: "✹", HOLY_DAY: "✹", SECT_FADE: "✹",
    ELEGY: "✒", TRADITION: "⚜", TREND: "≈",
    FIRST_TRADE: "⚡", MILESTONE: "◆", RECORD_CONC: "⚖", LEAD_CHANGE: "♛",
    HOUSE_FOUNDED: "⌂", DYNASTY: "♜",
    ASSEMBLY: "⛬", DECREE: "✎",
    ERA_OPEN: "✦", ERA_SHIFT: "✧", ERA_PASSAGE: "⧖", EPOCH_OPEN: "✷", EPOCH_CLOSE: "✥",
    MARKET_SHIFT: "↕", CREDIT: "⛁", RUN: "⇊", CLASS: "☰",
    COIN_FEVER: "↕", WHALE_MOVE: "⛁", TREASURY_FLOW: "⛁", COIN_SILENCE: "⛁",
    FEUD: "⚔", ALLIANCE: "❖", BETRAYAL: "✕", REPUTATION: "☠",
    FEAST: "✿", PANIC: "⚡", HUDDLE: "❄", STORM: "☀", BIRTH: "✿"
  };
  function kindCat(kind) { return KIND_CATS[kind] || "crowd"; }
  function kindIcon(kind) { return KIND_ICONS[kind] || "·"; }

  // ==========================================================================
  // 模块状态：host/root 引用、定时器、观察器、最近一次成功数据（fail-soft 保留）
  //   S.war 语义：null = 域不可达（未拉到）→ 允许编年史推断兜底；
  //               对象 = 已拉到权威 /war payload（无进行中战役就是真无战事）。
  // ==========================================================================
  var S = {
    alive: false, root: null, ui: null,
    timer: 0, inFlight: false,
    langObs: null, onVis: null,
    state: null,    // 最近一次成功的 /state payload（群体脉搏）
    annals: null,   // 最近一次成功的 /annals payload（时间线 + 徽标/推断兜底）
    pop: null,      // 最近一次成功的 /population payload（邦国/城市真实域）
    war: null       // 最近一次成功的 /war payload（战役权威域）
  };

  // ==========================================================================
  // 数据层：同源 fetch + 6s 超时 + fail-soft（任何失败 resolve(null)，绝不抛出）
  // ==========================================================================
  function apiBase() {
    // 与 app.js 完全同构的基址解析：?api= → localStorage → "/api"（同源部署默认）
    var base = "/api";
    try {
      var q = new URLSearchParams(location.search).get("api");
      base = q || localStorage.getItem("murmur-api") || "/api";
    } catch (e) { /* 保持默认 */ }
    return base;
  }
  function fetchJSON(path) {
    return new Promise(function (resolve) {
      var done = false;
      var ctrl = typeof AbortController === "function" ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* 已结束则忽略 */ } }
        finish(null);
      }, FETCH_TIMEOUT_MS);
      function finish(v) { if (done) return; done = true; clearTimeout(timer); resolve(v); }
      fetch(apiBase() + path, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (j) { finish(j || null); })
        .catch(function () { finish(null); });   // fail-soft：网络/解析失败 → 空值，保留上次渲染
    });
  }
  function poll() {
    if (!S.alive || S.inFlight) return;
    S.inFlight = true;
    // 四个真实数据域并行拉取，各自独立 fail-soft：一域失败只隐藏自己的组件。
    Promise.all([
      fetchJSON("/state"),
      fetchJSON("/annals?order=desc&limit=" + ANNALS_LIMIT),
      fetchJSON("/population"),
      fetchJSON("/war")
    ]).then(function (rs) {
      S.inFlight = false;
      if (!S.alive) return;                     // unmount 后到达的迟到响应：丢弃
      if (rs[0]) S.state = rs[0];               // 成功才更新；失败保留上次数据
      if (rs[1]) S.annals = rs[1];
      if (rs[2]) S.pop = rs[2];
      if (rs[3]) S.war = rs[3];
      render();
    });
  }

  // ==========================================================================
  // 派生层（全部只读真实 payload，绝不臆造）
  // ==========================================================================
  /** 窗内家族徽标（只作已有家族的标注，绝不凭空造家）：倒序扫描（新→旧）。
   *  HOUSE_FOUNDED 且其后无 DYNASTY 痕迹 → "founded"（窗内新立，老房建号回放不给）；
   *  TERRITORY_SEIZED 攻方 → "expanded" / 守方 → "annexed"。 */
  function deriveBadges(entries) {
    var map = {}, dynSeen = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || typeof e.kind !== "string") continue;
      var tk = e.tokens || {};
      if (e.kind === "DYNASTY" && typeof tk.name === "string") dynSeen[tk.name] = true;
      else if (e.kind === "TERRITORY_SEIZED") {
        if (typeof tk.winner === "string" && !map[tk.winner]) map[tk.winner] = "expanded";
        if (typeof tk.loser === "string" && !map[tk.loser]) map[tk.loser] = "annexed";
      } else if (e.kind === "HOUSE_FOUNDED" && typeof tk.name === "string" &&
                 !map[tk.name] && !dynSeen[tk.name]) {
        map[tk.name] = "founded";
      }
    }
    return map;
  }
  /** 窗内最近一次领土易主（战役横幅的 seized 标注）；无则 null。 */
  function latestSeized(entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e && e.kind === "TERRITORY_SEIZED") {
        var tk = e.tokens || {};
        if (typeof tk.winner === "string" && typeof tk.loser === "string" && tk.zones != null) {
          return { w: tk.winner, l: tk.loser, n: tk.zones };
        }
      }
    }
    return null;
  }
  /** 进行中战役（编年史推断，仅在 /war 域不可达时兜底）：最近一次 WAR_DECLARED
   *  若晚于最近一次 WAR_RESOLVED（或窗内尚无裁决）→ 进行中。
   *  WAR_DECLARED tokens={attacker,defender,stakeUsdc,potUsdc}（显示值）。 */
  function warFromChronicle(entries) {
    var decl = null, resolve = null;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!decl && e.kind === "WAR_DECLARED") decl = e;
      if (!resolve && e.kind === "WAR_RESOLVED") resolve = e;
      if (decl && resolve) break;
    }
    if (!decl) return null;                                    // 窗内无宣战 → 无战事
    var ongoing = !resolve || (Number(decl.seq) > Number(resolve.seq));
    if (!ongoing) return null;                                 // 已有更晚的裁决 → 战事已了
    var tk = decl.tokens || {}, mt = decl.metrics || {};
    var atk = typeof tk.attacker === "string" ? tk.attacker
      : (mt.attackerId != null ? "#" + mt.attackerId : "—");
    var def = typeof tk.defender === "string" ? tk.defender
      : (mt.defenderId != null ? "#" + mt.defenderId : "—");
    return {
      atk: atk, def: def,
      stake: num(tk.stakeUsdc, 2),                             // tokens 是显示值；metrics 是原子值，不混用
      pot: num(tk.potUsdc, 2),
      deadline: null                                           // 编年史无倒计时字段，诚实省略
    };
  }
  /** 进行中战役（权威域 /war）：wars[] 里 opened && !resolved、warId 最大者为当前战役。 */
  function warFromDomain(w) {
    if (!w || typeof w !== "object" || w.enabled === false) return null;
    var wars = Array.isArray(w.wars) ? w.wars : [];
    var cur = null;
    for (var i = 0; i < wars.length; i++) {
      var x = wars[i];
      if (!x || typeof x !== "object") continue;
      if (x.opened === true && x.resolved !== true) {
        if (!cur || (Number(x.warId) || 0) > (Number(cur.warId) || 0)) cur = x;
      }
    }
    if (!cur) return null;
    var atk = (typeof cur.attackerName === "string" && cur.attackerName) ? cur.attackerName
      : (cur.attacker != null ? "#" + cur.attacker : "—");
    var def = (typeof cur.defenderName === "string" && cur.defenderName) ? cur.defenderName
      : (cur.defender != null ? "#" + cur.defender : "—");
    var secs = Number(cur.secondsToDeadline);
    return {
      atk: atk, def: def,
      stake: isFinite(Number(cur.stakeUsdc)) ? num(cur.stakeUsdc, 2) : null,
      pot: isFinite(Number(cur.potUsdc)) ? num(cur.potUsdc, 2) : null,
      deadline: isFinite(secs) && secs > 0 ? fmtSpan(secs) : null
    };
  }

  // ==========================================================================
  // 渲染层：每次全量重建动态区（数据量小；文本一律 textContent，零注入面）
  // ==========================================================================
  function renderHead() {
    var a = S.annals, tag = S.ui.eraTag;
    var era = a ? Number(a.era) : NaN;
    if (isFinite(era) && era > 0) {
      var nm = typeof a.eraName === "string" ? a.eraName : "";
      tag.textContent = nm ? T("soc.tl.eraDiv", { era: roman(era).toLowerCase(), name: nm })
                           : T("soc.tl.eraOnly", { era: roman(era).toLowerCase() });
      tag.hidden = false;
    } else {
      tag.hidden = true; tag.textContent = "";
    }
  }

  var MOOD_STATES = ["AGITATE", "EXPLORE", "AGGREGATE", "REST"];
  function renderPulse() {
    var st = S.state, ui = S.ui;
    var col = st && st.collective && typeof st.collective === "object" ? st.collective : null;
    var mk = st && st.market && typeof st.market === "object" ? st.market : null;
    // 聚合读数缺席时的诚实退化：collective 无 → 若 market.temperature 在则纯温度条；再无 → 未就绪
    if (!col && !(mk && typeof mk.temperature === "number")) {
      ui.pulseNote.hidden = false;
      ui.pulseMain.hidden = true;
      ui.pulseBar.setAttribute("aria-hidden", "true");
      return;
    }
    ui.pulseNote.hidden = true;
    ui.pulseMain.hidden = false;
    ui.pulseBar.removeAttribute("aria-hidden");

    // 状态词：优先 collective.regime，回退 market.regime；未知词原样小写展示
    var regime = (col && typeof col.regime === "string" && col.regime) ||
                 (mk && typeof mk.regime === "string" && mk.regime) || "";
    var low = regime.toLowerCase();
    ui.pulseWord.textContent = T("soc.regime." + low) !== "soc.regime." + low
      ? T("soc.regime." + low) : low;

    // 数值行：温度 / 躁动(arousal) / 群情(valence) / 心智数（各自存在性兜底，缺则整段省略）
    var nums = [];
    var temp = col && typeof col.temperature === "number" ? col.temperature
             : (mk && typeof mk.temperature === "number" ? mk.temperature : null);
    if (temp != null) nums.push(T("soc.pulse.temp", { t: num(temp, 2) }));
    if (col && col.arousal != null) {
      var ag = signed(col.arousal, 2);
      if (ag != null) nums.push(T("soc.pulse.arousal", { v: ag }));
    }
    if (col && col.valence != null) {
      var v = signed(col.valence, 2);
      if (v != null) nums.push(T("soc.pulse.valence", { v: v }));
    }
    var minds = col && col.size != null ? col.size : (st && st.aliveCount != null ? st.aliveCount : null);
    if (minds != null) nums.push(T("soc.pulse.minds", { n: minds }));
    ui.pulseNums.textContent = nums.join(" · ");

    // 分段条：collective.states 真实 mood 分布（计数为 flexGrow）；零计数段退出条带
    var states = col && col.states && typeof col.states === "object" ? col.states : null;
    if (states) {
      ui.pulseBar.style.display = "";
      ui.pulseTempbar.hidden = true;
      for (var i = 0; i < MOOD_STATES.length; i++) {
        var key = MOOD_STATES[i], seg = ui.pulseSegs[key];
        var c = Number(states[key]);
        if (!isFinite(c) || c < 0) c = 0;
        seg.style.flexGrow = String(c);
        seg.classList.toggle("zero", c === 0);
        ui.legendNums[key].textContent = String(c);
      }
      // 图例词汇随语言重渲染刷新（语言切换 / 每次 poll 均跟随当前语言）
      for (var w = 0; w < MOOD_STATES.length; w++) {
        var wk = MOOD_STATES[w];
        ui.legendWords[wk].textContent = T("soc.state." + wk.toLowerCase());
      }
      ui.pulseLegend.hidden = false;
      ui.pulseBar.setAttribute("aria-label", T("soc.pulse.aria"));
    } else {
      // 只有聚合温度：温度条（宽度=clamp01(t)）+ 状态词，群体分布段整体隐藏（诚实缺省）
      ui.pulseBar.style.display = "none";
      ui.pulseLegend.hidden = true;
      if (temp != null) {
        ui.pulseTempbar.hidden = false;
        ui.pulseTempfill.style.width = (clamp01(temp) * 100).toFixed(1) + "%";
      } else {
        ui.pulseTempbar.hidden = true;
      }
    }
  }

  function renderTimeline() {
    var a = S.annals, ui = S.ui;
    var entries = a && Array.isArray(a.entries) ? a.entries : null;
    if (!entries || !entries.length || a.enabled === false) {
      ui.tl.hidden = true;                       // 诚实空态：编年史缺席/禁用 → 整组不渲染
      ui.tlList.textContent = "";
      return;
    }
    ui.tl.hidden = false;
    // 纪元名恢复：条目自身 tokens.eraName（若携带）+ 顶层 live meta（当前纪元），与 app.js 同语义
    var eraNames = {};
    for (var k = 0; k < entries.length; k++) {
      var tk = (entries[k] && entries[k].tokens) || {};
      if (typeof tk.eraName === "string" && tk.eraName) {
        var er = Number(entries[k].era);
        if (isFinite(er)) eraNames[er] = tk.eraName;
      }
    }
    var metaEra = Number(a.era);
    if (isFinite(metaEra) && typeof a.eraName === "string" && a.eraName) eraNames[metaEra] = a.eraName;

    var rows = entries.slice(0, TIMELINE_CAP);
    ui.tlList.textContent = "";
    var prevEra = null;
    for (var i = 0; i < rows.length; i++) {
      var e = rows[i] || {};
      var era = Number(e.era);
      // 纪元分隔线：era 变更处（首条前无线，与既有编年史行为一致）
      if (prevEra !== null && isFinite(era) && era !== prevEra) {
        var nm = eraNames[era];
        var divTxt = nm ? T("soc.tl.eraDiv", { era: roman(era).toLowerCase(), name: nm })
                        : T("soc.tl.eraOnly", { era: roman(era).toLowerCase() });
        ui.tlList.appendChild(el("li", "soc-era-div", divTxt));
      }
      if (isFinite(era)) prevEra = era;

      var sev = Number(e.severity); if (!isFinite(sev) || sev < 1) sev = 1;
      var li = el("li", "soc-ev soc-cat-" + kindCat(e.kind) + " soc-sev-" + Math.min(5, sev));
      li.tabIndex = 0;                            // 键盘可达：focus 展开全文
      li.appendChild(el("span", "soc-ev-ic", kindIcon(e.kind)));
      var main = el("div", "soc-ev-main");
      main.appendChild(el("div", "soc-ev-text", typeof e.text === "string" ? e.text : ""));
      var metaBits = [];
      metaBits.push(T("soc.tl.tick", { n: e.tick != null ? e.tick : "–" }));
      var ago = timeAgo(e.ts); if (ago) metaBits.push(ago);
      if (e.kind) metaBits.push(String(e.kind));
      if (Array.isArray(e.actors) && e.actors.length) {
        var ids = e.actors.map(function (x) { return "#" + x; }).join(" ");
        if (ids) metaBits.push(ids);
      }
      main.appendChild(el("div", "soc-ev-meta", metaBits.join(" · ")));
      li.appendChild(main);
      ui.tlList.appendChild(li);
    }
    // 溢出提示：窗内还有更多（真实计数，非装饰）
    var more = entries.length - rows.length;
    if (more > 0) {
      ui.tlMore.textContent = T("soc.tl.more", { n: more });
      ui.tlMore.hidden = false;
    } else {
      ui.tlMore.hidden = true; ui.tlMore.textContent = "";
    }
  }

  function renderPolities() {
    var ui = S.ui;
    // 邦国/城市真实域：/population → economy.dynasty.houses（服务端已排好 slice(0,8)）
    var dyn = S.pop && S.pop.economy && typeof S.pop.economy === "object" ? S.pop.economy.dynasty : null;
    var houses = dyn && Array.isArray(dyn.houses) ? dyn.houses : null;
    if (!houses || !houses.length) {
      ui.pol.hidden = true;                      // 诚实空态：无家族（当前线上真实态）→ 整卡组隐藏
      ui.polGrid.textContent = "";
      return;
    }
    // 徽标来自窗内真实编年史事件（只标注既有家族，绝不凭空造家）
    var badges = deriveBadges(S.annals && Array.isArray(S.annals.entries) ? S.annals.entries : []);
    var sorted = houses.slice().sort(function (a, b) {
      var la = Number(a && a.live) || 0, lb = Number(b && b.live) || 0;
      if (lb !== la) return lb - la;             // 在世心智降序（与 renderCitiesSection 同排序语义）
      var na = (a && a.name) || "", nb = (b && b.name) || "";
      return na < nb ? -1 : 1;
    }).slice(0, POLITY_CAP);
    ui.pol.hidden = false;
    ui.polGrid.textContent = "";
    for (var i = 0; i < sorted.length; i++) {
      var h = sorted[i] || {};
      var name = typeof h.name === "string" && h.name ? h.name : ("#" + (h.id != null ? h.id : "?"));
      var card = el("div", "soc-house");
      var col = houseColorOf(name);
      if (col) card.style.setProperty("--soc-house-c", "rgb(" + col[0] + "," + col[1] + "," + col[2] + ")");
      var top = el("div", "soc-house-top");
      top.appendChild(el("span", "soc-house-sigil", typeof h.sigil === "string" && h.sigil ? h.sigil : "⌂"));
      top.appendChild(el("b", "soc-house-name", name));
      card.appendChild(top);
      var bits = [];
      var gen = Number(h.gen);
      if (isFinite(gen) && gen > 0) bits.push(T("soc.pol.gen", { n: gen }));
      var cs = Number(h.capitalShare);
      if (isFinite(cs) && cs > 0) bits.push(T("soc.pol.share", { s: Math.round(cs * 100) + "%" }));
      var live = Number(h.live);
      if (isFinite(live) && live > 0) bits.push(T("soc.pulse.minds", { n: live }));
      var ft = Number(h.foundedTick);
      if (isFinite(ft) && ft > 0) bits.push(T("soc.pol.seat", { n: ft }));
      if (bits.length) card.appendChild(el("div", "soc-house-meta", bits.join(" · ")));
      var cz = Array.isArray(h.controlsZones) ? h.controlsZones.length : 0;
      if (cz > 0) card.appendChild(el("span", "soc-house-zones", "⚑ " + T("soc.pol.zones", { n: cz })));
      var b = badges[name];
      if (b) card.appendChild(el("span", "soc-badge is-" + b, T("soc.badge." + b)));
      ui.polGrid.appendChild(card);
    }
  }

  function renderWar() {
    var ui = S.ui;
    var entries = S.annals && Array.isArray(S.annals.entries) ? S.annals.entries : [];
    // 权威源优先：/war 数据域（链上战役）。域不可达（null）才以编年史推断兜底；
    // 域在而无进行中战役 = 真无战事，绝不用推断推翻权威。
    var war = warFromDomain(S.war);
    if (!war && S.war == null) war = warFromChronicle(entries);
    if (!war) { ui.war.hidden = true; return; }  // 无战事 → 不渲染任何占位
    var seized = latestSeized(entries);
    ui.war.hidden = false;
    ui.warMain.textContent = "";
    ui.warMain.appendChild(el("span", "soc-war-ic", "⚔"));
    ui.warMain.appendChild(el("span", null, T("soc.war.ongoing", { atk: war.atk, def: war.def })));
    var sub = [];
    if (war.stake != null) sub.push(T("soc.war.stake", { s: war.stake }));
    if (war.pot != null) sub.push(T("soc.war.pot", { s: war.pot }));
    if (war.deadline) sub.push(T("soc.war.deadline", { t: war.deadline }));
    if (seized) sub.push(T("soc.war.seized", { w: seized.w, n: seized.n, l: seized.l }));
    ui.warSub.textContent = sub.join(" · ");
    ui.warSub.hidden = sub.length === 0;
  }

  function render() {
    if (!S.alive || !S.ui) return;
    try {
      renderHead();
      renderWar();
      renderPulse();
      renderTimeline();
      renderPolities();
    } catch (e) { /* 渲染层 fail-soft：单帧异常不允许打断轮询循环 */ }
  }

  // ==========================================================================
  // 骨架：一次性搭建静态结构（挂载时），动态区由 render() 填充
  // ==========================================================================
  function buildSkeleton(root) {
    root.textContent = "";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", T("soc.panel.aria"));

    var head = el("header", "soc-head");
    head.appendChild(el("h3", "soc-title", T("soc.title")));
    var eraTag = el("span", "soc-era-tag");
    eraTag.hidden = true;
    head.appendChild(eraTag);
    root.appendChild(head);

    var body = el("div", "soc-body");
    // 战役横幅（默认隐藏，仅进行中战事渲染）
    var war = el("div", "soc-war");
    war.hidden = true;
    var warMain = el("div", "soc-war-main");
    war.appendChild(warMain);
    var warSub = el("div", "soc-war-sub");
    warSub.hidden = true;
    war.appendChild(warSub);
    body.appendChild(war);

    // 社会脉搏条（全宽头部）
    var pulse = el("div", "soc-pulse");
    var pulseMain = el("div", "soc-pulse-main");
    var pulseTop = el("div", "soc-pulse-top");
    var pulseWord = el("span", "soc-pulse-word");
    var pulseNums = el("span", "soc-pulse-nums");
    pulseTop.appendChild(pulseWord);
    pulseTop.appendChild(pulseNums);
    pulseMain.appendChild(pulseTop);
    var pulseBar = el("div", "soc-pulse-bar");
    pulseBar.setAttribute("role", "img");
    var pulseSegs = {};
    for (var i = 0; i < MOOD_STATES.length; i++) {
      var seg = el("span", "soc-seg soc-seg-" + MOOD_STATES[i].toLowerCase());
      seg.style.flexGrow = "0";
      pulseBar.appendChild(seg);
      pulseSegs[MOOD_STATES[i]] = seg;
    }
    pulseMain.appendChild(pulseBar);
    var pulseTempbar = el("div", "soc-tempbar");
    pulseTempbar.hidden = true;
    pulseTempbar.appendChild(el("span", "soc-tempfill"));
    pulseMain.appendChild(pulseTempbar);
    var pulseLegend = el("div", "soc-pulse-legend");
    var legendNums = {}, legendWords = {};
    for (var j = 0; j < MOOD_STATES.length; j++) {
      var key2 = MOOD_STATES[j];
      var item = el("span", "soc-lg-item");
      item.appendChild(el("i", "soc-lg-sw soc-lg-" + key2.toLowerCase()));
      var word = el("span", "soc-lg-word", T("soc.state." + key2.toLowerCase()));
      item.appendChild(word);
      var b = el("b", null, "0");
      item.appendChild(b);
      legendNums[key2] = b;
      legendWords[key2] = word;   // 词汇随语言重渲染刷新（renderPulse 每轮更新）
      pulseLegend.appendChild(item);
    }
    pulseMain.appendChild(pulseLegend);
    pulse.appendChild(pulseMain);
    var pulseNote = el("p", "soc-pulse-note", T("soc.pulse.unready"));
    pulseNote.hidden = true;
    pulse.appendChild(pulseNote);
    body.appendChild(pulse);

    // 双列：左时间线 / 右邦国卡（≤680px 由 CSS 收成单列）
    var cols = el("div", "soc-cols");

    var tl = el("section", "soc-tl");
    tl.appendChild(el("h4", "soc-sub", T("soc.tl.title")));
    var tlList = el("ul", "soc-tl-list");
    tl.appendChild(tlList);
    var tlMore = el("p", "soc-tl-more");
    tlMore.hidden = true;
    tl.appendChild(tlMore);
    cols.appendChild(tl);

    var pol = el("section", "soc-pol");
    pol.hidden = true;
    pol.appendChild(el("h4", "soc-sub", T("soc.pol.title")));
    var polGrid = el("div", "soc-pol-grid");
    pol.appendChild(polGrid);
    cols.appendChild(pol);

    body.appendChild(cols);
    root.appendChild(body);

    S.ui = {
      eraTag: eraTag,
      war: war, warMain: warMain, warSub: warSub,
      pulseMain: pulseMain, pulseNote: pulseNote, pulseWord: pulseWord, pulseNums: pulseNums,
      pulseBar: pulseBar, pulseSegs: pulseSegs, pulseTempbar: pulseTempbar,
      pulseTempfill: pulseTempbar.firstChild, pulseLegend: pulseLegend,
      legendNums: legendNums, legendWords: legendWords,
      tl: tl, tlList: tlList, tlMore: tlMore,
      pol: pol, polGrid: polGrid
    };
  }

  // ==========================================================================
  // 生命周期：mount / unmount / 定时器 / 可见性 / 语言跟随
  // ==========================================================================
  function startTimer() {
    stopTimer();
    S.timer = setInterval(poll, POLL_MS);
  }
  function stopTimer() {
    if (S.timer) { clearInterval(S.timer); S.timer = 0; }
  }
  function onVisibility() {
    if (!S.alive) return;
    if (document.hidden) {
      stopTimer();                               // 页面不可见 → 暂停轮询（省流）
    } else {
      poll();                                    // 回到前台 → 立即拉一次再恢复节拍
      startTimer();
    }
  }

  /** 挂载：target 为容器元素或元素 id；缺省时自动找 #soc-panel 或插入 .panel-temp 之后。
   *  幂等：已挂载时重复调用安全。挂载即拉一轮数据。 */
  function mount(target) {
    if (S.alive) return S.root;
    var host = target || document.getElementById("soc-panel") || null;
    if (host && typeof host === "string") host = document.getElementById(host);
    if (!host) {
      // 集成清单推荐路径：主线程在 .panel-temp 之后放 <section id="soc-panel" class="soc-panel" hidden></section>；
      // 兜底路径：找不到锚点容器时本模块自建 section 插到 .panel-temp 之后（首页直嵌可见性原则）。
      var temp = document.querySelector(".panel-temp");
      if (!temp || !temp.parentNode) return null;
      host = el("section", "soc-panel");
      host.id = "soc-panel";
      temp.parentNode.insertBefore(host, temp.nextSibling);
    }
    host.classList.add("soc-panel");
    S.root = host;
    S.alive = true;
    buildSkeleton(host);
    host.hidden = false;                         // 首屏即可见面板（诚实空态在组件层呈现）

    // 语言跟随：i18n.setLang 会改 <html lang>，观察之并即时重渲染（零共享状态写入）
    if (typeof MutationObserver === "function") {
      S.langObs = new MutationObserver(function () { if (S.alive) render(); });
      S.langObs.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }
    // 可见性暂停
    S.onVis = onVisibility;
    document.addEventListener("visibilitychange", S.onVis);

    poll();                                      // mount 立即拉一次
    startTimer();                                // 60s 节拍
    return host;
  }

  /** 卸载：全量清理（定时器/监听/观察器/DOM/引用），此后可再次 mount。 */
  function unmount() {
    S.alive = false;
    stopTimer();
    if (S.langObs) { S.langObs.disconnect(); S.langObs = null; }
    if (S.onVis) { document.removeEventListener("visibilitychange", S.onVis); S.onVis = null; }
    if (S.root) { S.root.textContent = ""; S.root.hidden = true; S.root = null; }
    S.ui = null; S.inFlight = false;
    S.state = null; S.annals = null; S.pop = null; S.war = null;  // 数据随面板销毁（重挂载即重拉）
  }

  // ==========================================================================
  // 首页直嵌自动挂载：main 线程给出 #soc-panel 空壳 → 填充之；否则插到 .panel-temp
  // 之后；两者皆无（非首页环境）→ 不自动挂载，仅暴露 mount() 供按需调用。
  // ==========================================================================
  function autoMount() {
    if (S.alive) return;
    var host = document.getElementById("soc-panel");
    if (!host) {
      var temp = document.querySelector(".panel-temp");
      if (!temp || !temp.parentNode) return;
      host = el("section", "soc-panel");
      host.id = "soc-panel";
      temp.parentNode.insertBefore(host, temp.nextSibling);
    }
    mount(host);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoMount, { once: true });
  } else {
    autoMount();
  }

  // 公开面：mount / unmount / I18N_KEYS（供主线程合入 i18n-ui.js）
  window.MurmurSocial = {
    mount: mount,
    unmount: unmount,
    I18N_KEYS: I18N_KEYS
  };
})();
