/**
 * Engine tests — `npm test` (node --test, no framework dependency).
 *
 * The 17 numbered tests are the ones named in the build prompt. The lettered tests after them
 * cover the four corrections in docs/COST-MODEL.md §4, which the prompt got wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEvent, newAccumulators, expandYear, simulatePlan, compare, resolveBenefit,
  benefitAvailability, describeBenefit, marginalCosts, BENEFIT_META, round2
} from '../src/engine.mjs';

import {
  blankPlan, normalizePlan, seedPlans, validatePlan, makeScenario,
  coins, copay, free, notCovered
} from '../src/plans.mjs';

/* ------------------------------------------------------------------ fixtures */

const HH = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];

/** A plain plan with round numbers, so assertions read as arithmetic rather than trivia. */
function testPlan(over = {}) {
  const p = blankPlan(0);
  Object.assign(p, {
    id: 'p', name: 'T', monthlyPremium: 100,
    negotiatedPct: 1,          // allowed === billed, unless a test says otherwise
    oonAllowedPct: 0.5,
    tiers: {
      in:  { deductible: { individual: 1000, family: 2000 }, oopMax: { individual: 3000, family: 6000 } },
      out: { deductible: { individual: 2000, family: 4000 }, oopMax: { individual: 6000, family: 12000 } }
    },
    ...over
  });
  return normalizePlan(p);
}

const ev = (o) => ({ memberId: 'a', tier: 'in', count: 1, ...o });

/* ============================================================================
   The 17 tests named in the build prompt
   ========================================================================== */

test('1. coinsurance is charged on the allowed amount, not the billed amount', () => {
  const plan = testPlan({
    negotiatedPct: 0.55,
    benefits: { specialist: { in: coins(0.2, false), out: coins(0.4, true) } }
  });
  const acc = newAccumulators(HH);
  const line = applyEvent(plan, acc, ev({ benefitKey: 'specialist', billed: 1000 }));

  assert.equal(line.allowed, 550, 'allowed is 55% of billed');
  assert.equal(line.coinsurance, 110, '20% of the $550 allowed, not of the $1,000 billed');
  assert.notEqual(line.coinsurance, 200);
});

test('2. the deductible absorbs a claim first, coinsurance applies only to the remainder', () => {
  const plan = testPlan({ benefits: { labs: { in: coins(0.2, true), out: coins(0.4, true) } } });
  const acc = newAccumulators(HH);

  const first = applyEvent(plan, acc, ev({ benefitKey: 'labs', billed: 600 }));
  assert.equal(first.deductible, 600, 'entirely deductible');
  assert.equal(first.coinsurance, 0);
  assert.equal(first.memberTotal, 600);

  const second = applyEvent(plan, acc, ev({ benefitKey: 'labs', billed: 600 }));
  assert.equal(second.deductible, 400, 'straddles: $400 finishes the $1,000 deductible');
  assert.equal(second.coinsurance, 40, '20% of the remaining $200 on the same claim');
  assert.equal(second.memberTotal, 440);
});

test('3. a copay marked "deductible does not apply" leaves the deductible untouched', () => {
  const plan = testPlan({ benefits: { pcp: { in: copay(30, false), out: coins(0.4, true) } } });
  const acc = newAccumulators(HH);
  const line = applyEvent(plan, acc, ev({ benefitKey: 'pcp', billed: 220 }));

  assert.equal(line.memberTotal, 30, 'the copay and nothing else');
  assert.equal(line.deductible, 0);
  assert.equal(acc.members.a.in.deductible, 0, 'deductible ledger untouched');
  assert.equal(acc.members.a.in.oop, 30, 'but it does credit the out-of-pocket maximum');
});

test('4. copays are excluded from the OOP max when the plan flag says they do not count', () => {
  const plan = testPlan({
    copaysCountToOOP: false,
    benefits: { pcp: { in: copay(30, false), out: coins(0.4, true) } }
  });
  const acc = newAccumulators(HH);
  acc.members.a.in.oop = 3000;         // individual maximum already reached
  acc.family.in.oop = 3000;

  const line = applyEvent(plan, acc, ev({ benefitKey: 'pcp', billed: 220 }));
  assert.equal(line.copay, 30, 'still owed past the maximum, because it never counted toward it');
  assert.equal(line.countedToOOP, 0);
  assert.equal(acc.members.a.in.oop, 3000, 'and it does not move the accumulator');
});

test('5. out-of-network balance billing is charged to the member and never counts toward the max', () => {
  const plan = testPlan({ benefits: { specialist: { in: coins(0.2, true), out: coins(0.4, true) } } });
  const acc = newAccumulators(HH);
  acc.members.a.out.deductible = 2000;   // out-of-network deductible already met
  acc.family.out.deductible = 2000;

  const line = applyEvent(plan, acc, ev({ benefitKey: 'specialist', tier: 'out', billed: 1000 }));

  assert.equal(line.allowed, 500, 'the plan only recognises its own allowed amount');
  assert.equal(line.balanceBilled, 500, 'the provider pursues the difference');
  assert.equal(line.coinsurance, 200, '40% of the allowed amount');
  assert.equal(line.memberTotal, 700, 'coinsurance plus the balance bill');
  assert.equal(line.countedToOOP, 200, 'only the coinsurance counts');
  assert.equal(acc.members.a.out.oop, 200, 'balance billing never credits the maximum');
});

