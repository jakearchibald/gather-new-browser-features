#!/usr/bin/env node
/**
 * Collect everything a release-notes pass needs, in one command.
 *
 * This is the ONLY script that touches the network. It resolves both runs,
 * downloads both summaries, streams both raw reports once, and fetches the source
 * of every changed test — then writes an artifact directory that every later step
 * reads locally. Analysis after this point is instant and offline.
 *
 * Usage:
 *   node wpt-collect.js --from <spec> --to <spec> [options]
 *
 *   node wpt-collect.js --from firefox@beta --to firefox@nightly
 *   node wpt-collect.js --from firefox@stable@152 --to firefox@stable@153
 *   node wpt-collect.js --from chrome@stable --to firefox@nightly
 *
 * A <spec> is "product[@channel][@version]", e.g.
 *   firefox@beta          latest Firefox beta run
 *   firefox@nightly       latest Firefox nightly (alias for experimental)
 *   chrome@stable         latest stable Chrome
 *   safari@experimental   latest Safari Technology Preview
 *   firefox@stable@152    newest complete Firefox 152.x stable run
 *
 * A numeric segment is a browser version. Use this for release notes between
 * shipped versions: once 153 is stable, "stable" no longer resolves to 152, so the
 * baseline has to be pinned. Keep the channel too — nightly runs outnumber stable
 * ones by ~50:1, so an unlabelled version search will not reach back far enough.
 *
 * Options:
 *   --out <dir>     where to write (default tmp/<from>-vs-<to>/)
 *   --aligned       require both runs to be on the same WPT revision, removing
 *                   test-suite churn from the diff. May select older runs, and
 *                   fails when no shared revision exists — common between release
 *                   channels. Incompatible with a version pin.
 *   --top <n>       rows per ranked section in report.txt (default 40). Does not
 *                   apply to the "Directory clusters" section, which always prints
 *                   in full, nor to anything in diff.json.
 *   --cluster-min <n>    min moved files for a directory to count as a cluster
 *                        (default 4, min 1). Lower it to sweep for smaller features.
 *   --cluster-ratio <r>  how one-sided a cluster must be, 0-1 (default 0.8).
 *   --no-sources    skip prefetching test source. Saves a few minutes, at the cost
 *                   of putting the network back in the middle of step 4.
 *   --force         overwrite an existing artifact directory, including any ticked
 *                   verdicts in its checklist.md.
 *
 * What it writes
 * --------------
 *   diff.json      every changed test file, with COMPLETE subtest evidence — every
 *                  name, status and assertion message that changed state. Nothing
 *                  is capped, which is what keeps wpt-subtests.js offline.
 *   report.txt     the ranked view, plus the two sections ranking would hide:
 *                  directory clusters and shared subtest vocabulary.
 *   checklist.md   the coverage worksheet. Tick it in place; wpt-inventory.js
 *                  --verify fails while any box is open or carries no real verdict.
 *   boxes.json     the box list as generated, before anyone edits the worksheet.
 *                  checklist.md is the one file here that is meant to be modified,
 *                  and a whole-file rewrite can drop a line without changing the
 *                  count — which is exactly what happened on one pass, four lines
 *                  gone with the tally still reading 416. --verify compares the
 *                  worksheet against this by path, so a lost box is an exit code
 *                  rather than a silent pass.
 *   state.json.gz  both full summaries, all ~120k tests. A diff only shows what
 *                  moved, so this is what answers "does a test even exist?".
 *   sources/       each changed test's source at the revision its run was tested
 *                  at — not master, which is whatever the test says today.
 *
 * Costs, once: two ~20MB summaries, two ~330MB raw reports, and one small GitHub
 * fetch per changed file. Everything downstream is a local read.
 */

const fs = require('fs');
const path = require('path');

