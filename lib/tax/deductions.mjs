// 연말정산 공제 트래커의 계산 엔진. 설계: docs/year-end-tax.md
//
// 가계부에서 모은 항목별 누적 금액과 사용자 설정(연봉 · 한계세율 · 자격)을 받아, 항목마다
// 공제 대상 금액 · 공제액 · 공제 효과(줄어드는 세금, 지방소득세 포함) · 남은 한도를 돌려준다.
//
//   - 순수 함수다. DB · 시간 · 환경변수를 보지 않는다.
//   - 결정세액 · 환급액은 계산하지 않는다. 효과는 "낼 세금이 충분할 때의 최대치"다.
//   - 한계세율은 추정하지 않는다. 사용자가 고른 값만 쓴다(없으면 소득공제 효과는 null).
//   - 오류 메시지 · 안내 문구(notes)에 금액을 넣지 않는다. 금액은 숫자 필드로만 돌려준다
//     (PLAN.md 로그 위생 — 문구가 어디에 찍혀도 값이 새지 않게).
import rules2026 from './rules/2026.mjs';

const RULES = Object.freeze({ 2026: rules2026 });

/** 가계부 항목 연결(tax_item_tags.deduction)과 같은 키. */
export const DEDUCTION_KEYS = Object.freeze([
  'pension_savings',
  'irp',
  'housing_subscription',
  'lease_loan',
  'mortgage_interest',
  'rent',
  'insurance',
  'donation_general',
  'donation_political',
  'donation_hometown',
]);

export const CARD_KINDS = Object.freeze(['credit', 'debit', 'culture', 'market', 'transit']);

/** 화면에 보일 공제 항목 이름. 카드 포함. */
export const DEDUCTION_LABELS = Object.freeze({
  pension_savings: '연금저축',
  irp: 'IRP',
  housing_subscription: '주택청약종합저축',
  lease_loan: '주택임차차입금 원리금',
  mortgage_interest: '장기주택저당차입금 이자',
  rent: '월세',
  insurance: '보장성 보험료',
  donation_general: '기부금(일반)',
  donation_political: '기부금(정치자금)',
  donation_hometown: '기부금(고향사랑)',
  card: '신용카드 등 사용액',
});

/**
 * @typedef {'ok' | 'needs_salary' | 'needs_rate' | 'needs_eligibility' | 'ineligible'} ItemStatus
 *
 * @typedef {object} DeductionItem
 * @property {string} key
 * @property {string} label
 * @property {'income' | 'credit'} kind 소득공제 | 세액공제
 * @property {ItemStatus} status
 * @property {number} amount 올해 누적 금액(입력 그대로)
 * @property {number | null} eligibleAmount 한도 · 요건을 적용한 공제 대상 금액
 * @property {number | null} deduction 소득공제액(소득공제 항목만)
 * @property {number | null} effect 줄어드는 세금(지방소득세 포함, 원)
 * @property {number | null} remaining 더 넣어도 공제되는 금액(누적 금액 기준). 한도가 없으면 null
 * @property {number | null} effectIfFilled remaining 을 다 채우면 늘어나는 효과
 * @property {boolean} estimated 가계부에서 근사한 값인가(카드)
 * @property {string[]} notes 화면에 보여 줄 짧은 안내
 * @property {CardProgress} [cardProgress] 카드 항목만: 문턱 · 한도 진행(화면의 진행 막대용)
 *
 * @typedef {object} CardProgress
 * @property {number} threshold 문턱(총급여 × 25%)
 * @property {number} toThreshold 문턱까지 남은 사용액(넘었으면 0)
 * @property {number} baseLimit 기본 공제한도
 * @property {number} base 기본 한도 안에서 받은 공제액
 * @property {number} extraLimit 추가 공제한도(전통시장 · 대중교통 · 문화체육)
 * @property {number} extra 추가 한도로 받은 공제액
 *
 * @typedef {object} CardInput
 * @property {number} [credit]
 * @property {number} [debit] 체크 · 직불 · 현금영수증
 * @property {number} [culture] 도서 · 공연 · 박물관 · 영화 · 체육시설
 * @property {number} [market] 전통시장
 * @property {number} [transit] 대중교통
 * @property {boolean} [estimated]
 *
 * @typedef {object} DeductionInput
 * @property {number} year 귀속연도
 * @property {number | null} salary 총급여(연봉, 원)
 * @property {number | null} marginalRate 사용자가 고른 한계세율(백분율 정수)
 * @property {boolean | null} homelessHouseholder 무주택 세대주인가
 * @property {string | null} mortgageTier 장기주택저당차입금 한도 구간 키, 해당 없으면 'none'
 * @property {Partial<Record<string, number>>} amounts DEDUCTION_KEYS 별 올해 누적 금액
 * @property {CardInput} [card]
 *
 * @typedef {object} DeductionResult
 * @property {number} year
 * @property {DeductionItem[]} items
 * @property {{ totalEffect: number, incomeDeductionTotal: number, incomeDeductionOverCap: number,
 *   needsInput: number }} summary
 */

