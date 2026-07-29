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

Intermediate artifacts go in `tmp/`, which is gitignored — a `diff.json` is ~600KB and
changes daily as new runs land, so never commit one. Bare `--json` picks the `tmp/` path.
The finished notes go in `release-notes/` (also gitignored) — see step 6.

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

## Step 2: Read the whole inventory

**Start here, before any ranked view. Subtest count is not a signal of importance, so
there is no threshold below which a change is safely ignorable.** The delta of a fix
measures how many assertions happened to still be failing beforehand — nothing more:

```
css/selectors/webkit-pseudo-element.html     5/6  -> 6/6   (+1)
    -webkit- prefixed pseudo-elements now parse as valid
.../customizable-select/select-parsing.html  10/17 -> 17/17 (+7)
    the <select> parser keeps all nested elements
```

Both shipped features. Both were sitting in ranked output on a real pass and dismissed as
rounding error next to a `+664`. No smarter ranking fixes this, because the premise is
wrong. So read everything:

```bash
node scripts/wpt-inventory.js $D --checklist # THE WORKSHEET — start here
node scripts/wpt-inventory.js $D --dirs      # ~200 lines: every directory that moved
node scripts/wpt-inventory.js $D             # every changed file, grouped by directory
node scripts/wpt-inventory.js $D --completed # files that reached 100% — see below
node scripts/wpt-inventory.js $D --regressions
```

**Use `--checklist` and finish it.** It emits ~160 unticked directories, each needing one
of three verdicts: *written up*, *explained* (same cause as another entry — name which), or
*not a feature* (infrastructure, flake, churn — say why). Churn-only directories arrive
pre-resolved.

A hard requirement, because "read it all" already failed as an instruction: the Popover API
rework was missed while `/html/semantics/popovers [5 files, +19 subtests, 5 fwd, 5 done]`
was on screen and had been quoted as "not yet examined". Nothing was missing but a
completion criterion, so "read 202 directories" degraded into "read the 15 interesting
ones". Two rules follow:

- **Verdict every line before writing any prose.** Drafting the big findings first and
  returning to the list later is the exact path that skipped popovers.
- **"Worth a look" is not resolved.** Look now or mark it explicitly unresolved.

**Don't add `--exclude`.** Every filter is somewhere a feature can hide. An earlier default
of `/third_party` hid the entire `Intl.Locale` info proposal — 42 files under
`third_party/test262/test/intl402/Locale/prototype/get*/`, every one `0/1 -> 1/1`.

**JavaScript and `Intl` features live in `third_party/test262`**, never under `/css`,
`/html` or any area you would think to check. One assertion per file makes it *look* like
uniform noise and makes `*done*` unusually precise: `0/1 -> 1/1` is one named spec assertion
starting to hold, and dozens under one proposal's directory is a cleaner "shipped" signal
than most web-platform directories produce. Scan the `test262` block for proposal-shaped
directory names (`intl402/Locale/prototype/getTimeZones`,
`language/expressions/dynamic-import`) rather than skimming past it.

**Watch the `*done*` marker.** It flags a file that went from partly failing to fully
passing — every remaining failure cleared. That is the strongest available "a feature
shipped" signal *and* it is independent of delta size, which is exactly the combination
ranking destroys: `webkit-pseudo-element.html` is `+1 *done*`. A small delta with `*done*`
means "small because it was nearly finished", not "small because it doesn't matter".

**Skip the `<- all test-suite churn` directories.** Those contain only `added`/`removed`
tests, which mean the two runs are on different WPT revisions, not that the browser
changed. Roughly 40 directories in a typical two-release diff are pure churn.

Then drill into anything interesting — never guess a feature from a directory name:

```bash
node scripts/wpt-area.js $D /fetch --kinds        # summary + rollup
node scripts/wpt-area.js $D /fetch                # biggest movers in one area
node scripts/wpt-area.js $D --regressions         # all regressions
```

Areas are usually dominated by one or two test files. Read the filenames: they name the
feature. In one run, the entire `fetch` gain was `compression-dictionary/*`, and the
entire `webcodecs` gain was `h265`/`hevc` variants — invisible at the area level.

