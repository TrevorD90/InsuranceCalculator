/**
 * Plan schema, normalizer, regulatory validator, and the five seed plans.
 *
 * Pure — no DOM, no I/O, no electron import. Shapes are specified in ARCHITECTURE §4.
 */

import { BENEFIT_KEYS, BENEFIT_META, NSA_PROTECTED } from './engine.mjs';

export const PLAN_COLORS = ['#2E6FD9', '#0E8A6E', '#8B4FC9', '#B4642A', '#C0392B'];

/* ------------------------------------------------- 2026 regulatory constants */
/* Seed coverage period is 06/01/26–05/31/27, so 2026 limits apply. COST-MODEL §3.  */

export const LIMITS_2026 = {
  acaOopMax:      { individual: 10600, family: 21200 },
  hdhpMinDeduct:  { individual: 1700,  family: 3400 },
  hdhpMaxOop:     { individual: 8500,  family: 17000 }
};

/* ------------------------------------------------------- benefit constructors */

export const coins = (rate, deductibleFirst = true, extra = {}) =>
  ({ mode: 'coinsurance', coinsurance: rate, deductibleFirst, balanceBillable: true, ...extra });

export const copay = (amount, deductibleFirst = false, extra = {}) =>
  ({ mode: 'copay', copay: amount, deductibleFirst, balanceBillable: true, ...extra });

export const free = () => ({ mode: 'noCharge', deductibleFirst: false, balanceBillable: true });

export const notCovered = () => ({ mode: 'notCovered' });

/* ------------------------------------------------------------- normalization */

function normBenefit(b, fallback) {
  if (!b || typeof b !== 'object') return { ...fallback };
  const mode = ['copay', 'coinsurance', 'noCharge', 'notCovered'].includes(b.mode) ? b.mode : fallback.mode;
  const out = { mode };
  if (mode === 'copay') out.copay = Math.max(0, Number(b.copay) || 0);
  if (mode === 'coinsurance') out.coinsurance = Math.min(1, Math.max(0, Number(b.coinsurance) || 0));
  if (mode !== 'notCovered') {
    out.deductibleFirst = b.deductibleFirst !== undefined ? !!b.deductibleFirst : !!fallback.deductibleFirst;
    out.balanceBillable = b.balanceBillable !== undefined ? !!b.balanceBillable : true;
  }
  return out;
}

function normLimitPair(v, fallback = { individual: 0, family: 0 }) {
  if (v == null) return null;
  if (typeof v === 'number') return { individual: v, family: v * 2 };
  return {
    individual: Math.max(0, Number(v.individual) || fallback.individual),
    family: Math.max(0, Number(v.family) || fallback.family)
  };
}

export function blankPlan(index = 0) {
  const benefits = {};
  for (const key of BENEFIT_KEYS) {
    benefits[key] = { in: coins(0.2), out: coins(0.4) };
  }
  benefits.preventive = { in: free(), out: coins(0.4) };

  return {
    id: `plan_${index}_${Math.random().toString(36).slice(2, 8)}`,
    name: `Plan ${String.fromCharCode(65 + (index % 26))}`,
    carrier: '',
    color: PLAN_COLORS[index % PLAN_COLORS.length],
    monthlyPremium: 0,
    isHSA: false,

    tiers: {
      in:  { deductible: { individual: 0, family: 0 }, oopMax: { individual: 0, family: 0 } },
      out: { deductible: { individual: 0, family: 0 }, oopMax: { individual: 0, family: 0 } }
    },

    familyDeductibleMode: 'embedded',   // DEDUCTIBLE ONLY. The individual OOP max is always
                                        // embedded — see COST-MODEL §4.4.
    combinedAccumulators: false,
    copaysCountToOOP: true,
    erCopayWaivedIfAdmitted: true,
    pharmacyDeductible: null,           // {individual, family} when the plan has a separate one
    balanceBilling: true,

    negotiatedPct: 0.55,
    oonAllowedPct: 0.50,

    benefits,
    source: 'manual',
    notes: '',
    unread: []
  };
}

