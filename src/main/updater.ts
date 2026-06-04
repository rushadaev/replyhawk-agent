// Auto-update via electron-updater + GitHub Releases.
// On launch (and every 6h) the app checks the latest GitHub release for replyhawk-agent,
// downloads a newer signed build in the background, and installs it on the next quit.
// Requires the releases to be readable — publish to a PUBLIC repo/release.

import { app } from 'electron';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

export function initAutoUpdate(): void {
  // Don't run the updater in dev (no packaged app to replace).
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const check = () => { autoUpdater.checkForUpdatesAndNotify().catch(() => undefined); };

  autoUpdater.on('update-available', (i) => console.log('[updater] update available:', i.version));
  autoUpdater.on('update-downloaded', (i) => console.log('[updater] downloaded', i.version, '— will install on quit'));
  autoUpdater.on('error', (e) => console.warn('[updater] error:', e?.message));

  check();
  setInterval(check, 6 * 60 * 60 * 1000); // every 6 hours
}