/** 귀속연도 규칙. 없는 연도는 던진다. */
export function rulesFor(year) {
  const rules = RULES[year];
  if (!rules) throw new RangeError('지원하지 않는 귀속연도');
  return rules;
}

/** 지원하는 귀속연도 목록(오름차순). */
export const SUPPORTED_YEARS = Object.freeze(Object.keys(RULES).map(Number).sort((a, b) => a - b));

const pctOf = (amount, pct) => Math.floor((amount * pct) / 100);

/** 줄어드는 소득세에 지방소득세(소득세의 10%)를 더한다. */
const withLocal = (rules, incomeTax) => incomeTax + pctOf(incomeTax, rules.localTaxPct);

function checkAmount(value, field) {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} 는 0 이상의 정수(원)여야 한다`);
  return value;
}

function normalize(input) {
  const rules = rulesFor(input.year);
  const salary = input.salary === null || input.salary === undefined ? null : checkAmount(input.salary, 'salary');
  const marginalRate = input.marginalRate ?? null;
  if (marginalRate !== null && !rules.marginalRates.includes(marginalRate)) {
    throw new RangeError('marginalRate 는 기본세율 구간 중 하나여야 한다');
  }
  const mortgageTier = input.mortgageTier ?? null;
  if (mortgageTier !== null && mortgageTier !== 'none' && !rules.mortgageInterest.tiers[mortgageTier]) {
    throw new RangeError('mortgageTier 가 규칙에 없다');
  }
  const amounts = {};
  for (const key of DEDUCTION_KEYS) amounts[key] = checkAmount(input.amounts?.[key], `amounts.${key}`);
  for (const key of Object.keys(input.amounts ?? {})) {
    if (!DEDUCTION_KEYS.includes(key)) throw new RangeError(`amounts 에 모르는 키: ${key}`);
  }
  const card = {};
  for (const kind of CARD_KINDS) card[kind] = checkAmount(input.card?.[kind], `card.${kind}`);
  return {
    rules,
    salary,
    marginalRate,
    homeless: input.homelessHouseholder ?? null,
    mortgageTier,
    amounts,
    card,
    cardEstimated: Boolean(input.card?.estimated),
  };
}

function item(key, kind, amount, fields) {
  return {
    key,
    label: DEDUCTION_LABELS[key],
    kind,
    status: 'ok',
    amount,
    eligibleAmount: null,
    deduction: null,
    effect: null,
    remaining: null,
    effectIfFilled: null,
    estimated: false,
    notes: [],
    ...fields,
  };
}

/** 소득공제액 → 줄어드는 세금. 한계세율이 없으면 null. */
function incomeEffect(ctx, deduction) {
  return ctx.marginalRate === null ? null : withLocal(ctx.rules, pctOf(deduction, ctx.marginalRate));
}

// ── 세액공제 ────────────────────────────────────────────────────────────────

function pensionItems(ctx) {
  const { pension } = ctx.rules;
  const savings = ctx.amounts.pension_savings;
  const irp = ctx.amounts.irp;
  const savingsEligible = Math.min(savings, pension.savingsLimit);
  const irpEligible = Math.min(irp, pension.totalLimit - savingsEligible);
  const total = savingsEligible + irpEligible;
  const pct = ctx.salary === null ? null : ctx.salary <= pension.salaryThreshold ? pension.highPct : pension.lowPct;

  const savingsRoom = Math.min(pension.savingsLimit - savingsEligible, pension.totalLimit - total);
  const irpRoom = pension.totalLimit - total;

  const build = (key, amount, eligible, room) => {
    const notes = ['연금저축과 IRP 를 합쳐 연 900만원까지'];
    if (amount > eligible) notes.push('한도를 넘은 금액은 공제되지 않는다');
    if (pct === null) return item(key, 'credit', amount, { status: 'needs_salary', eligibleAmount: eligible, remaining: room, notes });
    return item(key, 'credit', amount, {
      eligibleAmount: eligible,
      effect: withLocal(ctx.rules, pctOf(eligible, pct)),
      remaining: room,
      effectIfFilled: withLocal(ctx.rules, pctOf(eligible + room, pct)) - withLocal(ctx.rules, pctOf(eligible, pct)),
      notes,
    });
  };

  return [
    build('pension_savings', savings, savingsEligible, savingsRoom),
    build('irp', irp, irpEligible, irpRoom),
  ];
}

function rentItem(ctx) {
  const { rent } = ctx.rules;
  const amount = ctx.amounts.rent;
  const eligible = Math.min(amount, rent.limit);
  const base = { eligibleAmount: eligible, remaining: rent.limit - eligible, notes: ['무주택 세대주 · 총급여 8천만원 이하'] };
  if (ctx.salary === null) return item('rent', 'credit', amount, { ...base, status: 'needs_salary' });
  const tier = rent.tiers.find((t) => ctx.salary <= t.salaryMax);
  if (!tier || ctx.homeless === false) return item('rent', 'credit', amount, { ...base, status: 'ineligible', remaining: null });
  if (ctx.homeless === null) return item('rent', 'credit', amount, { ...base, status: 'needs_eligibility' });
  const effect = withLocal(ctx.rules, pctOf(eligible, tier.pct));
  return item('rent', 'credit', amount, {
    ...base,
    effect,
    effectIfFilled: withLocal(ctx.rules, pctOf(rent.limit, tier.pct)) - effect,
  });
}

function insuranceItem(ctx) {
  const { insurance } = ctx.rules;
  const amount = ctx.amounts.insurance;
  const eligible = Math.min(amount, insurance.limit);
  const effect = withLocal(ctx.rules, pctOf(eligible, insurance.pct));
  return item('insurance', 'credit', amount, {
    eligibleAmount: eligible,
    effect,
    remaining: insurance.limit - eligible,
    effectIfFilled: withLocal(ctx.rules, pctOf(insurance.limit, insurance.pct)) - effect,
    notes: ['보장성 보험만(저축성 제외)'],
  });
}

function donationItems(ctx) {
  const { donation } = ctx.rules;

  /** 정치자금 · 고향사랑: 10만원까지 100/110 (지방소득세 포함 전액), 넘는 금액 15%. */
  const smallDonation = (key, amount, annualLimit) => {
    const eligible = annualLimit === null ? amount : Math.min(amount, annualLimit);
    const first = Math.min(eligible, donation.fullCreditMax);
    const incomeTax = Math.floor((first * 100) / 110) + pctOf(eligible - first, donation.overPct);
    const notes = ['10만원까지는 전액(지방소득세 포함) 돌려받는다'];
    if (amount > eligible) notes.push('연간 기부 한도를 넘은 금액은 공제되지 않는다');
    return item(key, 'credit', amount, { eligibleAmount: eligible, effect: withLocal(ctx.rules, incomeTax), notes });
  };

  const general = ctx.amounts.donation_general;
  const low = Math.min(general, donation.generalThreshold);
  const generalTax = pctOf(low, donation.generalLowPct) + pctOf(general - low, donation.generalHighPct);

  return [
    item('donation_general', 'credit', general, {
      eligibleAmount: general,
      effect: withLocal(ctx.rules, generalTax),
      notes: ['소득 대비 기부 한도는 계산하지 않는다'],
    }),
    smallDonation('donation_political', ctx.amounts.donation_political, null),
    smallDonation('donation_hometown', ctx.amounts.donation_hometown, donation.hometownAnnualLimit),
  ];
}

// ── 소득공제 ────────────────────────────────────────────────────────────────

/** 주택청약 → 주택임차차입금 → 장기주택저당차입금 순서로 합산 한도를 나눠 쓴다. */
function housingItems(ctx) {
  const { housingSubscription: sub, leaseLoan: lease, mortgageInterest: mortgage } = ctx.rules;
  const items = [];

  // 주택청약
  const subAmount = ctx.amounts.housing_subscription;
  const subEligible = Math.min(subAmount, sub.paymentLimit);
  let subDeduction = 0;
  const subNotes = ['총급여 7천만원 이하 무주택 세대주. 연 300만원 납입까지'];
  if (ctx.salary === null) {
    items.push(item('housing_subscription', 'income', subAmount, { status: 'needs_salary', eligibleAmount: subEligible, notes: subNotes }));
  } else if (ctx.salary > sub.salaryMax || ctx.homeless === false) {
    items.push(item('housing_subscription', 'income', subAmount, { status: 'ineligible', notes: subNotes }));
  } else if (ctx.homeless === null) {
    items.push(item('housing_subscription', 'income', subAmount, { status: 'needs_eligibility', eligibleAmount: subEligible, notes: subNotes }));
  } else {
    subDeduction = pctOf(subEligible, sub.pct);
    const filled = pctOf(sub.paymentLimit, sub.pct);
    const effect = incomeEffect(ctx, subDeduction);
    items.push(item('housing_subscription', 'income', subAmount, {
      status: effect === null ? 'needs_rate' : 'ok',
      eligibleAmount: subEligible,
      deduction: subDeduction,
      effect,
      remaining: sub.paymentLimit - subEligible,
      effectIfFilled: effect === null ? null : incomeEffect(ctx, filled) - effect,
      notes: subNotes,
    }));
  }

  // 주택임차차입금 원리금 — 청약 공제액과 합쳐 400만원
  const leaseAmount = ctx.amounts.lease_loan;
  let leaseDeduction = 0;
  const leaseNotes = ['무주택 세대주의 전세자금대출. 주택청약 공제와 합쳐 400만원까지'];
  if (ctx.homeless === false) {
    items.push(item('lease_loan', 'income', leaseAmount, { status: 'ineligible', notes: leaseNotes }));
  } else if (ctx.homeless === null) {
    items.push(item('lease_loan', 'income', leaseAmount, { status: 'needs_eligibility', notes: leaseNotes }));
  } else {
    const room = Math.max(0, lease.combinedLimit - subDeduction);
    leaseDeduction = Math.min(pctOf(leaseAmount, lease.pct), room);
    const effect = incomeEffect(ctx, leaseDeduction);
    const roomLeft = room - leaseDeduction;
    items.push(item('lease_loan', 'income', leaseAmount, {
      status: effect === null ? 'needs_rate' : 'ok',
      eligibleAmount: Math.min(leaseAmount, Math.ceil((room * 100) / lease.pct)),
      deduction: leaseDeduction,
      effect,
      // 남은 공제액을 채우려면 상환액이 공제율의 역수만큼 더 필요하다.
      remaining: Math.ceil((roomLeft * 100) / lease.pct),
      effectIfFilled: effect === null ? null : incomeEffect(ctx, leaseDeduction + roomLeft) - effect,
      notes: leaseNotes,
    }));
  }

  // 장기주택저당차입금 이자 — 사용자가 고른 구간 한도, 위 두 공제액과 합산
  const mortgageAmount = ctx.amounts.mortgage_interest;
  const mortgageNotes = ['상환 기간 · 방식에 따라 한도가 다르다. 주택청약 · 전세대출 공제와 합산'];
  let mortgageDeduction = 0;
  if (ctx.mortgageTier === null) {
    items.push(item('mortgage_interest', 'income', mortgageAmount, { status: 'needs_eligibility', notes: mortgageNotes }));
  } else if (ctx.mortgageTier === 'none') {
    items.push(item('mortgage_interest', 'income', mortgageAmount, { status: 'ineligible', notes: mortgageNotes }));
  } else {
    const room = Math.max(0, mortgage.tiers[ctx.mortgageTier].limit - subDeduction - leaseDeduction);
    mortgageDeduction = Math.min(mortgageAmount, room);
    const effect = incomeEffect(ctx, mortgageDeduction);
    items.push(item('mortgage_interest', 'income', mortgageAmount, {
      status: effect === null ? 'needs_rate' : 'ok',
      eligibleAmount: mortgageDeduction,
      deduction: mortgageDeduction,
      effect,
      remaining: room - mortgageDeduction,
      effectIfFilled: effect === null ? null : incomeEffect(ctx, room) - effect,
      notes: mortgageNotes,
    }));
  }

  return items;
}

/**
 * 신용카드 등 소득공제.
 *
 *   1. 문턱(총급여 × 25%)을 공제율이 낮은 사용분부터 채운다.
 *   2. 남은 사용액 × 결제수단별 공제율 = 공제 가능액.
 *   3. 기본 한도까지 공제. 넘는 금액은 min(넘는 금액, 추가 한도, 전통시장 · 대중교통 · 문화체육 공제 가능액)
 *      만큼 더 공제.
 */
function cardItem(ctx) {
  const { card } = ctx.rules;
  const used = { ...ctx.card };
  const amount = CARD_KINDS.reduce((sum, kind) => sum + used[kind], 0);
  const notes = [];
  if (ctx.cardEstimated) notes.push('카드대금 결제액으로 추정한 값. 공제되지 않는 결제(관리비 등)가 섞여 있을 수 있다');

  if (ctx.salary === null) {
    return item('card', 'income', amount, { status: 'needs_salary', estimated: ctx.cardEstimated, notes });
  }

  // 문화체육 30% 는 총급여 7천만 이하만. 넘으면 신용카드 사용분으로 본다.
  if (ctx.salary > card.cultureSalaryMax && used.culture > 0) {
    used.credit += used.culture;
    used.culture = 0;
    notes.push('총급여 7천만원 초과라 문화체육 사용분은 신용카드 공제율로 계산했다');
  }

  const threshold = pctOf(ctx.salary, card.thresholdPct);
  let toFill = threshold;
  const over = {};
  for (const kind of [...CARD_KINDS].sort((a, b) => card.pct[a] - card.pct[b])) {
    const consumed = Math.min(used[kind], toFill);
    toFill -= consumed;
    over[kind] = used[kind] - consumed;
  }

  const possible = Object.fromEntries(CARD_KINDS.map((kind) => [kind, pctOf(over[kind], card.pct[kind])]));
  const possibleTotal = CARD_KINDS.reduce((sum, kind) => sum + possible[kind], 0);
  const baseLimit = card.baseLimit.find((t) => ctx.salary <= t.salaryMax).limit;
  const extraLimit = card.extraLimit.find((t) => ctx.salary <= t.salaryMax).limit;
  const base = Math.min(possibleTotal, baseLimit);
  const extra = Math.min(possibleTotal - base, extraLimit, possible.market + possible.transit + possible.culture);
  const deduction = base + extra;

  if (toFill > 0) notes.push('아직 문턱(총급여의 25%)을 넘지 않았다. 그 전까지는 공제가 없다');
  else if (base < baseLimit) notes.push('문턱을 넘었다. 이제부터는 체크카드 · 현금영수증(30%)이 신용카드(15%)보다 유리하다');
  else notes.push('기본 한도를 다 채웠다. 전통시장 · 대중교통 사용분만 추가로 공제된다');

  const effect = incomeEffect(ctx, deduction);
  const roomLeft = baseLimit - base;
  return item('card', 'income', amount, {
    status: effect === null ? 'needs_rate' : 'ok',
    eligibleAmount: amount - Math.min(amount, threshold),
    deduction,
    effect,
    // 기본 한도를 체크카드 · 현금영수증(30%)으로 채운다고 볼 때 더 써야 하는 금액.
    remaining: toFill + Math.ceil((roomLeft * 100) / card.pct.debit),
    effectIfFilled: effect === null ? null : incomeEffect(ctx, deduction + roomLeft) - effect,
    estimated: ctx.cardEstimated,
    notes,
    cardProgress: { threshold, toThreshold: toFill, baseLimit, base, extraLimit, extra },
  });
}

// ── 전체 ────────────────────────────────────────────────────────────────────

/**
 * @param {DeductionInput} input
 * @returns {DeductionResult}
 */
export function computeDeductions(input) {
  const ctx = normalize(input);
  const items = [
    ...pensionItems(ctx),
    ...housingItems(ctx),
    rentItem(ctx),
    insuranceItem(ctx),
    ...donationItems(ctx),
    cardItem(ctx),
  ];

  // 소득공제 종합한도. 넘으면 넘는 공제액만큼 효과를 요약에서 뺀다(항목별 값은 그대로).
  const incomeDeductionTotal = items.reduce((sum, it) => sum + (it.kind === 'income' ? (it.deduction ?? 0) : 0), 0);
  const incomeDeductionOverCap = Math.max(0, incomeDeductionTotal - ctx.rules.incomeDeductionCap);
  const overCapEffect = incomeDeductionOverCap > 0 ? (incomeEffect(ctx, incomeDeductionOverCap) ?? 0) : 0;

  const totalEffect = items.reduce((sum, it) => sum + (it.effect ?? 0), 0) - overCapEffect;
  const needsInput = items.filter((it) => it.status.startsWith('needs_')).length;

  return { year: ctx.rules.year, items, summary: { totalEffect, incomeDeductionTotal, incomeDeductionOverCap, needsInput } };
}
