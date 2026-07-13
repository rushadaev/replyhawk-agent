// Craigslist demand watcher. Polls the local Craigslist gigs/wanted listings for posts
// matching the operator's keywords ("drywall", "remodel", "handyman"…) and ingests each
// match as a lead. No login required — Craigslist is public — but we still drive the real
// Chrome profile so requests look like a normal browser.
//
// Contact extraction is best-effort: phone numbers are regexed out of the post body, and we
// try to open the post's "reply" panel to capture the anonymized relay email
// (xxxx@reply.craigslist.org) — either one plugs straight into the cloud's call/email
// pipeline.

import { chromium, BrowserContext, Page } from 'playwright-core';
import { postLead, knownLeadIds } from '../cloudClient';
import type { PollLog } from './yelp';

export interface CraigslistConfig {
  city: string;        // subdomain, e.g. "losangeles"
  keywords: string[];  // search terms, one search per keyword
  category: string;    // CL search category — 'ggg' = all gigs (default)
}

interface SearchHit { id: string; url: string; title: string }

const INGEST_CAP = 8; // max new posts ingested per poll cycle (keeps a cycle fast)

export class CraigslistWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private config: CraigslistConfig | null = null;
  readonly cdpPort: number;
  status: 'idle' | 'connecting' | 'watching' | 'error' = 'idle';
  lastError?: string;
  lastTick?: number;
  log: PollLog[] = [];
  lastScreenshot?: { at: number; b64: string };

  constructor(cdpPort: number) { this.cdpPort = cdpPort; }

  recent(n = 10): PollLog[] { return this.log.slice(0, n); }
  getConfig(): CraigslistConfig | null { return this.config; }

  async pollNow(): Promise<{ ok: true; ingested: number; total: number } | { ok: false; error: string }> {
    try {
      const r = await this.pollOnce();
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async start(config: CraigslistConfig, intervalSec = 300): Promise<void> {
    if (!config.city.trim()) throw new Error('Set your Craigslist city (the subdomain, e.g. "losangeles").');
    if (!config.keywords.length) throw new Error('Add at least one search keyword.');
    this.config = { ...config, category: config.category || 'ggg' };
    if (this.timer) return;
    this.status = 'connecting';
    const ms = Math.max(60, intervalSec) * 1000; // CL posts move slowly — 5 min default
    const tick = async (): Promise<void> => {
      if (this.running) return;
      this.running = true;
      try {
        const r = await this.pollOnce();
        this.status = 'watching';
        this.lastTick = Date.now();
        this.lastError = undefined;
        this.log.unshift({ at: this.lastTick, ingested: r.ingested, total: r.total });
        if (this.log.length > 50) this.log.length = 50;
      } catch (e) {
        this.status = 'error';
        this.lastError = (e as Error).message;
        this.log.unshift({ at: Date.now(), ingested: 0, total: 0, note: `ERROR: ${this.lastError}` });
      } finally {
        this.running = false;
      }
    };
    await tick();
    this.timer = setInterval(tick, ms);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status = 'idle';
  }

  private async withContext<T>(fn: (ctx: BrowserContext) => Promise<T>): Promise<T> {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`);
    try {
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      return await fn(ctx);
    } finally {
      await browser.close();
    }
  }

  private async pollOnce(): Promise<{ ingested: number; total: number }> {
    const cfg = this.config;
    if (!cfg) throw new Error('Not configured');
    let ingested = 0;
    const hits = new Map<string, SearchHit>();

    await this.withContext(async (ctx) => {
      const page = await ctx.newPage();
      try {
        for (const kw of cfg.keywords) {
          const url = `https://${cfg.city}.craigslist.org/search/${cfg.category}?query=${encodeURIComponent(kw)}&sort=date`;
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1500); // CL renders results client-side
          for (const h of await this.extractSearchHits(page)) hits.set(h.id, h);
        }

        try {
          await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
          const buf = await page.screenshot({ type: 'jpeg', quality: 40, fullPage: false });
          this.lastScreenshot = { at: Date.now(), b64: buf.toString('base64') };
        } catch { /* non-fatal */ }

        const known = await knownLeadIds('craigslist').catch(() => new Set<string>());
        const fresh = [...hits.values()].filter((h) => !known.has(h.id)).slice(0, INGEST_CAP);
        for (const h of fresh) {
          try { await this.ingestPost(page, h, cfg); ingested++; } catch { /* skip one */ }
        }
      } finally {
        await page.close().catch(() => undefined);
      }
    });
    return { ingested, total: hits.size };
  }

  // Post URLs look like /{area}/{cat}/d/{slug}/{id}.html — regex on hrefs is far more stable
  // than CL's result-list class names (which differ between the JS app and the static fallback).
  private async extractSearchHits(page: Page): Promise<SearchHit[]> {
    return page.evaluate(() => {
      const out: { id: string; url: string; title: string }[] = [];
      const seen = new Set<string>();
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = (a as HTMLAnchorElement).href;
        const m = href.match(/craigslist\.org\/.*\/d\/[^/]+\/(\d+)\.html/);
        if (!m || seen.has(m[1])) return;
        const title = (a.textContent || '').trim();
        if (!title || title.length < 4) return; // skip icon/thumbnail anchors
        seen.add(m[1]);
        out.push({ id: m[1], url: href.split('?')[0], title });
      });
      return out;
    }).catch(() => []);
  }

  private async ingestPost(page: Page, hit: SearchHit, cfg: CraigslistConfig): Promise<void> {
    await page.goto(hit.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    const details = await page.evaluate(() => {
      const title = document.querySelector('#titletextonly')?.textContent?.trim() || '';
      const bodyEl = document.querySelector('#postingbody');
      let body = bodyEl?.textContent?.trim() || '';
      body = body.replace(/QR Code Link to This Post\s*/i, '').trim();
      const hood = document.querySelector('.postingtitletext small')?.textContent?.replace(/[()]/g, '').trim() || '';
      const postedAt = document.querySelector('time.date, time')?.getAttribute('datetime') || null;
      return { title, body, hood, postedAt };
    }).catch(() => ({ title: '', body: '', hood: '', postedAt: null as string | null }));

    // Phone: regex from the body (posters often include one for gigs).
    const phoneMatch = details.body.match(/(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
    const phone = phoneMatch ? phoneMatch[0].replace(/[^\d+]/g, '') : undefined;

    // Relay email: open the reply panel and grab the mailto (best-effort, short timeout).
    let relayEmail: string | undefined;
    try {
      const replyBtn = page.locator('button.reply-button, .reply-button, button:has-text("reply")').first();
      if (await replyBtn.count()) {
        await replyBtn.click({ timeout: 3000 });
        await page.waitForTimeout(1500);
        const mailto = await page.evaluate(() => {
          const a = document.querySelector('a[href^="mailto:"]') as HTMLAnchorElement | null;
          return a ? a.href.replace(/^mailto:/, '').split('?')[0] : null;
        });
        if (mailto && /@reply\.craigslist\.org$/i.test(mailto)) relayEmail = mailto;
      }
    } catch { /* reply panel blocked or changed — phone/notes still make a usable lead */ }

    await postLead({
      source: 'craigslist',
      sourceLeadId: hit.id,
      sourceUrl: hit.url,
      customerName: undefined, // CL posts are anonymous
      customerPhone: phone,
      customerEmail: relayEmail,
      service: details.title || hit.title,
      location: details.hood || cfg.city,
      notes: details.body.slice(0, 4000),
      sourcePayload: { postedAt: details.postedAt, city: cfg.city, category: cfg.category },
    });
  }
}
