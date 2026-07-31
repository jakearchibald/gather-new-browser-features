/**
 * Locating a collected comparison on disk.
 *
 * One collection run writes a directory, not a loose file:
 *
 *   tmp/firefox-beta-vs-firefox-experimental/
 *     diff.json        every changed test, with complete subtest evidence
 *     report.txt       the ranked view, clusters and shared vocabulary
 *     checklist.md     the coverage worksheet, to be ticked in place
 *     boxes.json       the box list as generated, so --verify can spot a lost box
 *     state.json.gz    both full summaries, so "does a test exist?" stays local
 *     sources/         test source at the revision the runs were tested at
 *
 * A directory rather than `tmp/<slug>.diff.json` plus `tmp/diff.txt` plus
 * `tmp/checklist.md`: those shared names collide the moment a second comparison is
 * collected, and the file that gets silently overwritten is the one holding
 * someone's ticked verdicts.
 *
 * Every analysis script takes the directory. A path to diff.json is also accepted,
 * because that is what a half-remembered command line will contain.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TMP = path.join(ROOT, 'tmp');

/**
 * A path shown relative to the REPO ROOT, not the cwd.
 *
 * The Bash tool's working directory persists between calls, so one stray `cd`
 * leaks into everything afterwards. Discovery survives that — TMP is anchored to
 * __dirname — but `path.relative(process.cwd(), ...)` does not: from inside the
 * artifact directory it renders "tmp/a-vs-b" as "../../../../Users/.../tmp/a-vs-b",
 * which is technically correct and useless, and worse, unusable if copied.
 * Root-relative is stable wherever the command was run from.
 */
function rel(p) {
  return path.relative(ROOT, p) || p;
}

/** Directory name for a comparison, e.g. "firefox-beta-vs-firefox-experimental". */
function slugFor(fromLabel, toLabel) {
  const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  return `${slug(fromLabel)}-vs-${slug(toLabel)}`;
}

function defaultDir(fromLabel, toLabel) {
  return path.join(TMP, slugFor(fromLabel, toLabel));
}

/** Artifact directories under tmp/, newest-looking first. */
function discover() {
  let entries;
  try {
    entries = fs.readdirSync(TMP);
  } catch {
    return [];
  }
  return entries
    .map((name) => path.join(TMP, name))
    .filter((d) => fs.existsSync(path.join(d, 'diff.json')))
    .sort();
}

/**
 * Resolve whatever the user passed into the set of paths inside one artifact.
 * Accepts the directory, diff.json inside it, or nothing at all.
 *
 * Omitting it is the normal case and resolves to the only collected artifact.
 * That exists because the alternative convention — "the path is printed, call it
 * $D" — cannot work: shell state does not persist between tool calls, so every
 * command has to re-`export D=...`, which makes every command a compound
 * `export ... && node ...`. Permission rules match a command prefix, so a compound
 * command matches no rule and prompts. Twenty-four documented commands, twenty-four
 * prompts, and the tempting fix — allowlisting the compound form — would permit
 * anything after the `&&`.
 *
 * Ambiguity is refused rather than guessed, and the resolved directory is always
 * announced, so this can never quietly analyse the wrong comparison.
 */
function resolve(p, fail) {
  const bail = fail || ((m) => { throw new Error(m); });

  if (!p) {
    const found = discover();
    if (!found.length) {
      return bail(
        'no collected comparison found in tmp/\n' +
          'Collect one first:  node scripts/wpt-collect.js --from <a> --to <b>',
      );
    }
    if (found.length > 1) {
      return bail(
        `several collected comparisons in tmp/ — name the one you mean:\n  ${found
          .map((d) => rel(d))
          .join('\n  ')}`,
      );
    }
    p = found[0];
    // stderr, so it is visible without polluting stdout for anything parsing it.
    process.stderr.write(`using ${rel(p)}\n`);
  }

  let dir = p;
  if (fs.existsSync(p) && fs.statSync(p).isFile()) dir = path.dirname(p);

  const diff = path.join(dir, 'diff.json');
  if (!fs.existsSync(diff)) {
    return bail(
      `no diff.json in ${dir}\n` +
        `Collect one first:  node scripts/wpt-collect.js --from <a> --to <b>`,
    );
  }
  return {
    dir,
    diff,
    report: path.join(dir, 'report.txt'),
    checklist: path.join(dir, 'checklist.md'),
    // The box list as generated, so --verify can tell a resolved worksheet from one
    // that lost boxes while being resolved. Written by wpt-collect.js.
    boxes: path.join(dir, 'boxes.json'),
    state: path.join(dir, 'state.json.gz'),
    sources: path.join(dir, 'sources'),
  };
}

/** Resolve and parse in one step, which is what every analysis script wants. */
function load(p, fail) {
  const paths = resolve(p, fail);
  return { paths, report: JSON.parse(fs.readFileSync(paths.diff, 'utf8')) };
}

module.exports = { ROOT, TMP, rel, slugFor, defaultDir, discover, resolve, load };