test('6. the OOP maximum caps cost sharing, and a later claim the same year costs zero', () => {
  const plan = testPlan({ benefits: { inpatientFacility: { in: coins(0.2, true), out: coins(0.4, true) } } });
  const acc = newAccumulators(HH);

  const big = applyEvent(plan, acc, ev({ benefitKey: 'inpatientFacility', billed: 90000 }));
  assert.equal(big.memberTotal, 3000, 'capped at the individual out-of-pocket maximum');
  assert.equal(acc.members.a.in.oop, 3000);

  const later = applyEvent(plan, acc, ev({ benefitKey: 'inpatientFacility', billed: 5000 }));
  assert.equal(later.memberTotal, 0, 'everything after the maximum is free');
  assert.equal(later.planPaid, 5000);
});

test('7. the designated tier is used when selected, and falls back to the network tier when absent', () => {
  const plan = testPlan({
    benefits: {
      imaging: { designated: coins(0, true), in: coins(0.5, true), out: coins(0.4, true) },
      xray: { in: copay(25, false), out: coins(0.4, true) }
    }
  });

  const designated = applyEvent(plan, newAccumulators(HH), ev({ benefitKey: 'imaging', tier: 'designated', billed: 2000 }));
  assert.equal(designated.tierUsed, 'designated');
  assert.equal(designated.coinsurance, 0, '0% at a designated facility');
  assert.equal(designated.memberTotal, 1000, 'only the deductible draw remains');

  const network = applyEvent(plan, newAccumulators(HH), ev({ benefitKey: 'imaging', tier: 'in', billed: 2000 }));
  assert.equal(network.coinsurance, 500, '50% of the $1,000 past the deductible');
  assert.ok(network.memberTotal > designated.memberTotal, 'designated is the cheaper tier');

  // xray defines no designated benefit — asking for it must fall back to `in`.
  const fellBack = applyEvent(plan, newAccumulators(HH), ev({ benefitKey: 'xray', tier: 'designated', billed: 300 }));
  assert.equal(fellBack.tierUsed, 'in', 'falls back rather than failing');
  assert.equal(fellBack.memberTotal, 25, 'priced on the in-network copay');
});

test('8. embedded: one member meeting their deductible starts the plan paying for that member', () => {
  const plan = testPlan({
    familyDeductibleMode: 'embedded',
    benefits: { specialist: { in: coins(0.2, true), out: coins(0.4, true) } }
  });
  const acc = newAccumulators(HH);

  applyEvent(plan, acc, ev({ benefitKey: 'specialist', memberId: 'a', billed: 1000 }));
  assert.equal(acc.members.a.in.deductible, 1000, 'member A has met their individual deductible');

  const forA = applyEvent(plan, acc, ev({ benefitKey: 'specialist', memberId: 'a', billed: 500 }));
  assert.equal(forA.deductible, 0, 'A is through their deductible');
  assert.equal(forA.coinsurance, 100, 'so A pays coinsurance only');

  const forB = applyEvent(plan, acc, ev({ benefitKey: 'specialist', memberId: 'b', billed: 500 }));
  assert.equal(forB.deductible, 500, 'B is still short of theirs and pays in full');
  assert.equal(forB.coinsurance, 0);
});

test('9. aggregate: the plan pays nothing for anyone until the family deductible is met', () => {
  const plan = testPlan({
    familyDeductibleMode: 'aggregate',
    benefits: { specialist: { in: coins(0.2, true), out: coins(0.4, true) } }
  });
  const acc = newAccumulators(HH);

  applyEvent(plan, acc, ev({ benefitKey: 'specialist', memberId: 'a', billed: 1500 }));
  assert.equal(acc.family.in.deductible, 1500, 'family total is $1,500 of $2,000');

  // A has passed the $1,000 individual figure, but under aggregate that is not a gate.
  const forA = applyEvent(plan, acc, ev({ benefitKey: 'specialist', memberId: 'a', billed: 300 }));
  assert.equal(forA.deductible, 300, 'still all deductible — the family total is not met');
  assert.equal(forA.coinsurance, 0, 'the plan has paid nothing for anyone yet');

  const forB = applyEvent(plan, acc, ev({ benefitKey: 'specialist', memberId: 'b', billed: 400 }));
  assert.equal(forB.deductible, 200, '$200 finishes the $2,000 family deductible');
  assert.equal(forB.coinsurance, 40, 'and coinsurance starts for everyone at once');
});

