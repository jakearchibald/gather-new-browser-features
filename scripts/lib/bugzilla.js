/**
 * Did this JavaScript feature actually ship in this Firefox? Asked so that the answer
 * cannot be a false negative.
 *
 * Why this exists
 * ---------------
 * `lib/test262.js` finds the JS features a comparison cannot see, and hands over a
 * test262 feature flag: `iterator-chunking`, `iterator-includes`,
 * `Iterator.prototype.join`. The worksheet then said "look the flag up in the browser's
 * release notes or Bugzilla". That instruction is a trap, and it was taken:
 *
 *   quicksearch=iterator-chunking        -> {"bugs":[]}
 *   quicksearch=iterator-includes        -> {"bugs":[]}
 *   quicksearch=Iterator.prototype.join  -> {"bugs":[]}
 *
 * Zero results for all three — every one of which shipped in Firefox 154. A flag name is
 * test262's vocabulary; Bugzilla's is prose, and Mozilla writes "Ship Iterator Chunking
 * proposal". So the search was guaranteed to find nothing, and an empty result reads
 * exactly like "it didn't ship". A real pass concluded precisely that: "I checked all five
 * against Bugzilla rather than taking that at face value, and none of them shipped."
 *
 * That is the same absence-of-evidence error the skill warns about everywhere else,
 * reached through a search box, and it is worse than the original miss: the feature was
 * surfaced, investigated, and then actively ruled out.
 *
 * Two independent queries, in that order of authority
 * ---------------------------------------------------
 * 1. **Enumerate what shipped.** One query for every bug whose per-release status flag
 *    `cf_status_firefox<N>` is `fixed` and whose summary starts "Ship". This is ground
 *    truth for "which proposals shipped in N", it needs no guess about wording, and it
 *    therefore CANNOT produce a keyword false negative. It is the primary source.
 * 2. **Corroborate per flag.** A summary word-search on a title derived from the flag
 *    (`iterator-chunking` -> "Iterator Chunking", or the proposal name features.txt
 *    already carries). This finds the bug history, which the enumeration does not.
 *
 * The second query can still fail to match. When it does the answer is UNKNOWN, never
 * "did not ship" — and the enumeration is printed in full alongside, so a reader can see
 * "Ship Iterator Chunking proposal" in the shipped list even if the derived title missed.
 *
 * Why the per-flag query alone would still mislead
 * ------------------------------------------------
 * A TC39 proposal has three bugs in Mozilla's tree, and two of them are the wrong answer:
 *
 *   [meta] Iterator includes proposal                       never resolved
 *   Implement iterator includes proposal                    FIXED, 152 Branch
 *   Ship Iterator Includes proposal                         FIXED, 154 Branch
 *
 * "Implemented" means it exists behind a pref; only the Ship bug means it is on by
 * default. Reading the first FIXED bug found gives "shipped in 152", which is wrong in
 * both directions at once. So the classification below keys on the per-release status
 * flag rather than on resolution or milestone, and reports an implemented-but-unshipped
 * feature as its own outcome.
 */

const { netFetch } = require('./net.js');

const REST = 'https://bugzilla.mozilla.org/rest/bug';
const SHOW = 'https://bugzilla.mozilla.org/show_bug.cgi?id=';

// Bugs whose summary starts here are the ones that flip a feature on by default.
const SHIP = /^ship\b/i;

/** Bugzilla's per-release status flag for a Firefox version. */
function statusField(version) {
  return `cf_status_firefox${version}`;
}

async function query(params) {
  const url = `${REST}?${new URLSearchParams(params)}`;
  const res = await netFetch(url);
  const json = await res.json().catch(() => null);
  if (!json || json.error) {
    throw new Error(
      `Bugzilla: ${(json && json.message) || `${res.status} ${res.statusText}`}`,
    );
  }
  return json.bugs || [];
}

const FIELDS = (version) =>
  ['id', 'summary', 'status', 'resolution', 'target_milestone', 'component', statusField(version)].join(',');

