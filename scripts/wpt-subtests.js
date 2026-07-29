#!/usr/bin/env node
/**
 * Diff the *individual subtests* of one test file between two runs, with the
 * assertion message for each failure.
 *
 * Why this exists: a subtest count tells you a file moved; it does not tell you why.
 * "getComputedTiming() 26/41 -> 41/41" reads like fifteen timing fixes. The subtest
 * messages showed all fifteen were one missing property — startTime was `undefined`,
 * and because it is the first assertion in ten of those tests, that single line failed
 * them all. The count cannot distinguish "15 bugs fixed" from "1 bug fixed, 15 tests
 * unblocked", and those are different release notes.
 *
 * Names and messages also give you the vocabulary developers search for: property
 * names, method names, the actual expected-vs-got values.
 *
 * Usage:
 *   node wpt-subtests.js <diff.json> <test-path>
 *   node wpt-subtests.js --before <run_id> --after <run_id> <test-path>
 *
 *   node wpt-subtests.js diff.json /web-animations/interfaces/AnimationEffect/getComputedTiming.html
 *   node wpt-subtests.js diff.json /css/css-color/parsing/color-valid-color-mix-function.html --limit 40
 *   node wpt-subtests.js diff.json /fetch/http-cache/no-vary-search.tentative.any.html --all
 *
 * Options:
 *   --before <id>  run id for the baseline (default: from diff.json)
 *   --after <id>   run id for the comparison (default: from diff.json)
 *   --limit <n>    max subtests to print per section (default 25; 0 = all)
 *   --all          list every subtest, not just the ones that changed
 *   --messages     show messages for unchanged failures too (default: only changes)
 *
 * Note: this reads the *raw* report.json, not the summary blob. Those reports are
 * large (100MB+), so the fetch is streamed and filtered to the one test path and
 * discarded as it goes. One test file at a time, by design.
 */

const fs = require('fs');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(msg ? 1 : 0);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) usage();

const opts = { before: null, after: null, limit: 25, all: false, messages: false };
const positional = [];
// Unvalidated Number() would turn a typo into a silently truncated report.
const num = (flag, raw) => {
  const n = Number(raw);
  if (raw === undefined) usage(`missing value for ${flag}`);
  if (!Number.isFinite(n)) usage(`${flag} needs a number, got "${raw}"`);
  return n;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--before': opts.before = argv[++i]; break;
    case '--after': opts.after = argv[++i]; break;
    case '--limit': opts.limit = num(a, argv[++i]); break;
    case '--all': opts.all = true; break;
    case '--messages': opts.messages = true; break;
    default:
      if (a.startsWith('--')) usage(`unknown option ${a}`);
      positional.push(a);
  }
}

let diffPath = null;
let testPath = null;
for (const p of positional) {
  if (p.startsWith('/')) testPath = p;
  else diffPath = p;
}
if (!testPath) usage('need a test path (starts with "/")');

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

/** Resolve the two run ids, from explicit flags or a diff.json. */
function resolveRunIds() {
  if (opts.before && opts.after) {
    return { before: opts.before, after: opts.after, label: null };
  }
  // Honouring only the pair meant that one of them alone was silently dropped in
  // favour of the diff.json's run ids, comparing runs the user didn't ask for.
  if (opts.before || opts.after) {
    usage(
      `--before and --after must be given together ` +
        `(got only ${opts.before ? '--before' : '--after'})`,
    );
  }
  if (!diffPath) {
    usage('need either a diff.json or both --before and --after run ids');
  }
  const diff = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
  if (!diff.before?.run_id || !diff.after?.run_id) {
    throw new Error(`${diffPath} has no run ids — regenerate it with a current wpt-diff.js`);
  }
  return {
    before: String(diff.before.run_id),
    after: String(diff.after.run_id),
    label: {
      before: `${diff.before.spec} ${diff.before.browser_version}`,
      after: `${diff.after.spec} ${diff.after.browser_version}`,
    },
  };
}

/**
 * Stream a raw report.json and pull out the subtests of exactly one test path.
 *
 * The reports are far too big to JSON.parse whole. Rather than a full streaming
 * parser, exploit the report's shape: results is an array of objects each starting
 * with `{"test":"<path>"`. We buffer only while inside the object we want, tracking
 * brace depth (ignoring braces inside strings) to know where it ends.
 */
