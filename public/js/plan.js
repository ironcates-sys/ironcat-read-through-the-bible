/* Plan parsing + validation (pure, no DOM/network). Used by the app (window.Plan), by
 * scripts/csv-to-plan.js (builds the bundled default plan) and by the tests.
 *
 * CSV format: a header row containing a "Day" column plus any number of chapter columns.
 * Cells hold a book + chapter ("Isaiah 1"), a chapter range ("Jeremiah 1-2"), several
 * references separated by ";" or "+" ("Psalm 1; Psalm 3"), or be empty.
 * Single-chapter books (Obadiah, Philemon, 2 John, 3 John, Jude) may be given by name alone. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Plan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // [display name, Bible Brain book id, chapter count (English versification)]
  var BOOKS = [
    ['Genesis', 'GEN', 50], ['Exodus', 'EXO', 40], ['Leviticus', 'LEV', 27], ['Numbers', 'NUM', 36], ['Deuteronomy', 'DEU', 34],
    ['Joshua', 'JOS', 24], ['Judges', 'JDG', 21], ['Ruth', 'RUT', 4], ['1 Samuel', '1SA', 31], ['2 Samuel', '2SA', 24],
    ['1 Kings', '1KI', 22], ['2 Kings', '2KI', 25], ['1 Chronicles', '1CH', 29], ['2 Chronicles', '2CH', 36], ['Ezra', 'EZR', 10],
    ['Nehemiah', 'NEH', 13], ['Esther', 'EST', 10], ['Job', 'JOB', 42], ['Psalms', 'PSA', 150], ['Proverbs', 'PRO', 31],
    ['Ecclesiastes', 'ECC', 12], ['Song of Solomon', 'SNG', 8], ['Isaiah', 'ISA', 66], ['Jeremiah', 'JER', 52], ['Lamentations', 'LAM', 5],
    ['Ezekiel', 'EZK', 48], ['Daniel', 'DAN', 12], ['Hosea', 'HOS', 14], ['Joel', 'JOL', 3], ['Amos', 'AMO', 9],
    ['Obadiah', 'OBA', 1], ['Jonah', 'JON', 4], ['Micah', 'MIC', 7], ['Nahum', 'NAM', 3], ['Habakkuk', 'HAB', 3],
    ['Zephaniah', 'ZEP', 3], ['Haggai', 'HAG', 2], ['Zechariah', 'ZEC', 14], ['Malachi', 'MAL', 4],
    ['Matthew', 'MAT', 28], ['Mark', 'MRK', 16], ['Luke', 'LUK', 24], ['John', 'JHN', 21], ['Acts', 'ACT', 28],
    ['Romans', 'ROM', 16], ['1 Corinthians', '1CO', 16], ['2 Corinthians', '2CO', 13], ['Galatians', 'GAL', 6], ['Ephesians', 'EPH', 6],
    ['Philippians', 'PHP', 4], ['Colossians', 'COL', 4], ['1 Thessalonians', '1TH', 5], ['2 Thessalonians', '2TH', 3],
    ['1 Timothy', '1TI', 6], ['2 Timothy', '2TI', 4], ['Titus', 'TIT', 3], ['Philemon', 'PHM', 1], ['Hebrews', 'HEB', 13],
    ['James', 'JAS', 5], ['1 Peter', '1PE', 5], ['2 Peter', '2PE', 3], ['1 John', '1JN', 5], ['2 John', '2JN', 1],
    ['3 John', '3JN', 1], ['Jude', 'JUD', 1], ['Revelation', 'REV', 22],
  ];

  var ALIASES = {
    psalm: 'Psalms', ps: 'Psalms', psa: 'Psalms', pslm: 'Psalms',
    'song of songs': 'Song of Solomon', 'songs of solomon': 'Song of Solomon', 'song of sol': 'Song of Solomon', sos: 'Song of Solomon', song: 'Song of Solomon',
    revelations: 'Revelation', 'revelation of john': 'Revelation',
    gen: 'Genesis', exod: 'Exodus', ex: 'Exodus', lev: 'Leviticus', num: 'Numbers', deut: 'Deuteronomy', josh: 'Joshua', judg: 'Judges',
    prov: 'Proverbs', eccl: 'Ecclesiastes', eccles: 'Ecclesiastes', isa: 'Isaiah', jer: 'Jeremiah', lam: 'Lamentations', ezek: 'Ezekiel',
    dan: 'Daniel', hos: 'Hosea', obad: 'Obadiah', mic: 'Micah', nah: 'Nahum', hab: 'Habakkuk', zeph: 'Zephaniah', hag: 'Haggai',
    zech: 'Zechariah', mal: 'Malachi', matt: 'Matthew', mk: 'Mark', lk: 'Luke', jn: 'John', rom: 'Romans', gal: 'Galatians', eph: 'Ephesians',
    phil: 'Philippians', col: 'Colossians', heb: 'Hebrews', jas: 'James', rev: 'Revelation',
  };

  var LIMITS = { maxBytes: 300000, maxDays: 1000, maxItemsPerDay: 30 };

  var byKey = {};
  function key(s) {
    return String(s).toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()
      .replace(/^(iii|3rd|third)\s*/, '3 ').replace(/^(ii|2nd|second)\s*/, '2 ').replace(/^(i|1st|first)\s+/, '1 ')
      .replace(/^([123])(?=[a-z])/, '$1 ');
  }
  BOOKS.forEach(function (b) {
    byKey[key(b[0])] = b;
    byKey[b[1].toLowerCase()] = byKey[b[1].toLowerCase()] || b;
  });
  Object.keys(ALIASES).forEach(function (a) {
    var target = BOOKS.filter(function (b) { return b[0] === ALIASES[a]; })[0];
    if (!byKey[key(a)]) byKey[key(a)] = target;
  });

  function findBook(name) {
    var b = byKey[key(name)];
    return b ? { name: b[0], id: b[1], chapters: b[2] } : null;
  }

  function lev(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) d[i] = [i];
    for (j = 1; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  function suggest(name) {
    var k = key(name), best = null, bestD = 3;
    BOOKS.forEach(function (b) {
      var dist = lev(k, key(b[0]));
      if (dist < bestD) { bestD = dist; best = b[0]; }
    });
    return best;
  }

  // ---------- CSV ----------
  function parseCsv(text, delim) {
    text = String(text).replace(/^\uFEFF/, '');
    var rows = [], row = [], cell = '', q = false, i, c;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = ''; rows.push(row); row = [];
      } else cell += c;
    }
    if (q) throw new Error('A quoted cell is never closed (missing ").');
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); });
  }

  // ---------- cell -> items ----------
  // Returns { items: [...], errors: [...] } for one cell.
  function parseCell(cell, where) {
    var items = [], errors = [];
    String(cell).split(/[;+]/).forEach(function (part) {
      part = part.replace(/[\u2013\u2014\u2212]/g, '-').replace(/\u00a0/g, ' ').trim();
      if (!part) return;
      if (/:/.test(part)) { errors.push(where + '"' + part + '": verses are not supported, use whole chapters (e.g. "John 3" or "John 3-4").'); return; }
      var m = /^(.*?)(?:\s+(\d+)(?:\s*-\s*(\d+))?)?$/.exec(part);
      var name = m[1].trim();
      var bk = findBook(name);
      if (!bk) {
        var s = suggest(name);
        errors.push(where + 'unknown book "' + name + '"' + (s ? ' (did you mean ' + s + '?)' : '') + '.');
        return;
      }
      if (m[2] === undefined) {
        if (bk.chapters === 1) { items.push({ book: bk.name, bookId: bk.id, chapter: 1 }); return; }
        errors.push(where + '"' + part + '": ' + bk.name + ' needs a chapter number (it has ' + bk.chapters + ').');
        return;
      }
      var a = Number(m[2]), z = m[3] === undefined ? a : Number(m[3]);
      if (a < 1 || z < 1) { errors.push(where + '"' + part + '": chapter numbers start at 1.'); return; }
      if (a > bk.chapters || z > bk.chapters) {
        errors.push(where + '"' + part + '": ' + bk.name + ' has only ' + bk.chapters + ' chapter' + (bk.chapters === 1 ? '' : 's') + '.');
        return;
      }
      if (z < a) { errors.push(where + '"' + part + '": the range runs backwards.'); return; }
      for (var ch = a; ch <= z; ch++) items.push({ book: bk.name, bookId: bk.id, chapter: ch });
    });
    return { items: items, errors: errors };
  }

  function booksMap(days) {
    var out = {};
    days.forEach(function (d) { d.items.forEach(function (it) {
      var b = findBook(it.book);
      if (b) out[b.name] = { id: b.id, chapters: b.chapters };
    }); });
    return out;
  }

  // ---------- full CSV -> plan ----------
  // Returns { ok, errors: [string], plan | null }
  function parsePlan(text, opts) {
    opts = opts || {};
    var errors = [];
    function fail(msg) { errors.push(msg); return { ok: false, errors: errors, plan: null }; }
    if (typeof text !== 'string' || !text.trim()) return fail('The file is empty.');
    if (text.length > LIMITS.maxBytes) return fail('The file is too large (limit ' + Math.round(LIMITS.maxBytes / 1000) + ' KB).');
    var firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/)[0];
    var delim = firstLine.indexOf(',') === -1 && firstLine.indexOf('\t') !== -1 ? '\t' : ',';
    var rows;
    try { rows = parseCsv(text, delim); } catch (e) { return fail(e.message); }
    if (rows.length < 2) return fail('Need a header row and at least one day.');
    var header = rows[0].map(function (h) { return String(h).trim(); });
    var dayCol = -1;
    header.forEach(function (h, i) { if (dayCol === -1 && /^day$/i.test(h)) dayCol = i; });
    if (dayCol === -1) return fail('The header row must include a column named "Day".');
    var cols = [];
    header.forEach(function (h, i) { if (i !== dayCol) cols.push(i); });
    if (!cols.length) return fail('Add at least one chapter column after "Day".');

    var seen = {}, days = [];
    if (rows.length - 1 > LIMITS.maxDays) return fail('Too many days (limit ' + LIMITS.maxDays + ').');
    rows.slice(1).forEach(function (r, idx) {
      var rowNo = idx + 2;
      var dm = /^(?:day\s*)?(\d+)$/i.exec(String(r[dayCol] === undefined ? '' : r[dayCol]).trim());
      if (!dm) { errors.push('Row ' + rowNo + ': Day must be a whole number (got "' + String(r[dayCol] || '').trim() + '").'); return; }
      var day = Number(dm[1]);
      if (seen[day]) { errors.push('Row ' + rowNo + ': Day ' + day + ' appears more than once.'); return; }
      seen[day] = true;
      var items = [];
      cols.forEach(function (ci) {
        var cellText = r[ci] === undefined ? '' : r[ci];
        var where = 'Row ' + rowNo + ' (Day ' + day + '), column "' + (header[ci] || 'column ' + (ci + 1)) + '": ';
        var res = parseCell(cellText, where);
        res.errors.forEach(function (e) { errors.push(e); });
        res.items.forEach(function (it) { items.push(it); });
      });
      days.push({ day: day, items: items });
    });
    if (errors.length) return { ok: false, errors: errors, plan: null };

    days.sort(function (a, b) { return a.day - b.day; });
    days.forEach(function (d, i) {
      if (d.day !== i + 1 && errors.length < 50) errors.push('Days must be numbered 1, 2, 3 \u2026 with no gaps: expected Day ' + (i + 1) + ' but found Day ' + d.day + '.');
    });
    days.forEach(function (d) {
      if (!d.items.length) errors.push('Day ' + d.day + ' has no readings.');
      if (d.items.length > LIMITS.maxItemsPerDay) errors.push('Day ' + d.day + ' has ' + d.items.length + ' chapters (limit ' + LIMITS.maxItemsPerDay + ' per day).');
    });
    if (errors.length) return { ok: false, errors: errors, plan: null };

    var counts = days.map(function (d) { return d.items.length; });
    var plan = {
      title: opts.title || 'Custom plan',
      cycleLength: days.length,
      itemsPerDay: Math.min.apply(null, counts) === Math.max.apply(null, counts) ? counts[0] : null,
      columns: cols.map(function (ci) { return header[ci]; }),
      books: booksMap(days),
      days: days,
    };
    return { ok: true, errors: [], plan: plan };
  }

  // Re-validate a plan object read back from localStorage (never trust stored data blindly).
  function fromStored(obj) {
    try {
      if (!obj || !Array.isArray(obj.days) || !obj.days.length || obj.days.length > LIMITS.maxDays) return null;
      var days = [];
      for (var i = 0; i < obj.days.length; i++) {
        var d = obj.days[i];
        if (!d || d.day !== i + 1 || !Array.isArray(d.items) || !d.items.length || d.items.length > LIMITS.maxItemsPerDay) return null;
        var items = [];
        for (var j = 0; j < d.items.length; j++) {
          var it = d.items[j], b = findBook(it.book);
          if (!b || !Number.isInteger(it.chapter) || it.chapter < 1 || it.chapter > b.chapters) return null;
          items.push({ book: b.name, bookId: b.id, chapter: it.chapter });
        }
        days.push({ day: i + 1, items: items });
      }
      return {
        title: typeof obj.title === 'string' ? obj.title.slice(0, 80) : 'Custom plan',
        cycleLength: days.length, itemsPerDay: null,
        columns: Array.isArray(obj.columns) ? obj.columns.map(String).slice(0, LIMITS.maxItemsPerDay) : [],
        books: booksMap(days), days: days,
      };
    } catch (e) { return null; }
  }

  // ---------- plan -> CSV (template / backup). One item per cell, so it always re-imports identically. ----------
  function csvEscape(s) { s = String(s); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function planToCsv(plan) {
    var max = 0;
    plan.days.forEach(function (d) { max = Math.max(max, d.items.length); });
    var names = [];
    var useCols = plan.columns && plan.columns.length === max && plan.days.every(function (d) { return d.items.length === max; });
    for (var i = 0; i < max; i++) names.push(useCols ? plan.columns[i] : 'Reading_' + (i + 1));
    var lines = [['Day'].concat(names).map(csvEscape).join(',')];
    plan.days.forEach(function (d) {
      var cells = [String(d.day)];
      for (var i = 0; i < max; i++) cells.push(d.items[i] ? d.items[i].book + ' ' + d.items[i].chapter : '');
      lines.push(cells.map(csvEscape).join(','));
    });
    return lines.join('\n') + '\n';
  }

  function summarize(plan) {
    var total = 0, min = Infinity, max = 0, books = [];
    plan.days.forEach(function (d) {
      total += d.items.length; min = Math.min(min, d.items.length); max = Math.max(max, d.items.length);
      d.items.forEach(function (it) { if (books.indexOf(it.book) === -1) books.push(it.book); });
    });
    return { days: plan.days.length, chapters: total, minPerDay: min, maxPerDay: max, books: books };
  }

  function label(items) { // "Jeremiah 1-2, Isaiah 5" style, for previews
    var out = [], prev = null;
    items.forEach(function (it) {
      if (prev && prev.book === it.book && it.chapter === prev.end + 1) { prev.end = it.chapter; return; }
      prev = { book: it.book, start: it.chapter, end: it.chapter }; out.push(prev);
    });
    return out.map(function (r) { return r.book + ' ' + r.start + (r.end > r.start ? '-' + r.end : ''); }).join(', ');
  }

  return { BOOKS: BOOKS, LIMITS: LIMITS, findBook: findBook, parseCsv: parseCsv, parseCell: parseCell,
    parsePlan: parsePlan, fromStored: fromStored, planToCsv: planToCsv, summarize: summarize, label: label };
});
