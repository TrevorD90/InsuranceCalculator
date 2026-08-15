/**
 * Renderer — state, controls, rendering.
 *
 * This file formats numbers. It never derives them: every figure the user sees comes out of
 * src/engine.mjs. If you find arithmetic here that decides what someone owes, that is a bug.
 * See ARCHITECTURE §3.
 */

import {
  BENEFIT_KEYS, BENEFIT_META, compare, marginalCosts, benefitAvailability, describeBenefit, round2
} from '../src/engine.mjs';

import {
  seedPlans, blankPlan, normalizePlan, normalizeScenario, validatePlan,
  defaultHousehold, defaultScenarios, makeScenario, PLAN_COLORS
} from '../src/plans.mjs';

/* ------------------------------------------------------------------ bridge */

/** Fallback so the renderer still runs in a plain browser with no Electron behind it. */
const desktop = window.desktop || {
  settings: {
    load: async () => ({ hasKey: false, model: 'claude-sonnet-5', keyHint: '', encryptionAvailable: false }),
    save: async () => ({ ok: true }),
    clearKey: async () => ({ ok: true })
  },
  ai: { test: async () => ({ ok: false, error: 'Desktop bridge unavailable.' }) },
  // Outside Electron there is no frame to zoom; fall back to scaling the root font size, which
  // is imperfect but better than a dead control.
  ui: {
    setZoom: (f) => { document.documentElement.style.fontSize = `${f * 100}%`; },
    getZoom: () => 1
  },
  plans: { import: async () => ({ ok: false, error: 'Desktop bridge unavailable.' }), onProgress: () => () => {} },
  workspace: {
    export: async () => ({ ok: false }), import: async () => ({ ok: false }),
    autosave: async () => ({ ok: true }), restore: async () => ({ ok: true, data: null })
  },
  openExternal: () => {},
  platform: 'browser'
};

/* ------------------------------------------------------------------- state */

const state = {
  plans: seedPlans(),
  household: defaultHousehold(),
  scenarios: defaultScenarios(),
  results: [],
  ai: { state: 'off', model: 'claude-sonnet-5' },

  // Scenario ids added this session and not yet acknowledged. Session-only and deliberately
  // never persisted — a row is "new" to the person who just added it, not to the file.
  newScenarios: new Set(),

  textScale: 1
};

/** Text-size steps. Discrete so each arrow press lands somewhere predictable. */
const TEXT_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2];

/* ----------------------------------------------------------------- helpers */

const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 9);

const money = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US');
const pct = (n) => Math.round((Number(n) || 0) * 100) + '%';

function el(tag, props, kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const kid of kids || []) {
    if (kid == null || kid === false) continue;
    node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return node;
}

/**
 * Slider position maps to dollars on a square curve, so the low end — where most real bills
 * sit — has room to breathe instead of being crushed into the first few pixels.
 */
function sliderToDollars(t, max) {
  const raw = max * Math.pow(t / 1000, 2);
  const step = raw > 20000 ? 500 : raw > 5000 ? 100 : raw > 500 ? 10 : 5;
  return Math.max(0, Math.round(raw / step) * step);
}
function dollarsToSlider(v, max) {
  if (v <= 0 || max <= 0) return 0;
  return Math.min(1000, Math.round(1000 * Math.sqrt(Math.min(v, max) / max)));
}

const memberLabel = (id) => state.household.find((m) => m.id === id)?.label || '—';

/* ============================================================== PLAN CARDS */

function benefitEditorRow(plan, key) {
  const meta = BENEFIT_META[key];
  const cells = [el('td', { class: 'svc' }, [meta.label])];

  for (const tier of ['designated', 'in', 'out']) {
    const supportsDesignated = tier !== 'designated' || meta.designated;
    const entry = plan.benefits[key];
    const b = entry[tier];

    if (!supportsDesignated) {
      cells.push(el('td', { class: 'grp', colspan: '3' }, [
        el('span', { class: 'is-muted', title: 'No Designated provider tier applies to this service on any plan.' }, ['n/a'])
      ]));
      continue;
    }

    // A tier with no benefit defined shows an "add" affordance rather than a phantom row.
    if (!b) {
      cells.push(el('td', { class: 'grp', colspan: '3' }, [
        el('button', {
          class: 'btn btn-xs', type: 'button', text: 'add tier',
          title: 'Define a Designated-provider benefit for this service',
          onClick: () => {
            entry.designated = { ...entry.in };
            renderPlans(); recompute();
          }
        })
      ]));
      continue;
    }

    const modeSel = el('select', {
      'aria-label': `${meta.label} ${tier} mode`,
      onChange: () => {
        const next = { mode: modeSel.value };
        if (next.mode === 'copay') { next.copay = b.copay ?? 0; next.deductibleFirst = !!b.deductibleFirst; }
        if (next.mode === 'coinsurance') { next.coinsurance = b.coinsurance ?? 0.2; next.deductibleFirst = !!b.deductibleFirst; }
        if (next.mode === 'noCharge') next.deductibleFirst = false;
        if (next.mode !== 'notCovered') next.balanceBillable = b.balanceBillable !== false;
        entry[tier] = next;
        renderPlans(); recompute();
      }
    }, [
      ['copay', 'Copay'], ['coinsurance', 'Coinsurance'],
      ['noCharge', 'No charge'], ['notCovered', 'Not covered']
    ].map(([v, t]) => el('option', { value: v, selected: b.mode === v }, [t])));

    let valueCell;
    if (b.mode === 'copay') {
      const input = el('input', { type: 'number', min: '0', step: '5', value: b.copay ?? 0, 'aria-label': 'Copay' });
      input.addEventListener('input', () => { b.copay = Math.max(0, Number(input.value) || 0); recompute(); });
      valueCell = input;
    } else if (b.mode === 'coinsurance') {
      const input = el('input', {
        type: 'number', min: '0', max: '100', step: '1',
        value: Math.round((b.coinsurance ?? 0) * 100), 'aria-label': 'Coinsurance percent'
      });
      input.addEventListener('input', () => {
        b.coinsurance = Math.min(100, Math.max(0, Number(input.value) || 0)) / 100;
        recompute();
      });
      valueCell = input;
    } else {
      valueCell = el('span', { class: 'is-muted' }, ['—']);
    }

    let dedCell;
    if (b.mode === 'copay' || b.mode === 'coinsurance') {
      const cb = el('input', { type: 'checkbox', 'aria-label': 'Subject to deductible' });
      cb.checked = !!b.deductibleFirst;
      cb.addEventListener('change', () => { b.deductibleFirst = cb.checked; recompute(); });
      dedCell = cb;
    } else {
      dedCell = el('span', { class: 'is-muted' }, ['—']);
    }

    cells.push(
      el('td', { class: 'grp' }, [modeSel]),
      el('td', {}, [valueCell]),
      el('td', { style: 'text-align:center' }, [dedCell])
    );
  }

  return el('tr', {}, cells);
}

