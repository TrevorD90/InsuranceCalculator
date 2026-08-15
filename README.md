# Plan Ledger

A desktop app for comparing health insurance plans by simulating an actual year of care against
each one, rather than staring at five columns of deductibles and guessing.

Electron. No bundler, no build step. Runs on Windows and macOS.

## Running it

```
npm install
npm start        # launch the app
npm test         # run the cost-engine tests — 40 assertions, no framework
```

Installers:

```
npm run dist:win    # nsis installer + portable .exe
npm run dist:mac    # .dmg + .zip
```

Build on the platform you are targeting, or set up cross-building separately.

## What it does

**Left — plans.** One card per plan, five preloaded. The front shows name, monthly premium,
deductible and out-of-pocket maximum. "Coverage detail" opens the plan's toggles (family
deductible mode, combined accumulators, copays toward the maximum, ER copay waiver, separate
pharmacy deductible, balance billing), the out-of-network limits, the two pricing assumptions,
and a benefit editor with a row per service and columns for designated / in network / out of
network — each with a mode, a value and a "subject to deductible" checkbox.

**Middle — your year of care.** A row per kind of care: what the provider charges, with a
slider directly beneath it, plus which household member, a tier selector, how many times a
year, and remove. The emergency row gets an "admitted" checkbox. A row you have just added
glows with a blue haze until you click it, so it is findable in a long list. Under each row,
what a single visit costs on every plan in the three states that matter — before the
deductible, after it, and after the out-of-pocket maximum.

**Right — totals.** One card per plan, **always cheapest first** — the order is re-derived on
every keystroke and slider tick, so whichever plan is currently winning rises to the top and
takes the badge with it. While any plan is still missing a premium, a line above the cards says
the ranking is provisional, because a plan with no premium is being ranked on care costs alone
and sits higher than it should. Big total, delta against the cheapest,
then the **accumulator rail**: a single track from zero to the out-of-pocket maximum with the
deductible zone shaded, a notch where the deductible ends, and a fill showing how far this
simulated year got. Below it the breakdown, a plain-language line, the worst case, and the
per-visit ledger.

**Top bar.** A **Text size** control with `←` and `→` steps the whole window between 80% and
200%, and remembers where you left it. It is real frame zoom, so everything scales together —
at high magnification the layout folds down to a single column on its own.

Everything autosaves. Export writes plans, the year and the computed results to JSON; import
reads it back. Your text size is an app preference, not part of a comparison, so it stays out
of exported files.

## How the math works

The engine (`src/engine.mjs`) is pure — no DOM, no I/O — so `node --test` and the browser load
the same file. The rules it implements are specified with citations in
[`docs/COST-MODEL.md`](docs/COST-MODEL.md), which is authoritative: if the code disagrees with
that document, the code is wrong.

Things it models that simpler calculators skip:

- **Billed is not the basis for cost sharing.** Coinsurance and copays run on the plan's
  *allowed amount* — the negotiated rate in network, the plan's allowed amount out of network.
  Each plan carries editable assumptions for both.
- **Balance billing is tracked separately and never capped.** Out of network the provider never
  agreed to the allowed amount and may pursue you for the difference. By statute that money
  counts toward neither the deductible nor the out-of-pocket maximum, so nothing limits it.
  Same for non-covered services. Both are reported on their own flagged rows.
- **The year runs in sequence.** Deductible and out-of-pocket accumulate across visits, and
  repeat visits are interleaved round-robin rather than batched — twelve prescription fills
  before any other care draws the deductible down in an order no real year has.
- **Three provider tiers.** `designated` → `in` → `out`, with designated falling back to in
  network where a plan defines none. This is real: UnitedHealthcare's Designated Diagnostic
  Provider program prices labs and major imaging far lower, and on these plans it is the single
  biggest swing in the documents — network imaging at 50% coinsurance versus designated at 0%.
- **Whether the deductible applies is per benefit, per tier.** Not a global flag. On the HSA
  plans every copay sits behind the deductible; on the others the SBC says "deductible does not
  apply" next to most of them.
- **Family deductibles, embedded and aggregate.** Every scenario belongs to a household member,
  and individual accumulators roll up into family ones. Embedded: a member meeting their own
  deductible starts the plan paying for them. Aggregate: nobody is covered until the whole
  family deductible is met.
- **Emergency copay waived on admission**, priced as an inpatient stay instead.
- **Separate pharmacy deductible**, which does not consume the medical one.
- **A plan that can't do something says so in words.** Where one plan covers care and another
  cannot, the one that cannot shows **Unavailable** (no out-of-network coverage at all),
  **Not covered** (covered tier, uncovered service), or **Not stated** (read from a PDF that
  did not say) instead of a figure — with a line telling you how many plans are affected.
  This matters because a plan that cannot cover something still produces a number, the whole
  billed charge, and that number sitting beside another plan's $40 copay reads like a price
  rather than like being on your own with nothing capping it.
- **Every plan states its terms, both ways round.** Under each set of figures: *"You pay 40%,
  plan pays 60% · after the deductible · plus balance billing, which nothing caps"*, and what
  the plan pays in dollars for that visit once the deductible is met. Coinsurance is given from
  both sides deliberately — the member-share convention is the most misread number in a plan
  document. It is also the only thing that separates "covered, but you are still in your
  deductible" from "not covered at all": out of network, before the deductible, both cost you
  the entire billed charge.

