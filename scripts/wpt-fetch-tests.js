#!/usr/bin/env node
/**
 * Print the source of WPT test files, from the cache wpt-collect.js populated at
 * the revision each run was tested at.
 *
 * Why this exists: release notes need *accurate* code examples. Guessing API
 * syntax from a directory name produces plausible-looking but wrong snippets. The
 * test that changed state is the ground truth for what actually works, so read it,
 * and copy the example from it. Every snippet in the notes should trace to a test
 * that now passes — this is the single biggest accuracy win available, because
 * spec-shaped guesses look plausible and are often wrong.
 *
 * Usage:
 *   node wpt-fetch-tests.js <artifact-dir> <test-path> [<test-path> ...]
 *   node wpt-fetch-tests.js <artifact-dir> --area <prefix> [--top <n>]
 *
 *   node wpt-fetch-tests.js tmp/ff-153-vs-154 /css/css-values/progress-computed.html
 *   node wpt-fetch-tests.js tmp/ff-153-vs-154 --area /webtransport --top 3
 *   node wpt-fetch-tests.js tmp/ff-153-vs-154 --area /fetch --head 80
 *
 * Options:
 *   --area <prefix>  with no explicit paths, print the biggest movers under this
 *                    prefix instead
 *   --top <n>        how many, with --area (default 5)
 *   --head <n>       print only the first n lines of each file (default 60;
 *                    0 = all). Use 0 when reading a file to identify a feature.
 *   --blocks         list the test-registering calls with line numbers and the
 *                    positional index the harness would auto-name them by, instead
 *                    of printing source. This is how you resolve a subtest called
 *                    "... 2" without piping source through grep and counting by eye.
 *
 * THE REVISION MATTERS, and the cache handles it. Reading `master` silently gives
 * you whatever the test says today rather than what produced the result you are
 * describing. Between Firefox 151 and 152,
 * html/syntax/parsing/parse-processing-instruction.tentative.html is 200 at the
 * run's revision and 404 on master, so a master-based fetch reports "could not
 * fetch" for a test that exists perfectly well. A test that was *rewritten* rather
 * than deleted is worse: it fetches fine and you copy a code example that never
 * produced the result in your notes. wpt-collect.js pins each file to the run it
 * belongs to — the `after` revision generally, the `before` revision for a test the
 * diff reports as `removed`.
 *
 * Note: .any.js tests generate several .html variants. Given "foo.any.worker.html"
 * the cache holds the underlying "foo.any.js", which is the file with the real
 * content.
 */

const fs = require('fs');
const { usage, num, unknownOption } = require('./lib/cli.js');
const artifact = require('./lib/artifact.js');
const { toSourcePath, under, clip } = require('./lib/wpt.js');
const { grepFragment } = require('./lib/render.js');
const { readCached } = require('./lib/sources.js');
const page = require('./lib/page.js');

const fail = (msg) => usage(__filename, msg);

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) usage(__filename);

const opts = {
  dir: null, area: null, grep: [], top: 5, head: 60, part: 1, all: false, blocks: false,
};
const paths = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    // --include and --area are the same thing. Four names for "narrow the selection"
    // across six scripts (--grep, --include, --area, --section) is what made a
    // reasonable guess fail; two names with one meaning each is the floor.
    case '--area':
    case '--include': opts.area = argv[++i]; break;
    // Path substring, same meaning as everywhere else. Its real value is dodging
    // shell metacharacters: a `?exclude=(a|b|c)` variant needs quoting to survive
    // the shell, and even quoted it still contains `|`, which is enough to stop the
    // command being pre-approved. --grep contains none of that.
    case '--grep': opts.grep.push(String(argv[++i] || '').toLowerCase()); break;
    case '--top': opts.top = num(fail, a, argv[++i]); break;
    case '--head': opts.head = num(fail, a, argv[++i]); break;
    case '--part': opts.part = num(fail, a, argv[++i]); break;
    case '--all': opts.all = true; break;
    case '--blocks': opts.blocks = true; break;
    default:
      if (a.startsWith('--')) fail(unknownOption(__filename, a));
      // A WPT test path always starts with "/" and is never a local directory.
      else if (a.startsWith('/') && !fs.existsSync(a)) paths.push(a);
      else if (!opts.dir) opts.dir = a;
      else paths.push(a);
  }
}

const { paths: art, report } = artifact.load(opts.dir, fail);

