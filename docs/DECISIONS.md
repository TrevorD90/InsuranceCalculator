# Decision log

Every significant decision, assumption and tradeoff, newest first. `[DECISION: reason]` and
`[ASSUMPTION: …]` entries are flagged for review and are **not** blocking questions — work
continued past them.

Append a new dated section for each working session. Never rewrite history; if a decision is
reversed, add a new entry that supersedes it and mark the old one.

---

## 2026-08-15 (2) — Auto-update

Closing the gap flagged at the end of the v1.0.0 entry. New module `updater.js`, main process
only, `electron-updater` against the GitHub Releases provider. Full behaviour in
ARCHITECTURE §7.5; IPC in DATA-FLOW §5.

### 🔴 Caught before shipping: three names for one file

The build's `latest.yml` named the update file `Plan-Ledger-Setup-1.0.1.exe`. The file on disk
was `Plan Ledger Setup 1.0.1.exe`. GitHub, which rewrites spaces to dots on upload, had stored
v1.0.0's as `Plan.Ledger.Setup.1.0.0.exe`.

electron-builder space-normalises the name it writes into the update feed but not the file it
writes to disk, so the feed and the artifact disagreed before GitHub ever saw them. The updater
would have found the release, read the version, offered the update, and then 404'd fetching the
installer — a failure that appears only on other people's machines, and only after a release
looks successful.

**Fix:** explicit `artifactName` for `nsis`, `portable`, `mac` and `dmg`, hyphenated, so disk,
`latest.yml` and the uploaded asset are the same string. Verified by computing the SHA-512 and
byte length of the built installer and comparing both against `latest.yml`. Recorded in
ARCHITECTURE §9 as a rule with the reasoning, because the failure mode is invisible locally.

Related: `latest.yml` itself must be attached to every release. Omitting it does not break that
release's download — it breaks update checking for everyone already running the app. Also in §9.

### Decisions

- `[DECISION: check automatically, download only on a click]` The installer is 80 MB. Starting
  that on someone's connection unasked — possibly metered — is rude, and the app has no way to
  know what it is costing them. `autoDownload = false`; the user clicks. `autoInstallOnAppQuit`
  stays true so a download they never got round to restarting for is not wasted.
- `[DECISION: a failed background check says nothing]` Being offline at launch is the common
  case, not an error worth a banner. Only a check the user explicitly asked for reports its
  failure. **Alternative not taken:** surfacing every failure, which trains people to ignore the
  one notice that matters.
- `[DECISION: detect the three cases that cannot self-install, rather than letting a button
  fail]` Development, portable `.exe`, and unsigned macOS each check and notify but hand off to
  the browser for the download. The alternative — an Install button that silently does nothing
  on macOS because Squirrel discarded the update — is the worse failure, because the user
  believes they updated.
- `[DECISION: main re-checks canSelfInstall on download]` The renderer should never offer that
  action in those builds, but main does not take the renderer's word for what it may do. Costs
  one branch; keeps the trust boundary meaning what §7 says it means.
- `[DECISION: the pill is green, not purple]` Purple is the AI light's alone (CLAUDE.md). The
  update pill is also deliberately quieter than the AI pill — an available update is
  information, not a state of the tool you are using.
- `[DECISION: released as v1.0.1]` An updater that has never been published is inert. v1.0.1
  establishes the baseline feed; the first hop it can actually perform is v1.0.1 → v1.0.2.
- `[ASSUMPTION: SIGNED_BUILDS stays false]` A constant in `updater.js` gating macOS
  self-install. It is flipped in the same change that adds real certificates, not before.

### Not verified end to end, and cannot yet be

An update has never actually installed itself, because doing so needs two consecutive releases
that both contain the updater. v1.0.0 has none, so the first genuinely testable hop is
v1.0.1 → v1.0.2. What *was* verified: the packaged build runs past the check window against
live GitHub without error, `latest.yml`'s SHA-512 and byte length match the built installer
exactly, and `electron-updater` is present in the 2.2 MB asar. **The install-and-relaunch path
should be exercised by hand when v1.0.2 is cut.**

