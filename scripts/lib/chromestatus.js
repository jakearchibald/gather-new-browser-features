/**
 * Chrome Platform Status — the Chrome half of "did this JavaScript feature ship?".
 *
 * The Firefox adapter (lib/bugzilla.js) exists because WPT's vendored test262 is months
 * stale, so shipped JS features have no test on either side of a comparison and the notes
 * silently omit them. Nothing about that is Firefox-specific: `--from chrome@stable --to
 * chrome@beta` has exactly the same hole, and answering it with a Mozilla bug tracker is
 * obviously wrong. Hence one adapter per vendor, behind lib/shipped.js.
 *
 * chromestatus.com is the better-shaped source of the two. One public JSON endpoint
 * answers both halves at once:
 *
 *   Iterator helpers    status "Enabled by default", milestone 122
 *   Iterator Chunking   status "Proposed"
 *
 * `status.text` is the pref question and `status.milestone_str` is the release
 * attribution — where Bugzilla needs a "Ship <proposal>" bug plus a per-release status
 * flag to say the same thing.
 *
 * Two quirks worth knowing. The response is prefixed with `)]}'` as XSSI protection, so it
 * is not valid JSON until that line is stripped. And the search is over prose feature
 * names, so a test262 flag has to be turned into words first — `iterator-chunking` finds
 * nothing, exactly as it finds nothing in Bugzilla. That transformation is shared and
 * vendor-neutral, in lib/shipped.js's searchTitleFor.
 */

const { netFetch } = require('./net.js');

const API = 'https://chromestatus.com/api/v0/features';
const FEATURE = 'https://chromestatus.com/feature/';

// Google prefixes JSON responses with this to defeat cross-site script inclusion. It is
// not optional and not JSON.
const XSSI = ")]}'";

/**
 * `status.text` -> our shared outcome vocabulary.
 *
 * Unrecognised text maps to `unknown`, never to a negative. That default is the whole
 * lesson of the Firefox adapter: an inconclusive lookup that renders as "did not ship" is
 * worse than no lookup at all.
 */
function outcomeForStatus(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('enabled by default')) return 'enabled';
  if (t.includes('flag') || t.includes('trial')) return 'gated';
  if (t.includes('proposed') || t.includes('development') || t.includes('no active')) return 'not-shipped';
  if (t.includes('deprecat') || t.includes('remov')) return 'removed';
  return 'unknown';
}

async function search(title) {
  const res = await netFetch(`${API}?q=${encodeURIComponent(title)}`);
  if (!res.ok) throw new Error(`GET chromestatus -> ${res.status} ${res.statusText}`);
  let text = await res.text();
  if (text.startsWith(XSSI)) text = text.slice(XSSI.length);
  const json = JSON.parse(text);
  return json.features || [];
}

/**
 * One feature's fate in Chrome, in the shared vocabulary lib/shipped.js renders.
 *
 * The chromestatus entry comes back as `entry`, NOT `feature`. verifyFeatures spreads this
 * result over a record that already has `feature` — the test262 flag — and that is the key
 * the renderer matches on, so calling it `feature` here silently replaced every flag with
 * a chromestatus name and no Chrome finding ever matched its box.
 *
 * A JavaScript-category match is preferred over a merely name-matching one: the search is
 * full-text over summaries too, so "join" or "includes" can pull in unrelated entries.
 */
function classify(features, version) {
  if (!features.length) return { outcome: 'unknown', evidence: [] };
  const js = features.filter((f) => String(f.category || '').toLowerCase() === 'javascript');
  const f = (js.length ? js : features)[0];
  const chrome = (f.browsers || {}).chrome || {};
  const status = chrome.status || {};
  const milestoneStr = status.milestone_str;
  const milestone = /^\d+$/.test(String(milestoneStr)) ? Number(milestoneStr) : null;
  const base = outcomeForStatus(status.text);
  const evidence = [
    `chromestatus: "${f.name}" — ${status.text || 'no status'}`
      + (milestone ? `, milestone ${milestone}` : ''),
    `${FEATURE}${f.id}`,
  ];
  if (js.length === 0) {
    evidence.push('NOTE: no JavaScript-category match; this entry matched by text only, so');
    evidence.push('it may be a different feature. Confirm before using it.');
  }
  if (base !== 'enabled') return { outcome: base, evidence, entry: f, milestone };
  // Enabled by default — in which release?
  if (milestone === null) {
    return { outcome: 'shipped-unknown-version', evidence, entry: f, milestone };
  }
  if (version !== null && milestone > version) {
    // Enabled in a LATER milestone than the build under test, so not in this one.
    return { outcome: 'shipped-later', evidence, entry: f, milestone };
  }
  if (version !== null && milestone < version) {
    return { outcome: 'shipped-earlier', evidence, entry: f, milestone };
  }
  return { outcome: 'shipped', evidence, entry: f, milestone };
}

/** Check every feature, plus a note on how the lookup was framed. */
async function verifyFeatures(features, version, titleFor) {
  try {
    const findings = [];
    for (const feature of features) {
      const title = titleFor(feature);
      let result;
      try {
        result = classify(await search(title), version);
      } catch (err) {
        result = { outcome: 'error', evidence: [`chromestatus: ${String((err && err.message) || err)}`] };
      }
      findings.push({ feature, title, ...result });
    }
    return { ok: true, source: 'Chrome Platform Status', version, findings };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = { outcomeForStatus, classify, verifyFeatures, search };
