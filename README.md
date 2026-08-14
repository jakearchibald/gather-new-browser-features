# WPT browser diff → release notes

Tools for turning [wpt.fyi](https://wpt.fyi) web-platform-tests results into
developer-facing release notes: what a browser can newly do, and what broke.

Works for any two builds wpt.fyi knows about — channels of one browser
(Firefox nightly vs beta) or across browsers (Chrome stable vs Firefox nightly).

Node 18+ required. One dependency: `undici`, for proxy-aware `fetch` — Node's built-in
`fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY`, which makes these scripts fail with `ENOTFOUND`
on every host behind a corporate proxy or a sandbox. `pnpm install` before first use.

## Quick start

See what's on wpt.fyi, then collect. Those are the only two steps that use the network:

```bash
pnpm install
node scripts/wpt-runs.js                                      # what versions exist?
node scripts/wpt-collect.js --from firefox@beta --to firefox@nightly
```

It streams both raw reports (~330MB each), records **every** subtest that changed state
with its assertion message, stores both full summaries, fetches the source of every
changed test at the revision its run was tested at, and measures how far behind upstream
WPT's vendored test262 is. A minute or two, once. It writes `tmp/<from>-vs-<to>/`:

```text
diff.json        every changed test file with complete subtest evidence, plus jsHorizon
report.txt       the ranked view, directory clusters, shared vocabulary, JS horizon
checklist.md     the coverage worksheet — resolve it with wpt-resolve.js
boxes.json       internal: the box list as generated, so --verify spots a lost box
state.json.gz    both full summaries, all ~120k tests
sources/         each changed test's source, at the right revision
```

**Nightly-only features are discounted by default.** WPT force-enables prefs per directory
(`testing/web-platform/meta/<dir>/__dir__.ini`), so a passing test can mean "implemented", not
"a user has it" — and the most useful comparison, beta vs nightly, is exactly where that
floods the diff: on one real run **919 of 1585** forward-moving tests were pref-gated and the
notes led with three nightly-only features presented as shipped. The collector resolves each
pref across mozilla-central/-beta/-release via `searchfox-cli` and marks the directory in the
inventory and the worksheet. **Without `searchfox-cli` installed the check cannot run at all,
and every view says so loudly** — "not checked" and "nothing gated" must never look the same.

**Everything after that is a local read.** Only `wpt-runs.js`, `wpt-collect.js`,
`wpt-js-gaps.js` and `wpt-prefs.js --refresh` touch the network; `selftest.js` runs every analysis script with the proxy
pointed at a closed port to keep it that way.

```bash
node scripts/wpt-inventory.js --dirs                 # the map
node scripts/wpt-inventory.js                        # every changed file + evidence
node scripts/wpt-inventory.js --include /css/css-ui  # one area in full
node scripts/wpt-inventory.js --verify               # gate: fails while boxes are open
node scripts/wpt-subtests.js  /fetch/http-cache/no-vary-search.tentative.any.html
node scripts/wpt-fetch-tests.js --area /fetch --top 3
node scripts/wpt-grep.js      pseudoElement
node scripts/wpt-state.js     --grep sound-state     # is there even a test?
node scripts/wpt-js-gaps.js   --stored               # what JS features CANNOT be seen
node scripts/wpt-bugs.js      --gaps                # what shipped that the diff cannot show
node scripts/wpt-prefs.js                           # which of it is nightly-only
```

**Every view is paged.** A tool result holds roughly 30KB, and several of these views
outgrow that — one file's subtest detail reached 66KB, a broad `wpt-grep.js` pattern 3MB,
`wpt-state.js --grep /` 16MB. Rather than being truncated with no marker, output
breaks between whole blocks (a directory, a subtest, a section, a file) and says which page
it is, what has not been read, and the command to continue. `--all` overrides it for
deliberate redirection to a file. `selftest.js` sweeps every command at its most verbose
arguments and fails if any exceeds the limit without announcing itself as one page.

**And nothing caps.** Pagination can say what it has not shown yet; a row cap cannot, so
there are none. `wpt-state.js` used to default to `--limit 40`, sliced before the paginator
saw the list — which made it print `!! END — all 40 tests shown.` about a 143-match search,
with the notice about the other 103 *after* the END marker. `--grep text-box-trim` had 11
tests still failing and 10 were past the cap, so the answer to "what is left?" read as 1
of 11. `--limit` is now an ignored no-op, and a selftest check fails if any view ever again
claims completeness over dropped rows.

No path argument: each defaults to the only collected comparison in `tmp/` and prints
which one it used, refusing to guess when several exist. That is deliberate rather than
merely convenient — shell variables do not survive between tool calls, so an `export
D=… && node …` convention has to be repeated on every command, and a compound command
matches no permission-allowlist prefix, so it prompts every single time.

Read the inventory in full rather than skimming the biggest numbers. **Subtest count is not
a measure of importance** — a one-file `+1` was a shipped feature (`-webkit-` pseudo-elements
now parse) that got missed twice by ranked views, and a `+400` can be one missing property
fixed. The inventory selects nothing and sorts alphabetically for exactly this reason, and
it has no `--exclude` at all: an earlier default of `/third_party` hid the whole
`Intl.Locale` info proposal. JavaScript and `Intl` features live in `third_party/test262`,
never under a web-platform directory.

**But reading it all still cannot find a JavaScript feature that was never tested here**,
and that is not a hypothetical: WPT *vendors* test262 rather than tracking it. The re-pin was
every few months and became weekly in August 2026, so the size of the gap is measured per
comparison rather than assumed — and a snapshot that changes *between* the two runs is
handled as its own case, since those tests exist on one side only and would otherwise be
pre-resolved as churn. One Firefox comparison ran against a
117-day-old snapshot, so the three TC39 Iterator proposals that release shipped —
`Iterator.prototype.chunks`/`.windows`, `.includes` and `.join` — had **zero tests on either
side**. Every tool correctly found nothing, including `wpt-state.js`, and the notes named
none of the three. `wpt-js-gaps.js` measures that horizon by diffing test262's `features.txt`
between the vendored revision and upstream, and each gap becomes a checklist box `--verify`
will not pass without a verdict.

**Those boxes come with their answers**, because the obvious way to answer them is also
wrong. Told to "look the flag up in Bugzilla", the next pass found all three proposals and
ruled them out — `quicksearch=iterator-chunking` returns zero bugs, and zero bugs read as
"didn't ship". A flag name is test262's vocabulary; a vendor's is prose ("Ship Iterator
Chunking proposal"). So the collector runs the query itself, against the *"to"* browser's
own release source — Bugzilla for Firefox (`cf_status_firefox<N>` on a `Ship …` bug),
[Chrome Platform Status](https://chromestatus.com) for Chrome and Edge (`status.text` plus
`status.milestone_str`) — and prints the outcome on the box (`SHIPPED in 154`). A wording
miss renders `NOT FOUND, so UNKNOWN`, never a "no", and `Implement <proposal>` being FIXED
two releases earlier is reported as *not shipped*.

**Safari has no machine-readable release source**, which is recorded as a named gap rather
than discovered again: bugs.webkit.org is a Bugzilla whose REST API works, but it has no
per-release status field, and `quicksearch=Iterator chunking` returns a 2015 Web Inspector
bug — so reusing the Firefox logic there yields confident nonsense. Safari boxes get
`no release source, so UNKNOWN` plus the release-notes URLs to check by hand.

Alongside it, **[test262.fyi](https://test262.fyi) supplies the evidence Bugzilla lacks**:
per-flag pass counts from real runs, twice per engine — with and without experimental
options — so `78/78, default options` shows the feature works *and* is on by default, and
`0/0` distinguishes "we cannot see it" from "nobody has written tests yet". It cannot
replace Bugzilla, and that is checked rather than assumed: it tests one build per engine
and for Gecko that is a nightly (`sm: 155.0a1`), it keeps no per-feature history
(`history.json` is whole-suite totals, `gh-pages` is force-pushed to a single commit, and
no dated per-feature endpoint exists). So it says what nightly does today; Bugzilla says
which release turned it on. Both are printed, and a disagreement is reported as a finding.

## Scripts

| Script | Purpose |
| --- | --- |
| [wpt-runs.js](scripts/wpt-runs.js) | What is on wpt.fyi: versions and dates per channel, and the collect command for the two commonest comparisons. Run this before choosing specs. |
| [wpt-collect.js](scripts/wpt-collect.js) | Diffs two runs and writes the artifact directory everything else reads. One of the three scripts that use the network. |
| [wpt-inventory.js](scripts/wpt-inventory.js) | Every changed file with its subtest names, grouped by directory, ranked by nothing. `--verify` fails while any checklist box is unticked. |
| [wpt-report.js](scripts/wpt-report.js) | The ranked view: per-kind sections, area rollups, directory clusters, shared vocabulary. `--section` picks one; `--top 0` shows a section in full. |
| [wpt-subtests.js](scripts/wpt-subtests.js) | Every subtest of a file, with the assertion message behind each change, plus a rollup grouping them by message. Finds the *cause*, not just the count. |
| [wpt-fetch-tests.js](scripts/wpt-fetch-tests.js) | Print cached test source so code examples are accurate rather than guessed — at the revision the runs were tested at, not `master`. |
| [wpt-grep.js](scripts/wpt-grep.js) | Search subtest names and messages, paths, then test source. A filename often contains no word from the feature's name. |
| [wpt-state.js](scripts/wpt-state.js) | Absolute pass/fail of any test in both runs, including the ~120k the diff omits. "Not in the diff" never means "not shipped". `--only failing-after` answers "what's still broken in this feature?". |
| [wpt-prefs.js](scripts/wpt-prefs.js) | Which features a beta/release user actually has. WPT force-enables prefs per directory, so a passing test can be a nightly-only feature — this resolves each pref across mozilla-central/-beta/-release and marks the gated directories. Needs `searchfox-cli`. |
| [wpt-bugs.js](scripts/wpt-bugs.js) | The vendor's own changelog for the release, cross-referenced against the diff — the only view that runs feature → test. Catches changes the diff *does* show and you skimmed past, changes WPT has no coverage for at all (DevTools, WebExtensions), and bugs that are FIXED but still behind a pref. |
| [wpt-js-gaps.js](scripts/wpt-js-gaps.js) | Which JavaScript features this comparison *cannot* show, because WPT's vendored test262 predates them — plus, from test262.fyi and the "to" vendor's release source, which of those actually shipped. Networked; `--stored` is the offline form, `--add` backfills the boxes into an older artifact. |
| [wpt-resolve.js](scripts/wpt-resolve.js) | Apply a `{"box path": "verdict"}` file to the checklist. Exact keys only, no patterns, no fallback — a key matching no box writes nothing. Ticking boxes by hand cost 22% of one run's entire output. |
| [selftest.js](scripts/selftest.js) | Asserts the tooling still surfaces the features it has historically missed, and that nothing but the collector touches the network. Run it after changing any of the above. |

Each takes `--help`. Shared logic lives in [scripts/lib/](scripts/lib/).

## Collecting

Specs are `product[@channel][@version]`; channels are `stable`, `beta`, `experimental`
(aliases `nightly`, `release`, `tp`).

```bash
node scripts/wpt-collect.js --from chrome@stable --to firefox@nightly
node scripts/wpt-collect.js --from firefox@beta --to firefox@nightly --aligned
node scripts/wpt-collect.js --from firefox@stable@152 --to firefox@stable@153
```

`--aligned` pins both runs to the same WPT revision so test-suite churn drops out of the
diff. Release channels are often tested at different revisions, so it can fail to find a
match — it says so rather than guessing.

A version pin is for release notes between two shipped versions: once 153 is stable,
`firefox@stable` no longer resolves to 152, so the baseline has to be named. Keep the
channel alongside the version — nightly runs outnumber stable ones by ~50:1, so an
unlabelled version search never reaches back far enough. Version pins can't be combined
with `--aligned`: two shipped versions are never tested at the same WPT revision.

Other options: `--out <dir>` to collect elsewhere, `--no-sources` to skip the source
prefetch, `--force` to overwrite an existing artifact, `--top`/`--cluster-min`/
`--cluster-ratio` to tune `report.txt`. A collection refuses to overwrite an artifact whose
`checklist.md` has ticks in it, since that is the one thing here that can't be regenerated.

Test files are classified, which is what makes the analysis possible. The most useful
category is `newly-running`: a test that previously errored or crashed and now executes,
which usually means an API went from absent to present. Reference tests get their own
sections, because they carry no subtests and so are invisible to a subtest delta.

`report.txt` ends with two sections that exist because ranking hides things:

- **Directory clusters** ranks directories by how many files moved and how one-sided the
  movement was, rather than by subtest delta. Every other section ranks by magnitude, so a
  feature that lands as many tiny per-file gains is invisible in all of them. Added and
  removed tests don't count as movement (that's test-suite churn, not the browser), and
  nothing is excluded by path — `third_party/test262` clusters are where JavaScript and
  `Intl` features show up.
- **One feature, several directories** does the same job on subtest vocabulary instead of
  paths: a token appearing in newly-passing subtest names under two or more directories is
  probably one change in several places. `field-sizing` turned up across `/css/css-cascade`,
  `/css/css-ui`, `/html/rendering/widgets` and `/web-animations`.

## Why complete subtest evidence

The collector stores every subtest that changed state, with its message — not a capped
sample. That is what makes the drill-in step a local read: it used to re-stream two ~330MB
reports per invocation, so the step that actually names features was the expensive one, and
it got skipped or sampled with `tail`.

The cost is small, because roughly 90% of subtests in changed files pass on both sides and
only need counting. A two-release diff (2,587 changed files) stores ~8,900 subtest records
in a 4.9MB `diff.json`. The cap it replaced was 25 names per file, which truncated 29 files
in that same diff — the worst keeping 25 of 168 newly-passing names.

## Interpreting the output

Pass rates find the story; they aren't the story. Push through to the feature name — "the
`fetch` area gained 52 subtests" and "Compression Dictionary Transport now works" are the
same fact, but only one is worth telling a developer.

Then push one step further, with `wpt-subtests.js`: a count tells you a file moved, not
why. Subtests aren't independent — many assert a shared precondition first, so a single
missing property can fail a dozen of them and restoring it fixes them all at once. The
assertion messages tell those two stories apart, and only one of them is true.

The [wpt-release-notes skill](.claude/skills/wpt-release-notes/SKILL.md) documents the full
workflow and the traps that produce wrong conclusions: rising denominators that look like
regressions, uniform suite-wide failures that are really test-machine problems, reftests
that report no subtests, and partial runs published to wpt.fyi.

## Layout

```text
scripts/               the tools
scripts/lib/           shared logic: transport, report streaming, rendering, analysis
tmp/<a>-vs-<b>/        one collected comparison (gitignored)
release-notes/         finished notes (gitignored — regenerable, and stale as new runs land)
.claude/skills/        the repeatable workflow
```

`selftest.js` needs two artifacts to run against; see its `--help` for the two commands
that collect them.

## Running it without permission prompts

`.claude/settings.json` is committed, so a clone is quiet with no per-user setup. It runs
Bash in Claude Code's sandbox and auto-allows it on that basis, which is why there are
almost no prompts. What the committed file actually gives you:

- **Writes** confined to `tmp/` and `release-notes/`.
- **Credentials** (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.npmrc`, `~/.netrc`) unreadable
  from inside the sandbox, so a 330MB stream from the network can't become an exfiltration
  path.
- `failIfUnavailable: true` — a machine that can't start the sandbox fails loudly rather
  than quietly running commands unconfined. On a platform without sandbox support, drop
  that line knowingly rather than wondering why nothing starts.

**Egress is NOT confined by the committed file.** `allowedDomains` is listed there, but
`sandbox.network.strictAllowlist` is required to enforce it and is deliberately ignored from
project settings — otherwise a repo you cloned could rewrite your egress policy. Verified:
with the committed config alone, `example.com` and `pypi.org` are both reachable. To get
real confinement to the four hosts this repo uses, pass the committed flag file:

```bash
claude --settings .claude/strict-sandbox.json
```

Or put `{"sandbox":{"network":{"strictAllowlist":true}}}` in your own
`~/.claude/settings.json`, where it applies to every project but only bites where a sandbox
is actually enabled.

## Reference

- wpt.fyi API: https://github.com/web-platform-tests/wpt.fyi/blob/main/api/README.md
- Summary blobs are gzipped `summary_v2` JSON: `{"/test.html": {"s": "O", "c": [pass, total]}}`
