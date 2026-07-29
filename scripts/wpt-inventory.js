#!/usr/bin/env node
/**
 * Print EVERY changed test file in a diff, grouped by directory, for reading
 * end to end.
 *
 * Why this exists
 * ---------------
 * Every other view in this toolkit ranks by magnitude — subtest delta, summed
 * area delta, top-N per section. Ranking is the wrong tool for the job it was
 * being used for, because **subtest count is not a signal of importance**. The
 * delta of a fix measures how many assertions happened to still be failing
 * beforehand, which has nothing to do with whether a feature shipped:
 *
 *   css/selectors/webkit-pseudo-element.html   5/6  -> 6/6   (+1)
 *       -webkit- prefixed pseudo-elements now parse as valid
 *   .../customizable-select/select-parsing.html 10/17 -> 17/17 (+7)
 *       the <select> parser keeps all nested elements
 *
 * Both are real, developer-facing features. Both were dismissed as noise on a
 * real release-notes pass because +1 and +7 look like rounding error next to a
 * +664. No threshold, weighting or cleverer ranking fixes that, because the
 * premise is wrong: there is no delta below which a change is uninteresting.
 *
 * So this view selects nothing. It prints all changed files, grouped by the
 * directory that names the feature, and expects to be read in full. On a typical
 * two-release diff that is ~600 files in ~190 directories — a few minutes of
 * reading, and the only approach that cannot silently drop a feature.
 *
 * Usage:
 *   node wpt-inventory.js <diff.json> [options]
 *
 *   node wpt-inventory.js diff.json                   # everything, grouped
 *   node wpt-inventory.js diff.json --improvements    # only forward movement
 *   node wpt-inventory.js diff.json --regressions     # only backward movement
 *   node wpt-inventory.js diff.json --completed       # files that reached 100%
 *   node wpt-inventory.js diff.json --dirs            # one line per directory
 *   node wpt-inventory.js diff.json --checklist       # coverage worksheet, see below
 *   node wpt-inventory.js diff.json --include /css    # restrict to a subtree
 *
 * Options:
 *   --dirs          one line per directory only, no per-file rows
 *   --checklist     emit one unchecked line per directory that needs a verdict,
 *                   with churn-only directories pre-resolved. Use this to make
 *                   coverage auditable instead of aspirational: every line has to
 *                   end up either explained or written up. Reading advice cannot
 *                   be verified; an unticked box can.
 *   --completed     only files that went from partly failing to fully passing.
 *                   "Last failures cleared" — a strong feature-shipped signal
 *                   that is independent of how big the delta was.
 *   --improvements  only files that moved forward
 *   --regressions   only files that moved backward
 *   --include <p>   only tests whose path starts with <p> (repeatable)
 *   --exclude <p>   skip tests whose path starts with <p> (repeatable).
 *                   NOTHING is excluded unless you ask. See below.
 *
 * Why --checklist exists
 * ----------------------
 * The Popover API hint/auto rework was missed on a real pass *after* this script
 * was written and while its output was on screen. The line
 *
 *   /html/semantics/popovers  [5 files, +19 subtests, 5 fwd, 5 done]
 *
 * was printed, read, quoted in conversation as "not yet examined", and then never
 * examined — five files, every one *done*, the strongest signal this tool emits.
 * No additional signal would have helped, because the signal was already maximal.
 * What was missing was a completion criterion: nothing distinguished "read all 202
 * directories" from "read the 15 that looked interesting". So this mode turns the
 * inventory into a worksheet with a per-directory verdict, where stopping early is
 * visible rather than silent.
 *
 * On third_party/test262
 * ----------------------
 * `third_party/test262` is the vendored TC39 conformance suite, and it is where
 * **JavaScript language and Intl features appear** — they have no web-platform
 * directory of their own. It is tempting to exclude by default because it is
 * one-assertion-per-file and so forms large uniform blocks; an earlier version of
 * this script did exactly that, and immediately hid a shipped feature:
 *
 *   third_party/test262/test/intl402/Locale/prototype/get{Calendars,Collations,
 *   HourCycles,NumberingSystems,TextInfo,TimeZones,WeekInfo}/  — 42 files,
 *   every one 0/1 -> 1/1, i.e. the whole Intl.Locale info proposal landing.
 *
 * One assertion per file is what makes *done* maximally informative here: a
 * test262 file going 0/1 -> 1/1 means one named spec assertion started holding.
 * Dozens of them under one proposal's directory is a cleaner "feature shipped"
 * signal than most web-platform directories produce. So: no default exclusion.
 * If it is genuinely in the way for one run, pass --exclude /third_party
 * explicitly — but do not make that a habit, or Intl/Temporal-class features will
 * go unreported.
 */