/**
 * Every "Ship …" bug marked fixed for this Firefox version.
 *
 * The primary source, because it asks the question in Bugzilla's own vocabulary instead
 * of guessing at it. "Ship" is matched as a substring — Bugzilla has no summary-prefix
 * operator — so `Shippable`, `shipping-product` and a pile of intermittent-test bugs
 * come back too; they are dropped here rather than shown, since a noisy list is one
 * nobody reads.
 */
async function shippedInVersion(version) {
  const bugs = await query({
    f1: statusField(version), o1: 'equals', v1: 'fixed',
    f2: 'short_desc', o2: 'substring', v2: 'Ship',
    include_fields: FIELDS(version),
  });
  return bugs
    .filter((b) => SHIP.test(b.summary) && b.resolution === 'FIXED')
    .sort((a, b) => a.summary.localeCompare(b.summary));
}

/** Every bug whose summary contains all the words of `title`. */
async function bugsMatching(title, version) {
  if (!title) return [];
  return query({
    f1: 'short_desc', o1: 'allwordssubstr', v1: title,
    include_fields: FIELDS(version),
  });
}

/**
 * Decide one feature's fate from its bugs.
 *
 * `outcome` is deliberately five-valued. Collapsing it to shipped/not-shipped is what
 * turned "I could not find a bug" into "it did not ship".
 */
function classify(bugs, shipped, version) {
  const field = statusField(version);
  const fixedHere = bugs.filter((b) => b[field] === 'fixed' && b.resolution === 'FIXED');
  const shipBug = fixedHere.find((b) => SHIP.test(b.summary));
  if (shipBug) return { outcome: 'shipped', bug: shipBug, bugs };
  // A ship bug fixed against a different release: shipped, but not in this one.
  const otherShip = bugs.find((b) => SHIP.test(b.summary) && b.resolution === 'FIXED');
  if (otherShip) return { outcome: 'shipped-elsewhere', bug: otherShip, bugs };
  if (fixedHere.length) return { outcome: 'changed-here', bug: fixedHere[0], bugs };
  // Implemented behind a pref is NOT shipped, and is the outcome most easily misread as
  // shipped — `Implement iterator includes proposal` is FIXED in 152 Branch.
  //
  // Which bug to cite matters here, because the title search returns a proposal's whole
  // history. Taking the first FIXED bug cited "Remove Error Stack Accessor Telemetry" as
  // the evidence that the feature was implemented, which is a fair conclusion drawn from
  // an unrelated cleanup bug. Prefer the wording Mozilla uses for the landing itself.
  const PREFER = [/\bimplement/i, /\benable/i, /\bpref/i, /\bsupport\b/i];
  const fixed = bugs.filter((b) => b.resolution === 'FIXED');
  if (fixed.length) {
    const pick = PREFER.reduce(
      (found, re) => found || fixed.find((b) => re.test(b.summary)),
      null,
    ) || fixed[0];
    return { outcome: 'implemented-not-shipped', bug: pick, bugs, fixedCount: fixed.length };
  }
  if (bugs.length) return { outcome: 'open-bugs-only', bug: bugs[0], bugs };
  // The one outcome that is NOT a finding. The enumeration is the fallback, and it is
  // printed whole precisely so this case is recoverable by eye.
  return { outcome: 'no-bug-found', bug: null, bugs, shippedCount: shipped.length };
}

/**
 * Check a list of test262 features against Bugzilla for one Firefox version.
 *
 * Returns `{ ok, version, shipped, findings }`, or `{ ok: false, error }`. Best-effort
 * like the horizon check itself: an unreachable Bugzilla must leave the boxes open, not
 * answer them.
 */
async function verifyFeatures(features, version, titleFor) {
  try {
    const shipped = await shippedInVersion(version);
    const findings = [];
    for (const feature of features) {
      const title = titleFor(feature);
      let bugs = [];
      let error = null;
      try {
        bugs = await bugsMatching(title, version);
      } catch (err) {
        error = String((err && err.message) || err);
      }
      findings.push({ feature, title, error, ...classify(bugs, shipped, version) });
    }
    return { ok: true, version, shipped, findings };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

const bugUrl = (id) => `${SHOW}${id}`;

module.exports = { statusField, shippedInVersion, bugsMatching, classify, verifyFeatures, bugUrl, SHIP };
