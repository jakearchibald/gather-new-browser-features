#!/usr/bin/env node
/**
 * What is actually on wpt.fyi right now — which versions, on which channels, from
 * when. Run this before choosing the two specs to compare.
 *
 * Why this exists: picking `--from` and `--to` is the first decision in a
 * release-notes pass, and it was the only step with no tool. The advice "pin a
 * version for notes between shipped releases, because once 153 is stable `stable`
 * no longer resolves to 152" is unusable without a way to find out that 153 is
 * stable — so the gap got filled with an ad-hoc `node -e` that called undici
 * directly, losing proxy support, and that sits outside the permission allowlist.
 *
 * Cheap: one /api/runs call per channel, no summaries. Note that this lists runs
 * as published, including partial ones — a real Firefox nightly once published a
 * summary with 2 test files. wpt-collect.js verifies completeness and skips those;
 * this listing does not, so a suspiciously old-looking newest run may just be the
 * newest *complete* one being further back.
 *
 * Usage:
 *   node wpt-runs.js [product] [options]
 *
 *   node wpt-runs.js                          # firefox, all three channels
 *   node wpt-runs.js chrome
 *   node wpt-runs.js firefox --channel stable --max-count 20
 *
 * Options:
 *   --channel <c>    just one of stable / beta / experimental (aliases nightly,
 *                    release, tp). Default: all three.
 *   --max-count <n>  runs to list per channel (default 8)
 */

const { netFetch } = require('./lib/net.js');
const { usage, num, unknownOption } = require('./lib/cli.js');

const fail = (msg) => usage(__filename, msg);

const CHANNEL_ALIASES = { nightly: 'experimental', release: 'stable', tp: 'experimental' };
const CHANNELS = ['stable', 'beta', 'experimental'];

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) usage(__filename);

const opts = { product: 'firefox', channels: CHANNELS, maxCount: 8 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--channel': {
      const raw = String(argv[++i] || '').toLowerCase();
      const c = CHANNEL_ALIASES[raw] || raw;
      if (!CHANNELS.includes(c)) fail(`unknown channel "${raw}" (stable, beta, experimental)`);
      opts.channels = [c];
      break;
    }
    case '--max-count': opts.maxCount = num(fail, a, argv[++i]); break;
    default:
      if (a.startsWith('-')) fail(unknownOption(__filename, a));
      else opts.product = a;
  }
}

/** Leading numeric segment, e.g. "153.0.1" -> "153". */
const major = (v) => (String(v || '').match(/^(\d+)/) || [])[1] || null;

async function runsFor(channel) {
  const params = new URLSearchParams({
    product: opts.product,
    label: channel,
    'max-count': String(opts.maxCount),
  });
  const res = await netFetch(`https://wpt.fyi/api/runs?${params}`);
  // A product with no runs on a channel is a 404 here, not an empty array.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GET /api/runs?${params} -> ${res.status} ${res.statusText}`);
  return res.json();
}

(async () => {
  console.log(`# ${opts.product} runs on wpt.fyi`);

  const seen = {};
  for (const channel of opts.channels) {
    const runs = await runsFor(channel);
    seen[channel] = runs;
    console.log('');
    console.log(`## ${channel}${channel === 'experimental' ? '  (aka nightly)' : ''}`);
    if (!runs.length) {
      console.log('  (no runs)');
      continue;
    }
    for (const r of runs) {
      console.log(
        // 14 wide: Chrome versions are "151.0.7922.71" and overflowed a 12 pad.
        `  ${String(r.browser_version || '?').padEnd(14)} ${String(r.time_start || '').slice(0, 10)}  ` +
          `wpt @ ${String(r.revision || '?').slice(0, 10)}  run ${r.id}`,
      );
    }
    // The deduplicated list is the thing you actually need to pin a version.
    const versions = [...new Set(runs.map((r) => r.browser_version).filter(Boolean))];
    console.log(`  versions in the last ${runs.length}: ${versions.join(', ')}`);
  }

  // ---- suggested specs ----
  // Two questions cover almost every pass: "what's new in the current pre-release
  // channel" and "what shipped in the latest stable release".
  console.log('');
  console.log('## Suggested comparisons');
  const P = opts.product;

  if (seen.beta?.length && seen.experimental?.length) {
    console.log('');
    console.log(`  what is coming next, beta -> nightly:`);
    console.log(`    node scripts/wpt-collect.js --from ${P}@beta --to ${P}@nightly`);
  }

  const stableMajors = [...new Set((seen.stable || []).map((r) => major(r.browser_version)).filter(Boolean))];
  if (stableMajors.length >= 2) {
    const [newer, older] = stableMajors;
    console.log('');
    console.log(`  what shipped in ${P} ${newer}:`);
    console.log(`    node scripts/wpt-collect.js --from ${P}@stable@${older} --to ${P}@stable@${newer}`);
  } else if (stableMajors.length === 1 && opts.channels.includes('stable')) {
    console.log('');
    console.log(`  only ${P} ${stableMajors[0]} appears in the last ${opts.maxCount} stable runs.`);
    console.log(`  Raise --max-count to reach the previous release, then pin both versions:`);
    console.log(`    node scripts/wpt-runs.js ${P} --channel stable --max-count 40`);
  }

  console.log('');
  console.log('Keep the channel alongside a pinned version — nightly runs outnumber stable');
  console.log('ones ~50:1, so an unlabelled version search never reaches back far enough.');
  console.log('Completeness is not checked here; wpt-collect.js skips partial runs.');
})().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
