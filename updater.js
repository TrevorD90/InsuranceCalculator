'use strict';

/**
 * Auto-update — checking, downloading, installing.
 *
 * Main process only, like main.js and preload.js. The renderer never talks to GitHub; it
 * receives a state object over the bridge and renders it. See ARCHITECTURE §7 and DATA-FLOW §6.
 *
 * The hard part of this module is not downloading a file. It is being honest about the three
 * cases where updating cannot work, instead of showing a button that fails:
 *
 *   1. Development.   There is no packaged app to replace. electron-updater throws outright.
 *   2. Portable .exe. The NSIS updater replaces an *installed* app. A portable binary is a
 *                     loose file the user put somewhere; nothing knows where, and overwriting
 *                     a file the user is running is not something to attempt.
 *   3. Unsigned mac.  Squirrel.Mac refuses an update whose code signature does not match the
 *                     running app's. Our builds are unsigned (ARCHITECTURE §10), so the
 *                     download would succeed and the install would silently do nothing.
 *
 * In all three the app still *checks*, and still tells the user a new version exists — it just
 * sends them to the download page rather than pretending it can install it. A check is a cheap
 * HTTP GET; the capability question only governs what we offer to do about the answer.
 */

const { app, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES_URL = 'https://github.com/TrevorD90/InsuranceCalculator/releases/latest';

/* Long enough that the check never competes with first paint or the Claude connection test.
 * Nothing about an update is urgent enough to make the window slower to appear. */
const FIRST_CHECK_DELAY_MS = 8_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Flip to true in the same change that adds real code signing — a Windows Authenticode
 * certificate and an Apple Developer ID. Until then this being false is what keeps macOS in
 * notify-only mode instead of offering an install that Squirrel will discard.
 */
const SIGNED_BUILDS = false;

const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_DIR;

/** Why self-installing is unavailable, or null when it works. Order matters: most specific first. */
function unsupportedReason() {
  if (!app.isPackaged) return 'dev';
  if (isPortable()) return 'portable';
  if (process.platform === 'darwin' && !SIGNED_BUILDS) return 'unsigned-mac';
  return null;
}

/* ================================================================== state ==== */

/**
 * One object, pushed to the renderer whenever any part of it changes. The renderer derives
 * nothing and asks no follow-up questions — every phase it needs to draw is named here.
 *
 * phase:
 *   idle         nothing has happened yet this session
 *   checking     a check is in flight
 *   current      checked, already on the newest version
 *   available    a newer version exists
 *   downloading  fetching it — `percent` is live
 *   ready        downloaded and staged; restarting installs it
 *   error        the check or the download failed — `error` says how
 */
const state = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  newVersion: null,
  notes: null,
  percent: 0,
  error: null,
  canSelfInstall: false,
  unsupportedReason: null,
  releasesUrl: RELEASES_URL,
  lastCheckedAt: null
};

let getWindow = () => null;
let timer = null;
let checking = false;

function patch(next) {
  Object.assign(state, next);
  const win = getWindow();
  // A closed or destroyed window is normal on quit; a broadcast is never worth a crash.
  if (win && !win.isDestroyed()) win.webContents.send('updates:changed', { ...state });
}

/* =============================================================== checking ==== */

/**
 * @param {boolean} userAsked  A manual check reports "you are up to date" and reports failures.
 *                             The silent startup check stays quiet unless there is good news —
 *                             a background poll that cannot reach GitHub is not the user's
 *                             problem and must not present itself as one.
 */
