# Cost model — domain reference and build-prompt review

**Status:** authoritative. The engine implements this document. Where this document and
`plan-ledger-build-prompt.md` disagree, **this document wins** and the disagreement is
recorded in [§4](#4-corrections-to-the-build-prompt) with a citation.

**Last verified:** 2026-08-14 against the sources in [§6](#6-sources).

---

## 1. Vocabulary

These terms are used with exactly these meanings everywhere in the codebase. They are not
interchangeable and the most common way a plan comparison tool goes wrong is blurring them.

| Term | Meaning |
|---|---|
| **Billed charge** | What the provider puts on the bill. Sticker price. Almost nobody pays this. The user types this number. |
| **Allowed amount** | The amount the plan recognizes for a service. In network this is the carrier's negotiated rate; out of network it is the plan's own "allowed amount" schedule. |
| **Balance bill** | `billed − allowed`, out of network only. The provider never agreed to the plan's allowed amount, so they may pursue the member for the difference. |
| **Cost sharing** | Deductible + copays + coinsurance. Statutorily **excludes** premiums, balance-billed amounts from non-network providers, and spending on non-covered services. |
| **Deductible** | Cost sharing the member pays in full before the plan begins paying for a given benefit. |
| **Copay** | A flat dollar amount per service. |
| **Coinsurance** | A percentage of the allowed amount. Always stored as the **member's** share: "plan pays 80%" is `0.2`. |
| **Out-of-pocket maximum (OOP max)** | The ceiling on cost sharing for a year. Once reached, the plan pays 100% of covered in-network care. |
| **Accumulator** | A running total (deductible-met, OOP-met) that claims draw against, scoped to a member and a network side. |

### The three-state mental model

Any single service costs the member one of three different amounts depending on where in the
year it lands. This is the core insight the UI exists to make visible:

```
  before deductible met  →  member pays the full allowed amount
  after deductible met   →  member pays copay or coinsurance
  after OOP max met      →  member pays $0 (in-network covered care)
```

`marginalCosts()` produces these three by pricing the same visit against frozen accumulator
states. **Each state must be built from its own limits**: the individual ledger from the
individual deductible, the family ledger from the family deductible. Deriving one from the
other collapses the middle state into the third on any plan whose family deductible is at least
its individual out-of-pocket maximum — see `DECISIONS.md`, 2026-08-14 (6), for the regression
this caused and test R that now pins it.

---

## 2. How the pieces interact

### 2.1 Order of operations on a single claim

```
billed
  → allowed          = billed × tierRate            (negotiated % or OON allowed %)
  → balance          = billed − allowed             (out of network only, and only if balance-billable)
  → deductible draw  = min(allowed, deductibleRemaining)   [if benefit.deductibleFirst]
  → copay/coinsurance applied to the remainder of the same claim
  → OOP cap          = member cost sharing capped at oopRemaining
  → member owes      = cost sharing + balance bill + uncovered
```

Two things that are easy to get backwards:

- **Coinsurance runs on the allowed amount, never the billed amount.** A 20% coinsurance on a
  $1,000 billed charge with a $550 allowed amount is $110, not $200.
- **`deductibleFirst` is per benefit, per tier — never a global plan flag.** On an HSA plan
  every copay sits behind the deductible; on a copay-PPO the SBC says "deductible does not
  apply" next to most of them. Same carrier, same year, opposite behavior.

### 2.2 What accrues to what

|  | Counts toward deductible | Counts toward OOP max |
|---|---|---|
| Deductible payments | — (is the deductible) | ✅ always |
| Coinsurance | ❌ | ✅ always |
| Copays | ❌ typically | ✅ in network, mandatory (see §4.3) |
| **Balance billing** | ❌ **never** | ❌ **never** |
| **Non-covered services** | ❌ **never** | ❌ **never** |
| Premiums | ❌ | ❌ |

The two "never" rows are the whole danger of going out of network: they are uncapped. A plan
with a $6,000 OOP max does not limit the member's exposure to $6,000 if balance billing is in
play. The UI must surface these separately and in a warning color, never folded into a total.

### 2.3 Accumulator hierarchy

```
household
├── family accumulators          (family deductible, family OOP max)
└── per member
    ├── individual deductible    (embedded plans only — see §2.4)
    ├── individual OOP max       (ALWAYS present — see §4.4)
    └── per network side         (in / out, separate or combined per plan)
        └── optional separate pharmacy deductible
```

Every dollar of member cost sharing credits **both** the individual and the family
accumulator. Whichever ceiling is hit first starts the plan paying.

### 2.4 Embedded vs. aggregate family deductibles

- **Embedded** — each member has an individual deductible inside the larger family deductible.
  When a member meets theirs, the plan starts paying **for that member**, even if the family
  deductible is nowhere near met. Individual spend also credits the family total.
- **Aggregate (non-embedded)** — the entire family deductible must be met before the plan pays
  for **anyone**. A single high-utilizer can satisfy the whole thing.

This changes the answer materially for a household with one high-utilizer and several light
users, which is the single most common real-world shape.

### 2.5 The HSA constraint that explains the seed data

For an HDHP to be HSA-qualified with family coverage (2026 figures):

- minimum deductible: **$1,700** self-only / **$3,400** family
- maximum OOP: **$8,500** self-only / **$17,000** family
- **if the plan embeds an individual deductible, that embedded amount must be at least the
  family minimum ($3,400).** An HDHP embedding a $1,700 individual deductible is *not*
  HSA-qualified.

This is why the two HSA seed plans have the shapes they do, and it is a non-obvious detail the
build prompt got right:

| Plan | Deductible (ind/fam) | Mode | HSA-qualified? |
|---|---|---|---|
| ES2P / L81S HSA | $1,700 / $3,400 | **aggregate** | ✅ — aggregate, so the $1,700 individual figure is the self-only tier, not an embedded amount |
| ES38 / L81S HSA | $3,400 / $6,800 | **embedded** | ✅ — embedded individual $3,400 ≥ the $3,400 family minimum |

Had ES2P been embedded at $1,700, it would have failed HSA qualification. The prompt's
assignment of aggregate-vs-embedded to these two plans is therefore load-bearing and correct.

### 2.6 Provider tiers

Three tiers, not two: `designated` → `in` → `out`, with `designated` falling back to `in` when
a plan defines no designated benefit for that service.

This is not a modeling flourish. UnitedHealthcare's **Designated Diagnostic Provider (DDP)**
program is real and applies to outpatient **lab** and **major imaging** (MRI, CT, PET, MRA,
nuclear medicine) services. Members pay the lowest cost share at a DDP facility and a
materially higher one at an in-network facility that is not designated. On the seed plans this
is the single biggest swing in the documents — on ESZ9 and ES1J, network imaging is 50%
coinsurance while designated imaging is 0%.

**Scope note:** the DDP tier is only meaningful for labs and imaging. The tier selector should
not offer `designated` for benefits where no plan defines one.

### 2.7 Availability: "cannot" is not a price

Three states are routinely confused, and conflating them makes a comparison dishonest:

| State | Meaning | Shown as |
|---|---|---|
| **Covered** | The plan pays according to its benefit | the three figures |
| **Not covered / Unavailable** | The plan does not cover this at this tier. The member owes the **entire billed charge**, and none of it counts toward any limit. | the word |
| **Not stated** | An AI-extracted plan whose source document did not state this benefit. We do **not know** — which is a different claim from knowing it is a no. | the word, in a quieter style |

A plan that cannot cover something still produces a number: the full billed charge. Rendering
that number beside another plan's `$40` copay reads as *a price*, when it means *you are on your
own and nothing caps it*. So where one plan can do something and another cannot, the one that
cannot **says so in words**.

"Not stated" outranks "not covered". A default the app invented to fill an extraction gap must
never be presented as though the plan stated it — that is how a confidently wrong comparison
gets made.

A fourth state is a near-miss rather than a refusal: a scenario asks for the **Designated** tier
and the plan defines none, so it is priced at the in-network rate (§2.6). Still covered, but not
at the tier requested, so it is marked rather than silently substituted.

Implemented as `benefitAvailability(plan, benefitKey, tier)` in `engine.mjs`, which returns
`{status, label, detail}` with status one of `covered | unavailable | notStated | fallback`.
Every ledger line carries its own `availability`, judged on the service that was *asked for* —
so an ER visit that swaps to inpatient terms on admission still reports itself as an ER visit.

**The member's cost alone cannot carry this.** Out of network, before the deductible is met, a
plan covering a service at 40% coinsurance and a plan not covering it at all produce the *same*
member figure — the entire billed charge — for opposite reasons. One is putting the allowed
amount toward your deductible and will pay 60% of the next visit; the other will never pay
anything, ever. So `describeBenefit(plan, benefitKey, tier)` states the terms in words:

```
  You pay 40%, plan pays 60% · after the deductible · plus balance billing, which nothing caps
  You pay a $25 copay · deductible does not apply
  Plan pays 100% · after the deductible
  Covered in full
  Not covered — you owe the whole charge
  ... · no balance billing — protected by law          (NSA-protected services, §4.1)
```

Coinsurance is deliberately stated from **both** sides. "40% coinsurance" is the single most
misread figure in a plan document, and naming the plan's share alongside the member's removes
the ambiguity at the point of reading rather than in a footnote.

### 2.8 What a primary care visit can actually be billed at

The scenario sliders need ceilings, and a ceiling that cannot reach a bill you might really
receive quietly tells the user that bill is impossible. There is **no published "most expensive
primary care visit"** — no registry records one — so the upper bound is constructed from
published components rather than quoted.

| Component | Figure | Source |
|---|---|---|
| CPT **99205**, the highest-complexity primary care office visit — Medicare office rate | **$236.81** (2026) | CMS conversion factor $33.4009 |
| Average **billed charge** for 99205 | **$534.53** — a 2.3× markup | 2023 CMS utilization data |
| Median charge, 99205 | $484 | FAIR Health (2016) |
| Charge-to-cost ratio at the **fifty highest-markup US hospitals** | **~10×** Medicare-allowable (national average 3.4×, mode 2.4×) | Bai & Anderson, *Health Affairs*, "Extreme Markup" |
| Hospital **facility fee** added at a hospital-owned clinic | +$150–$400 typical; documented routine-visit examples of **$488** and **$503** | U.S. PIRG; InvestigateTV |
| Hospital-owned physician offices vs. independent | **+26%** for the same service | *Health Affairs*, 2024 |

Composing the extreme — highest-complexity visit, at an extreme-markup hospital-owned practice,
with a high-end facility fee:

```
  $236.81  Medicare office rate, CPT 99205
  ×  10    extreme-markup hospital ratio
  = $2,368
  +  ~500  high-end facility fee on a hospital-owned clinic
  ≈ $2,500  realistic worst case for ONE primary care visit
```

**Slider ceiling = 2 × $2,500 = $5,000.**

Two things this deliberately is not: it is not a *typical* bill (that is $150–$300), and it is
not an absolute maximum (chargemasters have no ceiling). It is the point past which a figure
stops being a bill someone plausibly received.

**Coherence rule.** Office-visit ceilings must not contradict one another — a specialist visit
always bills at least as much as primary care, so its ceiling cannot be lower. Only primary care
was researched; the others were scaled to preserve that ordering and are marked as assumptions
in `DECISIONS.md`. Test P pins both the primary-care floor and the ordering.

**Granularity note.** The slider maps position to dollars on a square curve, so raising a ceiling
costs precision only at the low end — about $5 per tick around a typical $220 charge instead of
$1 — and the number field beside it still takes an exact figure.

---

## 3. Regulatory floor and ceiling (2026 plan years)

The coverage period on the seed documents is 06/01/26 – 05/31/27, so 2026 limits apply.

| Limit | Self-only | Family |
|---|---|---|
| ACA maximum annual limitation on cost sharing | **$10,600** | **$21,200** |
| HDHP minimum annual deductible | $1,700 | $3,400 |
| HDHP maximum out-of-pocket | $8,500 | $17,000 |
| HSA contribution limit | $4,400 | $8,750 |

*(The ACA figures were revised upward by HHS from an earlier $10,150 / $20,300 published under
superseded methodology. The revised numbers above are the operative ones.)*

All five seed plans sit inside these bounds. The engine should validate against them — see
§4.5.

---

## 4. Corrections to the build prompt

The build prompt is unusually accurate for a spec of this kind. Every core definition in it
checks out: billed-vs-allowed, balance billing exclusion, per-benefit `deductibleFirst`,
embedded vs aggregate, separate network accumulators, the designated tier, the ER-admission
copay waiver, and the "SBCs don't state premiums" observation are all correct as written.

The following are the places it is wrong, incomplete, or structurally ambiguous. Each one
changes the number the app reports.

### 4.1 🔴 Balance billing on emergency care is illegal — the model overstates cost

The prompt models balance billing as a per-plan boolean and applies it to any out-of-network
claim. Under the **No Surprises Act** (in force since 2022-01-01), the member **cannot** be
balance billed for:

- **emergency services**, including post-stabilization care until safely transferable;
- **out-of-network providers delivering care at an in-network facility** — emergency medicine,
  anesthesiology, pathology, radiology, laboratory, neonatology, assistant surgeon, hospitalist
  and intensivist services;
- **air ambulance**.

For all of the above, member cost sharing is calculated **at the in-network rate** and **must
count toward the in-network deductible and in-network OOP max**.

Every seed plan sets ER to `$500 copay both networks`. Modeling an out-of-network ER visit with
a balance bill produces a number that is both legally wrong and alarmist — it inflates the
scariest line in the app.

> **Required:** balance-billability is a property of the **benefit**, not the plan.
> Add `balanceBillable: boolean` per benefit (default `true`, forced `false` for `er`,
> `ambulance` when air, and the ancillary-at-in-network-facility set). NSA-protected
> out-of-network claims must route their cost sharing to the **in-network** accumulators.

> **[as-built] Implemented scope.** `engine.mjs` exports `NSA_PROTECTED`, containing **`er`
> only**, and `plans.mjs` forces `balanceBillable: false` on those benefits during
> normalization so neither a hand edit nor an AI extraction can turn the protection off.
> Emergency services are protected wherever they are delivered, so `er` needs no qualifier.
> The **ancillary set is deliberately not included**: its protection is conditional on the
> facility being in network, and a scenario carries one `tier` field that cannot express
> "out-of-network provider at an in-network facility". Leaving them balance-billable reports
> the *worse* case, which is the safe direction to be wrong in — the app never assumes a
> protection it cannot verify. Closing this gap needs a per-scenario facility-network flag.
> Air ambulance is likewise unmodelled: the single `ambulance` key is treated as ground.
> Both are recorded in ARCHITECTURE §10.

This also resolves an otherwise unanswerable question in the seed data: plan 5 (ES38, EPO) has
**no out-of-network deductible or OOP max at all**, yet covers ER and ambulance out of network.
Without this rule there is no accumulator for those claims to draw against. With it, they
correctly draw against the in-network accumulators.

### 4.2 🟠 Ground ambulance is the one place balance billing still bites

Ground ambulance was deliberately excluded from the No Surprises Act. Roughly half of emergency
ground ambulance rides generate an out-of-network charge, and the member remains exposed to the
balance bill.

The prompt lists `ambulance` at 0% coinsurance both networks and gives it no special handling —
treating the single most balance-bill-prone service in the benefit set as ordinary.

> **Required:** `ambulance` keeps `balanceBillable: true` and the UI should flag it, while `er`
> is protected. This inverts the prompt's instinct and is the correct inversion.

### 4.3 🟡 "Copays count toward the OOP max" is not really a dial

The prompt makes this a per-plan flag defaulting to `true`. For in-network essential health
benefits in any non-grandfathered plan it is **mandatory**, not optional — the ACA's annual
limitation on cost sharing is defined to include deductibles, copayments and coinsurance alike.

> **Keep the flag** (it is needed for grandfathered and excepted-benefit plans, and for
> out-of-network cost sharing where the rule does not bind), but: default `true`, never `false`
> on any of the five seed plans, and surface a validation warning if a user sets it `false` on a
> plan whose in-network benefits are EHB.

### 4.4 🔴 The individual OOP max is always embedded — even on aggregate plans

The prompt carries a single `familyDeductibleMode: embedded | aggregate` and lets it govern the
household roll-up generally. That conflates two independent structures.

Since the 2016 plan year, every non-grandfathered plan **must** embed an individual out-of-pocket
maximum within family coverage. Once any one member reaches the self-only OOP limit, the plan
pays 100% for that member even if the family maximum is untouched — **regardless of whether the
deductible is embedded or aggregate**.

So ES2P has an **aggregate deductible** and an **embedded OOP max** simultaneously. A single
mode field cannot express that.

> **Required:** `familyDeductibleMode` governs the **deductible only**. The OOP max is embedded
> unconditionally. The engine checks the individual OOP ceiling on every claim for every plan.

### 4.5 🟡 No validation against the regulatory bounds

Nothing in the prompt checks a plan's numbers for plausibility. The AI PDF-import path makes
this matter: an extraction error that misreads a deductible produces a confidently wrong
comparison with no signal to the user.

> **Recommended:** validate on plan load and after every edit —
> in-network OOP max ≤ ACA limit; deductible ≤ OOP max; if flagged HSA, deductible ≥ HDHP
> minimum, OOP ≤ HDHP maximum, and embedded individual deductible ≥ family minimum. Surface as
> non-blocking warnings on the plan card.

### 4.6 🟢 The OOP-max forgiveness order is fine, and the rewind is correct

The prompt's "forgive coinsurance first, then copays, then deductible, and rewind the deductible
ledger by whatever you forgave" reads like an invented rule, and the ordering *is* a modeling
convention rather than a legal requirement — the member's total is identical whichever order you
forgive in, because the cap is on the sum.

But the rewind step is genuinely correct bookkeeping and should be kept: if deductible dollars
were forgiven, the member never paid them, so crediting them to the deductible accumulator would
report a deductible as met that isn't. Forgiving coinsurance first also minimizes how often the
rewind is needed, which is the right default.

⚠️ **Implementation warning.** The prototype in `plan-ledger.zip` (`src/engine.mjs`) implements
this incorrectly: it computes `dedForgiven` from the *full* excess before the forgiveness loop
runs, then unconditionally rewinds the deductible by that amount — even when the loop actually
forgave coinsurance and never touched the deductible. The result is a deductible accumulator
that under-reports. Compute the rewind from what the loop actually forgave.

### 4.7 🟡 Round-robin interleaving is a defensible approximation, not the real thing

"Interleave repeat visits round-robin rather than batching them" is correct in spirit — batching
twelve prescription fills before any other care draws the deductible down in an order no real
year has.

But round-robin isn't the real thing either, and it makes the result sensitive to the *order the
scenario rows happen to be listed in*, which the user can reorder without meaning anything by it.

> **Accepted as specified**, with a note: a chronological model (spread each scenario's visits
> evenly across twelve months, then sort by date) is order-independent and no harder to compute.
> Worth revisiting if results ever look sensitive to row order. Recorded in `DECISIONS.md`.

### 4.8 🟢 Minor, no action needed

- **Preventive in network at zero cost sharing, deductible not applied** — correct and legally
  required. Test 14 covers it.
- **Tier 4 drugs not covered on every plan** — plausible and internally consistent.
- **Premium absent from SBCs** — correct; SBCs state "provided separately."

### Summary table

| # | Severity | Issue | Action |
|---|---|---|---|
| 4.1 | 🔴 | ER/ancillary/air-ambulance balance billing is illegal (NSA) | `balanceBillable` per benefit; route protected claims to in-network accumulators |
| 4.4 | 🔴 | Individual OOP max is always embedded, even on aggregate plans | Split OOP-max embedding from `familyDeductibleMode` |
| 4.2 | 🟠 | Ground ambulance excluded from NSA — the real exposure | Keep `balanceBillable: true`, flag in UI |
| 4.3 | 🟡 | Copays-toward-OOP is mandatory in network | Keep flag, default true, warn on false |
| 4.5 | 🟡 | No regulatory validation of plan figures | Add non-blocking plan validation |
| 4.7 | 🟡 | Round-robin is order-sensitive | Accept, document, revisit |
| 4.6 | 🟢 | Forgiveness order / rewind | Correct as specified — but fix the prototype's rewind bug |

---

## 5. Open questions for the user

1. **Are the five plans' ER benefits in or out of network in practice?** Under the NSA the
   distinction largely collapses for emergency care. Confirms whether §4.1 changes any real
   number for you or is purely defensive.
2. **Which state?** Ground-ambulance balance billing protections are state-level, and several
   states have closed the federal gap. If yours has, §4.2 softens.
3. **Is anyone in the household on an HSA?** If so the app should model the tax treatment; the
   prototype README lists this as a known omission and it meaningfully favors the HDHPs.

---

## 6. Sources

- [Georgetown CHIR — Embedded Deductibles: Source of Consumer Confusion](https://chir.georgetown.edu/embedded-deductibles-and-how-they-work/)
- [U.S. Dept. of Labor / CMS — ACA & CAA Implementation FAQs Part 60](https://www.dol.gov/agencies/ebsa/about-ebsa/our-activities/resource-center/faqs/aca-part-60) (cost-sharing definition, 45 CFR 156.130)
- [CMS — 2027 Payment Parameters guidance](https://www.cms.gov/files/document/2027-papi-parameters-guidance-2026-01-29.pdf) and [revised 2026 ACA cost-sharing limits](https://blog.nisbenefits.com/cost-sharing-limits-revised-2026-plan-years)
- [IRS Rev. Proc. 2025-19 via Thomson Reuters — 2026 HSA/HDHP limits](https://tax.thomsonreuters.com/news/irs-announces-2026-hsa-and-ebhra-contribution-limits-hdhp-minimum-deductibles-and-hdhp-out-of-pocket-maximums/)
- [DataPath — Qualified HDHPs, Deductibles, and HSAs](https://dpath.com/hdhps-embedded-deductibles-hsas/) (embedded-deductible HSA rule)
- [UHCprovider.com — Designated Diagnostic Provider program](https://www.uhcprovider.com/en/reports-quality-programs/designated-diagnostic-provider.html) ([lab](https://www.uhcprovider.com/en/reports-quality-programs/designated-diagnostic-provider/designated-diagnostic-provider-lab.html), [imaging](https://www.uhcprovider.com/en/reports-quality-programs/designated-diagnostic-provider/designated-diagnostic-provider-imaging.html))
- [CFPB — What is a surprise medical bill / No Surprises Act](https://www.consumerfinance.gov/ask-cfpb/what-is-a-surprise-medical-bill-and-what-should-i-know-about-the-no-surprises-act-en-2123/) and [Minnesota Dept. of Health — No Surprises Act protections](https://www.health.state.mn.us/facilities/insurance/managedcare/faq/nosurprisesact.html)
- [KFF — Ground Ambulance Rides and Potential for Surprise Billing](https://www.kff.org/private-insurance/ground-ambulance-rides-and-potential-for-surprise-billing/)
- [Congressional Research Service — The ACA Preventive Services Coverage Requirement](https://www.congress.gov/crs-product/IF13010) and [KFF — Preventive Services Covered by Private Health Plans](https://www.kff.org/womens-health-policy/preventive-services-covered-by-private-health-plans/)
- [Cigna — Embedded Out-of-Pocket Maximum](https://www.cigna.com/employers/insights/informed-on-reform/embedded-oop-customer-impacts) (2016 embedding requirement)

### §2.8 — billed-charge ceilings

- [Bai & Anderson — Extreme Markup: The Fifty US Hospitals With The Highest Charge-To-Cost Ratios, *Health Affairs*](https://www.healthaffairs.org/doi/10.1377/hlthaff.2014.1414) (~10× vs. national average 3.4×, mode 2.4×)
- [CareRoute — CPT 99205 cost: 2026 Medicare rate vs. average charge](https://www.careroute.ai/costs/cpt/99205) ($236.81 Medicare office rate; $534.53 average billed charge from 2023 CMS utilization data)
- [FAIR Health — FH Healthcare Indicators and FH Medical Price Index white paper](https://s3.amazonaws.com/media2.fairhealth.org/whitepaper/asset/FH%20Medical%20Price%20Index%20and%20FH%20Healthcare%20Indicators--white%20paper.pdf) (99205 median charge $484)
- [U.S. PIRG — Facility fees are driving up the prices of doctor visits](https://pirg.org/edfund/articles/facility-fees-are-driving-up-the-prices-of-doctor-visits/) and [InvestigateTV — Costly Care: surprise facility fees from hospital-owned clinics](https://www.investigatetv.com/2026/07/06/costly-care-patients-say-surprise-facility-fees-hospital-owned-clinics-add-hundreds-routine-doctor-visits/) ($488 and $503 routine-visit examples; hospital-owned offices +26%)
- [GoodRx — Facility Fees: What Are They and Can You Fight Them?](https://www.goodrx.com/health-topic/finance/what-is-facility-fee) (typical $100–$500 range)
