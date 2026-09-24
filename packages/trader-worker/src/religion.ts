// ============================================================================================================
// religion.ts — THE FAITH MEMBRANE (信仰膜): prophets, covenants, holy days, schisms, fade-outs.
//
// An autonomous implementation of the swarm's religious dimension. Where the economy reads the connectome
// for TRADE and war reads it for FEUD, the faith membrane reads it for MEANING: when the age is unequal
// enough (gini ≥ 0.6 breeds desperation), a highly-reputed fly at the center of a strong-bond cluster may
// stop eating and start SPEAKING — a prophet — and its cluster may bind into a covenant (教派) with an
// invented name and a banner hue. Covenants keep FERVOR (狂热度, 0..1): stoked by global holy days (圣日,
// every 96 ticks), fed by inequality, bled out when the founder dies, extinguished when no boon can
// rekindle the ember. A fervent, crowded covenant may SCHISM — about a third of the faithful walking out
// under a new name — and the swarm's memory holds at most four covenants: the oldest cold ember is unmade
// to make room. All of this is chronicle NARRATIVE + read-out state and NOTHING else.
//
// THE ONE-WAY LAW (same iron rule as economy/culture/war): PURE READ-OUT. This layer never writes a genome,
// a connectome, a wallet, a ledger or a settlement decision, and it NEVER ROTATES THE MANIFEST HASH — no
// new behaviour kinds are decoded anywhere; existing read-outs (reputation, bonds, gini, deaths) are only
// re-narrated. Remove the module and the swarm's bytes are unchanged. No money moves here.
//
// DETERMINISM: no Math.random, no Date.now, no I/O. Every decision is a draw from xorshift32 over
// (seedBase, input.seed, era, tick, subject id, salt) — the constructor seed is the membrane's identity,
// the per-tick input.seed is the caller's seasoning (era reseeds upstream); same seed + same inputs ⇒
// byte-identical outputs. step() must be called exactly once per tick, ticks strictly forward;
// input.nowTs only stamps narrations. All state is bounded: ≤ 4 sects × ≤ 8 members + scalars — DO-safe.
//
// MECHANISM (the rules this file implements):
//   • PROPHET RISE — rep ≥ 0.8 AND bond-degree ≥ 3 (cluster center) AND gini ≥ 0.6 (不平等滋生信仰):
//     a deterministic seed×tick draw decides the rise; a fly leads at most one sect, and a fly that
//     already belongs to a covenant cannot found another (schism is the only split path).
//   • COVENANT    — prophet + strongest bond-neighbours, roster ≤ 8 (prophet included); name minted from
//     a SELF-INVENTED syllable table (2–3 syllables; no upstream wordlist is copied or consulted — 词表自创);
//     hue 0..359 from the same draw.
//   • HOLY DAY    — every 96 ticks globally: every living covenant +0.05 fervor (capped at 1) and one
//     HOLY_DAY narration. holyDay=true ⟺ a HOLY_DAY narration exists this tick (a holy day nobody keeps
//     is not observed).
//   • SCHISM      — fervor > 0.85 AND ≥ 6 members: a deterministic draw tears off ~1/3 of the roster
//     (rounded, ≥ 2, the founder stays) under a new name and hue; the mother creed cools by 0.25.
//   • FADE        — a covenant below the ember line (fervor < 0.15) for 240 consecutive ticks with no boon
//     able to rekindle it dissolves (a boon that cannot lift it back over the line is noise, not grace);
//     a dead founder bleeds −0.01 fervor per tick on top of the −0.0006 idle cooling; zeal feeds on
//     inequality (+0.005 × max(0, gini − 0.5) per tick); a roster with no living member is buried at once.
//   • BOUNDED     — ≤ 4 covenants at once; when a founding or schism overflows the cap, the OLDEST
//     covenant (coldest first on ties) dissolves — the young fire takes the old one's place.
//
// Phase order inside one step: ① deaths → ② fervor drift → ③ fade → ④ holy day → ⑤ prophets/foundings →
// ⑥ schisms → ⑦ cap trim. Narrations are THIS tick's events only (the chronicler folds them in).
// ============================================================================================================

/** A living covenant: the public read-out shape the frontend/chronicle consume. */
export interface Sect {
  id: number;
  name: string;
  founderId: number;
  foundedTick: number;
  memberIds: number[];
  /** banner hue 0..359 for the frontend's colouring. */
  hue: number;
  /** 狂热度 — zeal 0..1. */
  fervor: number;
}