function benefitEditor(plan) {
  const head = el('thead', {}, [
    el('tr', {}, [
      el('th', {}, ['Service']),
      el('th', { class: 'grp', colspan: '3' }, ['Designated']),
      el('th', { class: 'grp', colspan: '3' }, ['In network']),
      el('th', { class: 'grp', colspan: '3' }, ['Out of network'])
    ]),
    el('tr', {}, [
      el('th', {}, ['']),
      ...['Designated', 'In', 'Out'].flatMap(() => ([
        el('th', { class: 'grp' }, ['How']),
        el('th', {}, ['Value']),
        el('th', { style: 'text-align:center' }, ['Ded?'])
      ]))
    ])
  ]);

  const body = el('tbody', {}, BENEFIT_KEYS.map((k) => benefitEditorRow(plan, k)));
  return el('div', { class: 'benefit-table-wrap' }, [el('table', { class: 'benefit-table' }, [head, body])]);
}

function numField(label, get, set, step = 50) {
  const input = el('input', { type: 'number', min: '0', step: String(step), value: get() });
  input.addEventListener('input', () => { set(Math.max(0, Number(input.value) || 0)); recompute(); });
  return el('label', { class: 'mini-field' }, [el('span', {}, [label]), input]);
}

function pctField(label, get, set) {
  const input = el('input', { type: 'number', min: '1', max: '100', step: '1', value: Math.round(get() * 100) });
  input.addEventListener('input', () => {
    const v = Math.min(100, Math.max(1, Number(input.value) || 1)) / 100;
    set(v); recompute();
  });
  return el('label', { class: 'mini-field' }, [el('span', {}, [label]), input]);
}

/** Plan-id → validation container, so warnings can refresh without rebuilding the card
 *  (which would collapse the disclosure and steal focus from whatever is being typed in). */
const planWarnRefs = new Map();

function refreshPlanWarnings() {
  for (const plan of state.plans) {
    const box = planWarnRefs.get(plan.id);
    if (!box) continue;
    const warnings = validatePlan(plan);
    box.replaceChildren(...warnings.map((w) =>
      el('div', { class: 'plan-warn' + (w.level === 'info' ? ' is-info' : '') }, [w.message])));
    box.hidden = warnings.length === 0;
  }
}

