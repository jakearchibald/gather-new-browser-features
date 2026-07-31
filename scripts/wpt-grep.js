#!/usr/bin/env node
/**
 * Search a collected comparison for a keyword — in subtest names and assertion
 * messages, in paths, and in the test source. All three layers are local reads.
 *
 * Why this exists: "is this change in the release?" is a different search from
 * reading the inventory. Someone has a changelog entry, a bug number or a
 * half-memory, and wants it verified against the data.
 *
 * Search test *contents*, not paths. A filename often contains no word from the
 * feature's name: a `:muted` pseudo-class change lives in
 * `css/selectors/media/sound-state.html`, while a path grep for "muted" lands on
 * `muted-playbackrate.tentative.html`, which is about playbackRate and unrelated.
 * The subtest-name layer is the one that finds what paths cannot —
 * `getAnimations({ pseudoElement })` is named by its subtest, not its filename.
 *
 * Usage:
 *   node wpt-grep.js <artifact-dir> <pattern> [options]
 *
 *   node wpt-grep.js tmp/ff-153-vs-154 pseudoElement
 *   node wpt-grep.js tmp/ff-153-vs-154 ':muted' --include /css/selectors
 *   node wpt-grep.js tmp/ff-153-vs-154 'sound-state' --no-sources
 *
 * Options:
 *   --include <p>   restrict to a path prefix, on a path boundary (repeatable)
 *   --no-sources    skip the source layer
 *   --limit <n>     max matches printed per layer (default 0 = all)
 *
 * The pattern is a literal substring unless it looks like a regex (contains any of
 * \\ ( ) [ ] | + * ? ^ $), in which case it is compiled as one — and if that fails
 * to compile it falls back to a literal search with a note, because the obvious
 * thing to paste in is a fragment of an assertion message, and those are full of
 * parens and braces.
 *
 * Four honest answers, and three of them are not "yes":
 *
 *   tests moved, messages describe the claim   -> Confirmed. Quote message and path.
 *   tests moved, messages describe otherwise   -> A DIFFERENT change. Report both.
 *   test exists, identical in both runs        -> Not in this diff. wpt-state.js.
 *   no test matches at all                     -> No WPT coverage. Say so plainly.
 *
 * A matching directory name is not evidence. A changelog said WebDriver *Perform
 * Actions* now awaits action finalization; both perform_actions directories had
 * indeed moved +1. The newly-passing subtests were test_move_to_inline_block_child
 * and test_element_center_point_inline_block_child, both failing on
 * `assert 8 == 24.0 ± 1.0` — a coordinate bug for inline-block children, a
 * different fix that happens to live in the same directory. So always confirm via
 * the assertion messages, not the directory name.
 */

const fs = require('fs');
const path = require('path');
const { usage, num, unknownOption } = require('./lib/cli.js');
const artifact = require('./lib/artifact.js');
const { under, clip, shellArg, quotingAdvice } = require('./lib/wpt.js');
const { readCached } = require('./lib/sources.js');
const page = require('./lib/page.js');

const fail = (msg) => usage(__filename, msg);

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) usage(__filename);

const opts = { dir: null, pattern: null, sources: true, include: [], limit: 0, part: 1, all: false };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--include': opts.include.push(argv[++i]); break;
    case '--no-sources': opts.sources = false; break;
    case '--limit': opts.limit = num(fail, a, argv[++i]); break;
    case '--part': opts.part = num(fail, a, argv[++i]); break;
    case '--all': opts.all = true; break;
    default:
      if (a.startsWith('--')) fail(unknownOption(__filename, a));
      else positional.push(a);
  }
}

// One positional is ambiguous — artifact directory, or search pattern? Resolved by
// asking the filesystem rather than by argument order, so both
// `wpt-grep.js pseudoElement` and `wpt-grep.js tmp/a-vs-b pseudoElement` work.
if (positional.length >= 2) {
  [opts.dir, opts.pattern] = positional;
  if (positional.length > 2) fail(`unexpected argument ${positional[2]}`);
} else if (positional.length === 1) {
  const [one] = positional;
  const looksLikeArtifact =
    fs.existsSync(path.join(one, 'diff.json')) ||
    (fs.existsSync(one) && fs.statSync(one).isFile() && one.endsWith('diff.json'));
  if (looksLikeArtifact) {
    opts.dir = one;
    fail('a search pattern is required');
  }
  opts.pattern = one;
}
if (opts.pattern === null) fail('a search pattern is required');

const { paths, report } = artifact.load(opts.dir, fail);

const REGEXY = /[\\()[\]|+*?^$]/;
const matcher = (() => {
  const needle = opts.pattern.toLowerCase();
  const literal = (s) => String(s).toLowerCase().includes(needle);
  if (!REGEXY.test(opts.pattern)) return literal;
  try {
    const re = new RegExp(opts.pattern, 'i');
    return (s) => re.test(String(s));
  } catch (err) {
    // Announced, so a genuine regex typo isn't quietly reinterpreted.
    process.stderr.write(
      `note: pattern is not a valid regex (${err.message}) — searching for it literally.\n`,
    );
    return literal;
  }
})();

