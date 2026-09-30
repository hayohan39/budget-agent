// 현금흐름표의 항목 줄(항목별 · 계좌블록[].항목)과 분류 허용 목록.
//
// 지키는 것
//   1. 항목 줄의 합 = 그 섹션의 합계(건수도). 섹션 합계 · 실현순증감 · 검산은
//      항목 줄이 생기기 전과 같다. 2026-09 부터 항목 줄은 **거래 한 건**이다(합산하지
//      않는다) — 그래도 합계 · 검산 숫자는 합산하던 때와 똑같다(아래 fixture 값).
//   2. /classify 가 고를 수 있는 분류(CLASSIFY_CATEGORIES)는 부호와 무관하게
//      전부 집계의 명시적인 칸에 들어간다. "어느 칸에도 없는 분류" 갈래로
//      떨어지는 것이 하나도 없다.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openXlsxFile } from '../lib/xlsx/workbook.mjs';
import { parseTossStatement } from '../lib/toss/statement.mjs';
import { toTransactionRecords } from '../lib/toss/normalize.mjs';
import { classifyRecords, createClassifier } from '../lib/classify/engine.mjs';
import {
  CARD_CATEGORY,
  CLASSIFY_CATEGORIES,
  FIXED1_CATEGORIES,
  FIXED2_CATEGORIES,
  INCOME_CATEGORIES,
  LEGACY_OTHER_CATEGORY,
  SECTIONS,
  TRANSFER_CATEGORIES,
  VARIABLE_CATEGORY,
  aggregateMonthly,
  canonicalCategory,
  placeMainRow,
} from '../lib/report/monthly.mjs';
import { verifyMonthlyReport } from '../lib/report/verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'toss-sample-masked.xlsx');

const ACCOUNTS = Object.freeze([
  { id: 1, role: 'main', last4: '1288', nickname: '메인' },
  { id: 2, role: 'fixed', last4: '2222', nickname: '고정비' },
  { id: 3, role: 'emergency', last4: '3333', nickname: '비상금' },
]);

const SEED_RULES = Object.freeze([
  { id: 1, txn_type: null, pattern: '비상금 ?계좌', sign: null, category: '비상금이체', priority: 10 },
  { id: 2, txn_type: null, pattern: '고정비 ?계좌', sign: null, category: '고정비이체', priority: 20 },
  { id: 3, txn_type: '펌뱅킹출금', pattern: '카드', sign: -1, category: '카드대금', priority: 30 },
  { id: 4, txn_type: null, pattern: '대출 ?이자', sign: null, category: '주거비', priority: 40 },
  { id: 5, txn_type: null, pattern: 'IRP|ISA|연금', sign: null, category: '저축', priority: 50 },
  { id: 6, txn_type: null, pattern: '코인적립', sign: null, category: '저축', priority: 60 },
  { id: 7, txn_type: null, pattern: '통장 ?이자', sign: null, category: '이자', priority: 70 },
  { id: 8, txn_type: '이자입금', pattern: '.*', sign: null, category: '이자', priority: 80 },
  { id: 9, txn_type: '자동이체', pattern: '.*', sign: null, category: '고정비', priority: 90 },
  { id: 10, txn_type: null, pattern: '용돈', sign: -1, category: '용돈', priority: 75 },
]);

function fixtureRows(overrides = () => ({})) {
  const statement = parseTossStatement(openXlsxFile(FIXTURE).sheet(0));
  const records = toTransactionRecords(statement, ACCOUNTS);
  classifyRecords(records, createClassifier({ rules: SEED_RULES }));
  return records.map((record, index) => ({
    ...record,
    id: String(index + 1),
    amount: String(record.amount),
    balance: record.balance === null ? null : String(record.balance),
    ...overrides(record),
  }));
}

function sum(lines, field = 'total') {
  return lines.reduce((total, line) => total + line[field], 0);
}

/**
 * 항목 줄 = 거래 한 건. 줄마다 방향과 부호가 맞고, 같은 거래가 두 줄에 나오지 않으며,
 * 줄은 날짜순(같은 시각이면 id 내림차순)이다.
 */
