#!/usr/bin/env node
/**
 * Fetch the source of WPT test files from GitHub.
 *
 * Why this exists: release notes need *accurate* code examples. Guessing API syntax
 * from a directory name produces plausible-looking but wrong snippets. The test that
 * changed state is the ground truth for what actually works, so read it.
 *
 * Usage:
 *   node wpt-fetch-tests.js <test-path> [<test-path> ...] [options]
 *   node wpt-fetch-tests.js --from-diff diff.json --area /fetch [options]
 *
 *   node wpt-fetch-tests.js /css/css-values/progress-computed.html
 *   node wpt-fetch-tests.js --from-diff diff.json --area /webtransport --top 3
 *   node wpt-fetch-tests.js --from-diff diff.json --area /fetch --head 60
 *
 * Options:
 *   --from-diff <f>  read the diff for revision context, and — when no explicit
 *                    paths are given — pick the biggest movers from it
 *   --area <prefix>  with --from-diff and no explicit paths, restrict the pick
 *   --top <n>        with --from-diff and no explicit paths, how many (default 5)
 *   --head <n>       print only the first n lines of each file (default 60; 0 = all)
 *   --revision <r>   git ref to fetch from. Default: the WPT revision the runs were
 *                    at, taken from the diff. Without a diff, master.
 *
 * READ THE REVISION THE RUN WAS AT, NOT master. The default used to be master,
 * which silently reads whatever the test says today rather than what produced the
 * result you are describing. That is not hypothetical: between Firefox 151 and 152,
 * html/syntax/parsing/parse-processing-instruction.tentative.html is 200 at the
 * run's revision and 404 on master, so the tool reported "could not fetch — the
 * test may be generated or renamed" for a test that exists perfectly well. A test
 * that was *rewritten* rather than deleted is worse: it fetches fine and you copy a
 * code example that never produced the result in your notes.
 *
 * Which side's revision depends on the test. A fix is read at the `after` revision;
 * a test the diff reports as `removed` only exists at `before`.
 *
 * Note: .any.js tests generate several .html variants. Given "foo.any.worker.html"
 * this fetches the underlying "foo.any.js", which is the file with the real content.
 */

const fs = require('fs');
const { netFetch } = require('./lib/net.js');
const { RAW, toSourcePath, revisionResolver, sourceCandidates } = require('./lib/wpt.js');

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(msg ? 1 : 0);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) usage();

// revision stays null until resolved: null means "derive it from the diff", which
// can only be done once the diff is loaded.
const opts = { fromDiff: null, area: null, top: 5, head: 60, revision: null };
const paths = [];
// Unvalidated Number() would turn a typo into a silently empty listing.
const num = (flag, raw) => {
  const n = Number(raw);
  if (raw === undefined) usage(`missing value for ${flag}`);
  if (!Number.isFinite(n)) usage(`${flag} needs a number, got "${raw}"`);
  return n;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--from-diff': opts.fromDiff = argv[++i]; break;
    case '--area': opts.area = argv[++i]; break;
    case '--top': opts.top = num(a, argv[++i]); break;
    case '--head': opts.head = num(a, argv[++i]); break;
    case '--revision': opts.revision = argv[++i]; break;
    default:
      if (a.startsWith('--')) usage(`unknown option ${a}`);
      paths.push(a);
  }
}

async function fetchSource(testPath, revision) {
  // Rewritten .js generator first, literal .html as a fallback.
  const candidates = sourceCandidates(testPath);

  for (const candidate of candidates) {
    const url = `${RAW}/${revision}/${candidate}`;
    const res = await netFetch(url);
    if (res.ok) return { path: candidate, url, text: await res.text() };
  }
  return { path: candidates[0], url: null, text: null };
}

async function main() {
  let targets = paths;
  let revisionFor = () => opts.revision || 'master';

  if (opts.fromDiff) {
    if (!fs.existsSync(opts.fromDiff)) usage(`no such file: ${opts.fromDiff}`);
    const report = JSON.parse(fs.readFileSync(opts.fromDiff, 'utf8'));

    if (!opts.revision) {
      const resolve = revisionResolver(report);
      revisionFor = (t) => resolve(t) || 'master';
    }

    // Only auto-pick when no paths were named. Concatenating both meant that
    // `--from-diff D /some/path` fetched that path *plus* five unrelated movers,
    // so a diff could not be supplied purely for revision context.
    if (!paths.length) {
      let tests = report.tests;
      if (opts.area) {
        const p = opts.area.replace(/\/$/, '');
        tests = tests.filter((t) => t.test === p || t.test.startsWith(p + '/'));
      }
      // Biggest absolute movers explain the area; dedupe by source file so the
      // .any.js variants of one test don't consume the whole budget.
      const seen = new Set();
      const picked = [];
      for (const t of tests.sort((a, b) => Math.abs(b.deltaPass) - Math.abs(a.deltaPass))) {
        const src = toSourcePath(t.test);
        if (seen.has(src)) continue;
        seen.add(src);
        picked.push(t.test);
        if (picked.length >= opts.top) break;
      }
      targets = picked;
    }
  } else if (!opts.revision) {
    process.stderr.write(
      `note: no diff given, so reading master. master is not necessarily what the runs\n` +
        `      were tested at — pass --from-diff <diff.json> to pin the revision, or\n` +
        `      --revision <sha> explicitly.\n`,
    );
  }

  if (!targets.length) usage('no tests specified');

  for (const t of targets) {
    const { path: src, url, text } = await fetchSource(t, revisionFor(t));
    console.log(`${'#'.repeat(70)}`);
    console.log(`# ${t}`);
    if (url) console.log(`# ${url}`);
    console.log(`${'#'.repeat(70)}`);
    if (text === null) {
      console.log(`(could not fetch — tried ${src}; the test may be generated or renamed)`);
    } else {
      const lines = text.split('\n');
      const shown = opts.head > 0 ? lines.slice(0, opts.head) : lines;
      console.log(shown.join('\n'));
      if (shown.length < lines.length) {
        console.log(`... (${lines.length - shown.length} more lines; --head 0 for all)`);
      }
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
