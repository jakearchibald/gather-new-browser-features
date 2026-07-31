/**
 * Every human-readable view of a collected diff, in one module.
 *
 * wpt-collect.js writes these to disk at collection time; the analysis scripts
 * print filtered slices of the same functions on demand. One implementation, so a
 * directory read from `report.txt` and the same directory read through
 * `wpt-inventory.js --include` can never disagree.
 */

const {
  STATUS_NAMES, isChurn, movedForward, movedBackward, completed,
  dirOf, fmtSide, clip, signed, needsQuoting, shellQuote, toSourcePath,
} = require('./wpt.js');
const { messageRollup, detectRenames } = require('./analyse.js');

function pct(n) {
  return `${(n * 100).toFixed(3)}%`;
}

/**
 * Auto-generated positional subtest names ("...Element 2") carry no meaning and
 * actively mislead: they are zero-indexed *after* the first, so " 2" is the THIRD
 * test() block. SVGAnimatedEnumeration-SVGTextPathElement.html's one newly-passing
 * subtest was "... SVGTextPathElement 2"; its blocks cover method, spacing and
 * side, and it was first read as `spacing` — the second-sounding one — when it was
 * `side`, the feature that shipped.
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
  const s = String(msg).replace(/^assert_\w+:?\s*/, '');
  return /[a-z][A-Z]|\w\.\w|[a-z]-[a-z]|["'][^"']{2,}["']|\(\)/.test(s);
}

/**
 * Does the loaded evidence identify the feature, or must the source be read?
 *
 * Measured, not guessed: a file is opaque when every one of its newly-passing
 * subtests is positionally named AND carries a message that names nothing. That is
 * exactly SVGAnimatedEnumeration-SVGTextPathElement.html and exactly NOT
 * getAnimations.html ("Returns animations on pseudo-element when it is
 * specified"), which an earlier path-shape heuristic flagged identically and
 * wrongly.
 */
function opaquelyNamed(r) {
  const np = r.subtests && r.subtests.newlyPassing;
  if (!np || !np.length) return true;
  return !np.some((s) => !positionalName(s.name) || messageNamesSomething(s.message));
}

/** Subtests whose names are positional, so a number must not be read as an index. */
function positionalSubtests(r) {
  const np = (r.subtests && r.subtests.newlyPassing) || [];
  return np.filter((s) => positionalName(s.name));
}

/**
 * The subtest names behind a file's movement, indented under its row.
 *
 * This is the whole reason the collector loads subtest names. Without them a
 * reader has to infer a feature from a path and then decide whether to spend a
 * separate lookup finding out — a decision made with the least information
 * available, and the one that lost `getAnimations({ pseudoElement })`, whose
 * subtest is named "Returns animations on pseudo-element when it is specified".
 * A verdict is nearly free once the name is on the line; it is separate,
 * skippable work when it is not.
 */
function evidenceLines(r, indent, cap = 4) {
  if (!r.subtests) return [];
  const out = [];
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
    if (hidden > 0) out.push(`${indent}${label} ... and ${hidden} more (wpt-subtests.js for all)`);
  };
  const { newlyPassing, newlyFailing, counts } = r.subtests;
  show(newlyPassing, counts.newlyPassing, '+', 'was:');
  show(newlyFailing, counts.newlyFailing, '-', 'now:');
  return out;
}

/** Group changed tests by directory, alphabetically, with per-directory tallies. */
function groupByDir(tests) {
  const byDir = new Map();
  for (const r of tests) {
    const dir = dirOf(r.test);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(r);
  }
  return [...byDir.entries()]
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
}