async function fetchSubtests(runId, wantPath) {
  const runs = await getJSON(`https://wpt.fyi/api/runs?run_ids=${runId}`);
  if (!runs.length) throw new Error(`no run found for id ${runId}`);
  const run = runs[0];
  const url = run.raw_results_url;
  if (!url) throw new Error(`run ${runId} has no raw_results_url`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);

  // GCS may or may not pre-decompress; sniff the gzip magic on the first chunk.
  // (These reports are served with Content-Encoding: gzip *and* stored gzipped, so
  // after fetch() strips one layer there is often still a gzip stream underneath.)
  let stream = res.body;
  // The reports are pretty-printed with a space after the colon. Match both forms.
  const needles = [
    `{"test": ${JSON.stringify(wantPath)}`,
    `{"test":${JSON.stringify(wantPath)}`,
  ];

  let pending = '';
  let capturing = null; // {buf, depth, inStr, esc}
  let found = null;
  let sniffed = false;
  let gunzip = null;
  let stoppedEarly = false;
  // Chunk boundaries fall mid-character, and assertion messages routinely contain
  // non-ASCII (…, curly quotes, CSS values). Decoding each chunk independently
  // would replace a split sequence with U+FFFD — in the exact text this script
  // exists to quote verbatim.
  const decoder = new StringDecoder('utf8');

  const feed = (text) => {
    if (found) return;
    if (capturing) {
      // Continue accumulating the object we're inside.
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        capturing.buf += ch;
        if (capturing.esc) { capturing.esc = false; continue; }
        if (ch === '\\' && capturing.inStr) { capturing.esc = true; continue; }
        if (ch === '"') { capturing.inStr = !capturing.inStr; continue; }
        if (capturing.inStr) continue;
        if (ch === '{') capturing.depth++;
        else if (ch === '}') {
          capturing.depth--;
          if (capturing.depth === 0) {
            found = JSON.parse(capturing.buf);
            capturing = null;
            return;
          }
        }
      }
      return;
    }
    pending += text;
    let at = -1;
    for (const n of needles) {
      const i = pending.indexOf(n);
      if (i !== -1 && (at === -1 || i < at)) at = i;
    }
    if (at !== -1) {
      capturing = { buf: '', depth: 0, inStr: false, esc: false };
      const rest = pending.slice(at);
      pending = '';
      feed(rest);
    } else {
      // Keep only enough tail to catch a needle split across chunk boundaries.
      const keep = Math.max(...needles.map((n) => n.length)) * 2;
      if (pending.length > keep) pending = pending.slice(-keep);
    }
  };

  let inflateError = null;
  for await (const chunk of stream) {
    const buf = Buffer.from(chunk);
    if (!sniffed) {
      sniffed = true;
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        gunzip = zlib.createGunzip();
        gunzip.on('data', (d) => feed(decoder.write(d)));
        // Abandoning the stream mid-inflate is normal once we've found the test,
        // so those errors are expected. Before that point an error is a genuinely
        // corrupt or truncated body, and swallowing it made the script report
        // "test not present" — sending you off to debug the test path instead.
        gunzip.on('error', (err) => {
          if (!stoppedEarly) inflateError = err;
        });
      }
    }
    if (gunzip) {
      // Inflate synchronously so `found` is up to date before the next chunk.
      // A failing write may never flush its callback, so race it against 'error'.
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          gunzip.removeListener('error', finish);
          resolve();
        };
        gunzip.once('error', finish);
        gunzip.write(buf, finish);
      });
    } else {
      feed(decoder.write(buf));
    }
    if (inflateError) break;
    if (found) break;
  }
  stoppedEarly = true;
  if (gunzip) {
    gunzip.removeAllListeners('data');
    gunzip.destroy();
  }
  try { stream.destroy?.(); } catch {}
  if (inflateError) {
    throw new Error(`could not decompress ${url}: ${inflateError.message}`);
  }

  return {
    run,
    result: found,
  };
}

/** Index subtests by name for comparison. */
function indexSubtests(result) {
  const map = new Map();
  if (!result) return map;
  for (const s of result.subtests || []) {
    map.set(s.name, { status: s.status, message: s.message || null });
  }
  return map;
}

