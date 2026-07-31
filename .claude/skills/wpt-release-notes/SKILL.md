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

## Running the commands

**One bare command per call. Nothing before it, nothing after it.**

```bash
node scripts/wpt-inventory.js --dirs                 # yes
node scripts/wpt-subtests.js <path> --only newly-passing   # yes

export D=tmp/… && node scripts/wpt-inventory.js …    # NO
cd tmp/… ; node scripts/…                            # NO
node scripts/wpt-subtests.js <path> | head -40       # NO
node scripts/wpt-grep.js foo | grep 'PASS'           # NO
node scripts/…  ;  echo "---"  ;  node scripts/…     # NO — run them separately
```

Four reasons, all of which have already cost something:

- **A shell filter loses information invisibly.** Every view here already bounds itself:
  output is paged at block boundaries, the synopsis and the message rollups come *first*,
  and `--part`, `--only`, `--match`, `--include`, `--section` and `--top` narrow by meaning
  rather than by line position. A pipe adds nothing except loss. Receipts: a `sed` range
  arrived mangled but plausible; `tail -35` hid 12 of 24 subtests; `grep 'FAIL    -> PASS'`
  caught 1 of 21; `head -40` showed 10 of 36.
- **It turns every command into a permission prompt.** Rules match per sub-command across
  pipes, `;`, `&&` and newlines, so `| head` or a chained `echo` means nothing in the
  pipeline is pre-approved — even though the script itself is.
- **`export` does not persist.** Shell variables are gone by the next call, so a `$D`
  convention has to be repeated every time, and repeating it is what creates the compound
  command. Every script defaults to the only collected comparison and prints which it used;
  just omit the path.
- **`cd` *does* persist.** One `cd` makes `node scripts/…` unresolvable in every later
  command — and that failure happens before any script starts, so nothing can explain it.
  Stay at the repository root.

If output looks truncated, it will say so: `!! PART 2 OF 7` with the exact command to
continue, or `!! END — all N shown` when there is nothing more. Believe those lines rather
than reaching for a pipe.

**Put no quote characters in a command. Ever.** This is the whole rule, and it is stronger
than "avoid metacharacters", because a quote mark is itself enough to stop a command being
pre-approved. Two real failures, and the second is the one that matters:

```bash
node scripts/wpt-subtests.js --grep 'html5lib_url.html?file=webkit02'  # quoted for the ?
node scripts/wpt-grep.js 'popover=hint' --include /html/semantics/popovers   # quoted for NOTHING
```

Both prompted. In the second, `popover=hint` needs no quotes at all — `=` is an ordinary
character in an argument — so the quotes were added defensively and bought a permission
prompt for nothing. **Defensive quoting is not free.** `= - _ . /` never need quoting; only
`? ( ) | [ ] * $ ; < > & \` and spaces do.

So if a value would need quotes, **choose a different value** rather than quoting it. 17% of
changed paths are WPT variants like `url-setters.any.html?exclude=(file|javascript|mailto)`,
where `?` is a glob, `(…)` a glob group and `|` a pipe. Quoting genuinely is required to
pass such a path to the shell — and it still prompts, so passing it is the wrong move.
`--grep` on a metacharacter-free fragment has neither problem:

```bash
node scripts/wpt-subtests.js --grep url-setters                   # yes
node scripts/wpt-subtests.js /a.html /b.html --grep url-setters   # yes — additive
node scripts/wpt-subtests.js '/html/syntax/parsing/html5lib_url.html?file=webkit02'  # runs, but prompts
node scripts/wpt-subtests.js --grep webkit02                       # same test, no prompt
node scripts/wpt-subtests.js /url/url-setters.any.html?exclude=(file|javascript|mailto)    # NO — shell error
```

The tooling no longer offers you a quoted path to copy. Where a `?query` path appears in a
worksheet box or a suggested next command, it comes with the `--grep` fragment that reaches
it. Anything still shown quoted is labelled as the literal-path fallback, and says that it
will prompt.

`--grep <substring>` means the same thing on `wpt-inventory.js`, `wpt-subtests.js`,
`wpt-fetch-tests.js` and `wpt-state.js`: a case-insensitive path substring, repeatable, and
**additive with explicitly named paths** — so one command can mix "these two files" with
"and whatever matches this". It also picks up sibling variants you would otherwise name one
at a time. `--include` (and its alias `--area`) is the path-*prefix* selector for reading
one area in full.

Where a query path is printed, its safe form appears under it as `# paste as: …`, for the
rare case you do need it literally.

