/**
 * test262.fyi — real test262 results per engine, for the features WPT has no tests for.
 *
 * Why this exists alongside lib/bugzilla.js
 * -----------------------------------------
 * Bugzilla answers "which release turned this on", which is the question a release note
 * asks, and it answers it from a bug's status field rather than from anything executed.
 * That is a weaker kind of evidence than the rest of this toolkit runs on, and it was
 * added only because the WPT data for these features does not exist.
 *
 * test262.fyi runs the whole of test262 against engine builds at upstream HEAD and
 * publishes per-feature-flag pass counts. For a gapped flag that turns "no data anywhere"
 * into a measurement:
 *
 *   iterator-chunking          78/78   SpiderMonkey (default options)
 *   iterator-includes          44/44
 *   Iterator.prototype.join    18/18
 *   export-defer                0/0    <- no tests exist upstream at all
 *   error-stack-accessor       18/35
 *
 * Three things it gives that Bugzilla cannot:
 *
 *   - **Evidence rather than status.** 78/78 executed assertions is the kind of claim the
 *     notes are otherwise built from, and it makes a mistaken "it didn't ship" untenable
 *     on its own.
 *   - **The pref question, answered.** It runs each engine twice, with and without
 *     experimental options (`sm` and `sm_exp`). A feature passing only in `sm_exp` is
 *     flag-gated; passing in both means it is on in the default configuration. The skill
 *     otherwise has to state "nightly ≠ shipped, features may be behind a pref" and leave
 *     it there.
 *   - **Whether tests exist at all.** `total: 0` means the flag is registered upstream and
 *     nobody has written tests yet, which is the difference between "we cannot see it" and
 *     "there is nothing to see" — and it is what explains a Bugzilla lookup finding
 *     nothing for `export-defer`.
 *
 * And the reason it does NOT replace Bugzilla
 * -------------------------------------------
 * It tests one build per engine, and for Gecko that build is **nightly**: `meta.json`
 * reports `sm: 155.0a1` while this comparison is about 154 beta. There is no per-feature
 * history — `history.json` carries per-date engine versions but only whole-suite totals,
 * and no dated per-feature endpoint exists (`meta/<date>.json`, `features.json` and
 * `versions.json` are all 404). So it cannot say what 154 did, and nightly prefs are
 * exactly where Gecko enables things that beta and release do not.
 *
 * So the two sources answer different halves and are reported side by side: Bugzilla for
 * *which release*, test262.fyi for *does it work, and is it on by default*. Where they
 * disagree, that disagreement is printed rather than resolved — a feature Bugzilla calls
 * shipped that fails in default-config nightly is a finding, not a glitch to smooth over.
 */

const { netFetch } = require('./net.js');

const DATA = 'https://data.test262.fyi';

// wpt.fyi product -> the engine keys test262.fyi publishes. The `_exp` build is the same
// engine with experimental options, which is what makes the pref question answerable.
const ENGINES = {
  firefox: { key: 'sm', exp: 'sm_exp', engine: 'SpiderMonkey' },
  chrome: { key: 'v8', exp: 'v8_exp', engine: 'V8' },
  chromium: { key: 'v8', exp: 'v8_exp', engine: 'V8' },
  edge: { key: 'v8', exp: 'v8_exp', engine: 'V8' },
  safari: { key: 'jsc', exp: 'jsc_exp', engine: 'JavaScriptCore' },
};

function engineFor(product) {
  return ENGINES[String(product || '').toLowerCase()] || null;
}

/**
 * One feature's results for one engine, or null when the flag is not tracked.
 *
 * `prefGated` is the interesting derived bit: more tests pass with experimental options
 * than without, so the feature exists but is not on by default in the build tested.
 */
function featureResult(meta, flag, engine) {
  const f = meta.features && meta.features[flag];
  if (!f) return null;
  const total = f.total || 0;
  const pass = (f.engines && f.engines[engine.key]) || 0;
  const expPass = (f.engines && f.engines[engine.exp]) || 0;
  return {
    flag,
    total,
    pass,
    expPass,
    // No tests upstream at all. Not the same as a browser failing them, and the only
    // honest reading of a flag that exists with nothing behind it.
    noTests: total === 0,
    // Passes everything, without needing experimental options.
    fullyPassing: total > 0 && pass === total,
    // Needs the experimental build to pass more, i.e. flag-gated in the tested build.
    prefGated: total > 0 && expPass > pass,
  };
}

/**
 * Fetch test262.fyi's current per-feature results for a product's engine.
 *
 * Best-effort, like every other external lookup here: an unreachable site must leave the
 * boxes unanswered rather than answer them "no".
 */
async function fetchResults(features, product) {
  const engine = engineFor(product);
  if (!engine) {
    return { ok: false, notApplicable: true, error: `test262.fyi tracks no engine for "${product}"` };
  }
  try {
    const res = await netFetch(`${DATA}/meta.json`);
    if (!res.ok) throw new Error(`GET meta.json -> ${res.status} ${res.statusText}`);
    const meta = await res.json();
    const version = (meta.engines && meta.engines[engine.key]) || null;
    const results = {};
    for (const f of features) {
      const r = featureResult(meta, f.name, engine);
      if (r) results[f.name] = r;
    }
    return {
      ok: true,
      engine: engine.engine,
      // Labelled loudly as the build tested, because it is a NIGHTLY and the notes are
      // usually about beta or stable. Reading this as the release under discussion is the
      // one way this source can mislead.
      version,
      channel: 'nightly',
      test262Revision: (meta.test262 && meta.test262.revision) || null,
      generatedAt: (meta.times && meta.times.generatedAt) || null,
      tracked: Object.keys(results).length,
      results,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = { engineFor, featureResult, fetchResults, ENGINES };
