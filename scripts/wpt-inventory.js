#!/usr/bin/env node
/**
 * Every changed test file in a collected comparison, grouped by directory, for
 * reading end to end. Local and instant — wpt-collect.js already did the network.
 *
 * Why this exists
 * ---------------
 * Every other view ranks by magnitude — report.txt prints the top N by subtest
 * delta, the area rollup sums into a shallow bucket. Ranking is the wrong tool for
 * the job it was being used for, because **subtest count is not a signal of
 * importance**. The delta of a fix measures how many assertions happened to still
 * be failing beforehand, which has nothing to do with whether a feature shipped:
 *
 *   css/selectors/webkit-pseudo-element.html    5/6  -> 6/6   (+1)
 *       -webkit- prefixed pseudo-elements now parse as valid
 *   .../customizable-select/select-parsing.html 10/17 -> 17/17 (+7)
 *       the <select> parser keeps all nested elements
 *
 * Both are real, developer-facing features. Both were dismissed as noise on a real
 * release-notes pass because +1 and +7 look like rounding error next to a +664. No
 * threshold, weighting or cleverer ranking fixes that, because the premise is
 * wrong: there is no delta below which a change is uninteresting.
 *
 * So this view selects nothing. It prints all changed files, grouped by the
 * directory that names the feature, and expects to be read in full.
 *
 * Usage:
 *   node wpt-inventory.js [artifact-dir] [options]
 *
 *   node wpt-inventory.js --dirs
 *   node wpt-inventory.js --part 2
 *   node wpt-inventory.js --include /css/css-ui
 *   node wpt-inventory.js --regressions
 *   node wpt-inventory.js --verify
 *
 * The directory is optional and defaults to the only collected comparison in tmp/,
 * printing which one it used. Name it explicitly when several exist. Do NOT wrap
 * these in `export D=... && ...`: shell state does not persist between calls, so
 * that has to be repeated every time, and a compound command matches no permission
 * rule — turning every command into a prompt.
 *
 * The full listing does not fit in one tool result — ~86KB for a channel diff,
 * several hundred KB for a two-release one — so it is split into parts AT
 * DIRECTORY BOUNDARIES and says loudly which part you are looking at. Read them
 * all, with --part.
 *
 * Do not redirect this to a file and read line ranges out of it instead. That is
 * the failure this whole view exists to prevent: a line window cuts across a
 * directory, so the directory appears with only some of its files and nothing
 * marks the cut. --part cannot do that, and tells you what you have not yet seen.
 *
 * Options:
 *   --dirs          one line per directory only, no per-file rows: the map
 *   --part <n>      which page of the full listing (default 1). Pages break only
 *                   between directories, and each one reports its range.
 *   --all           print every part at once, ignoring the budget. For deliberate
 *                   redirection to a file or a pager, not for reading inline.
 *   --include <p>   only tests whose path starts with <p>, on a path boundary
 *                   (repeatable). This is how you read one area in full.
 *   --improvements  only files that moved forward
 *   --regressions   only files that moved backward
 *   --verify        audit the artifact's checklist.md and exit non-zero unless every
 *                   box is resolved with a usable verdict. This is what makes
 *                   "finish the checklist" enforceable: a printed box is state
 *                   nobody keeps, so it evaporates the moment the reader's
 *                   attention does.
 *
 *                   It checks the answers, not just the boxes, because counting
 *                   ticks certified "every line I still have has an x on it":
 *                     - a tick with no verdict passed, and so did
 *                       "— written up — see notes" (a bulk regex apply's fallback,
 *                       which would have stamped every unmatched box of 416);
 *                     - "explained" with nothing findable after it passed, though
 *                       it only asserts the line was set aside;
 *                     - nothing recorded which boxes should exist, so a pass that
 *                       rewrote the worksheet whole dropped four lines with the
 *                       count still reading 416. boxes.json fixes that one.
 *
 * There is deliberately no --exclude. Every filter is somewhere a feature can
 * hide, and this script's whole purpose is to be the one view that hides nothing.
 * An earlier default of `/third_party` looked obviously reasonable when it was
 * written and immediately concealed a shipped feature: 42 files under the
 * third_party/test262/test/intl402/Locale/prototype/get... directories, every one
 * 0/1 -> 1/1 — the whole Intl.Locale info proposal. JavaScript and Intl features have
 * no web-platform directory of their own, so they only ever appear there.
 *
 * The checklist
 * -------------
 * wpt-collect.js writes checklist.md alongside the diff. It exists because the
 * Popover API hint/auto rework was missed on a real pass *after* this script was
 * written and while its output was on screen. The line
 *
 *   /html/semantics/popovers  [5 files, +19 subtests, 5 fwd, 5 done]
 *
 * was printed, read, quoted in conversation as "not yet examined", and then never
 * examined — five files, every one *done*, the strongest signal this tool emits.
 * No additional signal would have helped, because the signal was already maximal.
 * What was missing was a completion criterion. Hence a worksheet with a verdict
 * per directory AND per file, and a --verify that fails while any box is open.
 */

