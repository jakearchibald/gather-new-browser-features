#!/usr/bin/env node
/**
 * Apply a file of verdicts to a collected comparison's checklist.md.
 *
 * Why this exists
 * ---------------
 * Resolving the worksheet by hand is the single most expensive step in a
 * release-notes pass, and the cost is not thinking — it is transcription.
 * Instrumenting one complete run (29.2 minutes wall clock, 180,385 output tokens,
 * generating flat out at 103 tokens/sec the whole time) put **106 Edit calls and
 * 149,823 characters — about 40,000 output tokens, 22% of everything the model
 * produced — into ticking boxes**. The same 167 verdicts expressed as a data file
 * are ~26,000 characters. An Edit has to restate its surrounding context to anchor
 * itself, so applying verdicts one edit at a time costs roughly six times the output
 * of simply listing them, and output tokens were what the wall clock was made of.
 *
 * So: write the verdicts once, as data, and let a script do the editing.
 *
 * Usage:
 *   node wpt-resolve.js [artifact-dir] --list [--part <n>] [--all]
 *   node wpt-resolve.js [artifact-dir] <verdicts.json> [--dry-run]
 *
 *   node wpt-resolve.js --list
 *   node wpt-resolve.js tmp/verdicts.json
 *   node wpt-resolve.js tmp/ff-152-vs-153 tmp/verdicts.json --dry-run
 *
 * Options:
 *   --list        every box path that still has no verdict, one per line, ready to be
 *                 used as keys. Because the keys must be EXACT, and there was no way
 *                 to get them: the directory boxes are in `wpt-inventory.js --dirs`
 *                 but the file boxes were only ever in checklist.md, several hundred
 *                 lines of it. Copying a key out of prose is how a key comes to match
 *                 no box.
 *   --part <n>    which page of --list (it does not fit in one tool result).
 *   --all         every page of --list at once.
 *   --dry-run     report what would be applied and write nothing.
 *
 * Write the verdicts file with the Write tool, NOT a shell heredoc. `cat > f <<'EOF'`
 * is arbitrary file creation through the shell: it will never be pre-approved and
 * should not be, so it prompts every time. The Write tool does the same job with no
 * prompt, and tmp/ is already writable.
 *
 * The format is one exact box path to one verdict:
 *
 *   {
 *     "/css/css-values/tree-counting": "written up: sibling-index() / sibling-count()",
 *     "/css/css-images": "explained: same feature as /css/css-values/tree-counting",
 *     "/fs": "not a feature: flake, the same subtest moved the other way in the worker variant"
 *   }
 *
 * Keys are EXACT box paths — the string after the box on a checklist line. Both the
 * directory list and the file list are addressed the same way, so one file can
 * resolve both.
 *
 * No patterns, and no fallback
 * ----------------------------
 * An earlier attempt at this was a throwaway script of ~150 regexes with, at the end
 * of each branch:
 *
 *   return line.replace('[ ]', '[x]') + '  — written up — see notes'
 *
 * Every box no rule matched was silently stamped resolved with a non-answer, and
 * --verify would then have passed on all 416. That is strictly worse than leaving
 * them open, because an open box is visible. The regexes were dangerous too:
 * unanchored substrings, so `/css-cascade/` claimed every changed file in a directory
 * that also holds @layer, @scope and revert.
 *
 * Hence exact keys only, and hence the checks below. A verdict this script cannot
 * place is an error that stops the run, never a box quietly ticked.
 *
 *   - a key matching no box            -> ERROR, nothing is written. This is the
 *                                        failure with no other symptom: a typo'd key
 *                                        does nothing at all, and the box it was
 *                                        meant for stays open looking untouched.
 *   - a verdict the gate would reject  -> ERROR, nothing is written. Whatever lands on
 *                                        disk always passes wpt-inventory.js --verify
 *                                        for the boxes it resolved, so "applied" and
 *                                        "accepted" cannot drift apart.
 *   - a key on an already-resolved box -> reported, left alone. Re-running is safe.
 *   - boxes with no key                -> listed, not an error. Resolving in several
 *                                        passes is normal; the gate is what insists
 *                                        every box eventually gets an answer.
 *
 * checklist.md is the one file in an artifact that cannot be regenerated without
 * losing work, so a .bak is written before the first change.
 */

const fs = require('fs');
const path = require('path');
const { usage, num, unknownOption } = require('./lib/cli.js');
const artifact = require('./lib/artifact.js');
const { verifyChecklist, boxPaths } = require('./lib/render.js');
const page = require('./lib/page.js');

const fail = (msg) => usage(__filename, msg);

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) usage(__filename);

