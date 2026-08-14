#!/usr/bin/env node
/**
 * The vendor's own list of what shipped in this release, cross-referenced against the diff.
 *
 * Every other view here starts from a test that moved and tries to name the feature. This
 * one runs the other way: it starts from what the bug tracker says shipped and asks whether
 * WPT saw it. That direction catches two things nothing else can, and they need opposite
 * responses:
 *
 *   bug 2019332  RTCIceTransport.getSelectedCandidatePair() / onselectedcandidatepairchange
 *                WAS in the diff, as newly-passing IDL subtests inside
 *                idlharness.https.window.html?include=(RTCSessionDescription|…) — a huge
 *                harness file behind a metacharacter path, i.e. the hardest row to read —
 *                and was absent from the notes. A cross-check catches what a reader skimmed.
 *
 *   bug 1850288  Show path in JSON Viewer  (and 1685123, WebExtensions manifest sandbox)
 *                DevTools and WebExtensions have no WPT coverage at all, so no pass-rate diff
 *                will ever mention them. The bug tracker is the only source.
 *
 * And one it gets wrong if you let it. `resolution=FIXED` means LANDED, NOT ENABLED. `:open`
 * for <select> (bug 2048183) is FIXED with a dev-doc keyword and its test fails in BOTH runs
 * because the feature is behind a pref — the failing test is CORRECT, and the first version of
 * this reported it as missing coverage, inverting the truth. So an empty match now lists all
 * three reasons it can happen instead of picking one, and where a summary says "behind pref"
 * or "in Nightly" the box says so.
 *
 * Local: wpt-collect.js fetched and matched everything already.
 *
 * Usage:
 *   node wpt-bugs.js [artifact-dir] [options]
 *
 *   node wpt-bugs.js                          # the developer-facing list, gaps first
 *   node wpt-bugs.js --gaps                   # only the ones the diff cannot show
 *   node wpt-bugs.js --census                 # every component, with counts
 *   node wpt-bugs.js --component Layout       # every fixed bug in matching components
 *   node wpt-bugs.js --grep clipboard         # every fixed bug whose summary matches
 *
 * Options:
 *   --refresh         fetch the changelog and store it in the artifact, adding the boxes to
 *                     checklist.md and boxes.json. NETWORKED — the only flag here that is.
 *                     For an artifact collected before this sweep existed. Safe to repeat.
 *   --gaps            only bugs with no matching diff evidence
 *   --census          the per-component counts for every fixed bug in the release
 *   --component <s>   bugs whose product/component contains <s> (repeatable)
 *   --grep <s>        bugs whose summary contains <s>, case-insensitive (repeatable)
 *   --part <n>        which page (default 1)
 *   --all             every page at once
 *
 * On the keyword filter, and why the census exists
 * ------------------------------------------------
 * The default list is the ~21 bugs carrying `dev-doc-needed`/`dev-doc-complete`, Mozilla's
 * own marker for "a web developer needs to be told about this". The unfiltered milestone
 * query is ~3256 bugs across 121 components, which is not readable — but "every filter is
 * somewhere a feature can hide" is the rule this repo runs on, and that keyword is applied
 * by hand and is certainly incomplete. So the rest are not discarded: they are stored whole
 * and reachable here by component or substring, with no further network access. The
 * boundary is navigable rather than silent, which is the same bargain `--part` makes with
 * the inventory.
 */

const fs = require('fs');
const { usage, num, unknownOption } = require('./lib/cli.js');
const artifact = require('./lib/artifact.js');
const { changelogLines, bugFinding, bugChecklistLines, bugGapBoxes, boxPaths } = require('./lib/render.js');
const page = require('./lib/page.js');

const fail = (msg) => usage(__filename, msg);

