#!/usr/bin/env node
/**
 * Which features in this comparison a beta/release user actually has.
 *
 * WPT force-enables prefs per directory — `testing/web-platform/meta/<dir>/__dir__.ini`
 * carries `prefs: [layout.css.typed-om.enabled:true]` and the harness applies it — so a test
 * passing does NOT mean the feature is on for users. Combined with the skill's most-suggested
 * comparison being beta -> nightly, that floods a diff with nightly-only features: on one real
 * 155 pass, 877 of 1585 forward-moving tests were gated and the notes led with three
 * nightly-only features presented as shipped.
 *
 * Usage:
 *   node wpt-prefs.js [artifact-dir] [options]
 *
 *   node wpt-prefs.js                    # the pref verdicts, worst first
 *   node wpt-prefs.js --gated            # every gated file, grouped by directory
 *   node wpt-prefs.js --refresh          # re-run the searchfox lookup and store it
 *
 * Options:
 *   --gated      list the gated files rather than the prefs
 *   --refresh    NETWORKED: re-run the check and store it in the artifact. For an artifact
 *                collected before this check existed, or after installing searchfox-cli.
 *   --part <n>   which page (default 1)
 *   --all        every page at once
 *
 * Needs searchfox-cli for --refresh (`cargo install searchfox-cli`). Without it the check
 * cannot run at all, and every view says so loudly rather than reporting "nothing gated" —
 * the two must never look the same.
 */

const fs = require('fs');
const { usage, num, unknownOption } = require('./lib/cli.js');
const artifact = require('./lib/artifact.js');
const { prefGatingLines } = require('./lib/render.js');
const { analysePrefGating, matchPrefsToTests, discount, VERDICT_LABEL } = require('./lib/prefs.js');
const page = require('./lib/page.js');

const fail = (msg) => usage(__filename, msg);

const opts = { dir: null, gated: false, refresh: false, part: 1, all: false };
for (let i = 0; i < process.argv.length - 2; i++) {
  const a = process.argv[i + 2];
  switch (a) {
    case '--gated': opts.gated = true; break;
    case '--refresh': opts.refresh = true; break;
    case '--part': opts.part = num(fail, a, process.argv[i + 3]); i++; break;
    case '--all': opts.all = true; break;
    case '-h': case '--help': usage(__filename); break;
    default:
      if (a.startsWith('-')) fail(unknownOption(__filename, a));
      else if (!opts.dir) opts.dir = a;
      else fail(`unexpected argument ${a}`);
  }
}

const { paths, report } = artifact.load(opts.dir, fail);

async function main() {
  if (opts.refresh) {
    const changed = report.tests.filter((r) => r.kind !== 'unchanged');
    const forward = changed.filter((r) => r.deltaPass > 0 || r.statusDirection === 'fixed');
    process.stderr.write(`Checking ${forward.length} forward-moving test(s) via searchfox...\n`);
    let g = await analysePrefGating(forward.map((r) => r.test), {
      onProgress: (d, n) => process.stderr.write(`  ${d}/${n} directories\r`),
    });
    if (g.ok) g = matchPrefsToTests(g, changed);
    report.prefGating = g;
    fs.writeFileSync(paths.diff, JSON.stringify(report, null, 2));
    if (!g.ok) {
      console.error(`\nerror: ${g.error}`);
      if (g.missingTool) {
        console.error('Install it, then re-run:  cargo install searchfox-cli');
      }
      return 1;
    }
    console.log(`\nStored. ${g.gatedTests.length} gated file(s); re-read the inventory to see the markers.`);
    return 0;
  }

  const g = report.prefGating;
  if (!g || !g.ok) {
    for (const line of prefGatingLines(g)) console.log(line);
    console.log(`Run:  ${artifact.cmd('wpt-prefs.js', paths)} --refresh`);
    return 0;
  }

  if (opts.gated) {
    const byDir = new Map();
    for (const t of g.gatedTests) {
      const dir = t.test.replace(/\/[^/]*$/, '');
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(t);
    }
    console.log(`# ${g.gatedTests.length} gated file(s) in ${byDir.size} directories — DISCOUNT unless asked`);
    console.log('');
    const blocks = [...byDir.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([dir, list]) => ({
        lines: [`  ${dir}  (${list.length}f)`,
          `      ${[...new Set(list.flatMap((x) => x.prefs))].slice(0, 4).join(', ')}`],
      }));
    for (const line of page.render(blocks, {
      part: opts.part, all: opts.all, unit: 'directories',
      resume: `${artifact.cmd('wpt-prefs.js', paths)} --gated`,
    }).lines) console.log(line);
    return 0;
  }

  for (const line of prefGatingLines(g)) console.log(line);
  console.log(`Gated files by directory:  ${artifact.cmd('wpt-prefs.js', paths)} --gated`);
  return 0;
}

main().then((c) => process.exit(c)).catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