function planCard(plan, index) {
  /* --- head ---------------------------------------------------------- */
  const nameInput = el('input', { class: 'plan-name-input', type: 'text', value: plan.name, 'aria-label': 'Plan name' });
  if (plan.source === 'ai') nameInput.classList.add('from-ai');
  nameInput.addEventListener('input', () => { plan.name = nameInput.value; recompute(); });

  const flags = [];
  if (plan.source === 'ai') flags.push(el('span', { class: 'flag flag-ai' }, ['Read by AI']));
  if (plan.isHSA) flags.push(el('span', { class: 'flag flag-hsa' }, ['HSA']));

  const head = el('div', { class: 'plan-card-head' }, [
    nameInput,
    ...flags,
    el('button', {
      class: 'icon-btn', type: 'button', text: '×', 'aria-label': `Remove ${plan.name}`, title: 'Remove plan',
      onClick: () => {
        state.plans = state.plans.filter((p) => p.id !== plan.id);
        renderPlans(); recompute();
      }
    })
  ]);

  /* --- premium (required manual entry) -------------------------------- */
  const premiumInput = el('input', { type: 'number', min: '0', step: '10', value: plan.monthlyPremium, 'aria-label': 'Monthly premium' });
  const premiumRow = el('div', { class: 'premium-row' + (plan.monthlyPremium > 0 ? '' : ' is-missing') }, [
    el('span', { class: 'control-label' }, ['Premium / month']),
    el('span', { class: 'amount-box' }, [el('span', { class: 'prefix' }, ['$']), premiumInput])
  ]);
  premiumInput.addEventListener('input', () => {
    plan.monthlyPremium = Math.max(0, Number(premiumInput.value) || 0);
    premiumRow.classList.toggle('is-missing', !(plan.monthlyPremium > 0));
    const note = premiumRow.parentElement.querySelector('.premium-warning');
    if (note) note.hidden = plan.monthlyPremium > 0;
    recompute();
  });

  const inT = plan.tiers.in;
  const front = el('div', { class: 'plan-front' }, [
    premiumRow,
    el('div', { class: 'premium-warning', hidden: plan.monthlyPremium > 0 }, [
      '▲ No premium entered — this plan cannot be compared fairly yet.'
    ]),
    el('div', { class: 'terms' }, [
      el('span', { html: `Deductible <b>${money(inT.deductible.individual)}</b> / <b>${money(inT.deductible.family)}</b>` }),
      el('span', { html: `Max <b>${money(inT.oopMax.individual)}</b> / <b>${money(inT.oopMax.family)}</b>` }),
      el('span', { html: `Family deductible <b>${plan.familyDeductibleMode}</b>` }),
      el('span', { html: plan.tiers.out ? `Out-of-network ded. <b>${money(plan.tiers.out.deductible.individual)}</b>` : 'Out of network <b>not covered</b>' })
    ])
  ]);

  const warnBox = el('div', { class: 'plan-warnings' });
  planWarnRefs.set(plan.id, warnBox);

  /* --- expanded ------------------------------------------------------- */
  const toggles = [
    ['combinedAccumulators', 'Combine in-network and out-of-network accumulators'],
    ['copaysCountToOOP', 'Copays count toward the out-of-pocket maximum'],
    ['erCopayWaivedIfAdmitted', 'Emergency copay is waived if you are admitted'],
    ['balanceBilling', 'Out-of-network providers may balance bill'],
    ['isHSA', 'HSA-qualified high-deductible plan']
  ].map(([key, label]) => {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!plan[key];
    cb.addEventListener('change', () => { plan[key] = cb.checked; renderPlans(); recompute(); });
    return el('label', {}, [cb, label]);
  });

  const famMode = el('select', {
    onChange: () => { plan.familyDeductibleMode = famMode.value; renderPlans(); recompute(); }
  }, [
    el('option', { value: 'embedded', selected: plan.familyDeductibleMode === 'embedded' }, ['Embedded — each member has their own']),
    el('option', { value: 'aggregate', selected: plan.familyDeductibleMode === 'aggregate' }, ['Aggregate — whole family first'])
  ]);

  const pharmOn = el('input', { type: 'checkbox' });
  pharmOn.checked = !!plan.pharmacyDeductible;
  pharmOn.addEventListener('change', () => {
    plan.pharmacyDeductible = pharmOn.checked ? { individual: 250, family: 500 } : null;
    renderPlans(); recompute();
  });

  const expanded = el('div', { class: 'plan-expand' }, [
    el('div', {}, [
      el('h4', { class: 'eyebrow' }, ['In network']),
      el('div', { class: 'mini-grid' }, [
        numField('Deductible, individual', () => inT.deductible.individual, (v) => { inT.deductible.individual = v; }),
        numField('Deductible, family', () => inT.deductible.family, (v) => { inT.deductible.family = v; }),
        numField('Max, individual', () => inT.oopMax.individual, (v) => { inT.oopMax.individual = v; }),
        numField('Max, family', () => inT.oopMax.family, (v) => { inT.oopMax.family = v; })
      ])
    ]),

    plan.tiers.out
      ? el('div', {}, [
          el('h4', { class: 'eyebrow' }, ['Out of network']),
          el('div', { class: 'mini-grid' }, [
            numField('Deductible, individual', () => plan.tiers.out.deductible.individual, (v) => { plan.tiers.out.deductible.individual = v; }),
            numField('Deductible, family', () => plan.tiers.out.deductible.family, (v) => { plan.tiers.out.deductible.family = v; }),
            numField('Max, individual', () => plan.tiers.out.oopMax.individual, (v) => { plan.tiers.out.oopMax.individual = v; }),
            numField('Max, family', () => plan.tiers.out.oopMax.family, (v) => { plan.tiers.out.oopMax.family = v; })
          ])
        ])
      : el('p', { class: 'field-note' }, ['This plan has no out-of-network coverage. Emergency care out of network is still protected by the No Surprises Act and draws against the in-network accumulators.']),

    el('div', {}, [
      el('h4', { class: 'eyebrow' }, ['Family deductible']),
      el('label', { class: 'mini-field' }, [el('span', {}, ['Mode']), famMode]),
      el('p', { class: 'field-note', style: 'margin:5px 0 0' }, [
        'The individual out-of-pocket maximum is always embedded, on every plan, regardless of this setting.'
      ])
    ]),

    el('div', {}, [
      el('h4', { class: 'eyebrow' }, ['Plan rules']),
      el('div', { class: 'toggle-grid' }, [...toggles, el('label', {}, [pharmOn, 'Separate pharmacy deductible'])])
    ]),

    plan.pharmacyDeductible
      ? el('div', { class: 'mini-grid' }, [
          numField('Pharmacy ded., individual', () => plan.pharmacyDeductible.individual, (v) => { plan.pharmacyDeductible.individual = v; }, 25),
          numField('Pharmacy ded., family', () => plan.pharmacyDeductible.family, (v) => { plan.pharmacyDeductible.family = v; }, 25)
        ])
      : null,

    el('div', {}, [
      el('h4', { class: 'eyebrow' }, ['Pricing assumptions']),
      el('div', { class: 'mini-grid' }, [
        pctField('In-network negotiated %', () => plan.negotiatedPct, (v) => { plan.negotiatedPct = v; }),
        pctField('Out-of-network allowed %', () => plan.oonAllowedPct, (v) => { plan.oonAllowedPct = v; })
      ]),
      el('p', { class: 'field-note', style: 'margin:5px 0 0' }, [
        'Percentage of the billed charge the plan recognises. Cost sharing runs on that, never on the billed amount.'
      ])
    ]),

    el('div', {}, [
      el('h4', { class: 'eyebrow' }, ['Cost sharing by service']),
      el('p', { class: 'field-note', style: 'margin:0 0 5px' }, [
        '"Ded?" means the deductible must be met first. Designated is the low-cost provider tier for labs and imaging; it falls back to in-network where a plan does not define one.'
      ]),
      benefitEditor(plan)
    ]),

    plan.notes ? el('p', { class: 'field-note' }, [plan.notes]) : null,
    plan.unread?.length
      ? el('p', { class: 'field-note is-warn' }, ['Not found in the document: ' + plan.unread.join(', ') + '. Check these against the source before trusting them.'])
      : null
  ]);

  const details = el('details', { class: 'plan-details' }, [
    el('summary', {}, ['Coverage detail']),
    expanded
  ]);

  const card = el('div', {
    class: 'card plan-card',
    style: `--plan-color:${plan.color || PLAN_COLORS[index % PLAN_COLORS.length]}`
  }, [head, front, warnBox, details]);

  return card;
}

function renderPlans() {
  const list = $('#planList');
  planWarnRefs.clear();
  list.replaceChildren();
  if (!state.plans.length) {
    list.appendChild(el('div', { class: 'empty' }, [
      el('strong', {}, ['No plans loaded']),
      'Read a plan PDF, add a blank plan, or load the five seed plans.'
    ]));
    return;
  }
  state.plans.forEach((p, i) => list.appendChild(planCard(p, i)));
}

