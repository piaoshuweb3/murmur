// THE FAITH MEMBRANE (信仰膜) tests — prophets, covenants, holy days, schisms, fade-outs.
//
// The religion layer is a PURE READ-OUT (it never touches a genome, a connectome, a wallet or the
// manifest hash), so the two things these tests must pin are:
//   1. THE MECHANISM AS DESIGNED — a prophet rises only when repute, cluster degree and cleave ALL
//      hold; rosters cap at eight; holy days pulse every 96 ticks with fervor capped at 1; fervent
//      crowds tear; founderless creeds bleed out; unkindled embers fade; memory holds but four
//      covenants. Every rule is exercised against tuned-but-fixed seeds (mirroring economy.test.ts's
//      seedBase 42 discipline) so the outcomes are permanent, not probabilistic.
//   2. BYTE-FOR-BYTE DETERMINISM — same constructor seed + same inputs ⇒ identical histories
//      (JSON.stringify equality, not deepEqual-with-latitude), a different seed ⇒ a different story,
//      and toJSON → fromJSON round-trips a membrane that agrees with its twin forever after.

import test from "node:test";
import assert from "node:assert/strict";

import { Religion, type ReligionInput, type Sect } from "./religion.js";

// ---------- helpers ----------

/** The membrane's identity seed (mirrors economy.test.ts's seedBase 42) and the caller's per-tick seed. */
const BASE = 42;
const CALLER_SEED = 7;

type ReadOut = ReturnType<Religion["step"]>;

function input(tick: number, over: Partial<ReligionInput> = {}): ReligionInput {
  return {
    tick,
    nowTs: 1_700_000_000_000 + tick, // narrations are stamped by the caller, never by a clock here
    seed: CALLER_SEED,
    era: 1,
    topReputations: [],
    bonds: [],
    gini: 0.3,
    deadIds: [],
    ...over,
  };
}

const rep = (id: number, r: number) => ({ id, rep: r });
const bond = (a: number, b: number, strength = 0.9) => ({ a, b, strength });

/** The standard prophet scenario: fly #7 adored (repute .95) at the center of a six-thread cluster. */
function prophetWorld(tick: number, over: Partial<ReligionInput> = {}): ReligionInput {
  const leaves = [1, 2, 3, 4, 5, 6];
  return input(tick, {
    topReputations: [rep(7, 0.95), ...leaves.map((l) => rep(l, 0.4))],
    bonds: leaves.map((l) => bond(7, l)),
    gini: 0.8,
    ...over,
  });
}

/** Step a scenario until a covenant exists (tuned seeds fire within a few ticks; else tuning broke). */
function foundCovenant(make: (t: number) => ReligionInput, maxTicks = 12): { r: Religion; out: ReadOut; foundedTick: number } {
  const r = new Religion(BASE);
  for (let t = 1; t <= maxTicks; t++) {
    const out = r.step(make(t));
    if (out.sects.length > 0) return { r, out, foundedTick: t };
  }
  throw new Error(`no covenant founded within ${maxTicks} ticks — seed tuning broke`);
}

/** The membrane's own serialization is a public contract: patch a living covenant through it. */
interface Blob {
  v: number;
  seedBase: number;
  nextSectId: number;
  sects: Array<Record<string, unknown>>;
}
function withSect(r: Religion, patch: Record<string, unknown>): Religion {
  const blob = r.toJSON() as Blob;
  assert.ok(blob.sects.length >= 1, "withSect needs a living covenant");
  blob.sects = blob.sects.map((s) => ({ ...s, ...patch }));
  return Religion.fromJSON(blob);
}

// ---------- prophet rise: every condition must hold ----------

test("no prophet rises unless repute, cluster degree and cleave ALL hold", () => {
  const leaves = [1, 2, 3, 4, 5, 6];
  const cases: Array<{ name: string; over: Partial<ReligionInput> }> = [
    { name: "an equal age breeds no faith (gini < 0.6)", over: { gini: 0.55 } },
    { name: "repute below the line rises nobody", over: { topReputations: [rep(7, 0.79), ...leaves.map((l) => rep(l, 0.4))] } },
    { name: "a cluster too thin (degree < 3) rises nobody", over: { bonds: [bond(7, 1), bond(7, 2)] } },
    { name: "a dead fly cannot rise", over: { deadIds: [7] } },
  ];
  for (const c of cases) {
    const r = new Religion(BASE);
    for (let t = 1; t <= 12; t++) {
      const out = r.step(prophetWorld(t, c.over));
      assert.equal(out.sects.length, 0, c.name);
      assert.equal(out.narrations.length, 0, c.name);
    }
  }
});

