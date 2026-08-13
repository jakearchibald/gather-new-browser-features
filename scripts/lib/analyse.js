/**
 * The derived views that are computed once, at collection time, and stored in the
 * artifact: the subtest-level diff for each changed file, directory clusters, and
 * shared subtest vocabulary.
 *
 * All three exist for the same reason: ranking by subtest delta loses features.
 * The delta of a fix measures how many assertions happened to still be failing
 * beforehand, which has nothing to do with whether a feature shipped.
 */

/**
 * Which subtests changed state between two runs of one test file.
 *
 * NOTHING IS CAPPED except `stillFailing`, and that one is context rather than
 * evidence. An earlier version stored 25 names per file, which meant that reading
 * the full picture for a file required re-streaming two ~330MB reports — so the
 * expensive step was the one that named features, and it got skipped. Storing it
 * all costs about 10% of the subtests in changed files (the rest pass on both
 * sides and are only counted), and turns every later question into a local read.
 *
 * When the baseline has no subtests at all — a `newly-running` file that used to be
 * ERROR 0/0 — every passing subtest on the other side is newly passing. That case
 * is the strongest feature signal in a diff, so it must not come back empty.
 */
function subtestDelta(before, after, { stillFailingCap = 200 } = {}) {
  const bMap = before ? before.subtests : new Map();
  const aMap = after ? after.subtests : new Map();

  const newlyPassing = [];
  const newlyFailing = [];
  const changed = [];
  const removed = [];
  const stillFailing = [];
  let passingBoth = 0;

  const msg = (m) => (m ? String(m).replace(/\s+/g, ' ').trim().slice(0, 500) : null);

  // A file that could not run at all before has no baseline names to match
  // against, so every pass on the compare side is new.
  if (!bMap.size && aMap.size) {
    for (const [name, a] of aMap) {
      if (a.status === 'PASS') newlyPassing.push({ name, was: null, message: null, added: true });
      else stillFailing.push({ name, status: a.status, message: msg(a.message) });
    }
  } else {
    for (const [name, a] of aMap) {
      const b = bMap.get(name);
      if (!b) {
        // Present only on the compare side: a brand-new assertion. One that holds
        // is usually the feature, so it counts as newly passing — flagged, so the
        // per-file view can still show it as an addition rather than a fix.
        if (a.status === 'PASS') newlyPassing.push({ name, was: null, message: null, added: true });
        else newlyFailing.push({ name, now: a.status, message: msg(a.message), added: true });
        continue;
      }
      if (a.status === 'PASS' && b.status !== 'PASS') {
        // The message from the OLD failure is the interesting one: it names the cause.
        newlyPassing.push({ name, was: b.status, message: msg(b.message), added: false });
      } else if (b.status === 'PASS' && a.status !== 'PASS') {
        newlyFailing.push({ name, now: a.status, message: msg(a.message), added: false });
      } else if (a.status !== b.status) {
        changed.push({ name, was: b.status, now: a.status, message: msg(a.message) });
      } else if (a.status === 'PASS') {
        passingBoth++;
      } else {
        stillFailing.push({ name, status: a.status, message: msg(a.message) });
      }
    }
    for (const [name, b] of bMap) {
      if (!aMap.has(name)) removed.push({ name, was: b.status });
    }
  }

  return {
    newlyPassing,
    newlyFailing,
    changed,
    removed,
    // Context only, and the one list that can run to thousands on a large file.
    stillFailing: stillFailing.slice(0, stillFailingCap),
    counts: {
      newlyPassing: newlyPassing.length,
      newlyFailing: newlyFailing.length,
      changed: changed.length,
      removed: removed.length,
      stillFailing: stillFailing.length,
      passingBoth,
    },
  };
}

