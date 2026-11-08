// lib/tax/store.mjs — 공제 트래커의 데이터 쪽(묶음 집계 · 연결 · 설정 · 후보 · 화면 조립).
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTracker,
  clearCardConfirmation,
  combineCard,
  deleteTag,
  describeMonths,
  emptySettings,
  loadCardConfirmation,
  loadCardUsage,
  loadSettings,
  loadTags,
  loadYearGroups,
  saveCardConfirmation,
  saveSettings,
  setTag,
  shiftMonth,
  suggestDeduction,
} from '../lib/tax/store.mjs';
import { withScratchDatabase } from './helpers/scratch-db.mjs';

test('후보 짐작: IRP · 연금저축 · 청약 · 월세 · 기부 · 보험, ISA · 4대보험은 후보 아님, 주거비 대출은 종류 미정 후보', () => {
  const cases = [
    ['저축', '미래에셋 IRP', { candidate: true, deduction: 'irp' }],
    ['저축', '개인형퇴직연금', { candidate: true, deduction: 'irp' }],
    ['저축', '연금저축펀드', { candidate: true, deduction: 'pension_savings' }],
    ['저축', '중개형 ISA', { candidate: false, deduction: null }],
    ['저축', '주택청약종합저축', { candidate: true, deduction: 'housing_subscription' }],
    ['주거비', '월세', { candidate: true, deduction: 'rent' }],
    ['변동비', '고향사랑기부제', { candidate: true, deduction: 'donation_hometown' }],
    ['변동비', '○○후원회', { candidate: true, deduction: 'donation_political' }],
    ['변동비', '유니세프 정기후원', { candidate: true, deduction: 'donation_general' }],
    ['고정비', '실손보험', { candidate: true, deduction: 'insurance' }],
    ['고정비', '국민건강보험', { candidate: false, deduction: null }],
    ['주거비', '전세대출 이자', { candidate: true, deduction: null }],
    ['변동비', '편의점', { candidate: false, deduction: null }],
  ];
  for (const [category, item, expected] of cases) assert.deepEqual(suggestDeduction(category, item), expected, item);
});

test('화면 조립: 연결된 묶음만 금액에 들어가고, 후보 · 그 밖 · 공제 아님으로 나뉜다', () => {
  const groups = [
    { category: '저축', item: 'IRP', net: 3_000_000, count: 6 },
    { category: '저축', item: '연금저축', net: 1_000_000, count: 2 },
    { category: '고정비', item: '실손보험', net: 600_000, count: 6 },
    { category: '고정비', item: '넷플릭스', net: 80_000, count: 6 },
    { category: '변동비', item: '환불만 있음', net: -5_000, count: 1 },
    { category: '고정비', item: '종신보험', net: 1_200_000, count: 6 },
  ];
  const tags = [
    { category: '저축', item: 'IRP', deduction: 'irp' },
    { category: '고정비', item: '종신보험', deduction: 'none' },
    { category: '저축', item: '작년에만 있던 연금', deduction: 'pension_savings' },
  ];
  const view = buildTracker({ year: 2026, groups, tags, settings: { ...emptySettings(), salary: 50_000_000 } });

  const irp = view.result.items.find((it) => it.key === 'irp');
  assert.equal(irp.amount, 3_000_000);
  assert.equal(irp.effect, 495_000);
  assert.deepEqual(view.sources.irp, [{ category: '저축', item: 'IRP', net: 3_000_000 }]);
  // 올해 거래가 없는 연결도 0원으로 남는다.
  assert.deepEqual(view.sources.pension_savings, [{ category: '저축', item: '작년에만 있던 연금', net: 0 }]);
  assert.equal(view.result.items.find((it) => it.key === 'pension_savings').amount, 0);

  assert.deepEqual(view.candidates.map((c) => [c.item, c.suggested]), [['연금저축', 'pension_savings'], ['실손보험', 'insurance']]);
  assert.deepEqual(view.others.map((c) => c.item), ['넷플릭스']);
  assert.deepEqual(view.dismissed.map((c) => c.item), ['종신보험']);
});

test('거래가 있는 달을 짧게 적는다', () => {
  assert.equal(describeMonths(['2026-03', '2026-04', '2026-05', '2026-10']), '3월~5월, 10월');
  assert.equal(describeMonths(['2026-01']), '1월');
  assert.equal(describeMonths([]), '');
});