test('10. the family OOP maximum caps the household even when no individual has reached theirs', () => {
  const plan = testPlan({
    tiers: {
      in:  { deductible: { individual: 500, family: 1000 }, oopMax: { individual: 5000, family: 6000 } },
      out: { deductible: { individual: 2000, family: 4000 }, oopMax: { individual: 6000, family: 12000 } }
    },
    benefits: { inpatientFacility: { in: coins(0.5, true), out: coins(0.4, true) } }
  });
  const acc = newAccumulators(HH);

  // Two members, each well short of the $5,000 individual maximum...
  acc.members.a.in.oop = 3000;
  acc.members.b.in.oop = 2500;
  acc.family.in.oop = 5500;
  acc.members.a.in.deductible = 500;
  acc.family.in.deductible = 1000;

  const line = applyEvent(plan, acc, ev({ benefitKey: 'inpatientFacility', memberId: 'a', billed: 40000 }));
  assert.equal(line.memberTotal, 500, '...but only $500 of family room was left');
  assert.equal(acc.family.in.oop, 6000, 'family maximum reached');
  assert.ok(acc.members.a.in.oop < 5000, 'while A is still below their individual maximum');
});

test('11. a separate pharmacy deductible does not consume the medical deductible', () => {
  const plan = testPlan({
    pharmacyDeductible: { individual: 250, family: 500 },
    benefits: {
      rxTier2: { in: copay(35, true), out: notCovered() },
      specialist: { in: coins(0.2, true), out: coins(0.4, true) }
    }
  });
  const acc = newAccumulators(HH);

  const rx = applyEvent(plan, acc, ev({ benefitKey: 'rxTier2', billed: 200 }));
  assert.equal(rx.deductible, 200, 'drawn from the pharmacy deductible');
  assert.equal(acc.members.a.in.pharmacy, 200, 'and accumulated there');
  assert.equal(acc.members.a.in.deductible, 0, 'the medical deductible is untouched');

  const med = applyEvent(plan, acc, ev({ benefitKey: 'specialist', billed: 400 }));
  assert.equal(med.deductible, 400, 'medical still has its full $1,000 available');
});

test('12. an emergency copay is waived and inpatient terms apply when the visit is admitted', () => {
  const plan = testPlan({
    erCopayWaivedIfAdmitted: true,
    benefits: {
      er: { in: copay(500, true), out: copay(500, true) },
      inpatientFacility: { in: coins(0.2, true), out: coins(0.4, true) }
    }
  });

  const accA = newAccumulators(HH);
  accA.members.a.in.deductible = 1000; accA.family.in.deductible = 2000;
  const walkOut = applyEvent(plan, accA, ev({ benefitKey: 'er', billed: 3000 }));

  const accB = newAccumulators(HH);
  accB.members.a.in.deductible = 1000; accB.family.in.deductible = 2000;
  const admitted = applyEvent(plan, accB, ev({ benefitKey: 'er', billed: 3000, admitted: true }));

  assert.equal(walkOut.memberTotal, 500, 'walk-out pays the emergency copay');
  assert.equal(admitted.copay, 0, 'the emergency copay is waived on admission');
  assert.equal(admitted.coinsurance, 600, 'and inpatient terms apply — 20% of $3,000');
  assert.match(admitted.note, /admitted/i);
});

test('13. a not-covered service is billed in full and accrues nothing anywhere', () => {
  const plan = testPlan({ benefits: { rxSpecialty: { in: notCovered(), out: notCovered() } } });
  const acc = newAccumulators(HH);

  const line = applyEvent(plan, acc, ev({ benefitKey: 'rxSpecialty', billed: 3800 }));
  assert.equal(line.memberTotal, 3800, 'the full sticker price');
  assert.equal(line.uncovered, 3800);
  assert.equal(line.deductible, 0);
  assert.equal(line.countedToOOP, 0);
  assert.equal(acc.members.a.in.deductible, 0, 'nothing accrues to the deductible');
  assert.equal(acc.members.a.in.oop, 0, 'nothing accrues to the maximum');
});

test('14. preventive care in network costs zero and accrues nothing', () => {
  const plan = testPlan({ benefits: { preventive: { in: free(), out: coins(0.4, true) } } });
  const acc = newAccumulators(HH);

  const line = applyEvent(plan, acc, ev({ benefitKey: 'preventive', billed: 350 }));
  assert.equal(line.memberTotal, 0);
  assert.equal(line.planPaid, 350);
  assert.equal(acc.members.a.in.deductible, 0);
  assert.equal(acc.members.a.in.oop, 0);
});

test('15. repeat visits are interleaved rather than batched', () => {
  const events = expandYear([
    { id: 'x', benefitKey: 'pcp', count: 3 },
    { id: 'y', benefitKey: 'rxTier1', count: 2 }
  ]);

  assert.equal(events.length, 5);
  assert.deepEqual(
    events.map((e) => e.benefitKey),
    ['pcp', 'rxTier1', 'pcp', 'rxTier1', 'pcp'],
    'round-robin, not three PCP visits followed by two fills'
  );
});