/* ============================================================== HOUSEHOLD */

function renderHousehold() {
  const box = $('#householdChips');
  box.replaceChildren(...state.household.map((m) => {
    const input = el('input', { type: 'text', value: m.label, 'aria-label': 'Member name' });
    input.addEventListener('input', () => { m.label = input.value; renderScenarios(); });
    return el('span', { class: 'chip' }, [
      input,
      state.household.length > 1
        ? el('button', {
            type: 'button', text: '×', 'aria-label': `Remove ${m.label}`,
            onClick: () => {
              state.household = state.household.filter((x) => x.id !== m.id);
              // Reassign that member's care to the first remaining member rather than orphan it.
              const fallback = state.household[0].id;
              for (const s of state.scenarios) if (s.memberId === m.id) s.memberId = fallback;
              renderHousehold(); renderScenarios(); recompute();
            }
          })
        : null
    ]);
  }));
}

/* ============================================================== SCENARIOS */

const scenarioRefs = new Map();

function scenarioRow(s) {
  const meta = BENEFIT_META[s.benefitKey] || { label: s.benefitKey, max: 5000 };
  const max = meta.max || 5000;

  const labelInput = el('input', { class: 'scenario-label', type: 'text', value: s.label, 'aria-label': 'Description' });
  labelInput.addEventListener('input', () => { s.label = labelInput.value; });

  /* --- billed amount, with the slider directly beneath it -------------- */
  const amountInput = el('input', { type: 'number', min: '0', step: '5', value: s.billed, 'aria-label': 'Billed amount' });
  const slider = el('input', {
    type: 'range', min: '0', max: '1000', step: '1',
    value: dollarsToSlider(s.billed, max), 'aria-label': `Billed amount for ${s.label}`
  });

  amountInput.addEventListener('input', () => {
    s.billed = Math.max(0, Number(amountInput.value) || 0);
    slider.value = dollarsToSlider(s.billed, max);
    recompute();
  });
  slider.addEventListener('input', () => {
    s.billed = sliderToDollars(Number(slider.value), max);
    amountInput.value = s.billed;
    recompute();
  });

  /* --- member ---------------------------------------------------------- */
  const memberSel = el('select', {
    'aria-label': 'Household member',
    onChange: () => { s.memberId = memberSel.value; recompute(); }
  }, state.household.map((m) => el('option', { value: m.id, selected: m.id === s.memberId }, [m.label])));

  /* --- tier ------------------------------------------------------------ */
  const tierButtons = [
    ['designated', 'Desig.', !!meta.designated],
    ['in', 'In', true],
    ['out', 'Out', true]
  ].map(([tier, label, enabled]) => el('button', {
    type: 'button',
    'aria-pressed': String(s.tier === tier),
    disabled: !enabled,
    title: enabled
      ? (tier === 'designated' ? 'Designated low-cost provider' : tier === 'in' ? 'In network' : 'Out of network')
      : 'No Designated tier applies to this service',
    text: label,
    onClick: () => {
      s.tier = tier;
      for (const b of tierButtons) b.setAttribute('aria-pressed', String(b.textContent === label));
      recompute();
    }
  }));

  /* --- count ----------------------------------------------------------- */
  const countInput = el('input', { type: 'number', min: '0', max: '365', value: s.count, 'aria-label': 'Times per year' });
  const setCount = (n) => {
    s.count = Math.max(0, Math.min(365, Math.round(n) || 0));
    countInput.value = s.count;
    row.classList.toggle('is-idle', s.count === 0);
    recompute();
  };
  countInput.addEventListener('input', () => setCount(Number(countInput.value)));

  /* --- service ---------------------------------------------------------- */
  const svcSel = el('select', {
    'aria-label': 'Service',
    onChange: () => {
      s.benefitKey = svcSel.value;
      const m = BENEFIT_META[s.benefitKey];
      s.label = m.label;
      s.billed = m.billed;
      if (s.tier === 'designated' && !m.designated) s.tier = 'in';
      renderScenarios(); recompute();
    }
  }, BENEFIT_KEYS.map((k) => el('option', { value: k, selected: k === s.benefitKey }, [BENEFIT_META[k].label])));

  const marginal = el('div', { class: 'marginal' });

  const admittedRow = s.benefitKey === 'er'
    ? (() => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = !!s.admitted;
        cb.addEventListener('change', () => { s.admitted = cb.checked; recompute(); });
        return el('label', { class: 'admitted-row' }, [cb, 'Ended in admission (emergency copay waived)']);
      })()
    : null;

  const isNew = state.newScenarios.has(s.id);

  const row = el('div', {
    class: 'card scenario' + (s.count === 0 ? ' is-idle' : '') + (isNew ? ' is-new' : '')
  }, [
    el('div', { class: 'scenario-top' }, [
      labelInput,
      el('button', {
        class: 'icon-btn', type: 'button', text: '×', 'aria-label': `Remove ${s.label}`, title: 'Remove',
        onClick: () => {
          state.scenarios = state.scenarios.filter((x) => x.id !== s.id);
          renderScenarios(); recompute();
        }
      })
    ]),

    el('div', { class: 'scenario-billed' }, [
      el('div', { class: 'billed-row' }, [
        el('span', { class: 'control-label' }, ['Provider charges']),
        el('span', { class: 'amount-box' }, [el('span', { class: 'prefix' }, ['$']), amountInput])
      ]),
      slider
    ]),

    el('div', { class: 'scenario-controls' }, [
      memberSel,
      svcSel,
      el('span', { class: 'tier-toggle' }, tierButtons),
      el('span', { class: 'stepper' }, [
        el('button', { type: 'button', 'aria-label': 'One fewer', text: '−', onClick: () => setCount(s.count - 1) }),
        countInput,
        el('button', { type: 'button', 'aria-label': 'One more', text: '+', onClick: () => setCount(s.count + 1) })
      ])
    ]),

    admittedRow,
    marginal
  ]);

  // The haze clears the moment the row is acknowledged. `focusin` as well as `click` so that
  // reaching it by keyboard counts as noticing it.
  if (isNew) {
    const acknowledge = () => {
      state.newScenarios.delete(s.id);
      row.classList.remove('is-new');
      row.removeEventListener('click', acknowledge);
      row.removeEventListener('focusin', acknowledge);
    };
    row.addEventListener('click', acknowledge);
    row.addEventListener('focusin', acknowledge);
  }

  scenarioRefs.set(s.id, { marginal, row });
  return row;
}

