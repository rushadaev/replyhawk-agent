// Facebook Groups watcher — NOTIFY-ONLY. Watches the operator's local community groups
// (their own logged-in session) for posts matching keywords like "recommend a contractor",
// and ingests each match as a lead so the owner gets pinged and replies AS THEMSELVES on
// Facebook within minutes.
//
// Deliberately read-only: the agent never posts, comments, or DMs on Facebook. Auto-posting
// from a personal account is the fastest way to get it restricted; speed-to-notification is
// the whole value here. The cloud's auto-reply is hard-gated to yelp/thumbtack, so nothing
// downstream can respond on FB either.

import { chromium, BrowserContext, Page } from 'playwright-core';
import { postLead, knownLeadIds } from '../cloudClient';
import type { PollLog } from './yelp';

export interface FacebookConfig {
  groupUrls: string[]; // full group URLs the operator is a member of
  keywords: string[];  // case-insensitive match against post text
}

interface FeedPost { id: string; url: string; text: string; author: string; group: string }

const INGEST_CAP = 6;

export class FacebookWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private config: FacebookConfig | null = null;
  readonly cdpPort: number;
  status: 'idle' | 'connecting' | 'watching' | 'error' = 'idle';
  lastError?: string;
  lastTick?: number;
  log: PollLog[] = [];
  lastScreenshot?: { at: number; b64: string };

  constructor(cdpPort: number) { this.cdpPort = cdpPort; }

  recent(n = 10): PollLog[] { return this.log.slice(0, n); }
  getConfig(): FacebookConfig | null { return this.config; }

  async pollNow(): Promise<{ ok: true; ingested: number; total: number } | { ok: false; error: string }> {
    try {
      const r = await this.pollOnce();
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async start(config: FacebookConfig, intervalSec = 300): Promise<void> {
    const groups = config.groupUrls.map((u) => u.trim()).filter(Boolean);
    if (!groups.length) throw new Error('Add at least one Facebook group URL.');
    if (!config.keywords.length) throw new Error('Add at least one keyword to match posts against.');
    this.config = { groupUrls: groups, keywords: config.keywords };
    if (this.timer) return;
    this.status = 'connecting';
    // Gentle cadence: each poll loads every group page; 5 min keeps the account boring.
    const ms = Math.max(120, intervalSec) * 1000;
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
    const kws = cfg.keywords.map((k) => k.toLowerCase());
    const matched = new Map<string, FeedPost>();
    let totalSeen = 0;
    let ingested = 0;

    await this.withContext(async (ctx) => {
      const page = await ctx.newPage();
      try {
        for (const groupUrl of cfg.groupUrls) {
          const base = groupUrl.replace(/\/+$/, '').split('?')[0];
          await page.goto(`${base}?sorting_setting=CHRONOLOGICAL`, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(3000);
          // A logged-out session lands on a login wall — tell the operator instead of silently
          // seeing zero posts forever.
          if (page.url().includes('/login')) throw new Error('Facebook session expired — click "Show window" and log in again.');
          // Nudge lazy-loading so the first handful of posts materialize.
          for (let i = 0; i < 3; i++) {
            await page.mouse.wheel(0, 1200).catch(() => undefined);
            await page.waitForTimeout(900);
          }
          const posts = await this.extractPosts(page);
          totalSeen += posts.length;
          for (const p of posts) {
            const t = p.text.toLowerCase();
            if (kws.some((k) => t.includes(k))) matched.set(p.id, p);
          }
        }

        try {
          await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
          const buf = await page.screenshot({ type: 'jpeg', quality: 40, fullPage: false });
          this.lastScreenshot = { at: Date.now(), b64: buf.toString('base64') };
        } catch { /* non-fatal */ }

        const known = await knownLeadIds('facebook').catch(() => new Set<string>());
        const fresh = [...matched.values()].filter((p) => !known.has(p.id)).slice(0, INGEST_CAP);
        for (const p of fresh) {
          // Notify-only lead: no phone/email/reply channel, so no automation can fire — the
          // cloud's new-lead notification is the product here.
          try {
            await postLead({
              source: 'facebook',
              sourceLeadId: p.id,
              sourceUrl: p.url,
              customerName: p.author || undefined,
              notes: `[${p.group}]\n\n${p.text.slice(0, 2500)}`,
              sourcePayload: { group: p.group, notifyOnly: true },
            });
            ingested++;
          } catch { /* skip one */ }
        }
      } finally {
        await page.close().catch(() => undefined);
      }
    });
    return { ingested, total: totalSeen };
  }

  // FB's DOM is obfuscated; anchor on role attributes (stable for accessibility) and post
  // permalinks (/groups/<g>/posts|permalink/<id>) rather than class names.
  private async extractPosts(page: Page): Promise<FeedPost[]> {
    const group = (await page.title().catch(() => ''))?.replace(/\s*\|\s*Facebook.*$/i, '').trim() || 'Facebook group';
    const raw = await page.evaluate(() => {
      const out: { id: string; url: string; text: string; author: string }[] = [];
      const seen = new Set<string>();
      document.querySelectorAll('[role="article"]').forEach((art) => {
        const link = Array.from(art.querySelectorAll('a[href]'))
          .map((a) => (a as HTMLAnchorElement).href)
          .find((h) => /\/groups\/[^/]+\/(posts|permalink)\/(\d+|pfbid\w+)/.test(h));
        if (!link) return;
        const m = link.match(/\/(posts|permalink)\/(\d+|pfbid\w+)/);
        const id = m ? m[2] : link;
        if (seen.has(id)) return;
        const text = (art as HTMLElement).innerText?.trim() || '';
        if (text.length < 20) return; // skip stubs/loading shells
        // The author's profile link is typically the first link with plain text in the article.
        const author = Array.from(art.querySelectorAll('a[role="link"]'))
          .map((a) => (a as HTMLElement).innerText?.trim())
          .find((t) => t && t.length > 1 && t.length < 60) || '';
        seen.add(id);
        out.push({ id, url: link.split('?')[0], text: text.slice(0, 4000), author });
      });
      return out;
    }).catch(() => [] as { id: string; url: string; text: string; author: string }[]);
    return raw.map((r) => ({ ...r, group }));
  }
}
