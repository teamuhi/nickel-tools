// MV3 service worker for Chrome/Edge/Brave. Owns the native messaging Port,
// tracks in-flight download jobs, and pushes progress/notifications
// independently of whether the popup is open -- same responsibility as the
// Firefox extension's background.js, but this file can be killed and
// restarted by the browser at any time (MV3 service worker lifecycle), so
// unlike the Firefox version it can't just trust its own in-memory state:
//
//   - `jobs` (running and queued downloads) and `notificationPaths` are persisted to chrome.storage.session
//     on every mutation, and rehydrated here at startup, so a restart
//     doesn't lose track of an in-flight download or a pending
//     click-to-reveal notification.
//   - Reconnecting via connectNative() after a restart always spawns a NEW
//     host.exe process, never reattaches to the one already running the
//     download -- there is no such API. So on rehydration, the job that was
//     running (queued ones haven't been sent yet) is reconciled by asking the (possibly
//     new) host process to read the job's status back from the status file
//     host.py persists to disk per requestId (see getJobStatus below),
//     rather than trusting the rehydrated in-memory shape as current.

const HOST_NAME = 'com.nickel.nickel_tools';
const HOST_TIMEOUT_MS = 8000;
const TRANSLATE_TIMEOUT_MS = 30000; // two sequential web requests; also covers an old host that ignores the message

let port = null;

// requestId -> { resolve, reject }, for one-shot request/response calls
// (ping, formats, config). Unlike `jobs`, these are NOT persisted: an
// in-flight Promise can't survive a service worker restart, so a caller
// whose request was orphaned by a restart just sees it reject/hang and can
// retry -- these calls are all short-lived (popup-open-triggered), so the
// window for this to matter is small.
const pendingRequests = {};

// id (the host requestId) -> { id, tabUrl, url, title, mode, source, status, percent, queuedAt, startedAt,
//   params, sig, filename, error, errorCode, errorHint }. status 'queued' = waiting for its turn; `params`
// (the download message) is dropped once the job is sent to the host. Keyed by id, so a pushed jobUpdate
// finds its job directly, also after a restart.
let jobs = {};

// notificationId -> file path, so clicking a finished-download notification
// can ask the host to reveal it
let notificationPaths = {};

let stateLoaded = loadState();

function newRequestId() {
  return crypto.randomUUID();
}

console.log('[bg] service worker script evaluating, t=', Date.now());

async function loadState() {
  const stored = await chrome.storage.session.get(['jobs', 'notificationPaths']);
  // Jobs stored by an older version were keyed by tabUrl and carried `requestId`.
  jobs = {};
  for (const [key, job] of Object.entries(stored.jobs || {})) {
    const id = job.id || job.requestId;
    if (id) jobs[id] = { queuedAt: job.startedAt || 0, tabUrl: key, ...job, id };
  }
  notificationPaths = stored.notificationPaths || {};
  console.log('[bg] state rehydrated, jobs=', JSON.stringify(jobs));
  reconcileJobs();
  pumpQueue(); // nothing was running (e.g. the worker died between two jobs): carry on with the queue
  updateBadge();
}

function persistState() {
  chrome.storage.session.set({ jobs, notificationPaths });
}

// job id -> { intervalId, failures }. After a restart, the host process
// we're now connected to is NOT the one running the download (a fresh
// connectNative() always spawns a new process -- see the module comment at
// the top), so it will never push us another jobUpdate for this job on its
// own. The only way to keep the popup's progress current is to keep asking
// -- a single reconciliation check would just freeze the UI at whatever
// that one snapshot showed. Polls over the same already-open port, which is
// what's expected to keep this service worker instance alive for the
// duration (same "strong keep-alive" assumption normal, non-restarted
// downloads already rely on) -- chrome.alarms was considered instead since
// setInterval doesn't survive a service worker being torn down, but its
// ~30s minimum period is too coarse for a progress bar.
const activePolls = {};

function stopPolling(id) {
  if (activePolls[id]) {
    clearInterval(activePolls[id].intervalId);
    delete activePolls[id];
  }
}

