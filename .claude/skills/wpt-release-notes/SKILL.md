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

- **A shell filter loses information invisibly.** Every view already bounds itself — output
  pages at block boundaries, synopses and message rollups come *first*, and `--part`,
  `--only`, `--match`, `--include`, `--section` and `--top` narrow by meaning rather than by
  line position. A pipe adds nothing but loss. Receipts: a `sed` range arrived mangled but
  plausible; `tail -35` hid 12 of 24 subtests; `grep 'FAIL    -> PASS'` caught 1 of 21;
  `head -40` showed 10 of 36.
- **It turns every command into a permission prompt.** Rules match per sub-command across
  pipes, `;`, `&&` and newlines, so one `| head` un-approves the whole pipeline.
- **`export` does not persist**, so a `$D` convention has to be repeated every call — and
  repeating it is what creates the compound command. Every script defaults to the only
  collected comparison and prints which it used; just omit the path.
- **`cd` *does* persist**, and makes `node scripts/…` unresolvable in every later command,
  before any script starts, so nothing can explain it. Stay at the repository root.

If output looks truncated it says so — `!! PART 2 OF 7` with the command to continue, or
`!! END — all N shown`. Believe those lines rather than reaching for a pipe.

**Put no quote characters in a command. Ever.** Stronger than "avoid metacharacters",
because a quote mark is itself enough to stop a command being pre-approved. `= - _ . /`
never need quoting; only `? ( ) | [ ] * $ ; < > & \` and spaces do — and **defensive
quoting is not free**: `wpt-grep.js 'popover=hint'` prompted, for quotes that bought
nothing.

So where a value *would* need quotes, **choose a different value.** 17% of changed paths are
variants like `url-setters.any.html?exclude=(file|javascript|mailto)`, where `?` is a glob,
`(…)` a glob group and `|` a pipe. Quoting is genuinely required to pass that to the shell,
and it still prompts — so passing it is the wrong move. `--grep` on a metacharacter-free
fragment has neither problem:

```bash
node scripts/wpt-subtests.js --grep url-setters                   # yes
node scripts/wpt-subtests.js /a.html /b.html --grep url-setters   # yes — additive
node scripts/wpt-subtests.js --grep webkit02                      # reaches a ?query variant
```

Nothing in the tooling offers you a quoted path to copy: where a `?query` path appears in a
box or a suggested command, the `--grep` fragment that reaches it comes with it.

`--grep <substring>` means the same thing on `wpt-inventory.js`, `wpt-subtests.js`,
`wpt-fetch-tests.js` and `wpt-state.js`: a case-insensitive path substring, repeatable, and
**additive with explicitly named paths**. It also picks up sibling variants you would
otherwise name one at a time. `--include` (alias `--area`) is the path-*prefix* selector for
reading one area in full.

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
subtest that changed state with its assertion message, stores both full summaries,
fetches the source of every changed test at the revision its run was tested at, and
measures how stale WPT's vendored test262 is — which is what tells you *which JavaScript
features this comparison cannot show at all*. Watch for:

```
  test262 snapshot b66872a924 (117 days old); 5 upstream feature flag(s) have no tests here.
  asking Bugzilla which of them shipped in Firefox 154...
  3 of 5 shipped in 154, 1 with no bug found (UNKNOWN, not "no").
    iterator-chunking -> bug 2047997 "Ship Iterator Chunking proposal"
  asking test262.fyi whether they pass, and in which config...
  4 tracked on SpiderMonkey 155.0a1 (NIGHTLY, not the release above), 1 have no tests upstream at all.