function assertNoNetting(lines, label) {
  const seen = new Set();
  for (const line of lines) {
    assert.ok(line.direction === 'in' || line.direction === 'out', `${label} 방향`);
    if (line.direction === 'in') assert.ok(line.total > 0, `${label} ${line.item} 입금 줄은 +`);
    else assert.ok(line.total <= 0, `${label} ${line.item} 출금 줄은 −`);
    assert.equal(line.count, 1, `${label} ${line.item} 한 줄 = 한 건`);
    assert.ok(!seen.has(line.id), `${label} ${line.item} 같은 거래가 두 줄에 나온다`);
    seen.add(line.id);
  }
  const days = lines.map((line) => line.day).filter((day) => day !== null).map((day) => {
    const [month, date] = day.split('/').map(Number);
    return month * 100 + date;
  });
  assert.deepEqual(days, [...days].sort((a, b) => a - b), `${label} 날짜순`);
}

/** 항목 줄 합계 = 섹션 합계. 모든 섹션 · 모든 분류 · 모든 계좌 블록에 대해. */
function assertLinesAddUp(result) {
  for (const [name, lines] of Object.entries(result.항목별)) assertNoNetting(lines, name);
  for (const block of result.계좌블록) assertNoNetting(block.항목, block.role);

  assert.equal(sum(result.항목별.수입), result.수입.total, '수입');
  assert.equal(sum(result.항목별.수입, 'count'), result.수입.count, '수입 건수');
  assert.equal(sum(result.항목별.고정지출1), result.고정지출1.total, '고정지출1');
  assert.equal(sum(result.항목별.고정지출1, 'count'), result.고정지출1.count, '고정지출1 건수');
  assert.equal(sum(result.항목별.고정지출2), result.고정지출2.total, '고정지출2');
  assert.equal(sum(result.항목별.고정지출2, 'count'), result.고정지출2.count, '고정지출2 건수');
  assert.equal(sum(result.항목별.카드비), result.카드비.total, '카드비');
  assert.equal(sum(result.항목별.카드비, 'count'), result.카드비.count, '카드비 건수');
  assert.equal(sum(result.항목별.변동비), result.변동비.total, '변동비');
  assert.equal(sum(result.항목별.변동비, 'count'), result.변동비.count, '변동비 건수');

  // 분류 단위로도 맞는다(표는 분류마다 따로 그린다).
  for (const name of ['수입', '고정지출1', '고정지출2']) {
    for (const item of result[name].items) {
      assert.equal(
        sum(result.항목별[name].filter((line) => line.category === item.key)),
        item.total,
        `${name} ${item.key} 분류`,
      );
    }
  }
  // 카드비에는 카드대금 줄만 있다.
  assert.ok(result.항목별.카드비.every((line) => line.category === CARD_CATEGORY), '카드비는 카드대금만');
  // 변동비는 방향별 소계로도 맞는다(입금 줄 = 일회성 수입, 출금 줄 = 일회성 지출).
  const variableIn = result.항목별.변동비.filter((line) => line.direction === 'in');
  const variableOut = result.항목별.변동비.filter((line) => line.direction === 'out');
  assert.equal(sum(variableIn), result.변동비.일회성수입.total, '일회성 수입');
  assert.equal(sum(variableIn, 'count'), result.변동비.일회성수입.count, '일회성 수입 건수');
  assert.equal(sum(variableOut), result.변동비.일회성지출.total, '일회성 지출');
  assert.equal(sum(variableOut, 'count'), result.변동비.일회성지출.count, '일회성 지출 건수');

  for (const block of result.계좌블록) {
    assert.equal(sum(block.항목), block.집행.total, `${block.role} 집행`);
    assert.equal(sum(block.항목, 'count'), block.집행.count, `${block.role} 집행 건수`);
  }
}

test('fixture: 항목 줄의 합이 섹션 합계와 같고 검산은 그대로 통과한다', () => {
  const result = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows: fixtureRows() });
  assertLinesAddUp(result);

  // test/report-monthly.test.mjs 와 같은 값. 미분류 입금은 변동비의 일회성 수입이다.
  assert.equal(result.수입.total, 263);
  assert.equal(result.고정지출1.total, -5150000);
  assert.equal(result.고정지출2.total, 0);
  assert.equal(result.카드비.total, -5090698);
  assert.equal(result.변동비.일회성수입.total, 11479850);
  assert.equal(result.변동비.일회성지출.total, -181280);
  assert.equal(result.계좌간이동.total, -1500000);

  const verification = verifyMonthlyReport(result);
  assert.equal(verification.checked, true);
  assert.equal(verification.ok, true);
  assert.equal(verification.actual, -441865);
});