function renderScenarios() {
  const list = $('#scenarioList');
  scenarioRefs.clear();
  list.replaceChildren();
  if (!state.scenarios.length) {
    list.appendChild(el('div', { class: 'empty' }, [
      el('strong', {}, ['No care in the year yet']),
      'Add the kinds of care you expect and set how often they happen.'
    ]));
    return;
  }
  for (const s of state.scenarios) list.appendChild(scenarioRow(s));
}

/**
 * The three-state readout beneath each scenario: what one visit costs before the deductible,
 * after it, and after the out-of-pocket maximum, for every plan at once.
 */
function renderMarginals() {
  for (const s of state.scenarios) {
    const refs = scenarioRefs.get(s.id);
    if (!refs) continue;

    if (!state.plans.length) { refs.marginal.replaceChildren(); continue; }

    const entries = state.plans.map((plan) => ({ plan, avail: benefitAvailability(plan, s.benefitKey, s.tier) }));
    const blocked = entries.filter((e) => e.avail.status === 'unavailable' || e.avail.status === 'notStated');

    const rows = entries.map(({ plan, avail }) => {
      const tag = el('span', { class: 'plan-tag', title: plan.name }, [
        el('span', { class: 'swatch', style: `background:${plan.color}` }),
        plan.name
      ]);

      // A plan that cannot do this says so in words. Showing the billed charge here would read
      // like a price sitting next to another plan's copay, when it means "you are on your own".
      if (avail.status === 'unavailable' || avail.status === 'notStated') {
        return el('div', { class: 'marginal-row is-blocked' }, [
          tag,
          el('span', {
            class: 'unavail' + (avail.status === 'notStated' ? ' is-unstated' : ''),
            title: avail.detail
          }, [avail.label]),
          el('span', { class: 'terms-line' }, [describeBenefit(plan, s.benefitKey, s.tier)])
        ]);
      }

      const m = marginalCosts(plan, s);
      const cells = [
        el('span', { class: 'money' }, [money(m.beforeDeductible.memberTotal)]),
        el('span', { class: 'money' }, [money(m.afterDeductible.memberTotal)]),
        el('span', { class: 'money' }, [money(m.afterOopMax.memberTotal)])
      ];

      // Covered, but not at the tier that was asked for — priced in network instead.
      if (avail.status === 'fallback') {
        tag.appendChild(el('span', { class: 'fallback-mark', title: avail.detail }, ['no desig.']));
      }

      // The figures alone cannot distinguish "covered, but you are still in the deductible"
      // from "not covered at all" — out of network both come to the whole billed charge. The
      // terms say which, and what the plan starts paying once the deductible is behind you.
      const terms = el('span', { class: 'terms-line' }, [describeBenefit(plan, s.benefitKey, s.tier)]);

      const planPays = m.afterDeductible.planPaid;
      if (planPays > 0) {
        terms.appendChild(el('span', { class: 'plan-pays' }, [
          `plan pays ${money(planPays)} of this visit once the deductible is met`
        ]));
      }

      return el('div', { class: 'marginal-row' }, [tag, ...cells, terms]);
    });

    const kids = [
      el('div', { class: 'marginal-head' }, ['One visit costs you']),
      el('div', { class: 'marginal-row head' }, [
        el('span', {}, ['']), el('span', {}, ['Before ded.']), el('span', {}, ['After ded.']), el('span', {}, ['After max'])
      ]),
      ...rows
    ];

    // Only worth calling out when the plans actually disagree.
    if (blocked.length && blocked.length < entries.length) {
      const anyUnstated = blocked.some((e) => e.avail.status === 'notStated');
      kids.push(el('div', { class: 'marginal-contrast' }, [
        `${blocked.length} of ${entries.length} plans ` +
        (anyUnstated ? 'cannot be priced for this care' : 'do not cover this at this tier') +
        ' — you would owe the whole charge, with nothing counting toward any limit.'
      ]));
    }

    refs.marginal.replaceChildren(...kids);
  }
}

/* ================================================================ RESULTS */

function accumulatorRail(plan, result) {
  const inT = plan.tiers.in;
  const ceiling = Math.max(inT.oopMax.family, 1);
  const spend = Math.min(result.accumulators.family.in.oop, ceiling);
  const dedWidth = Math.min(100, (inT.deductible.family / ceiling) * 100);
  const fillWidth = (spend / ceiling) * 100;
  const capped = spend >= ceiling - 0.5;

  return el('div', { class: 'rail' }, [
    el('div', { class: 'rail-track' }, [
      el('div', { class: 'rail-ded-zone', style: `width:${dedWidth}%` }),
      el('div', { class: 'rail-fill' + (capped ? ' is-capped' : ''), style: `width:${fillWidth}%` }),
      el('div', { class: 'rail-notch', style: `left:${dedWidth}%` })
    ]),
    el('div', { class: 'rail-labels' }, [
      el('span', {}, ['$0']),
      el('span', { class: 'rail-mid' }, [`${money(spend)} of covered care paid`]),
      el('span', {}, [`Max ${money(inT.oopMax.family)}`])
    ])
  ]);
}

function breakdown(result) {
  const row = (label, value, cls) => el('tr', { class: cls || '' }, [
    el('td', {}, [label]), el('td', {}, [money(value)])
  ]);

  const rows = [
    row('Premiums, 12 months', result.premiums),
    row('Deductible', result.deductiblePaid),
    row('Coinsurance', result.coinsurancePaid),
    row('Copays', result.copayPaid)
  ];

  // Flagged in a warning colour because nothing caps them.
  if (result.balanceBilled > 0) rows.push(row('Balance billed ▲', result.balanceBilled, 'flagged'));
  if (result.uncovered > 0) rows.push(row('Not covered ▲', result.uncovered, 'flagged'));

  rows.push(el('tr', { class: 'total' }, [
    el('td', {}, ['Your year, all in']), el('td', {}, [money(result.totalAnnual)])
  ]));

  return el('div', { class: 'breakdown' }, [el('table', {}, [el('tbody', {}, rows)])]);
}

