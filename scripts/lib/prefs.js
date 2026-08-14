/**
 * Which of these features a user can actually turn on — i.e. which are nightly-only.
 *
 * Why this exists
 * ---------------
 * The skill's most-suggested comparison is `--from firefox@beta --to firefox@nightly`
 * ("what is coming next"), and that is precisely the comparison where *everything*
 * nightly-only shows up as newly passing. One real 155 pass led with three headline
 * features — `attr()`, `progress()` and `alpha()` — and all three are nightly-only. The
 * notes presented them as shipped.
 *
 * Two mechanisms combine to make that invisible, and neither is obvious:
 *
 * 1. **WPT force-enables prefs.** `testing/web-platform/meta/<dir>/__dir__.ini` carries
 *    lines like `prefs: [layout.css.text-box.enabled:true]`, and the harness applies them.
 *    So a test can pass in a *beta* run for a feature beta users do not have — the pass
 *    means "implemented", not "enabled". Nothing in a pass-rate diff can distinguish those.
 *
 * 2. **The pref's default is channel-dependent**, in two different syntaxes:
 *
 *      value: @IS_NIGHTLY_BUILD@          # macro form, exactly resolvable
 *
 *      #if !defined(XP_LINUX) && defined(NIGHTLY_BUILD)
 *        value: 1
 *      #else
 *        value: 2
 *      #endif                             # block form, compound conditions
 *
 * So the check is: does this test's directory force a pref, and is that pref
 * channel-gated? Both halves come from mozilla-central via searchfox.
 *
 * On not picking a repo by version
 * -------------------------------
 * The obvious design — "read the pref from the repo matching the version" — does not work,
 * and checking saved it: `mozilla-central` is 156.0a1 while `mozilla-beta` and
 * `mozilla-release` are both 154.0, so a comparison about 155 maps to no repo at all. Worse,
 * reading only `mozilla-central` inverts the answer: central IS nightly, so
 * `layout.css.progress-function.enabled` reads `value: true` there and looks shipped, while
 * on the beta branch the same pref is `@IS_NIGHTLY_BUILD@`.
 *
 * So all three repos are read and reported side by side, and the verdict is left to the
 * writer with the default being to discount. A pref gated in any shipped-channel repo is not
 * something to describe as available, and where the trains genuinely disagree — because a
 * flip landed mid-cycle — the disagreement is the finding.
 */

const { execFile } = require('child_process');

const SPL = 'modules/libpref/init/StaticPrefList.yaml';
const META = 'testing/web-platform/meta';
const REPOS = ['mozilla-central', 'mozilla-beta', 'mozilla-release'];

// Macros whose value depends on the build channel rather than the platform. `@IS_ANDROID@`
// and friends are channel-independent and must not be mistaken for gating.
const CHANNEL_MACROS = {
  IS_NIGHTLY_BUILD: { nightly: true, shipped: false },
  IS_NOT_NIGHTLY_BUILD: { nightly: false, shipped: true },
  IS_NIGHTLY_OR_DEV_EDITION: { nightly: true, shipped: false },
  IS_NOT_RELEASE_OR_BETA: { nightly: true, shipped: false },
  // Early beta is not release, so from a "can a user rely on it" standpoint it is not shipped.
  IS_EARLY_BETA_OR_EARLIER: { nightly: true, shipped: false },
  IS_NOT_EARLY_BETA_OR_EARLIER: { nightly: false, shipped: true },
  IS_DEV_EDITION_OR_EARLY_BETA_OR_EARLIER: { nightly: true, shipped: false },
};
const CHANNEL_COND = /\b(NIGHTLY_BUILD|EARLY_BETA_OR_EARLIER|RELEASE_OR_BETA|MOZ_DEV_EDITION)\b/;

/**
 * Is searchfox-cli on PATH, and is it current?
 *
 * Judged on OUTPUT, not the exit code. The binary self-reports when a newer release exists,
 * and tying "is it installed" to a zero exit risks reporting a merely-outdated tool as
 * missing — which would swap the loudest warning here for the wrong one. Matching the version
 * banner cannot make that mistake.
 *
 * The version is recorded because a stale tool is a silent weakness of exactly the kind this
 * check exists to prevent: if an older release resolved `-R mozilla-beta` differently, the
 * pref verdicts would be wrong with nothing to show it.
 */
