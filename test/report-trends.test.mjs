// 가계부 통계(월별 추이) 집계 테스트. 합성 데이터만 쓴다 — 이름 · 금액은 가상이다.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateMonthly,
  buildMonthlyReport,
  loadMonthlyInputs,
  loadMonthlyInputsForMonths,
} from '../lib/report/monthly.mjs';
import { listYearMonths } from '../lib/report/months.mjs';
import { withScratchDatabase } from './helpers/scratch-db.mjs';
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

/**
 * listYearMonths · loadMonthlyInputs · loadMonthlyInputsForMonths 의 쿼리에만 답하는 가짜 DB.
 * 행에 year_month 를 붙이지 않으면 여러 달 조회가 달을 가를 수 없다 — 실제 DB 처럼
 * 여러 달 조회에는 year_month 를 붙여 준다.
 */
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
      if (text.includes('year_month = ANY($1')) {
        const months = [...values[0]].sort();
        return {
          rows: months.flatMap((year_month) => (byMonth[year_month] ?? []).map((r) => ({ year_month, ...r }))),
        };
      }
      if (text.includes('FROM transactions')) return { rows: byMonth[values[0]] ?? [] };
      throw new Error('모르는 쿼리');
    },
  };
}

/**
 * 예전 경로 — 달마다 buildMonthlyReport(계좌 + 거래 2쿼리). 새 경로와 결과가 같은지
 * 비교하려고 테스트에만 남긴다(달 고르는 방식은 loadMonthlyTrends 와 같다).
 */
async function loadMonthlyTrendsPerMonth(client, { months = 12 } = {}) {
  const available = await listYearMonths(client);
  if (available.length === 0) return [];
  const latest = available[0];
  const inRange =
    months === null
      ? available
      : available.filter((yearMonth) => {
          const [ly, lm] = latest.split('-').map(Number);
          const [y, m] = yearMonth.split('-').map(Number);
          return (ly - y) * 12 + (lm - m) < months;
        });
  const points = [];
  for (const yearMonth of [...inRange].sort()) {
    points.push(trendPointOf(await buildMonthlyReport(client, yearMonth)));
  }
  return fillTrendMonths(points);
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
  const monthQueries = client.queries.filter((query) => query.text.includes('year_month = ANY($1'));
  assert.ok(monthQueries.length > 0);
  for (const query of monthQueries) assert.ok(!query.text.includes('2026-'));
});

test('loadMonthlyTrends: 달 수와 무관하게 쿼리 3번(달 목록 · 계좌 · 거래)이다 — 예전에는 1 + 2N', async () => {
  const byMonth = {};
  for (const yearMonth of monthSpan('2025-10', '2026-09')) byMonth[yearMonth] = monthRows();

  const fresh = fakeClient(byMonth);
  const points = await loadMonthlyTrends(fresh, { months: 12 });
  assert.equal(points.length, 12);
  assert.equal(fresh.queries.length, 3);

  const old = fakeClient(byMonth);
  await loadMonthlyTrendsPerMonth(old, { months: 12 });
  assert.equal(old.queries.length, 1 + 2 * 12);
});

test('loadMonthlyTrends: 새 경로와 예전 달별 경로의 결과가 같다(가짜 DB, 빈 달 · 범위 포함)', async () => {
  const byMonth = {
    '2025-11': monthRows(),
    '2026-01': [...monthRows(), row({ amount: '30000', description: '가상중고거래', category: '변동비' })],
    '2026-02': monthRows().slice(0, 5),
    '2026-03': monthRows(),
  };
  for (const months of [null, 1, 3, 6, 12, 24]) {
    assert.deepEqual(
      await loadMonthlyTrends(fakeClient(byMonth), { months }),
      await loadMonthlyTrendsPerMonth(fakeClient(byMonth), { months }),
      String(months),
    );
  }
});

test('loadMonthlyInputsForMonths: 틀린 형식이면 쿼리를 내지 않고, 빈 목록은 빈 결과다', async () => {
  const client = {
    async query() {
      throw new Error('쿼리가 나가면 안 된다');
    },
  };
  for (const bad of [['2026-8'], ['2026-08', 'x'], 'not-an-array', [null]]) {
    await assert.rejects(() => loadMonthlyInputsForMonths(client, bad), /YYYY-MM/);
  }
  assert.deepEqual(await loadMonthlyInputsForMonths(client, []), []);
});

