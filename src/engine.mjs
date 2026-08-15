/**
 * Cost engine — Plan Ledger
 *
 * Pure: given a plan, a household and a year of care, return what the member owes.
 * No DOM, no I/O, no electron import — so `node --test` and the browser both load this file.
 *
 * The rules implemented here are specified in docs/COST-MODEL.md. That document is
 * authoritative: if this file disagrees with it, this file is wrong.
 *
 * Vocabulary (COST-MODEL §1):
 *   billed    the provider's sticker price. Almost nobody pays this.
 *   allowed   the amount the plan recognizes. In network the negotiated rate; out of
 *             network the plan's own allowed amount.
 *   balance   out of network only: billed − allowed, pursued by the provider.
 *             NEVER counts toward the deductible or the out-of-pocket maximum.
 *   member    what the patient owes.
 */

/* ------------------------------------------------------------------ constants */

export const BENEFIT_KEYS = [
  'preventive', 'pcp', 'specialist', 'mhOutpatient', 'mhInpatient', 'urgentCare',
  'er', 'ambulance', 'labs', 'xray', 'imaging', 'outpatientFacility',
  'outpatientPhysician', 'inpatientFacility', 'inpatientPhysician', 'rehab', 'dme',
  'homeHealth', 'skilledNursing', 'childbirthProfessional', 'childbirthFacility',
  'rxTier1', 'rxTier2', 'rxTier3', 'rxSpecialty'
];

/**
 * Display metadata. `billed` seeds a new scenario; `max` bounds its slider — a primary-care
 * slider that runs to $150,000 is useless and a hospital slider that stops at $2,000 is worse.
 * `designated` marks the benefits where a Designated tier is meaningful (COST-MODEL §2.6):
 * UnitedHealthcare's DDP program covers outpatient lab and major imaging only.
 *
 * Office-visit ceilings are roughly twice the realistic worst case, so the slider can always
 * reach a bill you might actually receive. For primary care that worst case is built from
 * published figures — see COST-MODEL §2.8 for the sources:
 *
 *   CPT 99205, the highest-complexity primary care visit
 *     Medicare office rate                      $236.81   (2026)
 *     × extreme-markup hospital ratio, ~10×     $2,368    (Bai & Anderson, Health Affairs)
 *     + high-end hospital facility fee          ~$500     (documented routine-visit examples)
 *     ≈ $2,500 realistic extreme            →   max $5,000
 *
 * The slider maps position to dollars on a square curve, so a higher ceiling costs granularity
 * only at the low end — roughly $5 per tick around a typical $220 charge rather than $1 — and
 * the number field beside it still accepts an exact figure.
 */
export const BENEFIT_META = {
  preventive:             { label: 'Preventive / annual physical', group: 'Office',     billed: 350,   max: 3000 },
  pcp:                    { label: 'Primary care visit',           group: 'Office',     billed: 220,   max: 5000 },
  specialist:             { label: 'Specialist visit',             group: 'Office',     billed: 400,   max: 6000 },
  mhOutpatient:           { label: 'Mental health, outpatient',    group: 'Office',     billed: 250,   max: 3000 },
  mhInpatient:            { label: 'Mental health, inpatient',     group: 'Facility',   billed: 12000, max: 90000 },
  urgentCare:             { label: 'Urgent care',                  group: 'Acute',      billed: 320,   max: 3000 },
  er:                     { label: 'Emergency room',               group: 'Acute',      billed: 3200,  max: 25000 },
  ambulance:              { label: 'Ambulance (ground)',           group: 'Acute',      billed: 1800,  max: 12000 },
  labs:                   { label: 'Lab work',                     group: 'Diagnostic', billed: 260,   max: 3000,  designated: true },
  xray:                   { label: 'X-ray',                        group: 'Diagnostic', billed: 300,   max: 2500 },
  imaging:                { label: 'Imaging (MRI / CT / PET)',     group: 'Diagnostic', billed: 2400,  max: 12000, designated: true },
  outpatientFacility:     { label: 'Outpatient surgery, facility', group: 'Facility',   billed: 9500,  max: 60000 },
  outpatientPhysician:    { label: 'Outpatient surgery, surgeon',  group: 'Facility',   billed: 2200,  max: 20000 },
  inpatientFacility:      { label: 'Inpatient stay, facility',     group: 'Facility',   billed: 28000, max: 200000 },
  inpatientPhysician:     { label: 'Inpatient stay, physician',    group: 'Facility',   billed: 4500,  max: 40000 },
  rehab:                  { label: 'Physical therapy / rehab',     group: 'Therapy',    billed: 220,   max: 2000 },
  dme:                    { label: 'Durable medical equipment',    group: 'Therapy',    billed: 900,   max: 15000 },
  homeHealth:             { label: 'Home health care',             group: 'Therapy',    billed: 1400,  max: 20000 },
  skilledNursing:         { label: 'Skilled nursing facility',     group: 'Facility',   billed: 14000, max: 90000 },
  childbirthProfessional: { label: 'Childbirth, professional',     group: 'Maternity',  billed: 4200,  max: 25000 },
  childbirthFacility:     { label: 'Childbirth, facility',         group: 'Maternity',  billed: 16000, max: 90000 },
  rxTier1:                { label: 'Drug, Tier 1 (generic)',       group: 'Pharmacy',   billed: 40,    max: 400 },
  rxTier2:                { label: 'Drug, Tier 2 (pref. brand)',   group: 'Pharmacy',   billed: 420,   max: 2000 },
  rxTier3:                { label: 'Drug, Tier 3 (non-pref.)',     group: 'Pharmacy',   billed: 750,   max: 4000 },
  rxSpecialty:            { label: 'Drug, specialty',              group: 'Pharmacy',   billed: 3800,  max: 25000 }
};