/**
 * Normalize arbitrary input — hand-edited, imported from a workspace file, or extracted from a
 * PDF by Claude — into a complete, well-formed plan. Never throws; missing fields fall back.
 */
export function normalizePlan(raw, index = 0) {
  const base = blankPlan(index);
  const p = raw && typeof raw === 'object' ? raw : {};

  const plan = {
    ...base,
    ...p,
    id: p.id || base.id,
    name: p.name || base.name,
    carrier: p.carrier || '',
    color: p.color || PLAN_COLORS[index % PLAN_COLORS.length],
    monthlyPremium: Math.max(0, Number(p.monthlyPremium) || 0),
    isHSA: !!p.isHSA,

    familyDeductibleMode: p.familyDeductibleMode === 'aggregate' ? 'aggregate' : 'embedded',
    combinedAccumulators: !!p.combinedAccumulators,
    copaysCountToOOP: p.copaysCountToOOP !== false,
    erCopayWaivedIfAdmitted: p.erCopayWaivedIfAdmitted !== false,
    balanceBilling: p.balanceBilling !== false,

    negotiatedPct: clampPct(p.negotiatedPct, base.negotiatedPct),
    oonAllowedPct: clampPct(p.oonAllowedPct, base.oonAllowedPct),

    source: p.source || 'manual',
    notes: p.notes || '',
    unread: Array.isArray(p.unread) ? p.unread : []
  };

  const t = p.tiers || {};
  plan.tiers = {
    in: {
      deductible: normLimitPair(t.in?.deductible) || base.tiers.in.deductible,
      oopMax: normLimitPair(t.in?.oopMax) || base.tiers.in.oopMax
    },
    // null out tier means no out-of-network coverage at all (EPO)
    out: t.out === null ? null : {
      deductible: normLimitPair(t.out?.deductible) || base.tiers.out.deductible,
      oopMax: normLimitPair(t.out?.oopMax) || base.tiers.out.oopMax
    }
  };

  plan.pharmacyDeductible = normLimitPair(p.pharmacyDeductible);

  const src = p.benefits || {};
  plan.benefits = {};
  for (const key of BENEFIT_KEYS) {
    const b = src[key] || {};
    const fallbackIn = key === 'preventive' ? free() : coins(0.2);
    const fallbackOut = plan.tiers.out === null ? notCovered() : coins(0.4);

    const entry = {
      in: normBenefit(b.in, fallbackIn),
      out: normBenefit(b.out, fallbackOut)
    };
    if (b.designated) entry.designated = normBenefit(b.designated, entry.in);

    // The No Surprises Act is not a plan option (COST-MODEL §4.1). Force it on the
    // benefits it protects, no matter what the document or the extraction said.
    if (NSA_PROTECTED.has(key)) {
      for (const tier of ['in', 'out', 'designated']) {
        if (entry[tier] && entry[tier].mode !== 'notCovered') entry[tier].balanceBillable = false;
      }
    }
    plan.benefits[key] = entry;
  }

  return plan;
}

function clampPct(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
  return n;
}

/* ---------------------------------------------------------------- validation */

/**
 * Non-blocking regulatory sanity checks (COST-MODEL §4.5). These exist mostly to catch
 * AI-extraction errors, which otherwise produce a confidently wrong comparison with no signal.
 * Returns [{level, message}] — never throws, never blocks the user.
 */
