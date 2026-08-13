/**
 * What the vendor says shipped in this release, cross-referenced against the diff.
 *
 * Why this exists
 * ---------------
 * Every other source here starts from WPT and tries to name the feature. This one starts
 * from the feature and asks whether WPT saw it — the opposite direction, which is why it
 * catches two things nothing else can.
 *
 * On the 153->154 pass, `target_milestone=154 Branch` + `resolution=FIXED` filtered to the
 * `dev-doc-needed`/`dev-doc-complete` keywords gave 21 bugs: Mozilla's own flag for "a web
 * developer needs to be told about this". Two of them were missing from the notes, for
 * opposite reasons:
 *
 *   bug 2019332  RTCIceTransport.getSelectedCandidatePair() / onselectedcandidatepairchange
 *                IN the diff, as newly-passing IDL subtests, and missed. They sit inside
 *                idlharness.https.window.html?include=(RTCSessionDescription|…) — a huge
 *                harness file behind a metacharacter path, i.e. the hardest kind of row to
 *                read. A cross-check catches what a reader skimmed.
 *
 *   bug 1850288  Show path in JSON Viewer   (and bug 1685123, WebExtensions manifest sandbox)
 *                DevTools and WebExtensions have no WPT coverage at all, so nothing in a
 *                pass-rate diff will ever mention them. The bug tracker is the only source.
 *
 * A third outcome had to be added after getting one wrong, and it is the most useful of the
 * three. `:open` for <select> (bug 2048183) is FIXED with a dev-doc keyword, and its test
 * fails in BOTH runs — which was first reported as "no coverage, the bug is the only
 * source". Wrong: the feature is behind a pref in 154, so the failing test is CORRECT and
 * WPT was right. `resolution=FIXED` means landed, not enabled. Several of the 21 are like
 * this — `Implement progress() function behind pref`, `Enable CSS Typed OM by default in
 * Nightly` (0/1 in beta), line-clamp (218 of 300 still failing). So a bug whose tests exist
 * and still fail is reported as LANDED, NOT ENABLED, which stops it being written up.
 *
 * On the filter, honestly
 * -----------------------
 * The unfiltered milestone query is 3256 bugs across all products (1457 in Core alone, 121
 * components). That is not readable, and "every filter is somewhere a feature can hide" is
 * the rule this repo runs on — so the keyword subset is offered as a LEAD, in the same
 * category as directory clusters and shared vocabulary, and the other ~3235 are not thrown
 * away. They are stored whole and reachable by component or substring, locally, so the
 * boundary is navigable rather than silent. `dev-doc` tagging is done by hand and is
 * certainly incomplete; a real change without the keyword is in the census, not the boxes.
 */

const { identifierShaped } = require('./analyse.js');

const REST = 'https://bugzilla.mozilla.org/rest/bug';
const SHOW = 'https://bugzilla.mozilla.org/show_bug.cgi?id=';

// Mozilla's own marker for "this needs developer documentation". `-needed` becomes
// `-complete` once written, so both are the same signal at different stages and querying
// only one silently halves the list.
const DEV_DOC = 'dev-doc-needed,dev-doc-complete';

const FIELDS = 'id,summary,product,component,keywords,target_milestone,resolution';

/**
 * Words in a bug summary that could name a test or a subtest, split by how much a hit on
 * them is worth.
 *
 * `identifierShaped` alone is the wrong filter here, and subtly so. It is tuned for subtest
 * VOCABULARY, where a capitalised single word is noise because CSS test titles are
 * capitalised — so it rejects `Iterator` and `Select`, which in a bug summary are exactly
 * the API being named. Using it unchanged extracted zero tokens from "Ship Iterator Join
 * proposal" and "Implement :open pseudo class for Select elements", and zero tokens then
 * rendered as "NO diff evidence" — a claim of absence produced by not having looked, which
 * is the precise error this module exists to prevent.
 *
 * So: prose is stripped by name, what survives is a candidate, and candidates are graded.
 * A `strong` hit (an identifier, a hyphenated CSS name, a dotted member, or a capitalised
 * API-looking word) is evidence. A `weak` hit is a lead to confirm by eye — "Show path in
 * JSON Viewer" matches `public-key-credential-to-json.https.window.html` on `json` alone,
 * which is a coincidence, and reporting it as evidence would be worse than reporting
 * nothing.
 */
