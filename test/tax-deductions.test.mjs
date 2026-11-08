// lib/tax/deductions.mjs — 연말정산 공제 트래커 계산 엔진.
//
// 기대값은 손으로 계산한 값이다(docs/year-end-tax-guide.md 의 공제율 · 한도). 금액은 원.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeDeductions, DEDUCTION_KEYS, rulesFor, SUPPORTED_YEARS } from '../lib/tax/deductions.mjs';

const BASE = Object.freeze({
  year: 2026,
  salary: 50_000_000,
  marginalRate: 15,
  homelessHouseholder: true,
  mortgageTier: 'none',
  amounts: {},
});

const run = (overrides = {}) => computeDeductions({ ...BASE, ...overrides });
const pick = (result, key) => result.items.find((it) => it.key === key);

test('설계 미리보기 예시: 연봉 5천만 · 한계세율 15% · IRP 300만 · 청약 240만 · 보험 120만 · 카드 1,800만', () => {
  const result = run({
    amounts: { irp: 3_000_000, housing_subscription: 2_400_000, insurance: 1_200_000 },
    card: { credit: 18_000_000, estimated: true },
  });

  // IRP 300만 × 15% = 45만 + 지방소득세 4.5만. 900만까지 600만 더 → +99만
  assert.deepEqual(
    (({ eligibleAmount, effect, remaining, effectIfFilled }) => ({ eligibleAmount, effect, remaining, effectIfFilled }))(pick(result, 'irp')),
    { eligibleAmount: 3_000_000, effect: 495_000, remaining: 6_000_000, effectIfFilled: 990_000 },
  );

  // 청약 240만 × 40% = 96만 소득공제 × 15% = 14.4만 + 1.44만. 60만 더 → 공제 +24만 → +3.96만
  const sub = pick(result, 'housing_subscription');
  assert.equal(sub.deduction, 960_000);
  assert.equal(sub.effect, 158_400);
  assert.equal(sub.remaining, 600_000);
  assert.equal(sub.effectIfFilled, 39_600);

  // 보험 120만 → 한도 100만 × 12% = 12만 + 1.2만
  const insurance = pick(result, 'insurance');
  assert.equal(insurance.eligibleAmount, 1_000_000);
  assert.equal(insurance.effect, 132_000);
  assert.equal(insurance.remaining, 0);

  // 카드: 문턱 1,250만. (1,800만 − 1,250만) × 15% = 82.5만 소득공제 × 15% = 123,750 + 12,375
  const card = pick(result, 'card');
  assert.equal(card.deduction, 825_000);
  assert.equal(card.effect, 136_125);
  assert.equal(card.estimated, true);
  assert.equal(card.status, 'ok');

  assert.equal(result.summary.totalEffect, 495_000 + 158_400 + 132_000 + 136_125);
  assert.equal(result.summary.needsInput, 0);
});

test('연봉이 없으면 공제율이 연봉에 달린 항목은 needs_salary, 보험료 · 기부금은 계산된다', () => {
  const result = run({ salary: null, amounts: { irp: 1_000_000, insurance: 500_000, donation_general: 100_000 } });
  assert.equal(pick(result, 'irp').status, 'needs_salary');
  assert.equal(pick(result, 'irp').effect, null);
  assert.equal(pick(result, 'card').status, 'needs_salary');
  assert.equal(pick(result, 'housing_subscription').status, 'needs_salary');
  assert.equal(pick(result, 'rent').status, 'needs_salary');
  assert.equal(pick(result, 'insurance').effect, 66_000); // 50만 × 12% = 6만 + 6천
  assert.equal(pick(result, 'donation_general').effect, 16_500); // 10만 × 15% = 1.5만 + 1.5천
});

