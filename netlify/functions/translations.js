'use strict';
// GET /api/translations -> { mock, translations: [{id, bibleId, name, language, drama, partial}] }
// Built live from Bible Brain at every app launch (never cached).
const { json, isMock, withAuth, bbFetch, TERMS_URL } = require('./lib/common');
const mock = require('./lib/mock');

const AUDIO_TYPES = new Set(['audio', 'audio_drama']); // plain mp3 filesets (not HLS "_stream")

// Does this size code cover the Old Testament (where the prophets live)?
function coversOT(size) {
  if (!size) return false;
  return size === 'C' || size.includes('OT');
}

function pickFilesets(data) {
  const out = [];
  for (const bible of data) {
    const all = Object.values(bible.filesets || {}).flat();
    for (const fs of all) {
      if (!fs || !AUDIO_TYPES.has(fs.set_type_code)) continue;
      if (!coversOT(fs.set_size_code)) continue;
      if (!/^[A-Z0-9]{6,16}$/.test(fs.id || '')) continue; // skips encoded variants like ...-opus16
      out.push({
        id: fs.id,
        bibleId: bible.abbr || String(fs.id).slice(0, 6),
        name: bible.vname || bible.name || fs.id,
        language: bible.language || '',
        drama: fs.set_type_code === 'audio_drama',
        partial: fs.set_size_code !== 'C' && fs.set_size_code !== 'OT' && fs.set_size_code !== 'NTOT',
        size: fs.set_size_code,
      });
    }
  }
  return out;
}

exports.handler = withAuth(['GET'], async () => {
  if (isMock()) {
    return json(200, { mock: true, notice: mock.NOTICE, termsUrl: TERMS_URL, translations: mock.TRANSLATIONS });
  }
  const languages = (process.env.BIBLE_LANGUAGES || 'eng').split(',').map((s) => s.trim()).filter(Boolean);
  const found = new Map();
  for (const language_code of languages) {
    for (let page = 1; page <= 6; page++) {
      const res = await bbFetch('/bibles', { language_code, media: 'audio', limit: 100, page });
      const data = Array.isArray(res.data) ? res.data : [];
      for (const t of pickFilesets(data)) if (!found.has(t.id)) found.set(t.id, t);
      const totalPages = res.meta && res.meta.pagination && res.meta.pagination.total_pages;
      if (!totalPages || page >= totalPages) break;
    }
  }
  const translations = [...found.values()].sort(
    (a, b) => Number(a.partial) - Number(b.partial) || a.name.localeCompare(b.name) || Number(a.drama) - Number(b.drama)
  );
  return json(200, { mock: false, termsUrl: TERMS_URL, translations });
});

exports._pickFilesets = pickFilesets; // for tests