test('실제 DB: 연도 묶음 집계(환불 차감 · 분류 별칭 · 제외 분류) · 설정 · 연결 왕복', async (t) => {
  await withScratchDatabase(t, 'tax_store', async (client) => {
    const rows = [
      // [txn_at, description, category, item, amount]
      ['2026-03-05T10:00:00+09:00', '미래에셋증권', '저축', 'IRP', -1_000_000],
      ['2026-04-05T10:00:00+09:00', '미래에셋증권', '저축', 'IRP', -1_000_000],
      ['2026-04-20T10:00:00+09:00', '미래에셋증권', '저축', 'IRP', 200_000], // 환불 · 해지
      ['2026-04-07T10:00:00+09:00', '주택청약', '저축', null, -200_000], // item 없음 → 적요
      ['2026-05-01T10:00:00+09:00', '편의점', '기타', null, -5_000], // 예전 분류 '기타' → 변동비
      ['2026-05-02T10:00:00+09:00', '월급', '수입', null, 3_000_000], // 수입은 대상 아님
      ['2026-05-03T10:00:00+09:00', '삼성카드주식회사', '카드대금', null, -900_000], // 카드대금은 T3
      ['2025-12-05T10:00:00+09:00', '미래에셋증권', '저축', 'IRP', -1_000_000], // 다른 해
    ];
    let n = 0;
    for (const [at, description, category, item, amount] of rows) {
      n += 1;
      await client.query(
        `INSERT INTO transactions (account_id, txn_at, description, txn_type, amount, category, item, dedupe_key, year_month)
         VALUES (1, $1, $2, '자동이체', $3, $4, $5, $6, to_char(($1::timestamptz AT TIME ZONE 'Asia/Seoul'), 'YYYY-MM'))`,
        [at, description, amount, category, item, `tax-store-${n}`],
      );
    }

    const { groups, months } = await loadYearGroups(client, 2026);
    assert.deepEqual(months, ['2026-03', '2026-04', '2026-05']);
    assert.deepEqual(
      groups.map((g) => [g.category, g.item, g.net, g.count]),
      [
        ['저축', 'IRP', 1_800_000, 3],
        ['저축', '주택청약', 200_000, 1],
        ['변동비', '편의점', 5_000, 1],
      ],
    );

    assert.deepEqual(await loadSettings(client, 2026), emptySettings());
    const settings = { salary: 52_000_000, marginalRate: 15, homelessHouseholder: true, mortgageTier: 'none' };
    await saveSettings(client, 2026, settings);
    assert.deepEqual(await loadSettings(client, 2026), settings);
    await saveSettings(client, 2026, { ...settings, marginalRate: null });
    assert.equal((await loadSettings(client, 2026)).marginalRate, null);

    await setTag(client, { category: '저축', item: 'IRP', deduction: 'irp' });
    await setTag(client, { category: '저축', item: 'IRP', deduction: 'pension_savings' });
    assert.deepEqual(await loadTags(client), [{ category: '저축', item: 'IRP', deduction: 'pension_savings' }]);
    assert.equal(await deleteTag(client, { category: '저축', item: 'IRP' }), 1);
    assert.equal(await deleteTag(client, { category: '저축', item: 'IRP' }), 0);
    assert.deepEqual(await loadTags(client), []);

    await assert.rejects(client.query("INSERT INTO tax_item_tags (category, item, deduction) VALUES ('저축', 'ISA', 'isa')"));
    await assert.rejects(client.query('INSERT INTO tax_year_settings (tax_year, marginal_rate) VALUES (2027, 20)'));
  });
});

test('카드: 확인값이 없으면 전부 추정(신용카드), 있으면 기준월까지 확인값 + 그 뒤 달만 추정', () => {
  const usage = [
    { month: '2026-08', total: 1_000_000 },
    { month: '2026-09', total: 2_000_000 },
    { month: '2026-10', total: 3_000_000 },
  ];
  assert.deepEqual(combineCard({ usage, confirmation: null }), {
    input: { credit: 6_000_000, debit: 0, culture: 0, market: 0, transit: 0, estimated: true },
    confirmedTotal: 0,
    estimatedTotal: 6_000_000,
    estimatedMonths: ['2026-08', '2026-09', '2026-10'],
  });

  const confirmation = { throughMonth: '2026-09', credit: 9_000_000, debit: 4_000_000, culture: 0, market: 500_000, transit: 300_000 };
  assert.deepEqual(combineCard({ usage, confirmation }), {
    input: { credit: 12_000_000, debit: 4_000_000, culture: 0, market: 500_000, transit: 300_000, estimated: true },
    confirmedTotal: 13_800_000,
    estimatedTotal: 3_000_000,
    estimatedMonths: ['2026-10'],
  });

  // 12월까지 확인했으면 추정이 없다.
  const full = combineCard({ usage, confirmation: { ...confirmation, throughMonth: '2026-12' } });
  assert.equal(full.input.estimated, false);
  assert.equal(full.estimatedTotal, 0);
});