function truncate(s, n) {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

function section(title, rows, limit) {
  if (!rows.length) return;
  console.log(`\n## ${title} (${rows.length})`);
  const shown = limit > 0 ? rows.slice(0, limit) : rows;
  for (const r of shown) console.log(r);
  if (shown.length < rows.length) {
    console.log(`  ... and ${rows.length - shown.length} more (--limit 0 for all)`);
  }
}

(async () => {
  const ids = resolveRunIds();
  process.stderr.write(`Fetching raw results for ${testPath}\n`);
  process.stderr.write(`  (streaming two large reports; this takes a moment)\n`);

  const [before, after] = await Promise.all([
    fetchSubtests(ids.before, testPath),
    fetchSubtests(ids.after, testPath),
  ]);

  const bLabel = ids.label?.before
    || `${before.run.browser_name} ${before.run.browser_version}`;
  const aLabel = ids.label?.after
    || `${after.run.browser_name} ${after.run.browser_version}`;

  console.log(`# Subtest diff: ${testPath}`);
  console.log(`\nbaseline : ${bLabel}, run ${ids.before}`);
  console.log(`compare  : ${aLabel}, run ${ids.after}`);

  if (!before.result && !after.result) {
    console.log(`\nTest not present in either report.`);
    console.log(`Check the path, including any ?query variant.`);
    return;
  }

  const bStatus = before.result?.status ?? '(absent)';
  const aStatus = after.result?.status ?? '(absent)';
  const bMap = indexSubtests(before.result);
  const aMap = indexSubtests(after.result);
  const count = (m) => [...m.values()].filter((v) => v.status === 'PASS').length;

  console.log(`\nharness  : ${bStatus} -> ${aStatus}`);
  console.log(`subtests : ${count(bMap)}/${bMap.size} -> ${count(aMap)}/${aMap.size} passing`);
  if (before.result?.message || after.result?.message) {
    if (before.result?.message) console.log(`baseline harness message: ${truncate(before.result.message, 200)}`);
    if (after.result?.message) console.log(`compare harness message : ${truncate(after.result.message, 200)}`);
  }

  const names = new Set([...bMap.keys(), ...aMap.keys()]);
  const fixed = [], broken = [], added = [], removed = [], changed = [], stillFailing = [], unchanged = [];

  for (const name of names) {
    const b = bMap.get(name);
    const a = aMap.get(name);
    if (!b) {
      added.push(`  ${a.status.padEnd(7)} ${truncate(name, 100)}`
        + (a.status !== 'PASS' && a.message ? `\n      ${truncate(a.message, 160)}` : ''));
      continue;
    }
    if (!a) {
      removed.push(`  ${b.status.padEnd(7)} ${truncate(name, 100)}`);
      continue;
    }
    if (b.status === a.status) {
      if (a.status !== 'PASS') {
        stillFailing.push(`  ${a.status.padEnd(7)} ${truncate(name, 100)}`
          + (opts.messages && a.message ? `\n      ${truncate(a.message, 160)}` : ''));
      } else {
        unchanged.push(`  PASS    ${truncate(name, 100)}`);
      }
      continue;
    }
    // Status changed.
    const line = `  ${b.status} -> ${a.status}  ${truncate(name, 90)}`;
    if (a.status === 'PASS') {
      // The message from the *old* failure is the interesting part: it names the cause.
      fixed.push(line + (b.message ? `\n      was: ${truncate(b.message, 160)}` : ''));
    } else if (b.status === 'PASS') {
      broken.push(line + (a.message ? `\n      now: ${truncate(a.message, 160)}` : ''));
    } else {
      changed.push(line + (a.message ? `\n      now: ${truncate(a.message, 160)}` : ''));
    }
  }

  section('Newly passing', fixed, opts.limit);
  section('Newly failing', broken, opts.limit);
  section('Failure changed (still failing)', changed, opts.limit);
  section('Subtests only in compare (added)', added, opts.limit);
  section('Subtests only in baseline (removed)', removed, opts.limit);
  section('Still failing (unchanged)', stillFailing, opts.messages ? opts.limit : Math.min(opts.limit, 10));
  if (opts.all) section('Passing in both', unchanged, opts.limit);

  // The whole point: if many fixes share one assertion message, it is one bug.
  if (fixed.length > 2) {
    const msgs = [];
    for (const name of names) {
      const b = bMap.get(name), a = aMap.get(name);
      if (b && a && a.status === 'PASS' && b.status !== 'PASS' && b.message) msgs.push(b.message);
    }
    const groups = new Map();
    for (const m of msgs) {
      // Normalise away test-specific values to spot a shared root cause, then
      // truncate. Truncating first left a dangling quote that the "…" rule could
      // not match, so one root cause split into several near-identical groups.
      const key = truncate(
        String(m).replace(/"[^"]*"/g, '"…"').replace(/-?\d+(\.\d+)?/g, 'N'),
        60,
      );
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    const top = [...groups.entries()].sort((x, y) => y[1] - x[1]);
    if (top.length && top[0][1] > 1) {
      console.log(`\n## Shared failure messages among the newly-passing`);
      console.log(`If one message accounts for most of the fixes, that is ONE bug fixed`);
      console.log(`unblocking many tests — not many separate fixes. Say so in the notes.`);
      for (const [msg, n] of top.slice(0, 5)) {
        console.log(`  ${String(n).padStart(3)}x  ${msg}`);
      }
    }
  }
})().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
