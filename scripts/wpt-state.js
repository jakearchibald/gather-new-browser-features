#!/usr/bin/env node
/**
 * Absolute pass/fail state of a test in BOTH runs of a diff — including tests the
 * diff does not mention.
 *
 * Why this exists: a diff can only show you what moved. A test that fails
 * identically in both runs is `unchanged` and legitimately absent from every
 * other view here, so "not in the diff" never means "not shipped" — and that
 * distinction was got wrong on a real pass. A `:muted` content-attribute question
 * came back "not in the diff", which was true and useless; the test exists, at
 * `css/selectors/media/sound-state.html`, and was failing in both runs.
 *
 * There are three answers, and only one of them is "it didn't ship":
 *   present and moved      -> the diff already told you
 *   present, same in both  -> unchanged; the feature's state is whatever it is
 *   no test at all         -> no WPT coverage; say that, not "didn't ship"
 *
 * Usage:
 *   node wpt-state.js <diff.json> <test-path>
 *   node wpt-state.js <diff.json> --grep <substring> [--limit <n>]
 *
 *   node wpt-state.js diff.json /css/selectors/media/sound-state.html
 *   node wpt-state.js diff.json --grep sound-state
 *   node wpt-state.js diff.json --grep 'Locale/prototype' --limit 60
 *
 * Options:
 *   --grep <s>    list every test whose path contains <s>, case-insensitive.
 *                 Use this first: a filename often does not contain any word from
 *                 the feature's name, so search broadly before concluding
 *                 anything. Grepping paths is a weak search — confirm with
 *                 wpt-fetch-tests.js and the test source.
 *   --limit <n>   max rows for --grep (default 40; 0 = all)
 *
 * Reads the two summary blobs named in the diff, so it sees all ~120k tests
 * rather than the changed ones. Two ~20MB downloads.
 */

const fs = require('fs');
const zlib = require('zlib');
const { netFetch } = require('./lib/net.js');

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

const opts = { file: null, path: null, grep: null, limit: 40 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    const v = argv[++i];
    if (v === undefined) usage(`missing value for ${a}`);
    return v;
  };
  switch (a) {
    case '--grep': opts.grep = next(); break;
    case '--limit': {
      const raw = next();
      opts.limit = Number(raw);
      if (!Number.isFinite(opts.limit)) usage(`--limit needs a number, got "${raw}"`);
      break;
    }
    default:
      if (a.startsWith('-')) usage(`unknown option ${a}`);
      // An existing local file is the diff. "starts with /" cannot tell them apart,
      // because an absolute diff path starts with / as well.
      else if (fs.existsSync(a) && fs.statSync(a).isFile() && !opts.file) opts.file = a;
      else if (a.startsWith('/')) opts.path = a;
      else if (!opts.file) opts.file = a;
      else usage(`unexpected argument ${a}`);
  }
}
if (!opts.file) usage('a diff.json path is required');
if (!opts.path && !opts.grep) usage('need a test path (starting with "/") or --grep <substring>');

/** Same shape as wpt-diff.js: { "/test.html": { s: "O", c: [pass, total] } }. */
async function fetchSummary(url) {
  const res = await netFetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text =
    buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  const raw = JSON.parse(text);
  const out = new Map();
  for (const [test, v] of Object.entries(raw)) {
    if (Array.isArray(v)) out.set(test, { status: null, pass: v[0], total: v[1] });
    else out.set(test, { status: v.s, pass: v.c[0], total: v.c[1] });
  }
  return out;
}

const fmt = (r) => (r ? `${STATUS_NAMES[r.status] || r.status || '?'} ${r.pass}/${r.total}` : 'absent');

(async () => {
  const diff = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
  for (const side of ['before', 'after']) {
    if (!diff[side]?.results_url) {
      throw new Error(`${opts.file} has no ${side}.results_url — regenerate it with wpt-diff.js`);
    }
  }
  process.stderr.write('Downloading both summaries...\n');
  const [before, after] = await Promise.all([
    fetchSummary(diff.before.results_url),
    fetchSummary(diff.after.results_url),
  ]);

  const label = (side) => `${diff[side].spec} ${diff[side].browser_version}`;
  console.log(`# Absolute state: ${label('before')} vs ${label('after')}`);
  console.log('');

  if (opts.grep) {
    const needle = opts.grep.toLowerCase();
    const hits = [...new Set([...before.keys(), ...after.keys()])]
      .filter((t) => t.toLowerCase().includes(needle))
      .sort();
    console.log(`${hits.length} test(s) whose path contains "${opts.grep}"`);
    if (!hits.length) {
      console.log('');
      console.log('No test path matches. That is NOT evidence the feature is missing —');
      console.log('a filename often contains no word from the feature name. Try a shorter');
      console.log('substring, the interface name, or the spec directory before concluding');
      console.log('anything, then check Bugzilla.');
      return;
    }
    console.log('');
    const shown = opts.limit > 0 ? hits.slice(0, opts.limit) : hits;
    for (const t of shown) {
      const b = before.get(t);
      const a = after.get(t);
      const moved = b && a && (b.pass !== a.pass || b.total !== a.total || b.status !== a.status);
      console.log(`  ${fmt(b).padEnd(18)} -> ${fmt(a).padEnd(18)} ${moved ? '(moved)  ' : '         '}${t}`);
    }
    if (shown.length < hits.length) {
      console.log(`\n  ... and ${hits.length - shown.length} more (--limit 0 for all)`);
    }
    return;
  }

  const b = before.get(opts.path);
  const a = after.get(opts.path);
  console.log(`test     : ${opts.path}`);
  console.log(`${label('before').padEnd(24)}: ${fmt(b)}`);
  console.log(`${label('after').padEnd(24)}: ${fmt(a)}`);
  console.log('');

  if (!b && !a) {
    console.log('NOT IN EITHER RUN. Either the path is wrong (check the ?query variant, and');
    console.log('that .any.js tests are named e.g. foo.any.worker.html), or WPT has no test');
    console.log('for this. Search first:  --grep <substring>');
    console.log('If there is genuinely no test: report "no WPT coverage", never "did not ship".');
    return;
  }
  if (b && a && b.pass === a.pass && b.total === a.total && b.status === a.status) {
    console.log('UNCHANGED between the two runs, so it is absent from the diff by design.');
    const full = a.total > 0 && a.pass === a.total;
    console.log(
      full
        ? 'It passes fully in BOTH runs — already supported before this release.'
        : 'It fails the same way in BOTH runs — the diff cannot say whether the feature',
    );
    if (!full) console.log('is unimplemented or merely untested here. Check Bugzilla.');
    return;
  }
  console.log('MOVED between the runs — see the diff and wpt-subtests.js for the cause:');
  console.log(`  node scripts/wpt-subtests.js ${opts.file} ${JSON.stringify(opts.path)} --limit 0`);
})().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
