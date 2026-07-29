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
node scripts/wpt-diff.js --from firefox@beta --to firefox@nightly --subtests --json --top 25 > tmp/diff.txt
# -> writes tmp/firefox-beta-vs-firefox-experimental.diff.json (the path is printed; call it $D)
```

**Always pass `--subtests`.** It streams both raw reports (~330MB each, ~10s total) and
records the newly-passing and newly-failing subtest *names* for every changed file. Those
names are the feature vocabulary, and without them every later step is reduced to guessing
a feature from a file path — which is how most of the misses in step 5 happened.
`getAnimations.html 29/34 -> 33/34` was written up as an unexplained "+1"; its subtest is
named `Returns animations on pseudo-element when it is specified`. Nothing needed inventing,
only loading.

Intermediate artifacts go in `tmp/`, which is gitignored — a `diff.json` is ~2.5MB with
`--subtests` and changes daily as new runs land, so never commit one. Bare `--json` picks
the `tmp/` path. The finished notes go in `release-notes/` (also gitignored) — see step 6.

Specs are `product[@channel][@version]`. Channels: `stable`, `beta`, `experimental`
(aliases: `nightly`, `release`, `tp`). Pin a version for notes between shipped releases —
once 153 is stable, `stable` no longer means 152 — and keep the channel alongside it:

```bash
node scripts/wpt-diff.js --from firefox@stable@152 --to firefox@stable@153 --subtests --json
```

Any two specs work, including cross-browser:

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

**Start here, before any ranked view. Subtest count is not a signal of importance, so there
is no threshold below which a change is safely ignorable.** A delta measures how many
assertions happened to still be failing beforehand, nothing more: `webkit-pseudo-element.html
5/6 -> 6/6 (+1)` was `-webkit-` prefixed pseudo-elements becoming valid, and
`customizable-select/select-parsing.html 10/17 -> 17/17 (+7)` was the `<select>` parser
keeping nested elements. Both shipped features, both sitting in ranked output and dismissed
as rounding error next to a `+664`. No smarter ranking fixes that, because the premise is
wrong. So read everything:

```bash
node scripts/wpt-inventory.js $D --checklist tmp/checklist.md   # THE WORKSHEET — start here
node scripts/wpt-inventory.js $D                                # every changed file + its subtest names
node scripts/wpt-inventory.js $D --dirs                         # one line per directory
node scripts/wpt-inventory.js $D --regressions
```

With `--subtests` in the diff, each file row carries the names that changed state, so a
verdict is usually available on the spot:

```
   +4  OK 29/34  -> OK 33/34  getAnimations.html
       + Returns animations on pseudo-element when it is specified
       + Throws SyntaxError for an invalid pseudo-element selector
