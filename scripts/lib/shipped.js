/**
 * "Did this JavaScript feature ship in this browser version?" — one question, one adapter
 * per vendor, and an explicit entry for the vendor that has no answer.
 *
 * Why a registry rather than a Bugzilla call
 * ------------------------------------------
 * The JS coverage horizon (lib/test262.js) is not a Firefox problem. WPT vendors test262
 * on a slow cadence, so for MONTHS of newly-shipped JS features there is no test on either
 * side of any comparison — and `--from chrome@stable --to chrome@beta` or
 * `safari@stable -> safari@experimental` hit that identically. The first version of this
 * resolved the gaps against Bugzilla unconditionally, which is right for Gecko and simply
 * wrong for the other two.
 *
 * Worse, it was wrong *quietly*: a Chrome comparison got "Bugzilla only tracks Firefox"
 * and an unanswered box, which reads as a shrug rather than as a missing capability. This
 * file makes the coverage a table you can look at:
 *
 *   firefox   Bugzilla                 per-release status flag + "Ship <proposal>" bug
 *   chrome    Chrome Platform Status   status.text + status.milestone_str, one JSON call
 *   safari    NOTHING MACHINE-READABLE see below
 *
 * On Safari, which is a real gap and not an oversight
 * --------------------------------------------------
 * bugs.webkit.org IS a Bugzilla and its REST API works, so the temptation is to point the
 * Firefox adapter at it. That produces confident nonsense. Checked, on the same features:
 *
 *   - It has NO per-release status flags. `/rest/field/bug` offers `bug_status` and
 *     `status_whiteboard` and nothing resembling `cf_status_firefox154`, so there is no
 *     field that says which Safari a fix rode out in.
 *   - Its quicksearch is much noisier. "Iterator chunking" returns a 2015 Web Inspector
 *     bug about array indices, which the Firefox adapter's logic would have happily
 *     classified from.
 *
 * WebKit's trunk is also not Safari: features land in WebKit months before a Safari
 * release, and Safari version to WebKit revision is not a public mapping. So the honest
 * outcome for Safari is `unsupported`, carrying the two places a human should look. It is
 * NEVER a "no" — that distinction is the entire reason this module exists.
 *
 * test262.fyi (lib/test262fyi.js) covers all three engines and is unaffected by any of
 * this, so a Safari comparison still gets "does it work, and is it on by default in the
 * tested build" — just not "which Safari".
 */

const bugzilla = require('./bugzilla.js');
const chromestatus = require('./chromestatus.js');

/**
 * The major version a wpt.fyi `browser_version` belongs to. "154.0b10" -> 154,
 * "141.0.7390.54" -> 141, "26.0" -> 26.
 */
