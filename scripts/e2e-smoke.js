// Optional browser smoke test (mock mode). Needs: npm i --no-save puppeteer-core; Chrome at /usr/bin/google-chrome;
// and the dev server running:  ACCESS_PASSCODE=e2e-pass node scripts/dev-server.js 8899
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage(); await p.setViewport({ width: 390, height: 844 });
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://localhost:8899/', { waitUntil: 'networkidle0' });
  await p.evaluate(() => { localStorage.clear(); });
  await p.reload({ waitUntil: 'networkidle0' });
  await p.type('#passcode', 'e2e-pass'); await p.click('#gate-form button'); await p.waitForSelector('#app:not([hidden])'); await sleep(600);
  // settings: announce off, pause 3s
  await p.click('#btn-settings'); await p.click('#set-announce'); await p.select('#set-pause', '3'); await p.evaluate(() => document.getElementById('dlg-settings').close());
  console.log('settings', await p.evaluate(() => JSON.stringify(__app.settings)));
  await p.select('#sel-sleep', 'chapter');
  await p.click('#btn-play'); await sleep(1200);
  console.log('pause icon shown while playing:', await p.evaluate(() => document.getElementById('ico-play').hasAttribute('hidden') && !document.getElementById('ico-pause').hasAttribute('hidden')), 'phase', await p.evaluate(() => __app.phase));
  await p.screenshot({ path: '/tmp/playing2.png' });
  await p.waitForFunction(() => __app.phase === 'idle', { timeout: 20000 });
  console.log('sleep stopped after chapter; state pos', await p.evaluate(() => __app.state.pos), await p.$eval('#toast', e => e.textContent));
  // now with pause: play next, expect pause phase after chapter
  await p.click('#btn-play');
  await p.waitForFunction(() => __app.phase === 'pause', { timeout: 20000 }); console.log('entered pause phase, src', await p.evaluate(() => document.getElementById('player').src.split('/').pop()));
  await p.waitForFunction(() => __app.phase === 'chapter' && __app.state.pos === 2, { timeout: 20000 }); console.log('resumed next chapter after pause, no announce');
  // whole day to completion
  await p.waitForFunction(() => __app.state.day === 2, { timeout: 60000 });
  console.log('day complete -> day', await p.evaluate(() => __app.state.day), JSON.stringify(await p.evaluate(() => __app.state.done)), await p.$eval('#streak-main', e => e.textContent), '|', await p.$eval('#streak-sub', e => e.textContent));
  console.log('errors', errors);
  await b.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