test('카드: 결제월을 한 달 앞당긴다', () => {
  assert.equal(shiftMonth('2026-02', -1), '2026-01');
  assert.equal(shiftMonth('2027-01', -1), '2026-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
});

test('실제 DB: 카드대금 → 사용월 · 카드사별 추정(환불 차감, 귀속연도 밖 제외) · 확인값 왕복', async (t) => {
  await withScratchDatabase(t, 'tax_card', async (client) => {
    const rows = [
      // [txn_at, description, amount] — 모두 카드대금
      ['2026-01-14T10:00:00+09:00', '삼성카드주식회사', -900_000], // 2025-12 사용분 → 제외
      ['2026-02-14T10:00:00+09:00', '삼성카드주식회사', -1_000_000], // 2026-01
      ['2026-02-15T10:00:00+09:00', '현대카드', -500_000], // 2026-01
      ['2026-03-14T10:00:00+09:00', '삼성카드주식회사', -1_200_000], // 2026-02
      ['2026-03-20T10:00:00+09:00', '삼성카드주식회사', 200_000], // 2026-02 환불
      ['2027-01-14T10:00:00+09:00', 'KB카드출금', -700_000], // 2026-12
      ['2027-02-14T10:00:00+09:00', 'KB카드출금', -800_000], // 2027-01 → 제외
    ];
    let n = 0;
    for (const [at, description, amount] of rows) {
      n += 1;
      await client.query(
        `INSERT INTO transactions (account_id, txn_at, description, txn_type, amount, category, dedupe_key, year_month)
         VALUES (1, $1, $2, '펌뱅킹출금', $3, '카드대금', $4, to_char(($1::timestamptz AT TIME ZONE 'Asia/Seoul'), 'YYYY-MM'))`,
        [at, description, amount, `tax-card-${n}`],
      );
    }

    assert.deepEqual(await loadCardUsage(client, 2026), [
      {
        month: '2026-01',
        total: 1_500_000,
        byIssuer: [
          { issuer: '삼성카드', amount: 1_000_000 },
          { issuer: '현대카드', amount: 500_000 },
        ],
      },
      { month: '2026-02', total: 1_000_000, byIssuer: [{ issuer: '삼성카드', amount: 1_000_000 }] },
      { month: '2026-12', total: 700_000, byIssuer: [{ issuer: 'KB국민카드', amount: 700_000 }] },
    ]);

    assert.equal(await loadCardConfirmation(client, 2026), null);
    const value = { throughMonth: '2026-09', credit: 9_000_000, debit: 4_000_000, culture: 0, market: 500_000, transit: 300_000 };
    await saveCardConfirmation(client, 2026, value);
    assert.deepEqual(await loadCardConfirmation(client, 2026), value);
    await saveCardConfirmation(client, 2026, { ...value, throughMonth: '2026-10', debit: 0 });
    assert.equal((await loadCardConfirmation(client, 2026)).throughMonth, '2026-10');
    await clearCardConfirmation(client, 2026);
    assert.equal(await loadCardConfirmation(client, 2026), null);
    await assert.rejects(saveCardConfirmation(client, 2026, { ...value, throughMonth: '2025-12' }));
  });
});

test('화면 조립에 카드 입력을 넘기면 엔진의 카드 항목이 계산된다', () => {
  const view = buildTracker({
    year: 2026,
    groups: [],
    tags: [],
    settings: { salary: 50_000_000, marginalRate: 15, homelessHouseholder: null, mortgageTier: null },
    card: { credit: 18_000_000, estimated: true },
  });
  const card = view.result.items.find((it) => it.key === 'card');
  assert.equal(card.deduction, 825_000);
  assert.equal(card.estimated, true);
});