function pollJobStatus(id) {
  console.log('[bg] pollJobStatus: starting poll for', id);
  stopPolling(id);
  const poll = { intervalId: null, failures: 0 };
  activePolls[id] = poll;
  poll.intervalId = setInterval(() => {
    if (!jobs[id]) {
      console.log('[bg] pollJobStatus: job gone, stopping poll for', id);
      stopPolling(id);
      return;
    }
    // A fresh requestId per poll tick for response correlation (so two
    // overlapping ticks can't clobber each other in pendingRequests); jobId
    // tells the host which job's status file to actually read.
    sendRequest({ type: 'getJobStatus', requestId: newRequestId(), jobId: id })
      .then((res) => {
        console.log('[bg] pollJobStatus tick ok for', id, '->', JSON.stringify(res));
        poll.failures = 0;
        const job = jobs[id];
        if (!job) {
          stopPolling(id);
          return;
        }
        // res carries this one RPC's own wrapper fields (type, ok, and a
        // per-tick requestId used only for response correlation -- see the
        // comment above) which must NOT overwrite the job's real, stable
        // id. Only the actual status fields belong in the job.
        // (applyUpdate strips them, and starts a pending browser fallback.)
        applyUpdate(job, res);
        if (isEnded(job.status) || fallbacksRunning.has(id)) stopPolling(id);
      })
      .catch((err) => {
        console.warn('[bg] pollJobStatus tick FAILED for', id, err && err.message);
        // A single missed tick isn't fatal (the host may just be briefly
        // busy); only give up after several in a row.
        poll.failures += 1;
        const job = jobs[id];
        if (poll.failures >= 5 && job) {
          job.status = 'error';
          job.error = 'Lost track of this download after a browser restart.';
          persistState();
          broadcast(job.tabUrl);
          stopPolling(id);
          jobDone(job);
        }
      });
  }, 1500);
}

function reconcileJobs() {
  console.log('[bg] reconcileJobs: checking', Object.keys(jobs).length, 'rehydrated job(s)');
  Object.values(jobs).filter(isRunning).forEach((job) => pollJobStatus(job.id));
}

function ensurePort() {
  if (port) return port;
  console.log('[bg] ensurePort: spawning a new native host connection');
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(onPortDisconnect);
  return port;
}

// timeoutMs is for requests an older host build never answers (unknown
// message types are silently ignored), so the popup can tell it to update.
function sendRequest(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    pendingRequests[message.requestId] = {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    };
    if (timeoutMs) {
      timer = setTimeout(() => {
        delete pendingRequests[message.requestId];
        reject(Object.assign(new Error('The native host did not answer.'), {
          code: 'E_HOST_OUTDATED',
          hint: 'Reinstall nickel.tools to update the native host.',
        }));
      }, timeoutMs);
    }
    try {
      ensurePort().postMessage(message);
    } catch (e) {
      delete pendingRequests[message.requestId];
      reject(e);
    }
  });
}


// User-facing toggles from the popup's Settings page (storage.local).
const DEFAULT_SETTINGS = { showBadge: true, notifyStart: true, notifyFinish: true, notifyError: true, autoReveal: false };
const HISTORY_MAX = 20;

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS))) };
}

// Browser's x.com login cookies, for sensitive/protected tweets. Sent to the
// local host only for that one request; null when the user turned it off.
async function getXCookies() {
  const { useXLogin } = await chrome.storage.local.get('useXLogin');
  if (useXLogin === false) return null;
  const lists = await Promise.all(['x.com', 'twitter.com'].map((domain) => chrome.cookies.getAll({ domain })));
  return lists.flat().map((c) => ({
    domain: c.domain, path: c.path, secure: c.secure, expirationDate: c.expirationDate, name: c.name, value: c.value,
  }));
}

// Error shape shared with the popup: host errors carry a code, readable
// message and hint (see backend/errors.py).
function makeError(msg) {
  return Object.assign(new Error(msg.error), { code: msg.errorCode, hint: msg.errorHint, detail: msg.errorDetail });
}

function failure(err) {
  logEvent('error', err.message, { code: err.code, hint: err.hint, detail: err.detail || err.stack });
  return { ok: false, error: err.message, errorCode: err.code, errorHint: err.hint, errorDetail: err.detail };
}