const SUMMARY_NOISE = new Set(`implement implment ship enable enabled enables set setting pref
prefs prefer default defaults nightly desktop android release users user support supported
add adds added change changed changes allow allows behind parsing parse proposal longhand
shorthand function functions value values property properties element elements attribute
attributes interface method methods remove removed removing update updated updating fix
fixed fixes make makes making show shows showing path paths general core when while with
from into that this these those what which have been being also only more most some other
into upon over under after before again still just like such than then them they their
should would could must may might will shall does done doesn't don't not and the for
box boxes case cases part parts type types name names test tests use used using work works
new old first last same both each all any one two three via per its
class classes pseudo pseudos level levels spec specs api apis mode modes state states
by default everywhere like`.split(/\s+/).filter(Boolean));

/**
 * Does the bug's own summary say the feature is not on for users?
 *
 * The reliable enablement signal, because it is stated rather than inferred: Mozilla writes
 * "behind pref", "in Nightly", "for nightly". `resolution=FIXED` plus a dev-doc keyword means
 * landed, NOT enabled — `Implement progress() function behind pref` is FIXED for 154 and no
 * developer can use it. Inferring the same thing from failing tests did not work (see
 * matchAgainstDiff), so this is deliberately narrow: it fires only on explicit wording, and
 * says nothing when there is none.
 */
const NOT_FOR_USERS = /\b(behind (?:a )?pref|behind (?:a )?flag|in nightly|for nightly|nightly[- ]only|early beta|disabled by default)\b/i;

function enablementFromSummary(summary) {
  const m = String(summary || '').match(NOT_FOR_USERS);
  return m ? m[0] : null;
}

function tokensFor(summary) {
  const cleaned = String(summary || '')
    .replace(/^\s*\[[^\]]*\]\s*/, '');   // leading [css-text-decor-4] spec tag
  // `:open` -> open, `progress()` -> progress, `RTCTransportStats.remote/localCertificateId`
  // -> both members. Slashes and parens are separators, not part of a name.
  const raw = cleaned.match(/[A-Za-z_$][\w$.-]*/g) || [];
  const strong = new Set();
  const weak = new Set();
  const consider = (tok) => {
    const t = tok.replace(/[.\-]+$/, '');
    if (t.length < 4) return;
    if (SUMMARY_NOISE.has(t.toLowerCase())) return;
    // Strong means unambiguously an identifier: camelCase, ALLCAPSthenLower, a hyphenated
    // CSS name, or a dotted member. A bare capitalised word does NOT qualify, and promoting
    // it was a measurable mistake — `Typed` (from "Enable CSS Typed OM") matched
    // /webrtc/RTCIceCandidate-constructor.html, `JSON` matched a webauthn toJSON test, and
    // `Select` produced 14 hits that BURIED the real finding, which is that WPT cannot see
    // `:open` for <select> at all. A false "found it" is worse than an honest "nothing".
    if (identifierShaped(t)) strong.add(t);
    else if (t.length >= 5) weak.add(t);
  };
  for (const t of raw) {
    consider(t);
    if (t.includes('.')) for (const part of t.split('.')) consider(part);
    if (t.includes('-')) consider(t.replace(/-/g, ''));
  }
  // A pref name is longer than the feature's test directory: the pref is
  // `layout.css.tree-counting-functions.enabled` and the tests are in
  // /css/css-values/tree-counting, so exact substring matching fails on one of the
  // release's headline features. Contribute the leading two segments of a 3+-segment
  // hyphenated name — as WEAK, because a prefix match is weaker evidence and is only
  // searched when the precise tokens found nothing.
  for (const t of [...strong]) {
    const parts = t.split('-');
    if (parts.length >= 3) {
      const prefix = parts.slice(0, 2).join('-');
      if (prefix.length >= 5 && !strong.has(prefix)) weak.add(prefix);
    }
  }
  return { strong: [...strong], weak: [...weak] };
}

