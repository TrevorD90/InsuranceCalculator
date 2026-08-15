# Plan Ledger — project instructions

A cross-platform Electron desktop app that compares health insurance plans by simulating a full
year of care against each one. **The math is the product; the interface is a window onto it.**

---

## 📋 Documentation is part of the build — read this first

`docs/` is not a description of the project. It is part of the project, and it is kept correct
in the same change as the code.

### Before you change code

**Read the relevant doc first.** These documents are authoritative:

| Document | Authoritative for |
|---|---|
| [`docs/COST-MODEL.md`](docs/COST-MODEL.md) | Every rule about deductibles, copays, coinsurance, OOP maximums, balance billing, family accumulators, and provider tiers. **Cited sources. If code and this document disagree, the code is wrong.** |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Module boundaries, process model, data shapes, security invariants |
| [`docs/DATA-FLOW.md`](docs/DATA-FLOW.md) | How data moves, IPC surface, the recompute loop, accumulator roll-up |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Why things are the way they are. Check before re-litigating a choice. |

### After you change code — mandatory, every time

**Every code change requires a documentation review in the same change.** Not a follow-up task,
not "later", not a TODO. Before reporting any coding work as complete, walk the routing table:

| If you changed… | Review and update… |
|---|---|
| Cost-sharing math, accumulator logic, any rule about how plans pay | `COST-MODEL.md` — and if it contradicts a cited source, **stop and flag it** rather than changing the doc to match the code |
| Module boundaries, new/removed/renamed files, data shapes, invariants | `ARCHITECTURE.md` §3–4 |
| IPC channels, the preload surface, persistence, external calls | `DATA-FLOW.md` §5–6 + `ARCHITECTURE.md` §7 |
| The recompute pipeline or claim-pricing order of operations | `DATA-FLOW.md` §2–3 (**update the Mermaid diagrams**) |
| Family/household accumulator behavior | `DATA-FLOW.md` §4 + `COST-MODEL.md` §2.3 |
| Plan schema, benefit keys, seed data | `ARCHITECTURE.md` §4 + `COST-MODEL.md` §2.5 |
| UI structure, columns, design tokens | `ARCHITECTURE.md` §6 |
| Build, packaging, scripts | `ARCHITECTURE.md` §9 + `README.md` |
| **Anything requiring a judgment call, tradeoff, or assumption** | `DECISIONS.md` — append, newest first, never rewrite history |
| A known limitation, added or removed | `ARCHITECTURE.md` §10 |

**Then state explicitly, in your reply, which documents you reviewed and what you changed —
including "reviewed X, no update needed" when that is the honest answer.** Silence about the
docs is not an acceptable completion.

### If a doc turns out to be wrong

Fix the document, and say so plainly. A stale document is worse than none — it will be trusted.
The one exception: never edit `COST-MODEL.md` to match code that contradicts one of its cited
regulatory sources. In that case the code is wrong. Raise it.

---

## Domain rules that are easy to get wrong

Short version. Full treatment with citations in `docs/COST-MODEL.md`.

1. **Coinsurance and copays apply to the *allowed amount*, never the billed amount.**
2. **`deductibleFirst` is per benefit, per tier — never a global plan flag.** HSA plans put
   every copay behind the deductible; copay-PPOs say "deductible does not apply."
3. **Balance billing and non-covered services accrue to nothing** — not the deductible, not the
   OOP max. They are uncapped and must be reported on their own flagged rows, never folded into
   a total.
4. **Emergency care cannot be balance billed** (No Surprises Act). Nor can out-of-network
   providers at in-network facilities, nor air ambulance. Their cost sharing routes to the
   **in-network** accumulators. `balanceBillable` is a per-benefit property.
5. **Ground ambulance is the exception** — excluded from the NSA, still balance-billable, and the
   real exposure.
6. **The individual OOP maximum is always embedded**, on every plan, including
   aggregate-deductible ones. `familyDeductibleMode` governs the **deductible only**.
7. **Coinsurance is always the member's share.** "Plan pays 80%" is `0.2`.
8. **Three tiers, not two:** `designated` → `in` → `out`, with `designated` falling back to `in`.
9. **"Cannot" is not a price.** A plan that does not cover something still yields a number — the
   whole billed charge — and showing it beside a covered plan's copay reads as a price. Use
   `benefitAvailability()` and print **Unavailable / Not covered / Not stated**. "Not stated"
   outranks "not covered": a default the app invented is never shown as though the plan stated
   it.

---

## Architectural invariants

Violating any of these is a defect, not a style preference:

- `contextIsolation: true`, `nodeIntegration: false`.
- **The renderer never sees the API key** — not once, not transiently, not to test a connection.
- **All Anthropic API calls originate in the main process.** Never the renderer.
- The preload surface is an explicit allow-list of named functions. No generic
  `invoke(channel, …)` passthrough.
- `src/*.mjs` imports nothing from `electron` and touches no DOM or Node global. That is what
  lets `node --test` and the browser load the same file.
- **If a number the user sees was computed anywhere other than `src/engine.mjs`, that is a bug.**
  `renderer/app.js` may format numbers; it may not derive them.
- No `await` in the recompute loop. The slider must feel connected to the totals.

---

## Working order

Established by the build prompt and not to be reordered: **cost engine + tests green first**,
before a single line of UI.

```
npm install && npm start     must work on a clean machine, no build step
npm test                     node --test, no framework dependency
npm run dist:win             electron-builder → nsis + portable
npm run dist:mac             electron-builder → dmg + zip
```

## Conventions

- Main process and preload are **CommonJS**; shared logic and renderer are **ES modules**.
- Shared logic is named `.mjs` so Node and the browser can both load it without a bundler.
- Money is stored as numbers, rounded to cents at the boundary — never accumulated pre-rounded.
- Purple `#7B4BD8` is **reserved exclusively for the AI status light**. Do not use it elsewhere.
- Monospace with tabular figures for anything the *plan or provider states as fact*; system sans
  for anything the *app says to the user*.

## Reference material

- `docs/` — authoritative, see the table above
- The original build prompt: `C:\Users\seren\Downloads\plan-ledger-build-prompt.md`
- Earlier prototype: `C:\Users\seren\Downloads\plan-ledger.zip` — **reference only.** It contains
  two incompatible generations, neither matching this architecture, and a known deductible-rewind
  bug (`COST-MODEL.md` §4.6). Do not extend it.