test("a qualifying prophet rises and binds a covenant (a two-beat announcement)", () => {
  const { r, out, foundedTick } = foundCovenant((t) => prophetWorld(t));
  assert.equal(out.sects.length, 1);
  const sect = out.sects[0];
  assert.equal(sect.founderId, 7);
  assert.ok(sect.memberIds.includes(7), "the prophet swears first");
  assert.ok(sect.memberIds.length >= 2 && sect.memberIds.length <= 8);
  assert.ok(Number.isInteger(sect.hue) && sect.hue >= 0 && sect.hue <= 359, "banner hue 0..359");
  assert.ok(sect.fervor > 0.4 && sect.fervor < 0.7, `opening fervor in the founding band, got ${sect.fervor}`);
  assert.match(sect.name, /^[A-Z][a-z]+$/, "a minted, self-invented name");
  const kinds = out.narrations.map((n) => n.kind);
  const i = kinds.indexOf("PROPHET");
  assert.ok(i >= 0, "the rise is announced");
  assert.equal(kinds[i + 1], "SECT_FOUNDED", "then the covenant");
  assert.deepEqual(out.narrations[i].actorIds, [7]);
  assert.ok(out.narrations[i + 1].text.includes(sect.name));
  assert.ok(out.narrations.every((n) => n.ts === 1_700_000_000_000 + foundedTick), "stamped by input.nowTs");
  // the prophet already leads — no second covenant can ever mint from the same fly
  for (let t = foundedTick + 1; t <= foundedTick + 6; t++) {
    assert.equal(r.step(prophetWorld(t)).sects.length, 1, "one fly, one covenant");
  }
});

test("the founding roster caps at eight and takes the strongest bonds first", () => {
  const leaves = Array.from({ length: 20 }, (_, i) => i + 1);
  const { out } = foundCovenant((t) =>
    input(t, {
      topReputations: [rep(9, 0.95), ...leaves.map((l) => rep(l, 0.5))],
      bonds: leaves.map((l) => bond(9, l, 0.5 + l * 0.001)), // strictly ordered thread strengths
      gini: 0.8,
    }),
  );
  assert.equal(out.sects.length, 1);
  // prophet + the seven strongest threads (leaf 20 binds tightest … leaf 14 loosest of the chosen)
  assert.deepEqual(out.sects[0].memberIds, [9, 20, 19, 18, 17, 16, 15, 14]);
});

// ---------- holy days: the 96-tick pulse, the boon, the cap ----------

test("holy days pulse every 96 ticks, lift the covenant, and are unkept when nobody believes", () => {
  const { r, foundedTick } = foundCovenant((t) => prophetWorld(t));
  assert.ok(foundedTick < 90);
  // an unkept holy day: no covenant ⇒ nothing is observed, nothing is narrated
  const nobody = new Religion(BASE).step(input(96));
  assert.equal(nobody.holyDay, false);
  assert.equal(nobody.narrations.length, 0);
  // run the eve of the ceremony
  let eve: ReadOut | null = null;
  for (let t = foundedTick + 1; t <= 95; t++) eve = r.step(prophetWorld(t));
  assert.ok(eve);
  assert.equal(eve.holyDay, false, "tick 95 is not the pulse");
  const before = eve.sects[0].fervor;
  const holy = r.step(prophetWorld(96));
  assert.equal(holy.holyDay, true);
  const days = holy.narrations.filter((n) => n.kind === "HOLY_DAY");
  assert.equal(days.length, 1);
  assert.ok(days[0].text.includes("1 covenant"));
  // drift on the holy tick is zeal(+0.0015 at gini .8) − idle(0.0006), then the +0.05 boon
  assert.ok(Math.abs(holy.sects[0].fervor - (before + 0.0009 + 0.05)) < 1e-9, "boon applied once, exactly");
  assert.equal(r.step(prophetWorld(97)).holyDay, false, "the pulse passes");
});

test("fervor is capped at exactly 1 on the boon and floored at 0 in the founderless bleed", () => {
  const { r } = foundCovenant((t) => prophetWorld(t));
  // a 4-fly flock cannot tear (schism needs ≥ 6) — keeps the boon test pure, no same-tick schism
  const capped = withSect(r, { fervor: 0.99, memberIds: [7, 1, 2, 3] }).step(prophetWorld(96));
  assert.equal(capped.holyDay, true);
  assert.equal(capped.sects[0].fervor, 1, "the boon cannot overflow the vessel");
  const cold = withSect(r, { fervor: 0, founderDead: true });
  const out = cold.step(input(97, { topReputations: [rep(7, 0.95)], gini: 0.3 }));
  assert.equal(out.sects.length, 1);
  assert.equal(out.sects[0].fervor, 0, "the bleed cannot go negative");
});