export type ReligionNarrationKind = "PROPHET" | "SECT_FOUNDED" | "SCHISM" | "HOLY_DAY" | "SECT_FADE";

/** One chronicle beat: the faith membrane never speaks twice about the same event in the same tick. */
export interface ReligionNarration {
  kind: ReligionNarrationKind;
  text: string;
  actorIds: number[];
  ts: number;
}

/** The read-only view the swarm hands the membrane each tick (all pre-filtered upstream). */
export interface ReligionInput {
  tick: number;
  nowTs: number;
  seed: number;
  era: number;
  /** reputation leaders, already sorted rep-descending. */
  topReputations: Array<{ id: number; rep: number }>;
  /** strong bonds (strength 0..1, already filtered to the top). */
  bonds: Array<{ a: number; b: number; strength: number }>;
  /** economic inequality 0..1 — the fuel of faith. */
  gini: number;
  /** flies that died THIS tick. */
  deadIds: number[];
}

export interface ReligionReadOut {
  sects: Sect[];
  narrations: ReligionNarration[];
  holyDay: boolean;
}

// --- bounded, deterministic constants (DO-safe by construction) ---
const SECT_CAP = 4;              // simultaneous covenants at most (overflow unmakes the oldest cold ember)
const SECT_MEMBERS_CAP = 8;      // founding roster cap, prophet included
const PROPHET_MIN_REP = 0.8;     // a prophet must be reputed
const PROPHET_MIN_DEGREE = 3;    // ...and stand at the center of a real bond cluster
const PROPHET_GINI_FLOOR = 0.6;  // ...in an age unequal enough to breed faith
const PROPHET_PCT = 0.5;         // per-tick chance the rise-draw assents once every condition holds
const HOLY_EVERY = 96;           // ticks between global holy days (~1.6 h)
const HOLY_BOON = 0.05;          // fervor granted to every living covenant on a holy day
const EMBER_LINE = 0.15;         // fervor below which a covenant is a dying ember
const FADE_AFTER = 240;          // unkindled ticks an ember may linger before it goes out
const SCHISM_FERVOR = 0.85;      // fervor above which a crowd may tear
const SCHISM_MIN_MEMBERS = 6;    // minimum roster for a schism to be possible
const SCHISM_PCT = 0.3;          // per-tick chance the tear-draw assents once eligible
const SCHISM_WOUND = 0.25;       // fervor the mother creed loses in a schism
const FOUNDER_DECAY = 0.01;      // per-tick fervor bleed once the founder is dead
const IDLE_DECAY = 0.0006;       // per-tick natural cooling (outpaces the amortized boon in equal ages)
const ZEAL_RATE = 0.005;         // per-tick fervor gain from inequality: ZEAL_RATE × max(0, gini − 0.5)

// draw salts (hexspeak, arbitrary — each decision stream must never alias another)
const SALT_PROPHET = 0x51ec7;    // does the prophet rise this tick?
const SALT_SCHISM = 0x5c15a;     // does the crowd tear this tick?
const SALT_ROSTER = 0xb0dd;      // which faithful walk out
const SALT_NAME = 0x7ea5e;       // syllable minting
const SALT_HUE = 0x08c1a;        // banner hue
const SALT_EMBER = 0x0f1e5;      // opening fervor

/**
 * The covenant syllables — a self-invented chant table (zho-qor, mal-ten, vrex…). Nothing here is lifted
 * from any upstream list; combinations like "Zhoqor", "Omuved" or "Rhutenqii" are minted per founding.
 */
const SYLLABLES = [
  "zho", "kra", "vex", "iss", "qor", "mal", "ten", "sha", "vrex", "omb",
  "kil", "phu", "drae", "nis", "omu", "bel", "tho", "ras", "yev", "cin",
  "pra", "ho", "vel", "ur", "ged", "zii", "moq", "lan", "fe", "rhu",
] as const;

const RELIGION_VERSION = 1;