const fs = require('fs');

const STATUS_NAMES = {
  O: 'OK', P: 'PASS', F: 'FAIL', S: 'SKIP', E: 'ERROR',
  N: 'NOTRUN', C: 'CRASH', T: 'TIMEOUT', PF: 'PRECONDITION_FAILED',
};

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(msg ? 1 : 0);
}

function parseArgs(argv) {
  const opts = {
    file: null, dirs: false, checklist: false, completed: false,
    improvements: false, regressions: false,
    include: [], exclude: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--dirs': opts.dirs = true; break;
      case '--checklist': opts.checklist = true; break;
      case '--completed': opts.completed = true; break;
      case '--improvements': opts.improvements = true; break;
      case '--regressions': opts.regressions = true; break;
      case '--include': opts.include.push(next()); break;
      case '--exclude': opts.exclude.push(next()); break;
      case '-h': case '--help': usage(); break;
      default:
        if (arg.startsWith('-')) usage(`unknown option ${arg}`);
        else if (!opts.file) opts.file = arg;
        else usage(`unexpected argument ${arg}`);
    }
  }
  if (!opts.file) usage('a diff.json path is required');
  return opts;
}

// A test that exists on only one side is test-suite churn, not browser change:
// the two runs are usually on different WPT revisions, so `added`/`removed` mean
// "this test was written since" far more often than they mean anything about the
// browser. Counting them as movement actively misleads — /css/css-viewport/zoom
// shows 34 changed files here, of which 31 are simply new tests. They are still
// listed (a new test that already fails can be worth a mention) but tallied
// separately so a directory of pure churn is obvious at a glance.
function isChurn(r) {
  return r.kind === 'added' || r.kind === 'removed';
}
/** Did this file move forward? Covers reftests, which carry no subtests. */
function movedForward(r) {
  return !isChurn(r) && (r.deltaPass > 0 || r.statusDirection === 'fixed' || r.kind === 'newly-running');
}
function movedBackward(r) {
  return !isChurn(r) && (r.deltaPass < 0 || r.statusDirection === 'broken' || r.kind === 'newly-broken');
}
/** Was failing something, now passes everything: "last failures cleared". */
function completed(r) {
  return (
    r.before && r.after &&
    r.before.total > 0 && r.after.total > 0 &&
    r.before.pass < r.before.total && r.after.pass === r.after.total
  );
}

function fmtSide(s) {
  if (!s) return '-';
  const name = STATUS_NAMES[s.status] || s.status || '?';
  return `${name} ${s.pass}/${s.total}`;
}

const opts = parseArgs(process.argv.slice(2));
const report = JSON.parse(fs.readFileSync(opts.file, 'utf8'));

/**
 * Prefix match on a path boundary. A plain startsWith over-matches siblings:
 * `--include /dom` swept in `/domparsing` and `--include /webrtc` swept in
 * `/webrtc-stats`. That is merely confusing for --include, but for --exclude it
 * *hides* — `--exclude /html` would silently drop `/html-media-capture`, which
 * is the failure mode this whole script exists to prevent.
 */
function under(test, prefix) {
  const p = `/${prefix.replace(/^\/+/, '')}`.replace(/\/+$/, '');
  return p === '' || test === p || test.startsWith(`${p}/`);
}

let tests = report.tests.filter((r) => r.kind !== 'unchanged');
if (opts.exclude.length) {
  tests = tests.filter((r) => !opts.exclude.some((p) => p && under(r.test, p)));
}
if (opts.include.length) {
  tests = tests.filter((r) => opts.include.some((p) => under(r.test, p)));
}
if (opts.completed) tests = tests.filter(completed);
if (opts.improvements) tests = tests.filter(movedForward);
if (opts.regressions) tests = tests.filter(movedBackward);

const byDir = new Map();
for (const r of tests) {
  const dir = `/${r.test.replace(/^\//, '').split('/').slice(0, -1).join('/')}`;
  if (!byDir.has(dir)) byDir.set(dir, []);
  byDir.get(dir).push(r);
}

