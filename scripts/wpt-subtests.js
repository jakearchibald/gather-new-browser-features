#!/usr/bin/env node
/**
 * Diff the *individual subtests* of one test file between two runs, with the
 * assertion message for each failure.
 *
 * Why this exists: a subtest count tells you a file moved; it does not tell you why.
 * "getComputedTiming() 26/41 -> 41/41" reads like fifteen timing fixes. The subtest
 * messages showed all fifteen were one missing property — startTime was `undefined`,
 * and because it is the first assertion in ten of those tests, that single line failed
 * them all. The count cannot distinguish "15 bugs fixed" from "1 bug fixed, 15 tests
 * unblocked", and those are different release notes.
 *
 * Names and messages also give you the vocabulary developers search for: property
 * names, method names, the actual expected-vs-got values.
 *
 * Usage:
 *   node wpt-subtests.js <diff.json> <test-path> [<test-path> ...]
 *   node wpt-subtests.js --before <run_id> --after <run_id> <test-path> ...
 *
 *   node wpt-subtests.js diff.json /web-animations/interfaces/AnimationEffect/getComputedTiming.html
 *   node wpt-subtests.js diff.json /css/css-color/parsing/color-valid-color-mix-function.html --limit 40
 *   node wpt-subtests.js diff.json /fetch/http-cache/no-vary-search.tentative.any.html --all
 *
 * PASS SEVERAL PATHS AT ONCE. Each invocation streams two ~330MB reports, and they
 * are scanned in a single pass, so N paths in one call costs what one path costs.
 * A shell loop calling this once per path pays that download N times over — three
 * paths that way is ~4GB, and doubling it again by piping the same call into `head`
 * and then re-running it for the rollup.
 *
 * Often you need neither: if the diff was built with `wpt-diff.js --subtests`, the
 * newly-passing/failing names and messages are already in it, and
 * `wpt-inventory.js <diff.json> --include <path>` reads them locally with no
 * network at all. Reach for this script for the full message rollup, for more than
 * the 25 names the diff stores per file, or for unchanged-failure context.
 *
 * Options:
 *   --before <id>  run id for the baseline (default: from diff.json)
 *   --after <id>   run id for the comparison (default: from diff.json)
 *   --limit <n>    max subtests to print per section (default 25; 0 = all)
 *   --all          list every subtest, not just the ones that changed
 *   --messages     show messages for unchanged failures too (default: only changes)
 *
 * Note: this reads the *raw* report.json, not the summary blob. Those reports are
 * large (100MB+), so the fetch is streamed and filtered to the one test path and
 * discarded as it goes. One test file at a time, by design.
 */

const fs = require('fs');
const { netFetch } = require('./lib/net.js');
const { extractResults } = require('./lib/report.js');

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(msg ? 1 : 0);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) usage();

const opts = { before: null, after: null, limit: 25, all: false, messages: false };
const positional = [];
// Unvalidated Number() would turn a typo into a silently truncated report.
const num = (flag, raw) => {
  const n = Number(raw);
  if (raw === undefined) usage(`missing value for ${flag}`);
  if (!Number.isFinite(n)) usage(`${flag} needs a number, got "${raw}"`);
  return n;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--before': opts.before = argv[++i]; break;
    case '--after': opts.after = argv[++i]; break;
    case '--limit': opts.limit = num(a, argv[++i]); break;
    case '--all': opts.all = true; break;
    case '--messages': opts.messages = true; break;
    default:
      if (a.startsWith('--')) usage(`unknown option ${a}`);
      positional.push(a);
  }
}

let diffPath = null;
// Several test paths are accepted and resolved in ONE pass over each report.
const testPaths = [];
for (const p of positional) {
  if (p.startsWith('/')) testPaths.push(p);
  else diffPath = p;
}
if (!testPaths.length) usage('need at least one test path (starts with "/")');

