#!/usr/bin/env node
/**
 * The ranked view of a comparison: overall stats, the per-kind sections, the area
 * rollups, directory clusters and shared subtest vocabulary.
 *
 * Why this exists: `report.txt` was the only thing in an artifact with no command
 * behind it. Six scripts were all named wpt-*.js, so a reader looking for the report
 * reasonably invoked `wpt-report.js` — and got "Cannot find module". Meanwhile the
 * two sections the skill actually directs you to, Directory clusters and One
 * feature/several directories, sit at the END of that 24-44KB file, so `head` on it
 * shows the overall stats and misses both, while `tail` gets them and loses
 * everything else.
 *
 * Rendered from diff.json rather than sliced out of report.txt, which matters for
 * one reason beyond consistency: report.txt bakes in the --top used at collection
 * time, so "## Improvements (186)" lists 40 and the other 146 are unreachable from
 * that file forever. Here --top is yours to set.
 *
 * Usage:
 *   node wpt-report.js [artifact-dir] [options]
 *
 *   node wpt-report.js --list                 # what sections exist
 *   node wpt-report.js --section clusters     # the leads ranking would hide
 *   node wpt-report.js --section vocabulary
 *   node wpt-report.js --top 0 --section improvements
 *   node wpt-report.js --part 2
 *
 * Options:
 *   --section <s>  only sections whose heading contains <s>, case-insensitive
 *                  (repeatable). Matches the real heading text, so there is no
 *                  second vocabulary to learn.
 *   --list         list the section headings and their sizes, then stop
 *   --top <n>      rows per ranked section (default 40; 0 = all)
 *   --part <n>     which page (default 1). Pages break between sections.
 *   --all          every page at once, ignoring the budget
 *
 * This is the RANKED view, and ranking is what loses features — a +1 has been a
 * shipped feature twice. Use it for leads, and wpt-inventory.js for coverage.
 */

const { usage, num, unknownOption } = require('./lib/cli.js');
const artifact = require('./lib/artifact.js');
const { renderReport } = require('./lib/render.js');
const page = require('./lib/page.js');

const fail = (msg) => usage(__filename, msg);

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) usage(__filename);

const opts = { dir: null, section: [], list: false, top: 40, part: 1, all: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--section': opts.section.push(String(argv[++i] || '').toLowerCase()); break;
    case '--list': opts.list = true; break;
    case '--top': opts.top = num(fail, a, argv[++i]); break;
    case '--part': opts.part = num(fail, a, argv[++i]); break;
    case '--all': opts.all = true; break;
    default:
      if (a.startsWith('-')) fail(unknownOption(__filename, a));
      else if (!opts.dir) opts.dir = a;
      else fail(`unexpected argument ${a}`);
  }
}
if (opts.section.some((s) => !s)) fail('--section needs a value');

const { paths: art, report } = artifact.load(opts.dir, fail);
const lines = renderReport(report, { top: opts.top });

// Split into blocks at "## " headings. Everything before the first heading is the
// preamble — run identity and the revision/platform caveats — and is always shown,
// because a section read without knowing which two runs produced it is worthless.
const preamble = [];
const sections = [];
for (const line of lines) {
  if (line.startsWith('## ')) sections.push({ heading: line.slice(3), lines: [line] });
  else if (sections.length) sections[sections.length - 1].lines.push(line);
  else preamble.push(line);
}

if (opts.list) {
  for (const l of preamble) console.log(l);
  console.log(`${sections.length} sections:`);
  for (const s of sections) {
    const bytes = s.lines.reduce((n, l) => n + l.length + 1, 0);
    console.log(`  ${String(bytes).padStart(6)}B  ${s.heading}`);
  }
  console.log('');
  console.log(`Read one with:  ${artifact.cmd('wpt-report.js', art)} --section clusters`);
  process.exit(0);
}

/**
 * Words a reader will reach for that the heading does not contain.
 *
 * `--section vocabulary` matched nothing, because the heading is "One feature,
 * several directories (shared newly-passing subtest words)" — the word people know
 * it by is absent from its own title. Matching heading text alone is elegant and
 * fails on exactly the two sections the skill tells you to read.
 */
const ALIASES = [
  // Nothing in this heading is a word anyone will type. The words they will type are
  // the ones they are looking for a feature *in* — "javascript", "js", "test262" —
  // and the section is precisely a list of JS features no other section can hold.
  [/^JavaScript coverage horizon/, 'javascript js test262 ecmascript tc39 gaps horizon blindspot missing'],
  [/^Vendor changelog/, 'changelog bugs bugzilla vendor shipped milestone leads'],
  [/^Directory clusters/, 'clusters cluster directories leads'],
  [/^One feature, several directories/, 'vocabulary tokens feature-across-areas leads'],
  [/no subtests \(reftests/, 'reftests reftest rendering'],
  [/^Areas that moved only/, 'reftests reftest rendering areas'],
  [/^Biggest movers by area/, 'areas rollup'],
  [/^Change breakdown/, 'kinds buckets breakdown'],
  [/^Newly running/, 'newly-running shipped'],
  [/^Newly broken/, 'newly-broken broke'],
];
const tagsFor = (heading) =>
  `${heading} ${ALIASES.filter(([re]) => re.test(heading)).map(([, t]) => t).join(' ')}`.toLowerCase();

let chosen = sections;
if (opts.section.length) {
  chosen = sections.filter((s) => opts.section.some((q) => tagsFor(s.heading).includes(q)));
  if (!chosen.length) {
    console.error(`error: no section heading contains ${opts.section.map((s) => JSON.stringify(s)).join(' or ')}`);
    console.error('Available:');
    for (const s of sections) console.error(`  ${s.heading}`);
    process.exit(1);
  }
}

for (const l of preamble) console.log(l);
if (opts.section.length) {
  console.log(`(showing ${chosen.length} of ${sections.length} sections — --list for all)`);
  console.log('');
}

const resume = [artifact.cmd('wpt-report.js', art)]
  .concat(opts.section.flatMap((s) => ['--section', s]))
  .concat(opts.top !== 40 ? ['--top', String(opts.top)] : [])
  .join(' ');
for (const line of page.render(chosen.map((s) => ({ lines: s.lines })), {
  part: opts.part, all: opts.all, unit: 'sections', resume,
}).lines) {
  console.log(line);
}