```

Those three lines are the only part of a collection run that is already a finished
release-note finding rather than an input to one. They become checklist boxes carrying
their own answers. See the test262 horizon in step 2.

**Every later command finds this directory by itself** — they default to the only
collected comparison in `tmp/` and print which one they used, so you never pass a path.
Name it explicitly only when several exist, in which case they refuse rather than guess.
The directory contains:

| File | What it is |
| --- | --- |
| `diff.json` | every changed test file with complete subtest evidence, plus `jsHorizon` |
| `report.txt` | the ranked view, directory clusters, shared vocabulary, JS coverage horizon |
| `checklist.md` | the coverage worksheet — tick it in place |
| `boxes.json` | internal: the box list as generated, so `--verify` can spot a lost box. Not the source for verdict keys — use `wpt-resolve.js --list` |
| `state.json.gz` | both full summaries, all ~120k tests |
| `sources/` | each changed test's source, at the right revision |

Specs are `product[@channel][@version]`; channels are `stable`, `beta`, `experimental`
(aliases `nightly`, `release`, `tp`). **Pin a version for notes between shipped releases** —
once 153 is stable, `stable` no longer means 152 — and keep the channel alongside it, because
nightly runs outnumber stable ones ~50:1 and an unlabelled version search never reaches back
far enough:

```bash
node scripts/wpt-collect.js --from firefox@stable@152 --to firefox@stable@153
node scripts/wpt-collect.js --from chrome@stable --to firefox@nightly
```

`--aligned` forces both runs onto the same WPT revision. Prefer it when you need confidence
in small deltas; it may pick older runs, and it cannot work between two pinned versions.

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
is no threshold below which a change is safely ignorable.** A delta only measures how many
assertions happened to still be failing beforehand: `webkit-pseudo-element.html 5/6 -> 6/6
(+1)` was `-webkit-` pseudo-elements becoming valid, and `select-parsing.html 10/17 -> 17/17
(+7)` was the `<select>` parser keeping nested elements. Both shipped features, both
dismissed on a real pass as rounding error next to a `+664`. No smarter ranking fixes that,
because the premise is wrong. So read everything:

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

**Finish the worksheet.** The artifact's `checklist.md` has **four** lists, all of which must be
resolved. Replace the box with `[x]`/`(x)` and append `" — <verdict>"`, one of:

```
[x] /css/css-values/tree-counting  — written up: sibling-index() / sibling-count()
[x] /css/css-transforms            — regression: four transform reftests now fail
[x] /css/css-images                — explained: sibling-index() in gradients (tree-counting)
[x] /fs                            — not a feature: flake, same subtest moved the other
                                     way in the worker variant of the same file