test('fixture: 저축 · 용돈 · 주거비가 거래 한 건씩 날짜순 줄로 풀린다', () => {
  const result = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows: fixtureRows() });
  const lines = (category) =>
    result.항목별.고정지출1
      .filter((line) => line.category === category)
      .map((line) => [line.day, line.item, line.total]);

  // 같은 날(같은 초)의 거래는 파일 순서(id 내림차순 = 더 과거가 먼저)다.
  assert.deepEqual(lines('저축'), [
    ['8/3', '길동 IRP', -350000],
    ['8/3', '홍길동 ISA', -1000000],
    ['8/3', '김철수 ISA', -1000000],
    ['8/3', '철수 연금저축', -500000],
    ['8/3', '김철수 IRP', -300000],
    ['8/5', '코인적립', -200000],
  ]);
  assert.deepEqual(lines('용돈'), [
    ['8/2', '철수 용돈', -500000],
    ['8/2', '길동 용돈', -500000],
  ]);
  assert.deepEqual(lines('주거비'), [['8/4', '대출 이자', -800000]]);

  // 카드대금은 카드사 이름이 항목이다(적요 표기가 달라도 같은 이름). 2026-09 부터 카드사별로
  // 더하지 않고 **출금 한 건이 한 줄**이다 — 삼성카드 두 건이 따로 보인다.
  assert.deepEqual(
    result.항목별.카드비.map((line) => [line.day, line.item, line.total]),
    [
      ['8/12', '현대카드', -1901314],
      ['8/14', '삼성카드', -317012],
      ['8/14', 'KB국민카드', -14050],
      ['8/21', '삼성카드', -2858322],
    ],
  );
  // 카드사 묶음(`카드비.issuers`)은 데이터에 그대로 있다 — 합계는 같다.
  assert.deepEqual(
    result.카드비.issuers.map((issuer) => [issuer.issuer, issuer.total]),
    [
      ['삼성카드', -3175334],
      ['현대카드', -1901314],
      ['KB국민카드', -14050],
    ],
  );
  // 미분류는 변동비에 미분류 꼬리표로, 적요가 항목이다. 같은 적요(김철수)라도 거래마다 한 줄이고,
  // 메모는 그 거래의 메모 하나다.
  assert.deepEqual(
    result.항목별.변동비.map((line) => [line.day, line.category, line.item, line.total, line.memo]),
    [
      ['8/1', '미분류', '김철수', 1000000, '곰돌이 휴가비'],
      ['8/5', '미분류', '김철수', -170000, '경주 숙박비'],
      ['8/14', '미분류', '김철수', 3500000, '곰돌이 월급'],
      ['8/16', '미분류', '이영희', -7500, null],
      ['8/20', '미분류', '코웨이08월렌탈', -3780, null],
      ['8/25', '미분류', '전자카드비', 1045850, null],
      ['8/29', '미분류', '홍길동', 5900000, null],
      ['8/30', '미분류', '김철수', 34000, null],
    ],
  );
});

test('항목 줄의 날짜는 실행 환경의 시간대와 무관하게 한국 시각이다', () => {
  // UTC 로는 8/31 15:30 이지만 한국 시각으로는 9/1 00:30 이다.
  const result = aggregateMonthly({
    yearMonth: '2026-09',
    accounts: ACCOUNTS,
    rows: [
      { id: '1', account_id: 1, txn_at: '2026-09-01T00:30:00+09:00', description: '가상가게', amount: '-100', category: VARIABLE_CATEGORY },
      { id: '2', account_id: 1, txn_at: new Date('2026-09-30T23:59:59+09:00'), description: '가상가게', amount: '-200', category: VARIABLE_CATEGORY },
    ],
  });
  assert.deepEqual(
    result.항목별.변동비.map((line) => [line.id, line.day, line.total]),
    [
      ['1', '9/1', -100],
      ['2', '9/30', -200],
    ],
  );
});

