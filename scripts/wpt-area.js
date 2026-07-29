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
 *   --min <n>      only show tests whose |subtest delta| >= n (default 1). Use 0 to
 *                  include reftests, which have no subtests and so always sit at 0.
 *   --limit <n>    max rows (default 40; 0 = all)
 *   --kinds        summarise change kinds for the area instead of listing tests
 *   --regressions  show only tests that lost subtests, newly broke, or (as a reftest)
 *                  flipped PASS -> FAIL
 *   --improvements show only tests that gained subtests, newly started running, or (as
 *                  a reftest) flipped FAIL -> PASS
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
// Unvalidated Number() turns a typo into an empty report rather than an error:
// slice(0, NaN) is [] and `length > NaN` is false, so every row and even the
// "... and N more" line silently disappears.
const num = (flag, raw) => {
  const n = Number(raw);
  if (raw === undefined) usage(`missing value for ${flag}`);
  if (!Number.isFinite(n)) usage(`${flag} needs a number, got "${raw}"`);
  return n;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--min': opts.min = num(a, argv[++i]); break;
    case '--limit': opts.limit = num(a, argv[++i]); break;
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

// A reftest has no subtests, so a rendering fix is FAIL 0/0 -> PASS 0/0: kind
// 'status-changed' with deltaPass 0. Those are real improvements/regressions and
// belong in --improvements/--regressions, but only once we know which way the
// flip went. wpt-diff.js records that as statusDirection; recompute it for diffs
// written before it did.
const PASS_LIKE = new Set(['P', 'O']);
const FAIL_LIKE = new Set(['F']);
const directionOf = (t) => {
  if (t.statusDirection !== undefined) return t.statusDirection;
  if (t.kind !== 'status-changed' || !t.before || !t.after) return null;
  if (FAIL_LIKE.has(t.before.status) && PASS_LIKE.has(t.after.status)) return 'fixed';
  if (PASS_LIKE.has(t.before.status) && FAIL_LIKE.has(t.after.status)) return 'broken';
  return 'other';
};

let tests = report.tests;
if (prefix) {
  // Match on a path boundary so "/css" doesn't also match "/css-foo".
  tests = tests.filter((t) => t.test === prefix || t.test.startsWith(prefix.replace(/\/$/, '') + '/'));
}
if (opts.regressions) {
  tests = tests.filter((t) => REGRESSED.has(t.kind) || directionOf(t) === 'broken');
}
if (opts.improvements) {
  tests = tests.filter((t) => IMPROVED.has(t.kind) || directionOf(t) === 'fixed');
}

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

  const flips = tests.map(directionOf);
  const fixed = flips.filter((d) => d === 'fixed').length;
  const broken = flips.filter((d) => d === 'broken').length;
  if (fixed || broken) {
    console.log(
      `status flips with no subtests (reftests): ${fixed} now passing, ${broken} now failing`,
    );
  }

  // Show the matching area rollups, which carry the pass-rate context. Match on
  // path boundaries in both directions: an area at or below the prefix, or the
  // parent area of a deeper prefix. Plain startsWith would pair "/domparsing"
  // with the unrelated "dom" area.
  const bare = prefix ? prefix.replace(/\/$/, '') : null;
  const areas = report.areas.filter((a) => {
    if (!bare) return true;
    const areaPath = '/' + a.area;
    return (
      areaPath === bare ||
      areaPath.startsWith(bare + '/') ||
      bare.startsWith(areaPath + '/')
    );
  });
  if (areas.length) {
    console.log('');
    console.log('area rollup:');
    for (const a of areas) {
      const rate = a.beforeRate === null || a.afterRate === null
        ? ''
        : ` (${(a.beforeRate * 100).toFixed(2)}% -> ${(a.afterRate * 100).toFixed(2)}%)`;
      const noSubtests = [
        a.statusFixed ? `${a.statusFixed} now passing` : null,
        a.statusBroken ? `${a.statusBroken} now failing` : null,
      ].filter(Boolean);
      const flipNote = noSubtests.length ? `  [no subtests: ${noSubtests.join(', ')}]` : '';
      console.log(
        `  ${a.deltaPass > 0 ? '+' : ''}${a.deltaPass} subtests  ${a.area}${rate}${flipNote}`,
      );
    }
  }
  process.exit(0);
}

const fmt = (side) =>
  side ? `${STATUS_NAMES[side.status] || side.status || '?'} ${side.pass}/${side.total}` : '-';

const spec = (side) =>
  report[side].product + (report[side].channel ? '@' + report[side].channel : '');

/**
 * wpt.fyi results URL for a test, comparing both runs.
 *
 * The test path may already carry a query (`foo.html?exclude=(RTCError)`), so the
 * product params have to be merged into it. Appending "?product=..." produced a
 * second "?" and buried both products inside the test's own query value.
 */
function resultsUrl(testPath) {
  const [path, query] = testPath.split(/\?(.*)/s);
  const params = new URLSearchParams(query || '');
  params.append('product', spec('before'));
  params.append('product', spec('after'));
  return `https://wpt.fyi/results${path}?${params}`;
}

const byDelta = (a, b) =>
  Math.abs(b.deltaPass) - Math.abs(a.deltaPass) || a.test.localeCompare(b.test);

let rows = tests.filter((t) => Math.abs(t.deltaPass) >= opts.min).sort(byDelta);

// A reftest-only area has every deltaPass at 0, so the --min filter empties the
// list and the report reads as "nothing changed" when 8 rendering tests just
// started passing. Show them rather than printing a bare header.
let shownDespiteMin = false;
if (!rows.length && opts.min > 0) {
  rows = tests.filter((t) => directionOf(t) === 'fixed' || directionOf(t) === 'broken').sort(byDelta);
  shownDespiteMin = rows.length > 0;
  if (shownDespiteMin) {
    console.log(`(nothing above --min ${opts.min}; these changed status with no subtests)\n`);
  }
}

const shown = opts.limit > 0 ? rows.slice(0, opts.limit) : rows;
for (const t of shown) {
  const d = `${t.deltaPass > 0 ? '+' : ''}${t.deltaPass}`;
  console.log(
    `${d.padStart(6)}  ${fmt(t.before).padEnd(20)} -> ${fmt(t.after).padEnd(20)} ${t.kind.padEnd(14)} ${t.test}`,
  );
  if (opts.urls) console.log(`        ${resultsUrl(t.test)}`);
}
if (shown.length < rows.length) {
  console.log(`\n... and ${rows.length - shown.length} more (--limit 0 for all)`);
}

// Tests with a delta of 0 still matter in both directions: a reftest FAIL -> PASS
// is a rendering fix, and an OK -> TIMEOUT at 0/1 is often an infrastructure
// problem rather than a code change.
const zero = tests.filter((t) => t.deltaPass === 0);
if (zero.length && opts.min > 0 && !shownDespiteMin) {
  const fixed = zero.filter((t) => directionOf(t) === 'fixed').length;
  const broken = zero.filter((t) => directionOf(t) === 'broken').length;
  const detail = [
    fixed ? `${fixed} now passing` : null,
    broken ? `${broken} now failing` : null,
  ].filter(Boolean);
  console.log(
    `\n(${zero.length} test(s) changed status without changing subtest counts` +
      `${detail.length ? ` — ${detail.join(', ')}` : ''}; --min 0 to see them)`,
  );
}