/**
 * Benefits the No Surprises Act protects from balance billing (COST-MODEL §4.1).
 * Emergency services are protected regardless of where they are delivered, so `er` is
 * unconditional. Cost sharing for a protected out-of-network claim is computed at the
 * IN-NETWORK rate and credited to the IN-NETWORK accumulators.
 *
 * Deliberately NOT in this set:
 *   - `ambulance` — ground ambulance was excluded from the Act and remains the single most
 *     balance-bill-prone service in the list (COST-MODEL §4.2).
 *   - ancillary services (labs, imaging, physician lines) — protected only when delivered at
 *     an in-network facility, a condition this model's single tier field cannot express.
 *     Left balance-billable, which reports the worse case. See ARCHITECTURE §10.
 */
export const NSA_PROTECTED = new Set(['er']);

export const RX_KEYS = new Set(['rxTier1', 'rxTier2', 'rxTier3', 'rxSpecialty']);

export const TIERS = ['designated', 'in', 'out'];

/* -------------------------------------------------------------------- helpers */

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp0 = (n) => (n < 0 ? 0 : n);
const EPS = 1e-9;

/** Which accumulator side a tier draws against. `designated` is in-network care. */
function rawSideFor(tier) {
  return tier === 'out' ? 'out' : 'in';
}

/* --------------------------------------------------------------- accumulators */

export function newAccumulators(household = []) {
  const side = () => ({ deductible: 0, oop: 0, pharmacy: 0 });
  const acc = {
    family: { in: side(), out: side() },
    members: {}
  };
  for (const m of household) {
    acc.members[m.id] = { in: side(), out: side() };
  }
  return acc;
}

function memberBucket(acc, memberId, side) {
  if (!acc.members[memberId]) {
    acc.members[memberId] = {
      in: { deductible: 0, oop: 0, pharmacy: 0 },
      out: { deductible: 0, oop: 0, pharmacy: 0 }
    };
  }
  return acc.members[memberId][side];
}

/** Deductible and OOP limits for one accumulator side, falling back to `in` when a plan
 *  has no out-of-network coverage at all (EPO) or combines its accumulators. */
function limitsFor(plan, side) {
  const t = (side === 'out' && plan.tiers.out) ? plan.tiers.out : plan.tiers.in;
  return { deductible: t.deductible, oopMax: t.oopMax };
}

/**
 * Remaining deductible room.
 *
 * Embedded  — the member's own deductible OR the family deductible, whichever is closer.
 * Aggregate — the family deductible only; an individual meeting theirs changes nothing until
 *             the whole family total is satisfied (COST-MODEL §2.4).
 */
function deductibleRoom(plan, acc, memberId, side, bucket) {
  const limits = limitsFor(plan, side);
  const field = bucket === 'pharmacy' ? 'pharmacy' : 'deductible';
  const caps = bucket === 'pharmacy' ? plan.pharmacyDeductible : limits.deductible;
  if (!caps) return 0;

  const fam = clamp0(caps.family - acc.family[side][field]);
  if (plan.familyDeductibleMode === 'aggregate') return fam;

  const ind = clamp0(caps.individual - memberBucket(acc, memberId, side)[field]);
  return Math.min(ind, fam);
}

