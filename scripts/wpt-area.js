#!/usr/bin/env node
/**
 * Drill into one area of a diff.json produced by wpt-diff.js.
 *
 * The area rollup from wpt-diff.js tells you *where* things moved; this tells you
 * *what* moved, which is what you need to name the actual feature. Sorting by
 * subtest delta surfaces the one or two test files that explain a whole area.
 *
 * Usage:
 *   node wpt-area.js <diff.json> <path-prefix> [options]
 *
 *   node wpt-area.js diff.json /fetch
 *   node wpt-area.js diff.json /css/css-typed-om --kinds
 *   node wpt-area.js diff.json /webcodecs --min 5 --limit 30
 *   node wpt-area.js diff.json --regressions        # all regressions, any area
 *
 * Options:
 *   --min <n>      only show tests whose |subtest delta| >= n (default 1)
 *   --limit <n>    max rows (default 40)
 *   --kinds        summarise change kinds for the area instead of listing tests
 *   --regressions  show only tests that lost subtests or newly broke
 *   --improvements show only tests that gained subtests or newly started running
 *   --urls         print a wpt.fyi results URL for each test (for manual checking)
 */

const fs = require('fs');
const path = require('path');

const STATUS_NAMES = {
  O: 'OK', P: 'PASS', F: 'FAIL', S: 'SKIP', E: 'ERROR',
  N: 'NOTRUN', C: 'CRASH', T: 'TIMEOUT', PF: 'PRECONDITION_FAILED',
};

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(msg ? 1 : 0);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) usage();

const opts = { min: 1, limit: 40, kinds: false, regressions: false, improvements: false, urls: false };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--min': opts.min = Number(argv[++i]); break;
    case '--limit': opts.limit = Number(argv[++i]); break;
    case '--kinds': opts.kinds = true; break;
    case '--regressions': opts.regressions = true; break;
    case '--improvements': opts.improvements = true; break;
    case '--urls': opts.urls = true; break;
    default:
      if (a.startsWith('--')) usage(`unknown option ${a}`);
      positional.push(a);
  }
}

const [file, prefix] = positional;
if (!file) usage('missing diff.json path');
if (!fs.existsSync(file)) usage(`no such file: ${file}`);

const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const label = (side) => report[side].spec || report[side].channel || report[side].product;

// An area prefix is optional when filtering by regressions/improvements.
if (!prefix && !opts.regressions && !opts.improvements) {
  usage('missing path prefix (or pass --regressions / --improvements)');
}

const REGRESSED = new Set(['regressed', 'newly-broken', 'removed']);
const IMPROVED = new Set(['improved', 'newly-running', 'added']);

let tests = report.tests;
if (prefix) {
  // Match on a path boundary so "/css" doesn't also match "/css-foo".
  tests = tests.filter((t) => t.test === prefix || t.test.startsWith(prefix.replace(/\/$/, '') + '/'));
}
if (opts.regressions) tests = tests.filter((t) => REGRESSED.has(t.kind));
if (opts.improvements) tests = tests.filter((t) => IMPROVED.has(t.kind));

if (!tests.length) {
  console.log(`No changed tests matching ${prefix || '(any)'} in ${path.basename(file)}.`);
  process.exit(0);
}

console.log(`# ${prefix || 'all areas'}  (${label('before')} -> ${label('after')})`);
console.log(`# ${tests.length} changed test file(s) in ${path.basename(file)}`);
console.log('');

if (opts.kinds) {
  const kinds = {};
  let deltaPass = 0;
  for (const t of tests) {
    kinds[t.kind] = (kinds[t.kind] || 0) + 1;
    deltaPass += t.deltaPass;
  }
  for (const [k, v] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
    console.log(`${String(v).padStart(6)}  ${k}`);
  }
  console.log('');
  console.log(`net subtest delta: ${deltaPass > 0 ? '+' : ''}${deltaPass}`);

  // Show the matching area rollups, which carry the pass-rate context.
  const areas = report.areas.filter(
    (a) => !prefix || ('/' + a.area === prefix || ('/' + a.area).startsWith(prefix.replace(/\/$/, '') + '/') || prefix.startsWith('/' + a.area)),
  );
  if (areas.length) {
    console.log('');
    console.log('area rollup:');
    for (const a of areas) {
      const rate = a.beforeRate === null || a.afterRate === null
        ? ''
        : ` (${(a.beforeRate * 100).toFixed(2)}% -> ${(a.afterRate * 100).toFixed(2)}%)`;
      console.log(`  ${a.deltaPass > 0 ? '+' : ''}${a.deltaPass} subtests  ${a.area}${rate}`);
    }
  }
  process.exit(0);
}

const fmt = (side) =>
  side ? `${STATUS_NAMES[side.status] || side.status || '?'} ${side.pass}/${side.total}` : '-';

const rows = tests
  .filter((t) => Math.abs(t.deltaPass) >= opts.min)
  .sort((a, b) => Math.abs(b.deltaPass) - Math.abs(a.deltaPass) || a.test.localeCompare(b.test));

for (const t of rows.slice(0, opts.limit)) {
  const d = `${t.deltaPass > 0 ? '+' : ''}${t.deltaPass}`;
  console.log(
    `${d.padStart(6)}  ${fmt(t.before).padEnd(20)} -> ${fmt(t.after).padEnd(20)} ${t.kind.padEnd(14)} ${t.test}`,
  );
  if (opts.urls) {
    const q = new URLSearchParams({ q: t.test });
    console.log(`        https://wpt.fyi/results${t.test}?${new URLSearchParams({
      product: report.before.product + (report.before.channel ? '@' + report.before.channel : ''),
    })}&${new URLSearchParams({
      product: report.after.product + (report.after.channel ? '@' + report.after.channel : ''),
    })}`);
    void q;
  }
}
if (rows.length > opts.limit) {
  console.log(`\n... and ${rows.length - opts.limit} more (raise --limit to see them)`);
}

// Tests with a delta of 0 still matter — a status flip with no subtest change
// (e.g. OK -> TIMEOUT at 0/1) is often an infrastructure problem, not a code change.
const zero = tests.filter((t) => t.deltaPass === 0);
if (zero.length && opts.min > 0) {
  console.log(`\n(${zero.length} test(s) changed status without changing subtest counts; --min 0 to see them)`);
}
