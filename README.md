# WPT browser diff → release notes

Tools for turning [wpt.fyi](https://wpt.fyi) web-platform-tests results into
developer-facing release notes: what a browser can newly do, and what broke.

Works for any two builds wpt.fyi knows about — channels of one browser
(Firefox nightly vs beta) or across browsers (Chrome stable vs Firefox nightly).

Node 18+ required (uses built-in `fetch`). No dependencies.

## Quick start

```bash
mkdir -p tmp
node scripts/wpt-diff.js --from firefox@beta --to firefox@nightly --json --top 25 > tmp/diff.txt
```

Then read the full inventory, drill into whatever moved, and read the tests before writing
about them:

```bash
D=tmp/firefox-beta-vs-firefox-experimental.diff.json   # --json prints the path it chose
node scripts/wpt-inventory.js "$D" --checklist          # coverage worksheet — start here
node scripts/wpt-inventory.js "$D" --dirs               # every directory that moved
node scripts/wpt-inventory.js "$D"                      # every changed file, grouped
node scripts/wpt-area.js "$D" /fetch                    # what changed in an area
node scripts/wpt-subtests.js "$D" /fetch/http-cache/no-vary-search.tentative.any.html
node scripts/wpt-fetch-tests.js --from-diff "$D" --area /fetch --top 3
```

Read the inventory in full rather than skimming the biggest numbers. **Subtest count is not
a measure of importance** — a one-file `+1` was a shipped feature (`-webkit-` pseudo-elements
now parse) that got missed twice by ranked views, and a `+400` can be one missing property
fixed. The inventory selects nothing and sorts alphabetically for exactly this reason, and
it takes no `--exclude` unless you ask: an earlier default of `/third_party` hid the whole
`Intl.Locale` info proposal. JavaScript and `Intl` features live in `third_party/test262`,
never under a web-platform directory.

## Scripts

| Script | Purpose |
| --- | --- |
| [wpt-diff.js](scripts/wpt-diff.js) | Diff two runs. Prints a report; `--json` writes structured data for the other scripts. |
| [wpt-inventory.js](scripts/wpt-inventory.js) | Every changed file, grouped by directory, ranked by nothing. `--checklist` turns it into a coverage worksheet with a per-directory verdict. |
| [wpt-area.js](scripts/wpt-area.js) | Drill into one path prefix of a diff, or list all regressions/improvements. |
| [wpt-subtests.js](scripts/wpt-subtests.js) | Diff the individual subtests of one test file, with the assertion message for each failure. Finds the *cause*, not just the count. |
| [wpt-fetch-tests.js](scripts/wpt-fetch-tests.js) | Fetch WPT test sources so code examples are accurate rather than guessed. |

Each takes `--help`.

Specs for `wpt-diff.js` are `product[@channel]`; channels are `stable`, `beta`,
`experimental` (aliases `nightly`, `release`, `tp`).

```bash
node scripts/wpt-diff.js --from chrome@stable --to firefox@nightly --json
node scripts/wpt-diff.js --from firefox@beta --to firefox@nightly --aligned
```

`--aligned` pins both runs to the same WPT revision so test-suite churn drops out of the
diff. Release channels are often tested at different revisions, so it can fail to find a
match — it says so rather than guessing.

Also supported: a version pin, for release notes between two shipped versions. Once 153 is
stable, `firefox@stable` no longer resolves to 152, so the baseline has to be named.

```bash
node scripts/wpt-diff.js --from firefox@stable@152 --to firefox@stable@153 --json
```

Keep the channel alongside the version — nightly runs outnumber stable ones by ~50:1, so an
unlabelled version search never reaches back far enough. Version pins can't be combined
with `--aligned`: two shipped versions are never tested at the same WPT revision.

Test files are classified, which is what makes the analysis possible. The most useful
category is `newly-running`: a test that previously errored or crashed and now executes,
which usually means an API went from absent to present. Reference tests get their own
sections, because they carry no subtests and so are invisible to a subtest delta.

The report ends with a **Directory clusters** section, which ranks directories by how many
files moved and how one-sided the movement was, rather than by subtest delta. Every other
section ranks by magnitude, so a feature that lands as many tiny per-file gains is invisible
in all of them — this section is the one that catches it, and it prints in full rather than
obeying `--top`. Added and removed tests don't count as movement (that's test-suite churn,
not the browser), and nothing is excluded by path — `third_party/test262` clusters are where
JavaScript and `Intl` features show up. Loosen it with `--cluster-min` and `--cluster-ratio`.

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
tmp/                   generated diffs (gitignored — a diff.json is ~600KB and changes daily)
release-notes/         finished notes (gitignored — regenerable, and stale as new runs land)
.claude/skills/        the repeatable workflow
```

## Reference

- wpt.fyi API: https://github.com/web-platform-tests/wpt.fyi/blob/main/api/README.md
- Summary blobs are gzipped `summary_v2` JSON: `{"/test.html": {"s": "O", "c": [pass, total]}}`
