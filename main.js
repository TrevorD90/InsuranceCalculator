'use strict';

/**
 * Electron main process — window, settings, Claude calls, file dialogs.
 *
 * This process holds every privilege: the API key, the filesystem, the network. The renderer
 * holds none of them and reaches this side only through the narrow bridge in preload.js.
 * See ARCHITECTURE §2 and §7.
 */

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_PDF_BYTES = 24 * 1024 * 1024;

let win = null;

/* ============================================================== settings ==== */
/* The key is encrypted with the OS keychain (Keychain on macOS, DPAPI on Windows) before it
 * touches disk. If the OS cannot encrypt, nothing is written — the key is held in memory for
 * the session and the UI says so, rather than a key quietly landing in a file in the clear. */

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const workspacePath = () => path.join(app.getPath('userData'), 'workspace.json');

let sessionKey = '';   // in-memory fallback when safeStorage is unavailable

const clampScale = (v, fallback = 1) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0.5 && n <= 3 ? n : fallback;
};

function readSettings() {
  const fallback = { apiKey: '', model: DEFAULT_MODEL, textScale: 1 };
  let encryptionAvailable = false;
  try { encryptionAvailable = safeStorage.isEncryptionAvailable(); } catch (_) { /* not ready yet */ }

  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    let apiKey = '';
    if (raw.apiKeyEncrypted && encryptionAvailable) {
      try {
        apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEncrypted, 'base64'));
      } catch (_) { apiKey = ''; }
    }
    return {
      apiKey,
      model: raw.model || fallback.model,
      textScale: clampScale(raw.textScale),
      encryptionAvailable
    };
  } catch (_) {
    return { ...fallback, encryptionAvailable };
  }
}

const activeKey = () => readSettings().apiKey || sessionKey;

function writeSettings(next) {
  const current = readSettings();
  const out = {
    model: next.model || current.model || DEFAULT_MODEL,
    textScale: clampScale(next.textScale, current.textScale)
  };
  let warning = null;

  const incoming = typeof next.apiKey === 'string' && next.apiKey.length ? next.apiKey : null;
  const keyToStore = incoming || current.apiKey;

  if (incoming) sessionKey = incoming;

  if (keyToStore) {
    if (current.encryptionAvailable) {
      out.apiKeyEncrypted = safeStorage.encryptString(keyToStore).toString('base64');
    } else {
      warning = 'This computer cannot encrypt stored keys, so the key is held for this session only and will be gone when you quit.';
    }
  }

  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(out, null, 2), { mode: 0o600 });
  return { ok: true, warning };
}

/* ================================================================ claude ==== */

