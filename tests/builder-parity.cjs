const { chromium } = require('playwright');
const cases = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36' });
  let bad = 0;
  for (const [i, c] of cases.entries()) {
    await p.goto('https://ao-gear.pages.dev/?build=' + c.code, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => document.querySelector('#ep-summary')?.innerText.includes('EP'), null, { timeout: 20000 });
    await p.waitForTimeout(150);
    const got = await p.evaluate(() => {
      const o = {};
      for (const r of document.querySelectorAll('#stats-list .stat-row')) {
        const v = r.querySelector('.stat-exact')?.textContent; if (v && r.dataset.stat !== 'Total Health') o[r.dataset.stat] = Number(v.replace(/[+,]/g, ''));
      }
      const ep = document.querySelector('#ep-summary').innerText.match(/(-?[\d,.]+)\s*EP/);
      const warn = [...document.querySelectorAll('.slot [data-field=warnings]')].map(n => n.textContent.trim()).filter(Boolean);
      return { o, ep: ep ? Number(ep[1].replace(/,/g, '')) : null, warn, url: location.search };
    });
    const exp = Object.fromEntries(Object.entries(c.totals).filter(([, v]) => v));
    const keys = new Set([...Object.keys(exp), ...Object.keys(got.o)]);
    const diffs = [...keys].filter(k => Math.abs((exp[k] || 0) - (got.o[k] || 0)) > 1e-6).map(k => `${k}: mine ${exp[k] || 0} site ${got.o[k] || 0}`);
    if (Math.abs(got.ep - Math.round(c.ep * 10) / 10) > 0.051) diffs.push(`EP mine ${c.ep} site ${got.ep}`);
    if (got.warn.length) diffs.push('site warnings: ' + got.warn.join('; '));
    if (diffs.length) { bad++; console.log(`#${i} ${c.cls} ${c.code}\n   ` + diffs.join('\n   ')); }
  }
  console.log(`${cases.length - bad}/${cases.length} builds match`);
  await b.close();
})();