// Node's built-in fetch ignores HTTP_PROXY/HTTPS_PROXY, so a proxy-only network
// looks like broken DNS. See scripts/lib/net.js.
const { netFetch } = require('./lib/net.js');
const { extractResults } = require('./lib/report.js');
const { fetchSummary, writeState } = require('./lib/summary.js');
const { subtestDelta, findClusters, findVocabulary } = require('./lib/analyse.js');
const { renderReport, renderChecklist, boxPaths } = require('./lib/render.js');
const { prefetchSources } = require('./lib/sources.js');
const artifact = require('./lib/artifact.js');
const { usage, num, unknownOption } = require('./lib/cli.js');
const { classify, statusDirection, areaOf, revisionResolver } = require('./lib/wpt.js');

const fail = (msg) => usage(__filename, msg);

const CHANNEL_ALIASES = { nightly: 'experimental', release: 'stable', tp: 'experimental' };
const CHANNELS = new Set(['stable', 'beta', 'experimental']);

// How many recent runs to consider when looking for a complete one.
const RUN_CANDIDATES = 5;
// A version-pinned spec has to look further back, since a shipped version may be
// weeks of runs behind the newest.
const VERSION_RUN_CANDIDATES = 200;
// Separate from the search window above: widening the search is one cheap
// /api/runs call, but every probe is a ~20MB summary download.
const MAX_SUMMARY_PROBES = 5;
// A full WPT run is ~120k test files. Anything far below this is a partial run
// that would otherwise yield a diff claiming every test was removed.
const MIN_TESTS = 10000;

/** Parse "product[@channel][@version]" into {product, channel, version, label}. */
function parseSpec(spec) {
  const lower = spec.toLowerCase();
  if (!lower.includes('@') && (CHANNEL_ALIASES[lower] || CHANNELS.has(lower))) {
    // Bare "nightly"/"beta"/"stable" — assume firefox.
    spec = `firefox@${lower}`;
  }
  const parts = spec.split('@');
  const product = parts[0];
  if (!product || parts.length > 3) {
    throw new Error(`Invalid spec: "${spec}" (expected "product[@channel][@version]")`);
  }
  for (const p of parts.slice(1)) {
    if (!p) {
      throw new Error(
        `Invalid spec: "${spec}" — empty segment after "@". Drop the "@" to accept any channel.`,
      );
    }
  }

  const rest = parts.slice(1);
  const version = rest.find((p) => /^\d/.test(p)) || null;
  const rawChannel = rest.find((p) => !/^\d/.test(p)) || null;
  const channel = rawChannel
    ? CHANNEL_ALIASES[rawChannel.toLowerCase()] || rawChannel.toLowerCase()
    : null;

  let label = product;
  if (channel) label += `@${channel}`;
  if (version) label += ` ${version}`;
  return { product, channel, version, label };
}

function parseArgs(argv) {
  const opts = {
    from: 'firefox@beta',
    to: 'firefox@experimental',
    out: null,
    top: 40,
    clusterMin: 4,
    clusterRatio: 0.8,
    aligned: false,
    sources: true,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--from': opts.from = next(); break;
      case '--to': opts.to = next(); break;
      case '--out': opts.out = next(); break;
      case '--top': opts.top = num(fail, arg, argv[++i]); break;
      case '--cluster-min':
        opts.clusterMin = num(fail, arg, argv[++i]);
        // 0 would disable both cluster filters and print every ancestor directory
        // of every changed file, in a section that never truncates.
        if (opts.clusterMin < 1) fail('--cluster-min must be at least 1');
        break;
      case '--cluster-ratio':
        opts.clusterRatio = num(fail, arg, argv[++i]);
        if (opts.clusterRatio <= 0 || opts.clusterRatio > 1) {
          fail('--cluster-ratio must be greater than 0 and at most 1');
        }
        break;
      case '--aligned': opts.aligned = true; break;
      case '--no-sources': opts.sources = false; break;
      case '--force': opts.force = true; break;
      case '-h': case '--help': usage(__filename); break;
      default: fail(unknownOption(__filename, arg));
    }
  }
  opts.fromSpec = parseSpec(opts.from);
  opts.toSpec = parseSpec(opts.to);
  opts.out = opts.out || artifact.defaultDir(opts.fromSpec.label, opts.toSpec.label);
  return opts;
}