function searchfoxVersion() {
  return new Promise((resolve) => {
    execFile('searchfox-cli', ['--version'], { timeout: 15_000 }, (err, stdout, stderr) => {
      const text = `${stdout || ''}\n${stderr || ''}`;
      const m = text.match(/searchfox-cli\s+(\d+\.\d+\.\d+)/);
      if (!m) return resolve({ present: false, version: null, outdated: false, latest: null });
      const nag = text.match(/latest:\s*(\d+\.\d+\.\d+)/);
      resolve({
        present: true,
        version: m[1],
        outdated: !!nag && nag[1] !== m[1],
        latest: nag ? nag[1] : null,
      });
    });
  });
}

async function haveSearchfox() {
  return (await searchfoxVersion()).present;
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('searchfox-cli', args, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        // A missing file is a 404 on stderr and a non-zero exit; that is an ordinary answer
        // here (most directories have no __dir__.ini), not a failure.
        if (err) return resolve(null);
        resolve(stdout);
      });
  });
}

/**
 * searchfox-cli prints an upgrade nag on stdout when a newer release exists; it is not file
 * content. Dormant while the install is current, and NOT dead code — it returns the moment
 * upstream publishes a release.
 */
function clean(text) {
  return String(text || '')
    .split('\n')
    .filter((l) => !/^(Note: A newer version|\s+Run: cargo binstall)/.test(l))
    .join('\n');
}

/**
 * StaticPrefList.yaml -> Map(prefName -> { nightly, shipped, raw, gated }).
 *
 * `nightly`/`shipped` are the resolved default where it can be resolved, and `null` where it
 * cannot — a compound `#if !defined(XP_LINUX) && defined(NIGHTLY_BUILD)` is deliberately
 * left unresolved rather than guessed, with `gated` still true so it is not read as shipped.
 */