The **"Directory clusters"** section of `tmp/diff.txt` ranks directories by how many files
moved and how one-sided the movement was, so it links one change across several directories
— the `<select>` work also moved 28 files in `/html/syntax/parsing`, which otherwise reads
as an unrelated parser area. It excludes nothing by path, so test262 proposals surface here
too (`dynamic-import/catch`, 48 files). Still a ranked view: a feature that moved one file
or moved files both ways never appears. A hint, not the coverage guarantee. `--cluster-min`
and `--cluster-ratio` loosen the two filters if you want a wider sweep.

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

For every test file you plan to write about, diff its individual subtests **with
`--limit 0`, and read every line of the output**:

```bash
node scripts/wpt-subtests.js $D /web-animations/interfaces/AnimationEffect/getComputedTiming.html --limit 0
node scripts/wpt-subtests.js $D "/webrtc/idlharness.https.window.html?exclude=(RTCError|RTCErrorEvent)" --limit 0
```

**Never pipe this through `head`, `tail`, or a `sed` range when deciding what a file
means.** It is the one mistake that produces a *confidently wrong* finding rather than a
visible gap — you have the right file, so nothing feels missing. A real pass read
`webrtc-stats/supported-stats.https.html`'s 24 new subtests via `tail -35`, saw the last 6
(candidate stats), wrote up exactly those, and missed the 12 `RTCTransportStats` properties
(`dtlsCipher`, `dtlsRole`, `tlsVersion`, `srtpCipher`, …) in the middle — a whole stats type
newly reported, not IDL polish. Long output is information about a file's importance, not a
reason to sample it.

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
- **Account for all of them.** If a file gained 24 subtests, your description should cover
  what all 24 were about, even if you only write up the interesting ones. A file whose
  subtests fall into two or three distinct groups is two or three findings — the
  `supported-stats` file above was "a new stats type is reported" *and* "an existing
  property spread to four more types", and reporting only the second understated it.
  Before moving on, ask: *which subtests have I not accounted for?*

Apply the same rule to regressions — `cookieStore.set` losing two subtests turned out to
be `expected "cookie-value" but got "deleted"`, which is a describable bug rather than a
number.

**A matching directory name is not evidence.** The trap is worst when you already hold a
claim — a changelog entry, a bug, "did X ship?" — and a directory whose name matches it
moved. A changelog said WebDriver *Perform Actions* now awaits action finalization, fixing
races; both `perform_actions` directories had indeed moved `+1`. The newly-passing subtests
were `test_move_to_inline_block_child` and `test_element_center_point_inline_block_child`,
both failing on `assert 8 == 24.0 ± 1.0` — a coordinate bug for inline-block children, a
different fix that happens to live in the same directory.

So the question is never "did this directory move?" but "do the assertion messages describe
*this* behaviour?" Sometimes they match nearly word for word —
`test_new_shared_worker[navigator.language]` failing `assert 'en-US' == 'de-DE'` is
unambiguously locale emulation reaching shared workers. When they don't, you have found a
*different* change, still worth reporting under its own name.

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

**Every filter — and every early stop — is somewhere a feature can hide.** Seven findings
were missed or misdescribed across one real release-notes pass, each to a different
mechanism, every one of them caught by a reader who knew the changelog rather than by the
tooling:

| Missed | Mechanism |
| --- | --- |
| customizable `<select>` parsing | magnitude ranking buried a 13-file, `+22` cluster inside `/html`'s `+453` |
| `-webkit-` pseudo-element parsing | a one-file `+1` dismissed by eye as parser trivia |
| `Intl.Locale` info proposal | a `--exclude /third_party` default that looked obviously reasonable when written |
| Popover API hint/auto | **an incomplete read** — the signal was maximal and on screen |
| `RTCDtlsTransport.getRemoteCertificates()` | same: `/webrtc` left unticked, one directory from one that was examined |
| `RTCTransportStats` | **a partial read of the right file** — `tail -35` hid 12 of 24 subtests, yielding a confident half-description |
| WebDriver *Perform Actions* | nearly mis-attributed: right directory, but the subtests were a coordinate bug (see step 3) |
| `:muted` content attribute | not in the diff at all: `unchanged` in both runs (see below) |

