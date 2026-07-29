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
 *   --from-diff <f>  pick tests from a diff.json instead of listing them
 *   --area <prefix>  with --from-diff, restrict to this path prefix
 *   --top <n>        with --from-diff, take the n biggest movers (default 5)
 *   --head <n>       print only the first n lines of each file (default 60; 0 = all)
 *   --revision <r>   git ref to fetch from (default: master)
 *
 * Note: .any.js tests generate several .html variants. Given "foo.any.worker.html"
 * this fetches the underlying "foo.any.js", which is the file with the real content.
 */

const fs = require('fs');
const { netFetch } = require('./lib/net.js');

const RAW = 'https://raw.githubusercontent.com/web-platform-tests/wpt';

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(msg ? 1 : 0);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) usage();

const opts = { fromDiff: null, area: null, top: 5, head: 60, revision: 'master' };
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

/**
 * Strip the generated-variant suffixes and query strings that appear in results
 * but are not real files in the repo.
 *   /foo.any.worker.html?vp9  ->  /foo.any.js
 *   /bar.https.any.html       ->  /bar.https.any.js
 *   /baz.window.html          ->  /baz.window.js
 *
 * A `.any.js` test generates one .html per global in its `// META: global=` line,
 * and tools/manifest/sourcefile.py keeps adding globals — worker-module,
 * sharedworker-module, serviceworker-module, window-module and six
 * shadowrealm-in-* variants all exist. Matching any single segment rather than a
 * fixed list stops each new global from silently 404ing. fetchSource() still
 * falls back to the literal path, so a real file that happens to look like a
 * variant is not lost.
 */
function toSourcePath(testPath) {
  let p = testPath.split('?')[0];
  p = p.replace(/\.any\.[^./]+\.html$/, '.any.js');
  p = p.replace(/\.any\.html$/, '.any.js');
  p = p.replace(/\.window\.html$/, '.window.js');
  p = p.replace(/\.worker\.html$/, '.worker.js');
  return p.replace(/^\//, '');
}

async function fetchSource(testPath, revision) {
  const candidates = [toSourcePath(testPath)];
  // If we rewrote to a .js generator, keep the literal .html as a fallback.
  const literal = testPath.split('?')[0].replace(/^\//, '');
  if (!candidates.includes(literal)) candidates.push(literal);

  for (const candidate of candidates) {
    const url = `${RAW}/${revision}/${candidate}`;
    const res = await netFetch(url);
    if (res.ok) return { path: candidate, url, text: await res.text() };
  }
  return { path: candidates[0], url: null, text: null };
}

async function main() {
  let targets = paths;

  if (opts.fromDiff) {
    if (!fs.existsSync(opts.fromDiff)) usage(`no such file: ${opts.fromDiff}`);
    const report = JSON.parse(fs.readFileSync(opts.fromDiff, 'utf8'));
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
    targets = targets.concat(picked);
  }

  if (!targets.length) usage('no tests specified');

  for (const t of targets) {
    const { path: src, url, text } = await fetchSource(t, opts.revision);
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
