---
name: wpt-release-notes
description: Generate developer-facing release notes by diffing web-platform-tests pass rates between two browser builds on wpt.fyi (e.g. Firefox nightly vs beta, or Chrome stable vs Firefox nightly). Use when asked what changed between browser versions/channels, what features a browser newly supports, or to write release notes / "what's new for developers" from WPT data.
---

# WPT release notes

Turn wpt.fyi test results into release notes that tell web developers what they can
now do. The scripts produce the data; the value you add is naming the *features* and
writing *accurate* code examples.

**Web developers don't care about pass rates. They care about features and fixed bugs.**
A pass-rate number is a means to find the story, never the story itself. "fetch improved
0.4%" is useless; "Compression Dictionary Transport now works" is the actual news, and
it's the same fact. Always push through to the feature name.

## Step 1: Generate the diff

```bash
mkdir -p tmp
node scripts/wpt-diff.js --from firefox@beta --to firefox@nightly --json --top 25 > tmp/diff.txt
# -> writes tmp/firefox-beta-vs-firefox-experimental.diff.json (the path is printed; call it $D)
```

All generated artifacts go in `tmp/`, which is gitignored — a `diff.json` is ~600KB and
changes daily as new runs land, so never commit one. Bare `--json` picks the `tmp/` path.

Specs are `product[@channel]`. Channels: `stable`, `beta`, `experimental` (aliases:
`nightly`, `release`, `tp`). Any two specs work, including cross-browser:

```bash
node scripts/wpt-diff.js --from chrome@stable --to firefox@nightly --json tmp/cross.json
```

Add `--aligned` to force both runs onto the same WPT revision. Prefer it when you need
confidence in small deltas; it may pick older runs, and it fails with a clear message
when no shared revision exists (common between release channels).

The script classifies each test file, which is what makes the analysis possible:

| Kind | Meaning |
| --- | --- |
| `newly-running` | Was `ERROR`/`CRASH`/`TIMEOUT`/`NOTRUN`/`PRECONDITION_FAILED`, now executes. **Strongest signal a feature shipped** — the harness previously aborted because the API was absent. |
| `improved` / `regressed` | More / fewer subtests passing |
| `newly-broken` | Now errors, crashes or times out |
| `added` / `removed` | Test exists on only one side |
| `status-changed` | Harness status flipped with no subtest change — mostly reftests, i.e. rendering fixes. `statusDirection` records which way it went |
| `subtests-changed` | Subtest total changed, pass count didn't |

## Step 2: Find what actually moved

`tmp/diff.txt` ends with a per-area rollup. For each interesting area, drill in — never
guess a feature from a directory name:

```bash
node scripts/wpt-area.js $D /fetch --kinds        # summary + rollup
node scripts/wpt-area.js $D /fetch                # list biggest movers
node scripts/wpt-area.js $D /css/css-typed-om --limit 30
node scripts/wpt-area.js $D --regressions         # all regressions
```

Areas are usually dominated by one or two test files. Read the filenames: they name the
feature. In one run, the entire `fetch` gain was `compression-dictionary/*`, and the
entire `webcodecs` gain was `h265`/`hevc` variants — invisible at the area level.

**Don't skip the reftests.** A reference-image test contributes no subtests, so a
rendering fix reads `FAIL 0/0 -> PASS 0/0` — a `deltaPass` of 0, invisible to anything
that ranks by subtest delta. `tmp/diff.txt` gives them two sections of their own plus an
"areas that moved only in reftests" rollup, and `--improvements`/`--regressions` include
them. There is no assertion message to quote, so group them by directory and say what the
directory covers. They are not a footnote: one Firefox stable→beta diff had 140 now
passing and 8 now failing, including a `css/css-transforms` regression cluster that no
subtest count would have surfaced.

## Step 3: Find the *cause* — read the subtest messages

**A subtest count names a file, not a cause.** This is the step that most changes what
the notes say, and it is not optional for any headline item.

For every test file you plan to write about, diff its individual subtests:

```bash
node scripts/wpt-subtests.js $D /web-animations/interfaces/AnimationEffect/getComputedTiming.html
node scripts/wpt-subtests.js $D "/webrtc/idlharness.https.window.html?exclude=(RTCError|RTCErrorEvent)"
```

It prints newly-passing and newly-failing subtests **with the assertion message from the
failing side** — the actual expected-vs-got — plus a rollup of how often each message
recurs. Quote paths exactly, including any `?query` variant. It streams the raw
`report.json` (100MB+) and filters to the one path, so allow a few seconds per file.

Why this is mandatory: `getComputedTiming() 26/41 → 41/41` reads like fifteen timing
fixes. The messages showed all fifteen were `startTime expected 0 but got undefined` —
**one missing property**. Ten of those tests assert `startTime` first, so a single line
failed them all. "15 subtests fixed" and "1 property added, unblocking 15 tests" are
different release notes, and only one is true.

