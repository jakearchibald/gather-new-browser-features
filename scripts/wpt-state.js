#!/usr/bin/env node
/**
 * Absolute pass/fail state of a test in BOTH runs — including the ~120k tests the
 * diff does not mention. Local: wpt-collect.js stored both full summaries.
 *
 * Why this exists: a diff can only show you what moved. A test that fails
 * identically in both runs is `unchanged` and legitimately absent from every other
 * view here, so "not in the diff" never means "not shipped" — and that distinction
 * was got wrong on a real pass. A `:muted` content-attribute question came back
 * "not in the diff", which was true and useless; the test exists, at
 * `css/selectors/media/sound-state.html`, and was failing in both runs.
 *
 * There are three answers, and only one of them is "it didn't ship":
 *   present and moved      -> the diff already told you
 *   present, same in both  -> unchanged; the feature's state is whatever it is
 *   no test at all         -> no WPT coverage; say that, not "didn't ship"
 *
 * Usage:
 *   node wpt-state.js <artifact-dir> <test-path>
 *   node wpt-state.js <artifact-dir> --grep <substring> [--limit <n>]
 *
 *   node wpt-state.js tmp/ff-153-vs-154 /css/selectors/media/sound-state.html
 *   node wpt-state.js tmp/ff-153-vs-154 --grep sound-state
 *   node wpt-state.js tmp/ff-153-vs-154 --grep 'Locale/prototype' --limit 0
 *
 * Options:
 *   --grep <s>    list every test whose path contains <s>, case-insensitive. Use
 *                 this first: a filename often does not contain any word from the
 *                 feature's name, so search broadly before concluding anything.
 *                 Grepping paths is a weak search — confirm against the source
 *                 with wpt-grep.js and wpt-fetch-tests.js.
 *   --limit <n>   max rows for --grep (default 40; 0 = all)
 *
 * Things with no WPT coverage at all, and so invisible here regardless: rendering
 * fixes with no reftest, "stopped working after several navigations"-style bugs,
 * event *ordering* changes where only the negative case is tested, and anything
 * whose spec has no tests yet. Absence of evidence is genuinely not evidence of
 * absence — say "no coverage", not "didn't ship", and point at Bugzilla.
 */

const fs = require('fs');
const { usage, num, unknownOption } = require('./lib/cli.js');
const artifact = require('./lib/artifact.js');
const { fmtSide, shellArg } = require('./lib/wpt.js');
const { grepFragment } = require('./lib/render.js');
const { readState } = require('./lib/summary.js');
const page = require('./lib/page.js');

const fail = (msg) => usage(__filename, msg);

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) usage(__filename);

const opts = { dir: null, path: null, grep: null, limit: 40, part: 1, all: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--grep': opts.grep = argv[++i]; break;
    case '--limit': opts.limit = num(fail, a, argv[++i]); break;
    case '--part': opts.part = num(fail, a, argv[++i]); break;
    case '--all': opts.all = true; break;
    default:
      if (a.startsWith('-')) fail(unknownOption(__filename, a));
      // A WPT test path always starts with "/" and is never a local directory.
      else if (a.startsWith('/') && !fs.existsSync(a)) opts.path = a;
      else if (!opts.dir) opts.dir = a;
      else if (!opts.path) opts.path = a;
      else fail(`unexpected argument ${a}`);
  }
}
if (!opts.path && !opts.grep) fail('need a test path (starting with "/") or --grep <substring>');

const { paths, report } = artifact.load(opts.dir, fail);
if (!fs.existsSync(paths.state)) {
  console.error(`error: no state.json.gz in ${paths.dir} — re-collect the comparison.`);
  process.exit(1);
}

const { before, after } = readState(paths.state);
// Built from product/channel rather than the spec label, which already carries a
// pinned version — "firefox@stable 153 153.0.1" reads like two different runs.
const label = (side) => {
  const s = report[side];
  return `${s.channel ? `${s.product}@${s.channel}` : s.product} ${s.browser_version}`;
};

