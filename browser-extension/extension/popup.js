// Shared popup logic: tab switching, job/progress + error rendering, settings
// and theme. The YouTube and Twitter panels live in youtube.js / twitter.js and
// plug in through the `panels` registry below. The Web panel lives in web.js.

const HTTP_URL_RE = /^https?:\/\//i;
const TWEET_URL_RE = /^https?:\/\/(?:[\w-]+\.)?(?:x|twitter)\.com\/(?:[^/?#]+|i\/web)\/status(?:es)?\/\d+/i;

const X_HOST_RE = /^https?:\/\/(?:[\w-]+\.)?(?:x|twitter)\.com\//i;

const ACTION_LOCK_MS = 600;

const $ = (id) => document.getElementById(id);

const downloadBtn = $('download');
const downloadToBtn = $('download-to');
const actionsEl = $('actions');
const progressWrap = $('progress-wrap');
const progressBar = $('progress-bar');
const progressText = $('progress-text');
const jobErrorEl = $('job-error');

let currentTabUrlValue = null;
let currentTabId = null;
let activeTab = 'youtube';
let lastJob = null; // the newest job of the current tab
let queue = []; // running + waiting jobs across all tabs: [{ id, title, source, mode, status, percent, tabUrl }]
let actionsLocked = false; // briefly set after a click, against double-clicks

// name -> { el, accepts(url), hint, loadingText, load(url) -> Promise, payload() -> {...},
//           state: undefined | 'loading' | 'ready' | 'error' | 'unsupported' }
const panels = {};

// ---------------------------------------------------------------- helpers

// Background replies { ok: false, error, errorCode, errorHint, errorDetail }
// on failure (both browsers); turn that into a thrown error carrying the code.
class AppError extends Error {
  constructor(res) {
    super(res.error);
    this.code = res.errorCode;
    this.hint = res.errorHint;
    this.detail = res.errorDetail;
  }
}

function send(message) {
  return browser.runtime.sendMessage(message).then((res) => {
    if (res && res.ok === false) throw new AppError(res);
    return res;
  });
}

// Like send(), for requests that must be answered. An empty reply means the
// background script doesn't know the message (a stale copy still running
// after an update), so say that instead of letting callers crash on undefined.
function request(message) {
  return send(message).then((res) => {
    if (res == null) {
      throw new Error('No reply from the extension background. Reload the extension (or restart the browser) and try again.');
    }
    return res;
  });
}

// Last-used options for a panel (storage.local), unless the user turned
// "Remember my last-used options" off in Settings.
async function loadPrefs(keys) {
  const { rememberOptions } = await browser.storage.local.get('rememberOptions');
  return rememberOptions === false ? {} : browser.storage.local.get(keys);
}

// The tab being downloaded from: the one the popup was opened on, or the one a
// detached window was opened for (?tabId=...).
const detachedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;

function currentTab() {
  if (detachedTabId) return browser.tabs.get(detachedTabId);
  return browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]);
}

