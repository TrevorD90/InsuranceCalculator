# Data flow and connection map — Plan Ledger

How data moves through the application, which module owns each hop, and where the trust
boundaries sit. Companion to [`ARCHITECTURE.md`](ARCHITECTURE.md) (structure) and
[`COST-MODEL.md`](COST-MODEL.md) (the math the pipeline performs).

Diagrams are Mermaid. IntelliJ, GitHub and VS Code render them inline.

---

## 1. Module connection map

Every arrow is a real dependency. If an arrow you want to add crosses the trust boundary
anywhere except through `preload.js`, the design is wrong.

```mermaid
graph TB
    subgraph MAIN["🔒 MAIN PROCESS — Node, CommonJS, privileged"]
        M["main.js<br/><i>window · settings · API calls · dialogs</i>"]
        SS[("safeStorage<br/>encrypted key")]
        FS[("userData<br/>settings.json")]
        M --- SS
        M --- FS
    end

    subgraph BRIDGE["preload.js — contextBridge"]
        P["window.desktop<br/><i>explicit allow-list</i>"]
    end

    subgraph REND["🌐 RENDERER — Chromium, ESM, unprivileged"]
        A["renderer/app.js<br/><i>state · events · DOM</i>"]
        E["src/engine.mjs<br/><i>PURE — no DOM, no I/O</i>"]
        PL["src/plans.mjs<br/><i>schema · normalize · validate · seeds</i>"]
        H["renderer/index.html + styles.css"]
        A -->|imports| E
        A -->|imports| PL
        PL -->|imports| E
        A -->|renders into| H
    end

    subgraph EXT["External"]
        API["api.anthropic.com<br/>/v1/messages"]
        PDF[("Plan PDFs<br/>on disk")]
    end

    M <-->|ipcMain.handle| P
    P <-->|ipcRenderer.invoke| A
    M -->|HTTPS, key in header| API
    M -->|fs.readFile → base64| PDF

    subgraph TEST["Test runner"]
        T["test/engine.test.mjs<br/><i>node --test</i>"]
    end

    T -->|imports| E
    T -->|imports| PL

    classDef privileged fill:#2E6FD9,stroke:#0F1622,color:#fff
    classDef pure fill:#0E8A6E,stroke:#0F1622,color:#fff
    classDef bridge fill:#7B4BD8,stroke:#0F1622,color:#fff
    classDef ext fill:#B4642A,stroke:#0F1622,color:#fff
    class M,SS,FS privileged
    class E,PL,T pure
    class P bridge
    class API,PDF ext
```

**Read the colors:** blue is privileged, green is pure and testable, purple is the single
crossing point, orange is outside the app. The green blocks are the only ones that produce
numbers, and they can be exercised without launching Electron at all.

---

## 2. The recompute loop — the hot path

This runs on **every keystroke and every slider tick**. It is synchronous and touches nothing
outside the renderer, which is what makes dragging a slider and watching five plans re-rank feel
instant.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant A as app.js (state)
    participant P as plans.mjs
    participant E as engine.mjs
    participant D as DOM

    U->>A: drag billed-amount slider
    A->>A: state.scenarios[i].billed = value
    A->>P: validate(plan) — regulatory bounds
    P-->>A: warnings[] (non-blocking)
    A->>E: compare(plans, scenarios, household)

    loop per plan
        E->>E: expandYear(scenarios) → ordered events
        E->>E: newAccumulators()
        loop per event, in order
            E->>E: applyEvent(plan, acc, event) → ledger line
        end
        E->>E: simulatePlan → totals + ledger
    end

    E->>E: rank cheapest-first, compute deltas
    E-->>A: results[]
    A->>D: re-render totals, rails, ledgers
    D-->>U: every plan's number moves at once
