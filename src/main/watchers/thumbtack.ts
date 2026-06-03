// Thumbtack pro-inbox watcher. Same pattern as the Yelp watcher: polls every N seconds,
// diffs against in-memory snapshot, forwards new threads or new customer messages.

import { chromium, BrowserContext, Page } from 'playwright-core';
import { extractThumbtackLead, ThumbtackLead } from '../extractors/thumbtack';
import { postLead, postEvent, postMessages, knownLeadIds } from '../cloudClient';

export interface ThumbtackLog { at: number; ingested: number; total: number; note?: string }

export class ThumbtackWatcher {
  private timer: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  readonly cdpPort: number;
  status: 'idle' | 'connecting' | 'watching' | 'error' = 'idle';
  lastError?: string;
  lastTick?: number;
  log: ThumbtackLog[] = [];

  lastScreenshot?: { at: number; b64: string };

  recent(n = 10): ThumbtackLog[] { return this.log.slice(0, n); }

  async pollNow(): Promise<{ ok: true; ingested: number; total: number } | { ok: false; error: string }> {
    try {
      const r = await this.pollOnceWithResult();
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // Force-ingest every thread in the inbox, ignoring the seen-set. Cloud dedups.
  async syncAll(): Promise<{ ok: true; ingested: number; total: number } | { ok: false; error: string }> {
    try {
      this.seen.clear();          // forget everything so pollOnce treats all as new…
      // …but pollOnce skips first-run; prime seen as "non-empty" by ingesting directly:
      let ingested = 0; let total = 0;
      await this.withContext(async (ctx) => {
        const page = await ctx.newPage();
        try {
          await page.goto('https://www.thumbtack.com/pro-inbox/', { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(3000);
          const ids: string[] = await page.evaluate(() => {
            const out = new Set<string>();
            for (const a of Array.from(document.querySelectorAll('a[href]'))) {
              const m = (a.getAttribute('href') ?? '').match(/\/pro-inbox\/messages\/(\d+)/);
              if (m) out.add(m[1]);
            }
            return Array.from(out);
          });
          total = ids.length;
          for (const id of ids) {
            this.seen.add(id);
            try { await this.ingestOne(page, id); ingested++; } catch { /* skip */ }
          }
        } finally {
          await page.close().catch(() => undefined);
        }
      });
      this.log.unshift({ at: Date.now(), ingested, total, note: `Synced all (${ingested}/${total})` });
      return { ok: true, ingested, total };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  constructor(cdpPort: number) { this.cdpPort = cdpPort; }

  async start(intervalSec = 30): Promise<void> {
    if (this.timer) return;
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

  private async pollOnceWithResult(): Promise<{ ingested: number; total: number }> {
    let ingested = 0; let total = 0;
    await this.withContext(async (ctx) => {
      const page = await ctx.newPage();
      try {
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
        total = ids.length;

        // Capture a screenshot of the inbox for the UI.
        try {
          await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
          const buf = await page.screenshot({ type: 'jpeg', quality: 40, fullPage: false });
          this.lastScreenshot = { at: Date.now(), b64: buf.toString('base64') };
        } catch (e) {
          console.warn('[thumbtack] screenshot failed:', (e as Error).message);
        }

        // Reconcile against the cloud: ingest any thread the cloud doesn't have yet.
        // Self-healing — no first-run skip, survives restarts.
        const known = await knownLeadIds('thumbtack').catch(() => new Set<string>());
        const missing = ids.filter((id) => !known.has(id));
        for (const id of missing) {
          try { await this.ingestOne(page, id); ingested++; }
          catch (e) { console.error('thumbtack ingest failed', id, (e as Error).message); }
        }
      } finally {
        await page.close().catch(() => undefined);
      }
    });
    return { ingested, total };
  }

  private async ingestOne(page: Page, bidPk: string): Promise<void> {
    const url = `https://www.thumbtack.com/pro-inbox/messages/${bidPk}`;
    const captured: { stream: { messages?: unknown[] } | null } = { stream: null };
    const listener = async (resp: import('playwright-core').Response): Promise<void> => {
      if (resp.url().includes('about:blank')) return;
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
    if (lead.messages.length) {
      await postMessages(posted.id, lead.messages.map((m) => ({
        sender: m.sender, text: m.text, source: 'thumbtack',
        sourceMessageId: m.id, sentAt: m.createdAt ?? undefined,
      })).filter((m) => m.text)).catch(() => undefined);
    }
    const lastCustomer = [...lead.messages].reverse().find((m) => m.sender === 'customer');
    if (lastCustomer && !posted.duplicate) {
      await postEvent(posted.id, {
        type: 'message_received', actor: 'thumbtack_watcher',
        message: lastCustomer.text, metadata: { at: lastCustomer.createdAt },
      });
    }
  }
}
