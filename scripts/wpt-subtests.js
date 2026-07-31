#!/usr/bin/env node
/**
 * Every subtest of one or more test files, with the assertion message behind each
 * change. Local and instant — wpt-collect.js already streamed the raw reports.
 *
 * Why this exists: a subtest count tells you a file moved; it does not tell you
 * why. "getComputedTiming() 26/41 -> 41/41" reads like fifteen timing fixes. The
 * subtest messages showed all fifteen were one missing property — startTime was
 * `undefined`, and because it is the first assertion in ten of those tests, that
 * single line failed them all. The count cannot distinguish "15 bugs fixed" from
 * "1 bug fixed, 15 tests unblocked", and those are different release notes.
 *
 * Names and messages also give you the vocabulary developers search for: property
 * names, method names, the actual expected-vs-got values.
 *
 * Usage:
 *   node wpt-subtests.js <artifact-dir> <test-path> [<test-path> ...]
 *
 *   node wpt-subtests.js tmp/ff-153-vs-154 /web-animations/interfaces/AnimationEffect/getComputedTiming.html
 *   node wpt-subtests.js tmp/ff-153-vs-154 /path/one.html /path/two.html /path/three.html
 *   node wpt-subtests.js tmp/ff-153-vs-154 --grep supported-stats
 *
 * Options:
 *   --grep <s>    run over every changed test whose path contains <s>, instead of
 *                 naming paths exactly. Handy when the ?query variant is fiddly.
 *   --match <s>   show only subtests whose NAME or MESSAGE matches, within each
 *                 file. Use this instead of piping to sed/head — see below.
 *   --only <c,..> show only these transition categories: newly-passing,
 *                 newly-failing, changed, removed, still-failing. Use this instead
 *                 of grepping for an arrow — see below.
 *   --part <n>    which page of the output (default 1). A busy file renders to more
 *                 than the tool output limit — 66KB for one 213-fix file — so it is
 *                 paged. Breaks fall between subtests, never inside one, and every
 *                 page repeats its file's synopsis so it stands alone. Each page
 *                 says what has not been read yet.
 *   --all         emit every page at once, ignoring the budget. For deliberate
 *                 redirection to a file, not for reading inline.
 *   --limit <n>   max rows per section (default 0 = all). Raising this above 0 is
 *                 almost always a mistake — see below.
 *
 * Run from the repository root. The Bash tool's working directory persists between
 * calls, so one earlier `cd` makes `node scripts/...` unresolvable afterwards —
 * which is a shell failure before this script starts, not something it can report.
 * Artifact discovery itself is cwd-independent.
 *
 * READ EVERY LINE. Do not pipe this through `head`, `tail` or a `sed` range when
 * deciding what a file means. It is the one mistake that produces a *confidently
 * wrong* finding rather than a visible gap, because you have the right file so
 * nothing feels missing. A real pass read webrtc-stats/supported-stats.https.html's
 * 24 new subtests via `tail -35`, saw the last 6 (candidate stats), wrote up
 * exactly those, and missed the 12 RTCTransportStats properties (dtlsCipher,
 * dtlsRole, tlsVersion, srtpCipher, …) in the middle — a whole stats type newly
 * reported, not IDL polish. Long output is information about a file's importance,
 * not a reason to sample it.
 *
 * A `sed` range is worse than `head`, because it fails *quietly*. Slicing
 * color-computed-color-mix-function.html with `sed -n '/color-mix/,/^====/p'`
 * looks reasonable and silently drops the header, the section titles and the
 * synopsis — nearly every subtest name contains "color-mix", so the range keeps
 * restarting and the output arrives mangled but plausible.
 *
 * When you want a bounded read, bound it with --match, which filters on meaning
 * rather than on line position and always reports the file's true totals:
 *
 *   node wpt-subtests.js $D /css/css-color/parsing/color-computed-color-mix-function.html --match '0%'
 *
 * DO NOT GREP FOR AN ARROW to get "just the newly-passing". `grep 'FAIL    -> PASS'`
 * is lossy in a way you cannot see: it misses a subtest that was NOTRUN or TIMEOUT
 * before, and misses `(new)   -> PASS` — a brand-new assertion that holds —
 * entirely. That last omission is how an ENTIRELY NEW interface appears, so the
 * pattern fails hardest on exactly the kind of claim it gets used to check. On one
 * real diff it under-reported in 19 files, hiding 55 new-subtest passes and 13
 * non-FAIL priors out of 1018. It also throws away the `was:` message lines, which
 * are the reason this command exists.
 *
 *   node wpt-subtests.js $D <path> --only newly-passing
 *
 * If you truly must grep, `-> PASS` is the sound pattern and `FAIL    -> PASS` is
 * not — but you will still lose the messages and the synopsis.
 *
 * Account for ALL of them. If a file gained 24 subtests, your description should
 * cover what all 24 were about even if you only write up the interesting ones. A
 * file whose subtests fall into two or three distinct groups is two or three
 * findings. Before moving on, ask: which subtests have I not accounted for?
 *
 * Read the rollup at the end:
 *   - One message dominating  -> one bug. Name it, give the reproducing example,
 *     and do NOT enumerate the tests.
 *   - Several distinct messages -> several fixes; group by message, not by file.
 *   - A matching directory name is not evidence. The question is never "did this
 *     directory move?" but "do the assertion messages describe *this* behaviour?"
 */