function dirBits(g) {
  return [
    g.forward ? `${g.forward} fwd` : null,
    g.backward ? `${g.backward} back` : null,
    g.completed ? `${g.completed} done` : null,
    g.churn ? `${g.churn} new/gone` : null,
  ].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------
// report.txt — the ranked view, plus the two sections that ranking would hide
// ---------------------------------------------------------------------------

function renderReport(report, { top = 40 } = {}) {
  const L = [];
  const p = (s = '') => L.push(s);
  const { before, after } = report;
  const bs = before.stats;
  const as = after.stats;

  p(`# WPT pass-rate diff: ${before.spec} -> ${after.spec}`);
  p('');
  p(`baseline : ${before.product} ${before.browser_version} (${before.spec}), ${before.os}, wpt @ ${before.wpt_revision}, run ${before.run_id}, ${before.time_start}`);
  p(`compare  : ${after.product} ${after.browser_version} (${after.spec}), ${after.os}, wpt @ ${after.wpt_revision}, run ${after.run_id}, ${after.time_start}`);
  if (before.wpt_revision !== after.wpt_revision) {
    p('NOTE     : runs are on different WPT revisions — some diffs are test-suite churn, not browser changes.');
    p('           Re-collect with --aligned for a churn-free comparison.');
  }
  if (before.os !== after.os) {
    p('NOTE     : runs are on different platforms — some diffs are platform differences.');
  }
  p('');
  p('## Overall');
  p(`tests      : ${bs.tests} -> ${as.tests} (${signed(as.tests - bs.tests)})`);
  p(`subtests   : ${bs.total} -> ${as.total} (${signed(as.total - bs.total)})`);
  p(`passing    : ${bs.pass} -> ${as.pass} (${signed(as.pass - bs.pass)})`);
  p(`pass rate  : ${pct(bs.rate)} -> ${pct(as.rate)} (${signed(+((as.rate - bs.rate) * 100).toFixed(3))} pp)`);
  p('');
  p('## Change breakdown (by test file)');
  for (const [k, v] of Object.entries(report.buckets)
    .filter(([k]) => k !== 'unchanged')
    .sort((a, b) => b[1] - a[1])) {
    p(`${k.padEnd(18)} ${v}`);
  }
  p(`${'(unchanged)'.padEnd(18)} ${report.buckets.unchanged || 0}`);
  p('');

  // A test with no subtests cannot be ranked by subtest delta, so it must not share a
  // section with tests that can. That is already why reftests have their own two
  // sections; crashtests need the same treatment for the same reason, and did not get
  // it. Splitting the harness-error sections by whether there are subtests at all
  // gives each group its own --top budget, and costs no duplication.
  const hasSubtests = (r) => (r.after?.total || 0) > 0 || (r.before?.total || 0) > 0;
  const byName = (a, b) => a.test.localeCompare(b.test);

  const sections = [
    ['Regressions (fewer subtests passing)', (r) => r.kind === 'regressed', (a, b) => a.deltaPass - b.deltaPass],
    ['Improvements (more subtests passing)', (r) => r.kind === 'improved', (a, b) => b.deltaPass - a.deltaPass],
    ['Newly broken (harness error/crash/timeout)', (r) => r.kind === 'newly-broken' && hasSubtests(r), null],
    ['Newly running (was error/crash/timeout)', (r) => r.kind === 'newly-running' && hasSubtests(r), null],
    // Crashtests and hang tests. `CRASH 0/0 -> PASS 0/0` is deltaPass 0, so while
    // these shared a section with the rows above they sorted below every partial
    // recovery — `TIMEOUT 0/6 -> OK 3/6` outranked a browser that stopped crashing —
    // and were cut by --top from a 59-row section.
    // /css/css-multicol/content-visibility-001-crash.html and
    // /css/css-page/page-name-002-print.html were both lost that way, and both were
    // real fixes that had to be recovered from the inventory by hand. A crash or hang
    // is the most user-visible failure there is; it should not be the least visible row.
    ['Stopped crashing or hanging (no subtests — crashtests)', (r) => r.kind === 'newly-running' && !hasSubtests(r), byName],
    ['Started crashing or hanging (no subtests — crashtests)', (r) => r.kind === 'newly-broken' && !hasSubtests(r), byName],
    // Reftests carry no subtests, so these rows are all deltaPass 0 and would
    // otherwise never be printed — despite being real rendering fixes.
    ['Now passing with no subtests (reftests: rendering fixes)', (r) => r.statusDirection === 'fixed', (a, b) => a.test.localeCompare(b.test)],
    ['Now failing with no subtests (reftests: rendering regressions)', (r) => r.statusDirection === 'broken', (a, b) => a.test.localeCompare(b.test)],
    [`Tests only in ${after.spec}`, (r) => r.kind === 'added', (a, b) => b.after.total - a.after.total],
    [`Tests only in ${before.spec}`, (r) => r.kind === 'removed', (a, b) => b.before.total - a.before.total],
  ];

  for (const [title, filter, sort] of sections) {
    const list = report.tests.filter(filter);
    if (!list.length) continue;
    if (sort) list.sort(sort);
    p(`## ${title} (${list.length})`);
    // top <= 0 means ALL. slice(0, 0) is [], so treating 0 as a literal cap printed
    // a section with zero rows and a "... and 186 more" line — and since the
    // collector accepts --top, `--top 0` would have written an empty report.txt.
    const shown = top > 0 ? list.slice(0, top) : list;
    for (const r of shown) {
      p(`  ${signed(r.deltaPass).padStart(6)}  ${fmtSide(r.before).padEnd(22)} -> ${fmtSide(r.after).padEnd(22)} ${r.test}`);
    }
    if (shown.length < list.length) {
      p(`  ... and ${list.length - shown.length} more (--top 0 for all; the inventory lists every one)`);
    }
    p('');
  }

  p('## Biggest movers by area');
  for (const a of report.areas
    .filter((x) => x.deltaPass !== 0 || x.statusFixed || x.statusBroken)
    .slice(0, 30)) {
    const rate = a.deltaRate === null ? '' : ` (${pct(a.beforeRate)} -> ${pct(a.afterRate)})`;
    // An area can be all reftests, where the subtest delta is 0 and the flip
    // counts are the entire story.
    const flips = [
      a.statusFixed ? `${a.statusFixed} now passing` : null,
      a.statusBroken ? `${a.statusBroken} now failing` : null,
    ].filter(Boolean);
    p(`  ${signed(a.deltaPass).padStart(7)} subtests  ${a.area}${rate}${flips.length ? `  [no subtests: ${flips.join(', ')}]` : ''}`);
  }
  p('');

  // An all-reftest area has deltaPass 0 everywhere, so it sorts below every area
  // that moved a single subtest and never survives the slice above — even when
  // dozens of rendering tests started passing. List those separately.
  const reftestOnly = report.areas
    .filter((a) => a.deltaPass === 0 && (a.statusFixed || a.statusBroken))
    .sort((x, y) => y.statusFixed + y.statusBroken - (x.statusFixed + x.statusBroken));
  if (reftestOnly.length) {
    p('## Areas that moved only in tests with no subtests (reftests)');
    for (const a of reftestOnly.slice(0, 30)) {
      const flips = [
        a.statusFixed ? `${a.statusFixed} now passing` : null,
        a.statusBroken ? `${a.statusBroken} now failing` : null,
      ].filter(Boolean);
      p(`  ${a.area.padEnd(34)} ${flips.join(', ')}`);
    }
    if (reftestOnly.length > 30) p(`  ... and ${reftestOnly.length - 30} more`);
    p('');
  }

  if (report.clusters.length) {
    p('## Directory clusters (many files in one directory moved the same way)');
    p('# Ranked by moved-file count, not subtest delta, so a feature that landed as');
    p('# many tiny gains still shows up. Only a lead, not coverage: a feature that');
    p('# moved one file, or moved files both ways, is absent. Filters applied:');
    p(`# >=${report.clusterMin} moved files, >=${Math.round(report.clusterRatio * 100)}% one direction, added/removed tests not counted.`);
    p('# For coverage, read inventory.txt in full.');
    // Printed in full, deliberately not truncated: the filters above already cut
    // 121k tests to a few dozen rows, and truncating by rank would reintroduce the
    // failure this section exists to prevent — the cluster that got missed sat one
    // row past a top-20 cut.
    for (const c of report.clusters) {
      const dir = c.improved >= c.regressed ? `${c.improved} improved` : `${c.regressed} regressed`;
      const churn = c.churn ? `  (+${c.churn} new/gone)` : '';
      p(`  ${String(c.moved).padStart(4)} files  ${signed(c.deltaPass).padStart(7)} subtests  ${dir.padEnd(14)} /${c.dir}${churn}`);
    }
    p('');
  }

  if (report.vocabulary && report.vocabulary.length) {
    p('## One feature, several directories (shared newly-passing subtest words)');
    p('# Mechanical version of "group by feature, not by directory": each token');
    p('# below appears in newly-passing subtest names under 2+ directories, so it is');
    p('# probably one change surfacing in several places. Report it once.');
    for (const v of report.vocabulary.slice(0, 25)) {
      p(`  ${v.token.padEnd(28)} ${v.dirs.length} dirs: ${v.dirs.slice(0, 4).map((d) => `/${d}`).join(' ')}${v.dirs.length > 4 ? ' …' : ''}`);
    }
    if (report.vocabulary.length > 25) p(`  ... and ${report.vocabulary.length - 25} more (see diff.json)`);
    p('');
  }

  return L;
}

// ---------------------------------------------------------------------------
// inventory.txt — every changed file, ranked by nothing
// ---------------------------------------------------------------------------

/**
 * Every changed test file, grouped by directory, for reading end to end.
 *
 * Every other view ranks by magnitude. Ranking is the wrong tool for this job,
 * because **subtest count is not a signal of importance**: the delta of a fix
 * measures how many assertions happened to still be failing beforehand.
 *
 *   css/selectors/webkit-pseudo-element.html    5/6  -> 6/6   (+1)
 *   .../customizable-select/select-parsing.html 10/17 -> 17/17 (+7)
 *
 * Both are real, developer-facing features. Both were dismissed as noise on a real
 * pass because +1 and +7 look like rounding error next to a +664. No threshold or
 * cleverer ranking fixes that, because the premise is wrong. So this view selects
 * nothing and sorts alphabetically.
 */
/** One directory's block: its header line, and its files with their evidence. */
function groupLines(g, dirsOnly) {
  const out = [];
  const allChurn = g.churn === g.rows.length ? '  <- all test-suite churn' : '';
  out.push(`${g.dir}  [${g.rows.length} file${g.rows.length === 1 ? '' : 's'}, ${signed(g.deltaPass)} subtests, ${dirBits(g)}]${allChurn}`);
  if (dirsOnly) return out;
  for (const r of g.rows) {
    const flag = completed(r)
      ? ' *done*'
      : r.kind === 'added' ? ' (new test)' : r.kind === 'removed' ? ' (test removed)' : '';
    const name = r.test.slice(g.dir === '/' ? 1 : g.dir.length + 1);
    out.push(`    ${signed(r.deltaPass).padStart(5)}  ${fmtSide(r.before).padEnd(20)} -> ${fmtSide(r.after).padEnd(20)} ${name}${flag}`);
    for (const line of evidenceLines(r, '           ')) out.push(line);
  }
  return out;
}

/**
 * Pack directory blocks into parts that each fit a character budget.
 *
 * Split points are always directory boundaries, never line offsets. That is the
 * whole point: a full inventory is ~86KB for a channel diff and several hundred KB
 * for a two-release one, so it does not fit in one tool result — and the obvious
 * workaround, redirecting it to a file and reading line ranges, reintroduces the
 * exact failure this view exists to prevent. A line window cuts across a
 * directory, so the directory appears with only some of its files and nothing says
 * so. Packing whole directories cannot do that.
 *
 * A single directory bigger than the budget becomes its own oversized part rather
 * than being split — /css/css-inline/text-box-trim is 177 lines by itself.
 */
function paginate(blocks, budget) {
  const parts = [];
  let current = [];
  let size = 0;
  for (const b of blocks) {
    const cost = b.lines.reduce((s, l) => s + l.length + 1, 0);
    if (current.length && size + cost > budget) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(b);
    size += cost;
  }
  if (current.length) parts.push(current);
  return parts.length ? parts : [[]];
}

function renderInventory(report, tests, {
  dirsOnly = false, filters = [], navHint = true, part = 1, budget = 25000, all = false,
  resume = 'node scripts/wpt-inventory.js',
} = {}) {
  const L = [];
  const p = (s = '') => L.push(s);
  const groups = groupByDir(tests);
  const blocks = groups.map((g) => ({ g, lines: groupLines(g, dirsOnly) }));

  // --dirs is paginated too. It is one line per directory, which looks like it
  // always fits — but that is ~71 bytes each, and a two-release diff runs to
  // 200-400 directories, so the map alone reaches the output limit and gets cut by
  // the harness with no marker. The budget makes that a deliberate, labelled break
  // instead. Small diffs are unaffected: 124 directories is 8.8KB, one part.
  const parts = all ? [blocks] : paginate(blocks, budget);
  const index = Math.min(Math.max(1, part), parts.length);
  const chosen = parts[index - 1];
  const paged = parts.length > 1;

  // Where this part sits in the whole, by directory ordinal, so coverage is
  // countable rather than felt.
  const before = parts.slice(0, index - 1).reduce((s, x) => s + x.length, 0);
  const firstDir = before + 1;
  const lastDir = before + chosen.length;

  p(`# Changed-test inventory: ${report.before.spec} -> ${report.after.spec}`);
  p('');
  p(`${tests.length} changed test files in ${groups.length} directories${filters.length ? ` (${filters.join(', ')})` : ''}.`);
  if (paged) {
    p('');
    p(`!! PART ${index} OF ${parts.length} — THIS IS NOT THE WHOLE INVENTORY.`);
    p(`!! Showing directories ${firstDir}-${lastDir} of ${groups.length}, split at directory`);
    p('!! boundaries so no directory is ever shown partially.');
    p(index === parts.length
      ? `!! This is the final part; directories 1-${firstDir - 1} are in parts 1-${parts.length - 1}.`
      : '!! Read every part.');
  }
  p('');
  p('Read this in full. Rows are alphabetical, not ranked — subtest delta is not a');
  p('measure of importance, and a +1 has turned out to be a shipped feature.');
  p('"done" counts files that went from partly failing to fully passing.');
  p('JS/Intl features live in third_party/test262, not a web-platform directory.');
  p('"+" / "-" lines are the subtest names that changed state: that is the feature');
  p('vocabulary, so read those rather than inferring anything from the filename.');
  if (!dirsOnly && navHint) {
    p('');
    p(`This is ${groups.length} directories and ${tests.length} files. Navigate it with the flags below,`);
    p('NOT by redirecting to a file and reading line ranges — a line window cuts across');
    p('a directory, so it shows up with only some of its files and nothing says so:');
    p('  wpt-inventory.js <dir> --dirs             one line per directory: the map');
    p('  wpt-inventory.js <dir> --part <n>         the next whole-directory page');
    p('  wpt-inventory.js <dir> --include <path>   one area in full, evidence intact');
    p('  wpt-subtests.js  <dir> <path>             one file, every subtest and message');
  }
  p('');

  for (const b of chosen) for (const line of b.lines) p(line);

  if (paged) {
    p('');
    p(`!! END OF PART ${index} OF ${parts.length}. You have seen directories ${firstDir}-${lastDir} of ${groups.length}.`);
    if (index < parts.length) {
      p(`!! NOT YET READ: directories ${lastDir + 1}-${groups.length}. Continue with:`);
      // The caller's own flags, not a `<dir>` placeholder. The placeholder was both
      // unpasteable — `<dir>` is a shell redirect — and wrong: it dropped whatever
      // --include or --grep was narrowing the listing, so following it silently paged
      // through a DIFFERENT, unfiltered set of directories than the one being read.
      p(`!!   ${resume} --part ${index + 1}`);
    } else {
      p('!! That was the last part. Every directory has now been printed at least once.');
    }
  }
  return L;
}

// ---------------------------------------------------------------------------
// checklist.md — the coverage worksheet
// ---------------------------------------------------------------------------

/**
 * A worksheet with a verdict per directory and per file.
 *
 * The Popover API hint/auto rework was missed on a real pass while this line was
 * on screen:
 *
 *   /html/semantics/popovers  [5 files, +19 subtests, 5 fwd, 5 done]
 *
 * It was printed, read, quoted in conversation as "not yet examined", and then
 * never examined — five files, every one *done*, the strongest signal the tooling
 * emits. No additional signal would have helped, because the signal was already
 * maximal. What was missing was a completion criterion.
 *
 * The per-directory worksheet was then itself not enough, and failed the same way
 * one release later: /svg/types/scripted was ticked as "mostly new SVGLength
 * tests", true of five files and wrong about the sixth, which was
 * SVGTextPathElement.side shipping. A directory verdict absorbs the files inside
 * it, and "3 done" is a number you skim rather than a question you answer. Hence
 * a second worksheet at file granularity.
 */
/**
 * Group boxed files by the source file they are variants of.
 *
 * A `?class=`, `?include=` or `?exclude=` parameter selects which slice of a
 * reftest runs or which subtests are enabled. It does not change what feature the
 * file covers, so N variants ask the same question N times — and a worksheet that
 * asks the same question seventeen times gets sixteen transcriptions and one check.
 *
 * That is not hypothetical. One real pass answered
 * text-box-trim-start-001.html seventeen separate times, every answer a rewording
 * of "trim-start variant, see ?class=auto", and text-box-trim-end-001.html sixteen
 * more. 47 of 292 file boxes on that diff were variants of a file already boxed —
 * a sixth of the worksheet spent re-answering, which is time taken directly from
 * the boxes that were genuinely distinct.
 */
function collapseVariants(rows) {
  const groups = new Map();
  for (const r of rows) {
    // Same source file AND the same transition. Same-source-only would fold a
    // window/worker divergence away, and that divergence is itself the finding: on
    // one real diff basic-auth.any.html newly passed while
    // basic-auth.any.sharedworker.html regressed, and "the same test moved both ways
    // in two globals" is a flake signal that exists only as a comparison between the
    // two. Keying on the transition also means one odd variant out of seventeen gets
    // its own box instead of preventing the other sixteen from folding.
    const key = `${toSourcePath(r.test)} ${fmtSide(r.before)} -> ${fmtSide(r.after)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()];
}

/**
 * A substring that selects a whole variant family for --grep, i.e. the filename
 * with every generated suffix stripped: `no-vary-search.tentative.any.html` ->
 * `no-vary-search`. Handed to the reader so reading all seventeen variants is one
 * command with no `?`, no `|` and nothing to quote.
 */
function grepFragment(testPath) {
  let seg = String(testPath).replace(/\?.*$/, '').split('/').pop();
  const SUFFIX = /\.(html|htm|xhtml|xht|js|py|svg|any|window|worker|serviceworker|sharedworker|https|h2|tentative|sub|optional)$/i;
  for (let i = 0; i < 8; i++) {
    const next = seg.replace(SUFFIX, '');
    if (next === seg) break;
    seg = next;
  }
  return seg;
}

function renderChecklist(report, tests) {
  const L = [];
  const p = (s = '') => L.push(s);
  const groups = groupByDir(tests);
  const churnOnly = groups.filter((g) => g.churn === g.rows.length);
  const needsVerdict = groups.filter((g) => g.churn !== g.rows.length);

  p(`# Coverage checklist: ${report.before.spec} -> ${report.after.spec}`);
  p('');
  p(`${needsVerdict.length} directories need a verdict. ${churnOnly.length} are pre-resolved`);
  p('as test-suite churn (added/removed tests only — different WPT revisions).');
  p('');
  p('Work top to bottom. Replace EVERY box with an x and append " — <verdict>",');
  p('where the verdict is one of:');
  p('  [x] /some/dir  — written up: <the feature, as it appears in the notes>');
  p('  [x] /some/dir  — explained: same feature as <name the other entry>');
  p('  [x] /some/dir  — not a feature: <infrastructure, flake or churn, and why>');
  p('');
  p('wpt-inventory.js --verify enforces all three shapes, so a box ticked with no');
  p('verdict, or "explained" with nothing named after it, fails the gate exactly as');
  p('an unticked box does. "explained" without a target is not an explanation — it');
  p('reads as one while saying only that the line has been set aside.');
  p('Do not leave a line unticked, and do not stop at the interesting-looking ones.');
  p('A 5-file all-done directory was skipped that way once.');
  p('');
  for (const g of needsVerdict) {
    p(`[ ] ${g.dir}  (${g.rows.length}f, ${signed(g.deltaPass)}, ${dirBits(g)})`);
  }
  p('');
  p(`--- pre-resolved as churn (${churnOnly.length}), no verdict needed ---`);
  for (const g of churnOnly) p(`[x] ${g.dir}  (${g.rows.length}f, churn)`);

  // Boxed set = every *done* file (the strongest feature signal, and independent
  // of delta size) plus every file whose loaded evidence cannot name its own
  // feature. *done* alone was not enough: getAnimations.html went 29/34 -> 33/34
  // for `{ pseudoElement }` and is not *done* because ::part() still fails, so a
  // done-only worksheet gave it no box and it became an unexplained "+1".
  const boxed = tests
    .filter((r) => completed(r) || (movedForward(r) && opaquelyNamed(r)))
    .sort((a, b) => a.test.localeCompare(b.test));
  // One box per source file, not per generated variant.
  const families = collapseVariants(boxed);
  const collapsed = boxed.length - families.length;
  const partial = families.filter((f) => !f.every(completed)).length;
  const opaque = families.filter((f) => f.every(opaquelyNamed)).length;

  if (families.length) {
    p('');
    p(`## File checklist (${families.length})`);
    p('');
    p('Every file that reached 100% — "last failures cleared" — plus every file');
    p(`whose evidence cannot name its own feature (${partial} of these have not finished).`);
    p('A small delta here means "small because it was nearly finished", NOT "small');
    p('because it does not matter", and a file short of 100% can still be a shipped');
    p('feature with one edge case outstanding. Ticking a directory above does NOT');
    p('tick these: name the feature each covers, or say why it is not one.');
    p('');
    p(`A "(?)" box (${opaque}) marks a file whose evidence names nothing — positional`);
    p('subtest names and messages like "assert_true: expected true got false".');
    p('Measured from the loaded subtest names, not guessed from the path. For those');
    p('only, read the source:  node scripts/wpt-fetch-tests.js <dir> <path> --head 0');
    if (collapsed) {
      p('');
      p(`${collapsed} generated variant(s) are folded into the box for their source file:`);
      p('a ?class= or ?include= parameter picks which slice runs, not which feature the');
      p('file covers, so they are one question. The folded variants are listed under');
      p('each box — ONE verdict covers the family.');
    }
    p('');
    for (const family of families) {
      const rep = family.find((r) => !opaquelyNamed(r)) || family[0];
      // Name the family by the test path when the variants differ only by ?query, and
      // by the source file when they are separate globals of one .any.js.
      const stripped = [...new Set(family.map((r) => r.test.replace(/\?.*$/, '')))];
      const base = stripped.length === 1 ? stripped[0] : `/${toSourcePath(rep.test)}`;
      // "(?)" / "( )" rather than "[?]" / "[ ]": the directory worksheet above uses
      // square brackets, and when both used them neither list could be counted or
      // grepped apart. A family is only opaque when NO variant names its feature —
      // one variant with usable evidence answers for the whole file.
      const box = family.every(opaquelyNamed) ? '(?)' : '( )';
      const allDone = family.every(completed);
      const mark = allDone ? '*done*' : 'still failing some — check anyway';

      if (family.length === 1) {
        const r = family[0];
        // The checklist is the durable artifact, and the place a path most often gets
        // copied from into a follow-up command — so what it offers to be copied has to
        // be a command that runs without a permission prompt.
        //
        // This used to read `[quote it: '/a/b.html?x=(y|z)']`, which was advice that
        // solved the wrong half of the problem. Quoting is what the SHELL needs; the
        // permission matcher sees the raw string either way, and a `?` or `|` in it
        // stops the command being pre-approved however carefully it is escaped. So the
        // worksheet was handing the reader a path that could not be pasted, and it was
        // pasted: `wpt-subtests.js '/html/syntax/parsing/html5lib_url.html?file=webkit02'`
        // prompted, exactly as offered. --grep reaches the same test with no
        // metacharacters at all, and since variants now fold into families, the stem
        // identifies this box uniquely within the diff.
        const fragment = grepFragment(r.test);
        p(`${box} ${r.test}${needsQuoting(r.test) ? `   [reach it with: --grep ${fragment}]` : ''}`);
        p(`      ${fmtSide(r.before)} -> ${fmtSide(r.after)}  (${signed(r.deltaPass)})  ${mark}`);
      } else {
        const delta = family.reduce((a, r) => a + r.deltaPass, 0);
        const doneCount = family.filter(completed).length;
        // "0 *done*, +0 subtests" is true of a reftest family and tells you nothing:
        // a reftest contributes no subtests, so its whole result is the status flip.
        // Report the transition when every variant made the same one, which is the
        // normal case for a family and the thing that makes a rendering fix visible.
        const transitions = [...new Set(family.map((r) => `${fmtSide(r.before)} -> ${fmtSide(r.after)}`))];
        const bits = [`${family.length} variants`];
        if (transitions.length === 1) bits.push(`all ${transitions[0]}`);
        else bits.push(`${transitions.length} distinct transitions`);
        if (delta) bits.push(`${signed(delta)} subtests total`);
        if (doneCount === family.length) bits.push('*done*');
        else if (doneCount) bits.push(`${doneCount} *done*`);
        p(`${box} ${base}   [${family.length} variants]`);
        p(`      ${bits.join(', ')}`);
        p(`      read all ${family.length}:  node scripts/wpt-subtests.js --grep ${grepFragment(base)}`);
        // Listed, never summarised away: a folded variant the reader cannot see is a
        // box that silently stopped existing.
        let line = '      variants:';
        for (const r of family) {
          const q = r.test.slice(base.length) || '(no query)';
          if (line.length + q.length + 1 > 92) {
            p(line);
            line = '               ';
          }
          line += ` ${q}`;
        }
        p(line);
        p(`      evidence from ${rep.test.slice(base.length) || '(no query)'}: `
          + `${fmtSide(rep.before)} -> ${fmtSide(rep.after)}  (${signed(rep.deltaPass)})`);
      }
      for (const line of evidenceLines(rep, '      ')) p(line);
      const positional = positionalSubtests(rep);
      if (positional.length) {
        p(`      NOTE: ${positional.length} subtest name(s) here are positional ("... 2").`);
        p('      They are zero-indexed AFTER the first, so " 2" is the THIRD test()');
        p('      block. Count test( blocks in the source before mapping one.');
      }
    }
  }
  return L;
}

/** Every box line's path, in file order. One parser, used on both sides of --verify. */
function boxPaths(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(?:\[[ x]\]|\([ ?x]\))\s+(\S+)/i);
    if (m) out.push(m[1]);
  }
  return out;
}