// ---------------------------------------------------------------- system log
// Every error (and each browser-fallback step) with its full detail, kept in
// storage.local for Settings > History > System log. Writes are chained so two
// entries logged at once can't overwrite each other.
const LOG_MAX = 200;
let logChain = Promise.resolve();

function logEvent(level, message, fields = {}) {
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)('[nickel.tools]', message, fields);
  const entry = { at: Date.now(), level, message: String(message || 'Unknown error'), ...fields };
  logChain = logChain.then(async () => {
    const { logs = [] } = await chrome.storage.local.get('logs');
    logs.unshift(entry);
    await chrome.storage.local.set({ logs: logs.slice(0, LOG_MAX) });
  }).catch(() => {});
}

self.addEventListener('error', (e) => logEvent('error', e.message, { context: 'background', detail: e.error && e.error.stack }));
self.addEventListener('unhandledrejection', (e) => logEvent('error', (e.reason && e.reason.message) || String(e.reason), { context: 'background', detail: e.reason && e.reason.stack }));

const isActive = (job) => job.status !== 'finished' && job.status !== 'error' && job.status !== 'cancelled'; // running (also paused) or queued
const isRunning = (job) => isActive(job) && job.status !== 'queued';
const isEnded = (status) => status === 'finished' || status === 'error' || status === 'cancelled';
const jobNotificationId = (job) => (job.id ? 'job-' + job.id : undefined);
const byQueuedAt = (a, b) => a.queuedAt - b.queuedAt;

// chrome.notifications.create(id?, options, callback): the id is optional.
function createNotification(id, options, callback) {
  const args = id ? [id, options] : [options];
  chrome.notifications.create(...args, callback);
}

const STATUS_WORDS = { starting: 'Starting', downloading: 'Downloading', paused: 'Paused', converting: 'Converting', tagging: 'Writing tags', rendering: 'Rendering card', retrying: 'Retrying in browser' };
const BADGE_COLORS = { active: '#111111', finished: '#346538', error: '#9f2f2d' };
const BADGE_FLASH_MS = { finished: 5000, error: 10000 };
const DEFAULT_TITLE = 'Download media from this page';

// Toolbar badge: progress while exporting (alternating with "+N" while others
// wait in the queue), then a short-lived check or "!". This is what shows an
// export is running while the popup is closed. The badge itself outlives a
// service worker restart; only the flash timer doesn't, which at worst leaves
// a check/"!" up until the next update.
const BADGE_TICK_MS = 2000;
let badgeFlash = null;
let badgeFlashTimer = null;
let badgeTicker = null;
let badgePhase = 0; // 0 = progress, 1 = waiting count
let lastBadge = '';

function flashBadge(status) {
  clearTimeout(badgeFlashTimer);
  badgeFlash = status;
  badgeFlashTimer = setTimeout(() => { badgeFlash = null; updateBadge(); }, BADGE_FLASH_MS[status]);
}

function clearBadgeFlash() {
  clearTimeout(badgeFlashTimer);
  badgeFlash = null;
  updateBadge();
}

// Runs only while jobs are waiting, so the badge isn't redrawn for nothing.
function setBadgeTicker(on) {
  if (on && !badgeTicker) {
    badgeTicker = setInterval(() => { badgePhase ^= 1; updateBadge(); }, BADGE_TICK_MS);
  } else if (!on && badgeTicker) {
    clearInterval(badgeTicker);
    badgeTicker = null;
    badgePhase = 0;
  }
}

async function updateBadge() {
  const { showBadge } = await getSettings();
  const all = Object.values(jobs);
  const running = all.find(isRunning);
  const waiting = all.filter((job) => job.status === 'queued').length;
  setBadgeTicker(showBadge && !!running && waiting > 0);
  let text = '';
  let color = BADGE_COLORS.active;
  let title = DEFAULT_TITLE;
  if (showBadge && (running || waiting)) {
    const percent = running ? Math.round(running.percent || 0) : 0;
    text = !running || badgePhase === 1 ? '+' + waiting : percent + '%';
    title = 'nickel.tools: ' + (running
      ? (STATUS_WORDS[running.status] || 'Exporting') + (running.title ? ' "' + running.title + '"' : '') + '… ' + percent + '%'
      : 'starting the next download')
      + (waiting ? ' · ' + waiting + ' queued' : '');
  } else if (showBadge && badgeFlash) {
    text = badgeFlash === 'finished' ? '✓' : '!';
    color = BADGE_COLORS[badgeFlash];
    title = badgeFlash === 'finished' ? 'nickel.tools: export finished' : 'nickel.tools: export failed';
  }
  const key = text + color + title;
  if (key === lastBadge) return;
  lastBadge = key;
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.showBadge) updateBadge();
});