/**
 * Find directories where many test files moved the same way.
 *
 * Every other view ranks by magnitude — the sections print the top N by subtest
 * delta, the rollup sums into a shallow bucket (`html`, `third_party`) — so a
 * feature whose tests are numerous but individually tiny is invisible to all of
 * them. 13 files under the-select-element/customizable-select/ moved +1 or +3
 * each, summing to +22 inside `html`'s +453, and a shipped feature was missed.
 *
 * So rank by cluster *shape*: how many files in one directory moved, and how
 * one-sided that movement was. That does not depend on subtest counts.
 *
 * Nothing is excluded by path. test262 forms large one-sided clusters by
 * construction, which is tempting to filter out and is exactly the wrong call —
 * that is where JS and Intl features live, and its area rollup line
 * ("+118 subtests third_party") names nothing. Excluding it hides the clearest
 * signal in the diff: 40 files under intl402/Locale/prototype, all 0/1 -> 1/1.
 */
function findClusters(rows, minFiles, oneSidedRatio) {
  const clusters = new Map();
  for (const r of rows) {
    // A test present on only one side is test-suite churn from differing WPT
    // revisions, not browser movement. Counting it produced a top-5 "cluster"
    // for /svg/geometry/parsing, whose 23 files were 23 brand-new tests.
    const churn = r.kind === 'added' || r.kind === 'removed';
    const forward =
      !churn && (r.deltaPass > 0 || r.statusDirection === 'fixed' || r.kind === 'newly-running');
    const backward =
      !churn && (r.deltaPass < 0 || r.statusDirection === 'broken' || r.kind === 'newly-broken');
    const parts = r.test.replace(/^\//, '').split('/');
    // Credit every ancestor directory, so a cluster surfaces at whatever depth
    // it actually lives at rather than a depth hardcoded here.
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/');
      if (!clusters.has(dir)) {
        clusters.set(dir, {
          dir, depth, paths: new Set(), churn: 0, improved: 0, regressed: 0, deltaPass: 0,
        });
      }
      const c = clusters.get(dir);
      if (churn) { c.churn++; continue; }
      c.paths.add(r.test);
      c.deltaPass += r.deltaPass;
      if (forward) c.improved++;
      else if (backward) c.regressed++;
    }
  }

  const candidates = [...clusters.values()]
    .map((c) => ({ ...c, moved: c.paths.size }))
    .filter((c) => c.moved >= minFiles)
    // One-sided: most files moved the same way. A directory where things broke
    // about as often as they were fixed is noise, not a feature landing.
    .filter((c) => {
      const dominant = Math.max(c.improved, c.regressed);
      return dominant >= oneSidedRatio * c.moved && dominant >= minFiles;
    })
    .sort((a, b) => b.depth - a.depth);

  // Keep the most specific naming of a cluster: drop a directory once the
  // clusters already kept beneath it cover >=70% of its moved files, because
  // they say the same thing with better names. Deepest-first, so a descendant's
  // fate is settled before its ancestor is judged.
  //
  // This handles both shapes of redundancy. A single dominant child collapses a
  // chain (semantics -> forms -> the-select-element -> customizable-select to
  // just the leaf). Many scattered children collapse a vague top-level row:
  // "/css, 136 files improved" is not a lead, and the area rollup already says
  // it. A directory whose children do *not* cover it survives, which is why
  // /IndexedDB (28 concentrated files) still appears.
  const kept = [];
  for (const c of candidates) {
    const covered = new Set();
    for (const o of kept) {
      if (!o.dir.startsWith(`${c.dir}/`)) continue;
      for (const p of o.paths) covered.add(p);
    }
    if (covered.size < 0.7 * c.moved) kept.push(c);
  }

  return kept
    .map(({ paths, ...c }) => c)
    .sort((a, b) => b.moved - a.moved || Math.abs(b.deltaPass) - Math.abs(a.deltaPass));
}

// Words that appear in subtest names everywhere and name no feature.
const STOPWORDS = new Set([
  'test', 'tests', 'testing', 'the', 'and', 'for', 'with', 'without', 'when', 'then',
  'should', 'must', 'not', 'from', 'into', 'this', 'that', 'these', 'those', 'has',
  'have', 'are', 'was', 'were', 'been', 'be', 'is', 'it', 'its', 'in', 'on', 'of',
  'to', 'a', 'an', 'as', 'at', 'by', 'or', 'if', 'no', 'one', 'two', 'set', 'get',
  'value', 'values', 'valid', 'invalid', 'element', 'elements', 'property',
  'properties', 'attribute', 'attributes', 'interface', 'type', 'returns', 'return',
  'after', 'before', 'via', 'using', 'default', 'empty', 'same', 'different', 'new',
  'first', 'second', 'child', 'parent', 'html', 'css', 'idl', 'api', 'case', 'cases',
  // Harness idioms and generic web vocabulary that pass the shape test below but
  // name no feature: they showed up across 5-19 directories on a real diff.
  'cross-origin', 'same-origin', 'e.style', 'same-site', 'cross-site', 'user-agent',
  'top-level', 'non-empty', 'read-only', 'well-formed', 'used-value-equivalent',
]);

