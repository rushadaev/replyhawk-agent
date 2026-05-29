// Launches the operator's system Chrome with a dedicated user-data-dir + remote-debugging-port.
// Each platform (yelp, thumbtack) gets its own profile so a Yelp ban can't cascade to Thumbtack.
// We then attach via Playwright over CDP — same trick as the original YELP/launch-chrome.sh.

import { app, shell } from 'electron';
import { spawn, ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { platform } from 'node:os';

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'],
};

function findChrome(): string | null {
  const list = CHROME_PATHS[platform()] ?? [];
  return list.find((p) => existsSync(p)) ?? null;
}

export interface PlatformId { id: 'yelp' | 'thumbtack' }

export interface RunningChrome {
  platform: PlatformId['id'];
  pid: number;
  port: number;
  proc: ChildProcess;
}

const running = new Map<PlatformId['id'], RunningChrome>();

// Pick a free port per platform so two Chromes can run side-by-side.
function portFor(p: PlatformId['id']): number {
  return p === 'yelp' ? 19222 : 19223;
}

function profileDirFor(p: PlatformId['id']): string {
  const dir = join(app.getPath('userData'), 'chrome-profiles', p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function startChromeFor(platform: PlatformId['id'], startUrl: string): RunningChrome | { error: string } {
  // Reuse existing instance if still alive
  const existing = running.get(platform);
  if (existing && !existing.proc.killed) return existing;

  const chrome = findChrome();
  if (!chrome) {
    return { error: 'Google Chrome is not installed. Install it from google.com/chrome and try again.' };
  }
  const port = portFor(platform);
  const profile = profileDirFor(platform);

  const proc = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=GoogleApiKeyConfigurationCheck',
    startUrl,
  ], { detached: false, stdio: 'ignore' });

  const ret: RunningChrome = { platform, pid: proc.pid ?? -1, port, proc };
  running.set(platform, ret);
  proc.on('exit', () => running.delete(platform));
  return ret;
}

export function stopChromeFor(platform: PlatformId['id']): void {
  const r = running.get(platform);
  if (!r) return;
  try { r.proc.kill(); } catch { /* noop */ }
  running.delete(platform);
}

export function listChromes(): Array<{ platform: PlatformId['id']; port: number; running: boolean }> {
  return (['yelp', 'thumbtack'] as const).map((p) => {
    const r = running.get(p);
    return { platform: p, port: portFor(p), running: !!r && !r.proc.killed };
  });
}

// Opens an external link the user clicks — used for "Help" buttons in the UI.
export function openExternal(url: string): void { void shell.openExternal(url); }
