#!/usr/bin/env node
/**
 * Print EVERY changed test file in a diff, grouped by directory, for reading
 * end to end.
 *
 * Why this exists
 * ---------------
 * Every other view in this toolkit ranks by magnitude — subtest delta, summed
 * area delta, top-N per section. Ranking is the wrong tool for the job it was
 * being used for, because **subtest count is not a signal of importance**. The
 * delta of a fix measures how many assertions happened to still be failing
 * beforehand, which has nothing to do with whether a feature shipped:
 *
 *   css/selectors/webkit-pseudo-element.html   5/6  -> 6/6   (+1)
 *       -webkit- prefixed pseudo-elements now parse as valid
 *   .../customizable-select/select-parsing.html 10/17 -> 17/17 (+7)
 *       the <select> parser keeps all nested elements
 *
 * Both are real, developer-facing features. Both were dismissed as noise on a
 * real release-notes pass because +1 and +7 look like rounding error next to a
 * +664. No threshold, weighting or cleverer ranking fixes that, because the
 * premise is wrong: there is no delta below which a change is uninteresting.
 *
 * So this view selects nothing. It prints all changed files, grouped by the
 * directory that names the feature, and expects to be read in full. On a typical
 * two-release diff that is ~600 files in ~190 directories — a few minutes of
 * reading, and the only approach that cannot silently drop a feature.
 *
 * Usage:
 *   node wpt-inventory.js <diff.json> [options]
 *
 *   node wpt-inventory.js diff.json                   # everything, grouped
 *   node wpt-inventory.js diff.json --improvements    # only forward movement
 *   node wpt-inventory.js diff.json --regressions     # only backward movement
 *   node wpt-inventory.js diff.json --completed       # files that reached 100%
 *   node wpt-inventory.js diff.json --dirs            # one line per directory
 *   node wpt-inventory.js diff.json --checklist       # coverage worksheet, see below
 *   node wpt-inventory.js diff.json --include /css    # restrict to a subtree
 *
 * Options:
 *   --dirs          one line per directory only, no per-file rows
 *   --checklist [f] emit one unchecked line per directory that needs a verdict,
 *                   with churn-only directories pre-resolved, followed by a
 *                   second worksheet with one line per *done* FILE. Use this to
 *                   make coverage auditable instead of aspirational: every line
 *                   has to end up either explained or written up. Reading advice
 *                   cannot be verified; an unticked box can. Two granularities
 *                   because a directory verdict absorbs the files inside it —
 *                   see "Why the done-file checklist exists" below. Given a file
 *                   path, writes the worksheet there instead of to stdout, and
 *                   refuses to overwrite one that already exists.
 *   --verify <f>    count unresolved lines in a worksheet written earlier and exit
 *                   non-zero if any remain. This is what makes "finish the
 *                   checklist" enforceable: a printed box is state nobody keeps,
 *                   so it evaporates the moment the reader's attention does.
 *   --completed     only files that went from partly failing to fully passing.
 *                   "Last failures cleared" — a strong feature-shipped signal
 *                   that is independent of how big the delta was.
 *   --improvements  only files that moved forward
 *   --regressions   only files that moved backward
 *   --include <p>   only tests whose path starts with <p> (repeatable)
 *   --exclude <p>   skip tests whose path starts with <p> (repeatable).
 *                   NOTHING is excluded unless you ask. See below.
 *
 * Why --checklist exists
 * ----------------------
 * The Popover API hint/auto rework was missed on a real pass *after* this script
 * was written and while its output was on screen. The line
 *
 *   /html/semantics/popovers  [5 files, +19 subtests, 5 fwd, 5 done]
 *
 * was printed, read, quoted in conversation as "not yet examined", and then never
 * examined — five files, every one *done*, the strongest signal this tool emits.
 * No additional signal would have helped, because the signal was already maximal.
 * What was missing was a completion criterion: nothing distinguished "read all 202
 * directories" from "read the 15 that looked interesting". So this mode turns the
 * inventory into a worksheet with a per-directory verdict, where stopping early is
 * visible rather than silent.
 *
 * Why the done-file checklist exists
 * ----------------------------------
 * The per-directory worksheet above was itself not enough, and failed the same
 * way one release later. On the Firefox 151 -> 152 pass, this line was printed:
 *
 *   /svg/types/scripted  [8 files, +36 subtests, 3 fwd, 3 done, 5 new/gone]
 *
 * It was read, verdicted as "mostly new SVGLength convertToSpecifiedUnits
 * tests", and ticked. That verdict was true of five files and wrong about one:
 *
 *   SVGAnimatedEnumeration-SVGTextPathElement.html  2/3 -> 3/3 *done*
 *
 * which was SVGTextPathElement.side — a newly supported IDL property —
 * shipping. The signal was maximal and correctly printed. What failed was
 * granularity: a directory is one tick, so ticking it silently resolved all
 * eight files, and "3 done" was a number to skim rather than a question to
 * answer.
 *
 * Hence a second worksheet at file granularity. ~150 done-files in a typical
 * two-release diff is entirely readable, and each is a direct question: what
 * feature does this cover? A directory verdict can no longer absorb them.
 *
 * Files whose name cannot identify the feature (idlharness, SVGAnimated*,
 * interfaces/) are marked [?] rather than [ ]: for those the path is not
 * evidence and the source has to be read. See OPAQUE_NAME_RE.
 *
 * And *done* alone was still not enough — a second feature was missed in the
 * same release, by a different mechanism:
 *
 *   /web-animations/interfaces/Animatable/getAnimations.html  29/34 -> 33/34
 *
 * That is Element.getAnimations({ pseudoElement }) shipping. It is NOT *done*,
 * because ::part() still fails, so under a done-only worksheet it got no box
 * and was reported as an unexplained "+1". A feature can ship with an edge case
 * outstanding; "reached 100%" and "is a feature" are different predicates.
 *
 * Boxing all ~326 forward movers would be unreadable. But opaquely-named files
 * are precisely where directory-level reading is guaranteed to fail, and there
 * are only ~13 of those beyond the done set. So the file checklist is:
 * every *done* file, plus every opaquely-named file that moved forward at all.
 *
 * On third_party/test262
 * ----------------------
 * `third_party/test262` is the vendored TC39 conformance suite, and it is where
 * **JavaScript language and Intl features appear** — they have no web-platform
 * directory of their own. It is tempting to exclude by default because it is
 * one-assertion-per-file and so forms large uniform blocks; an earlier version of
 * this script did exactly that, and immediately hid a shipped feature:
 *
 *   third_party/test262/test/intl402/Locale/prototype/get{Calendars,Collations,
 *   HourCycles,NumberingSystems,TextInfo,TimeZones,WeekInfo}/  — 42 files,
 *   every one 0/1 -> 1/1, i.e. the whole Intl.Locale info proposal landing.
 *
 * One assertion per file is what makes *done* maximally informative here: a
 * test262 file going 0/1 -> 1/1 means one named spec assertion started holding.
 * Dozens of them under one proposal's directory is a cleaner "feature shipped"
 * signal than most web-platform directories produce. So: no default exclusion.
 * If it is genuinely in the way for one run, pass --exclude /third_party
 * explicitly — but do not make that a habit, or Intl/Temporal-class features will
 * go unreported.
 */