/**
 * Does this token look like a spec identifier rather than an English word?
 *
 * The point is to keep `pseudoElement`, `field-sizing`, `SVGLength` and
 * `innerHTML` while dropping `Transitions`, `Blob`, `Multiple` and `0.875` — all
 * of which appeared across 8+ directories on a real diff purely because CSS test
 * titles are capitalised.
 */
function identifierShaped(t) {
  if (/^[\d.\-]+$/.test(t)) return false;                   // 0.125, 1-2
  if (/[a-z][A-Z]/.test(t)) return true;                    // pseudoElement, innerHTML
  if (/^[A-Z]{2,}[a-z]/.test(t)) return true;               // SVGLength, RTCTransportStats
  if (/^[A-Z0-9]{3,}$/.test(t)) return true;                // WOFF2, ARIA
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(t)) return true; // field-sizing, light-dark
  if (/^[A-Za-z_$][\w$]{2,}\.[A-Za-z_$]/.test(t)) return true; // Element.attachShadow
  return false;
}

/**
 * Group changed files by the vocabulary of their newly-passing subtests.
 *
 * "One feature moves several areas" has been advice up to now, checked by eye.
 * With subtest names loaded it is mechanical: a token appearing in newly-passing
 * subtests across two or more directories is one feature showing up in several
 * places. `pseudoElement` in both /web-animations and /css/css-pseudo is one
 * change, not two, and grouping by directory can never see that.
 *
 * Only over newly-passing names, because a shared token among failures is usually
 * a shared precondition rather than a feature.
 */