function parseStaticPrefList(text) {
  const out = new Map();
  const lines = clean(text).split('\n');
  // Stack of enclosing #if conditions, so a `value:` knows whether it is channel-gated.
  const stack = [];
  let name = null;
  let seen = [];

  const flush = () => {
    if (!name) return;
    // No branches recorded (shouldn't happen) -> unknown.
    if (!seen.length) { out.set(name, { nightly: null, shipped: null, raw: null, gated: false }); }
    else {
      // Resolve every branch, then combine. A channel macro is gating wherever it appears —
      // including inside a PLATFORM #if, which is the case that was wrong:
      // dom.clipboard.customFormatSupport.enabled is `false` on Android and
      // `@IS_NIGHTLY_BUILD@` on desktop, so it has two branches and no channel *condition*,
      // and it resolved to "unclear" for a plainly nightly-only pref.
      const resolved = seen.map((v) => {
        const macro = (v.value.match(/^@(\w+)@$/) || [])[1];
        if (macro && CHANNEL_MACROS[macro]) return { ...CHANNEL_MACROS[macro], macro: true };
        if (/^(true|false)$/.test(v.value)) {
          const b = v.value === 'true';
          return { nightly: b, shipped: b, macro: false };
        }
        return { nightly: null, shipped: null, macro: false };
      });
      const gated = seen.some((v) => v.gated) || resolved.some((r) => r.macro);
      let nightly = null;
      let shipped = null;
      // Unambiguous only when every branch agrees. Any branch on nightly with none shipped is
      // still a clear answer: nobody on a shipped channel gets it, whatever the platform.
      const known = resolved.filter((r) => r.nightly !== null);
      if (known.length === resolved.length && known.length) {
        nightly = known.some((r) => r.nightly);
        shipped = known.some((r) => r.shipped);
      }
      out.set(name, {
        nightly,
        shipped,
        raw: seen.map((v) => v.value).join(' | '),
        gated,
      });
    }
    name = null;
    seen = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (/^#if/.test(line)) { stack.push(CHANNEL_COND.test(line)); continue; }
    if (/^#elif/.test(line)) { stack[stack.length - 1] = CHANNEL_COND.test(line) || stack[stack.length - 1]; continue; }
    // #else inherits whether the #if it belongs to was channel-conditional.
    if (/^#else/.test(line)) continue;
    if (/^#endif/.test(line)) { stack.pop(); continue; }
    const nm = line.match(/^-\s+name:\s*(\S+)/);
    if (nm) { flush(); name = nm[1]; continue; }
    const v = line.match(/^value:\s*(.+?)\s*(?:#.*)?$/);
    if (v && name) seen.push({ value: v[1].trim(), gated: stack.some(Boolean) });
  }
  flush();
  return out;
}

/**
 * The pref names a `__dir__.ini` forces on.
 *
 * `prefs:` can be a bare list or a set of `if os == "…":` branches; every branch counts,
 * because a pref forced on any platform means a pass there does not imply a shipped default.
 */
function parseDirIni(text) {
  const names = new Set();
  for (const m of clean(text).matchAll(/\[([^\]]*)\]/g)) {
    for (const entry of m[1].split(',')) {
      const pref = entry.trim().split(':')[0].trim();
      if (/^[a-z][\w.-]*\.[\w.-]+$/i.test(pref)) names.add(pref);
    }
  }
  return [...names];
}

/** Run `fn` over `items` with bounded concurrency. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    for (;;) {
      const n = i++;
      if (n >= items.length) return;
      out[n] = await fn(items[n], n);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Every ancestor directory of a test path, shallowest first. WPT prefs inherit downward. */
function ancestorsOf(testPath) {
  const parts = String(testPath).replace(/^\//, '').replace(/\?.*$/, '').split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * Which prefs the WPT harness forces for the given tests, and whether each is channel-gated.
 *
 * Costs one searchfox call per repo (3) plus one per ancestor directory — ~360 on a
 * beta-to-nightly diff, pooled, and cached by searchfox-cli afterwards. Best-effort: if
 * anything fails the result says so, because "no nightly-only features found" and "the check
 * did not run" must never look the same.
 */
async function analysePrefGating(tests, { concurrency = 8, onProgress, prefLists = null } = {}) {
  const tool = prefLists ? prefLists.tool : await searchfoxVersion();
  if (!tool.present) {
    return {
      ok: false,
      missingTool: true,
      tool,
      error: 'searchfox-cli is not installed, so nightly-only features CANNOT be identified',
    };
  }
  try {
    let lists = prefLists && prefLists.lists;
    if (!lists) {
      lists = {};
      for (const repo of REPOS) {
        const text = await run(['-R', repo, '--get-file', SPL]);
        if (!text) throw new Error(`could not read ${SPL} from ${repo}`);
        lists[repo] = parseStaticPrefList(text);
      }
    }

    const dirs = [...new Set(tests.flatMap((t) => ancestorsOf(t)))].sort();
    let done = 0;
    const forced = new Map();
    await pool(dirs, concurrency, async (dir) => {
      const text = await run(['--get-file', `${META}/${dir}/__dir__.ini`]);
      done++;
      if (onProgress && done % 40 === 0) onProgress(done, dirs.length);
      if (text) {
        const names = parseDirIni(text);
        if (names.length) forced.set(dir, names);
      }
    });

    // Classify every forced pref once.
    const prefs = {};
    for (const names of forced.values()) {
      for (const pref of names) {
        if (prefs[pref]) continue;
        const per = {};
        for (const repo of REPOS) {
          const info = lists[repo].get(pref);
          per[repo] = info || null;
        }
        prefs[pref] = { pref, per, verdict: verdictFor(per) };
      }
    }
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      tool,
      dirsProbed: dirs.length,
      forced: [...forced.entries()].map(([dir, names]) => ({ dir, prefs: names })),
      prefs,
    };
  } catch (err) {
    return { ok: false, tool, error: String((err && err.message) || err) };
  }
}

/**
 * One pref's fate across the trains.
 *
 * Five outcomes, and only `shipped` means "a user has this". They are kept distinct because
 * accuracy of the LABEL matters as much as the discount decision: an earlier version called
 * everything gated "nightly-only", which was wrong for `layout.css.scroll-state.enabled`
 * (false in nightly too — nobody has it) and meaningless for
 * `layout.css.floating-first-letter.tight-glyph-bounds` (an int pref that differs by channel).
 * Both should still be discounted; neither is nightly-only.
 *
 * Anything ambiguous resolves AWAY from `shipped`. The purpose is to stop a nightly-only
 * feature being presented as available, so caution has to be the failure direction.
 */
function verdictFor(per) {
  const central = per['mozilla-central'];
  const shippedRepos = [per['mozilla-beta'], per['mozilla-release']].filter(Boolean);
  if (!central && !shippedRepos.length) return 'unknown-pref';
  const all = [central, ...shippedRepos].filter(Boolean);
  const gated = all.some((i) => i.gated);

  // Off everywhere, including nightly: the test only passes because WPT forces the pref on.
  // Nobody has the feature by default, which is a stronger reason to discount than
  // nightly-only, and a different sentence.
  const offEverywhere = all.length && all.every((i) => i.shipped === false && i.nightly === false);
  if (offEverywhere) return 'off-by-default';

  // Non-boolean and channel-dependent — a tuning value, not a feature switch.
  if (gated && all.every((i) => i.nightly === null && i.shipped === null)) return 'channel-dependent';

  const onInNightly = central ? central.nightly !== false : true;
  const offWhenShipped = shippedRepos.some((i) => i.gated || i.shipped === false);
  const onWhenShipped = shippedRepos.filter((i) => i.shipped === true && !i.gated);

  // Gated on some platforms and shipped on others. `network.http.happy_eyeballs_enabled` is
  // `@IS_NIGHTLY_BUILD@` on Android and `true` everywhere else, so desktop users DO have it —
  // calling that nightly-only is as wrong as calling it shipped, just in the other direction.
  // It needs a sentence naming the platforms, not a discount.
  const platformSplit = all.some((i) => i.gated && i.shipped === true);
  if (platformSplit) return 'platform-split';

  if (offWhenShipped && !onWhenShipped.length && onInNightly) return 'nightly-only';
  if (!gated && onWhenShipped.length && onWhenShipped.length === shippedRepos.length) {
    return 'shipped';
  }
  if (gated) return 'nightly-only';
  return 'unclear';
}

/** Does this verdict mean a user of the shipped channel does NOT have the feature? */
function discount(verdict) {
  // A platform split ships somewhere, so it is not discountable wholesale — it needs a
  // sentence naming the platforms.
  return verdict !== 'shipped' && verdict !== 'platform-split';
}

/** A short, accurate phrase per verdict, for the inventory and worksheet markers. */
const VERDICT_LABEL = {
  shipped: 'on by default',
  'platform-split': 'on by default on SOME platforms only',
  'nightly-only': 'NIGHTLY-ONLY',
  'off-by-default': 'OFF by default everywhere',
  'channel-dependent': 'channel-dependent value',
  unclear: 'pref state unclear',
  'unknown-pref': 'pref not found',
};

/** The prefs forced for one test path, nearest ancestor last. */
function prefsForTest(gating, testPath) {
  if (!gating || !gating.ok) return [];
  const byDir = new Map(gating.forced.map((f) => [f.dir, f.prefs]));
  const names = new Set();
  for (const dir of ancestorsOf(testPath)) {
    for (const p of byDir.get(dir) || []) names.add(p);
  }
  return [...names].map((p) => gating.prefs[p]).filter(Boolean);
}

/**
 * A pref name's distinctive tokens, for matching it to the tests it gates.
 *
 * Ancestry alone cannot do this job, and finding that out mattered:
 * `testing/web-platform/meta/css/__dir__.ini` force-enables EIGHT prefs for every test under
 * `/css`, several of them nightly-only. So "an ancestor forces a gated pref" is true of every
 * CSS directory and marks all of them, which is the same as marking none. The pref name is
 * the discriminator — `layout.css.progress-function.enabled` belongs to
 * `/css/css-values/progress-*`, not to `/css/css-color`.
 */
const GENERIC = new Set(`element elements forms display document color colors animation
animations transition transitions duration legacy description parsing scripted screen media
navigator streams select selection value values property properties style styles content
enabled disabled interface window global default options experimental support
first second third state states event events target targets custom permission
permissions`.split(/\s+/).filter(Boolean));

function prefTokens(pref) {
  const NAMESPACE = /^(layout\.css|layout|dom|network|media|gfx|mathml|image|browser|javascript\.options|javascript|privacy|security|apz|test|accessibility|editor|svg|widget|full-screen-api|clipboard)\./;
  const core = String(pref)
    .replace(NAMESPACE, '')
    .replace(/\.(enabled|disabled|enable|available|visible|supported)$/, '');
  const out = new Set();
  for (const seg of core.split('.')) {
    if (!seg) continue;
    // The hyphenated segment as a whole is the strongest form: `progress-function`,
    // `typed-om`, `ellipse-corners`.
    // A hyphenated segment is specific enough on its own merit; a bare word has to clear the
    // generic list, because `element` and `forms` match dozens of unrelated directories.
    if (seg.includes('-') || (seg.length >= 5 && !GENERIC.has(seg))) out.add(seg);
    // ...and its head, which is what a directory or filename usually uses.
    const head = seg.split('-')[0];
    if (head.length >= 5 && head !== seg && !GENERIC.has(head)) out.add(head);
  }
  return [...out];
}

/**
 * Which changed tests each gated pref plausibly gates, matched on path and subtest names.
 *
 * Deliberately the same shape as the changelog's matcher, and deliberately reported as an
 * association rather than a certainty: a pref name is a strong hint about which feature it
 * controls, not proof.
 */
/** A path or token as ' word word ' so matches land on whole words, never inside them. */
function words(text) {
  return ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

function matchPrefsToTests(gating, rows) {
  if (!gating || !gating.ok) return gating;
  const byTest = new Map();
  for (const info of Object.values(gating.prefs)) {
    if (!discount(info.verdict)) continue;
    const tokens = prefTokens(info.pref).map((t) => t.toLowerCase());
    if (!tokens.length) continue;
    for (const r of rows) {
      // The test PATH only, deliberately — not subtest names. A pref gates a feature area and
      // WPT paths are organised by feature area, whereas subtest names quote arbitrary CSS and
      // API vocabulary. Matching names too produced confident nonsense: `touch-events` was
      // flagged by `layout.css.webkit-line-clamp.skip-paint` on the word "webkit", and
      // `css/css-fonts/parsing` by `media.peerconnection.description.legacy.enabled`.
      // Whole-SEGMENT matching, not substring. `dom.forms.alpha.enabled` matched
      // `css-trans-FORMS/animation`, and `full-screen-api.transition-duration.enter` matched
      // `css-transitions` — both pure coincidence from a substring hit inside a longer word.
      // Both sides collapse to space-separated words so a token has to match whole words.
      if (!tokens.some((t) => words(r.test).includes(` ${words(t).trim()} `))) continue;
      if (!byTest.has(r.test)) byTest.set(r.test, []);
      byTest.get(r.test).push(info.pref);
    }
  }
  return {
    ...gating,
    gatedTests: [...byTest.entries()].map(([test, prefs]) => ({ test, prefs })),
  };
}

/**
 * The marker for a directory in the inventory and the worksheet, or null when nothing in it
 * is pref-gated.
 *
 * Directory granularity because that is the scale that works: hundreds of gated tests on one
 * real diff but only a few dozen directories, so a per-file box would be unreadable while a
 * per-directory marker lands where the reader is already making a decision.
 */
function dirMarker(gating, dir) {
  if (!gating || !gating.ok || !gating.gatedTests) return null;
  const prefix = `/${dir}/`;
  const hits = gating.gatedTests.filter((g) => `${g.test}`.startsWith(prefix));
  if (!hits.length) return null;
  const names = [...new Set(hits.flatMap((h) => h.prefs))];
  const infos = names.map((n) => gating.prefs[n]).filter(Boolean);
  const order = ['nightly-only', 'off-by-default', 'channel-dependent', 'unclear', 'unknown-pref'];
  // Worst verdict first, then the pref that matched the MOST of this directory's files. The
  // count tie-break is what makes the marker name the directory's own feature: Typed OM tests
  // touch every CSS property, so they legitimately match `ellipse-corners` too, and without
  // this the marker for /css/css-typed-om led with a pref about corner shapes.
  const filesFor = (pref) => hits.filter((h) => h.prefs.includes(pref)).length;
  infos.sort((x, y) => order.indexOf(x.verdict) - order.indexOf(y.verdict)
    || filesFor(y.pref) - filesFor(x.pref));
  const worst = infos[0];
  return {
    verdict: worst.verdict,
    label: VERDICT_LABEL[worst.verdict],
    // In the SAME order as the marker text, so the detail line leads with the pref the
    // heading named rather than an arbitrary one.
    prefs: infos.map((i) => i.pref),
    files: hits.length,
    text: `[${VERDICT_LABEL[worst.verdict]}: ${worst.pref}${names.length > 1 ? ` +${names.length - 1}` : ''}, ${hits.length}f]`,
  };
}

/** Tests gated by a pref a shipped-channel user does not have. */
function nightlyOnlyTests(gating) {
  if (!gating || !gating.ok || !gating.gatedTests) return [];
  return gating.gatedTests;
}


/**
 * Resolve changelog bugs to the pref that controls them, and to that pref's channel verdict.
 *
 * This is the half that was missing, and WebAssembly is what exposed it. A wasm proposal is a
 * binary-format and instruction-set change with no JavaScript API surface, so it has **no WPT
 * coverage in either direction** — by design, permanently, not as a lag. Every test-based
 * signal in this toolkit therefore says nothing about it, and one real 155 pass read that
 * silence as "cannot verify" and dropped both shipped proposals (bug 2062344 compact import
 * section, bug 2062374 wide arithmetic) until a human put them back.
 *
 * But the authoritative evidence exists and is one lookup away: `Ship the compact import
 * section proposal` maps to `javascript.options.wasm_compact_imports`, whose default across
 * mozilla-central/-beta/-release says exactly whether a user has it. So the box can carry the
 * answer instead of the reader having to know that wasm needs a different method.
 *
 * Matching is bug-summary <-> pref-name on distinctive tokens, with prefix comparison because
 * the two are not identically inflected: the pref says `compact_imports` and the bug says
 * "compact import section".
 */
// A bug's component narrows which prefs could possibly control it, and it is the difference
// between finding the right pref and finding a coincidence: "Ship the compact import section
// proposal" matched `javascript.options.compact_on_user_inactive` on the word "compact" until
// the component said the pref had to be about wasm.
const COMPONENT_HINTS = [
  [/WebAssembly/i, /wasm/i],
  [/JavaScript/i, /^javascript\./i],
  [/CSS|Layout/i, /^layout\./i],
  [/DOM|HTML/i, /^dom\./i],
  [/Networking/i, /^network\./i],
  [/WebRTC|Audio|Video|Media/i, /^media\./i],
  [/Graphics|Canvas/i, /^(gfx|image|webgl)\./i],
  [/MathML/i, /^mathml\./i],
  [/SVG/i, /^svg\.|^layout\./i],
  [/Security|Privacy/i, /^(security|privacy|dom\.security)\./i],
];

/** Individual words of a pref name — `wasm_wide_arithmetic` -> wasm, wide, arithmetic. */
function prefWords(name) {
  return [...new Set(
    String(name).split(/[._-]+/).filter((w) => w.length >= 4 && !GENERIC.has(w.toLowerCase())),
  )];
}

function prefsForBugs(lists, bugs, milestones = null) {
  // Index prefs by their individual words once. The whole hyphenated name as a single token
  // was too coarse: `wasm_wide_arithmetic` produced one token that no summary word could
  // prefix-match, so the Wide Arithmetic proposal resolved to nothing at all.
  const index = new Map();
  const central = lists['mozilla-central'] || new Map();
  for (const name of central.keys()) {
    for (const t of prefWords(name)) {
      const k = t.toLowerCase();
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(name);
    }
  }
  const out = {};
  for (const bug of bugs) {
    const summaryWords = words(bug.summary).trim().split(/\s+/).filter((w) => w.length >= 4);
    const scores = new Map();
    for (const [token, names] of index) {
      // Prefix comparison in both directions: `imports` vs `import`, `arithmetic` vs
      // `arithmetics`. Five characters is enough to stay specific without demanding the same
      // inflection.
      const hit = summaryWords.some((w) => {
        if (w === token) return true;   // exact, whatever the length: `wide` is four characters
        const n = Math.min(w.length, token.length);
        return n >= 5 && (w.startsWith(token.slice(0, n)) || token.startsWith(w.slice(0, n)));
      });
      if (!hit) continue;
      for (const name of names) scores.set(name, (scores.get(name) || 0) + 1);
    }
    if (!scores.size) continue;
    // The component hint is a filter, not a tiebreak: a pref outside the namespace its
    // component implies is a coincidence however many words it shares.
    const hint = (COMPONENT_HINTS.find(([c]) => c.test(bug.component || '')) || [])[1];
    let ranked = [...scores.entries()];
    if (hint) {
      const inNamespace = ranked.filter(([name]) => hint.test(name));
      if (inNamespace.length) ranked = inNamespace;
    }
    // Most words matched wins; ties break toward the shorter name, which is the less
    // specific and so more likely to be the feature's own switch.
    const best = ranked.sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
    // Two matching words minimum. One is a coincidence — `compact` alone found a pref about
    // inactive-user compaction.
    if (best[1] < 2) continue;
    const per = {};
    for (const repo of REPOS) per[repo] = (lists[repo] || new Map()).get(best[0]) || null;
    out[bug.id] = {
      pref: best[0],
      tokensMatched: best[1],
      per,
      ...verdictForBug(per, bug, milestones),
    };
  }
  return out;
}

/**
 * Which Firefox version each repo currently is.
 *
 * Needed because the trains do not line up with the version being written about: on one real
 * day mozilla-central was 156 while -beta and -release were both 154, so notes about 155 mapped
 * to no repo. Without this, a pref flipped during 155's cycle reads as nightly-only, because
 * the beta branch still carries 154's gate.
 */
async function fetchMilestones() {
  const out = {};
  for (const repo of REPOS) {
    const text = await run(['-R', repo, '--get-file', 'config/milestone.txt']);
    const m = clean(text || '').split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')).pop();
    const v = m && m.match(/^(\d+)/);
    out[repo] = v ? Number(v[1]) : null;
  }
  return out;
}

/**
 * A bug's pref verdict, accounting for where the release trains actually are.
 *
 * The shipped-channel repos can only speak for the versions they hold. `Ship the Wide
 * Arithmetic proposal` is fixed for 155, the pref is unconditionally true in central, and
 * mozilla-beta — still on 154 — carries `@IS_NIGHTLY_BUILD@`. Reading beta gives
 * "nightly-only", which is 154's answer to a question about 155. When the bug's milestone is
 * ahead of the beta branch, the flip landed inside that cycle and central is the evidence.
 */
function verdictForBug(per, bug, milestones) {
  const plain = verdictFor(per);
  const target = String(bug.milestone || '').match(/^(\d+)/);
  const beta = milestones && milestones['mozilla-beta'];
  if (!target || !beta) return { verdict: plain, trainNote: null };
  const n = Number(target[1]);
  if (n <= beta) return { verdict: plain, trainNote: null };
  const central = per['mozilla-central'];
  // Platform-split first: `network.http.happy_eyeballs_enabled` is `@IS_NIGHTLY_BUILD@` on
  // Android and `true` elsewhere, so central is BOTH gated and shipping. Reading only `gated`
  // returned nightly-only and would have told the reader desktop users do not have it.
  if (central && central.gated && central.shipped === true) {
    return {
      verdict: 'platform-split',
      trainNote: `central ships it on some platforms and gates it on others (${central.raw}) — `
        + 'say which, rather than treating it as available or as nightly-only',
    };
  }
  if (central && central.gated) {
    return {
      verdict: 'nightly-only',
      trainNote: `gated in mozilla-central too, so ${n} does not get it`,
    };
  }
  if (central && central.shipped === true) {
    return {
      verdict: 'shipped',
      trainNote: `mozilla-beta is still ${beta}, so its gate describes ${beta}, not ${n}; `
        + `central has it unconditionally, i.e. the flip landed in ${n}'s cycle`,
    };
  }
  return { verdict: 'unclear', trainNote: `no repo holds ${n}; check the pref by hand` };
}

/** Fetch the three pref lists on their own, for callers that only want prefsForBugs. */
async function fetchPrefLists() {
  const tool = await searchfoxVersion();
  if (!tool.present) return { ok: false, missingTool: true, tool };
  try {
    const lists = {};
    for (const repo of REPOS) {
      const text = await run(['-R', repo, '--get-file', SPL]);
      if (!text) throw new Error(`could not read ${SPL} from ${repo}`);
      lists[repo] = parseStaticPrefList(text);
    }
    const milestones = await fetchMilestones();
    return { ok: true, tool, lists, milestones };
  } catch (err) {
    return { ok: false, tool, error: String((err && err.message) || err) };
  }
}

module.exports = {
  haveSearchfox, searchfoxVersion, parseStaticPrefList, parseDirIni, analysePrefGating, verdictFor,
  prefsForTest, nightlyOnlyTests, ancestorsOf, discount, dirMarker, matchPrefsToTests,
  prefTokens, prefWords, words, prefsForBugs, fetchPrefLists, fetchMilestones, verdictForBug, VERDICT_LABEL, REPOS, CHANNEL_MACROS,
  GENERIC,
};