const opts = {
  dir: null, verdicts: null, dryRun: false, list: false, part: 1, all: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--dry-run': opts.dryRun = true; break;
    case '--list': opts.list = true; break;
    case '--part': opts.part = num(fail, a, argv[++i]); break;
    case '--all': opts.all = true; break;
    default:
      if (a.startsWith('-')) fail(unknownOption(__filename, a));
      // The verdicts file is a real file that is not a directory; the artifact is a
      // directory (or a path to diff.json, which artifact.load also accepts).
      else if (/\.json$/i.test(a) && fs.existsSync(a) && !fs.statSync(a).isDirectory()
        && path.basename(a) !== 'diff.json') opts.verdicts = a;
      else if (!opts.dir) opts.dir = a;
      else fail(`unexpected argument ${a}`);
  }
}
if (!opts.verdicts && !opts.list) fail('need a verdicts .json file, or --list to see the box paths');

const paths = artifact.resolve(opts.dir, fail);
if (!fs.existsSync(paths.checklist)) {
  console.error(`error: no checklist.md in ${paths.dir}`);
  console.error('Re-collect the comparison; wpt-collect.js writes one.');
  process.exit(1);
}

// ---- --list: the exact keys, ready to copy ----
if (opts.list) {
  const text = fs.readFileSync(paths.checklist, 'utf8');
  const BOX_OPEN = /^(?:\[ \]|\( \)|\(\?\))\s+(\S+)(.*)$/;
  const blocks = [];
  for (const line of text.split('\n')) {
    const m = line.match(BOX_OPEN);
    if (!m) continue;
    // The key ALONE on its own line, and any note indented beneath it.
    //
    // These used to share a line as `<key>   # <note>`, and for a `?query` box the note is
    // `[reach it with: --grep <fragment>]`. That reads as an instruction, because the
    // surrounding doctrine is "never pass a ?query path, use --grep instead" — so one pass
    // submitted the --grep fragment as the key for one box while correctly keeping `?rest` on
    // another, in the same file. The cue was fighting the doctrine, and the adjacency is what
    // made it ambiguous. The note is still worth having (it is how you read the test before
    // verdicting it), just not on the line being copied.
    const note = m[2].replace(/\s+/g, ' ').trim();
    const lines = [m[1]];
    if (note) lines.push(`    # ^ that line is the key. Context: ${note}`);
    blocks.push({ lines });
  }
  if (!blocks.length) {
    console.log('Every box already has a verdict. Check the gate:');
    console.log(`  ${artifact.cmd('wpt-inventory.js', paths)} --verify`);
    process.exit(0);
  }
  console.log(`# ${blocks.length} box(es) with no verdict yet, in ${artifact.rel(paths.checklist)}`);
  console.log('# One key per un-indented line, copied EXACTLY — including any ?query, which IS');
  console.log('# part of the key. Indented "#" lines are context, never keys. A --grep fragment');
  console.log('# shown as context is how to READ that test; it is not the key.');
  console.log('');
  for (const line of page.render(blocks, {
    part: opts.part,
    all: opts.all,
    unit: 'boxes',
    resume: `${artifact.cmd('wpt-resolve.js', paths)} --list`,
  }).lines) {
    console.log(line);
  }
  process.exit(0);
}

let verdicts;
try {
  verdicts = JSON.parse(fs.readFileSync(opts.verdicts, 'utf8'));
} catch (err) {
  console.error(`error: ${opts.verdicts} is not valid JSON — ${err.message}`);
  process.exit(1);
}
if (!verdicts || typeof verdicts !== 'object' || Array.isArray(verdicts)) {
  fail('the verdicts file must be a JSON object of "box path": "verdict"');
}

const text = fs.readFileSync(paths.checklist, 'utf8');
const lines = text.split('\n');

// ---- match keys to boxes ----
const BOX = /^(\[ \]|\[x\]|\( \)|\(\?\)|\(x\))(\s+)(\S+)(.*)$/i;
const byPath = new Map();
lines.forEach((line, i) => {
  const m = line.match(BOX);
  if (m && !byPath.has(m[3])) byPath.set(m[3], i);
});

const keys = Object.keys(verdicts);
const unmatched = keys.filter((k) => !byPath.has(k));
const already = [];
const toApply = [];
for (const k of keys) {
  const i = byPath.get(k);
  if (i === undefined) continue;
  if (/^(\[x\]|\(x\))/i.test(lines[i])) already.push(k);
  else toApply.push({ key: k, index: i });
}

