// 가계부 통계(월별 추이) 집계 테스트. 합성 데이터만 쓴다 — 이름 · 금액은 가상이다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateMonthly } from '../lib/report/monthly.mjs';
import {
  TREND_SERIES,
  fillTrendMonths,
  loadMonthlyTrends,
  monthSpan,
  nextYearMonth,
  trendPointOf,
} from '../lib/report/trends.mjs';

const ACCOUNTS = Object.freeze([
  { id: 1, role: 'main', nickname: '메인' },
  { id: 2, role: 'fixed', nickname: '고정비' },
  { id: 3, role: 'emergency', nickname: '비상금' },
]);

let seq = 0;
function row(overrides = {}) {
  seq += 1;
  return {
    id: String(seq),
    account_id: 1,
    txn_at: '2026-08-10T00:00:00+09:00',
    description: '',
    txn_type: '입금',
    amount: '0',
    balance: null,
    category: null,
    is_transfer: false,
    item: null,
    ...overrides,
  };
}

/** 세 계좌가 모두 도는 한 달. 금액은 **문자열**(pg 의 BIGINT 모양)이다. */
function monthRows() {
  return [
    // 메인 수입
    row({ amount: '3000000', description: '가상회사 급여', category: '수입' }),
    row({ amount: '120', txn_type: '이자입금', category: '이자' }),
    // 메인 → 고정비 · 비상금 이체(보낸 쪽)
    row({ amount: '-1000000', description: '고정비 계좌', category: '고정비이체', is_transfer: true }),
    row({ amount: '-300000', description: '비상금 계좌', category: '비상금이체', is_transfer: true }),
    // 비상금 → 메인으로 되돌아온 돈(분류된 이동). 수입이 아니다.
    row({ amount: '200000', description: '비상금 계좌', category: '비상금이체', is_transfer: true }),
    // 받는 쪽 계좌의 입금 · 이자와 집행 — 종합정산에 들어가지 않는다.
    row({ account_id: 2, amount: '1000000', description: '홍길동' }),
    row({ account_id: 2, amount: '-230000', description: '가상관리비', category: '고정비' }),
    row({ account_id: 3, amount: '300000', description: '홍길동' }),
    row({ account_id: 3, amount: '900', txn_type: '이자입금', category: '이자' }),
    // 메인에서 바로 나간 지출
    row({ amount: '-500000', description: 'IRP', category: '저축' }),
    row({ amount: '-420000', description: '대출 이자', category: '주거비' }),
    row({ amount: '-55000', description: '가상통신', category: '고정비' }),
    row({ amount: '-100000', description: '가상용돈', category: '용돈' }),
    row({ amount: '-870000', description: '가상카드주식회사', category: '카드대금' }),
    row({ amount: '-42000', description: '가상마트' }), // 미분류 출금 -> 변동비
    row({ amount: '-8000', description: '가상기타', category: '기타' }), // 예전 기타 -> 변동비
  ];
}

function reportOf(yearMonth, rows) {
  return aggregateMonthly({ yearMonth, accounts: ACCOUNTS, rows });
}

test('여섯 값은 현금흐름표 집계에서 나오고, 지출은 나간 돈의 크기다', () => {
  const report = reportOf('2026-08', monthRows());
  const point = trendPointOf(report);

  assert.deepEqual(point, {
    yearMonth: '2026-08',
    hasData: true,
    count: 16,
    수입: 3000120,
    저축: 500000,
    주거비: 420000,
    고정비: 1055000, // 메인의 고정비 분류 55,000 + 고정비 계좌로 옮긴 1,000,000
    카드비: 870000, // 카드대금만
    변동비: 50000, // 미분류 42,000 + 예전 기타 8,000
  });

  // 단일 출처: 현금흐름표 종합정산의 같은 줄과 같다.
  assert.equal(point.수입, report.종합정산.수입);
  assert.equal(point.카드비, -report.종합정산.카드비);
  assert.equal(point.변동비, -report.종합정산.변동비);
});

test('일회성 수입(변동비 · 미분류 입금)은 수입이 아니라 변동비를 줄이고, 더 크면 변동비가 음수다', () => {
  const base = trendPointOf(reportOf('2026-08', monthRows()));
  const withOneOff = trendPointOf(
    reportOf('2026-08', [
      ...monthRows(),
      row({ amount: '30000', description: '가상중고거래', category: '변동비' }),
      row({ amount: '5000', description: '가상환급' }), // 미분류 입금
    ]),
  );
  assert.equal(withOneOff.수입, base.수입);
  assert.equal(withOneOff.카드비, base.카드비);
  assert.equal(withOneOff.변동비, base.변동비 - 35000);

  const netInflow = trendPointOf(
    reportOf('2026-08', [
      row({ amount: '100000', description: '가상중고거래', category: '변동비' }),
      row({ amount: '-40000', description: '가상마트', category: '변동비' }),
    ]),
  );
  assert.equal(netInflow.변동비, -60000);
  assert.ok(Object.is(netInflow.수입, 0));
});

