/**
 * Summary blobs, and the on-disk cache that keeps them out of the analysis step.
 *
 * A summary_v2 blob is the whole run in ~20MB of gzipped JSON:
 *   { "/path/to/test.html": { "s": "O", "c": [passes, total] } }
 *
 * Every test is in there, including the ~120k that did not change — which is
 * exactly what a diff cannot tell you. "Not in the diff" never means "not
 * shipped", and answering the difference needs both full summaries. Downloading
 * them again at analysis time worked, but it put a network round trip in the
 * middle of a question that should be instant, so wpt-collect.js writes the merged
 * pair to `state.json.gz` and wpt-state.js reads that.
 *
 * Merged and re-gzipped rather than stored verbatim: the two blobs share ~120k
 * identical key strings, so pairing them halves the key overhead, and dropping to
 * a positional array per side removes the `s`/`c` keys entirely.
 */

const zlib = require('zlib');
const fs = require('fs');
const { netFetch } = require('./net.js');

/**
 * Fetch and decompress one summary blob into a Map.
 *
 * These are stored gzipped on GCS *and* served with a gzip Content-Encoding, so
 * after fetch undoes the transport layer there is sometimes still a gzip stream
 * underneath. Sniff rather than assume.
 */
async function fetchSummary(url) {
  const res = await netFetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text =
    buf[0] === 0x1f && buf[1] === 0x8b
      ? zlib.gunzipSync(buf).toString('utf8')
      : buf.toString('utf8');
  const raw = JSON.parse(text);
  const out = new Map();
  for (const [test, v] of Object.entries(raw)) {
    // Legacy v1 summaries are a bare [passes, total] with no harness status.
    if (Array.isArray(v)) out.set(test, { status: null, pass: v[0], total: v[1] });
    else out.set(test, { status: v.s, pass: v.c[0], total: v.c[1] });
  }
  return out;
}

/** One side's state as a compact positional tuple, or null when absent. */
const pack = (r) => (r ? [r.pass, r.total, r.status || ''] : null);
const unpack = (v) => (v ? { pass: v[0], total: v[1], status: v[2] || null } : null);

/**
 * Write both summaries to `file` as one gzipped object:
 *   { "/test.html": [ [pass, total, status] | null, [pass, total, status] | null ] }
 */
function writeState(file, before, after) {
  const merged = {};
  for (const test of new Set([...before.keys(), ...after.keys()])) {
    merged[test] = [pack(before.get(test)), pack(after.get(test))];
  }
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(merged), 'utf8')));
  return Object.keys(merged).length;
}

/** Read back what writeState wrote, as two Maps. */
function readState(file) {
  const merged = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  const before = new Map();
  const after = new Map();
  for (const [test, [b, a]] of Object.entries(merged)) {
    if (b) before.set(test, unpack(b));
    if (a) after.set(test, unpack(a));
  }
  return { before, after };
}

module.exports = { fetchSummary, writeState, readState };
