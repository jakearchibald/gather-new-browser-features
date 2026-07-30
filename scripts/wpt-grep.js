#!/usr/bin/env node
/**
 * Search a diff for a keyword — in subtest names, in paths, and optionally in the
 * test source itself.
 *
 * Why this exists: "is this change in the release?" is a different search from
 * reading the inventory, and it had no tool. The skill says to search test
 * *contents* rather than paths, because a filename often contains no word from the
 * feature's name — a `:muted` pseudo-class change lives in
 * `css/selectors/media/sound-state.html`, while a path grep for "muted" lands on
 * `muted-playbackrate.tentative.html`, which is about playbackRate and unrelated.
 *
 * Searches in order of cost, cheapest first, because the cheap layers usually
 * answer it:
 *
 *   1. subtest names and assertion messages recorded in the diff  — free, local
 *   2. test paths                                                 — free, local
 *   3. test source                                                — --sources
 *
 * Layer 1 only exists if the diff was built with `wpt-diff.js --subtests`, and it is
 * the layer that would have found `getAnimations({ pseudoElement })`, whose subtest
 * is named "Returns animations on pseudo-element when it is specified".
 *
 * Usage:
 *   node wpt-grep.js <diff.json> <pattern> [options]
 *
 *   node wpt-grep.js diff.json pseudoElement
 *   node wpt-grep.js diff.json ':muted' --sources --include /css/selectors
 *   WPT_CHECKOUT=~/src/wpt node wpt-grep.js diff.json 'sound-state' --sources
 *
 * Options:
 *   --sources         also search test source. With a checkout that is a local read;
 *                     without one it fetches each candidate, so it is capped.
 *   --checkout <dir>  local WPT checkout to read instead of fetching. Defaults to
 *                     $WPT_CHECKOUT. Worth having only for this: the results the
 *                     rest of the toolkit downloads are not in the repo, so a
 *                     checkout saves nothing on the ~330MB reports.
 *   --include <p>     restrict to a path prefix (repeatable). Needed to keep
 *                     --sources bounded when there is no checkout.
 *   --max-fetch <n>   cap source fetches with no checkout (default 60)
 *   --limit <n>       max matches printed per layer (default 40)
 *   --case            case-sensitive (default is insensitive)
 *   --fixed           treat the pattern as a literal string, never a regex
 *
 * The pattern is a literal substring unless it looks like a regex (contains any of
 * \\ ( ) [ ] | + * ? ^ $), in which case it is compiled as one — and if that fails
 * to compile it falls back to a literal search with a note, because the obvious
 * thing to paste in is a fragment of an assertion message.
 */

const fs = require('fs');
const path = require('path');
const { netFetch } = require('./lib/net.js');
const { RAW, under, revisionResolver, sourceCandidates } = require('./lib/wpt.js');

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(msg ? 1 : 0);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) usage();

const opts = {
  file: null,
  pattern: null,
  sources: false,
  checkout: process.env.WPT_CHECKOUT || null,
  include: [],
  maxFetch: 60,
  limit: 40,
  caseSensitive: false,
  fixed: false,
};
const num = (flag, raw) => {
  const n = Number(raw);
  if (raw === undefined) usage(`missing value for ${flag}`);
  if (!Number.isFinite(n)) usage(`${flag} needs a number, got "${raw}"`);
  return n;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--sources': opts.sources = true; break;
    case '--checkout': opts.checkout = argv[++i]; break;
    case '--include': opts.include.push(argv[++i]); break;
    case '--max-fetch': opts.maxFetch = num(a, argv[++i]); break;
    case '--limit': opts.limit = num(a, argv[++i]); break;
    case '--case': opts.caseSensitive = true; break;
    case '--fixed': opts.fixed = true; break;
    default:
      if (a.startsWith('-')) usage(`unknown option ${a}`);
      else if (!opts.file) opts.file = a;
      else if (opts.pattern === null) opts.pattern = a;
      else usage(`unexpected argument ${a}`);
  }
}
if (!opts.file) usage('a diff.json path is required');
if (opts.pattern === null) usage('a search pattern is required');
if (!fs.existsSync(opts.file)) usage(`no such file: ${opts.file}`);

const REGEXY = /[\\()[\]|+*?^$]/;
const matcher = (() => {
  const literal = () => {
    const needle = opts.caseSensitive ? opts.pattern : opts.pattern.toLowerCase();
    return (s) => (opts.caseSensitive ? String(s) : String(s).toLowerCase()).includes(needle);
  };
  if (opts.fixed || !REGEXY.test(opts.pattern)) return literal();
  try {
    const re = new RegExp(opts.pattern, opts.caseSensitive ? '' : 'i');
    return (s) => re.test(String(s));
  } catch (err) {
    // The obvious thing to search for is a snippet out of an assertion message,
    // and those are full of parens and braces. Falling back to a literal search is
    // what was meant; erroring out on `getAnimations({ pseudoElement` would not be.
    // Announced, so a genuine regex typo isn't quietly reinterpreted.
    process.stderr.write(
      `note: pattern is not a valid regex (${err.message}) — searching for it literally.\n` +
        `      Pass --fixed to skip regex interpretation entirely.\n`,
    );
    return literal();
  }
})();

const clip = (s, n) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** Print a bounded list, and say plainly when it was bounded. */
function emit(rows) {
  const shown = opts.limit > 0 ? rows.slice(0, opts.limit) : rows;
  for (const r of shown) console.log(r);
  if (shown.length < rows.length) {
    console.log(`  ... and ${rows.length - shown.length} more (--limit 0 for all)`);
  }
}

