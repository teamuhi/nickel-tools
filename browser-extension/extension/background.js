// Owns the native messaging Port to the local host, tracks in-flight
// download jobs, and pushes progress/notifications independently of
// whether the popup is open (a Port opened from the popup would die the
// instant the popup closes, so the popup only ever talks to us).

const HOST_NAME = 'com.nickel.nickel_tools';
const HOST_TIMEOUT_MS = 8000;
const TRANSLATE_TIMEOUT_MS = 30000; // two sequential web requests; also covers an old host that ignores the message

let port = null;

// requestId -> { resolve, reject }, for one-shot request/response calls (ping, formats)
const pendingRequests = {};

// id (the host requestId) -> { id, tabUrl, url, title, mode, source, status, percent, queuedAt, startedAt,
//   params, sig, filename, error, errorCode, errorHint }. status 'queued' = waiting for its turn; `params`
// (the download message) is dropped once the job is sent to the host.
const jobs = {};

// notificationId -> file path, so clicking a finished-download notification
// can ask the host to reveal it
const notificationPaths = {};

function newRequestId() {
  return crypto.randomUUID();
}

function ensurePort() {
  if (port) return port;
  port = browser.runtime.connectNative(HOST_NAME);
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
  return { ...DEFAULT_SETTINGS, ...(await browser.storage.local.get(Object.keys(DEFAULT_SETTINGS))) };
}

// Browser's x.com login cookies, for sensitive/protected tweets. Sent to the
// local host only for that one request; null when the user turned it off.
async function getXCookies() {
  const { useXLogin } = await browser.storage.local.get('useXLogin');
  if (useXLogin === false) return null;
  const lists = await Promise.all(['x.com', 'twitter.com'].map((domain) => browser.cookies.getAll({ domain })));
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
  return { ok: false, error: err.message, errorCode: err.code, errorHint: err.hint, errorDetail: err.detail };
}

const isActive = (job) => job.status !== 'finished' && job.status !== 'error' && job.status !== 'cancelled'; // running (also paused) or queued
const isRunning = (job) => isActive(job) && job.status !== 'queued';
const isEnded = (status) => status === 'finished' || status === 'error' || status === 'cancelled';
const jobNotificationId = (job) => (job.id ? 'job-' + job.id : undefined);
const byQueuedAt = (a, b) => a.queuedAt - b.queuedAt;

const STATUS_WORDS = { starting: 'Starting', downloading: 'Downloading', paused: 'Paused', converting: 'Converting', tagging: 'Writing tags', rendering: 'Rendering card' };
const BADGE_COLORS = { active: '#111111', finished: '#346538', error: '#9f2f2d' };
const BADGE_FLASH_MS = { finished: 5000, error: 10000 };
const DEFAULT_TITLE = 'Download media from this page';

// Toolbar badge: progress while exporting (alternating with "+N" while others
// wait in the queue), then a short-lived check or "!". This is what shows an
// export is running while the popup is closed.
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
  browser.browserAction.setBadgeText({ text });
  browser.browserAction.setBadgeBackgroundColor({ color });
  browser.browserAction.setTitle({ title });
}

browser.storage.onChanged.addListener((changes) => {
  if (changes.showBadge) updateBadge();
});

const finishedJobs = new Set();

// Everything that happens once a job ends: badge, notification, history, auto-reveal.
async function jobDone(job) {
  if (finishedJobs.has(job.id)) return;
  finishedJobs.add(job.id);
  if (job.status === 'cancelled') { // the user's own doing: no badge flash, notification or history entry
    browser.notifications.clear(jobNotificationId(job));
    updateBadge();
    prune();
    pumpQueue();
    return;
  }
  const isError = job.status === 'error';
  flashBadge(isError ? 'error' : 'finished');
  updateBadge();
  prune();
  pumpQueue(); // the next queued download starts without waiting for the notification work below

  const settings = await getSettings();
  if (isError ? settings.notifyError : settings.notifyFinish) notify(job, isError);
  if (isError) return;

  if (settings.autoReveal && job.path) {
    ensurePort().postMessage({ type: 'revealFile', requestId: newRequestId(), path: job.path });
  }
  const { history = [] } = await browser.storage.local.get('history');
  history.unshift({ title: job.title || job.filename || 'Saved', filename: job.filename, path: job.path, source: job.source, url: job.url, mode: job.mode, at: Date.now() });
  browser.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
}