const finishedJobs = new Set();

// Everything that happens once a job ends: badge, notification, history, auto-reveal.
async function jobDone(job) {
  if (finishedJobs.has(job.id)) return;
  finishedJobs.add(job.id);
  if (job.status === 'cancelled') { // the user's own doing: no badge flash, notification or history entry
    chrome.notifications.clear(jobNotificationId(job));
    updateBadge();
    prune();
    persistState();
    pumpQueue();
    return;
  }
  const isError = job.status === 'error';
  const where = { source: job.source, title: job.title, url: job.url };
  if (isError) logEvent('error', job.error, { ...where, code: job.errorCode, hint: job.errorHint, detail: job.errorDetail });
  else if (job.warning) logEvent('warn', job.warning, where);
  flashBadge(isError ? 'error' : 'finished');
  updateBadge();
  prune();
  persistState();
  pumpQueue(); // the next queued download starts without waiting for the notification work below

  const settings = await getSettings();
  if (isError ? settings.notifyError : settings.notifyFinish) notify(job, isError);
  if (isError) return;

  if (settings.autoReveal && job.path) {
    ensurePort().postMessage({ type: 'revealFile', requestId: newRequestId(), path: job.path });
  }
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift({ title: job.title || job.filename || 'Saved', filename: job.filename, path: job.path, source: job.source, url: job.url, mode: job.mode, at: Date.now() });
  chrome.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
}

// Same notification id as the "started" one, so the result replaces it.
function notify(job, isError) {
  createNotification(jobNotificationId(job), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-48.png'),
    title: isError ? 'Download failed' + (job.errorCode ? ' (' + job.errorCode + ')' : '') : 'Download finished',
    message: isError ? job.error + (job.errorHint ? '\n' + job.errorHint : '') : (job.title || job.filename || 'Saved') + (job.path ? '\nClick to show in folder' : ''),
  }, (notificationId) => {
    if (!isError && job.path) {
      notificationPaths[notificationId] = job.path;
      persistState();
    }
  });
}

async function notifyStarted(job) {
  if (!(await getSettings()).notifyStart) return;
  createNotification(jobNotificationId(job), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-48.png'),
    title: 'Exporting…',
    message: job.title || 'Your download has started',
    silent: true,
  });
}

chrome.notifications.onClicked.addListener((notificationId) => {
  const path = notificationPaths[notificationId];
  if (!path) return;
  ensurePort().postMessage({ type: 'revealFile', requestId: newRequestId(), path });
});

chrome.notifications.onClosed.addListener((notificationId) => {
  delete notificationPaths[notificationId];
  persistState();
});

// The popup shows one job per tab (the newest) plus the whole queue.
function broadcast(tabUrl) {
  chrome.runtime.sendMessage({ type: 'jobUpdate', tabUrl, job: publicJob(latestJobFor(tabUrl)), queue: queueSnapshot() }).catch(() => {
    // No popup listening; that's fine.
  });
}

// Everything but jobUpdate answers a sendRequest (pong, formatsResult, importFileResult, ...).
function onPortMessage(msg) {
  if (msg.type === 'jobUpdate') {
    const job = jobs[msg.requestId];
    if (!job) {
      console.warn('[bg] jobUpdate has no matching job -- dropped. requestId=', msg.requestId);
      return;
    }
    applyUpdate(job, msg);
    return;
  }
  const pending = pendingRequests[msg.requestId];
  if (!pending) return;
  delete pendingRequests[msg.requestId];
  if (msg.ok === false) {
    pending.reject(makeError(msg));
  } else {
    pending.resolve(msg);
  }
}

