/**
 * One paginator, shared by every view that can outgrow a tool result.
 *
 * Why this is centralised rather than added per-script: the same failure kept
 * arriving through different doors. A view exceeds the output limit, the harness
 * truncates it with no marker or the command simply errors, and the reflex fix is a
 * shell filter — `head`, `tail`, a `sed` range, a `grep` for an arrow — every one of
 * which drops information silently. An audit of this toolkit found three views still
 * unbounded: a broad `wpt-grep.js` pattern produced 3MB, and
 * `wpt-state.js --grep / --limit 0` produced 16MB, five hundred times the limit.
 *
 * The contract every paged view keeps:
 *   - break only between whole blocks, never inside one
 *   - state which page this is, out of how many
 *   - state what has NOT been read, and the exact command to continue
 *   - say plainly when it was the last page
 *
 * A page that does not say it is a page is indistinguishable from the end of the
 * data, which is the whole problem.
 */

// Tool results are truncated somewhere around 30KB. Leave room for the caller's
// own preamble and the markers themselves.
const DEFAULT_BUDGET = 22000;

const cost = (lines) => lines.reduce((s, l) => s + String(l).length + 1, 0);

/**
 * Pack blocks into pages that each fit `budget`.
 * A single block larger than the budget becomes its own oversized page rather than
 * being split — better one big page than a block cut in half.
 */
function pack(blocks, budget = DEFAULT_BUDGET) {
  const pages = [];
  let current = [];
  let size = 0;
  for (const b of blocks) {
    const c = cost(b.lines);
    if (current.length && size + c > budget) {
      pages.push(current);
      current = [];
      size = 0;
    }
    current.push(b);
    size += c;
  }
  if (current.length) pages.push(current);
  return pages.length ? pages : [[]];
}

/**
 * Render one page of `blocks`, with the loud markers.
 *
 * @param blocks  [{lines: string[]}]  atomic, never split
 * @param opts.part      1-based page number, clamped
 * @param opts.all       emit everything, ignoring the budget
 * @param opts.unit      what a block is, for the messages ("matches", "tests")
 * @param opts.resume    command to print for the next page, minus "--part N"
 * @returns {lines, index, total}
 */
function render(blocks, {
  part = 1, all = false, budget = DEFAULT_BUDGET, unit = 'entries', resume = '',
} = {}) {
  const pages = all ? [blocks] : pack(blocks, budget);
  const index = Math.min(Math.max(1, part), pages.length);
  const chosen = pages[index - 1];
  const total = pages.length;

  const before = pages.slice(0, index - 1).reduce((s, p) => s + p.length, 0);
  const from = before + 1;
  const to = before + chosen.length;
  const totalBlocks = blocks.length;

  const lines = [];
  if (total > 1) {
    lines.push(`!! PART ${index} OF ${total} — THIS IS NOT THE WHOLE OUTPUT.`);
    lines.push(`!! Showing ${unit} ${from}-${to} of ${totalBlocks}, split between whole ${unit}.`);
    lines.push('');
  }
  for (const b of chosen) lines.push(...b.lines);
  if (total > 1) {
    lines.push('');
    lines.push(`!! END OF PART ${index} OF ${total}. Seen ${unit} ${from}-${to} of ${totalBlocks}.`);
    if (index < total) {
      lines.push(`!! NOT YET READ: ${unit} ${to + 1}-${totalBlocks}. Continue with:`);
      lines.push(`!!   ${resume} --part ${index + 1}`);
    } else {
      lines.push('!! That was the last part.');
    }
  } else if (totalBlocks) {
    // Single page still gets a terminal line. Without one, a `tail -20` cannot tell
    // "this is everything" from "this is the end of something longer" — and `tail`
    // is exactly what discards the counts at the top.
    lines.push('');
    lines.push(`!! END — all ${totalBlocks} ${unit} shown.`);
  }
  return { lines, index, total };
}

module.exports = { DEFAULT_BUDGET, pack, render };
