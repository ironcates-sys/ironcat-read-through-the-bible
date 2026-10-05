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

// Placeholder "text" for the Follow along screen: clearly labelled, contains no Scripture.
const MOCK_VERSES = 5;
function text({ book, chapter }) {
  const verses = [];
  for (let v = 1; v <= MOCK_VERSES; v++) {
    verses.push({ verse: v, text: 'MOCK verse ' + v + ' of ' + book + ' ' + chapter + '. Placeholder text, not Scripture.' });
  }
  return {
    mock: true,
    notice: NOTICE,
    bookId: book,
    bookName: book,
    chapter,
    textFileset: 'MOCK',
    verses,
    copyright: { text: 'MOCK DATA. No real Bible content. Placeholder text; no copyright.', organizations: [] },
  };
}

// Fake verse timings spread across the 6-second mock tone so Follow along sync can be exercised.
function timestamps() {
  const verses = [{ verse: 0, t: 0 }];
  for (let v = 1; v <= MOCK_VERSES; v++) verses.push({ verse: v, t: (v - 1) * 1.1 + 0.3 });
  return { mock: true, verses };
}

module.exports = { NOTICE, TRANSLATIONS, chapter, text, timestamps };