test('16. the annual total always equals premiums plus member cost share', () => {
  const plans = seedPlans().map((p) => ({ ...p, monthlyPremium: 500 }));
  const scenarios = [
    makeScenario('specialist', { memberId: 'a', count: 6 }),
    makeScenario('imaging', { memberId: 'b', count: 2 }),
    makeScenario('rxTier2', { memberId: 'a', count: 12 }),
    makeScenario('pcp', { memberId: 'b', count: 4, tier: 'out' })
  ];

  for (const plan of plans) {
    const r = simulatePlan(plan, scenarios, HH);
    assert.equal(r.totalAnnual, round2(r.premiums + r.memberCare), `${plan.name}: total reconciles`);
    assert.equal(r.premiums, 6000, `${plan.name}: twelve months of premium`);

    const partsSum = round2(r.deductiblePaid + r.coinsurancePaid + r.copayPaid + r.balanceBilled + r.uncovered);
    assert.equal(partsSum, r.memberCare, `${plan.name}: the breakdown sums to member cost share`);
  }
});

test('17. in-network member cost sharing never exceeds the plan in-network OOP maximum', () => {
  // A deliberately brutal in-network year, on every seed plan.
  const scenarios = [
    makeScenario('inpatientFacility', { memberId: 'a', count: 2, billed: 120000 }),
    makeScenario('inpatientPhysician', { memberId: 'a', count: 2, billed: 20000 }),
    makeScenario('imaging', { memberId: 'b', count: 6, billed: 4000 }),
    makeScenario('specialist', { memberId: 'b', count: 20, billed: 600 }),
    makeScenario('rxTier3', { memberId: 'a', count: 12, billed: 900 })
  ];

  for (const plan of seedPlans()) {
    const r = simulatePlan(plan, scenarios, HH);
    // Cost sharing only. Balance billing and non-covered charges are excluded by statute and
    // are genuinely uncapped — see COST-MODEL §2.2.
    const costSharing = round2(r.deductiblePaid + r.coinsurancePaid + r.copayPaid);
    const cap = plan.tiers.in.oopMax.family;

    assert.equal(r.balanceBilled, 0, `${plan.name}: an all-in-network year has no balance billing`);
    assert.ok(
      costSharing <= cap + 0.01,
      `${plan.name}: cost sharing ${costSharing} must not exceed the family maximum ${cap}`
    );
  }
});

/* ============================================================================
   Corrections from docs/COST-MODEL.md §4 — things the build prompt got wrong
   ========================================================================== */

test('A. (§4.1) emergency care out of network is never balance billed and prices in-network', () => {
  const plan = testPlan({
    negotiatedPct: 0.55,
    oonAllowedPct: 0.5,
    benefits: {
      er: { in: copay(500, false), out: copay(500, false) },
      specialist: { in: coins(0.2, true), out: coins(0.4, true) }
    }
  });

  const acc = newAccumulators(HH);
  const er = applyEvent(plan, acc, ev({ benefitKey: 'er', tier: 'out', billed: 6000 }));

  assert.equal(er.balanceBilled, 0, 'the No Surprises Act forbids it');
  assert.equal(er.nsaProtected, true);
  assert.equal(er.allowed, 3300, 'priced at the in-network negotiated rate (55%), not the OON rate');
  assert.equal(er.side, 'in', 'and credited to the in-network accumulators');
  assert.equal(acc.members.a.in.oop, 500, 'in-network maximum moved');
  assert.equal(acc.members.a.out.oop, 0, 'out-of-network maximum untouched');

  // An ordinary out-of-network service is still balance billed.
  const spec = applyEvent(plan, newAccumulators(HH), ev({ benefitKey: 'specialist', tier: 'out', billed: 6000 }));
  assert.ok(spec.balanceBilled > 0, 'unprotected services still carry a balance bill');
});

test('A2. (§4.1) an EPO with no out-of-network tier still prices protected emergency care', () => {
  const es38 = seedPlans().find((p) => p.id === 'seed_es38');
  assert.equal(es38.tiers.out, null, 'the EPO genuinely has no out-of-network accumulators');

  const acc = newAccumulators(HH);
  const line = applyEvent(es38, acc, ev({ benefitKey: 'er', tier: 'out', billed: 9000 }));

  assert.equal(line.side, 'in', 'protected claims have somewhere to land');
  assert.equal(line.balanceBilled, 0);
  assert.ok(line.memberTotal > 0, 'the member still owes cost sharing');
  assert.ok(acc.members.a.in.deductible > 0, 'which draws the in-network deductible');

  // ...while an unprotected out-of-network service on the same plan is simply not covered.
  const spec = applyEvent(es38, newAccumulators(HH), ev({ benefitKey: 'specialist', tier: 'out', billed: 400 }));
  assert.equal(spec.uncovered, 400, 'no out-of-network coverage at all');
});