```

**The verdict kinds are a closed set** — `written up:`, `regression:`, `explained:`,
`not a feature:` and nothing else. `written up:` and `regression:` mean the same thing to the
gate ("this is in the notes"); use `regression:` when it is one, because the notes have a
separate Regressions section and the verdict is then the sorting key. The gate names the
offending prefix when it refuses one.

**Apply the verdicts as data, not as edits.** Three steps:

```bash
node scripts/wpt-resolve.js <dir> --list    # 1. every box path with no verdict yet
```

**Get the keys from `--list`** — they must be exact, and it is the only thing that emits
them. Not from `boxes.json`, which is verification machinery and lists resolved boxes too.
Then (2) write path→verdict with the **Write tool**, never a shell heredoc (which prompts):

```json
{
  "/css/css-values/tree-counting": "written up: sibling-index() / sibling-count()",
  "/css/css-images": "explained: same feature as /css/css-values/tree-counting",
  "/fs": "not a feature: flake, the same subtest moved the other way in the worker variant"
}
```

```bash
node scripts/wpt-resolve.js <dir> tmp/verdicts.json   # 3. applies them
node scripts/wpt-inventory.js <dir> --verify          # non-zero while any remain
```

Name the artifact directory in every command once `tmp/` holds more than one comparison —
the default only applies when there is exactly one.

**This is the single biggest saving available** — ticking boxes by hand cost one
instrumented pass 106 Edit calls and 22% of everything it generated, because an Edit has to
restate its context to anchor itself. A key matching no box is an error that writes nothing,
so a typo cannot silently do nothing. Resolve in as many passes as you like.

1. **`[ ]` directories** (200–400 on a two-release diff). Churn-only ones arrive resolved.
2. **`( )` / `(?)` files** — every `*done*` file plus every file whose evidence names
   nothing. **Ticking a directory does not tick these.**
3. **`[ ] bug:<id>`** — bugs Mozilla flagged as developer-facing for this release, each
   carrying its own cross-reference against the diff. See step 2b.
4. **`[ ] test262-feature:<flag>`** — JavaScript features with no test on either side,
   because WPT's vendored test262 predates them. Usually a handful. The box already
   carries Bugzilla's answer (`SHIPPED in 154, bug 2047997`); transcribe it, and **do not
   re-check by searching the flag name — that returns nothing for features that shipped.**
   See the test262 horizon above.

`--verify` reads the verdicts, not just the boxes, and says which of the three it rejected.
Two rules follow from that:

- **A verdict must answer.** `written up — see notes` is rejected by name, and `explained`
  must name something findable — another box's path, another box's *written up* text, or a
  numbered sibling (`same as -001`). Phrasing does not matter; following the reference
  landing somewhere does.
- **Edit boxes in place; never rewrite `checklist.md` wholesale.** A whole-file rewrite
  dropped four boxes on a real pass with the count still reading 416. `boxes.json` records
  the box list at collection time so `--verify` catches that.

**One verdict covers a variant family.** Boxes marked `[N variants]` fold the `?class=`
variants and `.any.worker`/`.any.html` globals of one source file into one question — the
parameter picks which slice runs, not which feature the file covers. Asked separately, a
worksheet answered `text-box-trim-start-001.html` seventeen times. Variants that moved
*differently* stay separate boxes: two globals moving opposite ways is a flake signal that
exists only as the comparison.

This is a gate rather than advice because "read it all" failed twice as an instruction —
once with the strongest signal the tooling emits already on screen, and once because a
directory verdict silently absorbed a file inside it. Hence file-level boxes too.

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

**Nothing is excluded, and there is no flag to exclude anything.** Every filter is somewhere
a feature can hide: an earlier default of `/third_party` hid the entire `Intl.Locale` info
proposal, 42 files all `0/1 -> 1/1`.

**JavaScript and `Intl` features live in `third_party/test262`**, never under `/css`,
`/html` or any area you would think to check. One assertion per file makes it *look* like
uniform noise and makes `*done*` unusually precise there: `0/1 -> 1/1` is one named spec
assertion starting to hold, and dozens under one proposal's directory is a cleaner "shipped"
signal than most web-platform directories produce. Scan that block for proposal-shaped
directory names (`intl402/Locale/prototype/getTimeZones`,
`language/expressions/dynamic-import`) rather than skimming past it.

**…but reading that block to the last line is still not enough, and this is the one gap
reading cannot close.** WPT *vendors* test262 rather than tracking it, so a feature whose
test262 tests landed past the pin has **no test in either run**. The cadence is changing —
it was every few months (117 days stale on the 153→154 diff, which cost three features) and
became weekly in August 2026 — so **check the number the collector prints rather than
assuming either**. Both states are handled, and they surface differently:

- **A stale snapshot** produces `test262-feature:` boxes for flags with no test on either
  side. That is the case the rest of this section describes.
- **A current snapshot** produces none, and the report says "coverage is current" — worth
  reading rather than skipping, because it is a positive result, not a silence.
- **A snapshot that changed *between* the two runs** — which weekly re-vendoring makes the
  norm for any release-to-release diff — is the opposite case: those tests *do* exist, in the
  after run only, so they classify as `added` and the directory worksheet pre-resolves them
  as churn. Their boxes say `tests are NEW in the after run` and the source is already
  cached, so read it locally. A whole proposal's tests arriving is a lead, not churn. Firefox 154 shipped Iterator Chunking, Includes and
Join into a 117-day-old snapshot; `wpt-grep.js Iterator` and `wpt-state.js --grep
Iterator/prototype/chunks` both correctly found nothing, and the notes named none of them.
Unlike every other miss here, the tooling's silence is indistinguishable from the feature
not shipping — including `wpt-state.js`, which reads the same two summaries.

So the collector measures the horizon, turns each gap into a box `--verify` will not pass,
**and answers it for you** — from test262.fyi (does it work, and is it on by default) and
the "to" vendor's own release source (which version). Read the answer off the box:

```
[ ] test262-feature:iterator-chunking   (no test here; SHIPPED in 154, bug 2047997)
      SHIPPED in Firefox 154. Write it up.
      2047997: "Ship Iterator Chunking proposal" [RESOLVED FIXED, 154 Branch]
      test262.fyi: 78/78 pass on SpiderMonkey 155.0a1 (NIGHTLY, not the release above)