// Phrases that occupy the space where an answer goes. "written up — see notes" is
// the canonical one, and it is what a bulk-apply script reaches for as its
// fallback: one real attempt at resolving this worksheet by regex ended
// `return line.replace('[ ]', '[x]') + '  — written up — see notes'`, which would
// have stamped every box no rule matched and passed the gate on all 416.
// Deliberately not "unknown": it is ordinary wording inside a quoted assertion
// message, and blocking it rejected a good verdict whose evidence was the harness
// error `unknown command browsingContext.stopScreencast`. A non-answer list has to
// match how a verdict defers, not any word that sounds vague.
const NON_ANSWER = /\b(see notes?|see above|see below|as above|as described|as discussed|various|miscellaneous|tbd|todo|n\/a)\b/i;

// The three verdict kinds, however they are punctuated.
const VERDICT_KIND = /\b(written[ -]up|explained|not[ -]a[ -]feature|churn)\b/i;

// Words too generic to be a reference to anything.
const STOPWORDS = new Set(`same feature features cause causes group grouped groups
this that these those with from into than then also only both each more most some
other another above below part parts covered belongs entry entries test tests file
files variant variants case cases thing things issue issues bug bugs fix fixes fixed
work item items section sections note notes here there where which what when does
done been being have has had was were will would could should must may might real
still just like about over under after before same see and the for not but all any
one two three onwards etc via per new old own set way its it's whole rest side`
  .split(/\s+/).filter(Boolean));