// ---------- schism: the tear ----------

test("a fervent crowd tears: about a third walks out and the mother cools", () => {
  const { r } = foundCovenant((t) => prophetWorld(t)); // roster: 7 + leaves 1..6 = 7 sworn
  const hot = withSect(r, { fervor: 0.9 });
  let torn: ReadOut | null = null;
  for (let t = 50; t <= 60; t++) {
    const out = hot.step(prophetWorld(t));
    if (out.sects.length === 2) { torn = out; break; }
  }
  assert.ok(torn, "the tear-draw assents within the tuned window");
  const parent = torn.sects.find((s) => s.founderId === 7) as Sect;
  const child = torn.sects.find((s) => s.founderId !== 7) as Sect;
  assert.ok(parent && child);
  assert.equal(parent.memberIds.length, 5, "7 stay with the mother");
  assert.equal(child.memberIds.length, 2, "round(7/3) = 2 walk out");
  assert.ok(parent.memberIds.includes(7), "the founder never abandons their own covenant");
  assert.ok(child.id > parent.id, "the child is minted after the mother");
  assert.notEqual(child.name, parent.name, "a new name");
  assert.ok(Number.isInteger(child.hue) && child.hue >= 0 && child.hue <= 359);
  // the tear tick is draw-dependent (assents somewhere in 50..60), so the fervor assertions are
  // RELATIVE — the exact pre-wound level belongs to whichever tick the tear fired on:
  assert.ok(child.fervor > 0.85 && child.fervor <= 1, "the child carries the fire");
  assert.ok(Math.abs(parent.fervor - (child.fervor - 0.25)) < 1e-9, "the mother cools by the wound");
  const sch = torn.narrations.find((n) => n.kind === "SCHISM");
  assert.ok(sch, "the tear is announced");
  assert.deepEqual([...sch.actorIds].sort((a, b) => a - b), [...child.memberIds].sort((a, b) => a - b));
  assert.ok(sch.text.includes(parent.name) && sch.text.includes(child.name));
  assert.ok(child.memberIds.includes(child.founderId), "the anointed leader walks with their flock");
});

test("a lukewarm or a thin crowd never tears", () => {
  // fervor at/below the boil line: no draw is even taken. 0.80 + 30 ticks × 0.0009 drift stays under 0.85.
  const lukewarm = withSect(foundCovenant((t) => prophetWorld(t)).r, { fervor: 0.8 });
  for (let t = 50; t <= 79; t++) assert.equal(lukewarm.step(prophetWorld(t)).sects.length, 1);
  // roster below six: a fervent handful cannot split
  const thinWorld = (t: number) => prophetWorld(t, { bonds: [1, 2, 3, 4].map((l) => bond(7, l)) });
  const thin = foundCovenant(thinWorld);
  assert.equal(thin.out.sects[0].memberIds.length, 5);
  const hotThin = withSect(thin.r, { fervor: 0.95 });
  for (let t = 50; t <= 79; t++) assert.equal(hotThin.step(thinWorld(t)).sects.length, 1);
});

// ---------- death, fade ----------

test("a dead founder bleeds the creed; a dead roster buries it at once", () => {
  const { r, out: founding, foundedTick } = foundCovenant((t) => prophetWorld(t));
  const f0 = founding.sects[0].fervor;
  const afterDeath = r.step(prophetWorld(foundedTick + 1, { deadIds: [7] }));
  assert.equal(afterDeath.sects.length, 1, "the creed outlives its founder");
  // zeal(+0.0015 at gini .8) − founder bleed(0.01) − idle(0.0006)
  assert.ok(Math.abs(afterDeath.sects[0].fervor - (f0 - 0.0091)) < 1e-9, "−0.01/tick founder bleed, net");
  const again = r.step(prophetWorld(foundedTick + 2));
  assert.ok(Math.abs(again.sects[0].fervor - (afterDeath.sects[0].fervor - 0.0091)) < 1e-9, "it bleeds every tick");
  // bury everyone: no living voice remains
  const buried = r.step(prophetWorld(foundedTick + 3, { deadIds: again.sects[0].memberIds }));
  assert.equal(buried.sects.length, 0);
  const fades = buried.narrations.filter((n) => n.kind === "SECT_FADE");
  assert.equal(fades.length, 1);
  assert.ok(fades[0].text.includes("no living voice remains"));
  assert.equal(r.step(prophetWorld(foundedTick + 4)).sects.length, 0, "and the memory stays empty");
});