**`--verify` exiting 1 is the gate working, not a crash.** It exits non-zero until every
checklist box has a real verdict, and says `GATE: NOT READY — n/m ticked`. That is the
expected state for most of a pass. It also fails on a box that is ticked *without* a usable
verdict, so `n/m ticked` reaching `416/416` is not the same as passing.

## Step 1: Collect

**First, see what's actually on wpt.fyi.** Don't assume which version is current —
"the latest stable" changes under you, and notes between shipped releases need both
versions pinned. This is cheap (one API call per channel) and prints the collect
command for the two commonest comparisons:

```bash
pnpm install   # once; undici provides proxy-aware fetch, which Node's lacks
node scripts/wpt-runs.js                                      # firefox, all channels
node scripts/wpt-runs.js firefox --channel stable --max-count 40   # reach back a release
```

Use it rather than writing an ad-hoc `node -e` fetch: that loses the proxy support in
`lib/net.js` (bare `fetch` ignores `HTTP_PROXY`, so every host fails as `ENOTFOUND`
behind a proxy) and falls outside the permission allowlist.

Then collect. One command does all the remaining network work, and everything after it
is a local read:

```bash
node scripts/wpt-collect.js --from firefox@beta --to firefox@nightly
# -> tmp/firefox-beta-vs-firefox-experimental/
```

Takes a minute or two. It streams both raw reports (~330MB each), records **every**
subtest that changed state with its assertion message, stores both full summaries, and
fetches the source of every changed test at the revision its run was tested at.

**Every later command finds this directory by itself** — they default to the only
collected comparison in `tmp/` and print which one they used, so you never pass a path.
Name it explicitly only when several exist, in which case they refuse rather than guess.
The directory contains:

| File | What it is |
| --- | --- |
| `diff.json` | every changed test file, with complete subtest evidence |
| `report.txt` | the ranked view, directory clusters, shared vocabulary |
| `checklist.md` | the coverage worksheet — tick it in place |
| `boxes.json` | the box list as generated, so `--verify` can spot a lost box |
| `state.json.gz` | both full summaries, all ~120k tests |
| `sources/` | each changed test's source, at the right revision |

Specs are `product[@channel][@version]`. Channels: `stable`, `beta`, `experimental`
(aliases: `nightly`, `release`, `tp`). Pin a version for notes between shipped releases —
once 153 is stable, `stable` no longer means 152 — and keep the channel alongside it,
because nightly runs outnumber stable ones ~50:1 and an unlabelled version search never
reaches back far enough:

```bash
node scripts/wpt-collect.js --from firefox@stable@152 --to firefox@stable@153
node scripts/wpt-collect.js --from chrome@stable --to firefox@nightly
```

Add `--aligned` to force both runs onto the same WPT revision. Prefer it when you need
confidence in small deltas; it may pick older runs, and it fails with a clear message
when no shared revision exists (common between release channels, and impossible between
two pinned versions).

`tmp/` and `release-notes/` are gitignored. Never commit an artifact — it's a few MB and
goes stale as new runs land.

