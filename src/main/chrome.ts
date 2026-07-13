// Launches the operator's system Chrome with a dedicated user-data-dir + remote-debugging-port.
// Each platform (yelp, thumbtack) gets its own profile so a Yelp ban can't cascade to Thumbtack.
// We then attach via Playwright over CDP — same trick as the original YELP/launch-chrome.sh.

import { app, shell } from 'electron';
import { spawn, ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
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

export interface PlatformId { id: 'yelp' | 'thumbtack' | 'craigslist' | 'facebook' }

export interface RunningChrome {
  platform: PlatformId['id'];
  pid: number;
  port: number;
  proc: ChildProcess;
  hidden: boolean;
}

const running = new Map<PlatformId['id'], RunningChrome>();

async function waitForCdpReady(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  return false;
}

async function waitForProcExit(proc: ChildProcess, timeoutMs = 8_000): Promise<void> {
  if (proc.exitCode != null) return;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(), timeoutMs);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

// Pick a free port per platform so multiple Chromes can run side-by-side.
const PORTS: Record<PlatformId['id'], number> = { yelp: 19222, thumbtack: 19223, craigslist: 19224, facebook: 19225 };
function portFor(p: PlatformId['id']): number {
  return PORTS[p];
}

function profileDirFor(p: PlatformId['id']): string {
  const dir = join(app.getPath('userData'), 'chrome-profiles', p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Chrome leaves a SingletonLock file in user-data-dir while running. If a previous
// process died ungracefully (crash, force-kill), the lock survives and the next
// launch silently fails. Clean stale locks before spawning.
function cleanProfileLocks(profile: string): void {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = join(profile, f);
    try { if (existsSync(p)) unlinkSync(p); } catch { /* noop */ }
  }
}

export function startChromeFor(
  platform: PlatformId['id'],
  startUrl: string,
  opts: { hidden?: boolean } = {},
): RunningChrome | { error: string } {
  const existing = running.get(platform);
  if (existing && !existing.proc.killed) return existing;

  const chrome = findChrome();
  if (!chrome) {
    return { error: 'Google Chrome is not installed. Install it from google.com/chrome and try again.' };
  }
  const port = portFor(platform);
  const profile = profileDirFor(platform);
  cleanProfileLocks(profile);
  const hidden = !!opts.hidden;

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (hidden) {
    // True headless mode (Chrome 109+). Same renderer as visible Chrome, no window,
    // no dock icon, no focus stealing. Stealth flag masks navigator.webdriver.
    args.push('--headless=new', '--disable-blink-features=AutomationControlled');
  } else {
    args.push(startUrl);
  }

  const proc = spawn(chrome, args, { detached: false, stdio: 'ignore' });

  const ret: RunningChrome = { platform, pid: proc.pid ?? -1, port, proc, hidden };
  running.set(platform, ret);
  proc.on('exit', () => running.delete(platform));
  return ret;
}

export async function stopChromeFor(platform: PlatformId['id']): Promise<void> {
  const r = running.get(platform);
  if (!r) return;
  try { r.proc.kill(); } catch { /* noop */ }
  await waitForProcExit(r.proc);
  running.delete(platform);
}

// Restart Chrome in hidden mode. Keeps the same user-data-dir so the operator's login
// session survives. Used after the watcher starts so the user no longer sees polling.
export async function makeHidden(platform: PlatformId['id'], startUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await stopChromeFor(platform);
  // Brief settle so user-data-dir lock releases
  await new Promise((res) => setTimeout(res, 500));
  const r = startChromeFor(platform, startUrl, { hidden: true });
  if ('error' in r) return { ok: false, error: r.error };
  const ready = await waitForCdpReady(r.port);
  return ready ? { ok: true } : { ok: false, error: 'Hidden Chrome did not come up in time' };
}

// Restart Chrome visibly. Use for re-login / pause-and-show.
export async function showWindow(platform: PlatformId['id'], startUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await stopChromeFor(platform);
  await new Promise((res) => setTimeout(res, 500));
  const r = startChromeFor(platform, startUrl, { hidden: false });
  if ('error' in r) return { ok: false, error: r.error };
  const ready = await waitForCdpReady(r.port);
  return ready ? { ok: true } : { ok: false, error: 'Chrome did not come up in time' };
}

export function isHidden(platform: PlatformId['id']): boolean {
  return !!running.get(platform)?.hidden;
}

export function listChromes(): Array<{ platform: PlatformId['id']; port: number; running: boolean; hidden: boolean }> {
  return (['yelp', 'thumbtack', 'craigslist', 'facebook'] as const).map((p) => {
    const r = running.get(p);
    return { platform: p, port: portFor(p), running: !!r && !r.proc.killed, hidden: !!r?.hidden };
  });
}

const START_URLS: Record<PlatformId['id'], string> = {
  yelp: 'https://biz.yelp.com/login',
  thumbtack: 'https://www.thumbtack.com/login',
  craigslist: 'https://www.craigslist.org', // geo-redirects to the local site; no login needed
  facebook: 'https://www.facebook.com',
};
export function startUrlFor(platform: PlatformId['id']): string {
  return START_URLS[platform];
}

// Opens an external link the user clicks — used for "Help" buttons in the UI.
export function openExternal(url: string): void { void shell.openExternal(url); }
