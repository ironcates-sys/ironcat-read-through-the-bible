'use strict';
// Clearly labelled MOCK data used when BIBLE_BRAIN_KEY is not set.
// The "audio" is a generated test tone (no speech, no Bible text, no licensing issues).
const NOTICE = 'MOCK DATA: this is a generated test tone, not Bible audio. Set BIBLE_BRAIN_KEY to use real content.';

const TRANSLATIONS = [
  { id: 'MOCKAA', bibleId: 'MOCKAA', name: 'MOCK: Test tone A (not a Bible)', language: 'Mock', drama: false, partial: false, mock: true },
  { id: 'MOCKBB', bibleId: 'MOCKBB', name: 'MOCK: Test tone B (not a Bible)', language: 'Mock', drama: true, partial: false, mock: true },
];

function chapter({ fileset, book, chapter }) {
  return {
    mock: true,
    notice: NOTICE,
    translation: { id: fileset, bibleId: fileset },
    bookId: book,
    bookName: book,
    chapter,
    audioUrl: '/mock/tone.mp3',
    duration: 6,
    copyright: { text: 'MOCK DATA. No real Bible content. Generated test tone; no copyright.', organizations: [] },
  };
}

module.exports = { NOTICE, TRANSLATIONS, chapter };