test('B. (§4.2) ground ambulance is NOT protected and remains balance-billable', () => {
  const plan = seedPlans().find((p) => p.id === 'seed_es1a');
  const line = applyEvent(plan, newAccumulators(HH), ev({ benefitKey: 'ambulance', tier: 'out', billed: 1800 }));

  assert.ok(line.balanceBilled > 0, 'the Act deliberately excluded ground ambulance');
  assert.equal(line.nsaProtected, false);
  assert.equal(line.side, 'out', 'and it uses the out-of-network accumulators');
});

test('C. (§4.4) the individual OOP maximum is embedded even on an aggregate-deductible plan', () => {
  const plan = testPlan({
    familyDeductibleMode: 'aggregate',
    benefits: { inpatientFacility: { in: coins(0.5, true), out: coins(0.4, true) } }
  });
  const acc = newAccumulators(HH);

  // One member runs up a catastrophic year on their own.
  const line = applyEvent(plan, acc, ev({ benefitKey: 'inpatientFacility', memberId: 'a', billed: 200000 }));

  assert.equal(line.memberTotal, 3000, 'capped at the INDIVIDUAL maximum, not the $6,000 family one');
  assert.equal(acc.members.a.in.oop, 3000);
  assert.ok(acc.family.in.oop < 6000, 'the family maximum is nowhere near met');

  const next = applyEvent(plan, acc, ev({ benefitKey: 'inpatientFacility', memberId: 'a', billed: 10000 }));
  assert.equal(next.memberTotal, 0, 'the plan now pays 100% for that member');

  const other = applyEvent(plan, acc, ev({ benefitKey: 'inpatientFacility', memberId: 'b', billed: 1000 }));
  assert.ok(other.memberTotal > 0, 'but not yet for anyone else');
});

test('D. (§4.6) the deductible ledger is only credited with money the member actually paid', () => {
  const plan = testPlan({
    tiers: {
      in:  { deductible: { individual: 5000, family: 10000 }, oopMax: { individual: 1200, family: 2400 } },
      out: { deductible: { individual: 2000, family: 4000 }, oopMax: { individual: 6000, family: 12000 } }
    },
    benefits: { inpatientFacility: { in: coins(0.2, true), out: coins(0.4, true) } }
  });
  const acc = newAccumulators(HH);

  // The claim would draw $3,000 of deductible, but only $1,200 of OOP room exists.
  const line = applyEvent(plan, acc, ev({ benefitKey: 'inpatientFacility', billed: 3000 }));

  assert.equal(line.memberTotal, 1200, 'capped at the out-of-pocket maximum');
  assert.equal(line.deductible, 1200, 'only what was actually paid is reported as deductible');
  assert.equal(acc.members.a.in.deductible, 1200, 'and only that is credited — no phantom $3,000');
  assert.equal(acc.members.a.in.oop, 1200);
});

test('E. (§4.3) validation warns when copays are set not to count toward the maximum', () => {
  const bad = normalizePlan({ ...blankPlan(0), copaysCountToOOP: false, monthlyPremium: 100 });
  const messages = validatePlan(bad).map((w) => w.message).join(' ');
  assert.match(messages, /not permitted/i);
});

test('F. (§2.5) validation catches an HSA plan whose embedded deductible is too low', () => {
  const bad = normalizePlan({
    ...blankPlan(0),
    isHSA: true,
    monthlyPremium: 100,
    familyDeductibleMode: 'embedded',
    tiers: {
      in:  { deductible: { individual: 1700, family: 3400 }, oopMax: { individual: 3000, family: 6000 } },
      out: { deductible: { individual: 5000, family: 10000 }, oopMax: { individual: 10000, family: 20000 } }
    }
  });
  const messages = validatePlan(bad).map((w) => w.message).join(' ');
  assert.match(messages, /would not be HSA-qualified/i);
});

test('G. all five seed plans pass regulatory validation once a premium is entered', () => {
  for (const plan of seedPlans()) {
    const warnings = validatePlan({ ...plan, monthlyPremium: 500 }).filter((w) => w.level === 'warn');
    assert.deepEqual(warnings, [], `${plan.name} should raise no warnings, got: ${JSON.stringify(warnings)}`);
  }
});

test('H. seed plans carry the aggregate/embedded shapes that keep both HSA plans qualified', () => {
  const plans = seedPlans();
  const es2p = plans.find((p) => p.id === 'seed_es2p');
  const es38 = plans.find((p) => p.id === 'seed_es38');

  assert.equal(es2p.familyDeductibleMode, 'aggregate', 'ES2P embeds nothing, so $1,700 is legal');
  assert.equal(es38.familyDeductibleMode, 'embedded');
  assert.equal(es38.tiers.in.deductible.individual, 3400, 'ES38 embeds exactly the family minimum');
});