test("an unkindled ember fades after exactly 240 ticks; a boon that rekindles saves it", () => {
  // cold path: cool the era, freeze the ember, and watch the kindle clock run out
  const cold = foundCovenant((t) => prophetWorld(t));
  const state = cold.r;
  for (let t = cold.foundedTick + 1; t <= 94; t++) state.step(prophetWorld(t, { gini: 0.3 }));
  const frozen = withSect(state, { fervor: 0.05 }); // below the ember line; boons cannot lift it over 0.15
  let fadedAt = -1;
  for (let t = 95; t <= cold.foundedTick + 250; t++) {
    const out = frozen.step(prophetWorld(t, { gini: 0.3 }));
    if (out.sects.length === 0) { fadedAt = t; break; }
  }
  assert.equal(fadedAt, cold.foundedTick + 240, "the ember goes out on its 240th unkindled tick");
  // rescue path: a boon that CAN rekindle resets the kindle clock — the creed endures
  const warm = foundCovenant((t) => prophetWorld(t));
  const state2 = warm.r;
  for (let t = warm.foundedTick + 1; t <= 94; t++) state2.step(prophetWorld(t, { gini: 0.3 }));
  const lukewarm = withSect(state2, { fervor: 0.12 }); // 0.12 − drift + 0.05 boon ≥ 0.15 at tick 96
  let sawHoly = false;
  let alive = true;
  for (let t = 95; t <= warm.foundedTick + 250; t++) {
    const out = lukewarm.step(prophetWorld(t, { gini: 0.3 }));
    sawHoly = sawHoly || out.holyDay;
    alive = alive && out.sects.length === 1;
  }
  assert.ok(sawHoly, "holy days did pass");
  assert.ok(alive, "the rekindled creed outlives the 240-tick axe");
});

// ---------- the cap: memory holds but four ----------

test("the swarm remembers at most four covenants — the oldest cold ember yields", () => {
  const prophets = [7, 17, 27, 37, 47];
  const world = (t: number) =>
    input(t, {
      topReputations: prophets.map((p) => rep(p, 0.9)),
      bonds: prophets.flatMap((p) => [p - 6, p - 5, p - 4].map((l) => bond(p, l))), // disjoint clusters of 3
      gini: 0.8,
    });
  const r = new Religion(BASE);
  let founded = 0;
  let fades = 0;
  let prev: ReadOut | null = null;
  for (let t = 1; t <= 40; t++) {
    const out = r.step(world(t));
    assert.ok(out.sects.length <= 4, `never more than four (tick ${t})`);
    founded += out.narrations.filter((n) => n.kind === "SECT_FOUNDED").length;
    for (const n of out.narrations.filter((x) => x.kind === "SECT_FADE")) {
      fades++;
      assert.match(n.text, /is unmade/, "the overflow dissolve names its cause");
      const name = (n.text.match(/The (.+?) is unmade/) ?? [])[1];
      assert.ok(prev, "a trim needs a previous crowd");
      // the unmade covenant is the oldest (coldest on ties) of the crowd that existed a tick earlier
      const crowd = prev.sects.filter((s) => s.name === name);
      assert.equal(crowd.length, 1, "the unmade name belonged to the living");
      const victim = crowd[0];
      const minKey = Math.min(...prev.sects.map((s) => s.foundedTick * 1000 + s.fervor));
      assert.equal(victim.foundedTick * 1000 + victim.fervor, minKey, "oldest-and-coldest yields its place");
    }
    prev = out;
  }
  assert.equal(founded, 5, "all five prophets rose");
  assert.equal(fades, 1, "exactly one covenant was unmade by the cap");
  const last = r.step(world(41));
  assert.equal(last.sects.length, 4);
  assert.equal(new Set(last.sects.map((s) => s.name)).size, 4, "living names stay unique");
});

// ---------- exclusivity ----------