const fs = require('fs');

const STATUS_NAMES = {
  O: 'OK', P: 'PASS', F: 'FAIL', S: 'SKIP', E: 'ERROR',
  N: 'NOTRUN', C: 'CRASH', T: 'TIMEOUT', PF: 'PRECONDITION_FAILED',
};

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(msg ? 1 : 0);
}

function parseArgs(argv) {
  const opts = {
    file: null, dirs: false, checklist: false, checklistOut: null, verify: null,
    completed: false, improvements: false, regressions: false,
    include: [], exclude: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--dirs': opts.dirs = true; break;
      case '--checklist':
        opts.checklist = true;
        // Optional value, so `--checklist` alone still prints to stdout.
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) opts.checklistOut = argv[++i];
        break;
      case '--verify': opts.verify = next(); break;
      case '--completed': opts.completed = true; break;
      case '--improvements': opts.improvements = true; break;
      case '--regressions': opts.regressions = true; break;
      case '--include': opts.include.push(next()); break;
      case '--exclude': opts.exclude.push(next()); break;
      case '-h': case '--help': usage(); break;
      default:
        if (arg.startsWith('-')) usage(`unknown option ${arg}`);
        else if (!opts.file) opts.file = arg;
        else usage(`unexpected argument ${arg}`);
    }
  }
  if (opts.verify) return opts;
  if (!opts.file) usage('a diff.json path is required');
  return opts;
}