/**
 * All three layers are collected into one block list and paged ONCE at the end.
 *
 * Paging each layer against the same --part would be incoherent: with 5 matches in
 * the name layer and 5000 in the source layer, "--part 2" would mean different
 * things in each. One block list, one page count, layer headings carried as their
 * own blocks so a page break between layers is still legible.
 *
 * A broad pattern produced 3MB across these layers before this existed — the harness
 * truncates that with no marker at all.
 */
const blocks = [];
const out = (...lines) => blocks.push({ lines });
const emit = (rows) => {
  const shown = opts.limit > 0 ? rows.slice(0, opts.limit) : rows;
  for (const r of shown) blocks.push({ lines: [r] });
  if (shown.length < rows.length) {
    out(`  ... and ${rows.length - shown.length} beyond --limit ${opts.limit} (--limit 0 for all)`);
  }
};

let tests = report.tests.filter((t) => t.kind !== 'unchanged');
if (opts.include.length) tests = tests.filter((t) => opts.include.some((p) => under(t.test, p)));

console.log(`# Searching ${report.before.spec} -> ${report.after.spec} for ${JSON.stringify(opts.pattern)}`);
console.log(`# ${tests.length} changed test file(s) in scope${opts.include.length ? ` (under ${opts.include.join(', ')})` : ''}`);
// A search term rarely needs quoting — `popover=hint` does not, `=` being an ordinary
// character — and one real pass quoted it anyway and paid a permission prompt for it.
for (const line of quotingAdvice('the search term', opts.pattern)) console.log(line);

// ---------------------------------------------------------------------------
// 1. Subtest names and messages — the layer paths cannot replace.
// ---------------------------------------------------------------------------
out('\n## Subtest names and messages');
{
  const hits = [];
  for (const t of tests) {
    if (!t.subtests) continue;
    const lists = [
      [t.subtests.newlyPassing, '+'],
      [t.subtests.newlyFailing, '-'],
      [t.subtests.changed, '~'],
      [t.subtests.stillFailing, '='],
    ];
    for (const [list, sign] of lists) {
      for (const s of list || []) {
        if (!matcher(s.name) && !matcher(s.message || '')) continue;
        hits.push(
          `  ${sign} ${t.test}\n      ${clip(s.name, 96)}` +
            (s.message ? `\n      ${clip(s.message, 96)}` : ''),
        );
      }
    }
  }
  if (!hits.length) out('  (no match)');
  else emit(hits);
  out('  legend: + newly passing, - newly failing, ~ failure changed, = failing in both');
}

// ---------------------------------------------------------------------------
// 2. Paths — free, and weak. A filename need not contain the feature's name.
// ---------------------------------------------------------------------------
out('\n## Test paths');
{
  const hits = tests.filter((t) => matcher(t.test));
  if (!hits.length) {
    out('  (no match — which is NOT evidence the feature is absent: a path often');
    out('   contains no word from the feature name)');
  } else {
    emit(hits.map((t) => `  ${t.kind.padEnd(14)} ${t.test}`));
  }
}

// ---------------------------------------------------------------------------
// 3. Source — cached by wpt-collect.js at the runs' revisions.
// ---------------------------------------------------------------------------
if (!opts.sources) {
  out('\n(--no-sources given, so test source was not searched. That is the layer that');
  out(' finds a feature whose name appears nowhere in a path or subtest name.)');
} else if (!fs.existsSync(paths.sources)) {
  out('\n## Test source');
  out('  !! No sources/ in this artifact — it was collected with --no-sources, so this');
  out('  !! layer cannot run and a "no match" above covers only names and paths.');
  out('  !! Re-collect without --no-sources to search source.');
} else {
  out('\n## Test source');
  const hits = [];
  let searched = 0;
  let unavailable = 0;
  for (const t of tests) {
    const cached = readCached(paths.sources, t.test);
    // A cached miss is stored as an empty body, so it is distinguishable from
    // "never fetched" without going back to the network.
    if (!cached || !cached.text.trim()) { unavailable++; continue; }
    searched++;
    const lines = cached.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matcher(lines[i])) hits.push(`  ${t.test}:${i + 1}\n      ${clip(lines[i], 96)}`);
    }
  }
  if (!hits.length) out(`  (no match in ${searched} file(s))`);
  else emit(hits);
  if (unavailable) {
    out(`  note: ${unavailable} test(s) have no cached source — generated variants and`);
    out('        renames legitimately have none.');
  }
}

// ---------------------------------------------------------------------------
// One page of the combined result.
// ---------------------------------------------------------------------------
const resume = ['node scripts/wpt-grep.js', shellArg(opts.pattern)]
  .concat(opts.include.flatMap((i) => ['--include', shellArg(i)]))
  .concat(opts.sources ? [] : ['--no-sources'])
  .join(' ');
for (const line of page.render(blocks, {
  part: opts.part,
  all: opts.all,
  unit: 'lines',
  resume,
}).lines) {
  console.log(line);
}