/** Internal covenant state: the public Sect plus the two trackers the membrane needs to remember. */
interface SectCore extends Sect {
  /** last tick a boon left this creed at/above the ember line — the kindle clock behind FADE. */
  lastKindledTick: number;
  founderDead: boolean;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * One deterministic draw in [0,1): FNV-style mixing of every key, then two xorshift32 rounds
 * (xorshift has a zero fixed point, so the state is seeded away from 0). Integer ops only —
 * identical keys always yield the identical double, on every engine, on every replay.
 */
function draw01(...ks: number[]): number {
  let h = (0x9e3779b9 ^ ks.length) >>> 0;
  for (const k of ks) {
    h = Math.imul(h ^ (k >>> 0), 0x85ebca6b) >>> 0;
    h = ((h << 13) | (h >>> 19)) >>> 0;
  }
  if (h === 0) h = 0x9e3779b9;
  for (let r = 0; r < 2; r++) {
    h ^= (h << 13) >>> 0; h >>>= 0;
    h ^= h >>> 17;
    h ^= (h << 5) >>> 0; h >>>= 0;
  }
  return h / 0x100000000;
}

// --- narration templates (self-written; numbers cited inline so every line is auditable) ---

function prophetText(id: number, rep: number, gini: number): string {
  return `Fly #${id} stops mid-feast and will not eat: repute ${rep.toFixed(2)} in an age cleaved ` +
    `${Math.round(gini * 100)}/100 — it speaks in a voice the swarm does not know, and the swarm leans in.`;
}

function foundedText(name: string, founderId: number, roster: number, hue: number, fervor: number): string {
  return `The ${name} covenant is founded — #${founderId} beneath a hue-${hue} banner with ` +
    `${roster} sworn; fervor opens at ${fervor.toFixed(2)}.`;
}

function holyDayText(covenants: number): string {
  return `A global holy day: ${covenants} covenant${covenants === 1 ? "" : "s"} chant as one swarm, ` +
    `every ember stoked by one shared pulse.`;
}

function schismText(parent: string, child: string, walking: number, leaderId: number, hue: number, fervor: number): string {
  return `Fervor ${fervor.toFixed(2)} boils over in the ${parent}: ${walking} of the faithful walk out behind ` +
    `#${leaderId} and raise the ${child} beneath a hue-${hue} banner — the mother creed is torn and cools.`;
}

function fadeText(name: string, cause: "buried" | "ember" | "unmade", unkindled: number, fervor: number): string {
  if (cause === "buried") {
    return `The ${name} falls silent — no living voice remains; the last chants scatter into the hum.`;
  }
  if (cause === "unmade") {
    return `The ${name} is unmade — the swarm's memory holds but ${SECT_CAP} covenants, and the oldest ` +
      `cold ember yields its place to younger fire.`;
  }
  return `The ${name} goes out — ${unkindled} ticks without a boon able to rekindle it, fervor ` +
    `${fervor.toFixed(2)}; the creed is no more.`;
}

/**
 * The faith membrane: a per-DO singleton owning the swarm's covenants. state.ts drives it once per tick
 * with the same read-outs the economy/chronicler already consume; it answers with narrations for the
 * chronicle, the living sect list for the frontend, and the holy-day flag for ceremony.
 */
export class Religion {
  private seedBase: number;
  private nextSectId = 1;
  private sects: SectCore[] = [];
  /** Lifetime prophet registry: a fly that has EVER founded (or led a schism of) a covenant can never
   *  rise again — the swarm remembers its prophets even after their covenant is unmade. Without this,
   *  a cap-trimmed prophet would re-found next tick and churn the memory forever. Bounded ≤ 32 ids. */
  private led = new Set<number>();

  constructor(seed: number) {
    this.seedBase = Number.isFinite(seed) ? Math.trunc(seed) : 0;
  }