```

**Constraint:** no `await` anywhere in this loop. No IPC, no disk, no network. The moment
recompute becomes asynchronous, the slider stops feeling connected to the numbers, and the
slider is the product's main idea.

---

## 3. Pricing a single claim

The innermost step — `applyEvent`. Every one of the 17 engine tests ultimately lands here.
Order of operations is specified in [COST-MODEL §2.1](COST-MODEL.md#21-order-of-operations-on-a-single-claim).

```mermaid
flowchart TD
    START([event: benefitKey, tier, billed, memberId, admitted]) --> AVAIL

    AVAIL["benefitAvailability(plan, benefitKey, tier)<br/>covered | unavailable | notStated | fallback<br/><i>judged on the service asked for, before any swap</i>"] --> RESOLVE

    RESOLVE["resolve benefit<br/>tier: designated → in → out"] --> ADMIT
    ADMIT{"ER + admitted<br/>+ waiver on?"}
    ADMIT -->|yes| SWAP["swap to inpatient terms<br/>ER copay waived"]
    ADMIT -->|no| MODE
    SWAP --> MODE

    MODE{benefit.mode}
    MODE -->|notCovered| NC["member owes FULL billed<br/>accrues to nothing<br/>⚠️ uncapped"]
    MODE -->|noCharge| FREE["member owes 0<br/>accrues nothing"]
    MODE -->|copay / coinsurance| ALLOW

    ALLOW["allowed = billed × tierRate"] --> BAL
    BAL{"tier = out<br/>AND balanceBillable?"}
    BAL -->|"yes"| BB["balance = billed − allowed<br/>⚠️ never accrues, uncapped"]
    BAL -->|"no — NSA protected"| NOBB["balance = 0<br/>route to IN-network accumulators"]
    BB --> DED
    NOBB --> DED

    DED{"benefit.deductibleFirst?"}
    DED -->|yes| DRAW["draw = min(allowed, deductibleRemaining)<br/>remainder carries to cost share"]
    DED -->|no| SKIP["deductible untouched"]
    DRAW --> SHARE
    SKIP --> SHARE

    SHARE{mode}
    SHARE -->|copay| CP["member pays min(copay, remainder)"]
    SHARE -->|coinsurance| CI["member pays remainder × coinsurance"]

    CP --> OOP
    CI --> OOP
    OOP["countable = deductible + coinsurance<br/>+ (copaysCountToOOP ? copay : 0)"] --> CAP

    CAP{"countable exceeds<br/>OOP room?"}
    CAP -->|no| ACCRUE
    CAP -->|yes| FORGIVE["forgive: coinsurance → copay → deductible<br/>rewind deductible ledger by what was<br/>actually forgiven (COST-MODEL §4.6)"]
    FORGIVE --> ACCRUE

    ACCRUE["credit individual AND family accumulators"] --> LINE
    NC --> LINE
    FREE --> LINE
    LINE([ledger line: deductible, coinsurance, copay,<br/>balanceBilled, uncovered, memberTotal, planPaid,<br/>availability])

    classDef warn fill:#C0392B,stroke:#0F1622,color:#fff
    classDef ok fill:#0E8A6E,stroke:#0F1622,color:#fff
    class NC,BB warn
    class FREE,NOBB ok
```

The two red nodes are the uncapped ones — balance billing and non-covered services. They bypass
both accumulators entirely and are the reason the UI reports them on their own flagged rows
rather than folding them into a total.

The `notCovered` path is also why availability is computed *first*, at the top of the flow.
That branch produces a perfectly good number — the entire billed charge — and a number is
exactly the wrong thing to show. Beside another plan's `$40` copay it reads as a price rather
than as being on your own, so the renderer prints the word instead. COST-MODEL §2.7.

---

## 4. Accumulator hierarchy and roll-up

Every dollar of member cost sharing credits **two** ledgers: the member's and the family's.
Whichever ceiling is reached first starts the plan paying.

```mermaid
flowchart TD
    CLAIM["member cost sharing<br/>from one claim"] --> SPLIT

    SPLIT --> IND["individual accumulator<br/>(memberId, network side)"]
    SPLIT --> FAM["family accumulator<br/>(network side)"]

    IND --> IDED["individual deductible"]
    IND --> IOOP["individual OOP max"]
    FAM --> FDED["family deductible"]
    FAM --> FOOP["family OOP max"]

    IDED --> MODE{"familyDeductibleMode"}
    MODE -->|embedded| EMB["member's own deductible met<br/>→ plan pays FOR THAT MEMBER<br/>even if family is short"]
    MODE -->|aggregate| AGG["plan pays for NO ONE<br/>until the FAMILY deductible is met"]

    IOOP --> ALWAYS["ALWAYS embedded — no mode switch.<br/>Individual OOP met → plan pays 100%<br/>for that member. Required since 2016.<br/>(COST-MODEL §4.4)"]

    FOOP --> FCAP["family OOP met → plan pays 100%<br/>for everyone, even if no individual<br/>reached their own maximum"]

    classDef rule fill:#7B4BD8,stroke:#0F1622,color:#fff
    class ALWAYS rule