The collector classifies each test file, which is what makes the analysis possible:

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
node scripts/wpt-inventory.js --dirs      # the map: one line per directory
node scripts/wpt-inventory.js             # part 1 of the full listing
node scripts/wpt-inventory.js --part 2    # ...and so on, until it says it was the last
node scripts/wpt-inventory.js --regressions
node scripts/wpt-inventory.js --include /css/css-ui   # one area in full
```

Each of those is a complete command — see "Running the commands" above.

The full listing is ~86KB for a channel diff and several hundred KB for a two-release
one, so it arrives in **parts split at directory boundaries**. Each says which
directories it covered and which you have not read yet; keep going until one says it
was the last. `--verify` is still what proves you finished, not the part counter.

Each file row carries the names that changed state, so a verdict is usually available on
the spot:

```
   +4  OK 29/34  -> OK 33/34  getAnimations.html
       + Returns animations on pseudo-element when it is specified
       + Throws SyntaxError for an invalid pseudo-element selector
```

**Navigate with `--part` and `--include`, never with a line window.** Do not redirect the
inventory to a file and read line ranges out of it: a line window cuts across directories,
so a directory shows up with only some of its files and nothing marks the cut. `--part`
breaks only between directories and tells you what you have not yet seen; `--include` is
bounded and loses nothing. Both beat `head`, `tail` and `sed` on the only axis that
matters, which is whether you can tell what you missed.

**Finish the worksheet.** The artifact's `checklist.md` has **two** lists, both of which must be
resolved. Replace the box with `[x]`/`(x)` and append `" — <verdict>"`, one of:

```
[x] /css/css-values/tree-counting  — written up: sibling-index() / sibling-count()
[x] /css/css-images                — explained: sibling-index() in gradients (tree-counting)
[x] /fs                            — not a feature: flake, same subtest moved the other
                                     way in the worker variant of the same file