const { usage, num, unknownOption } = require('./lib/cli.js');
const artifact = require('./lib/artifact.js');
const { shellArg, quotingAdvice } = require('./lib/wpt.js');
const { renderFiles, CATEGORIES, grepFragment } = require('./lib/render.js');

const fail = (msg) => usage(__filename, msg);

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) usage(__filename);

const opts = { dir: null, limit: 0, grep: [], match: null, only: null, part: 1, all: false };
const testPaths = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--limit': opts.limit = num(fail, a, argv[++i]); break;
    // Repeatable, and ADDITIVE with explicit paths. It used to replace them, so a
    // command could not mix "these two exact files" with "and whatever matches this
    // substring" — which is precisely what you want when one of the three paths you
    // care about is a `?exclude=(a|b|c)` variant you would rather not type.
    case '--grep': opts.grep.push(String(argv[++i] || '')); break;
    case '--match': opts.match = argv[++i]; break;
    case '--part': opts.part = num(fail, a, argv[++i]); break;
    case '--all': opts.all = true; break;
    case '--only': {
      const raw = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!raw.length) fail(`--only needs at least one of: ${CATEGORIES.join(', ')}`);
      const bad = raw.filter((c) => !CATEGORIES.includes(c));
      if (bad.length) fail(`unknown --only category "${bad[0]}" (choose from: ${CATEGORIES.join(', ')})`);
      opts.only = new Set(raw);
      break;
    }
    default:
      if (a.startsWith('-')) fail(unknownOption(__filename, a));
      // A WPT test path always starts with "/" and is never a local directory;
      // anything else is the artifact. Checking the filesystem first would
      // misclassify an absolute artifact path, which also starts with "/".
      else if (a.startsWith('/') && !require('fs').existsSync(a)) testPaths.push(a);
      else if (!opts.dir) opts.dir = a;
      else testPaths.push(a);
  }
}
if (!testPaths.length && !opts.grep.length) {
  fail('need at least one test path, or --grep <substring>');
}

const { paths: art, report } = artifact.load(opts.dir, fail);
const changed = report.tests.filter((r) => r.kind !== 'unchanged');
const byPath = new Map(changed.map((r) => [r.test, r]));

// Explicit paths first, then every --grep match, deduped so naming a path and also
// matching it does not print it twice.
const rows = [];
const taken = new Set();
const add = (r) => {
  if (!r || taken.has(r.test)) return;
  taken.add(r.test);
  rows.push(r);
};
for (const p of testPaths) add(byPath.get(p));
const missing = testPaths.filter((p) => !byPath.has(p));

const unmatched = [];
for (const g of opts.grep) {
  const needle = g.toLowerCase();
  const hits = changed.filter((r) => r.test.toLowerCase().includes(needle));
  if (!hits.length) unmatched.push(g);
  for (const r of hits) add(r);
}