/**
 * Does an "explained" verdict point at something the worksheet actually contains?
 *
 * "explained" means "same cause as another entry — name which", and a verdict that
 * names nothing is not an explanation. It reads as one while saying only that the
 * line has been set aside, and nothing can check it.
 *
 * The obvious test — does the verdict contain "see" or "same as"? — is wrong, and
 * measurably so: on a real resolved worksheet it flagged 28 verdicts, and all 28
 * were fine. `explained: sibling-index() in anchor() (tree-counting)` names
 * /css/css-values/tree-counting, and `explained: BiDi user contexts` is verbatim
 * another box's *written up* verdict. Both are exactly what "name which" asks for,
 * in neither of the two phrasings the pattern knew about.
 *
 * So resolve it instead of pattern-matching it: some distinctive word in the verdict
 * has to appear in ANOTHER box's path, or in some box's "written up" verdict. That
 * is the invariant the instruction is actually asking for, it holds regardless of
 * phrasing, and it makes the worksheet internally consistent — every deferral
 * points at something else in the worksheet, so following a chain of them
 * terminates somewhere real.
 */
function explainedResolves(verdict, ownPath, paths, writtenUpText) {
  const words = String(verdict).toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) || [];
  // Hyphenated identifiers also count by their parts, so "focused-target" can
  // resolve against a verdict that says "focused".
  const parts = words.flatMap((w) => w.split(/[-_]/)).filter((s) => s.length >= 5);
  const tokens = [...new Set([...words, ...parts])]
    .filter((t) => !STOPWORDS.has(t) && t !== 'explained');
  if (tokens.some((t) => (
    writtenUpText.includes(t)
    // Another box's path, not its own: a verdict echoing the directory it sits on
    // defers to itself, which terminates nowhere.
    || paths.some((q) => q !== ownPath && q.includes(t))
  ))) return true;

  // "same as 066" / "same as -001": a numbered sibling. The reference is exact even
  // though the token is three digits and would never survive a relevance filter, so
  // resolve it structurally — substitute the number into the numeric run of this
  // box's own path and see whether that names another box. All five such verdicts on
  // one real worksheet pointed at a file that was genuinely boxed; a check that
  // rejected them would have been teaching the reader to write worse verdicts.
  const nums = String(verdict).match(/\d{2,}/g) || [];
  const runs = [...ownPath.matchAll(/\d{2,}/g)];
  return nums.some((n) => runs.some((m) => {
    const cand = ownPath.slice(0, m.index) + n + ownPath.slice(m.index + m[0].length);
    return cand !== ownPath && paths.includes(cand);
  }));
}

