import { app, shell, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import { getToken, setToken, clearToken, verifyToken } from './auth';
import { heartbeat } from './heartbeat';
import { startChromeFor, stopChromeFor, listChromes, makeHidden, showWindow, startUrlFor, type PlatformId } from './chrome';
import { YelpWatcher } from './watchers/yelp';
import { ThumbtackWatcher } from './watchers/thumbtack';
import { CraigslistWatcher, type CraigslistConfig } from './watchers/craigslist';
import { FacebookWatcher, type FacebookConfig } from './watchers/facebook';
import { CommandPoller } from './commandPoller';
import { cloudFetch } from './cloudClient';
import { initAutoUpdate } from './updater';
import { readFileSync, writeFileSync } from 'node:fs';

// Brand the app name early so the macOS menu + dock say "ReplyHawk Agent" (not "Electron")
// even in dev. (Packaged builds get this from productName; dev needs it set explicitly.)
app.setName('ReplyHawk Agent');

let mainWindow: BrowserWindow | null = null;

// One watcher instance per source, lazily started after the user logs in.
const yelp = new YelpWatcher(19222);
const thumbtack = new ThumbtackWatcher(19223);
const craigslist = new CraigslistWatcher(19224);
const facebook = new FacebookWatcher(19225);
// Polls the cloud for outbound reply commands and sends them via Chrome.
const poller = new CommandPoller({ yelp: 19222, thumbtack: 19223 });

// Watcher configs (Craigslist city/keywords, FB groups/keywords) persist across restarts.
function configPath(): string { return join(app.getPath('userData'), 'watcher-config.json'); }
function loadWatcherConfig(): { craigslist?: CraigslistConfig; facebook?: FacebookConfig } {
  try { return JSON.parse(readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function saveWatcherConfig(patch: { craigslist?: CraigslistConfig; facebook?: FacebookConfig }): void {
  try { writeFileSync(configPath(), JSON.stringify({ ...loadWatcherConfig(), ...patch }, null, 2)); } catch { /* noop */ }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 660,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.replyhawk.agent');
  // Show the ReplyHawk icon in the dock during dev (packaged build uses build/icon.icns).
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(join(__dirname, '../../resources/icon.png')); } catch { /* noop */ }
  }
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w));

  // Start automatically when the operator logs in, so a reboot doesn't silently
  // stop lead-watching. Only meaningful in the packaged app; harmless in dev.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false });
  }
  ipcMain.handle('app:get-login-item', async () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('app:set-login-item', async (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false });
    return app.getLoginItemSettings().openAtLogin;
  });

  // Auth
  ipcMain.handle('auth:get-token', async () => {
    const t = await getToken();
    return t ? { hasToken: true, preview: t.slice(0, 6) + '…' + t.slice(-2) } : { hasToken: false };
  });
  ipcMain.handle('auth:set-token', async (_e, token: string) => setToken(token));
  ipcMain.handle('auth:clear-token', async () => clearToken());
  ipcMain.handle('auth:verify-token', async (_e, token: string) => verifyToken(token));
  ipcMain.handle('cloud:heartbeat', async () => heartbeat());

  // Chrome connections (one persistent Chrome per source)
  ipcMain.handle('chrome:start', async (_e, p: PlatformId['id']) => {
    const r = startChromeFor(p, startUrlFor(p));
    if ('error' in r) return { ok: false, error: r.error };
    return { ok: true, port: r.port };
  });
  ipcMain.handle('chrome:stop', async (_e, p: PlatformId['id']) => stopChromeFor(p));
  ipcMain.handle('chrome:list', async () => listChromes());
  ipcMain.handle('chrome:hide', async (_e, p: PlatformId['id']) => makeHidden(p, startUrlFor(p)));
  ipcMain.handle('chrome:show', async (_e, p: PlatformId['id']) => showWindow(p, startUrlFor(p)));

  // Watcher controls
  ipcMain.handle('watcher:yelp:set-biz', async (_e, encid: string) => yelp.setBiz(encid));
  ipcMain.handle('watcher:yelp:detect', async () => yelp.detectBizEncid());
  ipcMain.handle('watcher:yelp:get-biz', async () => yelp.getBiz());
  ipcMain.handle('watcher:yelp:start', async () => {
    try {
      await yelp.start(30);
      poller.start(15); // start sending queued replies once we're watching
      const h = await makeHidden('yelp', startUrlFor('yelp'));
      if (!h.ok) console.warn('[yelp] makeHidden failed:', h.error);
      return { ok: true, bizEncid: yelp.getBiz(), hidden: h.ok };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  ipcMain.handle('watcher:yelp:stop', async () => yelp.stop());
  ipcMain.handle('watcher:yelp:poll-now', async () => yelp.pollNow());
  ipcMain.handle('watcher:yelp:sync-all', async () => yelp.syncAll());
  ipcMain.handle('watcher:yelp:log', async () => yelp.recent(10));
  ipcMain.handle('watcher:yelp:screenshot', async () => yelp.lastScreenshot ?? null);
  ipcMain.handle('watcher:thumbtack:start', async () => {
    try {
      await thumbtack.start(30);
      poller.start(15); // start sending queued replies once any watcher is running
      const h = await makeHidden('thumbtack', startUrlFor('thumbtack'));
      if (!h.ok) console.warn('[thumbtack] makeHidden failed:', h.error);
      return { ok: true, hidden: h.ok };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  ipcMain.handle('watcher:thumbtack:stop', async () => thumbtack.stop());
  ipcMain.handle('watcher:thumbtack:poll-now', async () => thumbtack.pollNow());
  ipcMain.handle('watcher:thumbtack:log', async () => thumbtack.recent(10));
  ipcMain.handle('watcher:thumbtack:screenshot', async () => thumbtack.lastScreenshot ?? null);

  // Craigslist — public listings, no login; config = city + keywords.
  ipcMain.handle('watcher:craigslist:get-config', async () => craigslist.getConfig() ?? loadWatcherConfig().craigslist ?? null);
  ipcMain.handle('watcher:craigslist:start', async (_e, cfg: CraigslistConfig) => {
    try {
      await craigslist.start(cfg, 300);
      saveWatcherConfig({ craigslist: cfg });
      const h = await makeHidden('craigslist', startUrlFor('craigslist'));
      if (!h.ok) console.warn('[craigslist] makeHidden failed:', h.error);
      return { ok: true, hidden: h.ok };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  ipcMain.handle('watcher:craigslist:stop', async () => craigslist.stop());
  ipcMain.handle('watcher:craigslist:poll-now', async () => craigslist.pollNow());
  ipcMain.handle('watcher:craigslist:log', async () => craigslist.recent(10));
  ipcMain.handle('watcher:craigslist:screenshot', async () => craigslist.lastScreenshot ?? null);

  // Facebook Groups — notify-only; config = group URLs + keywords. Requires the operator's
  // own FB login in the dedicated Chrome profile.
  ipcMain.handle('watcher:facebook:get-config', async () => facebook.getConfig() ?? loadWatcherConfig().facebook ?? null);
  ipcMain.handle('watcher:facebook:start', async (_e, cfg: FacebookConfig) => {
    try {
      await facebook.start(cfg, 300);
      saveWatcherConfig({ facebook: cfg });
      const h = await makeHidden('facebook', startUrlFor('facebook'));
      if (!h.ok) console.warn('[facebook] makeHidden failed:', h.error);
      return { ok: true, hidden: h.ok };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  ipcMain.handle('watcher:facebook:stop', async () => facebook.stop());
  ipcMain.handle('watcher:facebook:poll-now', async () => facebook.pollNow());
  ipcMain.handle('watcher:facebook:log', async () => facebook.recent(10));
  ipcMain.handle('watcher:facebook:screenshot', async () => facebook.lastScreenshot ?? null);

  ipcMain.handle('watcher:status', async () => ({
    yelp: { status: yelp.status, lastTick: yelp.lastTick, lastError: yelp.lastError },
    thumbtack: { status: thumbtack.status, lastTick: thumbtack.lastTick, lastError: thumbtack.lastError },
    craigslist: { status: craigslist.status, lastTick: craigslist.lastTick, lastError: craigslist.lastError },
    facebook: { status: facebook.status, lastTick: facebook.lastTick, lastError: facebook.lastError },
    poller: {
      status: poller.status, lastTick: poller.lastTick, lastError: poller.lastError,
      sentCount: poller.sentCount, failedCount: poller.failedCount, pendingCount: poller.pendingCount,
    },
  }));

  // Reply queue activity (recent send attempts) for the in-app panel.
  ipcMain.handle('poller:log', async () => poller.recent(12));

  // Read-only pipeline snapshot from the cloud (the "call queue" lives server-side:
  // ElevenLabs places the calls, so we surface stage counts + the call-relevant leads).
  ipcMain.handle('cloud:snapshot', async () => {
    try {
      const r = await cloudFetch('/api/leads?limit=200');
      if (!r.ok) return { ok: false as const, error: `GET leads ${r.status}` };
      const { leads } = (await r.json()) as {
        leads: Array<{ id: string; name?: string | null; source?: string | null; status: string; updatedAt?: string }>;
      };
      const counts: Record<string, number> = {};
      for (const l of leads) counts[l.status] = (counts[l.status] ?? 0) + 1;
      const pick = (statuses: string[]): Array<{ id: string; name: string; source: string; status: string }> =>
        leads.filter((l) => statuses.includes(l.status))
          .slice(0, 12)
          .map((l) => ({ id: l.id, name: l.name ?? 'Unknown', source: l.source ?? '—', status: l.status }));
      return {
        ok: true as const,
        counts,
        total: leads.length,
        // "Call queue": leads queued to be called (ready) or mid-call (calling).
        callQueue: pick(['ready', 'calling']),
      };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });

  createWindow();
  initAutoUpdate();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  yelp.stop();
  thumbtack.stop();
  craigslist.stop();
  facebook.stop();
  poller.stop();
  void stopChromeFor('yelp');
  void stopChromeFor('thumbtack');
  void stopChromeFor('craigslist');
  void stopChromeFor('facebook');
  if (process.platform !== 'darwin') app.quit();
});
