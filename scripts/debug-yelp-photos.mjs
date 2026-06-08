// Find customer photos on a specific Yelp lead by attaching to the agent's running Chrome.
// The agent must be running with Yelp connected (CDP on 19222).
//
//   node scripts/debug-yelp-photos.mjs "https://biz.yelp.com/leads_center/<biz>/leads/<lead>"
//   (optional 2nd arg = CDP port, default 19222)
import { chromium } from 'playwright-core';
import fs from 'fs';

const url = process.argv[2];
const port = process.argv[3] || 19222;
if (!url) { console.error('usage: node scripts/debug-yelp-photos.mjs "<lead-url>" [port]'); process.exit(1); }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();

const netImgs = new Set();
const gqlOps = new Set();
page.on('response', (resp) => {
  const u = resp.url();
  const ct = resp.headers()['content-type'] || '';
  if (ct.startsWith('image/')) netImgs.add(u);
  if (/graphql/i.test(u)) {
    try { const r = JSON.parse(resp.request().postData() || '{}'); if (r.operationName) gqlOps.add(r.operationName); } catch {}
  }
});

console.log('→ opening', url);
await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(5000);

// Everything in the DOM that could be a photo (filter out obvious UI noise).
const dom = await page.evaluate(() => {
  const out = new Set();
  document.querySelectorAll('img').forEach((i) => { if (i.src && !i.src.startsWith('data:')) out.add(i.src); });
  document.querySelectorAll('[style*="background-image"]').forEach((e) => {
    const m = (e.getAttribute('style') || '').match(/url\(["']?(.*?)["']?\)/); if (m) out.add(m[1]);
  });
  document.querySelectorAll('a[href]').forEach((a) => { if (/\.(jpe?g|png|webp)/i.test(a.href)) out.add(a.href); });
  return [...out];
});
const noise = /(gravatar|sprite|icon|logo|emoji|\.svg|placeholder|avatar)/i;
const domPhotos = dom.filter((u) => !noise.test(u));

// Apollo state (initial) — scan for image urls.
const apollo = await page.evaluate(() => (window.yelp && window.yelp.react_apollo_state) || null);
const apolloImgs = [...new Set((JSON.stringify(apollo || '').match(/https?:\/\/[^"'\\ ]+?\.(?:jpe?g|png|webp|gif|heic)(?:\?[^"'\\ ]*)?/gi) || []))];

console.log('\n=== GraphQL operations seen ===');     console.log([...gqlOps].join('\n') || '(none)');
console.log('\n=== Network image responses ===');      console.log([...netImgs].join('\n') || '(none)');
console.log('\n=== DOM photos (UI noise filtered) ==='); console.log(domPhotos.join('\n') || '(none)');
console.log('\n=== Apollo image-like URLs ===');         console.log(apolloImgs.join('\n') || '(none)');

if (apollo) { fs.writeFileSync('/tmp/yelp-lead-apollo.json', JSON.stringify(apollo, null, 2)); console.log('\napollo → /tmp/yelp-lead-apollo.json'); }
fs.writeFileSync('/tmp/yelp-lead-imgs.json', JSON.stringify({ gqlOps: [...gqlOps], netImgs: [...netImgs], domPhotos, apolloImgs }, null, 2));
console.log('summary → /tmp/yelp-lead-imgs.json');

await browser.close();