  /**
   * One tick of faith. Phase order (see header): deaths → drift → fade → holy day → prophets →
   * schisms → cap trim. Pure against the input; all randomness flows from the seeds × tick.
   */
  step(input: ReligionInput): ReligionReadOut {
    const narrations: ReligionNarration[] = [];
    const tick = Math.trunc(input.tick);
    const ts = input.nowTs;
    const seed = Number.isFinite(input.seed) ? Math.trunc(input.seed) : this.seedBase;
    const era = Number.isFinite(input.era) ? Math.trunc(input.era) : 0;
    const gini = clamp01(Number.isFinite(input.gini) ? input.gini : 0);
    const dead = new Set<number>(input.deadIds);
    const keys = (subject: number, salt: number): number[] => [this.seedBase, seed, era, tick, subject, salt];

    const say = (kind: ReligionNarrationKind, text: string, actorIds: number[]): void => {
      narrations.push({ kind, text, actorIds, ts });
    };

    // reputation table for leader picks (defensively deduped; the contract promises rep-desc order)
    const repById = new Map<number, number>();
    for (const t of input.topReputations) {
      if (t && Number.isFinite(t.id) && Number.isFinite(t.rep)) repById.set(Math.trunc(t.id), t.rep);
    }

    // strong-bond adjacency (both directions, deduped, strongest first / lowest id on ties)
    const adj = new Map<number, Array<{ id: number; s: number }>>();
    for (const b of input.bonds) {
      if (!b || !Number.isFinite(b.strength) || !Number.isFinite(b.a) || !Number.isFinite(b.b)) continue;
      const a = Math.trunc(b.a), c = Math.trunc(b.b);
      if (a === c) continue;
      const link = (x: number, y: number): void => {
        let list = adj.get(x);
        if (!list) adj.set(x, (list = []));
        const ex = list.find((e) => e.id === y);
        if (ex) ex.s = Math.max(ex.s, b.strength);
        else list.push({ id: y, s: b.strength });
      };
      link(a, c);
      link(c, a);
    }
    for (const list of adj.values()) list.sort((x, y) => y.s - x.s || x.id - y.id);
    const degreeOf = (id: number): number => adj.get(id)?.length ?? 0;

    // ① DEATHS — prune rosters, mark dead founders, bury creeds with no living voice
    for (const s of this.sects) {
      if (s.memberIds.some((m) => dead.has(m))) s.memberIds = s.memberIds.filter((m) => !dead.has(m));
      if (!s.founderDead && dead.has(s.founderId)) s.founderDead = true;
    }
    this.sects = this.sects.filter((s) => {
      if (s.memberIds.length > 0) return true;
      say("SECT_FADE", fadeText(s.name, "buried", tick - s.lastKindledTick, s.fervor), []);
      return false;
    });

    // ② FERVOR DRIFT — zeal feeds on inequality; a dead founder bleeds the creed dry ON TOP of the
    //    idle cooling (spec: "−0.01/tick on top of the −0.0006 idle") — both decays always apply.
    for (const s of this.sects) {
      const zeal = Math.max(0, gini - 0.5) * ZEAL_RATE;
      const bleed = IDLE_DECAY + (s.founderDead ? FOUNDER_DECAY : 0);
      s.fervor = clamp01(s.fervor + zeal - bleed);
    }

    // ③ FADE — an ember no boon has rekindled for FADE_AFTER ticks, still cold, goes out
    this.sects = this.sects.filter((s) => {
      if (!(s.fervor < EMBER_LINE && tick - s.lastKindledTick >= FADE_AFTER)) return true;
      say("SECT_FADE", fadeText(s.name, "ember", tick - s.lastKindledTick, s.fervor), [...s.memberIds]);
      return false;
    });

    // ④ HOLY DAY — every HOLY_EVERY ticks the whole swarm keeps one shared ceremony (if anyone believes)
    let holyDay = false;
    if (tick % HOLY_EVERY === 0 && this.sects.length > 0) {
      holyDay = true;
      for (const s of this.sects) {
        s.fervor = clamp01(s.fervor + HOLY_BOON);
        if (s.fervor >= EMBER_LINE) s.lastKindledTick = tick; // a boon that cannot rekindle is noise, not grace
      }
      say("HOLY_DAY", holyDayText(this.sects.length), []);
    }

    // fly → sect membership (a fly belongs to at most one covenant; schism is the only split path)
    const membership = new Map<number, number>();
    for (const s of this.sects) for (const m of s.memberIds) membership.set(m, s.id);

    // ⑤ PROPHETS — rep ≥ .8, degree ≥ 3, gini ≥ .6, alive, sectless; the rise-draw assents or not
    if (gini >= PROPHET_GINI_FLOOR) {
      const seen = new Set<number>();
      const candidates = input.topReputations
        .filter((t) => {
          if (!t || !Number.isFinite(t.id)) return false;
          const id = Math.trunc(t.id);
          if (seen.has(id)) return false;
          seen.add(id);
          return t.rep >= PROPHET_MIN_REP && !dead.has(id) && !membership.has(id) && !this.led.has(id)
            && degreeOf(id) >= PROPHET_MIN_DEGREE;
        })
        .sort((a, b) => b.rep - a.rep || Math.trunc(a.id) - Math.trunc(b.id)); // defensive: rep-desc, id asc

      for (const c of candidates) {
        const id = Math.trunc(c.id);
        if (draw01(...keys(id, SALT_PROPHET)) >= PROPHET_PCT) continue;
        const roster = [id];
        for (const n of adj.get(id) ?? []) {
          if (roster.length >= SECT_MEMBERS_CAP) break;
          if (dead.has(n.id) || membership.has(n.id)) continue;
          roster.push(n.id);
        }
        const fervor0 = clamp01(0.5 + 0.15 * draw01(...keys(id, SALT_EMBER)));
        const hue = Math.floor(draw01(...keys(id, SALT_HUE)) * 360) % 360;
        const sect: SectCore = {
          id: this.nextSectId++,
          name: this.mintName(keys(id, SALT_NAME), new Set(this.sects.map((s) => s.name))),
          founderId: id,
          foundedTick: tick,
          memberIds: roster,
          hue,
          fervor: fervor0,
          lastKindledTick: tick,
          founderDead: false,
        };
        this.sects.push(sect);
        this.led.add(id);   // lifetime exclusivity: this prophet can never rise again
        for (const m of roster) membership.set(m, sect.id);
        say("PROPHET", prophetText(id, c.rep, gini), [id]);
        say("SECT_FOUNDED", foundedText(sect.name, id, roster.length, hue, fervor0), [...roster]);
      }
    }

    // ⑥ SCHISMS — a fervent crowd (oldest covenant first) tears; ~1/3 walk out, the mother cools
    for (const s of [...this.sects].sort((a, b) => a.foundedTick - b.foundedTick || a.id - b.id)) {
      if (s.fervor <= SCHISM_FERVOR || s.memberIds.length < SCHISM_MIN_MEMBERS) continue;
      if (draw01(...keys(s.id, SALT_SCHISM)) >= SCHISM_PCT) continue;
      const pool = s.memberIds.filter((m) => m !== s.founderId).sort((a, b) => a - b);
      if (pool.length < 2) continue; // no one left to anoint
      const childSize = Math.max(2, Math.round(s.memberIds.length / 3));
      const off = Math.floor(draw01(...keys(s.id, SALT_ROSTER)) * pool.length) % pool.length;
      const rotated = pool.slice(off).concat(pool.slice(0, off));
      const departing = rotated.slice(0, childSize);
      // the departing fly with the highest repute leads (ties → lower id; unlisted → lowest id wins)
      const rank = (m: number): number => repById.get(m) ?? -1;
      let leader = departing[0];
      for (const m of departing) {
        if (rank(m) > rank(leader) || (rank(m) === rank(leader) && m < leader)) leader = m;
      }
      const fervor = s.fervor;
      const childId = this.nextSectId++; // the child's own id keys its name/hue draws — no aliasing with the parent's streams
      const child: SectCore = {
        id: childId,
        name: this.mintName(keys(childId, SALT_NAME), new Set(this.sects.map((x) => x.name))),
        founderId: leader,
        foundedTick: tick,
        memberIds: [...departing].sort((a, b) => a - b),
        hue: Math.floor(draw01(...keys(childId, SALT_HUE)) * 360) % 360,
        fervor: clamp01(fervor),
        lastKindledTick: tick,
        founderDead: false,
      };
      const gone = new Set(departing);
      s.memberIds = s.memberIds.filter((m) => !gone.has(m));
      s.fervor = clamp01(fervor - SCHISM_WOUND);
      this.sects.push(child);
      this.led.add(leader);   // the anointed leader also enters the lifetime registry
      for (const m of child.memberIds) membership.set(m, child.id);
      say("SCHISM", schismText(s.name, child.name, departing.length, leader, child.hue, fervor), [...departing]);
    }

    // ⑦ CAP TRIM — the swarm remembers at most SECT_CAP covenants; the oldest cold ember yields
    if (this.sects.length > SECT_CAP) {
      const doomed = new Set(
        [...this.sects]
          .sort((a, b) => a.foundedTick - b.foundedTick || a.fervor - b.fervor || a.id - b.id)
          .slice(0, this.sects.length - SECT_CAP)
          .map((s) => s.id),
      );
      this.sects = this.sects.filter((s) => {
        if (!doomed.has(s.id)) return true;
        say("SECT_FADE", fadeText(s.name, "unmade", tick - s.lastKindledTick, s.fervor), [...s.memberIds]);
        return false;
      });
    }

    // read-out: fresh copies so callers can never reach into the membrane's state
    return {
      sects: this.sects.map((s) => ({
        id: s.id, name: s.name, founderId: s.founderId, foundedTick: s.foundedTick,
        memberIds: [...s.memberIds], hue: s.hue, fervor: s.fervor,
      })),
      narrations,
      holyDay,
    };
  }

