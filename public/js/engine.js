/* =====================================================================
   AO gear engine
   A line-for-line port of the stat maths and build-code format used by
   the AO Gear Builder (https://ao-gear.pages.dev). Every function here
   mirrors one in that site's bundle; the comment above each names what
   it reproduces, so the two can be compared after a site update.

   Works in the page, in a Web Worker, and in Node (for tests).
   ===================================================================== */
(function (root) {
  'use strict';

  const BUILDER_URL = 'https://ao-gear.pages.dev/';
  const BUILD_FORMAT = 6;
  const LEVEL_STEP = 10;

  /* Slot order is the order the builder writes slots into a build code. */
  const ACC_TYPES = ['Helmet', 'Hat', 'Face', 'Head', 'Neck', 'Shoulder', 'Collar',
    'Collar Accessory', 'Arm', 'Back', 'Front', 'Waist'];
  const SLOTS = [
    { id: 'acc1', label: 'Accessory 1', group: 'accessory', types: ACC_TYPES },
    { id: 'acc2', label: 'Accessory 2', group: 'accessory', types: ACC_TYPES },
    { id: 'acc3', label: 'Accessory 3', group: 'accessory', types: ACC_TYPES },
    { id: 'chest', label: 'Chest', group: 'armor', types: ['Chestpiece'] },
    { id: 'legs', label: 'Legs', group: 'armor', types: ['Legging', 'Leggings', 'Boots'] },
    { id: 'shield', label: 'Shield', group: 'weapon', types: ['Shield'] }
  ];

  /* Stats in the order the builder lists them. */
  const STAT_NAMES = ['Power', 'Defense', 'Range', 'Haste', 'Size', 'Dexterity', 'Resistance',
    'Regeneration', 'Pierce', 'Beast Defense', 'Limb Protection', 'Insanity', 'Drawback', 'Warding'];
  const ALLOC_KEYS = ['Magic', 'Strength', 'Weapons', 'Spirit'];
  const RARITY_RANK = { Limited: 6, Mystic: 5, Legendary: 4, Exotic: 3, Rare: 2, Uncommon: 1, Common: 0, '': -1 };

  /* ------------------------------ rounding ------------------------------ */
  // ve: round half-up to t decimals
  function roundTo(e, t) { const n = 10 ** t; return Math.round((e + Number.EPSILON) * n) / n; }
  // lt: floor to t decimals, guarded against float noise
  function floorTo(e, t = 1) { const n = 10 ** t; return roundTo(Math.floor(roundTo(Number(e) * n, 8)) / n, t); }
  // Le
  const floor1 = e => floorTo(e, 1);
  // pt: signed round
  function signedRound(e, t) { const n = 10 ** t; return (Math.sign(e) * Math.round(Math.abs(e) * n)) / n; }
  const clamp = (e, lo, hi) => Math.max(lo, Math.min(hi, e));
  // Ze: floor every value in place
  function floorAll(o) { for (const k of Object.keys(o || {})) o[k] = floor1(o[k]); return o; }
  // st / Et: add b into a
  function addInto(a, b) { for (const [k, v] of Object.entries(b || {})) a[k] = (a[k] || 0) + v; return a; }
  function sumStats(...list) { const t = {}; for (const s of list) addInto(t, s); return t; }

  /* ------------------------------ data ------------------------------ */
  function maxLevelOf(data) {
    const t = data?.constants?.maxLevel ?? data?.meta?.maxLevel;
    if (!Number.isInteger(t) || t < 1) throw Error('Missing or invalid maximum level');
    return t;
  }
  function magicsOf(data) {
    return (data.magics || []).map(n => ({
      id: n.id || slug(String(n.name || '').replace(/\s+Magic$/i, '')),
      name: n.name || n.id, shareId: n.shareId || 0
    })).filter(n => n.id && n.name);
  }
  function stylesOf(data) {
    return (data.fightingStyles || []).map(n => ({
      id: n.id || slug(n.name), name: n.name || n.id, shareId: n.shareId || 0
    })).filter(n => n.id && n.name);
  }
  function slug(e) {
    return String(e || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function allGems(data) {
    return [
      ...(data.gems?.rare || []).map(t => ({ ...t, rarity: t.rarity || 'Rare' })),
      ...(data.gems?.mystic || []).map(t => ({ ...t, rarity: t.rarity || 'Mystic' }))
    ];
  }
  // fn: everything addressable by shareId
  function shareIndex(data) {
    const t = [
      ...(data.items || []), ...(data.enchantments || []), ...(data.shieldEnchantments || []),
      ...(data.modifiers || []), ...(data.factionModifiers || []),
      ...(data.gems?.rare || []), ...(data.gems?.mystic || []), ...(data.reagents || []),
      ...magicsOf(data), ...stylesOf(data)
    ];
    return new Map(t.filter(n => n?.shareId).map(n => [Number(n.shareId), n]));
  }
  const shareOf = e => Number(e?.shareId || 0);

  /* ------------------------------ levels ------------------------------ */
  const snapDown = e => Math.floor((Number(e) || 0) / LEVEL_STEP) * LEVEL_STEP;      // Sn
  const levelCap = e => Math.max(1, Math.floor(e / LEVEL_STEP) * LEVEL_STEP);         // Ct
  const itemMaxLevel = (item, level) => Math.min(Number(item?.maxLevel || levelCap(level)), levelCap(level)); // Pt
  // ye: the level an item is actually worn at
  function itemLevel(requested, item, level) {
    const r = Number(item?.minLevel || 1), i = itemMaxLevel(item, level);
    const o = Number(requested) || r;
    const a = o <= r ? o : Math.round(o / LEVEL_STEP) * LEVEL_STEP;
    return clamp(a, r, i);
  }
  // Oe
  function slotLevel(slot, level) {
    const n = Number(slot.level);
    return itemLevel(Number.isFinite(n) && n > 0 ? n : level, slot.item, level);
  }
  /** Every level an item can be worn at for a character of `level`, highest first. */
  function itemLevels(item, level) {
    const lo = Number(item.minLevel || 1), hi = itemMaxLevel(item, level);
    if (hi < lo) return [];
    const out = [hi];
    for (let v = Math.ceil((lo + 1) / LEVEL_STEP) * LEVEL_STEP; v < hi; v += LEVEL_STEP) out.push(v);
    if (lo < hi && !out.includes(lo)) out.push(lo);
    return [...new Set(out.map(v => itemLevel(v, item, level)))].sort((a, b) => b - a);
  }

  /* ------------------------------ item stats ------------------------------ */
  function statScale(stat, scaling) {                                               // Pr
    if (scaling?.itemStatScales?.[stat] != null) return Number(scaling.itemStatScales[stat]);
    return stat === 'Defense' ? 2.7 : stat === 'Power' ? 0.315 : 0.5;
  }
  function scaledStats(stats, lvl, scaling, raw) {                                  // En
    const i = {}, o = snapDown(lvl);
    for (const [a, l] of Object.entries(stats || {})) {
      const s = Number(l) * o * statScale(a, scaling);
      i[a] = raw ? s : floorTo(s, 1);
    }
    return i;
  }
  function byLevel(table, lvl) {                                                    // $n
    const n = Object.entries(table || {}).map(([s, u]) => [Number(s), Number(u)])
      .filter(([s, u]) => Number.isFinite(s) && Number.isFinite(u)).sort((s, u) => s[0] - u[0]);
    if (!n.length) return null;
    const r = Number(lvl) || n[0][0];
    for (const [s, u] of n) if (s === r) return u;
    if (n.length === 1 || r <= n[0][0]) return floor1(n[0][1] * (r / n[0][0]));
    const last = n[n.length - 1];
    if (r >= last[0]) return floor1(last[1] * (r / last[0]));
    let o = n[0], a = n[n.length - 1];
    for (const [s, u] of n) { if (s < r) o = [s, u]; if (s > r) { a = [s, u]; break; } }
    const l = (r - o[0]) / (a[0] - o[0]);
    return floor1(o[1] + (a[1] - o[1]) * l);
  }
  function itemStats(item, lvl, data, raw = false) {                                // rt / Mt
    const i = scaledStats(item?.stats, lvl, data.scaling, raw);
    addInto(i, item?.flatStats);
    for (const [o, a] of Object.entries(item?.statByLevel || {})) {
      if (i[o] != null) continue;
      const l = byLevel(a, lvl);
      if (l !== null) i[o] = l;
    }
    return raw ? i : floorAll(i);
  }
  function enchantStats(ench, lvl, raw = false) {                                   // it / kn
    if (!ench) return {};
    const r = {}, o = snapDown(lvl);
    for (const [a, l] of Object.entries(ench.stats || {})) {
      const s = Number(l) * o;
      r[a] = raw ? s : floorTo(s, 1);
    }
    if (ench.special?.warding) r.Warding = (r.Warding || 0) + Number(ench.special.warding);
    return raw ? r : floorAll(r);
  }
  // Qe: Virtuous strips Atlantean
  const enchantCancelsMod = (ench, mod) => Boolean(ench?.special?.removesAtlantean && mod?.name === 'Atlantean');

  /* ------------------------------ modifiers ------------------------------ */
  const flatVal = v => (typeof v === 'string' && v.startsWith('flat:')) ? Number(v.slice(5)) : null;

  function modMaxStats(mod, item, current) {                                        // ei
    const r = {};
    const sp = mod.special || {};
    for (const [i, o] of Object.entries(mod.maxStats || mod.stats || {})) {
      if (sp.bonusStat === 'first_missing' && i !== 'Insanity') continue;
      r[i] = flatVal(o) ?? Number(o);
    }
    if (sp.bonusStat === 'first_missing') {
      const i = current ?? sumStats(item?.stats, item?.flatStats);
      const order = sp.bonusStatOrder || [];
      let found = false;
      for (const l of order) {
        if (Number(i[l] ?? 0) === 0) {
          const s = Number(sp.maxBonusMultipliers?.[l] ?? sp.bonusMultipliers?.[l] ?? 0);
          if (s) r[l] = s;
          found = true; break;
        }
      }
      if (!found && order.length > 0) {
        const l = sp.fallbackStat || order[0];
        const s = Number(sp.maxBonusMultipliers?.[l] ?? sp.bonusMultipliers?.[l] ?? 0);
        if (s) r[l] = (r[l] || 0) + s;
      }
    }
    if (sp.warding) r.Warding = (r.Warding || 0) + Number(sp.warding);
    return r;
  }

  const IMBUED_ORDER = ['Power', 'Defense', 'Size', 'Haste', 'Dexterity', 'Range', 'Resistance',
    'Pierce', 'Regeneration', 'Drawback', 'Warding', 'Insanity'];
  function imbuedStatsList(item, lvl, data) {                                       // er
    const r = itemStats(item, lvl, data, true);
    const order = data?.calculationRules?.imbued?.statOrder ?? IMBUED_ORDER;
    return order.filter(o => Number(r[o]) > 0);
  }
  function imbuedValue(stat, lvl, count, data) {                                    // ni
    const i = Math.max(Number(count) || 1, 1), o = Math.max(Number(lvl) || 1, 1);
    const mb = data?.constants?.modifierBase || {};
    const l = (Number(mb.standardFactor ?? 0.15) * o) / i;
    const s = data?.calculationRules?.imbued || {};
    const u = Math.min(i, s.countCap ?? 6) * (s.countSlope ?? 0.2) + (s.countIntercept ?? 0.8);
    const p = data?.constants?.globalScaling || {};
    let h;
    if (stat === 'Defense') h = Number(p.Defense ?? 2.7) * Number(mb.imbuedDefenseMultiplier ?? 1.1275);
    else if (stat === 'Power') h = Number(p.Power ?? 0.315);
    else h = Number(p[stat] ?? 0.5) * Number(mb.secondaryMultiplier ?? 2);
    return floor1(l * u * h);
  }
  function imbuedStats(item, lvl, data) {                                           // ti
    if (!item) return {};
    const r = imbuedStatsList(item, lvl, data);
    if (!r.length) return {};
    const o = {};
    for (const a of r) { const l = imbuedValue(a, lvl, r.length, data); if (l) o[a] = l; }
    return o;
  }

  function modStats(mod, item, lvl, data, current = null) {                         // Pe
    if (!mod) return {};
    if (mod.name === 'Imbued' || mod.special?.scalesWithBaseStats) return imbuedStats(item, lvl, data);
    current = current ?? itemStats(item, lvl, data, true);
    const a = Math.floor(maxLevelOf(data) / LEVEL_STEP) * LEVEL_STEP;
    const l = Number(mod.capLevel ?? a);
    const s = clamp(Number(lvl) || 1, 1, l);
    if (s >= l && mod.maxStats) return modMaxStats(mod, item, current);
    const sp = mod.special || {};
    const u = {}, p = s / LEVEL_STEP;
    for (const [h, k] of Object.entries(mod.stats || {})) {
      const fv = flatVal(k);
      if (sp.bonusStat === 'first_missing' && fv === null) continue;
      u[h] = fv ?? floor1(Number(k) * p);
    }
    if (sp.bonusStat === 'first_missing') {
      const order = sp.bonusStatOrder || [];
      let found = false;
      for (const N of order) {
        if (Number(current[N] ?? 0) === 0) {
          const D = Number(sp.bonusMultipliers?.[N] ?? 0);
          if (D) u[N] = (u[N] || 0) + floor1(D * p);
          found = true; break;
        }
      }
      if (!found && order.length > 0) {
        const N = sp.fallbackStat || order[0];
        const D = Number(sp.bonusMultipliers?.[N] ?? 0);
        if (D) u[N] = (u[N] || 0) + floor1(D * p);
      }
    }
    if (sp.warding) u.Warding = (u.Warding || 0) + Number(sp.warding);
    return u;
  }
  /** Which stat Atlantean's "first missing" bonus would land on, given the slot's other stats. */
  function atlanteanTarget(mod, current) {
    const sp = mod?.special;
    if (!sp || sp.bonusStat !== 'first_missing') return null;
    for (const N of sp.bonusStatOrder || []) if (Number(current[N] ?? 0) === 0) return N;
    return sp.fallbackStat || (sp.bonusStatOrder || [])[0] || null;
  }

  /* ------------------------------ jewels ------------------------------ */
  function emptyJewel() {                                                           // tt
    return { primary: { gem: null, tier: 5, reagent: null }, secondReagent: null, fusion: null };
  }
  function jewelPart(e) { return { gem: e?.gem || null, tier: Number(e?.tier ?? 5), reagent: e?.reagent || null }; }
  function normJewel(e) {                                                           // Z
    if (!e) return emptyJewel();
    if (e.primary || e.fusion || e.secondReagent) {
      return {
        primary: jewelPart(e.primary), secondReagent: e.secondReagent || null,
        fusion: e.fusion ? { primary: jewelPart(e.fusion.primary || e.fusion), secondReagent: e.fusion.secondReagent || null } : null
      };
    }
    return { primary: jewelPart(e), secondReagent: null, fusion: null };
  }
  function rareBase(stat, data) {                                                   // Vr
    const n = data.gems?.rareBaseValues || {};
    if (stat === 'Defense') return n.defense ?? 4.5;
    if (stat === 'Power') return n.power ?? 0.45;
    return n.substat ?? 1.5;
  }
  function mysticBase(e, data) {                                                    // Gr
    if (typeof e === 'number') return e;
    return Number(data.gems?.mysticBaseValues?.[e] ?? e ?? 0);
  }
  function jewelValue(base, level, tierPlusOne, data) {                             // Kr
    const j = data?.constants?.jewel || {};
    const o = Number(j.levelDivisor ?? 20), a = Number(j.tierDivisor ?? 6);
    const l = data?.calculationRules?.jewel || {};
    return clamp(floorTo(Number(base ?? 0) * (level / o) * (tierPlusOne / a), 1), l.minimum ?? 1, l.maximum ?? 5000);
  }
  function fusionPartValue(e, stat, data) {                                         // Yr
    const r = data?.calculationRules?.jewel || {}, J = data?.constants?.jewel || {};
    const i = Number(e || 0), o = Number(J.fusionDrawbackMultiplier ?? 0.5);
    if (stat === 'Drawback') return signedRound(i * o, 1);
    if ((r.fusionUnscaledStats ?? ['Warding', 'Insanity']).includes(stat)) return i;
    const a = Number(J.fusionPrimaryMultiplier ?? 0.6);
    let l = i * a;
    const s = J.fusionBonus || { Power: 0.9, Defense: 9, Substat: 3 };
    const u = stat === 'Power' ? Number(s.Power ?? 0.9) : stat === 'Defense' ? Number(s.Defense ?? 9) : Number(s.Substat ?? 3);
    if (i + u > l * (r.fusionComparisonMultiplier ?? 2)) l = (i + u) * (r.fusionAlternativeMultiplier ?? 0.5);
    return Math.min(Math.max(l, 0), r.maximum ?? 5000);
  }
  function partContribution(e, stat, mode, data) {                                  // rn
    if (mode === 'fusion') return fusionPartValue(e, stat, data);
    return roundTo(Number(e || 0) * Number(mode ?? 1), 3);
  }
  function fusionFinal(stat, t, data) {                                             // Zr
    const r = data?.calculationRules?.jewel || {};
    const i = floorTo(t, 1);
    if ((r.fusionMinimumExemptStats ?? ['Drawback']).includes(stat)) return i;
    return Math.max(r.minimum ?? 1, i);
  }
  function gemPartStats(part, level, data, mode = 1) {                              // kt
    const i = {}, o = part?.gem;
    if (!o) return i;
    const a = Number(part.tier ?? 5) + 1;
    const J = data?.constants?.jewel || {};
    const s = Number(J.levelDivisor ?? 20), u = Number(J.tierDivisor ?? 6);
    const p = h => mode === 'fusion' ? Number(h || 0) * (level / s) * (a / u) : jewelValue(h, level, a, data);
    if (o.stat) i[o.stat] = partContribution(p(rareBase(o.stat, data)), o.stat, mode, data);
    for (const [h, k] of Object.entries(o.stats || {})) i[h] = (i[h] || 0) + partContribution(p(mysticBase(k, data)), h, mode, data);
    if (o.special?.drawback) i.Drawback = (i.Drawback || 0) + partContribution(Number(o.special.drawback), 'Drawback', mode, data);
    return i;
  }
  function jewelStats(jewel, level, data) {                                         // an
    const r = normJewel(jewel);
    if (!r.primary.gem && !r.fusion?.primary?.gem) return {};
    if (!r.fusion?.primary?.gem) return gemPartStats(r.primary, level, data, 1);
    const i = {};
    addInto(i, gemPartStats(r.primary, level, data, 'fusion'));
    addInto(i, gemPartStats(r.fusion.primary, level, data, 'fusion'));
    for (const o of Object.keys(i)) i[o] = fusionFinal(o, i[o], data);
    return i;
  }
  function jewelsStats(gems, level, data) {                                         // Ne
    const r = {};
    for (const g of gems || []) addInto(r, jewelStats(g, level, data));
    return r;
  }
  function jewelName(j) {
    const r = normJewel(j), t = r.primary?.gem, n = r.fusion?.primary?.gem;
    const base = t?.name || 'Empty';
    if (!n) return base;
    if (t && n && (t.shareId && n.shareId ? t.shareId === n.shareId : t.name === n.name)) return 'Empowered ' + base;
    return `${base}-${n.name}`;
  }

  /* ------------------------------ sockets ------------------------------ */
  function baseSockets(item) {                                                      // ut
    if (!item) return 0;
    if (item.jewelSlots != null) return Number(item.jewelSlots);
    if (item.subType === 'Amulet') return 0;
    const n = RARITY_RANK[item.rarity || ''] || 0;
    return n >= 2 ? 2 : n === 1 ? 1 : 0;
  }
  function socketCount(slot) {                                                      // Hn / et
    if (!slot?.item) return 0;
    return baseSockets(slot.item) + Number(slot.modifier?.special?.extraJewelSlot ?? (slot.modifier?.name === 'Gilded' ? 1 : 0));
  }
  // Ve / Ge
  const modifierAllowed = (mod, item) => !mod || !item || !Array.isArray(item.validModifiers) || item.validModifiers.includes(mod.name);
  function enchantAllowed(e, t) {
    if (!e || !t) return true;
    if (Array.isArray(e.validEquipTypes)) return e.validEquipTypes.includes(t.equipType);
    if (t.equipType === 'Shield') return false;
    if (Array.isArray(t.validEnchantments)) return t.validEnchantments.includes(e.name);
    return true;
  }

  /* ------------------------------ character ------------------------------ */
  const statPoints = (level, data) => (Number(level) || 0) * Number(data?.constants?.statPointsPerLevel ?? 2); // ke
  const allocated = a => ALLOC_KEYS.reduce((t, n) => t + Number(a?.[n] || 0), 0);       // De
  function spiritScale(alloc, data, level) {                                        // Cn
    const r = allocated(alloc), i = statPoints(level, data), o = i > 0 ? i : r;
    const a = data?.constants?.spiritArmor || {};
    const l = Number(a.ratioMultiplier ?? 3), s = Number(a.minScale ?? 0.3), u = Number(a.maxScale ?? 1);
    return clamp(o > 0 ? (l * Number(alloc?.Spirit || 0)) / o : 0, s, u);
  }
  function classify(alloc, data) {                                                  // xe
    const n = allocated(alloc);
    if (!n) return 'No build';
    const r = data?.constants?.buildClassification || {};
    const i = Number(r.savantMinRatio ?? 0.15), o = Number(r.savantMaxRatio ?? 0.5),
      a = Number(r.hybridRatio ?? 0.4), l = Number(r.pureRatio ?? 0.6),
      s = Number(r.dominantRatio ?? 0.5), u = Number(r.subRatio ?? 0.25);
    const p = (Number(alloc?.Spirit) || 0) / n, h = (Number(alloc?.Magic) || 0) / n,
      k = (Number(alloc?.Strength) || 0) / n, w = (Number(alloc?.Weapons) || 0) / n;
    if (p >= i && h >= i && k >= i && w >= i && p < o && h < o && k < o && w < o) return 'Savant';
    if (p >= a && h >= a) return 'Paladin';
    if (p >= a && k >= a) return 'Juggernaut';
    if (p >= a && w >= a) return 'Knight';
    if (h >= a && k >= a) return 'Warlock';
    if (h >= a && w >= a) return 'Conjurer';
    if (k >= a && w >= a) return 'Warlord';
    if (p >= l) return 'Oracle';
    if (h >= l) return 'Mage';
    if (k >= l) return 'Berserker';
    if (w >= l) return 'Warrior';
    if (p >= s && w < u) return 'Oracle';
    if (h >= s && w < u) return 'Mage';
    if (k >= s && w < u) return 'Berserker';
    if (w >= s && p < u) return 'Warrior';
    return 'Savant';
  }
  /** _t: which identity choices (magics / fighting styles) a class can carry. */
  function identityKeys(alloc, data) {
    const n = classify(alloc || {}, data), r = data?.awakenings?.[n];
    if (r) {
      if (r.secondMagic) return ['primaryMagic', 'secondaryMagic'];
      if (r.secondFightingStyle) return ['primaryFightingStyle', 'secondaryFightingStyle'];
      if (r.forgetMelee && !r.forgetMagic) return ['primaryMagic'];
      if (r.forgetMagic && !r.forgetMelee) return ['primaryFightingStyle'];
      if (r.forgetMagic && r.forgetMelee) return [];
      if (n === 'Conjurer') return ['primaryMagic'];
      if (n === 'Warlord') return ['primaryFightingStyle'];
      return ['primaryMagic', 'primaryFightingStyle'];
    }
    switch (n) {
      case 'Mage': return ['primaryMagic', 'secondaryMagic'];
      case 'Berserker': return ['primaryFightingStyle', 'secondaryFightingStyle'];
      case 'Conjurer': return ['primaryMagic'];
      case 'Warlord': return ['primaryFightingStyle'];
      default: return ['primaryMagic', 'primaryFightingStyle'];
    }
  }
  function identityCapacity(alloc, data) {
    const k = identityKeys(alloc, data);
    return { magic: k.filter(x => x.endsWith('Magic')).length, style: k.filter(x => x.endsWith('FightingStyle')).length, keys: k };
  }
  /** The identity ids the builder treats as selected (Y in the allocator). */
  function selectedIdentity(alloc, data) {
    const keys = new Set(identityKeys(alloc, data));
    const pick = ks => new Set(ks.filter(k => keys.has(k)).map(k => alloc?.[k]).filter(Boolean));
    return { magic: pick(['primaryMagic', 'secondaryMagic']), style: pick(['primaryFightingStyle', 'secondaryFightingStyle']) };
  }

  /* ------------------------------ validity ------------------------------ */
  const baseNameOf = e => e?.baseName || e?.name || '';
  /** Jn: the builder's warnings for one slot. Empty array = valid. */
  function slotWarnings(slotId, slot, level, ident, others) {
    if (!slot.item) return [];
    const a = [], it = slot.item;
    if (!(level >= (it.minLevel || 1))) a.push('Level');
    if (it.isArcaniumTemplate && ident.magic.size) a.push('Magic');
    if (it.magicId && !ident.magic.has(it.magicId)) a.push('Magic');
    if (it.isFightingStyleTemplate && ident.style.size) a.push('Style');
    if (it.fightingStyleId && !ident.style.has(it.fightingStyleId)) a.push('Style');
    if (slotId.startsWith('acc')) {
      if (others.some(l => baseNameOf(l) === baseNameOf(it))) a.push('Duplicate');
      if (it.subType === 'Amulet' && others.some(l => l?.subType === 'Amulet')) a.push('Amulet');
      if (it.subType === 'Helmet' && others.some(l => l?.subType === 'Helmet')) a.push('Helmet');
    }
    const n = socketCount(slot);
    if ((slot.gems || []).slice(n).some(g => Boolean(g?.primary?.gem || g?.gem || g?.fusion?.primary?.gem))) a.push('Gem slots');
    return a;
  }
  function buildWarnings(data, level, alloc, slots) {
    const ident = selectedIdentity(alloc, data), out = {};
    for (const d of SLOTS) {
      const s = slots[d.id];
      if (!s?.item) continue;
      const others = d.id.startsWith('acc')
        ? SLOTS.filter(o => o.id.startsWith('acc') && o.id !== d.id && slots[o.id]?.item).map(o => slots[o.id].item)
        : [];
      // The builder only checks earlier accessory slots for duplicates of the same item, but any
      // pair is equally illegal in game, so we check both directions.
      const w = slotWarnings(d.id, s, level, ident, others);
      if (w.length) out[d.id] = w;
    }
    return out;
  }

  /* ------------------------------ EP ------------------------------ */
  function statEP(stat, value, level, data) {                                       // Hr
    const i = data?.calculationRules?.ep || {};
    if (stat === 'Power') return value / (i.powerDivisor ?? 0.3);
    if (stat === 'Defense') return value / (i.defenseDivisor ?? 3);
    const o = Math.floor(level / (i.tertiaryLevelStep ?? 10));
    if (stat === 'Insanity') return value * (-(i.insanityWeight ?? 3) * o);
    if (stat === 'Drawback') return value * (-(i.drawbackWeight ?? 2) * o);
    if (stat === 'Warding') return value * ((i.wardingWeight ?? 1.5) * o);
    return value;
  }
  function epOf(stats, level, data) {                                               // be
    let t = 0;
    for (const [k, v] of Object.entries(stats || {})) t += statEP(k, v, level, data);
    return roundTo(t, 2);
  }
  function applyCaps(s, data) {
    const N = data?.constants?.caps || {};
    if (N.warding != null && s.Warding != null) s.Warding = Math.min(s.Warding, N.warding);
    if (N.insanity != null && s.Insanity != null) s.Insanity = Math.min(s.Insanity, N.insanity);
    return s;
  }

  /* ------------------------------ whole build ------------------------------ */
  /** Ae: the builder's stat total, slot by slot, exactly as it adds them up. */
  function calcBuild({ data, slots, level, allocator }) {
    const sp = spiritScale(allocator || {}, data, level);
    const s = {}, per = {};
    let equipped = 0;
    for (const D of SLOTS) {
      const j = slots?.[D.id];
      if (!j?.item) continue;
      equipped += 1;
      const f = slotLevel(j, level);
      const b = enchantCancelsMod(j.enchant, j.modifier) ? null : j.modifier;
      const R = itemStats(j.item, f, data, true);
      if (j.item.statType === 'Spirit' && sp !== 1) for (const W of Object.keys(R)) R[W] *= sp;
      const O = jewelsStats((j.gems || []).slice(0, socketCount(j)), level, data);
      const Y = b && b.name !== 'Atlantean' ? null : j.factionModifier || null;
      const I = Y ? modStats(Y, j.item, f, data, null) : {};
      const x = enchantStats(j.enchant, f, true);
      const m = sumStats(R, O, I, x);
      const v = modStats(b, j.item, f, data, m);
      const L = {};
      for (const [W, ne] of [[j.item.name, R], [j.enchant?.name, x], [b?.name, v], [Y?.name, I]]) {
        if (W && Object.keys(ne).length) addInto(L, ne);
      }
      floorAll(L);
      addInto(s, L); addInto(s, O);
      const d = sumStats(L, O); floorAll(d);
      per[D.id] = { stats: d, ep: epOf(d, level, data), level: f, appliedModifier: b, appliedFaction: Y,
        atlanteanStat: b?.name === 'Atlantean' ? atlanteanTarget(b, m) : null };
    }
    floorAll(s);
    const uncapped = { ...s };
    applyCaps(s, data);
    return { totals: s, uncapped, perSlot: per, equipped, ep: epOf(s, level, data) };
  }

  /* ------------------------------ build code ------------------------------ */
  function bitWriter() {                                                            // mi
    const e = []; let t = 0, n = 0;
    return {
      write(r, i) {
        const o = Math.max(0, Math.floor(Number(r) || 0));
        for (let a = i - 1; a >= 0; a -= 1) {
          t = (t << 1) | ((o >> a) & 1); n += 1;
          if (n === 8) { e.push(t); t = 0; n = 0; }
        }
      },
      finish() { if (n) e.push(t << (8 - n)); return e; }
    };
  }
  function bitReader(e, start = 0) {                                                // cn
    let n = Math.floor(start / 8), r = 7 - (start % 8);
    return {
      read(i) {
        let o = 0;
        for (let a = 0; a < i; a += 1) {
          if (n >= e.length) throw Error('Truncated build payload');
          o = (o << 1) | ((e[n] >> r) & 1); r -= 1;
          if (r < 0) { r = 7; n += 1; }
        }
        return o;
      },
      position() { return n * 8 + (7 - r); }
    };
  }
  function toBase64Url(bytes) {                                                     // fi
    let t = '';
    for (const n of bytes) t += String.fromCharCode(n);
    const b = typeof btoa === 'function' ? btoa(t) : Buffer.from(t, 'binary').toString('base64');
    return b.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  }
  function fromBase64Url(e) {                                                       // dn
    const t = e.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(e.length / 4) * 4, '=');
    const bin = typeof atob === 'function' ? atob(t) : Buffer.from(t, 'base64').toString('binary');
    return Uint8Array.from(bin, n => n.charCodeAt(0));
  }
  function trimSlots(e) {                                                           // ui
    let t = Math.min(e.length, 6);
    while (t > 0 && !Number(e[t - 1]?.[0] || 0)) t -= 1;
    return e.slice(0, t);
  }
  function trimGems(e) {                                                            // di
    let t = e.length;
    while (t > 0) {
      const n = e[t - 1] || [], r = Array.isArray(n[4]) ? n[4] : [];
      if (Number(n[0] || 0) || Number(n[2] || 0) || Number(n[3] || 0) || Number(n[1] ?? 5) !== 5 ||
        Number(r[0] || 0) || Number(r[2] || 0) || Number(r[3] || 0) || Number(r[1] ?? 5) !== 5) break;
      t -= 1;
    }
    return e.slice(0, t);
  }
  /** dr: pack the array form into the base64url code. */
  function packBuild(e) {
    const t = bitWriter();
    t.write(BUILD_FORMAT, 8); t.write(Number(e[1] || 0), 8);
    const n = e[2] || [];
    const r = n.slice(0, 4).map((a, l) => [l, Number(a || 0)]).filter(([, a]) => a);
    const i = (r.length ? 1 : 0) | (n[4] ? 2 : 0) | (n[5] ? 4 : 0) | (n[6] ? 8 : 0) | (n[7] ? 16 : 0) | (n[8] ? 32 : 0) | (n[9] ? 64 : 0);
    t.write(i, 7);
    if (r.length) { t.write(r.length, 3); for (const [a, l] of r) { t.write(a, 2); t.write(l, 9); } }
    if (i & 2) t.write(Number(n[4] || 0), 24);
    if (i & 4) t.write(Number(n[5] || 0), 24);
    if (i & 8) t.write(Number(n[6] || 0), 24);
    if (i & 16) t.write(Number(n[7] || 0), 24);
    if (i & 32) t.write(Number(n[8] || 0), 3);
    if (i & 64) t.write(Number(n[9] || 0), 3);
    const o = trimSlots(e[3] || []);
    t.write(o.length, 3);
    for (const a of o) {
      const l = Number(a?.[0] || 0);
      t.write(l ? 1 : 0, 1);
      if (!l) continue;
      t.write(l, 24);
      const s = trimGems(a[4] || []), u = Number(a[5] || 0);
      const p = (Number(a[1] || 0) !== Number(e[1] || 0) ? 1 : 0) | (a[2] ? 2 : 0) | (a[3] ? 4 : 0) | (s.length ? 8 : 0) | (u ? 16 : 0);
      t.write(p, 5);
      if (p & 1) t.write(Number(a[1] || 0), 8);
      if (p & 2) t.write(Number(a[2] || 0), 24);
      if (p & 4) t.write(Number(a[3] || 0), 24);
      if (p & 16) t.write(u, 24);
      if (!(p & 8)) continue;
      t.write(s.length, 3);
      for (const h of s) {
        const k = Array.isArray(h?.[4]) ? h[4] : [];
        const w = (h?.[0] ? 1 : 0) | (Number(h?.[1] ?? 5) !== 5 ? 2 : 0) | (h?.[2] ? 4 : 0) | (h?.[3] ? 8 : 0) |
          (k[0] ? 16 : 0) | (Number(k[1] ?? 5) !== 5 ? 32 : 0) | (k[2] ? 64 : 0) | (k[3] ? 128 : 0);
        t.write(w, 8);
        if (w & 1) t.write(Number(h[0] || 0), 24);
        if (w & 2) t.write(Number(h[1] ?? 5), 3);
        if (w & 4) t.write(Number(h[2] || 0), 24);
        if (w & 8) t.write(Number(h[3] || 0), 24);
        if (w & 16) t.write(Number(k[0] || 0), 24);
        if (w & 32) t.write(Number(k[1] ?? 5), 3);
        if (w & 64) t.write(Number(k[2] || 0), 24);
        if (w & 128) t.write(Number(k[3] || 0), 24);
      }
    }
    return toBase64Url(t.finish());
  }
  /** mr: unpack a code into the array form (formats 1-6). */
  function unpackBuild(code) {
    const t = fromBase64Url(code), n = t[0] || 0;
    if (n < 1 || n > 6) throw Error('Unsupported build format');
    const r = bitReader(t);
    r.read(8);
    const i = r.read(8), o = n === 1 ? 3 : n >= 5 ? 7 : n >= 3 ? 5 : 4, a = r.read(o);
    const l = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    if (a & 1) { const k = r.read(3); for (let w = 0; w < k; w += 1) { const N = r.read(2); if (N >= 0 && N < 4) l[N] = r.read(9); } }
    if (a & 2) l[4] = r.read(24);
    if (a & 4) l[5] = r.read(24);
    if (n >= 2 && a & 8) l[6] = r.read(24);
    if (n >= 3 && a & 16) l[7] = r.read(24);
    if (n >= 5 && a & 32) l[8] = r.read(3);
    if (n >= 5 && a & 64) l[9] = r.read(3);
    const s = [], u = r.read(3);
    for (let k = 0; k < u; k += 1) {
      if (!r.read(1)) { s.push([]); continue; }
      const N = r.read(24), D = n >= 6 ? 5 : 4, j = r.read(D);
      const f = [N, j & 1 ? r.read(8) : i, j & 2 ? r.read(24) : 0, j & 4 ? r.read(24) : 0, []];
      if (n >= 6 && j & 16) f[5] = r.read(24);
      if (j & 8) {
        const b = r.read(3);
        for (let d = 0; d < b; d += 1) {
          const M = r.read(n >= 4 ? 8 : 3);
          const C = [M & 1 ? r.read(24) : 0, M & 2 ? r.read(3) : 5, M & 4 ? r.read(24) : 0];
          if (n >= 4) {
            C[3] = M & 8 ? r.read(24) : 0;
            const R = [M & 16 ? r.read(24) : 0, M & 32 ? r.read(3) : 5, M & 64 ? r.read(24) : 0, M & 128 ? r.read(24) : 0];
            if (R.some((O, Y) => (Y === 1 ? Number(O) !== 5 : Number(O)))) C[4] = R;
          }
          f[4].push(C);
        }
      }
      s.push(f);
    }
    while (s.length < 5) s.push([]);
    return [n, i, l, s];
  }

  /** wi + dr: a build (objects) to its code. */
  function encodeBuild({ data, level, allocator, slots }) {
    const keys = new Set(identityKeys(allocator, data));
    const magicShare = id => id ? Number(magicsOf(data).find(n => n.id === id)?.shareId || 0) : 0;
    const styleShare = id => id ? Number(stylesOf(data).find(n => n.id === id)?.shareId || 0) : 0;
    const a = allocator || {};
    const arr = [BUILD_FORMAT, level, [
      Number(a.Magic || 0), Number(a.Strength || 0), Number(a.Weapons || 0), Number(a.Spirit || 0),
      keys.has('primaryMagic') ? magicShare(a.primaryMagic) : 0,
      keys.has('secondaryMagic') ? magicShare(a.secondaryMagic) : 0,
      keys.has('primaryFightingStyle') ? styleShare(a.primaryFightingStyle) : 0,
      keys.has('secondaryFightingStyle') ? styleShare(a.secondaryFightingStyle) : 0,
      Number(a.dragonbloodTier || 0), Number(a.bloodDiseaseCount || 0)
    ], SLOTS.map(d => {
      const e = slots?.[d.id];
      if (!e?.item) return [];
      return [shareOf(e.item), slotLevel(e, level), shareOf(e.enchant), shareOf(e.modifier),
        (e.gems || []).map(g => {
          const t = normJewel(g);
          const n = [shareOf(t.primary.gem), Number(t.primary.tier ?? 5), shareOf(t.primary.reagent), shareOf(t.secondReagent)];
          if (t.fusion?.primary?.gem || t.fusion?.primary?.reagent || t.fusion?.secondReagent) {
            n[4] = [shareOf(t.fusion.primary.gem), Number(t.fusion.primary.tier ?? 5), shareOf(t.fusion.primary.reagent), shareOf(t.fusion.secondReagent)];
          }
          return n;
        }), shareOf(e.factionModifier)];
    })];
    return packBuild(arr);
  }
  /** A code back into slot objects (for checking and for loading a build to start from). */
  function decodeBuild(code, data) {
    const idx = shareIndex(data);
    const at = id => id ? idx.get(Number(id)) || null : null;
    const [version, level, al, sl] = unpackBuild(code);
    const magicId = s => magicsOf(data).find(n => Number(n.shareId) === Number(s))?.id || '';
    const styleId = s => stylesOf(data).find(n => Number(n.shareId) === Number(s))?.id || '';
    const allocator = { Magic: al[0], Strength: al[1], Weapons: al[2], Spirit: al[3],
      primaryMagic: magicId(al[4]), secondaryMagic: magicId(al[5]),
      primaryFightingStyle: styleId(al[6]), secondaryFightingStyle: styleId(al[7]),
      dragonbloodTier: al[8], bloodDiseaseCount: al[9] };
    const slots = {};
    SLOTS.forEach((d, i) => {
      const s = sl[i] || [];
      if (!Number(s[0] || 0)) { slots[d.id] = { item: null, gems: [] }; return; }
      const part = p => ({ gem: at(p[0]), tier: Number(p[1] ?? 5), reagent: at(p[2]) });
      slots[d.id] = {
        item: at(s[0]), level: s[1], enchant: at(s[2]), modifier: at(s[3]), factionModifier: at(s[5]),
        gems: (s[4] || []).map(g => ({ primary: part(g), secondReagent: at(g[3]),
          fusion: Array.isArray(g[4]) ? { primary: part(g[4]), secondReagent: at(g[4][3]) } : null }))
      };
    });
    return { version, level, allocator, slots };
  }
  const builderLink = code => `${BUILDER_URL}?build=${code}`;

  const api = {
    BUILDER_URL, SLOTS, STAT_NAMES, ALLOC_KEYS, LEVEL_STEP,
    roundTo, floorTo, floor1, clamp, addInto, sumStats,
    maxLevelOf, magicsOf, stylesOf, allGems, shareIndex, baseNameOf,
    itemLevel, slotLevel, itemLevels, levelCap, itemMaxLevel,
    itemStats, enchantStats, modStats, imbuedStats, atlanteanTarget, enchantCancelsMod,
    emptyJewel, normJewel, jewelStats, jewelsStats, jewelName,
    baseSockets, socketCount, modifierAllowed, enchantAllowed,
    statPoints, allocated, spiritScale, classify, identityKeys, identityCapacity, selectedIdentity,
    slotWarnings, buildWarnings, statEP, epOf, applyCaps, calcBuild,
    packBuild, unpackBuild, encodeBuild, decodeBuild, builderLink
  };
  root.AOEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