test('한계세율을 고르지 않으면 소득공제 항목은 공제액만 있고 효과는 null(needs_rate). 세액공제는 영향 없음', () => {
  const result = run({ marginalRate: null, amounts: { irp: 1_000_000, housing_subscription: 1_000_000 } });
  const sub = pick(result, 'housing_subscription');
  assert.equal(sub.status, 'needs_rate');
  assert.equal(sub.deduction, 400_000);
  assert.equal(sub.effect, null);
  assert.equal(sub.effectIfFilled, null);
  assert.equal(pick(result, 'irp').effect, 165_000);
  assert.equal(result.summary.totalEffect, 165_000);
});

test('한계세율이 높으면 같은 소득공제의 효과가 커진다', () => {
  const at15 = pick(run({ amounts: { housing_subscription: 3_000_000 } }), 'housing_subscription').effect;
  const at24 = pick(run({ marginalRate: 24, amounts: { housing_subscription: 3_000_000 } }), 'housing_subscription').effect;
  assert.equal(at15, 198_000); // 120만 × 15% = 18만 + 1.8만
  assert.equal(at24, 316_800); // 120만 × 24% = 28.8만 + 2.88만
});

test('연금계좌: 연금저축 600만 · 합산 900만 한도, 총급여 5,500만 초과면 12%', () => {
  const result = run({ salary: 60_000_000, amounts: { pension_savings: 7_000_000, irp: 4_000_000 } });
  const savings = pick(result, 'pension_savings');
  const irp = pick(result, 'irp');
  assert.equal(savings.eligibleAmount, 6_000_000);
  assert.equal(irp.eligibleAmount, 3_000_000);
  assert.equal(savings.effect, 792_000); // 600만 × 12% = 72만 + 7.2만
  assert.equal(irp.effect, 396_000);
  assert.equal(savings.remaining, 0);
  assert.equal(irp.remaining, 0);
  assert.ok(savings.notes.includes('한도를 넘은 금액은 공제되지 않는다'));
});

test('연금저축만 넣었으면 연금저축 남은 한도는 600만까지, IRP 남은 한도는 900만까지', () => {
  const result = run({ amounts: { pension_savings: 4_000_000 } });
  assert.equal(pick(result, 'pension_savings').remaining, 2_000_000);
  assert.equal(pick(result, 'irp').remaining, 5_000_000);
});

test('주택 관련: 무주택 세대주가 아니면 대상 아님, 미응답이면 needs_eligibility, 청약은 총급여 7천만 초과면 대상 아님', () => {
  const amounts = { housing_subscription: 1_000_000, lease_loan: 1_000_000, rent: 6_000_000 };
  const no = run({ homelessHouseholder: false, amounts });
  for (const key of ['housing_subscription', 'lease_loan', 'rent']) assert.equal(pick(no, key).status, 'ineligible', key);

  const unknown = run({ homelessHouseholder: null, amounts });
  for (const key of ['housing_subscription', 'lease_loan', 'rent']) assert.equal(pick(unknown, key).status, 'needs_eligibility', key);
  assert.equal(unknown.summary.needsInput, 3);

  assert.equal(pick(run({ salary: 75_000_000, amounts }), 'housing_subscription').status, 'ineligible');
});

test('월세: 총급여 5,500만 이하 17% · 8천만 이하 15% · 넘으면 대상 아님, 연 1,000만 한도', () => {
  assert.equal(pick(run({ amounts: { rent: 6_000_000 } }), 'rent').effect, 1_122_000); // 600만 × 17% = 102만 + 10.2만
  assert.equal(pick(run({ salary: 70_000_000, amounts: { rent: 12_000_000 } }), 'rent').effect, 1_650_000); // 1,000만 × 15%
  assert.equal(pick(run({ salary: 90_000_000, amounts: { rent: 6_000_000 } }), 'rent').status, 'ineligible');
});