/* ============================================================================
   Comparison sanity — the crossover the build prompt asks to be findable
   ========================================================================== */

test('I. compare() ranks cheapest first and reports a delta against the winner', () => {
  const plans = seedPlans().map((p, i) => ({ ...p, monthlyPremium: 400 + i * 50 }));
  const scenarios = [makeScenario('pcp', { memberId: 'a', count: 4 }), makeScenario('rxTier1', { memberId: 'a', count: 12 })];

  const results = compare(plans, scenarios, HH);
  assert.equal(results.length, 5);
  assert.equal(results[0].deltaVsBest, 0, 'the winner is zero away from itself');
  assert.equal(results.filter((r) => r.isBest).length, 1, 'exactly one winner');

  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i].totalAnnual >= results[i - 1].totalAnnual, 'sorted ascending');
    assert.equal(results[i].deltaVsBest, round2(results[i].totalAnnual - results[0].totalAnnual));
  }
});

test('I2. the cheapest plan is always first, however the inputs change', () => {
  const plans = seedPlans().map((p, i) => ({ ...p, monthlyPremium: 300 + i * 90 }));

  // Several very different years — the winner differs in each, and must lead every time.
  const years = [
    [makeScenario('pcp', { memberId: 'a', count: 2 })],
    [makeScenario('inpatientFacility', { memberId: 'a', count: 1, billed: 250000 })],
    [makeScenario('imaging', { memberId: 'b', count: 8, billed: 4000 }),
     makeScenario('rxTier3', { memberId: 'a', count: 12 })],
    [makeScenario('specialist', { memberId: 'b', count: 30, billed: 700, tier: 'out' })],
    []
  ];

  const winners = new Set();
  for (const scenarios of years) {
    const results = compare(plans, scenarios, HH);
    const cheapest = Math.min(...results.map((r) => r.totalAnnual));

    assert.equal(results[0].totalAnnual, cheapest, 'the cheapest total is in first place');
    assert.equal(results[0].isBest, true, 'and it is the badged winner');
    assert.equal(results[0].deltaVsBest, 0);

    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i].totalAnnual >= results[i - 1].totalAnnual, 'strictly ascending');
      assert.equal(results[i].isBest, false, 'exactly one winner');
    }
    winners.add(results[0].planId);
  }

  assert.ok(winners.size > 1, 'the winner really does change with the year, so the sort matters');
});

test('I3. a plan missing its premium is flagged, because it ranks on care alone', () => {
  const plans = seedPlans().map((p) => ({ ...p, monthlyPremium: 600 }));
  plans[4].monthlyPremium = 0;

  const results = compare(plans, [makeScenario('pcp', { memberId: 'a', count: 2 })], HH);
  const incomplete = results.find((r) => r.planId === plans[4].id);

  assert.equal(incomplete.premiumMissing, true);
  assert.equal(results[0].planId, plans[4].id, 'it does float to the top on an incomplete figure');
  assert.equal(results.filter((r) => r.premiumMissing).length, 1, 'and the UI can count them');
});

test('J. ES1A and ES38 cross over as utilisation rises', () => {
  // ES1A: $250 deductible, 10% coinsurance. ES38: $3,400 deductible, 0% coinsurance.
  // Low utilisation favours the low deductible; high utilisation favours the 0% coinsurance.
  const plans = seedPlans()
    .filter((p) => p.id === 'seed_es1a' || p.id === 'seed_es38')
    .map((p) => ({ ...p, monthlyPremium: 0 }));      // isolate care cost from premium

  const at = (billed) => {
    const scenarios = [makeScenario('inpatientFacility', { memberId: 'a', count: 1, billed })];
    const out = {};
    for (const p of plans) out[p.id] = simulatePlan(p, scenarios, HH).memberCare;
    return out;
  };

  const light = at(8000);
  const heavy = at(400000);

  assert.ok(light.seed_es1a < light.seed_es38, 'a light year favours the $250 deductible');
  assert.ok(heavy.seed_es38 < heavy.seed_es1a, 'a heavy year favours the 0% coinsurance plan');
});

/* ============================================================================
   Availability — a plan that cannot do something must say so in words
   ========================================================================== */

test('L. a plan with no out-of-network coverage reports "Unavailable", not a price', () => {
  const es38 = seedPlans().find((p) => p.id === 'seed_es38');
  const esz9 = seedPlans().find((p) => p.id === 'seed_esz9');

  const blocked = benefitAvailability(es38, 'specialist', 'out');
  assert.equal(blocked.status, 'unavailable');
  assert.equal(blocked.label, 'Unavailable');
  assert.match(blocked.detail, /no out-of-network coverage/i);

  // The same care on a plan that does cover it is priced normally — this is the contrast the
  // label exists to make visible.
  assert.equal(benefitAvailability(esz9, 'specialist', 'out').status, 'covered');
});

