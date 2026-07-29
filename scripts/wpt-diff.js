#!/usr/bin/env node
/**
 * Dump per-test pass-rate differences between two browser runs on wpt.fyi.
 *
 * API reference: https://github.com/web-platform-tests/wpt.fyi/blob/main/api/README.md
 *
 * Usage:
 *   node wpt-diff.js --from <spec> --to <spec> [--json out.json]
 *
 * A <spec> is "product[@channel]", e.g.
 *   firefox@beta          latest Firefox beta run
 *   firefox@nightly       latest Firefox nightly (alias for experimental)
 *   chrome@stable         latest stable Chrome
 *   safari@experimental   latest Safari Technology Preview
 *   firefox               latest Firefox run on any channel
 *
 * Cross-browser comparison works too: --from chrome@stable --to firefox@nightly
 *
 * Options:
 *   --json [file]   also write the full structured diff as JSON. With no value,
 *                   defaults to tmp/<from>-vs-<to>.diff.json (tmp/ is gitignored).
 *   --min-delta <n> ignore subtest deltas smaller than n subtests (default 1)
 *   --top <n>       how many rows to print per section (default 40)
 *   --aligned       require both runs to be on the same WPT revision, removing
 *                   test-suite churn from the diff (may select older runs)
 *
 * Channel labels understood by wpt.fyi: stable, beta, experimental (== nightly).
 */

const CHANNEL_ALIASES = {
  nightly: 'experimental',
  release: 'stable',
  tp: 'experimental',
};

// Default location for generated artifacts, resolved relative to the repo root
// (this file lives in scripts/). Gitignored.
const TMP_DIR = require('path').join(__dirname, '..', 'tmp');

// How many recent runs to consider when looking for a complete one.
const RUN_CANDIDATES = 5;
// A full WPT run is ~120k test files. Anything far below this is a partial run
// that would otherwise yield a diff claiming every test was removed.
const MIN_TESTS = 10000;

const STATUS_NAMES = {
  O: 'OK',
  P: 'PASS',
  F: 'FAIL',
  S: 'SKIP',
  E: 'ERROR',
  N: 'NOTRUN',
  C: 'CRASH',
  T: 'TIMEOUT',
  PF: 'PRECONDITION_FAILED',
};

// Statuses that mean "the test file itself did not run cleanly".
const HARNESS_ERROR = new Set(['E', 'C', 'T', 'N', 'PF']);

/**
 * Parse "product[@channel]" into {product, channel, label}.
 * Bare channel names are accepted for backwards compatibility and assume firefox.
 */
function parseSpec(spec) {
  if (!spec.includes('@') && CHANNEL_ALIASES[spec.toLowerCase()] !== undefined) {
    // Bare "nightly"/"beta"/"stable" — assume firefox.
    spec = `firefox@${spec}`;
  } else if (!spec.includes('@') && ['stable', 'beta', 'experimental'].includes(spec)) {
    spec = `firefox@${spec}`;
  }
  const [product, rawChannel] = spec.split('@');
  if (!product) throw new Error(`Invalid spec: "${spec}"`);
  const channel = rawChannel
    ? CHANNEL_ALIASES[rawChannel.toLowerCase()] || rawChannel.toLowerCase()
    : null;
  return {
    product,
    channel,
    label: channel ? `${product}@${channel}` : product,
  };
}

