'use strict';
// Auto-update from GitHub Releases (electron-updater), only for the Windows installer and the Linux AppImage: the
// portable exe, the .deb and `npm start` have nothing to update in place. Checks on start and every 6 hours and
// downloads in the background; the update installs when the app quits, or straight away from the notification.
const path = require('path');
const { app, Notification } = require('electron');
const log = require('./log');

let started = false;

// electron-updater's errors can carry a whole HTTP response.
const short = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 300);

function init() {
  if (started || !app.isPackaged) return;
  if (process.env.PORTABLE_EXECUTABLE_DIR) { log.info('update', 'portable build: auto-update is off (download new versions from GitHub)'); return; }
  if (process.platform === 'linux' && !process.env.APPIMAGE) { log.info('update', 'not an AppImage: auto-update is off (update with your package manager)'); return; }
  if (process.platform !== 'win32' && process.platform !== 'linux') return;
  started = true;

  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = { info: (m) => log.info('update', m), warn: (m) => log.warn('update', m), error: (m) => log.warn('update', short(m)), debug: () => {} };
  autoUpdater.allowPrerelease = false;

  let notified = null;
  autoUpdater.on('error', (e) => log.warn('update', `update check failed: ${short(e)}`));
  autoUpdater.on('update-available', (u) => log.info('update', `update ${u.version} available, downloading`));
  autoUpdater.on('update-downloaded', (u) => {
    log.info('update', `update ${u.version} downloaded; installs on restart`);
    if (notified === u.version || !Notification.isSupported()) return;
    notified = u.version;
    const n = new Notification({
      title: 'Twitch Desktop update ready',
      body: `Version ${u.version} is ready. Click to restart and update.`,
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    });
    n.on('click', () => {
      log.info('update', `restarting to install ${u.version}`);
      // Silent install, then relaunch. setImmediate lets the click handler return before the windows close.
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
    });
    n.show();
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {}); // the 'error' event logs it
  setTimeout(check, 10e3); // after the window and first poll have settled
  setInterval(check, 6 * 3600e3).unref();
}

module.exports = { init };