/**
 * Count the boxes left unticked in a worksheet written earlier.
 *
 * The point of a checklist is a completion criterion, and a criterion nobody can
 * evaluate is just advice with punctuation. Two features were lost after the
 * worksheet existed, both by stopping early. This makes stopping early an exit
 * code.
 */
function verifyWorksheet(file) {
  if (!fs.existsSync(file)) {
    console.error(`error: no worksheet at ${file}`);
    console.error('Write one first:  node scripts/wpt-inventory.js <diff.json> --checklist <file>');
    process.exit(1);
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const open = [];
  let done = 0;
  for (const line of lines) {
    // Directory boxes are [ ]/[x]; file boxes are ( )/(?)/(x). Anything the
    // reader has replaced with an x counts as resolved.
    if (/^(\[ \]|\(\s\)|\(\?\))/.test(line)) open.push(line.trim());
    else if (/^(\[x\]|\(x\))/i.test(line)) done++;
  }
  const total = open.length + done;
  console.log(`${file}: ${done}/${total} resolved, ${open.length} unresolved`);
  if (!open.length) {
    console.log('All boxes resolved.');
    return 0;
  }
  console.log('');
  for (const line of open.slice(0, 20)) console.log(`  ${line}`);
  if (open.length > 20) console.log(`  ... and ${open.length - 20} more`);
  console.log('');
  console.log('Resolve every line before writing notes. Replace the box with [x]/(x)');
  console.log('and a verdict: written up / explained (name which) / not a feature (why).');
  return 1;
}

// A test that exists on only one side is test-suite churn, not browser change:
// the two runs are usually on different WPT revisions, so `added`/`removed` mean
// "this test was written since" far more often than they mean anything about the
// browser. Counting them as movement actively misleads — /css/css-viewport/zoom
// shows 34 changed files here, of which 31 are simply new tests. They are still
// listed (a new test that already fails can be worth a mention) but tallied
// separately so a directory of pure churn is obvious at a glance.
function isChurn(r) {
  return r.kind === 'added' || r.kind === 'removed';
}
/** Did this file move forward? Covers reftests, which carry no subtests. */
function movedForward(r) {
  return !isChurn(r) && (r.deltaPass > 0 || r.statusDirection === 'fixed' || r.kind === 'newly-running');
}
function movedBackward(r) {
  return !isChurn(r) && (r.deltaPass < 0 || r.statusDirection === 'broken' || r.kind === 'newly-broken');
}
/** Was failing something, now passes everything: "last failures cleared". */
function completed(r) {
  return (
    r.before && r.after &&
    r.before.total > 0 && r.after.total > 0 &&
    r.before.pass < r.before.total && r.after.pass === r.after.total
  );
}

/**
 * Fallback for diffs built without `wpt-diff.js --subtests`: guess from the path
 * which files cannot name their own feature.
 *
 * A guess is all this can be, which is the reason `--subtests` exists. It missed
 * its own category on a real diff — `animationevent-interface.html`,
 * `Element-interface-attachShadow.html` and `SVGGraphicsElement.getBBox-10.html`
 * are all named for a type rather than a behaviour and none matched. The
 * patterns below are widened, and still only a guess.
 */
const OPAQUE_NAME_RE =
  /(^|\/)(idlharness|historical|interfaces?)[.\-]|SVGAnimated|\/interfaces?\/|-interface[.\-]|[.\-]\d\d?\.html$/i;

/**
 * Auto-generated positional subtest names ("...Element 2") carry no meaning and
 * actively mislead: they are zero-indexed *after* the first, so " 2" is the
 * THIRD test() block. Detected from the name itself when it is available.
 */
function positionalName(name) {
  return / \d+$/.test(String(name));
}

/**
 * A message that names nothing. `assert_true: expected true got false` is the
 * canonical case: it tells you an assertion flipped and not one word about what.
 * A message earns its keep by containing an identifier — a camelCase word, a
 * dotted path, a CSS property or a quoted value.
 */
function messageNamesSomething(msg) {
  if (!msg) return false;
  const s = String(msg);
  return /[a-z][A-Z]|\w\.\w|[a-z]-[a-z]|["'][^"']{2,}["']|\(\)/.test(s.replace(/^assert_\w+:?\s*/, ''));
}

/**
 * Does the loaded evidence identify the feature, or does the source have to be read?
 *
 * With `--subtests` this is measured rather than guessed: a file is opaque when
 * every one of its newly-passing subtests is positionally named AND carries a
 * message that names nothing. That is exactly
 * `SVGAnimatedEnumeration-SVGTextPathElement.html` ("...SVGTextPathElement 2",
 * `assert_true: expected true got false`) and exactly NOT
 * `getAnimations.html` ("Returns animations on pseudo-element when it is
 * specified"), which the path heuristic flagged identically and wrongly.
 */
function opaquelyNamed(r) {
  const np = r.subtests && r.subtests.newlyPassing;
  if (!np || !np.length) return OPAQUE_NAME_RE.test(r.test);
  return !np.some((s) => !positionalName(s.name) || messageNamesSomething(s.message));
}

/** Subtests whose names are positional, so a number must not be read as an index. */
function positionalSubtests(r) {
  const np = (r.subtests && r.subtests.newlyPassing) || [];
  return np.filter((s) => positionalName(s.name));
}

function fmtSide(s) {
  if (!s) return '-';
  const name = STATUS_NAMES[s.status] || s.status || '?';
  return `${name} ${s.pass}/${s.total}`;
}

function clip(s, n) {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/**
 * The subtest names behind a file's movement, indented under its row.
 *
 * This is the whole reason `wpt-diff.js --subtests` exists. Without it a reader
 * has to infer a feature from a path and then decide whether to spend a
 * `wpt-subtests.js` run finding out — a decision made with the least information
 * available, and the one that lost `getAnimations({ pseudoElement })`, whose
 * subtest is named "Returns animations on pseudo-element when it is specified".
 * A verdict is nearly free once the name is on the line; it is separate,
 * skippable work when it is not.
 */
function evidenceLines(r, indent, cap = 4) {
  if (!r.subtests) return [];
  const out = [];
  // `total` comes from counts, not the array: wpt-diff.js caps the stored names,
  // so the array length would under-report how much is hidden.
  const show = (list, total, label, msgLabel) => {
    for (const s of list.slice(0, cap)) {
      out.push(`${indent}${label} ${clip(s.name, 96)}`);
      // A positional name carries no meaning, so fall back to the message, which
      // for those files is usually the only identifier available.
      if (positionalName(s.name) && s.message) {
        out.push(`${indent}    ${msgLabel} ${clip(s.message, 96)}`);
      }
    }
    const hidden = total - Math.min(cap, list.length);
    if (hidden > 0) out.push(`${indent}${label} ... and ${hidden} more`);
  };
  const { newlyPassing, newlyFailing, counts } = r.subtests;
  show(newlyPassing, counts.newlyPassing, '+', 'was:');
  show(newlyFailing, counts.newlyFailing, '-', 'now:');
  return out;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.verify) process.exit(verifyWorksheet(opts.verify));

// Writing the worksheet to a file makes the ticks durable, so refusing to
// clobber one matters: an overwrite silently discards every verdict recorded so
// far, which is worse than any error this script could print.
const sink = [];
const L = opts.checklistOut ? (line = '') => sink.push(line) : console.log;
if (opts.checklistOut && fs.existsSync(opts.checklistOut)) {
  console.error(`error: ${opts.checklistOut} already exists — refusing to overwrite verdicts.`);
  console.error(`Check progress with:  node scripts/wpt-inventory.js --verify ${opts.checklistOut}`);
  process.exit(1);
}
function flush() {
  if (!opts.checklistOut) return;
  fs.writeFileSync(opts.checklistOut, `${sink.join('\n')}\n`);
  process.stderr.write(`Wrote ${opts.checklistOut}\n`);
  process.stderr.write(
    `Tick boxes in place, then: node scripts/wpt-inventory.js --verify ${opts.checklistOut}\n`,
  );
}

const report = JSON.parse(fs.readFileSync(opts.file, 'utf8'));

/**
 * Prefix match on a path boundary. A plain startsWith over-matches siblings:
 * `--include /dom` swept in `/domparsing` and `--include /webrtc` swept in
 * `/webrtc-stats`. That is merely confusing for --include, but for --exclude it
 * *hides* — `--exclude /html` would silently drop `/html-media-capture`, which
 * is the failure mode this whole script exists to prevent.
 */
function under(test, prefix) {
  const p = `/${prefix.replace(/^\/+/, '')}`.replace(/\/+$/, '');
  return p === '' || test === p || test.startsWith(`${p}/`);
}

let tests = report.tests.filter((r) => r.kind !== 'unchanged');
if (opts.exclude.length) {
  tests = tests.filter((r) => !opts.exclude.some((p) => p && under(r.test, p)));
}
if (opts.include.length) {
  tests = tests.filter((r) => opts.include.some((p) => under(r.test, p)));
}
if (opts.completed) tests = tests.filter(completed);
if (opts.improvements) tests = tests.filter(movedForward);
if (opts.regressions) tests = tests.filter(movedBackward);

const byDir = new Map();
for (const r of tests) {
  const dir = `/${r.test.replace(/^\//, '').split('/').slice(0, -1).join('/')}`;
  if (!byDir.has(dir)) byDir.set(dir, []);
  byDir.get(dir).push(r);
}

const groups = [...byDir.entries()]
  .map(([dir, rows]) => ({
    dir,
    rows: rows.sort((a, b) => b.deltaPass - a.deltaPass || a.test.localeCompare(b.test)),
    deltaPass: rows.reduce((s, r) => s + r.deltaPass, 0),
    forward: rows.filter(movedForward).length,
    backward: rows.filter(movedBackward).length,
    completed: rows.filter(completed).length,
    churn: rows.filter(isChurn).length,
  }))
  // Alphabetical by path, NOT by size. Related directories read together, and
  // no directory is implicitly "more important" for being listed first.
  .sort((a, b) => a.dir.localeCompare(b.dir));

const filters = [
  opts.completed && 'completed',
  opts.improvements && 'improvements',
  opts.regressions && 'regressions',
  opts.include.length && `under ${opts.include.join(', ')}`,
].filter(Boolean);

L(`# Changed-test inventory: ${report.before.spec} -> ${report.after.spec}`);
L('');
L(`${tests.length} changed test files in ${groups.length} directories${filters.length ? ` (${filters.join(', ')})` : ''}.`);
const hasEvidence = tests.some((r) => r.subtests);
if (!hasEvidence) {
  // Without this the reader is back to inferring features from paths, which is
  // how most of the known misses happened. Say so rather than degrading quietly.
  L('');
  L('NO SUBTEST NAMES IN THIS DIFF. Every line below is a path and a number, so');
  L('naming the feature means a separate wpt-subtests.js run per file — the exact');
  L('step that got skipped when features were missed. Regenerate with:');
  L('  node scripts/wpt-diff.js --from <a> --to <b> --subtests --json <out>');
}
if (opts.exclude.length && opts.exclude.some(Boolean)) {
  // Loud, because an exclusion is exactly how a feature goes unreported: an
  // earlier default of /third_party hid the whole Intl.Locale info proposal.
  L(`EXCLUDED BY REQUEST: ${opts.exclude.filter(Boolean).join(', ')} — features in`);
  L('those paths will not appear below. Re-run without --exclude to see them.');
}
L('');

if (opts.checklist) {
  const churnOnly = groups.filter((g) => g.churn === g.rows.length);
  const needsVerdict = groups.filter((g) => g.churn !== g.rows.length);

  L('COVERAGE CHECKLIST');
  L('');
  L(`${needsVerdict.length} directories need a verdict. ${churnOnly.length} are pre-resolved`);
  L('as test-suite churn (added/removed tests only — different WPT revisions).');
  L('');
  L('Work top to bottom and give EVERY line one of:');
  L('  [x] written up   — it is in the notes');
  L('  [x] explained    — same cause as another entry; name which');
  L('  [x] not a feature — infrastructure, flake, or churn; say why');
  L('Do not leave a line unticked, and do not stop at the interesting-looking ones.');
  L('A 5-file all-done directory was skipped that way once: see --help.');
  L('');
  for (const g of needsVerdict) {
    const bits = [
      g.forward ? `${g.forward} fwd` : null,
      g.backward ? `${g.backward} back` : null,
      g.completed ? `${g.completed} done` : null,
      g.churn ? `${g.churn} new/gone` : null,
    ].filter(Boolean);
    const delta = g.deltaPass > 0 ? `+${g.deltaPass}` : String(g.deltaPass);
    L(`[ ] ${g.dir}  (${g.rows.length}f, ${delta}, ${bits.join(', ')})`);
  }
  L('');
  L(`--- pre-resolved as churn (${churnOnly.length}), no verdict needed ---`);
  for (const g of churnOnly) L(`[x] ${g.dir}  (${g.rows.length}f, churn)`);

  // Second worksheet, at FILE granularity, because a directory verdict silently
  // absorbs every file inside it. /svg/types/scripted was ticked as "new
  // SVGLength tests" while holding three *done* files, one of which was
  // SVGTextPathElement.side shipping: "3 done" is a number you skim, not a
  // question you answer.
  //
  // Boxed set = every *done* file (the strongest feature signal, and independent
  // of delta size) plus every file whose loaded evidence cannot name its own
  // feature. *done* alone was not enough: getAnimations.html went 29/34 -> 33/34
  // for `{ pseudoElement }` and is not *done* because ::part() still fails, so a
  // done-only worksheet gave it no box and it became an unexplained "+1".
  //
  // Boxing all forward movers would be unreadable, and with subtest names loaded
  // it is also unnecessary — the directory listing now carries the evidence for
  // the rest.
  const boxed = tests
    .filter((r) => completed(r) || (movedForward(r) && opaquelyNamed(r)))
    .sort((a, b) => a.test.localeCompare(b.test));
  const partial = boxed.filter((r) => !completed(r)).length;
  const opaque = boxed.filter(opaquelyNamed).length;

  if (boxed.length) {
    L('');
    L(`FILE CHECKLIST (${boxed.length})`);
    L('');
    L('Every file that reached 100% — "last failures cleared" — plus every file');
    L(`whose evidence cannot name its own feature (${partial} of these have not finished).`);
    L('A small delta here means "small because it was nearly finished", NOT "small');
    L('because it does not matter", and a file short of 100% can still be a shipped');
    L('feature with one edge case outstanding. Ticking a directory above does NOT');
    L('tick these: name the feature each covers, or say why it is not one.');
    L('');
    L(`A "(?)" box (${opaque}) marks a file whose evidence names nothing — positional`);
    L('subtest names and messages like "assert_true: expected true got false".');
    if (hasEvidence) {
      L('Measured from the loaded subtest names, not guessed from the path. For these');
    } else {
      L('GUESSED FROM THE PATH, because this diff has no subtest names. For these');
    }
    L('only, fetch the source:  node scripts/wpt-fetch-tests.js <path> --head 0');
    L('');
    for (const r of boxed) {
      // "(?)" / "( )" rather than "[?]" / "[ ]": the directory worksheet above
      // uses square brackets, and when both used them neither list could be
      // counted or grepped apart.
      const box = opaquelyNamed(r) ? '(?)' : '( )';
      const delta = r.deltaPass > 0 ? `+${r.deltaPass}` : String(r.deltaPass);
      const mark = completed(r) ? '*done*' : 'still failing some — check anyway';
      L(`${box} ${r.test}`);
      L(`      ${fmtSide(r.before)} -> ${fmtSide(r.after)}  (${delta})  ${mark}`);
      for (const line of evidenceLines(r, '      ')) L(line);
      const positional = positionalSubtests(r);
      if (positional.length) {
        L(`      NOTE: ${positional.length} subtest name(s) here are positional ("... 2").`);
        L('      They are zero-indexed AFTER the first, so " 2" is the THIRD test()');
        L('      block. Count test( blocks in the source before mapping one.');
      }
    }
  }
  flush();
  process.exit(0);
}

L('Read this in full. Rows are alphabetical, not ranked — subtest delta is not a');
L('measure of importance, and a +1 has turned out to be a shipped feature.');
L('"done" counts files that went from partly failing to fully passing.');
L('JS/Intl features live in third_party/test262, not a web-platform directory.');
if (hasEvidence) {
  L('"+" / "-" lines are the subtest names that changed state: that is the feature');
  L('vocabulary, so read those rather than inferring anything from the filename.');
}
if (!opts.dirs) {
  // Loading subtest names made this listing several times longer, and the obvious
  // response is to page it by line number and strip the "+" lines to fit more on
  // screen. That throws away the 53% of the file that names features, and a line
  // window cuts across directories so a directory shows up with only some of its
  // files. Both alternatives below are bounded and lose nothing.
  L('');
  L(`This is ${groups.length} directories and ${tests.length} files — thousands of lines. Navigate`);
  L('it with the flags, not by paging raw line numbers or grepping out the evidence:');
  L('  --dirs               one line per directory: the map');
  L('  --include <path>     one area in full, evidence intact (repeatable)');
  L('  --checklist <file>   a worksheet with a verdict per directory and per file');
}
L('');

for (const g of groups) {
  const bits = [
    g.forward ? `${g.forward} fwd` : null,
    g.backward ? `${g.backward} back` : null,
    g.completed ? `${g.completed} done` : null,
    g.churn ? `${g.churn} new/gone` : null,
  ].filter(Boolean);
  const delta = g.deltaPass > 0 ? `+${g.deltaPass}` : String(g.deltaPass);
  const allChurn = g.churn === g.rows.length ? '  <- all test-suite churn' : '';
  L(`${g.dir}  [${g.rows.length} file${g.rows.length === 1 ? '' : 's'}, ${delta} subtests, ${bits.join(', ')}]${allChurn}`);
  if (!opts.dirs) {
    for (const r of g.rows) {
      const flag = completed(r)
        ? ' *done*'
        : r.kind === 'added' ? ' (new test)' : r.kind === 'removed' ? ' (test removed)' : '';
      const name = r.test.slice(g.dir === '/' ? 1 : g.dir.length + 1);
      L(`    ${(r.deltaPass > 0 ? `+${r.deltaPass}` : String(r.deltaPass)).padStart(5)}  ${fmtSide(r.before).padEnd(20)} -> ${fmtSide(r.after).padEnd(20)} ${name}${flag}`);
      for (const line of evidenceLines(r, '           ')) L(line);
    }
  }
}
