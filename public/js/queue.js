/* Pure logic: plan helpers, saved-progress state, streak info. No DOM, no network.
 * Works in the browser (window.Queue), the service worker (importScripts) and Node (tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Queue = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ITEMS_PER_DAY = 6;

  // ---------- dates (local calendar days) ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localDate(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dayNumber(iso) { // whole days since epoch, DST-safe
    var p = iso.split('-').map(Number);
    return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000);
  }
  function daysBetween(a, b) { return dayNumber(b) - dayNumber(a); }

  // ---------- announcement clip names (must match scripts/generate-announcements.py) ----------
  function clipName(bookId, chapter, singleChapterBook) {
    bookId = String(bookId).toLowerCase();
    return singleChapterBook ? bookId + '.mp3' : bookId + '-' + chapter + '.mp3';
  }
  function announceText(book, chapter, singleChapterBook) {
    return singleChapterBook ? book : book + ', chapter ' + chapter;
  }
  function allClipNames(plan) {
    var seen = {}, out = [];
    plan.days.forEach(function (d) {
      d.items.forEach(function (it) {
        var n = clipName(it.bookId, it.chapter, plan.books[it.book].chapters === 1);
        if (!seen[n]) { seen[n] = 1; out.push(n); }
      });
    });
    return out;
  }

  // ---------- state ----------
  function defaultState(today, cycleLength) {
    return { v: 1, cycle: 1, day: 1, pos: 0, t: 0, done: {}, readDates: [], anchorDate: today, anchorDay: 1, saved: [] };
  }

  function normalize(s, today, len) {
    var d = defaultState(today, len);
    if (!s || typeof s !== 'object') return d;
    var out = Object.assign(d, s);
    if (!out.done || typeof out.done !== 'object') out.done = {};
    if (!Array.isArray(out.readDates)) out.readDates = [];
    if (!Array.isArray(out.saved)) out.saved = [];
    out.cycle = Math.max(1, out.cycle | 0);
    out.day = Math.min(len, Math.max(1, out.day | 0));
    out.pos = Math.min(99, Math.max(0, out.pos | 0));  // app clamps to the day's real chapter count
    out.t = Math.max(0, Number(out.t) || 0);
    return out;
  }

  function doneList(state) { return state.done[String(state.cycle)] || []; }
  function isDone(state, day) { return doneList(state).indexOf(day) !== -1; }

  function clone(s) { return JSON.parse(JSON.stringify(s)); }

  function calendarDay(state, today, len) {
    var elapsed = daysBetween(state.anchorDate, today);
    if (elapsed < 0) elapsed = 0;
    return ((state.anchorDay - 1 + elapsed) % len) + 1;
  }

  // The next day (after `from`, wrapping) that is not yet done this cycle, or null if all done.
  function nextUndoneDay(state, from, len) {
    for (var i = 1; i <= len; i++) {
      var d = ((from - 1 + i) % len) + 1;
      if (!isDone(state, d)) return d;
    }
    return null;
  }

  function addReadDate(s, today) {
    if (s.readDates.indexOf(today) === -1) s.readDates.push(today);
    if (s.readDates.length > 400) s.readDates = s.readDates.slice(-400);
  }

  function markDone(state, day, today) {
    var s = clone(state), k = String(s.cycle);
    s.done[k] = s.done[k] || [];
    if (s.done[k].indexOf(day) === -1) s.done[k].push(day);
    s.done[k].sort(function (a, b) { return a - b; });
    addReadDate(s, today);
    return s;
  }

  function unmarkDone(state, day) {
    var s = clone(state), k = String(s.cycle);
    s.done[k] = (s.done[k] || []).filter(function (d) { return d !== day; });
    return s;
  }

  // Finish the current day: mark done, move to the next unread day (or start the next cycle).
  function finishDay(state, today, len) {
    var s = markDone(state, state.day, today);
    var next = nextUndoneDay(s, state.day, len);
    var cycleCompleted = false;
    if (next === null) {
      cycleCompleted = true;
      s.cycle += 1;
      s.day = 1;
      s.anchorDate = today;
      s.anchorDay = 1;
    } else {
      s.day = next;
    }
    s.pos = 0;
    s.t = 0;
    return { state: s, cycleCompleted: cycleCompleted, finishedDay: state.day };
  }

  // A chapter finished: go to the next chapter, or finish the day after the sixth.
  // `count` = number of chapters in the current day (plans can have any number per day).
  function chapterFinished(state, today, len, count) {
    count = count || ITEMS_PER_DAY;
    if (state.pos + 1 >= count) {
      var r = finishDay(state, today, len);
      r.dayFinished = true;
      return r;
    }
    var s = clone(state);
    s.pos += 1;
    s.t = 0;
    addReadDate(s, today);
    return { state: s, dayFinished: false, cycleCompleted: false, finishedDay: null };
  }

  function setPosition(state, pos, count) {
    var s = clone(state);
    s.pos = Math.min((count || ITEMS_PER_DAY) - 1, Math.max(0, pos));
    s.t = 0;
    return s;
  }

  // "Jump to any day": you are reading that day today, so the calendar pace re-anchors here.
  function jumpToDay(state, day, today, len) {
    var s = clone(state);
    s.day = Math.min(len, Math.max(1, day));
    s.pos = 0;
    s.t = 0;
    s.anchorDate = today;
    s.anchorDay = s.day;
    return s;
  }

  // "Skip to today": go to the calendar day without changing the pace anchor.
  function skipToToday(state, today, len) {
    var s = clone(state);
    s.day = calendarDay(state, today, len);
    s.pos = 0;
    s.t = 0;
    return s;
  }

  function startNewCycle(state, today) {
    var s = clone(state);
    s.cycle += 1;
    s.day = 1; s.pos = 0; s.t = 0;
    s.anchorDate = today; s.anchorDay = 1;
    return s;
  }

  // The reading plan was replaced. mode: 'restart' (Day 1, finished-day marks for this cycle cleared)
  // or 'keep' (same day number, clamped to the new length; marks beyond the new length dropped).
  // The cycle number and reading history (readDates, saved verses) are kept either way.
  function applyPlanChange(state, newLen, mode, today) {
    var s = clone(state), k = String(s.cycle);
    if (mode === 'restart') { s.done[k] = []; s.day = 1; }
    else {
      s.done[k] = (s.done[k] || []).filter(function (d) { return d <= newLen; });
      s.day = Math.min(newLen, Math.max(1, s.day));
    }
    s.pos = 0; s.t = 0;
    s.anchorDate = today; s.anchorDay = s.day;
    return s;
  }

  // How many days the calendar is ahead of your reading (0 if not behind). Never negative, never scolding.
  function behindBy(state, today, len) {
    var cal = calendarDay(state, today, len);
    return cal > state.day ? cal - state.day : 0;
  }

  // ---------- gentle streak info ----------
  function streakInfo(state, today, len) {
    var dates = state.readDates;
    var last = dates.length ? dates.slice().sort().pop() : null;
    var sinceLast = last ? daysBetween(last, today) : null;
    var inLast7 = dates.filter(function (d) { var n = daysBetween(d, today); return n >= 0 && n < 7; }).length;
    var message;
    if (sinceLast === null) message = 'Begin whenever you are ready.';
    else if (sinceLast === 0) message = 'You have read today. Well done.';
    else if (sinceLast === 1) message = 'Yesterday\u2019s reading is done. Ready when you are.';
    else message = 'Welcome back. Pick up right where you left off.';
    return {
      cycle: state.cycle,
      daysReadThisCycle: doneList(state).length,
      cycleLength: len,
      readInLast7: inLast7,
      lastReadDate: last,
      daysSinceLast: sinceLast,
      readToday: sinceLast === 0,
      message: message,
    };
  }

  function saveVerse(state, v) {
    var s = clone(state);
    s.saved.unshift(v);
    if (s.saved.length > 500) s.saved = s.saved.slice(0, 500);
    return s;
  }

  // Is a prefetched signed URL still young enough to use?
  function prefetchFresh(at, now, maxAge) { return typeof at === 'number' && now - at >= 0 && now - at < maxAge; }

  // Small ring buffer for the private on-device playback log.
  function pushLog(list, entry, max) { var a = (Array.isArray(list) ? list : []).concat([entry]); return a.length > max ? a.slice(a.length - max) : a; }
  // With the screen off, skip the short announcement / pause clips: Android Chrome drops the media
  // session (and lets the page be frozen) for clips under ~5s, so the next chapter never starts.
  function useShortClips(hidden) { return !hidden; }

  // Prefetch / preload identity: exact fileset + book + chapter.
  function prefetchKey(fileset, bookId, chapter) { return String(fileset) + '|' + String(bookId) + '|' + Number(chapter); }
  // Did the server answer for the chapter we asked for? (Only checks fields it returns.)
  function metaMatches(meta, fileset, bookId, chapter) {
    if (!meta) return false;
    if (meta.bookId && meta.bookId !== bookId) return false;
    if (meta.book_id && meta.book_id !== bookId) return false;
    if (meta.chapter != null && Number(meta.chapter) !== Number(chapter)) return false;
    var fs = meta.fileset || meta.filesetId || (meta.translation && meta.translation.id);
    if (fs && fs !== fileset) return false;
    return true;
  }
  // Use the preloaded standby element only for the very same chapter AND the very same URL.
  function preloadMatches(pre, key, url) { return !!(pre && pre.key && pre.url && key && url && pre.key === key && pre.url === url); }

  return {
    prefetchKey: prefetchKey, metaMatches: metaMatches, preloadMatches: preloadMatches,
    pushLog: pushLog, useShortClips: useShortClips,
    prefetchFresh: prefetchFresh,
    ITEMS_PER_DAY: ITEMS_PER_DAY,
    localDate: localDate, daysBetween: daysBetween,
    clipName: clipName, announceText: announceText, allClipNames: allClipNames,
    defaultState: defaultState, normalize: normalize, doneList: doneList, isDone: isDone,
    calendarDay: calendarDay, nextUndoneDay: nextUndoneDay,
    markDone: markDone, unmarkDone: unmarkDone, finishDay: finishDay, chapterFinished: chapterFinished,
    setPosition: setPosition, applyPlanChange: applyPlanChange, jumpToDay: jumpToDay, skipToToday: skipToToday, startNewCycle: startNewCycle,
    behindBy: behindBy, streakInfo: streakInfo, saveVerse: saveVerse,
  };
});
