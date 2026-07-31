/**
 * Argument-parsing helpers shared by every script.
 *
 * Both of these were copy-pasted into five files, comment and all. The `num`
 * validation is the one that matters: an unvalidated `Number()` turns a typo into
 * an *empty report* rather than an error, because `slice(0, NaN)` is `[]` and
 * `length > NaN` is false — so every row, and even the "... and N more" line that
 * would have shown something was missing, silently disappears.
 */

const fs = require('fs');
const path = require('path');

/**
 * Print a script's leading block comment as its help text, then exit.
 * Called with `module.filename` so each script documents itself in one place.
 *
 * An error prints the message and a pointer, NOT the whole comment. These help
 * blocks run to seventy lines of hard-won postmortem, and dumping all of it on a
 * mistyped path buries the one line that says what was wrong — a loop over three
 * directories with a stale path produced 400 lines of help and three copies of the
 * Popover story. Verbose on request; terse on failure.
 */
function usage(filename, msg) {
  if (!msg) {
    console.log(fs.readFileSync(filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
    process.exit(0);
  }
  const rel = path.relative(process.cwd(), filename) || filename;
  console.error(`error: ${msg}`);
  console.error(`\nUsage:  node ${rel} --help`);
  process.exit(1);
}

/** A finite number, or exit with a message naming the flag and the bad value. */
function num(fail, flag, raw) {
  if (raw === undefined) fail(`missing value for ${flag}`);
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`${flag} needs a number, got "${raw}"`);
  return n;
}

/** The flags a script actually handles, read out of its own switch statement. */
function flagsOf(filename) {
  const src = fs.readFileSync(filename, 'utf8');
  return [...new Set((src.match(/case '(--[a-z-]+)'/g) || [])
    .map((m) => m.slice(6, -1)))].sort();
}

/** Levenshtein distance, for "did you mean". */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[a.length][b.length];
}

/**
 * Report an unknown option usefully.
 *
 * The scripts share a vocabulary unevenly — `--grep` selects test files in two of
 * them, `--include` in two more, `--area` in a fifth — so guessing the wrong one is
 * the normal outcome of learning the toolkit, not carelessness. A bare "unknown
 * option --grep" plus a pointer to --help is a dead end mid-task; the flags this
 * script *does* take are two lines away and cost nothing to print.
 *
 * Flags come from the script's own switch statement, so this cannot drift out of
 * date the way a hand-maintained list would.
 */
function unknownOption(filename, flag) {
  const valid = flagsOf(filename);
  const near = valid
    .map((v) => ({ v, d: distance(flag, v) }))
    .filter(({ d }) => d <= 4)
    .sort((a, b) => a.d - b.d)[0];
  const lines = [`unknown option ${flag}`];
  if (near) lines.push(`did you mean ${near.v}?`);
  lines.push(`this script accepts: ${valid.join(' ')}`);
  return lines.join('\n');
}

module.exports = { usage, num, flagsOf, unknownOption };