if (!fs.existsSync(art.sources)) {
  console.error(`error: no sources/ in ${art.dir} — it was collected with --no-sources.`);
  console.error('Re-collect without that flag to cache test source locally.');
  process.exit(1);
}

// Named paths and --grep matches are additive; --area/--top only auto-picks when
// neither was given, so a diff can still be supplied purely for context.
let targets = [...paths];
if (opts.grep.length) {
  const changed = report.tests.filter((t) => t.kind !== 'unchanged');
  for (const g of opts.grep) {
    const hits = changed.filter((t) => t.test.toLowerCase().includes(g));
    if (!hits.length) console.log(`!! no changed test path contains ${JSON.stringify(g)}`);
    for (const t of hits) if (!targets.includes(t.test)) targets.push(t.test);
  }
}
if (!targets.length) {
  let tests = report.tests.filter((t) => t.kind !== 'unchanged');
  if (opts.area) tests = tests.filter((t) => under(t.test, opts.area));
  if (!tests.length) fail(`no changed tests under ${opts.area || '(any)'}`);
  // Biggest absolute movers explain the area; dedupe by source file so the
  // .any.js variants of one test don't consume the whole budget.
  const seen = new Set();
  targets = [];
  for (const t of tests.sort((a, b) => Math.abs(b.deltaPass) - Math.abs(a.deltaPass))) {
    const src = toSourcePath(t.test);
    if (seen.has(src)) continue;
    seen.add(src);
    targets.push(t.test);
    if (targets.length >= opts.top) break;
  }
}

// Collapse variants sharing a source file. A `.any.js` test generates one .html per
// global, so `--grep no-vary-search` selects four paths that are all the SAME source
// — printing it four times is noise, and four times the output budget.
const bySource = new Map();
for (const t of targets) {
  const src = toSourcePath(t);
  if (!bySource.has(src)) bySource.set(src, []);
  bySource.get(src).push(t);
}
const collapsed = [...bySource.values()].filter((v) => v.length > 1);
targets = [...bySource.values()].map((v) => v[0]);
for (const group of collapsed) {
  console.log(`note: ${group.length} variants share one source; showing ${group[0]}`);
  for (const other of group.slice(1)) console.log(`      (also ${other})`);
}

