// Find customer photos on a Thumbtack message thread via the agent's running Chrome.
// Open Thumbtack in the agent first (CDP on 19223), then:
//   node scripts/debug-thumbtack-photos.mjs "https://www.thumbtack.com/pro-inbox/messages/<id>" [port]
import { chromium } from 'playwright-core';
import fs from 'fs';

const url = process.argv[2];
const port = process.argv[3] || 19223;
if (!url) { console.error('usage: node scripts/debug-thumbtack-photos.mjs "<thread-url>" [port]'); process.exit(1); }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();

const netImgs = new Set();
const gqlOps = new Set();
let stream = null;
page.on('response', async (resp) => {
  const u = resp.url();
  if ((resp.headers()['content-type'] || '').startsWith('image/')) netImgs.add(u);
  if (/graphql/i.test(u)) {
    try {
      const r = JSON.parse(resp.request().postData() || '{}');
      if (r.operationName) gqlOps.add(r.operationName);
      if (r.operationName === 'MessengerStreamQuery') stream = (await resp.json())?.data?.messengerStream ?? null;
    } catch {}
  }
});

console.log('→ opening', url);
await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(5000);

const dom = await page.evaluate(() => {
  const out = new Set();
  document.querySelectorAll('img').forEach((i) => { if (i.src && !i.src.startsWith('data:')) out.add(i.src); });
  document.querySelectorAll('a[href]').forEach((a) => { if (/\.(jpe?g|png|webp)(\?|$)/i.test(a.href)) out.add(a.href); });
  return [...out];
});

// what the watcher would scan out of the messenger payload
const streamBlob = JSON.stringify(stream || '');
const streamImgs = [...new Set((streamBlob.match(/https?:\/\/[^"'\\ ]+/gi) || []).filter((u) => /\.(jpe?g|png|webp|gif|heic)|photo|image|media|attachment|cdn/i.test(u)))];

// the NOISE filter the watcher applies
const NOISE = /(logo|icon|sprite|emoji|avatar|profile|\.svg|placeholder|static|favicon|badge|googleusercontent)/i;
const candidate = [...new Set([...streamImgs, ...dom])].filter((u) => /^https?:\/\//.test(u) && !NOISE.test(u));

console.log('\n=== GraphQL ops ===');           console.log([...gqlOps].join('\n') || '(none)');
console.log('\n=== messenger-stream image-ish URLs ==='); console.log(streamImgs.join('\n') || '(none)');
console.log('\n=== network image responses ===');  console.log([...netImgs].join('\n') || '(none)');
console.log('\n=== DOM photos (raw) ===');         console.log(dom.join('\n') || '(none)');
console.log('\n=== >>> what the watcher WOULD send (noise filtered) <<< ==='); console.log(candidate.join('\n') || '(none)');

fs.writeFileSync('/tmp/tt-lead-stream.json', JSON.stringify(stream, null, 2));
fs.writeFileSync('/tmp/tt-lead-imgs.json', JSON.stringify({ gqlOps: [...gqlOps], streamImgs, netImgs: [...netImgs], dom, candidate }, null, 2));
console.log('\nstream → /tmp/tt-lead-stream.json   summary → /tmp/tt-lead-imgs.json');
await browser.close();
