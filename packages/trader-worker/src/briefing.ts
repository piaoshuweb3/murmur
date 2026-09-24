/**
 * briefing.ts — the Reddit content factory (自有实现 · 二次开发差异化层).
 *
 * 思想同源（上游 chronicle→canary 的"运营成本趋零"直觉），代码自写、措辞自创：
 * 编年史/温度/行情/桂冠诗 已经是每天自动写作的素材库 —— 本模块把它们折叠成
 * "每日快讯 + 每周战报 + 可直接张贴的 Reddit 双语文案"。零 LLM、零时钟、零随机：
 * 同输入永远字节级同输出（与 chronicler/poet 同一 no-LLM 证明模型），
 * 时间戳/数据全部由调用方注入，便于离线单测与跨引擎复算。
 *
 * 红线：不硬编码任何上游地址；链接三件套（站点/CA/explorer/Reddit）由 config 注入。
 */

/** 单条编年史摘录（调用方从 annals 滚动记忆里裁好的最新 N 条）。 */
export interface BriefingAnnal {
  kind: string;
  text: string;
  ts: number;
}

/** D1 七日聚合（SELECT COUNT/MIN/MAX/AVG/SUM 的结果，可能全空）。 */
export interface BriefingWeekly {
  days: number; // 样本 cron 数（0 = D1 无数据，诚实降级）
  tempMin: number | null;
  tempMax: number | null;
  tempAvg: number | null;
  settles: number; // 7 天结算笔数（含失败，诚实口径）
  deals: number; // 7 天撮合笔数
  volumeUsdc: number; // 7 天成交额（USDC）
}

/** 全部注入素材。任何字段缺失/为 null 都必须优雅降级，绝不抛错。 */
export interface BriefingInput {
  site: string; // https://flyx402.xyz
  tokenCa: string; // 我方 MURMUR CA（复制位用）
  explorer: string; // https://explorer.arc.io
  reddit: string; // https://www.reddit.com/r/flyx402/
  generatedAt: number; // epoch ms（由调用方注入，模块自身零时钟）
  temperature: number | null; // 0..1
  regime: string | null; // HOT/COLD/CALM
  era: string | null; // "the Fever"
  eraSeq: number | null;
  tick: number | null;
  liveAgents: number | null;
  behaviors: Array<{ label: string; count: number }>; // 已排序 top N
  fever: number | null; // bourse fever 0..1（bourse 关旗 → null）
  bourseLive: boolean;
  poem: { seq: number; eraName: string; firstLine: string } | null; // 桂冠诗（未成诗 → null）
  annals: BriefingAnnal[]; // 最新在前，建议 ≤5 条
  totals: { trades: number; settled: number; volumeUsdc: number };
  weekly: BriefingWeekly;
}

export interface BriefingPost {
  lang: "en" | "zh";
  title: string;
  body: string; // Reddit markdown，可直接张贴
}

export interface Briefing {
  generatedAt: number;
  daily: {
    temperature: number | null;
    regime: string | null;
    era: string | null;
    eraSeq: number | null;
    tick: number | null;
    liveAgents: number | null;
    topBehaviors: Array<{ label: string; count: number }>;
    fever: number | null;
    poemLine: string | null;
    headlines: Array<{ kind: string; text: string }>; // ≤3
    totals: { trades: number; settled: number; volumeUsdc: number };
  };
  weekly: BriefingWeekly;
  redditPost: BriefingPost[]; // [en, zh]
}

const ORDINARY = new Set(["the", "and", "with", "into", "over", "under", "still", "they", "them", "their", "this", "that", "from", "have", "has", "been", "were", "will", "would", "could", "then", "than", "when", "what", "some", "more", "most", "very", "just", "only", "also", "even", "ever", "never", "each", "other", "again", "once", "here", "there", "where", "while", "after", "before", "about", "against", "between", "through", "during", "because", "being", "having"]);
const ZH_STOP = new Set(["的", "了", "在", "是", "和", "与", "及", "或", "而", "被", "把", "让", "向", "往", "从", "对", "会", "能", "可", "这", "那", "就", "都", "也", "还", "又", "再", "不", "没", "无", "有", "个", "们", "么", "之", "以", "为", "于", "其", "中"]);

