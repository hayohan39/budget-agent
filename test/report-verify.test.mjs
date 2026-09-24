// 검산 테스트.
//
// 가장 중요한 것: **불일치가 예외가 아니라 결과로 돌아온다.** 리포트 화면이
// 통째로 비는 대신 "얼마가 어긋났다"를 보여 줄 수 있어야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openXlsxFile } from '../lib/xlsx/workbook.mjs';
import { parseTossStatement } from '../lib/toss/statement.mjs';
import { toTransactionRecords } from '../lib/toss/normalize.mjs';
import { classifyRecords, createClassifier } from '../lib/classify/engine.mjs';
import { aggregateMonthly } from '../lib/report/monthly.mjs';
import { VERIFY_REASONS, verifyMonthlyReport } from '../lib/report/verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'toss-sample-masked.xlsx');

const ACCOUNTS = Object.freeze([
  { id: 1, role: 'main', last4: '1288', nickname: '메인' },
  { id: 2, role: 'fixed', last4: '2222', nickname: '고정비' },
  { id: 3, role: 'emergency', last4: '3333', nickname: '비상금' },
]);

const YM = '2026-08';

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
  // 20260924033721729_add-allowance-rule.sql 이 나중에 넣은 규칙. id 는 SERIAL 이라 10 이다.
  { id: 10, txn_type: null, pattern: '용돈', sign: -1, category: '용돈', priority: 75 },
]);

function row(overrides = {}) {
  return {
    id: '1',
    account_id: 1,
    txn_at: '2026-08-10T00:00:00+09:00',
    description: '',
    txn_type: '입금',
    amount: '0',
    balance: null,
    category: null,
    is_transfer: false,
    ...overrides,
  };
}

function report(rows, extra = {}) {
  return aggregateMonthly({ yearMonth: YM, accounts: ACCOUNTS, rows, ...extra });
}

/** fixture 24행을 저장된 행 모양(금액·잔액이 문자열)으로. */
function fixtureRows() {
  const records = toTransactionRecords(
    parseTossStatement(openXlsxFile(FIXTURE).sheet(0)),
    ACCOUNTS,
  );
  classifyRecords(records, createClassifier({ rules: SEED_RULES }));
  return records.map((record, index) => ({
    ...record,
    id: String(index + 1),
    amount: String(record.amount),
    balance: record.balance === null ? null : String(record.balance),
  }));
}

test('fixture 한 달치는 검산을 통과한다', () => {
  const result = verifyMonthlyReport(report(fixtureRows()));

  assert.deepEqual(result, {
    target: 'main',
    checked: true,
    ok: true,
    expected: -441865,
    actual: -441865,
    difference: 0,
    reason: null,
  });
});

test('거래가 한 건 빠지면 던지지 않고 차액을 돌려준다', () => {
  const rows = fixtureRows();
  // 한 건을 빼면 금액 합계만 달라진다. 잔액 컬럼은 그대로라 검산이 걸린다.
  const dropped = rows.find((entry) => entry.amount === '-170000');
  const missing = rows.filter((entry) => entry !== dropped);

  const result = verifyMonthlyReport(report(missing));

  assert.equal(result.checked, true);
  assert.equal(result.ok, false);
  assert.equal(result.expected, -441865);
  assert.equal(result.actual, -441865 + 170000);
  assert.equal(result.difference, 170000);
  assert.equal(result.reason, null);
});

test('부호가 뒤집힌 행도 차액으로 드러난다', () => {
  const rows = fixtureRows();
  const flipped = rows.map((entry) =>
    entry.amount === '-800000' ? { ...entry, amount: '800000' } : entry,
  );

  const result = verifyMonthlyReport(report(flipped));
  assert.equal(result.ok, false);
  assert.equal(result.difference, 1600000);
});

test('보정은 검산 대상이 아니다', () => {
  // 보정으로 차액을 덮으면 안 된다(PLAN.md: 0 이 아니면 누락·오분류 신호다).
  const withAdjustment = report(fixtureRows(), {
    adjustments: [{ target: '변동비', amount: '999999', reason: '덮어쓰기 시도' }],
  });

  const result = verifyMonthlyReport(withAdjustment);
  assert.equal(result.ok, true);
  assert.equal(result.actual, withAdjustment.종합정산.실현순증감);
  assert.notEqual(result.actual, withAdjustment.종합정산.보정후순증감);
});

test('경계 행의 잔액이 비면 검산하지 않고 사유를 남긴다', () => {
  const rows = [
    row({ id: '2', txn_at: '2026-08-01T00:00:00+09:00', amount: '1000', balance: null }),
    row({ id: '1', txn_at: '2026-08-30T00:00:00+09:00', amount: '2000', balance: '12500' }),
  ];

  const result = verifyMonthlyReport(report(rows));
  assert.equal(result.checked, false);
  assert.equal(result.ok, null);
  assert.equal(result.difference, null);
  assert.equal(result.reason, VERIFY_REASONS.balanceMissing);
});

test('거래가 없는 달은 noRows 로 남는다', () => {
  const result = verifyMonthlyReport(report([]));
  assert.equal(result.checked, false);
  assert.equal(result.reason, VERIFY_REASONS.noRows);
});

test('메인 계좌가 없으면 noMainAccount 로 남는다', () => {
  const result = verifyMonthlyReport(
    aggregateMonthly({
      yearMonth: YM,
      accounts: ACCOUNTS.filter((account) => account.role !== 'main'),
      rows: [],
    }),
  );
  assert.equal(result.checked, false);
  assert.equal(result.reason, VERIFY_REASONS.noMainAccount);
});

test('이상한 입력을 줘도 던지지 않는다', () => {
  for (const bad of [null, undefined, {}, 42, 'report', { 계좌별잔액변화: null }, []]) {
    const result = verifyMonthlyReport(bad);
    assert.equal(result.checked, false, JSON.stringify(bad));
    assert.equal(result.ok, null);
    assert.ok(Object.values(VERIFY_REASONS).includes(result.reason), result.reason);
  }
});

test('실현순증감이 숫자가 아니면 검산하지 않는다', () => {
  const broken = report(fixtureRows());
  broken.종합정산.실현순증감 = null;

  const result = verifyMonthlyReport(broken);
  assert.equal(result.checked, false);
  assert.equal(result.reason, VERIFY_REASONS.unavailable);
});

test('결과에 적요·메모가 들어가지 않는다', () => {
  const result = verifyMonthlyReport(report(fixtureRows()));
  const serialized = JSON.stringify(result);

  for (const leak of ['김철수', '홍길동', '삼성카드', '비상금 계좌']) {
    assert.ok(!serialized.includes(leak), `${leak} 이(가) 새어 나왔다`);
  }
});
