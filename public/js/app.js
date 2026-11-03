/* Read Through the Bible: front end. Plain JS, no framework.
 * Two <audio> elements (A/B): `audio` is the active one; `standby` preloads the next chapter so the
 * chapter change is a same-task play() on an element that is already buffered (Android screen-off fix). */
(function () {
  'use strict';

  var Q = window.Queue;
  var $ = function (id) { return document.getElementById(id); };
  var audio = $('player');
  var standby = audio.cloneNode(false);
  standby.id = 'player-b';
  audio.parentNode.appendChild(standby);
  audio.dataset.name = 'A'; standby.dataset.name = 'B';
  var players = [audio, standby];
  // Listen on both elements, but only react to events from whichever one is active right now.
  function onAudio(name, fn) {
    players.forEach(function (el) {
      el.addEventListener(name, function (e) { if (el === audio) return fn.call(el, e); });
    });
  }

  var LS_TOKEN = 'ironcat.token.v1';
  var LS_STATE = 'ironcat.state.v1';
  var LS_SETTINGS = 'ironcat.settings.v1';
  var LS_PLAN = 'ironcat.plan.v1';       // uploaded custom plan (stays on this device; never sent anywhere)
  var PREFETCH_SECONDS = 25;   // resolve the next chapter's URL this long before the current one ends
  var PREFETCH_MAX_AGE = 10 * 60 * 1000;

  var plan = null;
  var defaultPlan = null;
  var usingCustom = false;
  var len = 66;
  var state = null;
  var settings = { translation: 'ENGESVO1DA', announce: true, pause: 0, speed: 1, wakeLock: false };
  var translations = [];
  var mockMode = false;
  var sessionTranslation = '';      // what the picker shows; changes apply from the next chapter
  var termsUrl = $('link-terms').href;

  // playback machine
  var phase = 'idle';               // idle | loading | announce | chapter | pause
  var playToken = 0;                // bumps to cancel any in-flight startItem
  var pending = null;               // { token, res, resume }
  var current = null;               // { day, pos, item, meta }
  var pauseLeft = 0;
  var prefetch = {};                // key -> { at, promise }
  var prefetchedFor = -1;           // pos we already prefetched for
  var sleepMode = '0';              // '0' | 'chapter' | minutes
  var sleepEnd = 0;
  var sleepStopAfterChapter = false;
  var lastSave = 0;
  var resumeAt = 0;
  var retriedUrl = false;
  var verseCache = null;

  // ---------- storage ----------
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode etc. */ } }
  function today() { return Q.localDate(new Date()); }
  function saveState() { store(LS_STATE, state); }
  function saveSettings() { store(LS_SETTINGS, settings); }

  // ---------- small UI helpers ----------
  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3500);
  }
  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function label(it) { return it.book + ' ' + it.chapter; }
  function todayItems() { return plan.days[state.day - 1].items; }
  function currentItem() { return todayItems()[Math.min(state.pos, todayItems().length - 1)]; }
  function dayCount() { return todayItems().length; }
  function isSingle(it) { return plan.books[it.book].chapters === 1; }

  // ---------- API (token on every call; nothing is cached) ----------
  function getToken() { return localStorage.getItem(LS_TOKEN) || ''; }
  function api(path, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    var tok = getToken();
    if (tok) headers.Authorization = 'Bearer ' + tok;
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body, cache: 'no-store', credentials: 'omit' })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.status === 401 && !opts.noGate) { showGate('Please enter the passcode.'); }
          if (!res.ok) { var e = new Error(data.message || ('Request failed (' + res.status + ')')); e.status = res.status; e.code = data.error; throw e; }
          return data;
        });
      }, function () { var e = new Error('You appear to be offline.'); e.status = 0; e.code = 'offline'; throw e; });
  }

  // ---------- gate ----------
  function showGate(msg) {
    $('app').hidden = true; $('gate').hidden = false;
    $('gate-msg').textContent = msg || '';
    stopPlayback();
    setTimeout(function () { $('passcode').focus(); }, 50);
  }
  $('gate-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('passcode').value;
    $('gate-msg').textContent = 'One moment\u2026';
    api('/api/auth', { method: 'POST', body: JSON.stringify({ passcode: code }), noGate: true })
      .then(function (r) {
        localStorage.setItem(LS_TOKEN, r.token);
        $('passcode').value = '';
        $('gate-msg').textContent = '';
        launch();
      })
      .catch(function (err) { $('gate-msg').textContent = err.message; });
  });

  // ---------- render ----------
  function render() {
    var t = today();
    var items = todayItems();
    var done = Q.isDone(state, state.day);
    $('cycle-line').textContent = 'Cycle ' + state.cycle + ' \u00b7 Day ' + state.day + ' of ' + len;
    $('day-title').textContent = "Today\u2019s reading";
    $('plan-name').textContent = usingCustom ? 'Custom plan' : '';
    var note = $('complete-note');
    note.hidden = !done;
    note.textContent = done ? 'This day is marked as read.' : '';

    var ol = $('chapter-list');
    ol.innerHTML = '';
    items.forEach(function (it, i) {
      var li = document.createElement('li');
      var isCur = i === state.pos;
      if (isCur) li.className = 'current';
      else if (i < state.pos || done) li.className = 'played';
      var b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<span class="dot"></span><span></span>';
      b.lastChild.textContent = label(it);
      b.addEventListener('click', function () { startAt(i); });
      li.appendChild(b);
      ol.appendChild(li);
    });

    var behind = Q.behindBy(state, t, len);
    var cal = Q.calendarDay(state, t, len);
    $('catchup').hidden = behind === 0;
    if (behind) $('catchup-text').textContent = 'The calendar is on day ' + cal + '. You are on day ' + state.day + ' \u2014 no rush.';

    var si = Q.streakInfo(state, t, len);
    $('streak-main').textContent = si.daysReadThisCycle + ' of ' + len + ' days read this cycle';
    $('streak-sub').textContent = si.message + (si.readInLast7 ? ' \u00b7 ' + si.readInLast7 + ' of the last 7 days' : '');
    $('btn-toggle-done').textContent = done ? 'Mark day as not read' : 'Mark day as read';

    updateNow();
    updatePlayIcon();
  }

  function updateNow() {
    var it = current && phase !== 'idle' ? current.item : currentItem();
    var title = label(it);
    var sub = '';
    if (phase === 'loading') sub = 'Preparing\u2026';
    else if (phase === 'announce') sub = 'Announcing\u2026';
    else if (phase === 'pause') sub = 'A quiet moment\u2026';
    else if (current && current.meta) sub = translationName(current.meta.translation.id);
    else sub = translationName(sessionTranslation) || '';
    $('now-title').textContent = title;
    $('now-sub').textContent = sub;
  }

  function translationName(id) {
    for (var i = 0; i < translations.length; i++) if (translations[i].id === id) return translations[i].name;
    return id || '';
  }

  function updatePlayIcon() {
    var playing = !audio.paused && phase !== 'idle';
    var busy = phase === 'loading';
    var showPause = playing || busy;
    $('ico-play').toggleAttribute('hidden', showPause); $('ico-pause').toggleAttribute('hidden', !showPause);  // SVG has no .hidden property
    $('btn-play').setAttribute('aria-label', showPause ? 'Pause' : 'Play');
    $('ico-fplay').toggleAttribute('hidden', showPause); $('ico-fpause').toggleAttribute('hidden', !showPause);
    $('btn-follow-play').setAttribute('aria-label', showPause ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = showPause ? 'playing' : (phase === 'idle' ? 'none' : 'paused');
    syncWakeLock(showPause);
  }
  // Screen Wake Lock with reasons: 'playing' (setting, while audio plays) and 'follow' (Follow along open).
  // Lock is held while any reason is active; browsers drop it when hidden, so we re-request on visible.
  var wakeLock = null, wakeReasons = {}, wakePending = false;
  function wakeWanted() { for (var k in wakeReasons) if (wakeReasons[k]) return true; return false; }
  function setWakeReason(reason, on) { wakeReasons[reason] = !!on; applyWakeLock(); }
  function applyWakeLock() {
    var want = wakeWanted();
    if (want && !wakeLock && !wakePending && !document.hidden) {
      if (!('wakeLock' in navigator)) { if (!applyWakeLock.warned) { applyWakeLock.warned = true; plog('wakelock failed unsupported'); } return; }
      wakePending = true;
      navigator.wakeLock.request('screen').then(function (l) {
        wakePending = false; wakeLock = l;
        plog('wakelock on ' + Object.keys(wakeReasons).filter(function (k) { return wakeReasons[k]; }).join(','));
        l.addEventListener('release', function () { if (wakeLock === l) wakeLock = null; plog('wakelock released'); });
        if (!wakeWanted()) { wakeLock = null; l.release().catch(function () {}); }
      }, function (e) { wakePending = false; plog('wakelock failed ' + (e && (e.name || e.message) || e)); });
    } else if (!want && wakeLock) {
      var l = wakeLock; wakeLock = null; l.release().catch(function () {});
    }
  }
  function syncWakeLock(active) { setWakeReason('playing', settings.wakeLock && active); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { setWakeReason('follow', $('dlg-follow').open); applyWakeLock(); } });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) updatePlayIcon(); });

  function setCopyright(meta) {
    var el = $('copyright');
    if (!meta) { el.textContent = ''; return; }
    var c = meta.copyright || {};
    var parts = [];
    if (meta.mock) parts.push('MOCK DATA \u2014 not Bible content.');
    var name = translationName(meta.translation.id);
    if (name) parts.push(name + '.');
    if (c.text) parts.push(c.text);
    if (c.organizations && c.organizations.length) parts.push(c.organizations.map(function (o) { return o.name; }).join(', ') + '.');
    if (!c.text && !meta.mock) parts.push('Copyright information for this translation is available via the Bible Brain terms link below.');
    el.textContent = parts.join(' ');
  }

  // ---------- chapter resolution + prefetch ----------
  function keyFor(it, tr) { return Q.prefetchKey(tr, it.bookId, it.chapter); }
  function refQuery(it, tr) {
    var meta = translations.filter(function (t) { return t.id === tr; })[0] || {};
    return '?fileset=' + encodeURIComponent(tr) + '&book=' + it.bookId + '&chapter=' + it.chapter +
      (meta.bibleId ? '&bible=' + encodeURIComponent(meta.bibleId) : '');
  }
  function fetchChapter(it, tr) { return api('/api/chapter' + refQuery(it, tr)); }
  // Verse start times for the playing chapter (shared by "Save this verse" and Follow along).
  function chapterTimestamps(it, tr) {
    if (!verseCache) {
      verseCache = api('/api/timestamps?fileset=' + encodeURIComponent(tr) + '&book=' + it.bookId + '&chapter=' + it.chapter);
      var mine = verseCache;
      mine.catch(function () { if (verseCache === mine) verseCache = null; });   // allow a retry later
    }
    return verseCache;
  }
  function resolveChapter(it, tr) {
    var k = keyFor(it, tr);
    var p = prefetch[k];
    delete prefetch[k];
    if (p && Q.prefetchFresh(p.at, Date.now(), PREFETCH_MAX_AGE) && !p.failed) return p;
    return track(fetchChapter(it, tr));
  }
  // Wrap a promise so its value can be read synchronously once settled (lets the 'ended' handler
  // swap src + play() without any await when the next chapter is already resolved).
  function track(promise) {
    var t = { at: Date.now(), promise: promise, done: false, failed: false, value: null };
    promise.then(function (v) { t.done = true; t.value = v; }, function () { t.failed = true; });
    return t;
  }
  // Resolve chapter N+1 as soon as chapter N starts (timeupdate is throttled with the screen off).
  // Near the end, refresh it if the signed URL is getting old or the first attempt failed.
  function maybePrefetch(force) {
    if (phase !== 'chapter') return;
    if (!force) {
      if (!isFinite(audio.duration) || audio.duration - audio.currentTime > PREFETCH_SECONDS) return;
      var nx = todayItems()[state.pos + 1], ex = nx && prefetch[keyFor(nx, sessionTranslation)];
      if (ex && !ex.failed && Q.prefetchFresh(ex.at, Date.now(), PREFETCH_MAX_AGE / 2)) return;
      prefetchedFor = -1;
    }
    if (prefetchedFor === state.pos) return;
    prefetchedFor = state.pos;
    var nextPos = state.pos + 1;
    if (nextPos >= dayCount() || sleepStopAfterChapter || sleepMode === 'chapter') return;
    var it = todayItems()[nextPos];
    var tr = sessionTranslation;
    var p = fetchChapter(it, tr);
    p.catch(function () { prefetchedFor = -1; /* retried near the end or at play time */ });
    var k = keyFor(it, tr), t = track(p);
    prefetch[k] = t;
    p.then(function (meta) {
      if (prefetch[k] !== t || !meta || !meta.audioUrl) return;
      if (!Q.metaMatches(meta, tr, it.bookId, it.chapter)) { plog('prefetch-mismatch', k); delete prefetch[k]; return; }
      preloadStandby(k, meta.audioUrl);
    }, function () {});
  }
  // Buffer the next chapter in the idle element so the change needs no network and no src swap.
  // Step 1: point the idle element at the signed CDN URL (fallback). Step 2: download the whole
  // mp3 into memory (Blob) and switch the idle element to an object URL, so after the swap Android
  // Chrome never has to fetch anything while the screen is off. The blob is never persisted (no
  // Cache/IndexedDB); it lives only until that chapter has played, then its URL is revoked.
  var blobJob = null;   // { key, url, ctrl }
  function setElSrc(el, src) {
    var prev = el.dataset.blobUrl;
    el.src = src;
    if (prev && prev !== src) { try { URL.revokeObjectURL(prev); } catch (e) { /* ignore */ } delete el.dataset.blobUrl; }
  }
  function preloadStandby(key, url) {
    try {
      standby.pause();
      standby.loop = false;
      standby.preload = 'auto';
      setElSrc(standby, url);
      standby.dataset.key = key; standby.dataset.url = url;
      standby.load();
      plog('preload ' + standby.dataset.name, key + ' ' + shortUrl(url));
    } catch (e) { plog('preload-failed', e && e.name); }
    downloadBlob(key, url);
  }
  function downloadBlob(key, url) {
    if (typeof fetch !== 'function' || typeof URL.createObjectURL !== 'function') return;
    if (blobJob && blobJob.ctrl) { try { blobJob.ctrl.abort(); } catch (e) { /* ignore */ } }
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var job = blobJob = { key: key, url: url, ctrl: ctrl }, t0 = Date.now();
    plog('blob-start', key);
    fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        if (blobJob !== job) return;
        blobJob = null;
        var bytes = buf.byteLength;
        // The CDN labels files binary/octet-stream; tell the player it is MP3.
        var el = Q.preloadMatches({ key: standby.dataset.key, url: standby.dataset.url }, key, url) ? standby : null;
        if (!el) { plog('blob-unused', key + ' ' + bytes + 'B ' + (Date.now() - t0) + 'ms'); return; }
        var obj = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
        el.pause();
        setElSrc(el, obj);
        el.dataset.blobUrl = obj;
        el.load();
        plog('blob-done ' + el.dataset.name, key + ' ' + bytes + 'B ' + (Date.now() - t0) + 'ms');
      })
      .catch(function (e) {
        if (blobJob === job) blobJob = null;
        if (e && e.name === 'AbortError') return;
        plog('blob-failed', key + ' ' + (e && (e.message || e.name)));
      });
  }

  // ---------- playback ----------
  function shortUrl(u) { return String(u || '').split('?')[0].split('/').slice(-2).join('/'); }
  // key: the exact translation|book|chapter the url is for (chapters only). If the standby element
  // already buffered that same chapter + URL, make it the active element instead of swapping src.
  function setSrc(url, key) {
    if (key && Q.preloadMatches({ key: standby.dataset.key, url: standby.dataset.url }, key, url) && !standby.error) {
      var old = audio;
      audio = standby; standby = old;
      try { old.pause(); } catch (e) { /* ignore */ }
      delete old.dataset.key; delete old.dataset.url;
      audio.loop = false;
      plog('swap->' + audio.dataset.name, 'ready=' + audio.readyState + (audio.dataset.blobUrl ? ' blob=yes' : ' blob=no'));
      if (old.dataset.blobUrl) { try { URL.revokeObjectURL(old.dataset.blobUrl); } catch (e) { /* ignore */ } delete old.dataset.blobUrl; }
      try { old.removeAttribute('src'); old.load(); } catch (e) { /* ignore */ }   // free the finished chapter
      if (audio.readyState >= 1) {
        if (resumeAt > 0 && resumeAt < (audio.duration || Infinity) - 2) audio.currentTime = resumeAt;
        else if (audio.currentTime) audio.currentTime = 0;
        resumeAt = 0;
        $('t-dur').textContent = fmt(audio.duration);
      }
    } else {
      audio.loop = false;
      setElSrc(audio, url);
      delete audio.dataset.key; delete audio.dataset.url;
    }
    audio.defaultPlaybackRate = settings.speed;
    audio.playbackRate = settings.speed;
  }
  // ---------- private playback log (this device only, last 150 events) ----------
  var LS_PLOG = 'ironcat.playlog';
  function plog(ev, extra) {
    try {
      var d = new Date(), e = d.toTimeString().slice(0, 8) + ' ' + ev + ' ph=' + phase + (current ? ' ' + current.item.bookId + current.item.chapter : '') +
        (document.hidden ? ' hidden' : '') + (extra ? ' ' + extra : '');
      localStorage.setItem(LS_PLOG, JSON.stringify(Q.pushLog(JSON.parse(localStorage.getItem(LS_PLOG) || '[]'), (d.getMonth() + 1) + '/' + d.getDate() + ' ' + e, 150)));
    } catch (x) { /* ignore */ }
  }
  ['ended', 'playing', 'pause', 'stalled', 'waiting', 'emptied', 'suspend', 'ratechange'].forEach(function (n) {
    onAudio(n, function () { plog(n + ' ' + audio.dataset.name, n === 'ratechange' ? 'rate=' + audio.playbackRate : ''); });
  });
  onAudio('loadedmetadata', function () { plog('loadedmetadata ' + audio.dataset.name, 'dur=' + Math.round(audio.duration || 0)); });
  var lastTuLog = 0;
  onAudio('timeupdate', function () {
    var n = Date.now();
    if (n - lastTuLog < 15000) return;
    lastTuLog = n;
    plog('t ' + audio.dataset.name, Math.round(audio.currentTime) + '/' + Math.round(audio.duration || 0) + 's x' + audio.playbackRate);
  });
  players.forEach(function (el) {   // the idle element's buffering problems are worth seeing too
    el.addEventListener('error', function () { if (el !== audio) plog('standby-error ' + el.dataset.name, el.error ? 'code=' + el.error.code : ''); });
  });
  document.addEventListener('visibilitychange', function () { plog('visibility ' + document.visibilityState); });
  document.addEventListener('freeze', function () { plog('freeze'); });
  document.addEventListener('resume', function () { plog('resume'); });
  window.addEventListener('pagehide', function () { plog('pagehide'); });

  // Fallback when no blob was ready: if playback is hidden and stuck (no progress for >4s after
  // suspend/stalled/waiting), reload the element at the same spot and play again.
  var stuck = { t: -1, since: 0, lastFix: 0 };
  ['suspend', 'stalled', 'waiting'].forEach(function (n) { onAudio(n, function () { checkStuck(); }); });
  setInterval(checkStuck, 2000);
  function checkStuck() {
    if (phase !== 'chapter' || audio.paused || !document.hidden || audio.dataset.blobUrl) { stuck.t = -1; return; }
    var now = Date.now(), ct = audio.currentTime;
    if (Math.abs(ct - stuck.t) > 0.25) { stuck.t = ct; stuck.since = now; return; }
    if (now - stuck.since < 4000 || now - stuck.lastFix < 15000) return;
    stuck.lastFix = now; stuck.since = now;
    plog('stall-recover ' + audio.dataset.name, 'at=' + Math.round(ct) + 's ready=' + audio.readyState);
    try { resumeAt = ct; audio.load(); tryPlay(); } catch (e) { plog('stall-recover-failed', e && e.name); }
  }

  function tryPlay() {
    // audio.src (not currentSrc, which only updates later) = the URL just assigned.
    plog('play() ' + audio.dataset.name, shortUrl(audio.src) + (phase === 'chapter' && current ? ' want=' + keyFor(current.item, current.tr) : ''));
    var p = audio.play();
    if (p && p.catch) p.catch(function (e) {
      plog('play-rejected', e && e.name);
      if (e && e.name === 'NotAllowedError') { phase = phase === 'idle' ? 'idle' : phase; toast('Tap Play to begin.'); }
      updatePlayIcon();
    });
  }

  function startAt(pos) {
    state = Q.setPosition(state, pos, dayCount()); saveState();
    startItem(0);
  }

  function startItem(resume) {
    var token = ++playToken;
    var it = currentItem();
    var tr = sessionTranslation;
    verseCache = null; prefetchedFor = -1; retriedUrl = false;
    current = { day: state.day, pos: state.pos, item: it, tr: tr, meta: null };
    phase = 'loading';
    render();
    var res = resolveChapter(it, tr);
    res.promise.catch(function () { /* handled in finishResolve */ });
    pending = { token: token, res: res, resume: resume };
    if (followIsOpen()) { loadFollow(it, tr); renderFollow(); }
    setMediaMetadata();
    var useAnnounce = settings.announce && !(resume > 2) && Q.useShortClips(document.hidden);
    if (useAnnounce) {
      phase = 'announce';
      setSrc('/announce/' + Q.clipName(it.bookId, it.chapter, isSingle(it)));
      tryPlay();
      updateNow(); updatePlayIcon();
    } else {
      finishResolve(token);
    }
  }

  function finishResolve(token) {
    var pd = pending;
    if (!pd || pd.token !== token) return;
    // Already resolved (the normal case thanks to early prefetch): swap + play synchronously.
    if (pd.res.done) { playChapter(pd.res.value, pd.resume); return; }
    // Not ready: keep the element playing looped silence so iOS keeps the audio session alive
    // while hidden, instead of calling play() later from an idle element.
    phase = 'loading';
    setSrc('/announce/silence.mp3'); audio.loop = true;
    tryPlay(); updateNow();
    pd.res.promise.then(function (meta) {
      if (token !== playToken) return;
      playChapter(meta, pd.resume);
    }, function (err) {
      if (token !== playToken) return;
      phase = 'idle';
      audio.loop = false;
      audio.pause();
      toast(err.message || 'Could not load this chapter.', 6000);
      updateNow(); updatePlayIcon();
    });
  }

  function playChapter(meta, resume) {
    current.meta = meta;
    if (meta.mock && !mockMode) { mockMode = true; showMockBanner(meta.notice); }
    phase = 'chapter';
    resumeAt = resume > 2 ? resume : 0;
    setSrc(meta.audioUrl, keyFor(current.item, current.tr));
    tryPlay();
    setCopyright(meta);
    setMediaMetadata();
    updateNow(); updatePlayIcon();
    maybePrefetch(true);
    // Prefetch text + timings for Follow along (in memory only) so it is ready when opened.
    loadFollow(current.item, meta.translation.id);
    renderFollow();
  }

  function stopPlayback() {
    playToken++;
    pending = null;
    phase = 'idle';
    try { audio.pause(); } catch (e) { /* ignore */ }
    updatePlayIcon();
  }

  function onChapterEnded() {
    var r = Q.chapterFinished(state, today(), len, dayCount());
    state = r.state; saveState();
    var stopHere = sleepStopAfterChapter || sleepMode === 'chapter';
    if (stopHere) { clearSleep(); phase = 'idle'; toast('Sleep well. Your place is saved.', 5000); render(); return; }
    if (r.dayFinished) {
      phase = 'idle';
      toast(r.cycleCompleted ? 'You have finished the whole cycle. Thank you, Lord.' : 'Day ' + r.finishedDay + ' is complete. Well done.', 6000);
      render();
      return;
    }
    render();
    if (settings.pause > 0 && Q.useShortClips(document.hidden)) {
      phase = 'pause'; pauseLeft = settings.pause;
      setSrc('/announce/silence.mp3');
      tryPlay(); updateNow();
    } else {
      startItem(0);
    }
  }

  onAudio('ended', function () {
    if (phase === 'announce') { finishResolve(playToken); return; }
    if (phase === 'chapter') { onChapterEnded(); return; }
    if (phase === 'pause') {
      pauseLeft -= 1;
      if (pauseLeft > 0) { audio.currentTime = 0; tryPlay(); } else { startItem(0); }
      return;
    }
    if (phase === 'loading') { audio.currentTime = 0; tryPlay(); }   // safety if loop is unsupported
  });

  onAudio('error', function () {
    plog('error ' + audio.dataset.name, audio.error ? 'code=' + audio.error.code : '');
    if (phase === 'announce') { finishResolve(playToken); return; }       // graceful: skip the clip
    if (phase === 'pause') { startItem(0); return; }
    if (phase === 'loading') { return; }
    if (phase === 'chapter' && current) {
      if (!retriedUrl) {                                                    // signed URL may have expired: re-resolve once
        retriedUrl = true;
        var at = audio.currentTime || resumeAt || 0, token = playToken, it = current.item;
        fetchChapter(it, current.meta.translation.id).then(function (meta) {
          if (token !== playToken) return;
          current.meta = meta; resumeAt = at; setSrc(meta.audioUrl); tryPlay();
        }, function (e) { phase = 'idle'; toast(e.message, 6000); updatePlayIcon(); });
        return;
      }
      phase = 'idle'; toast('The audio could not be played. Check your connection and try again.', 6000);
      updatePlayIcon();
    }
  });

  onAudio('loadedmetadata', function () {
    if (phase === 'chapter' && resumeAt > 0 && resumeAt < (audio.duration || Infinity) - 2) { audio.currentTime = resumeAt; }
    resumeAt = 0;
    $('t-dur').textContent = phase === 'chapter' ? fmt(audio.duration) : '0:00';
    updatePosition();
  });
  onAudio('play', updatePlayIcon);
  onAudio('pause', function () { updatePlayIcon(); persistPosition(true); });
  onAudio('playing', updatePlayIcon);

  onAudio('timeupdate', function () {
    $('t-cur').textContent = fmt(audio.currentTime);
    if (audio.duration && isFinite(audio.duration)) {
      $('seek').value = Math.round((audio.currentTime / audio.duration) * 1000);
      $('t-dur').textContent = fmt(audio.duration);
    }
    persistPosition(false);
    maybePrefetch();
    checkSleep();
    updatePosition();
    syncFollow(false);
  });
  onAudio('seeked', function () { syncFollow(true); });

  function persistPosition(force) {
    if (phase !== 'chapter') return;
    var now = Date.now();
    if (!force && now - lastSave < 5000) return;
    lastSave = now;
    state.t = Math.floor(audio.currentTime || 0);
    saveState();
  }

  function togglePlay() {
    if (phase === 'idle') {
      var resume = state.t > 2 ? state.t : 0;
      startItem(resume);
      return;
    }
    if (audio.paused) tryPlay(); else audio.pause();
  }

  function skipBack() {
    if (phase === 'chapter') audio.currentTime = Math.max(0, audio.currentTime - 15);
  }
  function skipForward() {
    if (phase === 'chapter') audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15);
  }
  function nextChapter() {
    if (state.pos >= dayCount() - 1) { toast('This is the last chapter of today\u2019s reading.'); return; }
    var was = phase !== 'idle' && !audio.paused;
    state = Q.setPosition(state, state.pos + 1, dayCount()); saveState();
    if (was) startItem(0); else { stopPlayback(); render(); }
  }
  function prevChapter() {
    var was = phase !== 'idle' && !audio.paused;
    if (phase === 'chapter' && audio.currentTime > 5) { audio.currentTime = 0; return; }
    if (state.pos > 0) state = Q.setPosition(state, state.pos - 1, dayCount()); else state = Q.setPosition(state, 0, dayCount());
    saveState();
    if (was) startItem(0); else { stopPlayback(); render(); }
  }

  $('btn-play').addEventListener('click', togglePlay);
  $('btn-back').addEventListener('click', skipBack);
  $('btn-next').addEventListener('click', nextChapter);
  $('btn-prev').addEventListener('click', prevChapter);
  $('seek').addEventListener('input', function () {
    if (phase === 'chapter' && audio.duration) audio.currentTime = (this.value / 1000) * audio.duration;
  });

  // ---------- speed ----------
  $('sel-speed').addEventListener('change', function () {
    settings.speed = Number(this.value) || 1; saveSettings();
    audio.defaultPlaybackRate = settings.speed; audio.playbackRate = settings.speed;
  });

  // ---------- sleep timer ----------
  function clearSleep() { sleepMode = '0'; sleepEnd = 0; sleepStopAfterChapter = false; $('sel-sleep').value = '0'; $('sleep-left').hidden = true; }
  $('sel-sleep').addEventListener('change', function () {
    sleepMode = this.value; sleepStopAfterChapter = false;
    if (sleepMode === 'chapter') { sleepEnd = 0; $('sleep-left').hidden = false; $('sleep-left').textContent = 'Will stop after this chapter.'; }
    else if (sleepMode === '0') { sleepEnd = 0; $('sleep-left').hidden = true; }
    else { sleepEnd = Date.now() + Number(sleepMode) * 60000; checkSleep(); }
  });
  function checkSleep() {
    if (!sleepEnd) return;
    var left = sleepEnd - Date.now();
    if (left <= 0) {
      clearSleep();
      persistPosition(true);
      stopPlaybackKeepPlace();
      toast('Sleep timer finished. Your place is saved.', 5000);
      return;
    }
    $('sleep-left').hidden = false;
    $('sleep-left').textContent = 'Stopping in ' + Math.ceil(left / 60000) + ' min';
  }
  function stopPlaybackKeepPlace() {
    var keepT = Math.floor(audio.currentTime || 0);
    var wasChapter = phase === 'chapter';
    stopPlayback();
    if (wasChapter) { state.t = keepT; saveState(); }
    render();
  }
  setInterval(checkSleep, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { checkSleep(); if (state) render(); if (phase === 'loading' && audio.paused) tryPlay(); } });

  // ---------- Media Session (lock screen) ----------
  function setMediaMetadata() {
    if (!('mediaSession' in navigator) || !current) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: label(current.item),
        artist: 'Day ' + current.day + ' of ' + len,
        album: current.meta ? translationName(current.meta.translation.id) : 'Read Through the Bible',
        artwork: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
    } catch (e) { /* older browsers */ }
  }
  function updatePosition() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (phase !== 'chapter' || !isFinite(audio.duration) || !audio.duration) return;
    try {
      navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime, audio.duration) });
    } catch (e) { /* ignore */ }
  }
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    var ms = navigator.mediaSession;
    function on(a, fn) { try { ms.setActionHandler(a, fn); } catch (e) { /* unsupported action */ } }
    on('play', function () { if (phase === 'idle') togglePlay(); else tryPlay(); });
    on('pause', function () { audio.pause(); });
    on('previoustrack', prevChapter);
    on('nexttrack', nextChapter);
    on('seekbackward', function (d) { if (phase === 'chapter') audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 15)); });
    on('seekforward', function (d) { if (phase === 'chapter') audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + ((d && d.seekOffset) || 15)); });
    on('seekto', function (d) { if (phase === 'chapter' && d && typeof d.seekTime === 'number') audio.currentTime = d.seekTime; });
    on('stop', function () { stopPlaybackKeepPlace(); });
  }

  // ---------- translations ----------
  function fillTranslationSelects() {
    ['sel-translation', 'set-translation'].forEach(function (id) {
      var sel = $(id);
      sel.innerHTML = '';
      translations.forEach(function (t) {
        var o = document.createElement('option');
        o.value = t.id;
        o.textContent = t.name + (t.drama ? ' (dramatized)' : '') + (t.partial ? ' \u2014 partial' : '');
        sel.appendChild(o);
      });
      sel.value = id === 'sel-translation' ? sessionTranslation : (settings.translation || sessionTranslation);
    });
  }
  $('sel-translation').addEventListener('change', function () {
    sessionTranslation = this.value;
    prefetch = {};                // a chapter already prefetched under the old translation is dropped
    prefetchedFor = -1;           // and the next one is resolved again under the new choice
    toast('Switching to ' + translationName(sessionTranslation) + ' from the next chapter.');
    updateNow();
  });
  $('set-translation').addEventListener('change', function () {
    settings.translation = this.value; saveSettings();
    toast('Default saved. It is used each time you open the app.');
  });

  function loadTranslations() {
    return api('/api/translations').then(function (r) {
      translations = r.translations || [];
      mockMode = !!r.mock;
      if (r.termsUrl) { termsUrl = r.termsUrl; $('link-terms').href = r.termsUrl; }
      if (mockMode) showMockBanner(r.notice);
      var ids = translations.map(function (t) { return t.id; });
      var preferred = settings.translation || r.defaultId || '';
      if (ids.indexOf(preferred) === -1) preferred = ids[0] || '';
      sessionTranslation = preferred;
      if (!settings.translation && preferred) { settings.translation = preferred; saveSettings(); }
      fillTranslationSelects();
      if (!translations.length) toast('No audio translations were found for your key.', 6000);
    });
  }
  function showMockBanner(text) {
    var b = $('banner-mock');
    b.hidden = false;
    b.textContent = text || 'MOCK DATA: BIBLE_BRAIN_KEY is not set. Audio is a test tone.';
  }

  // ---------- day controls ----------
  $('btn-skip-today').addEventListener('click', function () {
    stopPlayback();
    state = Q.skipToToday(state, today(), len); saveState(); render();
    toast('Skipped to today\u2019s reading. The days in between stay open for whenever you like.', 5000);
  });
  $('btn-toggle-done').addEventListener('click', function () {
    if (Q.isDone(state, state.day)) { state = Q.unmarkDone(state, state.day); saveState(); render(); return; }
    stopPlayback();
    var r = Q.finishDay(state, today(), len);
    state = r.state; saveState(); render();
    toast(r.cycleCompleted ? 'Cycle complete. Well done.' : 'Day ' + r.finishedDay + ' marked as read.');
  });
  $('btn-jump').addEventListener('click', function () {
    var g = $('jump-grid'); g.innerHTML = '';
    for (var d = 1; d <= len; d++) {
      (function (day) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = day;
        if (Q.isDone(state, day)) b.className = 'done';
        if (day === state.day) b.className = (b.className + ' current').trim();
        b.setAttribute('aria-label', 'Day ' + day + (Q.isDone(state, day) ? ', read' : ''));
        b.addEventListener('click', function () {
          stopPlayback();
          state = Q.jumpToDay(state, day, today(), len); saveState();
          $('dlg-jump').close(); render();
        });
        g.appendChild(b);
      })(d);
    }
    $('dlg-jump').showModal();
  });

  // ---------- save this verse ----------
  $('btn-verse').addEventListener('click', function () {
    var it = (current && phase !== 'idle') ? current.item : currentItem();
    var tr = current && current.meta ? current.meta.translation.id : sessionTranslation;
    var pos = phase === 'chapter' ? Math.max(0, (audio.currentTime || 0) - 4) : 0;  // allow for reaction time
    function commit(verse) {
      state = Q.saveVerse(state, { book: it.book, bookId: it.bookId, chapter: it.chapter, verse: verse, translation: tr, at: new Date().toISOString() });
      saveState();
      toast('Saved ' + it.book + ' ' + it.chapter + (verse ? ':' + verse : '') + '.');
    }
    if (phase !== 'chapter' || (current.meta && current.meta.mock)) { commit(null); return; }
    chapterTimestamps(it, tr).then(function (r) {
      var v = null;
      (r.verses || []).forEach(function (x) { if (x.t <= pos && x.verse > 0) v = x.verse; });
      commit(v);
    }, function () { commit(null); });
  });
  $('btn-saved').addEventListener('click', function () {
    var ul = $('saved-list'); ul.innerHTML = '';
    if (!state.saved.length) { var li = document.createElement('li'); li.textContent = 'Nothing saved yet.'; ul.appendChild(li); }
    state.saved.forEach(function (s, i) {
      var li = document.createElement('li');
      var span = document.createElement('span');
      span.textContent = s.book + ' ' + s.chapter + (s.verse ? ':' + s.verse : '') + ' \u00b7 ' + new Date(s.at).toLocaleDateString();
      var rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'link'; rm.textContent = 'Remove';
      rm.addEventListener('click', function () { state.saved.splice(i, 1); saveState(); $('btn-saved').click(); });
      li.appendChild(span); li.appendChild(rm); ul.appendChild(li);
    });
    $('dlg-saved').showModal();
  });


  // ---------- follow along (live text) ----------
  // Text comes from /api/text per chapter and lives only in memory (never localStorage / SW cache).
  var follow = null;            // { key, it, tr, text, textErr, ts, tsErr, tsPending }
  var followActive = null;      // verse number currently highlighted
  var followEls = [];           // [{ from, to, el }] in verse order for the rendered chapter
  var followRenderedKey = null;
  var followUserScrollAt = 0;
  var FOLLOW_LEAD = 0.15;       // seconds: highlight a hair early so it feels in step with the voice
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function followIsOpen() { return $('dlg-follow').open; }
  function followTarget() {
    if (current && phase !== 'idle') return { it: current.item, tr: current.meta ? current.meta.translation.id : current.tr };
    return { it: currentItem(), tr: sessionTranslation };
  }
  function loadFollow(it, tr) {
    if (!it || !tr) return;
    var key = keyFor(it, tr);
    if (follow && follow.key === key && !follow.textErr) {
      if (!follow.ts && !follow.tsPending && isPlayingKey(key)) fetchFollowTimes(follow);
      return;
    }
    var f = follow = { key: key, it: it, tr: tr, text: null, textErr: null, ts: null, tsErr: false, tsPending: false };
    api('/api/text' + refQuery(it, tr)).then(function (r) {
      if (follow !== f) return;
      f.text = r; renderFollow();
    }, function (e) {
      if (follow !== f) return;
      f.textErr = e.message || 'Could not load the text.'; renderFollow();
    });
    if (isPlayingKey(key)) fetchFollowTimes(f);
  }
  function isPlayingKey(key) {
    return !!(current && current.meta && phase === 'chapter' && keyFor(current.item, current.meta.translation.id) === key);
  }
  function fetchFollowTimes(f) {
    f.tsErr = false; f.tsPending = true;
    chapterTimestamps(f.it, f.tr).then(function (r) {
      f.tsPending = false;
      if (follow !== f) return;
      f.ts = (r.verses || [])
        .filter(function (x) { return x.verse > 0 && isFinite(x.t); })   // ignore the verse-0 intro
        .sort(function (a, b) { return a.t - b.t; });
      renderFollow();
    }, function () {
      f.tsPending = false;
      if (follow !== f) return;
      f.tsErr = true; renderFollow();
    });
  }

  function followCopyright(f) {
    var el = $('follow-copyright');
    el.textContent = '';
    var c = (f && f.text && f.text.copyright) || {};
    var meta = current && current.meta && f && isPlayingKey(f.key) ? current.meta : null;
    if (!c.text && meta && meta.copyright && meta.copyright.text) c = meta.copyright;   // fall back to the chapter's copyright
    var parts = [];
    if (f && f.text && f.text.mock) parts.push('MOCK DATA \u2014 not Bible content.');
    var name = f ? translationName(f.tr) : '';
    if (name) parts.push(name + '.');
    if (c.text) parts.push(c.text);
    if (c.organizations && c.organizations.length) parts.push(c.organizations.map(function (o) { return o.name; }).join(', ') + '.');
    if (!c.text && !(f && f.text && f.text.mock)) parts.push('Copyright information for this translation is available via the Bible Brain terms.');
    el.appendChild(document.createTextNode(parts.join(' ') + ' Text streamed from Bible Brain. '));
    var a = document.createElement('a');
    a.href = termsUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Bible Brain terms';
    el.appendChild(a);
  }

  function renderFollow() {
    if (!followIsOpen()) return;
    var f = follow;
    var box = $('follow-text'), status = $('follow-status');
    var tgt = followTarget();
    var title = f ? ((f.text && f.text.bookName && f.text.bookName !== f.it.bookId ? f.text.bookName : f.it.book) + ' ' + f.it.chapter) : label(tgt.it);
    $('follow-title').textContent = title;
    followCopyright(f);

    if (!f || (!f.text && !f.textErr)) {
      if (followRenderedKey !== 'loading') {
        box.innerHTML = '';
        var p = document.createElement('p'); p.className = 'loading';
        p.textContent = f ? 'Loading the text\u2026' : 'Choose a translation to see the text.';
        box.appendChild(p);
        followRenderedKey = 'loading'; followEls = []; followActive = null;
      }
      status.textContent = '';
      return;
    }
    if (f.textErr || !f.text.verses || !f.text.verses.length) {
      box.innerHTML = '';
      var q = document.createElement('p'); q.className = 'loading';
      q.textContent = f.textErr ? f.textErr + ' Playback is not affected.' : 'Text isn\u2019t available for this chapter in this translation. Playback is not affected.';
      box.appendChild(q);
      followRenderedKey = 'empty:' + f.key; followEls = []; followActive = null;
      status.textContent = '';
      return;
    }
    if (followRenderedKey !== f.key) {
      box.innerHTML = ''; followEls = []; followActive = null;
      var frag = document.createDocumentFragment();
      f.text.verses.forEach(function (v) {
        var el = document.createElement('p');
        el.className = 'v';
        el.setAttribute('data-verse', v.verse);
        var sup = document.createElement('sup');
        sup.textContent = v.verseEnd ? v.verse + '\u2013' + v.verseEnd : v.verse;
        el.appendChild(sup);
        el.appendChild(document.createTextNode(v.text));
        frag.appendChild(el);
        followEls.push({ from: v.verse, to: v.verseEnd || v.verse, el: el });
      });
      box.appendChild(frag);
      box.scrollTop = 0;
      followRenderedKey = f.key;
    }
    var playing = isPlayingKey(f.key);
    var synced = playing && f.ts && f.ts.length > 0;
    box.classList.toggle('synced', !!synced);
    if (!playing) status.textContent = phase === 'idle' ? 'Press play to follow along.' : '';
    else if (f.ts === null && !f.tsErr) status.textContent = '';
    else if (!synced) status.textContent = 'Timing unavailable for this recording \u2014 showing the text without sync.';
    else status.textContent = '';
    syncFollow(true);
  }

  // Latest timestamp at or before the playhead -> verse number (null before verse 1 starts).
  function verseAt(ts, time) {
    var v = null;
    for (var i = 0; i < ts.length; i++) { if (ts[i].t <= time + FOLLOW_LEAD) v = ts[i].verse; else break; }
    return v;
  }
  function elForVerse(v) {
    var best = null;
    for (var i = 0; i < followEls.length; i++) {
      var e = followEls[i];
      if (v >= e.from && v <= e.to) return e.el;
      if (e.from <= v) best = e.el;
    }
    return best;
  }
  function syncFollow(force) {
    if (!follow || !followIsOpen() || followRenderedKey !== follow.key) return;
    var v = null;
    if (follow.ts && follow.ts.length && isPlayingKey(follow.key)) v = verseAt(follow.ts, audio.currentTime || 0);
    if (v === followActive && !force) return;
    var prevEl = followActive != null ? elForVerse(followActive) : null;
    var el = v != null ? elForVerse(v) : null;
    if (prevEl && prevEl !== el) prevEl.classList.remove('active');
    followActive = v;
    if (!el) return;
    el.classList.add('active');
    var userScrolling = Date.now() - followUserScrollAt < 6000;
    if (force || !userScrolling) {
      try { el.scrollIntoView({ block: 'center', behavior: force || reduceMotion ? 'auto' : 'smooth' }); } catch (e) { el.scrollIntoView(); }
    }
  }

  function openFollow() {
    var tgt = followTarget();
    var dlg = $('dlg-follow');
    if (!dlg.open) dlg.showModal();
    setWakeReason('follow', true);
    followRenderedKey = null;
    loadFollow(tgt.it, tgt.tr);
    renderFollow();
    $('btn-follow-close').focus();
  }
  $('btn-follow').addEventListener('click', openFollow);
  $('dlg-follow').addEventListener('close', function () { setWakeReason('follow', false); });
  $('btn-follow-close').addEventListener('click', function () { $('dlg-follow').close(); });
  $('btn-follow-play').addEventListener('click', togglePlay);
  $('btn-follow-back').addEventListener('click', skipBack);
  ['wheel', 'touchmove'].forEach(function (ev) {
    $('follow-text').addEventListener(ev, function () { followUserScrollAt = Date.now(); }, { passive: true });
  });
  // Tap a verse to jump the audio there (when this chapter is playing and timings exist).
  $('follow-text').addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('.v');
    if (!el || !follow || !follow.ts || !follow.ts.length || !isPlayingKey(follow.key)) return;
    var n = Number(el.getAttribute('data-verse'));
    for (var i = 0; i < follow.ts.length; i++) {
      if (follow.ts[i].verse >= n) { audio.currentTime = follow.ts[i].t; followUserScrollAt = 0; return; }
    }
  });

  // ---------- settings ----------
  $('btn-settings').addEventListener('click', function () {
    $('set-announce').checked = settings.announce;
    $('set-pause').value = String(settings.pause);
    $('set-wakelock').checked = !!settings.wakeLock;
    var lg = []; try { lg = JSON.parse(localStorage.getItem(LS_PLOG) || '[]'); } catch (e) { /* ignore */ }
    $('playlog').textContent = lg.length ? lg.slice().reverse().join('\n') : 'Nothing logged yet.';
    $('app-version').textContent = typeof APP_VERSION !== 'undefined' ? APP_VERSION : '';
    $('dlg-settings').showModal();
  });
  $('btn-playlog-copy').addEventListener('click', function () { try { navigator.clipboard.writeText($('playlog').textContent); toast('Log copied.'); } catch (e) { /* ignore */ } });
  $('btn-playlog-clear').addEventListener('click', function () { localStorage.removeItem(LS_PLOG); $('playlog').textContent = 'Nothing logged yet.'; });
  $('set-announce').addEventListener('change', function () { settings.announce = this.checked; saveSettings(); });
  $('set-pause').addEventListener('change', function () { settings.pause = Number(this.value) || 0; saveSettings(); });
  $('set-wakelock').addEventListener('change', function () { settings.wakeLock = this.checked; saveSettings(); updatePlayIcon(); });
  $('btn-newcycle').addEventListener('click', function () {
    if (!confirm('Start a new cycle from Day 1? Your finished days for this cycle stay on record.')) return;
    stopPlayback();
    state = Q.startNewCycle(state, today()); saveState();
    $('dlg-settings').close(); render();
  });
  $('btn-signout').addEventListener('click', function () {
    localStorage.removeItem(LS_TOKEN);
    $('dlg-settings').close();
    showGate('This device is locked.');
  });


  // ---------- reading plan: upload / download / reset ----------
  var pendingPlan = null;   // { plan, custom }
  function applyPlan(p, custom) {
    plan = p; len = p.cycleLength; usingCustom = custom;
    $('plan-info').textContent = planSummaryText(p);
  }
  function planSummaryText(p) {
    var s = Plan.summarize(p);
    return (usingCustom ? 'Custom plan' : 'Default: ' + (p.title || 'Prophets plan')) + ' \u00b7 ' + s.days + ' days \u00b7 ' + s.chapters + ' chapters' +
      (s.minPerDay === s.maxPerDay ? ' (' + s.minPerDay + ' a day)' : ' (' + s.minPerDay + '\u2013' + s.maxPerDay + ' a day)');
  }
  function download(name, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function showPlanPreview(res, fileName, isReset) {
    var errBox = $('plan-errors'), body = $('plan-preview'), choice = $('plan-choice'), ok = $('btn-plan-accept');
    errBox.innerHTML = ''; body.innerHTML = '';
    $('plan-file').textContent = fileName || '';
    if (!res.ok) {
      pendingPlan = null;
      $('plan-title').textContent = 'This plan can\u2019t be used yet';
      var p0 = document.createElement('p'); p0.className = 'quiet small';
      p0.textContent = res.errors.length + ' problem' + (res.errors.length === 1 ? '' : 's') + ' found. Nothing was changed. Fix the file and try again.';
      errBox.appendChild(p0);
      var ul = document.createElement('ul'); ul.className = 'errs';
      res.errors.slice(0, 25).forEach(function (e) { var li = document.createElement('li'); li.textContent = e; ul.appendChild(li); });
      if (res.errors.length > 25) { var more = document.createElement('li'); more.textContent = '\u2026and ' + (res.errors.length - 25) + ' more.'; ul.appendChild(more); }
      errBox.appendChild(ul);
      choice.hidden = true; ok.hidden = true;
    } else {
      pendingPlan = { plan: res.plan, custom: !isReset };
      $('plan-title').textContent = isReset ? 'Go back to the default plan?' : 'Preview: does this look right?';
      var s = Plan.summarize(res.plan);
      var sum = document.createElement('p');
      sum.textContent = s.days + ' days, ' + s.chapters + ' chapters, ' + s.books.length + ' book' + (s.books.length === 1 ? '' : 's') +
        (s.minPerDay === s.maxPerDay ? ', ' + s.minPerDay + ' chapters a day.' : ', ' + s.minPerDay + '\u2013' + s.maxPerDay + ' chapters a day.');
      body.appendChild(sum);
      var tbl = document.createElement('ol'); tbl.className = 'prev';
      var show = res.plan.days.length <= 6 ? res.plan.days : res.plan.days.slice(0, 3).concat([null], res.plan.days.slice(-2));
      show.forEach(function (d) {
        var li = document.createElement('li');
        if (!d) { li.textContent = '\u2026'; li.className = 'quiet'; }
        else { li.innerHTML = '<b></b> <span></span>'; li.firstChild.textContent = 'Day ' + d.day; li.lastChild.textContent = Plan.label(d.items); }
        tbl.appendChild(li);
      });
      body.appendChild(tbl);
      $('plan-choice-text').textContent = 'You are on Day ' + state.day + ' of ' + len + ' now. The new plan has ' + res.plan.cycleLength + ' days.';
      $('plan-keep-label').textContent = 'Keep my current day number (Day ' + Math.min(res.plan.cycleLength, state.day) + ')';
      document.querySelector('input[name="plan-mode"][value="restart"]').checked = true;
      choice.hidden = false; ok.hidden = false;
    }
    $('dlg-plan').showModal();
  }
  $('btn-plan-upload').addEventListener('click', function () { $('plan-input').value = ''; $('plan-input').click(); });
  $('plan-input').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { $('dlg-settings').close(); showPlanPreview(Plan.parsePlan(String(reader.result), { title: 'Custom plan' }), f.name, false); };
    reader.onerror = function () { toast('Could not read that file.'); };
    if (f.size > Plan.LIMITS.maxBytes) { $('dlg-settings').close(); showPlanPreview({ ok: false, errors: ['The file is too large.'] }, f.name, false); return; }
    reader.readAsText(f);
  });
  $('btn-plan-download').addEventListener('click', function () {
    download(usingCustom ? 'my-reading-plan.csv' : 'reading-plan-template.csv', Plan.planToCsv(plan));
  });
  $('btn-plan-reset').addEventListener('click', function () {
    if (!usingCustom) { toast('You are already using the default plan.'); return; }
    $('dlg-settings').close();
    showPlanPreview({ ok: true, errors: [], plan: defaultPlan }, 'Bundled default plan', true);
  });
  $('btn-plan-accept').addEventListener('click', function () {
    if (!pendingPlan) return;
    var mode = document.querySelector('input[name="plan-mode"]:checked').value;
    stopPlayback();
    applyPlan(pendingPlan.plan, pendingPlan.custom);
    if (pendingPlan.custom) store(LS_PLAN, pendingPlan.plan); else { try { localStorage.removeItem(LS_PLAN); } catch (e) { /* ignore */ } }
    state = Q.applyPlanChange(state, len, mode, today());
    saveState();
    pendingPlan = null;
    $('dlg-plan').close();
    $('banner-msg').hidden = true;
    render();
    toast(usingCustom ? 'Your plan is saved on this device.' : 'Back to the default plan.');
  });
  $('btn-plan-cancel').addEventListener('click', function () { pendingPlan = null; $('dlg-plan').close(); });

  // ---------- service worker + updates ----------
  function setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').then(function (reg) {
      function offer(w) {
        $('banner-update').hidden = false;
        $('btn-update').onclick = function () { w.postMessage({ type: 'SKIP_WAITING' }); };
      }
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(nw);
        });
      });
      setInterval(function () { reg.update().catch(function () {}); }, 30 * 60 * 1000);
    }).catch(function () { /* app still works without it */ });
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloaded) return; reloaded = true;
      if (phase === 'idle' || audio.paused) location.reload();
    });
  }

  // ---------- launch ----------
  function launch() {
    $('gate').hidden = true; $('app').hidden = false;
    $('sel-speed').value = String(settings.speed);
    render();
    loadTranslations().then(function () { render(); }).catch(function (err) {
      if (err.status === 401) return;
      $('banner-msg').hidden = false;
      $('banner-msg').textContent = err.status === 0 ? 'You appear to be offline. Streaming needs a connection.' : err.message;
    });
  }

  function init() {
    setupServiceWorker();
    setupMediaSession();
    var saved = load(LS_SETTINGS);
    if (saved) settings = Object.assign(settings, saved);
    if (!(settings.speed >= 0.75 && settings.speed <= 2)) settings.speed = 1;
    fetch('/data/plan.json').then(function (r) { return r.json(); }).then(function (p) {
      defaultPlan = p;
      var stored = load(LS_PLAN), custom = stored ? Plan.fromStored(stored) : null;
      if (stored && !custom) { try { localStorage.removeItem(LS_PLAN); } catch (e) { /* ignore */ } }
      applyPlan(custom || p, !!custom);
      state = Q.normalize(load(LS_STATE), today(), len);
      state.pos = Math.min(state.pos, dayCount() - 1);
      saveState();
      if (getToken()) launch(); else showGate('');
    }).catch(function () {
      document.body.textContent = 'Could not load the reading plan. Please check your connection and reload.';
    });
  }

  // exposed for the test harness only
  window.__app = { get state() { return state; }, get phase() { return phase; }, get settings() { return settings; } };
  init();
})();