export function validatePlan(plan) {
  const out = [];
  const warn = (message) => out.push({ level: 'warn', message });
  const info = (message) => out.push({ level: 'info', message });

  const inT = plan.tiers.in;

  if (!(plan.monthlyPremium > 0)) {
    info('No monthly premium entered — the comparison is meaningless until this is filled in.');
  }

  if (inT.oopMax.individual > LIMITS_2026.acaOopMax.individual) {
    warn(`In-network individual out-of-pocket maximum exceeds the 2026 ACA limit of $${LIMITS_2026.acaOopMax.individual.toLocaleString()}.`);
  }
  if (inT.oopMax.family > LIMITS_2026.acaOopMax.family) {
    warn(`In-network family out-of-pocket maximum exceeds the 2026 ACA limit of $${LIMITS_2026.acaOopMax.family.toLocaleString()}.`);
  }
  if (inT.deductible.individual > inT.oopMax.individual && inT.oopMax.individual > 0) {
    warn('In-network individual deductible is higher than the individual out-of-pocket maximum.');
  }
  if (inT.deductible.family > inT.oopMax.family && inT.oopMax.family > 0) {
    warn('In-network family deductible is higher than the family out-of-pocket maximum.');
  }

  if (plan.isHSA) {
    const { hdhpMinDeduct, hdhpMaxOop } = LIMITS_2026;
    if (inT.deductible.family < hdhpMinDeduct.family) {
      warn(`Marked HSA but the family deductible is below the 2026 HDHP minimum of $${hdhpMinDeduct.family.toLocaleString()}.`);
    }
    if (inT.oopMax.family > hdhpMaxOop.family) {
      warn(`Marked HSA but the family out-of-pocket maximum exceeds the 2026 HDHP limit of $${hdhpMaxOop.family.toLocaleString()}.`);
    }
    // The rule that explains the two seed HSA plans — COST-MODEL §2.5.
    if (plan.familyDeductibleMode === 'embedded' && inT.deductible.individual < hdhpMinDeduct.family) {
      warn(`Marked HSA with an embedded individual deductible of $${inT.deductible.individual.toLocaleString()}, below the $${hdhpMinDeduct.family.toLocaleString()} family minimum. An HDHP embedding an individual deductible must embed at least the family minimum, so this plan would not be HSA-qualified.`);
    }
  }

  if (plan.copaysCountToOOP === false) {
    warn('Copays are set not to count toward the out-of-pocket maximum. For in-network essential health benefits this is not permitted in a non-grandfathered plan.');
  }

  return out;
}

/* ---------------------------------------------------------------- seed plans */

/** Apply one benefit across a list of keys. */
function set(benefits, keys, value) {
  for (const k of keys) benefits[k] = typeof value === 'function' ? value(k) : { ...value };
}

const ALL_MEDICAL = BENEFIT_KEYS.filter((k) => !k.startsWith('rx'));

/**
 * Plan 1 — Choice Plus ES2P / L81S HSA (POS), file BD-5OYB37.
 * HSA: the deductible applies to everything except preventive, including every copay and
 * every prescription tier. Family deductible is AGGREGATE — which is exactly what keeps a
 * $1,700 individual figure HSA-qualified (COST-MODEL §2.5).
 */