/** The text after the box and path, i.e. the reader's verdict. */
function verdictOf(line) {
  const m = String(line).match(/\s(?:—|–|--|-)\s+(.+)$/);
  return m ? m[1].trim() : '';
}

/**
 * Audit a worksheet: unticked boxes, ticked boxes whose verdict is not an answer,
 * and boxes that stopped existing.
 *
 * The point of a checklist is a completion criterion, and a criterion nobody can
 * evaluate is just advice with punctuation. Two features were lost after the
 * worksheet existed, both by stopping early, so stopping early became an exit code.
 *
 * Counting ticks was then not enough either, twice over. It certified "every line I
 * still have has an x on it":
 *
 *   - A tick with no verdict passed. So did `— written up — see notes`. The gate
 *     checked the box and never read the answer.
 *   - Nothing recorded which boxes were supposed to exist. A pass that resolved the
 *     worksheet by rewriting it whole dropped 4 evidence lines and stripped all 49
 *     paste helpers while leaving the count at 416, so the gate saw nothing. Nothing
 *     load-bearing was lost that time. A dropped *box* would have been invisible,
 *     and invisible is the entire failure mode this file exists to prevent.
 *
 * `expected` is the box list recorded at collection time (boxes.json). Absent —
 * an artifact collected before it was written — the inventory check is skipped and
 * says so, rather than silently reporting a clean bill of health it did not check.
 */