/** 标题里的温度形容词（en/zh 各一档，纯查表，零随机）。 */
function tempWord(t: number | null): { en: string; zh: string } {
  if (t == null || !Number.isFinite(t)) return { en: "steady", zh: "平稳" };
  if (t >= 0.66) return { en: "blazing", zh: "灼热" };
  if (t >= 0.5) return { en: "warm", zh: "温热" };
  if (t > 0.33) return { en: "cooling", zh: "转凉" };
  return { en: "frozen", zh: "冰封" };
}

/** 从摘录里抽 1-3 个关键名词（超停用词、按出现频次与长度稳定排序），给标题一点具体的画面。 */
function keywords(texts: string[], stop: Set<string>, minLen: number, cap: number): string[] {
  const freq = new Map<string, number>();
  for (const t of texts) {
    const words = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= minLen && !stop.has(w));
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 1)
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length) || (a[0] < b[0] ? -1 : 1))
    .slice(0, cap)
    .map(([w]) => w);
}

/** 确定性日期戳（UTC，只用于人读；不调用时钟）。 */
function dayStamp(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function fmtTemp(t: number | null): string {
  return t == null || !Number.isFinite(t) ? "—" : (Math.round(t * 1000) / 10).toFixed(1) + "%";
}

function fmtNum(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : Number(n).toLocaleString("en-US");
}

/**
 * 组装日报+周报+双语文案。纯函数：同输入同输出；任何输入为 null/空都降级成诚实占位
 * （"—" / "awaiting the first settled net"），绝不编造数字。
 */
export function buildBriefing(inp: BriefingInput): Briefing {
  const tw = tempWord(inp.temperature);
  const headlines = (inp.annals ?? []).slice(0, 3).map((a) => ({ kind: a.kind, text: a.text }));
  const kwEn = keywords(headlines.map((h) => h.text), ORDINARY, 4, 3);
  const kwZh = keywords(headlines.map((h) => h.text), ZH_STOP, 2, 3);

  const daily: Briefing["daily"] = {
    temperature: inp.temperature ?? null,
    regime: inp.regime ?? null,
    era: inp.era ?? null,
    eraSeq: inp.eraSeq ?? null,
    tick: inp.tick ?? null,
    liveAgents: inp.liveAgents ?? null,
    topBehaviors: (inp.behaviors ?? []).slice(0, 3),
    fever: inp.fever ?? null,
    poemLine: inp.poem ? inp.poem.firstLine : null,
    headlines,
    totals: {
      trades: inp.totals?.trades ?? 0,
      settled: inp.totals?.settled ?? 0,
      volumeUsdc: inp.totals?.volumeUsdc ?? 0,
    },
  };

  const weekly: BriefingWeekly = {
    days: inp.weekly?.days ?? 0,
    tempMin: inp.weekly?.tempMin ?? null,
    tempMax: inp.weekly?.tempMax ?? null,
    tempAvg: inp.weekly?.tempAvg ?? null,
    settles: inp.weekly?.settles ?? 0,
    deals: inp.weekly?.deals ?? 0,
    volumeUsdc: inp.weekly?.volumeUsdc ?? 0,
  };

  const stamp = dayStamp(inp.generatedAt);
  const eraTxt = daily.era ? `Era ${daily.eraSeq ?? "?"} — ${daily.era}` : "an unnamed era";
  const eraZh = daily.era ? `第 ${daily.eraSeq ?? "?"} 纪元 ·「${daily.era}」` : "无名纪元";

  // —— EN post ——
  const enLines: string[] = [];
  enLines.push(`**flyx402 daily swarm briefing — ${stamp}**`);
  enLines.push("");
  enLines.push(`Temperature is ${tw.en} at ${fmtTemp(daily.temperature)}${daily.regime ? ` (${daily.regime})` : ""}. The colony lives in ${eraTxt}, tick ${daily.tick ?? "—"}, ${fmtNum(daily.liveAgents)} flies aloft.`);
  if (daily.topBehaviors.length) {
    enLines.push(`Today's mood: ${daily.topBehaviors.map((b) => `${b.label} ${b.count}`).join(" · ")}.`);
  }
  if (inp.bourseLive && daily.fever != null) {
    enLines.push(`Bourse fever reads ${(daily.fever * 100).toFixed(0)}/100 on our own MURMUR tape (\`${inp.tokenCa}\`).`);
  }
  if (daily.totals.settled > 0) {
    enLines.push(`Netting so far: ${fmtNum(daily.totals.trades)} trades folded → **${fmtNum(daily.totals.settled)} on-chain settlements**, every one verifiable on the [Arc explorer](${inp.explorer}).`);
  } else {
    enLines.push(`Netting: ${fmtNum(daily.totals.trades)} trades folded, awaiting the first settled net — each future net lands on-chain with a per-transaction [explorer link](${inp.explorer}).`);
  }
  if (headlines.length) {
    enLines.push("");
    enLines.push("From the chronicle:");
    for (const h of headlines) enLines.push(`- *${h.kind}* — ${h.text}`);
  }
  if (inp.poem) {
    enLines.push("");
    enLines.push(`The Laureate's poem #${inp.poem.seq} opens: "${inp.poem.firstLine}"`);
  }
  if (weekly.days > 0) {
    enLines.push("");
    enLines.push(`**Week in review:** ${fmtNum(weekly.deals)} deals, ${fmtNum(weekly.settles)} settlement attempts, ${fmtNum(Math.round(weekly.volumeUsdc * 100) / 100)} USDC volume; temperature ${fmtTemp(weekly.tempMin)} → ${fmtTemp(weekly.tempMax)}${kwEn.length ? `, chronicle keeps saying: ${kwEn.join(", ")}` : ""}.`);
  }
  enLines.push("");
  enLines.push(`Watch the swarm live: ${inp.site} · verify every hash yourself · join ${inp.reddit}`);
  const enPost: BriefingPost = {
    lang: "en",
    title: `flyx402 swarm briefing ${stamp} — ${tw.en} ${fmtTemp(daily.temperature)}, ${eraTxt}`,
    body: enLines.join("\n").slice(0, 4000),
  };

  // —— ZH post ——
  const zhLines: string[] = [];
  zhLines.push(`**flyx402 蝇群每日快讯 — ${stamp}**`);
  zhLines.push("");
  zhLines.push(`链上温度${tw.zh}（${fmtTemp(daily.temperature)}${daily.regime ? ` · ${daily.regime}` : ""}）；${eraZh}，tick ${daily.tick ?? "—"}，在飞 ${fmtNum(daily.liveAgents)} 只。`);
  if (daily.topBehaviors.length) {
    zhLines.push(`群体情绪：${daily.topBehaviors.map((b) => `${b.label} ${b.count}`).join(" · ")}。`);
  }
  if (inp.bourseLive && daily.fever != null) {
    zhLines.push(`Bourse 行情热度 ${(daily.fever * 100).toFixed(0)}/100（自有 MURMUR 磁带 \`${inp.tokenCa}\`）。`);
  }
  if (daily.totals.settled > 0) {
    zhLines.push(`并账进度：${fmtNum(daily.totals.trades)} 笔交易折叠为 **${fmtNum(daily.totals.settled)} 笔链上结算**，每一笔都可在 [Arc 浏览器](${inp.explorer}) 逐笔核验。`);
  } else {
    zhLines.push(`并账进度：${fmtNum(daily.totals.trades)} 笔交易已折叠，等待首笔链上结算落地——届时每笔都附 [explorer 链接](${inp.explorer}) 供逐笔核验。`);
  }
  if (headlines.length) {
    zhLines.push("");
    zhLines.push("编年史头条：");
    for (const h of headlines) zhLines.push(`- *${h.kind}* — ${h.text}`);
  }
  if (inp.poem) {
    zhLines.push("");
    zhLines.push(`桂冠诗人第 ${inp.poem.seq} 首开篇："${inp.poem.firstLine}"`);
  }
  if (weekly.days > 0) {
    zhLines.push("");
    zhLines.push(`**本周战报**：撮合 ${fmtNum(weekly.deals)} 笔、结算尝试 ${fmtNum(weekly.settles)} 笔、成交 ${fmtNum(Math.round(weekly.volumeUsdc * 100) / 100)} USDC；温度 ${fmtTemp(weekly.tempMin)} → ${fmtTemp(weekly.tempMax)}${kwZh.length ? `；编年史高频词：${kwZh.join("、")}` : ""}。`);
  }
  zhLines.push("");
  zhLines.push(`实时观群：${inp.site} · 每个哈希都可自行上链核验 · 社区 ${inp.reddit}`);
  const zhPost: BriefingPost = {
    lang: "zh",
    title: `flyx402 蝇群快讯 ${stamp} — ${tw.zh} ${fmtTemp(daily.temperature)}，${eraZh}`,
    body: zhLines.join("\n").slice(0, 4000),
  };

  return { generatedAt: inp.generatedAt, daily, weekly, redditPost: [enPost, zhPost] };
}