function resultCard(result, rank) {
  const plan = state.plans.find((p) => p.id === result.planId);
  if (!plan) return null;

  const uncapped = round2(result.balanceBilled + result.uncovered);

  const card = el('div', {
    class: 'card result-card' + (result.isBest ? ' is-best' : ''),
    style: `--plan-color:${plan.color}`
  }, [
    el('div', { class: 'result-head' }, [
      el('div', {}, [
        el('div', { class: 'result-name' }, [plan.name]),
        plan.carrier ? el('div', { class: 'result-carrier' }, [plan.carrier]) : null
      ]),
      result.isBest
        ? el('span', { class: 'badge' }, ['Cheapest'])
        : el('span', { class: 'badge badge-rank' }, [`#${rank + 1}`])
    ]),

    el('div', { class: 'result-total' }, [
      el('span', { class: 'money money-lg' }, [money(result.totalAnnual)]),
      el('span', { class: 'result-delta' }, [
        result.isBest ? 'cheapest of the plans on screen' : `+${money(result.deltaVsBest)} vs cheapest`
      ])
    ]),

    accumulatorRail(plan, result),
    breakdown(result),

    el('p', { class: 'plain-line', html:
      `You would pay <b>${money(result.premiums)}</b> in premiums and <b>${money(result.memberCare)}</b> for care. ` +
      `The plan would pay <b>${money(result.planPaid)}</b> on your behalf` +
      (result.netBenefit >= 0
        ? `, which is <b>${money(result.netBenefit)}</b> more than your premiums.`
        : `, which is <b>${money(Math.abs(result.netBenefit))}</b> less than your premiums.`) +
      (uncapped > 0
        ? ` <span class="is-warn">${money(uncapped)} of your cost is balance billing or non-covered care, which nothing caps.</span>`
        : '')
    }),

    el('div', { class: 'result-foot' }, [
      el('span', {}, [`Worst case ${money(result.worstCase)}`]),
      el('button', {
        class: 'btn btn-xs', type: 'button', text: 'Per-visit ledger',
        onClick: () => openLedger(plan, result)
      })
    ])
  ]);

  if (result.premiumMissing) {
    card.querySelector('.result-total').appendChild(
      el('span', { class: 'result-delta is-warn' }, ['no premium entered'])
    );
  }
  return card;
}

function renderResults() {
  const list = $('#resultList');
  list.replaceChildren();

  if (!state.plans.length || !state.results.length) {
    list.appendChild(el('div', { class: 'empty' }, [
      el('strong', {}, ['Nothing to compare yet']),
      'Add a plan and some care to see how the year adds up.'
    ]));
    return;
  }

  // Cards are already sorted cheapest-first by compare(). But a plan with no premium entered
  // is only being charged for care, so it floats to the top on an incomplete figure — the
  // ranking is not yet a real answer and should not pretend to be.
  const missing = state.results.filter((r) => r.premiumMissing).length;
  if (missing) {
    list.appendChild(el('div', { class: 'rank-provisional' }, [
      `Ranking is provisional — ${missing} of ${state.results.length} `
      + `${missing === 1 ? 'plan is' : 'plans are'} missing a monthly premium, so `
      + `${missing === 1 ? 'it is' : 'they are'} being ranked on care costs alone and will sit `
      + 'higher than they should.'
    ]));
  }

  state.results.forEach((r, i) => {
    const card = resultCard(r, i);
    if (card) list.appendChild(card);
  });
}

/* ------------------------------------------------------------ ledger modal */

function openLedger(plan, result) {
  $('#ledgerTitle').textContent = `${plan.name} — per-visit ledger`;

  const head = el('thead', {}, [el('tr', {}, [
    '#', 'Service', 'Member', 'Tier', 'Billed', 'Allowed', 'Ded.', 'Coins.', 'Copay', 'Balance', 'Not cov.', 'You pay'
  ].map((h) => el('th', {}, [h])))]);

  const rows = result.lines.map((l, i) => {
    const flagged = l.balanceBilled > 0 || l.uncovered > 0;
    const a = l.availability;
    const serviceCell = el('td', {}, [l.label + (l.nsaProtected ? ' ⚑' : '')]);
    if (a && (a.status === 'unavailable' || a.status === 'notStated')) {
      serviceCell.appendChild(el('span', {
        class: 'unavail-inline' + (a.status === 'notStated' ? ' is-unstated' : ''),
        title: a.detail
      }, [a.label]));
    }
    return el('tr', { class: flagged ? 'has-warn' : '' }, [
      el('td', {}, [String(i + 1)]),
      serviceCell,
      el('td', {}, [memberLabel(l.memberId)]),
      el('td', {}, [l.tierUsed === 'designated' ? 'Desig.' : l.tierUsed === 'out' ? 'Out' : 'In']),
      el('td', {}, [money(l.billed)]),
      el('td', {}, [money(l.allowed)]),
      el('td', {}, [money(l.deductible)]),
      el('td', {}, [money(l.coinsurance)]),
      el('td', {}, [money(l.copay)]),
      el('td', { class: l.balanceBilled > 0 ? 'is-warn' : '' }, [money(l.balanceBilled)]),
      el('td', { class: l.uncovered > 0 ? 'is-warn' : '' }, [money(l.uncovered)]),
      el('td', {}, [money(l.memberTotal)])
    ]);
  });

  const body = rows.length
    ? el('table', { class: 'ledger' }, [head, el('tbody', {}, rows)])
    : el('div', { class: 'empty' }, [el('strong', {}, ['No visits in this year']), 'Set a count above zero on at least one row.']);

  $('#ledgerBody').replaceChildren(
    el('p', { class: 'field-note' }, [
      'Visits are interleaved across the year rather than batched, because the order claims arrive in decides who pays what. ⚑ marks a claim protected from balance billing by the No Surprises Act.'
    ]),
    body
  );
  $('#ledgerModal').hidden = false;
}

