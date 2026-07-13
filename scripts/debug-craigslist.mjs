// Probe: run the CL search + extraction against the live hidden Chrome (port 19224)
// and print what the watcher would see. usage: node scripts/debug-craigslist.mjs [city] [kw]
import { chromium } from 'playwright-core';

const city = process.argv[2] || 'losangeles';
const kw = process.argv[3] || 'remodel';

const browser = await chromium.connectOverCDP('http://127.0.0.1:19224');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
try {
  const url = `https://${city}.craigslist.org/search/ggg?query=${encodeURIComponent(kw)}&sort=date`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const hits = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href;
      const m = href.match(/craigslist\.org\/.*\/d\/[^/]+\/(\d+)\.html/);
      if (!m || seen.has(m[1])) return;
      const title = (a.textContent || '').trim();
      if (!title || title.length < 4) return;
      seen.add(m[1]);
      out.push({ id: m[1], url: href.split('?')[0], title: title.slice(0, 70) });
    });
    return out;
  });
  console.log(`hits: ${hits.length}`);
  hits.slice(0, 10).forEach((h) => console.log(`- [${h.id}] ${h.title}`));
  if (!hits.length) {
    // What DOES the page have? Dump anchor href patterns to see the real URL shape.
    const sample = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')].map((a) => a.href)
        .filter((h) => h.includes('craigslist')).slice(0, 20));
    console.log('sample anchors:', JSON.stringify(sample, null, 1));
  }
} finally {
  await page.close().catch(() => {});
  await browser.close();
}