const report = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
let tests = report.tests.filter((t) => t.kind !== 'unchanged');
if (opts.include.length) {
  tests = tests.filter((t) => opts.include.some((p) => under(t.test, p)));
}

console.log(`# Searching ${report.before.spec} -> ${report.after.spec} for ${JSON.stringify(opts.pattern)}`);
console.log(`# ${tests.length} changed test file(s) in scope${opts.include.length ? ` (under ${opts.include.join(', ')})` : ''}`);

// ---------------------------------------------------------------------------
// 1. Subtest names and messages — free, and usually the answer.
// ---------------------------------------------------------------------------
const hasEvidence = tests.some((t) => t.subtests);
console.log(`\n## Subtest names and messages`);
if (!hasEvidence) {
  console.log('  (this diff has no subtest names — regenerate with --subtests, or this');
  console.log('   layer cannot answer anything)');
} else {
  const hits = [];
  for (const t of tests) {
    if (!t.subtests) continue;
    for (const [list, sign] of [[t.subtests.newlyPassing, '+'], [t.subtests.newlyFailing, '-']]) {
      for (const s of list) {
        if (!matcher(s.name) && !matcher(s.message || '')) continue;
        hits.push(`  ${sign} ${t.test}\n      ${clip(s.name, 96)}` +
          (s.message ? `\n      ${clip(s.message, 96)}` : ''));
      }
    }
  }
  if (!hits.length) console.log('  (no match)');
  else emit(hits);
}

// ---------------------------------------------------------------------------
// 2. Paths — free, and weak. A filename need not contain the feature's name.
// ---------------------------------------------------------------------------
console.log(`\n## Test paths`);
const pathHits = tests.filter((t) => matcher(t.test));
if (!pathHits.length) {
  console.log('  (no match — which is NOT evidence the feature is absent: a path often');
  console.log('   contains no word from the feature name)');
} else {
  emit(pathHits.map((t) => `  ${t.kind.padEnd(14)} ${t.test}`));
}

// ---------------------------------------------------------------------------
// 3. Source — the layer the skill actually asks for.
// ---------------------------------------------------------------------------
(async () => {
  if (!opts.sources) {
    console.log(`\n(--sources not given, so test source was not searched. That is the layer`);
    console.log(` that finds a feature whose name appears nowhere in a path or subtest name.)`);
    return;
  }

  console.log(`\n## Test source`);
  const resolveRevision = revisionResolver(report);

  if (opts.checkout) {
    const root = opts.checkout.replace(/^~(?=$|\/)/, process.env.HOME || '~');
    if (!fs.existsSync(root)) usage(`no such checkout: ${root}`);
    // A checkout sits at ONE revision, and the two runs are usually at different
    // ones, so say so rather than implying the source matches either side.
    console.log(`  checkout: ${root}`);
    console.log(`  NOTE: a checkout is at one revision; these runs are at ${report.before.wpt_revision}`);
    console.log(`        and ${report.after.wpt_revision}. Check out the relevant one for exactness.`);
    const hits = [];
    let missing = 0;
    for (const t of tests) {
      let text = null;
      for (const c of sourceCandidates(t.test)) {
        const abs = path.join(root, c);
        try {
          text = fs.readFileSync(abs, 'utf8');
          break;
        } catch { /* try the next candidate */ }
      }
      if (text === null) { missing++; continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matcher(lines[i])) hits.push(`  ${t.test}:${i + 1}\n      ${clip(lines[i], 96)}`);
      }
    }
    if (!hits.length) console.log('  (no match)');
    else emit(hits);
    if (missing) {
      console.log(`  note: ${missing} test(s) had no source in the checkout — generated`);
      console.log(`        variants, or the checkout is at a different revision.`);
    }
    return;
  }

  // No checkout: fetch, and be explicit about the bound rather than quietly
  // searching a subset. An unannounced cap here reads as "no match".
  const candidates = tests;
  const budget = opts.maxFetch > 0 ? Math.min(opts.maxFetch, candidates.length) : candidates.length;
  if (candidates.length > budget) {
    console.log(`  !! ${candidates.length} candidate files, fetching only the first ${budget}.`);
    console.log(`  !! A "no match" below covers ${budget} files, NOT all ${candidates.length}.`);
    console.log(`  !! Narrow with --include, raise --max-fetch, or use --checkout.`);
  } else {
    console.log(`  fetching ${budget} file(s) at the runs' revisions`);
  }
  const hits = [];
  let fetched = 0;
  let failed = 0;
  for (const t of candidates.slice(0, budget)) {
    const revision = resolveRevision(t.test) || 'master';
    let text = null;
    for (const c of sourceCandidates(t.test)) {
      try {
        const res = await netFetch(`${RAW}/${revision}/${c}`);
        if (res.ok) { text = await res.text(); break; }
      } catch { /* try the next candidate */ }
    }
    fetched++;
    if (text === null) { failed++; continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matcher(lines[i])) hits.push(`  ${t.test}:${i + 1}\n      ${clip(lines[i], 96)}`);
    }
  }
  if (!hits.length) console.log(`  (no match in ${fetched} file(s))`);
  else emit(hits);
  if (failed) console.log(`  note: ${failed} of ${fetched} could not be fetched`);
})().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
