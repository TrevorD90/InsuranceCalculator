# Plan Ledger — documentation

These documents are part of the build, not a description of it. They are updated in the same
change as the code they describe. The enforcing rule lives in [`/CLAUDE.md`](../CLAUDE.md).

## Read in this order

1. **[COST-MODEL.md](COST-MODEL.md)** — what the math must do, and why.
   Vocabulary, how deductibles/copays/coinsurance/OOP maximums interact, family accumulator
   structures, the regulatory floor and ceiling, and a section-by-section review of the build
   prompt with citations. **Authoritative: if the code disagrees with this document, the code is
   wrong.** Start here — nothing else makes sense first.

2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the app is put together.
   Process model and security invariants, module layout and responsibility boundaries, the data
   model, the computation pipeline, interface architecture, privileged operations, and the
   limitations carried deliberately.

3. **[DATA-FLOW.md](DATA-FLOW.md)** — how data moves.
   Mermaid diagrams for the module connection map, the recompute hot path, single-claim pricing,
   accumulator roll-up, the complete IPC surface, and state ownership. Read alongside
   ARCHITECTURE.

4. **[DECISIONS.md](DECISIONS.md)** — why things are the way they are.
   Dated `[DECISION]` / `[ASSUMPTION]` log, newest first. Check before re-litigating a choice.

## Current state

**Built and passing.** 29 engine tests green; the app launches, renders, autosaves and restores.
`npm install && npm start` to run it, `npm test` for the engine.

Documenting the domain first was worth it: it surfaced four material corrections to the build
prompt at zero refactoring cost, all of which are now implemented and pinned by tests.

Four corrections that change reported numbers, in severity order:

| | Correction | Where |
|---|---|---|
| 🔴 | Emergency care cannot be balance billed (No Surprises Act) — `balanceBillable` is per benefit, and protected claims route to in-network accumulators | COST-MODEL §4.1 |
| 🔴 | The individual OOP maximum is always embedded, even on aggregate-deductible plans | COST-MODEL §4.4 |
| 🟠 | Ground ambulance is excluded from the NSA and is the real balance-billing exposure | COST-MODEL §4.2 |
| 🟡 | Copays counting toward the OOP max is mandatory in network, not a free dial | COST-MODEL §4.3 |

Three questions are still open for the user, recorded in COST-MODEL §5. None blocked the build;
answering them would let the app model the household more precisely.

**Not yet verified:** `npm run dist:win` / `dist:mac` have not been executed, there has been no
macOS testing, and the Claude PDF-import path has never made a live API call. See
[DECISIONS.md](DECISIONS.md) → "2026-08-14 (2)" → *Not done*.
