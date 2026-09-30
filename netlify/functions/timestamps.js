'use strict';
// GET /api/timestamps?fileset=..&book=..&chapter=..  -> { verses: [{ verse, t }] }
// Optional helper so "save this verse" can record a verse number. Best effort:
// returns an empty list when a fileset has no timing data.
const { json, isMock, withAuth, bbFetch, validateRef } = require('./lib/common');

exports.handler = withAuth(['GET'], async (event) => {
  const ref = validateRef(event.queryStringParameters || {});
  if (isMock()) return json(200, { mock: true, verses: [] });
  let verses = [];
  try {
    const res = await bbFetch('/timestamps/' + encodeURIComponent(ref.fileset) + '/' + ref.book + '/' + ref.chapter);
    const list = Array.isArray(res.data) ? res.data : [];
    verses = list
      .map((d) => ({ verse: parseInt(d.verse_start, 10), t: Number(d.timestamp) }))
      .filter((d) => Number.isFinite(d.verse) && Number.isFinite(d.t))
      .sort((a, b) => a.t - b.t);
  } catch (e) {
    verses = [];
  }
  return json(200, { mock: false, verses });
});