// One block per file, paged: `--top 5 --head 0` reached 80KB, well past a tool
// result, and a truncated source listing is how a code example gets copied from a
// file you only half saw.
let missing = 0;
const blocks = [];
for (const t of targets) {
  const cached = readCached(art.sources, t);
  const lines = ['#'.repeat(70), `# ${t}`];
  if (cached && cached.url) lines.push(`# ${cached.url}`);
  lines.push('#'.repeat(70));
  if (!cached) {
    missing++;
    // The commonest reason a bare path misses is that the diff holds it only as `?query`
    // variants, so the bare string is not a cache key. The old message — "is this a changed
    // test in this comparison?" — pointed at the wrong conclusion, because it IS one: one
    // pass gave up on text-box-trim-start-001.html, which is in the diff 17 times. The
    // SKILL's --grep guidance is framed around shell quoting, so nothing connected it to
    // cache-key resolution either.
    const variants = report.tests
      .filter((r) => r.kind !== 'unchanged' && r.test.startsWith(`${t}?`))
      .map((r) => r.test);
    if (variants.length) {
      lines.push(`(this path is in the diff only as ${variants.length} ?query variant(s), so the bare`);
      lines.push(' path is not a cache key. Reach them all with:');
      lines.push(`   node scripts/wpt-fetch-tests.js ${artifact.rel(art.dir)} --grep ${grepFragment(t)}`);
      lines.push(` first variant: ${variants[0].slice(t.length)})`);
    } else {
      lines.push('(not in the cache — no changed test in this comparison has this path. Check');
      lines.push(' the spelling, or search for it:  node scripts/wpt-grep.js <fragment>)');
    }
  } else if (!cached.text.trim()) {
    missing++;
    lines.push('(no source at the run\'s revision — generated variant, or renamed since)');
  } else if (opts.blocks) {
    // Resolving a positional subtest name ("... 2") used to mean piping source
    // through grep and counting `test(` by eye — which is how
    // SVGAnimatedEnumeration-SVGTextPathElement.html's one newly-passing subtest was
    // read as `spacing` (the second-sounding block) when it was `side` (the third).
    // The arithmetic is the error-prone part, so do it here.
    const src = cached.text.replace(/\n$/, '').split('\n');
    const CALL = /^\s*(?:promise_|async_)?test\s*\(|^\s*subsetTestByKey\s*\(/;
    // A name literal on the same line means the harness does NOT auto-name it, and
    // only auto-named tests get the positional suffix.
    const NAMED = /["'`]/;
    let anon = 0;
    const rows = [];
    for (let i = 0; i < src.length; i++) {
      if (!CALL.test(src[i])) continue;
      const named = NAMED.test(src[i].replace(CALL, ''));
      const label = named ? '   (named)' : `   auto "…${anon === 0 ? '' : ` ${anon - 1}`}"`;
      rows.push(`  block ${String(rows.length + 1).padStart(3)}  line ${String(i + 1).padStart(4)}${label}  ${clip(src[i], 70)}`);
      if (!named) anon++;
    }
    if (!rows.length) {
      // "0 calls" followed by the numbering rules reads like an answer when it is
      // the absence of one. Many CSS files register every subtest through a helper
      // — test_valid_value(), test_computed_value() — so there is no bare test() to
      // count, and positional auto-naming does not apply to them at all.
      lines.push('No direct test() / promise_test() calls found.');
      lines.push('');
      lines.push('That does NOT mean the file has no subtests. CSS parsing files typically');
      lines.push('register everything through a helper — test_valid_value(),');
      lines.push('test_computed_value() — which passes an explicit name, so the positional');
      lines.push('auto-naming this flag resolves never applies. If you are chasing a');
      lines.push('"... 2" style name, it is not coming from this file; read the source with');
      lines.push('--head 0 and find the helper.');
    } else {
      lines.push(`${rows.length} test-registering call(s):`);
      lines.push(...rows);
      lines.push('');
      lines.push('Auto-named tests are numbered from the file title, zero-indexed AFTER the');
      lines.push('first: "Foo", "Foo 1", "Foo 2" — so "Foo 2" is the THIRD auto-named block.');
      lines.push('Only calls without a name literal are auto-named; (named) ones keep theirs.');
      lines.push('The name-literal test is a same-line heuristic — confirm against the source');
      lines.push('with --head 0 if a call spans several lines.');
    }
  } else {
    const src = cached.text.replace(/\n$/, '').split('\n');
    const shown = opts.head > 0 ? src.slice(0, opts.head) : src;
    if (shown.length < src.length) {
      lines.push(...shown);
      lines.push(`... (${src.length - shown.length} more lines; --head 0 for all)`);
    } else {
      // A single file can exceed the whole page budget on its own — one --head 0
      // listing hit 68KB. Splitting source by LINE RANGE is legitimate where
      // splitting subtests or directories is not: source is read linearly and a
      // line number is meaningful, so a range says exactly what it covers and what
      // follows. Each chunk becomes its own block, so pages break between chunks.
      let from = 0;
      while (from < shown.length) {
        const chunk = [];
        let size = 0;
        while (from + chunk.length < shown.length && size < page.DEFAULT_BUDGET - 2000) {
          const l = shown[from + chunk.length];
          chunk.push(l);
          size += l.length + 1;
        }
        const to = from + chunk.length;
        const head = from === 0 ? lines.slice() : [
          '#'.repeat(70),
          `# ${t}  — lines ${from + 1}-${to} of ${shown.length}`,
          '#'.repeat(70),
        ];
        const body = [...head, ...chunk];
        if (to < shown.length) body.push(`... (continues at line ${to + 1} of ${shown.length})`);
        body.push('');
        blocks.push({ lines: body });
        from = to;
      }
      continue;
    }
  }
  lines.push('');
  blocks.push({ lines });
}

// A resume command is printed to be pasted, so every path in it goes through --grep.
// Concatenating the paths bare produced a line that only worked for paths with no
// `?query` in them, and silently produced a broken command for the ones that had one.
const resume = [artifact.cmd('wpt-fetch-tests.js', art)]
  .concat(opts.area ? ['--area', opts.area] : [])
  .concat(opts.top !== 5 ? ['--top', String(opts.top)] : [])
  .concat(opts.head !== 60 ? ['--head', String(opts.head)] : [])
  .concat(opts.grep.flatMap((g) => ['--grep', g]))
  .concat(paths.flatMap((t) => ['--grep', grepFragment(t)]))
  .join(' ');
for (const line of page.render(blocks, {
  part: opts.part, all: opts.all, unit: 'files', resume,
}).lines) {
  console.log(line);
}

if (missing) {
  console.log(`!! ${missing} of ${targets.length} file(s) had no usable source.`);
}
