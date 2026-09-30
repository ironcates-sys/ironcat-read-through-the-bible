const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Plan = require('../public/js/plan.js');
const Q = require('../public/js/queue.js');

const refs = (plan, day) => plan.days[day - 1].items.map((i) => i.book + ' ' + i.chapter);

test('existing prophets CSV parses identically to the bundled plan.json', () => {
  const csv = fs.readFileSync(path.join(__dirname, '../data/prophets-daily-reading-plan.csv'), 'utf8');
  const r = Plan.parsePlan(csv);
  assert.equal(r.ok, true, r.errors.join('\n'));
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data/plan.json'), 'utf8'));
  assert.deepEqual(r.plan.days, bundled.days);
  assert.equal(r.plan.cycleLength, 66);
  assert.equal(r.plan.itemsPerDay, 6);
});

test('Day column + any number of chapter columns; ranges expand; cycle length follows the file', () => {
  const r = Plan.parsePlan('Day,A,B\n1,Isaiah 1,Jeremiah 1-2\n2,Psalm 23,"John 3-4; Jude"\n3,Obadiah,\n');
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.plan.cycleLength, 3);
  assert.deepEqual(refs(r.plan, 1), ['Isaiah 1', 'Jeremiah 1', 'Jeremiah 2']);
  assert.deepEqual(refs(r.plan, 2), ['Psalms 23', 'John 3', 'John 4', 'Jude 1']);
  assert.deepEqual(refs(r.plan, 3), ['Obadiah 1']);
  assert.equal(r.plan.itemsPerDay, null);
  assert.equal(r.plan.days[1].items[0].bookId, 'PSA');
  assert.equal(r.plan.books.Psalms.chapters, 150);
});

test('forgiving input: BOM, CRLF, tabs, en-dash, case, numbered books, "Day 3", unsorted rows', () => {
  const r = Plan.parsePlan('\uFEFFday\tx\r\nDay 2\t1 john 1\u20135\r\n1\tSong of Songs 2\r\n');
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.deepEqual(refs(r.plan, 1), ['Song of Solomon 2']);
  assert.deepEqual(refs(r.plan, 2), ['1 John 1', '1 John 2', '1 John 3', '1 John 4', '1 John 5']);
  assert.equal(Plan.findBook('I Corinthians').id, '1CO');
  assert.equal(Plan.findBook('2nd Timothy').id, '2TI');
  assert.equal(Plan.findBook('Psalm').name, 'Psalms');
});

test('unknown book: clear error with row/column and a suggestion', () => {
  const r = Plan.parsePlan('Day,Reading\n1,Isaih 1\n2,Hezekiah 3\n');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /Row 2 \(Day 1\), column "Reading".*unknown book "Isaih".*did you mean Isaiah/);
  assert.match(r.errors[1], /unknown book "Hezekiah"/);
  assert.equal(r.plan, null);
});

test('bad chapter numbers: zero, too high, backwards range, verses, missing chapter', () => {
  const r = Plan.parsePlan('Day,R\n1,Isaiah 67\n2,Jude 2\n3,John 0\n4,John 5-3\n5,John 3:16\n6,John\n7,John 21\n8,Psalms 150\n');
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 6);
  assert.match(r.errors[0], /Isaiah has only 66 chapters/);
  assert.match(r.errors[1], /Jude has only 1 chapter\./);
  assert.match(r.errors[2], /start at 1/);
  assert.match(r.errors[3], /backwards/);
  assert.match(r.errors[4], /verses are not supported/);
  assert.match(r.errors[5], /John needs a chapter number/);
});

test('structure errors: no Day column, no chapter columns, duplicates, gaps, empty days, bad day values', () => {
  assert.match(Plan.parsePlan('Num,R\n1,John 1\n').errors[0], /"Day"/);
  assert.match(Plan.parsePlan('Day\n1\n').errors[0], /at least one chapter column/);
  assert.match(Plan.parsePlan('Day,R\n1,John 1\n1,John 2\n').errors[0], /Day 1 appears more than once/);
  assert.match(Plan.parsePlan('Day,R\n1,John 1\n3,John 2\n').errors[0], /no gaps: expected Day 2 but found Day 3/);
  assert.match(Plan.parsePlan('Day,R\n1,John 1\n2,\n').errors.join(' '), /Day 2 has no readings/);
  assert.match(Plan.parsePlan('Day,R\nx,John 1\n').errors[0], /Day must be a whole number/);
  assert.match(Plan.parsePlan('').errors[0], /empty/);
  assert.match(Plan.parsePlan('Day,R\n1,"John 1\n').errors[0], /quoted cell/);
  assert.match(Plan.parsePlan('Day,R\n').errors[0], /at least one day/);
  assert.match(Plan.parsePlan('x'.repeat(400000)).errors[0], /too large/);
});

test('limits: too many chapters in one day', () => {
  const r = Plan.parsePlan('Day,R\n1,Psalms 1-40\n');
  assert.equal(r.ok, false); assert.match(r.errors[0], /40 chapters.*limit/);
});