function planES2P() {
  const p = blankPlan(0);
  Object.assign(p, {
    id: 'seed_es2p',
    name: 'Choice Plus ES2P / L81S HSA',
    carrier: 'UnitedHealthcare',
    isHSA: true,
    familyDeductibleMode: 'aggregate',
    source: 'seed',
    tiers: {
      in:  { deductible: { individual: 1700, family: 3400 }, oopMax: { individual: 3000, family: 6000 } },
      out: { deductible: { individual: 5000, family: 10000 }, oopMax: { individual: 10000, family: 20000 } }
    },
    notes: 'HSA plan (POS). The deductible applies to everything except preventive care, including every copay and every prescription tier. Family deductible is aggregate: the whole $3,400 must be met before the plan pays for anyone.'
  });

  const b = p.benefits;
  const OUT = () => coins(0.5, true);
  set(b, ALL_MEDICAL, () => ({ in: coins(0.5, true), out: OUT() }));

  // HSA: deductibleFirst is true on every in-network benefit except preventive.
  b.preventive             = { in: free(),              out: OUT() };
  b.pcp                    = { in: copay(30, true),     out: OUT() };
  b.specialist             = { in: copay(60, true),     out: OUT() };
  b.mhOutpatient           = { in: copay(60, true),     out: OUT() };
  b.mhInpatient            = { in: copay(1200, true),   out: OUT() };
  b.urgentCare             = { in: copay(75, true),     out: OUT() };
  b.er                     = { in: copay(500, true),    out: copay(500, true) };
  b.ambulance              = { in: coins(0, true),      out: coins(0, true) };
  b.labs                   = { designated: copay(40, true), in: coins(0.5, true), out: OUT() };
  b.xray                   = { in: copay(40, true),     out: OUT() };
  b.imaging                = { designated: copay(300, true), in: copay(750, true), out: OUT() };
  b.outpatientFacility     = { in: copay(800, true),    out: OUT() };
  b.outpatientPhysician    = { in: coins(0, true),      out: OUT() };
  b.inpatientFacility      = { in: copay(1200, true),   out: OUT() };
  b.inpatientPhysician     = { in: coins(0, true),      out: OUT() };
  b.rehab                  = { in: copay(30, true),     out: OUT() };
  b.dme                    = { in: coins(0, true),      out: OUT() };
  b.homeHealth             = { in: coins(0, true),      out: OUT() };
  b.skilledNursing         = { in: copay(1200, true),   out: OUT() };
  b.childbirthProfessional = { in: coins(0, true),      out: OUT() };
  b.childbirthFacility     = { in: copay(1200, true),   out: OUT() };

  b.rxTier1     = { in: copay(10, true),  out: copay(10, true) };
  b.rxTier2     = { in: copay(35, true),  out: copay(35, true) };
  b.rxTier3     = { in: copay(60, true),  out: copay(60, true) };
  b.rxSpecialty = { in: copay(150, true), out: notCovered() };

  return p;
}

/**
 * Plan 2 — Choice Plus ESZ9 / Q91S (POS), file BD-Y3ZL9T.
 * Copay categories are NOT subject to the deductible. Family deductible embedded.
 */
function planESZ9() {
  const p = blankPlan(1);
  Object.assign(p, {
    id: 'seed_esz9',
    name: 'Choice Plus ESZ9 / Q91S',
    carrier: 'UnitedHealthcare',
    source: 'seed',
    tiers: {
      in:  { deductible: { individual: 1000, family: 2000 }, oopMax: { individual: 4000, family: 8000 } },
      out: { deductible: { individual: 2000, family: 4000 }, oopMax: { individual: 6250, family: 12500 } }
    },
    notes: 'POS plan. Copay categories are not subject to the deductible. Family deductible is embedded, so one member meeting theirs starts the plan paying for that member.'
  });

  const b = p.benefits;
  const OUT = () => coins(0.2, true);
  set(b, ALL_MEDICAL, () => ({ in: coins(0, true), out: OUT() }));

  b.preventive             = { in: free(),           out: OUT() };
  b.pcp                    = { in: copay(25, false), out: OUT() };
  b.specialist             = { in: copay(50, false), out: OUT() };
  b.mhOutpatient           = { in: copay(50, false), out: OUT() };
  b.mhInpatient            = { in: coins(0, true),   out: OUT() };
  b.urgentCare             = { in: copay(50, false), out: OUT() };
  b.er                     = { in: copay(500, false), out: copay(500, false) };
  b.ambulance              = { in: coins(0, true),   out: coins(0, true) };
  b.labs                   = { designated: copay(25, false), in: coins(0.5, true), out: OUT() };
  b.xray                   = { in: copay(25, false), out: OUT() };
  b.imaging                = { designated: coins(0, true), in: coins(0.5, true), out: OUT() };
  b.outpatientFacility     = { in: coins(0, true),   out: OUT() };
  b.outpatientPhysician    = { in: coins(0, true),   out: OUT() };
  b.inpatientFacility      = { in: coins(0, true),   out: OUT() };
  b.inpatientPhysician     = { in: coins(0, true),   out: OUT() };
  b.rehab                  = { in: copay(25, false), out: OUT() };
  b.dme                    = { in: coins(0, true),   out: OUT() };
  b.homeHealth             = { in: coins(0, true),   out: OUT() };
  b.skilledNursing         = { in: coins(0, true),   out: OUT() };
  b.childbirthProfessional = { in: coins(0, true),   out: OUT() };
  b.childbirthFacility     = { in: coins(0, true),   out: OUT() };

  b.rxTier1     = { in: copay(10, false), out: copay(10, false) };
  b.rxTier2     = { in: copay(45, false), out: copay(45, false) };
  b.rxTier3     = { in: copay(90, false), out: copay(90, false) };
  b.rxSpecialty = { in: copay(150, false), out: notCovered() };

  return p;
}