test('저장된 항목이 적요를 이긴다 — 다른 적요도 같은 항목 이름으로 보이되 합산하지 않는다', () => {
  const rows = fixtureRows((record) =>
    record.description === '김철수 ISA' || record.description === '홍길동 ISA'
      ? { item: 'ISA' }
      : record.description === '삼성카드주식회사'
        ? { item: '생활비카드' }
        : {},
  );
  const result = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows });
  assertLinesAddUp(result);

  const isa = result.항목별.고정지출1.filter((line) => line.item === 'ISA');
  assert.deepEqual(isa, [
    { id: '17', day: '8/3', category: '저축', item: 'ISA', direction: 'out', total: -1000000, count: 1, memo: null },
    { id: '16', day: '8/3', category: '저축', item: 'ISA', direction: 'out', total: -1000000, count: 1, memo: null },
  ]);
  // 카드대금에 항목을 정하면 카드사 묶음도 그 이름으로 간다.
  assert.ok(result.카드비.issuers.some((issuer) => issuer.issuer === '생활비카드'));
  assert.equal(result.종합정산.실현순증감, -441865);
});

test('같은 적요 · 같은 항목의 입금과 출금은 서로 다른 줄이고 상쇄하지 않는다', () => {
  // 김철수: 입금 3건(34,000 · 3,500,000 · 1,000,000)과 출금 1건(−170,000).
  // 전부 '수입' 으로 고르면 출금도 수입 섹션에 남는다(INCOME_CATEGORIES).
  const rows = fixtureRows((record) =>
    record.description === '김철수' ? { category: '수입', category_source: 'manual', item: '철수' } : {},
  );
  const result = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows });
  assertLinesAddUp(result);

  const kim = result.항목별.수입
    .filter((line) => line.item === '철수')
    .map((line) => [line.direction, line.total]);
  assert.deepEqual(kim, [
    ['in', 1000000],
    ['out', -170000],
    ['in', 3500000],
    ['in', 34000],
  ]);

  // 분류 단위 합계 · 섹션 합계 · 실현순증감 · 검산은 방향으로 나누기 전과 같다.
  const baseline = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows: fixtureRows() });
  assert.equal(result.종합정산.실현순증감, baseline.종합정산.실현순증감);
  assert.equal(
    result.수입.total + result.변동비.total,
    baseline.수입.total + baseline.변동비.total,
    '김철수의 입금 · 출금이 변동비(미분류)에서 수입 섹션으로 옮겨 갔을 뿐이다',
  );
  assert.equal(verifyMonthlyReport(result).ok, true);
  assert.equal(verifyMonthlyReport(result).actual, -441865);
});

test('미분류는 방향과 무관하게 변동비에 보이고, 입금 줄과 출금 줄이 나뉜다', () => {
  const result = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows: fixtureRows() });
  const kim = result.항목별.변동비.filter((line) => line.item === '김철수');
  assert.deepEqual(
    kim.map((line) => [line.category, line.direction, line.total]),
    [
      ['미분류', 'in', 1000000],
      ['미분류', 'out', -170000],
      ['미분류', 'in', 3500000],
      ['미분류', 'in', 34000],
    ],
  );
  // 수입 섹션에는 미분류 줄이 없다.
  assert.ok(result.항목별.수입.every((line) => line.category !== '미분류'));
  assert.ok(result.수입.items.every((item) => item.key !== '미분류'));
});

// ── 허용 목록 ↔ 집계 ──────────────────────────────────────────────────────

test('허용 목록은 집계가 칸을 가진 분류 전부이고 그 밖에는 없다', () => {
  assert.deepEqual(
    new Set(CLASSIFY_CATEGORIES),
    new Set([
      ...INCOME_CATEGORIES,
      ...FIXED1_CATEGORIES,
      ...FIXED2_CATEGORIES,
      CARD_CATEGORY,
      VARIABLE_CATEGORY,
      ...Object.keys(TRANSFER_CATEGORIES),
    ]),
  );
  // 예전 '기타' 는 변동비로 합쳤다 — 더는 고를 수 없다.
  assert.ok(!CLASSIFY_CATEGORIES.includes('기타'));
  assert.equal(new Set(CLASSIFY_CATEGORIES).size, CLASSIFY_CATEGORIES.length, '중복 없음');
  // 보정 대상 이름(adjustments_target_valid)과 어긋나지 않는다.
  for (const target of ['수입', '저축', '용돈', '주거비', '고정비', '비상금', '변동비']) {
    assert.ok(CLASSIFY_CATEGORIES.includes(target), target);
  }
});