function majorVersion(browserVersion) {
  const m = String(browserVersion || '').match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * The words a vendor is likely to have written, from a test262 feature flag.
 *
 * Vendor-neutral, and it lives here rather than in an adapter because BOTH of them need it:
 * Bugzilla and chromestatus alike search over prose feature names, so a flag matches nothing
 * in either. `iterator-chunking` returns zero results from both, for a feature Firefox
 * shipped in 154 — which is the mistake this whole module exists to stop.
 *
 * features.txt already carries the proposal's name for anything in its proposals section,
 * and that name is what vendors use nearly verbatim ("Iterator Join" -> "Ship Iterator Join
 * proposal"). Flags that have graduated to the alphabetical standard-features list have no
 * comment left, so the flag itself has to be turned back into prose.
 *
 * Never load-bearing on its own: it feeds the corroborating per-flag query, while the
 * enumerate-what-shipped query needs no guess about wording at all.
 */
function searchTitleFor(feature) {
  if (feature.label) return feature.label;
  const name = String(feature.name || '');
  // `Iterator.prototype.join` -> "Iterator join"; `Atomics.pause` -> "Atomics pause". The
  // dotted form is already prose-ish, so only the separators change, and `prototype` goes
  // because it appears in no bug summary.
  const words = name.includes('.')
    ? name.split('.').filter((s) => s && s !== 'prototype')
    : name.split(/[-_]/).filter(Boolean);
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Where each vendor's shipped-in-version answer comes from.
 *
 * `unsupported` is a first-class entry, not an absence. A vendor missing from this table
 * would fall through to a generic "not applicable" and look like a temporary glitch;
 * naming it, with the reason and the places to look instead, makes it a known limit.
 */
const SOURCES = {
  firefox: { source: 'Bugzilla', kind: 'bugzilla' },
  chrome: { source: 'Chrome Platform Status', kind: 'chromestatus' },
  chromium: { source: 'Chrome Platform Status', kind: 'chromestatus' },
  edge: { source: 'Chrome Platform Status', kind: 'chromestatus', note: 'Edge tracks Chromium; the milestone is Chromium\'s.' },
  safari: {
    source: null,
    kind: 'unsupported',
    why: 'WebKit\'s Bugzilla has no per-release status field, so nothing says which Safari a fix shipped in',
    lookAt: [
      'https://developer.apple.com/documentation/safari-release-notes',
      'https://webkit.org/blog/ (the "Release Notes for Safari Technology Preview" posts)',
    ],
  },
};

function sourceFor(product) {
  return SOURCES[String(product || '').toLowerCase()] || null;
}

/**
 * Normalise a vendor adapter's outcome into the vocabulary the renderer knows.
 *
 * Deliberately keeps `unknown` and `unsupported` apart from every negative. Collapsing
 * either into "did not ship" is the mistake that lost three Iterator proposals after they
 * had already been surfaced as boxes.
 */
const NOT_A_NO = new Set(['unknown', 'unsupported', 'error']);

function isNegative(outcome) {
  return !NOT_A_NO.has(outcome) && outcome !== 'shipped' && outcome !== 'shipped-earlier';
}

/**
 * Resolve every gapped feature for one product+version.
 *
 * Returns `{ ok, product, source, version, findings, extra }` where `findings` is one entry
 * per feature with a normalised `outcome`, and `extra` is whatever the adapter wants shown
 * once (Bugzilla's enumerated "Ship …" list, for instance).
 */
async function whatShipped(features, product, browserVersion) {
  const spec = sourceFor(product);
  const version = majorVersion(browserVersion);

  if (!spec) {
    return {
      ok: false,
      product,
      unsupported: true,
      error: `no shipped-in-version source is wired up for "${product}"`,
      lookAt: [],
    };
  }

  if (spec.kind === 'unsupported') {
    return {
      ok: false,
      product,
      unsupported: true,
      error: spec.why,
      lookAt: spec.lookAt || [],
      version,
    };
  }

  if (version === null) {
    return { ok: false, product, error: `could not read a major version from "${browserVersion}"` };
  }

  if (spec.kind === 'bugzilla') {
    const r = await bugzilla.verifyFeatures(features, version, searchTitleFor);
    if (!r.ok) return { ok: false, product, source: spec.source, error: r.error };
    return {
      ok: true,
      product,
      source: spec.source,
      version,
      note: spec.note || null,
      // The enumerated "Ship …" list: the part of the Bugzilla answer that needs no guess
      // about wording, and so the part that cannot produce a false negative.
      extra: r.shipped.map((b) => ({ id: b.id, summary: b.summary })),
      findings: r.findings.map((f) => ({
        feature: f.feature,
        title: f.title,
        outcome: normaliseBugzilla(f.outcome),
        evidence: bugzillaEvidence(f, version),
      })),
    };
  }

  const r = await chromestatus.verifyFeatures(features, version, searchTitleFor);
  if (!r.ok) return { ok: false, product, source: spec.source, error: r.error };
  return {
    ok: true,
    product,
    source: spec.source,
    version,
    note: spec.note || null,
    extra: [],
    findings: r.findings.map((f) => ({
      feature: f.feature,
      title: f.title,
      outcome: normaliseChrome(f.outcome),
      evidence: f.evidence,
    })),
  };
}

function normaliseBugzilla(outcome) {
  switch (outcome) {
    case 'shipped': return 'shipped';
    case 'shipped-elsewhere': return 'shipped-other-version';
    case 'changed-here': return 'changed-not-shipped';
    case 'implemented-not-shipped': return 'gated';
    case 'open-bugs-only': return 'not-shipped';
    case 'no-bug-found': return 'unknown';
    default: return 'unknown';
  }
}

function normaliseChrome(outcome) {
  switch (outcome) {
    case 'shipped': return 'shipped';
    case 'shipped-earlier': return 'shipped-earlier';
    case 'shipped-later': return 'shipped-other-version';
    case 'shipped-unknown-version': return 'shipped-other-version';
    case 'gated': return 'gated';
    case 'not-shipped': return 'not-shipped';
    case 'removed': return 'not-shipped';
    case 'error': return 'error';
    default: return 'unknown';
  }
}

function bugzillaEvidence(f, version) {
  const out = [];
  if (f.bug) {
    out.push(
      `bug ${f.bug.id}: "${f.bug.summary}" [${`${f.bug.status} ${f.bug.resolution || ''}`.trim()}, ${f.bug.target_milestone}]`,
      bugzilla.bugUrl(f.bug.id),
    );
  }
  if (f.outcome === 'no-bug-found') {
    out.push(`No bug matched "${f.title}". The wording probably missed, which is NOT a "no":`);
    out.push('searching for the flag name itself finds nothing for features that HAVE shipped.');
  }
  if (f.outcome === 'implemented-not-shipped') {
    out.push(`${f.fixedCount || 1} fixed bug(s) match and none is a "Ship ..." bug for Firefox ${version},`);
    out.push('so it is very likely still preffed off. The cited bug is the closest match by');
    out.push('wording, not proof: read it.');
  }
  return out;
}

module.exports = {
  SOURCES, sourceFor, whatShipped, isNegative, NOT_A_NO, majorVersion, searchTitleFor,
};
