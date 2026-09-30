#!/usr/bin/env node
// Converts data/prophets-daily-reading-plan.csv -> public/data/plan.json (the bundled default plan).
// Uses the same parser/validator as the in-app "Upload plan CSV" feature (public/js/plan.js).
const fs = require('fs');
const path = require('path');
const Plan = require('../public/js/plan.js');

const root = path.join(__dirname, '..');
const text = fs.readFileSync(path.join(root, 'data', 'prophets-daily-reading-plan.csv'), 'utf8');
const res = Plan.parsePlan(text, { title: 'Prophets daily reading plan' });
if (!res.ok) { console.error(res.errors.join('\n')); process.exit(1); }
fs.writeFileSync(path.join(root, 'public', 'data', 'plan.json'), JSON.stringify(res.plan) + '\n');
const s = Plan.summarize(res.plan);
console.log(`plan.json: ${s.days} days, ${s.chapters} items, ${s.books.length} books`);