/**
 * Remaining out-of-pocket room.
 *
 * ALWAYS embedded. Every non-grandfathered plan must embed the individual out-of-pocket
 * maximum within family coverage, regardless of how its deductible is structured — so this
 * is not switched on familyDeductibleMode (COST-MODEL §4.4).
 */
function oopRoom(plan, acc, memberId, side) {
  const { oopMax } = limitsFor(plan, side);
  const ind = clamp0(oopMax.individual - memberBucket(acc, memberId, side).oop);
  const fam = clamp0(oopMax.family - acc.family[side].oop);
  return Math.min(ind, fam);
}

/* ------------------------------------------------------------ benefit lookup */

const DEFAULT_BENEFIT = { mode: 'coinsurance', coinsurance: 0.5, deductibleFirst: true, balanceBillable: true };

/**
 * Resolve a benefit for a service and tier, with the designated → in → out fallback chain
 * from COST-MODEL §2.6. Returns the benefit and the tier actually used, so callers can tell
 * whether a designated request fell back.
 */
export function resolveBenefit(plan, benefitKey, tier) {
  const svc = plan.benefits[benefitKey];
  if (!svc) return { benefit: DEFAULT_BENEFIT, tierUsed: tier === 'out' ? 'out' : 'in' };

  if (tier === 'designated') {
    if (svc.designated) return { benefit: svc.designated, tierUsed: 'designated' };
    return { benefit: svc.in, tierUsed: 'in' };
  }
  if (tier === 'out') return { benefit: svc.out || DEFAULT_BENEFIT, tierUsed: 'out' };
  return { benefit: svc.in, tierUsed: 'in' };
}

/* -------------------------------------------------------------- availability */

/**
 * Can this plan actually deliver this service at this tier — and if not, why not?
 *
 * Comparison is only honest when a plan that *cannot* do something says so in words. A plan
 * with no out-of-network coverage still produces a number (the member owes the whole billed
 * charge), and that number sitting beside a covered plan's $40 copay reads like a price rather
 * than like being on your own.
 *
 * Statuses:
 *   covered     — priced normally
 *   unavailable — the plan does not cover this at this tier; the member owes the full charge
 *   notStated   — an AI-extracted plan whose source document did not state this benefit.
 *                 Distinct from "not covered": we do not know, rather than knowing it is a no.
 *   fallback    — a Designated tier was asked for and this plan defines none, so it is priced
 *                 at the in-network rate. Still covered, but not the tier that was requested.
 */
export function benefitAvailability(plan, benefitKey, tier) {
  const requested = TIERS.includes(tier) ? tier : 'in';

  // "The document didn't say" outranks everything below it — a default we invented must never
  // be presented as though the plan stated it.
  if (plan.source === 'ai' && Array.isArray(plan.unread) && plan.unread.includes(benefitKey)) {
    return {
      status: 'notStated',
      label: 'Not stated',
      detail: 'The source document did not state this benefit. Check it against the PDF.'
    };
  }

  if (!plan.benefits?.[benefitKey]) return { status: 'covered', label: '', detail: '' };

  const { benefit, tierUsed } = resolveBenefit(plan, benefitKey, requested);

  if (benefit.mode === 'notCovered') {
    const noOutTier = requested === 'out' && !plan.tiers.out;
    return {
      status: 'unavailable',
      label: noOutTier ? 'Unavailable' : 'Not covered',
      detail: noOutTier
        ? 'This plan has no out-of-network coverage, so you would owe the entire billed charge and none of it counts toward any limit.'
        : 'This plan does not cover this service at this tier. You would owe the entire billed charge and none of it counts toward any limit.'
    };
  }

  if (requested === 'designated' && tierUsed !== 'designated') {
    return {
      status: 'fallback',
      label: 'No Designated tier',
      detail: 'This plan defines no Designated provider benefit for this service, so it is priced at the regular in-network rate.'
    };
  }

  return { status: 'covered', label: '', detail: '' };
}

/**
 * Say, in plain words, what this plan actually does for this service at this tier.
 *
 * Needed because the member's cost alone is ambiguous. Out of network before the deductible is
 * met, a plan that covers a service at 40% coinsurance and a plan that does not cover it at all
 * produce the *same* member figure — the whole billed charge — for opposite reasons. One is
 * putting $200 toward your deductible and will pay $120 of the next visit; the other will never
 * pay anything. Only the terms distinguish them.
 *
 * Coinsurance is stated from both sides ("you pay 40%, plan pays 60%") because the member share
 * convention is the single most misread number in a plan document.
 */