```

**Apply the verdicts as data, not as edits.** Write one file mapping each box path to
its verdict, with the **Write tool** — never a shell heredoc, which prompts every time:

```json
{
  "/css/css-values/tree-counting": "written up: sibling-index() / sibling-count()",
  "/css/css-images": "explained: same feature as /css/css-values/tree-counting",
  "/fs": "not a feature: flake, the same subtest moved the other way in the worker variant"
}
```

```bash
node scripts/wpt-resolve.js tmp/verdicts.json   # applies them, refuses on a bad key
node scripts/wpt-inventory.js --verify          # exits non-zero while any remain
```

This is the single biggest saving available. One instrumented pass spent **106 Edit
calls and ~40,000 output tokens — 22% of everything it generated — ticking boxes**, and
the run was output-bound end to end (180,385 tokens in 29.2 minutes, 103 tok/s
sustained). The same verdicts as a file are ~7,000 tokens, because an Edit has to
restate its surrounding context to anchor itself. Keys are **exact** box paths; a key
matching no box is an error that writes nothing, so a typo can't silently do nothing.
Resolve in as many passes as you like.

1. **`[ ]` directories** (200–400 on a two-release diff). Churn-only ones arrive resolved.
2. **`( )` / `(?)` files** — every `*done*` file plus every file whose evidence names
   nothing. **Ticking a directory does not tick these.**

`--verify` reads the verdicts, not just the boxes. Three things fail it:

- **A tick with no verdict**, or a verdict that defers instead of answering. `— written up
  — see notes` is rejected by name: it is what a bulk regex apply reaches for as its
  fallback, and one attempt at resolving a worksheet that way would have stamped all 416
  boxes and passed.
- **`explained` that names nothing findable.** It must point at another box's path, at
  another box's *written up* text, or at a numbered sibling (`same as -001`). Any of those
  three is fine, and phrasing does not matter — what matters is that following the
  reference lands somewhere. `explained: sundry plumbing wobbles` fails; it reads as an
  explanation while saying only that the line has been set aside.
- **A box that stopped existing.** The box list is recorded at collection time in
  `boxes.json`, and `--verify` compares by path. So **edit boxes in place; do not rewrite
  `checklist.md` wholesale.** A whole-file rewrite already dropped four lines on a real
  pass while leaving the count at 416, which the old tick-counting gate could not see.

**One verdict covers a variant family.** Boxes marked `[N variants]` fold together the
`?class=`/`?include=` variants and the `.any.worker`/`.any.html` globals of one source
file, listing every folded path. They are one question — the parameter picks which slice
runs, not which feature the file covers. A worksheet that asked separately answered
`text-box-trim-start-001.html` seventeen times, each a rewording of the last. Variants that
moved *differently* are deliberately still separate boxes, because two globals of one test
moving opposite ways is a flake signal that exists only as the comparison.

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
names, not guessed from the path, so it is rare (6 of 152 on one release rather than 16
by path guess). For those only, read the source:

```bash
node scripts/wpt-fetch-tests.js <path> --head 0
```

**Nothing is excluded, and there is no flag to exclude anything.** Every filter is
somewhere a feature can hide. An earlier default of `/third_party` hid the entire
`Intl.Locale` info proposal — 42 files under `third_party/test262/test/intl402/Locale/`,
every one `0/1 -> 1/1`.

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

Two sections of the ranked report generate leads the inventory's alphabetical order won't.
Read them with `wpt-report.js` rather than opening `report.txt` — both sections sit at the
*end* of that file, so a line-window read of it shows the overall stats and misses exactly
these:

```bash
node scripts/wpt-report.js --list                  # what sections exist
node scripts/wpt-report.js --section clusters
node scripts/wpt-report.js --section vocabulary
```


- **Directory clusters** ranks directories by how many files moved and how one-sided the
  movement was, linking one change across several directories — the `<select>` work also
  moved 28 files in `/html/syntax/parsing`, which otherwise reads as an unrelated parser
  area. Nothing is excluded by path, so test262 proposals surface here (`dynamic-import`,
  48 files). `--cluster-min` and `--cluster-ratio` widen it at collection time.
- **One feature, several directories** does the same on subtest vocabulary instead of
  paths: a token in newly-passing names under 2+ directories is probably one change.
  `field-sizing` appeared across `/css/css-cascade`, `/css/css-ui`,
  `/html/rendering/widgets` and `/web-animations` — one feature, four places, and the
  mechanical answer to "group by feature, not by directory".

Both are ranked, so both are hints. The inventory is the coverage guarantee.

**Don't skip the reftests.** A reference-image test contributes no subtests, so a
rendering fix reads `FAIL 0/0 -> PASS 0/0` — a `deltaPass` of 0, invisible to anything
that ranks by subtest delta. `report.txt` gives them two sections of their own plus an
"areas that moved only in reftests" rollup, and `--improvements`/`--regressions` include
them. There is no assertion message to quote, so group them by directory and say what the
directory covers. They are not a footnote: one Firefox stable→beta diff had 140 now
passing and 8 now failing, including a `css/css-transforms` regression cluster that no
subtest count would have surfaced.

## Step 3: Find the *cause* — read the subtest messages

**A subtest count names a file, not a cause.** This is the step that most changes what
the notes say, and it is not optional for any headline item. It is a local read, so there
is no reason to ration it:

```bash
node scripts/wpt-subtests.js /web-animations/interfaces/AnimationEffect/getComputedTiming.html
node scripts/wpt-subtests.js /path/one.html /path/two.html /path/three.html
node scripts/wpt-subtests.js --grep supported-stats     # when the ?query variant is fiddly
node scripts/wpt-subtests.js <path> --match '0%'        # bounded read, see below
node scripts/wpt-subtests.js <path> --part 2            # next page of a busy file
```

A busy file exceeds the tool output limit on its own — one 213-fix file is 66KB — so
output is **paged at subtest boundaries**, never inside an entry, with the synopsis
repeated on every page so each stands alone. Keep going until a page says it was the
last. That is also why the bare command on a big file can fail outright rather than
printing something short.

It opens with a **synopsis** — counts per category, and the dominant assertion message
among both the fixes and what still fails — then prints every subtest that changed state
**with the message from the failing side**, the actual expected-vs-got. For a path with a
`?query` variant, **use `--grep`** rather than the path (see "Running the commands").

**Why the no-pipe rule matters most here** (see "Running the commands"): this is the one
place a shell filter produces a *confidently wrong* finding rather than a visible gap — you
have the right file, so nothing feels missing. A real pass read
`webrtc-stats/supported-stats.https.html`'s 24 new subtests via `tail -35`, saw the last 6
(candidate stats), wrote up exactly those, and missed the 12 `RTCTransportStats` properties
(`dtlsCipher`, `dtlsRole`, `tlsVersion`, `srtpCipher`, …) in the middle — a whole stats type
newly reported, not IDL polish. Long output is information about a file's importance, not a
reason to sample it.

**A `sed` range is worse than `head`, because it fails quietly.** Slicing
`color-computed-color-mix-function.html` with `sed -n '/color-mix/,/^====/p'` looks
reasonable and arrives mangled: nearly every subtest name contains `color-mix`, so the
range restarts on almost every line, silently dropping the header, the section titles and
the synopsis. The result reads like a complete answer.

**When you want a bounded read, bound it by meaning with `--match` or `--only`.** `--match`
filters on name and message; `--only newly-passing` (also `newly-failing`, `changed`,
`removed`, `still-failing`) filters by transition category. Both say they filtered and
still report the file's true totals — so "51 of 57 still-failing subtests are `0%`-sum
mixes" is a claim you can make, which no line window can support.

**Do not grep for an arrow to get "just the newly-passing".** `grep 'FAIL    -> PASS'`
is lossy invisibly: it misses a subtest that was `NOTRUN` or `TIMEOUT` before, and misses
`(new)   -> PASS` — a brand-new assertion that holds — entirely. That last omission is how
an *entirely new interface* appears, so the pattern fails hardest on exactly the claim it
gets reached for. On one real diff it under-reported in 19 files, hiding 55 new-subtest
passes and 13 non-FAIL priors out of 1018. It also discards the `was:` messages, which are
the reason this step exists. Use `--only newly-passing`.

Why this step is mandatory: `getComputedTiming() 26/41 → 41/41` reads like fifteen timing
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
shipped. Both the inventory and this command flag these files and print the warning. Count
`test(` blocks in the source rather than trusting the index:

```bash
node scripts/wpt-fetch-tests.js <path> --blocks
```

That lists every test-registering call with its line number and the positional name the
harness would give it, so `"Foo 2"` maps to a block without counting by eye.

**The synopsis rollup is the answer — don't `head`/`tail` past it to go hunting.** Each
rollup group prints a normalised key *and* one unabridged `e.g.` example, because the
normalisation necessarily strips the expected-vs-got tail that names the cause. On
`color-valid-color-mix-function.html` the group reads `144x Colors do not match. Actual:
color-mix(…) Expected: color-mix(…)` and the example spells it out — `Actual:
color-mix(in hsl, red 60%, blue)` vs `Expected: color-mix(in hsl, red 60%, blue 40%)`,
i.e. the second percentage was omitted on serialization. That is 144 of 213 fixes named in
one line, with no second command.

Read the synopsis rollups:

- **One message dominating the fixes** → one bug. Say so, name it, and give the example
  that reproduces it. Do not enumerate the tests.
- **One message dominating what still fails** → one *limitation*, and the other half of an
  honest note. `color-mix` gained 0%-sum parsing while 51 of its 57 remaining failures were
  all `0%` mixes computing as transparent black — "color-mix improved" hides that; "0%-sum
  mixes now parse but still compute wrongly" is the useful sentence.
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

**An IDL member count is not a WPT finding.** When a dictionary or interface is newly
reported, the obvious next move is to read its definition — and then the *spec's* member
count silently becomes the claim. `RTCCertificateStats` has 4 newly-passing subtests in one
real diff (`fingerprint`, `fingerprintAlgorithm`, `base64Certificate`, plus one behavioural
test) and `RTCTransportStats` has 4 (`bytesSent`, `bytesReceived`, `localCertificateId`,
`remoteCertificateId`); both were first written up as "6 members", a number that came from
the IDL rather than from any test. The IDL tells you which members *exist*; only the
subtests tell you which ones a browser now *reports*. Count the subtests, and say "4 of its
members now report" rather than implying the whole dictionary landed.

**Added/removed *subtests* at the same WPT revision are a behaviour change, not churn.**
This one inverts. `text-decoration-inset-auto.html` went 52/73 → 73/73 with 20 subtests
removed and 20 added, and was written up as "the test's own restructuring, with one real
fix" — 20 of 21 dismissed. But both runs were at the same revision, so the test source was
byte-identical and no restructuring was possible:

```
removed:  … from [auto] to [10px -20px] at (-1) should be [NaNpx NaNpx]
added:    … from [auto] to [10px -20px] at (-1) should be [-7.44px 22.56px]
```

The expected value is baked into the subtest *name*, so a rename means the browser's
computed value changed: `text-decoration-inset: auto` had been computing to `NaN`. All 21
subtests are that one fix. `wpt-subtests.js` now detects the pairing and says so loudly —
but the words "added" and "removed" mean churn only when the revisions *differ*, and the
report's header tells you which case you are in. Check the revision before calling
anything churn.

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

**Do not invent API syntax.** The source of every changed test is already in the artifact's `sources/`,
pinned to the revision its run was tested at. Read it and copy from it:

```bash
node scripts/wpt-fetch-tests.js /css/css-values/progress-computed.html --head 80
node scripts/wpt-fetch-tests.js --area /webtransport --top 3
```

The pinning matters and is automatic. `master` is whatever the test says *today* rather
than what produced the result you are describing: between 151 and 152,
`parse-processing-instruction.tentative.html` is present at the run's revision and 404 on
`master` — and a test that was *rewritten* rather than deleted is worse, because it reads
cleanly and the snippet you copy never produced your result.

`.any.js` generated variants resolve to their generator (`foo.any.worker.html` →
`foo.any.js`), which is the file with real content. Every snippet in the notes should trace
to a test that now passes. This is the single biggest accuracy win: spec-shaped guesses look
plausible and are often wrong.

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
| `Intl.Locale` info proposal | a `--exclude /third_party` default that looked obviously reasonable when written | selftest; no `--exclude` exists now |
| Popover API hint/auto | an incomplete read — the signal was maximal and on screen | `--verify` |
| `RTCDtlsTransport.getRemoteCertificates()` | same: `/webrtc` left unticked, one directory from one examined | `--verify` |
| `RTCTransportStats` | a partial read of the right file — `tail -35` hid 12 of 24 subtests | loud truncation notice |
| WebDriver *Perform Actions* | nearly mis-attributed: right directory, wrong cause (see step 3) | nothing — read the messages |
| `:muted` content attribute | not in the diff at all: `unchanged` in both runs | `wpt-state.js` |
| `SVGTextPathElement.side` | a directory verdict absorbed a `+1 *done*` file named after an IDL interface | file-level boxes |
| `getAnimations({ pseudoElement })` | not `*done*` (`::part()` still fails), so a done-only worksheet gave it no box | complete subtest evidence |

**Every place output gets shortened is a place a feature disappears** — a rank cut, a
default exclusion, a `tail`, or stopping when the interesting-looking entries run out.
Prefer reading more with no filter over reading less with a clever one.

The last two share a shape worth naming: **both were named after an IDL interface, and
neither path contained the word that named the feature** — `side` and `pseudoElement` appear
nowhere in `SVGAnimatedEnumeration-SVGTextPathElement.html` or `Animatable/getAnimations.html`.
When a filename describes a *type* rather than a *behaviour*, the path is not evidence, which
is the whole reason subtest names are loaded up front instead of inferred from paths.

**When someone asks whether a change is missing, assume they're right until the data says
otherwise** — and verify it properly rather than grepping paths for their wording. See
"Checking a specific claim" below.

**Partial runs land on wpt.fyi.** A real Firefox nightly once published a summary with
only 2 test files; naively taking the latest run yields a diff where all ~120k tests look
`removed`. `wpt-collect.js` skips runs with fewer than 10,000 test files and prints a
`note: skipped N incomplete run(s)`. If a diff claims almost everything was removed or
added, suspect this before believing it — and sanity-check that the total is ~120k.

**`tentative` in a path means the spec is unstable.** Flag these as experimental.

**Nightly ≠ shipped.** Features may be behind a pref. WPT shows what runs in the
harness, not what users have. State this caveat, and if the notes are going anywhere
public, say that pref status needs checking against Bugzilla or release notes.

## Step 6: Write the notes

**Gate — run this before writing a word:**

```bash
node scripts/wpt-inventory.js --verify
```

Non-zero means go back to step 2. Drafting feels like progress and resolving the remaining
directories doesn't; that asymmetry is how the Popover API rework was missed, so the gate is
a command rather than a resolution.

Every `(?)` box must have had its **source read**, not its path guessed at, and every
boxed file needs a feature name or a stated reason it isn't one.
An entry in the notes reading "+1 `some-file.html`" with no feature named is not a
finding — it is an unresolved checklist line that got copied into prose. Two features were
lost that way in one release.

Write to `release-notes/`, not `tmp/`, so deleting an artifact can't take the notes with
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

**Search subtest names and source, not just paths.** `wpt-grep.js` does all three layers,
all local:

```bash
node scripts/wpt-grep.js pseudoElement
node scripts/wpt-grep.js ':muted' --include /css/selectors
```

The first layer is the one that finds things paths can't: `getAnimations({ pseudoElement })`
is named by its subtest, not its filename. The third searches the cached source of every
changed test. **Then confirm via the assertion messages** — see "a matching directory name
is not evidence" in step 3.

A `:muted` pseudo-class change lives in `css/selectors/media/sound-state.html`; a path grep
for "muted" finds `muted-playbackrate.tentative.html`, which is about `playbackRate` and
unrelated.

There are four honest answers, and three of them are not "yes":

| Finding | Report it as |
| --- | --- |
| Tests moved, messages describe the claim | Confirmed. Quote the message and path. |
| Tests moved, messages describe something else | A *different* change. Report both facts. |
| Test exists, identical in both runs | Not in this diff. Check absolute state before saying "not shipped". |
| No test matches at all | No WPT coverage. Say so plainly. |

**A diff cannot tell you a feature is still missing.** A file with the same pass count in
both runs is `unchanged` and legitimately absent from every view here, so "not in the diff"
never means "not shipped". `wpt-state.js` reads the stored summaries — all ~120k tests, both
runs — and answers all three of the non-confirmed cases:

```bash
node scripts/wpt-state.js --grep sound-state                        # does a test exist?
node scripts/wpt-state.js /css/selectors/media/sound-state.html     # its state in both runs
node scripts/wpt-state.js --grep text-box-trim --only failing-after # what's STILL broken?
```

**Use `--only failing-after` before writing up any feature as shipped.** A feature that
mostly works usually has a shaped gap worth a sentence, and the gap is what a developer
needs. `text-box-trim` passes 132 of 143 tests — and six of the eleven failures are
`text-box-trim-line-clamp-*`, i.e. it does not work with `line-clamp` yet. That is a caveat,
not a footnote, and it is invisible unless you ask for it.

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