function verifyChecklist(text, expected = null) {
  const open = [];
  const bad = [];
  let done = 0;

  // Pass 1: classify every box. The "explained" check needs the whole worksheet
  // before it can resolve anything, so nothing is judged until all of it is read.
  const ticked = [];
  for (const line of String(text).split('\n')) {
    // Directory boxes are [ ]/[x]; file boxes are ( )/(?)/(x). Anything the reader
    // has replaced with an x counts as resolved.
    if (/^(\[ \]|\(\s\)|\(\?\))/.test(line)) {
      open.push(line.trim());
      continue;
    }
    if (!/^(\[x\]|\(x\))/i.test(line)) continue;
    done++;
    const t = line.trim();
    const m = t.match(/^(?:\[x\]|\(x\))\s+(\S+)/i);
    ticked.push({ line: t, path: m ? m[1].toLowerCase() : '', verdict: verdictOf(t) });
  }

  const paths = ticked.map((b) => b.path).filter(Boolean);
  const writtenUpText = ticked
    .filter((b) => /\bwritten[ -]up\b/i.test(b.verdict))
    .map((b) => b.verdict.toLowerCase())
    .join('\n');

  // Pass 2: judge each verdict.
  for (const b of ticked) {
    // Churn directories are pre-resolved by the generator and carry no verdict.
    if (/,\s*churn\)/i.test(b.line)) continue;
    if (!b.verdict) {
      bad.push({ line: b.line, why: 'ticked, but carries no verdict at all' });
      continue;
    }
    if (NON_ANSWER.test(b.verdict)) {
      bad.push({ line: b.line, why: 'the verdict defers instead of answering' });
      continue;
    }
    const kind = b.verdict.match(VERDICT_KIND);
    if (!kind) {
      bad.push({ line: b.line, why: 'verdict names no kind (written up / explained / not a feature)' });
      continue;
    }
    // A bare kind with no detail is the same non-answer in fewer words.
    if (b.verdict.replace(VERDICT_KIND, '').replace(/[\s:.,;—–-]+/g, '').length === 0) {
      bad.push({ line: b.line, why: `"${kind[1]}" with no detail — say which feature, or why not one` });
      continue;
    }
    if (/^explained$/i.test(kind[1])
      && !explainedResolves(b.verdict, b.path, paths, writtenUpText)) {
      bad.push({
        line: b.line,
        why: '"explained" but nothing it names appears in another box or in any "written up" verdict',
      });
    }
  }

  const seen = boxPaths(text);
  let missing = [];
  let extra = [];
  if (expected) {
    const have = new Set(seen);
    const want = new Set(expected);
    missing = expected.filter((p) => !have.has(p));
    extra = seen.filter((p) => !want.has(p));
  }
  return {
    open, bad, done, total: open.length + done, missing, extra, inventoryChecked: !!expected,
  };
}

// ---------------------------------------------------------------------------
// One file, in full — every subtest and every message
// ---------------------------------------------------------------------------

/**
 * The complete subtest picture for one test file, with the assertion messages.
 *
 * A subtest count names a file, not a cause. Sections a feature description is
 * built from are never silently truncated here: a partial read of the RIGHT file
 * is harder to notice than not reading it at all. One pass characterised
 * webrtc-stats/supported-stats.https.html from the tail of its 24 newly-passing
 * subtests and missed the 12 RTCTransportStats properties in the middle.
 */
/**
 * The transition categories a per-file view can be narrowed to.
 *
 * "Show me just what newly passes" is a category question, and without a flag for
 * it the answer is a shell grep on the rendered arrow — which is lossy in a way
 * that is invisible. `grep 'FAIL    -> PASS'` misses a subtest that was NOTRUN or
 * TIMEOUT before, and misses `(new)   -> PASS` entirely. That second one is how an
 * ENTIRELY NEW interface shows up, so the pattern fails hardest on exactly the
 * claim it tends to be used to check: on one real diff it under-reported in 19
 * files, hiding 55 new-subtest passes and 13 non-FAIL priors.
 *
 * `newly-passing` deliberately spans both fixes and brand-new assertions, so this
 * cannot under-report the way the grep does.
 */
const CATEGORIES = ['newly-passing', 'newly-failing', 'changed', 'removed', 'still-failing'];