function formatBytes(bytes) {
  if (bytes == null) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(i === 0 ? 0 : (n < 10 ? 1 : 0)) + ' ' + units[i];
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

const SOURCE_TILES = { youtube: 'YT', twitter: 'X', web: 'WEB' };

// Constant markup only (never page text), so innerHTML is safe here.
const ICONS = {
  folder: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.2 1.5h6.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>',
  page: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
  remove: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

function iconButton(icon, label, onClick, disabled) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-mini';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = ICONS[icon];
  btn.disabled = !!disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

// One row of the queue and history lists: source tile, title, muted meta line
// and icon buttons. Titles come from pages, so everything is set via textContent.
function listItem({ source, title, meta, actions = [] }) {
  const item = document.createElement('div');
  item.className = 'list-item';
  const text = document.createElement('div');
  text.className = 'li-text';
  const titleEl = textNode('div', 'li-title', title);
  titleEl.title = title;
  text.append(titleEl, textNode('div', 'li-meta', meta));
  const buttons = document.createElement('div');
  buttons.className = 'li-actions';
  buttons.append(...actions);
  item.append(textNode('span', 'src-tile', SOURCE_TILES[source] || SOURCE_TILES.youtube), text, buttons);
  return item;
}

// err: { code, message, hint, detail }. Built with textContent only, since
// message/detail can echo page or server text.
function fillError(el, err) {
  el.replaceChildren();
  if (err.code) el.append(textNode('span', 'err-code', err.code));
  el.append(textNode('div', 'err-msg', err.message));
  if (err.hint) el.append(textNode('div', 'err-hint', err.hint));
  if (err.detail && err.detail !== err.message) {
    const details = document.createElement('details');
    details.append(textNode('summary', '', 'Details'), textNode('pre', '', err.detail));
    el.append(details);
  }
  el.classList.remove('hidden');
}

function panelMessage(name, text) {
  const el = panels[name].el;
  el.querySelector('.msg').textContent = text;
  el.querySelector('.error-box').classList.add('hidden');
}

function panelError(name, err) {
  const el = panels[name].el;
  el.querySelector('.msg').textContent = '';
  fillError(el.querySelector('.error-box'), { code: err.code, message: err.message, hint: err.hint, detail: err.detail });
}

// Shown when the native host answers with an older payload than the popup expects.
function noteOutdatedHost(name, outdated) {
  panels[name].el.querySelector('.host-note').classList.toggle('hidden', !outdated);
}

function noteYtdlp(info) {
  if (!info || !info.version) return;
  const age = info.age_days != null ? ' (' + info.age_days + ' days old)' : '';
  const el = $('ytdlp-info');
  el.textContent = 'yt-dlp ' + info.version + age;
  el.classList.toggle('is-stale', info.age_days != null && info.age_days > 90);
}

// ------------------------------------------------------------------ tabs

// Reflects the selected output in the footer button, the hint under it and the
// filename extension badge. Panels expose output() -> { label, ext, hint }.
function refreshOutput() {
  const panel = panels[activeTab];
  const out = panel && panel.state === 'ready' && panel.output ? panel.output() : null;
  // With downloads ahead, a new one is queued behind them.
  const verb = queue.length ? 'Queue' : 'Download';
  $('download-label').textContent = out ? verb + ' ' + out.label : verb;
  $('action-hint').textContent = queue.length
    ? 'Starts after ' + queue.length + (queue.length === 1 ? ' download' : ' downloads') + ' ahead'
    : (out && out.hint ? out.hint : '');
  if (panel && panel.extEl) panel.extEl.textContent = out ? out.ext : '';
}

// A running job no longer blocks the buttons: another click just queues behind it.
function syncActions() {
  const panel = panels[activeTab];
  actionsEl.classList.toggle('hidden', panel.state !== 'ready');
  const blocked = actionsLocked || (panel.canDownload && !panel.canDownload());
  downloadBtn.disabled = blocked;
  downloadToBtn.disabled = blocked;
  refreshOutput();
}

function lockActions() {
  actionsLocked = true;
  syncActions();
  setTimeout(() => {
    actionsLocked = false;
    syncActions();
  }, ACTION_LOCK_MS);
}

const WEB_FALLBACK_CODES = ['E_UNSUPPORTED_URL', 'E_NO_MEDIA', 'E_EXTRACTOR_BROKEN', 'E_UNKNOWN'];
const YOUTUBE_HOST_RE = /^https?:\/\/(?:[\w-]+\.)?(?:youtube\.com|youtu\.be)\//i; // keep its yt-dlp error visible

function loadPanel(name) {
  const panel = panels[name];
  if (panel.state) return;
  if (!panel.accepts(currentTabUrlValue)) {
    panel.state = 'unsupported';
    panelMessage(name, typeof panel.hint === 'function' ? panel.hint(currentTabUrlValue) : panel.hint);
    return;
  }
  panel.state = 'loading';
  panelMessage(name, panel.loadingText);
  panel.load(currentTabUrlValue)
    .then(() => {
      panel.state = 'ready';
      panelMessage(name, '');
      syncActions();
    })
    .catch((err) => {
      panel.state = 'error';
      panelError(name, err);
      syncActions();
      // yt-dlp can't use this page (no video, or the site blocks/breaks its
      // extractor): the Web tab can still list its images and files.
      if (name === 'youtube' && WEB_FALLBACK_CODES.includes(err.code) && !YOUTUBE_HOST_RE.test(currentTabUrlValue) && activeTab === name && panels.web && panels.web.accepts(currentTabUrlValue)) {
        selectTab('web');
      }
    });
}

function selectTab(name) {
  activeTab = name;
  document.body.dataset.tab = name; // the Twitter and Web tabs get a wider popup
  document.querySelectorAll('#tabs [role="tab"]').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  });
  for (const key in panels) panels[key].el.classList.toggle('hidden', key !== name);
  loadPanel(name);
  renderJob(lastJob);
}

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[role="tab"]');
  if (tab) selectTab(tab.dataset.tab);
});