async function getJSON(url) {
  const res = await netFetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Recent runs for a spec, newest first.
 *
 * Fetch several candidates, not just one: partial/aborted runs do land on wpt.fyi
 * (a real nightly once published only 2 tests), and picking one silently produces
 * a diff where every test looks "removed".
 */
async function latestRuns(spec) {
  const wanted = spec.version ? VERSION_RUN_CANDIDATES : RUN_CANDIDATES;
  const params = new URLSearchParams({ product: spec.product, 'max-count': String(wanted) });
  if (spec.channel) params.set('label', spec.channel);
  let runs = await getJSON(`https://wpt.fyi/api/runs?${params}`);
  if (spec.version) {
    // Prefix match on a dot boundary so "152" means the 152 series (152.0.6), not
    // 1520, while "152.0.6" stays exact.
    const v = spec.version;
    runs = runs.filter((r) => {
      const bv = r.browser_version || '';
      return bv === v || bv.startsWith(`${v}.`);
    });
  }
  if (!runs.length) {
    if (spec.version && !spec.channel) {
      // The commonest way a version pin fails.
      throw new Error(
        `No runs found for "${spec.label}" in the last ${wanted} ${spec.product} runs.\n` +
          `Add the channel the version shipped on — "${spec.product}@stable@${spec.version}" ` +
          `rather than "${spec.product}@${spec.version}". Without a channel the search is ` +
          `dominated by nightlies and does not reach back far enough.`,
      );
    }
    throw new Error(`No runs found for "${spec.label}"`);
  }
  return runs;
}

/**
 * The most recent run whose summary looks complete. Candidates are tried
 * newest-first and downloaded lazily, so a complete latest run costs one fetch.
 */
async function firstUsableRun(spec, runs) {
  const errors = [];
  let probes = 0;
  for (const [i, run] of runs.entries()) {
    if (probes >= MAX_SUMMARY_PROBES) {
      errors.push(`stopped after ${probes} summary download(s); ${runs.length - i} candidate(s) untried`);
      break;
    }
    probes++;
    let summary;
    try {
      summary = await fetchSummary(run.results_url);
    } catch (err) {
      errors.push(`run ${run.id}: ${err.message}`);
      continue;
    }
    if (summary.size >= MIN_TESTS) {
      if (i > 0) {
        process.stderr.write(
          `note: skipped ${i} incomplete ${spec.label} run(s); using run ${run.id} (${summary.size} tests)\n`,
        );
      }
      return { run, summary };
    }
    errors.push(`run ${run.id} (${run.time_start}): only ${summary.size} tests — partial run`);
  }
  throw new Error(
    `No complete ${spec.label} run found among ${runs.length} candidate run(s) ` +
      `(expected >= ${MIN_TESTS} test files):\n  ${errors.join('\n  ')}`,
  );
}

/**
 * Runs of both specs on the same WPT revision, so the diff reflects browser
 * differences rather than test-suite churn.
 *
 * Note on the API: /api/runs rejects "product=firefox@beta" (400 invalid product
 * spec) — channels are selected via `label`, and a single `label` applies to every
 * requested product. So aligned=true cannot express "firefox beta vs firefox
 * nightly". Instead list recent revisions per spec via /api/shas and intersect.
 */
async function alignedRuns(fromSpec, toSpec, maxCount = 100) {
  for (const spec of [fromSpec, toSpec]) {
    if (spec.version) {
      throw new Error(
        `--aligned cannot be used with the version-pinned spec "${spec.label}": distinct ` +
          `browser versions are tested at distinct WPT revisions. Re-run without --aligned ` +
          `and treat small single-subtest deltas as possible test-suite churn.`,
      );
    }
  }
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
      `No shared WPT revision found between "${fromSpec.label}" and "${toSpec.label}" in the ` +
        `last ${maxCount} runs of each.\nRelease channels are often tested at different ` +
        `revisions, so an aligned comparison may not exist. Re-run without --aligned and ` +
        `treat small single-subtest deltas as possible test-suite churn.`,
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
 * Per-test subtest maps from one run's raw report.
 *
 * A test path frequently cannot name the feature that shipped:
 * `SVGAnimatedEnumeration-SVGTextPathElement.html` going 2/3 -> 3/3 was the `side`
 * property landing, and `getAnimations.html` going 29/34 -> 33/34 was
 * `{ pseudoElement }` — whose subtest is literally named "Returns animations on
 * pseudo-element when it is specified". Both were missed. Subtest names are the
 * feature vocabulary, so load them for every changed file, up front.
 */
async function fetchSubtestMaps(run, wanted) {
  const url = run.raw_results_url;
  if (!url) throw new Error(`run ${run.id} has no raw_results_url`);
  const { results, malformed } = await extractResults(url, wanted, { label: `run ${run.id}` });
  if (malformed) {
    process.stderr.write(`note: ${malformed} unparseable result object(s) in ${run.id}\n`);
  }
  const out = new Map();
  for (const [test, obj] of results) {
    const map = new Map();
    for (const s of obj.subtests || []) {
      map.set(s.name, { status: s.status, message: s.message || null });
    }
    out.set(test, { status: obj.status, message: obj.message || null, subtests: map });
  }
  return out;
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

/** Write-then-rename, so a reader never sees a half-written artifact. */
function writeAtomic(file, contents) {
  const staging = `${file}.partial-${process.pid}`;
  try {
    fs.writeFileSync(staging, contents);
    fs.renameSync(staging, file);
  } catch (err) {
    try { fs.unlinkSync(staging); } catch { /* nothing to clean up */ }
    throw err;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // A checklist with ticks in it is the only thing here that cannot be regenerated,
  // so refuse to clobber a directory rather than silently discarding verdicts.
  if (fs.existsSync(path.join(opts.out, 'diff.json')) && !opts.force) {
    const ticked = fs.existsSync(path.join(opts.out, 'checklist.md'))
      ? fs.readFileSync(path.join(opts.out, 'checklist.md'), 'utf8').split('\n')
          .filter((l) => /^(\[x\]|\(x\))/i.test(l)).length
      : 0;
    throw new Error(
      `${opts.out} already holds a collected comparison` +
        (ticked ? ` with ${ticked} ticked checklist line(s)` : '') +
        `.\nPass --force to overwrite it, --out <dir> to collect elsewhere, or just use it ` +
        `as it is:\n  node scripts/wpt-inventory.js ${opts.out} --dirs`,
    );
  }

  process.stderr.write(
    `Resolving runs (${opts.fromSpec.label} -> ${opts.toSpec.label})${opts.aligned ? ' [aligned]' : ''}...\n`,
  );

  let beforeRun, afterRun, beforeSummary, afterSummary;

  if (opts.aligned) {
    // An aligned comparison is pinned to one revision, so there is no alternative
    // run to fall back to — validate and report instead.
    [beforeRun, afterRun] = await alignedRuns(opts.fromSpec, opts.toSpec);
    process.stderr.write('Downloading summaries...\n');
    [beforeSummary, afterSummary] = await Promise.all([
      fetchSummary(beforeRun.results_url),
      fetchSummary(afterRun.results_url),
    ]);
    for (const [spec, run, summary] of [
      [opts.fromSpec, beforeRun, beforeSummary],
      [opts.toSpec, afterRun, afterSummary],
    ]) {
      if (summary.size < MIN_TESTS) {
        throw new Error(
          `The aligned ${spec.label} run ${run.id} at revision ${run.revision} is partial ` +
            `(${summary.size} test files, expected >= ${MIN_TESTS}). Re-run without --aligned.`,
        );
      }
    }
  } else {
    const [beforeCandidates, afterCandidates] = await Promise.all([
      latestRuns(opts.fromSpec),
      latestRuns(opts.toSpec),
    ]);
    process.stderr.write('Downloading summaries...\n');
    const [b, a] = await Promise.all([
      firstUsableRun(opts.fromSpec, beforeCandidates),
      firstUsableRun(opts.toSpec, afterCandidates),
    ]);
    ({ run: beforeRun, summary: beforeSummary } = b);
    ({ run: afterRun, summary: afterSummary } = a);
  }

  // ---- classify every test ----
  const rows = [];
  const buckets = {};
  const areas = new Map();

  for (const test of new Set([...beforeSummary.keys(), ...afterSummary.keys()])) {
    const before = beforeSummary.get(test) || null;
    const after = afterSummary.get(test) || null;
    const kind = classify(before, after);
    buckets[kind] = (buckets[kind] || 0) + 1;

    const beforePass = before ? before.pass : 0;
    const beforeTotal = before ? before.total : 0;
    const afterPass = after ? after.pass : 0;
    const afterTotal = after ? after.total : 0;

    const area = areaOf(test);
    if (!areas.has(area)) {
      areas.set(area, {
        area, beforePass: 0, beforeTotal: 0, afterPass: 0, afterTotal: 0,
        changed: 0, statusFixed: 0, statusBroken: 0,
      });
    }
    const a = areas.get(area);
    a.beforePass += beforePass;
    a.beforeTotal += beforeTotal;
    a.afterPass += afterPass;
    a.afterTotal += afterTotal;

    if (kind === 'unchanged') continue;
    a.changed++;

    // Only meaningful for a bare status flip; for improved/regressed rows the
    // subtest delta already carries the direction.
    const direction = kind === 'status-changed' ? statusDirection(before, after) : null;
    if (direction === 'fixed') a.statusFixed++;
    else if (direction === 'broken') a.statusBroken++;

    const beforeRate = beforeTotal ? beforePass / beforeTotal : null;
    const afterRate = afterTotal ? afterPass / afterTotal : null;

    rows.push({
      test,
      area,
      kind,
      statusDirection: direction,
      before: before && { status: before.status, pass: beforePass, total: beforeTotal, message: null },
      after: after && { status: after.status, pass: afterPass, total: afterTotal, message: null },
      deltaPass: afterPass - beforePass,
      deltaTotal: afterTotal - beforeTotal,
      beforeRate,
      afterRate,
      deltaRate: beforeRate !== null && afterRate !== null ? afterRate - beforeRate : null,
    });
  }

  // ---- complete subtest evidence for every changed file ----
  const wanted = new Set(rows.map((r) => r.test));
  process.stderr.write(
    `Streaming raw reports for subtest evidence (${wanted.size} changed files; ~330MB each)...\n`,
  );
  // Sequential, not Promise.all. Each report is ~330MB and the scan between chunks
  // is synchronous, so two at once starve each other's socket — behind a proxy that
  // shows up as a mid-transfer "aborted". Sequential also halves peak memory.
  const beforeSubtests = await fetchSubtestMaps(beforeRun, wanted);
  const afterSubtests = await fetchSubtestMaps(afterRun, wanted);

  let withNames = 0;
  let found = 0;
  for (const r of rows) {
    const b = beforeSubtests.get(r.test) || null;
    const a = afterSubtests.get(r.test) || null;
    if (!b && !a) continue;
    found++;
    if (b && r.before) r.before.message = b.message;
    if (a && r.after) r.after.message = a.message;
    r.subtests = subtestDelta(b, a);
    if (r.subtests.counts.newlyPassing || r.subtests.counts.newlyFailing) withNames++;
  }
  // A silent extraction failure would hand back a diff that looks complete and has
  // quietly lost the evidence, so say what was and wasn't found.
  process.stderr.write(
    `Subtest evidence: ${found}/${rows.length} changed files located, ${withNames} with a state change.\n`,
  );
  if (found < rows.length) {
    process.stderr.write(
      `note: ${rows.length - found} changed file(s) had no raw result — reftests and skipped ` +
        `tests legitimately have none.\n`,
    );
  }

  const report = {
    generated: new Date().toISOString(),
    aligned: opts.aligned,
    clusterMin: opts.clusterMin,
    clusterRatio: opts.clusterRatio,
    subtestCoverage: { changed: rows.length, found, withNames },
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
      stats: summarise(beforeSummary),
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
      stats: summarise(afterSummary),
    },
    buckets,
    areas: [...areas.values()]
      .map((a) => ({
        ...a,
        beforeRate: a.beforeTotal ? a.beforePass / a.beforeTotal : null,
        afterRate: a.afterTotal ? a.afterPass / a.afterTotal : null,
        deltaPass: a.afterPass - a.beforePass,
        deltaRate: a.beforeTotal && a.afterTotal
          ? a.afterPass / a.afterTotal - a.beforePass / a.beforeTotal
          : null,
      }))
      // Status flips are the tiebreak, so a reftest-only area (all deltas 0) still
      // sorts above areas that genuinely didn't move.
      .sort((x, y) =>
        Math.abs(y.deltaPass) - Math.abs(x.deltaPass) ||
        y.statusFixed + y.statusBroken - (x.statusFixed + x.statusBroken)),
    clusters: findClusters(rows, opts.clusterMin, opts.clusterRatio),
    vocabulary: findVocabulary(rows),
    tests: rows.sort(
      (x, y) => Math.abs(y.deltaPass) - Math.abs(x.deltaPass) || x.test.localeCompare(y.test),
    ),
  };

  // ---- write the artifact ----
  fs.mkdirSync(opts.out, { recursive: true });
  const changed = report.tests.filter((r) => r.kind !== 'unchanged');

  writeAtomic(path.join(opts.out, 'diff.json'), JSON.stringify(report, null, 2));
  writeAtomic(path.join(opts.out, 'report.txt'), `${renderReport(report, { top: opts.top }).join('\n')}\n`);
  const checklistText = `${renderChecklist(report, changed).join('\n')}\n`;
  writeAtomic(path.join(opts.out, 'checklist.md'), checklistText);
  // The box list as generated. checklist.md is edited in place by whoever resolves
  // it, and a whole-file rewrite can drop a line without changing the count — so the
  // set of boxes that ought to be there is recorded separately, before anyone
  // touches it, and --verify compares against it by path.
  writeAtomic(path.join(opts.out, 'boxes.json'), `${JSON.stringify(boxPaths(checklistText), null, 1)}\n`);

  process.stderr.write('Writing full-summary state (both runs, all tests)...\n');
  const stateCount = writeState(path.join(opts.out, 'state.json.gz'), beforeSummary, afterSummary);

  let sourceStats = null;
  if (opts.sources) {
    const revisionFor = revisionResolver(report);
    process.stderr.write(`Fetching test source for ${changed.length} changed files...\n`);
    sourceStats = await prefetchSources(
      path.join(opts.out, 'sources'),
      changed.map((r) => r.test),
      (t) => revisionFor(t) || 'master',
      {
        onProgress: (done, total) => process.stderr.write(`  ${done}/${total}\r`),
      },
    );
    process.stderr.write(
      `  sources: ${sourceStats.fetched} fetched, ${sourceStats.cached} already present, ` +
        `${sourceStats.failed} unavailable (generated variants and renames)\n`,
    );
  }

  // ---- what to do next ----
  const rel = path.relative(process.cwd(), opts.out) || opts.out;
  console.log(`Collected ${changed.length} changed test files into ${rel}/`);
  console.log('');
  console.log(`  diff.json      ${(fs.statSync(path.join(opts.out, 'diff.json')).size / 1e6).toFixed(1)}MB, complete subtest evidence`);
  console.log(`  report.txt     ranked view, directory clusters, shared vocabulary`);
  console.log(`  checklist.md   ${changed.length ? 'coverage worksheet — tick it in place' : 'empty'}`);
  console.log(`  state.json.gz  ${stateCount} tests, both runs`);
  if (sourceStats) {
    const got = sourceStats.fetched + sourceStats.cached;
    console.log(`  sources/       ${got} of ${got + sourceStats.failed} test files`);
    // `failed` was computed and then dropped from this line, under a label that read
    // like a total. 124 misses went unreported that way, and surfaced only when an
    // agent mid-analysis noticed that no test262 source would load. Grouped by
    // filename suffix, because the failures that matter come in families — a whole
    // generated-wrapper type with no mapping — and one line about a family is
    // actionable where 124 individual paths are noise.
    if (sourceStats.failed) {
      const fams = new Map();
      for (const t of sourceStats.failedPaths || []) {
        const base = t.split('/').pop().replace(/\?.*$/, '');
        const key = (base.match(/\.[^.]+\.[^.]+$/) || [base.replace(/^[^.]*/, '')])[0] || base;
        fams.set(key, (fams.get(key) || 0) + 1);
      }
      console.log(`                 !! ${sourceStats.failed} had no source at the run's revision:`);
      for (const [suffix, n] of [...fams.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
        console.log(`                    ${String(n).padStart(4)} x *${suffix}`);
      }
      console.log('                 A whole suffix family here means a missing source-path');
      console.log('                 mapping, not a missing test — see toSourcePath in lib/wpt.js.');
    }
  } else console.log('  sources/       not fetched (--no-sources)');
  console.log('');
  // No path in these, and no `export D=...` either. The analysis scripts default to
  // the only collected comparison, which keeps each command a bare script
  // invocation — the form the permission allowlist can actually match. A compound
  // `export D=... && node ...` matches no rule and prompts every time.
  console.log('Everything from here is local. Next:');
  console.log('');
  console.log('  node scripts/wpt-inventory.js --dirs      # the map');
  console.log('  node scripts/wpt-inventory.js             # every file + evidence');
  console.log('  node scripts/wpt-inventory.js --verify    # gate before writing');
  console.log('');
  // Stated here because this is the last thing read before the analysis commands
  // start, and because a pipe is both lossy and the thing that turns each of those
  // commands into a permission prompt.
  console.log('Run each as its own bare command: no "| head", no "| grep", no chaining');
  console.log('with ";" or "&&", no "export D=", no "cd". Every view pages itself and');
  console.log('says "!! PART n OF m" or "!! END" — believe that rather than filtering.');
  if (artifact.discover().length > 1) {
    console.log('');
    console.log(`  (tmp/ holds more than one comparison, so pass ${rel} to each)`);
  }
  if (report.before.wpt_revision !== report.after.wpt_revision) {
    // Quantified, because "some of this diff" is unactionable and the real figure is
    // large enough to change how the worksheet is read: on one release-to-release
    // comparison it was 342 of 909 changed files, 38%.
    const churnFiles = changed.filter((r) => r.kind === 'added' || r.kind === 'removed').length;
    const pct = changed.length ? Math.round((churnFiles / changed.length) * 100) : 0;
    console.log('');
    console.log(`NOTE: the runs are on different WPT revisions (${report.before.wpt_revision} -> `
      + `${report.after.wpt_revision}),`);
    console.log(`      so ${churnFiles} of ${changed.length} changed files (${pct}%) exist in only one run —`);
    console.log('      test-suite churn, not browser change.');
    console.log('      These are already kept out of the file checklist, and directories made');
    console.log('      up entirely of them arrive pre-resolved. What is left still needs reading:');
    console.log('      a mixed directory can hold both churn and a real fix.');
    if (report.before.product === report.after.product
      && (report.before.browser_version || '') !== (report.after.browser_version || '')) {
      // Worth saying plainly, because --aligned looks like the answer and is not.
      console.log('      --aligned CANNOT help here: two browser versions are never tested at the');
      console.log('      same WPT revision, so no aligned pair exists for a version comparison.');
    } else {
      console.log('      --aligned removes it, where both sides are current channels.');
    }
  }
}

main().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