```

The purple node is the correction from COST-MODEL §4.4: the build prompt's single
`familyDeductibleMode` governs the **deductible only**. The individual out-of-pocket maximum is
embedded unconditionally, on every plan, including aggregate-deductible ones like ES2P.

Also flowing through this structure, per plan:

- **`combinedAccumulators`** — whether the `in` and `out` sides share ledgers or run separately.
- **`pharmacyDeductible`** — when set, `rx*` benefits draw against their own deductible and do
  **not** consume the medical one.
- **NSA-protected out-of-network claims** — routed to the **in-network** accumulators regardless
  of the above (COST-MODEL §4.1). This is what gives plan 5 (EPO, no out-of-network
  accumulators at all) somewhere to put an out-of-network ER claim.

---

## 5. IPC surface

The complete list. `preload.js` exposes these names and nothing else — no generic channel
passthrough.

```mermaid
sequenceDiagram
    participant R as renderer/app.js
    participant P as preload.js
    participant M as main.js
    participant X as external

    Note over R,X: Settings
    R->>P: desktop.settings.load()
    P->>M: invoke("settings:load")
    M-->>R: {model, hasKey, keyHint, encryptionAvailable}
    Note right of M: never the key itself

    R->>P: desktop.settings.save({apiKey?, model})
    P->>M: invoke("settings:save")
    M->>M: safeStorage.encryptString → disk
    M-->>R: {ok, warning?}

    Note over R,X: Connection test
    R->>P: desktop.ai.test()
    P->>M: invoke("ai:test")
    M->>X: POST /v1/messages (key in header)
    X-->>M: 200 | 401 | 429
    M-->>R: {ok, model} | {ok:false, error}

    Note over R,X: PDF import
    R->>P: desktop.plans.import()
    P->>M: invoke("plans:import")
    M->>X: showOpenDialog → PDF paths
    loop per file (≤ 24 MB)
        M->>M: read → base64
        M-->>R: send("plans:progress", {file, state})
        M->>X: POST document block + schema prompt
        X-->>M: JSON (fences stripped defensively)
    end
    M-->>R: {plans[], failures[]}
    R->>R: normalizePlan + validate, mark source:"ai"

    Note over R,X: Workspace
    R->>P: desktop.workspace.export(payload)
    P->>M: invoke("workspace:export")
    M->>X: showSaveDialog → write JSON
    R->>P: desktop.workspace.import()
    P->>M: invoke("workspace:import")
    M->>X: showOpenDialog → read JSON
    M-->>R: {ok, data} → normalize + validate

    Note over R,X: Autosave (silent, debounced 600ms, no dialog)
    R->>P: desktop.workspace.autosave(payload)
    P->>M: invoke("workspace:autosave")
    M->>X: write userData/workspace.json
    R->>P: desktop.workspace.restore()
    P->>M: invoke("workspace:restore")
    M-->>R: {ok, data|null}
```

**[as-built] channel names.** `workspace:export` / `workspace:import` are the dialog-backed
pair; `workspace:autosave` / `workspace:restore` are the silent local pair. `restore` resolves
`{ok:true, data:null}` rather than rejecting when no autosave exists, and the renderer wraps
the call in `try/catch` anyway — a failed restore costs the user their autosave, and must never
cost them the whole interface.

**The key never crosses the bridge.** `settings:load` returns a masked hint
(`sk-ant-…abcd`) and a boolean, never the value. `ai:test` and `plans:import` do their work
entirely in main and return results, not credentials.

**[as-built] `desktop.ui.setZoom` / `getZoom` are the one pair that never reach main.** They
call `webFrame` directly from the preload, because frame zoom is a property of this frame and a
round trip would buy nothing. Still named, single-purpose, and logic-free. The preference itself
*is* persisted through main, as `textScale` on `settings:load` / `settings:save`, alongside the
model — it is an app setting, not workspace data, so it never lands in an exported comparison.

---

## 6. State ownership and persistence

```mermaid
flowchart LR
    subgraph RS["renderer state — in memory, authoritative while running"]
        SP["state.plans[]"]
        SH["state.household[]"]
        SC["state.scenarios[]"]
        SR["state.results[]<br/><i>derived — never edited</i>"]
    end

    subgraph DISK["disk"]
        AUTO[("autosave<br/>userData")]
        EXP[("export.json<br/>user-chosen path")]
        SET[("settings.json<br/>encrypted key + model")]
    end

    SP & SH & SC -->|"every change (debounced)"| AUTO
    AUTO -->|"on launch"| SP & SH & SC
    SP & SH & SC & SR -->|"Export"| EXP
    EXP -->|"Import → normalize → validate"| SP & SH & SC
    SET -.->|"main process only"| SET

    classDef derived fill:#CDD6E2,stroke:#0F1622,color:#0F1622
    class SR derived
```

Two rules:

1. **`state.results` is derived and never edited.** It is thrown away and rebuilt on every
   recompute. Anything that needs to persist belongs in plans, household, or scenarios.
2. **Settings never mix with workspace data.** The encrypted key lives in the main process's
   `settings.json`; exported workspace files are plain JSON containing no secrets, safe to
   email to a spouse or an HR rep.

---

## 7. Trust boundaries, summarized

| Boundary | Crossed by | Carries | Never carries |
|---|---|---|---|
| Renderer ↔ Main | `preload.js` allow-list only | plan data, settings metadata, progress events | the API key, raw fs handles, arbitrary channel names |
| Main ↔ Anthropic | `fetch` in main | base64 PDF, extraction prompt, key header | anything the user didn't explicitly import |
| Main ↔ Disk | `fs` in main | encrypted key, autosave, exports | plaintext key (unless `safeStorage` is unavailable — and then the UI says so) |
| Engine ↔ everything | function calls | plain objects in, plain objects out | side effects of any kind |