test('전세대출 원리금은 청약 공제액과 합쳐 400만원까지', () => {
  const result = run({ amounts: { housing_subscription: 3_000_000, lease_loan: 10_000_000 } });
  assert.equal(pick(result, 'housing_subscription').deduction, 1_200_000);
  const lease = pick(result, 'lease_loan');
  assert.equal(lease.deduction, 2_800_000); // 1,000만 × 40% = 400만 → 남은 280만까지
  assert.equal(lease.remaining, 0);
  assert.equal(lease.effectIfFilled, 0);
});

test('주택담보대출 이자: 고른 구간 한도에서 청약 · 전세대출 공제액을 뺀 만큼', () => {
  const result = run({ mortgageTier: '6m', amounts: { housing_subscription: 3_000_000, mortgage_interest: 7_000_000 } });
  const mortgage = pick(result, 'mortgage_interest');
  assert.equal(mortgage.deduction, 4_800_000); // 600만 − 청약 120만
  assert.equal(mortgage.remaining, 0);
  assert.equal(pick(run({ mortgageTier: null, amounts: { mortgage_interest: 1 } }), 'mortgage_interest').status, 'needs_eligibility');
  assert.equal(pick(run({ amounts: { mortgage_interest: 1 } }), 'mortgage_interest').status, 'ineligible');
});

test('카드: 문턱은 공제율 낮은 사용분부터 채운다', () => {
  // 총급여 4천만 → 문턱 1,000만. 신용 800 + 체크 200 으로 채움 → 체크 400 × 30% + 전통시장 200 × 40%
  const card = pick(run({ salary: 40_000_000, card: { credit: 8_000_000, debit: 6_000_000, market: 2_000_000 } }), 'card');
  assert.equal(card.deduction, 1_200_000 + 800_000);
});

test('카드: 기본 한도를 넘으면 전통시장 · 대중교통 공제분만큼 추가 한도로 더 공제', () => {
  // 문턱 1,000만을 체크에서 채움 → 체크 2,000만 × 30% = 600만, 대중교통 300만 × 40% = 120만
  // 기본 300만 + 추가 min(420만, 300만, 120만) = 420만
  const card = pick(run({ salary: 40_000_000, card: { debit: 30_000_000, transit: 3_000_000 } }), 'card');
  assert.equal(card.deduction, 4_200_000);
  assert.equal(card.remaining, 0);
  assert.equal(card.cardProgress.base, 3_000_000);
  assert.equal(card.cardProgress.extra, 1_200_000);
  assert.equal(card.cardProgress.toThreshold, 0);
  assert.ok(card.notes.some((note) => note.startsWith('기본 한도를 다 채웠다')));
});

test('카드: 문턱 전이면 공제 0, 남은 금액은 문턱까지 + 기본 한도를 체크카드로 채울 금액', () => {
  const card = pick(run({ card: { credit: 10_000_000 } }), 'card');
  assert.equal(card.deduction, 0);
  assert.deepEqual(card.cardProgress, {
    threshold: 12_500_000,
    toThreshold: 2_500_000,
    baseLimit: 3_000_000,
    base: 0,
    extraLimit: 3_000_000,
    extra: 0,
  });
  // 문턱 1,250만까지 250만 + 기본 한도 300만 ÷ 30% = 1,000만
  assert.equal(card.remaining, 2_500_000 + 10_000_000);
});

test('카드: 총급여 7천만 초과면 문화체육은 신용카드 공제율, 기본 한도 250만', () => {
  const card = pick(run({ salary: 80_000_000, card: { credit: 20_000_000, culture: 10_000_000 } }), 'card');
  // 문턱 2,000만 → 신용(문화 포함) 3,000만 중 1,000만 × 15% = 150만
  assert.equal(card.deduction, 1_500_000);
});