// ---- refuse on a key that names no box ----
if (unmatched.length) {
  console.error(`error: ${unmatched.length} verdict key(s) match no box in ${artifact.rel(paths.checklist)}:`);
  for (const k of unmatched.slice(0, 20)) console.error(`  ${k}`);
  if (unmatched.length > 20) console.error(`  ... and ${unmatched.length - 20} more`);
  console.error('');
  console.error('Nothing has been written. A key must be the EXACT path shown after the box,');
  console.error('copied from checklist.md — not a prefix, a pattern or a guess. Check for a');
  console.error('trailing slash, a missing leading "/", or a directory that has no box because');
  console.error('it was pre-resolved as churn. List the real box paths with:');
  console.error(`  ${artifact.cmd('wpt-resolve.js', paths)} --list`);
  process.exit(1);
}

// ---- build the result in memory ----
const out = lines.slice();
for (const { key, index } of toApply) {
  const m = out[index].match(BOX);
  const box = m[1].startsWith('[') ? '[x]' : '(x)';
  const verdict = String(verdicts[key]).trim();
  out[index] = `${box}${m[2]}${m[3]}${m[4]}  — ${verdict}`;
}
const result = out.join('\n');

// ---- refuse if the gate would reject what we just wrote ----
const applied = new Set(toApply.map((t) => t.key));
let requirePrefEvidence = null;
try {
  const diff = JSON.parse(fs.readFileSync(paths.diff, 'utf8'));
  const curated = (diff.changelog && diff.changelog.ok && diff.changelog.curated) || [];
  requirePrefEvidence = new Set(curated.filter((b) => b.isShip).map((b) => `bug:${b.id}`));
} catch { /* older artifact: no policy */ }
const check = verifyChecklist(result, null, { requirePrefEvidence });
const badApplied = check.bad.filter((b) => {
  const m = b.line.match(BOX);
  return m && applied.has(m[3]);
});
if (badApplied.length) {
  console.error(`error: ${badApplied.length} of ${toApply.length} verdict(s) would not pass the gate:`);
  for (const b of badApplied.slice(0, 15)) {
    console.error(`  ${b.why}`);
    console.error(`    ${b.line.slice(0, 150)}`);
  }
  if (badApplied.length > 15) console.error(`  ... and ${badApplied.length - 15} more`);
  console.error('');
  console.error('Nothing has been written. Every verdict must be one of:');
  console.error('  written up: <the feature, as it appears in the notes>');
  console.error('  explained: same feature as <a path or verdict named elsewhere in the sheet>');
  console.error('  not a feature: <infrastructure, flake or churn, and why>');
  process.exit(1);
}

// ---- report ----
console.log(`${toApply.length} box(es) resolved in ${artifact.rel(paths.checklist)}.`);
if (already.length) {
  console.log(`${already.length} key(s) name a box that was already resolved; left untouched:`);
  for (const k of already.slice(0, 8)) console.log(`  ${k}`);
  if (already.length > 8) console.log(`  ... and ${already.length - 8} more`);
}

const open = check.open.length;
if (open) {
  console.log('');
  console.log(`${open} box(es) still have no verdict. Not an error — resolve in as many`);
  console.log('passes as you like; --verify is what insists every box ends up answered.');
  // Strip via the box regex, not /^\S+\s+/: a `( )` box contains a space, so `\S+`
  // eats only the "(" and leaves ") /path" behind.
  const sample = check.open.slice(0, 8).map((l) => (l.match(BOX) || [, , , l])[3]);
  for (const s of sample) console.log(`  ${s}`);
  if (open > 8) console.log(`  ... and ${open - 8} more`);
}

if (opts.dryRun) {
  console.log('');
  console.log('--dry-run: nothing written.');
  process.exit(0);
}

// A .bak before the first change: checklist.md holds the only work in an artifact
// that re-collecting cannot reproduce.
if (toApply.length) {
  fs.writeFileSync(`${paths.checklist}.bak`, text);
  fs.writeFileSync(paths.checklist, result);
  console.log('');
  console.log(`Previous checklist saved as ${artifact.rel(paths.checklist)}.bak`);
}
console.log('');
console.log(`Check the gate:  ${artifact.cmd('wpt-inventory.js', paths)} --verify`);

// Sanity: the box set must not have changed. This script only ever rewrites a box's
// own line in place, so a difference here means a bug in this script rather than in
// anyone's editing — worth catching loudly either way.
const before = boxPaths(text);
const after = boxPaths(result);
if (before.length !== after.length || before.some((p, i) => p !== after[i])) {
  console.error('');
  console.error('error: applying verdicts changed the set of boxes. This is a bug in');
  console.error('wpt-resolve.js. The previous checklist is in checklist.md.bak.');
  process.exit(1);
}