export function describeBenefit(plan, benefitKey, tier) {
  const requested = TIERS.includes(tier) ? tier : 'in';

  const avail = benefitAvailability(plan, benefitKey, requested);
  if (avail.status === 'notStated') return 'Not stated in the plan document';

  const { benefit } = resolveBenefit(plan, benefitKey, requested);
  const parts = [];

  if (benefit.mode === 'notCovered') return 'Not covered — you owe the whole charge';

  if (benefit.mode === 'noCharge') {
    parts.push('Covered in full');
  } else if (benefit.mode === 'copay') {
    parts.push(`You pay a $${Math.round(benefit.copay || 0)} copay`);
    parts.push(benefit.deductibleFirst ? 'after the deductible' : 'deductible does not apply');
  } else if (benefit.mode === 'coinsurance') {
    const you = Math.round((benefit.coinsurance || 0) * 100);
    parts.push(you === 0 ? 'Plan pays 100%' : `You pay ${you}%, plan pays ${100 - you}%`);
    parts.push(benefit.deductibleFirst ? 'after the deductible' : 'deductible does not apply');
  }

  if (requested === 'out') {
    if (NSA_PROTECTED.has(benefitKey)) {
      parts.push('no balance billing — protected by law');
    } else if (plan.balanceBilling !== false && benefit.balanceBillable !== false) {
      parts.push('plus balance billing, which nothing caps');
    }
  }

  return parts.join(' · ');
}

/* ------------------------------------------------------------------- pricing */

/**
 * Price one encounter against the current accumulators. Mutates `acc`.
 * Returns a full ledger line so the interface can explain itself rather than just show a total.
 *
 * Order of operations is specified in COST-MODEL §2.1 and drawn in DATA-FLOW §3.
 */