function renderFile(report, r, { limit = 0, match = null, matchLabel = null, only = null } = {}) {
  const show = (cat) => !only || only.has(cat);
  const L = [];
  const p = (s = '') => L.push(s);
  const st = r.subtests;

  p('='.repeat(74));
  p(`# ${r.test}`);
  // A variant path like `?exclude=(file|javascript|mailto)` cannot be pasted into a
  // command as-is: `?` globs, `(...)` groups and `|` pipes, so the shell fails before
  // node runs and nothing can report why. 17% of changed paths in one real comparison
  // needed this.
  //
  // Quoting fixes that, and it is genuinely required if you pass the path literally —
  // but it fixes only the shell. The permission matcher sees the raw string either
  // way, so a quoted `?query` path still stops being pre-approved and still prompts.
  // This block used to say `# paste as: '<quoted>'`, which read as "this is the form
  // to use" and was then used: a real pass pasted
  // `wpt-subtests.js '/html/syntax/parsing/html5lib_url.html?file=webkit02'` and hit
  // the prompt the label had implied it was avoiding.
  //
  // So --grep leads, because it has no metacharacters to escape in the first place,
  // and the quoted form stays as the literal-path fallback it actually is. Neither
  // line begins with a runnable `node scripts/` prefix, so the quoted path is never
  // the thing sitting in the copy position.
  if (needsQuoting(r.test)) {
    p(`# reach it with:  --grep ${grepFragment(r.test)}`);
    p(`# or as a literal path, shell-quoted: ${shellQuote(r.test)}`);
    p('#   (the quotes are what the shell needs; the command will still ask permission)');
  }
  p('='.repeat(74));
  p('');
  p(`kind     : ${r.kind}${r.statusDirection ? ` (${r.statusDirection})` : ''}`);
  p(`harness  : ${STATUS_NAMES[r.before?.status] || r.before?.status || '(absent)'} -> ${STATUS_NAMES[r.after?.status] || r.after?.status || '(absent)'}`);
  p(`subtests : ${r.before ? `${r.before.pass}/${r.before.total}` : '-'} -> ${r.after ? `${r.after.pass}/${r.after.total}` : '-'} passing`);
  if (r.before?.message) p(`baseline harness message: ${clip(r.before.message, 300)}`);
  if (r.after?.message) p(`compare harness message : ${clip(r.after.message, 300)}`);

  if (!st) {
    p('');
    p('No subtest data. Reftests and skipped tests legitimately have none — the whole');
    p('result is the harness status above.');
    return L;
  }

  const keep = (rows) => (match ? (rows || []).filter((s) => match(s.name) || match(s.message || '')) : rows || []);

  // ---- synopsis, FIRST ----
  //
  // This used to sit at the bottom, which put the one thing that tells you the
  // *shape* of a file behind up to several hundred lines of detail — so any
  // truncation destroyed exactly the part worth keeping. A reader who slices this
  // output with `head` now still gets the counts and the dominant causes; they
  // lose examples, which is recoverable, rather than the conclusion, which isn't.
  const counts = st.counts;
  p('');
  p('## Synopsis');
  p(`  ${counts.newlyPassing} newly passing, ${counts.newlyFailing} newly failing, ` +
    `${counts.changed} failure changed, ${counts.removed} removed`);
  p(`  ${counts.stillFailing} failing in both runs, ${counts.passingBoth} passing in both`);

  // Both directions get a rollup. A dominant shape among the FIXES means one bug
  // was fixed and unblocked many tests; a dominant shape among what STILL FAILS
  // names the limitation precisely, which is the other half of an honest note.
  for (const [label, list, note] of [
    ['fixes', st.newlyPassing, 'ONE bug fixed unblocking many tests — not many separate fixes'],
    ['still-failing', st.stillFailing, 'ONE remaining limitation, not many scattered failures'],
  ]) {
    const rollup = messageRollup(list);
    if (!rollup.length || rollup[0].count < 2) continue;
    const share = `${rollup[0].count}/${list.length}`;
    p('');
    p(`  dominant ${label} message (${share}) — if this accounts for most of them, that is`);
    p(`  ${note}:`);
    for (const { message, count } of rollup.slice(0, 4)) {
      p(`    ${String(count).padStart(3)}x  ${message}`);
    }
    // One unabridged example per rollup. These messages carry the cause in their
    // expected-vs-got tail, and the normalised key necessarily strips exactly that
    // — so without an exemplar the reader has to run a second command to find out
    // what the dominant bug actually was, which is how "the second percentage was
    // dropped on serialization" needed digging for rather than being on screen.
    p('    e.g. ' + clip(rollup[0].example, 300));
  }

  // A renamed subtest at a fixed revision is a behaviour change, and reads as churn
  // because "added"/"removed" are the same words used for genuine test-suite churn.
  // Announced before any filtering, because --only newly-passing hides the removed
  // half and that is precisely how the pairing became invisible.
  const sameRevision = report.before.wpt_revision === report.after.wpt_revision;
  const renames = detectRenames(st);
  if (renames.paired) {
    p('');
    if (sameRevision) {
      p(`  !! ${renames.paired} subtest(s) were RENAMED, not added or removed. Both runs are at`);
      p(`  !! WPT revision ${report.after.wpt_revision}, so the test source is byte-identical —`);
      p('  !! no test was rewritten. These names embed a value the browser computes, so a');
      p('  !! rename means THE COMPUTED VALUE CHANGED. That is a behaviour change, and the');
      p('  !! strongest kind. Do NOT write it off as test churn.');
    } else {
      p(`  ${renames.paired} subtest(s) look renamed rather than added/removed. The runs are at`);
      p(`  different revisions (${report.before.wpt_revision} -> ${report.after.wpt_revision}), so this`);
      p('  may be a rewritten test OR a changed computed value — compare the pair below.');
    }
    for (const e of renames.examples) {
      p(`      was: ${clip(e.was, 110)}`);
      p(`      now: ${clip(e.now, 110)}`);
    }
  }

  if (match || only) {
    p('');
    const how = [
      match ? `matching ${matchLabel}` : null,
      only ? `in ${[...only].join(', ')}` : null,
    ].filter(Boolean).join(' and ');
    p(`  FILTERED to subtests ${how}. Counts above are the file's true totals;`);
    p('  the sections below show only what matched.');
    // Naming the non-empty categories being suppressed. `--only newly-passing` on a
    // file with 20 removed subtests hid exactly the half that showed 20 "new"
    // subtests were renames of the old ones.
    if (only) {
      const hidden = [
        ['newly-passing', counts.newlyPassing],
        ['newly-failing', counts.newlyFailing],
        ['changed', counts.changed],
        ['removed', counts.removed],
        ['still-failing', counts.stillFailing],
      ].filter(([name, n]) => n > 0 && !only.has(name));
      if (hidden.length) {
        p(`  HIDDEN by --only: ${hidden.map(([n, c]) => `${c} ${n}`).join(', ')}.`);
        p('  Those may explain what you are looking at — re-run without --only if unsure.');
      }
    }
  }

  // Entries are collected rather than printed, so the caller can page them at entry
  // boundaries. A 213-fix file renders to 66KB — over twice the tool output limit —
  // so the bare command simply failed, and the reflex fallback of piping to `head`
  // cuts mid-entry and loses the section titles.
  const entries = [];
  const section = (title, rows, fmt, loud = false) => {
    if (!rows.length) return;
    const heading = `${title} (${rows.length})`;
    const shown = limit > 0 ? rows.slice(0, limit) : rows;
    shown.forEach((s, i) => entries.push({ section: heading, first: i === 0, lines: fmt(s) }));
    const hidden = rows.length - shown.length;
    if (!hidden) return;
    entries.push({
      section: heading,
      first: !shown.length,
      lines: loud
        ? [
            `  !! ${hidden} MORE NOT SHOWN — re-run with --limit 0 before describing`,
            '  !! this file; the hidden ones may change the story.',
          ]
        : [`  ... and ${hidden} more (--limit 0 for all)`],
    });
  };

  // Newly passing splits into fixes and brand-new assertions: a new assertion that
  // holds is usually the feature, but it is not the same claim as "this used to
  // fail and now passes", and conflating them overstates a release.
  const fixes = keep(st.newlyPassing).filter((s) => !s.added);
  const addedPassing = keep(st.newlyPassing).filter((s) => s.added);
  const breaks = keep(st.newlyFailing).filter((s) => !s.added);
  const addedFailing = keep(st.newlyFailing).filter((s) => s.added);

  section('Newly passing (was failing, now passes)', show('newly-passing') ? fixes : [], (s) => [
    `  ${String(s.was || '?').padEnd(7)} -> PASS  ${clip(s.name, 90)}`,
    ...(s.message ? [`      was: ${clip(s.message, 200)}`] : []),
  ], true);

  section('Newly passing (subtest is new on the compare side)', show('newly-passing') ? addedPassing : [], (s) => [
    `  (new)   -> PASS  ${clip(s.name, 90)}`,
  ], true);

  section('Newly failing (was passing, now fails)', show('newly-failing') ? breaks : [], (s) => [
    `  PASS    -> ${String(s.now || '?').padEnd(7)}  ${clip(s.name, 90)}`,
    ...(s.message ? [`      now: ${clip(s.message, 200)}`] : []),
  ], true);

  section('New subtests that fail', show('newly-failing') ? addedFailing : [], (s) => [
    `  (new)   -> ${String(s.now || '?').padEnd(7)}  ${clip(s.name, 90)}`,
    ...(s.message ? [`      now: ${clip(s.message, 200)}`] : []),
  ], true);

  section('Failure changed (still failing)', show('changed') ? keep(st.changed) : [], (s) => [
    `  ${String(s.was).padEnd(7)} -> ${String(s.now).padEnd(7)}  ${clip(s.name, 90)}`,
    ...(s.message ? [`      now: ${clip(s.message, 200)}`] : []),
  ], true);

  section('Subtests only in the baseline (removed)', show('removed') ? keep(st.removed) : [], (s) => [
    `  ${String(s.was || '?').padEnd(7)} ${clip(s.name, 90)}`,
  ]);

  // Not "context" in small print: what a feature still gets wrong is half of an
  // honest release note, and on a real file 48 of these 57 shared one cause.
  section('Still failing in both runs', show('still-failing') ? keep(st.stillFailing) : [], (s) => [
    `  ${String(s.status).padEnd(7)} ${clip(s.name, 90)}`,
    ...(s.message ? [`      ${clip(s.message, 200)}`] : []),
  ]);

  const tail = [];
  if (!match && st.counts.stillFailing > st.stillFailing.length) {
    tail.push(`  (${st.counts.stillFailing - st.stillFailing.length} further still-failing subtests were not stored)`);
  }

  const positional = positionalSubtests(r);
  if (positional.length) {
    tail.push('');
    tail.push(`NOTE: ${positional.length} newly-passing subtest name(s) are positional ("... 2").`);
    tail.push('They are zero-indexed AFTER the first, so " 2" is the THIRD test() block.');
    tail.push('Count test( blocks in the source before mapping one to a behaviour.');
  }
  // header is repeated on every page: it is the synopsis, so a page without it
  // would be uninterpretable on its own.
  return { header: L, entries, tail };
}

