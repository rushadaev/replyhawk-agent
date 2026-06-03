// Thin wrapper that attaches the agent token to every cloud request.
import { API_URL } from './config';
import { getToken } from './auth';

export async function cloudFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  if (!token) throw new Error('not_paired');
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
}

// Which sourceLeadIds does the cloud already have for this source/business?
export async function knownLeadIds(source: string): Promise<Set<string>> {
  const r = await cloudFetch(`/api/leads/known?source=${encodeURIComponent(source)}`);
  if (!r.ok) throw new Error(`GET known ${r.status}`);
  const { ids } = (await r.json()) as { ids: string[] };
  return new Set(ids);
}

export async function postLead(payload: Record<string, unknown>): Promise<{ id: string; duplicate: boolean }> {
  const r = await cloudFetch('/api/leads', { method: 'POST', body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`POST /api/leads ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { lead: { id: string }; duplicate?: boolean };
  return { id: j.lead.id, duplicate: !!j.duplicate };
}

export async function postEvent(
  leadId: string,
  body: { type: string; actor: string; message?: string; metadata?: Record<string, unknown> }
): Promise<void> {
  const r = await cloudFetch(`/api/leads/${leadId}/events`, { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST events ${r.status}: ${await r.text()}`);
}

export interface OutboundMessage {
  sender: 'customer' | 'business' | 'ai' | 'system';
  text: string;
  source?: string;
  sourceMessageId?: string;
  sentAt?: string;
}

// Bulk-push the conversation; cloud dedups on sourceMessageId so re-sending is safe.
export async function postMessages(leadId: string, messages: OutboundMessage[]): Promise<void> {
  if (!messages.length) return;
  const r = await cloudFetch(`/api/leads/${leadId}/messages`, { method: 'POST', body: JSON.stringify({ messages }) });
  if (!r.ok) throw new Error(`POST messages ${r.status}: ${await r.text()}`);
}
