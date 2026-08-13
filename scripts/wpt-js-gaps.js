#!/usr/bin/env node
/**
 * Which JavaScript features this comparison cannot show — checked live.
 *
 * WPT does not track test262, it *vendors* it: `third_party/test262/vendored.toml`
 * pins an upstream revision, and it is re-pointed by hand every few months. So the
 * JS half of a WPT run has a horizon, and a feature whose test262 tests landed past
 * it has no test in either run — invisible in the diff, in the inventory, in every
 * ranked section, and in wpt-state.js, which is otherwise the tool that stops "not in
 * the diff" being reported as "not shipped".
 *
 * That cost three features on one real pass. Firefox 154 shipped Iterator Chunking
 * (`Iterator.prototype.chunks` / `.windows`), Iterator Includes and Iterator Join;
 * the snapshot was 117 days old; `wpt-grep.js Iterator` matched nothing in any of its
 * three layers and `wpt-state.js --grep Iterator/prototype/chunks` returned zero
 * tests. Every tool was right and the notes named none of the three.
 *
 * wpt-collect.js now records this at collection time, and the gaps become checklist
 * boxes that --verify insists on. This script exists for the two cases that leaves:
 *
 *   - an artifact collected before the check existed, whose diff.json has no
 *     `jsHorizon` — `--add` writes the boxes it would have had;
 *   - asking again later, since upstream test262 moves and the answer is cheap.
 *
 * Usage:
 *   node wpt-js-gaps.js [artifact-dir] [--add]
 *
 *   node wpt-js-gaps.js
 *   node wpt-js-gaps.js tmp/firefox-stable-153-vs-firefox-beta-154 --add
 *
 * Options:
 *   --stored        print what collection recorded and do NO network access. This is the
 *                   answer the checklist was built from.
 *   --add           append the JS-gap boxes to the artifact's checklist.md and record them
 *                   in boxes.json, for an artifact collected before the check existed.
 *                   Refuses if they are already there, so it is safe to repeat.
 *   --no-shipped    skip the "did it actually ship?" lookup, reporting the gaps alone.
 *
 * NETWORKED, unlike every other analysis script here: seven small files from GitHub, plus
 * one Bugzilla query per gap. `--stored` is the offline form.
 *
 * Why Bugzilla and not the tests
 * ------------------------------
 * Because for these features there are no tests, anywhere, at any revision — that is what
 * makes them gaps. WPT master pins the same four-month-old test262 snapshot the runs used,
 * and `third_party/test262/test/built-ins/Iterator/prototype/chunks/` 404s on master today,
 * so no run of any browser at any WPT revision has a result to report. The question "did
 * this ship?" is not under-measured here; it is unmeasured.
 *
 * There is a second reason that applies even where tests DO exist: WPT reports what ran in
 * the harness, which is not the same as what is on by default for users. Mozilla's "Ship
 * <proposal>" bug IS the pref flip, so Bugzilla answers the pref question that WPT
 * structurally cannot — the caveat the skill otherwise has to state and leave open.
 *
 * On --add and boxes.json
 * -----------------------
 * boxes.json is otherwise written once, at collection time, precisely so that a box
 * lost while resolving the worksheet is an exit code rather than a silent pass. `--add`
 * is the one sanctioned second writer, and it preserves that guarantee rather than
 * weakening it: the boxes and their record are written together, from the same list, so
 * --verify keeps comparing a complete worksheet against a complete inventory. Adding
 * the boxes to checklist.md BY HAND does not — they would show up under "boxes that
 * were not in the generated checklist" and fail the gate.
 */

const fs = require('fs');
const { usage, unknownOption } = require('./lib/cli.js');
const artifact = require('./lib/artifact.js');
const { fetchCoverageHorizon } = require('./lib/test262.js');
const { whatShipped } = require('./lib/shipped.js');
const { fetchResults } = require('./lib/test262fyi.js');
const { jsHorizonLines, jsChecklistLines, jsGapBoxes, boxPaths } = require('./lib/render.js');

const fail = (msg) => usage(__filename, msg);

const opts = { dir: null, add: false, stored: false, shipped: true };
for (const a of process.argv.slice(2)) {
  switch (a) {
    case '--add': opts.add = true; break;
    case '--stored': opts.stored = true; break;
    case '--shipped': opts.shipped = true; break;
    case '--no-shipped': opts.shipped = false; break;
    case '-h': case '--help': usage(__filename); break;
    default:
      if (a.startsWith('-')) fail(unknownOption(__filename, a));
      else if (!opts.dir) opts.dir = a;
      else fail(`unexpected argument ${a}`);
  }
}
if (opts.add && opts.stored) fail('--add needs a live check; drop --stored');

const { paths, report } = artifact.load(opts.dir, fail);