const groups = [...byDir.entries()]
  .map(([dir, rows]) => ({
    dir,
    rows: rows.sort((a, b) => b.deltaPass - a.deltaPass || a.test.localeCompare(b.test)),
    deltaPass: rows.reduce((s, r) => s + r.deltaPass, 0),
    forward: rows.filter(movedForward).length,
    backward: rows.filter(movedBackward).length,
    completed: rows.filter(completed).length,
    churn: rows.filter(isChurn).length,
  }))
  // Alphabetical by path, NOT by size. Related directories read together, and
  // no directory is implicitly "more important" for being listed first.
  .sort((a, b) => a.dir.localeCompare(b.dir));

const L = console.log;
const filters = [
  opts.completed && 'completed',
  opts.improvements && 'improvements',
  opts.regressions && 'regressions',
  opts.include.length && `under ${opts.include.join(', ')}`,
].filter(Boolean);

L(`# Changed-test inventory: ${report.before.spec} -> ${report.after.spec}`);
L('');
L(`${tests.length} changed test files in ${groups.length} directories${filters.length ? ` (${filters.join(', ')})` : ''}.`);
if (opts.exclude.length && opts.exclude.some(Boolean)) {
  // Loud, because an exclusion is exactly how a feature goes unreported: an
  // earlier default of /third_party hid the whole Intl.Locale info proposal.
  L(`EXCLUDED BY REQUEST: ${opts.exclude.filter(Boolean).join(', ')} — features in`);
  L('those paths will not appear below. Re-run without --exclude to see them.');
}
L('');

if (opts.checklist) {
  const churnOnly = groups.filter((g) => g.churn === g.rows.length);
  const needsVerdict = groups.filter((g) => g.churn !== g.rows.length);

  L('COVERAGE CHECKLIST');
  L('');
  L(`${needsVerdict.length} directories need a verdict. ${churnOnly.length} are pre-resolved`);
  L('as test-suite churn (added/removed tests only — different WPT revisions).');
  L('');
  L('Work top to bottom and give EVERY line one of:');
  L('  [x] written up   — it is in the notes');
  L('  [x] explained    — same cause as another entry; name which');
  L('  [x] not a feature — infrastructure, flake, or churn; say why');
  L('Do not leave a line unticked, and do not stop at the interesting-looking ones.');
  L('A 5-file all-done directory was skipped that way once: see --help.');
  L('');
  for (const g of needsVerdict) {
    const bits = [
      g.forward ? `${g.forward} fwd` : null,
      g.backward ? `${g.backward} back` : null,
      g.completed ? `${g.completed} done` : null,
      g.churn ? `${g.churn} new/gone` : null,
    ].filter(Boolean);
    const delta = g.deltaPass > 0 ? `+${g.deltaPass}` : String(g.deltaPass);
    L(`[ ] ${g.dir}  (${g.rows.length}f, ${delta}, ${bits.join(', ')})`);
  }
  L('');
  L(`--- pre-resolved as churn (${churnOnly.length}), no verdict needed ---`);
  for (const g of churnOnly) L(`[x] ${g.dir}  (${g.rows.length}f, churn)`);
  process.exit(0);
}

L('Read this in full. Rows are alphabetical, not ranked — subtest delta is not a');
L('measure of importance, and a +1 has turned out to be a shipped feature.');
L('"done" counts files that went from partly failing to fully passing.');
L('JS/Intl features live in third_party/test262, not a web-platform directory.');
L('');

for (const g of groups) {
  const bits = [
    g.forward ? `${g.forward} fwd` : null,
    g.backward ? `${g.backward} back` : null,
    g.completed ? `${g.completed} done` : null,
    g.churn ? `${g.churn} new/gone` : null,
  ].filter(Boolean);
  const delta = g.deltaPass > 0 ? `+${g.deltaPass}` : String(g.deltaPass);
  const allChurn = g.churn === g.rows.length ? '  <- all test-suite churn' : '';
  L(`${g.dir}  [${g.rows.length} file${g.rows.length === 1 ? '' : 's'}, ${delta} subtests, ${bits.join(', ')}]${allChurn}`);
  if (!opts.dirs) {
    for (const r of g.rows) {
      const flag = completed(r)
        ? ' *done*'
        : r.kind === 'added' ? ' (new test)' : r.kind === 'removed' ? ' (test removed)' : '';
      const name = r.test.slice(g.dir === '/' ? 1 : g.dir.length + 1);
      L(`    ${(r.deltaPass > 0 ? `+${r.deltaPass}` : String(r.deltaPass)).padStart(5)}  ${fmtSide(r.before).padEnd(20)} -> ${fmtSide(r.after).padEnd(20)} ${name}${flag}`);
    }
  }
}
