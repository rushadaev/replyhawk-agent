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