test("membership is exclusive: shared kin end up in one covenant, never two", () => {
  const world = (t: number) =>
    input(t, {
      topReputations: [rep(1, 0.9), rep(5, 0.9)],
      bonds: [bond(1, 2), bond(1, 3), bond(1, 4), bond(5, 2), bond(5, 3), bond(5, 4)],
      gini: 0.8,
    });
  const r = new Religion(BASE);
  let both: ReadOut | null = null;
  for (let t = 1; t <= 24 && !both; t++) {
    const out = r.step(world(t));
    if (out.sects.length === 2) both = out;
  }
  assert.ok(both, "both prophets rose within the tuned window");
  const flat = both.sects.flatMap((s) => s.memberIds);
  assert.equal(new Set(flat).size, flat.length, "no fly is sworn twice");
  const byFounder = new Map(both.sects.map((s) => [s.founderId, s.memberIds]));
  assert.ok(byFounder.get(1)?.includes(1) && byFounder.get(5)?.includes(5));
  for (const m of [2, 3, 4]) assert.ok(flat.includes(m), `shared kin #${m} found a home`);
});

// ---------- serialization ----------

test("toJSON → fromJSON round-trips the membrane and both agree forever after", () => {
  const { r } = foundCovenant((t) => prophetWorld(t));
  for (let t = 13; t <= 20; t++) r.step(prophetWorld(t));
  const blob = JSON.parse(JSON.stringify(r.toJSON()));
  const twin = Religion.fromJSON(blob);
  assert.deepEqual(twin.toJSON(), r.toJSON(), "the restored state is the same state");
  const future = [...Array.from({ length: 5 }, (_, i) => 21 + i), 96];
  for (const t of future) {
    const a = r.step(prophetWorld(t));
    const b = twin.step(prophetWorld(t));
    assert.equal(JSON.stringify(b), JSON.stringify(a), `twin agreement at tick ${t}`);
  }
});

test("fromJSON swallows garbage into a fresh empty membrane — and salvages what it can", () => {
  for (const junk of [null, undefined, 42, "x", {}, { v: 99, sects: [] }, { v: 1, sects: "nope" }, { v: 1, sects: [null, { id: "x" }] }]) {
    const fresh = Religion.fromJSON(junk as unknown);
    const j = fresh.toJSON() as Blob;
    assert.equal(j.sects.length, 0, `garbage ${JSON.stringify(junk)} → empty membrane`);
    assert.ok(Array.isArray(fresh.step(prophetWorld(1)).sects));
  }
  // a valid blob is clamped and reordered, never trusted
  const r = Religion.fromJSON({
    v: 1,
    seedBase: 9,
    nextSectId: 5,
    sects: [
      { id: 1, name: "Oldfaith", founderId: 0, foundedTick: 4, memberIds: [], hue: 999, fervor: 2, lastKindledTick: -3, founderDead: true },
      { id: 3, name: "Zhoqor", founderId: 7, foundedTick: 10, memberIds: [7, 1, 2], hue: 200, fervor: 0.4, lastKindledTick: 10, founderDead: false },
      { id: 3, name: "Dupe", founderId: 0, foundedTick: 5, memberIds: [9], hue: 1, fervor: 0.5, lastKindledTick: 5, founderDead: false },
    ],
  });
  const j = r.toJSON() as Blob;
  assert.equal(j.seedBase, 9);
  assert.equal(j.nextSectId, 5, "the stored counter survives (max id + 1 is smaller)");
  assert.deepEqual(j.sects.map((s) => (s as { id: number }).id), [1, 3], "sorted, duplicate id dropped");
  const s1 = j.sects[0] as Record<string, unknown>;
  assert.equal(s1.hue, 279, "hue 999 wraps into 0..359");
  assert.equal(s1.fervor, 1, "fervor clamps high");
  assert.equal(s1.lastKindledTick, 4, "a corrupt kindle clock falls back to the founding tick");
});

// ---------- determinism: the membrane's soul ----------

test("same seed + same inputs ⇒ byte-identical histories; a different seed ⇒ a different story", () => {
  const script: Array<(t: number) => ReligionInput> = [];
  for (let t = 1; t <= 48; t++) script.push((tt) => prophetWorld(tt, { gini: tt < 24 ? 0.65 : 0.9 }));
  script.push((tt) => prophetWorld(tt, { deadIds: [3] })); // a death mid-story (tick 49)
  for (let t = 50; t <= 96; t++) script.push((tt) => prophetWorld(tt)); // through the holy day
  const run = (seed: number): string[] => {
    const r = new Religion(seed);
    return script.map((mk, i) => JSON.stringify(r.step(mk(i + 1))));
  };
  const a = run(BASE);
  const b = run(BASE);
  assert.deepEqual(a, b, "twice-told tales are byte-for-byte the same tale");
  const c = run(BASE + 1);
  assert.notDeepEqual(a, c, "the constructor seed is load-bearing");
});
