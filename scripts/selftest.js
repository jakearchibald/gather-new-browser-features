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
 * behaviour. Artifacts live in tmp/ and are gitignored, so generate them first:
 *
 *   node scripts/wpt-diff.js --from firefox@stable@151 --to firefox@stable@152 \
 *        --subtests --json tmp/151-152.json > tmp/151-152.txt
 *   node scripts/wpt-diff.js --from firefox@stable@152 --to firefox@stable@153 \
 *        --subtests --json tmp/152-153.json > tmp/152-153.txt
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

const opts = { a: path.join(TMP, '151-152.json'), b: path.join(TMP, '152-153.json') };
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
const check = (name, fn) => {
  let problem;
  try {
    problem = fn();
  } catch (err) {
    problem = `threw: ${err.message}`;
  }
  if (problem) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${problem}`);
  } else {
    passed++;
    console.log(`ok    ${name}`);
  }
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