```

**Finish the worksheet.** It writes **two** lists, both of which must be resolved. Each
line needs one of three verdicts: *written up*, *explained* (same cause as another entry —
name which), or *not a feature* (infrastructure, flake, churn — say why). Replace the box
with `[x]`/`(x)` and the verdict, in the file, then check:

```bash
node scripts/wpt-inventory.js --verify tmp/checklist.md   # exits non-zero while any remain
```

1. **`[ ]` directories** (200–400 on a two-release diff). Churn-only ones arrive resolved.
2. **`( )` / `(?)` files** — every `*done*` file plus every file whose evidence names
   nothing. **Ticking a directory does not tick these.**

This is enforced rather than advised because "read it all" failed twice as an instruction.
The Popover API rework was missed while `/html/semantics/popovers [5 files, +19 subtests,
5 fwd, 5 done]` was on screen and had been quoted as "not yet examined" — nothing was
missing but a completion criterion. Then `/svg/types/scripted` was ticked as "mostly new
SVGLength tests", true of five files and wrong about the sixth, which was
`SVGTextPathElement.side` shipping: a directory verdict absorbs the files inside it, and
"3 done" is a number you skim rather than a question you answer. Hence file-level boxes,
and a `--verify` that fails.

- **Verdict every line before writing any prose.** Drafting first and returning to the list
  later is the exact path that skipped popovers.
- **"Worth a look" is not resolved.** Look now or leave the box unticked.
- **A file need not reach 100% to be a shipped feature.** `getAnimations.html` stops at
  33/34 because `::part()` still fails. `*done*` is a strong signal, not a filter.

**A `(?)` box means the loaded evidence names nothing** — positional subtest names plus a
message like `assert_true: expected true got false`. That is measured from the subtest
names, not guessed from the path, so it is now rare (6 of 152 on one release rather than 16
by path guess). For those only, read the source:

```bash
node scripts/wpt-fetch-tests.js <path> --head 0
```

**Don't add `--exclude`.** Every filter is somewhere a feature can hide. An earlier default
of `/third_party` hid the entire `Intl.Locale` info proposal — 42 files under
`third_party/test262/test/intl402/Locale/prototype/get*/`, every one `0/1 -> 1/1`.

**JavaScript and `Intl` features live in `third_party/test262`**, never under `/css`,
`/html` or any area you would think to check. One assertion per file makes it *look* like
uniform noise and makes `*done*` unusually precise there: `0/1 -> 1/1` is one named spec
assertion starting to hold, and dozens under one proposal's directory is a cleaner "shipped"
signal than most web-platform directories produce. Scan that block for proposal-shaped
directory names (`intl402/Locale/prototype/getTimeZones`,
`language/expressions/dynamic-import`) rather than skimming past it.

**Watch the `*done*` marker.** Every remaining failure in the file cleared. It is the
strongest "a feature shipped" signal available *and* independent of delta size, the exact
combination ranking destroys: `webkit-pseudo-element.html` is `+1 *done*`. A small delta
with `*done*` means "small because it was nearly finished".

**Skip the `<- all test-suite churn` directories.** Only `added`/`removed` tests, which mean
the runs are on different WPT revisions, not that the browser changed.

Then drill into anything interesting:

```bash
node scripts/wpt-area.js $D /fetch --kinds        # summary + rollup
node scripts/wpt-area.js $D /fetch                # biggest movers in one area
node scripts/wpt-area.js $D --regressions         # all regressions
```

Areas are usually dominated by one or two test files. In one run the entire `fetch` gain was
`compression-dictionary/*` and the entire `webcodecs` gain was `h265`/`hevc` variants —
invisible at the area level.

Two sections of `tmp/diff.txt` generate leads the inventory's alphabetical order won't:

- **Directory clusters** ranks directories by how many files moved and how one-sided the
  movement was, linking one change across several directories — the `<select>` work also
  moved 28 files in `/html/syntax/parsing`, which otherwise reads as an unrelated parser
  area. Nothing is excluded by path, so test262 proposals surface here (`dynamic-import`,
  48 files). `--cluster-min` and `--cluster-ratio` widen it.
- **One feature, several directories** (needs `--subtests`) does the same on subtest
  vocabulary instead of paths: a token in newly-passing names under 2+ directories is
  probably one change. `field-sizing` appeared across `/css/css-cascade`, `/css/css-ui`,
  `/html/rendering/widgets` and `/web-animations` — one feature, four places, and the
  mechanical answer to "group by feature, not by directory".

Both are ranked, so both are hints. The inventory is the coverage guarantee.

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

Step 2 gives you the newly-passing subtest *names* for free. This step adds the assertion
messages — the expected-vs-got — and the rollup that tells one bug from many. For every
test file you plan to write about, **with `--limit 0`, and read every line**:

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

**A numbered subtest name is not a description — and the numbering is off by one.**
Anonymous `test(function(){...})` blocks are auto-named from the file title, zero-indexed
*after* the first: `"Foo"`, `"Foo 1"`, `"Foo 2"`, so `"Foo 2"` is the **third** block.
`SVGAnimatedEnumeration-SVGTextPathElement.html`'s one newly-passing subtest was
`"... SVGTextPathElement 2"`; its blocks cover `method`, `spacing` and `side`, and it was
first read as `spacing` — the second-sounding one — when it was `side`, the feature that
shipped. The inventory flags these files `(?)` and prints the warning. Count `test(` blocks
in the source rather than trusting the index:

```bash
node scripts/wpt-fetch-tests.js <path> --head 0 | grep -n '^test(\|^  assert'
```

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

**Every filter — and every early stop — is somewhere a feature can hide.** Ten findings
were missed or misdescribed across two real passes, each to a different mechanism, every one
caught by a reader who knew the changelog rather than by the tooling. `scripts/selftest.js`
now asserts the ones a tool can guard, so they fail loudly instead of being remembered:

| Missed | Mechanism | Guarded by |
| --- | --- | --- |
| customizable `<select>` parsing | magnitude ranking buried a 13-file `+22` cluster inside `/html`'s `+453` | Directory clusters |
| `-webkit-` pseudo-element parsing | a one-file `+1` dismissed by eye as parser trivia | unranked inventory |
| `Intl.Locale` info proposal | a `--exclude /third_party` default that looked obviously reasonable when written | selftest |
| Popover API hint/auto | an incomplete read — the signal was maximal and on screen | `--verify` |
| `RTCDtlsTransport.getRemoteCertificates()` | same: `/webrtc` left unticked, one directory from one examined | `--verify` |
| `RTCTransportStats` | a partial read of the right file — `tail -35` hid 12 of 24 subtests | loud truncation notice |
| WebDriver *Perform Actions* | nearly mis-attributed: right directory, wrong cause (see step 3) | nothing — read the messages |
| `:muted` content attribute | not in the diff at all: `unchanged` in both runs | `wpt-state.js` |
| `SVGTextPathElement.side` | a directory verdict absorbed a `+1 *done*` file named after an IDL interface | file-level boxes |
| `getAnimations({ pseudoElement })` | not `*done*` (`::part()` still fails), so a done-only worksheet gave it no box | `--subtests` evidence |

**Every place output gets shortened is a place a feature disappears** — a rank cut, a
default exclusion, a `tail`, or stopping when the interesting-looking entries run out.
Prefer reading more with no filter over reading less with a clever one.

The last two share a shape worth naming: **both were named after an IDL interface, and
neither path contained the word that named the feature** — `side` and `pseudoElement` appear
nowhere in `SVGAnimatedEnumeration-SVGTextPathElement.html` or `Animatable/getAnimations.html`.
When a filename describes a *type* rather than a *behaviour*, the path is not evidence, which
is the whole reason to load subtest names up front instead of inferring from paths.

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

**Gate — run this before writing a word:**

```bash
node scripts/wpt-inventory.js --verify tmp/checklist.md
```

Non-zero means go back to step 2. Drafting feels like progress and resolving the remaining
directories doesn't; that asymmetry is how the Popover API rework was missed, so the gate is
a command rather than a resolution.

Every `(?)` box must have had its **source fetched**, not its path guessed at, and every
boxed file needs a feature name or a stated reason it isn't one.
An entry in the notes reading "+1 `some-file.html`" with no feature named is not a
finding — it is an unresolved checklist line that got copied into prose. Two features were
lost that way in one release.

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

**Search subtest names, not just paths.** A filename may contain no word from the claim.
With `--subtests` the inventory carries the vocabulary, so grep that first, then the sources:

```bash
node scripts/wpt-inventory.js $D | grep -i -B6 '<keyword>'
node scripts/wpt-fetch-tests.js <candidate-path> --head 0 | grep -n '<api-name>'
```

A `:muted` pseudo-class change lives in `css/selectors/media/sound-state.html`; a path grep
for "muted" finds `muted-playbackrate.tentative.html`, which is about `playbackRate` and
unrelated. **Then confirm via the assertion messages** — see "a matching directory name is
not evidence" in step 3.

There are four honest answers, and three of them are not "yes":

| Finding | Report it as |
| --- | --- |
| Tests moved, messages describe the claim | Confirmed. Quote the message and path. |
| Tests moved, messages describe something else | A *different* change. Report both facts. |
| Test exists, identical in both runs | Not in this diff. Check absolute state before saying "not shipped". |
| No test matches at all | No WPT coverage. Say so plainly. |

**A diff cannot tell you a feature is still missing.** A file with the same pass count in
both runs is `unchanged` and legitimately absent from every view here, so "not in the diff"
never means "not shipped". `wpt-state.js` reads both full summaries and answers all three of
the non-confirmed cases:

```bash
node scripts/wpt-state.js $D --grep sound-state                        # does a test exist?
node scripts/wpt-state.js $D /css/selectors/media/sound-state.html     # its state in both runs
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
