/**
 * How far behind upstream test262 the WPT snapshot is — i.e. which JavaScript
 * features this comparison is structurally incapable of showing.
 *
 * Why this exists
 * ---------------
 * Every other blind spot in this toolkit is a *reading* failure: the signal was in
 * the data and someone stopped early, filtered it out, or read the wrong half. This
 * one is not. It is a hole in the data itself, and no amount of reading fixes it.
 *
 * Firefox 154 shipped three TC39 Iterator proposals — Iterator Chunking
 * (`Iterator.prototype.chunks` / `.windows`), Iterator Includes and Iterator Join.
 * The 153->154 release notes named none of them, and every tool here was right to
 * say nothing:
 *
 *   node scripts/wpt-grep.js Iterator            -> no match, in any of three layers
 *   node scripts/wpt-state.js --grep Iterator/prototype/chunks
 *                                                -> 0 test(s) whose path contains it
 *
 * WPT does not track test262. It *vendors* it, recording the upstream revision in
 * `third_party/test262/vendored.toml`, and re-vendors on a slow, manual cadence. On
 * the WPT revision both of those runs were tested at, that pointer was four months
 * stale — so `test/built-ins/Iterator/prototype/` contained drop, every, filter,
 * find, flatMap, forEach, map, reduce, some, take and toArray, and no chunks,
 * windows, includes or join. Zero tests, in either run, for three shipped features.
 *
 * That is worse than an ordinary gap, because the tooling's silence is
 * indistinguishable from "nothing shipped". `wpt-state.js` exists precisely so that
 * "not in the diff" never gets reported as "not shipped" — and it cannot help here,
 * since it answers from the same two summaries. The skill even told the reader where
 * to look ("JavaScript and Intl features live in third_party/test262"), which reads
 * as an assurance that looking there is sufficient. It is not.
 *
 * So the horizon becomes data. Two tiny files answer it exactly:
 *
 *   wpt @ <rev>:  third_party/test262/vendored.toml   -> the vendored test262 rev
 *   test262 @ <that rev> and @ main:  features.txt    -> the feature flags each has
 *
 * test262 requires every new proposal to register a feature flag in `features.txt`,
 * so a flag upstream has and the snapshot does not is a *proof* — not a heuristic —
 * that this comparison contains no test for that feature. `iterator-chunking`,
 * `iterator-includes` and `Iterator.prototype.join` all fall out of that one set
 * difference, by name, and the names are what a release note needs.
 *
 * The answer is a question, not a finding: WPT cannot say whether Firefox shipped
 * these, only that it did not test them. That is why each one becomes a checklist
 * box — the reader has to go to Bugzilla or the browser's own release notes and come
 * back with a verdict. An unanswerable question is still much better than a silent
 * one.
 *
 * Networked, so wpt-collect.js calls it and everything downstream reads the result
 * out of diff.json. Best-effort throughout: a release-notes pass must not fail
 * because GitHub was briefly unreachable, so failures are recorded as failures
 * rather than thrown, and never as an empty list of gaps.
 */

const { netFetch } = require('./net.js');

const RAW = 'https://raw.githubusercontent.com';
const API = 'https://api.github.com';
const WPT_REPO = 'web-platform-tests/wpt';
const T262_REPO = 'tc39/test262';

// Where WPT records which upstream test262 revision it vendored.
const VENDORED_TOML = 'third_party/test262/vendored.toml';