const opts = {
  dir: null, gaps: false, census: false, component: [], grep: [], part: 1, all: false,
  refresh: false,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    const v = argv[++i];
    if (v === undefined) fail(`missing value for ${a}`);
    return v;
  };
  switch (a) {
    case '--refresh': opts.refresh = true; break;
    case '--gaps': opts.gaps = true; break;
    case '--census': opts.census = true; break;
    case '--component': opts.component.push(next().toLowerCase()); break;
    case '--grep': opts.grep.push(next().toLowerCase()); break;
    case '--part': opts.part = num(fail, a, argv[++i]); break;
    case '--all': opts.all = true; break;
    case '-h': case '--help': usage(__filename); break;
    default:
      if (a.startsWith('-')) fail(unknownOption(__filename, a));
      else if (!opts.dir) opts.dir = a;
      else fail(`unexpected argument ${a}`);
  }
}

const { paths, report } = artifact.load(opts.dir, fail);

// ---- --refresh: the one networked path, mirroring wpt-js-gaps.js --add ----
if (opts.refresh) {
  const { netFetch } = require('./lib/net.js');
  const { fetchChangelog } = require('./lib/changelog.js');
  const { majorVersion } = require('./lib/shipped.js');
  (async () => {
    // The same still-failing set the collector builds, out of the stored summaries.
    const { readState } = require('./lib/summary.js');
    const stillFailing = [];
    try {
      const { after } = readState(paths.state);
      for (const [test, a] of after) {
        if (!a || a.total === 0 || a.pass < a.total) {
          stillFailing.push({ test, pass: a ? a.pass : 0, total: a ? a.total : 0 });
        }
      }
    } catch {
      console.log('note: no state.json.gz, so "landed but not enabled" cannot be detected.');
    }
    const fresh = await fetchChangelog(
      netFetch, report.after.product, majorVersion(report.after.browser_version),
      report.tests.filter((r) => r.kind !== 'unchanged'), stillFailing,
    );
    if (!fresh.ok) {
      console.error(`error: ${fresh.error}`);
      process.exit(1);
    }
    // Resolve each bug's controlling pref too. For a category WPT cannot cover — a wasm
    // binary-format change, a network-protocol default — this is the only positive evidence
    // there is, and without it "no tests" reads as "not a feature".
    const { fetchPrefLists, prefsForBugs } = require('./lib/prefs.js');
    const prefLists = await fetchPrefLists();
    if (prefLists.ok) {
      const matches = prefsForBugs(prefLists.lists, fresh.curated, prefLists.milestones);
      let named = 0;
      for (const bug of fresh.curated) if (matches[bug.id]) { bug.prefMatch = matches[bug.id]; named++; }
      console.log(`Resolved a controlling pref for ${named} of ${fresh.curated.length} bug(s).`);
    } else {
      console.log(`note: no pref evidence (${prefLists.missingTool ? 'searchfox-cli not installed' : prefLists.error}).`);
    }
    report.changelog = fresh;
    fs.writeFileSync(paths.diff, JSON.stringify(report, null, 2));
    const gaps = fresh.curated.filter((b) => !b.hits.length).length;
    console.log(`${fresh.total} bug(s) fixed for ${fresh.milestone}; ${fresh.curated.length} developer-facing, `
      + `${gaps} with no diff evidence. Stored in diff.json.`);

    const text = fs.existsSync(paths.checklist) ? fs.readFileSync(paths.checklist, 'utf8') : null;
    if (text === null) {
      console.log('No checklist.md here, so no boxes were added.');
      return;
    }
    if (boxPaths(text).some((b) => b.startsWith('bug:'))) {
      console.log('Boxes for these are already in checklist.md; none added.');
    } else {
      // .bak first, and boxes.json in the same breath, so --verify keeps comparing a
      // complete worksheet against a complete inventory.
      const updated = `${text.replace(/\n+$/, '')}\n${bugChecklistLines(fresh).join('\n')}\n`;
      fs.writeFileSync(`${paths.checklist}.bak`, text);
      fs.writeFileSync(paths.checklist, updated);
      fs.writeFileSync(paths.boxes, `${JSON.stringify(boxPaths(updated), null, 1)}\n`);
      console.log(`Added ${bugGapBoxes(fresh).length} box(es); previous checklist saved as .bak`);
    }
    console.log(`Read them:  ${artifact.cmd('wpt-bugs.js', paths)}`);
  })().catch((err) => {
    console.error(String(err && err.stack ? err.stack : err));
    process.exit(1);
  });
  return;
}