async function callClaude(apiKey, body) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    const e = new Error('Could not reach the API. Check your network connection.');
    e.cause = err;
    throw e;
  }

  const text = await res.text();
  if (!res.ok) {
    let msg = `The API returned ${res.status}.`;
    if (res.status === 401) msg = 'That API key was rejected. Check it in Settings.';
    else if (res.status === 429) msg = 'Rate limited. Wait a moment and try again.';
    else if (res.status >= 500) msg = 'The API is having trouble. Try again shortly.';
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error?.message) msg = parsed.error.message;
    } catch (_) { /* keep the status message */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

const textOf = (response) =>
  (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

/** Strip markdown fences defensively and pull the outermost JSON object. */
function parseJsonBlock(str) {
  const s = String(str).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('The model did not return plan data.');
  return JSON.parse(s.slice(first, last + 1));
}

const EXTRACTION_PROMPT = [
  'You are reading a health insurance Summary of Benefits and Coverage (SBC) or plan document.',
  'Return the plan cost-sharing terms as a single JSON object and nothing else: no prose, no code fences.',
  '',
  'Schema:',
  '{',
  '  "name": string,',
  '  "carrier": string,',
  '  "isHSA": boolean,',
  '  "monthlyPremium": 0,',
  '  "familyDeductibleMode": "embedded" | "aggregate",',
  '  "combinedAccumulators": boolean,',
  '  "copaysCountToOOP": boolean,',
  '  "erCopayWaivedIfAdmitted": boolean,',
  '  "pharmacyDeductible": { "individual": number, "family": number } | null,',
  '  "tiers": {',
  '    "in":  { "deductible": {"individual": number, "family": number},',
  '             "oopMax":     {"individual": number, "family": number} },',
  '    "out": { "deductible": {"individual": number, "family": number},',
  '             "oopMax":     {"individual": number, "family": number} } | null',
  '  },',
  '  "benefits": {',
  '    "<benefitKey>": {',
  '      "designated": <benefit> | omitted,',
  '      "in":  <benefit>,',
  '      "out": <benefit>',
  '    }',
  '  },',
  '  "notes": string,',
  '  "unread": [string]',
  '}',
  '',
  'A <benefit> is exactly one of:',
  '  { "mode": "copay",       "copay": number,       "deductibleFirst": boolean }',
  '  { "mode": "coinsurance", "coinsurance": number, "deductibleFirst": boolean }',
  '  { "mode": "noCharge" }',
  '  { "mode": "notCovered" }',
  '',
  'Benefit keys: preventive, pcp, specialist, mhOutpatient, mhInpatient, urgentCare, er,',
  'ambulance, labs, xray, imaging, outpatientFacility, outpatientPhysician, inpatientFacility,',
  'inpatientPhysician, rehab, dme, homeHealth, skilledNursing, childbirthProfessional,',
  'childbirthFacility, rxTier1, rxTier2, rxTier3, rxSpecialty.',
  '',
  'How to fill it in:',
  '- Report BOTH the individual and the family figure for every deductible and maximum.',
  '- coinsurance is the MEMBER share as a decimal. "Plan pays 80%" means 0.2. "0% coinsurance"',
  '  means the member pays 0 and is written as 0.',
  '- deductibleFirst is true ONLY when the document says the deductible applies to that benefit.',
  '  SBCs usually say "after deductible" or, for the opposite, "deductible does not apply".',
  '  On HSA-qualified plans the deductible applies to everything except preventive care.',
  '- Capture the DESIGNATED provider tier separately from the regular network tier. Plans often',
  '  price a Designated Diagnostic Provider far lower for labs and imaging. If the document',
  '  shows only one network figure, omit "designated" entirely rather than duplicating it.',
  '- If the plan has NO out-of-network coverage (an EPO), set "tiers.out" to null and set every',
  '  out-of-network benefit to {"mode":"notCovered"} — except emergency room and ambulance if',
  '  the document covers those out of network.',
  '- familyDeductibleMode is "aggregate" when the whole family deductible must be met before the',
  '  plan pays for anyone, and "embedded" when each member has their own individual deductible.',
  '- monthlyPremium is always 0. SBCs do not state the premium.',
  '- If a field is not in the document, choose a sensible default AND list that field name in',
  '  "unread". Do not invent specific dollar figures.',
  '- If the document covers several plan tiers, use the first and say which one in "notes".',
  '- Put anything a shopper would be caught out by in "notes": separate drug deductibles, copays',
  '  excluded from the maximum, referral requirements, tiered networks, per-admission copays.'
].join('\n');

async function extractPlanFromPdf(apiKey, model, filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_PDF_BYTES) {
    throw new Error('That file is over 24 MB, which is too large to send. Export a smaller PDF or split it.');
  }
  const data = fs.readFileSync(filePath).toString('base64');

  const response = await callClaude(apiKey, {
    model: model || DEFAULT_MODEL,
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
        { type: 'text', text: EXTRACTION_PROMPT }
      ]
    }]
  });

  const plan = parseJsonBlock(textOf(response));
  plan.source = 'ai';
  plan.sourceFile = path.basename(filePath);
  if (!plan.name) plan.name = path.basename(filePath).replace(/\.pdf$/i, '');
  return plan;
}

