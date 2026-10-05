'use strict';
// GET /api/text?fileset=ENGESVO1DA&book=ISA&chapter=1[&bible=ENGESV]
//   -> { mock, bookId, bookName, chapter, textFileset, verses: [{ verse, verseEnd?, text }], copyright, termsUrl }
// Plain chapter text for the "Follow along" screen. `fileset` is the AUDIO fileset being played;
// the matching text_plain fileset of the same bible is resolved here. Streamed per request and
// never cached (no-store); only fileset metadata (ids/sizes, no Scripture) is memoised in memory.
// When no text exists, responds 200 with an empty verse list and `unavailable` so the UI degrades quietly.
const { json, isMock, withAuth, bbFetch, validateRef, TERMS_URL, ApiError } = require('./lib/common');
const mock = require('./lib/mock');
const { getCopyright } = require('./lib/copyright');

// USFM ids of the 39 Old Testament books; anything else is treated as New Testament.
const OT_BOOKS = new Set([
  'GEN', 'EXO', 'LEV', 'NUM', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA', '1KI', '2KI', '1CH', '2CH', 'EZR', 'NEH',
  'EST', 'JOB', 'PSA', 'PRO', 'ECC', 'SNG', 'ISA', 'JER', 'LAM', 'EZK', 'DAN', 'HOS', 'JOL', 'AMO', 'OBA', 'JON',
  'MIC', 'NAM', 'HAB', 'ZEP', 'HAG', 'ZEC', 'MAL',
]);
const RE_TEXT_FILESET = /^[A-Z0-9_]{6,24}$/; // e.g. ENGESVO_ET (skips encoded variants like ...-json / -usx)

function testamentOf(book) {
  return OT_BOOKS.has(book) ? 'OT' : 'NT';
}

// How well does a Bible Brain size code cover the testament? Higher is better, 0 = no.
// Codes seen: OT, NT, C (complete), NTOT, OTNTP, NTOTP, NTPOTP, OTP, NTP, P.
function sizeScore(size, testament) {
  if (!size) return 0;
  if (size === testament) return 4;
  if (size === 'C' || size === 'NTOT' || size === 'OTNT') return 3;
  if (size.includes(testament)) return 2; // full or partial (…P) coverage of that testament
  if (size === 'P') return 1;            // unknown partial: worth a try
  return 0;
}

// Pure helper (exported for tests): ordered text_plain candidates for a book.
function pickTextFilesets(bibleData, book) {
  const testament = testamentOf(book);
  const all = Object.values((bibleData && bibleData.filesets) || {}).flat();
  const seen = new Set();
  const out = [];
  for (const fs of all) {
    if (!fs) continue;
    // Live Bible Brain uses type/size; some docs/tests still use set_type_code/set_size_code.
    const type = fs.set_type_code || fs.type;
    const size = fs.set_size_code || fs.size;
    if (type !== 'text_plain') continue;
    if (!RE_TEXT_FILESET.test(fs.id || '') || seen.has(fs.id)) continue;
    const score = sizeScore(size, testament);
    if (!score) continue;
    seen.add(fs.id);
    out.push({ id: fs.id, size, score });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((c) => c.id);
}

const bibleMemo = new Map(); // bibleId -> { at, data: { filesets } }  (metadata only)
const MEMO_MS = 6 * 3600 * 1000;

async function getBible(bible) {
  const hit = bibleMemo.get(bible);
  if (hit && hit.at > Date.now() - MEMO_MS) return hit.data;
  const res = await bbFetch('/bibles/' + encodeURIComponent(bible));
  const d = (res && res.data) || res || {};
  const data = { filesets: d.filesets || {} };
  bibleMemo.set(bible, { at: Date.now(), data });
  return data;
}

function toVerses(list) {
  const byVerse = new Map();
  for (const d of list) {
    if (!d) continue;
    const verse = parseInt(d.verse_start, 10);
    const text = typeof d.verse_text === 'string' ? d.verse_text.replace(/\s+/g, ' ').trim() : '';
    if (!Number.isInteger(verse) || verse < 1 || !text) continue; // drops verse 0 / headings / empties
    if (byVerse.has(verse)) continue;
    const end = parseInt(d.verse_end, 10);
    const v = { verse, text };
    if (Number.isInteger(end) && end > verse) v.verseEnd = end; // combined verses, e.g. 3-4
    byVerse.set(verse, v);
  }
  return [...byVerse.values()].sort((a, b) => a.verse - b.verse);
}

exports.handler = withAuth(['GET'], async (event) => {
  const ref = validateRef(event.queryStringParameters || {});
  if (isMock()) return json(200, mock.text(ref));

  const base = { mock: false, bookId: ref.book, bookName: ref.book, chapter: ref.chapter, termsUrl: TERMS_URL };
  let candidates;
  try {
    candidates = pickTextFilesets(await getBible(ref.bible), ref.book);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) candidates = [];
    else throw e;
  }
  if (!candidates.length) {
    return json(200, { ...base, textFileset: null, verses: [], unavailable: 'no_text_fileset', copyright: { text: '', organizations: [] } });
  }

  // Try the best candidate first; a partial fileset may lack this book, so fall through (max 3 tries).
  for (const textFileset of candidates.slice(0, 3)) {
    let res;
    try {
      res = await bbFetch('/bibles/filesets/' + encodeURIComponent(textFileset) + '/' + ref.book + '/' + ref.chapter);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) continue;
      throw e;
    }
    const list = Array.isArray(res && res.data) ? res.data : [];
    const verses = toVerses(list);
    if (!verses.length) continue;
    const first = list.find((d) => d && d.book_name);
    const copyright = await getCopyright(ref.bible, textFileset, /^text/);
    return json(200, { ...base, bookName: (first && first.book_name) || ref.book, textFileset, verses, copyright });
  }
  return json(200, { ...base, textFileset: null, verses: [], unavailable: 'not_found', copyright: { text: '', organizations: [] } });
});

exports._pickTextFilesets = pickTextFilesets; // for tests
exports._toVerses = toVerses;