export function applyEvent(plan, acc, event) {
  const memberId = event.memberId || '_self';
  const requestedTier = TIERS.includes(event.tier) ? event.tier : 'in';
  const billed = clamp0(Number(event.billed) || 0);

  // Judged on the service that was asked for, before any ER→inpatient swap below.
  const availability = benefitAvailability(plan, event.benefitKey, requestedTier);

  let benefitKey = event.benefitKey;
  let { benefit, tierUsed } = resolveBenefit(plan, benefitKey, requestedTier);
  let note = '';

  // An ER visit that becomes an admission: the emergency copay is waived and the stay is
  // priced on inpatient facility terms instead.
  if (benefitKey === 'er' && event.admitted && plan.erCopayWaivedIfAdmitted) {
    benefitKey = 'inpatientFacility';
    ({ benefit, tierUsed } = resolveBenefit(plan, benefitKey, requestedTier));
    note = 'Admitted — emergency copay waived, priced as an inpatient stay.';
  }

  // No Surprises Act: a protected out-of-network claim cannot be balance billed, prices at
  // the in-network rate, and credits the in-network accumulators (COST-MODEL §4.1).
  const nsaProtected = NSA_PROTECTED.has(event.benefitKey) && requestedTier === 'out';

  let side = rawSideFor(tierUsed);
  if (plan.combinedAccumulators) side = 'in';
  if (nsaProtected) side = 'in';
  if (side === 'out' && !plan.tiers.out) side = 'in';   // EPO: nowhere else for it to go

  const line = {
    benefitKey: event.benefitKey,
    label: event.label || BENEFIT_META[event.benefitKey]?.label || event.benefitKey,
    memberId,
    tier: requestedTier,
    tierUsed,
    side,
    billed: round2(billed),
    allowed: 0,
    deductible: 0,
    coinsurance: 0,
    copay: 0,
    balanceBilled: 0,
    uncovered: 0,
    memberTotal: 0,
    planPaid: 0,
    countedToOOP: 0,
    nsaProtected,
    availability,
    note
  };

  /* --- not covered: full sticker price, accrues to nothing anywhere ----------- */
  if (benefit.mode === 'notCovered') {
    line.uncovered = round2(billed);
    line.memberTotal = round2(billed);
    line.note = 'Not covered. The full charge is yours and none of it counts toward any limit.';
    return line;
  }

  /* --- allowed amount and balance bill --------------------------------------- */
  // Protected claims price at the in-network negotiated rate even out of network.
  const rate = (requestedTier === 'out' && !nsaProtected) ? plan.oonAllowedPct : plan.negotiatedPct;
  const allowed = round2(billed * rate);
  line.allowed = allowed;

  const canBalanceBill =
    requestedTier === 'out' &&
    !nsaProtected &&
    plan.balanceBilling !== false &&
    benefit.balanceBillable !== false;

  if (canBalanceBill) {
    line.balanceBilled = round2(clamp0(billed - allowed));
  }

  /* --- covered in full ------------------------------------------------------- */
  if (benefit.mode === 'noCharge') {
    line.memberTotal = line.balanceBilled;
    line.planPaid = allowed;
    if (!line.note) line.note = 'Covered in full.';
    line.deductibleAfter = memberBucket(acc, memberId, side).deductible;
    line.oopAfter = memberBucket(acc, memberId, side).oop;
    return line;
  }

  /* --- deductible ------------------------------------------------------------ */
  const bucket = (RX_KEYS.has(benefitKey) && plan.pharmacyDeductible) ? 'pharmacy' : 'medical';
  let remaining = allowed;

  if (benefit.deductibleFirst) {
    const room = deductibleRoom(plan, acc, memberId, side, bucket);
    const draw = Math.min(remaining, room);
    line.deductible = round2(draw);
    remaining = round2(remaining - draw);
  }

  /* --- copay or coinsurance on whatever is left of the same claim ------------ */
  if (benefit.mode === 'copay') {
    line.copay = round2(Math.min(benefit.copay || 0, remaining));
  } else if (benefit.mode === 'coinsurance') {
    line.coinsurance = round2(remaining * (benefit.coinsurance || 0));
  }

  /* --- out-of-pocket maximum ------------------------------------------------- */
  // Balance billing and non-covered charges are excluded by statute and never appear here.
  const copayCounts = plan.copaysCountToOOP !== false;
  let countable = round2(line.deductible + line.coinsurance + (copayCounts ? line.copay : 0));
  const room = oopRoom(plan, acc, memberId, side);

  if (countable > room + EPS) {
    // Forgive coinsurance first, then copays, then the deductible. The member's total is the
    // same whichever order we use — the cap is on the sum — but forgiving the deductible last
    // minimises how often the ledger has to be rewound (COST-MODEL §4.6).
    let excess = round2(countable - room);
    for (const field of ['coinsurance', 'copay', 'deductible']) {
      if (excess <= EPS) break;
      if (field === 'copay' && !copayCounts) continue;   // not countable, so not forgivable here
      const take = Math.min(excess, line[field]);
      line[field] = round2(line[field] - take);
      excess = round2(excess - take);
    }
    countable = room;
    line.note = line.note || 'Out-of-pocket maximum reached. The plan covers the rest.';
  }

  /* --- credit the accumulators ----------------------------------------------- */
  // line.deductible is post-forgiveness, so the member is only ever credited with money they
  // actually paid. This is the "rewind" from COST-MODEL §4.6, done by construction.
  const dedField = bucket === 'pharmacy' ? 'pharmacy' : 'deductible';
  if (line.deductible > 0) {
    memberBucket(acc, memberId, side)[dedField] = round2(memberBucket(acc, memberId, side)[dedField] + line.deductible);
    acc.family[side][dedField] = round2(acc.family[side][dedField] + line.deductible);
  }
  if (countable > 0) {
    memberBucket(acc, memberId, side).oop = round2(memberBucket(acc, memberId, side).oop + countable);
    acc.family[side].oop = round2(acc.family[side].oop + countable);
  }

  line.countedToOOP = round2(countable);
  line.memberTotal = round2(line.deductible + line.coinsurance + line.copay + line.balanceBilled);
  line.planPaid = round2(clamp0(allowed - line.deductible - line.coinsurance - line.copay));
  line.deductibleAfter = memberBucket(acc, memberId, side)[dedField];
  line.oopAfter = memberBucket(acc, memberId, side).oop;

  return line;
}

/* ---------------------------------------------------------------- simulation */

/**
 * Expand scenarios into individual events, interleaved round-robin rather than batched.
 * A year that uses one benefit twelve times before touching anything else draws the
 * deductible down in an order no real year does.
 *
 * Known property: the result depends on the order the scenario rows are listed in.
 * See COST-MODEL §4.7 — accepted deliberately, revisit if it ever bites.
 */
export function expandYear(scenarios) {
  const queues = scenarios
    .filter((s) => (Number(s.count) || 0) > 0)
    .map((s) => ({ s, left: Math.min(Math.round(Number(s.count) || 0), 500) }));

  const events = [];
  while (queues.some((q) => q.left > 0)) {
    for (const q of queues) {
      if (q.left > 0) { events.push({ ...q.s }); q.left -= 1; }
    }
  }
  return events;
}