// Said at the point of use, because the prompt has already happened by the time this
// runs and the only thing left to fix is the next command.
const countMatches = (p) => changed.filter((r) => r.test.toLowerCase().includes(p.toLowerCase())).length;
for (const g of opts.grep) {
  for (const line of quotingAdvice('--grep', g, countMatches)) console.log(line);
}
if (opts.match) {
  for (const line of quotingAdvice('--match', opts.match)) console.log(line);
}

if (unmatched.length) {
  for (const g of unmatched) console.log(`No changed test path contains "${g}".`);
  console.log('');
  console.log('That is NOT evidence the feature is absent — a filename often contains no');
  console.log('word from the feature name, and a test unchanged in both runs is absent');
  console.log('from this diff by design. Search subtest names with wpt-grep.js, and');
  console.log('absolute state with wpt-state.js.');
  if (!rows.length) process.exit(0);
  console.log('');
}

// A literal, case-insensitive substring. Deliberately not a regex: the thing you
// paste in here is a fragment of an assertion message or a CSS value, and those
// are full of parens, brackets and percent signs.
const match = opts.match
  ? (s) => String(s).toLowerCase().includes(opts.match.toLowerCase())
  : null;

console.log(`# Subtest detail: ${report.before.spec} -> ${report.after.spec}`);
const how = [
  testPaths.length ? `${testPaths.length} named` : null,
  opts.grep.length ? `--grep ${opts.grep.map((g) => JSON.stringify(g)).join(', ')}` : null,
].filter(Boolean).join(' + ');
console.log(`# ${rows.length} test file(s)${how ? ` (${how})` : ''}`);
if (match) console.log(`# subtests filtered to those matching "${opts.match}"`);
if (opts.only) console.log(`# categories: ${[...opts.only].join(', ')}`);
console.log('');

// A real resume command. Named paths go through --grep, since a `?query` path in a
// line printed to be copied is the whole problem: unquoted the shell globs it, quoted
// it stops being pre-approved.
const resume = [artifact.cmd('wpt-subtests.js', art)]
  .concat(opts.limit ? ['--limit', String(opts.limit)] : [])
  .concat(opts.match ? ['--match', shellArg(opts.match)] : [])
  .concat(opts.only ? ['--only', [...opts.only].join(',')] : [])
  .concat(opts.grep.flatMap((g) => ['--grep', shellArg(g)]))
  .concat(testPaths.flatMap((t) => ['--grep', grepFragment(t)]))
  .join(' ');

for (const line of renderFiles(report, rows, {
  limit: opts.limit,
  match,
  matchLabel: JSON.stringify(opts.match),
  only: opts.only,
  part: opts.part,
  all: opts.all,
  resume,
})) {
  console.log(line);
}

// Loud tail: with several paths a single "not found" line scrolls away, and a path
// silently yielding nothing is how a mistyped ?query variant becomes "no change
// here".
if (missing.length) {
  console.log(`!! ${missing.length} of ${testPaths.length} path(s) are not changed tests in this diff:`);
  for (const p of missing) console.log(`!!   ${p}`);
  console.log('!!');
  console.log('!! Either the path is wrong (check the ?query variant, and that .any.js tests');
  console.log('!! are named e.g. foo.any.worker.html), or the test did not change — which is');
  console.log('!! not the same as "the feature is missing". Try:');
  // Both suggestions use --grep. Echoing the path back bare is how this message
  // handed over a command that could not run: a `?query` path is glob syntax to the
  // shell unquoted, and quoted it stops matching a permission rule.
  // A concrete fragment from the path that failed, not a `<substring>` placeholder.
  // Angle brackets are shell redirects, so a placeholder in the copy position is one
  // more command that cannot be run as printed.
  console.log(`!!   ${artifact.cmd('wpt-subtests.js', art)} --grep ${grepFragment(missing[0])}`);
  console.log(`!!   ${artifact.cmd('wpt-state.js', art)} --grep ${grepFragment(missing[0])}`);
  process.exit(1);
}