Only the first is a tooling problem; rows four onward all happened *after* the tooling was
fixed. **Every place output gets shortened is a place a feature disappears** — a rank cut, a
default exclusion, a `tail`, or simply stopping when the interesting-looking entries run
out. Prefer reading more with no filter over reading less with a clever one.

**When someone asks whether a change is missing, assume they're right until the data says
otherwise** — and verify it properly rather than grepping paths for their wording. See
"Checking a specific claim" below.

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

**Gate: is every `--checklist` line resolved?** If not, go back to step 2. Drafting feels
like progress and reading the remaining 140 directories doesn't — that asymmetry is how the
Popover API rework was missed.

Write to `release-notes/`, not `tmp/`, so a later `rm -rf tmp/` can't take the notes with
it. Name the file after what was compared: `release-notes/firefox-153.md` for a
version-to-version diff, `firefox-nightly-vs-beta.md` for a channel one. The directory is
gitignored — the notes are regenerable and go stale as new runs land, so publish by copying
elsewhere rather than committing.

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

## Checking a specific claim

A common follow-up is not "what changed?" but "is *this* in the release?" — someone has a
changelog entry, a bug number, or a half-memory, and wants it verified against the data.
This is a different search from step 2 and has its own failure modes.

**Search test contents, not just paths.** A filename may not contain any word from the
claim. A `:muted` pseudo-class change lives in `css/selectors/media/sound-state.html`; a
path grep for "muted" finds `muted-playbackrate.tentative.html`, which is about
`playbackRate` and unrelated. Grep the inventory, then grep the test sources:

```bash
node scripts/wpt-inventory.js $D | grep -i -B4 '<keyword>'
node scripts/wpt-fetch-tests.js <candidate-path> --head 0 | grep -n '<api-name>'
```

**Then confirm via the assertion messages** — see "a matching directory name is not
evidence" in step 3.

There are four honest answers, and three of them are not "yes":

| Finding | Report it as |
| --- | --- |
| Tests moved, messages describe the claim | Confirmed. Quote the message and path. |
| Tests moved, messages describe something else | A *different* change. Report both facts. |
| Test exists, identical in both runs | Not in this diff. Check absolute state (below) before saying "not shipped". |
| No test matches at all | No WPT coverage. Say so plainly. |

**A diff cannot tell you a feature is still missing.** If a file has the same pass count in
both runs it is `unchanged` and legitimately absent from the diff — so "not in the diff"
never means "not shipped". Load both runs' full summaries and compare absolute state:

```bash
node -e "
const d=require('./$D');
(async()=>{for(const side of ['before','after']){
  const res=await fetch(d[side].results_url); const buf=Buffer.from(await res.arrayBuffer());
  const txt=buf[0]===0x1f?require('zlib').gunzipSync(buf).toString():buf.toString();
  const s=JSON.parse(txt); const k='<test-path>';
  console.log(side, d[side].browser_version, JSON.stringify(s[k]));
}})()"
```

Things with no WPT coverage at all, and so invisible here regardless: rendering fixes with
no reftest, "stopped working after several navigations"-style bugs, event *ordering* changes
where only the negative case is tested, and anything whose spec has no tests yet. Absence of
evidence is genuinely not evidence of absence — say "no coverage", not "didn't ship", and
point at Bugzilla for confirmation.

## Reference

- API docs: https://github.com/web-platform-tests/wpt.fyi/blob/main/api/README.md
- Results UI: `https://wpt.fyi/results/<test-path>?product=firefox@beta&product=firefox@experimental`
- Test source: `https://github.com/web-platform-tests/wpt/blob/master/<path>`
- `/api/runs` rejects `product=firefox@beta` (400); channels go via `label`, and one
  `label` applies to all products — which is why `--aligned` intersects `/api/shas`
  per spec instead of using `aligned=true`.
- Summary blobs are `summary_v2` gzipped JSON: `{"/test.html": {"s": "O", "c": [pass, total]}}`.