test('기부금: 정치자금 · 고향사랑은 10만원까지 전액(지방소득세 포함), 넘는 금액 15%. 일반은 1천만 초과분 30%', () => {
  const result = run({ amounts: { donation_political: 150_000, donation_hometown: 100_000, donation_general: 12_000_000 } });
  // 10만 × 100/110 = 90,909 + 5만 × 15% = 7,500 → 98,409 + 9,840
  assert.equal(pick(result, 'donation_political').effect, 108_249);
  assert.equal(pick(result, 'donation_hometown').effect, 90_909 + 9_090);
  // 1,000만 × 15% + 200만 × 30% = 210만 + 21만
  assert.equal(pick(result, 'donation_general').effect, 2_310_000);
});

test('소득공제 종합한도 2,500만을 넘으면 요약 효과에서 넘는 만큼 뺀다(항목별 값은 그대로)', () => {
  // 총급여 6천만 · 한계세율 24%. 주택담보대출 이자 2,000만(한도 2,000만 구간)
  // 카드: 문턱 1,500만을 체크에서 채움 → 체크 3,500만 × 30% = 1,050만, 전통시장 1,000만 × 40% = 400만
  //       기본 300만 + 추가 min(1,150만, 300만, 400만) = 600만
  // 합계 2,600만 → 100만 초과 → 효과에서 100만 × 24% = 24만 + 2.4만 을 뺀다
  const result = run({
    salary: 60_000_000,
    marginalRate: 24,
    mortgageTier: '20m',
    amounts: { mortgage_interest: 20_000_000 },
    card: { debit: 50_000_000, market: 10_000_000 },
  });
  assert.equal(pick(result, 'mortgage_interest').deduction, 20_000_000);
  assert.equal(pick(result, 'card').deduction, 6_000_000);
  assert.equal(result.summary.incomeDeductionTotal, 26_000_000);
  assert.equal(result.summary.incomeDeductionOverCap, 1_000_000);
  const itemEffects = result.items.reduce((sum, it) => sum + (it.effect ?? 0), 0);
  assert.equal(result.summary.totalEffect, itemEffects - 264_000);
});

test('입력 검증: 음수 · 소수 · 모르는 키 · 모르는 연도 · 구간 밖 세율은 던지고, 메시지에 값을 넣지 않는다', () => {
  assert.throws(() => run({ amounts: { irp: -1_234_567 } }), (error) => error instanceof RangeError && !error.message.includes('1234567'));
  assert.throws(() => run({ amounts: { irp: 1.5 } }), RangeError);
  assert.throws(() => run({ amounts: { isa: 1 } }), RangeError);
  assert.throws(() => run({ year: 2019 }), RangeError);
  assert.throws(() => run({ marginalRate: 20 }), RangeError);
  assert.throws(() => run({ mortgageTier: '99m' }), RangeError);
  assert.throws(() => run({ card: { credit: -1 } }), RangeError);
});

test('안내 문구에는 금액이 들어가지 않는다', () => {
  const result = run({
    amounts: { pension_savings: 7_654_321, irp: 3_000_000, rent: 1_234_567 },
    card: { credit: 9_876_543, estimated: true },
  });
  for (const it of result.items) {
    for (const note of it.notes) assert.doesNotMatch(note, /\d{4,}/, `${it.key}: ${note}`);
  }
});

test('모든 공제 키가 결과에 한 번씩, 카드가 마지막. 지원 연도와 규칙이 맞물린다', () => {
  const keys = run().items.map((it) => it.key);
  assert.deepEqual([...keys].sort(), [...DEDUCTION_KEYS, 'card'].sort());
  assert.equal(keys.at(-1), 'card');
  for (const year of SUPPORTED_YEARS) assert.equal(rulesFor(year).year, year);
});

test('규칙: 한계세율 선택지는 세율 구간의 세율과 같고, 구간은 오름차순', () => {
  for (const year of SUPPORTED_YEARS) {
    const rules = rulesFor(year);
    assert.deepEqual(rules.marginalRates, rules.taxBrackets.map((b) => b.pct));
    for (let i = 1; i < rules.taxBrackets.length; i += 1) assert.ok(rules.taxBrackets[i].upTo > rules.taxBrackets[i - 1].upTo);
  }
});