/**
 * Plan 3 — Choice Plus ES1J / Q92S (POS), file BD-HZW9KC.
 * Same shape as ESZ9, higher deductible and copays. Family deductible embedded.
 */
function planES1J() {
  const p = blankPlan(2);
  Object.assign(p, {
    id: 'seed_es1j',
    name: 'Choice Plus ES1J / Q92S',
    carrier: 'UnitedHealthcare',
    source: 'seed',
    tiers: {
      in:  { deductible: { individual: 2000, family: 6000 }, oopMax: { individual: 5000, family: 10000 } },
      out: { deductible: { individual: 4000, family: 12000 }, oopMax: { individual: 6250, family: 12500 } }
    },
    notes: 'POS plan, same shape as ESZ9 with a higher deductible and copays. Childbirth benefits were not stated in the source summary and are modelled on the inpatient pattern (0% in network).'
  });

  const b = p.benefits;
  const OUT = () => coins(0.2, true);
  set(b, ALL_MEDICAL, () => ({ in: coins(0, true), out: OUT() }));

  b.preventive             = { in: free(),           out: OUT() };
  b.pcp                    = { in: copay(30, false), out: OUT() };
  b.specialist             = { in: copay(60, false), out: OUT() };
  b.mhOutpatient           = { in: copay(60, false), out: OUT() };
  b.mhInpatient            = { in: coins(0, true),   out: OUT() };
  b.urgentCare             = { in: copay(75, false), out: OUT() };
  b.er                     = { in: copay(500, false), out: copay(500, false) };
  b.ambulance              = { in: coins(0, true),   out: coins(0, true) };
  b.labs                   = { designated: copay(25, false), in: coins(0.5, true), out: OUT() };
  b.xray                   = { in: copay(25, false), out: OUT() };
  b.imaging                = { designated: coins(0, true), in: coins(0.5, true), out: OUT() };
  b.outpatientFacility     = { in: coins(0, true),   out: OUT() };
  b.outpatientPhysician    = { in: coins(0, true),   out: OUT() };
  b.inpatientFacility      = { in: coins(0, true),   out: OUT() };
  b.inpatientPhysician     = { in: coins(0, true),   out: OUT() };
  b.rehab                  = { in: copay(30, false), out: OUT() };
  b.dme                    = { in: coins(0, true),   out: OUT() };
  b.homeHealth             = { in: coins(0, true),   out: OUT() };
  b.skilledNursing         = { in: coins(0, true),   out: OUT() };
  b.childbirthProfessional = { in: coins(0, true),   out: OUT() };
  b.childbirthFacility     = { in: coins(0, true),   out: OUT() };

  b.rxTier1     = { in: copay(15, false),  out: copay(15, false) };
  b.rxTier2     = { in: copay(50, false),  out: copay(50, false) };
  b.rxTier3     = { in: copay(100, false), out: copay(100, false) };
  b.rxSpecialty = { in: copay(150, false), out: notCovered() };

  return p;
}