test('허용된 분류는 부호와 무관하게 명시적인 칸에 들어간다', () => {
  const sections = new Set(Object.values(SECTIONS));
  for (const category of CLASSIFY_CATEGORIES) {
    for (const amount of ['-12345', '0', '12345']) {
      const place = placeMainRow({ category, amount, is_transfer: false });
      assert.equal(place.explicit, true, `${category} ${amount}`);
      assert.ok(sections.has(place.section), `${category} ${amount} -> ${place.section}`);
    }
  }

  // 이 테스트가 빈 검사가 아니라는 확인 — 목록 밖의 분류는 명시적인 칸이 없다.
  assert.equal(placeMainRow({ category: '손수정', amount: '-1' }).explicit, false);
});

test('출금 분류마다 기대한 칸으로 간다', () => {
  const expected = {
    수입: SECTIONS.income,
    이자: SECTIONS.income,
    저축: SECTIONS.fixed1,
    용돈: SECTIONS.fixed1,
    주거비: SECTIONS.fixed1,
    고정비: SECTIONS.fixed2,
    비상금: SECTIONS.fixed2,
    카드대금: SECTIONS.card,
    변동비: SECTIONS.variable,
    고정비이체: SECTIONS.transfer,
    비상금이체: SECTIONS.transfer,
  };
  assert.deepEqual(Object.keys(expected).sort(), [...CLASSIFY_CATEGORIES].sort());
  for (const [category, section] of Object.entries(expected)) {
    assert.equal(placeMainRow({ category, amount: '-1' }).section, section, category);
  }
});

test('모든 허용 분류 × 양쪽 부호로 집계해도 항목 줄과 항등식이 맞는다', () => {
  const rows = [];
  let id = 0;
  for (const category of CLASSIFY_CATEGORIES) {
    for (const amount of [-7000, 3000]) {
      id += 1;
      rows.push({
        id: String(id),
        account_id: 1,
        txn_at: `2026-08-${String((id % 27) + 1).padStart(2, '0')}T00:00:00+09:00`,
        description: `${category} 항목 ${id}`,
        txn_type: '자동이체',
        amount: String(amount),
        balance: null,
        category,
        is_transfer: false,
      });
    }
  }
  const result = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows });
  assertLinesAddUp(result);

  const sumOfAmounts = rows.reduce((total, row) => total + Number(row.amount), 0);
  assert.equal(result.종합정산.실현순증감, sumOfAmounts);
  assert.equal(
    result.종합정산.수입 +
      result.종합정산.고정지출1 +
      result.종합정산.고정지출2 +
      result.종합정산.카드비 +
      result.종합정산.변동비 +
      result.종합정산.계좌간이동,
    result.종합정산.실현순증감,
  );
  // 변동비에는 사람이 고른 '변동비' 줄만 있다(입금 · 출금 둘 다) — 목록 밖 갈래로 샌
  // 것이 없다. 카드비에는 카드대금 출금만 있다(카드대금 입금은 수입이다).
  assert.deepEqual(
    result.항목별.변동비.map((line) => [line.category, line.direction, line.total]),
    [
      [VARIABLE_CATEGORY, 'out', -7000],
      [VARIABLE_CATEGORY, 'in', 3000],
    ],
  );
  assert.deepEqual(
    result.항목별.카드비.map((line) => [line.category, line.direction, line.total]),
    [[CARD_CATEGORY, 'out', -7000]],
  );
});

// ── 변동비 = 일회성 수입 · 지출 (예전 기타 포함) ──────────────────────────