/**
 * Does anything in the diff mention this bug's identifiers?
 *
 * Searched over subtest names as well as paths, because the vocabulary lives in the names:
 * `getSelectedCandidatePair` appears in a subtest and in no filename, which is how it was
 * missed. `unsearchable` is its own outcome — a summary that yields no candidate at all has
 * not been checked, and must never render as "not in the diff".
 */
function matchAgainstDiff(bug, changed, stillFailing = []) {
  const { strong, weak } = tokensFor(bug.summary);
  if (!strong.length && !weak.length) {
    return {
      tokens: [], weakTokens: [], hits: [], weakHits: [], failingHits: [], unsearchable: true,
    };
  }
  const find = (tokens) => {
    const lower = tokens.map((t) => t.toLowerCase());
    const out = [];
    for (const r of changed) {
      const names = [];
      if (r.subtests) {
        for (const key of ['newlyPassing', 'newlyFailing', 'changed']) {
          for (const sub of r.subtests[key] || []) names.push(sub.name || '');
        }
      }
      const haystack = `${r.test}\n${names.join('\n')}`.toLowerCase();
      const matched = lower.filter((t) => haystack.includes(t));
      if (!matched.length) continue;
      out.push({
        test: r.test,
        deltaPass: r.deltaPass,
        matched: matched.map((m) => tokens[lower.indexOf(m)]),
        subtest: names.find((n) => matched.some((t) => n.toLowerCase().includes(t))) || null,
      });
    }
    // Biggest movers first: a +2 on the right file beats a coincidental token in a big one.
    out.sort((x, y) => Math.abs(y.deltaPass) - Math.abs(x.deltaPass));
    return out;
  };
  // Gate the weak pass on strong HITS, not on strong tokens existing. Gating on tokens meant
  // a bug with precise tokens that matched nothing never fell back — so
  // "Set layout.css.tree-counting-functions.enabled" reported "NOT in the diff" while
  // /css/css-values/tree-counting sat right there, which is the exact false negative the
  // weak tier was added to close.
  const hits = find(strong);

  // Tests that exist and are NOT fully passing in the after run, matched on path. This is
  // the dimension that was missing, and its absence produced a confidently wrong finding:
  // `:open` for <select> is behind a pref in 154, so select-open-invalidation.html fails in
  // BOTH runs — WPT was right, and reporting it as "no coverage, the bug is the only source"
  // inverted the truth. A FIXED bug with a dev-doc keyword does not mean "enabled for
  // users": it can be landed behind a pref (`Implement progress() function behind pref`),
  // enabled for nightly only (`Enable CSS Typed OM by default in Nightly`, whose tests are
  // 0/1 in beta), or partly enabled (line-clamp, 218 of 300 still failing).
  //
  // So the diff can prove a changelog entry did NOT ship, which is the honest use of the
  // pairing and turns that false positive into a correct finding.
  // STRONG tokens only. Weak ones against 122k paths was hopeless — `alpha`, `Iterator` and
  // `remote` each matched hundreds of unrelated failing tests, so every bug came back
  // "landed, not enabled", including the three Iterator proposals that had demonstrably
  // shipped. Inverting the truth in that direction is no better than the false positive this
  // was meant to fix, so this is now context on a precise match, never a classification.
  const failingHits = matchPaths(strong, stillFailing).slice(0, 40);

  return {
    tokens: strong,
    weakTokens: weak,
    hits,
    weakHits: hits.length ? [] : find(weak),
    failingHits,
    unsearchable: false,
  };
}