function parseArgs(argv) {
  const opts = {
    from: 'firefox@beta',
    to: 'firefox@experimental',
    json: null,
    minDelta: 1,
    top: 40,
    aligned: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--from': opts.from = next(); break;
      case '--to': opts.to = next(); break;
      case '--json':
        // Optional value: bare --json writes to the default tmp/ path.
        if (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.json = argv[++i];
        else opts.json = true;
        break;
      case '--min-delta': opts.minDelta = Number(next()); break;
      case '--top': opts.top = Number(next()); break;
      case '--aligned': opts.aligned = true; break;
      case '-h':
      case '--help':
        console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  opts.fromSpec = parseSpec(opts.from);
  opts.toSpec = parseSpec(opts.to);

  // Generated artifacts belong in tmp/, which is gitignored — a diff.json is
  // ~600KB and changes as new runs land, so it shouldn't be committed.
  if (opts.json === true) {
    const slug = (s) => s.label.replace(/[^a-z0-9]+/gi, '-');
    opts.json = require('path').join(
      TMP_DIR,
      `${slug(opts.fromSpec)}-vs-${slug(opts.toSpec)}.diff.json`,
    );
  }
  return opts;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * /api/runs?product=<product>&label=<channel>&max-count=1
 * Returns the most recent TestRun for that product/channel.
 */
async function latestRun(spec) {
  // Fetch several candidates, not just one: partial/aborted runs do land on
  // wpt.fyi (a real nightly once published only 2 tests), and picking one
  // silently produces a diff where every test looks "removed". Callers verify
  // the summary size and fall back to the next candidate.
  const params = new URLSearchParams({ product: spec.product, 'max-count': String(RUN_CANDIDATES) });
  if (spec.channel) params.set('label', spec.channel);
  const runs = await getJSON(`https://wpt.fyi/api/runs?${params}`);
  if (!runs.length) throw new Error(`No runs found for "${spec.label}"`);
  return runs;
}

/**
 * Take the most recent run whose summary looks complete.
 *
 * "Complete" is relative: WPT has ~120k test files, but rather than hardcode a
 * threshold we reject runs that are a tiny fraction of the most complete
 * candidate, which tolerates suite growth and per-product differences.
 */
async function firstUsableRun(spec, runs) {
  const errors = [];
  for (const [i, run] of runs.entries()) {
    let summary;
    try {
      summary = await fetchSummary(run);
    } catch (err) {
      errors.push(`run ${run.id}: ${err.message}`);
      continue;
    }
    if (summary.size >= MIN_TESTS) {
      if (i > 0) {
        process.stderr.write(
          `note: skipped ${i} incomplete ${spec.label} run(s); using run ${run.id} ` +
            `(${summary.size} tests)\n`,
        );
      }
      return { run, summary };
    }
    errors.push(`run ${run.id} (${run.time_start}): only ${summary.size} tests — partial run`);
  }
  throw new Error(
    `No complete ${spec.label} run found in the last ${runs.length} runs ` +
      `(expected >= ${MIN_TESTS} test files):\n  ${errors.join('\n  ')}`,
  );
}

/**
 * Find runs of both specs on the same WPT revision, so the diff reflects browser
 * differences rather than test-suite churn.
 *
 * Note on the API: /api/runs rejects "product=firefox@beta" (400 invalid product
 * spec) — channels are selected via `label`, and a single `label` applies to every
 * requested product. So aligned=true cannot express "firefox beta vs firefox
 * nightly". Instead we list recent revisions per spec via /api/shas and intersect
 * them, which works for any combination.
 */
async function alignedRuns(fromSpec, toSpec, maxCount = 100) {
  const shaList = async (spec) => {
    const params = new URLSearchParams({ product: spec.product, 'max-count': String(maxCount) });
    if (spec.channel) params.set('label', spec.channel);
    return getJSON(`https://wpt.fyi/api/shas?${params}`);
  };

  const [fromShas, toShas] = await Promise.all([shaList(fromSpec), shaList(toSpec)]);
  const toSet = new Set(toShas);
  // fromShas is reverse-chronological, so the first match is the most recent.
  const shared = fromShas.find((s) => toSet.has(s));

  if (!shared) {
    throw new Error(
      `No shared WPT revision found between "${fromSpec.label}" and "${toSpec.label}" ` +
        `in the last ${maxCount} runs of each.\n` +
        `Release channels are often tested at different revisions, so an aligned ` +
        `comparison may not exist. Re-run without --aligned and treat small ` +
        `single-subtest deltas as possible test-suite churn.`,
    );
  }

  const runFor = async (spec) => {
    const params = new URLSearchParams({ product: spec.product, sha: shared });
    if (spec.channel) params.set('label', spec.channel);
    const runs = await getJSON(`https://wpt.fyi/api/runs?${params}`);
    if (!runs.length) throw new Error(`No ${spec.label} run at revision ${shared}`);
    return runs[0];
  };

  process.stderr.write(`Aligned on WPT revision ${shared}\n`);
  return Promise.all([runFor(fromSpec), runFor(toSpec)]);
}

/**
 * Fetch and decompress a summary_v2 blob.
 * Shape: { "/path/to/test.html": { s: "O", c: [subtest_passes, subtest_total] } }
 * fetch() transparently handles the gzip Content-Encoding from GCS.
 */
async function fetchSummary(run) {
  const res = await fetch(run.results_url);
  if (!res.ok) {
    throw new Error(`GET ${run.results_url} -> ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  let text;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    // Still gzipped (server didn't set Content-Encoding) — inflate manually.
    text = require('zlib').gunzipSync(buf).toString('utf8');
  } else {
    text = buf.toString('utf8');
  }
  const raw = JSON.parse(text);
  const out = new Map();
  for (const [test, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      // legacy v1 summary: [passes, total], no harness status available
      out.set(test, { status: null, pass: v[0], total: v[1] });
    } else {
      out.set(test, { status: v.s, pass: v.c[0], total: v.c[1] });
    }
  }
  return out;
}

/** Top-level WPT directory, used to aggregate per-feature-area. */
function areaOf(test) {
  const parts = test.replace(/^\//, '').split('/');
  // css/ and _mozilla/ etc. are broad; go two levels deep for those.
  if ((parts[0] === 'css' || parts[0] === '_mozilla') && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function classify(before, after) {
  if (!before) return 'added';
  if (!after) return 'removed';

  const deltaPass = after.pass - before.pass;
  const deltaTotal = after.total - before.total;

  const beforeBroken = before.status && HARNESS_ERROR.has(before.status);
  const afterBroken = after.status && HARNESS_ERROR.has(after.status);

  if (!beforeBroken && afterBroken) return 'newly-broken';
  if (beforeBroken && !afterBroken) return 'newly-running';

  if (deltaPass > 0) return 'improved';
  if (deltaPass < 0) return 'regressed';
  if (deltaTotal !== 0) return 'subtests-changed';
  if (before.status !== after.status) return 'status-changed';
  return 'unchanged';
}

function summarise(summary) {
  let pass = 0;
  let total = 0;
  for (const r of summary.values()) {
    pass += r.pass;
    total += r.total;
  }
  return { tests: summary.size, pass, total, rate: total ? pass / total : 0 };
}

function pct(n) {
  return `${(n * 100).toFixed(3)}%`;
}

function signed(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  process.stderr.write(
    `Fetching runs (${opts.fromSpec.label} -> ${opts.toSpec.label})${opts.aligned ? ' [aligned]' : ''}...\n`,
  );

  let beforeRun;
  let afterRun;
  let beforeSummary;
  let afterSummary;

  if (opts.aligned) {
    // An aligned comparison is pinned to one revision, so there is no
    // alternative run to fall back to — validate and report instead.
    [beforeRun, afterRun] = await alignedRuns(opts.fromSpec, opts.toSpec);
    process.stderr.write(`Downloading summaries...\n`);
    [beforeSummary, afterSummary] = await Promise.all([
      fetchSummary(beforeRun),
      fetchSummary(afterRun),
    ]);
    for (const [spec, run, summary] of [
      [opts.fromSpec, beforeRun, beforeSummary],
      [opts.toSpec, afterRun, afterSummary],
    ]) {
      if (summary.size < MIN_TESTS) {
        throw new Error(
          `The aligned ${spec.label} run ${run.id} at revision ${run.revision} is ` +
            `partial (${summary.size} test files, expected >= ${MIN_TESTS}). ` +
            `Re-run without --aligned to pick a complete run.`,
        );
      }
    }
  } else {
    const [beforeCandidates, afterCandidates] = await Promise.all([
      latestRun(opts.fromSpec),
      latestRun(opts.toSpec),
    ]);
    process.stderr.write(`Downloading summaries...\n`);
    const [before, after] = await Promise.all([
      firstUsableRun(opts.fromSpec, beforeCandidates),
      firstUsableRun(opts.toSpec, afterCandidates),
    ]);
    ({ run: beforeRun, summary: beforeSummary } = before);
    ({ run: afterRun, summary: afterSummary } = after);
  }

  const allTests = new Set([...beforeSummary.keys(), ...afterSummary.keys()]);
  const rows = [];
  const buckets = {};
  const areas = new Map();

  for (const test of allTests) {
    const before = beforeSummary.get(test) || null;
    const after = afterSummary.get(test) || null;
    const kind = classify(before, after);
    buckets[kind] = (buckets[kind] || 0) + 1;

    const beforePass = before ? before.pass : 0;
    const beforeTotal = before ? before.total : 0;
    const afterPass = after ? after.pass : 0;
    const afterTotal = after ? after.total : 0;
    const deltaPass = afterPass - beforePass;

    // Per-test pass rate delta (guard against 0-subtest tests).
    const beforeRate = beforeTotal ? beforePass / beforeTotal : null;
    const afterRate = afterTotal ? afterPass / afterTotal : null;

    const area = areaOf(test);
    if (!areas.has(area)) {
      areas.set(area, { area, beforePass: 0, beforeTotal: 0, afterPass: 0, afterTotal: 0, changed: 0 });
    }
    const a = areas.get(area);
    a.beforePass += beforePass;
    a.beforeTotal += beforeTotal;
    a.afterPass += afterPass;
    a.afterTotal += afterTotal;

    if (kind === 'unchanged') continue;
    a.changed++;

    rows.push({
      test,
      area,
      kind,
      before: before && { status: before.status, pass: beforePass, total: beforeTotal },
      after: after && { status: after.status, pass: afterPass, total: afterTotal },
      deltaPass,
      deltaTotal: afterTotal - beforeTotal,
      beforeRate,
      afterRate,
      deltaRate: beforeRate !== null && afterRate !== null ? afterRate - beforeRate : null,
    });
  }

  const beforeStats = summarise(beforeSummary);
  const afterStats = summarise(afterSummary);

  const report = {
    generated: new Date().toISOString(),
    aligned: opts.aligned,
    before: {
      spec: opts.fromSpec.label,
      product: beforeRun.browser_name,
      channel: opts.fromSpec.channel,
      run_id: beforeRun.id,
      browser_version: beforeRun.browser_version,
      os: `${beforeRun.os_name} ${beforeRun.os_version}`,
      wpt_revision: beforeRun.revision,
      time_start: beforeRun.time_start,
      results_url: beforeRun.results_url,
      stats: beforeStats,
    },
    after: {
      spec: opts.toSpec.label,
      product: afterRun.browser_name,
      channel: opts.toSpec.channel,
      run_id: afterRun.id,
      browser_version: afterRun.browser_version,
      os: `${afterRun.os_name} ${afterRun.os_version}`,
      wpt_revision: afterRun.revision,
      time_start: afterRun.time_start,
      results_url: afterRun.results_url,
      stats: afterStats,
    },
    buckets,
    areas: [...areas.values()]
      .map((a) => ({
        ...a,
        beforeRate: a.beforeTotal ? a.beforePass / a.beforeTotal : null,
        afterRate: a.afterTotal ? a.afterPass / a.afterTotal : null,
        deltaPass: a.afterPass - a.beforePass,
        deltaRate:
          a.beforeTotal && a.afterTotal
            ? a.afterPass / a.afterTotal - a.beforePass / a.beforeTotal
            : null,
      }))
      .sort((x, y) => Math.abs(y.deltaPass) - Math.abs(x.deltaPass)),
    tests: rows.sort((x, y) => Math.abs(y.deltaPass) - Math.abs(x.deltaPass) || x.test.localeCompare(y.test)),
  };

  // ---- human-readable dump ----
  const L = console.log;
  L(`# WPT pass-rate diff: ${opts.fromSpec.label} -> ${opts.toSpec.label}`);
  L('');
  L(`baseline : ${report.before.product} ${report.before.browser_version} (${opts.fromSpec.label}), ${report.before.os}, wpt @ ${report.before.wpt_revision}, run ${report.before.run_id}, ${report.before.time_start}`);
  L(`compare  : ${report.after.product} ${report.after.browser_version} (${opts.toSpec.label}), ${report.after.os}, wpt @ ${report.after.wpt_revision}, run ${report.after.run_id}, ${report.after.time_start}`);
  if (report.before.wpt_revision !== report.after.wpt_revision) {
    L(`NOTE     : runs are on different WPT revisions — some diffs are test-suite churn, not browser changes.`);
    L(`           Re-run with --aligned for a churn-free comparison.`);
  }
  if (report.before.os !== report.after.os) {
    L(`NOTE     : runs are on different platforms — some diffs are platform differences.`);
  }
  L('');
  L('## Overall');
  L(`tests      : ${beforeStats.tests} -> ${afterStats.tests} (${signed(afterStats.tests - beforeStats.tests)})`);
  L(`subtests   : ${beforeStats.total} -> ${afterStats.total} (${signed(afterStats.total - beforeStats.total)})`);
  L(`passing    : ${beforeStats.pass} -> ${afterStats.pass} (${signed(afterStats.pass - beforeStats.pass)})`);
  L(`pass rate  : ${pct(beforeStats.rate)} -> ${pct(afterStats.rate)} (${signed(+( (afterStats.rate - beforeStats.rate) * 100).toFixed(3))} pp)`);
  L('');
  L('## Change breakdown (by test file)');
  for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    L(`${k.padEnd(18)} ${v}`);
  }
  L('');

  const sections = [
    ['Regressions (fewer subtests passing)', (r) => r.kind === 'regressed' && -r.deltaPass >= opts.minDelta, (a, b) => a.deltaPass - b.deltaPass],
    ['Improvements (more subtests passing)', (r) => r.kind === 'improved' && r.deltaPass >= opts.minDelta, (a, b) => b.deltaPass - a.deltaPass],
    ['Newly broken (harness error/crash/timeout)', (r) => r.kind === 'newly-broken', null],
    ['Newly running (was error/crash/timeout)', (r) => r.kind === 'newly-running', null],
    ['Tests only in ' + opts.toSpec.label, (r) => r.kind === 'added', (a, b) => b.after.total - a.after.total],
    ['Tests only in ' + opts.fromSpec.label, (r) => r.kind === 'removed', (a, b) => b.before.total - a.before.total],
  ];

  for (const [title, filter, sort] of sections) {
    const list = report.tests.filter(filter);
    if (!list.length) continue;
    if (sort) list.sort(sort);
    L(`## ${title} (${list.length})`);
    for (const r of list.slice(0, opts.top)) {
      const b = r.before ? `${STATUS_NAMES[r.before.status] || r.before.status || '?'} ${r.before.pass}/${r.before.total}` : '-';
      const a = r.after ? `${STATUS_NAMES[r.after.status] || r.after.status || '?'} ${r.after.pass}/${r.after.total}` : '-';
      L(`  ${signed(r.deltaPass).padStart(6)}  ${b.padEnd(22)} -> ${a.padEnd(22)} ${r.test}`);
    }
    if (list.length > opts.top) L(`  ... and ${list.length - opts.top} more`);
    L('');
  }

  L('## Biggest movers by area');
  for (const a of report.areas.filter((x) => x.deltaPass !== 0).slice(0, 30)) {
    const rate =
      a.deltaRate === null ? '' : ` (${pct(a.beforeRate)} -> ${pct(a.afterRate)})`;
    L(`  ${signed(a.deltaPass).padStart(7)} subtests  ${a.area}${rate}`);
  }
  L('');

  if (opts.json) {
    const fs = require('fs');
    fs.mkdirSync(require('path').dirname(opts.json), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify(report, null, 2));
    process.stderr.write(`Wrote ${opts.json}\n`);
  }
}

main().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
