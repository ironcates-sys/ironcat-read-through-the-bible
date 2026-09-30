const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Q = require('../public/js/queue.js');
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data/plan.json'), 'utf8'));
const LEN = plan.cycleLength;

test('plan: 66 days, 6 items each, matches CSV', () => {
  assert.equal(plan.days.length, 66);
  plan.days.forEach((d) => assert.equal(d.items.length, 6));
  const csv = fs.readFileSync(path.join(__dirname, '../data/prophets-daily-reading-plan.csv'), 'utf8').trim().split('\n').slice(1);
  csv.forEach((line, i) => {
    const cells = line.split(',').slice(1);
    assert.deepEqual(plan.days[i].items.map((x) => x.book + ' ' + x.chapter), cells);
  });
  assert.deepEqual(plan.days[0].items[0], { book: 'Isaiah', bookId: 'ISA', chapter: 1 });
});

test('clip names + announcement text (single-chapter books say only the name)', () => {
  assert.equal(Q.clipName('ISA', 1, false), 'isa-1.mp3');
  assert.equal(Q.clipName('OBA', 1, true), 'oba.mp3');
  assert.equal(Q.announceText('Obadiah', 1, true), 'Obadiah');
  assert.equal(Q.announceText('Isaiah', 1, false), 'Isaiah, chapter 1');
  const dir = path.join(__dirname, '../public/announce');
  if (fs.existsSync(path.join(dir, 'isa-1.mp3'))) {
    Q.allClipNames(plan).forEach((n) => assert.ok(fs.existsSync(path.join(dir, n)), 'missing clip ' + n));
  }
});

test('queue advances in plan order and finishes the day after six chapters', () => {
  let s = Q.defaultState('2026-09-30', LEN);
  const order = [];
  for (let i = 0; i < 6; i++) {
    order.push(plan.days[s.day - 1].items[s.pos].book + ' ' + plan.days[s.day - 1].items[s.pos].chapter);
    const r = Q.chapterFinished(s, '2026-09-30', LEN);
    s = r.state;
    if (i < 5) assert.equal(r.dayFinished, false); else assert.equal(r.dayFinished, true);
  }
  assert.deepEqual(order, ['Isaiah 1', 'Jeremiah 1', 'Ezekiel 1', 'Daniel 1', 'Hosea 1', 'Haggai 1']);
  assert.equal(s.day, 2); assert.equal(s.pos, 0);
  assert.deepEqual(Q.doneList(s), [1]);
});

test('completing day 66 rolls into cycle 2, day 1', () => {
  let s = Q.defaultState('2026-09-30', LEN);
  for (let d = 1; d <= 66; d++) {
    const r = Q.finishDay(s, '2026-09-30', LEN);
    s = r.state;
    if (d === 66) assert.equal(r.cycleCompleted, true);
  }
  assert.equal(s.cycle, 2); assert.equal(s.day, 1); assert.deepEqual(Q.doneList(s), []);
  assert.equal(s.done['1'].length, 66);
});

test('skipped days stay open; after the last day we wrap to the earliest unread day', () => {
  let s = Q.defaultState('2026-09-01', LEN);
  s = Q.jumpToDay(s, 10, '2026-09-01', LEN);
  for (let d = 10; d <= 66; d++) s = Q.finishDay(s, '2026-09-01', LEN).state;
  assert.equal(s.day, 1); assert.equal(s.cycle, 1);   // days 1-9 still unread
  assert.equal(Q.isDone(s, 10), true); assert.equal(Q.isDone(s, 5), false);
});

test('missing days pauses rather than resets; no negative behind; catch up / skip to today', () => {
  let s = Q.defaultState('2026-09-01', LEN);
  s = Q.finishDay(s, '2026-09-01', LEN).state;            // read day 1 on Sept 1, now on day 2
  const t = '2026-09-11';                                  // ten quiet days later
  assert.equal(Q.calendarDay(s, t, LEN), 11);
  assert.equal(Q.behindBy(s, t, LEN), 9);
  const info = Q.streakInfo(s, t, LEN);
  assert.equal(info.daysReadThisCycle, 1);                 // nothing was lost
  assert.ok(!/miss|lost|broke|behind|reset/i.test(info.message), info.message);
  const s2 = Q.skipToToday(s, t, LEN);
  assert.equal(s2.day, 11); assert.equal(Q.behindBy(s2, t, LEN), 0);
  assert.deepEqual(Q.doneList(s2), [1]);
  assert.equal(Q.behindBy(s, '2026-09-01', LEN), 0);
});

test('jump to any day re-anchors the calendar pace', () => {
  let s = Q.defaultState('2026-09-01', LEN);
  s = Q.jumpToDay(s, 40, '2026-09-20', LEN);
  assert.equal(s.day, 40); assert.equal(Q.calendarDay(s, '2026-09-21', LEN), 41);
  assert.equal(Q.calendarDay(s, '2026-09-20', LEN) , 40);
});

test('calendar wraps after 66 days', () => {
  const s = Q.defaultState('2026-01-01', LEN);
  assert.equal(Q.calendarDay(s, '2026-03-08', LEN), 1);   // 66 days later
});

test('mark / unmark done, normalize bad saved data', () => {
  let s = Q.defaultState('2026-09-30', LEN);
  s = Q.markDone(s, 5, '2026-09-30'); assert.equal(Q.isDone(s, 5), true);
  s = Q.unmarkDone(s, 5); assert.equal(Q.isDone(s, 5), false);
  const n = Q.normalize({ day: 999, pos: -3, cycle: 0, done: 'x' }, '2026-09-30', LEN);
  assert.equal(n.day, 66); assert.equal(n.pos, 0); assert.equal(n.cycle, 1); assert.deepEqual(n.done, {});
});

test('streak info: days this cycle, last 7 days, friendly copy', () => {
  let s = Q.defaultState('2026-09-25', LEN);
  s = Q.finishDay(s, '2026-09-25', LEN).state;
  s = Q.finishDay(s, '2026-09-29', LEN).state;
  const i = Q.streakInfo(s, '2026-09-30', LEN);
  assert.equal(i.daysReadThisCycle, 2); assert.equal(i.readInLast7, 2); assert.equal(i.daysSinceLast, 1);
});
