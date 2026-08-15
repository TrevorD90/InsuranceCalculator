# Architecture — Plan Ledger

**Status:** implemented. Written before the code, deliberately, so the build had something to be
checked against; updated 2026-08-14 to match what was built. Divergences from the original
target are marked **[as-built]**.

**Companion documents:** [`COST-MODEL.md`](COST-MODEL.md) (what the math must do and why),
[`DATA-FLOW.md`](DATA-FLOW.md) (how data moves), [`DECISIONS.md`](DECISIONS.md) (choices and
assumptions on the record).

---

## 1. What this application is

A cross-platform Electron desktop app that compares health insurance plans by simulating a
full year of care against each one, in sequence, and reporting which costs least.

The organizing principle: **the math is the product; the interface is a window onto it.** The
cost engine is pure, has no DOM and no I/O, and is built and tested to green before any UI
exists. Everything else in this document exists to keep that boundary intact.

---

## 2. Process model

Electron gives us two processes with very different privileges. The security posture is the
reason for most of the structural choices below.

```
┌─────────────────────────── main process (Node, CommonJS) ───────────────────────────┐
│  main.js                                                                             │
│    • BrowserWindow lifecycle                                                         │
│    • settings persistence + safeStorage encryption of the API key                    │
│    • ALL Anthropic API calls                                                         │
│    • native file dialogs, PDF reads, workspace import/export                         │
│  Holds: the API key, filesystem access, network access                               │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │  contextBridge — the ONLY channel
                                       │  preload.js (CommonJS, contextIsolation: true)
┌──────────────────────────────────────┴───────────────────────────────────────────────┐
│                        renderer process (Chromium, ES modules)                        │
│  renderer/app.js  ──imports──▶  src/engine.mjs, src/plans.mjs                        │
│    • all rendering and interaction                                                    │
│    • runs the cost engine synchronously on every input change                        │
│  Holds: nothing privileged. No key, no fs, no direct network.                        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Invariants — violating any of these is a defect, not a style preference:**

1. `contextIsolation: true`, `nodeIntegration: false`. Not negotiable.
2. The renderer never sees the API key. Not once, not transiently, not for a "test connection".
3. The renderer never calls `api.anthropic.com`. All calls originate in main — which also
   removes CORS from the problem space entirely.
4. The preload surface is an explicit allow-list of named functions. No generic `invoke(channel, …)`
   passthrough, because that is just `nodeIntegration` with extra steps.
5. `src/*.mjs` imports nothing from `electron` and touches no browser or Node global. That is
   what lets `node --test` and the browser both load the same file.

---

## 3. Module layout

```
main.js                  Electron main: window, settings, Claude calls, file dialogs   [CJS]
preload.js               contextBridge surface — the narrow bridge                     [CJS]
src/
  engine.mjs             the cost engine — pure functions, no DOM, no I/O              [ESM]
  plans.mjs              schema, normalizer, validator, the five seed plans            [ESM]
renderer/
  index.html             app shell, three-column layout
  styles.css             design tokens + component styles
  app.js                 state, controls, rendering                                    [ESM]
test/
  engine.test.mjs        node --test, 40 assertions                                    [ESM]
docs/                    this folder — see §8
README.md
```

**[as-built]** 40 assertions, not 17: the 17 named in the build prompt plus 23 covering the
COST-MODEL §4 corrections, availability and plain-words terms (§2.7), slider ceilings (§2.8),
seed-plan validation, cheapest-first ranking, the three-state monotonicity invariant, and the
ES1A/ES38 crossover. The `test` script is `node --test "test/*.test.mjs"` — passing a bare
directory makes Node 24 try to resolve it as a module and fail.

### Why the `.mjs` / `.js` split

Node needs an unambiguous module type per file and the project has no bundler and no build
step. Rather than set `"type": "module"` in `package.json` (which would break `main.js` and
`preload.js`, both of which must be CommonJS for Electron), shared logic is explicitly named
`.mjs`. That extension is ESM to Node regardless of `package.json`, and the browser loads it
happily via `<script type="module">`. One file, two runtimes, zero tooling.

### Responsibility boundaries

| Module | Owns | Must never |
|---|---|---|
| `src/engine.mjs` | Pricing one claim; simulating a year; accumulator arithmetic; comparison and ranking; **availability** (`benefitAvailability`) and **plain-words terms** (`describeBenefit`) | Import electron, touch the DOM, read files, know what a plan *card* is |
| `src/plans.mjs` | Plan/scenario/household shapes, normalization of partial or AI-extracted input, regulatory validation, seed data | Perform pricing arithmetic |
| `renderer/app.js` | Application state, event wiring, DOM rendering, formatting | Contain a single line of cost-sharing math |
| `main.js` | Privilege: key storage, network, filesystem, dialogs | Contain business logic or pricing math |
| `preload.js` | Naming the bridge functions | Contain logic of any kind |

**[as-built] One bridge function does not reach main.** `desktop.ui.setZoom` / `getZoom` call
`webFrame` directly from the preload, because frame zoom is a property of *this* frame and
round-tripping through the main process would buy nothing. It is still a named, single-purpose
passthrough with no logic in it, so the allow-list invariant holds. Everything privileged —
the key, the filesystem, the network — still goes to main.

The rule that keeps this honest: **if a number the user sees was computed anywhere other than
`engine.mjs`, that is a bug.** `app.js` may format numbers. It may not derive them.

---

## 4. Data model

### 4.1 Benefit

The atom of the model. One service, one tier.

```js
{ mode: "copay",       copay: 30,          deductibleFirst: false, balanceBillable: true }
{ mode: "coinsurance", coinsurance: 0.2,   deductibleFirst: true,  balanceBillable: true }
{ mode: "noCharge" }
{ mode: "notCovered" }        // full billed charge to the member, accrues nothing anywhere
```

- `coinsurance` is always the **member's** share. "Plan pays 80%" is `0.2`.
- `deductibleFirst` is per benefit **per tier** — never a plan-level flag. See COST-MODEL §2.1.
- `balanceBillable` is per benefit, and is the correction described in COST-MODEL §4.1. It is
  `false` for `er` and for out-of-network providers at in-network facilities, because the
  No Surprises Act forbids balance billing there.

### 4.2 Plan

```js
{
  id, name, carrier, color,
  monthlyPremium,                  // required manual entry; 0 is flagged as incomplete
  isHSA,                           // drives HDHP validation

  tiers: {
    designated: { … },             // optional; falls back to `in` when absent
    in:  { deductible: {individual, family}, oopMax: {individual, family} },
    out: { deductible: {individual, family}, oopMax: {individual, family} }  // null on EPO
  },

  familyDeductibleMode,            // "embedded" | "aggregate" — DEDUCTIBLE ONLY
                                   // the individual OOP max is always embedded (COST-MODEL §4.4)
  combinedAccumulators,            // do in/out share accumulators
  copaysCountToOOP,                // default true; mandatory in network (COST-MODEL §4.3)
  erCopayWaivedIfAdmitted,
  pharmacyDeductible,              // null when not separate

  negotiatedPct,                   // in-network allowed ÷ billed, default 0.55
  oonAllowedPct,                   // out-of-network allowed ÷ billed, default 0.50

  benefits: { [benefitKey]: { designated?, in, out } },
  source,                          // "seed" | "manual" | "ai"
  notes, unread                    // provenance for AI-extracted plans
}
```

**Benefit keys (25):** `preventive, pcp, specialist, mhOutpatient, mhInpatient, urgentCare, er,
ambulance, labs, xray, imaging, outpatientFacility, outpatientPhysician, inpatientFacility,
inpatientPhysician, rehab, dme, homeHealth, skilledNursing, childbirthProfessional,
childbirthFacility, rxTier1, rxTier2, rxTier3, rxSpecialty`.

### 4.3 Household and scenarios

```js
household: [ { id, label } ]                      // e.g. "Me", "Spouse", "Kid 1"

scenario: {
  id, benefitKey, label,
  memberId,                                        // every scenario belongs to a member
  billed,                                          // number field + slider beneath it
  tier,                                            // "designated" | "in" | "out"
  count,                                           // occurrences per year
  admitted                                         // ER only — triggers the copay waiver
}
```

Assigning every scenario to a member is what makes embedded-vs-aggregate computable. Without
it the family deductible question is unanswerable.

### 4.4 Accumulator state

Transient, rebuilt from scratch on every recompute. Never persisted.

```js
{
  family: { in: {deductible, oop}, out: {…} },
  members: { [memberId]: { in: {deductible, oop, pharmacyDeductible}, out: {…} } }
}
```

---

## 5. The computation pipeline

Pure, synchronous, and cheap enough to run on every slider tick — which is the entire point of
the slider.

```
household + scenarios + plans
        │
        ▼
  expandYear(scenarios)          →  ordered event list (round-robin interleave, COST-MODEL §4.7)
        │
        ▼
  for each plan:
    newAccumulators()
    for each event in order:
      applyEvent(plan, acc, event)  →  one ledger line, mutates acc
        │
        ▼
  simulatePlan(plan, scenarios)  →  per-plan totals + full per-visit ledger
        │
        ▼
  compare(plans, scenarios)      →  ranked, cheapest first, delta vs. cheapest
```

`applyEvent` is the single most important function in the codebase and the one every test in
`engine.test.mjs` ultimately exercises. Its order of operations is specified in COST-MODEL §2.1.

**Per-plan result shape:** premiums, deductible paid, coinsurance paid, copays paid, balance
billed, uncovered charges, total for the year, plan paid on the member's behalf, that figure
net of premiums, worst case (premiums + in-network OOP max), full per-visit ledger, and delta
against the cheapest plan in the set.

**Availability** is computed alongside pricing, not instead of it. `benefitAvailability(plan,
benefitKey, tier)` returns `{status, label, detail}` — `covered | unavailable | notStated |
fallback` — and every ledger line carries its own copy, judged on the service that was *asked
for* (so an ER visit that swaps to inpatient terms on admission still reports itself as an ER
visit). The renderer uses it to print words where a plan cannot do something, because the
number it would otherwise print is the full billed charge and reads like a price. See
COST-MODEL §2.7.

---

## 6. Interface architecture

Three columns under a dark top bar. Layout collapses to a single column on a narrow window.

**Top bar** carries, left to right: the app name, a **Text size** control (`←` / percentage /
`→`), the AI status pill, Import, Export, and the settings gear. Text size steps through
`0.8 · 0.9 · 1.0 · 1.1 · 1.25 · 1.4 · 1.6 · 1.8 · 2.0` via `webFrame.setZoomFactor`, clamping at
either end (the arrow disables), and persists in `settings.json` as `textScale`. Because it is
real frame zoom rather than a CSS transform, the responsive collapse to one column happens
naturally at high magnification — the effective viewport narrows, and the existing media query
does the rest.

| Column | Contents | Reads | Writes |
|---|---|---|---|
| **Left — Plans** | One card per plan (≥5 at once). Front: name, premium, deductible, OOP max. Expanded: toggles, OON limits, pricing assumptions, full benefit editor (row per service × designated/in/out) | `state.plans` | plan edits → recompute |
| **Middle — Year of care** | Row per scenario: billed amount + **slider beneath it**, member, tier selector, count, remove. ER row gets "admitted". Household manager at top. A just-added row wears a **blue haze** until clicked or focused. Beneath each row, the three-state readout per plan, each with its coverage terms in plain words and what the plan pays once the deductible is met — and **Unavailable / Not covered / Not stated** printed in place of figures for any plan that cannot deliver that care, plus a contrast line when the plans disagree | `state.scenarios`, `state.household` | scenario edits → recompute |
| **Right — Totals** | Card per plan, **always cheapest first** (re-sorted on every recompute), badged. Big total, delta, **accumulator rail**, breakdown table, plain-language line, worst case, collapsible ledger. A provisional-ranking line appears above the cards while any plan is missing a premium | `state.results` | nothing |

**The accumulator rail** is the signature element: one track from zero to the OOP max, the
deductible zone shaded at the left, a notch where the deductible ends, and a fill showing how
far the simulated year got. It is the three-state model from COST-MODEL §1 made visible.

### Visual direction

A claims ledger, not a SaaS dashboard.

| Token | Value | Use |
|---|---|---|
| Ink | `#0F1622` | near-black text |
| Paper | `#E9EDF2` | cool background |
| Rule | `#CDD6E2` | hairline borders |
| AI accent | `#7B4BD8` | **reserved exclusively for the AI status light** |
| Plan identity | `#2E6FD9` `#0E8A6E` `#8B4FC9` `#B4642A` `#C0392B` | categorical, per plan |

Monospace with tabular figures for anything the *plan or provider states as fact*; system sans
for anything the *app says to the user*. That distinction is load-bearing — it is how the user
tells a quoted figure from a computed one.

Accessibility: visible keyboard focus, `prefers-reduced-motion` respected, usable at one column.

---

## 7. Privileged operations

### 7.1 API key storage

Encrypted with Electron `safeStorage` (Keychain on macOS, DPAPI on Windows) before it touches
disk, in the app's userData directory. If the OS reports encryption unavailable, the key is
held **in memory for the session only** and the panel says so plainly, rather than a key
quietly landing in a file in the clear.

### 7.2 Claude connection

- `POST https://api.anthropic.com/v1/messages`, header `anthropic-version: 2023-06-01`
- Default model `claude-sonnet-5`, editable
- Called from **main only**
- Status light states: hollow (no key) → pulsing (in flight) → filled+glowing (connected) → red (error)

### 7.3 PDF plan import

Multi-select dialog → each file base64 as a `document` block → system prompt pinning the exact
JSON schema → parse reply, stripping markdown fences defensively → normalize → validate.

Cap files at 24 MB. Report per-file failures **without losing the successes**. After import,
tell the user to check the extracted figures against the source document, and mark every
AI-sourced plan visibly (purple "Read by AI" flag, listed unread fields).

The extraction prompt must instruct: individual figures not family; coinsurance as the
**member's** share; `deductibleFirst` true only when the document says the deductible applies;
capture the Designated tier **separately** from the regular network tier; set every
out-of-network benefit to `notCovered` when the plan has no out-of-network coverage.

**The app must be fully usable with no API key at all.** Every arithmetic feature works offline.
The only thing that needs Claude is reading a PDF.

### 7.4 Persistence

Autosave continuously. Export writes plans + year + computed results to JSON; import reads it
back. Workspace files are plain JSON and contain no secrets.

---

## 8. Documentation contract

`docs/` is part of the build, not a description of it.

| File | Holds |
|---|---|
| `ARCHITECTURE.md` | this file — structure, boundaries, data model, invariants |
| `COST-MODEL.md` | domain reference, regulatory constraints, build-prompt corrections |
| `DATA-FLOW.md` | process/IPC flow, computation pipeline, accumulator hierarchy diagrams |
| `DECISIONS.md` | `[DECISION]` / `[ASSUMPTION]` log, newest first |

**These documents are updated in the same change as the code they describe.** The enforcing
rule, including exactly what triggers an update, lives in `/CLAUDE.md` at the project root.

---

## 9. Build and packaging

```
npm install && npm start     must work on a clean machine, no build step
npm test                     node --test, no framework dependency
npm run dist:win             electron-builder → nsis + portable
npm run dist:mac             electron-builder → dmg + zip
```

## 10. Known limitations carried deliberately

Recorded here so they are chosen rather than discovered. User-facing phrasing in README.

- **No HSA/FSA tax treatment.** Materially favors the HDHP plans; the comparison understates
  their advantage. Highest-value next addition.
- **Deterministic, not probabilistic.** Prices the year you describe, not a distribution over
  possible years. A good/typical/bad-year model would be the more honest tool.
- **Tiered networks flattened to three tiers.** Real plans occasionally have more.
- **No employer premium contribution field.** The user enters their own share.
- **Round-robin interleaving is order-sensitive** — see COST-MODEL §4.7.
- **[as-built] Ancillary-provider NSA protection is not modelled.** `NSA_PROTECTED` contains
  `er` only. The Act also protects out-of-network anaesthesia, pathology, radiology, laboratory,
  neonatology, assistant-surgeon, hospitalist and intensivist services *when delivered at an
  in-network facility* — a condition a scenario's single `tier` field cannot express. Those
  benefits stay balance-billable, so the app reports the worse case rather than silently
  assuming protection it cannot verify. Resolving this needs a per-scenario "facility was in
  network" flag.
- **[as-built] Air vs. ground ambulance is not distinguished.** Air ambulance is NSA-protected;
  ground is not. The single `ambulance` key is treated as ground — the common and riskier case.
- **[as-built] No Tier 4 drug benefit key.** The 25 keys cover retail tiers 1–3 plus specialty.
  Tier 4 is Not Covered on all five seed plans; model it by setting a row to Not Covered.
- **[as-built] `rxSpecialty` carries the specialty Tier 2 copay.** The source documents price
  specialty drugs in three tiers ($10 / $150 / $500 on most plans); one key cannot hold three.
- **[as-built] ES1J childbirth benefits were not stated** in the source summary and are modelled
  on that plan's inpatient pattern (0% in network, 20% out). Noted on the plan card.
