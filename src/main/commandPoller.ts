// Polls the cloud for pending reply commands and executes them via the operator's Chrome.
// Cloud enqueues a reply (AI-drafted or operator-typed); this picks it up, sends it on
// the right platform, and reports the result back.

import { cloudFetch } from './cloudClient';
import { sendYelpReply } from './senders/yelp';
import { sendThumbtackReply } from './senders/thumbtack';

interface ReplyCommand {
  id: string;
  leadId: string;
  source: 'yelp' | 'thumbtack';
  sourceUrl: string | null;
  text: string;
}

// One row in the reply-queue activity feed shown in the app.
export interface PollerLogEntry {
  at: number;
  leadId: string;
  source: 'yelp' | 'thumbtack' | string;
  status: 'sent' | 'failed';
  text: string; // short preview of what we sent
  error?: string;
}

export class CommandPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  status: 'idle' | 'polling' | 'error' = 'idle';
  lastError?: string;
  lastTick?: number;
  sentCount = 0;
  failedCount = 0;
  pendingCount = 0; // how many were waiting in the queue on the last poll
  private logEntries: PollerLogEntry[] = []; // newest-first ring buffer

  // Resolve the right CDP port per platform (matches chrome.ts portFor()).
  constructor(private ports: { yelp: number; thumbtack: number }) {}

  /** Most recent send attempts (newest first) for the in-app reply-queue panel. */
  recent(n = 10): PollerLogEntry[] {
    return this.logEntries.slice(0, n);
  }

  private record(e: PollerLogEntry): void {
    this.logEntries.unshift(e);
    if (this.logEntries.length > 50) this.logEntries.length = 50;
  }

  start(intervalSec = 15): void {
    if (this.timer) return;
    const ms = Math.max(8, intervalSec) * 1000;
    const tick = async (): Promise<void> => {
      if (this.running) return; // don't overlap
      this.running = true;
      try {
        await this.pollOnce();
        this.status = 'polling';
        this.lastTick = Date.now();
        this.lastError = undefined;
      } catch (e) {
        this.status = 'error';
        this.lastError = (e as Error).message;
      } finally {
        this.running = false;
      }
    };
    void tick();
    this.timer = setInterval(tick, ms);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status = 'idle';
  }

  private async report(id: string, status: 'sending' | 'sent' | 'failed', error?: string): Promise<void> {
    await cloudFetch(`/api/agent/commands/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, error }),
    }).catch(() => undefined);
  }

  private async pollOnce(): Promise<void> {
    const r = await cloudFetch('/api/agent/commands');
    if (!r.ok) throw new Error(`GET commands ${r.status}`);
    const { commands } = (await r.json()) as { commands: ReplyCommand[] };
    this.pendingCount = commands.length;
    if (commands.length) console.log(`[poller] ${commands.length} pending reply command(s)`);
    for (const cmd of commands) {
      console.log(`[poller] sending ${cmd.source} reply for lead ${cmd.leadId} → ${cmd.sourceUrl}`);
      if (!cmd.sourceUrl) {
        await this.report(cmd.id, 'failed', 'no sourceUrl');
        this.failedCount++;
        this.record({ at: Date.now(), leadId: cmd.leadId, source: cmd.source, status: 'failed', text: cmd.text.slice(0, 80), error: 'no sourceUrl' });
        continue;
      }
      await this.report(cmd.id, 'sending');
      let result: { ok: true } | { ok: false; error: string };
      if (cmd.source === 'yelp') {
        result = await sendYelpReply(this.ports.yelp, cmd.sourceUrl, cmd.text);
      } else if (cmd.source === 'thumbtack') {
        result = await sendThumbtackReply(this.ports.thumbtack, cmd.sourceUrl, cmd.text);
      } else {
        result = { ok: false, error: `sender for ${cmd.source} not implemented yet` };
      }
      if (result.ok) {
        console.log(`[poller] ✓ sent ${cmd.id}`);
        await this.report(cmd.id, 'sent');
        this.sentCount++;
        this.record({ at: Date.now(), leadId: cmd.leadId, source: cmd.source, status: 'sent', text: cmd.text.slice(0, 80) });
      } else {
        console.warn(`[poller] ✗ failed ${cmd.id}: ${result.error}`);
        await this.report(cmd.id, 'failed', result.error);
        this.failedCount++;
        this.record({ at: Date.now(), leadId: cmd.leadId, source: cmd.source, status: 'failed', text: cmd.text.slice(0, 80), error: result.error });
      }
    }
  }
}