async function check(userAsked = false) {
  const reason = unsupportedReason();
  if (reason === 'dev') {
    // electron-updater throws without a packaged app. Say so plainly rather than surfacing that.
    patch({ phase: 'current', error: null, unsupportedReason: 'dev' });
    return { ...state };
  }
  if (checking) return { ...state };

  checking = true;
  patch({ phase: 'checking', error: null });

  try {
    const result = await autoUpdater.checkForUpdates();
    const found = result?.updateInfo?.version;
    state.lastCheckedAt = new Date().toISOString();

    // electron-updater resolves for same-version too; compare rather than trusting the call.
    if (found && found !== state.currentVersion) {
      patch({ phase: 'available', newVersion: found, notes: releaseNotesText(result.updateInfo) });
    } else {
      patch({ phase: 'current', newVersion: null, notes: null });
    }
  } catch (err) {
    if (userAsked) {
      patch({ phase: 'error', error: friendlyError(err) });
    } else {
      // Silent failure: leave the UI as it was. Offline at launch is the common case.
      patch({ phase: state.newVersion ? 'available' : 'idle' });
    }
  } finally {
    checking = false;
  }
  return { ...state };
}

/** Release notes arrive as a string or as an array of {version, note}; both become plain text. */
function releaseNotesText(info) {
  const raw = info?.releaseNotes;
  if (!raw) return null;
  const text = Array.isArray(raw) ? raw.map((r) => r?.note || '').join('\n\n') : String(raw);
  const stripped = text.replace(/<[^>]+>/g, '').trim();   // GitHub returns HTML
  if (!stripped) return null;
  return stripped.length > 900 ? `${stripped.slice(0, 900)}…` : stripped;
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (/net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED/i.test(msg)) {
    return 'Could not reach GitHub. Check your network connection.';
  }
  if (/404/.test(msg)) {
    // The usual cause is a release published without its latest.yml — see ARCHITECTURE §9.
    return 'No update information was published for this platform.';
  }
  return msg;
}

/* ================================================================== setup ==== */

/**
 * @param {() => (import('electron').BrowserWindow | null)} windowGetter
 *        A getter, not the window — main.js rebuilds the window on macOS `activate`, so a
 *        captured reference would go stale and updates would broadcast into a dead object.
 */
function initUpdater(windowGetter) {
  getWindow = windowGetter;

  const reason = unsupportedReason();
  state.unsupportedReason = reason;
  state.canSelfInstall = reason === null;

  // Never download 80 MB on someone's connection without being asked. The user clicks.
  autoUpdater.autoDownload = false;
  // If they downloaded but never got round to restarting, install on the next quit.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('download-progress', (p) => {
    patch({ phase: 'downloading', percent: Math.round(p?.percent || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    patch({ phase: 'ready', percent: 100, newVersion: info?.version || state.newVersion });
  });
  autoUpdater.on('error', (err) => {
    if (state.phase === 'downloading') patch({ phase: 'error', error: friendlyError(err) });
  });

  /* ---------------------------------------------------------------- ipc ---- */

  ipcMain.handle('updates:status', () => ({ ...state }));

  ipcMain.handle('updates:check', () => check(true));

  ipcMain.handle('updates:download', async () => {
    if (!state.canSelfInstall) {
      // The renderer should never offer this here, but the main process does not take the
      // renderer's word for what it is allowed to do.
      shell.openExternal(RELEASES_URL);
      return { ok: false, error: 'This build cannot install updates itself.' };
    }
    if (state.phase !== 'available') return { ok: false, error: 'No update is waiting.' };
    try {
      patch({ phase: 'downloading', percent: 0, error: null });
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      patch({ phase: 'error', error: friendlyError(err) });
      return { ok: false, error: friendlyError(err) };
    }
  });

  ipcMain.handle('updates:install', () => {
    if (state.phase !== 'ready') return { ok: false, error: 'No update has been downloaded.' };
    // isSilent false so the installer shows progress; isForceRunAfter true so the app comes back.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  });

  /* -------------------------------------------------------------- schedule -- */

  if (reason === 'dev') return;   // nothing to poll for

  setTimeout(() => { check(false); }, FIRST_CHECK_DELAY_MS);
  timer = setInterval(() => { check(false); }, RECHECK_INTERVAL_MS);
  app.on('before-quit', () => { if (timer) clearInterval(timer); });
}

module.exports = { initUpdater };