/* ============================================================== RECOMPUTE */

/**
 * The hot path. Synchronous, no IPC, no disk — it runs on every keystroke and every slider
 * tick, which is what makes dragging a charge feel connected to the totals.
 */
function recompute() {
  const totalBilled = state.scenarios.reduce((sum, s) => sum + (s.billed || 0) * (s.count || 0), 0);
  $('#totalBilled').textContent = money(totalBilled);

  state.results = state.plans.length ? compare(state.plans, state.scenarios, state.household) : [];

  refreshPlanWarnings();
  renderResults();
  renderMarginals();
  scheduleAutosave();
}

/* --------------------------------------------------------------- autosave */

let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    desktop.workspace.autosave({
      version: 1,
      plans: state.plans,
      household: state.household,
      scenarios: state.scenarios
    });
  }, 600);
}

function loadWorkspace(data) {
  if (!data || !Array.isArray(data.plans)) return false;
  state.household = Array.isArray(data.household) && data.household.length ? data.household : defaultHousehold();
  state.plans = data.plans.map((p, i) => normalizePlan(p, i));
  state.scenarios = (data.scenarios || []).map((s) => normalizeScenario(s, state.household));
  return true;
}

/* ================================================================ AI LAMP */

function setLamp(lampState, text) {
  state.ai.state = lampState;
  $('#aiDot').dataset.state = lampState;
  $('#aiText').textContent = text;
  $('#readPdfBtn').disabled = lampState !== 'on';
}

async function testConnection(override) {
  setLamp('checking', 'Checking…');
  const res = await desktop.ai.test(override);
  if (res.ok) setLamp('on', `Connected · ${res.model || state.ai.model}`);
  else if (res.error === 'No API key set.') setLamp('off', 'Not connected');
  else setLamp('error', 'Connection failed');
  return res;
}

/* ================================================================ WIRING */

async function refreshKeyHint() {
  const s = await desktop.settings.load();
  $('#keyHint').textContent = s.hasKey
    ? `Key stored: ${s.keyHint}${s.encryptionAvailable ? ' · encrypted by your operating system' : ' · THIS SESSION ONLY — your OS cannot encrypt it, so nothing was written to disk'}`
    : 'No key stored yet. The app works fully without one — only reading PDFs needs Claude.';
  return s;
}

function wireSettings() {
  const modal = $('#settingsModal');
  const open = () => { modal.hidden = false; $('#apiKeyInput').focus(); };
  const close = () => {
    modal.hidden = true;
    $('#testResult').textContent = '';
    $('#testResult').className = 'test-result';
    $('#apiKeyInput').value = '';
  };

  $('#settingsBtn').addEventListener('click', open);
  $('#aiPill').addEventListener('click', open);
  $('#closeSettings').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  const saveThen = async (thenTest) => {
    const result = $('#testResult');
    const apiKey = $('#apiKeyInput').value.trim();
    const model = $('#modelInput').value.trim() || 'claude-sonnet-5';
    state.ai.model = model;

    result.className = 'test-result';
    result.textContent = thenTest ? 'Contacting the API…' : 'Saving…';

    const saved = await desktop.settings.save({ apiKey: apiKey || undefined, model });

    if (!thenTest) {
      result.className = saved.ok ? 'test-result is-ok' : 'test-result is-bad';
      result.textContent = saved.ok ? (saved.warning || 'Saved.') : (saved.error || 'Could not save.');
      $('#apiKeyInput').value = '';
      await refreshKeyHint();
      if (saved.ok && (apiKey || state.ai.state === 'on')) testConnection();
      return;
    }

    const res = await testConnection({ apiKey: apiKey || undefined, model });
    if (res.ok) {
      result.className = 'test-result is-ok';
      result.textContent = 'Connected. ' + (saved.warning || 'Ready to read plan documents.');
      $('#apiKeyInput').value = '';
    } else {
      result.className = 'test-result is-bad';
      result.textContent = res.error;
    }
    refreshKeyHint();
  };

  $('#testBtn').addEventListener('click', () => saveThen(true));
  $('#saveKeyBtn').addEventListener('click', () => saveThen(false));

  $('#clearKeyBtn').addEventListener('click', async () => {
    await desktop.settings.clearKey();
    $('#apiKeyInput').value = '';
    $('#testResult').className = 'test-result';
    $('#testResult').textContent = 'Key removed.';
    setLamp('off', 'Not connected');
    refreshKeyHint();
  });

  // Ledger modal
  $('#closeLedger').addEventListener('click', () => { $('#ledgerModal').hidden = true; });
  $('#ledgerModal').addEventListener('click', (e) => { if (e.target === $('#ledgerModal')) $('#ledgerModal').hidden = true; });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!modal.hidden) close();
    if (!$('#ledgerModal').hidden) $('#ledgerModal').hidden = true;
  });
}

function wireImport() {
  const box = $('#importStatus');
  const lines = new Map();

  desktop.plans.onProgress(({ file, state: st }) => {
    box.hidden = false;
    let line = lines.get(file);
    if (!line) {
      line = el('div', { class: 'line' }, [el('span', {}, [file]), el('b', {}, ['reading…'])]);
      lines.set(file, line);
      box.appendChild(line);
    }
    const b = line.lastChild;
    b.textContent = st === 'done' ? 'read' : st === 'failed' ? 'could not read' : 'reading…';
    b.className = st === 'failed' ? 'is-bad' : '';
  });

  $('#readPdfBtn').addEventListener('click', async () => {
    const btn = $('#readPdfBtn');
    btn.disabled = true;
    box.hidden = false;
    box.replaceChildren(el('div', { class: 'line' }, [el('span', {}, ['Choose one or more plan PDFs.']), el('b', {}, [''])]));
    lines.clear();

    const res = await desktop.plans.import();
    btn.disabled = state.ai.state !== 'on';

    if (!res.ok) {
      box.replaceChildren(el('div', { class: 'line' }, [el('span', { class: 'is-bad' }, [res.error]), el('b', {}, [''])]));
      return;
    }
    if (res.canceled) { box.hidden = true; return; }

    for (const raw of res.plans) {
      const plan = normalizePlan({ ...raw, id: 'plan_' + uid(), source: 'ai' }, state.plans.length);
      state.plans.push(plan);
    }
    renderPlans();
    recompute();

    const done = res.plans.length;
    const failed = (res.failures || []).length;
    box.appendChild(el('div', { class: 'line line-summary' }, [
      el('span', {}, [
        `${done} ${done === 1 ? 'plan' : 'plans'} added.` +
        (failed ? ` ${failed} could not be read.` : '') +
        ' Check every figure against the source document before trusting it — extraction is good, not infallible.'
      ]),
      el('b', {}, [''])
    ]));
    for (const f of res.failures || []) {
      box.appendChild(el('div', { class: 'line' }, [el('span', { class: 'is-bad' }, [`${f.file}: ${f.error}`]), el('b', {}, [''])]));
    }
  });
}