// -------------------------------------------------------------- job / UI

function renderJob(job) {
  lastJob = job || null;
  const show = !!job && (job.source || 'youtube') === activeTab;
  progressWrap.classList.toggle('hidden', !show);
  syncActions();
  if (!show) return;

  const percent = job.percent || 0;
  progressBar.style.transform = 'scaleX(' + (percent / 100) + ')';
  if (job.status === 'queued') {
    const place = queue.filter((j) => j.status === 'queued').findIndex((j) => j.id === job.id) + 1;
    progressText.textContent = 'Queued' + (place ? ' · #' + place + ' in line' : '…');
  } else if (job.status === 'starting') {
    progressText.textContent = 'Starting…';
  } else if (job.status === 'downloading') {
    progressText.textContent = 'Downloading' + (job.total > 1 ? ' ' + job.item + ' of ' + job.total : '') + '… ' + percent + '%';
  } else if (job.status === 'converting') {
    progressText.textContent = 'Converting' + (job.total > 1 ? ' ' + job.item + ' of ' + job.total : '') + '…' + (job.source === 'twitter' ? ' ' + percent + '%' : '');
  } else if (job.status === 'tagging') {
    progressText.textContent = 'Writing tags…';
  } else if (job.status === 'rendering') {
    progressText.textContent = 'Rendering card… ' + percent + '%';
  } else if (job.status === 'finished') {
    progressText.textContent = 'Saved as ' + job.filename + (job.warning ? '\n' + job.warning : '');
  } else if (job.status === 'error') {
    progressText.textContent = 'Failed';
  }
  progressWrap.classList.toggle('is-success', job.status === 'finished');
  progressWrap.classList.toggle('is-error', job.status === 'error');
  if (job.status === 'error') {
    fillError(jobErrorEl, { code: job.errorCode, message: job.error, hint: job.errorHint, detail: job.errorDetail });
  } else {
    jobErrorEl.classList.add('hidden');
  }
}

const STATUS_LABELS = { starting: 'Starting', downloading: 'Downloading', converting: 'Converting', tagging: 'Writing tags', rendering: 'Rendering card' };

function queueItem(job) {
  const waiting = job.status === 'queued';
  const actions = waiting
    ? [iconButton('remove', 'Remove from queue', () => send({ type: 'removeQueued', id: job.id }).then(refreshJobState).catch(() => {}))]
    : [];
  return listItem({
    source: job.source,
    title: job.title || 'Download',
    meta: waiting ? 'Waiting' : (STATUS_LABELS[job.status] || 'Working') + (job.status === 'starting' ? '' : ' · ' + Math.round(job.percent || 0) + '%'),
    actions,
  });
}

// Collapsible list in the footer; hidden while nothing is queued or running.
function renderQueue() {
  const running = queue.filter((job) => job.status !== 'queued').length;
  const waiting = queue.length - running;
  $('queue').classList.toggle('hidden', !queue.length);
  $('queue-summary').textContent = 'Queue · ' + [running && running + ' running', waiting && waiting + ' waiting'].filter(Boolean).join(', ');
  $('queue-list').replaceChildren(...queue.map(queueItem));
}

// The background replies { job, queue }; a stale copy still running after an
// update replies with just the job.
const readJobState = (res) => (res && Array.isArray(res.queue) ? res : { job: res || null, queue: [] });

function applyJobState(res, forThisTab = true) {
  const state = readJobState(res);
  queue = state.queue;
  renderQueue();
  if (forThisTab) renderJob(state.job);
  else syncActions();
}

function refreshJobState() {
  return send({ type: 'getJob', tabUrl: currentTabUrlValue }).then((res) => applyJobState(res)).catch(syncActions);
}

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'jobUpdate') applyJobState(message, message.tabUrl === currentTabUrlValue);
});