test('내 계좌 간 이체는 수입을 부풀리지 않는다', () => {
  const base = trendPointOf(reportOf('2026-08', monthRows()));
  // 이체를 몇 번 더 오가게 해도(메인 ↔ 비상금, 받는 쪽 입금) 수입은 그대로다.
  const moreTransfers = [
    ...monthRows(),
    row({ amount: '-700000', description: '비상금 계좌', category: '비상금이체', is_transfer: true }),
    row({ account_id: 3, amount: '700000', description: '홍길동' }),
    row({ amount: '700000', description: '비상금 계좌', category: '비상금이체', is_transfer: true }),
    // 분류는 없지만 is_transfer 라벨만 선 메인 입금도 이동이다.
    row({ amount: '50000', description: '고정비 계좌', is_transfer: true }),
  ];
  const point = trendPointOf(reportOf('2026-08', moreTransfers));
  assert.equal(point.수입, base.수입);
  assert.equal(point.저축, base.저축);
  assert.equal(point.변동비, base.변동비);
});

test('지출이 없는 항목은 0 이다(-0 이 아니다) · 메인 계좌의 입금(환불 포함)은 현금흐름표처럼 수입이다', () => {
  const point = trendPointOf(
    reportOf('2026-08', [
      row({ amount: '1000000', category: '수입' }),
      row({ amount: '-10000', category: '변동비' }),
    ]),
  );
  for (const key of ['저축', '주거비', '고정비', '카드비']) {
    assert.ok(Object.is(point[key], 0), key);
  }
  assert.equal(point.변동비, 10000);

  // 현금흐름표는 메인 계좌의 입금을 (변동비 · 미분류가 아니면) 수입 섹션에 둔다(placeMainRow).
  // 통계도 같은 집계를 쓰므로 카드대금으로 분류한 취소 입금은 카드비를 줄이지 않고 수입에 잡힌다.
  const refundMonth = trendPointOf(reportOf('2026-08', [row({ amount: '5000', category: '카드대금' })]));
  assert.equal(refundMonth.수입, 5000);
  assert.ok(Object.is(refundMonth.카드비, 0));
  assert.ok(Object.is(refundMonth.변동비, 0));
});

test('거래가 없는 달은 hasData=false 이고 값을 지어내지 않는다', () => {
  const empty = trendPointOf(reportOf('2026-07', []));
  assert.equal(empty.hasData, false);
  assert.equal(empty.count, 0);
});

test('monthSpan · nextYearMonth: 연도를 넘고, 뒤집힌 범위 · 틀린 형식은 빈 목록이다', () => {
  assert.equal(nextYearMonth('2026-12'), '2027-01');
  assert.deepEqual(monthSpan('2026-11', '2027-02'), ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.deepEqual(monthSpan('2026-09', '2026-09'), ['2026-09']);
  assert.deepEqual(monthSpan('2026-10', '2026-09'), []);
  assert.deepEqual(monthSpan('2026-9', '2026-10'), []);
});

test('fillTrendMonths: 빈 달을 null 로 채우고, 한 달치 · 0 달치도 다룬다', () => {
  const a = trendPointOf(reportOf('2026-06', monthRows()));
  const c = trendPointOf(reportOf('2026-08', monthRows()));
  const filled = fillTrendMonths([c, a]);
  assert.deepEqual(filled.map((point) => point.yearMonth), ['2026-06', '2026-07', '2026-08']);
  assert.equal(filled[1].hasData, false);
  for (const series of TREND_SERIES) assert.equal(filled[1][series.key], null, series.key);

  assert.deepEqual(fillTrendMonths([c]).map((point) => point.yearMonth), ['2026-08']);
  assert.deepEqual(fillTrendMonths([]), []);
  assert.deepEqual(fillTrendMonths([trendPointOf(reportOf('2026-05', []))]), []);
});

/** listYearMonths · loadMonthlyInputs 의 쿼리에만 답하는 가짜 DB. */
function fakeClient(byMonth) {
  const queries = [];
  return {
    queries,
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.includes('SELECT DISTINCT year_month')) {
        return { rows: Object.keys(byMonth).sort().reverse().map((year_month) => ({ year_month })) };
      }
      if (text.startsWith('SELECT id, role, nickname FROM accounts')) return { rows: ACCOUNTS };
      if (text.includes('FROM transactions')) return { rows: byMonth[values[0]] ?? [] };
      if (text.includes('FROM adjustments')) return { rows: [] };
      throw new Error('모르는 쿼리');
    },
  };
}

test('loadMonthlyTrends: 최근 N개월은 달력 기준이고 빈 달을 채워 오름차순으로 돌려준다', async () => {
  const client = fakeClient({
    '2025-12': monthRows(),
    '2026-02': monthRows(),
    '2026-03': monthRows(),
  });
  const all = await loadMonthlyTrends(client, { months: null });
  assert.deepEqual(all.map((point) => [point.yearMonth, point.hasData]), [
    ['2025-12', true],
    ['2026-01', false],
    ['2026-02', true],
    ['2026-03', true],
  ]);

  // 최근 3개월 = 2026-01 ~ 2026-03. 2025-12 는 빠지고, 첫 달이 데이터가 있는 달부터 시작한다.
  const recent = await loadMonthlyTrends(fakeClient({ '2025-12': monthRows(), '2026-02': monthRows(), '2026-03': monthRows() }), {
    months: 3,
  });
  assert.deepEqual(recent.map((point) => point.yearMonth), ['2026-02', '2026-03']);

  // 달 값은 파라미터로만 나간다.
  const monthQueries = client.queries.filter((query) => query.text.includes('WHERE year_month = $1'));
  assert.ok(monthQueries.length > 0);
  for (const query of monthQueries) assert.ok(!query.text.includes('2026-'));
});

test('loadMonthlyTrends: 거래가 하나도 없으면 빈 목록이다', async () => {
  assert.deepEqual(await loadMonthlyTrends(fakeClient({}), { months: 12 }), []);
});
