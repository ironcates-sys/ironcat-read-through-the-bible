'use strict';
// Shared helpers for every Netlify function in this project.
// - No third-party dependencies.
// - The Bible Brain key is read from process.env.BIBLE_BRAIN_KEY and is used
//   server-side only. It is never placed in a response body, header or log line.
const crypto = require('crypto');

const BB_BASE = 'https://4.dbt.io/api';
const TERMS_URL = 'https://www.faithcomesbyhearing.com/bible-brain/terms-conditions';
const TOKEN_DAYS = 30;

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  // Never let a browser, CDN or service worker keep these responses.
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
};

function json(statusCode, body, extraHeaders) {
  return { statusCode, headers: { ...BASE_HEADERS, ...(extraHeaders || {}) }, body: JSON.stringify(body) };
}

function isMock() {
  return !process.env.BIBLE_BRAIN_KEY || process.env.BIBLE_BRAIN_MOCK === '1';
}

// ---------- passcode + token ----------
function secretKey() {
  const pass = process.env.ACCESS_PASSCODE;
  if (!pass) return null;
  // Changing ACCESS_PASSCODE invalidates every previously issued token.
  return crypto.createHash('sha256').update('ironcat-token-v1|' + pass).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload, key) {
  return b64url(crypto.createHmac('sha256', key).update(payload).digest());
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function passcodeMatches(candidate) {
  const pass = process.env.ACCESS_PASSCODE;
  if (!pass || typeof candidate !== 'string') return false;
  return safeEqual(candidate.trim(), pass.trim());
}

function issueToken(now = Date.now()) {
  const key = secretKey();
  const exp = now + TOKEN_DAYS * 86400000;
  const payload = 'v1.' + exp;
  return { token: payload + '.' + sign(payload, key), expiresAt: exp };
}

function tokenValid(token, now = Date.now()) {
  const key = secretKey();
  if (!key || typeof token !== 'string') return false;
  const m = /^(v1\.(\d{10,15}))\.([A-Za-z0-9_-]{20,64})$/.exec(token);
  if (!m) return false;
  if (Number(m[2]) < now) return false;
  return safeEqual(sign(m[1], key), m[3]);
}

function header(event, name) {
  const h = (event && event.headers) || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
  return undefined;
}

// Returns null when the request is authorised, otherwise a ready-made response.
function checkAuth(event) {
  if (!process.env.ACCESS_PASSCODE) {
    return json(503, { error: 'not_configured', message: 'ACCESS_PASSCODE is not set on the server, so the app is locked.' });
  }
  const auth = header(event, 'authorization') || '';
  const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1] || header(event, 'x-access-token') || '';
  if (!tokenValid(token)) return json(401, { error: 'unauthorized', message: 'Please enter the passcode.' });
  return null;
}

// Wrap a function so it ALWAYS verifies the token itself (defence in depth:
// nothing relies on a proxy, redirect or front-end gate).
function withAuth(methods, fn) {
  return async (event, context) => {
    try {
      if (!methods.includes(event.httpMethod)) {
        return json(405, { error: 'method_not_allowed' }, { Allow: methods.join(', ') });
      }
      const denied = checkAuth(event);
      if (denied) return denied;
      return await fn(event, context);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

// ---------- Bible Brain ----------
class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function scrub(text) {
  const key = process.env.BIBLE_BRAIN_KEY;
  let s = String(text == null ? '' : text);
  if (key) s = s.split(key).join('[redacted]');
  return s.replace(/([?&]key=)[^&\s"']+/gi, '$1[redacted]');
}

function errorResponse(err) {
  const status = err instanceof ApiError ? err.status : 500;
  const code = err instanceof ApiError ? err.code : 'server_error';
  console.error('function error:', status, code, scrub(err && err.message)); // key-safe
  const message = err instanceof ApiError ? scrub(err.message) : 'Something went wrong on the server.';
  return json(status, { error: code, message });
}

async function bbFetch(path, params = {}) {
  const key = process.env.BIBLE_BRAIN_KEY;
  if (!key) throw new ApiError(503, 'no_key', 'BIBLE_BRAIN_KEY is not set.');
  const url = new URL(BB_BASE + path);
  url.searchParams.set('v', '4');
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  url.searchParams.set('key', key);
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
  } catch (e) {
    throw new ApiError(502, 'upstream_unreachable', 'Could not reach Bible Brain.');
  }
  if (res.status === 404) throw new ApiError(404, 'not_found', 'Not found at Bible Brain.');
  if (res.status === 401 || res.status === 403) throw new ApiError(502, 'upstream_denied', 'Bible Brain rejected the server key.');
  if (!res.ok) throw new ApiError(502, 'upstream_error', 'Bible Brain returned HTTP ' + res.status + '.');
  try {
    return await res.json();
  } catch (e) {
    throw new ApiError(502, 'upstream_bad_json', 'Bible Brain sent an unreadable response.');
  }
}

// ---------- input validation ----------
const RE_FILESET = /^[A-Z0-9]{6,16}$/;
const RE_BIBLE = /^[A-Z0-9]{3,12}$/;
const RE_BOOK = /^[A-Z0-9]{3}$/;

function validateRef(qs) {
  const fileset = String(qs.fileset || '').toUpperCase();
  const book = String(qs.book || '').toUpperCase();
  const chapter = Number(qs.chapter);
  if (!RE_FILESET.test(fileset)) throw new ApiError(400, 'bad_fileset', 'Invalid fileset id.');
  if (!RE_BOOK.test(book)) throw new ApiError(400, 'bad_book', 'Invalid book id.');
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 150) throw new ApiError(400, 'bad_chapter', 'Invalid chapter.');
  let bible = String(qs.bible || '').toUpperCase();
  if (!bible) bible = fileset.slice(0, 6);
  if (!RE_BIBLE.test(bible)) throw new ApiError(400, 'bad_bible', 'Invalid bible id.');
  return { fileset, book, chapter, bible };
}

module.exports = {
  BB_BASE, TERMS_URL, json, isMock, issueToken, tokenValid, passcodeMatches, checkAuth, withAuth,
  ApiError, bbFetch, scrub, errorResponse, validateRef, header,
};