  /** Mint a covenant name: 2–3 self-invented syllables, capitalised, unique among the living (8 tries). */
  private mintName(keys: number[], taken: Set<string>): string {
    let fallback = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const n = 2 + (draw01(...keys, SALT_NAME, attempt) < 0.4 ? 1 : 0);
      let name = "";
      for (let i = 0; i < n; i++) {
        const pick = Math.floor(draw01(...keys, SALT_NAME, attempt * 16 + i) * SYLLABLES.length) % SYLLABLES.length;
        name += SYLLABLES[pick];
      }
      name = name.charAt(0).toUpperCase() + name.slice(1);
      if (attempt === 0) fallback = name;
      if (!taken.has(name)) return name;
    }
    return fallback; // practically unreachable: ~27k combinations against ≤ 4 living names
  }

  /**
   * Persist the membrane only (≤ 4 sects × ≤ 8 members + scalars). Narrations are ephemeral —
   * they belong to the chronicler the moment they are spoken.
   */
  toJSON(): unknown {
    return {
      v: RELIGION_VERSION,
      seedBase: this.seedBase,
      nextSectId: this.nextSectId,
      led: [...this.led].slice(0, 32),
      sects: this.sects.map((s) => ({
        id: s.id, name: s.name, founderId: s.founderId, foundedTick: s.foundedTick,
        memberIds: [...s.memberIds], hue: s.hue, fervor: s.fervor,
        lastKindledTick: s.lastKindledTick, founderDead: s.founderDead,
      })),
    };
  }