function syncJob(job) {
  persistState();
  broadcast(job.tabUrl);
  updateBadge();
}

// Applies a host status report. A Web job's final report may list files the host
// was refused (`fallback`); the browser then fetches those before the job ends.
function applyUpdate(job, fields) {
  if (fallbacksRunning.has(job.id)) return; // the host is done; the browser fallback owns the job now
  const { fallback, type, ok, requestId, ...update } = fields;
  Object.assign(job, update);
  if (fallback && fallback.items && fallback.items.length && (update.status === 'finished' || update.status === 'error') && !job.fallbackDone) {
    job.fallbackDone = true;
    runFallback(job, fallback);
    return;
  }
  settlePending(job);
  syncJob(job);
  if (isEnded(job.status)) jobDone(job);
}

// ---------------------------------------------------------------- browser fallback
// Web files the host was refused (hotlink protection, bot checks, cookie-only
// CDNs) are downloaded by the browser itself -- the same request as "Save as" --
// then handed back to the host, which moves each into the save location and
// converts it. The host's part of the job has ended by then, so it can't be
// paused; cancel stops it. Lives in memory only: if the service worker is
// restarted mid-way, the job just ends with the host's own result (fallbackDone
// is persisted, so it isn't retried twice).
const fallbacksRunning = new Set();
const fileName = (path) => String(path).split(/[\\/]/).pop();

// Resolves to the downloaded file's full path. The entry is erased from the
// browser's download list afterwards (the file stays; the host moves it).
function browserDownload(url, job) {
  return new Promise((resolve, reject) => {
    let id = null;
    const finish = (fn, value) => {
      chrome.downloads.onChanged.removeListener(onChanged);
      delete job.fallbackDownloadId;
      fn(value);
    };
    const check = () => chrome.downloads.search({ id }).then(([item]) => {
      if (!item) finish(reject, new Error('The browser download disappeared.'));
      else if (item.state === 'complete') {
        chrome.downloads.erase({ id }).catch(() => {});
        finish(resolve, item.filename);
      } else if (item.state === 'interrupted') {
        finish(reject, Object.assign(new Error('The browser could not download it (' + (item.error || 'interrupted') + ').'), { code: 'E_BROWSER_DOWNLOAD' }));
      }
    });
    const onChanged = (delta) => { if (delta.id === id && delta.state) check(); };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.download({ url, saveAs: false, conflictAction: 'uniquify' })
      .then((newId) => { id = newId; job.fallbackDownloadId = id; return check(); })
      .catch((e) => finish(reject, e));
  });
}

async function runFallback(job, fb) {
  fallbacksRunning.add(job.id);
  const saved = [...(fb.saved || [])];
  const kept = [];
  let failed = 0;
  let lastError = null;
  const n = fb.items.length;
  logEvent('info', 'The site refused ' + n + ' file(s) to nickel.tools; retrying through the browser', {
    source: 'web', title: job.title, url: job.url, detail: fb.items.map((it) => it.url + '\n  host: ' + it.error).join('\n'),
  });
  for (const [i, item] of fb.items.entries()) {
    if (job.pending === 'cancel') break;
    Object.assign(job, { status: 'retrying', item: i + 1, total: n, percent: Math.round((i / n) * 100) });
    syncJob(job);
    try {
      const file = await browserDownload(item.url, job);
      const res = await sendRequest({ type: 'importFile', requestId: newRequestId(), path: file, targetDir: fb.targetDir, kind: item.kind, convert: fb.convert });
      saved.push(res.path);
      if (res.kept) kept.push(res.kept);
      logEvent('info', 'Saved through the browser: ' + fileName(res.path), { source: 'web', url: item.url, detail: res.path });
    } catch (e) {
      if (job.pending === 'cancel') break;
      failed += 1;
      lastError = e;
      logEvent('error', 'Browser retry failed: ' + e.message, {
        source: 'web', code: e.code, url: item.url, detail: 'host: ' + item.error + '\nbrowser: ' + (e.detail || e.message),
      });
    }
  }
  fallbacksRunning.delete(job.id);

  if (job.pending === 'cancel') {
    job.status = 'cancelled';
  } else if (saved.length) {
    ['error', 'errorCode', 'errorHint', 'errorDetail'].forEach((key) => delete job[key]);
    Object.assign(job, {
      status: 'finished',
      percent: 100,
      filename: saved.length === 1 ? fileName(saved[0]) : saved.length + ' files',
      path: saved.length === 1 ? saved[0] : fb.targetDir,
      warning: [
        job.warning,
        failed && failed + ' of ' + fb.total + ' failed, also through the browser: ' + lastError.message,
        kept.length && kept.length + ' file(s) kept as the original (could not convert ' + [...new Set(kept)].join(', ') + ')',
      ].filter(Boolean).join('\n') || undefined,
    });
  } else {
    job.status = 'error';
    job.errorDetail = [job.errorDetail, 'Browser retry: ' + (lastError ? lastError.message : 'nothing to retry')].filter(Boolean).join('\n');
  }
  delete job.pending;
  syncJob(job);
  jobDone(job);
}

