/**
 * Every human-readable view of a collected diff, in one module.
 *
 * wpt-collect.js writes these to disk at collection time; the analysis scripts
 * print filtered slices of the same functions on demand. One implementation, so a
 * directory read from `report.txt` and the same directory read through
 * `wpt-inventory.js --include` can never disagree.
 */

const {
  STATUS_NAMES, isChurn, movedForward, movedBackward, completed,
  dirOf, fmtSide, clip, signed, needsQuoting, shellQuote, toSourcePath,
} = require('./wpt.js');
const { messageRollup, detectRenames } = require('./analyse.js');
const { dirMarker, discount, VERDICT_LABEL } = require('./prefs.js');

function pct(n) {
  return `${(n * 100).toFixed(3)}%`;
}

/**
 * Auto-generated positional subtest names ("...Element 2") carry no meaning and
 * actively mislead: they are zero-indexed *after* the first, so " 2" is the THIRD
 * test() block. SVGAnimatedEnumeration-SVGTextPathElement.html's one newly-passing
 * subtest was "... SVGTextPathElement 2"; its blocks cover method, spacing and
 * side, and it was first read as `spacing` — the second-sounding one — when it was
 * `side`, the feature that shipped.
 */
function positionalName(name) {
  return / \d+$/.test(String(name));
}

/**
 * A message that names nothing. `assert_true: expected true got false` is the
 * canonical case: it tells you an assertion flipped and not one word about what.
 * A message earns its keep by containing an identifier — a camelCase word, a
 * dotted path, a CSS property or a quoted value.
 */
function messageNamesSomething(msg) {
  if (!msg) return false;
  const s = String(msg).replace(/^assert_\w+:?\s*/, '');
  return /[a-z][A-Z]|\w\.\w|[a-z]-[a-z]|["'][^"']{2,}["']|\(\)/.test(s);
}

/**
 * Does the loaded evidence identify the feature, or must the source be read?
 *
 * Measured, not guessed: a file is opaque when every one of its newly-passing
 * subtests is positionally named AND carries a message that names nothing. That is
 * exactly SVGAnimatedEnumeration-SVGTextPathElement.html and exactly NOT
 * getAnimations.html ("Returns animations on pseudo-element when it is
 * specified"), which an earlier path-shape heuristic flagged identically and
 * wrongly.
 */
function opaquelyNamed(r) {
  const np = r.subtests && r.subtests.newlyPassing;
  if (!np || !np.length) return true;
  return !np.some((s) => !positionalName(s.name) || messageNamesSomething(s.message));
}

/** Subtests whose names are positional, so a number must not be read as an index. */
function positionalSubtests(r) {
  const np = (r.subtests && r.subtests.newlyPassing) || [];
  return np.filter((s) => positionalName(s.name));
}

/**
 * The subtest names behind a file's movement, indented under its row.
 *
 * This is the whole reason the collector loads subtest names. Without them a
 * reader has to infer a feature from a path and then decide whether to spend a
 * separate lookup finding out — a decision made with the least information
 * available, and the one that lost `getAnimations({ pseudoElement })`, whose
 * subtest is named "Returns animations on pseudo-element when it is specified".
 * A verdict is nearly free once the name is on the line; it is separate,
 * skippable work when it is not.
 */
function evidenceLines(r, indent, cap = 4) {
  if (!r.subtests) return [];
  const out = [];
  const show = (list, total, label, msgLabel) => {
    for (const s of list.slice(0, cap)) {
      out.push(`${indent}${label} ${clip(s.name, 96)}`);
      // A positional name carries no meaning, so fall back to the message, which
      // for those files is usually the only identifier available.
      if (positionalName(s.name) && s.message) {
        out.push(`${indent}    ${msgLabel} ${clip(s.message, 96)}`);
      }
    }
    const hidden = total - Math.min(cap, list.length);
    if (hidden > 0) out.push(`${indent}${label} ... and ${hidden} more (wpt-subtests.js for all)`);
  };
  const { newlyPassing, newlyFailing, counts } = r.subtests;
  show(newlyPassing, counts.newlyPassing, '+', 'was:');
  show(newlyFailing, counts.newlyFailing, '-', 'now:');
  return out;
}