async function getJSON(url) {
  const res = await netFetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

/** Resolve the two run ids, from explicit flags or a diff.json. */
function resolveRunIds() {
  if (opts.before && opts.after) {
    return { before: opts.before, after: opts.after, label: null };
  }
  // Honouring only the pair meant that one of them alone was silently dropped in
  // favour of the diff.json's run ids, comparing runs the user didn't ask for.
  if (opts.before || opts.after) {
    usage(
      `--before and --after must be given together ` +
        `(got only ${opts.before ? '--before' : '--after'})`,
    );
  }
  if (!diffPath) {
    usage('need either a diff.json or both --before and --after run ids');
  }
  const diff = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
  if (!diff.before?.run_id || !diff.after?.run_id) {
    throw new Error(`${diffPath} has no run ids — regenerate it with a current wpt-diff.js`);
  }
  return {
    before: String(diff.before.run_id),
    after: String(diff.after.run_id),
    label: {
      before: `${diff.before.spec} ${diff.before.browser_version}`,
      after: `${diff.after.spec} ${diff.after.browser_version}`,
    },
  };
}

/**
 * Subtests for a set of test paths, from one run's raw report — in a single pass.
 *
 * Taking several paths at once matters: the shape that invites itself is a shell
 * loop calling this script once per path, and each call streams two ~330MB
 * reports. Three paths that way is ~4GB to answer a question about three files.
 */
async function fetchSubtests(runId, wantPaths) {
  const runs = await getJSON(`https://wpt.fyi/api/runs?run_ids=${runId}`);
  if (!runs.length) throw new Error(`no run found for id ${runId}`);
  const run = runs[0];
  const url = run.raw_results_url;
  if (!url) throw new Error(`run ${runId} has no raw_results_url`);
  const { results } = await extractResults(url, new Set(wantPaths), { label: `run ${runId}` });
  return { run, results };
}

/** Index subtests by name for comparison. */
function indexSubtests(result) {
  const map = new Map();
  if (!result) return map;
  for (const s of result.subtests || []) {
    map.set(s.name, { status: s.status, message: s.message || null });
  }
  return map;
}

function truncate(s, n) {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

/**
 * `loud` marks the sections a feature description is actually built from. A
 * partial read of the RIGHT file is harder to notice than not reading it at all:
 * one pass characterised webrtc-stats/supported-stats.https.html from the tail of
 * its 24 newly-passing subtests and missed the 12 RTCTransportStats properties in
 * the middle. Sections that are capped by design (still-failing, passing-in-both)
 * get the quiet note — shouting on all seven only dilutes it.
 */
function section(title, rows, limit, loud = false) {
  if (!rows.length) return;
  console.log(`\n## ${title} (${rows.length})`);
  const shown = limit > 0 ? rows.slice(0, limit) : rows;
  for (const r of shown) console.log(r);
  const hidden = rows.length - shown.length;
  if (!hidden) return;
  if (loud) {
    console.log(`  !! ${hidden} MORE NOT SHOWN — re-run with --limit 0 before describing`);
    console.log(`  !! this file; the hidden ones may change the story.`);
  } else {
    console.log(`  ... and ${hidden} more (--limit 0 for all)`);
  }
}

/** Print the full comparison for one test file. */
function reportOne(testPath, bResult, aResult) {
  console.log(`\n${'='.repeat(74)}`);
  console.log(`# ${testPath}`);
  console.log('='.repeat(74));

  if (!bResult && !aResult) {
    console.log(`\nNot present in either report. Check the path, including any ?query`);
    console.log(`variant, and that .any.js tests are named e.g. foo.any.worker.html.`);
    return;
  }

  const bStatus = bResult?.status ?? '(absent)';
  const aStatus = aResult?.status ?? '(absent)';
  const bMap = indexSubtests(bResult);
  const aMap = indexSubtests(aResult);
  const count = (m) => [...m.values()].filter((v) => v.status === 'PASS').length;

  console.log(`\nharness  : ${bStatus} -> ${aStatus}`);
  console.log(`subtests : ${count(bMap)}/${bMap.size} -> ${count(aMap)}/${aMap.size} passing`);
  if (bResult?.message || aResult?.message) {
    if (bResult?.message) console.log(`baseline harness message: ${truncate(bResult.message, 200)}`);
    if (aResult?.message) console.log(`compare harness message : ${truncate(aResult.message, 200)}`);
  }

  const names = new Set([...bMap.keys(), ...aMap.keys()]);
  const fixed = [], broken = [], added = [], removed = [], changed = [], stillFailing = [], unchanged = [];

  for (const name of names) {
    const b = bMap.get(name);
    const a = aMap.get(name);
    if (!b) {
      added.push(`  ${a.status.padEnd(7)} ${truncate(name, 100)}`
        + (a.status !== 'PASS' && a.message ? `\n      ${truncate(a.message, 160)}` : ''));
      continue;
    }
    if (!a) {
      removed.push(`  ${b.status.padEnd(7)} ${truncate(name, 100)}`);
      continue;
    }
    if (b.status === a.status) {
      if (a.status !== 'PASS') {
        stillFailing.push(`  ${a.status.padEnd(7)} ${truncate(name, 100)}`
          + (opts.messages && a.message ? `\n      ${truncate(a.message, 160)}` : ''));
      } else {
        unchanged.push(`  PASS    ${truncate(name, 100)}`);
      }
      continue;
    }
    // Status changed.
    const line = `  ${b.status} -> ${a.status}  ${truncate(name, 90)}`;
    if (a.status === 'PASS') {
      // The message from the *old* failure is the interesting part: it names the cause.
      fixed.push(line + (b.message ? `\n      was: ${truncate(b.message, 160)}` : ''));
    } else if (b.status === 'PASS') {
      broken.push(line + (a.message ? `\n      now: ${truncate(a.message, 160)}` : ''));
    } else {
      changed.push(line + (a.message ? `\n      now: ${truncate(a.message, 160)}` : ''));
    }
  }

  // The first four are what a feature description gets built from, so a silent
  // truncation there becomes a confidently incomplete finding.
  section('Newly passing', fixed, opts.limit, true);
  section('Newly failing', broken, opts.limit, true);
  section('Failure changed (still failing)', changed, opts.limit, true);
  section('Subtests only in compare (added)', added, opts.limit, true);
  section('Subtests only in baseline (removed)', removed, opts.limit);
  section('Still failing (unchanged)', stillFailing, opts.messages ? opts.limit : Math.min(opts.limit, 10));
  if (opts.all) section('Passing in both', unchanged, opts.limit);

  // The whole point: if many fixes share one assertion message, it is one bug.
  if (fixed.length > 2) {
    const msgs = [];
    for (const name of names) {
      const b = bMap.get(name), a = aMap.get(name);
      if (b && a && a.status === 'PASS' && b.status !== 'PASS' && b.message) msgs.push(b.message);
    }
    const groups = new Map();
    for (const m of msgs) {
      // Normalise away test-specific values to spot a shared root cause, then
      // truncate. Truncating first left a dangling quote that the "…" rule could
      // not match, so one root cause split into several near-identical groups.
      const key = truncate(
        String(m).replace(/"[^"]*"/g, '"…"').replace(/-?\d+(\.\d+)?/g, 'N'),
        60,
      );
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    const top = [...groups.entries()].sort((x, y) => y[1] - x[1]);
    if (top.length && top[0][1] > 1) {
      console.log(`\n## Shared failure messages among the newly-passing`);
      console.log(`If one message accounts for most of the fixes, that is ONE bug fixed`);
      console.log(`unblocking many tests — not many separate fixes. Say so in the notes.`);
      for (const [msg, n] of top.slice(0, 5)) {
        console.log(`  ${String(n).padStart(3)}x  ${msg}`);
      }
    }
  }
}

(async () => {
  const ids = resolveRunIds();
  process.stderr.write(`Fetching raw results for ${testPaths.length} test path(s)\n`);
  process.stderr.write(`  (one pass over each of two large reports; this takes a moment)\n`);

  // Sequential, not Promise.all: a path near the end of a report streams the whole
  // ~330MB, and two of those at once starve each other's socket — behind a proxy
  // that surfaces as a mid-transfer "aborted".
  const before = await fetchSubtests(ids.before, testPaths);
  const after = await fetchSubtests(ids.after, testPaths);

  const bLabel = ids.label?.before
    || `${before.run.browser_name} ${before.run.browser_version}`;
  const aLabel = ids.label?.after
    || `${after.run.browser_name} ${after.run.browser_version}`;

  console.log(`# Subtest diff: ${testPaths.length} test file(s)`);
  console.log(`\nbaseline : ${bLabel}, run ${ids.before}`);
  console.log(`compare  : ${aLabel}, run ${ids.after}`);

  for (const p of testPaths) {
    reportOne(p, before.results.get(p) || null, after.results.get(p) || null);
  }

  // Loud tail: with several paths a single "not present" line scrolls away, and a
  // path silently yielding nothing is how a mistyped ?query variant becomes
  // "no change here".
  const missing = testPaths.filter((p) => !before.results.has(p) && !after.results.has(p));
  if (missing.length) {
    console.log(`\n!! ${missing.length} of ${testPaths.length} path(s) matched NOTHING in either report:`);
    for (const p of missing) console.log(`!!   ${p}`);
  }
})().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
