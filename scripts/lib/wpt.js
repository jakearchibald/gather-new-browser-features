/**
 * WPT domain vocabulary, in one place.
 *
 * Everything here was duplicated across scripts at some point, and each copy grew
 * its own bugs: the generated-variant list missed the `-module` and
 * `shadowrealm-in-*` globals, the prefix matcher swept `/domparsing` into
 * `--include /dom`, the revision default read master instead of what the runs were
 * tested at, and "did this move forward?" existed in three shapes that disagreed
 * about reftests. One definition each, imported everywhere.
 */

const RAW = 'https://raw.githubusercontent.com/web-platform-tests/wpt';

// wptreport's single-letter harness statuses.
const STATUS_NAMES = {
  O: 'OK', P: 'PASS', F: 'FAIL', S: 'SKIP', E: 'ERROR',
  N: 'NOTRUN', C: 'CRASH', T: 'TIMEOUT', PF: 'PRECONDITION_FAILED',
};

// Statuses that mean "the test file itself did not run cleanly". A file leaving
// this set is the strongest "a feature shipped" signal a diff produces: the
// harness previously aborted because the API was absent.
const HARNESS_ERROR = new Set(['E', 'C', 'T', 'N', 'PF']);

// A reftest reports its entire result as the harness status and contributes no
// subtests, so a status flip at 0/0 is a real rendering fix or regression.
const PASS_LIKE = new Set(['P', 'O']);
const FAIL_LIKE = new Set(['F']);

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
  // test262 and web-extension tests are generated wrappers whose .html exists only at
  // run time — the repo holds just the .js. Without these two lines every such test
  // cached an empty source: 118 of 118 under /third_party/test262 and 6 of 6 under
  // /web-extensions on one real diff, against 0 of the other 785. It went unnoticed
  // because the miss is recorded as an empty body rather than an error.
  //
  // It matters most exactly where it failed. test262 subtest names are all just
  // "Test", so the source is the only evidence there is — and it is the best evidence
  // in WPT, carrying a structured header:
  //   esid: sec-Intl.Locale.prototype.getCalendars
  //   description: Verifies the branding check for the "getCalendars" function ...
  //   features: [Intl.Locale,Intl.Locale-info]
  // `features:` names the proposal outright. This is the same directory the
  // --exclude /third_party postmortem is about: the tooling learned not to filter
  // test262 and never learned to read it.
  // The two conventions differ, and only checking the real repo shows it:
  //   third_party/test262/.../branding.test262.html -> branding.js        (.test262 dropped)
  //   web-extensions/browser.storage.extension.html -> ...extension.js    (.extension kept)
  // `.test262-module.html` is a third spelling, for test262 files that are modules.
  // Found only by re-collecting after fixing the first two and checking what was still
  // empty — which is the argument for the "no suffix family comes back 100% empty"
  // guard in selftest.js rather than a fixed list of known suffixes.
  p = p.replace(/\.test262(-module)?\.html$/, '.js');
  p = p.replace(/\.extension\.html$/, '.extension.js');
  return p.replace(/^\//, '');
}

