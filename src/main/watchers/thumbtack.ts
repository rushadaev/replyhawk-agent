// Thumbtack pro-inbox watcher. Same pattern as the Yelp watcher: polls every N seconds,
// diffs against in-memory snapshot, forwards new threads or new customer messages.

import { chromium, BrowserContext, Page } from 'playwright-core';
import { extractThumbtackLead, ThumbtackLead } from '../extractors/thumbtack';
import { postLead, postEvent } from '../cloudClient';

export class ThumbtackWatcher {
  private timer: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  readonly cdpPort: number;
  status: 'idle' | 'connecting' | 'watching' | 'error' = 'idle';
  lastError?: string;
  lastTick?: number;

  constructor(cdpPort: number) { this.cdpPort = cdpPort; }

  async start(intervalSec = 30): Promise<void> {
    if (this.timer) return;
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
    await this.withContext(async (ctx) => {
      const page = await ctx.newPage();
      await page.goto('https://www.thumbtack.com/pro-inbox/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const ids: string[] = await page.evaluate(() => {
        const out = new Set<string>();
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          const h = a.getAttribute('href') ?? '';
          const m = h.match(/\/pro-inbox\/messages\/(\d+)/);
          if (m) out.add(m[1]);
        }
        return Array.from(out);
      });
      await page.close();
      const newOnes = ids.filter((id) => !this.seen.has(id));
      for (const id of newOnes) {
        try { await this.ingestOne(ctx, id); this.seen.add(id); }
        catch (e) { console.error('thumbtack ingest failed', id, (e as Error).message); }
      }
    });
  }

  private async ingestOne(ctx: BrowserContext, bidPk: string): Promise<void> {
    const url = `https://www.thumbtack.com/pro-inbox/messages/${bidPk}`;
    const page: Page = await ctx.newPage();
    const captured: { stream: { messages?: unknown[] } | null } = { stream: null };
    const listener = async (resp: import('playwright-core').Response): Promise<void> => {
      if (!/app\.thumbtack\.com\/graphql/.test(resp.url())) return;
      try {
        const req = JSON.parse(resp.request().postData() || '{}') as { operationName?: string };
        if (req.operationName === 'MessengerStreamQuery') {
          const j = (await resp.json()) as { data?: { messengerStream?: { messages?: unknown[] } } };
          captured.stream = j.data?.messengerStream ?? null;
        }
      } catch { /* noop */ }
    };
    page.on('response', listener);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    const panel: string | null = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
      const el = all.find((e) => e.textContent?.trim().startsWith('Property type'));
      if (!el) return null;
      let node: HTMLElement = el;
      for (let i = 0; i < 8 && node.parentElement; i++) {
        const sib = node.parentElement;
        if (/Show map|As recommended|Click to show phone|Project type:|Property type/.test(sib.innerText || '')
            && sib.innerText.length > 100 && sib.innerText.length < 4000) {
          node = sib; continue;
        }
        break;
      }
      return node.innerText ?? null;
    });
    page.off('response', listener);
    await page.close();
    if (!captured.stream) return;
    const lead: ThumbtackLead = extractThumbtackLead({ stream: captured.stream as Parameters<typeof extractThumbtackLead>[0]['stream'], panel, bidPk, url });

    const posted = await postLead({
      source: 'thumbtack',
      sourceLeadId: lead.sourceLeadId,
      sourceUrl: lead.sourceUrl,
      customerName: lead.customerName,
      customerPhone: lead.customerPhone,
      service: lead.service,
      location: lead.location,
      notes: lead.notes,
      sourcePayload: { panelFields: lead.panelFields, messageCount: lead.messages.length },
    });
    const lastCustomer = [...lead.messages].reverse().find((m) => m.sender === 'customer');
    if (lastCustomer && !posted.duplicate) {
      await postEvent(posted.id, {
        type: 'message_received', actor: 'thumbtack_watcher',
        message: lastCustomer.text, metadata: { at: lastCustomer.createdAt },
      });
    }
  }
}
