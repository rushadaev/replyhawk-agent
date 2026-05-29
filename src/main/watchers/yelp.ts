// Yelp Biz watcher. Polls the operator's logged-in Chrome (CDP attach) every 30s,
// detects new leads + new customer messages, forwards them to the ReplyHawk cloud.
//
// Lifecycle: agent.connect('yelp') launches Chrome (user logs in once). After that
// watchYelp() can be turned on; it runs in the main process indefinitely until paused.

import { chromium, BrowserContext, Page } from 'playwright-core';
import { extractInbox, extractMessages, extractLeadDetails, type YelpInboxItem } from '../extractors/yelp';
import { postLead, postEvent } from '../cloudClient';

interface SnapshotEntry { encid: string; lastEventTime: string | null }

export interface PollLog { at: number; ingested: number; total: number; note?: string }

export class YelpWatcher {
  private timer: NodeJS.Timeout | null = null;
  private snapshot = new Map<string, SnapshotEntry>();
  private bizEncid: string | null = null;
  readonly cdpPort: number;
  status: 'idle' | 'connecting' | 'watching' | 'error' = 'idle';
  lastError?: string;
  lastTick?: number;
  log: PollLog[] = [];

  constructor(cdpPort: number) { this.cdpPort = cdpPort; }

  recent(n = 10): PollLog[] { return this.log.slice(0, n); }

  // Manual one-shot poll, used by the "Poll now" button.
  async pollNow(): Promise<{ ok: true; ingested: number; total: number } | { ok: false; error: string }> {
    try {
      if (!this.bizEncid) {
        const d = await this.detectBizEncid();
        if (!d) throw new Error('No Yelp tab found — open biz.yelp.com first');
        this.bizEncid = d;
      }
      const result = await this.pollOnceWithResult();
      return { ok: true, ingested: result.ingested, total: result.total };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  setBiz(encid: string): void { this.bizEncid = encid; }
  getBiz(): string | null { return this.bizEncid; }

  // Inspect every tab in the attached Chrome and pull the encid out of any
  // biz.yelp.com URL — works whether the operator is on /home/<id>/, /leads_center/<id>/, etc.
  async detectBizEncid(): Promise<string | null> {
    try {
      return await this.withContext(async (ctx) => {
        for (const p of ctx.pages()) {
          const u = p.url();
          const m = u.match(/biz\.yelp\.com\/(?:home|leads_center|reviews|inbox)\/([A-Za-z0-9_-]{20,})/);
          if (m) return m[1];
        }
        return null;
      });
    } catch {
      return null;
    }
  }

  async start(intervalSec = 30): Promise<void> {
    if (this.timer) return;
    if (!this.bizEncid) {
      const detected = await this.detectBizEncid();
      if (!detected) throw new Error('Could not find a logged-in Yelp Biz tab. Sign in once in the opened Chrome window.');
      this.bizEncid = detected;
    }
    this.status = 'connecting';
    const ms = Math.max(15, intervalSec) * 1000;
    const tick = async (): Promise<void> => {
      try {
        const r = await this.pollOnceWithResult();
        this.status = 'watching';
        this.lastTick = Date.now();
        this.lastError = undefined;
        this.log.unshift({ at: this.lastTick, ingested: r.ingested, total: r.total });
        if (this.log.length > 50) this.log.length = 50;
      } catch (e) {
        this.status = 'error';
        this.lastError = (e as Error).message;
        this.log.unshift({ at: Date.now(), ingested: 0, total: 0, note: `ERROR: ${this.lastError}` });
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
    const browser = await chromium.connectOverCDP(`http://localhost:${this.cdpPort}`);
    try {
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      return await fn(ctx);
    } finally {
      await browser.close();
    }
  }

  // Wrapper so both the interval tick and the manual "Poll now" share the same body.
  private async pollOnceWithResult(): Promise<{ ingested: number; total: number }> {
    let ingested = 0; let total = 0;
    await this.pollOnceInternal((n, t) => { ingested = n; total = t; });
    return { ingested, total };
  }

  private async pollOnceInternal(report: (ingested: number, total: number) => void): Promise<void> {
    if (!this.bizEncid) return;
    await this.withContext(async (ctx) => {
      // Reuse one background tab for the entire poll cycle to avoid spawning
      // dozens of visible tabs on first run.
      const page = await ctx.newPage();
      try {
        await page.goto(`https://biz.yelp.com/leads_center/${this.bizEncid}/leads`, { waitUntil: 'domcontentloaded' });
        const state = await page.evaluate(() => (window as unknown as { yelp?: { react_apollo_state?: Record<string, unknown> } }).yelp?.react_apollo_state || null);
        if (!state) throw new Error('Apollo state not found — login expired?');
        const items = extractInbox(state as Record<string, Record<string, unknown>>, this.bizEncid!);
        const isFirstRun = this.snapshot.size === 0;
        const changed: YelpInboxItem[] = [];
        for (const it of items) {
          const prev = this.snapshot.get(it.leadEncid);
          if (!prev) changed.push(it);
          else if (prev.lastEventTime !== it.lastEventTime && it.latestIsCustomer) changed.push(it);
          this.snapshot.set(it.leadEncid, { encid: it.leadEncid, lastEventTime: it.lastEventTime });
        }
        report(isFirstRun ? 0 : changed.length, items.length);
        if (isFirstRun) return;
        for (const it of changed) {
          await this.ingestLead(page, it);
        }
      } finally {
        await page.close().catch(() => undefined);
      }
    });
  }

  private async ingestLead(page: Page, it: YelpInboxItem): Promise<void> {
    await page.goto(it.url, { waitUntil: 'domcontentloaded' });
    const state = await page.evaluate(() => (window as unknown as { yelp?: { react_apollo_state?: Record<string, unknown> } }).yelp?.react_apollo_state || null);
    if (!state) return;
    const s = state as Record<string, Record<string, unknown>>;
    const details = extractLeadDetails(s);
    const messages = extractMessages(s);
    const lastCustomer = [...messages].reverse().find((m) => m.sender === 'customer');

    const lead = await postLead({
      source: 'yelp',
      sourceLeadId: it.leadEncid,
      sourceUrl: it.url,
      customerName: details.customerName,
      customerPhone: details.customerPhone,
      customerEmail: details.customerEmail,
      service: details.service ?? it.projectCategory ?? undefined,
      location: details.location,
      notes: details.notes || it.previewText,
      sourcePayload: { inboxItem: it, urgency: details.urgency, communicationPreference: details.communicationPreference },
    });
    if (lastCustomer && !lead.duplicate) {
      await postEvent(lead.id, {
        type: 'message_received', actor: 'yelp_watcher',
        message: lastCustomer.text ?? undefined, metadata: { sender: lastCustomer.sender, at: lastCustomer.createdAt },
      });
    }
  }
}
