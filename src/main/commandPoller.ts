// Polls the cloud for pending reply commands and executes them via the operator's Chrome.
// Cloud enqueues a reply (AI-drafted or operator-typed); this picks it up, sends it on
// the right platform, and reports the result back.

import { cloudFetch } from './cloudClient';
import { sendYelpReply } from './senders/yelp';

interface ReplyCommand {
  id: string;
  leadId: string;
  source: 'yelp' | 'thumbtack';
  sourceUrl: string | null;
  text: string;
}

export class CommandPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  status: 'idle' | 'polling' | 'error' = 'idle';
  lastError?: string;
  lastTick?: number;
  sentCount = 0;

  // Resolve the right CDP port per platform (matches chrome.ts portFor()).
  constructor(private ports: { yelp: number; thumbtack: number }) {}

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
    for (const cmd of commands) {
      if (!cmd.sourceUrl) { await this.report(cmd.id, 'failed', 'no sourceUrl'); continue; }
      await this.report(cmd.id, 'sending');
      let result: { ok: true } | { ok: false; error: string };
      if (cmd.source === 'yelp') {
        result = await sendYelpReply(this.ports.yelp, cmd.sourceUrl, cmd.text);
      } else {
        result = { ok: false, error: `sender for ${cmd.source} not implemented yet` };
      }
      if (result.ok) { await this.report(cmd.id, 'sent'); this.sentCount++; }
      else { await this.report(cmd.id, 'failed', result.error); }
    }
  }
}