test('L2. a service the plan simply does not cover reports "Not covered"', () => {
  const plan = testPlan({ benefits: { rxSpecialty: { in: notCovered(), out: notCovered() } } });
  const a = benefitAvailability(plan, 'rxSpecialty', 'in');
  assert.equal(a.status, 'unavailable');
  assert.equal(a.label, 'Not covered');
  // Distinct wording from the no-out-of-network-tier case above.
  assert.notEqual(a.label, 'Unavailable');
});

test('M. an AI-extracted plan reports "Not stated" for fields the document did not state', () => {
  const plan = normalizePlan({
    ...blankPlan(0), source: 'ai', unread: ['imaging'], monthlyPremium: 400
  });
  const a = benefitAvailability(plan, 'imaging', 'in');
  assert.equal(a.status, 'notStated');
  assert.equal(a.label, 'Not stated');

  // "We do not know" must outrank "we defaulted it to something" — the invented default is
  // never presented as though the plan stated it.
  assert.equal(benefitAvailability(plan, 'pcp', 'in').status, 'covered', 'other benefits are unaffected');

  // And it must outrank notCovered, because not-stated is a different claim than a known no.
  const both = normalizePlan({
    ...blankPlan(0), source: 'ai', unread: ['rxSpecialty'],
    benefits: { rxSpecialty: { in: notCovered(), out: notCovered() } }
  });
  assert.equal(benefitAvailability(both, 'rxSpecialty', 'in').status, 'notStated');
});

test('N. asking for a Designated tier a plan lacks reports a fallback, still covered', () => {
  const esz9 = seedPlans().find((p) => p.id === 'seed_esz9');

  const hasIt = benefitAvailability(esz9, 'imaging', 'designated');
  assert.equal(hasIt.status, 'covered', 'ESZ9 defines a designated imaging benefit');

  const lacksIt = benefitAvailability(esz9, 'pcp', 'designated');
  assert.equal(lacksIt.status, 'fallback');
  assert.equal(lacksIt.label, 'No Designated tier');
  assert.match(lacksIt.detail, /in-network rate/i);
});

test('O. every ledger line carries its availability', () => {
  const es38 = seedPlans().find((p) => p.id === 'seed_es38');
  const acc = newAccumulators(HH);

  const uncovered = applyEvent(es38, acc, ev({ benefitKey: 'specialist', tier: 'out', billed: 400 }));
  assert.equal(uncovered.availability.status, 'unavailable');
  assert.equal(uncovered.uncovered, 400, 'and the member does owe the whole charge');

  const covered = applyEvent(es38, acc, ev({ benefitKey: 'specialist', tier: 'in', billed: 400 }));
  assert.equal(covered.availability.status, 'covered');

  // The ER→inpatient swap must not change what the row says it is.
  const er = applyEvent(es38, acc, ev({ benefitKey: 'er', billed: 9000, admitted: true }));
  assert.equal(er.benefitKey, 'er', 'the line still reports the service that was asked for');
  assert.equal(er.availability.status, 'covered');
});

test('R. "after the deductible" is not silently collapsed into "after the maximum"', () => {
  // Regression. marginalCosts used to write the FAMILY deductible into the INDIVIDUAL ledger
  // and derive the individual out-of-pocket total from it. On any plan whose family deductible
  // is at least its individual maximum, that filled the maximum too, so the middle column
  // reported $0 for visits that really cost a copay — five of nine seed plan/tier combinations.
  const es2p = seedPlans().find((p) => p.id === 'seed_es2p');

  assert.ok(
    es2p.tiers.in.deductible.family >= es2p.tiers.in.oopMax.individual,
    'ES2P is one of the plans that triggered the bug ($3,400 family deductible, $3,000 individual max)'
  );

  // Designated lab work on ES2P is a $40 copay after the deductible.
  const m = marginalCosts(es2p, { benefitKey: 'labs', tier: 'designated', billed: 260, memberId: 'a' });
  assert.equal(m.afterDeductible.memberTotal, 40, 'the copay must survive the deductible being met');
  assert.equal(m.afterDeductible.copay, 40);
  assert.ok(m.afterDeductible.planPaid > 0, 'and the plan pays the rest');
  assert.equal(m.afterOopMax.memberTotal, 0, 'only the maximum makes it free');
  assert.ok(m.beforeDeductible.memberTotal > m.afterDeductible.memberTotal, 'strictly cheaper after the deductible');

  // The three states must be monotonically non-increasing on every seed plan and tier.
  for (const plan of seedPlans()) {
    for (const tier of ['designated', 'in', 'out']) {
      for (const key of ['labs', 'pcp', 'specialist', 'inpatientFacility']) {
        const r = marginalCosts(plan, { benefitKey: key, tier, billed: 900, memberId: 'a' });
        assert.ok(
          r.beforeDeductible.memberTotal >= r.afterDeductible.memberTotal - 0.01,
          `${plan.name} ${key}/${tier}: meeting the deductible must never cost more`
        );
        assert.ok(
          r.afterDeductible.memberTotal >= r.afterOopMax.memberTotal - 0.01,
          `${plan.name} ${key}/${tier}: reaching the maximum must never cost more`
        );
      }
    }
  }
});

