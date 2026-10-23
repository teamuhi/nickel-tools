// YouTube (and any other yt-dlp site) panel: video download with a resolution
// picker, a clip of a video (trim timeline + resolution), and a music-style audio download with format choice, automatic
// tags + cover art and an optional metadata editor. Registers itself into
// popup.js's `panels` registry.

(() => {
  const META_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'date', 'track', 'genre'];
  const COVER_MAX_PX = 1200;
  // Rough size of lossless output relative to uncompressed 16-bit/44.1 kHz stereo PCM.
  const LOSSLESS_RATIO = { wav: 1, flac: 0.55, alac: 0.6 };
  const FALLBACK_BEST_KBPS = { mp3: 192, m4a: 128, opus: 128, ogg: 160 };

  // Preferred video codec -> label and container (mirrors backend/core.py VIDEO_CODECS).
  const VIDEO_CODECS = {
    h264: { label: 'H.264 + AAC', ext: 'mp4' },
    vp9: { label: 'VP9 + Opus', ext: 'webm' },
    av1: { label: 'AV1 + Opus', ext: 'webm' },
  };

  const CONTAINERS = ['mp4', 'mkv', 'webm'];
  const CLIP_DEFAULT_SECONDS = 10; // initial length of a new clip
  const PREVIEW_DEFAULT_VOLUME = 0.1; // the starting level, and what the sound button restores when the slider was at 0
  const PREVIEW_SCRUB_MS = 120; // wait for a dragged handle to settle before seeking the preview
  const CLIP_MIN_AHEAD = 1; // a playhead closer than this to the end starts the clip at 0 instead

  const el = {
    container: $('yt-container'),
    kind: $('yt-kind'), video: $('yt-video'), audio: $('yt-audio'), thumb: $('thumb'), mp4Quality: $('mp4-quality'), codec: $('video-codec'),
    hero: $('yt-hero'), duration: $('yt-duration'), vTitle: $('yt-vtitle'), vChannel: $('yt-vchannel'),
    title: $('title'), ext: $('yt-ext'),
    cover: $('yt-cover'), coverEmpty: $('yt-cover-empty'), mcTitle: $('mc-title'), mcArtist: $('mc-artist'), mcAlbum: $('mc-album'), mcBadge: $('mc-badge'),
    afmt: $('yt-afmt'), aqRow: $('yt-aq-row'), aquality: $('yt-aquality'),
    tags: $('yt-tags'), square: $('yt-square'), squareRow: $('yt-square-row'), edit: $('yt-edit'), editRow: $('yt-edit-row'),
    form: $('yt-meta-form'), coverFile: $('yt-cover-file'), withAudio: $('yt-with-audio'),
    codecRow: $('yt-codec-row'), clipBox: $('yt-clip'), clipLen: $('yt-clip-len'), clipEst: $('yt-clip-est'),
    preview: $('yt-preview'), sound: $('yt-preview-sound'), soundBox: $('yt-preview-vol'), bar: $('yt-preview-bar'), play: $('yt-preview-play'), seek: $('yt-preview-seek'), time: $('yt-preview-time'), note: $('yt-preview-note'), volume: $('yt-preview-volume'),
  };
  const fields = Object.fromEntries(META_FIELDS.map((k) => [k, $('mf-' + k)]));

  let info = null;
  let kind = 'video'; // 'video' | 'audio' | 'clip'
  let prefs = { format: 'mp3', quality: 'best', tags: true, square: true };
  let videoCodec = 'h264';
  let container = 'mp4';
  let cover = { source: 'thumbnail', dataUrl: '' };
  let previewFailed = false; // the stream wouldn't play: the thumbnail stays in the hero
  let previewMuted = false;
  let previewVolume = PREVIEW_DEFAULT_VOLUME; // 0..1
  let soundTouched = false; // only a level the user picked is remembered
  let soundFailed = false; // the audio stream wouldn't play: the sound button goes away
  // The video stream has no sound (YouTube serves audio separately), so a hidden player plays it alongside.
  const previewAudio = new Audio();
  previewAudio.preload = 'auto';

  // The Clip tab's trim timeline; the sizes shown on the page follow the clip length,
  // and dragging a thumb scrubs the preview to it.
  const trimCtl = createTrim({
    range: $('yt-range'), start: $('yt-clip-start'), end: $('yt-clip-end'), startText: $('yt-clip-start-t'), endText: $('yt-clip-end-t'),
    onChange(trim, moved) {
      renderClip();
      updatePreviewBar();
      if (moved) scrubPreview(moved === 'start' ? trim.start : Math.max(trim.start, trim.end - 0.1));
    },
  });

  // Dragging a handle fires many events; seek once the handle settles, to the nearest keyframe where the browser can.
  let scrubTimer = 0;
  function scrubPreview(time) {
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => {
      if (!el.preview.getAttribute('src')) return;
      if (el.preview.fastSeek) el.preview.fastSeek(time); else el.preview.currentTime = time;
    }, PREVIEW_SCRUB_MS);
  }

  const previewShown = () => kind === 'clip' && !!info && !!info.preview_url && !previewFailed;

  const formats = () => info.audio_formats || [];
  const currentFormat = () => formats().find((f) => f.id === prefs.format) || formats()[0];
  const isLossy = (f) => f && f.qualities.length > 0;

  function savePrefs() {
    browser.storage.local.set({ ytKind: kind, ytAudio: prefs, ytCodec: videoCodec, ytContainer: container, ...(soundTouched && { ytPreviewVolume: { muted: previewMuted, volume: previewVolume } }) });
  }

  // WebM only carries VP9/AV1 (+ Opus), so it narrows the codec list and is
  // unavailable when the page offers neither. MP4/MKV take any offered codec.
  // A clip is re-encoded, so it can always be WebM (and has no codec choice).
  function renderVideoOptions() {
    const offered = info.video_codecs && info.video_codecs.length ? info.video_codecs : ['h264'];
    const webmCodecs = offered.filter((c) => c !== 'h264' && VIDEO_CODECS[c]);
    const webmOk = webmCodecs.length > 0 || kind === 'clip';
    el.container.querySelector('[data-container="webm"]').disabled = !webmOk;
    if (container === 'webm' && !webmOk) container = 'mp4';
    el.container.querySelectorAll('[data-container]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.container === container)));

    const codecs = (container === 'webm' ? webmCodecs : offered).filter((c) => VIDEO_CODECS[c]);
    el.codec.replaceChildren(...codecs.map((c) => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = VIDEO_CODECS[c].label;
      return opt;
    }));
    if (codecs.length && !codecs.includes(videoCodec)) videoCodec = codecs[0];
    el.codec.value = videoCodec;
  }

  // ------------------------------------------------------------- metadata

  // What the file will carry: the editor's values while it is open, else the automatic ones.
  function liveMeta() {
    if (!el.edit.checked) return info.meta;
    return Object.assign({}, info.meta, Object.fromEntries(META_FIELDS.map((k) => [k, fields[k].value.trim()])));
  }

  function fillFields() {
    META_FIELDS.forEach((k) => { fields[k].value = info.meta[k] || ''; });
  }

  function estimateBytes(fmt, quality) {
    const duration = info.duration;
    if (!duration) return null;
    if (!isLossy(fmt)) return duration * 176400 * (LOSSLESS_RATIO[fmt.id] || 1);
    const kbps = quality === 'best' ? (info.best_audio_kbps || FALLBACK_BEST_KBPS[fmt.id]) : Number(quality);
    return duration * kbps * 125; // kbps * 1000 / 8
  }

  function audioName() {
    const m = liveMeta();
    return m.artist && m.title ? m.artist + ' - ' + m.title : m.title || info.title || '';
  }

  // ------------------------------------------------------------- rendering

  function renderCover() {
    const url = cover.source === 'custom' ? cover.dataUrl : cover.source === 'thumbnail' ? info.thumbnail : '';
    const embedding = el.tags.checked;
    const shown = !!url && embedding;
    el.cover.classList.toggle('hidden', !shown);
    el.coverEmpty.classList.toggle('hidden', shown);
    el.coverEmpty.textContent = embedding ? 'No cover' : 'Not embedded';
    if (shown && el.cover.getAttribute('src') !== url) el.cover.src = url;
    el.cover.classList.toggle('is-contain', !el.square.checked);
  }

  function renderCard() {
    const m = liveMeta();
    const fmt = currentFormat();
    el.mcTitle.textContent = m.title || info.title || 'Untitled';
    el.mcArtist.textContent = el.tags.checked ? (m.artist || 'Unknown artist') : 'Tags off';
    el.mcAlbum.textContent = el.tags.checked ? [m.album, (m.date || '').slice(0, 4)].filter(Boolean).join(' · ') : '';
    el.mcBadge.textContent = fmt ? fmt.label + (isLossy(fmt) && el.aquality.value ? ' · ' + qualityName(el.aquality.value, fmt) : '') : '';
    el.title.placeholder = kind === 'audio' ? audioName() : (info.title || '') + (kind === 'clip' ? ' (clip)' : '');
  }

  function qualityName(q, fmt) {
    return q === 'best' ? (fmt.id === 'mp3' ? 'Best (VBR)' : 'Best') : q + ' kbps';
  }

  function renderQualities() {
    const fmt = currentFormat();
    el.aqRow.classList.toggle('hidden', !isLossy(fmt));
    if (!isLossy(fmt)) return;
    el.aquality.innerHTML = '';
    fmt.qualities.forEach((q) => {
      const opt = document.createElement('option');
      opt.value = q;
      const size = formatBytes(estimateBytes(fmt, q));
      opt.textContent = qualityName(q, fmt) + (size ? ' · ~' + size : '');
      el.aquality.appendChild(opt);
    });
    el.aquality.value = fmt.qualities.includes(prefs.quality) ? prefs.quality : 'best';
  }

  function renderFormats() {
    el.afmt.innerHTML = '';
    formats().forEach((f) => {
      const label = document.createElement('label');
      label.className = 'fmt-card';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'afmt';
      input.value = f.id;
      input.checked = f.id === currentFormat().id;
      label.append(input, textNode('span', 'fmt-name', f.label), textNode('span', 'fmt-sub', f.sub));
      el.afmt.appendChild(label);
    });
  }

  // Resolution list with sizes; for a clip the size is scaled to the clip length.
  function labelQualities() {
    const { start, end } = trimCtl.get();
    const scale = kind === 'clip' && info.duration ? (end - start) / info.duration : 1;
    (info.video_qualities || []).forEach((q, i) => {
      const size = formatBytes(q.estimated_bytes && q.estimated_bytes * scale);
      el.mp4Quality.options[i].textContent = q.height + 'p' + (size ? ' · ' + (scale < 1 ? '~' : '') + size : '');
    });
  }

  function renderClip() {
    if (!info) return;
    const { start, end } = trimCtl.get();
    const length = end - start;
    el.clipLen.textContent = formatTime(start) + ' → ' + formatTime(end) + ' · ' + length.toFixed(1) + ' s';
    labelQualities();
    const q = (info.video_qualities || []).find((x) => String(x.height) === el.mp4Quality.value);
    const bytes = q && q.estimated_bytes && info.duration ? q.estimated_bytes * length / info.duration : null;
    el.clipEst.textContent = [q && q.height + 'p', bytes && '~' + formatBytes(bytes), length.toFixed(1) + ' s'].filter(Boolean).join(' · ');
  }

  function render() {
    setKind();
    if (kind === 'clip') renderClip();
    el.editRow.classList.toggle('hidden', !el.tags.checked);
    el.squareRow.classList.toggle('hidden', !el.tags.checked);
    el.form.classList.toggle('hidden', !(el.tags.checked && el.edit.checked));
    renderCover();
    renderCard();
    refreshOutput();
  }

  function setKind() {
    el.kind.querySelectorAll('[role="tab"]').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.kind === kind));
    });
    el.video.classList.toggle('hidden', kind === 'audio'); // Video and Clip share the picture + resolution/format rows
    el.clipBox.classList.toggle('hidden', kind !== 'clip');
    el.codecRow.classList.toggle('hidden', kind === 'clip');
    el.audio.classList.toggle('hidden', kind !== 'audio');

    // The Clip tab plays the selected part where the thumbnail is.
    const preview = previewShown();
    el.preview.classList.toggle('hidden', !preview);
    el.thumb.classList.toggle('hidden', preview || !info.thumbnail);
    el.soundBox.classList.toggle('hidden', !preview || soundFailed);
    el.bar.classList.toggle('hidden', !preview);
    el.note.classList.toggle('hidden', !preview);
    el.duration.classList.toggle('hidden', preview || !info.duration);
    if (!preview) {
      el.preview.pause();
    } else {
      scrubPreview(trimCtl.get().start);
    }
  }

  function formatDuration(seconds) {
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? h + ':' + pad(m) + ':' + pad(s % 60) : m + ':' + pad(s % 60);
  }

  function populate(data, playhead) {
    // An older native host sends neither tags nor audio formats; keep the panel usable.
    const outdated = !data.audio_formats || !data.meta || !data.clip;
    info = Object.assign({ audio_formats: [], meta: { title: data.title || '' } }, data);
    noteOutdatedHost('youtube', outdated);
    el.title.value = '';
    el.hero.classList.toggle('hidden', !info.thumbnail && !info.preview_url);
    if (info.thumbnail) el.thumb.src = info.thumbnail;
    el.duration.textContent = info.duration ? formatDuration(info.duration) : '';
    // The stream starts loading now, so it is ready by the time the Clip tab is opened.
    previewFailed = false;
    soundFailed = false;
    el.preview.poster = info.thumbnail || '';
    if (info.preview_url && !!info.clip && !!info.duration) el.preview.src = info.preview_url;
    else el.preview.removeAttribute('src');
    if (info.preview_audio_url && el.preview.getAttribute('src')) previewAudio.src = info.preview_audio_url;
    else previewAudio.removeAttribute('src');
    el.vTitle.textContent = info.title || '';
    el.vChannel.textContent = info.channel || '';

    el.mp4Quality.innerHTML = '';
    (info.video_qualities || []).forEach((q) => el.mp4Quality.appendChild(new Option('', q.height)));
    if (el.mp4Quality.options.length === 0) el.mp4Quality.appendChild(new Option('no video streams found', ''));

    // Clips need an up-to-date host and a known length.
    const clipTab = el.kind.querySelector('[data-kind="clip"]');
    const canClip = !!info.clip && !!info.duration;
    clipTab.disabled = !canClip;
    clipTab.title = canClip ? '' : !info.clip ? 'Update the nickel.tools native host to enable clips' : "This video's length is unknown";
    if (!canClip && kind === 'clip') kind = 'video';
    // The clip starts where the video is playing now (0 when unknown or nearly at the end).
    const from = playhead > 0 && playhead < (info.duration || 0) - CLIP_MIN_AHEAD ? Math.round(playhead * 10) / 10 : 0;
    trimCtl.reset(info.duration || 0, { start: from, end: from + CLIP_DEFAULT_SECONDS });

    // Only codecs the page actually offers (an older host sends none: H.264 only).
    renderVideoOptions();
    labelQualities();

    // Without an audio-capable ffmpeg there is nothing to offer under Audio.
    const audioTab = el.kind.querySelector('[data-kind="audio"]');
    audioTab.disabled = !formats().length;
    audioTab.title = formats().length ? '' : outdated ? 'Update the nickel.tools native host to enable audio' : 'Audio needs an ffmpeg build with audio encoders';
    if (!formats().length) kind = 'video';
    if (formats().length) {
      prefs.format = (formats().find((f) => f.id === prefs.format) || formats()[0]).id;
      el.tags.checked = prefs.tags;
      el.square.checked = prefs.square;
      el.edit.checked = false;
      cover = { source: 'thumbnail', dataUrl: '' };
      fillFields();
      renderFormats();
      renderQualities();
    }
    noteYtdlp(info.ytdlp);
    $('video-info').classList.remove('hidden');
    render();
  }

  // ------------------------------------------------------------- output

  function output() {
    if (kind === 'clip') {
      return { label: container.toUpperCase() + ' clip', ext: '.' + container, hint: 'Only the selected part is downloaded' + (el.withAudio.checked ? '.' : ', without audio.') };
    }
    if (kind === 'video') {
      return { label: container.toUpperCase(), ext: '.' + container, hint: el.withAudio.checked ? 'Video with audio.' : 'Video only, no audio.' };
    }
    const fmt = currentFormat();
    const bytes = !isLossy(fmt) ? estimateBytes(fmt) : null;
    const size = bytes ? '~' + formatBytes(bytes) : '';
    const tagNote = !el.tags.checked ? 'No tags.' : fmt.id === 'wav' ? 'Tag support for WAV varies by player.' : 'Tagged with title, artist & cover.';
    return { label: fmt.label, ext: '.' + fmt.ext, hint: [size, tagNote].filter(Boolean).join(' · ') };
  }

  // ------------------------------------------------------------- cover

  // Any picked image is re-encoded as a JPEG of at most COVER_MAX_PX before it is sent to the host.
  function loadCoverFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, COVER_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      cover = { source: 'custom', dataUrl: canvas.toDataURL('image/jpeg', 0.9) };
      URL.revokeObjectURL(url);
      render();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  // ------------------------------------------------------------- listeners

  el.kind.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (!tab || tab.disabled) return;
    kind = tab.dataset.kind;
    renderVideoOptions();
    labelQualities();
    savePrefs();
    render();
  });

  el.afmt.addEventListener('change', (e) => {
    prefs.format = e.target.value;
    savePrefs();
    renderQualities();
    render();
  });

  el.aquality.addEventListener('change', () => {
    prefs.quality = el.aquality.value;
    savePrefs();
    render();
  });

  [['tags', el.tags], ['square', el.square]].forEach(([key, box]) => {
    box.addEventListener('change', () => {
      prefs[key] = box.checked;
      savePrefs();
      render();
    });
  });

  el.edit.addEventListener('change', render);
  Object.values(fields).forEach((input) => input.addEventListener('input', () => { renderCard(); }));
  $('yt-meta-reset').addEventListener('click', () => { fillFields(); cover = { source: 'thumbnail', dataUrl: '' }; render(); });
  $('yt-cover-replace').addEventListener('click', () => el.coverFile.click());
  $('yt-cover-reset').addEventListener('click', () => { cover = { source: 'thumbnail', dataUrl: '' }; render(); });
  $('yt-cover-none').addEventListener('click', () => { cover = { source: 'none', dataUrl: '' }; render(); });
  el.coverFile.addEventListener('change', () => { loadCoverFile(el.coverFile.files[0]); el.coverFile.value = ''; });
  el.mp4Quality.addEventListener('change', () => {
    if (kind === 'clip') renderClip();
    refreshOutput();
  });
  el.withAudio.addEventListener('change', refreshOutput);

  // Start the preview at the clip, loop it inside the clip, and fall back to the thumbnail if the stream won't play.
  el.preview.addEventListener('loadedmetadata', () => { el.preview.currentTime = trimCtl.get().start; });
  el.preview.addEventListener('timeupdate', () => {
    const { start, end } = trimCtl.get();
    if (el.preview.currentTime >= end || el.preview.currentTime < start - 0.25) el.preview.currentTime = start;
    else syncAudio();
  });

  // Keep the audio player on the video's clock.
  const hasAudio = () => previewAudio.hasAttribute('src');
  function syncAudio() {
    if (hasAudio() && Math.abs(previewAudio.currentTime - el.preview.currentTime) > 0.3) previewAudio.currentTime = el.preview.currentTime;
  }
  function playAudio() {
    if (!hasAudio()) return;
    syncAudio();
    previewAudio.play().catch(() => {});
  }
  ['play', 'playing'].forEach((name) => el.preview.addEventListener(name, playAudio));
  ['pause', 'waiting', 'ended'].forEach((name) => el.preview.addEventListener(name, () => previewAudio.pause()));
  ['seeking', 'seeked'].forEach((name) => el.preview.addEventListener(name, syncAudio));
  previewAudio.addEventListener('loadedmetadata', () => { previewAudio.currentTime = trimCtl.get().start; });
  previewAudio.addEventListener('error', () => {
    if (!hasAudio()) return;
    soundFailed = true;
    setKind();
  });

  // Our own play bar (the browser's would show a dead volume button for a video-only stream): play/pause,
  // a position inside the clip, and elapsed / clip length.
  function updatePreviewBar() {
    const { start, end } = trimCtl.get();
    const elapsed = Math.min(end - start, Math.max(0, el.preview.currentTime - start));
    el.seek.max = end - start;
    if (document.activeElement !== el.seek) el.seek.value = elapsed;
    el.time.textContent = elapsed.toFixed(1) + ' / ' + (end - start).toFixed(1) + ' s';
    const playing = !el.preview.paused;
    el.play.innerHTML = ICONS[playing ? 'pause' : 'play'];
    el.play.title = el.play.ariaLabel = playing ? 'Pause preview' : 'Play preview';
  }
  function tickPreviewBar() {
    updatePreviewBar();
    if (!el.preview.paused) requestAnimationFrame(tickPreviewBar);
  }
  el.play.addEventListener('click', () => { if (el.preview.paused) el.preview.play().catch(() => {}); else el.preview.pause(); });
  el.preview.addEventListener('click', () => el.play.click());
  el.seek.addEventListener('input', () => scrubPreview(trimCtl.get().start + Number(el.seek.value)));
  el.preview.addEventListener('play', tickPreviewBar);
  ['pause', 'seeked', 'loadedmetadata'].forEach((name) => el.preview.addEventListener(name, updatePreviewBar));

  // One mute switch + volume slider for whichever stream carries the sound.
  function applySound() {
    el.preview.muted = previewAudio.muted = previewMuted;
    el.preview.volume = previewAudio.volume = previewVolume;
    el.volume.value = previewVolume;
    const silent = previewMuted || previewVolume === 0;
    el.sound.setAttribute('aria-pressed', String(silent));
    el.sound.title = el.sound.ariaLabel = silent ? 'Unmute preview' : 'Mute preview';
  }
  el.sound.addEventListener('click', () => {
    if (previewMuted || previewVolume === 0) {
      previewMuted = false;
      if (previewVolume === 0) previewVolume = PREVIEW_DEFAULT_VOLUME;
    } else {
      previewMuted = true;
    }
    applySound();
    soundTouched = true;
    savePrefs();
  });
  el.volume.addEventListener('input', () => {
    previewVolume = Number(el.volume.value);
    if (previewVolume > 0) previewMuted = false;
    applySound();
  });
  el.volume.addEventListener('change', () => { soundTouched = true; savePrefs(); });
  el.preview.addEventListener('error', () => {
    if (!el.preview.getAttribute('src')) return;
    previewFailed = true;
    setKind();
  });

  el.codec.addEventListener('change', () => {
    videoCodec = el.codec.value;
    savePrefs();
    refreshOutput();
  });
  el.container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-container]');
    if (!btn || btn.disabled || btn.dataset.container === container) return;
    container = btn.dataset.container;
    renderVideoOptions();
    savePrefs();
    refreshOutput();
  });

  // ------------------------------------------------------------- registry

  panels.youtube = {
    el: $('yt-panel'),
    extEl: el.ext,
    output,
    accepts: (url) => HTTP_URL_RE.test(url) && !X_HOST_RE.test(url),
    hint: (url) => (X_HOST_RE.test(url)
      ? 'On X, open a tweet and use the X / Twitter tab.'
      : 'Open a web page with a video or audio to download it.'),
    loadingText: 'Loading media info…',
    load: (url) => Promise.all([
      loadPrefs(['ytKind', 'ytAudio', 'ytCodec', 'ytContainer', 'ytPreviewVolume']),
      browser.storage.local.get('defaultContainer'),
      send({ type: 'getFormats', url }),
      send({ type: 'getPlayhead', tabId: currentTabId }).then((res) => res.time, () => null),
    ]).then(([stored, defaults, data, playhead]) => {
      kind = ['audio', 'clip'].includes(stored.ytKind) ? stored.ytKind : 'video';
      videoCodec = VIDEO_CODECS[stored.ytCodec] ? stored.ytCodec : 'h264';
      // Last used format; else the Settings default; a saved VP9/AV1 pick from
      // before this option existed keeps meaning WebM.
      container = CONTAINERS.includes(stored.ytContainer) ? stored.ytContainer
        : VIDEO_CODECS[videoCodec].ext === 'webm' ? 'webm'
          : CONTAINERS.includes(defaults.defaultContainer) ? defaults.defaultContainer : 'mp4';
      prefs = Object.assign(prefs, stored.ytAudio);
      const sound = stored.ytPreviewVolume || {};
      previewMuted = sound.muted === true;
      previewVolume = Number.isFinite(sound.volume) ? Math.min(1, Math.max(0, sound.volume)) : PREVIEW_DEFAULT_VOLUME;
      applySound();
      populate(data, playhead);
    }),
    payload() {
      const title = el.title.value.trim() || el.title.placeholder;
      if (kind === 'clip') {
        const { start, end } = trimCtl.get();
        return { mode: 'mp4', quality: el.mp4Quality.value, codec: videoCodec, container, withAudio: el.withAudio.checked, title, clip: { start, end } };
      }
      if (kind === 'video') return { mode: 'mp4', quality: el.mp4Quality.value, codec: videoCodec, container, withAudio: el.withAudio.checked, title };
      const fmt = currentFormat();
      const quality = isLossy(fmt) ? el.aquality.value : undefined;
      const tags = el.tags.checked;
      return {
        mode: 'audio',
        quality,
        title,
        audio: {
          format: fmt.id,
          quality,
          tags,
          meta: tags && el.edit.checked ? liveMeta() : null,
          cover: { source: cover.source, square: el.square.checked, dataUrl: cover.source === 'custom' ? cover.dataUrl : '' },
        },
      };
    },
  };
})();
