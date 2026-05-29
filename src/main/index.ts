import { app, shell, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import { getToken, setToken, clearToken, verifyToken } from './auth';
import { heartbeat } from './heartbeat';
import { startChromeFor, stopChromeFor, listChromes, type PlatformId } from './chrome';
import { YelpWatcher } from './watchers/yelp';
import { ThumbtackWatcher } from './watchers/thumbtack';

let mainWindow: BrowserWindow | null = null;

// One watcher instance per source, lazily started after the user logs in.
const yelp = new YelpWatcher(19222);
const thumbtack = new ThumbtackWatcher(19223);

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
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w));

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
    const url = p === 'yelp' ? 'https://biz.yelp.com/login' : 'https://www.thumbtack.com/login';
    const r = startChromeFor(p, url);
    if ('error' in r) return { ok: false, error: r.error };
    return { ok: true, port: r.port };
  });
  ipcMain.handle('chrome:stop', async (_e, p: PlatformId['id']) => stopChromeFor(p));
  ipcMain.handle('chrome:list', async () => listChromes());

  // Watcher controls
  ipcMain.handle('watcher:yelp:set-biz', async (_e, encid: string) => yelp.setBiz(encid));
  ipcMain.handle('watcher:yelp:start', async () => yelp.start(30).then(() => ({ ok: true })).catch((e: Error) => ({ ok: false, error: e.message })));
  ipcMain.handle('watcher:yelp:stop', async () => yelp.stop());
  ipcMain.handle('watcher:thumbtack:start', async () => thumbtack.start(30).then(() => ({ ok: true })).catch((e: Error) => ({ ok: false, error: e.message })));
  ipcMain.handle('watcher:thumbtack:stop', async () => thumbtack.stop());
  ipcMain.handle('watcher:status', async () => ({
    yelp: { status: yelp.status, lastTick: yelp.lastTick, lastError: yelp.lastError },
    thumbtack: { status: thumbtack.status, lastTick: thumbtack.lastTick, lastError: thumbtack.lastError },
  }));

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  yelp.stop();
  thumbtack.stop();
  stopChromeFor('yelp');
  stopChromeFor('thumbtack');
  if (process.platform !== 'darwin') app.quit();
});