const cl = report.changelog;

if (!cl || !cl.ok) {
  // Never silence: an unmeasured changelog must not look like an empty one.
  for (const line of changelogLines(cl)) console.log(line);
  process.exit(0);
}

const resume = [artifact.cmd('wpt-bugs.js', paths)]
  .concat(opts.gaps ? ['--gaps'] : [])
  .concat(opts.census ? ['--census'] : [])
  .concat(opts.component.flatMap((c) => ['--component', c]))
  .concat(opts.grep.flatMap((g) => ['--grep', g]))
  .join(' ');

console.log(`# Vendor changelog: ${cl.total} bug(s) FIXED for ${cl.milestone}`);
console.log('');

// ---- --census: how to reach the bugs the keyword filter leaves out ----
if (opts.census) {
  console.log(`# Every component, so the ${cl.curated.length}-bug keyword list is navigable rather than a`);
  console.log('# silent cut. Drill in with --component <substring>.');
  console.log('');
  const blocks = cl.census.map((c) => ({ lines: [`  ${String(c.count).padStart(5)}  ${c.key}`] }));
  for (const line of page.render(blocks, {
    part: opts.part, all: opts.all, unit: 'components', resume,
  }).lines) console.log(line);
  process.exit(0);
}

// ---- --component / --grep: the whole set, filtered by meaning ----
if (opts.component.length || opts.grep.length) {
  const rows = [];
  for (const c of cl.census) {
    if (opts.component.length && !opts.component.some((q) => c.key.toLowerCase().includes(q))) continue;
    for (const b of c.bugs) {
      if (opts.grep.length && !opts.grep.some((q) => b.summary.toLowerCase().includes(q))) continue;
      rows.push({ lines: [`  bug ${b.id}  [${c.key}]`, `      ${b.summary}`] });
    }
  }
  const filters = [
    opts.component.length && `component matching ${opts.component.join(', ')}`,
    opts.grep.length && `summary matching ${opts.grep.join(', ')}`,
  ].filter(Boolean);
  console.log(`# ${rows.length} bug(s) — ${filters.join('; ')}`);
  console.log('# These are NOT keyword-filtered, so most will not be developer-facing.');
  console.log('');
  if (!rows.length) {
    console.log('No match. --census lists every component name.');
    process.exit(0);
  }
  for (const line of page.render(rows, {
    part: opts.part, all: opts.all, unit: 'bugs', resume,
  }).lines) console.log(line);
  process.exit(0);
}

// ---- default: the developer-facing list, gaps first ----
const list = opts.gaps ? cl.curated.filter((b) => !b.hits.length) : cl.curated;
const gaps = cl.curated.filter((b) => !b.hits.length).length;
console.log(`# ${cl.curated.length} flagged developer-facing (dev-doc-needed/-complete); ${gaps} with no`);
console.log('# matching diff evidence, listed first. A LEAD, not coverage — the keyword is');
console.log('# applied by hand. Everything else: --census, --component, --grep.');
console.log('');
if (opts.gaps) console.log(`(filtered to the ${list.length} with no diff evidence)`);

const blocks = list.map((b) => {
  const f = bugFinding(b);
  const lines = [
    `  bug ${b.id}  [${b.product}/${b.component}]  ${f.short}`,
    `      ${b.summary}`,
  ];
  for (const line of f.lines) lines.push(`      ${line}`);
  lines.push(`      https://bugzilla.mozilla.org/show_bug.cgi?id=${b.id}`);
  return { lines };
});
for (const line of page.render(blocks, {
  part: opts.part, all: opts.all, unit: 'bugs', resume,
}).lines) console.log(line);
