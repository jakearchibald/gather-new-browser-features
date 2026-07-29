#!/usr/bin/env node
/**
 * Assert that the tooling still surfaces the features it once missed.
 *
 * Every entry below is a real miss from a real release-notes pass, recorded in
 * the skill as prose. Prose does not fail. A default `--exclude /third_party`
 * looked obviously reasonable when it was written and hid the whole `Intl.Locale`
 * info proposal; nothing but a reader's memory stopped that from being
 * reintroduced, and something very like it was reintroduced later in
 * wpt-diff.js's cluster section. So the postmortems live here as well, where a
 * regression is an exit code.
 *
 * Cases run against real diff artifacts, since the whole point is end-to-end
 * behaviour. They live in tmp/selftest/ — a subdirectory of its own, because tmp/
 * is shared scratch space and an actual release-notes run keeps its working files
 * there. Generate them first:
 *
 *   mkdir -p tmp/selftest
 *   node scripts/wpt-diff.js --from firefox@stable@151 --to firefox@stable@152 \
 *        --subtests --json tmp/selftest/151-152.json > tmp/selftest/151-152.txt
 *   node scripts/wpt-diff.js --from firefox@stable@152 --to firefox@stable@153 \
 *        --subtests --json tmp/selftest/152-153.json > tmp/selftest/152-153.txt
 *
 * Or point it at diffs you already have, which costs no downloads:
 *   node selftest.js --a tmp/151-152.json --b tmp/152-153.json
 *
 * Usage:
 *   node selftest.js [--a <151-152.json>] [--b <152-153.json>]
 *
 * Exit codes: 0 all passed, 1 a check failed, 2 artifacts missing so coverage is
 * incomplete. 2 is deliberately not 0 — "couldn't check" must not read as "fine".
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = __dirname;
const TMP = path.join(__dirname, '..', 'tmp');

// Own subdirectory, not tmp/ directly. tmp/ is shared scratch space and a
// release-notes run in another session keeps its working artifacts there; a fixed
// name like tmp/151-152.json collides with whatever that run happens to be doing,
// and "cleaning up" one has already cost another session a ~4GB re-download.
const opts = {
  a: path.join(TMP, 'selftest', '151-152.json'),
  b: path.join(TMP, 'selftest', '152-153.json'),
};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--a') opts.a = process.argv[++i];
  else if (process.argv[i] === '--b') opts.b = process.argv[++i];
  else if (['-h', '--help'].includes(process.argv[i])) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
    process.exit(0);
  } else {
    console.error(`unknown argument: ${process.argv[i]}`);
    process.exit(1);
  }
}

const run = (script, args) =>
  execFileSync('node', [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });

let failed = 0;
let passed = 0;
const report = (name, problem) => {
  if (problem) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${problem}`);
  } else {
    passed++;
    console.log(`ok    ${name}`);
  }
};

const check = (name, fn) => {
  let problem;
  try {
    problem = fn();
  } catch (err) {
    problem = `threw: ${err.message}`;
  }
  report(name, problem);
};

const checkAsync = async (name, fn) => {
  let problem;
  try {
    problem = await fn();
  } catch (err) {
    problem = `threw: ${err.message}`;
  }
  report(name, problem);
};

/** The diff row for one test, or a message saying it is missing. */
const row = (diff, test) => diff.tests.find((t) => t.test === test);

const cases = [];

