'use strict';
// Best-effort copyright lookup shared by chapter.js (audio) and text.js (text).
// Server-side, in-memory only (copyright text, not audio/Scripture). Short TTL, per warm instance.
const { bbFetch } = require('./common');

const memo = new Map();
const MEMO_MS = 6 * 3600 * 1000;

// prefer: regex used to pick a fallback entry when the exact fileset id is not listed.
async function getCopyright(bible, fileset, prefer = /^audio/) {
  const hit = memo.get(fileset);
  if (hit && hit.at > Date.now() - MEMO_MS) return hit.value;
  let value = { text: '', organizations: [] };
  try {
    const res = await bbFetch('/bibles/' + encodeURIComponent(bible) + '/copyright');
    const list = Array.isArray(res) ? res : Array.isArray(res.data) ? res.data : [];
    const entry = list.find((e) => e.id === fileset) || list.find((e) => prefer.test(e.type || '')) || list[0];
    const c = entry && entry.copyright;
    if (c) {
      value = {
        text: typeof c.copyright === 'string' ? c.copyright : '',
        organizations: (c.organizations || [])
          .map((o) => ({ name: o.abbreviation || o.slug || '', url: o.url_site || '' }))
          .filter((o) => o.name),
      };
    }
  } catch (e) {
    return value; // copyright lookup is best-effort; UI falls back to the DBP terms link
  }
  memo.set(fileset, { at: Date.now(), value });
  return value;
}

module.exports = { getCopyright };