export function simulatePlan(plan, scenarios, household = []) {
  const acc = newAccumulators(household);
  const lines = expandYear(scenarios).map((e) => applyEvent(plan, acc, e));

  const sum = (f) => round2(lines.reduce((t, l) => t + (l[f] || 0), 0));
  const premiums = round2((Number(plan.monthlyPremium) || 0) * 12);
  const memberCare = sum('memberTotal');

  // Per-member roll-up, so the UI can show who drove the year.
  const byMember = {};
  for (const l of lines) {
    if (!byMember[l.memberId]) byMember[l.memberId] = { memberTotal: 0, visits: 0 };
    byMember[l.memberId].memberTotal = round2(byMember[l.memberId].memberTotal + l.memberTotal);
    byMember[l.memberId].visits += 1;
  }

  return {
    planId: plan.id,
    lines,
    byMember,
    accumulators: acc,

    premiums,
    deductiblePaid: sum('deductible'),
    coinsurancePaid: sum('coinsurance'),
    copayPaid: sum('copay'),
    balanceBilled: sum('balanceBilled'),
    uncovered: sum('uncovered'),

    billedTotal: sum('billed'),
    allowedTotal: sum('allowed'),
    planPaid: sum('planPaid'),

    memberCare,
    totalAnnual: round2(premiums + memberCare),
    netBenefit: round2(sum('planPaid') - premiums),
    worstCase: round2(premiums + (plan.tiers.in.oopMax.family || 0)),

    premiumMissing: !(Number(plan.monthlyPremium) > 0)
  };
}

export function compare(plans, scenarios, household = []) {
  const results = plans.map((p) => simulatePlan(p, scenarios, household));
  if (!results.length) return results;

  const best = results.reduce((a, b) => (b.totalAnnual < a.totalAnnual ? b : a), results[0]);
  for (const r of results) {
    r.isBest = r.planId === best.planId;
    r.deltaVsBest = round2(r.totalAnnual - best.totalAnnual);
  }
  return results.slice().sort((a, b) => a.totalAnnual - b.totalAnnual);
}

/**
 * The three-state readout from COST-MODEL §1: what one visit costs before the deductible,
 * after it, and after the out-of-pocket maximum. Priced against frozen accumulator states,
 * so it never mutates a real simulation.
 */
export function marginalCosts(plan, scenario) {
  const memberId = scenario.memberId || '_self';
  const event = { ...scenario, memberId, count: 1 };
  const side = rawSideFor(scenario.tier === 'out' ? 'out' : 'in');
  const limits = limitsFor(plan, side);

  /**
   * Fill the accumulators to a named point in the year.
   *
   * Individual and family ledgers are set from their OWN limits. Writing the family deductible
   * into the individual ledger — and then deriving the individual out-of-pocket total from it —
   * silently turns "after the deductible" into "after the out-of-pocket maximum" on any plan
   * whose family deductible is at least its individual maximum, which is five of the nine seed
   * plan/tier combinations. The middle column then reports $0 for visits that really cost a
   * copay.
   */
  const stateAt = ({ deductibleMet, oop }) => {
    const acc = newAccumulators([{ id: memberId }]);

    for (const s of ['in', 'out']) {
      const l = limitsFor(plan, s);
      const ind = deductibleMet ? l.deductible.individual : 0;
      const fam = deductibleMet ? l.deductible.family : 0;

      acc.members[memberId][s].deductible = ind;
      acc.members[memberId][s].pharmacy = ind;
      acc.family[s].deductible = fam;
      acc.family[s].pharmacy = fam;

      // Meeting a deductible also credits that much to the out-of-pocket maximum — but only
      // that much. Clamped so a large deductible cannot overshoot the ceiling.
      acc.members[memberId][s].oop = oop === 'max'
        ? l.oopMax.individual
        : Math.min(ind, l.oopMax.individual);
      acc.family[s].oop = oop === 'max'
        ? l.oopMax.family
        : Math.min(fam, l.oopMax.family);
    }
    return acc;
  };

  return {
    beforeDeductible: applyEvent(plan, stateAt({ deductibleMet: false, oop: 'none' }), event),
    afterDeductible: applyEvent(plan, stateAt({ deductibleMet: true, oop: 'deductible' }), event),
    afterOopMax: applyEvent(plan, stateAt({ deductibleMet: true, oop: 'max' }), event)
  };
}

export const fmt = (n) =>
  (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
