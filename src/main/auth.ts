// Agent token storage. Encrypts via Electron's built-in safeStorage (macOS Keychain
// under the hood) and persists ciphertext to a 0600 file in userData. No native deps.
import { app, safeStorage } from 'electron';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { API_URL } from './config';

function tokenPath(): string {
  const dir = join(app.getPath('userData'), 'secure');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, 'agent-token.enc');
}

export async function getToken(): Promise<string | null> {
  const path = tokenPath();
  if (!existsSync(path)) return null;
  try {
    const buf = readFileSync(path);
    if (!safeStorage.isEncryptionAvailable()) {
      return buf.toString('utf8') || null;
    }
    return safeStorage.decryptString(buf) || null;
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  const path = tokenPath();
  const value = token.trim();
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(path, safeStorage.encryptString(value), { mode: 0o600 });
  } else {
    writeFileSync(path, value, { mode: 0o600 });
  }
}

export async function clearToken(): Promise<void> {
  const path = tokenPath();
  if (existsSync(path)) unlinkSync(path);
}

export async function verifyToken(token: string): Promise<{ ok: true; preview: unknown } | { ok: false; error: string }> {
  try {
    const r = await fetch(`${API_URL}/api/leads?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 401) return { ok: false, error: 'Token rejected (401). Make sure it matches the one on Railway.' };
    if (!r.ok) return { ok: false, error: `Cloud returned ${r.status}` };
    const j = await r.json();
    return { ok: true, preview: j };
  } catch (e) {
    return { ok: false, error: `Could not reach cloud: ${(e as Error).message}` };
  }
}