test('loadMonthlyInputsForMonths: DB 오류 메시지를 그대로 흘리지 않는다', async () => {
  const client = {
    async query() {
      throw new Error('relation "transactions" does not exist (host=secret-host)');
    },
  };
  await assert.rejects(
    () => loadMonthlyInputsForMonths(client, ['2026-08']),
    (error) => {
      assert.ok(!error.message.includes('secret-host'));
      assert.match(error.message, /현금흐름표 입력을 읽지 못했습니다/);
      return true;
    },
  );
});

/** 실제 DB 에 넣을 합성 행. txn_at 은 KST, year_month 는 KST 기준(월 경계 행 포함). */
function dbRow(accountId, at, yearMonth, amount, description, extra = {}) {
  return {
    account_id: accountId,
    txn_at: at,
    description,
    txn_type: amount > 0 ? '입금' : '출금',
    amount,
    balance: extra.balance ?? null,
    category: extra.category ?? null,
    is_transfer: extra.is_transfer ?? false,
    item: extra.item ?? null,
    year_month: yearMonth,
  };
}

test('실제 DB: 여러 달 한 번 조회가 달별 조회와 입력 · 현금흐름표 · 추이까지 같다', async (t) => {
  await withScratchDatabase(t, 'trends_batch', async (client) => {
    const rows = [];
    let balance = 5_000_000;
    const months = ['2025-12', '2026-01', '2026-03', '2026-04'];
    for (const [index, yearMonth] of months.entries()) {
      const day = (d) => `${yearMonth}-${String(d).padStart(2, '0')}T09:00:00+09:00`;
      const main = (at, amount, description, extra = {}) => {
        balance += amount;
        rows.push(dbRow(1, at, yearMonth, amount, description, { ...extra, balance }));
      };
      main(day(1), 3_000_000 + index, '가상회사 급여', { category: '수입' });
      main(day(2), -1_000_000, '고정비 계좌', { category: '고정비이체', is_transfer: true });
      rows.push(dbRow(2, day(2), yearMonth, 1_000_000, '홍길동'));
      main(day(3), -300_000, '비상금 계좌', { category: '비상금이체', is_transfer: true });
      rows.push(dbRow(3, day(3), yearMonth, 300_000, '홍길동'));
      rows.push(dbRow(3, day(4), yearMonth, 900, '이자', { category: '이자' }));
      rows.push(dbRow(2, day(5), yearMonth, -230_000, '가상관리비', { category: '고정비', item: '관리비' }));
      main(day(6), -500_000, 'IRP', { category: '저축' });
      main(day(7), -870_000, '가상카드주식회사', { category: '카드대금' });
      // 같은 초의 두 건(id 순서가 시간 순서를 정한다).
      main(day(8), -42_000, '가상마트');
      main(day(8), -8_000, '가상마트');
      main(day(9), 30_000 * (index + 1), '가상중고거래', { category: '변동비' });
    }
    // KST 로는 1월 1일 00:30 이지만 UTC 로는 전년 12월 31일인 행 — year_month 는 KST 기준 '2026-01'.
    rows.push(dbRow(1, '2026-01-01T00:30:00+09:00', '2026-01', -1_000, '가상새해'));

    for (const [index, r] of rows.entries()) {
      await client.query(
        `INSERT INTO transactions
           (account_id, txn_at, description, txn_type, amount, balance, category, is_transfer, item,
            year_month, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [r.account_id, r.txn_at, r.description, r.txn_type, r.amount, r.balance, r.category, r.is_transfer, r.item,
          r.year_month, `synthetic-${index}`],
      );
    }

    const all = [...months, '2026-02', '2025-11'].sort();
    const batch = await loadMonthlyInputsForMonths(client, all);
    assert.deepEqual(batch.map((input) => input.yearMonth), all);
    for (const input of batch) {
      const single = await loadMonthlyInputs(client, input.yearMonth);
      assert.deepEqual(input, single, input.yearMonth);
      assert.deepEqual(aggregateMonthly(input), await buildMonthlyReport(client, input.yearMonth), input.yearMonth);
    }

    for (const range of [null, 1, 2, 3, 6, 12]) {
      assert.deepEqual(
        await loadMonthlyTrends(client, { months: range }),
        await loadMonthlyTrendsPerMonth(client, { months: range }),
        String(range),
      );
    }
    const trends = await loadMonthlyTrends(client, { months: null });
    assert.deepEqual(trends.map((point) => [point.yearMonth, point.hasData]), [
      ['2025-12', true],
      ['2026-01', true],
      ['2026-02', false],
      ['2026-03', true],
      ['2026-04', true],
    ]);
  });
});

test('loadMonthlyTrends: 거래가 하나도 없으면 빈 목록이다', async () => {
  assert.deepEqual(await loadMonthlyTrends(fakeClient({}), { months: 12 }), []);
});