function buildPayload(type) {
  const url = currentTabUrlValue;
  return Object.assign({ type, tabUrl: url, url, source: activeTab }, panels[activeTab].payload());
}

// `extra` merges into the request, e.g. { downloadDir } for a one-off folder.
// The background queues the job (or ignores an exact repeat), then we resync.
function startDownload(extra) {
  lockActions();
  send(Object.assign(buildPayload('startDownload'), extra))
    .then(refreshJobState)
    .catch((err) => renderJob({ status: 'error', error: err.message, source: activeTab }));
}

// The folder dialog steals focus, which closes the popup, so the background
// script owns the whole sequence (pick a folder, then queue the job). If the
// popup is still open afterwards it just follows the job's updates.
function startDownloadTo() {
  downloadToBtn.disabled = true;
  send(buildPayload('startDownloadTo'))
    .then(refreshJobState)
    .catch((err) => {
      syncActions();
      renderJob({ status: 'error', error: 'Could not start the download: ' + err.message, source: activeTab });
    });
}

downloadBtn.addEventListener('click', () => startDownload());
downloadToBtn.addEventListener('click', startDownloadTo);

// --------------------------------------------------------------- settings

const settingsToggleBtn = $('settings-toggle');
const settingsPanel = $('settings-panel');
const mainEl = $('main');
const settingsStatusEl = $('settings-status');

// One save location per tab. `key` is the field name in the host's config
// messages; `loaded` is the last value the host reported, so Save is only
// enabled for edited fields and only those are sent (an untouched Twitter
// field that is inheriting the YouTube path must not get pinned to it).
const dirFields = {
  youtube: { input: $('download-dir'), browse: $('browse-dir'), key: 'downloadDir', loaded: '' },
  twitter: { input: $('twitter-dir'), browse: $('browse-twitter-dir'), key: 'twitterDownloadDir', loaded: '' },
  web: { input: $('web-dir'), browse: $('browse-web-dir'), key: 'webDownloadDir', loaded: '' },
};

// Toggles and selects in the Settings panel (`data-setting`) save straight to
// storage.local as they change; background.js reads the notification/badge ones.
const SETTING_DEFAULTS = {
  showBadge: true, notifyStart: true, notifyFinish: true, notifyError: true, autoReveal: false,
  rememberOptions: true, useXLogin: true,
  theme: 'system', defaultTab: 'auto',
};
const settingInputs = [...document.querySelectorAll('[data-setting]')];
const containerSeg = $('set-container');
const HISTORY_SHOWN = 5;

function setSettingsStatus(text) {
  settingsStatusEl.textContent = text;
}

function flashSettingsStatus(text) {
  setSettingsStatus(text);
  setTimeout(() => setSettingsStatus(''), 1500);
}

function isDirDirty(field) {
  return field.input.value.trim() !== field.loaded;
}

function applyConfig(res) {
  for (const field of Object.values(dirFields)) {
    field.loaded = res[field.key] || '';
    field.input.value = field.loaded;
  }
}