/** renderFile flattened, for callers that do not page. */
function renderFileLines(report, r, opts) {
  const { header, entries, tail } = renderFile(report, r, opts);
  const out = [...header];
  let current = null;
  for (const e of entries) {
    if (e.section !== current) {
      out.push('');
      out.push(`## ${e.section}`);
      current = e.section;
    }
    out.push(...e.lines);
  }
  return [...out, ...tail];
}

/**
 * Several files' per-file views, paged at subtest-entry boundaries.
 *
 * Never breaks inside an entry, and repeats the owning file's header and synopsis on
 * every page, so each page stands alone. Each page states which entries it covered
 * and what has not been read — the same contract as the inventory's --part, for the
 * same reason: 66KB of output for one file exceeds the tool limit, and a page break
 * that does not say so is indistinguishable from the end of the data.
 */
function renderFiles(report, rows, { part = 1, budget = 22000, all = false, ...opts } = {}) {
  const files = rows.map((r) => ({ r, ...renderFile(report, r, opts) }));
  const cost = (lines) => lines.reduce((s, l) => s + l.length + 1, 0);

  // Flatten to a stream of pageable units, each tagged with its file.
  const units = [];
  for (const f of files) {
    f.entries.forEach((e, i) => units.push({ f, e, last: i === f.entries.length - 1 }));
    if (!f.entries.length) units.push({ f, e: null, last: true });
  }

  const pages = [];
  let page = [];
  let size = 0;
  for (const u of units) {
    const c = cost(u.e ? u.e.lines : []) + (page.length ? 0 : cost(u.f.header));
    if (page.length && size + c > budget) {
      pages.push(page);
      page = [];
      size = 0;
    }
    page.push(u);
    size += c + (page.length === 1 ? cost(u.f.header) : 0);
  }
  if (page.length) pages.push(page);
  if (!pages.length) pages.push([]);

  const chosen = all ? units : pages[Math.min(Math.max(1, part), pages.length) - 1];
  const index = all ? 1 : Math.min(Math.max(1, part), pages.length);
  const total = all ? 1 : pages.length;

  const out = [];
  if (total > 1) {
    out.push(`!! PART ${index} OF ${total} — THIS IS NOT THE WHOLE OUTPUT.`);
    out.push('!! Pages break between subtests, never inside one, and each repeats its');
    out.push("!! file's synopsis. Read every part.");
    out.push('');
  }
  let currentFile = null;
  let currentSection = null;
  for (const u of chosen) {
    if (u.f !== currentFile) {
      out.push(...u.f.header);
      currentFile = u.f;
      currentSection = null;
    }
    if (u.e && u.e.section !== currentSection) {
      out.push('');
      out.push(`## ${u.e.section}${u.e.first ? '' : ' — continued'}`);
      currentSection = u.e.section;
    }
    if (u.e) out.push(...u.e.lines);
    if (u.last) out.push(...u.f.tail);
  }
  if (total > 1) {
    out.push('');
    out.push(`!! END OF PART ${index} OF ${total}.`);
    if (index < total) {
      out.push(`!! NOT YET READ: the remaining ${total - index} part(s). Continue with:`);
      // As above: a real command, built by the caller from its own arguments.
      out.push(`!!   ${opts.resume || 'node scripts/wpt-subtests.js'} --part ${index + 1}`);
    } else {
      out.push('!! That was the last part.');
    }
  }
  return out;
}

module.exports = {
  renderReport, renderInventory, renderChecklist, renderFile, renderFileLines,
  renderFiles, verifyChecklist, boxPaths, verdictOf, grepFragment, collapseVariants,
  groupByDir, evidenceLines, opaquelyNamed, positionalName, positionalSubtests,
  messageNamesSomething, CATEGORIES,
};