```

**Do not re-derive it, and above all do not search a bug tracker for the flag name** —
`quicksearch=iterator-chunking` returns zero bugs for a feature that shipped, because the
flag is test262's vocabulary and a vendor's is prose ("Ship Iterator Chunking proposal").
A pass that did exactly this got three empty result sets and reported "none of them
shipped": worse than the original miss, because the features were found and then ruled out.

| On the box | Means |
| --- | --- |
| `SHIPPED in <N>` | It shipped. Write it up. |
| `shipped before <N>` | Available, but not news for this release. |
| `shipped, but not in <N>` | Attributed to another version. Check it. |
| `not on by default in <N>` | Behind a pref. **Implemented is not shipped** — `Implement …` is routinely fixed one or two releases before `Ship …`. |
| `changed in <N>, not enabled` | Something landed, nothing turned it on. |
| `not shipped` | The vendor tracks it and does not have it on. |
| `test262 needs experimental options` | Flag-gated even in nightly. Not available. |
| `NOT FOUND, so UNKNOWN` | **The wording missed. Not a "no."** Weigh the enumerated `Ship …` list and the test262.fyi numbers. |
| `no test262 tests exist yet` | Registered upstream with nothing behind it, so nothing can measure it. |
| `no release source, so UNKNOWN` | Safari, which has none. Follow the URLs on the box. |

Sources per "to" browser: Firefox → Bugzilla, Chrome/Edge → Chrome Platform Status,
**Safari → nothing machine-readable** (WebKit's Bugzilla has no per-release status field, and
`quicksearch=Iterator chunking` there returns a 2015 Web Inspector bug — so a Safari box is
UNKNOWN plus release-note URLs, never a "no"). Where the two sources disagree, say so: a
feature the vendor calls shipped that only passes with experimental options is preffed off.
To ask again, or for an artifact predating the check: `node scripts/wpt-js-gaps.js`
(`--stored` for the offline answer, `--add` to backfill the boxes). Full rationale is in
`scripts/lib/test262.js`, `shipped.js` and `test262fyi.js`.

**Watch the `*done*` marker.** Every remaining failure in the file cleared. It is the
strongest "a feature shipped" signal available *and* independent of delta size, the exact
combination ranking destroys: `webkit-pseudo-element.html` is `+1 *done*`. A small delta
with `*done*` means "small because it was nearly finished".

**Skip the `<- all test-suite churn` directories.** Only `added`/`removed` tests, which mean
the runs are on different WPT revisions, not that the browser changed.

Two sections of the ranked report generate leads the inventory's alphabetical order won't.
Read them with `wpt-report.js`, not by opening `report.txt` — both sit at the *end* of that
file, so a line-window read of it misses exactly these:

```bash
node scripts/wpt-report.js --list                  # what sections exist
node scripts/wpt-report.js --section clusters
node scripts/wpt-report.js --section vocabulary
```

- **Directory clusters** ranks directories by how many files moved and how one-sided the
  movement was, linking one change across several — the `<select>` work also moved 28 files
  in `/html/syntax/parsing`, which reads as an unrelated parser area. Nothing is excluded by
  path, so test262 proposals surface here too. `--cluster-min`/`--cluster-ratio` widen it at
  collection time.
- **One feature, several directories** does the same on subtest vocabulary: a token in
  newly-passing names under 2+ directories is probably one change. `field-sizing` appeared
  across `/css/css-cascade`, `/css/css-ui`, `/html/rendering/widgets` and `/web-animations`.

Both are ranked, so both are hints. The inventory is the coverage guarantee.

**Don't skip the reftests.** A reference-image test contributes no subtests, so a
rendering fix reads `FAIL 0/0 -> PASS 0/0` — a `deltaPass` of 0, invisible to anything
that ranks by subtest delta. `report.txt` gives them two sections of their own plus an
"areas that moved only in reftests" rollup, and `--improvements`/`--regressions` include
them. There is no assertion message to quote, so group them by directory and say what the
directory covers. They are not a footnote: one Firefox stable→beta diff had 140 now
passing and 8 now failing, including a `css/css-transforms` regression cluster that no
subtest count would have surfaced.

## Step 2b: Cross-check against the vendor's own changelog

**Every other view here runs test → feature. This one runs feature → test**, and that
direction catches two things nothing else can. For a Firefox comparison the collector
queries Bugzilla for everything resolved `FIXED` against the release's milestone, and picks
out the bugs carrying `dev-doc-needed`/`dev-doc-complete` — Mozilla's own marker for "a web
developer needs to be told about this" — then matches each against the diff:

```bash
node scripts/wpt-bugs.js              # the developer-facing list, gaps first
node scripts/wpt-bugs.js --gaps       # only the ones the diff cannot show
node scripts/wpt-bugs.js --census     # every component, with counts
node scripts/wpt-bugs.js --component Layout    # drill into the rest, locally
```

On the 153→154 pass that was 21 bugs out of 3256 fixed.

**`resolution=FIXED` means landed, not enabled** — and getting that wrong is the one error
this step has already produced. `:open` for `<select>` is FIXED with a dev-doc keyword, and
its test fails in *both* runs because the feature is behind a pref: the failing test is
**correct**, and reading it as "no WPT coverage, so the bug is the only source" inverted the
truth. Several of the 21 are like this — `progress()` and `alpha()` say "behind pref" outright,
CSS Typed OM is nightly-only (`0/1` in beta), `line-clamp` has 218 of 300 still failing. Where
the summary says so, the box says so; where it doesn't, **check before writing anything up**.

| Outcome on the box | Means |
| --- | --- |
| `in the diff (N file(s))` | The evidence is already here, with the file and subtest named. **If it is not in your notes, you missed it** — this is how `RTCIceTransport.getSelectedCandidatePair()` was found, buried in `idlharness…?include=(…)`. |
| `in the diff, but <behind pref \| for nightly>` | Landed and visible, but not on for users. Two bugs can name the same feature — `text-box.enabled for nightly` and `…for all users` — and only the second is news. |
| `not in the diff` | Three possible reasons, and the box lists all three rather than picking: preffed off; genuinely no WPT coverage (DevTools, WebExtensions and internal media changes never are); or covered under vocabulary these tokens missed. |
| `weak match only (N)` | A generic word matched. **A lead, not evidence** — `Select` matched 14 unrelated files. Confirm by eye. |
| `NOT CHECKED` | No usable identifier in the summary, so it was never matched. Not the same as "not in the diff". |

Each becomes a `bug:<id>` checklist box, and `not a feature:` is the right verdict for a real
bug that is not web-facing, or that landed behind a pref. Saying so is the point.

**An enablement TITLE is enough — no keyword needed.** The dev-doc keyword relies on someone
remembering it; a title like `Enable QUIC v2 version negotiation on all channels` is written by
the person landing the flip, because the title *is* the description of the flip. So every bug
whose title starts `Ship`/`Enable`/`Set`/`Let`, or says `by default`, `for all users`, `on all
channels`, `on release` or `ride the trains`, is boxed **when it is in `Core/*`** — the web
platform — regardless of keywords. On one release that was 39 of 2570 titles, 18 in Core, and it
was the only route to two features nothing else here could reach: QUIC v2 version negotiation and
Happy Eyeballs v3, neither of which can ever have a WPT test. Enablement titles outside `Core/*`
are listed as leads rather than boxed; they are overwhelmingly build, CI and Android-app work.

For these boxes **absence of tests does not disqualify** — resolve from the pref evidence on the
box, and never write `not a feature: no tests`. That exact verdict lost two WebAssembly proposals
on a real pass, after the same pass had correctly worked out that WPT could not see them.

Each box also carries its **controlling pref** where one could be resolved, with the value on each
release train and a note when the trains disagree — because `mozilla-beta` can still be on the
*previous* version, in which case its gate describes that version and not the one you are writing
about:

```
controlling pref (candidate, 2 word(s) matched): javascript.options.wasm_compact_imports
  central=true | false  beta=false  release=false
  => ON for users. This IS news, tests or no tests.
  note: mozilla-beta is still 154, so its gate describes 154, not 155; central has it
        unconditionally, i.e. the flip landed in 155's cycle
```

**This is a lead, not coverage.** The keyword is applied by hand and is certainly
incomplete: 21 of 3256. The other ~3235 are not discarded — they are stored whole and
reachable by component or substring with no further network access, so the boundary is
navigable rather than silent. That is the same bargain `--part` makes with the inventory.
Non-Firefox comparisons get `NOT APPLICABLE`, since Bugzilla milestones only describe Firefox.

## Step 2c: Discount nightly-only features — they are not news

**By default, a feature that is not on for beta/release users does not go in the notes.**
Include one only if you were explicitly asked to cover what is coming in nightly, and then
say so in its own clearly-labelled section.

**But do not let this rule swallow the opposite case.** "Gated" and "invisible" both read as
"don't write it up", from opposite directions, and only one of them should. A pref-gating marker
can only discount things that *appear* in the diff — a feature with no WPT files has no gated
files either, and is not thereby discountable. No tests is a reason to go and find the pref
(step 2b, and the no-coverage list in step 5), never a reason to drop something.

This is not a nicety. The skill's most-suggested comparison is
`--from firefox@beta --to firefox@nightly`, which is *exactly* where nightly-only features
flood the diff — on one real 155 pass **967 of 1585 forward-moving tests were pref-gated**,
and the notes led with `attr()`, `progress()` and `alpha()`, all three nightly-only, all three
presented as shipped.

Two mechanisms hide it, and neither is visible in a pass rate:

1. **WPT force-enables prefs.** `testing/web-platform/meta/<dir>/__dir__.ini` carries
   `prefs: [layout.css.typed-om.enabled:true]` and the harness applies it. So **a passing test
   means "implemented", not "a user has it"** — including in a beta run.
2. **The pref's default is channel-dependent**, as `value: @IS_NIGHTLY_BUILD@` or an
   `#ifdef NIGHTLY_BUILD` block in `StaticPrefList.yaml`.

The collector resolves both through searchfox and **marks the directory line**, in the
inventory and on the worksheet box:

```
/css/css-typed-om  [14 files, +452 subtests, 14 fwd, 8 done]  [NIGHTLY-ONLY: layout.css.typed-om.enabled +16, 390f]
    !! On in nightly, OFF for beta/release users. DISCOUNT from the notes unless asked.
```

| Marker | Means |
| --- | --- |
| *(none)* | Nothing here is pref-gated. Write it up normally. |
| `NIGHTLY-ONLY` | On in nightly, off for beta/release. **Discount.** Verdict: `not a feature: nightly-only (<pref>)`. |
| `OFF by default everywhere` | Off in *every* channel including nightly; the test only passes because WPT forced it. **Discount.** |
| `on by default on SOME platforms only` | A platform split — e.g. `@IS_NIGHTLY_BUILD@` on Android, `true` elsewhere. **Write it up and name the platforms**; neither "available" nor "nightly-only" is true of it, and this is not a discount. Then check for **sibling** prefs gating part of the feature. |
| `channel-dependent value` / `pref state unclear` / `pref not found` | Could not be resolved. Treat as a lead, check the pref by hand, and do not present it as available. |

The pref-to-directory association is a **lead**, matched on whole path segments — it named the
right pref for `css-typed-om`, `progress()` and `alpha()`, and earlier looser matching flagged
`touch-events` from a line-clamp pref. So confirm before discounting something that looks real,
and read the evidence with:

```bash
node scripts/wpt-prefs.js            # every pref, its value in central/beta/release
node scripts/wpt-prefs.js --gated    # the gated files, by directory
```

**If `searchfox-cli` is not installed, none of this can run**, every view says so loudly, and
the honest response is to state in the notes that pref state is unverified rather than to
present anything as available:

```bash
cargo install searchfox-cli          # cargo-binstall is a separate tool, often absent
node scripts/wpt-prefs.js --refresh
```

Keep it current, too. It self-reports when a newer release exists, and the pref section prints
the version it resolved with — an outdated resolver is the same class of silent weakness as no
resolver at all, so a stale one is called out rather than trusted.

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

**This is where a shell filter is most dangerous**, because it produces a *confidently
wrong* finding rather than a visible gap — you have the right file, so nothing feels
missing. A real pass read `supported-stats.https.html`'s 24 new subtests via `tail -35`, saw
the last 6, wrote up exactly those, and missed the 12 `RTCTransportStats` properties in the
middle: a whole stats type newly reported, not IDL polish. Long output is information about
a file's importance, not a reason to sample it. A `sed` range is worse still, because it
fails quietly: nearly every subtest name in `color-computed-color-mix-function.html`
contains `color-mix`, so a `/color-mix/,/^====/p` range restarts on almost every line and
silently drops the header, the section titles and the synopsis.

**The synopsis always reports the file's true totals, including the side you filtered out.**
With `--only`, the requested category's rollup comes first and anything from the other side is
labelled `NOT WHAT YOU ASKED FOR` — because on `color-valid-color-mix-function.html --only
still-failing` the one still-failing subtest has no dominant message, so a `144x` *fixes*
rollup was the first substantive thing on screen and was nearly read as the failure cause.

**Bound a read by meaning instead, with `--match` or `--only`.** `--match` filters on name
and message; `--only newly-passing` (also `newly-failing`, `changed`, `removed`,
`still-failing`) filters by transition. Both say they filtered and still report the file's
true totals — so "51 of 57 still-failing subtests are `0%`-sum mixes" is a claim you can
make, which no line window can support. In particular **do not grep for an arrow** to get
the newly-passing: `grep 'FAIL    -> PASS'` misses a prior `NOTRUN`/`TIMEOUT`, misses
`(new)   -> PASS` — a brand-new assertion, which is how an entirely new interface appears —
and discards the `was:` messages this whole step exists for. It under-reported in 19 files
on one diff, hiding 55 new-subtest passes. Use `--only newly-passing`.

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

**An IDL member count is not a WPT finding.** When an interface is newly reported, the
obvious next move is to read its definition — and then the *spec's* member count silently
becomes the claim. `RTCCertificateStats` has 4 newly-passing subtests and was first written
up as "6 members", a number that came from the IDL and from no test. The IDL says which
members *exist*; only the subtests say which a browser now *reports*. Count the subtests.

**Added/removed *subtests* at the same WPT revision are a behaviour change, not churn.**
This one inverts. `text-decoration-inset-auto.html` went 52/73 → 73/73 with 20 subtests
removed and 20 added, and was written up as test restructuring — 20 of 21 dismissed. But
both runs were at the same revision, so the source was byte-identical:

```
removed:  … from [auto] to [10px -20px] at (-1) should be [NaNpx NaNpx]
added:    … from [auto] to [10px -20px] at (-1) should be [-7.44px 22.56px]
```

The expected value is baked into the subtest *name*, so a rename means the computed value
changed: `text-decoration-inset: auto` had been computing to `NaN`, and all 21 subtests are
that one fix. `wpt-subtests.js` detects the pairing and says so, but "added" and "removed"
mean churn only when the revisions *differ* — check which case you are in first.

**A pref flip IS the shipping event, not a non-event.** `Enable X on Release`, `Set X for all
users`, `Let X ride the trains` are the *strongest possible* ship signals — they are the moment a
feature becomes available. One pass made `Enable new CSS attr() on Release` a headline feature and,
in the same document, discounted `Let svg.new-getBBox.enabled ride the trains` as "just a pref
flip". Identical evidence, opposite conclusions. `--verify` now refuses `not a feature:` on an
enablement box unless the verdict quotes a pref default or a source path, because the answer has
to come from the pref list and never from the diff's silence.

**A matching name is not evidence — at any level.** The classic form is a directory: a changelog
said WebDriver *Perform Actions* now awaits action finalization, both `perform_actions`
directories had moved `+1`, and the newly-passing subtests were `test_move_to_inline_block_child`
failing on `assert 8 == 24.0 ± 1.0` — a coordinate bug for inline-block children, a
different fix that happens to live in the same directory.

The same trap one level down catches **file, interface and method names**. One pass matched a
`getBBox()` pref-flip bug to `/svg/geometry` because both concern `getBBox()` — one is the
`options` argument, the other non-rendered elements, unrelated behaviours sharing a method name.
So the question is never "does this name match?" but "do the assertion messages describe *this*
behaviour?" This sits in deliberate tension with searching broadly for candidates: cast wide to
find evidence, then read the messages to confirm it is the right evidence.

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

**The one exception, and it has its own source.** A past-the-horizon JS feature (the
`test262-feature:` boxes) has no test in the artifact, so this rule has nothing local to
point at — which is exactly when a snippet gets written from memory carrying the same
implied authority as one copied from source. One pass nearly shipped `chunks`/`windows` that
way. The tests are not missing, only missing *here*: the collector resolves each flag to its
upstream test262 directory and fetches a sample, so copy from that and say the snippet is
upstream-derived rather than taken from a test that ran in this comparison.

```bash
node scripts/wpt-js-gaps.js --stored   # the sample tests, in full, offline
```

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
| Iterator Chunking / Includes / Join | **not a reading failure at all**: WPT vendors test262, the snapshot was 117 days stale, so three shipped proposals had zero tests in either run | `wpt-js-gaps.js`; `test262-feature:` boxes |
| …the same three, again | surfaced as boxes, then **ruled out**: a Bugzilla search on the test262 flag name returns zero bugs for all three, and the empty result was read as "didn't ship" | the collector runs the query itself, in Bugzilla's wording, and prints the answer on the box |

**Every place output gets shortened is a place a feature disappears** — a rank cut, a
default exclusion, a `tail`, or stopping when the interesting-looking entries run out. Prefer
reading more with no filter over reading less with a clever one.

The last two rows break that pattern and are worth holding separately: **reading more cannot
fix a feature that was never tested**, and **an empty search result is not a finding.** Note
which way the second ran — the tooling was right, the lookup was wrong, and the lookup won.
When a box carries an answer, that answer *is* the evidence.

`SVGTextPathElement.side` and `getAnimations({ pseudoElement })` share a shape worth naming:
both were named after an IDL interface, and **neither path contained the word that named the
feature**. When a filename describes a *type* rather than a *behaviour*, the path is not
evidence — which is why subtest names are loaded up front rather than inferred from paths.

**When someone asks whether a change is missing, assume they're right until the data says
otherwise** — and verify it properly rather than grepping paths for their wording. See
"Checking a specific claim" below.

**Partial runs land on wpt.fyi.** A real Firefox nightly once published a summary with
only 2 test files; naively taking the latest run yields a diff where all ~120k tests look
`removed`. `wpt-collect.js` skips runs with fewer than 10,000 test files and prints a
`note: skipped N incomplete run(s)`. If a diff claims almost everything was removed or
added, suspect this before believing it — and sanity-check that the total is ~120k.

**`tentative` in a path means the spec is unstable.** Flag these as experimental.

**Nightly ≠ shipped, and it is now measured rather than caveated.** WPT shows what runs in
the harness, and the harness force-enables prefs — so a pass can mean "implemented" for a
feature no user has. Step 2c resolves each one against `StaticPrefList.yaml` across
mozilla-central/-beta/-release and marks the directory. Discount anything marked, unless you
were asked for what is coming in nightly. Where the check could not run, say pref state is
unverified rather than implying availability.

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

**State the scope, because it is not "everything that changed".** These notes cover what WPT
tests, plus what the vendor's changelog surfaces — bugs Mozilla flagged `dev-doc-*` and bugs whose
title describes an enablement event. Two classes fall outside both instruments and should be named
as out of scope rather than implied absent: a feature that shipped with **no flip** (implemented
directly on-by-default, or gated only by a build flag with no pref), and anything whose only record
is an untitled internals change. Networking and graphics internals in particular need a separate
pass over the census.

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

There are five honest answers, and four of them are not "yes":

| Finding | Report it as |
| --- | --- |
| Tests moved, messages describe the claim | Confirmed. Quote the message and path. |
| Tests moved, messages describe something else | A *different* change. Report both facts. |
| Test exists, identical in both runs | Not in this diff. Check absolute state before saying "not shipped". |
| No test matches, and it's a JS/`Intl` feature | Check the horizon first — `wpt-js-gaps.js`. "Past the test262 snapshot" and "untested" are different answers. |
| No test matches at all | No WPT coverage — but check `wpt-bugs.js --grep <word>` before saying "didn't ship". |

**For anything JavaScript, "no test matches" is the answer that needs one more step**, and
the step is `node scripts/wpt-js-gaps.js` — not a bug search. `Iterator.prototype.chunks`
returned zero matches from every layer of `wpt-grep.js` and zero from `wpt-state.js`, and it
had shipped. If the flag is in the horizon's missing list, the honest sentence is "WPT has no
test for this at the revision these runs used", followed by what the vendor source says. See
the test262 horizon in step 2 for why searching the flag name answers "no" incorrectly.

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

Things with no WPT coverage at all. These are invisible in the diff — though the vendor
changelog (step 2b) now reaches some of them, and `wpt-bugs.js --grep` is worth trying
before concluding anything.

**WebAssembly is the category most easily lost here, and it has been lost.** A wasm proposal is
a binary-format or instruction-set change with *no JavaScript API surface*, so **no WPT test can
ever observe it** — permanently, not as a lag. One pass wrote *"so WPT cannot show it"* in its own
verdict and then filed two shipped proposals as `not a feature`. The same holds for anything in
the JS engine below the JS API surface, and for network-protocol defaults (QUIC / HTTP3 version
negotiation). For these, **absence of tests is expected and is evidence of nothing**; the pref
and the source are the evidence:

```bash
searchfox-cli -q '<feature words>' -p StaticPrefList.yaml     # the default, per channel
searchfox-cli --get-file js/src/wasm/WasmFeatures.h           # the flag predicate
searchfox-cli -q '<feature>' -p js/moz.configure              # --disable-X means on by default
```

`js/src/jit-test/tests/wasm/spec/<proposal>/` existing means the spec tests are vendored, i.e.
implemented. The collector resolves each changelog bug to its controlling pref and puts the
answer on the box, so normally you can just read it there.

Also invisible: rendering fixes with no reftest, "stopped working after several navigations"-style bugs, event *ordering* changes
where only the negative case is tested, anything whose spec has no tests yet, and **any
JavaScript feature newer than WPT's vendored test262 snapshot** — the last of which is
measurable rather than merely possible, and is what `wpt-js-gaps.js` measures. Absence of
evidence is genuinely not evidence of absence — say "no coverage", not "didn't ship", and
point at Bugzilla for confirmation.

## Reference

- API docs: https://github.com/web-platform-tests/wpt.fyi/blob/main/api/README.md
- Results UI: `https://wpt.fyi/results/<test-path>?product=firefox@beta&product=firefox@experimental`
- Test source: `https://github.com/web-platform-tests/wpt/blob/master/<path>`
- Which test262 a WPT revision vendors:
  `https://github.com/web-platform-tests/wpt/blob/<wpt-rev>/third_party/test262/vendored.toml`
- Every test262 feature flag, with proposal links:
  `https://github.com/tc39/test262/blob/main/features.txt` — the set difference against the
  vendored revision's copy is what `wpt-js-gaps.js` reports
- What shipped in a Firefox release, per Bugzilla — the per-release status flag, not the
  resolution or the milestone. This query needs no guess about wording, which is why it is
  the primary source:
  `/rest/bug?f1=cf_status_firefox154&o1=equals&v1=fixed&f2=short_desc&o2=substring&v2=Ship`
- test262 results per engine, per feature flag, in default and experimental configurations:
  `https://data.test262.fyi/meta.json` (also `index.json`, and `history.json` for per-date
  engine versions with whole-suite totals). Current data only — the engine builds are
  nightlies and there is no per-feature history, so it cannot attribute a feature to a
  release. Rendered by `wpt-js-gaps.js` beside the Bugzilla answer.
- `/api/runs` rejects `product=firefox@beta` (400); channels go via `label`, and one
  `label` applies to all products — which is why `--aligned` intersects `/api/shas`
  per spec instead of using `aligned=true`.
- Summary blobs are `summary_v2` gzipped JSON: `{"/test.html": {"s": "O", "c": [pass, total]}}`.