console.log(`# Absolute state: ${label('before')} vs ${label('after')}`);
console.log(`# ${new Set([...before.keys(), ...after.keys()]).size} tests in both runs combined`);
console.log('');

if (opts.grep) {
  const needle = opts.grep.toLowerCase();
  const hits = [...new Set([...before.keys(), ...after.keys()])]
    .filter((t) => t.toLowerCase().includes(needle))
    .sort();
  console.log(`${hits.length} test(s) whose path contains "${opts.grep}"`);
  if (!hits.length) {
    console.log('');
    console.log('No test path matches. That is NOT evidence the feature is missing — a');
    console.log('filename often contains no word from the feature name. Try a shorter');
    console.log('substring, the interface name, or the spec directory, then search subtest');
    console.log('names and source with wpt-grep.js, and finally check Bugzilla.');
    process.exit(0);
  }
  console.log('');
  const shown = opts.limit > 0 ? hits.slice(0, opts.limit) : hits;
  // Paged: `--grep / --limit 0` matches all ~120k tests and produced 16MB before
  // this, five hundred times what a tool result holds. The harness truncates that
  // with no marker, so "no more matches" and "cut off here" looked identical.
  const blocks = shown.map((t) => {
    const b = before.get(t);
    const a = after.get(t);
    const moved = b && a && (b.pass !== a.pass || b.total !== a.total || b.status !== a.status);
    return {
      lines: [`  ${fmtSide(b).padEnd(18)} -> ${fmtSide(a).padEnd(18)} ${moved ? '(moved)  ' : '         '}${t}`],
    };
  });
  const resume = `node scripts/wpt-state.js --grep ${shellArg(opts.grep)}` +
    (opts.limit !== 40 ? ` --limit ${opts.limit}` : '');
  for (const line of page.render(blocks, {
    part: opts.part, all: opts.all, unit: 'tests', resume,
  }).lines) {
    console.log(line);
  }
  if (shown.length < hits.length) {
    console.log(`\n  ... and ${hits.length - shown.length} beyond --limit ${opts.limit} (--limit 0 for all)`);
  }
  process.exit(0);
}

const b = before.get(opts.path);
const a = after.get(opts.path);
console.log(`test     : ${opts.path}`);
console.log(`${label('before').padEnd(24)}: ${fmtSide(b)}`);
console.log(`${label('after').padEnd(24)}: ${fmtSide(a)}`);
console.log('');

if (!b && !a) {
  console.log('NOT IN EITHER RUN. Either the path is wrong (check the ?query variant, and');
  console.log('that .any.js tests are named e.g. foo.any.worker.html), or WPT has no test');
  console.log('for this. Search first:  --grep <substring>');
  console.log('If there is genuinely no test: report "no WPT coverage", never "did not ship".');
  process.exit(0);
}

if (b && a && b.pass === a.pass && b.total === a.total && b.status === a.status) {
  console.log('UNCHANGED between the two runs, so it is absent from the diff by design.');
  if (a.total > 0 && a.pass === a.total) {
    console.log('It passes fully in BOTH runs — already supported before this release.');
  } else {
    console.log('It fails the same way in BOTH runs — the diff cannot say whether the feature');
    console.log('is unimplemented or merely untested here. Check Bugzilla.');
  }
  process.exit(0);
}

console.log('MOVED between the runs. Read the cause:');
// paths.dir, not opts.dir — the latter is null whenever the artifact was defaulted,
// which printed "undefined" into a command the reader was meant to copy.
//
// --grep rather than the path, quoted or otherwise. A suggested command exists to be
// pasted, and a `?query` path does not survive being pasted: quoted it breaks the
// permission match, unquoted the shell globs it. The stem has neither problem.
console.log(`  node scripts/wpt-subtests.js --grep ${grepFragment(opts.path)}`);
console.log(`  (in ${paths.dir})`);