  /** Restore from a stored blob; absent/corrupt/foreign-version ⇒ a fresh empty membrane (faith restarts). */
  static fromJSON(o: unknown): Religion {
    const p = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
    const seedBase = Number.isFinite(p.seedBase as number) ? Math.trunc(p.seedBase as number) : 0;
    const r = new Religion(seedBase);
    if (p.v !== RELIGION_VERSION || !Array.isArray(p.sects)) return r;
    if (Array.isArray(p.led)) {
      for (const x of p.led) {
        const id = Number(x);
        if (Number.isInteger(id) && id >= 0) r.led.add(id);
        if (r.led.size >= 32) break;
      }
    }
    const seenIds = new Set<number>();
    for (const raw of p.sects) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const id = Number(e.id);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const founderId = Number(e.founderId);
      const foundedTick = Number(e.foundedTick);
      const hue = Number(e.hue);
      const fervor = Number(e.fervor);
      if (!Number.isInteger(id) || id < 1) continue;
      if (!Number.isInteger(founderId) || founderId < 0) continue;
      if (!Number.isInteger(foundedTick) || foundedTick < 0) continue;
      if (typeof e.name !== "string" || e.name.length === 0 || e.name.length > 32) continue;
      const memberIds = Array.isArray(e.memberIds)
        ? Array.from(new Set(e.memberIds.map((m) => Number(m)).filter((m) => Number.isInteger(m) && m >= 0)))
            .slice(0, SECT_MEMBERS_CAP)
        : [];
      const lastKindledTick = Number(e.lastKindledTick);
      r.sects.push({
        id, name: e.name, founderId, foundedTick,
        memberIds,
        hue: Number.isInteger(hue) && hue >= 0 && hue <= 359
          ? hue
          : Number.isFinite(hue)
            ? ((Math.trunc(hue) % 360) + 360) % 360
            : 0,
        fervor: clamp01(Number.isFinite(fervor) ? fervor : 0),
        lastKindledTick: Number.isInteger(lastKindledTick) && lastKindledTick >= 0 ? lastKindledTick : foundedTick,
        founderDead: e.founderDead === true,
      });
      if (r.sects.length >= SECT_CAP) break;
    }
    r.sects.sort((a, b) => a.id - b.id);
    const maxId = r.sects.reduce((m, s) => Math.max(m, s.id), 0);
    const stored = Number(p.nextSectId);
    r.nextSectId = Math.max(Number.isInteger(stored) && stored >= 1 ? stored : 1, maxId + 1);
    return r;
  }
}