function wireWorkspace() {
  $('#exportWsBtn').addEventListener('click', () => {
    desktop.workspace.export({
      version: 1,
      exportedAt: new Date().toISOString(),
      plans: state.plans,
      household: state.household,
      scenarios: state.scenarios,
      results: state.results.map((r) => ({
        planId: r.planId, premiums: r.premiums, memberCare: r.memberCare,
        totalAnnual: r.totalAnnual, deltaVsBest: r.deltaVsBest, planPaid: r.planPaid,
        deductiblePaid: r.deductiblePaid, coinsurancePaid: r.coinsurancePaid,
        copayPaid: r.copayPaid, balanceBilled: r.balanceBilled, uncovered: r.uncovered,
        worstCase: r.worstCase
      }))
    });
  });

  $('#importWsBtn').addEventListener('click', async () => {
    const res = await desktop.workspace.import();
    if (!res.ok || res.canceled || !res.data) return;
    if (!loadWorkspace(res.data)) return;
    renderAll();
  });
}

function wireToolbar() {
  $('#addPlanBtn').addEventListener('click', () => {
    const p = normalizePlan(blankPlan(state.plans.length), state.plans.length);
    p.name = `New plan ${state.plans.length + 1}`;
    p.tiers.in = { deductible: { individual: 1500, family: 3000 }, oopMax: { individual: 5000, family: 10000 } };
    p.tiers.out = { deductible: { individual: 3000, family: 6000 }, oopMax: { individual: 9000, family: 18000 } };
    state.plans.push(p);
    renderPlans(); recompute();
  });

  $('#loadSeedBtn').addEventListener('click', () => {
    state.plans = seedPlans();
    renderPlans(); recompute();
  });

  $('#addMemberBtn').addEventListener('click', () => {
    state.household.push({ id: 'm_' + uid(), label: `Member ${state.household.length + 1}` });
    renderHousehold(); renderScenarios(); recompute();
  });

  $('#addScenarioBtn').addEventListener('click', () => {
    const s = makeScenario('pcp', { memberId: state.household[0]?.id || 'm_self', count: 1 });
    state.scenarios.push(s);
    state.newScenarios.add(s.id);
    renderScenarios(); recompute();
    scenarioRefs.get(s.id)?.row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

/* --------------------------------------------------------------- text size */

function applyTextScale(scale, persist = true) {
  // Snap to the nearest defined step, so a stored odd value still lands somewhere sensible.
  let idx = TEXT_STEPS.indexOf(scale);
  if (idx === -1) {
    idx = TEXT_STEPS.reduce(
      (best, v, i) => (Math.abs(v - scale) < Math.abs(TEXT_STEPS[best] - scale) ? i : best), 0
    );
  }
  state.textScale = TEXT_STEPS[idx];

  try { desktop.ui.setZoom(state.textScale); }
  catch (err) { console.warn('Could not change the text size.', err); }

  $('#textSizeValue').textContent = Math.round(state.textScale * 100) + '%';
  $('#textSmaller').disabled = idx === 0;
  $('#textLarger').disabled = idx === TEXT_STEPS.length - 1;

  if (persist) scheduleTextScaleSave();
}

let textScaleTimer = null;
function scheduleTextScaleSave() {
  clearTimeout(textScaleTimer);
  // Debounced: holding an arrow down should not write settings.json once per press.
  textScaleTimer = setTimeout(() => {
    desktop.settings.save({ textScale: state.textScale }).catch(() => {});
  }, 400);
}

function stepTextScale(direction) {
  const idx = TEXT_STEPS.indexOf(state.textScale);
  const next = Math.min(TEXT_STEPS.length - 1, Math.max(0, idx + direction));
  applyTextScale(TEXT_STEPS[next]);
}

function wireTextSize() {
  $('#textSmaller').addEventListener('click', () => stepTextScale(-1));
  $('#textLarger').addEventListener('click', () => stepTextScale(1));
}

/* ================================================================= STARTUP */

function renderAll() {
  renderHousehold();
  renderPlans();
  renderScenarios();
  recompute();
}

async function start() {
  wireSettings();
  wireImport();
  wireWorkspace();
  wireToolbar();
  wireTextSize();

  // The app must render even if the bridge is missing or a handler throws. A failed restore
  // costs the user their autosave; it must never cost them the whole interface.
  try {
    const restored = await desktop.workspace.restore();
    if (restored?.ok && restored.data) loadWorkspace(restored.data);
  } catch (err) {
    console.warn('Could not restore the last session; starting from the seed plans.', err);
  }

  renderAll();

  try {
    const s = await refreshKeyHint();
    state.ai.model = s.model || 'claude-sonnet-5';
    $('#modelInput').value = state.ai.model;
    applyTextScale(s.textScale ?? 1, false);   // restore, without writing it straight back
    if (s.hasKey) testConnection();
    else setLamp('off', 'Not connected');
  } catch (err) {
    console.warn('Settings unavailable.', err);
    applyTextScale(1, false);
    setLamp('off', 'Not connected');
  }
}

start();
