#!/usr/bin/env node
/**
 * Assert that the tooling still surfaces the features it once missed.
 *
 * Every artifact-based entry below is a real miss from a real release-notes pass,
 * recorded in the skill as prose. Prose does not fail. A default
 * `--exclude /third_party` looked obviously reasonable when it was written and hid
 * the whole `Intl.Locale` info proposal; nothing but a reader's memory stopped that
 * from being reintroduced, and something very like it was reintroduced later in the
 * cluster section. So the postmortems live here as well, where a regression is an
 * exit code.
 *
 * Cases run against real collected artifacts, since the whole point is end-to-end
 * behaviour. They live in tmp/selftest/ — a subdirectory of its own, because tmp/
 * is shared scratch space and an actual release-notes run keeps its working files
 * there. Collect them first:
 *
 *   node scripts/wpt-collect.js --from firefox@stable@151 --to firefox@stable@152 \
 *        --out tmp/selftest/151-152
 *   node scripts/wpt-collect.js --from firefox@stable@152 --to firefox@stable@153 \
 *        --out tmp/selftest/152-153
 *
 * Or point it at artifacts you already have, which costs no downloads:
 *   node selftest.js --a tmp/151-152 --b tmp/152-153
 *
 * Usage:
 *   node selftest.js [--a <artifact-dir>] [--b <artifact-dir>]
 *
 * Exit codes: 0 all passed, 1 a check failed, 2 artifacts missing so coverage is
 * incomplete. 2 is deliberately not 0 — "couldn't check" must not read as "fine".
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = __dirname;
const TMP = path.join(__dirname, '..', 'tmp');

// Own subdirectory, not tmp/ directly. tmp/ is shared scratch space and a
// release-notes run in another session keeps its working artifacts there; a fixed
// name collides with whatever that run happens to be doing, and "cleaning up" one
// has already cost another session a ~4GB re-download.
const opts = {
  a: path.join(TMP, 'selftest', '151-152'),
  b: path.join(TMP, 'selftest', '152-153'),
};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--a') opts.a = process.argv[++i];
  else if (process.argv[i] === '--b') opts.b = process.argv[++i];
  else if (['-h', '--help'].includes(process.argv[i])) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
    process.exit(0);
  } else {
    console.error(`unknown argument: ${process.argv[i]}`);
    process.exit(1);
  }
}

/**
 * Run an analysis script with the network black-holed.
 *
 * Every script except wpt-collect.js is supposed to be a local read, and "local"
 * is a property worth testing rather than believing: the whole restructure exists
 * because the drill-in step used to re-stream two ~330MB reports. Pointing the
 * proxy at a closed port means any accidental fetch fails loudly instead of just
 * being slow, so a reintroduced network call shows up here rather than in a
 * release-notes run behind a corporate proxy.
 */
const OFFLINE = {
  ...process.env,
  HTTP_PROXY: 'http://127.0.0.1:1',
  HTTPS_PROXY: 'http://127.0.0.1:1',
  http_proxy: 'http://127.0.0.1:1',
  https_proxy: 'http://127.0.0.1:1',
  NO_PROXY: '',
  no_proxy: '',
};

const run = (script, args) =>
  execFileSync('node', [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: OFFLINE,
    // Captured, not inherited: a script's own stderr (a usage message from a
    // deliberately-bad argument, or wpt-runs.js failing offline) otherwise
    // interleaves into the check report and reads as a failure.
    stdio: ['pipe', 'pipe', 'pipe'],
  });

let failed = 0;
let passed = 0;
const report = (name, problem) => {
  if (problem) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${problem}`);
  } else {
    passed++;
    console.log(`ok    ${name}`);
  }
};

const check = (name, fn) => {
  let problem;
  try {
    problem = fn();
  } catch (err) {
    problem = `threw: ${err.message}`;
  }
  report(name, problem);
};

const checkAsync = async (name, fn) => {
  let problem;
  try {
    problem = await fn();
  } catch (err) {
    problem = `threw: ${err.message}`;
  }
  report(name, problem);
};

/** The diff row for one test. */
const row = (diff, test) => diff.tests.find((t) => t.test === test);

const cases = [];

// ---------------------------------------------------------------------------
// Firefox 151 -> 152
// ---------------------------------------------------------------------------
cases.push({
  artifact: 'a',
  label: '151->152',
  checks: (diff, dir) => {
    const SVG = '/svg/types/scripted/SVGAnimatedEnumeration-SVGTextPathElement.html';
    const ANIM = '/web-animations/interfaces/Animatable/getAnimations.html';

    // Missed because a directory verdict absorbed it: /svg/types/scripted was
    // ticked as "new SVGLength tests" while holding this +1 *done* file.
    check('151-152: SVGTextPathElement.side file is present and *done*', () => {
      const r = row(diff, SVG);
      if (!r) return `${SVG} not in the diff`;
      if (!(r.before.pass < r.before.total && r.after.pass === r.after.total)) {
        return `expected partly-failing -> fully-passing, got ${r.before.pass}/${r.before.total} -> ${r.after.pass}/${r.after.total}`;
      }
      return null;
    });

    check('151-152: it gets its own box in the file checklist', () => {
      const out = fs.readFileSync(path.join(dir, 'checklist.md'), 'utf8');
      return out.includes(SVG) ? null : 'absent from checklist.md';
    });

    // Its evidence names nothing ("...SVGTextPathElement 2" / "assert_true:
    // expected true got false"), so it must be flagged as needing the source.
    check('151-152: it is flagged (?) as evidence-that-names-nothing', () => {
      const out = fs.readFileSync(path.join(dir, 'checklist.md'), 'utf8');
      const line = out.split('\n').find((l) => l.includes(SVG));
      if (!line) return 'absent from checklist.md';
      return line.startsWith('(?)') ? null : `expected a (?) box, got: ${line.slice(0, 40)}`;
    });

    // Missed for the opposite reason: not *done* (::part() still fails), so a
    // done-only worksheet gave it no box and it became an unexplained "+1".
    check('151-152: getAnimations pseudoElement evidence is loaded', () => {
      const r = row(diff, ANIM);
      if (!r) return `${ANIM} not in the diff`;
      if (!r.subtests) return 'no subtest evidence in the artifact';
      const names = r.subtests.newlyPassing.map((s) => s.name).join(' | ');
      return /pseudo-element|pseudoElement/i.test(names)
        ? null
        : `newly-passing names do not mention the pseudo-element: ${names}`;
    });

    check('151-152: that evidence appears in the inventory listing', () => {
      const out = run('wpt-inventory.js', [dir, '--include', '/web-animations/interfaces/Animatable']);
      return /pseudo-element/i.test(out) ? null : 'inventory output does not show the subtest name';
    });

    // The drill-in step used to re-stream two ~330MB reports per invocation, which
    // is why the skill had to warn against calling it in a loop. It is now a local
    // read, and OFFLINE proves it.
    check('151-152: wpt-subtests.js reads several files with no network', () => {
      const out = run('wpt-subtests.js', [dir, SVG, ANIM]);
      const headers = (out.match(/^# \/.+$/gm) || []).length;
      if (headers !== 2) return `expected 2 per-path sections, got ${headers}`;
      if (/matched NOTHING|not changed tests/.test(out)) return 'one of the paths resolved to nothing';
      return null;
    });

    // Storing only the first 25 names per file meant the full picture required a
    // fresh download, so the expensive step was the one that named features.
    check('151-152: subtest evidence is complete, not capped at 25', () => {
      const big = diff.tests.filter((t) => t.subtests && t.subtests.counts.newlyPassing > 25);
      if (!big.length) return null; // nothing in this diff exceeds the old cap
      const truncated = big.find((t) => t.subtests.newlyPassing.length !== t.subtests.counts.newlyPassing);
      return truncated
        ? `${truncated.test} stored ${truncated.subtests.newlyPassing.length} of ${truncated.subtests.counts.newlyPassing} names`
        : null;
    });

    // Reading master rather than the revision under test silently substitutes
    // today's source for the one that produced the result being described.
    check('151-152: cached source is pinned to the run revision, not master', () => {
      // Deleted between these two runs: 200 at the baseline revision, 404 on master.
      const GONE = '/html/syntax/parsing/parse-processing-instruction.tentative.html';
      if (!diff.tests.some((t) => t.test === GONE && t.kind === 'removed')) {
        return `${GONE} is no longer 'removed' in this diff — pick another deleted test`;
      }
      const out = run('wpt-fetch-tests.js', [dir, GONE, '--head', '2']);
      if (/no source at the run|not in the cache/.test(out)) {
        return 'fell back to master and lost the source';
      }
      const sha = (diff.before.results_url.match(/\/([0-9a-f]{40})\//) || [])[1];
      return out.includes(sha) ? null : `fetched from the wrong ref:\n${out.split('\n').slice(0, 3).join('\n')}`;
    });

    // The skill says to search test CONTENTS, not paths. wpt-grep is that step.
    check('151-152: wpt-grep finds a feature by subtest name, with no network', () => {
      const out = run('wpt-grep.js', [dir, 'pseudoElement']);
      const section = out.split('## Test paths')[0];
      return /getAnimations\.html/.test(section)
        ? null
        : 'pseudoElement not found in the subtest-name layer';
    });

    // A feature can ship across several directories; the vocabulary section is the
    // mechanical version of "group by feature, not by directory".
    check('151-152: field-sizing is linked across multiple directories', () => {
      if (!diff.vocabulary) return 'no vocabulary section';
      const v = diff.vocabulary.find((x) => x.token.toLowerCase() === 'field-sizing');
      if (!v) return 'field-sizing not in the vocabulary section';
      return v.dirs.length >= 2 ? null : `only ${v.dirs.length} directory`;
    });
  },
});

// ---------------------------------------------------------------------------
// Firefox 152 -> 153
// ---------------------------------------------------------------------------
cases.push({
  artifact: 'b',
  label: '152->153',
  checks: (diff, dir) => {
    // The exclusion that hid the Intl.Locale info proposal, twice: once as a
    // default --exclude in the inventory, once as a hardcoded skip in the cluster
    // section. There is now no --exclude at all.
    check('152-153: test262 Intl.Locale proposal is in the diff at all', () => {
      const hits = diff.tests.filter((t) => t.test.includes('/intl402/Locale/prototype/'));
      return hits.length >= 4 ? null : `only ${hits.length} intl402/Locale/prototype files`;
    });

    check('152-153: it surfaces as a directory cluster', () => {
      if (!diff.clusters) return 'no clusters section';
      return diff.clusters.some((c) => c.dir.includes('intl402/Locale'))
        ? null
        : 'no intl402/Locale cluster — is third_party being excluded again?';
    });

    check('152-153: dynamic-import surfaces as a directory cluster', () => {
      if (!diff.clusters) return 'no clusters section';
      return diff.clusters.some((c) => c.dir.includes('dynamic-import'))
        ? null
        : 'no dynamic-import cluster';
    });

    check('152-153: the inventory does not exclude test262', () => {
      const out = run('wpt-inventory.js', [dir, '--dirs']);
      return out.includes('/third_party/test262') ? null : 'no third_party/test262 directories listed';
    });

    // Reftests carry no subtests, so every ranked view scores them 0.
    check('152-153: reftest rendering fixes are classified with a direction', () => {
      const fixed = diff.tests.filter((t) => t.statusDirection === 'fixed').length;
      return fixed > 0 ? null : 'no statusDirection:"fixed" rows — reftest fixes are invisible';
    });

    check('152-153: churn is not counted as cluster movement', () => {
      if (!diff.clusters) return 'no clusters section';
      // /svg/geometry/parsing was 23 brand-new tests reported as 21 improved.
      const bad = diff.clusters.find((c) => c.dir === 'svg/geometry/parsing');
      return bad ? `pure-churn directory present as a cluster: ${JSON.stringify(bad)}` : null;
    });

    // A diff cannot tell you a feature is still missing, and saying "not in the
    // diff" for a test that fails identically in both runs was a real wrong answer.
    check('152-153: wpt-state.js answers for unchanged tests, offline', () => {
      const out = run('wpt-state.js', [dir, '--grep', 'sound-state']);
      return /sound-state\.html/.test(out) ? null : 'sound-state.html not found in the stored summaries';
    });

    check('152-153: stored state covers the whole run, not just changed tests', () => {
      const changed = diff.tests.filter((t) => t.kind !== 'unchanged').length;
      const out = run('wpt-state.js', [dir, '--grep', '/']);
      const total = Number((out.match(/# (\d+) tests in both runs/) || [])[1] || 0);
      if (total < 100000) return `only ${total} tests stored — expected the full ~120k run`;
      return total > changed ? null : `stored ${total} but ${changed} changed: unchanged tests are missing`;
    });
  },
});

// ---------------------------------------------------------------------------
// Transport (scripts/lib/net.js) — the only layer that still needs the network
// ---------------------------------------------------------------------------
// This layer had no coverage while it was hand-rolled, and two bugs got through in
// one sitting — both of which failed misleadingly rather than loudly. A truncated
// or silently-empty transfer poisons every downstream conclusion, so the properties
// that matter are asserted here: a real streaming body, correct decompression, and
// that a large transfer arrives COMPLETE.
async function transportChecks() {
  const { netFetch } = require(path.join(SCRIPTS, 'lib', 'net.js'));

  let runs = null;
  await checkAsync('net: JSON over the wire (proxy-aware if one is configured)', async () => {
    const res = await netFetch('https://wpt.fyi/api/runs?product=firefox&label=stable&max-count=1');
    if (!res.ok) return `wpt.fyi returned ${res.status}`;
    runs = await res.json();
    return Array.isArray(runs) && runs.length ? null : 'no runs in the response';
  });
  if (!runs) return;

  await checkAsync('net: body is a streaming ReadableStream, not a buffered string', async () => {
    const res = await netFetch(`https://wpt.fyi/api/runs?run_ids=${runs[0].id}`);
    const isStream = res.body && typeof res.body.getReader === 'function';
    await res.arrayBuffer();
    return isStream ? null : `res.body is ${res.body && res.body.constructor.name}`;
  });

  await checkAsync('net: Content-Encoding is undone, exposing the stored gzip layer', async () => {
    const res = await netFetch(runs[0].results_url);
    const buf = Buffer.from(await res.arrayBuffer());
    // The summary blobs are stored gzipped AND served gzipped. After one layer is
    // undone this must be either plain JSON or a single remaining gzip stream —
    // never a double-encoded body, which is what a missing decompression looks like.
    const stillGzip = buf[0] === 0x1f && buf[1] === 0x8b;
    const text = stillGzip ? require('zlib').gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return `summary did not decode to JSON: ${err.message}`;
    }
    return Object.keys(parsed).length > 10000 ? null : `only ${Object.keys(parsed).length} tests`;
  });

  // Choosing the two specs was the one step with no tool, and the gap got filled
  // with an ad-hoc `node -e` calling undici directly — no proxy support, and
  // outside the permission allowlist. Assert the supported path works, including
  // the deduplicated version list that is the reason to run it.
  await checkAsync('runs: wpt-runs.js lists versions per channel', async () => {
    const out = execFileSync('node', [path.join(SCRIPTS, 'wpt-runs.js'), 'firefox'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const channel of ['stable', 'beta', 'experimental']) {
      if (!out.includes(`## ${channel}`)) return `no "${channel}" section`;
    }
    if (!/versions in the last \d+: \S/.test(out)) return 'no deduplicated version list';
    return /wpt-collect\.js --from/.test(out) ? null : 'suggested no collect command';
  });

  await checkAsync('net: a ~330MB stream arrives complete, not truncated', async () => {
    const url = runs[0].raw_results_url;
    if (!url) return 'run has no raw_results_url';
    const res = await netFetch(url);
    let bytes = 0;
    let tail = '';
    const decoder = new (require('string_decoder').StringDecoder)('utf8');
    for await (const chunk of res.body) {
      bytes += chunk.length;
      // Keep only the end, to prove the transfer reached the end of the document.
      tail = (tail + decoder.write(Buffer.from(chunk))).slice(-4096);
    }
    if (bytes < 50_000_000) return `only ${(bytes / 1e6).toFixed(1)}MB — transfer looks truncated`;
    // A complete wptreport ends with the closing brace of the top-level object.
    return tail.trimEnd().endsWith('}') ? null : `stream ended mid-document (${(bytes / 1e6).toFixed(0)}MB)`;
  });
}