// ---------------------------------------------------------------------------
// Firefox 151 -> 152
// ---------------------------------------------------------------------------
cases.push({
  artifact: 'a',
  checks: (diff, file) => {
    const SVG = '/svg/types/scripted/SVGAnimatedEnumeration-SVGTextPathElement.html';
    const ANIM = '/web-animations/interfaces/Animatable/getAnimations.html';

    // Missed because a directory verdict absorbed it: /svg/types/scripted was
    // ticked as "new SVGLength tests" while holding this +1 *done* file.
    check('151-152: SVGTextPathElement.side file is present and *done*', () => {
      const r = row(diff, SVG);
      if (!r) return `${SVG} not in the diff`;
      if (!(r.before.pass < r.before.total && r.after.pass === r.after.total)) {
        return `expected partly-failing -> fully-passing, got ${r.before.pass}/${r.before.total} -> ${r.after.pass}/${r.after.total}`;
      }
      return null;
    });

    check('151-152: it gets its own box in the FILE CHECKLIST', () => {
      const out = run('wpt-inventory.js', [file, '--checklist']);
      return out.includes(SVG) ? null : 'absent from the checklist output';
    });

    // Its evidence names nothing ("...SVGTextPathElement 2" / "assert_true:
    // expected true got false"), so it must be flagged as needing the source.
    check('151-152: it is flagged (?) as evidence-that-names-nothing', () => {
      const out = run('wpt-inventory.js', [file, '--checklist']);
      const line = out.split('\n').find((l) => l.includes(SVG));
      if (!line) return 'absent from the checklist output';
      return line.startsWith('(?)') ? null : `expected a (?) box, got: ${line.slice(0, 40)}`;
    });

    // Missed for the opposite reason: not *done* (::part() still fails), so a
    // done-only worksheet gave it no box and it became an unexplained "+1".
    check('151-152: getAnimations pseudoElement evidence is loaded', () => {
      const r = row(diff, ANIM);
      if (!r) return `${ANIM} not in the diff`;
      if (!r.subtests) return 'no subtest names — regenerate the diff with --subtests';
      const names = r.subtests.newlyPassing.map((s) => s.name).join(' | ');
      return /pseudo-element|pseudoElement/i.test(names)
        ? null
        : `newly-passing names do not mention the pseudo-element: ${names}`;
    });

    check('151-152: that evidence appears in the inventory listing', () => {
      const out = run('wpt-inventory.js', [file, '--include', '/web-animations/interfaces/Animatable']);
      return /pseudo-element/i.test(out) ? null : 'inventory output does not show the subtest name';
    });

    // The shape that invites itself is a shell loop calling wpt-subtests.js once
    // per path, each call streaming two ~330MB reports. Several paths must resolve
    // in a single invocation or that cost comes straight back.
    check('151-152: wpt-subtests.js resolves several paths in one invocation', () => {
      const out = run('wpt-subtests.js', [
        file,
        SVG,
        ANIM,
        '--limit', '1',
      ]);
      const headers = (out.match(/^# \/.+$/gm) || []).length;
      if (headers !== 2) return `expected 2 per-path sections, got ${headers}`;
      if (/matched NOTHING/.test(out)) return 'one of the paths resolved to nothing';
      return null;
    });

    // A feature can ship across several directories; the vocabulary section is
    // the mechanical version of "group by feature, not by directory".
    check('151-152: field-sizing is linked across multiple directories', () => {
      if (!diff.vocabulary) return 'no vocabulary section — regenerate with --subtests';
      const v = diff.vocabulary.find((x) => x.token.toLowerCase() === 'field-sizing');
      if (!v) return 'field-sizing not in the vocabulary section';
      return v.dirs.length >= 2 ? null : `only ${v.dirs.length} directory`;
    });
  },
});

// ---------------------------------------------------------------------------
// Firefox 152 -> 153
// ---------------------------------------------------------------------------
cases.push({
  artifact: 'b',
  checks: (diff, file) => {
    // The exclusion that hid the Intl.Locale info proposal, twice: once as a
    // default --exclude in wpt-inventory.js, once as a hardcoded skip in
    // wpt-diff.js's cluster section.
    check('152-153: test262 Intl.Locale proposal is in the diff at all', () => {
      const hits = diff.tests.filter((t) => t.test.includes('/intl402/Locale/prototype/'));
      return hits.length >= 4 ? null : `only ${hits.length} intl402/Locale/prototype files`;
    });

    check('152-153: it surfaces as a directory cluster', () => {
      if (!diff.clusters) return 'no clusters section';
      const hit = diff.clusters.some((c) => c.dir.includes('intl402/Locale'));
      return hit ? null : 'no intl402/Locale cluster — is third_party being excluded again?';
    });

    check('152-153: dynamic-import surfaces as a directory cluster', () => {
      if (!diff.clusters) return 'no clusters section';
      const hit = diff.clusters.some((c) => c.dir.includes('dynamic-import'));
      return hit ? null : 'no dynamic-import cluster';
    });

    check('152-153: the inventory does not exclude test262 by default', () => {
      const out = run('wpt-inventory.js', [file, '--dirs']);
      return out.includes('/third_party/test262')
        ? null
        : 'no third_party/test262 directories listed';
    });

    // Reftests carry no subtests, so every ranked view scores them 0.
    check('152-153: reftest rendering fixes are classified with a direction', () => {
      const fixed = diff.tests.filter((t) => t.statusDirection === 'fixed').length;
      return fixed > 0 ? null : 'no statusDirection:"fixed" rows — reftest fixes are invisible';
    });

    check('152-153: churn is not counted as cluster movement', () => {
      if (!diff.clusters) return 'no clusters section';
      // /svg/geometry/parsing was 23 brand-new tests reported as 21 improved.
      const bad = diff.clusters.find((c) => c.dir === 'svg/geometry/parsing');
      return bad ? `pure-churn directory present as a cluster: ${JSON.stringify(bad)}` : null;
    });
  },
});

// ---------------------------------------------------------------------------
// Transport (scripts/lib/net.js)
// ---------------------------------------------------------------------------
// This layer had no coverage while it was hand-rolled, and two bugs got through
// in one sitting — both of which failed misleadingly rather than loudly. A
// truncated or silently-empty transfer poisons every downstream conclusion, so
// the properties that matter are asserted here: a real streaming body, correct
// decompression, and that a large transfer arrives COMPLETE.
async function transportChecks() {
  const { netFetch } = require(path.join(SCRIPTS, 'lib', 'net.js'));

  let runs = null;
  await checkAsync('net: JSON over the wire (proxy-aware if one is configured)', async () => {
    const res = await netFetch('https://wpt.fyi/api/runs?product=firefox&label=stable&max-count=1');
    if (!res.ok) return `wpt.fyi returned ${res.status}`;
    runs = await res.json();
    return Array.isArray(runs) && runs.length ? null : 'no runs in the response';
  });
  if (!runs) return;

  await checkAsync('net: body is a streaming ReadableStream, not a buffered string', async () => {
    const res = await netFetch(`https://wpt.fyi/api/runs?run_ids=${runs[0].id}`);
    const isStream = res.body && typeof res.body.getReader === 'function';
    await res.arrayBuffer();
    return isStream ? null : `res.body is ${res.body && res.body.constructor.name}`;
  });

  await checkAsync('net: Content-Encoding is undone, exposing the stored gzip layer', async () => {
    const res = await netFetch(runs[0].results_url);
    const buf = Buffer.from(await res.arrayBuffer());
    // The summary blobs are stored gzipped AND served gzipped. After one layer is
    // undone this must be either plain JSON or a single remaining gzip stream —
    // never a double-encoded body, which is what a missing decompression looks like.
    const stillGzip = buf[0] === 0x1f && buf[1] === 0x8b;
    const text = stillGzip ? require('zlib').gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return `summary did not decode to JSON: ${err.message}`;
    }
    return Object.keys(parsed).length > 10000 ? null : `only ${Object.keys(parsed).length} tests`;
  });

  await checkAsync('net: a ~330MB stream arrives complete, not truncated', async () => {
    const url = runs[0].raw_results_url;
    if (!url) return 'run has no raw_results_url';
    const res = await netFetch(url);
    let bytes = 0;
    let tail = '';
    const decoder = new (require('string_decoder').StringDecoder)('utf8');
    for await (const chunk of res.body) {
      bytes += chunk.length;
      // Keep only the end, to prove the transfer reached the end of the document.
      tail = (tail + decoder.write(Buffer.from(chunk))).slice(-4096);
    }
    if (bytes < 50_000_000) return `only ${(bytes / 1e6).toFixed(1)}MB — transfer looks truncated`;
    // A complete wptreport ends with the closing brace of the top-level object.
    return tail.trimEnd().endsWith('}') ? null : `stream ended mid-document (${(bytes / 1e6).toFixed(0)}MB)`;
  });
}

// ---------------------------------------------------------------------------
// Artifact-independent
// ---------------------------------------------------------------------------
function pathBoundaryChecks(file) {
  check('--include matches on a path boundary, not a string prefix', () => {
    const out = run('wpt-inventory.js', [file, '--dirs', '--include', '/dom']);
    return /^\/domparsing/m.test(out) ? '--include /dom leaked /domparsing' : null;
  });
  check('--exclude matches on a path boundary, not a string prefix', () => {
    const out = run('wpt-inventory.js', [file, '--dirs', '--exclude', '/web-animations']);
    return /^\/web-animations\b/m.test(out) ? '--exclude did not drop /web-animations' : null;
  });
}

(async () => {
  // Transport first: if the network layer is broken, every artifact-based check
  // below is either stale or about to be regenerated from bad data.
  await transportChecks();

  let missing = 0;
  for (const c of cases) {
    const file = opts[c.artifact];
    if (!fs.existsSync(file)) {
      missing++;
      console.log(`SKIP  ${path.basename(file)} not found — cannot check ${c.artifact === 'a' ? '151->152' : '152->153'}`);
      continue;
    }
    const diff = JSON.parse(fs.readFileSync(file, 'utf8'));
    c.checks(diff, file);
  }

  const anyArtifact = [opts.a, opts.b].find((f) => fs.existsSync(f));
  if (anyArtifact) pathBoundaryChecks(anyArtifact);

  console.log('');
  console.log(`${passed} passed, ${failed} failed${missing ? `, ${missing} artifact(s) missing` : ''}`);
  if (failed) process.exit(1);
  if (missing) {
    console.log('');
    console.log('Coverage is INCOMPLETE — generate the artifacts and re-run (see --help).');
    process.exit(2);
  }
})();
