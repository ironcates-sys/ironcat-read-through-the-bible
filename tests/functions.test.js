const test = require('node:test');
const assert = require('node:assert');

// Functions are exercised in MOCK mode (no BIBLE_BRAIN_KEY).
delete process.env.BIBLE_BRAIN_KEY;
process.env.ACCESS_PASSCODE = 'test-passcode-123';

const common = require('../netlify/functions/lib/common');
const fn = {
  auth: require('../netlify/functions/auth').handler,
  translations: require('../netlify/functions/translations').handler,
  chapter: require('../netlify/functions/chapter').handler,
  timestamps: require('../netlify/functions/timestamps').handler,
};
const get = (qs, headers) => ({ httpMethod: 'GET', headers: headers || {}, queryStringParameters: qs || {} });

test('every protected function rejects missing / bad tokens', async () => {
  for (const name of ['translations', 'chapter', 'timestamps']) {
    let r = await fn[name](get({ fileset: 'MOCKAA', book: 'ISA', chapter: '1' }));
    assert.equal(r.statusCode, 401, name + ' without token');
    r = await fn[name](get({ fileset: 'MOCKAA', book: 'ISA', chapter: '1' }, { authorization: 'Bearer nonsense' }));
    assert.equal(r.statusCode, 401, name + ' with bad token');
    r = await fn[name](get({}, { authorization: 'Bearer v1.9999999999999.' + 'A'.repeat(43) }));
    assert.equal(r.statusCode, 401, name + ' with forged token');
  }
});

test('wrong passcode rejected, right passcode yields a working token', async () => {
  let r = await fn.auth({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ passcode: 'nope' }) });
  assert.equal(r.statusCode, 401);
  r = await fn.auth({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ passcode: 'test-passcode-123' }) });
  assert.equal(r.statusCode, 200);
  const { token } = JSON.parse(r.body);
  const t = await fn.translations(get({}, { authorization: 'Bearer ' + token }));
  assert.equal(t.statusCode, 200);
  const body = JSON.parse(t.body);
  assert.equal(body.mock, true);
  assert.match(body.notice, /MOCK/);
  const c = await fn.chapter(get({ fileset: 'MOCKAA', book: 'ISA', chapter: '3' }, { 'X-Access-Token': token }));
  assert.equal(c.statusCode, 200);
  const cb = JSON.parse(c.body);
  assert.equal(cb.mock, true); assert.equal(cb.chapter, 3); assert.match(cb.notice, /MOCK/);
});

test('token expires and dies when passcode changes', () => {
  const { token } = common.issueToken(Date.now());
  assert.equal(common.tokenValid(token), true);
  assert.equal(common.tokenValid(token, Date.now() + 31 * 86400000), false);
  process.env.ACCESS_PASSCODE = 'different';
  assert.equal(common.tokenValid(token), false);
  process.env.ACCESS_PASSCODE = 'test-passcode-123';
});

test('fails closed when ACCESS_PASSCODE is unset', async () => {
  const keep = process.env.ACCESS_PASSCODE;
  delete process.env.ACCESS_PASSCODE;
  const r = await fn.translations(get({}, { authorization: 'Bearer x' }));
  assert.equal(r.statusCode, 503);
  const a = await fn.auth({ httpMethod: 'POST', headers: {}, body: '{"passcode":""}' });
  assert.equal(a.statusCode, 503);
  process.env.ACCESS_PASSCODE = keep;
});

test('responses are no-store and input is validated', async () => {
  const { token } = common.issueToken();
  const h = { authorization: 'Bearer ' + token };
  const ok = await fn.translations(get({}, h));
  assert.match(ok.headers['Cache-Control'], /no-store/);
  const denied = await fn.chapter(get({}));
  assert.match(denied.headers['Cache-Control'], /no-store/);
  const bad = await fn.chapter(get({ fileset: '../etc', book: 'ISA', chapter: '1' }, h));
  assert.equal(bad.statusCode, 400);
  assert.match(bad.headers['Cache-Control'], /no-store/);
  const bad2 = await fn.chapter(get({ fileset: 'MOCKAA', book: 'ISA', chapter: '0' }, h));
  assert.equal(bad2.statusCode, 400);
});

test('live mode: only signed url/copyright/meta returned, key never echoed (stubbed upstream)', async () => {
  const SECRET = 'SECRETKEY_abc123XYZ';
  process.env.BIBLE_BRAIN_KEY = SECRET;
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    const u = String(url); seen.push(u);
    if (u.includes('/copyright')) return new Response(JSON.stringify([{ id: 'ENGESVO2DA', type: 'audio_drama', copyright: { copyright: '© Test Publisher', organizations: [{ abbreviation: 'TST', url_site: 'https://example.org' }] } }]), { status: 200 });
    if (u.includes('/bibles/filesets/')) return new Response(JSON.stringify({ data: [{ book_id: 'ISA', book_name: 'Isaiah', chapter_start: 1, path: 'https://cdn.example.org/a.mp3?Signature=abc&key=' + SECRET, duration: 400, secret_internal: 'x' }] }), { status: 200 });
    if (u.includes('/bibles?')) return new Response(JSON.stringify({ data: [{ abbr: 'ENGESV', name: 'English Standard Version', vname: 'ESV', language: 'English', filesets: { 'dbp-prod': [
      { id: 'ENGESVO2DA', set_type_code: 'audio_drama', set_size_code: 'OT' },
      { id: 'ENGESVN2DA', set_type_code: 'audio_drama', set_size_code: 'NT' },
      { id: 'ENGESVO1DA-opus16', set_type_code: 'audio_drama', set_size_code: 'OT' },
      { id: 'ENGESVO2ET', set_type_code: 'text_plain', set_size_code: 'OT' }] } }], meta: { pagination: { total_pages: 1 } } }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    const { token } = common.issueToken();
    const h = { authorization: 'Bearer ' + token };
    const t = await fn.translations(get({}, h));
    const tb = JSON.parse(t.body);
    assert.equal(tb.mock, false);
    assert.deepEqual(tb.translations.map((x) => x.id), ['ENGESVO2DA']);
    const c = await fn.chapter(get({ fileset: 'ENGESVO2DA', book: 'ISA', chapter: '1', bible: 'ENGESV' }, h));
    assert.equal(c.statusCode, 200);
    const cb = JSON.parse(c.body);
    assert.equal(cb.copyright.text, '© Test Publisher');
    assert.equal(cb.audioUrl.startsWith('https://cdn.example.org/'), true);
    assert.equal(cb.secret_internal, undefined);
    assert.ok(seen.some((u) => u.includes('key=' + SECRET)), 'upstream call carries the key');
    for (const r of [t, c]) {
      assert.ok(!JSON.stringify(r.headers).includes(SECRET));
    }
    assert.ok(!t.body.includes(SECRET));
  } finally {
    global.fetch = realFetch;
    delete process.env.BIBLE_BRAIN_KEY;
  }
});

test('upstream failure never leaks the key', async () => {
  process.env.BIBLE_BRAIN_KEY = 'LEAKME_999';
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('boom https://4.dbt.io/api/x?key=LEAKME_999'); };
  try {
    const { token } = common.issueToken();
    const r = await fn.translations(get({}, { authorization: 'Bearer ' + token }));
    assert.equal(r.statusCode, 502);
    assert.ok(!r.body.includes('LEAKME_999'));
  } finally { global.fetch = realFetch; delete process.env.BIBLE_BRAIN_KEY; }
});
