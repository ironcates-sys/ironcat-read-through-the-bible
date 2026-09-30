// Browser test for the custom-plan upload flow (mock mode). Needs: npm i --no-save puppeteer-core; Chrome;
// dev server running:  ACCESS_PASSCODE=e2e-pass node scripts/dev-server.js 8899
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = require('assert');
const tmp = (name, text) => { const f = path.join(os.tmpdir(), name); fs.writeFileSync(f, text); return f; };
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage(); await p.setViewport({ width: 390, height: 844 });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const apiCalls = []; p.on('request', (r) => { if (r.method() !== 'GET' || r.url().includes('plan')) apiCalls.push(r.method() + ' ' + r.url()); });
  await p.goto('http://localhost:8899/', { waitUntil: 'networkidle0' });
  await p.evaluate(() => localStorage.clear()); await p.reload({ waitUntil: 'networkidle0' });
  await p.type('#passcode', 'e2e-pass'); await p.click('#gate-form button'); await p.waitForSelector('#app:not([hidden])'); await sleep(500);
  const list = () => p.$$eval('#chapter-list li', (l) => l.map((x) => x.textContent));
  const openSettings = async () => { await p.click('#btn-settings'); await sleep(100); };
  const upload = async (file) => { await openSettings(); const input = await p.$('#plan-input'); await input.uploadFile(file); await p.waitForFunction(() => document.getElementById('dlg-plan').open); };

  await openSettings(); console.log('plan info:', await p.$eval('#plan-info', (e) => e.textContent)); await p.evaluate(() => document.getElementById('dlg-settings').close());

  // 1. invalid file: errors shown, nothing changes
  await upload(tmp('bad.csv', 'Day,R\n1,Isaih 1\n2,John 99\n'));
  const errs = await p.$$eval('#plan-errors li', (l) => l.map((x) => x.textContent));
  console.log('errors shown:', errs);
  assert.equal(errs.length, 2); assert.ok(await p.$eval('#btn-plan-accept', (e) => e.hidden));
  await p.click('#btn-plan-cancel');
  assert.equal((await list()).length, 6);

  // 2. valid file: preview, choose "keep day" after moving to day 5
  await p.click('#btn-jump'); await p.$$eval('#jump-grid button', (b) => b[4].click());
  await upload(tmp('good.csv', 'Day,Morning,Evening\n1,John 1-2,Psalm 1\n2,John 3,Psalm 2\n3,Mark 1,Psalm 3\n'));
  console.log('preview:', await p.$eval('#plan-preview', (e) => e.textContent.replace(/\s+/g, ' ')));
  console.log('choice:', await p.$eval('#plan-choice-text', (e) => e.textContent), '|', await p.$eval('#plan-keep-label', (e) => e.textContent));
  await p.click('input[name="plan-mode"][value="keep"]'); await p.click('#btn-plan-accept'); await sleep(300);
  console.log('after keep:', await p.$eval('#cycle-line', (e) => e.textContent), await list());
  assert.match(await p.$eval('#cycle-line', (e) => e.textContent), /Day 3 of 3/);
  assert.equal((await list()).length, 2);
  assert.ok(await p.evaluate(() => !!localStorage.getItem('ironcat.plan.v1')));

  // 3. plays the custom plan's queue (2 chapters, then day complete)
  await p.click('#btn-settings'); await p.evaluate(() => { document.getElementById('dlg-settings').close(); });
  await p.click('#btn-play'); await sleep(800);
  console.log('playing:', await p.$eval('#now-title', (e) => e.textContent));
  await p.waitForFunction(() => __app.state.cycle === 2 || __app.state.day !== 3, { timeout: 60000 });
  console.log('after day 3 done:', await p.$eval('#cycle-line', (e) => e.textContent));

  // 4. survives reload
  await p.reload({ waitUntil: 'networkidle0' }); await sleep(400);
  console.log('reload:', await p.$eval('#cycle-line', (e) => e.textContent), '|', await p.$eval('#plan-name', (e) => e.textContent));
  assert.equal(await p.$eval('#plan-name', (e) => e.textContent), 'Custom plan');

  // 5. download template round-trip (evaluate the generated CSV)
  const csv = await p.evaluate(() => Plan.planToCsv(JSON.parse(localStorage.getItem('ironcat.plan.v1'))));
  console.log('download csv:\n' + csv);

  // 6. tampered stored plan falls back to default
  await p.evaluate(() => localStorage.setItem('ironcat.plan.v1', JSON.stringify({ days: [{ day: 1, items: [{ book: 'John', chapter: 999 }] }] })));
  await p.reload({ waitUntil: 'networkidle0' }); await sleep(400);
  console.log('tampered ->', await p.$eval('#cycle-line', (e) => e.textContent), '| stored plan removed:', await p.evaluate(() => localStorage.getItem('ironcat.plan.v1') === null));

  // 7. reset to default, restart
  await upload(tmp('good2.csv', 'Day,R\n1,John 1\n2,John 2\n')); await p.click('#btn-plan-accept'); await sleep(300);
  await openSettings(); await p.click('#btn-plan-reset'); await p.waitForFunction(() => document.getElementById('dlg-plan').open);
  console.log('reset title:', await p.$eval('#plan-title', (e) => e.textContent));
  await p.click('#btn-plan-accept'); await sleep(300);
  console.log('after reset:', await p.$eval('#cycle-line', (e) => e.textContent), await list(), 'stored:', await p.evaluate(() => localStorage.getItem('ironcat.plan.v1')));
  assert.match(await p.$eval('#cycle-line', (e) => e.textContent), /Day 1 of 66/);

  // 8. caches hold nothing it shouldn't; uploaded plan was never sent anywhere
  const cached = await p.evaluate(async () => { const o = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) o.push(new URL(r.url).pathname); return o; });
  console.log('cache entries:', cached.length, 'bad:', cached.filter((u) => /^\/(api|mock|\.netlify)/.test(u) || /custom|good|upload/.test(u)));
  assert.equal(cached.filter((u) => /^\/(api|mock|\.netlify)/.test(u)).length, 0);
  console.log('non-GET requests made:', apiCalls.filter((x) => !x.startsWith('GET')));
  console.log('errors:', errors); assert.equal(errors.length, 0);
  await b.close(); console.log('PLAN E2E OK');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
