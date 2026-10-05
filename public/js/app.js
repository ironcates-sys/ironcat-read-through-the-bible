/* Read Through the Bible: front end. Plain JS, no framework.
 * ONE <audio> element is reused for everything (announcement clip, chapter, pause silence). */
(function () {
  'use strict';

  var Q = window.Queue;
  var $ = function (id) { return document.getElementById(id); };
  var audio = $('player');

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
  var settings = { translation: 'ENGESVO1DA', announce: true, pause: 0, speed: 1 };
  var translations = [];
  var mockMode = false;
  var sessionTranslation = '';      // what the picker shows; changes apply from the next chapter
  var termsUrl = $('link-terms').href;

  // playback machine
  var phase = 'idle';               // idle | loading | announce | chapter | pause
  var playToken = 0;                // bumps to cancel any in-flight startItem
  var pending = null;               // { token, metaP, resume }
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
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = showPause ? 'playing' : (phase === 'idle' ? 'none' : 'paused');
  }

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
  function keyFor(it, tr) { return tr + '|' + it.bookId + '|' + it.chapter; }
  function fetchChapter(it, tr) {
    var meta = translations.filter(function (t) { return t.id === tr; })[0] || {};
    var q = '/api/chapter?fileset=' + encodeURIComponent(tr) + '&book=' + it.bookId + '&chapter=' + it.chapter +
      (meta.bibleId ? '&bible=' + encodeURIComponent(meta.bibleId) : '');
    return api(q);
  }
  function resolveChapter(it, tr) {
    var k = keyFor(it, tr);
    var p = prefetch[k];
    delete prefetch[k];
    if (p && Date.now() - p.at < PREFETCH_MAX_AGE) return p.promise;
    return fetchChapter(it, tr);   // resolved right before play
  }
  function maybePrefetch() {
    if (phase !== 'chapter' || !isFinite(audio.duration)) return;
    if (audio.duration - audio.currentTime > PREFETCH_SECONDS) return;
    if (prefetchedFor === state.pos) return;
    prefetchedFor = state.pos;
    var nextPos = state.pos + 1;
    if (nextPos >= dayCount() || sleepStopAfterChapter || sleepMode === 'chapter') return;
    var it = todayItems()[nextPos];
    var tr = sessionTranslation;
    var p = fetchChapter(it, tr);
    p.catch(function () { /* will simply be resolved again at play time */ });
    prefetch[keyFor(it, tr)] = { at: Date.now(), promise: p };
  }

  // ---------- playback ----------
  function setSrc(url) {
    audio.src = url;
    audio.defaultPlaybackRate = settings.speed;
    audio.playbackRate = settings.speed;
  }
  function tryPlay() {
    var p = audio.play();
    if (p && p.catch) p.catch(function (e) {
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
    current = { day: state.day, pos: state.pos, item: it, meta: null };
    phase = 'loading';
    render();
    var metaP = resolveChapter(it, tr);
    metaP.catch(function () { /* handled in finishResolve */ });
    pending = { token: token, metaP: metaP, resume: resume };
    var useAnnounce = settings.announce && !(resume > 2);
    if (useAnnounce) {
      phase = 'announce';
      setSrc('/announce/' + Q.clipName(it.bookId, it.chapter, isSingle(it)));
      tryPlay();
      updateNow(); updatePlayIcon();
    } else {
      // Keep the (already user-activated) audio element busy with a short silent clip while the URL
      // resolves; iOS Safari is stricter about play() calls that happen after an async gap.
      setSrc('/announce/silence.mp3');
      tryPlay();
      finishResolve(token);
    }
  }

  function finishResolve(token) {
    var pd = pending;
    if (!pd || pd.token !== token) return;
    pd.metaP.then(function (meta) {
      if (token !== playToken) return;
      playChapter(meta, pd.resume);
    }, function (err) {
      if (token !== playToken) return;
      phase = 'idle';
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
    setSrc(meta.audioUrl);
    tryPlay();
    setCopyright(meta);
    setMediaMetadata();
    updateNow(); updatePlayIcon();
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
    if (settings.pause > 0) {
      phase = 'pause'; pauseLeft = settings.pause;
      setSrc('/announce/silence.mp3');
      tryPlay(); updateNow();
    } else {
      startItem(0);
    }
  }

  audio.addEventListener('ended', function () {
    if (phase === 'announce') { finishResolve(playToken); return; }
    if (phase === 'chapter') { onChapterEnded(); return; }
    if (phase === 'pause') {
      pauseLeft -= 1;
      if (pauseLeft > 0) { audio.currentTime = 0; tryPlay(); } else { startItem(0); }
    }
  });

  audio.addEventListener('error', function () {
    if (phase === 'announce') { finishResolve(playToken); return; }       // graceful: skip the clip
    if (phase === 'pause') { startItem(0); return; }
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

  audio.addEventListener('loadedmetadata', function () {
    if (phase === 'chapter' && resumeAt > 0 && resumeAt < (audio.duration || Infinity) - 2) { audio.currentTime = resumeAt; }
    resumeAt = 0;
    $('t-dur').textContent = phase === 'chapter' ? fmt(audio.duration) : '0:00';
    updatePosition();
  });
  audio.addEventListener('play', updatePlayIcon);
  audio.addEventListener('pause', function () { updatePlayIcon(); persistPosition(true); });
  audio.addEventListener('playing', updatePlayIcon);

  audio.addEventListener('timeupdate', function () {
    $('t-cur').textContent = fmt(audio.currentTime);
    if (audio.duration && isFinite(audio.duration)) {
      $('seek').value = Math.round((audio.currentTime / audio.duration) * 1000);
      $('t-dur').textContent = fmt(audio.duration);
    }
    persistPosition(false);
    maybePrefetch();
    checkSleep();
    updatePosition();
  });

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
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { checkSleep(); if (state) render(); } });

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
    var p = verseCache || api('/api/timestamps?fileset=' + encodeURIComponent(tr) + '&book=' + it.bookId + '&chapter=' + it.chapter);
    p.then(function (r) {
      verseCache = Promise.resolve(r);
      var v = null;
      (r.verses || []).forEach(function (x) { if (x.t <= pos) v = x.verse; });
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

  // ---------- settings ----------
  $('btn-settings').addEventListener('click', function () {
    $('set-announce').checked = settings.announce;
    $('set-pause').value = String(settings.pause);
    $('app-version').textContent = typeof APP_VERSION !== 'undefined' ? APP_VERSION : '';
    $('dlg-settings').showModal();
  });
  $('set-announce').addEventListener('change', function () { settings.announce = this.checked; saveSettings(); });
  $('set-pause').addEventListener('change', function () { settings.pause = Number(this.value) || 0; saveSettings(); });
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
