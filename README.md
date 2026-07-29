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

Then drill into whatever moved, and read the tests before writing about them:

```bash
D=tmp/firefox-beta-vs-firefox-experimental.diff.json   # --json prints the path it chose
node scripts/wpt-area.js "$D" /fetch                    # what changed in an area
node scripts/wpt-subtests.js "$D" /fetch/http-cache/no-vary-search.tentative.any.html
node scripts/wpt-fetch-tests.js --from-diff "$D" --area /fetch --top 3
```

## Scripts

| Script | Purpose |
| --- | --- |
| [wpt-diff.js](scripts/wpt-diff.js) | Diff two runs. Prints a report; `--json` writes structured data for the other scripts. |
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

Test files are classified, which is what makes the analysis possible. The most useful
category is `newly-running`: a test that previously errored or crashed and now executes,
which usually means an API went from absent to present.

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
.claude/skills/        the repeatable workflow
```

## Reference

- wpt.fyi API: https://github.com/web-platform-tests/wpt.fyi/blob/main/api/README.md
- Summary blobs are gzipped `summary_v2` JSON: `{"/test.html": {"s": "O", "c": [pass, total]}}`