// Only cancel applies while the browser retries files (the host's part has ended).
function controlFallback(job, action) {
  if (action !== 'cancel') return { ok: false, error: "Can't pause while the browser retries a file." };
  job.pending = 'cancel';
  if (job.fallbackDownloadId != null) chrome.downloads.cancel(job.fallbackDownloadId).catch(() => {});
  syncJob(job);
  return { ok: true };
}

// Only cancel applies while the browser retries files (the host's part has ended).
function controlFallback(job, action) {
  if (action !== 'cancel') return { ok: false, error: "Can't pause while the browser retries a file." };
  job.pending = 'cancel';
  if (job.fallbackDownloadId != null) chrome.downloads.cancel(job.fallbackDownloadId).catch(() => {});
  syncJob(job);
  return { ok: true };
}

function onPortDisconnect() {
  const err = chrome.runtime.lastError;
  const message = 'Native host disconnected' + (err && err.message ? ': ' + err.message : '');
  logEvent('warn', message, { context: 'native host' });
  port = null;

  Object.values(pendingRequests).forEach((p) => p.reject(new Error(message)));
  for (const id in pendingRequests) delete pendingRequests[id];

  // Queued jobs keep waiting; only the one the dead host was running fails.
  // Collect it first: jobDone starts the next queued job, which must not be failed too.
  const dead = Object.values(jobs).filter((job) => isRunning(job) && !fallbacksRunning.has(job.id)); // a browser fallback reports its own failure
  dead.forEach((job) => {
    job.status = 'error';
    job.error = message;
    broadcast(job.tabUrl);
  });
  persistState();
  dead.forEach(jobDone);
  pumpQueue(); // reconnects and carries on with the queue
}

// Which config field holds each tab's save location.
const DIR_KEYS = { youtube: 'downloadDir', twitter: 'twitterDownloadDir', web: 'webDownloadDir' };

// Shows the host's Windows folder dialog; resolves to the chosen path, or null if
// cancelled. Runs here rather than in the popup because the dialog steals focus,
// which closes the popup before the answer arrives. No timeout: the user may
// take as long as they like.
function browseFolder(source) {
  return sendRequest({ type: 'browseFolder', requestId: newRequestId(), source }).then((res) => res.path || null);
}

// `pending` is a pause/resume/cancel request waiting for the host to act on it; it is dropped once the
// job's status shows the request took effect (a cancel stays until the job ends).
function settlePending(job) {
  if (job.pending === 'pause' && job.status !== 'downloading' && job.status !== 'starting') delete job.pending;
  else if (job.pending === 'resume' && job.status !== 'paused') delete job.pending;
}

// Strips what the popup must not see (the pending download message).
function publicJob(job) {
  if (!job) return null;
  const { params, sig, ...rest } = job;
  return rest;
}

function latestJobFor(tabUrl) {
  return Object.values(jobs).filter((job) => job.tabUrl === tabUrl).reduce((a, b) => (!a || b.queuedAt >= a.queuedAt ? b : a), null);
}

// The running job first, then the waiting ones in arrival order.
function queueSnapshot() {
  const all = Object.values(jobs);
  return [...all.filter(isRunning), ...all.filter((job) => job.status === 'queued').sort(byQueuedAt)]
    .map(({ id, title, source, mode, status, percent, tabUrl, pending }) => ({ id, title, source, mode, status, percent, tabUrl, pending }));
}

