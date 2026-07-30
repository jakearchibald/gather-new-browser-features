# WPT browser diff → release notes

Tools for turning [wpt.fyi](https://wpt.fyi) web-platform-tests results into
developer-facing release notes: what a browser can newly do, and what broke.

Works for any two builds wpt.fyi knows about — channels of one browser
(Firefox nightly vs beta) or across browsers (Chrome stable vs Firefox nightly).

Node 18+ required. One dependency: `undici`, for proxy-aware `fetch` — Node's built-in
`fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY`, which makes these scripts fail with `ENOTFOUND`
on every host behind a corporate proxy or a sandbox. `pnpm install` before first use.

## Quick start

```bash
pnpm install
mkdir -p tmp
node scripts/wpt-diff.js --from firefox@beta --to firefox@nightly --subtests --json --top 25 > tmp/diff.txt
```

`--subtests` streams both raw reports (~330MB each, ~10s) to record the newly-passing and
newly-failing subtest *names* per changed file. Those names are what identify a feature; a
path usually can't. Then read the full inventory, drill into whatever moved, and read the
tests before writing about them:

```bash
D=tmp/firefox-beta-vs-firefox-experimental.diff.json   # --json prints the path it chose
node scripts/wpt-inventory.js "$D" --checklist tmp/checklist.md   # worksheet — start here
node scripts/wpt-inventory.js "$D"                      # every changed file + its subtest names
node scripts/wpt-inventory.js --verify tmp/checklist.md # non-zero while boxes are unticked
node scripts/wpt-area.js "$D" /fetch                    # what changed in an area
node scripts/wpt-subtests.js "$D" /fetch/http-cache/no-vary-search.tentative.any.html --limit 0
node scripts/wpt-fetch-tests.js --from-diff "$D" --area /fetch --top 3
node scripts/wpt-state.js "$D" --grep sound-state       # is there even a test? (diffs can't say)
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
| [wpt-diff.js](scripts/wpt-diff.js) | Diff two runs. Prints a report; `--json` writes structured data for the other scripts, and `--subtests` adds per-file subtest names. |
| [wpt-inventory.js](scripts/wpt-inventory.js) | Every changed file with its subtest names, grouped by directory, ranked by nothing. `--checklist` writes a coverage worksheet; `--verify` fails while any box is unticked. |
| [wpt-area.js](scripts/wpt-area.js) | Drill into one path prefix of a diff, or list all regressions/improvements. |
| [wpt-subtests.js](scripts/wpt-subtests.js) | Diff the individual subtests of one or more test files, with the assertion message for each failure. Finds the *cause*, not just the count. Pass every path to one invocation — each call streams two ~330MB reports and scans them in a single pass. |
| [wpt-fetch-tests.js](scripts/wpt-fetch-tests.js) | Fetch WPT test sources so code examples are accurate rather than guessed. Pass `--from-diff` to read them at the revision the runs were tested at, not `master`. |
| [wpt-grep.js](scripts/wpt-grep.js) | Search a diff for a keyword in subtest names and messages (free), paths (free), then test source (`--sources`). A filename often contains no word from the feature's name. |
| [wpt-state.js](scripts/wpt-state.js) | Absolute pass/fail of a test in both runs, including tests the diff omits. "Not in the diff" never means "not shipped". |
| [selftest.js](scripts/selftest.js) | Asserts the tooling still surfaces the features it has historically missed. Run it after changing any of the above. |

Each takes `--help`.

Specs for `wpt-diff.js` are `product[@channel][@version]`; channels are `stable`, `beta`,
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

With `--subtests` there is also a **One feature, several directories** section, which does
the same job on subtest vocabulary instead of paths: a token appearing in newly-passing
subtest names under two or more directories is probably one change in several places.
`field-sizing` turned up across `/css/css-cascade`, `/css/css-ui`, `/html/rendering/widgets`
and `/web-animations`.

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
scripts/lib/net.js     proxy-aware fetch; Node's built-in fetch ignores HTTP_PROXY
tmp/                   generated diffs (gitignored — ~2.5MB with --subtests, changes daily)
release-notes/         finished notes (gitignored — regenerable, and stale as new runs land)
.claude/skills/        the repeatable workflow
```

`selftest.js` needs two diff artifacts to run against; see its `--help` for the two commands
that generate them.

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
