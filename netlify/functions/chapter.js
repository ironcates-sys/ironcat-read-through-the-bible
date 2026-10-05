'use strict';
// GET /api/chapter?fileset=ENGESVO2DA&book=ISA&chapter=1[&bible=ENGESV]
// Returns ONLY: a freshly signed audio URL, duration, copyright and small metadata.
// The URL is meant to be streamed immediately; it is never stored by the app.
const { json, isMock, withAuth, bbFetch, validateRef, TERMS_URL, ApiError } = require('./lib/common');
const mock = require('./lib/mock');
const { getCopyright } = require('./lib/copyright');

exports.handler = withAuth(['GET'], async (event) => {
  const ref = validateRef(event.queryStringParameters || {});
  if (isMock()) return json(200, mock.chapter(ref));

  const [chapterRes, copyright] = await Promise.all([
    bbFetch('/bibles/filesets/' + encodeURIComponent(ref.fileset) + '/' + ref.book + '/' + ref.chapter),
    getCopyright(ref.bible, ref.fileset),
  ]);
  const first = Array.isArray(chapterRes.data) ? chapterRes.data.find((d) => d && typeof d.path === 'string') : null;
  if (!first) throw new ApiError(404, 'not_available', 'This chapter is not available in that translation.');
  let u;
  try {
    u = new URL(first.path);
  } catch (e) {
    throw new ApiError(502, 'bad_audio_url', 'Bible Brain returned an unusable audio link.');
  }
  if (u.protocol !== 'https:') throw new ApiError(502, 'bad_audio_url', 'Bible Brain returned an unusable audio link.');

  return json(200, {
    mock: false,
    translation: { id: ref.fileset, bibleId: ref.bible },
    bookId: ref.book,
    bookName: first.book_name || ref.book,
    chapter: ref.chapter,
    audioUrl: u.toString(),
    duration: typeof first.duration === 'number' ? first.duration : null,
    copyright,
    termsUrl: TERMS_URL,
  });
});
