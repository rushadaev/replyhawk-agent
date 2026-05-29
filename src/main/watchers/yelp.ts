// Yelp Biz watcher. Polls the operator's logged-in Chrome (CDP attach) every 30s,
// detects new leads + new customer messages, forwards them to the ReplyHawk cloud.
//
// Lifecycle: agent.connect('yelp') launches Chrome (user logs in once). After that
// watchYelp() can be turned on; it runs in the main process indefinitely until paused.

import { chromium, BrowserContext } from 'playwright-core';
import { extractInbox, extractMessages, extractLeadDetails, type YelpInboxItem } from '../extractors/yelp';
import { postLead, postEvent } from '../cloudClient';

interface SnapshotEntry { encid: string; lastEventTime: string | null }

export class YelpWatcher {
  private timer: NodeJS.Timeout | null = null;
  private snapshot = new Map<string, SnapshotEntry>();
  private bizEncid: string | null = null;
  readonly cdpPort: number;
  status: 'idle' | 'connecting' | 'watching' | 'error' = 'idle';
  lastError?: string;
  lastTick?: number;

  constructor(cdpPort: number) { this.cdpPort = cdpPort; }

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
      try { await this.pollOnce(); this.status = 'watching'; this.lastTick = Date.now(); }
      catch (e) { this.status = 'error'; this.lastError = (e as Error).message; }
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

  private async pollOnce(): Promise<void> {
    if (!this.bizEncid) return;
    await this.withContext(async (ctx) => {
      const page = await ctx.newPage();
      await page.goto(`https://biz.yelp.com/leads_center/${this.bizEncid}/leads`, { waitUntil: 'domcontentloaded' });
      const state = await page.evaluate(() => (window as unknown as { yelp?: { react_apollo_state?: Record<string, unknown> } }).yelp?.react_apollo_state || null);
      await page.close();
      if (!state) throw new Error('Apollo state not found — login expired?');
      const items = extractInbox(state as Record<string, Record<string, unknown>>, this.bizEncid!);
      const changed: YelpInboxItem[] = [];
      for (const it of items) {
        const prev = this.snapshot.get(it.leadEncid);
        if (!prev) changed.push(it);
        else if (prev.lastEventTime !== it.lastEventTime && it.latestIsCustomer) changed.push(it);
        this.snapshot.set(it.leadEncid, { encid: it.leadEncid, lastEventTime: it.lastEventTime });
      }
      for (const it of changed) {
        await this.ingestLead(ctx, it);
      }
    });
  }

  private async ingestLead(ctx: BrowserContext, it: YelpInboxItem): Promise<void> {
    const page = await ctx.newPage();
    await page.goto(it.url, { waitUntil: 'domcontentloaded' });
    const state = await page.evaluate(() => (window as unknown as { yelp?: { react_apollo_state?: Record<string, unknown> } }).yelp?.react_apollo_state || null);
    await page.close();
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