### Two corrections to how these tools usually work

Both are law, both change the number, and both are covered by tests:

- **Emergency care cannot be balance billed.** Under the No Surprises Act, emergency services —
  and out-of-network providers at in-network facilities, and air ambulance — cannot balance
  bill. Cost sharing is computed at the in-network rate and credited to the **in-network**
  accumulators. Modelling an out-of-network ER visit with a balance bill inflates the scariest
  line in the app by an amount you would never actually owe. Balance-billability is therefore a
  property of the benefit, not the plan.
- **The individual out-of-pocket maximum is always embedded.** Since the 2016 plan year every
  non-grandfathered plan must embed it in family coverage, regardless of how the deductible is
  structured. So a plan can have an aggregate deductible and an embedded maximum at the same
  time — one of the five does.

Ground ambulance is the exception that proves the first rule: Congress deliberately left it out
of the No Surprises Act, so it remains balance-billable, and it is where the real exposure sits.

### Plan validation

Plans are checked against the 2026 regulatory bounds — the ACA out-of-pocket cap, and for
HSA-marked plans the HDHP minimum deductible, maximum out-of-pocket, and the rule that an
embedded individual deductible must be at least the family minimum. Warnings appear on the card
and never block you. This mostly exists to catch PDF-extraction errors, which otherwise produce
a confidently wrong comparison with no signal at all.

## Premiums

None of the source documents contain the premium — SBCs say it is "provided separately." So the
monthly premium is a required manual entry on every plan card, and a plan with $0 in that field
is flagged in both columns until you fill it in. The comparison is meaningless without it.

## The Claude connection

Reading a plan PDF is the one feature that needs Claude. SBCs are standardised in layout but not
in wording, so pattern matching breaks constantly; a model reading the document and returning
structured JSON is far more reliable.

Open Settings, paste a key from https://console.anthropic.com, pick a model, press **Test
connection**. The dot beside **AI** in the top bar is hollow when no key is saved, filled and
glowing when connected, pulsing while a request is in flight, red on error. "Read plan
documents" stays disabled until it is green.

**Everything else runs offline.** All the arithmetic, all the comparison. Plan PDFs are sent only
when you press the import button.

Anything extracted is marked: a purple "Read by AI" flag, a purple hairline under the name
field, and a list of any fields the model could not find. Check the figures against the PDF
before trusting them — extraction is good, not infallible.

### Key storage

The key is encrypted with the OS keychain (Keychain on macOS, DPAPI on Windows) before it is
written to disk. If the OS reports encryption unavailable, the key is held in memory for the
session only and the panel says so, rather than a key quietly landing in a file in the clear.

The renderer process never sees the key. `settings:load` returns a masked hint and a boolean,
never the value; every API call happens in the main process. The preload bridge is an explicit
allow-list of named functions, with `contextIsolation: true` and `nodeIntegration: false`.

## Documentation

`docs/` is part of the build and is updated in the same change as the code.

| | |
|---|---|
| [`docs/COST-MODEL.md`](docs/COST-MODEL.md) | Domain reference, regulatory constraints, sourced review of the build spec. **Authoritative.** |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Process model, boundaries, data model, invariants |
| [`docs/DATA-FLOW.md`](docs/DATA-FLOW.md) | Diagrams: connection map, recompute loop, claim pricing, accumulator roll-up, IPC |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Dated decision and assumption log |

## Limitations I knowingly left in

- **No HSA or FSA tax treatment.** This meaningfully favours the two high-deductible plans, so
  the comparison currently understates their advantage. The highest-value thing to add next.
- **Deterministic, not probabilistic.** It prices the year you describe. Modelling a distribution
  — a good year, a typical one, a bad one — would be the more honest tool.
- **Ancillary-provider balance billing is not modelled.** The No Surprises Act protects
  out-of-network anaesthesia, pathology, radiology and similar *when delivered at an in-network
  facility*. A scenario carries one tier and cannot express "out-of-network provider, in-network
  facility", so those services stay balance-billable — the app shows the worse case. Emergency
  care, which is protected everywhere, is handled correctly.
- **Air versus ground ambulance is not distinguished.** Air ambulance is protected; ground is
  not. The single `ambulance` benefit is treated as ground, which is the common and riskier case.
- **Tier 4 drugs have no benefit key.** The 25 keys cover tiers 1–3 plus specialty. Tier 4 is
  Not Covered on all five plans; model it by setting a specialty row to Not Covered.
- **`rxSpecialty` uses the specialty Tier 2 copay.** The documents price specialty drugs in three
  tiers; one key cannot hold three numbers.
- **Round-robin interleaving is order-sensitive.** Results depend slightly on the order the
  scenario rows are listed in. A chronological model would be order-independent — see
  COST-MODEL §4.7.
- **Childbirth benefits on ES1J were not stated** in the source summary and are modelled on that
  plan's inpatient pattern.
- **Individual policies only in one sense:** the household is assumed to sit under one policy at
  a time. Split-family situations are out of scope.
- `npm audit` reports findings in `electron-builder`'s dependency tree. Production dependencies
  are clean (`npm audit --omit=dev` → 0).
