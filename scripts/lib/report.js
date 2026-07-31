/**
 * Stream a raw wptreport and pull out the result objects for a set of test paths.
 *
 * This once lived in two places — the diff and the per-file drill-in — and each
 * copy grew its own bugs: one spliced a stale seek-tail into a captured object and
 * reported 19 of 2587 files as "legitimately absent", the other swallowed inflate
 * errors so a decode failure surfaced as "test not present". Tricky streaming code
 * with two implementations means fixing each bug twice, so there is now one, and
 * only wpt-collect.js calls it.
 *
 * The reports are ~330MB and far too big to JSON.parse whole, so this exploits
 * their shape: `results` is an array of objects each beginning `{"test": "<path>"`.
 * It seeks the next such object, brace-matches to its end (string-aware, so braces
 * inside assertion messages don't confuse it), parses it, and keeps it only if it
 * was asked for. It stops as soon as every wanted path has been found, which makes
 * a lookup of a handful of paths cheap and a sweep of all of them complete.
 */

const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');
const { netFetch } = require('./net.js');

// Both spacings occur: some reports are pretty-printed, some are not.
const NEEDLES = ['{"test": ', '{"test":'];
const KEEP_TAIL = Math.max(...NEEDLES.map((n) => n.length));

/**
 * @param {string} url         raw_results_url for the run
 * @param {Set<string>} want   test paths to keep
 * @returns {Promise<{results: Map<string, object>, malformed: number}>}
 */
async function extractOnce(url, want) {
  const res = await netFetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);

  const results = new Map();
  let malformed = 0;
  let pending = '';
  let capturing = null; // { buf, depth, inStr, esc }
  let done = false;

  // `pending` only ever holds an unconsumed seek tail, and is drained at the top.
  // It must not be prepended while mid-capture: doing that spliced stale text into
  // the captured object and desynced the scanner.
  const feed = (text) => {
    let rest = pending + text;
    pending = '';
    while (rest && !done) {
      if (capturing) {
        let end = -1;
        for (let i = 0; i < rest.length; i++) {
          const ch = rest[i];
          if (capturing.esc) { capturing.esc = false; continue; }
          if (ch === '\\' && capturing.inStr) { capturing.esc = true; continue; }
          if (ch === '"') { capturing.inStr = !capturing.inStr; continue; }
          if (capturing.inStr) continue;
          if (ch === '{') capturing.depth++;
          else if (ch === '}' && --capturing.depth === 0) { end = i; break; }
        }
        if (end === -1) {
          capturing.buf += rest;
          return;
        }
        capturing.buf += rest.slice(0, end + 1);
        try {
          const obj = JSON.parse(capturing.buf);
          if (obj && typeof obj.test === 'string' && want.has(obj.test)) {
            results.set(obj.test, obj);
            if (results.size === want.size) done = true;
          }
        } catch {
          malformed++;
        }
        capturing = null;
        rest = rest.slice(end + 1);
        continue;
      }
      let at = -1;
      for (const n of NEEDLES) {
        const i = rest.indexOf(n);
        if (i !== -1 && (at === -1 || i < at)) at = i;
      }
      if (at === -1) {
        // Keep a tail in case a needle straddles the chunk boundary.
        pending = rest.length > KEEP_TAIL ? rest.slice(-KEEP_TAIL) : rest;
        return;
      }
      capturing = { buf: '', depth: 0, inStr: false, esc: false };
      rest = rest.slice(at);
    }
  };

  const decoder = new StringDecoder('utf8');
  let gunzip = null;
  let sniffed = false;
  let inflateError = null;
  let stoppedEarly = false;

  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk);
    if (!sniffed) {
      sniffed = true;
      // These blobs are stored gzipped as well as served gzipped, so after fetch
      // undoes Content-Encoding there is sometimes still a gzip stream underneath.
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        gunzip = zlib.createGunzip();
        gunzip.on('data', (d) => feed(decoder.write(d)));
        // Abandoning the stream once everything is found is normal, so errors after
        // that point are expected. Before it, an error is a genuinely corrupt body,
        // and swallowing it made the caller report "test not present" instead.
        gunzip.on('error', (err) => {
          if (!stoppedEarly) inflateError = inflateError || err;
        });
      }
    }
    if (gunzip) {
      // Inflate before the next chunk, and race the write against 'error' since a
      // failing write may never flush its callback.
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          gunzip.removeListener('error', finish);
          resolve();
        };
        gunzip.once('error', finish);
        gunzip.write(buf, finish);
      });
    } else {
      feed(decoder.write(buf));
    }
    if (inflateError || done) break;
  }
  stoppedEarly = true;
  if (gunzip) {
    gunzip.removeAllListeners('data');
    gunzip.destroy();
  }
  try { res.body.cancel?.(); } catch { /* already closed */ }
  if (inflateError) throw new Error(`could not decompress ${url}: ${inflateError.message}`);

  return { results, malformed };
}

/**
 * extractOnce, retried.
 *
 * A ~330MB transfer gets dropped mid-stream often enough to matter — reliably so
 * behind a proxy, which reports it as `aborted`. The scan is stateful, so a retry
 * restarts from the beginning; a few seconds is far better than losing the run.
 * Retries are announced, never silent: a quietly incomplete extraction means
 * features missing from the notes with nothing to show that anything went wrong.
 */
async function extractResults(url, want, { attempts = 3, label = '' } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await extractOnce(url, want);
    } catch (err) {
      if (attempt >= attempts) {
        throw new Error(`report stream ${label || url} failed ${attempts}x (last: ${err.message})`);
      }
      process.stderr.write(
        `note: report stream ${label || url} failed (${err.message}); retrying ${attempt + 1}/${attempts}\n`,
      );
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

module.exports = { extractResults };