test('Q. describeBenefit distinguishes real coverage from no coverage out of network', () => {
  const plans = seedPlans();
  const es1a = plans.find((p) => p.id === 'seed_es1a');   // 40% coinsurance out of network
  const es38 = plans.find((p) => p.id === 'seed_es38');   // EPO, no out-of-network coverage

  const covered = describeBenefit(es1a, 'specialist', 'out');
  assert.match(covered, /you pay 40%/i, "the member's share");
  assert.match(covered, /plan pays 60%/i, 'and the plan\'s, because that is the misread number');
  assert.match(covered, /after the deductible/i);
  assert.match(covered, /balance billing/i, 'out of network, the uncapped part must be named');

  const notCovered = describeBenefit(es38, 'specialist', 'out');
  assert.match(notCovered, /not covered/i);
  assert.doesNotMatch(notCovered, /plan pays/i, 'it never pays anything, so do not imply it might');

  // The whole point: identical member cost, opposite meaning.
  const a = marginalCosts(es1a, { benefitKey: 'specialist', tier: 'out', billed: 400, memberId: 'a' });
  const b = marginalCosts(es38, { benefitKey: 'specialist', tier: 'out', billed: 400, memberId: 'a' });
  assert.equal(a.beforeDeductible.memberTotal, b.beforeDeductible.memberTotal,
    'before the deductible both cost the member the whole charge — which is why words are needed');
  assert.ok(a.afterDeductible.planPaid > 0, 'but one plan starts paying');
  assert.equal(b.afterDeductible.planPaid, 0, 'and the other never does');
  assert.notEqual(covered, notCovered, 'so their descriptions must differ');
});

test('Q2. describeBenefit states copays, deductible treatment and protected services', () => {
  const plans = seedPlans();
  const esz9 = plans.find((p) => p.id === 'seed_esz9');
  const es2p = plans.find((p) => p.id === 'seed_es2p');

  // Copay with the deductible waived, versus the same shape on an HSA plan where it is not.
  assert.match(describeBenefit(esz9, 'pcp', 'in'), /\$25 copay/);
  assert.match(describeBenefit(esz9, 'pcp', 'in'), /deductible does not apply/i);
  assert.match(describeBenefit(es2p, 'pcp', 'in'), /\$30 copay/);
  assert.match(describeBenefit(es2p, 'pcp', 'in'), /after the deductible/i, 'HSA: everything is');

  // 0% coinsurance is coverage, not absence of it.
  assert.match(describeBenefit(esz9, 'inpatientFacility', 'in'), /plan pays 100%/i);

  // Preventive is free by law in network.
  assert.match(describeBenefit(esz9, 'preventive', 'in'), /covered in full/i);

  // Emergency care out of network cannot be balance billed (COST-MODEL §4.1) — say so, rather
  // than staying silent and letting the reader assume the usual out-of-network exposure.
  const er = describeBenefit(esz9, 'er', 'out');
  assert.match(er, /no balance billing/i);
  assert.match(er, /protected by law/i);

  // Ground ambulance is the exception and must not claim protection it does not have.
  assert.match(describeBenefit(esz9, 'ambulance', 'out'), /plus balance billing/i);
});

test('P. slider ceilings reach a realistic worst-case bill and stay internally coherent', () => {
  // Primary care is the researched one: ~$2,500 realistic extreme, doubled. COST-MODEL §2.8.
  assert.ok(BENEFIT_META.pcp.max >= 5000, 'a primary care slider must reach a real worst case');

  // A specialist visit always bills at least as much as primary care, so its ceiling cannot be
  // lower — that would be visibly incoherent the moment someone dragged both.
  assert.ok(BENEFIT_META.specialist.max >= BENEFIT_META.pcp.max);

  // Every seeded default must be reachable on its own slider, or the row opens out of range.
  for (const [key, meta] of Object.entries(BENEFIT_META)) {
    assert.ok(meta.max > 0, `${key} needs a positive ceiling`);
    assert.ok(meta.billed <= meta.max, `${key}: default ${meta.billed} exceeds its ceiling ${meta.max}`);
  }
});

test('K. resolveBenefit reports the tier it actually used', () => {
  const plan = seedPlans().find((p) => p.id === 'seed_esz9');
  assert.equal(resolveBenefit(plan, 'imaging', 'designated').tierUsed, 'designated');
  assert.equal(resolveBenefit(plan, 'pcp', 'designated').tierUsed, 'in', 'no designated PCP benefit exists');
  assert.equal(resolveBenefit(plan, 'pcp', 'out').tierUsed, 'out');
});