/**
 * Prefix match on a path boundary. A plain startsWith over-matches siblings:
 * `--include /dom` swept in `/domparsing` and `--include /webrtc` swept in
 * `/webrtc-stats`, which is merely confusing for an include and actively hides
 * for anything that filters out.
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

/** Source URL candidates for a test path, with the literal .html as fallback. */
function sourceCandidates(testPath) {
  const candidates = [toSourcePath(testPath)];
  const literal = testPath.split('?')[0].replace(/^\//, '');
  if (!candidates.includes(literal)) candidates.push(literal);
  return candidates;
}

/** How a test file changed between the two runs. */
function classify(before, after) {
  if (!before) return 'added';
  if (!after) return 'removed';

  const deltaPass = after.pass - before.pass;
  const deltaTotal = after.total - before.total;

  const beforeBroken = before.status && HARNESS_ERROR.has(before.status);
  const afterBroken = after.status && HARNESS_ERROR.has(after.status);

  if (!beforeBroken && afterBroken) return 'newly-broken';
  if (beforeBroken && !afterBroken) return 'newly-running';

  if (deltaPass > 0) return 'improved';
  if (deltaPass < 0) return 'regressed';
  if (deltaTotal !== 0) return 'subtests-changed';
  if (before.status !== after.status) return 'status-changed';
  return 'unchanged';
}

/**
 * Which way a bare status flip went: 'fixed', 'broken', or 'other'.
 *
 * This is what makes reftest results visible. A reference test contributes no
 * subtests, so a rendering fix is FAIL 0/0 -> PASS 0/0 with deltaPass === 0 —
 * invisible to anything that ranks by subtest delta, which is most of a WPT diff.
 * In a typical Firefox stable->beta diff these are ~150 files and much of the
 * release's CSS work.
 */
function statusDirection(before, after) {
  if (!before || !after || before.status === after.status) return null;
  if (FAIL_LIKE.has(before.status) && PASS_LIKE.has(after.status)) return 'fixed';
  if (PASS_LIKE.has(before.status) && FAIL_LIKE.has(after.status)) return 'broken';
  return 'other';
}

/**
 * A test present on only one side is test-suite churn, not browser change: the two
 * runs are usually on different WPT revisions, so `added`/`removed` mean "this test
 * was written since" far more often than they mean anything about the browser.
 * Counting them as movement actively misleads — /css/css-viewport/zoom showed 34
 * changed files, of which 31 were simply new tests.
 */
function isChurn(r) {
  return r.kind === 'added' || r.kind === 'removed';
}

/** Did this file move forward? Covers reftests, which carry no subtests. */
function movedForward(r) {
  return !isChurn(r) &&
    (r.deltaPass > 0 || r.statusDirection === 'fixed' || r.kind === 'newly-running');
}

function movedBackward(r) {
  return !isChurn(r) &&
    (r.deltaPass < 0 || r.statusDirection === 'broken' || r.kind === 'newly-broken');
}

/** Was failing something, now passes everything: "last failures cleared". */
function completed(r) {
  return Boolean(
    r.before && r.after &&
    r.before.total > 0 && r.after.total > 0 &&
    r.before.pass < r.before.total && r.after.pass === r.after.total,
  );
}

/** Top-level WPT directory, used to aggregate per-feature-area. */
function areaOf(test) {
  const parts = test.replace(/^\//, '').split('/');
  // css/ and _mozilla/ etc. are broad; go two levels deep for those.
  if ((parts[0] === 'css' || parts[0] === '_mozilla') && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

/** Directory containing a test file, with a leading slash. */
function dirOf(test) {
  return `/${test.replace(/^\//, '').split('/').slice(0, -1).join('/')}`;
}

/** "OK 29/34", or "-" for a side where the test does not exist. */
function fmtSide(s) {
  if (!s) return '-';
  return `${STATUS_NAMES[s.status] || s.status || '?'} ${s.pass}/${s.total}`;
}

/** Collapse whitespace and cap length, with an ellipsis when cut. */
function clip(s, n) {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * Does this test path need shell quoting before it can be pasted into a command?
 *
 * 17% of the changed paths in one real comparison do — 63 of 380. A WPT variant
 * looks like `url-setters.any.html?exclude=(file|javascript|mailto)`, and in a shell
 * `?` is a glob wildcard, `(...)` a glob group and `|` a pipe. Unquoted, zsh reports
 * "no matches found" and the command never reaches node at all, so no script can
 * explain what went wrong.
 */
function needsQuoting(testPath) {
  return /[?()|*[\]$ \\'"&;<>]/.test(String(testPath));
}

/** The path as a single-quoted shell word, safe to paste. */
function shellQuote(testPath) {
  return `'${String(testPath).replace(/'/g, `'\\''`)}'`;
}

/**
 * An argument for a command we are printing for someone to run: quoted only if it
 * has to be.
 *
 * Not JSON.stringify, which was what several resume lines used. It quotes
 * unconditionally, so `--grep color` came back as `--grep "color"` — and the quotes
 * are not free. They are part of the raw command string the permission matcher sees,
 * which is the same mechanism that makes a correctly-quoted variant path prompt. So
 * unnecessary quotes turn a pre-approved command into a prompt for nothing.
 */
function shellArg(value) {
  const s = String(value);
  return needsQuoting(s) ? shellQuote(s) : s;
}

/**
 * Advice to print when a search value had to be quoted to reach us.
 *
 * Quoting a command's argument is what turns a pre-approved command into a permission
 * prompt, and both ways of getting there were seen on real passes:
 *
 *   --grep 'html5lib_url.html?file=webkit02'   the value genuinely needs quotes,
 *                                             because of the `?`
 *   wpt-grep.js 'popover=hint'                the value needs NO quotes at all —
 *                                             `=` is an ordinary character — and the
 *                                             quotes were added defensively
 *
 * The second is the one worth naming: defensive quoting costs a prompt for nothing.
 * `= - _ . /` never need quoting. Only `? ( ) | [ ] * $ ; < > & \` and whitespace do.
 *
 * `matches` counts how many changed tests a candidate selects, so the advice can say
 * what the cheaper value actually buys instead of asserting the values are equivalent.
 * Returns [] when the value was already fine, so callers can spread it unconditionally.
 */
function quotingAdvice(flag, value, matches = null) {
  const s = String(value);
  if (!needsQuoting(s)) return [];
  // The pieces left once every quote-forcing character is removed. The longest is the
  // best single substitute; a caller with a matcher can rank them by what they select.
  const pieces = s.split(/[?()|*[\]$\s\\'"&;<>]+/).filter((p) => p.length >= 4);
  const ranked = pieces
    .map((p) => ({ p, n: matches ? matches(p) : null }))
    .sort((a, b) => b.p.length - a.p.length);
  const lines = [
    `note: ${flag} ${JSON.stringify(s)} had to be quoted, which is enough on its own to`,
    '      stop the command being pre-approved — quoting satisfies the shell, not the',
    '      permission match. A value with none of  ? ( ) | [ ] * $ ; < > & \\  or spaces',
    '      needs no quotes and prompts for nothing.',
  ];
  if (ranked.length) {
    lines.push('      Unquoted alternatives from this same value:');
    for (const { p, n } of ranked.slice(0, 3)) {
      lines.push(`        ${flag} ${p}${n === null ? '' : `   (${n} changed test${n === 1 ? '' : 's'})`}`);
    }
  }
  return lines;
}

module.exports = {
  RAW, STATUS_NAMES, HARNESS_ERROR, PASS_LIKE, FAIL_LIKE,
  toSourcePath, under, revisionResolver, sourceCandidates,
  classify, statusDirection, isChurn, movedForward, movedBackward, completed,
  areaOf, dirOf, fmtSide, clip, signed, needsQuoting, shellQuote, shellArg, quotingAdvice,
};