function findVocabulary(rows, minDirs = 2) {
  const tokens = new Map();
  for (const r of rows) {
    if (!r.subtests) continue;
    const dir = r.test.replace(/^\//, '').split('/').slice(0, -1).join('/');
    const seen = new Set();
    for (const s of r.subtests.newlyPassing) {
      // camelCase and dotted identifiers are the interesting shapes: they are
      // how specs name properties and methods.
      for (const raw of String(s.name).split(/[^A-Za-z0-9_.$-]+/)) {
        const t = raw.replace(/^[.\-]+|[.\-]+$/g, '');
        if (t.length < 4) continue;
        const key = t.toLowerCase();
        if (STOPWORDS.has(key)) continue;
        if (!identifierShaped(t)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!tokens.has(key)) tokens.set(key, { token: t, dirs: new Set(), files: [] });
        const entry = tokens.get(key);
        entry.dirs.add(dir);
        entry.files.push(r.test);
      }
    }
  }
  return [...tokens.values()]
    .filter((t) => t.dirs.size >= minDirs)
    .map((t) => ({ token: t.token, dirs: [...t.dirs].sort(), files: t.files.slice(0, 12) }))
    .sort((a, b) => b.dirs.length - a.dirs.length || a.token.localeCompare(b.token));
}

/**
 * Group a list of subtests by the shape of their assertion message.
 *
 * The whole reason to read messages: "getComputedTiming() 26/41 -> 41/41" reads
 * like fifteen timing fixes, but all fifteen were `startTime expected 0 but got
 * undefined` — ONE missing property, asserted first in ten of those tests. "15
 * subtests fixed" and "1 property added, unblocking 15 tests" are different
 * release notes and only one is true.
 *
 * Takes any list, not just the newly-passing. Rolling up the *still-failing* ones
 * answers the other half of the question — what a feature still gets wrong — and
 * that was invisible while this only looked at fixes. On one real file, 48 of 57
 * still-failing subtests shared a single shape, which is the difference between
 * "some color-mix cases still fail" and "0%-sum mixes compute as transparent
 * black". Only the second is worth a line in the notes.
 */
function messageRollup(list) {
  const groups = new Map();
  for (const s of list || []) {
    if (!s.message) continue;
    // Normalise away test-specific values to spot a shared root cause, THEN
    // truncate. Truncating first left a dangling quote that the normaliser could
    // not match, so one root cause split into several near-identical groups.
    //
    // Long parenthesised bodies go too, and that one matters. These messages carry
    // the failing value inline — "Actual: color-mix(in hsl, red 60%, blue)
    // Expected: color-mix(in hsl, red 60%, blue 40%)" — so keying on the raw text
    // splits ONE bug across every colour space it was tested in. On a real file
    // that reported 32 groups topping out at 35x, while the actual dominant cause
    // was a single serialization bug accounting for 178. The rollup exists to tell
    // one bug from many and was doing the opposite.
    //
    // Collapsed innermost-outward, because these values nest:
    // "color-mix(in xyz-d65, color(srgb .1 .2 .3) 0%, color(...))" hides the space
    // name OUTSIDE the inner parens, so a single non-nested pass leaves
    // "color-mix(in xyz-d65, ...)" intact and the fragmentation survives.
    //
    // 10+ characters, so WPT's short "(number)"/"(string)" type annotations survive
    // — collapsing those would merge genuinely different type mismatches. The
    // trailing "Error: assert_*" clause is outside any parens and always survives,
    // which is what keeps distinct bugs apart: "lengths differ, expected N got N"
    // (a dropped percentage) never merges with "property N, expected N +/- N" (a
    // wrong computed value), even though both begin "Colors do not match".
    let flat = String(s.message);
    for (let pass = 0; pass < 8; pass++) {
      const next = flat.replace(/\([^()]{10,}\)/g, '⟪⟫');
      if (next === flat) break;
      flat = next;
    }
    const norm = flat
      .replace(/"[^"]*"/g, '"…"')
      .replace(/-?\d+(\.\d+)?/g, 'N')
      .replace(/⟪⟫/g, '(…)');
    const key = norm.length > 120 ? `${norm.slice(0, 119)}…` : norm;
    if (!groups.has(key)) groups.set(key, { message: key, count: 0, example: s.message });
    groups.get(key).count++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/**
 * Subtests that vanished and reappeared under a different name.
 *
 * This exists because of a real, inverted misreading. A file went 52/73 -> 73/73
 * with 20 subtests removed and 20 added, and was written up as "the test's own
 * restructuring, with one real fix" — dismissing 20 of 21 as churn. But the two runs
 * were at the SAME WPT revision, so the test source was byte-identical and no
 * restructuring was possible. The names embed the expected value:
 *
 *   removed:  ... from [auto] to [10px -20px] at (-1) should be [NaNpx NaNpx]
 *   added:    ... from [auto] to [10px -20px] at (-1) should be [-7.44px 22.56px]
 *
 * `text-decoration-inset: auto` had been computing to NaN and now computes to a real
 * length. Every one of those 21 subtests is that single fix. A renamed subtest at a
 * fixed revision is a *behaviour* change — the strongest possible kind — and reads
 * as churn only because "added"/"removed" are the same words used for test-suite
 * churn when the revisions differ.
 *
 * Pairs on the name with every number (and NaN) flattened, so the value that moved
 * is exactly what is allowed to differ.
 */
function detectRenames(subtests) {
  const key = (n) => String(n).replace(/NaN|-?\d+(?:\.\d+)?/g, 'N');
  const bucket = (list) => {
    const m = new Map();
    for (const s of list || []) {
      const k = key(s.name);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    return m;
  };
  const gone = bucket(subtests.removed);
  const fresh = bucket((subtests.newlyPassing || []).filter((s) => s.added)
    .concat((subtests.newlyFailing || []).filter((s) => s.added)));

  let paired = 0;
  const examples = [];
  for (const [k, before] of gone) {
    const after = fresh.get(k);
    if (!after) continue;
    paired += Math.min(before.length, after.length);
    if (examples.length < 3) examples.push({ was: before[0].name, now: after[0].name });
  }
  return { paired, examples };
}

module.exports = {
  subtestDelta, findClusters, findVocabulary, messageRollup, detectRenames, identifierShaped,
};