function renderSettingValues(stored) {
  settingInputs.forEach((input) => {
    const key = input.dataset.setting;
    const value = stored[key] != null ? stored[key] : SETTING_DEFAULTS[key];
    if (input.type === 'checkbox') input.checked = value !== false;
    else input.value = String(value);
  });
  const container = stored.defaultContainer || 'mp4';
  containerSeg.querySelectorAll('[data-container]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.container === container)));
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const TIME_UNITS = [['day', 86400], ['hour', 3600], ['minute', 60]];

// "5 minutes ago", "yesterday", "now".
function timeAgo(at) {
  const seconds = Math.round((at - Date.now()) / 1000);
  const [unit, size] = TIME_UNITS.find(([, s]) => Math.abs(seconds) >= s) || ['second', 1];
  return relativeTime.format(unit === 'second' ? 0 : Math.round(seconds / size), unit);
}

let historyEntries = [];
let historyExpanded = false;

function historyItem(entry, index) {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(entry.filename || '');
  const actions = [iconButton('folder', 'Show in folder', () => send({ type: 'revealFile', path: entry.path }).catch((err) => flashSettingsStatus('Error: ' + err.message)), !entry.path)];
  // Entries saved by older versions have no page URL.
  if (HTTP_URL_RE.test(entry.url || '')) actions.push(iconButton('page', 'Open the source page', () => browser.tabs.create({ url: entry.url })));
  actions.push(iconButton('remove', 'Remove from history', () => {
    historyEntries.splice(index, 1);
    browser.storage.local.set({ history: historyEntries }).then(() => renderHistory(historyEntries, historyExpanded));
  }));
  return listItem({
    source: entry.source,
    title: entry.title || entry.filename || 'Saved',
    meta: [ext && ext[1].toUpperCase(), entry.at && timeAgo(entry.at)].filter(Boolean).join(' · '),
    actions,
  });
}

function renderHistory(history, showAll = false) {
  historyEntries = history || [];
  historyExpanded = showAll;
  const total = historyEntries.length;
  $('history-title').textContent = 'Recent downloads' + (total ? ' (' + total + ')' : '');
  $('clear-history').disabled = !total;
  const shown = showAll ? historyEntries : historyEntries.slice(0, HISTORY_SHOWN);
  $('history-list').replaceChildren(...(total ? shown.map(historyItem) : [textNode('div', 'list-empty hint', 'No downloads yet')]));
  const more = $('history-more');
  more.classList.toggle('hidden', total <= HISTORY_SHOWN);
  more.textContent = showAll ? 'Show less' : 'Show all (' + total + ')';
}

function loadSettings() {
  setSettingsStatus('Loading…');
  request({ type: 'getConfig' })
    .then((res) => {
      applyConfig(res);
      $('about-info').textContent = 'nickel.tools ' + browser.runtime.getManifest().version + ' · '
        + (res.hostVersion ? 'host ' + res.hostVersion : 'host outdated (reinstall nickel.tools to update it)');
      noteYtdlp(res.ytdlp);
      setSettingsStatus('');
    })
    .catch((err) => {
      setSettingsStatus('Error: ' + err.message);
    });
  browser.storage.local.get([...Object.keys(SETTING_DEFAULTS), 'defaultContainer', 'history']).then((stored) => {
    renderSettingValues(stored);
    renderHistory(stored.history);
  });
}

// A typed path saves when the field loses focus or Enter is pressed; only that
// field is sent, so an untouched one inheriting the YouTube path isn't pinned.
function saveDir(field) {
  if (!isDirDirty(field)) return;
  setSettingsStatus('Saving…');
  request({ type: 'setConfig', config: { [field.key]: field.input.value.trim() } })
    .then((res) => {
      applyConfig(res);
      flashSettingsStatus('Saved');
    })
    .catch((err) => {
      setSettingsStatus('Error: ' + err.message);
    });
}

Object.values(dirFields).forEach((field) => field.input.addEventListener('change', () => saveDir(field)));

settingInputs.forEach((input) => {
  input.addEventListener('change', () => {
    const key = input.dataset.setting;
    let value = input.type === 'checkbox' ? input.checked : input.value;
    browser.storage.local.set({ [key]: value });
    if (key === 'theme') applyThemePref(value);
  });
});

containerSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-container]');
  if (!btn) return;
  browser.storage.local.set({ defaultContainer: btn.dataset.container });
  containerSeg.querySelectorAll('[data-container]').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
});

// Matches --duration-base in popup.css. The settings panel and the main UI
// are tall enough together to push the popup past the browser's max popup
// height, so they're shown one at a time; sequencing the fade avoids both
// being laid out at once.
const PANEL_FADE_MS = 150;

settingsToggleBtn.addEventListener('click', () => {
  const opening = settingsPanel.classList.contains('hidden');
  $('app').classList.toggle('settings-open', opening);
  settingsToggleBtn.setAttribute('aria-pressed', String(opening));
  settingsToggleBtn.title = opening ? 'Close settings' : 'Settings';
  if (opening) {
    loadSettings();
    mainEl.classList.add('hidden');
    setTimeout(() => settingsPanel.classList.remove('hidden'), PANEL_FADE_MS);
  } else {
    settingsPanel.classList.add('hidden');
    setTimeout(() => mainEl.classList.remove('hidden'), PANEL_FADE_MS);
  }
});