/* =================================================================== ipc ==== */

ipcMain.handle('settings:load', () => {
  const s = readSettings();
  const key = s.apiKey || sessionKey;
  return {
    model: s.model,
    hasKey: !!key,
    // A masked hint only. The key itself never crosses the bridge.
    keyHint: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : '',
    encryptionAvailable: s.encryptionAvailable,
    textScale: s.textScale
  };
});

ipcMain.handle('settings:save', (_e, next) => {
  try { return writeSettings(next || {}); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('settings:clearKey', () => {
  try {
    sessionKey = '';
    const s = readSettings();
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ model: s.model }, null, 2), { mode: 0o600 });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('ai:test', async (_e, override) => {
  const s = readSettings();
  const key = (override && override.apiKey) || activeKey();
  const model = (override && override.model) || s.model || DEFAULT_MODEL;
  if (!key) return { ok: false, error: 'No API key set.' };
  try {
    await callClaude(key, {
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with one word: ready' }]
    });
    return { ok: true, model };
  } catch (err) {
    return { ok: false, error: err.message, status: err.status };
  }
});

ipcMain.handle('plans:import', async () => {
  const key = activeKey();
  if (!key) return { ok: false, error: 'Connect Claude in Settings before importing plan documents.' };
  const model = readSettings().model || DEFAULT_MODEL;

  const picked = await dialog.showOpenDialog(win, {
    title: 'Choose plan documents',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Plan documents', extensions: ['pdf'] }]
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: true, plans: [], failures: [], canceled: true };

  const plans = [];
  const failures = [];

  // One file's failure must not lose the others' successes.
  for (const filePath of picked.filePaths) {
    const file = path.basename(filePath);
    win?.webContents.send('plans:progress', { file, state: 'reading' });
    try {
      plans.push(await extractPlanFromPdf(key, model, filePath));
      win?.webContents.send('plans:progress', { file, state: 'done' });
    } catch (err) {
      failures.push({ file, error: err.message });
      win?.webContents.send('plans:progress', { file, state: 'failed' });
    }
  }
  return { ok: true, plans, failures };
});

ipcMain.handle('workspace:export', async (_e, payload) => {
  try {
    const picked = await dialog.showSaveDialog(win, {
      title: 'Export comparison',
      defaultPath: 'plan-comparison.json',
      filters: [{ name: 'Comparison', extensions: ['json'] }]
    });
    if (picked.canceled || !picked.filePath) return { ok: true, canceled: true };
    fs.writeFileSync(picked.filePath, JSON.stringify(payload, null, 2));
    return { ok: true, path: picked.filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('workspace:import', async () => {
  try {
    const picked = await dialog.showOpenDialog(win, {
      title: 'Import comparison',
      properties: ['openFile'],
      filters: [{ name: 'Comparison', extensions: ['json'] }]
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: true, canceled: true };
    return { ok: true, data: JSON.parse(fs.readFileSync(picked.filePaths[0], 'utf8')) };
  } catch (err) { return { ok: false, error: err.message }; }
});

/* Autosave — silent, continuous, local. Never contains the API key. */
ipcMain.handle('workspace:autosave', (_e, payload) => {
  try {
    fs.mkdirSync(path.dirname(workspacePath()), { recursive: true });
    fs.writeFileSync(workspacePath(), JSON.stringify(payload));
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('workspace:restore', () => {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(workspacePath(), 'utf8')) };
  } catch (_) {
    return { ok: true, data: null };
  }
});

ipcMain.handle('shell:open', (_e, url) => {
  if (/^https:\/\//.test(String(url))) shell.openExternal(String(url));
});

/* ================================================================ window ==== */

function createWindow() {
  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#E9EDF2',
    title: 'Plan Ledger',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });

  // Never let the app navigate itself somewhere else, and send real links to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

nativeTheme.themeSource = 'light';

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