/**
 * Match tokens against test PATHS only.
 *
 * Used for tests that did not change, where no subtest names were loaded — the summary gives
 * a path and a pass count and nothing else. Paths are a weak signal in general, which is why
 * the rest of this file prefers subtest names; here it is all there is, and "a test with this
 * name in it still fails" is a useful enough claim to be worth a weak match.
 */
function matchPaths(tokens, tests) {
  if (!tokens.length || !tests.length) return [];
  const lower = tokens.map((t) => t.toLowerCase());
  const out = [];
  for (const t of tests) {
    const path = t.test.toLowerCase();
    const matched = lower.filter((tok) => path.includes(tok));
    if (matched.length) out.push({ ...t, matched: matched.map((m) => tokens[lower.indexOf(m)]) });
  }
  return out.slice(0, 400);
}

async function query(netFetch, params) {
  const url = `${REST}?${new URLSearchParams({ ...params, include_fields: FIELDS, limit: '0' })}`;
  const res = await netFetch(url);
  const json = await res.json().catch(() => null);
  if (!json || json.error) {
    throw new Error(`Bugzilla: ${(json && json.message) || `${res.status} ${res.statusText}`}`);
  }
  return json.bugs || [];
}

/**
 * Fetch the release's fixed bugs and cross-reference the curated ones against the diff.
 *
 * Two queries, unioned: the milestone (where a fix landed) and the per-release status flag
 * (which also catches uplifts from an earlier branch). They returned the same 21 on the
 * pass that motivated this, but a uplift-heavy release would diverge and dropping either
 * would be a silent filter.
 */
async function fetchChangelog(netFetch, product, version, changedTests, stillFailing = []) {
  if (String(product).toLowerCase() !== 'firefox') {
    return {
      ok: false,
      unsupported: true,
      error: `Bugzilla milestones only describe Firefox, and this comparison is about ${product}`,
    };
  }
  try {
    const milestone = `${version} Branch`;
    const [all, curatedByMilestone, curatedByStatus] = await Promise.all([
      query(netFetch, { target_milestone: milestone, resolution: 'FIXED' }),
      query(netFetch, {
        target_milestone: milestone, resolution: 'FIXED',
        keywords: DEV_DOC, keywords_type: 'anywords',
      }),
      query(netFetch, {
        f1: `cf_status_firefox${version}`, o1: 'equals', v1: 'fixed',
        keywords: DEV_DOC, keywords_type: 'anywords',
      }),
    ]);

    const byId = new Map();
    for (const b of [...curatedByMilestone, ...curatedByStatus]) byId.set(b.id, b);
    const curated = [...byId.values()]
      .map((b) => ({
        id: b.id,
        summary: b.summary,
        product: b.product,
        component: b.component,
        milestone: b.target_milestone,
        url: `${SHOW}${b.id}`,
        notForUsers: enablementFromSummary(b.summary),
        ...matchAgainstDiff(b, changedTests, stillFailing),
      }))
      .sort((a, b) => (a.hits.length - b.hits.length)   // unmatched first: those are the gaps
        || a.component.localeCompare(b.component)
        || a.id - b.id);

    // The whole set, kept so the keyword filter is navigable rather than silent.
    const census = new Map();
    for (const b of all) {
      const key = `${b.product}/${b.component}`;
      if (!census.has(key)) census.set(key, []);
      census.get(key).push({ id: b.id, summary: b.summary });
    }

    return {
      ok: true,
      version,
      milestone,
      total: all.length,
      curated,
      census: [...census.entries()]
        .map(([key, bugs]) => ({ key, count: bugs.length, bugs }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = {
  fetchChangelog, tokensFor, matchAgainstDiff, matchPaths, enablementFromSummary,
  DEV_DOC, SHOW,
};