const fs = require('fs');
const { usage, num, unknownOption } = require('./lib/cli.js');
const artifact = require('./lib/artifact.js');
const { under, movedForward, movedBackward, shellArg } = require('./lib/wpt.js');
const { renderInventory, verifyChecklist } = require('./lib/render.js');

const fail = (msg) => usage(__filename, msg);

function parseArgs(argv) {
  const opts = {
    dir: null, dirs: false, verify: null, part: 1, all: false,
    improvements: false, regressions: false, include: [], grep: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--dirs': opts.dirs = true; break;
      case '--part':
        opts.part = num(fail, arg, argv[++i]);
        if (opts.part < 1) fail('--part is 1-based');
        break;
      case '--all': opts.all = true; break;
      // A flag, not a path-taking option: it operates on whichever artifact the
      // other flags already identify, so `--verify` alone is the common form.
      case '--verify': opts.verify = true; break;
      case '--improvements': opts.improvements = true; break;
      case '--regressions': opts.regressions = true; break;
      case '--include': opts.include.push(next()); break;
      // Path substring, the same meaning `--grep` has in every other script. Kept
      // alongside --include (a path *prefix*) because they answer different
      // questions: "this area in full" versus "wherever this word appears".
      case '--grep': opts.grep.push(String(next()).toLowerCase()); break;
      case '-h': case '--help': usage(__filename); break;
      default:
        if (arg.startsWith('-')) fail(unknownOption(__filename, arg));
        else if (!opts.dir) opts.dir = arg;
        else fail(`unexpected argument ${arg}`);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// ---- --verify: the gate ----
if (opts.verify) {
  const paths = artifact.resolve(opts.dir, fail);
  if (!fs.existsSync(paths.checklist)) {
    console.error(`error: no checklist.md in ${paths.dir}`);
    console.error('Re-collect the comparison; wpt-collect.js writes one.');
    process.exit(1);
  }
  let expected = null;
  if (fs.existsSync(paths.boxes)) {
    try {
      expected = JSON.parse(fs.readFileSync(paths.boxes, 'utf8'));
    } catch {
      expected = null;
    }
  }
  const {
    open, bad, done, total, missing, extra, inventoryChecked,
  } = verifyChecklist(fs.readFileSync(paths.checklist, 'utf8'), expected);

  const problems = open.length + bad.length + missing.length + extra.length;
  if (!problems) {
    console.log(`GATE PASSED: all ${total} checklist boxes resolved with a verdict.`);
    if (!inventoryChecked) {
      // Never report a clean bill of health for a check that did not run.
      console.log('');
      console.log('NOTE: no boxes.json in this artifact, so the box inventory was NOT checked —');
      console.log('a box dropped while resolving the worksheet would not have been noticed.');
      console.log('Artifacts collected from now on record one. Re-collect to enable the check.');
    }
    console.log('Ready to write notes.');
    process.exit(0);
  }

  // Announced as a gate result, because exit 1 is the normal state until the
  // worksheet is finished and it was being read as a crash.
  console.log(`GATE: NOT READY — ${done}/${total} ticked, ${open.length} still open, `
    + `${bad.length} ticked without a real verdict.`);
  console.log('(Exiting 1 is expected here until every box has a verdict. Not a failure.)');

  const show = (label, lines, note) => {
    if (!lines.length) return;
    console.log('');
    console.log(`--- ${label} (${lines.length}) ---`);
    if (note) console.log(note);
    for (const line of lines.slice(0, 20)) console.log(`  ${line}`);
    if (lines.length > 20) console.log(`  ... and ${lines.length - 20} more`);
  };

  show('still open', open);
  show(
    'ticked, but the verdict does not answer',
    bad.map((b) => `${b.why}\n    ${b.line}`),
    'Each of these has an x on it, which is why the count above looks finished.',
  );
  // A missing box is the failure the count cannot see: resolving the worksheet by
  // rewriting it whole is lossy, and a box that stopped existing reads as a box
  // that was resolved.
  show(
    'boxes that have gone missing since collection',
    missing,
    'These were in the generated checklist and are not in it now. Restore them —\n'
      + 'checklist.md is the only file here that cannot be regenerated without losing\n'
      + 'verdicts, so re-collecting is not the fix. Copy them back from boxes.json.',
  );
  show(
    'boxes that were not in the generated checklist',
    extra,
    'Paths added or altered by hand. Usually a path edited while ticking it.',
  );

  // Leads with the verdicts-file route, because this message is printed every time the
  // gate fails — which is most of a pass — and it used to describe hand-editing. That is
  // the method measured at 106 Edit calls and 22% of one run's entire output, so the
  // most-read line in the toolkit was recommending its most expensive path, and never
  // mentioned the command that exists to replace it.
  console.log('');
  console.log('Resolve every line before writing notes. Do it as data, not as edits:');
  console.log('');
  console.log(`  1. ${artifact.cmd('wpt-resolve.js', paths)} --list`);
  console.log('     every box path with no verdict yet — use these EXACTLY as keys');
  console.log('  2. write {"<box path>": "<verdict>", ...} with the Write tool');
  console.log(`  3. ${artifact.cmd('wpt-resolve.js', paths)} <that file>`);
  console.log('');
  console.log('Each verdict is one of:');
  console.log('  written up: <the feature, as it appears in the notes>');
  console.log('  explained: same feature as <name the other entry>   <- a target is required');
  console.log('  not a feature: <infrastructure, flake or churn, and why>');
  console.log('');
  console.log('Editing checklist.md by hand works too, and costs several times the output —');
  console.log('an edit has to restate its surrounding context, a verdict does not.');
  process.exit(1);
}

// ---- the listing ----
const { paths: art, report } = artifact.load(opts.dir, fail);

let tests = report.tests.filter((r) => r.kind !== 'unchanged');
if (opts.include.length) {
  tests = tests.filter((r) => opts.include.some((p) => under(r.test, p)));
}
if (opts.grep.length) {
  tests = tests.filter((r) => opts.grep.some((g) => r.test.toLowerCase().includes(g)));
}
if (opts.improvements) tests = tests.filter(movedForward);
if (opts.regressions) tests = tests.filter(movedBackward);

const filters = [
  opts.improvements && 'improvements',
  opts.regressions && 'regressions',
  opts.include.length && `under ${opts.include.join(', ')}`,
  opts.grep.length && `matching ${opts.grep.join(', ')}`,
].filter(Boolean);

// Rebuilt from the parsed options rather than process.argv, so the resume command is
// normalised and carries no metacharacters beyond what a value genuinely needs.
const resume = [artifact.cmd('wpt-inventory.js', art)]
  .concat(opts.dirs ? ['--dirs'] : [])
  .concat(opts.improvements ? ['--improvements'] : [])
  .concat(opts.regressions ? ['--regressions'] : [])
  .concat(opts.include.flatMap((p) => ['--include', shellArg(p)]))
  .concat(opts.grep.flatMap((g) => ['--grep', shellArg(g)]))
  .join(' ');

for (const line of renderInventory(report, tests, {
  dirsOnly: opts.dirs,
  filters,
  part: opts.part,
  all: opts.all,
  resume,
  // The navigation hint is for someone facing the whole listing; once they have
  // narrowed to an area or a filter, repeating it is just noise.
  navHint: !filters.length,
})) {
  console.log(line);
}