// Keeps running and queued jobs plus the newest finished/failed one per tab
// (the popup still shows its "Saved as..." line); older ones are dropped.
function prune() {
  const newest = {};
  Object.values(jobs).filter((job) => !isActive(job)).forEach((job) => {
    if (!newest[job.tabUrl] || job.queuedAt >= newest[job.tabUrl].queuedAt) newest[job.tabUrl] = job;
  });
  Object.values(jobs).forEach((job) => {
    if (!isActive(job) && newest[job.tabUrl] !== job) delete jobs[job.id];
  });
}

// Adds a download to the queue (one runs at a time, oldest first). A repeat of
// the same tab + options that is already waiting or running is ignored.
async function enqueue(message) {
  await stateLoaded;
  const { type, tabUrl, ...params } = message;
  const sig = JSON.stringify(params);
  console.log('[bg] enqueue: tabUrl=', tabUrl, 'url=', message.url);
  let job = Object.values(jobs).find((j) => isActive(j) && j.tabUrl === tabUrl && j.sig === sig);
  if (!job) {
    job = {
      id: newRequestId(),
      tabUrl,
      url: message.url,
      title: message.title,
      mode: message.mode,
      source: message.source || 'youtube',
      status: 'queued',
      percent: 0,
      queuedAt: Date.now(),
      params,
      sig,
    };
    jobs[job.id] = job;
    persistState();
    pumpQueue();
    if (job.status === 'queued') {
      broadcast(tabUrl);
      updateBadge();
    }
  }
  return { id: job.id, position: queueSnapshot().findIndex((j) => j.id === job.id) };
}

// Starts the oldest queued job unless one is already running.
function pumpQueue() {
  const all = Object.values(jobs);
  if (all.some(isRunning)) return;
  const next = all.filter((job) => job.status === 'queued').sort(byQueuedAt)[0];
  if (next) runJob(next);
}

function runJob(job) {
  const { params } = job;
  delete job.params;
  job.status = 'starting';
  job.startedAt = Date.now();
  console.log('[bg] runJob: id=', job.id, 'tabUrl=', job.tabUrl);
  notifyStarted(job);
  (async () => {
    try {
      const cookies = job.source === 'twitter' ? await getXCookies() : null;
      ensurePort().postMessage({ ...params, type: 'download', requestId: job.id, cookies });
    } catch (e) {
      console.error('[bg] runJob: postMessage threw', e);
      job.status = 'error';
      job.error = e.message;
      persistState();
      broadcast(job.tabUrl);
      jobDone(job);
    }
  })();
  persistState();
  broadcast(job.tabUrl);
  updateBadge();
}

// A job that failed before it could be queued (e.g. the folder dialog), so the popup shows why.
async function failJob(message, error) {
  await stateLoaded;
  const job = {
    id: newRequestId(),
    tabUrl: message.tabUrl,
    url: message.url,
    title: message.title,
    mode: message.mode,
    source: message.source || 'youtube',
    status: 'error',
    percent: 0,
    queuedAt: Date.now(),
    error,
  };
  jobs[job.id] = job;
  persistState();
  broadcast(job.tabUrl);
  jobDone(job);
}