/** The upstream revision out of WPT's vendored.toml. */
function parseVendoredRev(toml) {
  const m = String(toml).match(/^\s*rev\s*=\s*["']([0-9a-f]{7,40})["']/mi);
  return m ? m[1] : null;
}

/**
 * test262's features.txt as a map of flag -> where it was declared.
 *
 * The file has two halves and a feature MOVES between them as it advances: proposals
 * at stage 3+ get a `# Name` / `# url` comment block above the flag, and on reaching
 * the published spec the flag is relisted, bare, in the alphabetical "Standard
 * language features" list. So a *line* diff of two revisions reports Temporal,
 * explicit-resource-management, Atomics.pause and canonical-tz as both removed and
 * added — four features that did nothing but graduate. Comparing the set of NAMES is
 * what the question actually asks, and it is the reason this is a parser rather than
 * a `diff`.
 */
function parseFeatures(text) {
  const features = new Map();
  const lines = String(text).split('\n').map((l) => l.trim());
  let section = null;
  let label = null;
  let url = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      // A blank line ends a proposal's comment block.
      label = null;
      url = null;
      continue;
    }
    // A section heading is a `##` line followed by the blurb that explains the
    // section. The lookahead is not fussiness: `##` also appears twice inside one
    // proposal's comment block upstream today, where a single `#` was meant —
    //
    //   # Source Phase Imports
    //   ## https://github.com/tc39/proposal-source-phase-imports
    //   source-phase-imports
    //   ## test262 special specifier
    //   source-phase-imports-module-source
    //
    // — so matching `##` alone files every later flag under a heading of a URL, and
    // then reports `Iterator.prototype.join` as a "test262 special specifier".
    if (/^##\s+\S/.test(line)) {
      const next = lines.slice(i + 1).find((l) => l !== '');
      if (next && next.startsWith('#')) {
        section = line.replace(/^##\s*/, '');
        label = null;
        url = null;
        continue;
      }
    }
    if (line.startsWith('#')) {
      const comment = line.replace(/^#+\s*/, '');
      if (/^https?:\/\//.test(comment)) url = url || comment;
      else if (!label) label = comment;
      continue;
    }
    // A feature flag, with an optional trailing `  # https://...` note.
    const name = line.replace(/\s+#.*$/, '').trim();
    if (!name) continue;
    if (!features.has(name)) features.set(name, { name, section, label, url });
  }
  return features;
}

/**
 * Feature flags `newer` declares and `older` does not, in `newer`'s order.
 *
 * Deliberately a name-set difference and nothing cleverer. There is no relevance
 * filter and no allowlist of interesting-looking names: this is the one place in the
 * toolkit where a missing entry cannot be recovered by reading harder, so a flag
 * whose feature turns out not to have shipped costs one line of checklist, and a
 * flag quietly dropped costs a feature.
 */
function newFeatures(older, newer) {
  const out = [];
  for (const [name, info] of newer) {
    if (!older.has(name)) out.push(info);
  }
  return out;
}

async function fetchText(url) {
  const res = await netFetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.text();
}

/** Committer date for a test262 revision, or null. Cosmetic, so never fatal. */
async function commitDate(rev) {
  try {
    const res = await netFetch(`${API}/repos/${T262_REPO}/commits/${rev}`);
    if (!res.ok) return null;
    const json = await res.json();
    return (json.commit && json.commit.committer && json.commit.committer.date) || null;
  } catch {
    return null;
  }
}

async function snapshotFor(wptRevision) {
  const toml = await fetchText(`${RAW}/${WPT_REPO}/${wptRevision}/${VENDORED_TOML}`);
  const rev = parseVendoredRev(toml);
  if (!rev) {
    throw new Error(
      `no rev = "..." in ${VENDORED_TOML} at wpt ${wptRevision} — the file's format may have changed`,
    );
  }
  const [features, date] = await Promise.all([
    fetchText(`${RAW}/${T262_REPO}/${rev}/features.txt`).then(parseFeatures),
    commitDate(rev),
  ]);
  return { wptRevision, rev, date, features };
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

/**
 * The JavaScript coverage horizon for a comparison.
 *
 * `beforeRevision`/`afterRevision` are the two runs' WPT revisions, which are
 * usually equal — one fetch then answers for both.
 *
 * Two distinct gaps come out of it, and the second one only exists when the runs
 * differ:
 *
 *   `missing`     flags upstream has and the AFTER run's snapshot does not. No test
 *                 for these ran in either browser, so the feature cannot appear in
 *                 any view of this comparison, at any pass rate.
 *   `revendored`  flags the after snapshot has and the before snapshot does not.
 *                 Their tests exist on one side only, so they classify as `added` —
 *                 which the collector pre-resolves as test-suite churn and the
 *                 inventory labels `<- all test-suite churn`. That is correct about
 *                 the mechanism and wrong about the consequence: the tests are new,
 *                 but a whole proposal's worth of them arriving is exactly the
 *                 signal a release note wants. This is the same shape as the
 *                 `--exclude /third_party` default that once hid the Intl.Locale
 *                 info proposal, reached by a different door.
 */
/**
 * Where a gapped feature's tests live UPSTREAM, and one or two of them in full.
 *
 * This closes the last hole, and it is a hole in the skill's central accuracy rule. Step 4
 * says every code example must be copied from a test that passed — "do not invent API
 * syntax", the single biggest accuracy win. For a past-the-horizon feature that rule is
 * unsatisfiable by construction: there is no test in the artifact, so the one instruction
 * that normally prevents invented syntax silently stops applying at exactly the moment you
 * are writing up three features you cannot verify. One pass wrote `chunks`/`windows` from
 * memory and only caught it afterwards, adding a "spec-derived" caveat by hand.
 *
 * But the tests are not missing — they are missing *here*. They exist upstream, and one
 * compare call finds them: every file added between the vendored revision and `main` comes
 * back with its patch, and a test262 test declares its flag in frontmatter:
 *
 *   features: [iterator-chunking, generators]
 *
 * so the flag maps to a directory with no guessing at all —
 * `iterator-chunking` -> `test/built-ins/Iterator/prototype/{chunks,windows}`. Fetching one
 * behavioural test from each gives a real, executed, spec-cited example to copy.
 *
 * The compare endpoint caps `files` at 300 and does not page (`page=2` returns none), so a
 * very stale snapshot can hide a flag's tests behind the cap. That is reported as
 * `truncated`, never as "no tests upstream" — and test262.fyi's per-flag count is the
 * cross-check, since it knows how many tests a flag has whether or not they are in this
 * response.
 */
const COMPARE_FILE_CAP = 300;

// Metadata tests make poor examples: `length.js` and `prop-desc.js` assert a property
// descriptor and show nothing a developer would write. Error-path tests are almost as bad.
// Prefer a test that demonstrates the feature doing its job.
function sampleScore(file) {
  const name = file.filename.split('/').pop();
  let score = 0;
  if (/^(length|name|prop-desc|descriptor|callable|not-a-constructor|proto)\.js$/.test(name)) score -= 10;
  if (/(abrupt|throws|not-a-number|out-of-range|no-coercion|invalid|failure)/.test(name)) score -= 5;
  const patch = file.patch || '';
  if (/assert\.compareArray|assert\.sameValue/.test(patch)) score += 2;
  if (/assert\.throws/.test(patch)) score -= 2;
  if (/function\*|yield/.test(patch)) score += 2;
  return score;
}

async function fetchUpstreamTests(vendoredRev, flagNames) {
  const wanted = new Set(flagNames);
  const out = {};
  try {
    const res = await netFetch(
      `${API}/repos/${T262_REPO}/compare/${vendoredRev}...main?per_page=100`,
    );
    if (!res.ok) throw new Error(`GET compare -> ${res.status} ${res.statusText}`);
    const json = await res.json();
    const files = json.files || [];
    const truncated = files.length >= COMPARE_FILE_CAP;

    const byFlag = new Map();
    for (const f of files) {
      if (f.status !== 'added' || !f.filename.startsWith('test/') || !f.patch) continue;
      const m = f.patch.match(/features:\s*\[([^\]]*)\]/);
      if (!m) continue;
      for (const raw of m[1].split(',')) {
        const flag = raw.trim();
        if (!wanted.has(flag)) continue;
        if (!byFlag.has(flag)) byFlag.set(flag, []);
        byFlag.get(flag).push(f);
      }
    }

    for (const flag of flagNames) {
      const found = byFlag.get(flag) || [];
      const dirs = [...new Set(found.map((f) => f.filename.replace(/\/[^/]*$/, '')))].sort();
      // One sample per directory, best-scoring, so `iterator-chunking` yields an example of
      // chunks AND of windows rather than two of the same method.
      const picks = dirs.map((d) => found
        .filter((f) => f.filename.startsWith(`${d}/`))
        .sort((a, b) => sampleScore(b) - sampleScore(a))[0]).filter(Boolean).slice(0, 2);
      const samples = [];
      for (const f of picks) {
        const url = `${RAW}/${T262_REPO}/main/${f.filename}`;
        try {
          const r = await netFetch(url);
          if (r.ok) samples.push({ path: f.filename, url, text: await r.text() });
        } catch { /* a sample is a bonus, never a failure */ }
      }
      out[flag] = { dirs, samples, truncated: truncated && !dirs.length };
    }
    return { ok: true, truncated, flags: out };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function fetchCoverageHorizon({ beforeRevision, afterRevision }) {
  try {
    const [head, headFeatures] = await Promise.all([
      commitDate('main').then((date) => ({ rev: 'main', date })),
      fetchText(`${RAW}/${T262_REPO}/main/features.txt`).then(parseFeatures),
    ]);

    const after = await snapshotFor(afterRevision);
    const before = beforeRevision === afterRevision ? after : await snapshotFor(beforeRevision);

    const strip = ({ features, ...rest }) => rest;
    const missing = newFeatures(after.features, headFeatures);
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      upstream: { repo: T262_REPO, ...head, features: headFeatures.size },
      before: strip(before),
      after: strip(after),
      sameSnapshot: before.rev === after.rev,
      lagDays: daysBetween(after.date, head.date),
      missing,
      revendored: before.rev === after.rev ? [] : newFeatures(before.features, after.features),
      // Real upstream tests for the gapped flags, so Step 4's "copy the example from a
      // passing test" survives the one case where the artifact has no test to copy.
      upstreamTests: missing.length
        ? await fetchUpstreamTests(after.rev, missing.map((f) => f.name))
        : null,
    };
  } catch (err) {
    // Recorded, not thrown, and never reported as "no gaps found": a collection run
    // is ~660MB of downloads and must not be lost to one unreachable small file. The
    // views read `ok` and say the check did not run, which is the one thing an
    // unchecked blind spot must never be able to look like.
    return { ok: false, error: String((err && err.message) || err), checkedAt: new Date().toISOString() };
  }
}

module.exports = {
  parseVendoredRev, parseFeatures, newFeatures, fetchCoverageHorizon,
  fetchUpstreamTests, sampleScore,
};