// ---------------------------------------------------------------------------
// Message rollup — pure, so these run even with no artifact collected
// ---------------------------------------------------------------------------
// The rollup's whole job is telling one bug from many, and it was doing the
// opposite: keying on raw message text split a single serialization bug across
// every colour space it was tested in, reporting 32 groups topping out at 35x when
// the real dominant cause accounted for 144. The reader then believed the wrong
// group was dominant.
function rollupChecks() {
  const { messageRollup } = require(path.join(SCRIPTS, 'lib', 'analyse.js'));
  const of = (...messages) => messageRollup(messages.map((message) => ({ message })));

  check('rollup: nested values collapse, so one bug is one group', () => {
    const r = of(
      'Colors do not match. Actual: color-mix(in hsl, red 60%, blue) Expected: color-mix(in hsl, red 60%, blue 40%). Error: assert_array_approx_equals: lengths differ, expected 2 got 1',
      'Colors do not match. Actual: color-mix(in xyz-d65, color(xyz-d65 .1 .2 .3) 25%, color(xyz-d65 .5 .6 .7)) Expected: color-mix(in xyz-d65, color(xyz-d65 .1 .2 .3) 25%, color(xyz-d65 .5 .6 .7) 75%). Error: assert_array_approx_equals: lengths differ, expected 8 got 7',
    );
    return r.length === 1 && r[0].count === 2
      ? null
      : `expected 1 group of 2, got ${r.length} group(s): ${r.map((g) => g.count).join(',')}`;
  });

  check('rollup: a dropped percentage does not merge with a wrong computed value', () => {
    // Both begin "Colors do not match"; only the assert tail distinguishes them,
    // and that tail lives outside any parens so it must survive normalisation.
    const r = of(
      'Colors do not match. Actual: color-mix(in hsl, red 60%, blue) Expected: color-mix(in hsl, red 60%, blue 40%). Error: assert_array_approx_equals: lengths differ, expected 2 got 1',
      'Colors do not match. Actual: color(srgb 0 0 0 / 0) Expected: color(srgb 0.33 0.36 0.24 / 0). Error: assert_array_approx_equals: property 0, expected 0.33 +/- 0.01',
    );
    return r.length === 2 ? null : `two distinct bugs collapsed into ${r.length} group(s)`;
  });

  check('rollup: short type annotations survive, so type mismatches stay apart', () => {
    const r = of(
      'assert_equals: expected (number) 5 but got (string) "5"',
      'assert_equals: expected (string) "a" but got (undefined) undefined',
    );
    return r.length === 2 ? null : `"(number)"/"(string)" were collapsed into ${r.length} group(s)`;
  });

  check('rollup: carries an unabridged example, since the key strips the cause', () => {
    const full = 'Colors do not match. Actual: color-mix(in hsl, red 60%, blue) Expected: color-mix(in hsl, red 60%, blue 40%). Error: assert_array_approx_equals: lengths differ, expected 2 got 1';
    const r = of(full, full);
    if (!r[0].example) return 'no example on the group';
    return r[0].example === full ? null : 'the example was normalised or truncated';
  });
}