test('planToCsv round-trips (default plan and a ranged plan) and quotes safely', () => {
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data/plan.json'), 'utf8'));
  const csv = Plan.planToCsv(bundled);
  assert.match(csv.split('\n')[0], /^Day,Isaiah,Jeremiah_Lamentations/);
  const back = Plan.parsePlan(csv);
  assert.equal(back.ok, true); assert.deepEqual(back.plan.days, bundled.days);
  const uneven = Plan.parsePlan('Day,A,B\n1,John 1-3,Mark 1\n2,Luke 1,\n').plan;
  const back2 = Plan.parsePlan(Plan.planToCsv(uneven));
  assert.equal(back2.ok, true); assert.deepEqual(back2.plan.days, uneven.days);
});

test('fromStored re-validates saved data and rejects tampering', () => {
  const good = Plan.parsePlan('Day,R\n1,John 1\n2,John 2\n').plan;
  const restored = Plan.fromStored(JSON.parse(JSON.stringify(good)));
  assert.equal(restored.cycleLength, 2);
  assert.equal(Plan.fromStored({ days: [{ day: 1, items: [{ book: 'John', chapter: 99 }] }] }), null);
  assert.equal(Plan.fromStored({ days: [{ day: 1, items: [{ book: 'Nope', chapter: 1 }] }] }), null);
  assert.equal(Plan.fromStored({ days: [{ day: 2, items: [{ book: 'John', chapter: 1 }] }] }), null);
  assert.equal(Plan.fromStored(null), null);
  assert.equal(Plan.fromStored('x'), null);
});

test('label() compacts consecutive chapters for previews', () => {
  const p = Plan.parsePlan('Day,R\n1,"John 1-3; Mark 4; Mark 5"\n').plan;
  assert.equal(Plan.label(p.days[0].items), 'John 1-3, Mark 4-5');
});

test('queue with a variable-length plan: 2 chapters on day 1, 3 on day 2; cycle length follows plan', () => {
  const plan = Plan.parsePlan('Day,A\n1,John 1-2\n2,Mark 1-3\n').plan;
  const LEN = plan.cycleLength;
  let s = Q.defaultState('2026-09-30', LEN);
  let r = Q.chapterFinished(s, '2026-09-30', LEN, plan.days[0].items.length);
  assert.equal(r.dayFinished, false); s = r.state; assert.equal(s.pos, 1);
  r = Q.chapterFinished(s, '2026-09-30', LEN, 2);
  assert.equal(r.dayFinished, true); assert.equal(r.state.day, 2);
  s = r.state;
  for (let i = 0; i < 2; i++) { r = Q.chapterFinished(s, '2026-09-30', LEN, 3); assert.equal(r.dayFinished, false); s = r.state; }
  r = Q.chapterFinished(s, '2026-09-30', LEN, 3);
  assert.equal(r.dayFinished, true); assert.equal(r.cycleCompleted, true); assert.equal(r.state.cycle, 2);
  assert.equal(Q.setPosition(s, 99, 3).pos, 2);
});

test('applyPlanChange: restart vs keep (clamped), history kept', () => {
  let s = Q.defaultState('2026-09-01', 66);
  s = Q.jumpToDay(s, 40, '2026-09-01', 66);
  s = Q.markDone(s, 1, '2026-09-01'); s = Q.markDone(s, 39, '2026-09-02');
  s = Q.saveVerse(s, { book: 'John', chapter: 3 });
  s.pos = 4; s.t = 99;
  const keep = Q.applyPlanChange(s, 30, 'keep', '2026-09-30');
  assert.equal(keep.day, 30); assert.equal(keep.pos, 0); assert.equal(keep.t, 0);
  assert.deepEqual(Q.doneList(keep), [1]);
  assert.equal(keep.saved.length, 1); assert.deepEqual(keep.readDates, s.readDates);
  assert.equal(Q.calendarDay(keep, '2026-09-30', 30), 30);
  const keep2 = Q.applyPlanChange(s, 100, 'keep', '2026-09-30');
  assert.equal(keep2.day, 40); assert.deepEqual(Q.doneList(keep2), [1, 39]);
  const restart = Q.applyPlanChange(s, 100, 'restart', '2026-09-30');
  assert.equal(restart.day, 1); assert.deepEqual(Q.doneList(restart), []);
  assert.equal(restart.cycle, s.cycle); assert.equal(restart.saved.length, 1);
  assert.equal(Q.calendarDay(restart, '2026-10-02', 100), 3);
});

test('service worker only touches shell/plan/announce and never api, mock or other origins', () => {
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  assert.match(sw, /origin !== self\.location\.origin\) return/);
  assert.match(sw, /'\/api\/'\) === 0/);
  assert.match(sw, /'\/js\/plan\.js'/);
  assert.ok(!/localStorage|plan\.v1|blob:/.test(sw));
  // every shell file listed really exists
  const shell = /var SHELL = \[([\s\S]*?)\];/.exec(sw)[1].match(/'([^']+)'/g).map((x) => x.slice(1, -1));
  shell.forEach((u) => { if (u !== '/') assert.ok(fs.existsSync(path.join(__dirname, '../public', u)), u); });
  // the custom plan lives in localStorage only (not the Cache API)
  const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(app, /store\(LS_PLAN/);
  assert.ok(!/caches\.|cache\.put/.test(app));
});