// Same notification id as the "started" one, so the result replaces it.
function notify(job, isError) {
  browser.notifications.create(jobNotificationId(job), {
    type: 'basic',
    title: isError ? 'Download failed' + (job.errorCode ? ' (' + job.errorCode + ')' : '') : 'Download finished',
    message: isError ? job.error + (job.errorHint ? '\n' + job.errorHint : '') : (job.title || job.filename || 'Saved') + (job.path ? '\nClick to show in folder' : ''),
  }).then((notificationId) => {
    if (!isError && job.path) {
      notificationPaths[notificationId] = job.path;
    }
  });
}

async function notifyStarted(job) {
  if (!(await getSettings()).notifyStart) return;
  browser.notifications.create(jobNotificationId(job), {
    type: 'basic',
    title: 'Exporting…',
    message: job.title || 'Your download has started',
  });
}

browser.notifications.onClicked.addListener((notificationId) => {
  const path = notificationPaths[notificationId];
  if (!path) return;
  ensurePort().postMessage({ type: 'revealFile', requestId: newRequestId(), path });
});

browser.notifications.onClosed.addListener((notificationId) => {
  delete notificationPaths[notificationId];
});

// The popup shows one job per tab (the newest) plus the whole queue.
function broadcast(tabUrl) {
  browser.runtime.sendMessage({ type: 'jobUpdate', tabUrl, job: publicJob(latestJobFor(tabUrl)), queue: queueSnapshot() }).catch(() => {
    // No popup listening; that's fine.
  });
}

function onPortMessage(msg) {
  if (msg.type === 'pong' || msg.type === 'formatsResult' || msg.type === 'tweetResult' || msg.type === 'translateResult' || msg.type === 'configResult' || msg.type === 'controlJobResult' || msg.type === 'browseFolderResult' || msg.type === 'openPathResult' || msg.type === 'revealFileResult') {
    const pending = pendingRequests[msg.requestId];
    if (!pending) return;
    delete pendingRequests[msg.requestId];
    if (msg.ok === false) {
      pending.reject(makeError(msg));
    } else {
      pending.resolve(msg);
    }
    return;
  }

  if (msg.type === 'jobUpdate') {
    const job = jobs[msg.requestId];
    if (!job) return;
    Object.assign(job, msg);
    settlePending(job);
    broadcast(job.tabUrl);
    updateBadge();
    if (isEnded(msg.status)) jobDone(job);
  }
}