// ---------------------------------------------------------------------------
// The gate — that it fails on a bad worksheet AND passes on a good one
// ---------------------------------------------------------------------------
// --verify used to count ticks, which certified "every line I still have has an x
// on it". Two ways past it, both seen for real:
//
//   - A tick with no verdict passed, and so did "written up — see notes". A bulk
//     regex apply that ended `+ '  — written up — see notes'` on every unmatched
//     box would have resolved all 416 and passed.
//   - Nothing recorded which boxes should exist. A pass that resolved the worksheet
//     by rewriting it whole dropped four lines while leaving the count intact.
//
// Both halves matter equally. A stricter gate that flags good work is worse than a
// loose one, because it trains the reader to write verdicts that satisfy the
// pattern — the first attempt at the "explained" rule flagged 28 verdicts on a real
// worksheet and every one of them was fine. So the good-verdict cases below are not
// padding; they are the half that was got wrong first.
function checklistChecks() {
  const {
    verifyChecklist, boxPaths, collapseVariants, grepFragment,
  } = require(path.join(SCRIPTS, 'lib', 'render.js'));

  const sheet = (...lines) => lines.join('\n');
  const whys = (r) => r.bad.map((b) => b.why).join(' | ');

  check('gate: a tick with no verdict is not resolved', () => {
    const r = verifyChecklist('[x] /css/css-cascade');
    return r.bad.length === 1 ? null : `expected 1 bad, got ${r.bad.length}`;
  });

  check('gate: "see notes" is rejected — the bulk-apply fallback', () => {
    const r = verifyChecklist(sheet(
      '[x] /css/css-cascade  — written up — see notes',
      '(x) /css/foo.html  — written up: see above',
    ));
    return r.bad.length === 2 ? null : `expected 2 bad, got ${r.bad.length}: ${whys(r)}`;
  });

  check('gate: a verdict naming no kind is rejected', () => {
    const r = verifyChecklist('[x] /css/css-cascade  — it moved a bit');
    return r.bad.length === 1 && /names no kind/.test(whys(r))
      ? null : `got ${r.bad.length}: ${whys(r)}`;
  });

  check('gate: a bare kind with no detail is rejected', () => {
    const r = verifyChecklist('[x] /css/css-cascade  — written up');
    return r.bad.length === 1 && /no detail/.test(whys(r))
      ? null : `got ${r.bad.length}: ${whys(r)}`;
  });

  check('gate: "explained" pointing at nothing is rejected', () => {
    const r = verifyChecklist(sheet(
      '[x] /css/css-values/tree-counting  — written up: sibling-index()',
      '[x] /webdriver/tests/bidi/foo  — explained: sundry plumbing wobbles',
    ));
    return r.bad.length === 1 && /explained/.test(whys(r))
      ? null : `expected the second line only, got ${r.bad.length}: ${whys(r)}`;
  });

  check('gate: "explained" naming another box PATH resolves', () => {
    // The real form: "(tree-counting)" is a reference to a directory in the sheet.
    const r = verifyChecklist(sheet(
      '[x] /css/css-values/tree-counting  — written up: sibling-index() / sibling-count()',
      '[x] /css/css-images  — explained: sibling-index() in gradients (tree-counting)',
    ));
    return r.bad.length === 0 ? null : `flagged a good verdict: ${whys(r)}`;
  });

  check('gate: "explained" echoing another box\'s WRITTEN-UP text resolves', () => {
    // Also real: 14 boxes said exactly "explained: BiDi user contexts", and another
    // box's verdict was verbatim "written up: BiDi user contexts".
    const r = verifyChecklist(sheet(
      '[x] /webdriver/tests/bidi/browsing_context/create  — written up: BiDi user contexts',
      '[x] /webdriver/tests/bidi/browsing_context/load  — explained: BiDi user contexts',
    ));
    return r.bad.length === 0 ? null : `flagged a good verdict: ${whys(r)}`;
  });

  check('gate: "explained: same as -001" resolves against the numbered sibling', () => {
    const r = verifyChecklist(sheet(
      '(x) /css/css-fonts/small-caps-letter-spacing-001.html  — written up: letter-spacing with ß',
      '(x) /css/css-fonts/small-caps-letter-spacing-002.html  — explained: same as -001',
    ));
    return r.bad.length === 0 ? null : `flagged a good verdict: ${whys(r)}`;
  });

  check('gate: a sibling number that is NOT a box does not resolve', () => {
    const r = verifyChecklist(sheet(
      '(x) /css/css-fonts/small-caps-letter-spacing-001.html  — written up: letter-spacing with ß',
      '(x) /css/css-fonts/small-caps-letter-spacing-002.html  — explained: same as 099',
    ));
    return r.bad.length === 1 ? null : 'a reference to a box that does not exist resolved anyway';
  });

  check('gate: "unknown" inside a quoted message is not a non-answer', () => {
    // Blocking the word rejected a good verdict whose evidence was the harness error
    // `unknown command browsingContext.stopScreencast`.
    const r = verifyChecklist(sheet(
      '(x) /webdriver/a/start_screencast/invalid.py  — written up: BiDi screencast commands',
      '(x) /webdriver/a/stop_screencast/invalid.py  — explained: same screencast commands as start_screencast/invalid.py (prior message: unknown command browsingContext.stopScreencast)',
    ));
    return r.bad.length === 0 ? null : `flagged a good verdict: ${whys(r)}`;
  });

  // A gate whose rejections are not diagnosable teaches avoidance, not precision. One pass
  // spent three round-trips rewording a single verdict, guessing at which word had tripped
  // the check, and never found out which it was.
  check('gate: a rejection names the phrase that triggered it', () => {
    const r = verifyChecklist(sheet('[x] /a  — explained: same as /b, various other bits'));
    if (r.bad.length !== 1) return `expected 1 bad, got ${r.bad.length}`;
    return /"various"/.test(r.bad[0].why)
      ? null : `did not name the trigger: ${r.bad[0].why}`;
  });

  check('gate: a wrong verdict kind is named, and the closed set is listed', () => {
    // `regression:` used to be the example here and is now a valid kind, so this needs a
    // prefix that genuinely is not one — the property under test is that the gate quotes what
    // it refused and lists what it will take.
    const r = verifyChecklist(sheet('[x] /a  — investigated: cookieStore.set returned deleted'));
    if (r.bad.length !== 1) return `expected 1 bad, got ${r.bad.length}`;
    const why = r.bad[0].why;
    if (!/"investigated:"/.test(why)) return `did not quote the offending prefix: ${why}`;
    for (const kind of ['written up:', 'regression:', 'not a feature:']) {
      if (!why.includes(kind)) return `did not list ${kind}: ${why}`;
    }
    return null;
  });

  check('gate: "regression:" is a verdict kind, not a rejection', () => {
    // Two independent passes reached for it — once four times, once about fifteen — after
    // following the instruction to write `written up:` instead. It means the same thing to the
    // gate and carries more information, since the notes have a Regressions section.
    const r = verifyChecklist(sheet('[x] /css/css-transforms  — regression: four transform reftests now fail'));
    return r.bad.length === 0 ? null : `rejected a regression verdict: ${whys(r)}`;
  });

  check('gate: a churn directory needs no verdict', () => {
    const r = verifyChecklist('[x] /some/dir  (3f, churn)');
    return r.bad.length === 0 ? null : `churn line flagged: ${whys(r)}`;
  });

  check('gate: a box missing since collection is reported', () => {
    const text = sheet('[x] /a  — written up: thing one', '[x] /b  — written up: thing two');
    const r = verifyChecklist(text, ['/a', '/b', '/c']);
    return r.missing.length === 1 && r.missing[0] === '/c'
      ? null : `expected /c missing, got ${JSON.stringify(r.missing)}`;
  });

  check('gate: a dropped box is caught even when the COUNT is unchanged', () => {
    // The failure the count cannot see: swap one box for another and the tally holds.
    const text = sheet('[x] /a  — written up: thing one', '[x] /typo  — written up: thing two');
    const r = verifyChecklist(text, ['/a', '/b']);
    return r.missing.length === 1 && r.extra.length === 1 && r.total === 2
      ? null : `missing=${JSON.stringify(r.missing)} extra=${JSON.stringify(r.extra)}`;
  });

  check('gate: without boxes.json it says the inventory was NOT checked', () => {
    const r = verifyChecklist('[x] /a  — written up: thing one');
    return r.inventoryChecked === false && r.missing.length === 0
      ? null : 'claimed to have checked an inventory it was not given';
  });

  check('gate: boxPaths reads every box shape', () => {
    const got = boxPaths(sheet(
      '[ ] /dir/open', '[x] /dir/done', '( ) /f/open.html', '(?) /f/opaque.html',
      '(x) /f/done.html', '      OK 1/2 -> OK 2/2  (+1)', '# a heading',
    ));
    return got.length === 5 ? null : `expected 5 paths, got ${got.length}: ${got.join(',')}`;
  });

  check('variants: ?query variants of one file fold into one box', () => {
    const row = (test) => ({
      test, before: { status: 8, pass: 0, total: 0 }, after: { status: 1, pass: 0, total: 0 }, deltaPass: 0,
    });
    const fams = collapseVariants([
      row('/css/a-001.html?class=auto'), row('/css/a-001.html?class=cap'), row('/css/b.html'),
    ]);
    return fams.length === 2 ? null : `expected 2 families, got ${fams.length}`;
  });

  check('variants: a window/worker divergence is NOT folded away', () => {
    // basic-auth.any.html newly passed while basic-auth.any.sharedworker.html
    // regressed. Folding by source alone would hide the comparison that IS the
    // finding, so the transition is part of the key.
    const fams = collapseVariants([
      { test: '/w/basic-auth.any.html', before: { status: 1, pass: 0, total: 1 }, after: { status: 1, pass: 1, total: 1 }, deltaPass: 1 },
      { test: '/w/basic-auth.any.sharedworker.html', before: { status: 1, pass: 1, total: 1 }, after: { status: 1, pass: 0, total: 1 }, deltaPass: -1 },
    ]);
    return fams.length === 2 ? null : 'two opposite results in two globals were folded into one box';
  });

  // Generated wrappers whose .html exists only at run time. Both mappings were absent,
  // so 118 test262 files and 6 web-extension files cached an empty source — and the
  // miss is stored as an empty body, so nothing reported it. The two conventions
  // differ, which is only discoverable against the real repo: .test262 is dropped,
  // .extension is kept.
  check('sources: generated wrappers map to the .js that actually exists', () => {
    const { toSourcePath } = require(path.join(SCRIPTS, 'lib', 'wpt.js'));
    const cases = [
      ['/third_party/test262/test/intl402/Locale/prototype/getCalendars/branding.test262.html',
        'third_party/test262/test/intl402/Locale/prototype/getCalendars/branding.js'],
      ['/third_party/test262/test/language/import/import-attributes/text-empty.test262-module.html',
        'third_party/test262/test/language/import/import-attributes/text-empty.js'],
      ['/web-extensions/browser.storage.extension.html',
        'web-extensions/browser.storage.extension.js'],
      ['/fetch/http-cache/no-vary-search.tentative.any.worker.html',
        'fetch/http-cache/no-vary-search.tentative.any.js'],
    ];
    for (const [input, want] of cases) {
      const got = toSourcePath(input);
      if (got !== want) return `${input} -> "${got}", expected "${want}"`;
    }
    return null;
  });

  check('variants: the --grep fragment strips generated suffixes', () => {
    const cases = [
      ['/fetch/http-cache/no-vary-search.tentative.any.html', 'no-vary-search'],
      ['/css/x/text-box-trim-start-001.html?class=auto', 'text-box-trim-start-001'],
      ['/websockets/mixed-content.https.any.serviceworker.html', 'mixed-content'],
    ];
    for (const [input, want] of cases) {
      const got = grepFragment(input);
      if (got !== want) return `${input} -> "${got}", expected "${want}"`;
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// The JavaScript coverage horizon — the miss that reading harder cannot fix
// ---------------------------------------------------------------------------
// Firefox 154 shipped three TC39 Iterator proposals. The 153->154 notes named none
// of them, and unlike every other entry in this file that was not a reading failure:
// WPT vendors test262 rather than tracking it, the snapshot was 117 days stale, and
// `test/built-ins/Iterator/prototype/` therefore held drop/every/filter/... and no
// chunks, windows, includes or join. Zero tests, both runs. `wpt-grep.js Iterator`
// matched nothing in all three of its layers; `wpt-state.js`, which exists precisely
// so "not in the diff" is never reported as "not shipped", answers from the same two
// summaries and so could not help either.
//
// The fixtures are trimmed real features.txt content, and the vendored fixture is what
// wpt @ 3159769338 actually pinned. Offline, so this runs with no artifact.
async function horizonChecks() {
  const {
    parseVendoredRev, parseFeatures, newFeatures,
  } = require(path.join(SCRIPTS, 'lib', 'test262.js'));
  const {
    jsGapBoxes, jsChecklistLines, boxPaths, verifyChecklist, jsFinding, jsFyiLines,
    jsUpstreamLines,
  } = require(path.join(SCRIPTS, 'lib', 'render.js'));
  // Both renderers read a block off the horizon, so wrap a bare block for the checks that
  // only care about one finding's wording.
  // jsFinding reads the horizon's normalised `shipped` block (lib/shipped.js), so wrap a
  // bare one for the checks that only care about how a single outcome is worded.
  const shippedBlock = (outcome, extra = {}) => ({
    ok: true, product: 'firefox', source: 'Bugzilla', version: 154, extra: [],
    findings: [{ feature: { name: 'flag' }, title: 'T', outcome, evidence: [], ...extra }],
  });
  const jsFindingText = (block, name) => jsFinding({ shipped: block }, name) || { short: '', lines: [] };
  const jsFyiText = (fyiBlock, name) => jsFyiLines({ fyi: fyiBlock }, name);

  // Trimmed from tc39/test262@b66872a92 — the revision wpt @ 3159769338 vendored.
  const VENDORED = `## Proposed language features
#
# blurb

# Decorators
# https://github.com/tc39/proposal-decorators
decorators

# Temporal
# https://github.com/tc39/proposal-temporal
Temporal

# Explicit Resource Management
# https://github.com/tc39/proposal-explicit-resource-management
explicit-resource-management

## Standard language features
#
# blurb

Array.prototype.at
iterator-helpers
`;

  // ...and from main, four months later. Temporal and explicit-resource-management
  // GRADUATED: same names, different half of the file.
  const UPSTREAM = `## Proposed language features
#
# blurb

# Decorators
# https://github.com/tc39/proposal-decorators
decorators

# Source Phase Imports
## https://github.com/tc39/proposal-source-phase-imports
source-phase-imports
## test262 special specifier
source-phase-imports-module-source

# Iterator Join
# https://github.com/tc39/proposal-iterator-join
Iterator.prototype.join

## Standard language features
#
# blurb

Array.prototype.at
explicit-resource-management
iterator-chunking
iterator-helpers
iterator-includes
Temporal
`;

  check('horizon: the vendored test262 revision is read from vendored.toml', () => {
    const got = parseVendoredRev(
      '[test262]\nsource = "https://github.com/tc39/test262"\nrev = "b66872a92487694396fb082343e08dd7cca5ddf4"\n',
    );
    return got === 'b66872a92487694396fb082343e08dd7cca5ddf4' ? null : `got ${JSON.stringify(got)}`;
  });

  check('horizon: the three shipped Iterator proposals are reported as gaps', () => {
    const missing = newFeatures(parseFeatures(VENDORED), parseFeatures(UPSTREAM))
      .map((f) => f.name);
    const want = ['Iterator.prototype.join', 'iterator-chunking', 'iterator-includes'];
    const absent = want.filter((w) => !missing.includes(w));
    return absent.length ? `did NOT report ${absent.join(', ')} (got ${missing.join(', ')})` : null;
  });

  check('horizon: a feature that merely graduated is NOT reported as new', () => {
    // The reason this is a parser and not `diff features.txt`. A flag moves from the
    // proposals half to the alphabetical half when it reaches the published spec, so a
    // line diff calls Temporal and explicit-resource-management both removed AND added
    // — two features that did nothing, in a list whose whole value is that every entry
    // is worth a lookup. Four of the five real entries would have been noise.
    const missing = newFeatures(parseFeatures(VENDORED), parseFeatures(UPSTREAM))
      .map((f) => f.name);
    const graduated = ['Temporal', 'explicit-resource-management'].filter((g) => missing.includes(g));
    return graduated.length ? `reported ${graduated.join(', ')} as a new gap` : null;
  });

  check('horizon: `##` inside a proposal comment block is not a section heading', () => {
    // Upstream really does have `## https://...` and `## test262 special specifier`
    // inside the Source Phase Imports block. Treating those as headings filed every
    // later flag under a section named after a URL, and reported
    // Iterator.prototype.join as a "test262 special specifier".
    const f = parseFeatures(UPSTREAM);
    const join = f.get('Iterator.prototype.join');
    if (!join) return 'Iterator.prototype.join was not parsed at all';
    if (join.section !== 'Proposed language features') return `section is ${JSON.stringify(join.section)}`;
    return f.get('iterator-chunking').section === 'Standard language features'
      ? null : 'the standard-features section was mis-attributed';
  });

  check('horizon: a proposal keeps its name and URL, which is the release-note vocabulary', () => {
    const join = parseFeatures(UPSTREAM).get('Iterator.prototype.join');
    return join.label === 'Iterator Join' && /proposal-iterator-join/.test(join.url || '')
      ? null : `label=${JSON.stringify(join.label)} url=${JSON.stringify(join.url)}`;
  });

  check('horizon: each gap becomes a box the gate refuses to pass', () => {
    // A printed caveat is state nobody keeps — that is why the worksheet exists at
    // all. A gap no view can confirm needs the completion criterion more than
    // anything else here, since answering it means leaving the artifact.
    const h = {
      ok: true,
      after: { rev: 'b66872a92487694396fb082343e08dd7cca5ddf4' },
      lagDays: 117,
      missing: newFeatures(parseFeatures(VENDORED), parseFeatures(UPSTREAM)),
      revendored: [],
    };
    const boxes = jsGapBoxes(h);
    if (!boxes.length) return 'no boxes generated for a snapshot with known gaps';
    const text = jsChecklistLines(h).join('\n');
    const paths = boxPaths(text);
    for (const b of boxes) {
      if (!paths.includes(b.path)) return `${b.path} is not a parseable box in the rendered section`;
    }
    const r = verifyChecklist(text, paths);
    return r.open.length === boxes.length
      ? null
      : `gate saw ${r.open.length} open boxes, expected ${boxes.length}`;
  });

  check('horizon: a box path needs no shell quoting', () => {
    // These get pasted as wpt-resolve.js keys and printed in --verify's output. A
    // metacharacter in one turns a documented command into a permission prompt, which
    // is the failure mode the whole no-quotes rule exists for.
    const h = {
      ok: true,
      after: { rev: 'x' },
      lagDays: 1,
      missing: newFeatures(parseFeatures(VENDORED), parseFeatures(UPSTREAM)),
      revendored: [],
    };
    const bad = jsGapBoxes(h).map((b) => b.path).filter((p) => /[?()|[\]$;<>*'"\s&\\]/.test(p));
    return bad.length ? `needs quoting: ${bad.join(', ')}` : null;
  });

  // -------------------------------------------------------------------------
  // …and the follow-up miss: the gap was found, then ruled out
  // -------------------------------------------------------------------------
  // The first fix surfaced all three Iterator proposals as boxes and told the reader to
  // "look the flag up in the browser's release notes or Bugzilla". That is a worse
  // outcome than silence, and it happened: "I checked all five against Bugzilla rather
  // than taking that at face value, and none of them shipped."
  //
  // Because a test262 flag name is not Bugzilla's vocabulary. Verbatim, today:
  //   quicksearch=iterator-chunking        -> {"bugs":[]}
  //   quicksearch=Iterator.prototype.join  -> {"bugs":[]}
  // Zero bugs for two features that shipped in 154. So the lookup is done by the tooling,
  // in Bugzilla's own wording, and its answer is rendered onto the box.
  const bz = require(path.join(SCRIPTS, 'lib', 'bugzilla.js'));
  // The vendor-neutral helpers (majorVersion, searchTitleFor) live in the dispatcher, not
  // in the Firefox adapter — both adapters need them.
  const shipped = require(path.join(SCRIPTS, 'lib', 'shipped.js'));

  check('bugzilla: a flag name is turned into the prose Mozilla writes', () => {
    const cases = [
      // The two that returned zero bugs. Mozilla's summaries are "Ship Iterator Chunking
      // proposal" and "Ship Iterator Includes proposal".
      [{ name: 'iterator-chunking' }, 'Iterator chunking'],
      [{ name: 'iterator-includes' }, 'Iterator includes'],
      // features.txt already carries the proposal name for anything not yet graduated,
      // and it beats anything derivable from the flag.
      [{ name: 'Iterator.prototype.join', label: 'Iterator Join' }, 'Iterator Join'],
      // No label: the dotted form loses `prototype`, which appears in no bug summary.
      [{ name: 'Iterator.prototype.join' }, 'Iterator join'],
      [{ name: 'Atomics.pause' }, 'Atomics pause'],
    ];
    for (const [feature, want] of cases) {
      const got = shipped.searchTitleFor(feature);
      if (got !== want) return `${feature.name} -> "${got}", expected "${want}"`;
    }
    return null;
  });

  check('bugzilla: "no bug found" is UNKNOWN, never "did not ship"', () => {
    // The whole failure in one assertion. An empty result set must not be reportable as
    // a negative finding, because the empty result is what the wrong query returns.
    const f = bz.classify([], [], 154);
    if (f.outcome !== 'no-bug-found') return `outcome was ${f.outcome}`;
    const rendered = jsFindingText(shippedBlock('unknown'), 'flag');
    if (/did not ship|didn't ship|not shipped/i.test(rendered.short)) {
      return `the short form asserts a negative: "${rendered.short}"`;
    }
    return /UNKNOWN/.test(rendered.short) && /NOT a "no"/i.test(rendered.lines.join(' '))
      ? null : `did not say it was unknown: "${rendered.short}"`;
  });

  check('bugzilla: implemented behind a pref is not reported as shipped', () => {
    // A proposal has three bugs and two are the wrong answer:
    //   [meta] Iterator includes proposal          never resolved
    //   Implement iterator includes proposal       FIXED, 152 Branch
    //   Ship Iterator Includes proposal            FIXED, 154 Branch
    // Reading the first FIXED bug gives "shipped in 152", wrong in both directions.
    const bugs = [
      { id: 1, summary: '[meta] Iterator includes proposal', resolution: '', target_milestone: '---' },
      { id: 2, summary: 'Implement iterator includes proposal', resolution: 'FIXED', target_milestone: '152 Branch', cf_status_firefox154: '---' },
    ];
    const f = bz.classify(bugs, [], 154);
    if (f.outcome !== 'implemented-not-shipped') return `outcome was ${f.outcome}`;
    // And it must cite the landing bug, not whatever FIXED bug came back first.
    return f.bug.id === 2 ? null : `cited bug ${f.bug.id} instead of the Implement bug`;
  });

  check('bugzilla: the Ship bug for THIS release is what means shipped', () => {
    const bugs = [
      { id: 2, summary: 'Implement iterator includes proposal', resolution: 'FIXED', target_milestone: '152 Branch', cf_status_firefox154: '---' },
      { id: 3, summary: 'Ship Iterator Includes proposal', resolution: 'FIXED', target_milestone: '154 Branch', cf_status_firefox154: 'fixed' },
    ];
    const f = bz.classify(bugs, [], 154);
    return f.outcome === 'shipped' && f.bug.id === 3 ? null : `outcome ${f.outcome}, bug ${f.bug && f.bug.id}`;
  });

  check('bugzilla: a Ship bug fixed for a DIFFERENT release is not this release', () => {
    const bugs = [
      { id: 3, summary: 'Ship Iterator Includes proposal', resolution: 'FIXED', target_milestone: '152 Branch', cf_status_firefox154: '---' },
    ];
    return bz.classify(bugs, [], 154).outcome === 'shipped-elsewhere'
      ? null : 'a ship bug from another release counted as shipping here';
  });

  check('bugzilla: the version comes from the browser version, not the spec label', () => {
    const cases = [['154.0b10', 154], ['155.0a1', 155], ['153.0.4', 153], ['', null]];
    for (const [input, want] of cases) {
      const got = shipped.majorVersion(input);
      if (got !== want) return `${JSON.stringify(input)} -> ${got}, expected ${want}`;
    }
    return null;
  });

  // The finding is rendered ONTO the box line, which puts generated text where the gate
  // parses the reader's verdict. Two characters and one word list would break it, so this
  // sweeps every outcome rather than trusting the current wording.
  check('bugzilla: no rendered finding can corrupt a verdict on its own box', () => {
    const { verifyChecklist, verdictOf } = require(path.join(SCRIPTS, 'lib', 'render.js'));
    const outcomes = ['shipped', 'shipped-earlier', 'shipped-other-version', 'gated',
      'changed-not-shipped', 'not-shipped', 'unknown', 'error'];
    for (const label of outcomes) {
      const { short } = jsFindingText(shippedBlock(label), 'flag');
      const box = `[x] test262-feature:flag   (no test here; ${short})  — written up: the feature`;
      // The generated text must not look like the start of the verdict...
      const got = verdictOf(box);
      if (got !== 'written up: the feature') return `${label}: verdict parsed as "${got}"`;
      // ...and must not trip the gate's non-answer or missing-kind rules.
      const r = verifyChecklist(box);
      if (r.bad.length) return `${label}: gate rejected a good verdict — ${r.bad[0].why}`;
    }
    return null;
  });

  // -------------------------------------------------------------------------
  // test262.fyi — evidence, where Bugzilla only has status
  // -------------------------------------------------------------------------
  // Bugzilla answers "which release turned this on" from a status field. test262.fyi
  // actually runs test262 against engine builds, twice per engine (with and without
  // experimental options), so it answers "does it work" and "is it on by default" — the
  // pref question the skill otherwise has to state and leave open. It cannot replace
  // Bugzilla, because it tests NIGHTLY (`sm: 155.0a1` while the notes are about 154 beta)
  // and publishes no per-feature history.
  const fyi = require(path.join(SCRIPTS, 'lib', 'test262fyi.js'));
  const META = {
    engines: { sm: '155.0a1', sm_exp: '155.0a1', v8: '15.3.60', v8_exp: '15.3.60' },
    test262: { revision: '3655e74' },
    features: {
      'iterator-chunking': { total: 78, engines: { sm: 78, sm_exp: 78, v8: 9 } },
      'export-defer': { total: 0, engines: { sm: 0, sm_exp: 0, v8: 0 } },
      'error-stack-accessor': { total: 35, engines: { sm: 18, sm_exp: 18, v8: 0 } },
      'flag-gated-example': { total: 20, engines: { sm: 0, sm_exp: 20, v8: 0 } },
    },
  };
  const sm = fyi.engineFor('firefox');

  check('test262.fyi: a browser maps to its engine, both configurations', () => {
    if (!sm || sm.key !== 'sm' || sm.exp !== 'sm_exp') return `firefox -> ${JSON.stringify(sm)}`;
    if (fyi.engineFor('chrome').key !== 'v8') return 'chrome does not map to v8';
    return fyi.engineFor('ladybird') === null ? null : 'an unknown product got an engine';
  });

  check('test262.fyi: passing without experimental options is on by default', () => {
    const r = fyi.featureResult(META, 'iterator-chunking', sm);
    return r.fullyPassing && !r.prefGated && r.pass === 78 && !r.noTests
      ? null : `iterator-chunking -> ${JSON.stringify(r)}`;
  });

  check('test262.fyi: passing only with experimental options is FLAG GATED', () => {
    // The distinction the skill otherwise cannot make. Reporting this as "works" would
    // put a preffed-off feature in the notes as available.
    const r = fyi.featureResult(META, 'flag-gated-example', sm);
    return r.prefGated && !r.fullyPassing ? null : `not detected as gated: ${JSON.stringify(r)}`;
  });

  check('test262.fyi: zero tests upstream is distinct from failing them', () => {
    // `export-defer` is registered upstream with nothing behind it, which is why the
    // Bugzilla search also came up empty. "Nothing to measure" and "measured as broken"
    // must not render the same.
    const r = fyi.featureResult(META, 'export-defer', sm);
    if (!r.noTests) return 'total 0 was not reported as "no tests"';
    if (r.fullyPassing) return '0/0 was reported as fully passing';
    const { short, lines } = jsFyiText({ ok: true, engine: 'SpiderMonkey', version: '155.0a1', results: { 'export-defer': r } }, 'export-defer');
    return /no test262 tests exist/i.test(short) && /0 tests written/.test(lines.join(' '))
      ? null : `rendered as "${short}"`;
  });

  check('test262.fyi: the tested build is always labelled a nightly', () => {
    // The one way this source misleads: reading "155.0a1 passes 78/78" as a statement
    // about the release being written up.
    const r = fyi.featureResult(META, 'iterator-chunking', sm);
    const { lines } = jsFyiText({ ok: true, engine: 'SpiderMonkey', version: '155.0a1', results: { 'iterator-chunking': r } }, 'iterator-chunking');
    const text = lines.join(' ');
    return /NIGHTLY/.test(text) && /155\.0a1/.test(text)
      ? null : `no nightly label in: ${text}`;
  });

  // -------------------------------------------------------------------------
  // …and the third layer: whose bug tracker?
  // -------------------------------------------------------------------------
  // The gap is not Firefox-specific — `--from chrome@stable --to chrome@beta` has the same
  // hole — so resolving it out of Bugzilla unconditionally is right for one vendor and
  // wrong for the rest. Chrome has a better-shaped source (chromestatus: one call gives
  // both the pref status and the milestone). Safari has none: bugs.webkit.org IS a
  // Bugzilla, its REST API works, and pointing the Firefox logic at it produces confident
  // nonsense — it has no per-release status field, and quicksearch "Iterator chunking"
  // returns a 2015 Web Inspector bug about array indices.
  const cs = require(path.join(SCRIPTS, 'lib', 'chromestatus.js'));

  check('shipped: every vendor is either wired up or named as unsupported', () => {
    for (const product of ['firefox', 'chrome', 'safari']) {
      const s = shipped.sourceFor(product);
      if (!s) return `${product} has no entry at all, so it would look like a glitch`;
      if (s.kind === 'unsupported' && !(s.why && (s.lookAt || []).length)) {
        return `${product} is unsupported without a reason and somewhere else to look`;
      }
    }
    return shipped.sourceFor('ladybird') === null ? null : 'an unknown product got a source';
  });

  check('shipped: an unsupported vendor is UNKNOWN, never a negative', () => {
    // Safari must not be answerable. The gate should still demand a verdict, and the
    // reader must be sent somewhere real rather than told "not applicable".
    for (const o of ['unknown', 'unsupported', 'error']) {
      if (shipped.isNegative(o)) return `"${o}" was treated as a negative outcome`;
    }
    if (!shipped.isNegative('gated')) return '"gated" should be a negative for this release';
    return shipped.isNegative('shipped') ? '"shipped" was treated as a negative' : null;
  });

  await checkAsync('shipped: Safari resolves to a named gap with places to look', async () => {
    const r = await shipped.whatShipped([{ name: 'iterator-chunking' }], 'safari', '26.0');
    if (r.ok) return 'Safari claimed to have a release source';
    if (!r.unsupported) return 'Safari looked like a transient failure, not a known limit';
    if (!/per-release status field/.test(r.error)) return `unhelpful reason: ${r.error}`;
    return (r.lookAt || []).some((u) => /developer\.apple\.com/.test(u))
      ? null : 'no Safari release notes URL offered';
  });

  check('chromestatus: "Enabled by default" plus a milestone is the answer', () => {
    const entry = (text, ms) => ([{
      id: 1, name: 'Iterator helpers', category: 'JavaScript',
      browsers: { chrome: { status: { text, milestone_str: ms } } },
    }]);
    const cases = [
      [entry('Enabled by default', '122'), 122, 'shipped'],
      [entry('Enabled by default', '122'), 130, 'shipped-earlier'],
      [entry('Enabled by default', '140'), 130, 'shipped-later'],
      [entry('Behind a flag', 'Behind a flag'), 130, 'gated'],
      [entry('Proposed', 'Proposed'), 130, 'not-shipped'],
      // Unrecognised status text must NOT become a negative.
      [entry('Some new status nobody has seen', ''), 130, 'unknown'],
      [[], 130, 'unknown'],
    ];
    for (const [features, version, want] of cases) {
      const got = cs.classify(features, version).outcome;
      if (got !== want) {
        const t = features.length ? features[0].browsers.chrome.status.text : '(no results)';
        return `"${t}" @ ${version} -> ${got}, expected ${want}`;
      }
    }
    return null;
  });

  check('chromestatus: the chromestatus entry does not clobber the test262 flag', () => {
    // A real bug, and a silent one: classify() returned the chromestatus entry as
    // `feature`, verifyFeatures spread it over its own `feature` (the test262 flag), and
    // the renderer matches boxes on `feature.name` — so every Chrome finding was
    // unmatchable and no box ever showed an answer.
    const r = cs.classify([{
      id: 1, name: 'Iterator Chunking', category: 'JavaScript',
      browsers: { chrome: { status: { text: 'Proposed', milestone_str: 'Proposed' } } },
    }], 130);
    if ('feature' in r) return 'classify() still returns a `feature` key, which collides';
    const merged = { feature: { name: 'iterator-chunking' }, title: 'Iterator Chunking', ...r };
    return merged.feature.name === 'iterator-chunking'
      ? null : `the flag became ${JSON.stringify(merged.feature)}`;
  });

  check('shipped: a Chrome milestone is read from a Chrome version string', () => {
    // Chrome versions are "141.0.7390.54", Firefox "154.0b10", Safari "26.0". One parser.
    const cases = [['141.0.7390.54', 141], ['154.0b10', 154], ['26.0', 26], ['18.4', 18]];
    for (const [input, want] of cases) {
      const got = shipped.majorVersion(input);
      if (got !== want) return `${input} -> ${got}, expected ${want}`;
    }
    return null;
  });

  // Step 4 ("copy every snippet from a passing test") is unsatisfiable for a
  // past-the-horizon feature using the artifact alone, which is exactly when syntax gets
  // written from memory. The tests exist upstream; these assert we point at them, and that a
  // truncated lookup is never reported as "no tests upstream".
  check('upstream: a gapped flag points at real upstream tests to copy from', () => {
    const h = {
      upstreamTests: { ok: true, truncated: false, flags: {
        'iterator-chunking': {
          dirs: ['test/built-ins/Iterator/prototype/chunks'],
          samples: [{ path: 'test/built-ins/Iterator/prototype/chunks/a.js', url: 'https://x/a.js', text: 'x' }],
          truncated: false,
        },
      } },
    };
    const text = jsUpstreamLines(h, 'iterator-chunking').join(' ');
    if (!/Iterator\/prototype\/chunks/.test(text)) return 'did not name the upstream directory';
    return /from memory/.test(text) ? null : 'did not warn against writing from memory';
  });

  check('upstream: a truncated lookup is not reported as "no tests upstream"', () => {
    const h = { upstreamTests: { ok: true, truncated: true, flags: {
      'export-defer': { dirs: [], samples: [], truncated: true },
    } } };
    const text = jsUpstreamLines(h, 'export-defer').join(' ');
    return /truncated/.test(text) && /NOT "no tests upstream"/.test(text)
      ? null : `truncation was not distinguished: ${text}`;
  });

  check('upstream: a flag with genuinely no tests upstream says nothing extra', () => {
    // test262.fyi already reports "no test262 tests exist yet" for these; a second, vaguer
    // line about a truncated lookup would contradict it.
    const h = {
      fyi: { ok: true, results: { 'export-defer': { noTests: true, total: 0 } } },
      upstreamTests: { ok: true, truncated: true, flags: { 'export-defer': { dirs: [], samples: [], truncated: true } } },
    };
    return jsUpstreamLines(h, 'export-defer').length === 0
      ? null : 'contradicted the "no tests exist" finding';
  });

  check('upstream: a metadata test is not chosen as the example', () => {
    const { sampleScore } = require(path.join(SCRIPTS, 'lib', 'test262.js'));
    const f = (name, patch = '') => ({ filename: `test/built-ins/Iterator/prototype/chunks/${name}`, patch });
    const behavioural = f('chunks-evenly-divisible.js', 'function* g() { yield 1; }\nassert.compareArray(x, [1]);');
    for (const dull of ['length.js', 'prop-desc.js', 'chunkSize-not-a-number.js']) {
      if (sampleScore(f(dull, 'assert.throws(TypeError, ...)')) >= sampleScore(behavioural)) {
        return `${dull} scored at least as high as a behavioural test`;
      }
    }
    return null;
  });

  // -------------------------------------------------------------------------
  // The vendor changelog — feature -> test, the only source running that way
  // -------------------------------------------------------------------------
  // Two real misses on one release, in opposite directions, both invisible to every other
  // view: bug 2019332 (RTCIceTransport.getSelectedCandidatePair) WAS in the diff as
  // newly-passing IDL subtests and absent from the notes; bug 2048183 (:open for <select>)
  // was not in the diff at all, its test being FAIL 0/0 in both runs.
  const cl = require(path.join(SCRIPTS, 'lib', 'changelog.js'));
  const { bugFinding, bugGapBoxes, bugChecklistLines, boxPaths: bp } =
    require(path.join(SCRIPTS, 'lib', 'render.js'));

  check('changelog: a bug summary yields the API identifiers, not the prose', () => {
    const t = cl.tokensFor('Implement RTCIceTransport.getSelectedCandidatePair()/onselectedcandidatepairchange');
    for (const want of ['RTCIceTransport', 'getSelectedCandidatePair']) {
      if (!t.strong.includes(want)) return `${want} was not strong: ${JSON.stringify(t)}`;
    }
    return t.strong.includes('Implement') ? 'the verb "Implement" was kept as an identifier' : null;
  });

  check('changelog: a bare capitalised word is a WEAK token, not evidence', () => {
    // Promoting these was measurably wrong: `Typed` (from "Enable CSS Typed OM") matched a
    // WebRTC file, `JSON` matched a webauthn test, and `Select` produced 14 hits that BURIED
    // the real finding — that WPT cannot see :open for <select> at all.
    const t = cl.tokensFor('Implement :open pseudo class for Select elements');
    if (t.strong.includes('Select')) return '"Select" was treated as strong evidence';
    return t.weak.includes('Select') ? null : `"Select" was dropped entirely: ${JSON.stringify(t)}`;
  });

  check('changelog: a pref name contributes its feature-directory prefix', () => {
    // The pref is layout.css.tree-counting-functions.enabled; the tests are in
    // /css/css-values/tree-counting, so exact matching misses a headline feature.
    const t = cl.tokensFor('Set layout.css.tree-counting-functions.enabled for all users');
    return t.weak.includes('tree-counting')
      ? null : `no tree-counting prefix: ${JSON.stringify(t)}`;
  });

  check('changelog: precise tokens that MISS still fall back to the weak pass', () => {
    // The bug this guards: the weak pass was gated on strong tokens existing rather than on
    // strong tokens HITTING, so a bug with precise-but-unmatched tokens reported "NOT in the
    // diff" while the feature's directory sat right there.
    const changed = [{
      test: '/css/css-values/tree-counting/calc-sibling-function-parsing.html',
      deltaPass: 4,
      subtests: { newlyPassing: [{ name: 'sibling-index() in calc' }] },
    }];
    const r = cl.matchAgainstDiff(
      { summary: 'Set layout.css.tree-counting-functions.enabled for all users' }, changed);
    if (r.hits.length) return 'the precise pref name matched, so this case was not exercised';
    return r.weakHits.length ? null : 'the weak pass did not run after the strong pass missed';
  });

  check('changelog: a summary with no usable token is UNSEARCHABLE, not "not in the diff"', () => {
    const r = cl.matchAgainstDiff({ summary: 'Set the pref for all users' }, []);
    if (!r.unsearchable) return `expected unsearchable, got ${JSON.stringify(r).slice(0, 90)}`;
    const { short, lines } = bugFinding({ ...r });
    return /NOT CHECKED/.test(short) && /not the same as/.test(lines.join(' '))
      ? null : `rendered as "${short}"`;
  });

  check('changelog: a matched bug says the evidence is already in the diff', () => {
    const bug = {
      id: 1, summary: 'Implement RTCDtlsTransport.onerror', product: 'Core', component: 'WebRTC',
      unsearchable: false, tokens: ['RTCDtlsTransport'], weakTokens: [], weakHits: [],
      hits: [{ test: '/webrtc/idlharness.https.window.html', deltaPass: 2, matched: ['RTCDtlsTransport'], subtest: 'RTCDtlsTransport interface: attribute onerror' }],
    };
    const { short, lines } = bugFinding(bug);
    if (!/in the diff/.test(short)) return `short form did not say so: ${short}`;
    return /you missed it/.test(lines.join(' ')) ? null : 'did not tell the reader to check the notes';
  });

  // The correction that mattered most: `:open` for <select> is FIXED with a dev-doc keyword
  // and its test fails in BOTH runs — because the feature is behind a pref, so the failing
  // test is CORRECT. Reporting that as "no WPT coverage, the bug is the only source" inverted
  // the truth. resolution=FIXED means landed, not enabled.
  check('changelog: the summary\'s own "behind pref" wording is read', () => {
    const cases = [
      ['Implement progress() function behind pref', 'behind pref'],
      ['Enable CSS Typed OM by default in Nightly', 'in Nightly'],
      ['[text-box-trim] Set layout.css.text-box.enabled for nightly', 'for nightly'],
      // ...and must NOT fire on the bug that actually ships it.
      ['Set layout.css.text-box.enabled for all users', null],
      ['Ship Iterator Join proposal', null],
    ];
    for (const [summary, want] of cases) {
      const got = cl.enablementFromSummary(summary);
      if ((got || null) !== want && !(want && got && got.toLowerCase() === want.toLowerCase())) {
        return `${JSON.stringify(summary)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
      }
    }
    return null;
  });

  check('changelog: "not in the diff" never claims to be the only source', () => {
    // Three reasons produce an empty match and only one is "no coverage". Asserting which is
    // how the :open error happened, so the wording must offer all three.
    const r = cl.matchAgainstDiff({ summary: 'Implement RTCFoo.barBaz()' }, [], []);
    const { short, lines } = bugFinding({ ...r, id: 1 });
    const text = lines.join(' ');
    if (/only source/.test(short)) return `the short form asserts it: ${short}`;
    for (const want of [/NOT enabled/, /no WPT coverage/, /vocabulary/]) {
      if (!want.test(text)) return `the three possibilities are not all offered: missing ${want}`;
    }
    return null;
  });

  check('changelog: the still-failing probe uses PRECISE tokens only', () => {
    // With weak tokens it matched hundreds of unrelated failing paths and reported every bug
    // as "landed, not enabled" — including the three Iterator proposals that had shipped.
    const stillFailing = [
      { test: '/css/css-values/some-alpha-thing.html', pass: 0, total: 3 },
      { test: '/webrtc/RTCIceTransport-extension.html', pass: 0, total: 3 },
    ];
    // "alpha" is a weak token: it must NOT reach the failing probe.
    const weakOnly = cl.matchAgainstDiff({ summary: 'Implement alpha() function behind pref' }, [], stillFailing);
    if (weakOnly.failingHits.length) return 'a weak token matched failing paths';
    // A precise one should.
    const precise = cl.matchAgainstDiff({ summary: 'Implement RTCIceTransport.foo()' }, [], stillFailing);
    return precise.failingHits.length ? null : 'a precise token did not match a failing path';
  });

  check('changelog: every bug becomes a box, and box paths need no quoting', () => {
    const fresh = {
      ok: true, version: 154, milestone: '154 Branch', total: 3256,
      curated: [
        { id: 2048183, summary: ':open for select', product: 'Core', component: 'DOM', tokens: ['x'], weakTokens: [], hits: [], weakHits: [], unsearchable: false },
        { id: 2019332, summary: 'RTCIceTransport.getSelectedCandidatePair()', product: 'Core', component: 'WebRTC', tokens: ['RTCIceTransport'], weakTokens: [], weakHits: [], unsearchable: false, hits: [{ test: '/a.html', deltaPass: 2, matched: ['RTCIceTransport'], subtest: 'x' }] },
      ],
      census: [],
    };
    const boxes = bugGapBoxes(fresh);
    if (boxes.length !== 2) return `expected 2 boxes, got ${boxes.length}`;
    const bad = boxes.map((b) => b.path).filter((x) => /[?()|[\]$;<>*'"\s&\\]/.test(x));
    if (bad.length) return `needs quoting: ${bad.join(', ')}`;
    const paths = bp(bugChecklistLines(fresh).join('\n'));
    for (const b of boxes) {
      if (!paths.includes(b.path)) return `${b.path} is not a parseable box`;
    }
    // The gap must sort before the matched one: it is the one nothing else will mention.
    return paths[0] === 'bug:2048183' ? null : `gaps did not sort first: ${paths.join(',')}`;
  });

  check('horizon: a failed or absent check never renders as "no gaps"', () => {
    // The one thing an unmeasured blind spot must not be able to look like. Both the
    // report section and the inventory caveat have to say so out loud.
    const { jsHorizonLines } = require(path.join(SCRIPTS, 'lib', 'render.js'));
    for (const [label, h] of [['absent', undefined], ['failed', { ok: false, error: 'boom' }]]) {
      const text = jsHorizonLines(h).join('\n');
      if (!/NOT CHECKED/.test(text)) return `a ${label} horizon rendered without saying so`;
      if (jsGapBoxes(h).length) return `a ${label} horizon produced boxes`;
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Output size — the failure that kept arriving through different doors
// ---------------------------------------------------------------------------
// Five separate times, a view outgrew what a tool result holds. The harness then
// truncated it with no marker, or the command errored outright, and the reflex fix
// was a shell filter that dropped information silently: `head` on the inventory,
// a `sed` range on one file, a `grep` for an arrow, `tail` on a synopsis. An audit
// found three views still unbounded — a broad wpt-grep pattern produced 3MB and
// `wpt-state --grep / --limit 0` produced 16MB, five hundred times the limit.
//
// So this is a standing sweep rather than three more one-off checks: every command,
// at its most verbose plausible arguments, must either fit the budget or say out
// loud that it is one page of several. A future view that forgets to page fails here.
const OUTPUT_LIMIT = 30000;

function outputSizeChecks(dir) {
  const cases = [
    ['wpt-inventory.js', []],
    ['wpt-inventory.js', ['--dirs']],
    ['wpt-inventory.js', ['--regressions']],
    ['wpt-report.js', []],
    ['wpt-report.js', ['--top', '0']],
    ['wpt-report.js', ['--list']],
    ['wpt-subtests.js', ['--grep', '/']],
    ['wpt-grep.js', ['e']],
    ['wpt-grep.js', ['color']],
    ['wpt-state.js', ['--grep', '/', '--limit', '0']],
    ['wpt-fetch-tests.js', ['--area', '/css', '--top', '5', '--head', '0']],
    ['wpt-runs.js', ['--max-count', '40']],
    // --stored is this script's offline form; without it, it fetches.
    ['wpt-js-gaps.js', ['--stored']],
    ['wpt-bugs.js', []],
    ['wpt-bugs.js', ['--census']],
    ['wpt-bugs.js', ['--component', 'Layout']],
  ];
  for (const [script, args] of cases) {
    check(`output fits or pages: ${script} ${args.join(' ')}`.trim(), () => {
      let out;
      try {
        out = run(script, [dir, ...args]);
      } catch (err) {
        // wpt-runs.js needs the network, which is black-holed here.
        if (script === 'wpt-runs.js') return null;
        return `exited ${err.status}: ${String(err.stderr || '').split('\n')[0]}`;
      }
      if (out.length <= OUTPUT_LIMIT) return null;
      // Over the limit is fine ONLY if it announces itself as one page of several.
      if (/^!! PART \d+ OF \d+/m.test(out)) return null;
      return `${out.length} bytes with NO part marker — it will be truncated silently`;
    });
  }

  // A suggested command has one job: to be run. These scripts print them constantly —
  // resume lines, "read the cause", the worksheet's per-box hint — and for a long time
  // several of them emitted a WPT variant path, which cannot be run either way. Bare,
  // the shell globs on `?` and dies before node starts. Quoted, the shell is happy and
  // the permission matcher is not, so it prompts.
  //
  // Both forms were offered and both were taken. `# paste as: '<quoted>'` led to
  // `wpt-subtests.js '/html/syntax/parsing/html5lib_url.html?file=webkit02'` prompting,
  // and the label had promised the opposite. So: anything printed in a runnable
  // position must be free of shell metacharacters. Quoting advice still exists for the
  // literal-path case, but never on a line that looks ready to copy.
  check('every suggested command is runnable as printed', () => {
    // A line whose content begins with the command, i.e. sitting in the copy position.
    const RUNNABLE = /^(?:[\s!]*)(node scripts\/\S+.*)$/;
    const METACHAR = /[?()|[\]$;<>*'"]/;
    const probes = [
      ['wpt-inventory.js', []],
      ['wpt-inventory.js', ['--verify']],
      ['wpt-subtests.js', ['--grep', '/css/css-color/parsing']],
      ['wpt-subtests.js', ['/no/such/path.html?x=(a|b)']],
      ['wpt-state.js', ['--grep', '/css', '--limit', '0']],
      ['wpt-grep.js', ['color']],
      ['wpt-fetch-tests.js', ['--area', '/css', '--top', '3', '--head', '10']],
      ['wpt-report.js', []],
      ['wpt-js-gaps.js', ['--stored']],
      ['wpt-bugs.js', []],
    ];
    // Only wpt-runs.js and wpt-collect.js operate without an artifact; everything else
    // needs one named. Suggested commands used to omit it, relying on "there is only one
    // comparison in tmp/" — which stops being true the moment a second is collected, and
    // then every "continue with" line fails with "name the one you mean", exactly when
    // someone is working across two. Asserting the property here rather than staging a
    // second artifact, since the property is what has to hold.
    const NEEDS_ARTIFACT = /node scripts\/wpt-(inventory|report|subtests|grep|state|fetch-tests|resolve|js-gaps|bugs)\.js/;
    const offenders = [];
    for (const [script, args] of probes) {
      let out;
      try {
        out = run(script, [dir, ...args]);
      } catch (err) {
        // --verify exits 1 by design while boxes are open, and a bogus path exits 1
        // too; the output is what is under test either way.
        out = String(err.stdout || '');
      }
      for (const line of out.split('\n')) {
        const m = line.match(RUNNABLE);
        if (!m) continue;
        if (METACHAR.test(m[1])) {
          offenders.push(`${script}: metacharacter — ${m[1].trim().slice(0, 80)}`);
        } else if (NEEDS_ARTIFACT.test(m[1]) && !/(?:^|\s)(?:\/|\.{0,2}\/|tmp\/)\S*/.test(m[1].replace(/node scripts\/\S+/, ''))) {
          offenders.push(`${script}: names no artifact — ${m[1].trim().slice(0, 80)}`);
        }
      }
    }
    return offenders.length ? offenders.join('\n      ') : null;
  });

  // A filtered read must lead with its OWN side. Asking for still-failing and being shown a
  // 144x rollup of FIXES as the first substantive line nearly produced a misattribution.
  check('--only leads with the requested category, and labels the other side', () => {
    const diff = JSON.parse(fs.readFileSync(path.join(dir, 'diff.json'), 'utf8'));
    // A file with many fixes and few still-failing is where the trap lives.
    const target = diff.tests
      .filter((t) => t.subtests && t.subtests.counts.newlyPassing > 20
        && t.subtests.counts.stillFailing > 0
        && t.subtests.counts.stillFailing < 5)
      .sort((a, b) => b.subtests.counts.newlyPassing - a.subtests.counts.newlyPassing)[0];
    if (!target) return null;
    const out = run('wpt-subtests.js', [dir, target.test, '--only', 'still-failing']);
    const fixesAt = out.indexOf('dominant fixes message');
    if (fixesAt === -1) return null;   // no cross-side rollup to mislabel
    const warnAt = out.indexOf('NOT WHAT YOU ASKED FOR');
    if (warnAt === -1 || warnAt > fixesAt) {
      return 'a fixes rollup was shown under --only still-failing with no warning above it';
    }
    return null;
  });

  // A key that shares its line with a "[reach it with: --grep ...]" note was read as an
  // instruction, because the surrounding doctrine says never to pass a ?query path. One pass
  // submitted the --grep fragment as a key for one box and kept ?rest on another, in one file.
  check('wpt-resolve.js --list puts the key alone on its line', () => {
    const out = run('wpt-resolve.js', [dir, '--list']);
    if (/box\(es\) with no verdict/.test(out) === false) return null;   // nothing open
    for (const line of out.split('\n')) {
      if (/^\S/.test(line) && !line.startsWith('#') && !line.startsWith('!!')) {
        if (/\s#|\[reach it with/.test(line)) return `a key line carries a note: ${line.slice(0, 90)}`;
      }
    }
    return null;
  });

  // Paging is only honest if the pages tile. A view that pages but drops or repeats
  // blocks is worse than one that truncates, because it looks complete.
  check('every paged view tiles exactly (no gaps, no repeats)', () => {
    // Row patterns must be tight. A loose one matched the synopsis line "ONE bug
    // fixed unblocking many tests", which is repeated on every page BY DESIGN, and
    // reported a 4-row discrepancy that did not exist. Anchor on the real status
    // vocabulary instead of "some capitals".
    const ST = 'PASS|FAIL|TIMEOUT|NOTRUN|ERROR|CRASH|SKIP|PRECONDITION_FAILED|OK|\\(new\\)|\\?';
    const probes = [
      ['wpt-grep.js', ['color'], /^  [+~=-] \//],
      ['wpt-state.js', ['--grep', '/css/css-color', '--limit', '0'], /^  \S+ +\d+\/\d+/],
      ['wpt-subtests.js', ['--grep', '/css/css-color/parsing'],
        new RegExp(`^  (?:${ST}) *(?:-> *(?:${ST}))? +\\S`)],
    ];
    for (const [script, args, rowRe] of probes) {
      const rowsIn = (o) => o.split('\n').filter((l) => rowRe.test(l));
      const all = rowsIn(run(script, [dir, ...args, '--all']));
      const paged = [];
      for (let n = 1; n <= 400; n++) {
        const o = run(script, [dir, ...args, '--part', String(n)]);
        paged.push(...rowsIn(o));
        if (!/^!! PART/m.test(o) || /That was the last part/.test(o)) break;
        if (n === 400) return `${script} pagination did not terminate`;
      }
      if (JSON.stringify(all) !== JSON.stringify(paged)) {
        return `${script}: --all has ${all.length} rows, pages have ${paged.length}`;
      }
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Artifact-independent
// ---------------------------------------------------------------------------
function generalChecks(dir) {
  outputSizeChecks(dir);
  check('--include matches on a path boundary, not a string prefix', () => {
    const out = run('wpt-inventory.js', [dir, '--dirs', '--include', '/dom']);
    return /^\/domparsing/m.test(out) ? '--include /dom leaked /domparsing' : null;
  });

  // The inventory is the coverage guarantee, so it must never quietly drop rows.
  check('the inventory lists every changed file', () => {
    const diff = JSON.parse(fs.readFileSync(path.join(dir, 'diff.json'), 'utf8'));
    const changed = diff.tests.filter((t) => t.kind !== 'unchanged').length;
    const out = run('wpt-inventory.js', [dir, '--dirs']);
    const claimed = Number((out.match(/^(\d+) changed test files/m) || [])[1] || 0);
    return claimed === changed ? null : `inventory says ${claimed}, diff has ${changed}`;
  });

  // The synopsis has to come BEFORE the detail. It used to be a trailing rollup,
  // which put the shape of a file behind hundreds of lines — so truncating the
  // output destroyed exactly the part worth keeping, and truncating is what a
  // reader facing 135 lines actually does.
  check('the per-file synopsis is front-loaded, before any subtest detail', () => {
    const diff = JSON.parse(fs.readFileSync(path.join(dir, 'diff.json'), 'utf8'));
    const busiest = diff.tests
      .filter((t) => t.subtests && t.subtests.counts.stillFailing > 5)
      .sort((a, b) => b.subtests.counts.stillFailing - a.subtests.counts.stillFailing)[0];
    if (!busiest) return null;
    const lines = run('wpt-subtests.js', [dir, busiest.test]).split('\n');
    const synopsis = lines.findIndex((l) => l.startsWith('## Synopsis'));
    const firstSection = lines.findIndex((l) => /^## (?!Synopsis)/.test(l));
    if (synopsis === -1) return 'no synopsis at all';
    if (firstSection !== -1 && synopsis > firstSection) {
      return `synopsis at line ${synopsis} came after a detail section at ${firstSection}`;
    }
    // The counts are the part a truncated read must still get right.
    return lines.slice(synopsis, synopsis + 4).join(' ').includes('failing in both runs')
      ? null
      : 'synopsis does not carry the still-failing count';
  });

  // --match exists so a bounded read is bounded by meaning rather than by line
  // position. A filtered view that also filtered its own totals would be the same
  // silent-truncation trap wearing a flag.
  check('--match filters sections but still reports the file\'s true totals', () => {
    const diff = JSON.parse(fs.readFileSync(path.join(dir, 'diff.json'), 'utf8'));
    const busiest = diff.tests
      .filter((t) => t.subtests && t.subtests.counts.stillFailing > 5)
      .sort((a, b) => b.subtests.counts.stillFailing - a.subtests.counts.stillFailing)[0];
    if (!busiest) return null;
    const needle = busiest.subtests.stillFailing[0].name.slice(0, 12);
    const out = run('wpt-subtests.js', [dir, busiest.test, '--match', needle]);
    const total = busiest.subtests.counts.stillFailing;
    if (!out.includes(`${total} failing in both runs`)) {
      return `filtered output does not report the true total of ${total}`;
    }
    return /FILTERED to subtests matching/.test(out) ? null : 'no notice that output was filtered';
  });

  // The full inventory does not fit in one tool result, and the workaround that
  // suggests itself — redirect to a file, read line ranges — cuts across directory
  // boundaries so a directory appears with only some of its files. --part exists so
  // that is never necessary, which only holds if the parts tile the whole thing
  // exactly: no gap, no overlap, same order.
  check('--part tiles the whole inventory with no gaps or overlaps', () => {
    const dirLine = /^\/\S*  \[\d+ files?,/;
    const dirsIn = (out) => out.split('\n').filter((l) => dirLine.test(l));
    const all = dirsIn(run('wpt-inventory.js', [dir, '--all']));

    const paged = [];
    for (let n = 1; n <= 200; n++) {
      const out = run('wpt-inventory.js', [dir, '--part', String(n)]);
      paged.push(...dirsIn(out));
      if (!/^!! PART \d+ OF (\d+)/m.test(out)) break;      // small diff, single page
      if (/That was the last part/.test(out)) break;
      if (n === 200) return 'more than 200 parts — pagination is not terminating';
    }
    if (paged.length !== all.length) {
      return `--all lists ${all.length} directories, parts list ${paged.length}`;
    }
    return JSON.stringify(all) === JSON.stringify(paged)
      ? null
      : 'parts do not reproduce --all in order — a directory is duplicated or missing';
  });

  // Past the last part must be a bounded no-op, not an empty page that reads as
  // "nothing left here" when the reader miscounted.
  check('--part past the end clamps to the last part rather than printing nothing', () => {
    const out = run('wpt-inventory.js', [dir, '--part', '9999']);
    if (!/^!! PART /m.test(out)) return null; // single-page diff
    return /That was the last part/.test(out) ? null : 'no terminal notice on an over-range part';
  });

  // "Just the newly-passing" gets asked by grepping for an arrow, and
  // `grep 'FAIL    -> PASS'` silently misses a NOTRUN/TIMEOUT prior and misses
  // `(new)   -> PASS` — a brand-new assertion that holds — entirely. That last
  // omission is how an ENTIRELY NEW interface appears, so the pattern fails hardest
  // on the claim it gets used to check. --only must cover every kind.
  check('--only newly-passing includes new subtests, not just FAIL -> PASS', () => {
    const diff = JSON.parse(fs.readFileSync(path.join(dir, 'diff.json'), 'utf8'));
    const withAdded = diff.tests.find(
      (t) => t.subtests && t.subtests.newlyPassing.some((s) => s.added),
    );
    if (!withAdded) return null;
    // --all, because this counts RENDERED ROWS. Without it the check measures page 1 and
    // compares it to the whole-artifact total, so it passes only while the probe file
    // happens to fit one page — and fails the day discovery picks an artifact with a
    // 1242-subtest file (109KB, five pages). Any row-counting check needs --all; this is
    // the second one to have been written without it.
    const out = run('wpt-subtests.js', [dir, withAdded.test, '--only', 'newly-passing', '--all']);
    const expected = withAdded.subtests.counts.newlyPassing;
    const shown = (out.match(/^  (?:\(new\)|\S+ +)-> PASS/gm) || []).length;
    if (shown !== expected) return `${expected} newly passing in the artifact, ${shown} rendered`;
    // And the naive grep must be demonstrably worse, or this guard proves nothing.
    const naive = (out.match(/^  FAIL {4}-> PASS/gm) || []).length;
    return naive < expected
      ? null
      : `this file has no non-FAIL priors, so it cannot guard the grep trap`;
  });

  check('--only rejects an unknown category instead of silently showing nothing', () => {
    try {
      run('wpt-subtests.js', [dir, '--grep', '/', '--only', 'newly-pasing']);
    } catch (err) {
      return /unknown --only category/.test(String(err.stderr || '')) ? null : 'wrong error';
    }
    return 'a misspelled category was accepted';
  });

  // A WPT variant path globs in the shell — `?` is a wildcard, `(a|b)` a glob group
  // — so an unquoted one dies with "no matches found" before node starts, and no
  // script can explain it. 17% of changed paths in one comparison were affected.
  //
  // This used to assert that a `# paste as: '<quoted>'` line was printed, and passed
  // for a long time while being the wrong requirement. Quoting satisfies the shell and
  // not the permission matcher, so the label was promising something it could not
  // deliver — and it was believed: a real pass copied the quoted form and prompted.
  // Both halves are now required. The --grep route is what leads, and the quoted form
  // has to still be offered and still round-trip, because passing the literal path is
  // a real thing to want.
  check('a query-variant path is shown with a --grep route AND a working quoted form', () => {
    const diff = JSON.parse(fs.readFileSync(path.join(dir, 'diff.json'), 'utf8'));
    const tricky = diff.tests.find(
      (t) => t.kind !== 'unchanged' && /[?()|]/.test(t.test) && t.subtests,
    );
    if (!tricky) return null;
    const out = run('wpt-subtests.js', [dir, tricky.test]);

    const grepLine = (out.match(/^# reach it with: +--grep (\S+)$/m) || [])[1];
    if (!grepLine) return 'no --grep route offered for a query path';
    if (/[?()|[\]$;<>*'"]/.test(grepLine)) return `the --grep fragment is not metachar-free: ${grepLine}`;
    // And it has to actually select the test it is offered for. --all for the same
    // reason as above: a fragment that matches many files puts the target on a later
    // page, and "not on page 1" is not "not selected".
    const viaGrep = run('wpt-subtests.js', [dir, '--grep', grepLine, '--all']);
    if (!viaGrep.includes(tricky.test)) return `--grep ${grepLine} does not reach ${tricky.test}`;

    const quoted = (out.match(/^# or as a literal path, shell-quoted: (.+)$/m) || [])[1];
    if (!quoted) return 'the literal-path fallback is no longer offered';
    const echoed = execFileSync('/bin/sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' });
    if (echoed !== tricky.test) return `quoted form does not round-trip: ${echoed}`;
    // It must not read as the recommended form, or it gets copied again.
    return /still ask permission/.test(out) ? null : 'the quoted form is offered without its caveat';
  });

  // The scripts share a selection vocabulary unevenly enough that guessing wrong is
  // the normal outcome of learning them — `--grep` on wpt-fetch-tests.js failed for
  // exactly that reason, right after the skill started recommending `--grep`. So
  // `--grep` must mean the same thing everywhere, and a wrong guess must name the
  // real flags rather than dead-ending at --help.
  check('--grep selects test files on every script that selects test files', () => {
    for (const script of ['wpt-inventory.js', 'wpt-subtests.js', 'wpt-fetch-tests.js', 'wpt-state.js']) {
      const flags = require(path.join(SCRIPTS, 'lib', 'cli.js')).flagsOf(path.join(SCRIPTS, script));
      if (!flags.includes('--grep')) return `${script} has no --grep (has: ${flags.join(' ')})`;
    }
    return null;
  });

  check('--grep is additive with explicitly named paths', () => {
    const diff = JSON.parse(fs.readFileSync(path.join(dir, 'diff.json'), 'utf8'));
    const changed = diff.tests.filter((t) => t.kind !== 'unchanged' && t.subtests);
    const named = changed.find((t) => !/[?()|]/.test(t.test));
    if (!named) return null;
    // A substring that matches something OTHER than the named path.
    const other = changed.find((t) => t.test !== named.test && /[?()|]/.test(t.test));
    if (!other) return null;
    const token = other.test.replace(/^\//, '').split(/[/.?]/)[1] || 'url';
    // --all, because output is paged: the named file alone can fill page 1, putting
    // the grep matches on later pages and making a page-1 header count read as
    // "additive selection is broken" when it is working.
    const out = run('wpt-subtests.js', [dir, named.test, '--grep', token, '--all']);
    const headers = (out.match(/^# \/.+$/gm) || []).length;
    if (headers < 2) return `expected the named path plus grep matches, got ${headers} file(s)`;
    return out.includes(named.test) ? null : 'the explicitly named path was dropped';
  });

  check('an unknown option names the real flags instead of dead-ending', () => {
    try {
      run('wpt-fetch-tests.js', [dir, '--grepp', 'x']);
    } catch (err) {
      const msg = String(err.stderr || '');
      if (!/unknown option --grepp/.test(msg)) return 'no "unknown option" line';
      if (!/this script accepts:/.test(msg)) return 'does not list the script\'s real flags';
      return /did you mean --grep\?/.test(msg) ? null : 'no nearest-flag suggestion';
    }
    return 'a bogus option was accepted';
  });

  // The gate has to actually fail, or it is advice with punctuation.
  check('--verify exits non-zero while boxes are open', () => {
    try {
      run('wpt-inventory.js', ['--verify', dir]);
    } catch (err) {
      return err.status === 1 ? null : `exited ${err.status}, expected 1`;
    }
    // Exit 0 is correct only if the worksheet really is fully ticked.
    const text = fs.readFileSync(path.join(dir, 'checklist.md'), 'utf8');
    return /^(\[ \]|\(\s\)|\(\?\))/m.test(text)
      ? '--verify exited 0 with boxes still open'
      : null;
  });

  // Exit 1 is the normal state for most of a pass, and was being read as a crash.
  // It has to say what it is.
  check('--verify announces itself as a gate rather than looking like a crash', () => {
    let out;
    try {
      out = run('wpt-inventory.js', ['--verify', dir]);
    } catch (err) {
      out = String(err.stdout || '');
    }
    if (/GATE PASSED/.test(out)) return null;
    if (!/^GATE: NOT READY/m.test(out)) return 'no "GATE: NOT READY" line';
    return /expected here|Not a failure/i.test(out)
      ? null
      : 'does not say a non-zero exit is expected';
  });

  // A crash or hang is the most user-visible failure there is, and `CRASH 0/0 ->
  // PASS 0/0` has deltaPass 0 — so while these shared a section with recoveries that
  // do have subtests, they sorted last and --top cut them.
  // /css/css-multicol/content-visibility-001-crash.html and
  // /css/css-page/page-name-002-print.html were both lost that way on a real diff and
  // had to be recovered from the inventory by hand.
  check('crashtest fixes are not out-ranked by partial recoveries', () => {
    const diff = JSON.parse(fs.readFileSync(path.join(dir, 'diff.json'), 'utf8'));
    const zeroSub = diff.tests.filter((t) => t.kind === 'newly-running'
      && (t.after?.total || 0) === 0 && (t.before?.total || 0) === 0);
    if (!zeroSub.length) return null;
    // --all, because the property under test is "not out-ranked and not cut by --top", not
    // "lands on page one". Adding any section above them would otherwise fail this check
    // while the ranking it guards was still correct.
    const out = run('wpt-report.js', [dir, '--all']);
    const missing = zeroSub.filter((t) => !out.includes(t.test));
    return missing.length
      ? `${missing.length} of ${zeroSub.length} crash/hang fixes absent from report.txt, e.g. ${missing[0].test}`
      : null;
  });

  // The apply step for the worksheet. Instrumenting a real run put 106 Edit calls and
  // ~40k output tokens — 22% of everything generated — into ticking boxes; the same
  // verdicts as a data file are ~7k. Both refusals below are what stop that becoming
  // the earlier regex script, which stamped every unmatched box "written up — see
  // notes" and would have passed the gate on all 416.
  // A completeness claim must be true. `wpt-state.js --grep` used to slice its match
  // list at 40 BEFORE the paginator saw it, so the paginator said "!! END — all 40
  // tests shown." about a 143-match search, with the notice about the other 103 printed
  // after the END marker and not even marked `!!`.
  //
  // That is not a cosmetic ordering problem. `--grep text-box-trim` had 11 tests still
  // failing and 10 of them were past the cap, so the visible answer to "what is left?"
  // was 1 of 11 — and six text-box-trim-line-clamp-* failures, a coherent feature gap,
  // were invisible. Pagination can say what it has not shown; a cap cannot, so there
  // are no caps.
  check('"all N shown" is never printed over dropped rows', () => {
    const probes = [
      ['wpt-state.js', ['--grep', 'text-box-trim']],
      ['wpt-state.js', ['--grep', 'css-inline']],
      ['wpt-subtests.js', ['--grep', '/css/css-color']],
      ['wpt-grep.js', ['color']],
    ];
    for (const [script, args] of probes) {
      const out = run(script, [dir, ...args]);
      if (/beyond --limit/.test(out)) return `${script} still drops rows to a cap`;
      const claim = out.match(/^!! END — all (\d+) (\S+) shown/m);
      if (!claim) continue;
      // The claimed count must match the rows actually emitted.
      const rows = out.split('\n').filter((l) => /^ {2}\S+ +\d+\/\d+ +->/.test(l)).length;
      if (rows && Number(claim[1]) !== rows) {
        return `${script} claims all ${claim[1]} ${claim[2]} shown but printed ${rows} rows`;
      }
    }
    return null;
  });

  check('wpt-state.js --only failing-after returns only failures', () => {
    const out = run('wpt-state.js', [dir, '--grep', 'css-inline', '--only', 'failing-after']);
    const rows = out.split('\n').filter((l) => /^ {2}\S+ +\d+\/\d+ +->/.test(l));
    if (!rows.length) return null;
    // The right-hand side of every row must be a non-passing state.
    const wrong = rows.filter((l) => / -> {2}(PASS|OK) +(\d+)\/\2\b/.test(l));
    return wrong.length ? `${wrong.length} passing row(s) survived the filter, e.g. ${wrong[0].trim()}` : null;
  });

  // The general form of the test262 bug. Three separate generated-wrapper suffixes were
  // missing from toSourcePath — .test262.html, .extension.html, and then
  // .test262-module.html, which only turned up by re-collecting after fixing the first
  // two and looking at what was still empty. A fixed list of known suffixes would have
  // needed three rounds; this catches the next one on the first.
  //
  // Keyed on families rather than totals because a handful of empty sources is normal
  // (a renamed or generated-only test), while an ENTIRE suffix family empty means no
  // mapping exists. A miss is stored as an empty body, so nothing else notices.
  check('no whole suffix family has an empty source', () => {
    const { readCached } = require(path.join(SCRIPTS, 'lib', 'sources.js'));
    const sources = path.join(dir, 'sources');
    if (!fs.existsSync(sources)) return null;
    const diff = JSON.parse(fs.readFileSync(path.join(dir, 'diff.json'), 'utf8'));
    const fams = new Map();
    for (const t of diff.tests.filter((x) => x.kind !== 'unchanged')) {
      const base = t.test.split('/').pop().replace(/\?.*$/, '');
      const suffix = (base.match(/\.[^.]+\.html?$/) || [])[0];
      if (!suffix) continue;
      const cached = readCached(sources, t.test);
      // Only a RECORDED miss counts. readCached distinguishes "tried and there was
      // nothing there" (an entry with an empty body) from "never tried" (no entry), and
      // that distinction is the whole point of writing misses down: an absent entry is
      // no evidence either way, so counting it as empty would make this check fail for a
      // cache that is merely incomplete.
      if (!cached) continue;
      const f = fams.get(suffix) || { n: 0, empty: 0 };
      f.n++;
      if (!cached.text.trim()) f.empty++;
      fams.set(suffix, f);
    }
    const dead = [...fams.entries()]
      .filter(([, f]) => f.n >= 5 && f.empty === f.n)
      .map(([s, f]) => `*${s} (${f.n} files, all empty)`);
    if (!dead.length) return null;
    // Two causes, both actionable, and the message must not assert the wrong one: either
    // toSourcePath has no mapping for the suffix, or it has just gained one and this
    // artifact's cache predates it. A miss is stored as an empty body and never retried.
    return `${dead.join(', ')}\n      Either toSourcePath has no mapping for this wrapper `
      + 'type, or this artifact\n      was collected before it gained one — re-collect to tell them apart.';
  });

  check('wpt-resolve.js refuses a key that matches no box', () => {
    const f = path.join(require('os').tmpdir(), 'selftest-badkey.json');
    fs.writeFileSync(f, JSON.stringify({ '/no/such/directory': 'written up: nothing' }));
    try {
      run('wpt-resolve.js', [dir, f]);
      return 'it accepted a key matching no box';
    } catch (err) {
      const out = String(err.stderr || '') + String(err.stdout || '');
      return /match no box/.test(out) ? null : `wrong error: ${out.split('\n')[0]}`;
    }
  });

  check('wpt-resolve.js refuses a verdict the gate would reject', () => {
    const text = fs.readFileSync(path.join(dir, 'checklist.md'), 'utf8');
    const open = text.split('\n')
      .map((l) => (l.match(/^(?:\[ \]|\( \)|\(\?\))\s+(\S+)/) || [])[1])
      .filter(Boolean);
    if (!open.length) return null;
    const f = path.join(require('os').tmpdir(), 'selftest-badverdict.json');
    fs.writeFileSync(f, JSON.stringify({ [open[0]]: 'written up — see notes' }));
    const before = fs.readFileSync(path.join(dir, 'checklist.md'), 'utf8');
    try {
      run('wpt-resolve.js', [dir, f]);
      return 'it accepted "see notes" as a verdict';
    } catch (err) {
      const out = String(err.stderr || '') + String(err.stdout || '');
      if (!/would not pass the gate/.test(out)) return `wrong error: ${out.split('\n')[0]}`;
      // And it must not have written anything on the way to refusing.
      return fs.readFileSync(path.join(dir, 'checklist.md'), 'utf8') === before
        ? null : 'it modified checklist.md before refusing';
    }
  });

  check('wpt-resolve.js --dry-run leaves the checklist alone', () => {
    const ck = path.join(dir, 'checklist.md');
    const text = fs.readFileSync(ck, 'utf8');
    const open = text.split('\n')
      .map((l) => (l.match(/^(?:\[ \]|\( \)|\(\?\))\s+(\S+)/) || [])[1])
      .filter(Boolean);
    if (!open.length) return null;
    const f = path.join(require('os').tmpdir(), 'selftest-dryrun.json');
    fs.writeFileSync(f, JSON.stringify({ [open[0]]: 'not a feature: selftest probe, churn' }));
    const out = run('wpt-resolve.js', [dir, f, '--dry-run']);
    if (!/nothing written/i.test(out)) return 'no "nothing written" confirmation';
    return fs.readFileSync(ck, 'utf8') === text ? null : '--dry-run modified checklist.md';
  });
}

(async () => {
  // Transport first: if the network layer is broken, every artifact below is either
  // stale or about to be regenerated from bad data.
  await transportChecks();

  // Pure logic next: these need no artifact, so they still run when tmp/ has been
  // wiped — which is most of the time during end-to-end testing.
  rollupChecks();
  checklistChecks();
  await horizonChecks();

  let missing = 0;
  for (const c of cases) {
    const dir = opts[c.artifact];
    if (!fs.existsSync(path.join(dir, 'diff.json'))) {
      missing++;
      console.log(`SKIP  no artifact at ${dir} — cannot check ${c.label}`);
      continue;
    }
    c.checks(JSON.parse(fs.readFileSync(path.join(dir, 'diff.json'), 'utf8')), dir);
  }

  // These checks are about mechanics — output size, pagination tiling, path
  // boundaries — not about a specific release, so ANY collected comparison
  // exercises them. Falling back to whatever is in tmp/ matters because the
  // fixtures are routinely deleted between end-to-end runs, and without this the
  // whole output-size sweep silently sat out exactly when it was most useful.
  const { discover } = require(path.join(SCRIPTS, 'lib', 'artifact.js'));
  const any = [opts.a, opts.b, ...discover()]
    .find((d) => d && fs.existsSync(path.join(d, 'diff.json')));
  if (any) {
    if (![opts.a, opts.b].includes(any)) {
      console.log(`note: fixtures absent; running mechanical checks against ${path.basename(any)}`);
    }
    generalChecks(any);
  } else {
    console.log('SKIP  no artifact anywhere in tmp/ — mechanical checks cannot run');
    missing++;
  }

  console.log('');
  console.log(`${passed} passed, ${failed} failed${missing ? `, ${missing} artifact(s) missing` : ''}`);
  if (failed) process.exit(1);
  if (missing) {
    console.log('');
    console.log('Coverage is INCOMPLETE — collect the artifacts and re-run (see --help).');
    process.exit(2);
  }
})();
