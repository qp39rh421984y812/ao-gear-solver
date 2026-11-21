/* =====================================================================
   Gear solver page: loads item data, reads the form, runs the solver in
   Web Workers, and renders the result with a build code for the
   AO Gear Builder.
   ===================================================================== */
(function () {
  'use strict';
  const E = window.AOEngine, SV = window.AOSolver;

  const LIVE_DATA = 'https://ao-gear.pages.dev/data/equipment.json';
  const LOCAL_DATA = 'data/equipment.json';
  const SAVE_ENDPOINT = '/api/builds';

  /* Stats in the order the form lists them. */
  const TARGET_ROWS = ['Power', 'Defense', 'Size', 'Dexterity', 'Range', 'Haste', 'Pierce', 'Resistance', 'Regeneration', 'Warding', 'Insanity', 'Drawback'];
  const PRIO_STATS = ['Power', 'Defense', 'Size', 'Dexterity', 'Range', 'Haste', 'Pierce', 'Resistance', 'Regeneration', 'Warding'];
  const NEGATIVE = new Set(['Insanity', 'Drawback']);
  const RARITY = { '': '#8B98A0', Common: '#7D7D7F', Uncommon: '#9A8850', Rare: '#6765EC', Exotic: '#E0503F', Legendary: '#2FBF4F', Mystic: '#C001C2', Limited: '#D7AC48' };
  const IDENT_LABEL = { primaryMagic: 'Magic', secondaryMagic: 'Second magic', primaryFightingStyle: 'Fighting style', secondaryFightingStyle: 'Second style' };

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = n => { const r = Math.round(n * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };

  let DATA = null;
  const els = {
    level: $('plevel'), mag: $('pmag'), str: $('pstr'), wep: $('pwep'), spi: $('pspi'),
    ptsNote: $('ptsNote'), classBadge: $('classBadge'), classNote: $('classNote'), identGrid: $('identGrid'),
    tgtBody: $('tgtBody'), results: $('results'), solveBtn: $('solveBtn'), solveLabel: $('solveLabel'),
    prog: $('prog'), tally: $('tally'), effort: $('effort'), attempts: $('attempts'), budgetNote: $('budgetNote'),
    optShield: $('optShield'), optExact: $('optExact'), optFocus: $('optFocus'), insMode: $('insMode'),
    clearT: $('clearT'), prioList: $('prioList'), resetPrio: $('resetPrio'), dataSrc: $('dataSrc'),
    exGilded: $('exGilded'), exImbued: $('exImbued'), exFaction: $('exFaction'), exFusion: $('exFusion'),
    exMystic: $('exMystic'), exLost: $('exLost'), exSunken: $('exSunken'), exText: $('exText')
  };

  /* ------------------------------ data ------------------------------ */
  function usable(d) {
    try {
      if (!d || !Array.isArray(d.items) || d.items.length < 50 || !Array.isArray(d.magics)) return false;
      E.maxLevelOf(d);
      // smoke test: the engine can price and encode a piece
      const it = d.items.find(i => i.equipType === 'Chestpiece' && (i.minLevel || 1) <= 100);
      const slots = { chest: { item: it, gems: [] } };
      E.calcBuild({ data: d, level: 100, allocator: {}, slots });
      E.encodeBuild({ data: d, level: 100, allocator: {}, slots });
      return true;
    } catch (e) { return false; }
  }
  async function fetchJSON(url, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-cache' });
      if (!r.ok) throw Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async function loadData() {
    let src = 'live';
    let d = null;
    try { d = await fetchJSON(LIVE_DATA, 9000); if (!usable(d)) d = null; } catch (e) { d = null; }
    if (!d) { src = 'bundled'; d = await fetchJSON(LOCAL_DATA, 20000); }
    const v = d.meta?.gameVersion ? ` · game ${esc(d.meta.gameVersion)}` : '';
    els.dataSrc.innerHTML = src === 'live'
      ? `live data${v} · ${d.items.length} items`
      : `bundled snapshot${v} · ${d.items.length} items (live data unavailable)`;
    els.dataSrc.classList.toggle('warn', src !== 'live');
    return d;
  }

  /* ------------------------------ character ------------------------------ */
  const identChoice = {};      // key -> 'any' | '' | id
  function allocator() {
    return { Magic: +els.mag.value || 0, Strength: +els.str.value || 0, Weapons: +els.wep.value || 0, Spirit: +els.spi.value || 0 };
  }
  function levelValue() {
    const max = DATA ? E.maxLevelOf(DATA) : 175;
    return Math.min(Math.max(1, Math.floor(+els.level.value || 1)), max);
  }
  function renderCharacter() {
    const lvl = levelValue(), a = allocator();
    const used = E.allocated(a), max = E.statPoints(lvl, DATA);
    els.ptsNote.textContent = `${used} of ${max} stat points used`;
    els.ptsNote.classList.toggle('over', used > max);
    if (!DATA) return;
    const cls = E.classify(a, DATA);
    els.classBadge.textContent = cls === 'No build' ? 'Unallocated' : cls;
    const cap = E.identityCapacity(a, DATA);
    const parts = [];
    if (cap.magic) parts.push(cap.magic === 1 ? '1 magic' : `${cap.magic} magics`);
    if (cap.style) parts.push(cap.style === 1 ? '1 fighting style' : `${cap.style} fighting styles`);
    els.classNote.textContent = parts.length ? `carries ${parts.join(' and ')}` : 'carries no magic or fighting style';
    const sp = E.spiritScale(a, DATA, lvl);
    if (sp < 1) els.classNote.textContent += ` · spirit armour at ${Math.round(sp * 100)}%`;

    const magics = E.magicsOf(DATA), styles = E.stylesOf(DATA);
    els.identGrid.innerHTML = cap.keys.length ? cap.keys.map(k => {
      const list = k.endsWith('Magic') ? magics : styles;
      const cur = identChoice[k] ?? 'any';
      const opts = [`<option value="any"${cur === 'any' ? ' selected' : ''}>Solver picks</option>`,
        `<option value=""${cur === '' ? ' selected' : ''}>None</option>`]
        .concat(list.map(m => `<option value="${esc(m.id)}"${cur === m.id ? ' selected' : ''}>${esc(m.name)}</option>`));
      return `<div class="field"><label for="id_${k}">${IDENT_LABEL[k]}</label><select id="id_${k}" data-key="${k}">${opts.join('')}</select></div>`;
    }).join('') : `<p class="ident-none">No magic- or style-specific gear for this class.</p>`;
  }
  els.identGrid.addEventListener('change', ev => {
    const k = ev.target.dataset.key;
    if (!k) return;
    identChoice[k] = ev.target.value;
    // primary and secondary can't be the same magic / style
    const pair = { primaryMagic: 'secondaryMagic', secondaryMagic: 'primaryMagic', primaryFightingStyle: 'secondaryFightingStyle', secondaryFightingStyle: 'primaryFightingStyle' }[k];
    if (ev.target.value && ev.target.value !== 'any' && identChoice[pair] === ev.target.value) { identChoice[pair] = 'any'; renderCharacter(); }
  });
  [els.level, els.mag, els.str, els.wep, els.spi].forEach(i => i.addEventListener('input', renderCharacter));

  /* ------------------------------ targets & priorities ------------------------------ */
  TARGET_ROWS.forEach(stat => {
    const tr = document.createElement('tr');
    const box = (cls, label) => `<td class="in"><input type="text" class="tval ${cls}" autocomplete="off" spellcheck="false" inputmode="decimal" placeholder="&mdash;" aria-label="${stat} ${label}" data-stat="${stat}"></td>`;
    tr.innerHTML = `<td class="name">${stat}</td>` + box('tmin', 'at least') + box('tmax', 'hard cap');
    els.tgtBody.appendChild(tr);
  });
  PRIO_STATS.forEach(stat => {
    const row = document.createElement('div');
    row.className = 'prio-row'; row.dataset.stat = stat;
    row.innerHTML = `<label for="prio_${stat}">${stat}</label><input type="range" id="prio_${stat}" data-stat="${stat}" min="0" max="8" step="0.5" value="1"><output for="prio_${stat}">&times;1.00</output>`;
    els.prioList.appendChild(row);
  });
  const isShun = raw => raw === '-';
  function shunnedStats() {
    const out = new Set();
    els.tgtBody.querySelectorAll('input.tmin').forEach(i => { if (isShun(i.value.trim())) out.add(i.dataset.stat); });
    return out;
  }
  function refreshPrio() {
    const shun = shunnedStats();
    els.prioList.querySelectorAll('.prio-row').forEach(row => {
      const stat = row.dataset.stat, slider = row.querySelector('input'), out = row.querySelector('output');
      const v = Number(slider.value), s = shun.has(stat);
      row.classList.toggle('shun', s);
      row.classList.toggle('up', !s && v > 1);
      row.classList.toggle('down', !s && v < 1 && v > 0);
      row.classList.toggle('off', !s && v === 0);
      slider.disabled = s;
      out.innerHTML = s ? 'shunned' : (v === 0 ? 'off' : '&times;' + v.toFixed(2));
    });
  }
  els.prioList.addEventListener('input', refreshPrio);
  els.tgtBody.addEventListener('input', refreshPrio);
  els.resetPrio.addEventListener('click', () => { els.prioList.querySelectorAll('input').forEach(r => { r.value = '1'; }); refreshPrio(); });
  els.clearT.addEventListener('click', () => { els.tgtBody.querySelectorAll('input').forEach(i => { i.value = ''; }); refreshPrio(); });
  refreshPrio();

  function boxValue(inp) {
    const raw = inp.value.trim().replace(',', '.');
    if (raw === '' || isShun(raw)) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  }
  function readConfig() {
    const targets = [], avoid = [];
    els.tgtBody.querySelectorAll('tr').forEach(tr => {
      const mn = tr.querySelector('input.tmin'), mx = tr.querySelector('input.tmax');
      const stat = mn.dataset.stat;
      if (isShun(mn.value.trim())) avoid.push(stat);
      const min = boxValue(mn), max = boxValue(mx);
      if (min !== null || max !== null) targets.push({ stat, min, max });
    });
    const prio = {};
    els.prioList.querySelectorAll('input').forEach(r => { prio[r.dataset.stat] = Number(r.value); });
    const alloc = allocator();
    const cap = E.identityCapacity(alloc, DATA);
    const identity = {};
    cap.keys.forEach(k => { identity[k] = identChoice[k] ?? 'any'; });
    return {
      level: levelValue(), allocator: alloc, identity,
      useShield: els.optShield.checked, exact: els.optExact.checked, focus: els.optFocus.checked,
      insMode: els.insMode.value,
      exclude: {
        gilded: els.exGilded.checked, imbued: els.exImbued.checked, faction: els.exFaction.checked,
        fusion: els.exFusion.checked, mystic: els.exMystic.checked, lost: els.exLost.checked, sunken: els.exSunken.checked
      },
      excludeText: els.exText.value,
      targets, avoid, prio
    };
  }

  /* ------------------------------ budget note ------------------------------ */
  const cores = () => Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  function setBudgetNote() {
    const per = +els.effort.value / 1000, n = +els.attempts.value;
    const par = Math.min(n, cores());
    const total = Math.ceil(n / par) * per;
    els.budgetNote.textContent = n === 1
      ? `One search, about ${per}s.`
      : `${n} independent searches, ${par} at a time, about ${total < 60 ? Math.round(total) + 's' : Math.floor(total / 60) + ' min ' + Math.round(total % 60) + 's'} in total.`;
  }
  els.effort.addEventListener('change', setBudgetNote);
  els.attempts.addEventListener('change', setBudgetNote);
  setBudgetNote();

  /* ------------------------------ workers ------------------------------ */
  let pool = null;
  function makePool(n) {
    try {
      const ws = [];
      for (let i = 0; i < n; i++) {
        const w = new Worker('js/worker.js');
        w.postMessage({ type: 'init', data: DATA });
        ws.push(w);
      }
      return ws;
    } catch (e) { return null; }
  }
  function killPool() { if (pool) pool.forEach(w => w.terminate()); pool = null; }

  let searching = false, cancel = null;

  function solve() {
    if (searching) { if (cancel) cancel(); return; }
    const cfg = readConfig();
    const perMs = +els.effort.value, attempts = +els.attempts.value;
    const want = Math.min(attempts, cores());
    if (!pool || pool.length < want) { killPool(); pool = makePool(want); }

    searching = true;
    els.solveBtn.classList.add('stopping');
    els.solveLabel.textContent = 'Stop';
    els.prog.hidden = false; els.tally.hidden = false;
    const bar = els.prog.firstElementChild;
    bar.style.width = '0%';

    let best = null, met = 0, done = 0, err = null, next = 0, finished = false;
    const partial = new Map();
    const t0 = performance.now();

    const finish = () => {
      if (finished) return;
      finished = true; searching = false; cancel = null;
      els.solveBtn.classList.remove('stopping');
      els.solveLabel.textContent = 'Find build';
      bar.style.width = '100%';
      setTimeout(() => { els.prog.hidden = true; els.tally.hidden = true; }, 400);
      if (!best) {
        els.results.innerHTML = `<div class="verdict miss"><h3>${err ? 'The search failed' : 'No wearable gear'}</h3><p>${esc(err || `Nothing in the item list fits level ${cfg.level} with these settings. Raise the level, loosen a cap of 0, or clear an exclusion.`)}</p></div>`;
        return;
      }
      render(best, cfg, { attempts: done, met, secs: (performance.now() - t0) / 1000 });
    };
    const update = () => {
      let f = done;
      partial.forEach(v => { f += v; });
      bar.style.width = (Math.min(1, f / attempts) * 100).toFixed(0) + '%';
      els.tally.textContent = best
        ? `attempt ${Math.min(done + 1, attempts)} of ${attempts} · ${met} met every rule · best EP ${best.ep.toFixed(2)}`
        : `attempt ${Math.min(done + 1, attempts)} of ${attempts}`;
    };
    const take = res => {
      done++;
      if (res && !res.error) {
        if (res.met) met++;
        if (SV.betterResult(res, best)) best = res;
      } else if (res && res.error) err = res.error;
      update();
    };

    if (pool) {
      const busy = new Set();
      const dispatch = w => {
        if (next >= attempts || finished) {
          if (!busy.size) finish();
          return;
        }
        const job = next++;
        busy.add(w);
        w.onmessage = ev => {
          const m = ev.data;
          if (m.type === 'progress') { partial.set(m.job, m.f); update(); return; }
          if (m.type !== 'result') return;
          partial.delete(m.job);
          busy.delete(w);
          take(m.res);
          dispatch(w);
        };
        w.onerror = e => { busy.delete(w); err = e.message || 'worker error'; done++; dispatch(w); };
        w.postMessage({ type: 'solve', job, cfg, timeMs: perMs, seed: job + 1 });
      };
      cancel = () => { killPool(); finish(); };
      pool.forEach(dispatch);
    } else {
      // No workers (e.g. opened from disk): run on the page, one attempt per tick.
      let stop = false;
      cancel = () => { stop = true; };
      const step = () => {
        if (stop || next >= attempts) { finish(); return; }
        const job = next++;
        try { take(SV.solve(DATA, cfg, { timeMs: perMs, seed: job + 1 })); } catch (e) { err = String(e.message || e); done++; }
        setTimeout(step, 0);
      };
      setTimeout(step, 30);
    }
  }
  els.solveBtn.addEventListener('click', solve);

  /* ------------------------------ results ------------------------------ */
  function nameOfIdent(kind, id) {
    const list = kind === 'magic' ? E.magicsOf(DATA) : E.stylesOf(DATA);
    return list.find(m => m.id === id)?.name || id;
  }
  function render(res, cfg, run) {
    const out = els.results;
    out.textContent = '';
    const T = res.targets;
    const missed = T.filter(t => !t.ok);
    const shun = cfg.avoid || [];
    const prioNames = PRIO_STATS.filter(s => Math.abs((cfg.prio[s] ?? 1) - 1) > 1e-9).map(s => `${s} ${cfg.prio[s] === 0 ? 'off' : '&times;' + cfg.prio[s].toFixed(2)}`);
    const exOn = Object.keys(cfg.exclude).filter(k => cfg.exclude[k]);
    const tuned = shun.length > 0 || prioNames.length > 0 || cfg.focus;
    const best = tuned ? 'best gear set under your weighting' : 'highest-EP gear set';

    // ---- verdict ----
    const v = document.createElement('div');
    v.className = 'verdict ' + (missed.length ? 'miss' : 'ok');
    if (!T.length) {
      v.innerHTML = `<h3>${tuned ? 'Best gear set for your weighting' : 'Highest-EP gear set'}</h3><p>${tuned
        ? 'No targets were set, so this is the gear that best serves your priorities.'
        : 'No targets were set, so this is simply the most efficient gear your character can wear.'}</p>`;
    } else if (!missed.length) {
      const caps = T.filter(t => t.max !== null).length;
      v.innerHTML = `<h3>All ${T.length} stat rule${T.length > 1 ? 's' : ''} met</h3><p>This is the ${best} that satisfies every rule${caps ? `, including ${caps} hard cap${caps > 1 ? 's' : ''}` : ''}.</p>`;
    } else {
      const impossible = missed.filter(t => t.min !== null && t.max !== null && t.min > t.max);
      const breached = missed.filter(t => !t.capOK);
      const worst = missed.map(t => !t.capOK ? `<b>${t.stat}</b> ${fmt(t.got - t.max)} over its cap` : `<b>${t.stat}</b> ${t.got < t.min ? 'short by' : 'off by'} ${fmt(Math.abs(t.got - t.min))}`).join(', ');
      let why;
      if (impossible.length) why = impossible.map(t => `<b>${t.stat}</b> asks for at least ${fmt(t.min)} but caps at ${fmt(t.max)}`).join('; ') + ' &mdash; a hard cap always wins.';
      else if (breached.length) why = `Your hard cap${breached.length > 1 ? 's' : ''} on ${breached.map(t => t.stat).join(' and ')} can't be held alongside the rest.`;
      else why = `No legal gear set reaches ${missed.length > 1 ? 'them' : 'it'} at level ${cfg.level} with these settings.`;
      const others = T.length - missed.length;
      v.innerHTML = `<h3>Can't satisfy ${missed.length} of your ${T.length} stat rule${T.length > 1 ? 's' : ''}</h3><p>${why} This is the closest possible &mdash; ${worst}.${others > 0 ? ' Every other rule is met.' : ''}</p>`;
    }
    out.appendChild(v);

    // ---- what the search was tuned for ----
    const bits = [];
    if (cfg.focus) bits.push(`<span><b>Focused</b> only stats you asked for earn score</span>`);
    const insLabel = { never: 'never', power: 'only where its bonus is power', pays: 'only where its bonus is power or defense', any: null };
    if (insLabel[cfg.insMode]) bits.push(`<span><b>Atlantean</b> ${insLabel[cfg.insMode]}</span>`);
    const exLabels = { gilded: 'Gilded', imbued: 'Imbued', faction: 'faction modifiers', fusion: 'fused jewels', mystic: 'mystic gems', lost: 'Lost items', sunken: 'Sunken items' };
    const exBits = exOn.map(k => exLabels[k]).concat(String(cfg.excludeText || '').split(',').map(s => esc(s.trim())).filter(Boolean));
    if (exBits.length) bits.push(`<span><b>Excluded</b> ${exBits.join(', ')}</span>`);
    if (prioNames.length) bits.push(`<span><b>Weighted</b> ${prioNames.join(', ')}</span>`);
    if (shun.length) bits.push(`<span><b>Shunned</b> ${shun.map(s => s + ((res.totals[s] || 0) > 0 ? ` (${fmt(res.totals[s])} unavoidable)` : '')).join(', ')}</span>`);
    if (!cfg.useShield) bits.push(`<span><b>Shield slot</b> left free</span>`);
    if (bits.length) {
      const tune = document.createElement('div');
      tune.className = 'tuning'; tune.innerHTML = bits.join('');
      out.appendChild(tune);
    }

    // ---- summary strip ----
    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.innerHTML =
      `<div class="stat-cell ep"><div class="k">Efficiency points</div><div class="v">${res.ep.toFixed(2)}</div></div>` +
      `<div class="stat-cell"><div class="k">Rules met</div><div class="v">${T.length - missed.length}<small> / ${T.length}</small></div></div>` +
      (run.attempts > 1 ? `<div class="stat-cell"><div class="k">Best of</div><div class="v">${run.attempts}<small> tries, ${run.met} clean</small></div></div>` : '') +
      `<div class="stat-cell"><div class="k">Power</div><div class="v">${fmt(res.totals.Power || 0)}</div></div>` +
      `<div class="stat-cell"><div class="k">Defense</div><div class="v">${fmt(res.totals.Defense || 0)}</div></div>`;
    out.appendChild(strip);

    // ---- ledger ----
    const led = document.createElement('section');
    led.className = 'panel';
    const tmap = new Map(T.map(t => [t.stat, t]));
    let rows = '';
    for (const stat of TARGET_ROWS) {
      const got = res.totals[stat] || 0, t = tmap.get(stat), sh = shun.includes(stat);
      if (!t && !sh && got === 0) continue;
      let pill, barCls, pct = 0, want = '&mdash;';
      if (sh) {
        const clean = got <= 1e-9;
        pill = `<span class="pill ${clean ? 'met' : 'short'}">${clean ? 'none left' : 'unavoidable'}</span>`;
        barCls = clean ? 'met' : 'short';
        want = `<span class="rule-sym">shunned</span>`;
      } else if (!t) {
        pill = `<span class="pill none">no rule</span>`; barCls = 'none';
      } else {
        let word;
        if (!t.capOK) word = 'over cap';
        else if (!t.minOK) word = got < (t.min ?? 0) ? 'short' : 'over';
        else if (t.min !== null && t.max !== null) word = t.pinned ? 'pinned' : 'in range';
        else if (t.max !== null) word = 'under cap';
        else word = cfg.exact ? 'on target' : 'met';
        pill = `<span class="pill ${t.ok ? 'met' : 'short'}">${word}</span>`;
        barCls = t.ok ? 'met' : 'short';
        const ref = t.max !== null ? t.max : t.min;
        pct = ref > 0 ? Math.min(100, got / ref * 100) : (got > 0 ? 100 : 0);
        const parts = [];
        if (t.min !== null) parts.push(`<span class="rule-sym">&ge;</span> ${fmt(t.min)}`);
        if (t.max !== null) parts.push(`<span class="rule-sym">&le;</span> ${fmt(t.max)}`);
        want = parts.join('<span class="rule-sep">/</span>');
      }
      rows += `<tr class="${t ? '' : 'dim'}"><td>${stat}</td><td class="bar-cell"><div class="bar"><i class="${barCls}" style="width:${pct.toFixed(1)}%"></i></div></td><td>${want}</td><td><b>${fmt(got)}</b></td><td>${pill}</td></tr>`;
    }
    led.innerHTML = `<div class="panel-head"><h2>Stats reached</h2><span class="hint">as the gear builder shows them</span></div>` +
      `<div class="panel-body" style="overflow-x:auto"><table class="ledger"><thead><tr><th>Stat</th><th></th><th>Target</th><th>Achieved</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    out.appendChild(led);

    // ---- gear ----
    const gear = document.createElement('section');
    gear.className = 'panel';
    const filled = res.slots.filter(s => !s.empty);
    const cards = res.slots.map(s => {
      if (s.empty) return `<div class="slot"><div class="slot-top"><span class="slot-kind">${esc(s.label)}</span></div><div class="slot-name" style="color:var(--ink-3)">Empty</div></div>`;
      const tags = TARGET_ROWS.filter(k => s.stats[k]).map(k => `<span class="tag${NEGATIVE.has(k) ? ' neg' : ''}">${k} ${fmt(s.stats[k])}</span>`).join('');
      const identTag = s.magic ? `<span class="ident">${esc(nameOfIdent('magic', s.magic))}</span>` : s.style ? `<span class="ident">${esc(nameOfIdent('style', s.style))}</span>` : '';
      const gems = s.gems.filter(Boolean);
      const mod = s.modifier ? esc(s.modifier) + (s.atlantean ? ` <span class="rule-sym">(bonus &rarr; ${esc(s.atlantean)})</span>` : '') : null;
      return `<div class="slot">
        <div class="slot-top"><span class="slot-kind">${esc(s.label)}</span><span class="slot-ep">${s.ep.toFixed(2)} EP</span></div>
        <div class="slot-name"><span class="rar" style="background:${RARITY[s.rarity] || RARITY['']}"></span>${esc(s.item)} <span class="lvl">Lv ${s.level}</span>${identTag}</div>
        <dl>
          <dt>Enchant</dt><dd${s.enchant ? '' : ' class="empty"'}>${s.enchant ? esc(s.enchant) : 'none'}</dd>
          <dt>Modifier</dt><dd${mod ? '' : ' class="empty"'}>${mod || 'none'}</dd>
          ${s.faction ? `<dt>Faction</dt><dd>${esc(s.faction)}</dd>` : ''}
          <dt>Jewels</dt><dd${gems.length ? '' : ' class="empty"'}>${gems.length ? `<span class="gems-list">${gems.map(g => `<span>${esc(g)}</span>`).join('')}</span>` : (s.gems.length ? 'empty sockets' : 'no sockets')}</dd>
        </dl>
        <div class="slot-stats">${tags}</div>
      </div>`;
    }).join('');
    gear.innerHTML = `<div class="panel-head"><h2>Gear set</h2><span class="hint">${filled.length} of 6 slots</span></div><div class="panel-body"><div class="slots">${cards}</div></div>`;
    out.appendChild(gear);

    // ---- build code ----
    const a = res.allocator;
    const carried = [];
    ['primaryMagic', 'secondaryMagic'].forEach(k => { if (a[k]) carried.push(`<b>${esc(nameOfIdent('magic', a[k]))}</b>`); });
    ['primaryFightingStyle', 'secondaryFightingStyle'].forEach(k => { if (a[k]) carried.push(`<b>${esc(nameOfIdent('style', a[k]))}</b>`); });
    const specific = res.slots.filter(s => !s.empty && (s.magic || s.style)).map(s => esc(s.item));
    const identLine = carried.length
      ? `<p class="ident-note">The code sets ${carried.join(' and ')}${specific.length ? ` &mdash; needed by ${specific.join(', ')}` : ''}, along with your stat allocation, so the builder keeps every piece as solved.</p>`
      : `<p class="ident-note">No magic- or style-specific gear in this build.</p>`;
    const warn = Object.keys(res.warnings || {}).length
      ? `<p class="note" style="color:var(--bad)">The builder will flag: ${esc(Object.entries(res.warnings).map(([k, w]) => k + ': ' + w.join(', ')).join('; '))}</p>` : '';
    const cb = document.createElement('section');
    cb.className = 'panel';
    cb.innerHTML = `<div class="panel-head"><h2>Build code</h2><span class="hint">AO Gear Builder format</span></div>
      <div class="panel-body">
        <div class="codebox">
          <input type="text" id="codeOut" readonly value="${esc(res.code)}" aria-label="Build code">
          <button class="mini" id="copyCode" type="button">Copy code</button>
          <button class="mini" id="copyLink" type="button">Copy link</button>
          <a class="linkbtn" href="${esc(res.link)}" target="_blank" rel="noopener">Open in AO Gear Builder</a>
        </div>
        ${identLine}${warn}
        <p class="note">Open the link, or paste the code into <b>Load</b> on the builder. Its stats panel will show exactly the numbers above.</p>
      </div>`;
    out.appendChild(cb);
    const copy = (btn, text) => {
      const done = () => { const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = t; }, 1400); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => { $('codeOut').select(); document.execCommand('copy'); done(); });
      else { $('codeOut').select(); document.execCommand('copy'); done(); }
    };
    $('copyCode').addEventListener('click', e => copy(e.currentTarget, res.code));
    $('copyLink').addEventListener('click', e => copy(e.currentTarget, res.link));

    recordBuild(res);
  }

  /* Fire-and-forget: the solver never depends on this succeeding. */
  function recordBuild(res) {
    try {
      fetch(SAVE_ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: res.code, ep: res.ep, stats: { power: res.totals.Power || 0, defense: res.totals.Defense || 0, size: res.totals.Size || 0, pierce: res.totals.Pierce || 0 } })
      }).then(r => { if (!r.ok) console.warn('build not recorded: HTTP ' + r.status); })
        .catch(e => console.warn('build not recorded:', e.message));
    } catch (e) { console.warn('build not recorded:', e.message); }
  }

  /* ------------------------------ start ------------------------------ */
  renderCharacter();
  loadData().then(d => {
    DATA = d;
    els.level.max = String(E.maxLevelOf(d));
    renderCharacter();
    els.solveBtn.disabled = false;
    els.solveLabel.textContent = 'Find build';
  }).catch(e => {
    els.dataSrc.textContent = 'item data failed to load';
    els.dataSrc.classList.add('warn');
    els.solveLabel.textContent = 'No item data';
    els.results.innerHTML = `<div class="verdict miss"><h3>Couldn't load item data</h3><p>${esc(e.message || e)}</p></div>`;
  });
})();