// One scan.js result per frame -> the top frame's page info plus every frame's
// items (media is often inside an iframe), de-duplicated by URL.
function mergeScans(results) {
  const scans = (results || []).filter((r) => r && r.items);
  const top = scans.find((r) => r.top) || scans[0];
  if (!top) return null;
  const seen = new Set();
  const items = scans.flatMap((r) => r.items).filter((item) => !seen.has(item.url) && seen.add(item.url));
  return { ...top, items: items.slice(0, 300) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getFormats') {
    stateLoaded.then(() => sendRequest({ type: 'formats', requestId: newRequestId(), url: message.url }))
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  if (message.type === 'translate') {
    stateLoaded.then(() => sendRequest({ type: 'translate', requestId: newRequestId(), texts: message.texts, target: message.target }, TRANSLATE_TIMEOUT_MS))
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  if (message.type === 'getTweet') {
    getXCookies()
      .then((cookies) => sendRequest({ type: 'tweet', requestId: newRequestId(), url: message.url, cookies }))
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  if (message.type === 'startDownload') {
    enqueue(message).then(sendResponse);
    return true;
  }

  if (message.type === 'startDownloadTo') {
    browseFolder(message.source)
      .then((path) => (path ? enqueue({ ...message, downloadDir: path }) : null))
      .catch((err) => failJob(message, 'Could not choose a folder: ' + err.message))
      .then(() => sendResponse());
    return true;
  }

  if (message.type === 'pickDir') {
    browseFolder(message.source)
      .then((path) => {
        if (!path) return { cancelled: true };
        return sendRequest({ type: 'setConfig', requestId: newRequestId(), config: { [DIR_KEYS[message.source]]: path } });
      })
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  // Where the page's video is playing, so a clip can start there (null: no video / no access).
  if (message.type === 'getPlayhead') {
    chrome.scripting.executeScript({
      target: { tabId: message.tabId },
      func: () => { const v = document.querySelector('video.html5-main-video') || document.querySelector('video'); return v && isFinite(v.currentTime) ? v.currentTime : null; },
    })
      .then((res) => sendResponse({ time: res && res[0] && res[0].result }), () => sendResponse({ time: null }));
    return true;
  }

  if (message.type === 'scanPage') {
    chrome.scripting.executeScript({ target: { tabId: message.tabId, allFrames: true }, files: ['scan.js'] })
      .then((res) => sendResponse(mergeScans(res.map((r) => r.result))))
      .catch((e) => sendResponse(failure(Object.assign(new Error("This page can't be scanned."), {
        code: 'E_UNSUPPORTED_URL',
        hint: 'Reload the page, then open nickel.tools from the toolbar again.',
        detail: e.message,
      }))));
    return true;
  }

  if (message.type === 'getJob') {
    stateLoaded.then(() => {
      clearBadgeFlash();
      sendResponse({ job: publicJob(latestJobFor(message.tabUrl)), queue: queueSnapshot() });
    });
    return true;
  }

  // Pause / resume / cancel the running download (the host acts on it at its next progress report).
  if (message.type === 'controlJob') {
    stateLoaded.then(() => {
      const job = jobs[message.id];
      if (!job || !isRunning(job) || !['pause', 'resume', 'cancel'].includes(message.action)) {
        return { ok: false, error: 'This download is no longer running.' };
      }
      if (fallbacksRunning.has(job.id)) return controlFallback(job, message.action);
      return sendRequest({ type: 'controlJob', requestId: newRequestId(), jobId: job.id, action: message.action }, HOST_TIMEOUT_MS)
        .then(() => {
          job.pending = message.action;
          persistState();
          broadcast(job.tabUrl);
          return { ok: true };
        });
    }).then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  // Only a job still waiting can be removed here; a running one is stopped with controlJob.
  if (message.type === 'removeQueued') {
    stateLoaded.then(() => {
      const job = jobs[message.id];
      const removed = !!job && job.status === 'queued';
      if (removed) {
        delete jobs[job.id];
        persistState();
        broadcast(job.tabUrl);
        updateBadge();
      }
      sendResponse({ removed });
    });
    return true;
  }

  // Errors the popup hit on its own (script errors), for the system log.
  if (message.type === 'log') {
    logEvent(message.level || 'error', message.message, { context: 'popup', detail: message.detail });
    sendResponse({ logged: true });
    return false;
  }

  if (message.type === 'getConfig') {
    sendRequest({ type: 'getConfig', requestId: newRequestId() })
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  if (message.type === 'setConfig') {
    sendRequest({ type: 'setConfig', requestId: newRequestId(), config: message.config })
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  // Settings helpers; an old host never answers these.
  const hostCalls = {
    openPath: () => ({ type: 'openPath', path: message.path, source: message.source }),
    revealFile: () => ({ type: 'revealFile', path: message.path }),
  };
  if (hostCalls[message.type]) {
    sendRequest({ ...hostCalls[message.type](), requestId: newRequestId() }, HOST_TIMEOUT_MS)
      .then(sendResponse, (err) => sendResponse(failure(err)));
    return true;
  }

  return false;
});
