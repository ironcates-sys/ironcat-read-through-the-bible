#!/usr/bin/env node
// Converts data/prophets-daily-reading-plan.csv -> public/data/plan.json
// (translation-independent: book + chapter items, six per day, in plan order).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const csv = fs.readFileSync(path.join(root, 'data', 'prophets-daily-reading-plan.csv'), 'utf8').trim().split(/\r?\n/);

// Bible Brain (DBP) book ids + English-versification chapter counts
const BOOKS = {
  Isaiah: ['ISA', 66], Jeremiah: ['JER', 52], Lamentations: ['LAM', 5], Ezekiel: ['EZK', 48],
  Daniel: ['DAN', 12], Hosea: ['HOS', 14], Joel: ['JOL', 3], Amos: ['AMO', 9], Obadiah: ['OBA', 1],
  Jonah: ['JON', 4], Micah: ['MIC', 7], Nahum: ['NAM', 3], Habakkuk: ['HAB', 3], Zephaniah: ['ZEP', 3],
  Haggai: ['HAG', 2], Zechariah: ['ZEC', 14], Malachi: ['MAL', 4],
};

const header = csv[0].split(',');
const days = [];
const used = {};
for (const line of csv.slice(1)) {
  const cells = line.split(',').map((s) => s.trim());
  const day = Number(cells[0]);
  const items = cells.slice(1).map((ref) => {
    const m = /^(.+?)\s+(\d+)$/.exec(ref);
    if (!m || !BOOKS[m[1]]) throw new Error(`Bad reference "${ref}" on day ${day}`);
    const chapter = Number(m[2]);
    if (chapter < 1 || chapter > BOOKS[m[1]][1]) throw new Error(`${ref} out of range on day ${day}`);
    used[m[1]] = BOOKS[m[1]];
    return { book: m[1], bookId: BOOKS[m[1]][0], chapter };
  });
  if (items.length !== 6) throw new Error(`Day ${day} does not have 6 items`);
  days.push({ day, items });
}
days.forEach((d, i) => { if (d.day !== i + 1) throw new Error('Days must be sequential from 1'); });

const books = {};
for (const [name, [id, chapters]] of Object.entries(used)) books[name] = { id, chapters };

const plan = {
  title: "Prophets daily reading plan",
  cycleLength: days.length,
  itemsPerDay: 6,
  columns: header.slice(1),
  books,
  days,
};
fs.writeFileSync(path.join(root, 'public', 'data', 'plan.json'), JSON.stringify(plan) + '\n');
console.log(`plan.json: ${days.length} days, ${days.length * 6} items, ${Object.keys(books).length} books`);