/**
 * Plan 4 — Choice Plus ES1A / Q91S (POS), file BD-96K3UX.
 * Very low deductible, 10% coinsurance in network, 40% out. Family deductible embedded.
 */
function planES1A() {
  const p = blankPlan(3);
  Object.assign(p, {
    id: 'seed_es1a',
    name: 'Choice Plus ES1A / Q91S',
    carrier: 'UnitedHealthcare',
    source: 'seed',
    tiers: {
      in:  { deductible: { individual: 250, family: 750 }, oopMax: { individual: 4000, family: 8000 } },
      out: { deductible: { individual: 500, family: 1500 }, oopMax: { individual: 5750, family: 11500 } }
    },
    notes: 'POS plan. Very low deductible with 10% coinsurance in network and 40% out. Watch this one against ES38 as utilisation rises — the low deductible wins early, the 0% coinsurance wins late.'
  });

  const b = p.benefits;
  const OUT = () => coins(0.4, true);
  set(b, ALL_MEDICAL, () => ({ in: coins(0.1, true), out: OUT() }));

  b.preventive             = { in: free(),           out: OUT() };
  b.pcp                    = { in: copay(25, false), out: OUT() };
  b.specialist             = { in: copay(50, false), out: OUT() };
  b.mhOutpatient           = { in: copay(50, false), out: OUT() };
  b.mhInpatient            = { in: coins(0.1, true), out: OUT() };
  b.urgentCare             = { in: copay(75, false), out: OUT() };
  b.er                     = { in: copay(500, false), out: copay(500, false) };
  b.ambulance              = { in: coins(0.1, true), out: coins(0.1, true) };
  b.labs                   = { designated: copay(25, false), in: coins(0.5, true), out: OUT() };
  b.xray                   = { in: copay(25, false), out: OUT() };
  b.imaging                = { designated: coins(0.1, true), in: coins(0.5, true), out: OUT() };
  b.outpatientFacility     = { in: coins(0.1, true), out: OUT() };
  b.outpatientPhysician    = { in: coins(0.1, true), out: OUT() };
  b.inpatientFacility      = { in: coins(0.1, true), out: OUT() };
  b.inpatientPhysician     = { in: coins(0.1, true), out: OUT() };
  b.rehab                  = { in: copay(25, false), out: OUT() };
  b.dme                    = { in: coins(0.1, true), out: OUT() };
  b.homeHealth             = { in: coins(0.1, true), out: OUT() };
  b.skilledNursing         = { in: coins(0.1, true), out: OUT() };
  b.childbirthProfessional = { in: coins(0.1, true), out: OUT() };
  b.childbirthFacility     = { in: coins(0.1, true), out: OUT() };

  b.rxTier1     = { in: copay(10, false),  out: copay(10, false) };
  b.rxTier2     = { in: copay(45, false),  out: copay(45, false) };
  b.rxTier3     = { in: copay(90, false),  out: copay(90, false) };
  b.rxSpecialty = { in: copay(150, false), out: notCovered() };

  return p;
}

/**
 * Plan 5 — Choice ES38 / L81S HSA (EPO), file BD-SJ0AFF.
 * No out-of-network coverage at all except emergency room and ambulance. HSA, so the
 * deductible applies to everything except preventive. Family deductible EMBEDDED — and the
 * embedded individual figure ($3,400) is exactly the 2026 HDHP family minimum, which is what
 * keeps it HSA-qualified (COST-MODEL §2.5).
 */