Read the rollup at the end:

- **One message dominating** → one bug. Say so, name it, and give the example that
  reproduces it. Do not enumerate the tests.
- **Several distinct messages** → several fixes; group by message, not by file.
- The message text is also your vocabulary: property names, method names, real values.
  `RTCIceCandidatePair … expected property missing` names a feature; "IDL conformance
  gains" does not.

Apply the same rule to regressions — `cookieStore.set` losing two subtests turned out to
be `expected "cookie-value" but got "deleted"`, which is a describable bug rather than a
number.

## Step 4: Read the tests before writing examples

**Do not invent API syntax.** Fetch the tests that changed state and copy from them:

```bash
node scripts/wpt-fetch-tests.js --from-diff $D --area /webtransport --top 3
node scripts/wpt-fetch-tests.js /css/css-values/progress-computed.html --head 80
```

This handles `.any.js` generated variants (`foo.any.worker.html` → `foo.any.js`).
Every snippet in the notes should trace to a test that now passes. This is the single
biggest accuracy win: spec-shaped guesses look plausible and are often wrong.

## Step 5: Interpret — the traps

Apply these before writing. Each one produced a wrong conclusion on a first pass:

**N subtests fixed is not N fixes.** See step 3 — a big count is often one small change
with wide reach, and counting tests instead of causes inflates the notes.

**A rising denominator can look like a regression.** If a test previously aborted at
`ERROR 0/0` and now runs 325 subtests with 205 passing, the *area pass rate can fall*
while support clearly improved. Check absolute `deltaPass`, not just rate.

**A uniform failure across a whole suite is usually infrastructure.** When all 46
`encrypted-media/drm-*` tests time out — including ones already failing — that's a
CDM/codec provisioning failure on the test machine, not 46 code regressions. Signal:
tests with `deltaPass === 0` flipping to `TIMEOUT`. Say it's suspect.

**A pass rate can be built on a handful of tests.** Suites like `jpegxl` are mostly
reference-image tests contributing no subtests, so a "5.9% → 100%" headline can rest on a
few scripted files. Check how many files actually moved before writing a dramatic number.

**Different WPT revisions mean churn.** Without `--aligned`, some diff is new or
rewritten tests, not browser change. Large consistent moves are real; single-subtest
deltas need `--aligned` before you trust them.

**One feature moves several areas.** CSS Typed OM landing also fixed MathML
`attributeStyleMap` tests and added container-query unit factories. Group by feature, not
by directory, or you'll report one change three times.

**Partial runs land on wpt.fyi.** A real Firefox nightly once published a summary with
only 2 test files; naively taking the latest run yields a diff where all ~120k tests look
`removed`. `wpt-diff.js` skips runs with fewer than 10,000 test files and prints a
`note: skipped N incomplete run(s)`. If a diff claims almost everything was removed or
added, suspect this before believing it — and sanity-check that the total is ~120k.

**`tentative` in a path means the spec is unstable.** Flag these as experimental.

**Nightly ≠ shipped.** Features may be behind a pref. WPT shows what runs in the
harness, not what users have. State this caveat, and if the notes are going anywhere
public, say that pref status needs checking against Bugzilla or release notes.

## Step 6: Write the notes

Structure by feature, biggest developer impact first:

- **A heading per feature**, named as developers know it ("Scroll-driven animations",
  not "scroll-animations"), with a short plain-English description of what it enables.
- **A code example** for anything developers can now use, copied from the tests.
- **What specifically works**, from the test filenames *and subtest names* — method names,
  property values, keywords. Specificity is the product.
- **Bug fixes** as a separate lighter section: **what was broken, in the terms the
  assertion message used**, and what works now. "`getComputedTiming().startTime` returned
  `undefined`" beats "timing fixes"; the message from step 3 gives you that sentence, and
  often a before/after snippet showing the old wrong value.
- **Regressions**, framed by developer impact. Lead with anything security-related.
  Separate probable-infrastructure items and label them as such.
- **A method note**: the two runs, run IDs, WPT revisions, and the churn caveat.

Mention subtest counts only as supporting evidence for a claim ("70/196 → 195/196"), never
as the headline — and never as a proxy for how many things were fixed (see step 3). Cite
test paths so claims are checkable.

## Reference

- API docs: https://github.com/web-platform-tests/wpt.fyi/blob/main/api/README.md
- Results UI: `https://wpt.fyi/results/<test-path>?product=firefox@beta&product=firefox@experimental`
- Test source: `https://github.com/web-platform-tests/wpt/blob/master/<path>`
- `/api/runs` rejects `product=firefox@beta` (400); channels go via `label`, and one
  `label` applies to all products — which is why `--aligned` intersects `/api/shas`
  per spec instead of using `aligned=true`.
- Summary blobs are `summary_v2` gzipped JSON: `{"/test.html": {"s": "O", "c": [pass, total]}}`.
