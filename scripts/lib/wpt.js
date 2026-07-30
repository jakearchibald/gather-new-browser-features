/**
 * WPT path and revision conventions, in one place.
 *
 * Each of these has been a bug at least once, in more than one copy: the
 * generated-variant list missed the `-module` and `shadowrealm-in-*` globals, the
 * prefix matcher swept `/domparsing` into `--include /dom`, and the revision
 * default read master instead of what the runs were tested at.
 */

const RAW = 'https://raw.githubusercontent.com/web-platform-tests/wpt';

/**
 * Strip the generated-variant suffixes and query strings that appear in results
 * but are not real files in the repo.
 *   /foo.any.worker.html?vp9  ->  foo.any.js
 *   /bar.https.any.html       ->  bar.https.any.js
 *   /baz.window.html          ->  baz.window.js
 *
 * A `.any.js` test generates one .html per global in its `// META: global=` line,
 * and tools/manifest/sourcefile.py keeps adding globals — worker-module,
 * sharedworker-module, serviceworker-module, window-module and six
 * shadowrealm-in-* variants all exist. Matching any single segment rather than a
 * fixed list stops each new global from silently 404ing.
 */
function toSourcePath(testPath) {
  let p = testPath.split('?')[0];
  p = p.replace(/\.any\.[^./]+\.html$/, '.any.js');
  p = p.replace(/\.any\.html$/, '.any.js');
  p = p.replace(/\.window\.html$/, '.window.js');
  p = p.replace(/\.worker\.html$/, '.worker.js');
  return p.replace(/^\//, '');
}

/**
 * Prefix match on a path boundary. A plain startsWith over-matches siblings:
 * `--include /dom` swept in `/domparsing` and `--include /webrtc` swept in
 * `/webrtc-stats`. Merely confusing for an include; for an exclude it *hides* —
 * `--exclude /html` would silently drop `/html-media-capture`.
 */
function under(test, prefix) {
  const p = `/${String(prefix).replace(/^\/+/, '')}`.replace(/\/+$/, '');
  return p === '' || test === p || test.startsWith(`${p}/`);
}

/**
 * Which WPT revision a given test should be read at, given a diff report.
 *
 * Reading master silently gives you whatever the test says today rather than what
 * produced the result you are describing. Between Firefox 151 and 152,
 * html/syntax/parsing/parse-processing-instruction.tentative.html is 200 at the
 * run's revision and 404 on master; a test that was *rewritten* rather than deleted
 * is worse, because it fetches fine and the example you copy is wrong.
 *
 * Prefers the full SHA out of results_url over the diff's shortened wpt_revision:
 * both resolve on raw.githubusercontent, but a full SHA cannot become ambiguous.
 */
function revisionResolver(report) {
  const shaFor = (side) => {
    const full = (String(report[side]?.results_url || '').match(/\/([0-9a-f]{40})\//) || [])[1];
    return full || report[side]?.wpt_revision || null;
  };
  const after = shaFor('after');
  const before = shaFor('before');
  const kinds = new Map((report.tests || []).map((t) => [t.test, t.kind]));
  return (testPath) => {
    // A `removed` test is gone from the compare side — and often from master too —
    // so it can only be read at the baseline revision.
    if (kinds.get(testPath) === 'removed') return before || after;
    return after || before;
  };
}

/** Source URL for a test path at a revision, with the .html fallback candidate. */
function sourceCandidates(testPath) {
  const candidates = [toSourcePath(testPath)];
  const literal = testPath.split('?')[0].replace(/^\//, '');
  if (!candidates.includes(literal)) candidates.push(literal);
  return candidates;
}

module.exports = { RAW, toSourcePath, under, revisionResolver, sourceCandidates };
