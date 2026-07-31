/**
 * WPT test sources, cached on disk at the revision the runs were tested at.
 *
 * Release notes need *accurate* code examples: guessing API syntax from a
 * directory name produces plausible-looking and often wrong snippets, so every
 * example should be copied from a test that actually changed state. That makes the
 * source a required input rather than an optional one, and wpt-collect.js fetches
 * it for every changed file up front so the writing step never waits on the
 * network.
 *
 * Reading `master` is the trap this exists to close. master is whatever the test
 * says *today*, not what produced the result being described. Between Firefox 151
 * and 152, html/syntax/parsing/parse-processing-instruction.tentative.html is 200
 * at the run's revision and 404 on master — and a test that was *rewritten* rather
 * than deleted is worse, because it fetches cleanly and the snippet you copy never
 * produced your result. So the cache is keyed by revision and the fetch always
 * pins one.
 */

const fs = require('fs');
const path = require('path');
const { netFetch } = require('./net.js');
const { RAW, sourceCandidates } = require('./wpt.js');

/**
 * Where a test's source lives inside the artifact directory.
 *
 * The WPT path becomes one flat filename rather than a nested tree: paths contain
 * `?query` variants that are not legal filenames on every platform, and a flat
 * directory is far cheaper to check for existence than walking a tree.
 */
function cacheName(testPath) {
  return `${testPath.replace(/^\//, '').replace(/[^A-Za-z0-9._-]/g, '_')}.txt`;
}

function cacheFile(dir, testPath) {
  return path.join(dir, cacheName(testPath));
}

/**
 * Fetch one test's source, trying the `.any.js` generator before the literal
 * `.html`. A `.any.js` test generates one .html per global, and only the .js file
 * has real content.
 */
async function fetchSource(testPath, revision) {
  for (const candidate of sourceCandidates(testPath)) {
    const url = `${RAW}/${revision}/${candidate}`;
    let res;
    try {
      res = await netFetch(url);
    } catch {
      continue; // try the next candidate
    }
    if (res.ok) return { candidate, url, text: await res.text() };
  }
  return null;
}

/**
 * Read a cached source, or null when it was never fetched or could not be.
 * The stored file keeps a two-line header naming the URL it came from, so a
 * snippet can always be traced back to an exact revision.
 */
function readCached(dir, testPath) {
  let raw;
  try {
    raw = fs.readFileSync(cacheFile(dir, testPath), 'utf8');
  } catch {
    return null;
  }
  const nl = raw.indexOf('\n\n');
  if (!raw.startsWith('# source: ') || nl === -1) return { url: null, text: raw };
  return { url: raw.slice('# source: '.length, raw.indexOf('\n')), text: raw.slice(nl + 2) };
}

/**
 * Fetch and cache the source of every test in `tests`.
 *
 * Bounded concurrency, not Promise.all over thousands of URLs: a two-release diff
 * changes ~2600 files, and opening that many sockets at once is throttled at best
 * and reported as a connection error at worst. Failures are counted rather than
 * thrown — generated variants and renamed tests legitimately have no source, and
 * losing the whole collection run over one 404 would be absurd.
 */
async function prefetchSources(dir, tests, revisionFor, { concurrency = 8, onProgress } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let fetched = 0;
  let cached = 0;
  let failed = 0;
  let index = 0;
  // Which ones failed, not just how many. A count cannot tell "a few renamed tests"
  // from "every generated wrapper of one type", and those need opposite responses.
  const failedPaths = [];

  const worker = async () => {
    for (;;) {
      const i = index++;
      if (i >= tests.length) return;
      const testPath = tests[i];
      const file = cacheFile(dir, testPath);
      if (fs.existsSync(file)) {
        cached++;
        continue;
      }
      const got = await fetchSource(testPath, revisionFor(testPath));
      if (got) {
        fs.writeFileSync(file, `# source: ${got.url}\n\n${got.text}`);
        fetched++;
      } else {
        // Record the miss, so a later read distinguishes "never tried" from
        // "tried and there is nothing there" without going back to the network.
        fs.writeFileSync(file, `# source: (not found)\n\n`);
        failed++;
        failedPaths.push(testPath);
      }
      if (onProgress && (fetched + failed) % 100 === 0) onProgress(fetched + failed + cached, tests.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tests.length) }, worker));
  return { fetched, cached, failed, failedPaths };
}

module.exports = { cacheFile, fetchSource, readCached, prefetchSources };