async function main() {
  let horizon;
  if (opts.stored) {
    horizon = report.jsHorizon;
    console.log('# As recorded at collection time — no network, and the answer the checklist');
    console.log(`# was built from.${horizon ? '' : ' This artifact has none: it predates the check.'}`);
  } else {
    horizon = await fetchCoverageHorizon({
      beforeRevision: report.before.wpt_revision,
      afterRevision: report.after.wpt_revision,
    });
    if (horizon.ok) {
      const features = [...horizon.missing, ...(horizon.revendored || [])];
      horizon.shipped = features.length && opts.shipped
        ? await whatShipped(features, report.after.product, report.after.browser_version)
        : null;
      horizon.fyi = features.length
        ? await fetchResults(features, report.after.product)
        : null;
    }
    console.log(`# Checked live against tc39/test262 just now, for wpt @ ${report.after.wpt_revision}`);
    const stored = report.jsHorizon;
    if (stored && stored.ok && horizon.ok && stored.missing.length !== horizon.missing.length) {
      // Upstream moved since collection. Worth saying, because the checklist was built
      // from the stored answer and is therefore the smaller list.
      console.log(`# NOTE: collection recorded ${stored.missing.length} gap(s); upstream now gives ${horizon.missing.length}.`);
      console.log('#       The checklist was built from the stored answer.');
    }
    if (!stored) {
      console.log('# NOTE: this artifact has no recorded horizon — it predates the check. The');
      console.log('#       worksheet therefore has no boxes for any of this. `--add` writes them.');
    }
  }
  console.log('');
  for (const line of jsHorizonLines(horizon)) console.log(line);

  // The sample tests, in full. This is the deep-dive command the SKILL points at for horizon
  // features, and it is the only place Step 4's "copy the example from a passing test" can be
  // satisfied for them — the artifact has no such test, upstream does.
  const up = horizon && horizon.upstreamTests;
  if (up && up.ok) {
    const withSamples = Object.entries(up.flags).filter(([, f]) => f.samples.length);
    if (withSamples.length) {
      console.log('');
      console.log('## Upstream test262 tests for these flags — copy examples from HERE');
      console.log('#');
      console.log('# There is no test in this comparison for any of them, so the usual rule (copy');
      console.log('# every snippet from a test that passed) has nothing local to point at. These are');
      console.log('# the real upstream tests, at test262 main. Prefer them over writing from memory,');
      console.log('# and say in the notes that the example is upstream-derived rather than taken from');
      console.log('# a test that ran in this comparison.');
      for (const [flag, f] of withSamples) {
        for (const sm of f.samples) {
          console.log('');
          console.log(`### ${flag} — ${sm.path}`);
          console.log(`# ${sm.url}`);
          console.log(sm.text.replace(/\n+$/, ''));
        }
      }
    }
  }

  if (!opts.add) {
    if (horizon && horizon.ok && jsGapBoxes(horizon).length && !report.jsHorizon) {
      console.log(`Add these to the worksheet:  ${artifact.cmd('wpt-js-gaps.js', paths)} --add`);
    }
    return 0;
  }

  // ---- --add ----
  if (!horizon.ok) {
    console.error(`error: the live check failed (${horizon.error}), so there is nothing to add.`);
    return 1;
  }
  const boxes = jsGapBoxes(horizon);
  if (!boxes.length) {
    console.log('Nothing to add: this snapshot is current with upstream test262.');
    return 0;
  }
  if (!fs.existsSync(paths.checklist)) {
    console.error(`error: no checklist.md in ${paths.dir}`);
    return 1;
  }
  const text = fs.readFileSync(paths.checklist, 'utf8');
  const already = boxPaths(text).filter((p) => p.startsWith('test262-feature:'));
  if (already.length) {
    console.log(`${already.length} JS-gap box(es) are already in ${artifact.rel(paths.checklist)}; none added.`);
    // The horizon is still refreshed, so the Bugzilla findings reach every view. Without
    // this, an artifact whose boxes were added before the Bugzilla lookup existed keeps
    // telling the reader to go and look the flags up — which is the instruction that
    // produced the wrong answer in the first place.
    report.jsHorizon = horizon;
    fs.writeFileSync(paths.diff, JSON.stringify(report, null, 2));
    console.log('Refreshed the stored horizon in diff.json, so the Bugzilla findings show up in');
    console.log(`  ${artifact.cmd('wpt-report.js', paths)} --section javascript`);
    console.log(`Resolve the boxes like any other:  ${artifact.cmd('wpt-resolve.js', paths)} --list`);
    return 0;
  }

  const section = jsChecklistLines(horizon);
  const updated = `${text.replace(/\n+$/, '')}\n${section.join('\n')}\n`;

  // .bak first: checklist.md is the only file in an artifact that re-collecting cannot
  // reproduce, because it holds the verdicts.
  fs.writeFileSync(`${paths.checklist}.bak`, text);
  fs.writeFileSync(paths.checklist, updated);
  // Recorded in the same breath, from the file just written, so --verify's inventory
  // check stays meaningful rather than reporting every new box as "extra".
  fs.writeFileSync(paths.boxes, `${JSON.stringify(boxPaths(updated), null, 1)}\n`);
  // And into diff.json, which is where every other view reads the horizon from.
  // Without this the artifact contradicts itself: the worksheet asks five questions
  // while `wpt-report.js --section javascript` says the check never ran and the
  // inventory says gaps are unknown. A reader who believed either of those would
  // reasonably dismiss the boxes.
  report.jsHorizon = horizon;
  fs.writeFileSync(paths.diff, JSON.stringify(report, null, 2));

  console.log(`Added ${boxes.length} box(es) to ${artifact.rel(paths.checklist)}, recorded them in`);
  console.log('boxes.json, and stored the horizon in diff.json so every view agrees.');
  console.log(`Previous checklist saved as ${artifact.rel(paths.checklist)}.bak`);
  console.log('');
  console.log('Each is a question the artifact cannot answer — look the flag up in the');
  console.log('browser\'s release notes or Bugzilla, then resolve it as data:');
  console.log(`  ${artifact.cmd('wpt-resolve.js', paths)} --list`);
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