function onPortDisconnect() {
  const err = browser.runtime.lastError;
  const message = 'Native host disconnected' + (err && err.message ? ': ' + err.message : '');
  port = null;

  Object.values(pendingRequests).forEach((p) => p.reject(new Error(message)));
  for (const id in pendingRequests) delete pendingRequests[id];

  // Queued jobs keep waiting; only the one the dead host was running fails.
  // Collect it first: jobDone starts the next queued job, which must not be failed too.
  const dead = Object.values(jobs).filter(isRunning);
  dead.forEach((job) => {
    job.status = 'error';
    job.error = message;
    broadcast(job.tabUrl);
  });
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
function enqueue(message) {
  const { type, tabUrl, ...params } = message;
  const sig = JSON.stringify(params);
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
  notifyStarted(job);
  (async () => {
    try {
      const cookies = job.source === 'twitter' ? await getXCookies() : null;
      ensurePort().postMessage({ ...params, type: 'download', requestId: job.id, cookies });
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      broadcast(job.tabUrl);
      jobDone(job);
    }
  })();
  broadcast(job.tabUrl);
  updateBadge();
}

// A job that failed before it could be queued (e.g. the folder dialog), so the popup shows why.
function failJob(message, error) {
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

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'getFormats') {
    return sendRequest({ type: 'formats', requestId: newRequestId(), url: message.url }).catch(failure);
  }

  if (message.type === 'getTweet') {
    return getXCookies()
      .then((cookies) => sendRequest({ type: 'tweet', requestId: newRequestId(), url: message.url, cookies }))
      .catch(failure);
  }

  if (message.type === 'translate') {
    return sendRequest({ type: 'translate', requestId: newRequestId(), texts: message.texts, target: message.target }, TRANSLATE_TIMEOUT_MS).catch(failure);
  }

  if (message.type === 'startDownload') {
    return Promise.resolve(enqueue(message));
  }

  if (message.type === 'startDownloadTo') {
    return browseFolder(message.source)
      .then((path) => {
        if (path) enqueue({ ...message, downloadDir: path });
      })
      .catch((err) => failJob(message, 'Could not choose a folder: ' + err.message));
  }

  if (message.type === 'pickDir') {
    return browseFolder(message.source)
      .then((path) => {
        if (!path) return { cancelled: true };
        return sendRequest({ type: 'setConfig', requestId: newRequestId(), config: { [DIR_KEYS[message.source]]: path } });
      })
      .catch(failure);
  }

  // Where the page's video is playing, so a clip can start there (null: no video / no access).
  if (message.type === 'getPlayhead') {
    return browser.tabs.executeScript(message.tabId, { code: "(() => { const v = document.querySelector('video.html5-main-video') || document.querySelector('video'); return v && isFinite(v.currentTime) ? v.currentTime : null; })()" })
      .then((res) => ({ time: res && res[0] }))
      .catch(() => ({ time: null }));
  }

  if (message.type === 'scanPage') {
    return browser.tabs.executeScript(message.tabId, { file: 'scan.js', allFrames: true })
      .then(mergeScans)
      .catch((e) => failure(Object.assign(new Error("This page can't be scanned."), {
        code: 'E_UNSUPPORTED_URL',
        hint: 'Reload the page, then open nickel.tools from the toolbar again.',
        detail: e.message,
      })));
  }

  if (message.type === 'getJob') {
    clearBadgeFlash();
    return Promise.resolve({ job: publicJob(latestJobFor(message.tabUrl)), queue: queueSnapshot() });
  }

  // Pause / resume / cancel the running download (the host acts on it at its next progress report).
  if (message.type === 'controlJob') {
    const job = jobs[message.id];
    if (!job || !isRunning(job) || !['pause', 'resume', 'cancel'].includes(message.action)) {
      return Promise.resolve({ ok: false, error: 'This download is no longer running.' });
    }
    return sendRequest({ type: 'controlJob', requestId: newRequestId(), jobId: job.id, action: message.action }, HOST_TIMEOUT_MS)
      .then(() => {
        job.pending = message.action;
        broadcast(job.tabUrl);
        return { ok: true };
      })
      .catch(failure);
  }

  // Only a job still waiting can be removed here; a running one is stopped with controlJob.
  if (message.type === 'removeQueued') {
    const job = jobs[message.id];
    const removed = !!job && job.status === 'queued';
    if (removed) {
      delete jobs[job.id];
      broadcast(job.tabUrl);
      updateBadge();
    }
    return Promise.resolve({ removed });
  }

  if (message.type === 'getConfig') {
    return sendRequest({ type: 'getConfig', requestId: newRequestId() }).catch(failure);
  }

  if (message.type === 'setConfig') {
    return sendRequest({ type: 'setConfig', requestId: newRequestId(), config: message.config }).catch(failure);
  }

  // Settings helpers; an old host never answers these.
  if (message.type === 'openPath') {
    return sendRequest({ type: 'openPath', requestId: newRequestId(), path: message.path, source: message.source }, HOST_TIMEOUT_MS).catch(failure);
  }

  if (message.type === 'revealFile') {
    return sendRequest({ type: 'revealFile', requestId: newRequestId(), path: message.path }, HOST_TIMEOUT_MS).catch(failure);
  }
});