`[DECISION: electron-updater over a hand-rolled check]` A hand-rolled "is there a newer tag"
check plus a browser hand-off would have been perhaps 40 lines and no dependency. Rejected
because it can never do the actual install, and the differential download, SHA-512 verification
and staged-install-on-quit are the parts that are genuinely fiddly to get right. The dependency
is main-process only and adds 0 production vulnerabilities (`npm audit --omit=dev` clean; the
14 reported vulnerabilities are all in electron-builder's dev tree).

---

## 2026-08-15 — v1.0.0 released

Finished the release that was interrupted mid-way on 2026-08-14. Yesterday's state: code
pushed, `npm run dist:win` artifacts sitting in `dist/`, **no tag and no release**. The
binaries were verified still newer than every source file before being published, so what is
downloadable is what is tagged.

Tag `v1.0.0` → commit `b6ee7a7`. Both Windows artifacts attached, byte sizes confirmed against
the local builds after upload.

- `[DECISION: the release ships Windows only]` No Mac was available to build on, and
  electron-builder does not cross-build a `.dmg` from Windows. Rather than hold the release or
  ship an untested macOS artifact, the notes state plainly that macOS builds are not attached
  and how to produce them. **Alternative not taken:** a CI matrix on GitHub Actions building
  both platforms on tag push. That is the right long-term answer and would have removed this
  decision entirely, but setting it up was not what the session was for.
- `[DECISION: binaries ship unsigned]` Signing needs a purchased Authenticode certificate and
  an Apple Developer ID. Neither exists. The notes tell users what SmartScreen will say and
  what to click. Recorded in ARCHITECTURE §10 as a limitation carried deliberately, not an
  oversight — for an app that asks for insurance details, an "unrecognized publisher" banner is
  a genuine cost.
- `[DECISION: published, not drafted]` Created as a public non-prerelease. v1.0.0 with 40 green
  assertions is not a preview, and a draft nobody promotes is indistinguishable from no release.
- `[ASSUMPTION: 1.0.0 as it stands in package.json is the intended version]` It was already
  `1.0.0` and the artifacts were built under that name; the tag was made to match rather than
  bumping anything.
- **Release procedure written down** in ARCHITECTURE §9, including the invariant that
  `package.json` version, git tag and release name must agree and the tag must point at the
  build commit. It was reconstructed from context this time; it should not have to be again.
- **README corrected** — it advertised 29 assertions; the suite is 40. Committed separately
  before tagging so the tagged tree is accurate.

**Open for review:** no auto-update path exists (ARCHITECTURE §10). Users who install v1.0.0
have no way to learn v1.0.1 happened. Worth deciding before the second release, not after.

---

## 2026-08-14 (6) — Coverage terms, and a real bug in the three-state preview

User report: *"when I put it in out of network, all the plans said they paid the full amount…
but if the plan does say there is a copay and the plan will pay 40% after deductible, it should
show that as well."*

### 🔴 Bug found: "after the deductible" silently collapsed into "after the maximum"

Investigating the report turned up an actual defect in `marginalCosts()`, not just a
presentation gap.

`stateAt()` wrote the **family** deductible into the **individual** ledger and then derived the
individual out-of-pocket total from that same figure:

```js
stateAt(limits.deductible.family, Math.min(limits.deductible.family, limits.oopMax.individual))
```

On any plan whose family deductible is at least its individual out-of-pocket maximum, that
second argument equals the maximum — so the "after the deductible" state was constructed with
the out-of-pocket maximum already reached, every cost share was forgiven, and the column
reported **$0 for visits that really cost a copay**.

Affected **five of the nine seed plan/tier combinations**: ES2P in and out, ES1J in and out,
ES38 in. ES2P's $40 designated-lab copay and $30 primary-care copay both displayed as $0.

The annual simulation was never affected — `simulate()` builds accumulators from real events.
Only the per-scenario preview was wrong, which is exactly the number the user was reading.

**Fix:** each ledger is filled from its own limits, and the out-of-pocket credit is clamped to
its own ceiling. Test R pins the specific case and adds a monotonicity invariant — across every
seed plan, tier and a representative set of services, meeting the deductible must never cost
more than not meeting it, and reaching the maximum must never cost more than meeting the
deductible. That invariant would have caught this the day it was written.

### Decisions

**[DECISION: state coinsurance from both sides]**
`describeBenefit()` renders "You pay 40%, plan pays 60%" rather than "40% coinsurance". The
member-share convention is the most misread figure in a plan document — the user's own phrasing
("the plan will pay for 40%") is the exact inversion — and naming both shares removes the
ambiguity where it is read rather than in a footnote.

**[DECISION: terms go in the engine, not the renderer]**
`describeBenefit(plan, benefitKey, tier)` sits beside `benefitAvailability` in `engine.mjs`. It
is a statement of fact about the plan, testable without a DOM, and subject to the same rule as
every other number the user sees.

**[DECISION: name the uncapped part in the same breath]**
Out-of-network terms end with "plus balance billing, which nothing caps", and NSA-protected
services say "no balance billing — protected by law". The exposure and the coverage belong in
one sentence; splitting them is how a reader concludes the out-of-pocket maximum protects them
when it does not.

**[DECISION: show what the plan pays in dollars, not just percentages]**
A green line under the terms reads "plan pays $120 of this visit once the deductible is met".
The percentage answers *what the plan does*; the dollar figure answers *what it is worth on this
visit*, which is the question a slider is being dragged to explore.

**[DECISION: blocked rows get terms too]**
An "Unavailable" row still carries "Not covered — you owe the whole charge". The label says the
plan cannot; the terms say what that costs.

### Verification

- 40/40 tests pass (3 new: R for the regression, Q and Q2 for the descriptions).
- Corrected figures, out-of-network specialist at $400 billed — the middle column changed on
  three of five plans:

  | Plan | after ded. before | after ded. now | plan pays |
  |---|---|---|---|
  | ES2P | $200 | **$300** | $100 |
  | ESZ9 | $240 | $240 | $160 |
  | ES1J | $200 | **$240** | $160 |
  | ES1A | $280 | $280 | $120 |
  | ES38 | $400 | $400 | $0 — never covers it |

- ES2P designated labs now shows its $40 copay after the deductible, where it previously
  showed $0.
- Live: five terms lines render per scenario, the plan-pays line appears on every covering
  plan, and the EPO row shows "Unavailable" with "Not covered — you owe the whole charge".
  No console errors.

---

## 2026-08-14 (5) — New-row highlight and text size control

### Decisions

**[DECISION: text size uses `webFrame.setZoomFactor`, not CSS]**
The obvious approach — `zoom` or a `transform: scale()` on `<body>` — breaks the modals. Both
create a new containing block for `position: fixed` descendants in Chromium, so `.modal-veil`
with `inset: 0` would stop covering the viewport. Real frame zoom is what Ctrl+/− uses, scales
layout correctly, and makes the responsive collapse to one column fall out for free at high
magnification: the effective viewport narrows and the existing 1080px media query does the rest.
*Alternative rejected:* converting every px to rem, a large refactor of `styles.css` for a worse
result (it would scale text but not spacing, borders or the slider track).

**[DECISION: `ui.setZoom` is the one bridge function that does not reach main]**
It calls `webFrame` directly from the preload. Frame zoom is a property of *this* frame, so a
round trip through main would buy nothing. It stays a named, single-purpose, logic-free
passthrough, so the allow-list invariant holds — everything actually privileged still goes to
main. Recorded in ARCHITECTURE §3 and DATA-FLOW §5 because it is a real, if narrow, exception.

**[DECISION: discrete steps, not a continuous range]**
`0.8 · 0.9 · 1.0 · 1.1 · 1.25 · 1.4 · 1.6 · 1.8 · 2.0`. Each arrow press lands somewhere
predictable, the arrows disable at the ends rather than silently doing nothing, and a stored
odd value snaps to the nearest step rather than being rejected.

**[DECISION: the preference persists in `settings.json`, not the workspace]**
Text size is an app setting like the model name, not part of a comparison. Putting it in the
workspace would have exported a personal display preference alongside plan data and lost it
whenever the autosave was cleared. Debounced 400ms so holding an arrow does not write the file
once per press.

**[DECISION: the new-row haze clears on `focusin` as well as `click`]**
The request was "until the user clicks on it". Reaching the row by keyboard is equally an
acknowledgement, and without `focusin` a keyboard-only user would have a permanently glowing
row they could never dismiss.

**[DECISION: newness is session-only state, held outside the scenario object]**
A `Set` of ids on `state`, not a field on the scenario. A row is new to the person who just
added it, not to the file — so it is never autosaved, never exported, and never comes back on
restore. It does survive a re-render (changing the row's service rebuilds every row), which the
`Set` gives for free and a DOM-only flag would not.

**[DECISION: haze only, no "New" badge]**
The request specified a visual marker. A text badge would add a second thing to dismiss and
compete with the availability labels already living in that row.

### Verification

- 37/37 tests still pass (unchanged — both features are renderer/shell concerns with no engine
  surface).
- Live: text size steps 100% → 140% with the frame zoom actually applied (`getZoom() === 1.4`),
  clamps at 200% and 80% with the corresponding arrow disabled, and **survives a restart** —
  `settings.json` holds `"textScale": 1.25` and the relaunched window comes up at 125%.
- Live: adding a row produces exactly one hazed row, it is the last row, the animation is
  running, it **survives a re-render** triggered by changing the row's service, and clicking it
  clears the haze. No console errors.
- Reduced motion: the pulse is replaced by a held static glow, so the marker still reads.

---

## 2026-08-14 (4) — Ranking confirmation and researched slider ceilings

User asked whether the cheapest plan always rises to the top, and for the primary-care slider
ceiling to be twice the most expensive real PCP bill.

### Findings

**Cheapest-first was already guaranteed — no change needed.** `compare()` ends with
`results.slice().sort((a, b) => a.totalAnnual - b.totalAnnual)` and runs on every recompute, so
the order is re-derived from scratch on each keystroke and slider tick. Confirmed live: dragging
the primary-care charge to its new ceiling moved ES1J past ES38 into first place, and the
"Cheapest" badge moved with it. Test I2 now pins this across five very different years, and
asserts the winner genuinely changes between them so the sort is doing real work.

### Decisions

**[DECISION: primary-care slider ceiling set to $5,000, from constructed evidence]**
There is no published "most expensive primary care visit" — no registry records one — so the
bound is composed from published components rather than quoted: CPT 99205 Medicare office rate
$236.81 × the ~10× charge-to-cost ratio of the fifty highest-markup US hospitals (Bai &
Anderson, *Health Affairs*) ≈ $2,368, plus a high-end hospital facility fee of ~$500 (documented
routine-visit examples of $488 and $503) ≈ **$2,500 realistic worst case**, doubled to $5,000 as
requested. Full derivation and sources in COST-MODEL §2.8.

**[DECISION: raise the neighbouring office ceilings too, to keep the set coherent]**
Only primary care was researched. But a specialist visit always bills at least as much as a PCP
visit, so leaving `specialist` at $1,600 under a $5,000 `pcp` would be visibly wrong the moment
anyone dragged both. Scaled: `specialist` 1600→6000, `preventive` 1500→3000, `mhOutpatient`
900→3000, `urgentCare` 1400→3000, `rehab` 800→2000. Test P pins the ordering rule and that every
seeded default stays inside its own ceiling. *Alternative rejected:* changing only `pcp`, which
satisfies the literal request while making the app incoherent.

**[DECISION: flag the ranking as provisional when a premium is missing]**
A plan with no premium entered is ranked on care costs alone, so it floats to the top on an
incomplete figure and can wear the "Cheapest" badge without having earned it. Rather than
changing the sort — the user asked for cheapest-first and should get exactly that — the totals
column now carries a line naming how many plans are incomplete and warning that they sit higher
than they should. It disappears the moment every premium is filled in. *Alternatives rejected:*
sorting incomplete plans to the bottom (contradicts the request, and is surprising before any
premium is typed), and withholding the badge (leaves the ranking silently wrong).

### Assumptions

**[ASSUMPTION: the non-PCP office ceilings are scaled, not researched]**
`specialist`, `preventive`, `mhOutpatient`, `urgentCare` and `rehab` were set to preserve the
ordering rule, not derived from sources. If any of them matters, it deserves the same treatment
as §2.8. The facility ceilings (inpatient, outpatient, imaging, ER) were untouched.

**[ASSUMPTION: $5,000 is a plausibility bound, not a maximum]**
Chargemasters have no ceiling. $5,000 is the point past which a primary-care figure stops being
a bill someone plausibly received; it is not a claim that no larger bill exists.

### Verification

- 37/37 tests pass (3 new: I2, I3, P).
- Live: the provisional banner reads "5 of 5 plans are missing a monthly premium" on a fresh
  start and disappears once premiums are entered; the PCP slider reaches exactly $5,000 at full
  travel; dragging it re-sorts the totals column and moves the "Cheapest" badge; totals remain
  ascending; no console errors.

---

## 2026-08-14 (3) — Availability labels

User request: *"If one plan can't do it but another plan does, show text that says Unavailable
or Not stated."*

### Decisions

**[DECISION: availability lives in the engine, not the renderer]**
`benefitAvailability(plan, benefitKey, tier)` is exported from `engine.mjs` and every ledger
line carries its result. Putting it in the renderer would have been quicker and would have
broken the invariant that nothing the user sees is derived outside the engine — "can this plan
do this" is a fact about the plan, not a display concern. It is also now testable without a DOM.

**[DECISION: four states, not two]**
`covered | unavailable | notStated | fallback`. The user named two labels; the domain has four
distinguishable situations and collapsing them would lose real information:
- `unavailable` splits by cause in its *wording* — "Unavailable" when the plan has no
  out-of-network coverage at all, "Not covered" when it covers the tier but not this service.
  Same status, different sentence, because they are different facts about the plan.
- `notStated` is for AI-extracted plans whose source document was silent. **It outranks
  `notCovered`**: a default the app invented must never be shown as though the plan stated it.
  Test M pins this precedence.
- `fallback` is a near-miss, not a refusal — a Designated tier was asked for and the plan
  defines none, so it is priced in network. Still covered, so it keeps its figures and gets a
  quiet "no desig." marker rather than being blanked out.

**[DECISION: judge availability on the service asked for, before the ER→inpatient swap]**
An admitted ER visit is priced on inpatient terms, but the row still says "Emergency room". If
availability were computed after the swap, a plan could report on a service the user never
selected. Test O pins it.

**[DECISION: the contrast line only appears when plans actually disagree]**
`0 < blocked < total`. If every plan covers something, there is nothing to compare; if none do,
the per-row labels already say so and a summary would be noise. This is the literal reading of
the request — *one plan can't but another does* — and it keeps the middle column quiet in the
common case.

**[DECISION: the word replaces the figures, spanning all three columns]**
Rather than showing the billed charge with a warning colour. The three-state readout answers
"what does one visit cost", and for an uncovered service the honest answer is not a number in
that frame — the charge is already displayed directly above in the scenario row.

### Assumptions

**[ASSUMPTION: `unread` entries are benefit keys]**
`benefitAvailability` matches `plan.unread.includes(benefitKey)`. The extraction prompt asks for
field names, which for benefits are the keys — but a model could return `"imaging copay"` or
`"deductible"` instead. Non-matching entries degrade silently to no label, and are still listed
in full on the plan card, so nothing is lost; the per-benefit label just does not appear.
Worth revisiting once real extractions have been observed.

### Verification

- 34/34 tests pass (5 new: L, L2, M, N, O).
- Driven live: a specialist visit switched to out-of-network shows "Unavailable" on ES38 while
  the other four show figures, with the contrast line *"1 of 5 plans do not cover this at this
  tier — you would owe the whole charge, with nothing counting toward any limit."*
- Designated labs shows no fallback markers (all five plans define a designated lab benefit),
  and the Designated tier button stays disabled for `pcp`, where no plan defines one.

---

## 2026-08-14 (2) — Application built

Engine and tests first, green before any UI, per the build prompt's working order. 29 tests
pass. The app launches, renders, autosaves and restores; verified by driving the real window
(sliders, ranking flips, ledger, responsive collapse) rather than by inspection.

### Decisions

**[DECISION: `NSA_PROTECTED` contains `er` only]**
Emergency services are protected wherever delivered, so `er` is unconditional and safe. The
ancillary set (anaesthesia, pathology, radiology, labs, neonatology, assistant surgeon,
hospitalist, intensivist) is protected *only at an in-network facility* — a condition a
scenario's single `tier` field cannot express. Leaving them balance-billable reports the worse
case, which is the safe direction to be wrong in: the app never assumes a protection it cannot
verify. *Alternative rejected:* marking them protected unconditionally, which would understate
real exposure. Closing the gap needs a per-scenario facility-network flag. COST-MODEL §4.1.

**[DECISION: protection is forced during normalization, not merely defaulted]**
`normalizePlan` overwrites `balanceBillable` on protected benefits after merging user input, so
neither a hand edit nor an AI extraction can switch off a legal protection. The No Surprises Act
is not a plan option.

**[DECISION: `plans.mjs` owns validation; `engine.mjs` owns arithmetic]**
`validatePlan` returns `[{level, message}]` and never throws or blocks. Keeping it out of the
engine preserves the engine's purity and keeps regulatory limits — which change annually — in
one file next to `LIMITS_2026`.

**[DECISION: the OOP "rewind" is achieved by construction, not by a correction step]**
The forgiveness loop mutates `line.deductible` in place, and accumulators are credited from the
post-forgiveness value. The member is therefore only ever credited with money actually paid, and
there is no second bookkeeping step to get wrong — which is exactly how the prototype's bug
arose. Test D pins it.

**[DECISION: `familyDeductibleMode` gates only `deductibleRoom`]**
`oopRoom` takes `min(individual, family)` unconditionally on every plan. This is the §4.4
correction expressed as code: there is no branch that could make the individual maximum
non-embedded. Test C proves it on an aggregate plan.

**[DECISION: an EPO's out-of-network claims fall back to the in-network accumulators]**
When `plan.tiers.out === null` there is nowhere else for a covered out-of-network claim to
land. Combined with NSA routing this makes ES38 — no out-of-network tier, but ER and ambulance
covered out of network — computable. Test A2.

**[DECISION: `rxSpecialty` carries the specialty Tier 2 copay ($150)]**
The documents price specialty drugs in three tiers; the agreed 25-key benefit set has one
specialty key. Tier 2 is the representative middle. Recorded as a limitation rather than
silently averaged.

**[DECISION: ES1J childbirth modelled on that plan's inpatient pattern]**
The source summary omits childbirth for ES1J alone. Modelled 0% in network / 20% out, matching
its inpatient and outpatient facility lines, and stated in the plan's `notes` so it is visible
in the app rather than only here.

### Bugs found and fixed during verification

**Startup was fragile.** An unhandled rejection from `workspace.restore()` aborted `start()`
before `renderAll()`, leaving a blank window. Found by running the app against a main process
with no IPC handlers registered. Now wrapped: a failed restore costs the autosave, never the
interface.

**Cards were silently clipped.** The three scrolling columns are `display:flex;
flex-direction:column`, so cards inherited `flex-shrink:1` and were squeezed below their content
height; `overflow:hidden` on the card then clipped the remainder. The first result card measured
156px tall while its children totalled 333px — the breakdown table, plain-language line, worst
case and ledger button were all present in the DOM and invisible. Fixed with `flex: 0 0 auto` on
the lists' direct children. *This is why measuring beat looking:* the DOM probe said everything
was there, and it was — just not on screen.

**`hidden` did not hide.** `.premium-warning { display: flex }` and `.import-status
{ display: grid }` are class selectors, which outrank the user-agent's `[hidden] {display:none}`,
so anything hidden via `el.hidden = true` stayed visible. Fixed globally with
`[hidden] { display: none !important; }`.

**Validation warnings went stale.** `recompute()` deliberately does not re-render plan cards —
doing so would collapse the open disclosure and steal focus mid-typing — so the validation box
kept its first-render contents. Now refreshed in place via `planWarnRefs`, verified to update
live while leaving the disclosure open.

**`node --test test/` fails on Node 24**, which resolves a bare directory as a module. Script is
`node --test "test/*.test.mjs"`.

### Verification performed

- 29/29 tests pass.
- Hand sanity-check across three years: healthy → copay plans win (copays skip the deductible);
  moderate → ES1A wins on its $250 deductible; serious → ES2P wins on its $3,000 maximum. All
  explainable.
- **ES1A/ES38 crossover confirmed between $40k and $60k billed** and reachable by dragging one
  slider, exactly as the build prompt predicted. ES38 flattens at its $3,400 deductible because
  its coinsurance is 0%; ES1A keeps climbing at 10% until its maximum.
- Live app driven: sliders move totals, a catastrophic year flips ES1A from #1 to #4, ledger
  populates (33 rows), narrow window collapses to one column with no horizontal scroll, zero
  console errors, `window.desktop` exposes no key accessor.
- Copay plans correctly do **not** respond to a changing specialist charge — a flat copay is
  insensitive to the billed amount. This is the product's central insight rendering correctly.
- `npm audit --omit=dev` → 0 vulnerabilities. The 14 reported findings are entirely in
  `electron-builder`'s dev tree.

### Not done

- `npm run dist:win` / `dist:mac` were **not executed**. The electron-builder config is written
  but producing installers downloads platform toolchains and takes several minutes; unverified.
- No macOS testing. Developed and verified on Windows 11.
- The AI PDF import path is **untested against a live API** — no key was available. The code
  path, error handling and prompt are written; the round trip is unproven.

---

## 2026-08-14 — Research, prompt validation, documentation foundation

### Decisions

**[DECISION: the No Surprises Act overrides the build prompt's balance-billing model]**
The prompt applies balance billing to any out-of-network claim via a per-plan boolean. Federal
law has prohibited balance billing for emergency services, out-of-network providers at
in-network facilities, and air ambulance since 2022-01-01. Making `balanceBillable` a
per-benefit property instead of a per-plan flag is the smallest change that makes the model
lawful. Recorded in COST-MODEL §4.1. *Also solves an otherwise unanswerable question:* plan 5
(ES38, EPO) has no out-of-network accumulators at all but covers ER out of network — protected
claims route to the in-network accumulators, which gives those dollars somewhere to land.

**[DECISION: split OOP-max embedding from `familyDeductibleMode`]**
The prompt carries one mode field. Since the 2016 plan year every non-grandfathered plan must
embed the individual out-of-pocket maximum in family coverage regardless of deductible
structure, so ES2P is aggregate-deductible *and* embedded-OOP-max simultaneously — a state one
field cannot represent. `familyDeductibleMode` now governs the deductible only. COST-MODEL §4.4.

**[DECISION: keep `copaysCountToOOP` as a flag despite it being mandatory in network]**
For in-network essential health benefits it is not legally optional. Kept anyway because it is
needed for grandfathered plans, excepted benefits, and out-of-network cost sharing where the
rule does not bind — but it defaults `true`, is `true` on all five seed plans, and setting it
`false` raises a validation warning. *Alternative rejected:* removing it entirely, which would
have made the engine unable to model a legitimate class of plan. COST-MODEL §4.3.

**[DECISION: write docs before code]**
The user's instruction, and the right call independently: the build prompt contains factual
errors that would have been expensive to unwind after the engine was written around them.
Validating the domain first surfaced four material corrections at zero refactoring cost.

**[DECISION: docs live in `docs/`, enforced by `/CLAUDE.md`]**
A documentation-maintenance rule in the project's root `CLAUDE.md`, with an explicit
change→document routing table, rather than relying on a convention. See §"Documentation
contract" in ARCHITECTURE.md.

**[DECISION: accept round-robin interleaving as specified, with a recorded reservation]**
The prompt requires round-robin. It is right that batching is wrong, but round-robin makes
results sensitive to the order scenario rows happen to be listed in — which the user can change
without meaning anything by it. A chronological model (spread each scenario's visits across
twelve months, sort by date) is order-independent and costs nothing extra. Building as
specified; revisit if results ever look order-sensitive. COST-MODEL §4.7.

**[DECISION: `.mjs` for shared logic rather than `"type": "module"`]**
Setting `"type": "module"` in `package.json` would break `main.js` and `preload.js`, which must
be CommonJS for Electron. Explicit `.mjs` extensions are unambiguous to Node, loadable by the
browser via `<script type="module">`, and require no bundler. One file, two runtimes, zero
tooling. ARCHITECTURE.md §3.

### Assumptions

**[ASSUMPTION: the 2026 regulatory figures are the operative ones]**
Seed-plan coverage period is 06/01/26 – 05/31/27, so 2026 limits apply: ACA OOP cap
$10,600/$21,200; HDHP minimum deductible $1,700/$3,400; HDHP maximum OOP $8,500/$17,000. Note
HHS *revised* the ACA figures upward from $10,150/$20,300 published under superseded
methodology — the revised numbers are used. Re-verify if the plan year changes.

**[ASSUMPTION: the five seed plans' figures are transcribed correctly from the SBCs]**
Not independently verifiable without the source PDFs. Every figure was checked for *internal*
consistency and against regulatory bounds and all five pass — including the non-obvious HSA
embedded-deductible rule, which both HSA plans satisfy in different ways. That is meaningful
evidence the transcription is careful, but it is not verification.

**[ASSUMPTION: the household is a single family unit under one policy at a time]**
Every scenario is assigned to a member, and members roll up to one family accumulator per plan.
Split-family situations (two policies covering overlapping members) are out of scope.

**[ASSUMPTION: `designated` tier applies only to labs and imaging]**
Matches UnitedHealthcare's actual Designated Diagnostic Provider program scope. The data model
allows a designated benefit on any key; the UI should only offer the tier where a plan defines
one.

### Findings carried forward

**Prototype bug — deductible rewind over-corrects.** `src/engine.mjs` in `plan-ledger.zip`
computes `dedForgiven` from the full excess *before* the forgiveness loop runs, then rewinds the
deductible accumulator by that amount even when the loop actually forgave coinsurance and never
touched the deductible. Produces a deductible that under-reports. Must not be carried into the
new engine. COST-MODEL §4.6.

**Prototype contains two incompatible generations.** The zip ships both a UMD `.js` engine (wired
to the renderer, 31 tests passing) and an ESM `.mjs` engine (orphaned, different data model:
`inNetwork`/`outOfNetwork` vs `network.in/out`, `mode` vs `type`, different service keys).
Neither matches the target architecture — the `.mjs` pair is closer in shape but has no
household, no tiers, and no family accumulators. Treat the prototype as reference, not as a
starting point to extend.

### Open questions for the user

Raised, not blocking. Recorded in COST-MODEL §5.

1. **Are the ER benefits in or out of network in practice?** Under the NSA the distinction
   largely collapses for emergency care — determines whether the §4.1 correction changes a real
   number or is purely defensive.
2. **Which state?** Ground-ambulance balance-billing protection is state-level and several
   states have closed the federal gap. If yours has, the §4.2 warning softens.
3. **Is anyone on an HSA?** If so the app should model the tax treatment, which meaningfully
   favors the two HDHP plans. Currently a deliberate omission.

### Next steps

1. Answer the three open questions above (or explicitly defer them).
2. Build `src/engine.mjs` + `src/plans.mjs` against COST-MODEL.md.
3. Get all 17 specified tests green, plus new tests for the §4.1 and §4.4 corrections.
4. Hand-run the five seed plans against a moderate year; confirm the ES1A ($250 deductible /
   10% coinsurance) vs. ES38 ($3,400 deductible / 0% coinsurance) crossover is findable by
   dragging a slider.
5. Only then: the renderer.