/** Group changed tests by directory, alphabetically, with per-directory tallies. */
function groupByDir(tests) {
  const byDir = new Map();
  for (const r of tests) {
    const dir = dirOf(r.test);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(r);
  }
  return [...byDir.entries()]
    .map(([dir, rows]) => ({
      dir,
      rows: rows.sort((a, b) => b.deltaPass - a.deltaPass || a.test.localeCompare(b.test)),
      deltaPass: rows.reduce((s, r) => s + r.deltaPass, 0),
      forward: rows.filter(movedForward).length,
      backward: rows.filter(movedBackward).length,
      completed: rows.filter(completed).length,
      churn: rows.filter(isChurn).length,
    }))
    // Alphabetical by path, NOT by size. Related directories read together, and
    // no directory is implicitly "more important" for being listed first.
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

function dirBits(g) {
  return [
    g.forward ? `${g.forward} fwd` : null,
    g.backward ? `${g.backward} back` : null,
    g.completed ? `${g.completed} done` : null,
    g.churn ? `${g.churn} new/gone` : null,
  ].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------
// The JavaScript coverage horizon
// ---------------------------------------------------------------------------

/**
 * One box path per gapped feature flag, stable across renders.
 *
 * Prefixed and colon-joined so it is a single whitespace-free token — the shape every
 * box parser here expects — and so it can never collide with a test path. It also has
 * to survive being pasted into a shell as a wpt-resolve.js key, so no flag character
 * may need quoting; `Iterator.prototype.join` and `iterator-chunking` are both fine,
 * since test262 flag names are drawn from letters, digits, `.`, `-` and `_`.
 */
function jsBoxPath(name) {
  return `test262-feature:${name}`;
}

/**
 * What Bugzilla said about one gapped feature, as a short parenthetical and a longer
 * explanation.
 *
 * Rendered ONTO the box rather than left for the reader to look up, because the lookup is
 * where this went wrong. The worksheet said "look the flag up in Bugzilla", and
 * `quicksearch=iterator-chunking` returns zero bugs for a feature that shipped — so all
 * three Iterator proposals were surfaced, investigated, and dismissed. A finding the
 * reader has to re-derive is a finding that can be re-derived wrongly.
 *
 * Two constraints on the short form, both mechanical. It must contain no em dash and no
 * space-surrounded hyphen, since `verdictOf` reads the first of those as the start of the
 * reader's verdict; and none of the words in NON_ANSWER, or the gate would reject an
 * otherwise good verdict on the strength of text the generator put there.
 */
function jsFinding(h, name) {
  const sh = h && h.shipped;
  const fyi = jsFyiLines(h, name);
  // Appended to whatever the outcome is: even a "not shipped" box benefits, since the next
  // reader may be writing it up for a later release.
  fyi.lines = [...fyi.lines, ...jsUpstreamLines(h, name)];
  if (!sh) {
    return fyi.lines.length ? { short: fyi.short || '', lines: fyi.lines } : null;
  }
  if (!sh.ok) {
    // Two very different reasons, and neither is a "no". `unsupported` is a known limit
    // with somewhere else to look; anything else is a transient failure.
    const lines = [`${sh.unsupported ? 'No release source' : 'Lookup failed'}: ${sh.error}.`,
      'This box is UNANSWERED, not answered "no".'];
    for (const url of sh.lookAt || []) lines.push(`  check by hand: ${url}`);
    return {
      short: sh.unsupported ? 'no release source, so UNKNOWN' : 'lookup failed, so UNKNOWN',
      lines: [...lines, ...fyi.lines],
    };
  }
  const f = sh.findings.find((x) => x.feature.name === name);
  if (!f) return fyi.lines.length ? { short: fyi.short, lines: fyi.lines } : null;

  const v = sh.version;
  const src = sh.source;
  const ev = f.evidence || [];
  switch (f.outcome) {
    case 'shipped':
      return {
        short: `SHIPPED in ${v}`,
        lines: [`SHIPPED in ${sh.product} ${v}, per ${src}. Write it up.`, ...ev, ...fyi.lines],
      };
    case 'shipped-earlier':
      return {
        short: `shipped before ${v}`,
        lines: [`On by default since an earlier release, so it is available in ${v} but is not`,
          'news for it. Check the milestone before claiming it as new.', ...ev, ...fyi.lines],
      };
    case 'shipped-other-version':
      return {
        short: `shipped, but not in ${v}`,
        lines: [`On by default, but attributed to a different version than ${v}. Read the`,
          'milestone before claiming it for this release.', ...ev, ...fyi.lines],
      };
    case 'gated':
      return {
        short: `not on by default in ${v}`,
        lines: ['It exists but is behind a flag or pref for this release. Implemented is NOT',
          'shipped: do not write it up as available.', ...ev, ...fyi.lines],
      };
    case 'changed-not-shipped':
      return {
        short: `changed in ${v}, not enabled`,
        lines: [`Something landed in ${v} but nothing that turns the feature on, so it is`,
          'probably still preffed off. Read the evidence.', ...ev, ...fyi.lines],
      };
    case 'not-shipped':
      return {
        short: 'not shipped',
        lines: [`${src} tracks it and does not have it on by default.`, ...ev, ...fyi.lines],
      };
    case 'error':
      return {
        short: 'lookup failed, so UNKNOWN',
        lines: ['This box is UNANSWERED, not answered "no".', ...ev, ...fyi.lines],
      };
    case 'unknown':
    default:
      return {
        // When test262.fyi has something to say here it is the deciding evidence, because
        // the release-attribution side found nothing at all.
        short: fyi.short || 'NOT FOUND, so UNKNOWN',
        lines: [`${src} returned nothing usable for this flag. That is NOT a "no" — the`,
          'search is over prose feature names, and a test262 flag name matches nothing even',
          'for features that have shipped. Weigh the measurement below and the enumerated',
          'list above, then answer.', ...ev, ...fyi.lines],
      };
  }
}

const jsBugUrl = (id) => `https://bugzilla.mozilla.org/show_bug.cgi?id=${id}`;

/**
 * Where to copy a gapped feature's code example from.
 *
 * Step 4's rule — every snippet traces to a passing test — is unsatisfiable for a
 * past-the-horizon feature using the artifact alone, and that is precisely when a snippet
 * gets written from memory with the same implied authority as one copied from source. The
 * tests exist upstream, so point at them by path and offer the sample the collector fetched.
 *
 * "Lookup truncated" and "no tests exist" are kept apart, because the compare endpoint caps
 * at 300 files and a stale snapshot can hide a flag behind that cap. test262.fyi's per-flag
 * count is the tiebreak: it knows how many tests a flag has regardless of the cap.
 */
function jsUpstreamLines(h, name) {
  const up = h && h.upstreamTests;
  if (!up || !up.ok) return [];
  const f = up.flags && up.flags[name];
  if (!f) return [];
  const fyi = h.fyi && h.fyi.ok && h.fyi.results && h.fyi.results[name];
  if (!f.dirs.length) {
    if (fyi && fyi.noTests) return [];      // nothing to point at; jsFyiLines already says so
    if (f.truncated) {
      return ['upstream tests: lookup truncated (the compare API caps at 300 files), so this',
        '  is NOT "no tests upstream". Search tc39/test262 for the flag in test frontmatter.'];
    }
    return [];
  }
  const out = [`upstream tests: ${f.dirs.join(', ')}`,
    '  There is no test HERE to copy an example from, so copy it from one of those rather',
    '  than writing the syntax from memory, and say the snippet is upstream-derived.'];
  for (const sm of f.samples) out.push(`  sample: ${sm.url}`);
  if (f.samples.length) out.push('  (full source in: node scripts/wpt-js-gaps.js --stored)');
  return out;
}

/**
 * test262.fyi's measurement for one flag: executed test counts, and whether the feature
 * needed experimental options.
 *
 * `short` is only populated when the measurement CHANGES the reading of the Bugzilla
 * outcome — no tests exist at all, the feature is flag-gated, or it demonstrably works
 * where Bugzilla found nothing. Otherwise the numbers go on the detail lines, so the box
 * line stays one line and carries the surprise rather than the corroboration.
 */
function jsFyiLines(h, name) {
  const fyi = h && h.fyi;
  if (!fyi) return { short: '', lines: [] };
  if (!fyi.ok) {
    return {
      short: '',
      lines: [`test262.fyi: ${fyi.error}`],
    };
  }
  const r = fyi.results && fyi.results[name];
  if (!r) {
    return { short: '', lines: [`test262.fyi does not track this flag on ${fyi.engine}.`] };
  }
  // Always name the build, and always name it as a nightly. This is the one way this
  // source misleads: reading "155.0a1 passes 78/78" as a statement about the release the
  // notes are describing.
  const where = `${fyi.engine} ${fyi.version} (NIGHTLY, not the release above)`;
  if (r.noTests) {
    return {
      short: 'no test262 tests exist yet',
      lines: [`test262.fyi: the flag is registered upstream with 0 tests written, so nothing`,
        'anywhere can measure it. That is why a bug search may also come up empty.'],
    };
  }
  const lines = [`test262.fyi: ${r.pass}/${r.total} pass on ${where}, default options`];
  if (r.prefGated) {
    lines.push(`  and ${r.expPass}/${r.total} with experimental options, so it is FLAG GATED even in`);
    lines.push('  nightly. Not on by default.');
    return { short: 'test262 needs experimental options', lines };
  }
  if (r.fullyPassing) {
    lines.push('  All of them, without experimental options: it works and is on by default in');
    lines.push('  nightly. Which release enabled it is the separate question Bugzilla answers.');
  } else {
    lines.push(`  Partial: ${r.total - r.pass} still fail, same in the experimental build.`);
  }
  return { short: '', lines };
}

/**
 * What this comparison cannot show, for JavaScript — printed as a section of its own.
 *
 * It sits third, straight after the change breakdown, and before every ranked view.
 * That placement is the point: it is not a footnote about data quality but a
 * statement about what the numbers below are *capable* of containing. Three Iterator
 * proposals shipped in one Firefox release with no test in either run, and every
 * ranked section, the inventory, the vocabulary rollup and wpt-state.js were all
 * correct to say nothing about them.
 */
function jsHorizonLines(h) {
  const L = [];
  const p = (s = '') => L.push(s);

  p('## JavaScript coverage horizon (WPT vendors test262, it does not track it)');
  if (!h) {
    // An artifact collected before this check existed. Silence here would be read as
    // "no gaps", which is the exact failure the section exists to prevent.
    p('# NOT CHECKED — this artifact predates the check, so JS gaps are unknown, not');
    p('# absent. Re-collect to measure them.');
    p('');
    return L;
  }
  if (!h.ok) {
    p(`# NOT CHECKED — the horizon lookup failed: ${h.error}`);
    p('# JS gaps are therefore UNKNOWN for this comparison, not absent. Check MDN\'s');
    p('# release notes or Bugzilla for JavaScript features by hand before writing.');
    p('');
    return L;
  }

  const age = h.lagDays === null ? 'age unknown' : `${h.lagDays} days behind`;
  p(`# tests/js in this WPT revision come from tc39/test262 @ ${h.after.rev.slice(0, 10)}`);
  p(`#   snapshot ${h.after.date || '(date unknown)'}   upstream HEAD ${h.upstream.date || '(date unknown)'}   ${age}`);
  if (!h.sameSnapshot) {
    p(`#   the two runs are on DIFFERENT snapshots: ${h.before.rev.slice(0, 10)} -> ${h.after.rev.slice(0, 10)}`);
  }
  p('#');
  p('# A JS feature whose test262 tests landed after that snapshot has NO test in');
  p('# either run. It cannot appear in the inventory, in any ranked section, or in');
  p('# wpt-state.js, and its absence looks exactly like not shipping. Firefox 154');
  p('# shipped Iterator Chunking, Iterator Includes and Iterator Join into a 117-day-old');
  p('# snapshot and the notes named none of them.');

  if (h.missing.length) {
    p('');
    p(`# ${h.missing.length} feature flag(s) upstream has and this comparison does not. WPT cannot say`);
    p('# whether the browser shipped these, only that it did not test them — so each is');
    p('# resolved at collection time against two sources that answer different halves:');
    p('# test262.fyi for "does it work, and is it on by default", and a per-vendor release');
    p('# source for "which version turned it on".');
    const sh = h.shipped;
    if (h.fyi && h.fyi.ok) {
      p('#');
      p(`# test262.fyi runs all of test262 @ ${(h.fyi.test262Revision || '?').slice(0, 7)} against ${h.fyi.engine} ${h.fyi.version},`);
      p('# twice: with and without experimental options. That measures whether each feature');
      p('# WORKS and whether it is on by DEFAULT — but the build is a NIGHTLY, so it cannot');
      p('# say which release enabled it.');
    }
    if (sh && sh.ok) {
      p('#');
      p(`# Release source: ${sh.source} (${sh.product} ${sh.version}).`);
      if (sh.note) p(`# ${sh.note}`);
      p('# Do NOT re-derive this by searching for a flag name. Both this source and Bugzilla');
      p('# search over PROSE feature names, so the flag matches nothing even for features');
      p('# that shipped:');
      p('#   quicksearch=iterator-chunking        0 bugs   (shipped in Firefox 154)');
      p('#   quicksearch=Iterator.prototype.join  0 bugs   (shipped in Firefox 154)');
      if (sh.extra && sh.extra.length) {
        p(`# ${sh.extra.length} bug(s) whose summary starts "Ship" are flagged fixed for ${sh.version}. That`);
        p('# list needs no guess about wording, so it cannot produce a false negative:');
        for (const b of sh.extra) p(`  bug ${b.id}  ${b.summary}`);
      }
    } else if (sh && sh.unsupported) {
      p('#');
      p(`# NO release source for ${sh.product}: ${sh.error}.`);
      p('# So every box below is UNANSWERED for "which version", not answered "no". The');
      p('# test262.fyi measurement still says whether it works and is on by default.');
      for (const url of sh.lookAt || []) p(`#   check by hand: ${url}`);
    }
    p('');
    for (const f of h.missing) {
      const finding = jsFinding(h, f.name);
      p(`  ${f.name}${finding ? `      ${finding.short}` : ''}`);
      const bits = [f.label, f.section].filter(Boolean).join(' / ');
      if (bits) p(`      ${bits}`);
      if (f.url) p(`      ${f.url}`);
      for (const line of (finding ? finding.lines : [])) p(`      ${line}`);
    }
    if (!sh) {
      p('');
      p('# No release check recorded. Each of the above is UNANSWERED — and searching a bug');
      p('# tracker for the flag name will answer "no" incorrectly. Run:');
      p('#   node scripts/wpt-js-gaps.js');
    } else if (!sh.ok && !sh.unsupported) {
      p('');
      p(`# The release check did not run: ${sh.error}`);
      p('# So the above are UNANSWERED, not answered "no".');
    }
  } else {
    p('');
    p('# No upstream feature flag is missing from this snapshot, so test262 coverage is');
    p('# current. JS features can still be absent for want of tests being written.');
  }

  if (h.revendored && h.revendored.length) {
    p('');
    p(`# ${h.revendored.length} flag(s) arrived BETWEEN the two runs (test262 was re-vendored), so unlike`);
    p('# the list above their tests DO exist — in the after run only. Their');
    p('# tests exist on one side only, so they classify as `added` and the worksheet');
    p('# pre-resolves them as test-suite churn — true about the mechanism, and wrong');
    p('# about the consequence: a whole proposal\'s tests arriving is a lead, and this');
    p('# is the same shape as the /third_party exclusion that once hid Intl.Locale.');
    for (const f of h.revendored) {
      p(`  ${f.name}${f.label ? `      ${f.label}` : ''}`);
    }
  }
  p('');
  return L;
}

/**
 * The lines that stop a missing pref check reading as "nothing is nightly-only".
 *
 * Loud by design. Without searchfox-cli there is no way to tell a shipped feature from a
 * nightly-only one, and the whole diff then reads as shipped — which is the failure this
 * check exists for, so its absence has to be at least as visible as its findings.
 */
function prefCaveat(g) {
  if (!g) {
    return ['This artifact predates the pref-gating check, so whether these features are',
      'nightly-only is UNKNOWN. Re-collect, or: node scripts/wpt-prefs.js --refresh'];
  }
  if (g.missingTool) {
    return ['!! searchfox-cli IS NOT INSTALLED, so NOTHING below is known to be available to',
      '!! users. WPT force-enables prefs per directory, so a passing test can be a',
      '!! nightly-only feature. Install it (cargo install searchfox-cli) and run',
      '!! node scripts/wpt-prefs.js --refresh, or treat every feature here as UNVERIFIED.'];
  }
  if (!g.ok) {
    return [`The pref-gating check failed (${g.error}), so nightly-only features are NOT`,
      'marked below. Treat pref state as unverified.'];
  }
  const n = (g.gatedTests || []).length;
  if (!n) return [];
  return [`${n} of the files below are gated by a pref a beta/release user does not have, and`,
    'are marked on their directory line. DISCOUNT those from the notes unless asked otherwise.'];
}

/**
 * The pref-gating section: which prefs gate what, and which are nightly-only.
 */
function prefGatingLines(g) {
  const L = [];
  const p = (s = '') => L.push(s);
  p('## Pref gating (which features a shipped-channel user actually has)');
  if (!g) {
    p('# NOT CHECKED — this artifact predates the check. Re-collect to measure it.');
    p('');
    return L;
  }
  if (g.missingTool) {
    p('# NOT CHECKED — searchfox-cli is not installed, and it is the only way to tell a');
    p('# shipped feature from a nightly-only one. Every feature in this comparison is');
    p('# therefore UNVERIFIED: WPT force-enables prefs per directory, so a passing test does');
    p('# not mean a user has the feature. Install it and re-run:');
    p('#   cargo install searchfox-cli   (or, if you have it, cargo binstall)');
    p('#   node scripts/wpt-prefs.js --refresh');
    p('');
    return L;
  }
  if (!g.ok) {
    p(`# NOT CHECKED — ${g.error}. Pref state is unverified.`);
    p('');
    return L;
  }
  const byVerdict = {};
  for (const info of Object.values(g.prefs)) {
    (byVerdict[info.verdict] = byVerdict[info.verdict] || []).push(info);
  }
  const gated = (g.gatedTests || []).length;
  if (g.tool && g.tool.outdated) {
    // A stale resolver is a silent weakness of exactly the kind this check exists to catch.
    p(`# !! searchfox-cli ${g.tool.version} is OUTDATED (latest ${g.tool.latest}). The pref verdicts`);
    p('# !! below came from it. Update and re-run before trusting them:');
    p('# !!   cargo install searchfox-cli && node scripts/wpt-prefs.js --refresh');
  } else if (g.tool && g.tool.version) {
    p(`# resolved with searchfox-cli ${g.tool.version}`);
  }
  p(`# ${g.dirsProbed} directories probed; ${g.forced.length} force prefs on via`);
  p('# testing/web-platform/meta/<dir>/__dir__.ini, which is why a test can pass for a');
  p('# feature the channel does not enable. Pref defaults read from StaticPrefList.yaml in');
  p('# mozilla-central, -beta and -release, because central IS nightly and reading it alone');
  p('# makes every nightly-only pref look shipped.');
  p(`# ${gated} forward-moving test(s) are gated by a pref a beta/release user does not have.`);
  p('');
  for (const verdict of ['nightly-only', 'off-by-default', 'channel-dependent', 'unclear', 'unknown-pref', 'shipped']) {
    const list = byVerdict[verdict];
    if (!list || !list.length) continue;
    p(`  ${VERDICT_LABEL[verdict]} (${list.length})${discount(verdict) ? '  <- DISCOUNT these' : ''}:`);
    for (const info of list.slice(0, 14)) {
      const per = info.per;
      const show = (r) => (per[r] ? per[r].raw : 'absent');
      p(`    ${info.pref}`);
      p(`        central=${show('mozilla-central')}  beta=${show('mozilla-beta')}  release=${show('mozilla-release')}`);
    }
    if (list.length > 14) p(`    ... and ${list.length - 14} more`);
    p('');
  }
  return L;
}

/**
 * The two or three lines that stop the inventory reading as a completeness guarantee
 * for JavaScript. Short by design — it appears above every page of every listing.
 */
function jsHorizonCaveat(h) {
  if (!h) {
    return ['This artifact predates the test262 horizon check, so JS coverage gaps are',
      'UNKNOWN here rather than absent. Re-collect to measure them.'];
  }
  if (!h.ok) {
    return ['The test262 horizon check failed at collection time, so JS coverage gaps are',
      'UNKNOWN here rather than absent — check MDN or Bugzilla for JS features by hand.'];
  }
  if (!h.missing.length && !(h.revendored || []).length) return [];
  const lag = h.lagDays === null ? 'of unknown age' : `${h.lagDays} days behind upstream`;
  const rev = (h.revendored || []).length;
  const out = [`BUT test262 is VENDORED into WPT — this snapshot is ${lag}.`];
  // Both counts, because this fired on either and reported only the first: with a current
  // snapshot and a re-vendor between the runs it read "cannot surface 0 JS feature(s)", which
  // is the same conflation of the two classes that the boxes had.
  if (h.missing.length) {
    out.push(`Reading every line below cannot surface ${h.missing.length} JS feature(s) with no test in`,
      'either run.');
  }
  if (rev) {
    out.push(`${rev} more arrived BETWEEN the two runs, so their tests exist on one side only and`,
      'the worksheet pre-resolves them as churn.');
  }
  out.push('Both are boxed at the end of checklist.md, and listed by wpt-report.js --section javascript.');
  return out;
}

// ---------------------------------------------------------------------------
// The vendor changelog — feature -> test, the opposite direction to everything else
// ---------------------------------------------------------------------------

/** One box path per developer-facing bug. Bare digits, so nothing needs quoting. */
function bugBoxPath(id) {
  return `bug:${id}`;
}

/**
 * How a bug's cross-reference against the diff reads.
 *
 * Four outcomes, and only one of them says "you already have this":
 *   matched      strong identifier hit in the diff. If it is not in the notes, it was missed.
 *   weak-only    a hit on a generic word. A LEAD to confirm, not evidence — `Select` matched
 *                14 files for the `:open` bug and every one was unrelated.
 *   no-evidence  searched and found nothing: the diff cannot show this, so the notes need it
 *                from the bug or not at all.
 *   unsearchable no candidate token in the summary, so it was never checked. Explicitly NOT
 *                the same as no-evidence.
 */
function bugFinding(bug) {
  // Tests that exist and still fail in the "to" run, matched on a PRECISE identifier only.
  // Context, never a classification: see lib/changelog.js for why the loose version had to go.
  const failing = bug.failingHits || [];
  // The vendor's own wording. This is the only enablement signal here that is stated rather
  // than inferred, and `resolution=FIXED` does NOT mean enabled — which is the mistake that
  // produced a confidently wrong finding about `:open` for <select>.
  const pref = bug.notForUsers
    ? [`The summary says "${bug.notForUsers}", so this landed but is NOT on for users.`,
      'Do not write it up as available.']
    : [];
  const stillFails = failing.length
    ? [`${failing.length} test(s) matching ${failing[0].matched.join(', ')} still FAIL after, e.g.`,
      `  ${failing[0].test}`,
      'so it may be partly enabled at most. Check with wpt-state.js --only failing-after.']
    : [];

  if (bug.unsearchable) {
    return { short: 'NOT CHECKED (no token in the summary)', lines: [
      'The summary yielded no searchable identifier, so this was never matched against the',
      'diff. That is not the same as "not in the diff" — read the bug.', ...pref] };
  }
  if (bug.hits.length) {
    const lines = [`in the diff, ${bug.hits.length} file(s) matching ${bug.hits[0].matched.join(', ')}:`];
    for (const h of bug.hits.slice(0, 3)) {
      lines.push(`  ${signed(h.deltaPass)}  ${h.test}`);
      if (h.subtest) lines.push(`      ${clip(h.subtest, 88)}`);
    }
    if (bug.hits.length > 3) lines.push(`  ... and ${bug.hits.length - 3} more`);
    lines.push(...stillFails, ...pref);
    if (!bug.notForUsers) lines.push('If this is not in your notes, you missed it — the evidence is above.');
    return {
      short: bug.notForUsers ? `in the diff, but ${bug.notForUsers}` : `in the diff (${bug.hits.length} file(s))`,
      lines,
    };
  }
  if (bug.weakHits.length) {
    return {
      short: bug.notForUsers ? `weak match, and ${bug.notForUsers}` : `weak match only (${bug.weakHits.length})`,
      lines: [
        `No precise identifier matched. ${bug.weakHits.length} file(s) match a generic word `
          + `(${bug.weakHits[0].matched.join(', ')}), starting with`,
        `  ${bug.weakHits[0].test}`,
        'Treat as a lead and confirm by eye: a generic-word match is usually a coincidence.',
        ...pref],
    };
  }
  // No changed test matched. There are THREE reasons for that and only one of them is "the
  // bug is the only source", so this must not assert which. Getting that wrong is what
  // produced the `:open` for <select> error: it is FIXED with a dev-doc keyword, its test
  // fails in both runs because the feature is preffed off, and reporting it as missing
  // coverage inverted the truth — WPT was right.
  return {
    short: bug.notForUsers ? `not in the diff, and ${bug.notForUsers}` : 'not in the diff',
    lines: [
      `Searched the diff for ${bug.tokens.concat(bug.weakTokens).slice(0, 6).join(', ')} and found nothing.`,
      'Three possibilities, and they need opposite write-ups:',
      '  - landed but NOT enabled (behind a pref, or nightly-only). Its tests may exist and',
      '    fail in both runs, which is CORRECT. Check with wpt-state.js before writing it up.',
      '  - no WPT coverage at all — DevTools, WebExtensions and internal media changes are',
      '    never in WPT, so the bug really is the only source.',
      '  - covered, but under vocabulary these tokens missed. Try wpt-grep.js.',
      ...stillFails, ...pref],
  };
}

/**
 * The changelog section: the developer-facing bugs, gaps first, then the census.
 *
 * Gaps first because they are the ones nothing else here will ever mention. The census of
 * everything else exists so the keyword filter is navigable instead of silent — 21 boxes out
 * of 3256 fixed bugs is a big cut, `dev-doc` tagging is manual and incomplete, and a reader
 * who wants an area should be able to get it without another network call.
 */
function changelogLines(cl, { censusTop = 24 } = {}) {
  const L = [];
  const p = (s = '') => L.push(s);
  p('## Vendor changelog (what the bug tracker says shipped)');
  if (!cl) {
    p('# NOT CHECKED — this artifact predates the changelog sweep. Re-collect to measure it.');
    p('');
    return L;
  }
  if (!cl.ok) {
    p(`# ${cl.unsupported ? 'NOT APPLICABLE' : 'NOT CHECKED'} — ${cl.error}`);
    p('');
    return L;
  }
  const gaps = cl.curated.filter((b) => !b.hits.length);
  p(`# ${cl.total} bug(s) resolved FIXED for ${cl.milestone}. ${cl.curated.length} carry Mozilla's own`);
  p('# dev-doc-needed/dev-doc-complete keyword, i.e. "a web developer needs to be told".');
  p('# This is the only source here that runs feature -> test instead of test -> feature,');
  p('# which is why it catches what a reader skimmed as well as what WPT cannot see:');
  p(`# ${gaps.length} of the ${cl.curated.length} have no matching evidence in the diff at all.`);
  p('#');
  p('# A LEAD, not coverage: the keyword is applied by hand and is incomplete. Everything');
  p('# else is in the census below, reachable with wpt-bugs.js --component / --grep.');
  p('');
  // Only the gaps here, one line each: the full evidence per bug is on the checklist boxes,
  // where the verdict gets written, and in wpt-bugs.js. This section is a pointer, because
  // at full length it displaced the ranked sections off the first page of report.txt.
  p(`# The ${gaps.length} with no diff evidence — nothing else in this artifact mentions these:`);
  for (const b of gaps.slice(0, 20)) {
    p(`  bug ${b.id}  [${b.component}]  ${clip(b.summary, 74)}`);
  }
  if (gaps.length > 20) p(`  ... and ${gaps.length - 20} more`);
  p('');
  p(`# All ${cl.curated.length}, with per-bug diff evidence:  node scripts/wpt-bugs.js`);
  p('');
  p(`# Census of all ${cl.total} fixed bugs, by component. The keyword list above is a subset;`);
  p('# these are how you reach the rest.');
  for (const c of cl.census.slice(0, censusTop)) {
    p(`  ${String(c.count).padStart(5)}  ${c.key}`);
  }
  if (cl.census.length > censusTop) {
    p(`  ... and ${cl.census.length - censusTop} more component(s) — wpt-bugs.js --census for all`);
  }
  p('');
  return L;
}

const SHOW_BUG = 'https://bugzilla.mozilla.org/show_bug.cgi?id=';

/** One box per developer-facing bug, so the cross-check is a gate rather than a suggestion. */
function bugGapBoxes(cl) {
  if (!cl || !cl.ok) return [];
  return cl.curated.map((b) => ({ path: bugBoxPath(b.id), bug: b }));
}

/**
 * The worksheet's fourth list. Ordered gaps-first, matching the report, because a bug the
 * diff cannot show is the one a reader is least equipped to answer from the artifact.
 */
function bugChecklistLines(cl) {
  const boxes = bugGapBoxes(cl);
  if (!boxes.length) return [];
  const L = [];
  const p = (s = '') => L.push(s);
  const gaps = boxes.filter((b) => !b.bug.hits.length).length;
  p('');
  p(`## Developer-facing bugs in this release (${boxes.length})`);
  p('');
  p(`Mozilla flagged these ${boxes.length} bugs as needing developer documentation for`);
  p(`${cl.milestone}, out of ${cl.total} fixed. ${gaps} have no matching evidence in the diff.`);
  p('');
  p('**FIXED does not mean enabled.** A bug can be fixed for this release and still be behind');
  p('a pref, so its WPT tests fail in BOTH runs and that failure is CORRECT. Check before');
  p('writing anything up — "landed, not enabled" is a "not a feature:" verdict.');
  p('');
  p('What this list is for, from the pass that added it:');
  p('  bug 2019332  RTCIceTransport.getSelectedCandidatePair() — WAS in the diff, as newly-');
  p('               passing IDL subtests, and still absent from the notes. A cross-check.');
  p('  bug 1850288  Show path in JSON Viewer — DevTools has no WPT coverage at all, so');
  p('               nothing else here will ever mention it.');
  p('  bug 2048183  :open for <select> — FIXED, but behind a pref: its tests still fail in');
  p('               both runs, which is CORRECT. "landed, not enabled" is not a feature.');
  p('');
  p('Verdicts work as everywhere else. "not a feature:" is the right answer for a bug that');
  p('is real but not web-facing — a DevTools or build change — and saying so is the point.');
  p('');
  for (const box of boxes) {
    const f = bugFinding(box.bug);
    p(`[ ] ${box.path}   (${f.short})`);
    p(`      ${clip(box.bug.summary, 92)}`);
    p(`      ${box.bug.product}/${box.bug.component}`);
    for (const line of f.lines) p(`      ${line}`);
    p(`      ${SHOW_BUG}${box.bug.id}`);
  }
  return L;
}

// ---------------------------------------------------------------------------
// report.txt — the ranked view, plus the two sections that ranking would hide
// ---------------------------------------------------------------------------

function renderReport(report, { top = 40 } = {}) {
  const L = [];
  const p = (s = '') => L.push(s);
  const { before, after } = report;
  const bs = before.stats;
  const as = after.stats;

  p(`# WPT pass-rate diff: ${before.spec} -> ${after.spec}`);
  p('');
  p(`baseline : ${before.product} ${before.browser_version} (${before.spec}), ${before.os}, wpt @ ${before.wpt_revision}, run ${before.run_id}, ${before.time_start}`);
  p(`compare  : ${after.product} ${after.browser_version} (${after.spec}), ${after.os}, wpt @ ${after.wpt_revision}, run ${after.run_id}, ${after.time_start}`);
  if (before.wpt_revision !== after.wpt_revision) {
    p('NOTE     : runs are on different WPT revisions — some diffs are test-suite churn, not browser changes.');
    p('           Re-collect with --aligned for a churn-free comparison.');
  }
  if (before.os !== after.os) {
    p('NOTE     : runs are on different platforms — some diffs are platform differences.');
  }
  p('');
  p('## Overall');
  p(`tests      : ${bs.tests} -> ${as.tests} (${signed(as.tests - bs.tests)})`);
  p(`subtests   : ${bs.total} -> ${as.total} (${signed(as.total - bs.total)})`);
  p(`passing    : ${bs.pass} -> ${as.pass} (${signed(as.pass - bs.pass)})`);
  p(`pass rate  : ${pct(bs.rate)} -> ${pct(as.rate)} (${signed(+((as.rate - bs.rate) * 100).toFixed(3))} pp)`);
  p('');
  p('## Change breakdown (by test file)');
  for (const [k, v] of Object.entries(report.buckets)
    .filter(([k]) => k !== 'unchanged')
    .sort((a, b) => b[1] - a[1])) {
    p(`${k.padEnd(18)} ${v}`);
  }
  p(`${'(unchanged)'.padEnd(18)} ${report.buckets.unchanged || 0}`);
  p('');

  for (const line of jsHorizonLines(report.jsHorizon)) p(line);

  // A test with no subtests cannot be ranked by subtest delta, so it must not share a
  // section with tests that can. That is already why reftests have their own two
  // sections; crashtests need the same treatment for the same reason, and did not get
  // it. Splitting the harness-error sections by whether there are subtests at all
  // gives each group its own --top budget, and costs no duplication.
  const hasSubtests = (r) => (r.after?.total || 0) > 0 || (r.before?.total || 0) > 0;
  const byName = (a, b) => a.test.localeCompare(b.test);

  const sections = [
    ['Regressions (fewer subtests passing)', (r) => r.kind === 'regressed', (a, b) => a.deltaPass - b.deltaPass],
    ['Improvements (more subtests passing)', (r) => r.kind === 'improved', (a, b) => b.deltaPass - a.deltaPass],
    ['Newly broken (harness error/crash/timeout)', (r) => r.kind === 'newly-broken' && hasSubtests(r), null],
    ['Newly running (was error/crash/timeout)', (r) => r.kind === 'newly-running' && hasSubtests(r), null],
    // Crashtests and hang tests. `CRASH 0/0 -> PASS 0/0` is deltaPass 0, so while
    // these shared a section with the rows above they sorted below every partial
    // recovery — `TIMEOUT 0/6 -> OK 3/6` outranked a browser that stopped crashing —
    // and were cut by --top from a 59-row section.
    // /css/css-multicol/content-visibility-001-crash.html and
    // /css/css-page/page-name-002-print.html were both lost that way, and both were
    // real fixes that had to be recovered from the inventory by hand. A crash or hang
    // is the most user-visible failure there is; it should not be the least visible row.
    ['Stopped crashing or hanging (no subtests — crashtests)', (r) => r.kind === 'newly-running' && !hasSubtests(r), byName],
    ['Started crashing or hanging (no subtests — crashtests)', (r) => r.kind === 'newly-broken' && !hasSubtests(r), byName],
    // Reftests carry no subtests, so these rows are all deltaPass 0 and would
    // otherwise never be printed — despite being real rendering fixes.
    ['Now passing with no subtests (reftests: rendering fixes)', (r) => r.statusDirection === 'fixed', (a, b) => a.test.localeCompare(b.test)],
    ['Now failing with no subtests (reftests: rendering regressions)', (r) => r.statusDirection === 'broken', (a, b) => a.test.localeCompare(b.test)],
    [`Tests only in ${after.spec}`, (r) => r.kind === 'added', (a, b) => b.after.total - a.after.total],
    [`Tests only in ${before.spec}`, (r) => r.kind === 'removed', (a, b) => b.before.total - a.before.total],
  ];

  for (const [title, filter, sort] of sections) {
    const list = report.tests.filter(filter);
    if (!list.length) continue;
    if (sort) list.sort(sort);
    p(`## ${title} (${list.length})`);
    // top <= 0 means ALL. slice(0, 0) is [], so treating 0 as a literal cap printed
    // a section with zero rows and a "... and 186 more" line — and since the
    // collector accepts --top, `--top 0` would have written an empty report.txt.
    const shown = top > 0 ? list.slice(0, top) : list;
    for (const r of shown) {
      p(`  ${signed(r.deltaPass).padStart(6)}  ${fmtSide(r.before).padEnd(22)} -> ${fmtSide(r.after).padEnd(22)} ${r.test}`);
    }
    if (shown.length < list.length) {
      p(`  ... and ${list.length - shown.length} more (--top 0 for all; the inventory lists every one)`);
    }
    p('');
  }

  p('## Biggest movers by area');
  for (const a of report.areas
    .filter((x) => x.deltaPass !== 0 || x.statusFixed || x.statusBroken)
    .slice(0, 30)) {
    const rate = a.deltaRate === null ? '' : ` (${pct(a.beforeRate)} -> ${pct(a.afterRate)})`;
    // An area can be all reftests, where the subtest delta is 0 and the flip
    // counts are the entire story.
    const flips = [
      a.statusFixed ? `${a.statusFixed} now passing` : null,
      a.statusBroken ? `${a.statusBroken} now failing` : null,
    ].filter(Boolean);
    p(`  ${signed(a.deltaPass).padStart(7)} subtests  ${a.area}${rate}${flips.length ? `  [no subtests: ${flips.join(', ')}]` : ''}`);
  }
  p('');

  // An all-reftest area has deltaPass 0 everywhere, so it sorts below every area
  // that moved a single subtest and never survives the slice above — even when
  // dozens of rendering tests started passing. List those separately.
  const reftestOnly = report.areas
    .filter((a) => a.deltaPass === 0 && (a.statusFixed || a.statusBroken))
    .sort((x, y) => y.statusFixed + y.statusBroken - (x.statusFixed + x.statusBroken));
  if (reftestOnly.length) {
    p('## Areas that moved only in tests with no subtests (reftests)');
    for (const a of reftestOnly.slice(0, 30)) {
      const flips = [
        a.statusFixed ? `${a.statusFixed} now passing` : null,
        a.statusBroken ? `${a.statusBroken} now failing` : null,
      ].filter(Boolean);
      p(`  ${a.area.padEnd(34)} ${flips.join(', ')}`);
    }
    if (reftestOnly.length > 30) p(`  ... and ${reftestOnly.length - 30} more`);
    p('');
  }

  if (report.clusters.length) {
    p('## Directory clusters (many files in one directory moved the same way)');
    p('# Ranked by moved-file count, not subtest delta, so a feature that landed as');
    p('# many tiny gains still shows up. Only a lead, not coverage: a feature that');
    p('# moved one file, or moved files both ways, is absent. Filters applied:');
    p(`# >=${report.clusterMin} moved files, >=${Math.round(report.clusterRatio * 100)}% one direction, added/removed tests not counted.`);
    p('# For coverage, read inventory.txt in full.');
    // Printed in full, deliberately not truncated: the filters above already cut
    // 121k tests to a few dozen rows, and truncating by rank would reintroduce the
    // failure this section exists to prevent — the cluster that got missed sat one
    // row past a top-20 cut.
    for (const c of report.clusters) {
      const dir = c.improved >= c.regressed ? `${c.improved} improved` : `${c.regressed} regressed`;
      const churn = c.churn ? `  (+${c.churn} new/gone)` : '';
      p(`  ${String(c.moved).padStart(4)} files  ${signed(c.deltaPass).padStart(7)} subtests  ${dir.padEnd(14)} /${c.dir}${churn}`);
    }
    p('');
  }

  for (const line of changelogLines(report.changelog)) p(line);
  for (const line of prefGatingLines(report.prefGating)) p(line);

  if (report.vocabulary && report.vocabulary.length) {
    p('## One feature, several directories (shared newly-passing subtest words)');
    p('# Mechanical version of "group by feature, not by directory": each token');
    p('# below appears in newly-passing subtest names under 2+ directories, so it is');
    p('# probably one change surfacing in several places. Report it once.');
    for (const v of report.vocabulary.slice(0, 25)) {
      p(`  ${v.token.padEnd(28)} ${v.dirs.length} dirs: ${v.dirs.slice(0, 4).map((d) => `/${d}`).join(' ')}${v.dirs.length > 4 ? ' …' : ''}`);
    }
    if (report.vocabulary.length > 25) p(`  ... and ${report.vocabulary.length - 25} more (see diff.json)`);
    p('');
  }

  return L;
}

// ---------------------------------------------------------------------------
// inventory.txt — every changed file, ranked by nothing
// ---------------------------------------------------------------------------

/**
 * Every changed test file, grouped by directory, for reading end to end.
 *
 * Every other view ranks by magnitude. Ranking is the wrong tool for this job,
 * because **subtest count is not a signal of importance**: the delta of a fix
 * measures how many assertions happened to still be failing beforehand.
 *
 *   css/selectors/webkit-pseudo-element.html    5/6  -> 6/6   (+1)
 *   .../customizable-select/select-parsing.html 10/17 -> 17/17 (+7)
 *
 * Both are real, developer-facing features. Both were dismissed as noise on a real
 * pass because +1 and +7 look like rounding error next to a +664. No threshold or
 * cleverer ranking fixes that, because the premise is wrong. So this view selects
 * nothing and sorts alphabetically.
 */
/** One directory's block: its header line, and its files with their evidence. */
function groupLines(g, dirsOnly, gating = null) {
  const out = [];
  const allChurn = g.churn === g.rows.length ? '  <- all test-suite churn' : '';
  // The pref marker goes on the directory header, which is the line a reader decides from —
  // in --dirs, in the full listing, and in the worksheet. A feature whose tests only pass
  // because WPT forced a pref on is not something a user has.
  const marker = dirMarker(gating, g.dir.replace(/^\//, ''));
  out.push(`${g.dir}  [${g.rows.length} file${g.rows.length === 1 ? '' : 's'}, ${signed(g.deltaPass)} subtests, ${dirBits(g)}]${allChurn}${marker ? `  ${marker.text}` : ''}`);
  if (marker) {
    out.push(`    !! ${marker.files} file(s) here are gated by ${marker.prefs.slice(0, 3).join(', ')}${marker.prefs.length > 3 ? ` +${marker.prefs.length - 3}` : ''}`);
    out.push(`    !! ${marker.verdict === 'nightly-only'
      ? 'On in nightly, OFF for beta/release users. DISCOUNT from the notes unless asked.'
      : `${marker.label}. WPT forced it on, so passing does NOT mean a user has it.`}`);
  }
  if (dirsOnly) return out;
  for (const r of g.rows) {
    const flag = completed(r)
      ? ' *done*'
      : r.kind === 'added' ? ' (new test)' : r.kind === 'removed' ? ' (test removed)' : '';
    const name = r.test.slice(g.dir === '/' ? 1 : g.dir.length + 1);
    out.push(`    ${signed(r.deltaPass).padStart(5)}  ${fmtSide(r.before).padEnd(20)} -> ${fmtSide(r.after).padEnd(20)} ${name}${flag}`);
    for (const line of evidenceLines(r, '           ')) out.push(line);
  }
  return out;
}

/**
 * Pack directory blocks into parts that each fit a character budget.
 *
 * Split points are always directory boundaries, never line offsets. That is the
 * whole point: a full inventory is ~86KB for a channel diff and several hundred KB
 * for a two-release one, so it does not fit in one tool result — and the obvious
 * workaround, redirecting it to a file and reading line ranges, reintroduces the
 * exact failure this view exists to prevent. A line window cuts across a
 * directory, so the directory appears with only some of its files and nothing says
 * so. Packing whole directories cannot do that.
 *
 * A single directory bigger than the budget becomes its own oversized part rather
 * than being split — /css/css-inline/text-box-trim is 177 lines by itself.
 */
function paginate(blocks, budget) {
  const parts = [];
  let current = [];
  let size = 0;
  for (const b of blocks) {
    const cost = b.lines.reduce((s, l) => s + l.length + 1, 0);
    if (current.length && size + cost > budget) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(b);
    size += cost;
  }
  if (current.length) parts.push(current);
  return parts.length ? parts : [[]];
}

function renderInventory(report, tests, {
  dirsOnly = false, filters = [], navHint = true, part = 1, budget = 25000, all = false,
  resume = 'node scripts/wpt-inventory.js',
} = {}) {
  const L = [];
  const p = (s = '') => L.push(s);
  const groups = groupByDir(tests);
  const blocks = groups.map((g) => ({ g, lines: groupLines(g, dirsOnly, report.prefGating) }));

  // --dirs is paginated too. It is one line per directory, which looks like it
  // always fits — but that is ~71 bytes each, and a two-release diff runs to
  // 200-400 directories, so the map alone reaches the output limit and gets cut by
  // the harness with no marker. The budget makes that a deliberate, labelled break
  // instead. Small diffs are unaffected: 124 directories is 8.8KB, one part.
  const parts = all ? [blocks] : paginate(blocks, budget);
  const index = Math.min(Math.max(1, part), parts.length);
  const chosen = parts[index - 1];
  const paged = parts.length > 1;

  // Where this part sits in the whole, by directory ordinal, so coverage is
  // countable rather than felt.
  const before = parts.slice(0, index - 1).reduce((s, x) => s + x.length, 0);
  const firstDir = before + 1;
  const lastDir = before + chosen.length;

  p(`# Changed-test inventory: ${report.before.spec} -> ${report.after.spec}`);
  p('');
  p(`${tests.length} changed test files in ${groups.length} directories${filters.length ? ` (${filters.join(', ')})` : ''}.`);
  if (paged) {
    p('');
    p(`!! PART ${index} OF ${parts.length} — THIS IS NOT THE WHOLE INVENTORY.`);
    p(`!! Showing directories ${firstDir}-${lastDir} of ${groups.length}, split at directory`);
    p('!! boundaries so no directory is ever shown partially.');
    p(index === parts.length
      ? `!! This is the final part; directories 1-${firstDir - 1} are in parts 1-${parts.length - 1}.`
      : '!! Read every part.');
  }
  p('');
  p('Read this in full. Rows are alphabetical, not ranked — subtest delta is not a');
  p('measure of importance, and a +1 has turned out to be a shipped feature.');
  p('"done" counts files that went from partly failing to fully passing.');
  p('JS/Intl features live in third_party/test262, not a web-platform directory.');
  p('"+" / "-" lines are the subtest names that changed state: that is the feature');
  p('vocabulary, so read those rather than inferring anything from the filename.');
  // The line above used to end the paragraph, and read as an assurance that looking
  // in third_party/test262 was sufficient. It is not: WPT vendors test262 on a slow
  // cadence, so reading this listing to the last line still cannot surface a JS
  // feature whose tests postdate the snapshot. Three did on one real comparison.
  for (const line of jsHorizonCaveat(report.jsHorizon)) p(line);
  for (const line of prefCaveat(report.prefGating)) p(line);
  if (!dirsOnly && navHint) {
    p('');
    p(`This is ${groups.length} directories and ${tests.length} files. Navigate it with the flags below,`);
    p('NOT by redirecting to a file and reading line ranges — a line window cuts across');
    p('a directory, so it shows up with only some of its files and nothing says so:');
    p('  wpt-inventory.js <dir> --dirs             one line per directory: the map');
    p('  wpt-inventory.js <dir> --part <n>         the next whole-directory page');
    p('  wpt-inventory.js <dir> --include <path>   one area in full, evidence intact');
    p('  wpt-subtests.js  <dir> <path>             one file, every subtest and message');
  }
  p('');

  for (const b of chosen) for (const line of b.lines) p(line);

  if (paged) {
    p('');
    p(`!! END OF PART ${index} OF ${parts.length}. You have seen directories ${firstDir}-${lastDir} of ${groups.length}.`);
    if (index < parts.length) {
      p(`!! NOT YET READ: directories ${lastDir + 1}-${groups.length}. Continue with:`);
      // The caller's own flags, not a `<dir>` placeholder. The placeholder was both
      // unpasteable — `<dir>` is a shell redirect — and wrong: it dropped whatever
      // --include or --grep was narrowing the listing, so following it silently paged
      // through a DIFFERENT, unfiltered set of directories than the one being read.
      p(`!!   ${resume} --part ${index + 1}`);
    } else {
      p('!! That was the last part. Every directory has now been printed at least once.');
    }
  }
  return L;
}

// ---------------------------------------------------------------------------
// checklist.md — the coverage worksheet
// ---------------------------------------------------------------------------

/**
 * A worksheet with a verdict per directory and per file.
 *
 * The Popover API hint/auto rework was missed on a real pass while this line was
 * on screen:
 *
 *   /html/semantics/popovers  [5 files, +19 subtests, 5 fwd, 5 done]
 *
 * It was printed, read, quoted in conversation as "not yet examined", and then
 * never examined — five files, every one *done*, the strongest signal the tooling
 * emits. No additional signal would have helped, because the signal was already
 * maximal. What was missing was a completion criterion.
 *
 * The per-directory worksheet was then itself not enough, and failed the same way
 * one release later: /svg/types/scripted was ticked as "mostly new SVGLength
 * tests", true of five files and wrong about the sixth, which was
 * SVGTextPathElement.side shipping. A directory verdict absorbs the files inside
 * it, and "3 done" is a number you skim rather than a question you answer. Hence
 * a second worksheet at file granularity.
 */
/**
 * Group boxed files by the source file they are variants of.
 *
 * A `?class=`, `?include=` or `?exclude=` parameter selects which slice of a
 * reftest runs or which subtests are enabled. It does not change what feature the
 * file covers, so N variants ask the same question N times — and a worksheet that
 * asks the same question seventeen times gets sixteen transcriptions and one check.
 *
 * That is not hypothetical. One real pass answered
 * text-box-trim-start-001.html seventeen separate times, every answer a rewording
 * of "trim-start variant, see ?class=auto", and text-box-trim-end-001.html sixteen
 * more. 47 of 292 file boxes on that diff were variants of a file already boxed —
 * a sixth of the worksheet spent re-answering, which is time taken directly from
 * the boxes that were genuinely distinct.
 */
function collapseVariants(rows) {
  const groups = new Map();
  for (const r of rows) {
    // Same source file AND the same transition. Same-source-only would fold a
    // window/worker divergence away, and that divergence is itself the finding: on
    // one real diff basic-auth.any.html newly passed while
    // basic-auth.any.sharedworker.html regressed, and "the same test moved both ways
    // in two globals" is a flake signal that exists only as a comparison between the
    // two. Keying on the transition also means one odd variant out of seventeen gets
    // its own box instead of preventing the other sixteen from folding.
    const key = `${toSourcePath(r.test)} ${fmtSide(r.before)} -> ${fmtSide(r.after)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()];
}

/**
 * A substring that selects a whole variant family for --grep, i.e. the filename
 * with every generated suffix stripped: `no-vary-search.tentative.any.html` ->
 * `no-vary-search`. Handed to the reader so reading all seventeen variants is one
 * command with no `?`, no `|` and nothing to quote.
 */
function grepFragment(testPath) {
  let seg = String(testPath).replace(/\?.*$/, '').split('/').pop();
  const SUFFIX = /\.(html|htm|xhtml|xht|js|py|svg|any|window|worker|serviceworker|sharedworker|https|h2|tentative|sub|optional)$/i;
  for (let i = 0; i < 8; i++) {
    const next = seg.replace(SUFFIX, '');
    if (next === seg) break;
    seg = next;
  }
  return seg;
}

function renderChecklist(report, tests, { dir = '' } = {}) {
  // The worksheet is read long after it is written, by which time tmp/ may hold more
  // than one comparison — so the commands it suggests name their artifact.
  const at = dir ? ` ${dir}` : '';
  const L = [];
  const p = (s = '') => L.push(s);
  const groups = groupByDir(tests);
  const churnOnly = groups.filter((g) => g.churn === g.rows.length);
  const needsVerdict = groups.filter((g) => g.churn !== g.rows.length);

  p(`# Coverage checklist: ${report.before.spec} -> ${report.after.spec}`);
  p('');
  const jsGaps = jsGapBoxes(report.jsHorizon);
  p(`${needsVerdict.length} directories need a verdict. ${churnOnly.length} are pre-resolved`);
  p('as test-suite churn (added/removed tests only — different WPT revisions).');
  if (jsGaps.length) {
    p(`${jsGaps.length} JavaScript feature(s) have no test here at all and are boxed at the end.`);
  }
  const pg = report.prefGating;
  if (pg && pg.ok && (pg.gatedTests || []).length) {
    p(`${pg.gatedTests.length} file(s) are gated by a pref beta/release users do not have; their`);
    p('directories are marked. Discount those unless you were asked to include them.');
  } else if (pg && (pg.missingTool || !pg.ok)) {
    p('!! Pref gating was NOT checked, so nothing here is known to be available to users.');
  }
  p('');
  p('Work top to bottom. Replace EVERY box with an x and append " — <verdict>",');
  p('where the verdict is one of:');
  p('  [x] /some/dir  — written up: <the feature, as it appears in the notes>');
  p('  [x] /some/dir  — explained: same feature as <name the other entry>');
  p('  [x] /some/dir  — not a feature: <infrastructure, flake or churn, and why>');
  p('');
  p('wpt-inventory.js --verify enforces all three shapes, so a box ticked with no');
  p('verdict, or "explained" with nothing named after it, fails the gate exactly as');
  p('an unticked box does. "explained" without a target is not an explanation — it');
  p('reads as one while saying only that the line has been set aside.');
  p('Do not leave a line unticked, and do not stop at the interesting-looking ones.');
  p('A 5-file all-done directory was skipped that way once.');
  p('');
  for (const g of needsVerdict) {
    const marker = dirMarker(report.prefGating, g.dir.replace(/^\//, ''));
    p(`[ ] ${g.dir}  (${g.rows.length}f, ${signed(g.deltaPass)}, ${dirBits(g)})${marker ? `  ${marker.text}` : ''}`);
    if (marker) {
      p(`      ${marker.verdict === 'nightly-only'
        ? 'NIGHTLY-ONLY — not available to beta/release users. The right verdict is normally'
        : `${marker.label} — WPT forced the pref on, so passing does not mean a user has it.`}`);
      p(`      "not a feature: ${marker.verdict === 'nightly-only' ? 'nightly-only' : marker.verdict} (${marker.prefs[0]})" unless you were asked to include these.`);
    }
  }
  p('');
  p(`--- pre-resolved as churn (${churnOnly.length}), no verdict needed ---`);
  for (const g of churnOnly) p(`[x] ${g.dir}  (${g.rows.length}f, churn)`);

  // Boxed set = every *done* file (the strongest feature signal, and independent
  // of delta size) plus every file whose loaded evidence cannot name its own
  // feature. *done* alone was not enough: getAnimations.html went 29/34 -> 33/34
  // for `{ pseudoElement }` and is not *done* because ::part() still fails, so a
  // done-only worksheet gave it no box and it became an unexplained "+1".
  const boxed = tests
    .filter((r) => completed(r) || (movedForward(r) && opaquelyNamed(r)))
    .sort((a, b) => a.test.localeCompare(b.test));
  // One box per source file, not per generated variant.
  const families = collapseVariants(boxed);
  const collapsed = boxed.length - families.length;
  const partial = families.filter((f) => !f.every(completed)).length;
  const opaque = families.filter((f) => f.every(opaquelyNamed)).length;

  if (families.length) {
    p('');
    p(`## File checklist (${families.length})`);
    p('');
    p('Every file that reached 100% — "last failures cleared" — plus every file');
    p(`whose evidence cannot name its own feature (${partial} of these have not finished).`);
    p('A small delta here means "small because it was nearly finished", NOT "small');
    p('because it does not matter", and a file short of 100% can still be a shipped');
    p('feature with one edge case outstanding. Ticking a directory above does NOT');
    p('tick these: name the feature each covers, or say why it is not one.');
    p('');
    p(`A "(?)" box (${opaque}) marks a file whose evidence names nothing — positional`);
    p('subtest names and messages like "assert_true: expected true got false".');
    p('Measured from the loaded subtest names, not guessed from the path. For those');
    p(`only, read the source:  node scripts/wpt-fetch-tests.js${at} --grep <fragment> --head 0`);
    if (collapsed) {
      p('');
      p(`${collapsed} generated variant(s) are folded into the box for their source file:`);
      p('a ?class= or ?include= parameter picks which slice runs, not which feature the');
      p('file covers, so they are one question. The folded variants are listed under');
      p('each box — ONE verdict covers the family.');
    }
    p('');
    for (const family of families) {
      const rep = family.find((r) => !opaquelyNamed(r)) || family[0];
      // Name the family by the test path when the variants differ only by ?query, and
      // by the source file when they are separate globals of one .any.js.
      const stripped = [...new Set(family.map((r) => r.test.replace(/\?.*$/, '')))];
      const base = stripped.length === 1 ? stripped[0] : `/${toSourcePath(rep.test)}`;
      // "(?)" / "( )" rather than "[?]" / "[ ]": the directory worksheet above uses
      // square brackets, and when both used them neither list could be counted or
      // grepped apart. A family is only opaque when NO variant names its feature —
      // one variant with usable evidence answers for the whole file.
      const box = family.every(opaquelyNamed) ? '(?)' : '( )';
      const allDone = family.every(completed);
      const mark = allDone ? '*done*' : 'still failing some — check anyway';

      if (family.length === 1) {
        const r = family[0];
        // The checklist is the durable artifact, and the place a path most often gets
        // copied from into a follow-up command — so what it offers to be copied has to
        // be a command that runs without a permission prompt.
        //
        // This used to read `[quote it: '/a/b.html?x=(y|z)']`, which was advice that
        // solved the wrong half of the problem. Quoting is what the SHELL needs; the
        // permission matcher sees the raw string either way, and a `?` or `|` in it
        // stops the command being pre-approved however carefully it is escaped. So the
        // worksheet was handing the reader a path that could not be pasted, and it was
        // pasted: `wpt-subtests.js '/html/syntax/parsing/html5lib_url.html?file=webkit02'`
        // prompted, exactly as offered. --grep reaches the same test with no
        // metacharacters at all, and since variants now fold into families, the stem
        // identifies this box uniquely within the diff.
        const fragment = grepFragment(r.test);
        p(`${box} ${r.test}${needsQuoting(r.test) ? `   [reach it with: --grep ${fragment}]` : ''}`);
        p(`      ${fmtSide(r.before)} -> ${fmtSide(r.after)}  (${signed(r.deltaPass)})  ${mark}`);
      } else {
        const delta = family.reduce((a, r) => a + r.deltaPass, 0);
        const doneCount = family.filter(completed).length;
        // "0 *done*, +0 subtests" is true of a reftest family and tells you nothing:
        // a reftest contributes no subtests, so its whole result is the status flip.
        // Report the transition when every variant made the same one, which is the
        // normal case for a family and the thing that makes a rendering fix visible.
        const transitions = [...new Set(family.map((r) => `${fmtSide(r.before)} -> ${fmtSide(r.after)}`))];
        const bits = [`${family.length} variants`];
        if (transitions.length === 1) bits.push(`all ${transitions[0]}`);
        else bits.push(`${transitions.length} distinct transitions`);
        if (delta) bits.push(`${signed(delta)} subtests total`);
        if (doneCount === family.length) bits.push('*done*');
        else if (doneCount) bits.push(`${doneCount} *done*`);
        p(`${box} ${base}   [${family.length} variants]`);
        p(`      ${bits.join(', ')}`);
        p(`      read all ${family.length}:  node scripts/wpt-subtests.js${at} --grep ${grepFragment(base)}`);
        // Listed, never summarised away: a folded variant the reader cannot see is a
        // box that silently stopped existing.
        let line = '      variants:';
        for (const r of family) {
          const q = r.test.slice(base.length) || '(no query)';
          if (line.length + q.length + 1 > 92) {
            p(line);
            line = '               ';
          }
          line += ` ${q}`;
        }
        p(line);
        p(`      evidence from ${rep.test.slice(base.length) || '(no query)'}: `
          + `${fmtSide(rep.before)} -> ${fmtSide(rep.after)}  (${signed(rep.deltaPass)})`);
      }
      for (const line of evidenceLines(rep, '      ')) p(line);
      const positional = positionalSubtests(rep);
      if (positional.length) {
        p(`      NOTE: ${positional.length} subtest name(s) here are positional ("... 2").`);
        p('      They are zero-indexed AFTER the first, so " 2" is the THIRD test()');
        p('      block. Count test( blocks in the source before mapping one.');
      }
    }
  }

  for (const line of jsChecklistLines(report.jsHorizon)) p(line);
  for (const line of bugChecklistLines(report.changelog)) p(line);
  return L;
}

/**
 * The worksheet's third list: JavaScript features with no test on either side.
 *
 * Separate from renderChecklist so wpt-js-gaps.js can append exactly this to an
 * artifact collected before the check existed, rather than an approximation of it.
 *
 * Last of the three lists because it is smallest, not least: on the comparison that
 * produced it, three of its five boxes were features the notes should have led with.
 */
function jsChecklistLines(h) {
  const jsGaps = jsGapBoxes(h);
  if (!jsGaps.length) return [];
  const L = [];
  const p = (s = '') => L.push(s);
  p('');
  const nMissing = jsGaps.filter((b) => b.kind === 'missing').length;
  const nRevendored = jsGaps.length - nMissing;
  p(`## JavaScript features the diff cannot show normally (${jsGaps.length})`);
  p('');
  p('WPT vendors test262 rather than tracking it, so the JS half of a run has a horizon.');
  p(`This comparison's snapshot is tc39/test262 @ ${h.after.rev.slice(0, 10)}${h.lagDays === null ? '' : `, ${h.lagDays} days behind upstream`}.`);
  if (nMissing) {
    p('');
    p(`${nMissing} flag(s) are declared upstream and NOT in this snapshot — a PROOF that neither`);
    p('run holds a single test for them, not a guess. The diff, the inventory, the ranked');
    p('report and wpt-state.js are all silent, and that silence looks exactly like the');
    p('feature not shipping. Firefox 154 shipped Iterator Chunking, Includes and Join into a');
    p('117-day-old snapshot; all three were invisible and all three were missed.');
  }
  if (nRevendored) {
    p('');
    p(`${nRevendored} flag(s) arrived BETWEEN the two runs, because test262 was re-vendored. Those`);
    p('are the opposite case: their tests DO exist, in the after run only, so they classify as');
    p('`added` and the directory worksheet pre-resolves them as test-suite churn. True about');
    p('the mechanism, wrong about the consequence — a whole proposal\'s tests arriving is a');
    p('lead. Read them locally; the source is already cached:');
    p('  node scripts/wpt-subtests.js --grep <flag-ish fragment>');
    p('  node scripts/wpt-fetch-tests.js --grep <fragment> --head 0');
  }
  p('');
  // The Bugzilla answer, printed here rather than left as an exercise. The previous
  // version of this section said "look the flag up in Bugzilla", and that produced a
  // worse outcome than silence: `quicksearch=iterator-chunking` returns zero bugs, so
  // all three shipped Iterator proposals were found, checked, and ruled out.
  const sh = h.shipped;
  if (h.fyi && h.fyi.ok) {
    p(`Each box carries a test262.fyi measurement: ${h.fyi.engine} ${h.fyi.version}, run with and`);
    p('without experimental options, so it says whether the feature works AND whether it is');
    p('on by default. That build is a NIGHTLY, so it does not say which release enabled it.');
    p('');
  }
  if (sh && sh.ok) {
    p(`Each box also carries ${sh.source}'s answer for ${sh.product} ${sh.version}, so do not`);
    p('re-derive it. Searching a bug tracker for a test262 flag name does not work — every');
    p('one of these returns zero bugs, including the ones that shipped:');
    p('');
    p('  quicksearch=iterator-chunking        0 bugs   (shipped in Firefox 154)');
    p('  quicksearch=Iterator.prototype.join  0 bugs   (shipped in Firefox 154)');
    p('');
    if (sh.extra && sh.extra.length) {
      p(`Vendors write prose. ${sh.extra.length} bug(s) whose summary starts "Ship" are flagged fixed for`);
      p(`${sh.version}, and that list needs no guess about wording:`);
      p('');
      for (const b of sh.extra) p(`  bug ${b.id}  ${b.summary}`);
      p('');
      p('A box saying NOT FOUND means the per-flag wording missed, NOT that the feature did');
      p('not ship. Check it against that list by eye before answering.');
    } else {
      p('A box saying NOT FOUND means the per-flag wording missed, NOT that the feature did');
      p('not ship. Weigh the test262.fyi measurement before answering.');
    }
  } else if (sh && sh.unsupported) {
    // Named as a known limit rather than left as a shrug. Safari lands here: WebKit's
    // Bugzilla has no per-release status field, and pointing the Firefox logic at it
    // produces confident nonsense — "Iterator chunking" returns a 2015 Web Inspector bug.
    p(`There is NO release-attribution source wired up for ${sh.product}:`);
    p(`  ${sh.error}.`);
    p('So "which version turned it on" is UNANSWERED for every box below — not "no". The');
    p('test262.fyi measurement above still tells you whether it works and is on by default');
    p('in the tested build. For the version, check by hand:');
    for (const url of sh.lookAt || []) p(`  ${url}`);
  } else {
    p('These are the only boxes here that cannot be answered from the artifact, and the');
    p('automatic release check did not run, so each needs a lookup. Do NOT search for the');
    p('flag name: `quicksearch=iterator-chunking` returns zero bugs for a feature that');
    p('shipped in Firefox 154. Search the feature as prose ("Iterator Chunking"), or run:');
    p('  node scripts/wpt-js-gaps.js');
  }
  p('');
  p('Then answer in one of these shapes (indented, so they are examples, not boxes — and');
  p('note that one flag names a whole PROPOSAL, so one box can cover several methods):');
  p('  written up: Iterator.prototype.chunks() and .windows(), per bug 2047997');
  p('  not a feature: implemented but preffed off in this release, bug 2045859');
  p('  not a feature: test262 harness plumbing, not a language feature');
  p('');
  for (const box of jsGaps) {
    const finding = jsFinding(h, box.feature.name);
    const where = box.kind === 'revendored' ? 'tests are NEW in the after run' : 'no test here';
    p(`[ ] ${box.path}   (${where}${finding ? `; ${finding.short}` : ''})`);
    const bits = [box.feature.label, box.feature.section].filter(Boolean).join(' / ');
    if (bits) p(`      ${bits}`);
    if (box.feature.url) p(`      ${box.feature.url}`);
    for (const line of (finding ? finding.lines : [])) p(`      ${line}`);
  }
  return L;
}

/**
 * One box per JavaScript feature this comparison cannot see.
 *
 * A box rather than a printed caveat, for the reason the whole worksheet exists: the
 * Popover API rework was missed while the strongest signal the tooling emits was on
 * screen, because a printed line is state nobody keeps. A gap that no view can
 * confirm needs that discipline more than anything else here, not less — and unlike
 * every other box, the reader has to leave the artifact to answer it.
 *
 * `revendored` flags are boxed too. Their tests exist in the after run only, so they
 * land in the `added` bucket, which the directory worksheet pre-resolves as churn —
 * so without a box of their own they are the one class of gap that arrives already
 * ticked.
 */
function jsGapBoxes(h) {
  if (!h || !h.ok) return [];
  const boxes = [];
  const seen = new Set();
  // Tagged, because the two classes are opposites and were sharing one label. A `missing`
  // flag has no test in EITHER run; a `revendored` one has tests in the after run only. Both
  // need a box, but "no test here" is true of the first and false of the second — a
  // mislabelling that only stayed harmless while WPT re-vendored test262 twice a year. It is
  // now on a weekly cadence, so straddling a re-vendor is the normal case for any
  // release-to-release diff, and `revendored` becomes the common class rather than the rare one.
  for (const [kind, list] of [['missing', h.missing], ['revendored', h.revendored || []]]) {
    for (const feature of list) {
      const path = jsBoxPath(feature.name);
      if (seen.has(path)) continue;
      seen.add(path);
      boxes.push({ path, feature, kind });
    }
  }
  return boxes;
}

/** Every box line's path, in file order. One parser, used on both sides of --verify. */
function boxPaths(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(?:\[[ x]\]|\([ ?x]\))\s+(\S+)/i);
    if (m) out.push(m[1]);
  }
  return out;
}

// Phrases that occupy the space where an answer goes. "written up — see notes" is
// the canonical one, and it is what a bulk-apply script reaches for as its
// fallback: one real attempt at resolving this worksheet by regex ended
// `return line.replace('[ ]', '[x]') + '  — written up — see notes'`, which would
// have stamped every box no rule matched and passed the gate on all 416.
// Deliberately not "unknown": it is ordinary wording inside a quoted assertion
// message, and blocking it rejected a good verdict whose evidence was the harness
// error `unknown command browsingContext.stopScreencast`. A non-answer list has to
// match how a verdict defers, not any word that sounds vague.
const NON_ANSWER = /\b(see notes?|see above|see below|as above|as described|as discussed|various|miscellaneous|tbd|todo|n\/a)\b/i;

// The verdict kinds, however they are punctuated.
//
// `regression:` earns its place rather than diluting the vocabulary. Two independent passes
// reached for it — once four times, once about fifteen — after following the instruction to
// use `written up:` instead, and both reported the same reason: "written up" does double duty
// as "this is a feature" and "this is in the notes", so a regression verdict reads wrong even
// when it is right. It also carries information the notes already need, since they have a
// separate Regressions section, so `regression:` is strictly more informative than the
// `written up:` it replaces. It means the same thing to the gate.
const VERDICT_KIND = /\b(written[ -]up|regression|explained|not[ -]a[ -]feature|churn)\b/i;

// Words too generic to be a reference to anything.
const STOPWORDS = new Set(`same feature features cause causes group grouped groups
this that these those with from into than then also only both each more most some
other another above below part parts covered belongs entry entries test tests file
files variant variants case cases thing things issue issues bug bugs fix fixes fixed
work item items section sections note notes here there where which what when does
done been being have has had was were will would could should must may might real
still just like about over under after before same see and the for not but all any
one two three onwards etc via per new old own set way its it's whole rest side`
  .split(/\s+/).filter(Boolean));

/**
 * Does an "explained" verdict point at something the worksheet actually contains?
 *
 * "explained" means "same cause as another entry — name which", and a verdict that
 * names nothing is not an explanation. It reads as one while saying only that the
 * line has been set aside, and nothing can check it.
 *
 * The obvious test — does the verdict contain "see" or "same as"? — is wrong, and
 * measurably so: on a real resolved worksheet it flagged 28 verdicts, and all 28
 * were fine. `explained: sibling-index() in anchor() (tree-counting)` names
 * /css/css-values/tree-counting, and `explained: BiDi user contexts` is verbatim
 * another box's *written up* verdict. Both are exactly what "name which" asks for,
 * in neither of the two phrasings the pattern knew about.
 *
 * So resolve it instead of pattern-matching it: some distinctive word in the verdict
 * has to appear in ANOTHER box's path, or in some box's "written up" verdict. That
 * is the invariant the instruction is actually asking for, it holds regardless of
 * phrasing, and it makes the worksheet internally consistent — every deferral
 * points at something else in the worksheet, so following a chain of them
 * terminates somewhere real.
 */
function explainedResolves(verdict, ownPath, paths, writtenUpText) {
  const words = String(verdict).toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) || [];
  // Hyphenated identifiers also count by their parts, so "focused-target" can
  // resolve against a verdict that says "focused".
  const parts = words.flatMap((w) => w.split(/[-_]/)).filter((s) => s.length >= 5);
  const tokens = [...new Set([...words, ...parts])]
    .filter((t) => !STOPWORDS.has(t) && t !== 'explained');
  if (tokens.some((t) => (
    writtenUpText.includes(t)
    // Another box's path, not its own: a verdict echoing the directory it sits on
    // defers to itself, which terminates nowhere.
    || paths.some((q) => q !== ownPath && q.includes(t))
  ))) return true;

  // "same as 066" / "same as -001": a numbered sibling. The reference is exact even
  // though the token is three digits and would never survive a relevance filter, so
  // resolve it structurally — substitute the number into the numeric run of this
  // box's own path and see whether that names another box. All five such verdicts on
  // one real worksheet pointed at a file that was genuinely boxed; a check that
  // rejected them would have been teaching the reader to write worse verdicts.
  const nums = String(verdict).match(/\d{2,}/g) || [];
  const runs = [...ownPath.matchAll(/\d{2,}/g)];
  return nums.some((n) => runs.some((m) => {
    const cand = ownPath.slice(0, m.index) + n + ownPath.slice(m.index + m[0].length);
    return cand !== ownPath && paths.includes(cand);
  }));
}

/** The text after the box and path, i.e. the reader's verdict. */
function verdictOf(line) {
  const m = String(line).match(/\s(?:—|–|--|-)\s+(.+)$/);
  return m ? m[1].trim() : '';
}

/**
 * Audit a worksheet: unticked boxes, ticked boxes whose verdict is not an answer,
 * and boxes that stopped existing.
 *
 * The point of a checklist is a completion criterion, and a criterion nobody can
 * evaluate is just advice with punctuation. Two features were lost after the
 * worksheet existed, both by stopping early, so stopping early became an exit code.
 *
 * Counting ticks was then not enough either, twice over. It certified "every line I
 * still have has an x on it":
 *
 *   - A tick with no verdict passed. So did `— written up — see notes`. The gate
 *     checked the box and never read the answer.
 *   - Nothing recorded which boxes were supposed to exist. A pass that resolved the
 *     worksheet by rewriting it whole dropped 4 evidence lines and stripped all 49
 *     paste helpers while leaving the count at 416, so the gate saw nothing. Nothing
 *     load-bearing was lost that time. A dropped *box* would have been invisible,
 *     and invisible is the entire failure mode this file exists to prevent.
 *
 * `expected` is the box list recorded at collection time (boxes.json). Absent —
 * an artifact collected before it was written — the inventory check is skipped and
 * says so, rather than silently reporting a clean bill of health it did not check.
 */
function verifyChecklist(text, expected = null) {
  const open = [];
  const bad = [];
  let done = 0;

  // Pass 1: classify every box. The "explained" check needs the whole worksheet
  // before it can resolve anything, so nothing is judged until all of it is read.
  const ticked = [];
  for (const line of String(text).split('\n')) {
    // Directory boxes are [ ]/[x]; file boxes are ( )/(?)/(x). Anything the reader
    // has replaced with an x counts as resolved.
    if (/^(\[ \]|\(\s\)|\(\?\))/.test(line)) {
      open.push(line.trim());
      continue;
    }
    if (!/^(\[x\]|\(x\))/i.test(line)) continue;
    done++;
    const t = line.trim();
    const m = t.match(/^(?:\[x\]|\(x\))\s+(\S+)/i);
    ticked.push({ line: t, path: m ? m[1].toLowerCase() : '', verdict: verdictOf(t) });
  }

  const paths = ticked.map((b) => b.path).filter(Boolean);
  const writtenUpText = ticked
    .filter((b) => /\bwritten[ -]up\b/i.test(b.verdict))
    .map((b) => b.verdict.toLowerCase())
    .join('\n');

  // Pass 2: judge each verdict.
  for (const b of ticked) {
    // Churn directories are pre-resolved by the generator and carry no verdict.
    if (/,\s*churn\)/i.test(b.line)) continue;
    if (!b.verdict) {
      bad.push({ line: b.line, why: 'ticked, but carries no verdict at all' });
      continue;
    }
    // Name the trigger, always. A gate that says only "this is wrong" teaches avoidance
    // rather than precision: one pass spent three round-trips rewording a single verdict,
    // guessing at which word had tripped the check, and never found out. The rejected
    // phrase is the one piece of information the reader cannot reconstruct.
    const defers = b.verdict.match(NON_ANSWER);
    if (defers) {
      bad.push({
        line: b.line,
        why: `the verdict defers instead of answering — the phrase "${defers[0]}" is what `
          + 'triggered this; say what the feature is, or why it is not one',
      });
      continue;
    }
    const kind = b.verdict.match(VERDICT_KIND);
    if (!kind) {
      // The set is closed, and `regression:` is the natural thing to reach for — one pass
      // wrote it four times. A regression that goes in the notes IS "written up".
      const first = (b.verdict.match(/^\s*([a-z][a-z -]{0,20}?):/i) || [])[1];
      bad.push({
        line: b.line,
        why: (first ? `"${first}:" is not one of the verdict kinds. ` : 'verdict names no kind. ')
          + 'Use exactly one of "written up:", "regression:", "explained:" or '
          + '"not a feature:" — "regression:" is for one you are reporting as a regression',
      });
      continue;
    }
    // A bare kind with no detail is the same non-answer in fewer words.
    if (b.verdict.replace(VERDICT_KIND, '').replace(/[\s:.,;—–-]+/g, '').length === 0) {
      bad.push({ line: b.line, why: `"${kind[1]}" with no detail — say which feature, or why not one` });
      continue;
    }
    if (/^explained$/i.test(kind[1])
      && !explainedResolves(b.verdict, b.path, paths, writtenUpText)) {
      bad.push({
        line: b.line,
        why: '"explained" but nothing it names appears in another box or in any "written up" verdict',
      });
    }
  }

  const seen = boxPaths(text);
  let missing = [];
  let extra = [];
  if (expected) {
    const have = new Set(seen);
    const want = new Set(expected);
    missing = expected.filter((p) => !have.has(p));
    extra = seen.filter((p) => !want.has(p));
  }
  return {
    open, bad, done, total: open.length + done, missing, extra, inventoryChecked: !!expected,
  };
}

// ---------------------------------------------------------------------------
// One file, in full — every subtest and every message
// ---------------------------------------------------------------------------

/**
 * The complete subtest picture for one test file, with the assertion messages.
 *
 * A subtest count names a file, not a cause. Sections a feature description is
 * built from are never silently truncated here: a partial read of the RIGHT file
 * is harder to notice than not reading it at all. One pass characterised
 * webrtc-stats/supported-stats.https.html from the tail of its 24 newly-passing
 * subtests and missed the 12 RTCTransportStats properties in the middle.
 */
/**
 * The transition categories a per-file view can be narrowed to.
 *
 * "Show me just what newly passes" is a category question, and without a flag for
 * it the answer is a shell grep on the rendered arrow — which is lossy in a way
 * that is invisible. `grep 'FAIL    -> PASS'` misses a subtest that was NOTRUN or
 * TIMEOUT before, and misses `(new)   -> PASS` entirely. That second one is how an
 * ENTIRELY NEW interface shows up, so the pattern fails hardest on exactly the
 * claim it tends to be used to check: on one real diff it under-reported in 19
 * files, hiding 55 new-subtest passes and 13 non-FAIL priors.
 *
 * `newly-passing` deliberately spans both fixes and brand-new assertions, so this
 * cannot under-report the way the grep does.
 */
const CATEGORIES = ['newly-passing', 'newly-failing', 'changed', 'removed', 'still-failing'];

function renderFile(report, r, { limit = 0, match = null, matchLabel = null, only = null } = {}) {
  const show = (cat) => !only || only.has(cat);
  const L = [];
  const p = (s = '') => L.push(s);
  const st = r.subtests;

  p('='.repeat(74));
  p(`# ${r.test}`);
  // A variant path like `?exclude=(file|javascript|mailto)` cannot be pasted into a
  // command as-is: `?` globs, `(...)` groups and `|` pipes, so the shell fails before
  // node runs and nothing can report why. 17% of changed paths in one real comparison
  // needed this.
  //
  // Quoting fixes that, and it is genuinely required if you pass the path literally —
  // but it fixes only the shell. The permission matcher sees the raw string either
  // way, so a quoted `?query` path still stops being pre-approved and still prompts.
  // This block used to say `# paste as: '<quoted>'`, which read as "this is the form
  // to use" and was then used: a real pass pasted
  // `wpt-subtests.js '/html/syntax/parsing/html5lib_url.html?file=webkit02'` and hit
  // the prompt the label had implied it was avoiding.
  //
  // So --grep leads, because it has no metacharacters to escape in the first place,
  // and the quoted form stays as the literal-path fallback it actually is. Neither
  // line begins with a runnable `node scripts/` prefix, so the quoted path is never
  // the thing sitting in the copy position.
  if (needsQuoting(r.test)) {
    p(`# reach it with:  --grep ${grepFragment(r.test)}`);
    p(`# or as a literal path, shell-quoted: ${shellQuote(r.test)}`);
    p('#   (the quotes are what the shell needs; the command will still ask permission)');
  }
  p('='.repeat(74));
  p('');
  p(`kind     : ${r.kind}${r.statusDirection ? ` (${r.statusDirection})` : ''}`);
  p(`harness  : ${STATUS_NAMES[r.before?.status] || r.before?.status || '(absent)'} -> ${STATUS_NAMES[r.after?.status] || r.after?.status || '(absent)'}`);
  p(`subtests : ${r.before ? `${r.before.pass}/${r.before.total}` : '-'} -> ${r.after ? `${r.after.pass}/${r.after.total}` : '-'} passing`);
  if (r.before?.message) p(`baseline harness message: ${clip(r.before.message, 300)}`);
  if (r.after?.message) p(`compare harness message : ${clip(r.after.message, 300)}`);

  if (!st) {
    p('');
    p('No subtest data. Reftests and skipped tests legitimately have none — the whole');
    p('result is the harness status above.');
    return L;
  }

  const keep = (rows) => (match ? (rows || []).filter((s) => match(s.name) || match(s.message || '')) : rows || []);

  // ---- synopsis, FIRST ----
  //
  // This used to sit at the bottom, which put the one thing that tells you the
  // *shape* of a file behind up to several hundred lines of detail — so any
  // truncation destroyed exactly the part worth keeping. A reader who slices this
  // output with `head` now still gets the counts and the dominant causes; they
  // lose examples, which is recoverable, rather than the conclusion, which isn't.
  const counts = st.counts;
  p('');
  p('## Synopsis');
  p(`  ${counts.newlyPassing} newly passing, ${counts.newlyFailing} newly failing, ` +
    `${counts.changed} failure changed, ${counts.removed} removed`);
  p(`  ${counts.stillFailing} failing in both runs, ${counts.passingBoth} passing in both`);

  // Both directions get a rollup. A dominant shape among the FIXES means one bug
  // was fixed and unblocked many tests; a dominant shape among what STILL FAILS
  // names the limitation precisely, which is the other half of an honest note.
  //
  // Ordered so a filtered read gets its OWN side first. With `--only still-failing` on
  // color-valid-color-mix-function.html the still-failing rollup is skipped (one subtest, no
  // repeat) and the 144x FIXES rollup was the first substantive thing on screen — a reader
  // who asked for failures nearly attributed it to them. Requested category first, the other
  // side labelled as the other side, and a requested category with no dominant message says
  // so rather than vanishing.
  const rollups = [
    ['fixes', 'newly-passing', st.newlyPassing,
      'ONE bug fixed unblocking many tests — not many separate fixes'],
    ['still-failing', 'still-failing', st.stillFailing,
      'ONE remaining limitation, not many scattered failures'],
  ];
  if (only) rollups.sort((a, b) => (only.has(b[1]) ? 1 : 0) - (only.has(a[1]) ? 1 : 0));
  for (const [label, category, list, note] of rollups) {
    const requested = !only || only.has(category);
    const rollup = messageRollup(list);
    if (!rollup.length || rollup[0].count < 2) {
      if (only && requested && list.length) {
        p('');
        p(`  no dominant ${label} message — ${list.length} subtest(s), no repeated message.`);
      }
      continue;
    }
    const share = `${rollup[0].count}/${list.length}`;
    p('');
    if (!requested) {
      p(`  NOT WHAT YOU ASKED FOR: the rollup below is the ${category} side, which --only`);
      p(`  filtered out. Do not read it as ${[...only].join('/')}.`);
    }
    p(`  dominant ${label} message (${share}) — if this accounts for most of them, that is`);
    p(`  ${note}:`);
    for (const { message, count } of rollup.slice(0, 4)) {
      p(`    ${String(count).padStart(3)}x  ${message}`);
    }
    // One unabridged example per rollup. These messages carry the cause in their
    // expected-vs-got tail, and the normalised key necessarily strips exactly that
    // — so without an exemplar the reader has to run a second command to find out
    // what the dominant bug actually was, which is how "the second percentage was
    // dropped on serialization" needed digging for rather than being on screen.
    p('    e.g. ' + clip(rollup[0].example, 300));
  }

  // A renamed subtest at a fixed revision is a behaviour change, and reads as churn
  // because "added"/"removed" are the same words used for genuine test-suite churn.
  // Announced before any filtering, because --only newly-passing hides the removed
  // half and that is precisely how the pairing became invisible.
  const sameRevision = report.before.wpt_revision === report.after.wpt_revision;
  const renames = detectRenames(st);
  if (renames.paired) {
    p('');
    if (sameRevision) {
      p(`  !! ${renames.paired} subtest(s) were RENAMED, not added or removed. Both runs are at`);
      p(`  !! WPT revision ${report.after.wpt_revision}, so the test source is byte-identical —`);
      p('  !! no test was rewritten. These names embed a value the browser computes, so a');
      p('  !! rename means THE COMPUTED VALUE CHANGED. That is a behaviour change, and the');
      p('  !! strongest kind. Do NOT write it off as test churn.');
    } else {
      p(`  ${renames.paired} subtest(s) look renamed rather than added/removed. The runs are at`);
      p(`  different revisions (${report.before.wpt_revision} -> ${report.after.wpt_revision}), so this`);
      p('  may be a rewritten test OR a changed computed value — compare the pair below.');
    }
    for (const e of renames.examples) {
      p(`      was: ${clip(e.was, 110)}`);
      p(`      now: ${clip(e.now, 110)}`);
    }
  }

  if (match || only) {
    p('');
    const how = [
      match ? `matching ${matchLabel}` : null,
      only ? `in ${[...only].join(', ')}` : null,
    ].filter(Boolean).join(' and ');
    p(`  FILTERED to subtests ${how}. Counts above are the file's true totals;`);
    p('  the sections below show only what matched.');
    // Naming the non-empty categories being suppressed. `--only newly-passing` on a
    // file with 20 removed subtests hid exactly the half that showed 20 "new"
    // subtests were renames of the old ones.
    if (only) {
      const hidden = [
        ['newly-passing', counts.newlyPassing],
        ['newly-failing', counts.newlyFailing],
        ['changed', counts.changed],
        ['removed', counts.removed],
        ['still-failing', counts.stillFailing],
      ].filter(([name, n]) => n > 0 && !only.has(name));
      if (hidden.length) {
        p(`  HIDDEN by --only: ${hidden.map(([n, c]) => `${c} ${n}`).join(', ')}.`);
        p('  Those may explain what you are looking at — re-run without --only if unsure.');
      }
    }
  }

  // Entries are collected rather than printed, so the caller can page them at entry
  // boundaries. A 213-fix file renders to 66KB — over twice the tool output limit —
  // so the bare command simply failed, and the reflex fallback of piping to `head`
  // cuts mid-entry and loses the section titles.
  const entries = [];
  const section = (title, rows, fmt, loud = false) => {
    if (!rows.length) return;
    const heading = `${title} (${rows.length})`;
    const shown = limit > 0 ? rows.slice(0, limit) : rows;
    shown.forEach((s, i) => entries.push({ section: heading, first: i === 0, lines: fmt(s) }));
    const hidden = rows.length - shown.length;
    if (!hidden) return;
    entries.push({
      section: heading,
      first: !shown.length,
      lines: loud
        ? [
            `  !! ${hidden} MORE NOT SHOWN — re-run with --limit 0 before describing`,
            '  !! this file; the hidden ones may change the story.',
          ]
        : [`  ... and ${hidden} more (--limit 0 for all)`],
    });
  };

  // Newly passing splits into fixes and brand-new assertions: a new assertion that
  // holds is usually the feature, but it is not the same claim as "this used to
  // fail and now passes", and conflating them overstates a release.
  const fixes = keep(st.newlyPassing).filter((s) => !s.added);
  const addedPassing = keep(st.newlyPassing).filter((s) => s.added);
  const breaks = keep(st.newlyFailing).filter((s) => !s.added);
  const addedFailing = keep(st.newlyFailing).filter((s) => s.added);

  section('Newly passing (was failing, now passes)', show('newly-passing') ? fixes : [], (s) => [
    `  ${String(s.was || '?').padEnd(7)} -> PASS  ${clip(s.name, 90)}`,
    ...(s.message ? [`      was: ${clip(s.message, 200)}`] : []),
  ], true);

  section('Newly passing (subtest is new on the compare side)', show('newly-passing') ? addedPassing : [], (s) => [
    `  (new)   -> PASS  ${clip(s.name, 90)}`,
  ], true);

  section('Newly failing (was passing, now fails)', show('newly-failing') ? breaks : [], (s) => [
    `  PASS    -> ${String(s.now || '?').padEnd(7)}  ${clip(s.name, 90)}`,
    ...(s.message ? [`      now: ${clip(s.message, 200)}`] : []),
  ], true);

  section('New subtests that fail', show('newly-failing') ? addedFailing : [], (s) => [
    `  (new)   -> ${String(s.now || '?').padEnd(7)}  ${clip(s.name, 90)}`,
    ...(s.message ? [`      now: ${clip(s.message, 200)}`] : []),
  ], true);

  section('Failure changed (still failing)', show('changed') ? keep(st.changed) : [], (s) => [
    `  ${String(s.was).padEnd(7)} -> ${String(s.now).padEnd(7)}  ${clip(s.name, 90)}`,
    ...(s.message ? [`      now: ${clip(s.message, 200)}`] : []),
  ], true);

  section('Subtests only in the baseline (removed)', show('removed') ? keep(st.removed) : [], (s) => [
    `  ${String(s.was || '?').padEnd(7)} ${clip(s.name, 90)}`,
  ]);

  // Not "context" in small print: what a feature still gets wrong is half of an
  // honest release note, and on a real file 48 of these 57 shared one cause.
  section('Still failing in both runs', show('still-failing') ? keep(st.stillFailing) : [], (s) => [
    `  ${String(s.status).padEnd(7)} ${clip(s.name, 90)}`,
    ...(s.message ? [`      ${clip(s.message, 200)}`] : []),
  ]);

  const tail = [];
  if (!match && st.counts.stillFailing > st.stillFailing.length) {
    tail.push(`  (${st.counts.stillFailing - st.stillFailing.length} further still-failing subtests were not stored)`);
  }

  const positional = positionalSubtests(r);
  if (positional.length) {
    tail.push('');
    tail.push(`NOTE: ${positional.length} newly-passing subtest name(s) are positional ("... 2").`);
    tail.push('They are zero-indexed AFTER the first, so " 2" is the THIRD test() block.');
    tail.push('Count test( blocks in the source before mapping one to a behaviour.');
  }
  // header is repeated on every page: it is the synopsis, so a page without it
  // would be uninterpretable on its own.
  return { header: L, entries, tail };
}

/** renderFile flattened, for callers that do not page. */
function renderFileLines(report, r, opts) {
  const { header, entries, tail } = renderFile(report, r, opts);
  const out = [...header];
  let current = null;
  for (const e of entries) {
    if (e.section !== current) {
      out.push('');
      out.push(`## ${e.section}`);
      current = e.section;
    }
    out.push(...e.lines);
  }
  return [...out, ...tail];
}

/**
 * Several files' per-file views, paged at subtest-entry boundaries.
 *
 * Never breaks inside an entry, and repeats the owning file's header and synopsis on
 * every page, so each page stands alone. Each page states which entries it covered
 * and what has not been read — the same contract as the inventory's --part, for the
 * same reason: 66KB of output for one file exceeds the tool limit, and a page break
 * that does not say so is indistinguishable from the end of the data.
 */
function renderFiles(report, rows, { part = 1, budget = 22000, all = false, ...opts } = {}) {
  const files = rows.map((r) => ({ r, ...renderFile(report, r, opts) }));
  const cost = (lines) => lines.reduce((s, l) => s + l.length + 1, 0);

  // Flatten to a stream of pageable units, each tagged with its file.
  const units = [];
  for (const f of files) {
    f.entries.forEach((e, i) => units.push({ f, e, last: i === f.entries.length - 1 }));
    if (!f.entries.length) units.push({ f, e: null, last: true });
  }

  const pages = [];
  let page = [];
  let size = 0;
  for (const u of units) {
    const c = cost(u.e ? u.e.lines : []) + (page.length ? 0 : cost(u.f.header));
    if (page.length && size + c > budget) {
      pages.push(page);
      page = [];
      size = 0;
    }
    page.push(u);
    size += c + (page.length === 1 ? cost(u.f.header) : 0);
  }
  if (page.length) pages.push(page);
  if (!pages.length) pages.push([]);

  const chosen = all ? units : pages[Math.min(Math.max(1, part), pages.length) - 1];
  const index = all ? 1 : Math.min(Math.max(1, part), pages.length);
  const total = all ? 1 : pages.length;

  const out = [];
  if (total > 1) {
    out.push(`!! PART ${index} OF ${total} — THIS IS NOT THE WHOLE OUTPUT.`);
    out.push('!! Pages break between subtests, never inside one, and each repeats its');
    out.push("!! file's synopsis. Read every part.");
    out.push('');
  }
  let currentFile = null;
  let currentSection = null;
  for (const u of chosen) {
    if (u.f !== currentFile) {
      out.push(...u.f.header);
      currentFile = u.f;
      currentSection = null;
    }
    if (u.e && u.e.section !== currentSection) {
      out.push('');
      out.push(`## ${u.e.section}${u.e.first ? '' : ' — continued'}`);
      currentSection = u.e.section;
    }
    if (u.e) out.push(...u.e.lines);
    if (u.last) out.push(...u.f.tail);
  }
  if (total > 1) {
    out.push('');
    out.push(`!! END OF PART ${index} OF ${total}.`);
    if (index < total) {
      out.push(`!! NOT YET READ: the remaining ${total - index} part(s). Continue with:`);
      // As above: a real command, built by the caller from its own arguments.
      out.push(`!!   ${opts.resume || 'node scripts/wpt-subtests.js'} --part ${index + 1}`);
    } else {
      out.push('!! That was the last part.');
    }
  }
  return out;
}

module.exports = {
  renderReport, renderInventory, renderChecklist, renderFile, renderFileLines,
  renderFiles, verifyChecklist, boxPaths, verdictOf, grepFragment, collapseVariants,
  groupByDir, evidenceLines, opaquelyNamed, positionalName, positionalSubtests,
  messageNamesSomething, CATEGORIES, jsBoxPath, jsGapBoxes, jsHorizonLines,
  jsChecklistLines, jsFinding, jsFyiLines, jsUpstreamLines, jsHorizonCaveat,
  changelogLines, bugChecklistLines, bugGapBoxes, bugFinding, bugBoxPath,
  prefGatingLines, prefCaveat,
};