test('변동비: 입금은 일회성 수입, 출금은 일회성 지출 — 둘 다 변동비 섹션이고 수입이 아니다', () => {
  for (const amount of ['-1', '0', '1']) {
    assert.deepEqual(placeMainRow({ category: VARIABLE_CATEGORY, amount }), {
      section: SECTIONS.variable,
      key: VARIABLE_CATEGORY,
      explicit: true,
    });
    // 미분류도 방향과 무관하게 변동비에 일단 보인다.
    assert.deepEqual(placeMainRow({ category: null, amount }), {
      section: SECTIONS.variable,
      key: '미분류',
      explicit: true,
    });
  }

  // fixture 의 미분류 중 김철수(입금 3 · 출금 1)와 이영희(출금 1)를 변동비로 고른다.
  const baseline = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows: fixtureRows() });
  const rows = fixtureRows((record) =>
    record.description === '김철수' || record.description === '이영희'
      ? { category: VARIABLE_CATEGORY, category_source: 'manual' }
      : {},
  );
  const result = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows });
  assertLinesAddUp(result);

  assert.equal(baseline.미분류.count, 8);
  assert.equal(result.미분류.count, 3, '변동비는 분류된 것이다');

  assert.deepEqual(
    result.항목별.변동비
      .filter((line) => line.category === VARIABLE_CATEGORY)
      .map((line) => [line.item, line.direction, line.total]),
    [
      ['김철수', 'in', 1000000],
      ['김철수', 'out', -170000],
      ['김철수', 'in', 3500000],
      ['이영희', 'out', -7500],
      ['김철수', 'in', 34000],
    ],
  );
  // 입금은 수입 섹션으로 가지 않는다.
  assert.ok(result.수입.items.every((item) => item.key !== VARIABLE_CATEGORY));
  assert.equal(result.수입.total, baseline.수입.total);

  // 미분류 → 변동비는 같은 섹션 안의 이동이라 섹션 합계 · 실현순증감 · 검산이 그대로다.
  assert.equal(result.변동비.total, baseline.변동비.total);
  assert.deepEqual(result.변동비.일회성수입, baseline.변동비.일회성수입);
  assert.deepEqual(result.변동비.일회성지출, baseline.변동비.일회성지출);
  assert.equal(result.종합정산.실현순증감, baseline.종합정산.실현순증감);
  assert.equal(verifyMonthlyReport(result).ok, true);
});

test('예전 기타는 읽을 때 변동비다 — 저장된 값을 고치지 않아도 같은 줄에 모인다', () => {
  assert.equal(canonicalCategory(LEGACY_OTHER_CATEGORY), VARIABLE_CATEGORY);
  assert.equal(canonicalCategory(null), null);
  assert.equal(canonicalCategory(undefined), null);
  assert.equal(canonicalCategory('저축'), '저축');
  for (const amount of ['-1', '1']) {
    assert.deepEqual(placeMainRow({ category: LEGACY_OTHER_CATEGORY, amount }), {
      section: SECTIONS.variable,
      key: VARIABLE_CATEGORY,
      explicit: true,
    });
  }

  // 김철수는 예전 기타, 이영희는 변동비로 저장돼 있어도 결과는 둘 다 변동비로 고른 것과 같다.
  const legacy = fixtureRows((record) =>
    record.description === '김철수'
      ? { category: LEGACY_OTHER_CATEGORY, category_source: 'manual' }
      : record.description === '이영희'
        ? { category: VARIABLE_CATEGORY, category_source: 'manual' }
        : {},
  );
  const merged = fixtureRows((record) =>
    record.description === '김철수' || record.description === '이영희'
      ? { category: VARIABLE_CATEGORY, category_source: 'manual' }
      : {},
  );
  const fromLegacy = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows: legacy });
  const fromMerged = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows: merged });
  assertLinesAddUp(fromLegacy);
  assert.deepEqual(fromLegacy, fromMerged);

  // 비메인 계좌의 집행 줄도 같은 규칙이다.
  const block = aggregateMonthly({
    yearMonth: '2026-08',
    accounts: ACCOUNTS,
    rows: [
      { id: '1', account_id: 2, txn_at: '2026-08-01T00:00:00+09:00', description: '가상가게', amount: '-100', category: LEGACY_OTHER_CATEGORY },
    ],
  }).계좌블록.find((entry) => entry.role === 'fixed');
  assert.deepEqual(block.항목.map((line) => line.category), [VARIABLE_CATEGORY]);
});