function planES38() {
  const p = blankPlan(4);
  Object.assign(p, {
    id: 'seed_es38',
    name: 'Choice ES38 / L81S HSA (EPO)',
    carrier: 'UnitedHealthcare',
    isHSA: true,
    source: 'seed',
    tiers: {
      in:  { deductible: { individual: 3400, family: 6800 }, oopMax: { individual: 6400, family: 12800 } },
      out: null      // EPO — no out-of-network deductible or maximum exists
    },
    notes: 'EPO. No out-of-network coverage at all except emergency room and ambulance. HSA, so the deductible applies to everything except preventive. Out-of-network emergency care is protected by the No Surprises Act and draws against the in-network accumulators.'
  });

  const b = p.benefits;
  set(b, ALL_MEDICAL, () => ({ in: coins(0, true), out: notCovered() }));

  b.preventive             = { in: free(),         out: notCovered() };
  b.er                     = { in: coins(0, true), out: coins(0, true) };
  b.ambulance              = { in: coins(0, true), out: coins(0, true) };
  b.labs                   = { designated: coins(0, true), in: coins(0.5, true), out: notCovered() };
  b.imaging                = { designated: coins(0, true), in: coins(0.5, true), out: notCovered() };

  b.rxTier1     = { in: copay(10, true),  out: notCovered() };
  b.rxTier2     = { in: copay(35, true),  out: notCovered() };
  b.rxTier3     = { in: copay(60, true),  out: notCovered() };
  b.rxSpecialty = { in: copay(150, true), out: notCovered() };

  return p;
}

export function seedPlans() {
  return [planES2P(), planESZ9(), planES1J(), planES1A(), planES38()].map((p, i) => normalizePlan(p, i));
}

/* ------------------------------------------------- household and scenarios */

export function defaultHousehold() {
  return [
    { id: 'm_self', label: 'Me' },
    { id: 'm_spouse', label: 'Spouse' },
    { id: 'm_child', label: 'Child' }
  ];
}

export function makeScenario(benefitKey, { memberId = 'm_self', count = 1, tier = 'in', billed } = {}) {
  const meta = BENEFIT_META[benefitKey] || { label: benefitKey, billed: 250 };
  return {
    id: `sc_${benefitKey}_${tier}_${memberId}_${Math.random().toString(36).slice(2, 6)}`,
    benefitKey,
    label: meta.label,
    memberId,
    billed: billed ?? meta.billed,
    tier,
    count,
    admitted: false
  };
}

/** A moderate year: routine care for everyone, one specialist course, one imaging study. */
export function defaultScenarios() {
  return [
    makeScenario('preventive', { memberId: 'm_self', count: 1 }),
    makeScenario('preventive', { memberId: 'm_spouse', count: 1 }),
    makeScenario('preventive', { memberId: 'm_child', count: 1 }),
    makeScenario('pcp', { memberId: 'm_self', count: 2 }),
    makeScenario('pcp', { memberId: 'm_child', count: 3 }),
    makeScenario('specialist', { memberId: 'm_self', count: 3 }),
    makeScenario('urgentCare', { memberId: 'm_child', count: 1 }),
    makeScenario('labs', { memberId: 'm_self', count: 3, tier: 'designated' }),
    makeScenario('imaging', { memberId: 'm_self', count: 1, tier: 'in' }),
    makeScenario('rxTier1', { memberId: 'm_self', count: 12 }),
    makeScenario('rxTier2', { memberId: 'm_spouse', count: 4 }),
    makeScenario('er', { memberId: 'm_child', count: 0 })
  ];
}

export function normalizeScenario(raw, household) {
  const ids = new Set((household || []).map((m) => m.id));
  const s = raw && typeof raw === 'object' ? raw : {};
  const benefitKey = BENEFIT_KEYS.includes(s.benefitKey) ? s.benefitKey : 'pcp';
  const meta = BENEFIT_META[benefitKey];
  return {
    id: s.id || `sc_${Math.random().toString(36).slice(2, 9)}`,
    benefitKey,
    label: s.label || meta.label,
    memberId: ids.has(s.memberId) ? s.memberId : (household?.[0]?.id || 'm_self'),
    billed: Math.max(0, Number(s.billed) || 0),
    tier: ['designated', 'in', 'out'].includes(s.tier) ? s.tier : 'in',
    count: Math.max(0, Math.min(365, Math.round(Number(s.count) || 0))),
    admitted: !!s.admitted
  };
}