// The background script picks the folder and saves it (the popup may close
// while the dialog is open); if we are still here, show the stored result.
Object.entries(dirFields).forEach(([name, field]) => {
  field.browse.addEventListener('click', () => {
    field.browse.disabled = true;
    setSettingsStatus('Choose a folder…');
    request({ type: 'pickDir', source: name })
      .then((res) => {
        field.browse.disabled = false;
        if (res && res.cancelled) {
          setSettingsStatus(''); // user cancelled the dialog
          return;
        }
        applyConfig(res);
        flashSettingsStatus('Saved');
      })
      .catch((err) => {
        field.browse.disabled = false;
        setSettingsStatus('Error: ' + err.message);
      });
  });
});

document.querySelectorAll('[data-open]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const field = dirFields[btn.dataset.open];
    // An empty field is an inherited location; the host resolves it to the
    // folder that downloads for this tab actually land in.
    request({ type: 'openPath', source: btn.dataset.open, path: field.input.value.trim() })
      .then(() => flashSettingsStatus('Opened folder'))
      .catch((err) => setSettingsStatus('Error: ' + err.message));
  });
});

$('clear-history').addEventListener('click', () => {
  browser.storage.local.remove('history').then(() => renderHistory([]));
});

$('history-more').addEventListener('click', () => renderHistory(historyEntries, !historyExpanded));

// Two clicks, so a stray one can't wipe the settings.
const resetBtn = $('reset-settings');
let resetTimer = null;
resetBtn.addEventListener('click', () => {
  if (resetTimer === null) {
    resetBtn.textContent = 'Click again to reset';
    resetTimer = setTimeout(() => {
      resetBtn.textContent = 'Reset';
      resetTimer = null;
    }, 4000);
    return;
  }
  clearTimeout(resetTimer);
  resetTimer = null;
  resetBtn.textContent = 'Reset';
  browser.storage.local.clear()
    .then(() => send({ type: 'setConfig', config: { downloadDir: '', twitterDownloadDir: '', webDownloadDir: '' } }))
    .then(() => {
      applyThemePref('system');
      loadSettings();
      flashSettingsStatus('Settings reset');
    })
    .catch((err) => setSettingsStatus('Error: ' + err.message));
});

// -------------------------------------------------------------- pop-out

const popoutBtn = $('popout-btn');
if (detachedTabId) document.body.classList.add('is-detached');
if (!browser.windows) popoutBtn.classList.add('hidden'); // e.g. Firefox Android

// A popup closes the moment it loses focus; a window of its own does not.
popoutBtn.addEventListener('click', () => {
  browser.windows.create({ url: 'popup.html?tabId=' + currentTabId, type: 'popup', width: 520, height: 700 })
    .then(() => window.close());
});

// ------------------------------------------------------------------ theme

const themeToggleBtn = $('theme-toggle');
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let themePref = 'system';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  themeToggleBtn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

// 'system' follows the OS (and tracks it live); 'light' / 'dark' are fixed.
function applyThemePref(pref) {
  themePref = pref;
  applyTheme(pref === 'system' ? (systemDark.matches ? 'dark' : 'light') : pref);
}

systemDark.addEventListener('change', () => {
  if (themePref === 'system') applyThemePref('system');
});

themeToggleBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyThemePref(next);
  $('set-theme').value = next;
  browser.storage.local.set({ theme: next });
});

// ------------------------------------------------------------------- init

// "Open on tab" setting; Auto opens a tweet link on the Twitter tab, anything else on YouTube.
function startTab(url, pref) {
  if (pref && pref !== 'auto' && panels[pref]) return pref;
  return TWEET_URL_RE.test(url) ? 'twitter' : 'youtube';
}

function init() {
  const stored = browser.storage.local.get(['theme', 'defaultTab']);
  stored.then((s) => applyThemePref(s.theme || 'system'));

  Promise.all([stored, currentTab()]).then(async ([s, tab]) => {
    const url = tab.url;
    currentTabUrlValue = url;
    currentTabId = tab.id;
    // A missing/stale background must not leave the popup stuck on "Loading…".
    const state = readJobState(await send({ type: 'getJob', tabUrl: url }).catch(() => null));
    lastJob = state.job;
    queue = state.queue;
    renderQueue();
    selectTab(startTab(url, s.defaultTab));
  }).catch((err) => {
    panelError('youtube', { message: 'Could not start: ' + err.message, hint: 'Reload the extension or restart the browser.' });
  });
}

// twitter.js registers panels.twitter at script load; init runs after both.
document.addEventListener('DOMContentLoaded', init);
