// Lightweight liveness ping to the cloud — proves our token still works and the cloud
// notices this agent is alive (lastSeenAt updates server-side).
import { API_URL } from './config';
import { getToken } from './auth';

export type Heartbeat =
  | { ok: true; ts: number }
  | { ok: false; reason: 'no_token' | 'unauthorized' | 'unreachable'; detail?: string };

export async function heartbeat(): Promise<Heartbeat> {
  const token = await getToken();
  if (!token) return { ok: false, reason: 'no_token' };
  try {
    const r = await fetch(`${API_URL}/api/leads?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 401) return { ok: false, reason: 'unauthorized' };
    if (!r.ok) return { ok: false, reason: 'unreachable', detail: `HTTP ${r.status}` };
    return { ok: true, ts: Date.now() };
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: (e as Error).message };
  }
}
