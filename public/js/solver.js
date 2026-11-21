/* =====================================================================
   AO gear solver
   Finds the gear set that meets the requested stat rules and, among
   those, scores best on EP (re-weighted by the user's priorities). When
   no gear set can meet every rule, it returns the one that misses by the
   least: hard caps first, then the summed shortfall on floors, then EP.

   Search:
   1. Guided construction. The build total is a sum over slots, so for any
      set of per-stat weights the best build splits into "best piece per
      slot". Weights start at EP x priority and are nudged up for stats
      short of a floor and down for stats over a cap (Lagrangian
      multipliers), which walks the starting builds toward the rules.
   2. Exact local search from the best starts: every single change of item,
      enchant, modifier, faction, jewel and item level; jewels as a set;
      and two slots swapped at once to get off plateaus.
   3. Iterated kicks with fresh guided or random restarts until time is up.

   Slot stats are computed with the same maths as engine.js (tested
   against it), just on flat arrays so the search can afford millions of
   evaluations. Final numbers are always recomputed by engine.js.
   ===================================================================== */
(function (root) {
  'use strict';
  const E = root.AOEngine || (typeof require === 'function' ? require('./engine.js') : null);

  /* Stat vector layout used by the search. */
  const S = ['Power', 'Defense', 'Size', 'Dexterity', 'Range', 'Haste', 'Pierce', 'Resistance', 'Regeneration', 'Warding', 'Insanity', 'Drawback'];
  const NS = S.length;
  const IX = Object.fromEntries(S.map((n, i) => [n, i]));
  const I_POW = 0, I_DEF = 1, I_WARD = 9, I_INS = 10, I_DRAW = 11;

  const toVec = obj => {
    const v = new Float64Array(NS);
    for (const [k, x] of Object.entries(obj || {})) if (k in IX) v[IX[k]] += Number(x) || 0;
    return v;
  };

  /* Tolerances. Gear stats land on 0.1 steps, so "exact" targets get a small band. */
  const HIT_EPS = 1e-6;
  const tolFor = (i, value) => (i >= I_WARD ? 0.05 : Math.max(1, Math.abs(value) * 0.01));
  const AVOID_W = 5;
  const MIN_TARGET_W = 0.35;
  const FOCUS_W = -0.25;

  /* Search sizes. */
  const SHORTLIST = 8;
  const FULL_FIT_POOL = 45;
  const GEM_TOP = 10;
  const GEM_POOL_2 = 18;
  const GEM_POOL_3 = 11;
  const PAIR_TOP = 36;
  const PAIR_REFIT = 10;
  const GUIDED_ITERS = 70;
  const GUIDED_KEEP = 6;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------- rules & scoring ---------------------------- */
  function epWeights(level, data) {
    const w = new Float64Array(NS);
    for (let k = 0; k < NS; k++) w[k] = E.statEP(S[k], 1, level, data);
    return w;
  }
  function minOK(T, got, exact) {
    if (T.min === null) return true;
    if (exact) return Math.abs(got - T.min) <= tolFor(T.i, T.min) + 1e-9;
    return got >= T.min - 1e-6;
  }
  const capOK = (T, got) => T.max === null || got <= T.max + 1e-6;
  const meets = (T, got, exact) => minOK(T, got, exact) && capOK(T, got);

  /* ---------------------------- preparation ---------------------------- */
  /**
   * Everything that depends only on the data and the request: candidate pools,
   * precomputed stat vectors, and the scoring function.
   */
  function prepare(data, cfg) {
    const level = cfg.level;
    const alloc = cfg.allocator || {};
    const sp = E.spiritScale(alloc, data, level);
    const W = epWeights(level, data);
    const caps = data?.constants?.caps || {};
    const exact = !!cfg.exact;
    const insMode = cfg.insMode || 'pays';

    /* --- exclusions --- */
    const frags = String(cfg.excludeText || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const ex = cfg.exclude || {};
    const nameBlocked = name => {
      const n = String(name || '').toLowerCase();
      if (ex.lost && /\blost\b/.test(n)) return true;
      if (ex.sunken && n.includes('sunken')) return true;
      for (const f of frags) if (n.includes(f)) return true;
      return false;
    };

    /* --- targets --- */
    const targets = (cfg.targets || []).filter(T => T && T.stat in IX).map(T => ({
      i: IX[T.stat], stat: T.stat,
      min: T.min ?? null, max: T.max ?? null,
      pinned: T.min != null && T.max != null && T.min === T.max
    }));
    const avoid = new Uint8Array(NS);
    for (const s of cfg.avoid || []) if (s in IX) avoid[IX[s]] = 1;
    const prio = new Float64Array(NS).fill(1);
    for (const [s, p] of Object.entries(cfg.prio || {})) if (s in IX) prio[IX[s]] = Number(p);
    if (cfg.focus) {
      const asked = new Uint8Array(NS);
      targets.forEach(T => { asked[T.i] = 1; });
      for (let k = 0; k < NS; k++) if (prio[k] > 1 + 1e-9) asked[k] = 1;
      for (let k = 0; k < NS; k++) if (!asked[k] && W[k] > 0) prio[k] = FOCUS_W;
    }
    // A hard cap of 0 bans every source of that stat up front.
    const banned = targets.filter(T => T.max === 0).map(T => T.i);
    const addsBanned = v => banned.some(i => v[i] > 1e-9);

    /** Preference value (EP currency, priority-weighted) per unit of each stat. */
    const PW = new Float64Array(NS);
    for (let k = 0; k < NS; k++) PW[k] = avoid[k] ? -AVOID_W * Math.abs(W[k]) : prio[k] * W[k];

    function capTotals(v, out) {
      for (let k = 0; k < NS; k++) out[k] = v[k];
      if (caps.warding != null) out[I_WARD] = Math.min(out[I_WARD], caps.warding);
      if (caps.insanity != null) out[I_INS] = Math.min(out[I_INS], caps.insanity);
      return out;
    }
    const capBuf = new Float64Array(NS);
    /** Score a build total: hard violations, floor shortfall, preference, EP. */
    function scoreOf(raw) {
      const v = capTotals(raw, capBuf);
      let hv = 0, sf = 0, pref = 0, ep = 0;
      for (let k = 0; k < NS; k++) { pref += PW[k] * v[k]; ep += W[k] * v[k]; }
      for (let t = 0; t < targets.length; t++) {
        const T = targets[t], got = v[T.i];
        if (T.max !== null) {
          const over = got - T.max - HIT_EPS;
          if (over > 0) hv += over / Math.max(Math.abs(T.max), 1);
        }
        if (T.min === null) continue;
        if (T.pinned) {
          const under = T.min - got - HIT_EPS;
          if (under > 0) hv += under / Math.max(Math.abs(T.min), 1);
          continue;
        }
        const d = exact ? Math.max(0, Math.abs(got - T.min) - tolFor(T.i, T.min)) : Math.max(0, T.min - got - HIT_EPS);
        sf += Math.max(prio[T.i], MIN_TARGET_W) * d / Math.max(Math.abs(T.min), 1);
      }
      return { hv, sf, pref, ep: E.roundTo(ep, 2) };
    }

    /* --- enchants (per level, raw) --- */
    const enchants = (data.enchantments || []).filter(e => !nameBlocked(e.name) && !(cfg.exclude?.virtuous && e.special?.removesAtlantean));
    const VIRTUOUS = new Set(enchants.map((e, i) => e.special?.removesAtlantean ? i : -1).filter(i => i >= 0));
    const enchVecCache = new Map();
    const enchVecs = lvl => {
      let a = enchVecCache.get(lvl);
      if (!a) { a = enchants.map(e => toVec(E.enchantStats(e, lvl, true))); enchVecCache.set(lvl, a); }
      return a;
    };

    /* --- modifiers --- */
    const mods = (data.modifiers || []).filter(m => {
      if (nameBlocked(m.name)) return false;
      if (m.name === 'Gilded' && ex.gilded) return false;
      if (m.name === 'Imbued' && ex.imbued) return false;
      if (m.special?.bonusStat === 'first_missing' && insMode === 'never') return false;
      return true;
    });
    const modKind = mods.map(m => m.special?.bonusStat === 'first_missing' ? 'atl'
      : (m.name === 'Imbued' || m.special?.scalesWithBaseStats) ? 'imbued'
        : (m.special?.extraJewelSlot || m.name === 'Gilded') ? 'gilded' : 'plain');
    const modExtraSockets = mods.map(m => Number(m.special?.extraJewelSlot ?? (m.name === 'Gilded' ? 1 : 0)));
    const ATL_ORDER = mods.map(m => (m.special?.bonusStatOrder || []).map(s => IX[s]));
    const ATL_FALLBACK = mods.map(m => IX[m.special?.fallbackStat || (m.special?.bonusStatOrder || [])[0]] ?? I_POW);
    const allowAtl = insMode === 'any' ? null : new Set(insMode === 'power' ? [I_POW] : [I_POW, I_DEF]);
    const modVecCache = new Map();
    /** Plain-modifier vectors and Atlantean flat part + per-stat bonus, per level. */
    const modVecs = lvl => {
      let a = modVecCache.get(lvl);
      if (a) return a;
      a = mods.map((m, mi) => {
        const k = modKind[mi];
        if (k === 'plain' || k === 'gilded') return { v: toVec(E.modStats(m, null, lvl, data, {})) };
        if (k === 'atl') {
          // Split Atlantean into the part it always pays (insanity) and the
          // bonus, which lands on the first stat the slot has none of.
          const ones = () => Object.fromEntries(S.map(s => [s, 1]));
          const fbStat = ATL_FALLBACK[mi];
          const whenFull = toVec(E.modStats(m, null, lvl, data, ones()));   // nothing missing -> fallback
          const flat = Float64Array.from(whenFull);
          const fb = whenFull[fbStat];
          flat[fbStat] = 0;
          const bonus = new Float64Array(NS);
          for (const q of ATL_ORDER[mi]) {
            const cur = ones(); cur[S[q]] = 0;
            bonus[q] = toVec(E.modStats(m, null, lvl, data, cur))[q] - flat[q];
          }
          return { v: flat, bonus, fb, fbStat };
        }
        return { v: new Float64Array(NS) };
      });
      modVecCache.set(lvl, a);
      return a;
    };
    const facs = cfg.exclude?.faction ? [] : (data.factionModifiers || []).filter(m => !nameBlocked(m.name));
    const facVecCache = new Map();
    const facVecs = lvl => {
      let a = facVecCache.get(lvl);
      if (!a) { a = facs.map(f => toVec(E.modStats(f, null, lvl, data, null))); facVecCache.set(lvl, a); }
      return a;
    };

    /* --- jewels --- */
    const gems = E.allGems(data).filter(g => !nameBlocked(g.name) && !(ex.mystic && g.rarity === 'Mystic'));
    const jewels = [];
    const addJewel = (j, label) => {
      const v = toVec(E.jewelStats(j, level, data));
      if (!v.some(x => x)) return;
      if (addsBanned(v)) return;
      jewels.push({ j, v, label });
    };
    const tiers = exact ? [5, 4, 3, 2, 1, 0] : [5];
    for (const g of gems) for (const t of tiers) addJewel({ primary: { gem: g, tier: t, reagent: null }, secondReagent: null, fusion: null });
    if (!ex.fusion) {
      for (let a = 0; a < gems.length; a++) for (let b = a; b < gems.length; b++) {
        addJewel({ primary: { gem: gems[a], tier: 5, reagent: null }, secondReagent: null, fusion: { primary: { gem: gems[b], tier: 5, reagent: null }, secondReagent: null } });
      }
    }
    // Drop jewels another jewel beats on every stat in the direction that helps.
    const dir = new Int8Array(NS);
    for (let k = 0; k < NS; k++) {
      const hasMin = targets.some(T => T.i === k && T.min !== null);
      const hasMax = targets.some(T => T.i === k && T.max !== null);
      const p = PW[k];
      if (hasMin && hasMax) dir[k] = 0;
      else if (hasMax) dir[k] = p > 0 ? 0 : -1;
      else if (hasMin) dir[k] = p < 0 ? 0 : 1;
      else dir[k] = p > 0 ? 1 : p < 0 ? -1 : 0;
    }
    const dominates = (a, b) => { // a at least as good as b everywhere
      for (let k = 0; k < NS; k++) {
        if (dir[k] === 1 && a[k] < b[k] - 1e-9) return false;
        if (dir[k] === -1 && a[k] > b[k] + 1e-9) return false;
        if (dir[k] === 0 && Math.abs(a[k] - b[k]) > 1e-9) return false;
      }
      return true;
    };
    const keep = [];
    for (let i = 0; i < jewels.length; i++) {
      let dom = false;
      for (let j = 0; j < jewels.length && !dom; j++) {
        if (i === j || !dominates(jewels[j].v, jewels[i].v)) continue;
        // identical vectors: keep the earlier (single gem before fusion)
        if (dominates(jewels[i].v, jewels[j].v) && j > i) continue;
        dom = true;
      }
      if (!dom) keep.push(jewels[i]);
    }
    const JW = keep;
    const JV = JW.map(x => x.v);

    /* --- identity (magics / fighting styles) --- */
    const cap = E.identityCapacity(alloc, data);
    const pickMode = cfg.identity || {};
    const fixedMagic = new Set(), fixedStyle = new Set();
    let freeMagic = 0, freeStyle = 0;
    const magicKeys = cap.keys.filter(k => k.endsWith('Magic'));
    const styleKeys = cap.keys.filter(k => k.endsWith('FightingStyle'));
    for (const k of magicKeys) { const v = pickMode[k] ?? 'any'; if (v === 'any') freeMagic++; else if (v) fixedMagic.add(v); }
    for (const k of styleKeys) { const v = pickMode[k] ?? 'any'; if (v === 'any') freeStyle++; else if (v) fixedStyle.add(v); }
    const magicOK = m => fixedMagic.has(m) || freeMagic > 0;
    const styleOK = m => fixedStyle.has(m) || freeStyle > 0;

    /* --- item pools --- */
    const EMPTY = { empty: true, idx: -1, item: null, levels: [0], R: [new Float64Array(NS)], imb: [new Float64Array(NS)], sockets: 0, mods: [-1], facs: [], ench: [-1], base: '', magic: null, style: null };
    let recId = 0;
    const recCache = new Map();
    function makeRec(item) {
      if (recCache.has(item)) return recCache.get(item);
      let levels = E.itemLevels(item, level);
      if (!exact) levels = levels.slice(0, 1);
      if (!levels.length) { recCache.set(item, null); return null; }
      const R = levels.map(l => {
        const r = E.itemStats(item, l, data, true);
        if (item.statType === 'Spirit' && sp !== 1) for (const k of Object.keys(r)) r[k] *= sp;
        return toVec(r);
      });
      const imb = levels.map(l => toVec(E.imbuedStats(item, l, data)));
      const modList = [-1];
      const insanityBanned = banned.includes(I_INS);
      mods.forEach((m, mi) => {
        if (!E.modifierAllowed(m, item)) return;
        if (modKind[mi] === 'atl' && insanityBanned) return;
        modList.push(mi);
      });
      const facList = [];
      facs.forEach((f, fi) => { if (E.modifierAllowed(f, item)) facList.push(fi); });
      const enchList = [-1];
      enchants.forEach((e, ei) => { if (E.enchantAllowed(e, item)) enchList.push(ei); });
      const rec = {
        idx: recId++, item, levels, R, imb, sockets: E.baseSockets(item), mods: modList, facs: facList, ench: enchList,
        base: E.baseNameOf(item), amulet: item.subType === 'Amulet', helmet: item.subType === 'Helmet',
        magic: item.magicId || null, style: item.fightingStyleId || null
      };
      recCache.set(item, rec);
      return rec;
    }
    const activeSlots = E.SLOTS.filter(d => d.id !== 'shield' || cfg.useShield);
    const pools = activeSlots.map(d => {
      const out = [EMPTY];
      for (const it of data.items || []) {
        if (!d.types.includes(it.equipType)) continue;
        if (level < (it.minLevel || 1)) continue;
        if (it.isArcaniumTemplate || it.isFightingStyleTemplate || it.cosmetic) continue;
        if (it.magicId && !magicOK(it.magicId)) continue;
        if (it.fightingStyleId && !styleOK(it.fightingStyleId)) continue;
        if (nameBlocked(it.name) || nameBlocked(it.baseName)) continue;
        const rec = makeRec(it);
        if (!rec) continue;
        if (banned.length && rec.R.every(v => addsBanned(v))) continue;
        out.push(rec);
      }
      return out;
    });
    const A = activeSlots.length;

    return {
      data, cfg, level, sp, W, PW, targets, avoid, prio, exact, insMode, allowAtl, banned, addsBanned,
      enchants, VIRTUOUS, enchVecs, mods, modKind, modExtraSockets, ATL_ORDER, ATL_FALLBACK, modVecs,
      facs, facVecs, JW, JV, EMPTY, pools, activeSlots, A, scoreOf, capTotals,
      fixedMagic, fixedStyle, freeMagic, freeStyle, magicKeys, styleKeys
    };
  }

  /* ---------------------------- the search ---------------------------- */
  function makeSearch(P, seed) {
    const rng = mulberry32(seed >>> 0 || 1);
    const rnd = n => (rng() * n) | 0;
    const pick = a => a[rnd(a.length)];
    const { pools, A, JV, mods, modKind, modExtraSockets, VIRTUOUS, enchVecs, modVecs, facVecs, scoreOf, allowAtl, ATL_ORDER } = P;

    /* ---- slot evaluation (mirror of engine.calcBuild for one slot) ---- */
    // engine.floorTo(x, 1), inlined: same two guard roundings, same result.
    const EPS = Number.EPSILON;
    const floor1fast = e => {
      const a = Math.round((e * 10 + EPS) * 1e8) / 1e8;
      return Math.round((Math.floor(a) / 10 + EPS) * 10) / 10;
    };
    /** Per item-level lookups of the level-dependent vectors, cached on the record. */
    function levelVecs(rec, li) {
      const c = rec.lv || (rec.lv = []);
      let o = c[li];
      if (!o) { const l = rec.levels[li]; o = c[li] = { e: enchVecs(l), m: modVecs(l), f: facVecs(l) }; }
      return o;
    }
    const Lb = new Float64Array(NS), Mb = new Float64Array(NS), Ob = new Float64Array(NS);
    let lastAtl = -1;   // which stat the last Atlantean slot paid into (-1: none)
    function slotVec(sl, out) {
      out.fill(0); lastAtl = -1;
      const rec = sl.rec;
      if (rec.empty) return out;
      const R = rec.R[sl.li], lv = levelVecs(rec, sl.li);
      Ob.fill(0);
      for (let g = 0; g < sl.gems.length; g++) {
        const j = sl.gems[g];
        if (j < 0) continue;
        const v = JV[j];
        for (let k = 0; k < NS; k++) Ob[k] += v[k];
      }
      const x = sl.ei >= 0 ? lv.e[sl.ei] : null;
      const kind = sl.mi >= 0 ? modKind[sl.mi] : null;
      const I = (sl.fi >= 0 && (kind === null || kind === 'atl')) ? lv.f[sl.fi] : null;
      let v = null, atlK = -1, atlVal = 0;
      if (kind === 'plain' || kind === 'gilded') v = lv.m[sl.mi].v;
      else if (kind === 'imbued') v = rec.imb[sl.li];
      else if (kind === 'atl') {
        const mv = lv.m[sl.mi];
        v = mv.v;
        // first stat (in bonus order) the slot has none of yet
        for (let k = 0; k < NS; k++) Mb[k] = R[k] + Ob[k] + (I ? I[k] : 0) + (x ? x[k] : 0);
        for (const q of ATL_ORDER[sl.mi]) if (Mb[q] === 0) { atlK = q; atlVal = mv.bonus[q]; break; }
        if (atlK < 0) { atlK = mv.fbStat; atlVal = mv.fb; }
        lastAtl = atlK;
      }
      for (let k = 0; k < NS; k++) {
        let s = R[k];
        if (x) s += x[k];
        if (v) s += v[k];
        if (k === atlK) s += atlVal;
        if (I) s += I[k];
        Lb[k] = s;
      }
      for (let k = 0; k < NS; k++) { const l = Lb[k]; out[k] = (l === 0 ? 0 : floor1fast(l)) + Ob[k]; }
      return out;
    }
    const atlOK = () => lastAtl < 0 || !allowAtl || allowAtl.has(lastAtl);

    /* ---- legality ---- */
    const isAcc = s => P.activeSlots[s].group === 'accessory';
    function identityOK(st, s, rec) {
      if (!rec.magic && !rec.style) return true;
      const mg = new Set(), sy = new Set();
      for (let j = 0; j < A; j++) {
        const r = j === s ? rec : st[j]?.rec;
        if (!r) continue;
        if (r.magic && !P.fixedMagic.has(r.magic)) mg.add(r.magic);
        if (r.style && !P.fixedStyle.has(r.style)) sy.add(r.style);
      }
      return mg.size <= P.freeMagic && sy.size <= P.freeStyle;
    }
    function accConflict(a, b) {
      return a.base === b.base || (a.amulet && b.amulet) || (a.helmet && b.helmet);
    }
    function legal(st, s, rec) {
      if (rec.empty) return true;
      if (isAcc(s)) {
        for (let j = 0; j < A; j++) {
          if (j === s || !st[j] || !isAcc(j) || st[j].rec.empty) continue;
          if (accConflict(rec, st[j].rec)) return false;
        }
      }
      return identityOK(st, s, rec);
    }
    function legal2(st, s1, r1, s2, r2) {
      if (!r1.empty && !r2.empty && isAcc(s1) && isAcc(s2) && accConflict(r1, r2)) return false;
      const tmp = st.slice();
      tmp[s1] = { rec: r1 }; tmp[s2] = { rec: r2 };
      return legal(tmp, s1, r1) && legal(tmp, s2, r2);
    }

    /* ---- slot config helpers ---- */
    const enchOK = (ei, mi) => !(VIRTUOUS.has(ei) && mi >= 0 && modKind[mi] === 'atl');
    function repair(sl) {
      const rec = sl.rec;
      if (rec.empty) { sl.li = 0; sl.ei = -1; sl.mi = -1; sl.fi = -1; sl.gems.length = 0; return sl; }
      if (sl.li >= rec.levels.length) sl.li = 0;
      if (!rec.mods.includes(sl.mi)) sl.mi = -1;
      if (!rec.ench.includes(sl.ei)) sl.ei = -1;
      if (!enchOK(sl.ei, sl.mi)) sl.ei = -1;
      const kind = sl.mi >= 0 ? modKind[sl.mi] : null;
      if (sl.fi >= 0 && (!(kind === null || kind === 'atl') || !rec.facs.includes(sl.fi))) sl.fi = -1;
      const n = rec.sockets + (sl.mi >= 0 ? modExtraSockets[sl.mi] : 0);
      while (sl.gems.length < n) sl.gems.push(-1);
      sl.gems.length = n;
      return sl;
    }
    const newSlot = rec => repair({ rec, li: 0, ei: -1, mi: -1, fi: -1, gems: [] });
    const cloneSlot = sl => ({ rec: sl.rec, li: sl.li, ei: sl.ei, mi: sl.mi, fi: sl.fi, gems: sl.gems.slice() });
    const cloneState = st => st.map(cloneSlot);
    const carry = (rec, from) => repair({ rec, li: 0, ei: from.ei, mi: from.mi, fi: from.fi, gems: from.gems.slice() });

    /* ---- objective ----
       Strict mode is lexicographic: caps, then floors, then preference.
       Soft mode (strategic oscillation) prices rule misses as finite penalties,
       so the search may cross a briefly infeasible region to reach a better
       feasible build; every soft polish is followed by a strict one. */
    const mode = { soft: false, K: 0, KH: 0 };
    const softVal = a => a.pref - mode.K * a.sf - mode.KH * a.hv;
    const better = (a, b) => {
      if (mode.soft) return softVal(a) > softVal(b) + 1e-7;
      if (a.hv < b.hv - 1e-9) return true;
      if (a.hv > b.hv + 1e-9) return false;
      if (a.sf < b.sf - 1e-9) return true;
      if (a.sf > b.sf + 1e-9) return false;
      return a.pref > b.pref + 1e-7;
    };
    const INVALID = { hv: Infinity, sf: Infinity, pref: -Infinity, ep: 0 };

    const slotVecs = Array.from({ length: A }, () => new Float64Array(NS));
    const total = new Float64Array(NS), scratch = new Float64Array(NS);
    const sA = new Float64Array(NS), sB = new Float64Array(NS);

    function sumTotal() {
      total.fill(0);
      for (let j = 0; j < A; j++) for (let k = 0; k < NS; k++) total[k] += slotVecs[j][k];
    }
    function recompute(st) {
      for (let j = 0; j < A; j++) {
        slotVec(st[j], slotVecs[j]);
        if (!atlOK()) { st[j].mi = -1; repair(st[j]); slotVec(st[j], slotVecs[j]); }
      }
      sumTotal();
      return scoreOf(total);
    }
    function tryScore(s, cand) {
      slotVec(cand, scratch);
      if (!atlOK()) return INVALID;
      for (let k = 0; k < NS; k++) scratch[k] += total[k] - slotVecs[s][k];
      return scoreOf(scratch);
    }
    function tryScore2(s1, c1, s2, c2) {
      slotVec(c1, sA); if (!atlOK()) return INVALID;
      slotVec(c2, sB); if (!atlOK()) return INVALID;
      for (let k = 0; k < NS; k++) scratch[k] = total[k] - slotVecs[s1][k] - slotVecs[s2][k] + sA[k] + sB[k];
      return scoreOf(scratch);
    }
    function commit(st, s, cand, sc) {
      st[s] = cand;
      slotVec(cand, slotVecs[s]);
      sumTotal();
      return sc;
    }

    /* ---- jewels: fast path ----
       Outside Atlantean slots a jewel only adds its own vector to the slot, so
       swapping one is "total - old + new" with no slot re-evaluation. */
    const jx = new Float64Array(NS), jy = new Float64Array(NS);
    /** Build total with slot s replaced by `cand` minus the jewels at `drop` sockets. */
    function totalWithout(s, cand, drop, out) {
      const saved = drop.map(g => cand.gems[g]);
      drop.forEach(g => { cand.gems[g] = -1; });
      slotVec(cand, out);
      const ok = atlOK();
      drop.forEach((g, i) => { cand.gems[g] = saved[i]; });
      for (let k = 0; k < NS; k++) out[k] += total[k] - slotVecs[s][k];
      return ok;
    }
    /** Best jewel for socket g of cand (others fixed); returns {j, sc}. */
    function bestJewel(s, cand, g) {
      if (cand.mi >= 0 && modKind[cand.mi] === 'atl') {
        let bj = cand.gems[g], bsc = tryScore(s, cand);
        const c2 = cloneSlot(cand);
        for (let j = -1; j < JV.length; j++) {
          if (j === bj) continue;
          c2.gems[g] = j;
          const t = tryScore(s, c2);
          if (better(t, bsc)) { bsc = t; bj = j; }
        }
        return { j: bj, sc: bsc };
      }
      totalWithout(s, cand, [g], jx);
      let bj = -1, bsc = scoreOf(jx);
      for (let j = 0; j < JV.length; j++) {
        const v = JV[j];
        for (let k = 0; k < NS; k++) jy[k] = jx[k] + v[k];
        const t = scoreOf(jy);
        if (better(t, bsc)) { bsc = t; bj = j; }
      }
      return { j: bj, sc: bsc };
    }

    /* ---- moves ---- */
    /** Best enchant, modifier+faction, jewels and level for one slot, others fixed. */
    function refit(s, cand0) {
      let cand = cloneSlot(cand0), sc = tryScore(s, cand);
      const tryC = c2 => { const s2 = tryScore(s, c2); if (better(s2, sc)) { sc = s2; cand = c2; return true; } return false; };
      for (let pass = 0; pass < 2; pass++) {
        let moved = false;
        for (const e of cand.rec.ench) {
          if (e === cand.ei || !enchOK(e, cand.mi)) continue;
          const c2 = cloneSlot(cand); c2.ei = e; moved = tryC(c2) || moved;
        }
        for (const m of cand.rec.mods) {
          const facOpts = (m < 0 || modKind[m] === 'atl') ? [-1, ...cand.rec.facs] : [-1];
          for (const f of facOpts) {
            if (m === cand.mi && f === cand.fi) continue;
            if (!enchOK(cand.ei, m)) continue;
            const c2 = cloneSlot(cand); c2.mi = m; c2.fi = f; repair(c2);
            // a newly opened socket gets the best single jewel straight away
            if (c2.gems.length > cand.gems.length) {
              const g = c2.gems.length - 1;
              c2.gems[g] = bestJewel(s, c2, g).j;
            }
            moved = tryC(c2) || moved;
          }
        }
        for (let g = 0; g < cand.gems.length; g++) {
          const b = bestJewel(s, cand, g);
          if (b.j !== cand.gems[g] && better(b.sc, sc)) {
            cand = cloneSlot(cand); cand.gems[g] = b.j; sc = b.sc; moved = true;
          }
        }
        if (P.exact) {
          for (let li = 0; li < cand.rec.levels.length; li++) {
            if (li === cand.li) continue;
            const c2 = cloneSlot(cand); c2.li = li; moved = tryC(c2) || moved;
          }
        }
        if (!moved) break;
      }
      return { cand, sc };
    }

    /** Jewels as a set: payoffs a single-socket change can't see (Atlantean, caps). */
    function gemCombo(s, cand0) {
      const n = cand0.gems.length;
      if (n < 2) return null;
      const probe = cloneSlot(cand0);
      for (let g = 1; g < n; g++) probe.gems[g] = -1;
      const scored = [];
      for (let j = -1; j < JV.length; j++) { probe.gems[0] = j; scored.push({ j, sc: tryScore(s, probe) }); }
      scored.sort((a, b) => (better(a.sc, b.sc) ? -1 : better(b.sc, a.sc) ? 1 : 0));
      const short = [], seen = new Set();
      const add = j => { if (j != null && !seen.has(j)) { seen.add(j); short.push(j); } };
      for (let i = 0; i < Math.min(GEM_TOP, scored.length); i++) add(scored[i].j);
      cand0.gems.forEach(add);
      // the best single source of each stat, so set effects stay reachable
      for (let k = 0; k < NS; k++) {
        let b = null, bv = 0;
        for (let j = 0; j < JV.length; j++) if (JV[j][k] > bv) { bv = JV[j][k]; b = j; }
        if (P.PW[k] > 0 || P.targets.some(T => T.i === k)) add(b);
      }
      add(-1);
      const pool = short.slice(0, n >= 3 ? GEM_POOL_3 : GEM_POOL_2);
      let best = null, bestSc = null;
      const cand = cloneSlot(cand0);
      const atl = cand.mi >= 0 && modKind[cand.mi] === 'atl';
      // Non-Atlantean: jewels are purely additive, so sum vectors directly.
      const allSockets = cand.gems.map((_, g) => g);
      const baseOK = atl ? true : totalWithout(s, cand, allSockets, jx);
      if (!baseOK) return null;
      const acc = Array.from({ length: n + 1 }, () => new Float64Array(NS));
      if (!atl) acc[0].set(jx);
      (function walk(d, from) {
        if (d === n) {
          const sc = atl ? tryScore(s, cand) : scoreOf(acc[n]);
          if (!bestSc || better(sc, bestSc)) { bestSc = sc; best = cloneSlot(cand); }
          return;
        }
        // sockets are interchangeable: enumerate multisets only
        for (let i = from; i < pool.length; i++) {
          cand.gems[d] = pool[i];
          if (!atl) {
            const a = acc[d], b = acc[d + 1], v = pool[i] >= 0 ? JV[pool[i]] : null;
            for (let k = 0; k < NS; k++) b[k] = a[k] + (v ? v[k] : 0);
          }
          walk(d + 1, i);
        }
      })(0, 0);
      return bestSc ? { cand: best, sc: bestSc } : null;
    }

    function descend(st, cur, deadline) {
      let improved = true, guard = 0;
      while (improved && guard++ < 50) {
        improved = false;
        for (let s = 0; s < A; s++) {
          if (performance.now() > deadline) return cur;
          // armour: rank cheaply with the slot's current fittings, re-fit the best
          const ranked = [];
          for (const rec of pools[s]) {
            if (rec === st[s].rec || !legal(st, s, rec)) continue;
            const cand = carry(rec, st[s]);
            ranked.push({ sc: tryScore(s, cand), cand });
          }
          ranked.sort((a, b) => (better(a.sc, b.sc) ? -1 : better(b.sc, a.sc) ? 1 : 0));
          const nFit = ranked.length <= FULL_FIT_POOL ? ranked.length : Math.min(SHORTLIST, ranked.length);
          let bestSc = cur, bestCand = null;
          for (let r = 0; r < nFit; r++) {
            const fit = refit(s, ranked[r].cand);
            if (better(fit.sc, bestSc)) { bestSc = fit.sc; bestCand = fit.cand; }
          }
          // Carried fittings hide what an item can do with its own (Gilded, Atlantean,
          // its best jewels), so also refit the items that rank best with those.
          const est = makeEstimator(localLambda());
          const byEst = [];
          for (const rec of pools[s]) {
            if (rec === st[s].rec || !legal(st, s, rec)) continue;
            byEst.push(est(rec));
          }
          byEst.sort((a, b) => b.val - a.val);
          for (let r = 0; r < Math.min(SHORTLIST, byEst.length); r++) {
            const fit = refit(s, byEst[r].sl);
            if (better(fit.sc, bestSc)) { bestSc = fit.sc; bestCand = fit.cand; }
          }
          if (bestCand) { cur = commit(st, s, bestCand, bestSc); improved = true; }

          const fit = refit(s, st[s]);
          if (better(fit.sc, cur)) { cur = commit(st, s, fit.cand, fit.sc); improved = true; }
          const combo = gemCombo(s, st[s]);
          if (combo && better(combo.sc, cur)) { cur = commit(st, s, combo.cand, combo.sc); improved = true; }
        }
      }
      return cur;
    }

    /** Two slots at once: trades one slot's stats against another's. */
    function pairPass(st, cur, deadline) {
      // candidate items per slot: the best few on their own, from the current build
      const tops = [];
      for (let s = 0; s < A; s++) {
        const r = [];
        for (const rec of pools[s]) r.push({ rec, sc: tryScore(s, carry(rec, st[s])) });
        r.sort((a, b) => (better(a.sc, b.sc) ? -1 : better(b.sc, a.sc) ? 1 : 0));
        const list = r.slice(0, PAIR_TOP).map(x => x.rec);
        if (!list.includes(st[s].rec)) list.push(st[s].rec);
        tops.push(list);
      }
      // visit slot pairs in a random order so a short budget still covers different pairs
      const pairs = [];
      for (let a = 0; a < A; a++) for (let b = a + 1; b < A; b++) pairs.push([a, b]);
      for (let i = pairs.length - 1; i > 0; i--) { const j = rnd(i + 1); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
      for (const [s1, s2] of pairs) {
        {
          if (performance.now() > deadline) return cur;
          const p1 = tops[s1], p2 = tops[s2];
          const ranked = [];
          for (const r1 of p1) {
            const c1 = carry(r1, st[s1]);
            for (const r2 of p2) {
              if (r1 === st[s1].rec && r2 === st[s2].rec) continue;
              if (!legal2(st, s1, r1, s2, r2)) continue;
              const c2 = carry(r2, st[s2]);
              const sc = tryScore2(s1, c1, s2, c2);
              if (sc.pref > -Infinity) ranked.push({ sc, r1, r2 });
            }
          }
          ranked.sort((a, b) => (better(a.sc, b.sc) ? -1 : better(b.sc, a.sc) ? 1 : 0));
          for (let r = 0; r < Math.min(PAIR_REFIT, ranked.length); r++) {
            if (performance.now() > deadline) return cur;
            const { r1, r2 } = ranked[r];
            const keep1 = st[s1], keep2 = st[s2];
            commit(st, s2, carry(r2, keep2), cur);
            const f1 = refit(s1, carry(r1, keep1));
            commit(st, s1, f1.cand, f1.sc);
            const f2 = refit(s2, st[s2]);
            if (better(f2.sc, cur)) { cur = commit(st, s2, f2.cand, f2.sc); }
            else { commit(st, s1, keep1, cur); commit(st, s2, keep2, cur); }
          }
        }
      }
      return cur;
    }

    /**
     * Fitting exchange: one enchant / modifier / jewel change in each of two
     * slots at once. Under a binding floor, the only improving moves are often
     * "give up some of the stat here, win it back there", which no single
     * change can make without breaking the floor in between.
     */
    function fittingMoves(st, s) {
      const sl = st[s], out = [];
      if (sl.rec.empty) return out;
      const lam = localLambda();
      const add = c => {
        repair(c);
        const v = new Float64Array(NS);
        slotVec(c, v);
        if (atlOK()) out.push({ c, v });
      };
      for (const e of sl.rec.ench) if (e !== sl.ei && enchOK(e, sl.mi)) { const c = cloneSlot(sl); c.ei = e; add(c); }
      for (const m of sl.rec.mods) {
        const fo = (m < 0 || modKind[m] === 'atl') ? [-1, ...sl.rec.facs] : [-1];
        for (const f of fo) {
          if ((m === sl.mi && f === sl.fi) || !enchOK(sl.ei, m)) continue;
          const c = cloneSlot(sl); c.mi = m; c.fi = f; add(c);
        }
      }
      // jewels: the most valuable under local weights, plus one per stat in play
      const order = Array.from(JV.keys()).sort((a, b) => dot(lam, JV[b]) - dot(lam, JV[a]));
      const set = new Set(order.slice(0, 18));
      for (let k = 0; k < NS; k++) {
        if (!(P.targets.some(T => T.i === k))) continue;
        let b = -1, bv = 0;
        for (let j = 0; j < JV.length; j++) if (JV[j][k] > bv) { bv = JV[j][k]; b = j; }
        if (b >= 0) set.add(b);
      }
      set.add(-1);
      const seenG = new Set();
      for (let g = 0; g < sl.gems.length; g++) {
        if (seenG.has(sl.gems[g])) continue;     // sockets holding the same jewel are interchangeable
        seenG.add(sl.gems[g]);
        for (const j of set) if (j !== sl.gems[g]) { const c = cloneSlot(sl); c.gems[g] = j; add(c); }
      }
      return out;
    }
    function fitPairPass(st, cur, deadline) {
      const moves = [];
      for (let s = 0; s < A; s++) moves.push(fittingMoves(st, s));
      for (let s1 = 0; s1 < A; s1++) for (let s2 = s1 + 1; s2 < A; s2++) {
        if (performance.now() > deadline) return cur;
        const m1 = moves[s1], m2 = moves[s2];
        if (!m1.length || !m2.length) continue;
        let best = null, bsc = cur;
        for (const a of m1) {
          for (let k = 0; k < NS; k++) sA[k] = total[k] - slotVecs[s1][k] - slotVecs[s2][k] + a.v[k];
          for (const b of m2) {
            for (let k = 0; k < NS; k++) scratch[k] = sA[k] + b.v[k];
            const sc = scoreOf(scratch);
            if (better(sc, bsc)) { bsc = sc; best = [a, b]; }
          }
        }
        if (best) {
          commit(st, s1, best[0].c, bsc);
          cur = commit(st, s2, best[1].c, bsc);
          return cur;      // the build changed: let descent take over again
        }
      }
      return cur;
    }

    function polish(st, cur, deadline) {
      for (let outer = 0; outer < 8; outer++) {
        const start = cur;
        cur = descend(st, cur, deadline);
        if (performance.now() > deadline) break;
        cur = fitPairPass(st, cur, deadline);
        if (better(cur, start)) continue;
        cur = pairPass(st, cur, deadline);
        if (!better(cur, start)) break;
      }
      return cur;
    }

    /* ---- construction ---- */
    function randomState() {
      const st = new Array(A).fill(null);
      for (let s = 0; s < A; s++) {
        let sl = null;
        for (let t = 0; t < 80 && !sl; t++) {
          const rec = pick(pools[s]);
          if (rec.empty && pools[s].length > 1 && t < 60) continue;
          if (legal(st, s, rec)) sl = newSlot(rec);
        }
        sl = sl || newSlot(P.EMPTY);
        sl.ei = pick(sl.rec.ench); sl.mi = pick(sl.rec.mods);
        if (rng() < 0.4 && sl.rec.facs.length) sl.fi = pick(sl.rec.facs);
        repair(sl);
        for (let g = 0; g < sl.gems.length; g++) sl.gems[g] = rnd(JV.length);
        st[s] = sl;
      }
      return st;
    }

    /**
     * Best build for a linear weighting `lam` of the stats: each slot on its
     * own, then accessories as a legal triple and magics/styles as a legal set.
     */
    const dot = (a, b) => { let t = 0; for (let k = 0; k < NS; k++) t += a[k] * b[k]; return t; };
    /**
     * For weights `lam`, an estimator of each item's value with its own best
     * enchant, modifier, faction and jewels (linear in the stats, so cheap).
     */
    function makeEstimator(lam) {
      // best jewel for these weights
      let jBest = -1, jVal = 0;
      const jScore = new Float64Array(JV.length);
      for (let j = 0; j < JV.length; j++) { const v = jScore[j] = dot(lam, JV[j]); if (v > jVal) { jVal = v; jBest = j; } }
      /* Atlantean pays its bonus into the first stat a slot lacks, so the right
         jewels depend on what the slot already covers. For each "already
         covered" pattern, find the best jewel multiset once and reuse it. */
      const atlMemo = new Map();
      let atlShort = null;
      function atlJewels(mi, lvl, coverMask, n) {
        const key = mi + '|' + lvl + '|' + coverMask + '|' + n;
        let r = atlMemo.get(key);
        if (r) return r;
        if (!atlShort) {
          const idx = Array.from(JV.keys()).sort((a, b) => jScore[b] - jScore[a]);
          const set = new Set(idx.slice(0, 10));
          for (const q of ATL_ORDER[mi]) {
            let b = -1, bv = -Infinity;
            for (const j of idx) if (JV[j][q] > 0 && jScore[j] > bv) { bv = jScore[j]; b = j; }
            if (b >= 0) set.add(b);
            // and the best jewel covering q together with another bonus stat
            let b2 = -1, bv2 = -Infinity;
            for (const j of idx) if (JV[j][q] > 0 && ATL_ORDER[mi].filter(z => JV[j][z] > 0).length >= 2 && jScore[j] > bv2) { bv2 = jScore[j]; b2 = j; }
            if (b2 >= 0) set.add(b2);
          }
          atlShort = [-1, ...set];
        }
        const mv = modVecs(lvl)[mi], order = ATL_ORDER[mi];
        let best = { val: -Infinity, gems: [] };
        const pick = [];
        (function walk(d, from, val, mask) {
          if (d === n) {
            let tgt = -1, bv = 0;
            for (let qi = 0; qi < order.length; qi++) if (!(mask & (1 << qi))) { tgt = order[qi]; bv = mv.bonus[tgt]; break; }
            if (tgt < 0) { tgt = mv.fbStat; bv = mv.fb; }
            if (allowAtl && !allowAtl.has(tgt)) return;
            const total = val + lam[tgt] * bv;
            if (total > best.val) best = { val: total, gems: pick.slice() };
            return;
          }
          for (let i = from; i < atlShort.length; i++) {
            const j = atlShort[i];
            let m2 = mask;
            if (j >= 0) for (let qi = 0; qi < order.length; qi++) if (JV[j][order[qi]] > 0) m2 |= 1 << qi;
            pick.push(j); walk(d + 1, i, val + (j >= 0 ? jScore[j] : 0), m2); pick.pop();
          }
        })(0, 0, 0, coverMask);
        atlMemo.set(key, best);
        return best;
      }
      return function estimate(rec) {
          if (rec.empty) return { val: 0, sl: newSlot(rec) };
          const li = 0, lvl = rec.levels[li];
          const ev = enchVecs(lvl), mv = modVecs(lvl), fv = facVecs(lvl);
          let eBest = -1, eVal = 0, eBestNV = -1, eValNV = 0;
          for (const e of rec.ench) {
            if (e < 0) continue;
            const v = dot(lam, ev[e]);
            if (v > eVal) { eVal = v; eBest = e; }
            if (!VIRTUOUS.has(e) && v > eValNV) { eValNV = v; eBestNV = e; }
          }
          let fBest = -1, fVal = 0;
          for (const f of rec.facs) { const v = dot(lam, fv[f]); if (v > fVal) { fVal = v; fBest = f; } }
          const base = dot(lam, rec.R[li]);
          const n = rec.sockets;
          let best = { val: base + eVal + fVal + n * jVal, ei: eBest, mi: -1, fi: fBest, extra: 0 };
          for (const m of rec.mods) {
            if (m < 0) continue;
            const k = modKind[m];
            let val, ei = eBest, fi = -1;
            if (k === 'plain') val = base + eVal + dot(lam, mv[m].v) + n * jVal;
            else if (k === 'gilded') val = base + eVal + (n + modExtraSockets[m]) * jVal;
            else if (k === 'imbued') val = base + eVal + dot(lam, rec.imb[li]) + n * jVal;
            else if (k === 'atl') {
              ei = eBestNV; fi = fBest;
              const order = ATL_ORDER[m], R = rec.R[li];
              let mask = 0;
              for (let qi = 0; qi < order.length; qi++) {
                const q = order[qi];
                if (R[q] + (ei >= 0 ? ev[ei][q] : 0) + (fi >= 0 ? fv[fi][q] : 0) !== 0) mask |= 1 << qi;
              }
              const aj = atlJewels(m, lvl, mask, n);
              if (aj.val === -Infinity) continue;
              val = base + eValNV + fVal + dot(lam, mv[m].v) + aj.val;
              if (val > best.val) best = { val, ei, mi: m, fi, gems: aj.gems };
              continue;
            }
            if (val > best.val) best = { val, ei, mi: m, fi, extra: 0 };
          }
          const sl = repair({ rec, li, ei: best.ei, mi: best.mi, fi: best.fi, gems: [] });
          for (let g = 0; g < sl.gems.length; g++) sl.gems[g] = best.gems ? (best.gems[g] ?? -1) : jBest;
          return { val: best.val, sl };
      };
    }
    function weightedBuild(lam) {
      const est = makeEstimator(lam);
      const perSlot = [];
      for (let s = 0; s < A; s++) {
        const list = pools[s].map(est);
        list.sort((a, b) => b.val - a.val);
        perSlot.push(list);
      }
      return assemble(perSlot);
    }
    /** Local linear weights at the current build: EP x priority, plus pressure from rules in play. */
    const lamBuf = new Float64Array(NS);
    function localLambda() {
      const v = P.capTotals(total, new Float64Array(NS));
      const big = 6 * (Math.max(...Array.from(P.PW).map(Math.abs)) || 1);
      for (let k = 0; k < NS; k++) lamBuf[k] = P.PW[k];
      for (const T of P.targets) {
        const k = T.i, sc = Math.max(1, Math.abs(T.min ?? T.max ?? 1));
        if (T.min !== null && v[k] < T.min + tolFor(k, T.min)) lamBuf[k] += big * 100 / sc;
        if (T.max !== null && v[k] > T.max - tolFor(k, T.max)) lamBuf[k] -= big * 100 / sc;
      }
      return lamBuf;
    }

    /** Pick one entry per slot from ranked lists, respecting every cross-slot rule. */
    function assemble(perSlot) {
      // identity candidates: magics / styles among the strong options
      // Rank each free magic / style by the best value it unlocks in any slot,
      // and only consider the strongest few as the build's identity.
      const mScore = new Map(), sScore = new Map();
      for (const list of perSlot) for (const e of list.slice(0, 30)) {
        const r = e.sl.rec;
        if (r.magic && !P.fixedMagic.has(r.magic)) mScore.set(r.magic, Math.max(mScore.get(r.magic) ?? -Infinity, e.val));
        if (r.style && !P.fixedStyle.has(r.style)) sScore.set(r.style, Math.max(sScore.get(r.style) ?? -Infinity, e.val));
      }
      const topOf = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
      const mags = new Set(P.freeMagic ? topOf(mScore, P.freeMagic >= 2 ? 7 : 6) : []);
      const stys = new Set(P.freeStyle ? topOf(sScore, P.freeStyle >= 2 ? 6 : 5) : []);
      const choose = (set, k) => {
        const arr = [...set], out = [[]];
        if (k >= 1) arr.forEach(a => out.push([a]));
        if (k >= 2) for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
        return out;
      };
      const magOpts = choose(mags, P.freeMagic), styOpts = choose(stys, P.freeStyle);
      let bestSt = null, bestVal = -Infinity;
      for (const mo of magOpts) for (const so of styOpts) {
        const allowM = new Set([...P.fixedMagic, ...mo]), allowS = new Set([...P.fixedStyle, ...so]);
        const ok = rec => (!rec.magic || allowM.has(rec.magic)) && (!rec.style || allowS.has(rec.style));
        const st = new Array(A).fill(null);
        let val = 0;
        // non-accessory slots
        for (let s = 0; s < A; s++) {
          if (isAcc(s)) continue;
          const e = perSlot[s].find(x => ok(x.sl.rec));
          st[s] = cloneSlot(e.sl); val += e.val;
        }
        // accessories: best legal combination from the top of the list
        const accS = []; for (let s = 0; s < A; s++) if (isAcc(s)) accS.push(s);
        const cands = perSlot[accS[0]].filter(x => ok(x.sl.rec)).slice(0, 26);
        let bestTrip = null, bestTV = -Infinity;
        const empties = cands.filter(c => c.sl.rec.empty);
        const pick3 = (i0, chosen, v) => {
          if (chosen.length === accS.length) { if (v > bestTV) { bestTV = v; bestTrip = chosen.slice(); } return; }
          for (let i = i0; i < cands.length; i++) {
            const c = cands[i];
            // list is sorted: nothing further down can beat the best triple
            if (v + c.val * (accS.length - chosen.length) <= bestTV) break;
            if (!c.sl.rec.empty && chosen.some(o => !o.sl.rec.empty && accConflict(o.sl.rec, c.sl.rec))) continue;
            chosen.push(c); pick3(c.sl.rec.empty ? i : i + 1, chosen, v + c.val); chosen.pop();
          }
        };
        if (cands.length) pick3(0, [], 0);
        if (!bestTrip) bestTrip = accS.map(() => empties[0] || { val: 0, sl: newSlot(P.EMPTY) });
        accS.forEach((s, i) => { st[s] = cloneSlot(bestTrip[i].sl); });
        val += bestTV > -Infinity ? bestTV : 0;
        if (val > bestVal) { bestVal = val; bestSt = st; }
      }
      return bestSt;
    }

    /** Lagrangian walk: weights move toward the rules; every visited build is a start. */
    function guidedStarts(noise) {
      const starts = [];
      const mu = new Float64Array(NS), nu = new Float64Array(NS);
      // stat scale: how much of each stat a full build can typically hold
      const scale = new Float64Array(NS);
      for (let k = 0; k < NS; k++) {
        let m = 0;
        for (let s = 0; s < A; s++) { let b = 0; for (const rec of pools[s]) if (!rec.empty) b = Math.max(b, rec.R[0][k]); m += b; }
        let jb = 0; for (const v of JV) jb = Math.max(jb, v[k]);
        scale[k] = Math.max(1, m + jb * 6);
      }
      const base = new Float64Array(NS);
      for (let k = 0; k < NS; k++) base[k] = P.PW[k] * (1 + noise * (rng() * 2 - 1));
      const lam = new Float64Array(NS);
      const typical = Math.max(...Array.from(P.W).map(Math.abs)) || 1;
      const st = new Array(A);
      for (let it = 0; it < GUIDED_ITERS; it++) {
        for (let k = 0; k < NS; k++) lam[k] = base[k] + mu[k] - nu[k];
        const b = weightedBuild(lam);
        for (let s = 0; s < A; s++) st[s] = b[s];
        const sc = recompute(st);
        starts.push({ st: cloneState(st), sc });
        if (sc.hv === 0 && sc.sf === 0 && it > 4) {
          // rules met: relax multipliers slowly so EP can be recovered
          for (let k = 0; k < NS; k++) { mu[k] *= 0.85; nu[k] *= 0.85; }
        }
        const step = (4 * typical) / Math.sqrt(it + 1);
        const v = P.capTotals(total, new Float64Array(NS));
        for (const T of P.targets) {
          const k = T.i;
          if (T.min !== null) mu[k] = Math.max(0, mu[k] + step * (T.min - v[k]) / scale[k] * (T.min - v[k] > 0 ? 1 : 0.35));
          if (T.max !== null) nu[k] = Math.max(0, nu[k] + step * (v[k] - T.max) / scale[k] * (v[k] - T.max > 0 ? 1 : 0.35));
        }
      }
      starts.sort((a, b) => (better(a.sc, b.sc) ? -1 : better(b.sc, a.sc) ? 1 : 0));
      // keep the best distinct ones
      const out = [], keys = new Set();
      for (const s of starts) {
        const key = s.st.map(x => x.rec.idx).join(',');
        if (keys.has(key)) continue;
        keys.add(key); out.push(s);
        if (out.length >= GUIDED_KEEP) break;
      }
      return out;
    }

    function kick(st, stale) {
      const kicks = 1 + rnd(2) + Math.min(3, stale >> 2);
      for (let k = 0; k < kicks; k++) {
        const s = rnd(A);
        let sl = null;
        for (let t = 0; t < 60 && !sl; t++) { const rec = pick(pools[s]); if (legal(st, s, rec)) sl = newSlot(rec); }
        if (!sl) continue;
        sl.ei = pick(sl.rec.ench); sl.mi = pick(sl.rec.mods);
        if (rng() < 0.4 && sl.rec.facs.length) sl.fi = pick(sl.rec.facs);
        repair(sl);
        for (let g = 0; g < sl.gems.length; g++) sl.gems[g] = rnd(JV.length);
        st[s] = sl;
      }
    }

    function run(budgetMs, onProgress) {
      const t0 = performance.now(), deadline = t0 + budgetMs;
      let best = null, bestSc = null;
      const consider = (st, sc) => { if (!bestSc || better(sc, bestSc)) { bestSc = sc; best = cloneState(st); return true; } return false; };

      // 1. guided starts, polished
      const starts = guidedStarts(seed === 1 ? 0 : 0.25);
      for (const s of starts) {
        if (performance.now() > deadline && best) break;
        const st = cloneState(s.st);
        let cur = recompute(st);
        cur = polish(st, cur, deadline);
        consider(st, cur);
      }
      // 2. a couple of random starts for diversity
      for (let r = 0; r < 2 && performance.now() < deadline; r++) {
        const st = randomState();
        let cur = recompute(st);
        cur = polish(st, cur, deadline);
        consider(st, cur);
      }
      // 3. iterated local search with strategic oscillation
      let stale = 0, rounds = starts.length + 2;
      const scaleEP = Math.max(100, Math.abs(bestSc.pref));
      while (performance.now() < deadline) {
        rounds++;
        let st;
        const oscillate = rng() < 0.45;
        if (stale >= 40) {
          st = rng() < 0.5 ? randomState() : cloneState(guidedStarts(0.6)[0].st);
          stale = 0;
        } else {
          st = cloneState(best);
          if (!oscillate || rng() < 0.5) kick(st, stale);
        }
        let cur = recompute(st);
        if (oscillate) {
          // Penalty continuation: start loose (a 1% floor miss costs ~0.2-1% of
          // the build's value) and tighten, so the walk drifts back to feasible.
          mode.soft = true;
          let K = scaleEP * (0.2 + rng() * 0.8);
          for (let step = 0; step < 4 && performance.now() < deadline; step++, K *= 3.5) {
            mode.K = K; mode.KH = K * 4;
            cur = descend(st, recompute(st), deadline);
          }
          mode.soft = false;
          cur = recompute(st);
        }
        cur = polish(st, cur, deadline);
        if (consider(st, cur)) stale = 0; else stale++;
        if (onProgress) onProgress((performance.now() - t0) / budgetMs);
      }
      if (!best) return null;
      const st = best;
      recompute(st);
      return { state: st, score: bestSc, rounds };
    }

    return { run, slotVec, recompute, better, randomState, weightedBuild };
  }

  /* ---------------------------- output ---------------------------- */
  /** Turn a search state into builder slots, allocator and code. */
  function materialize(P, st) {
    const { data, level, cfg } = P;
    const slots = {};
    for (const d of E.SLOTS) slots[d.id] = { item: null, gems: [] };
    P.activeSlots.forEach((d, s) => {
      const sl = st[s];
      if (sl.rec.empty) return;
      slots[d.id] = {
        item: sl.rec.item, level: sl.rec.levels[sl.li],
        enchant: sl.ei >= 0 ? P.enchants[sl.ei] : null,
        modifier: sl.mi >= 0 ? P.mods[sl.mi] : null,
        factionModifier: sl.fi >= 0 ? P.facs[sl.fi] : null,
        gems: sl.gems.map(j => j >= 0 ? JSON.parse(JSON.stringify(P.JW[j].j)) : E.emptyJewel())
      };
    });
    // Identity: the magics / styles the gear needs go into the build, so the
    // builder keeps every magic- or style-specific piece as it is.
    const alloc = { ...E.ALLOC_KEYS.reduce((o, k) => (o[k] = Number(cfg.allocator?.[k] || 0), o), {}),
      primaryMagic: '', secondaryMagic: '', primaryFightingStyle: '', secondaryFightingStyle: '', dragonbloodTier: 0, bloodDiseaseCount: 0 };
    const usedM = [], usedS = [];
    for (const d of E.SLOTS) {
      const it = slots[d.id].item;
      if (it?.magicId && !usedM.includes(it.magicId)) usedM.push(it.magicId);
      if (it?.fightingStyleId && !usedS.includes(it.fightingStyleId)) usedS.push(it.fightingStyleId);
    }
    const ident = cfg.identity || {};
    const fill = (keys, used) => {
      const free = used.filter(m => !keys.some(k => ident[k] === m));
      for (const k of keys) {
        const v = ident[k] ?? 'any';
        if (v === 'any') alloc[k] = free.shift() || '';
        else alloc[k] = v || '';
      }
    };
    fill(P.magicKeys, usedM);
    fill(P.styleKeys, usedS);
    const result = E.calcBuild({ data, level, allocator: alloc, slots });
    const code = E.encodeBuild({ data, level, allocator: alloc, slots });
    const warnings = E.buildWarnings(data, level, alloc, slots);
    return { slots, allocator: alloc, result, code, link: E.builderLink(code), warnings };
  }

  /** One complete solve. */
  function solve(data, cfg, { timeMs = 2500, seed = 1, onProgress = null } = {}) {
    const P = prepare(data, cfg);
    if (P.pools.every(p => p.length <= 1)) return { error: 'No wearable gear for these settings.' };
    const search = makeSearch(P, seed);
    const out = search.run(timeMs, onProgress);
    if (!out) return { error: 'No legal gear set found.' };
    const m = materialize(P, out.state);
    // Score the exact totals the builder will show.
    const exactVec = toVec(m.result.totals);
    const sc = P.scoreOf(exactVec);
    const targetsReport = P.targets.map(T => {
      const got = m.result.totals[T.stat] || 0;
      return { stat: T.stat, min: T.min, max: T.max, pinned: T.pinned, got, minOK: minOK(T, got, P.exact), capOK: capOK(T, got), ok: meets(T, got, P.exact) };
    });
    return {
      code: m.code, link: m.link, allocator: m.allocator, warnings: m.warnings,
      totals: m.result.totals, ep: m.result.ep,
      slots: E.SLOTS.map(d => {
        const s = m.slots[d.id], ps = m.result.perSlot[d.id];
        if (!s.item) return { slot: d.id, label: d.label, empty: true };
        return {
          slot: d.id, label: d.label, item: s.item.name, rarity: s.item.rarity || '', level: ps.level,
          magic: s.item.magicId || null, style: s.item.fightingStyleId || null,
          enchant: s.enchant?.name || null, modifier: s.modifier?.name || null,
          faction: ps.appliedFaction?.name || null, atlantean: ps.atlanteanStat,
          gems: s.gems.map(g => (g.primary?.gem || g.fusion?.primary?.gem) ? E.jewelName(g) + (g.primary.tier !== 5 ? ` (${data.gems.tiers[g.primary.tier]})` : '') : null),
          stats: ps.stats, ep: ps.ep
        };
      }),
      score: sc, targets: targetsReport, met: sc.hv === 0 && sc.sf === 0, rounds: out.rounds
    };
  }

  /** Compare two solve() results the same way the search does. */
  function betterResult(a, b) {
    if (!b) return true;
    if (!a) return false;
    const x = a.score, y = b.score;
    if (x.hv !== y.hv) return x.hv < y.hv - 1e-9;
    if (Math.abs(x.sf - y.sf) > 1e-9) return x.sf < y.sf;
    return x.pref > y.pref + 1e-7;
  }

  const api = { solve, prepare, makeSearch, materialize, betterResult, STATS: S, tolFor, meets, minOK, capOK };
  root.AOSolver = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
