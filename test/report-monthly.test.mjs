// 월별 현금흐름표 집계 테스트.
//
// 두 층이다.
//   1. 순수 집계 — 행 배열만 주고 섹션·부호·항등식을 본다. 항상 돈다.
//   2. 실제 왕복 — 스크래치 DB 에 fixture 를 넣고 분류까지 돌린 뒤 같은 숫자가
//      나오는지 본다(pg 가 BIGINT 를 문자열로 주는 경로를 실제로 통과한다).
//      `TEST_DATABASE_URL` 이 있을 때만 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openXlsxFile } from '../lib/xlsx/workbook.mjs';
import { parseTossStatement } from '../lib/toss/statement.mjs';
import { toTransactionRecords } from '../lib/toss/normalize.mjs';
import { insertTransactions } from '../lib/db/transactions.mjs';
import { classifyStored } from '../lib/classify/store.mjs';
import {
  aggregateMonthly,
  balanceSpan,
  buildMonthlyReport,
  isTransferLeg,
  matchIncomingTransfers,
} from '../lib/report/monthly.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'toss-sample-masked.xlsx');

const ACCOUNTS = Object.freeze([
  { id: 1, role: 'main', last4: '1288', nickname: '메인' },
  { id: 2, role: 'fixed', last4: '2222', nickname: '고정비' },
  { id: 3, role: 'emergency', last4: '3333', nickname: '비상금' },
]);

const YM = '2026-08';

/**
 * 거래 행 하나. 금액·잔액은 **문자열**로 둔다 — pg 가 BIGINT 를 문자열로
 * 주기 때문이다. 집계가 문자열을 이어 붙이면 여기서 바로 드러난다.
 */
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

// ── 부호 규약 ──────────────────────────────────────────────────────────────

test('부호는 저장된 그대로다 — 수입 +, 지출 −', () => {
  const result = report([
    row({ id: '1', amount: '5900000', description: '홍길동' }),
    row({ id: '2', amount: '-800000', category: '주거비', description: '대출 이자' }),
  ]);

  assert.equal(result.signConvention, '입금 +, 출금 −');
  assert.equal(result.수입.total, 5900000);
  assert.equal(result.고정지출1.total, -800000);
  assert.equal(result.종합정산.실현순증감, 5100000);
});

test('BIGINT 가 문자열로 와도 합계가 맞는다', () => {
  const result = report([
    row({ id: '1', amount: '1' }),
    row({ id: '2', amount: '2' }),
  ]);

  // 문자열을 이어 붙였다면 12 또는 '12' 가 된다.
  assert.equal(result.수입.total, 3);
  assert.equal(typeof result.수입.total, 'number');
});

test('금액은 number·bigint 로 와도 똑같이 처리한다', () => {
  const result = report([
    row({ id: '1', amount: 34000 }),
    row({ id: '2', amount: 1000000n }),
  ]);
  assert.equal(result.수입.total, 1034000);
});

// ── 계좌 간 이동 ───────────────────────────────────────────────────────────

test('메인에서 나간 계좌 간 이동은 수입에도 지출에도 들어가지 않는다', () => {
  const result = report([
    row({ id: '1', amount: '5000000', description: '홍길동' }),
    row({ id: '2', amount: '-500000', description: '비상금 계좌', category: '비상금이체', is_transfer: true }),
    row({ id: '3', amount: '-1000000', description: '고정비 계좌', category: '고정비이체', is_transfer: true }),
  ]);

  assert.equal(result.수입.total, 5000000);
  assert.equal(result.고정지출1.total, 0);
  assert.equal(result.고정지출2.total, 0);
  assert.equal(result.변동지출.total, 0);

  // 자기 줄로 빠진다.
  assert.equal(result.계좌간이동.total, -1500000);
  assert.equal(result.계좌간이동.count, 2);
  assert.deepEqual(result.계좌간이동.items, [
    { key: '고정비', total: -1000000, count: 1 },
    { key: '비상금', total: -500000, count: 1 },
  ]);

  // 메인 잔액은 실제로 줄었으므로 실현순증감에는 들어간다.
  assert.equal(result.종합정산.실현순증감, 3500000);
});

test('받는 쪽 계좌의 입금은 수입으로 세지 않는다(중복 계산 방지)', () => {
  const result = report([
    row({ id: '1', account_id: 1, amount: '-500000', description: '비상금 계좌', category: '비상금이체', is_transfer: true }),
    // 비상금 계좌 명세서에 잡히는 같은 이체의 반대쪽. is_transfer 가 서지 않는다
    // (적요가 `비상금 계좌` 가 아니라 보낸 쪽 라벨이기 때문이다).
    row({ id: '2', account_id: 3, amount: '500000', description: '홍길동', is_transfer: false }),
  ]);

  assert.equal(result.수입.total, 0, '다른 계좌 입금이 수입으로 샜다');
  assert.equal(result.종합정산.실현순증감, -500000);
  // 그 돈은 계좌 블록에서 따로 보인다.
  const emergency = result.계좌블록.find((block) => block.role === 'emergency');
  assert.equal(emergency.입금.total, 500000);
});

test('is_transfer 플래그만 서 있어도 이동으로 본다', () => {
  // 분류가 아직 안 된 행(category NULL)이라도 라벨이 서 있으면 이동이다.
  const flagged = row({ id: '1', amount: '-500000', description: '비상금 계좌', is_transfer: true });
  assert.equal(isTransferLeg(flagged), true);

  const result = report([flagged]);
  assert.equal(result.계좌간이동.total, -500000);
  assert.deepEqual(result.계좌간이동.items, [{ key: '기타', total: -500000, count: 1 }]);
  assert.equal(result.변동지출.기타.total, 0);
});

test('분류만 서 있고 is_transfer 가 비어도 이동으로 본다', () => {
  // 받는 쪽 계좌에서 온 행처럼 플래그가 없는 경우의 두 번째 방어선.
  const classified = row({ id: '1', amount: '-500000', category: '고정비이체', is_transfer: false });
  assert.equal(isTransferLeg(classified), true);
  assert.equal(report([classified]).계좌간이동.total, -500000);
});

// ── 비메인 계좌 이자 상계 ──────────────────────────────────────────────────

/**
 * 메인 · 고정비 · 비상금 세 계좌가 모두 도는 한 달치.
 *
 * fixture 는 **메인 계좌 명세서**라 비메인 계좌의 이자 행이 한 건도 없다.
 * 그래서 이 모양은 합성한다 — 금액은 임의의 값이고 실제 거래가 아니다.
 *
 * 메인 행에는 `balance` 를 넣어 잔액 변화가 실제로 계산되게 한다.
 * `withInterest` 가 켜지면 고정비 · 비상금 계좌에 이자 행이 한 건씩 붙는다.
 */
function threeAccountRows({ withInterest }) {
  const base = [
    // 메인 → 고정비 1,000,000 / 메인 → 비상금 500,000. 잔액 변화는 −1,500,000.
    row({
      id: '1',
      account_id: 1,
      txn_at: '2026-08-05T00:00:00+09:00',
      amount: '-1000000',
      description: '고정비 계좌',
      category: '고정비이체',
      is_transfer: true,
      balance: '9000000',
    }),
    row({
      id: '2',
      account_id: 1,
      txn_at: '2026-08-06T00:00:00+09:00',
      amount: '-500000',
      description: '비상금 계좌',
      category: '비상금이체',
      is_transfer: true,
      balance: '8500000',
    }),
    // 고정비 계좌 — 메인에서 온 입금과 그 계좌의 집행.
    row({ id: '3', account_id: 2, txn_at: '2026-08-05T00:00:00+09:00', amount: '1000000' }),
    row({
      id: '4',
      account_id: 2,
      txn_at: '2026-08-10T00:00:00+09:00',
      amount: '-886815',
      txn_type: '자동이체',
      category: '고정비',
    }),
    // 비상금 계좌 — 입금만 있고 집행이 없는 달.
    row({ id: '5', account_id: 3, txn_at: '2026-08-06T00:00:00+09:00', amount: '500000' }),
  ];
  if (!withInterest) return base;

  return [
    ...base,
    row({
      id: '6',
      account_id: 2,
      txn_at: '2026-08-31T00:00:00+09:00',
      amount: '64',
      txn_type: '이자입금',
      category: '이자',
    }),
    row({
      id: '7',
      account_id: 3,
      txn_at: '2026-08-31T00:00:00+09:00',
      amount: '2431',
      txn_type: '이자입금',
      category: '이자',
    }),
  ];
}

test('비메인 계좌의 이자는 그 계좌 블록 안에서 집행을 상계한다', () => {
  const result = report(threeAccountRows({ withInterest: true }));
  const fixed = result.계좌블록.find((block) => block.role === 'fixed');
  const emergency = result.계좌블록.find((block) => block.role === 'emergency');

  assert.deepEqual(fixed.입금, { total: 1000000, count: 1 });
  assert.deepEqual(fixed.집행, { total: -886815, count: 1 });
  assert.deepEqual(fixed.이자, { total: 64, count: 1 });
  // 순증감 = 입금 + 이자 − 집행 (집행은 이미 음수라 코드에서는 덧셈이다).
  assert.equal(fixed.순증감, 113249);
  assert.equal(fixed.순증감, fixed.입금.total + fixed.이자.total + fixed.집행.total);

  // 같은 규칙을 비상금에도 그대로 쓴다. 한쪽만 특별 취급하지 않는다.
  assert.deepEqual(emergency.이자, { total: 2431, count: 1 });
  assert.equal(emergency.집행.total, 0);
  assert.equal(emergency.순증감, 502431);
  assert.equal(
    emergency.순증감,
    emergency.입금.total + emergency.이자.total + emergency.집행.total,
  );
});

test('이자가 붙으면 그 계좌의 순증감만 이자만큼 움직인다', () => {
  const withoutInterest = report(threeAccountRows({ withInterest: false }));
  const withInterest = report(threeAccountRows({ withInterest: true }));

  const before = (result, role) => result.계좌블록.find((block) => block.role === role);

  assert.equal(before(withoutInterest, 'fixed').이자.total, 0);
  assert.equal(before(withoutInterest, 'fixed').순증감, 113185);
  assert.equal(before(withInterest, 'fixed').순증감 - before(withoutInterest, 'fixed').순증감, 64);
  assert.equal(
    before(withInterest, 'emergency').순증감 - before(withoutInterest, 'emergency').순증감,
    2431,
  );
});

test('비메인 계좌의 이자는 종합정산의 수입에 들어가지 않는다', () => {
  const withoutInterest = report(threeAccountRows({ withInterest: false }));
  const withInterest = report(threeAccountRows({ withInterest: true }));

  assert.equal(withInterest.수입.total, 0, '비메인 계좌 이자가 수입으로 샜다');
  assert.deepEqual(withInterest.수입.items, []);

  // 메인 기준 현금흐름은 이자가 붙어도 **한 칸도** 달라지지 않는다.
  assert.deepEqual(withInterest.종합정산, withoutInterest.종합정산);
  assert.equal(withInterest.종합정산.실현순증감, -1500000);

  // 메인 잔액 변화도 그대로다(검산의 반대쪽 값).
  const mainOf = (result) => result.계좌별잔액변화.find((entry) => entry.role === 'main');
  assert.deepEqual(mainOf(withInterest), mainOf(withoutInterest));
  assert.equal(mainOf(withInterest).change, -1500000);
});

test('메인 계좌의 이자는 종전대로 수입이다', () => {
  // 상계는 비메인 계좌에만 적용한다. 메인 계좌의 이자는 메인으로 들어온 돈이다.
  const result = report([
    row({ id: '1', account_id: 1, amount: '263', txn_type: '이자입금', category: '이자' }),
  ]);

  assert.deepEqual(result.수입.items, [{ key: '이자', total: 263, count: 1 }]);
  assert.equal(result.종합정산.실현순증감, 263);
});

// ── 섹션 ──────────────────────────────────────────────────────────────────

test('고정지출1 은 저축·용돈·주거비를 고정된 순서로 담는다', () => {
  const result = report([
    row({ id: '1', amount: '-300000', category: '저축' }),
    row({ id: '2', amount: '-500000', category: '용돈' }),
    row({ id: '3', amount: '-800000', category: '주거비' }),
  ]);

  assert.deepEqual(result.고정지출1.items, [
    { key: '저축', total: -300000, count: 1 },
    { key: '용돈', total: -500000, count: 1 },
    { key: '주거비', total: -800000, count: 1 },
  ]);
  assert.equal(result.고정지출1.total, -1600000);
});

test('값이 없는 섹션 줄도 0 으로 남는다(표 모양이 흔들리지 않는다)', () => {
  const result = report([]);

  assert.deepEqual(result.고정지출1.items.map((item) => item.key), ['저축', '용돈', '주거비']);
  assert.deepEqual(result.고정지출2.items.map((item) => item.key), ['고정비', '비상금']);
  assert.equal(result.고정지출1.total, 0);
  assert.equal(result.종합정산.실현순증감, 0);
});

test('규칙에 안 걸린 출금은 변동지출 기타로 간다', () => {
  const result = report([
    row({ id: '1', amount: '-3780', description: '코웨이08월렌탈', txn_type: 'CMS출금' }),
  ]);

  assert.equal(result.변동지출.기타.total, -3780);
  assert.equal(result.변동지출.total, -3780);
  assert.equal(result.미분류.count, 1);
});

test('미분류 입금은 수입에 들어가되 미분류 건수로도 잡힌다', () => {
  const result = report([row({ id: '1', amount: '3500000', description: '김철수' })]);

  assert.deepEqual(result.수입.items, [{ key: '미분류', total: 3500000, count: 1 }]);
  assert.equal(result.미분류.count, 1);
});

// ── 카드 ──────────────────────────────────────────────────────────────────

test('카드대금을 카드사별로 묶는다', () => {
  const result = report([
    row({ id: '1', amount: '-2858322', description: '삼성카드주식회사', txn_type: '펌뱅킹출금', category: '카드대금' }),
    row({ id: '2', amount: '-317012', description: '삼성카드주식회사', txn_type: '펌뱅킹출금', category: '카드대금' }),
    row({ id: '3', amount: '-14050', description: 'KB카드출금', txn_type: '펌뱅킹출금', category: '카드대금' }),
    row({ id: '4', amount: '-1901314', description: '현대카드', txn_type: '펌뱅킹출금', category: '카드대금' }),
  ]);

  assert.deepEqual(result.변동지출.카드대금.issuers, [
    { issuer: '삼성카드', total: -3175334, count: 2 },
    { issuer: '현대카드', total: -1901314, count: 1 },
    { issuer: 'KB국민카드', total: -14050, count: 1 },
  ]);
  assert.equal(result.변동지출.카드대금.total, -5090698);
  assert.equal(result.변동지출.카드대금.count, 4);
  // 카드사별 합계가 카드대금 합계와 같다(PLAN.md 검증 6).
  assert.equal(
    result.변동지출.카드대금.issuers.reduce((sum, item) => sum + item.total, 0),
    result.변동지출.카드대금.total,
  );
});

// ── 보정은 없다 ────────────────────────────────────────────────────────────

test('수동 보정은 집계에 없다 — 입력으로 넘겨도 무시하고 종합정산의 합계는 실현순증감이다', () => {
  // 사용자 요청(2026-09): "보정은 수동으로 기입할때 생겼던 것들이야. 이제는 필요없으니 삭제해줘."
  const result = report(
    [row({ id: '1', amount: '1000000' })],
    { adjustments: [{ target: '수입', amount: '-50000', reason: '이월 정산' }] },
  );

  assert.equal(Object.hasOwn(result, '보정'), false);
  assert.deepEqual(Object.keys(result.종합정산), [
    '수입',
    '고정지출1',
    '고정지출2',
    '변동지출',
    '계좌간이동',
    '실현순증감',
  ]);
  assert.equal(result.종합정산.실현순증감, 1000000);
});

// ── 받는 쪽 계좌의 내 계좌 간 이체 ─────────────────────────────────────────

/** 메인 → 고정비 이체 한 쌍(보낸 쪽 · 받는 쪽). 금액 · 시각은 임의의 값이다. */
function transferPair({ gapMinutes = 0, inAmount = '1000000', inAccount = 2 } = {}) {
  const at = new Date(Date.parse('2026-08-05T09:00:00+09:00') + gapMinutes * 60 * 1000).toISOString();
  return [
    row({ id: '10', account_id: 1, txn_at: '2026-08-05T09:00:00+09:00', amount: '-1000000', description: '고정비 계좌', category: '고정비이체', is_transfer: true }),
    row({ id: '11', account_id: inAccount, txn_at: at, amount: inAmount, description: '홍길동' }),
  ];
}

test('matchIncomingTransfers: 메인의 이동 출금과 금액 · 받는 계좌 · 시각이 맞는 입금만 짝짓는다', () => {
  assert.deepEqual([...matchIncomingTransfers({ accounts: ACCOUNTS, rows: transferPair() })], ['11']);
  // 허용 시각 안(10분)은 짝, 밖은 짝이 아니다.
  assert.deepEqual([...matchIncomingTransfers({ accounts: ACCOUNTS, rows: transferPair({ gapMinutes: 10 }) })], ['11']);
  assert.equal(matchIncomingTransfers({ accounts: ACCOUNTS, rows: transferPair({ gapMinutes: 11 }) }).size, 0);
  // 금액이 다르면 짝이 아니다.
  assert.equal(matchIncomingTransfers({ accounts: ACCOUNTS, rows: transferPair({ inAmount: '999999' }) }).size, 0);
  // 다른 계좌(비상금)로 들어온 같은 금액은 짝이 아니다 — 보낸 쪽은 고정비로 갔다.
  assert.equal(matchIncomingTransfers({ accounts: ACCOUNTS, rows: transferPair({ inAccount: 3 }) }).size, 0);
  // 메인 계좌에 들어온 돈은 받는 쪽 다리가 아니다.
  assert.equal(matchIncomingTransfers({ accounts: ACCOUNTS, rows: transferPair({ inAccount: 1 }) }).size, 0);
  // 계좌 목록이 없으면 아무것도 짝짓지 않는다.
  assert.equal(matchIncomingTransfers({ accounts: [], rows: transferPair() }).size, 0);
});

test('matchIncomingTransfers: 1:1 로만 짝짓고 가장 가까운 입금을 고른다', () => {
  const rows = [
    ...transferPair({ gapMinutes: 3 }),
    // 같은 금액의 입금이 하나 더 있다. 시각이 더 가까우므로 이쪽이 짝이다.
    row({ id: '12', account_id: 2, txn_at: '2026-08-05T09:00:30+09:00', amount: '1000000', description: '홍길동' }),
  ];
  assert.deepEqual([...matchIncomingTransfers({ accounts: ACCOUNTS, rows })], ['12']);
});

test('matchIncomingTransfers: 분류 없이 is_transfer 만 선 보낸 쪽은 적요로 받는 계좌를 안다 · 이자는 짝이 아니다', () => {
  const rows = [
    row({ id: '20', account_id: 1, txn_at: '2026-08-06T09:00:00+09:00', amount: '-300000', description: '비상금 계좌', is_transfer: true }),
    row({ id: '21', account_id: 3, txn_at: '2026-08-06T09:00:00+09:00', amount: '300000', description: '홍길동' }),
    row({ id: '22', account_id: 1, txn_at: '2026-08-31T00:00:00+09:00', amount: '-64', description: '고정비 계좌', category: '고정비이체', is_transfer: true }),
    row({ id: '23', account_id: 2, txn_at: '2026-08-31T00:00:00+09:00', amount: '64', txn_type: '이자입금', category: '이자' }),
  ];
  assert.deepEqual([...matchIncomingTransfers({ accounts: ACCOUNTS, rows })], ['21']);
});

test('받는 쪽 계좌의 이체 입금은 미분류 건수에서 빠지고, 짝 없는 입금은 그대로 센다', () => {
  const rows = [
    ...transferPair(),
    // 고정비 계좌의 짝 없는 입금(환불 등).
    row({ id: '30', account_id: 2, txn_at: '2026-08-20T09:00:00+09:00', amount: '15000', description: '환불' }),
  ];
  const result = report(rows);
  assert.equal(result.미분류.count, 1);
  assert.equal(result.미분류.계좌간이체입금, 1);
  // 계좌 블록의 입금 · 종합정산은 짝 여부와 무관하게 예전과 같다.
  const fixed = result.계좌블록.find((block) => block.role === 'fixed');
  assert.deepEqual(fixed.입금, { total: 1015000, count: 2 });
  assert.equal(result.수입.total, 0);
  assert.equal(result.종합정산.실현순증감, -1000000);
});

// ── 잔액 ──────────────────────────────────────────────────────────────────

test('계좌별 잔액 변화를 balance 컬럼에서 끌어낸다', () => {
  const rows = [
    row({ id: '3', txn_at: '2026-08-01T00:00:00+09:00', amount: '1000', balance: '11000' }),
    row({ id: '2', txn_at: '2026-08-15T00:00:00+09:00', amount: '-500', balance: '10500' }),
    row({ id: '1', txn_at: '2026-08-30T00:00:00+09:00', amount: '2000', balance: '12500' }),
  ];
  const span = balanceSpan(rows);

  // 시작 잔액 = 첫 거래의 거래 후 잔액 - 그 거래 금액.
  assert.deepEqual(span, { opening: 10000, closing: 12500, change: 2500, derived: true, reason: null });

  const main = report(rows).계좌별잔액변화.find((entry) => entry.role === 'main');
  assert.equal(main.change, 2500);
  assert.equal(main.count, 3);
});

test('같은 초의 행은 id 내림차순이 시간순이다', () => {
  // 파일이 최신순이고 그 순서로 INSERT 되므로, 같은 초에서는 id 가 클수록 과거다.
  const rows = [
    row({ id: '10', txn_at: '2026-08-01T11:04:25+09:00', amount: '-1000', balance: '9000' }),
    row({ id: '9', txn_at: '2026-08-01T11:04:25+09:00', amount: '-2000', balance: '7000' }),
  ];
  assert.deepEqual(balanceSpan(rows), {
    opening: 10000,
    closing: 7000,
    change: -3000,
    derived: true,
    reason: null,
  });
});

test('경계 행의 잔액이 비어 있으면 추정하지 않고 사유를 남긴다', () => {
  const rows = [
    row({ id: '2', txn_at: '2026-08-01T00:00:00+09:00', amount: '1000', balance: null }),
    row({ id: '1', txn_at: '2026-08-30T00:00:00+09:00', amount: '2000', balance: '12500' }),
  ];
  assert.deepEqual(balanceSpan(rows), {
    opening: null,
    closing: null,
    change: null,
    derived: false,
    reason: 'balanceMissing',
  });
});

test('거래가 없는 계좌는 noRows 로 남는다', () => {
  const result = report([]);
  for (const entry of result.계좌별잔액변화) {
    assert.equal(entry.derived, false);
    assert.equal(entry.reason, 'noRows');
    assert.equal(entry.count, 0);
  }
});

test('잔액 0 은 빈 값이 아니다', () => {
  const rows = [
    row({ id: '2', txn_at: '2026-08-01T00:00:00+09:00', amount: '-100', balance: '0' }),
    row({ id: '1', txn_at: '2026-08-02T00:00:00+09:00', amount: '500', balance: '500' }),
  ];
  assert.equal(balanceSpan(rows).opening, 100);
  assert.equal(balanceSpan(rows).closing, 500);
});

// ── 로그 위생 ──────────────────────────────────────────────────────────────

test('결과에 메모·거래 일시·잔액이 들어가지 않고, 적요는 항목 이름 자리에만 나온다', () => {
  // 적요는 이제 항목 이름으로 화면에 나온다(PLAN.md "적요 표시 원칙 변경").
  // 그 밖의 행 단위 값은 여전히 결과에 실리지 않는다.
  const result = report([
    row({
      id: '1',
      amount: '3500000',
      balance: '9876543',
      description: '김철수',
      txn_type: '입금',
      memo: '비밀메모',
      txn_at: '2026-08-10T12:34:56+09:00',
    }),
    row({ id: '2', amount: '-170000', description: '이영희', txn_type: '모임원송금' }),
  ]);
  const serialized = JSON.stringify(result);

  for (const leak of ['비밀메모', '2026-08-10T12:34:56', '12:34:56', '9876543', '모임원송금']) {
    assert.ok(!serialized.includes(leak), `${leak} 이(가) 새어 나왔다`);
  }

  // 적요는 항목별 줄의 item 에만 있다. 항목별을 걷어 내면 어디에도 없다.
  const { 항목별, 계좌블록, ...rest } = result;
  const withoutLines = JSON.stringify({
    ...rest,
    계좌블록: 계좌블록.map((block) => {
      const copy = { ...block };
      delete copy.항목;
      return copy;
    }),
  });
  for (const description of ['김철수', '이영희']) {
    assert.ok(!withoutLines.includes(description), `${description} 이(가) 항목 줄 밖에 나왔다`);
  }
  assert.deepEqual(
    항목별.수입.map((line) => line.item),
    ['김철수'],
  );
  assert.deepEqual(
    항목별.변동지출.map((line) => line.item),
    ['이영희'],
  );
});

// ── fixture 한 달치 ────────────────────────────────────────────────────────

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

function fixtureRecords() {
  const statement = parseTossStatement(openXlsxFile(FIXTURE).sheet(0));
  return toTransactionRecords(statement, ACCOUNTS);
}

/** 저장된 행처럼 보이게 id 와 문자열 금액을 입힌다(파일 순서 = 최신순). */
async function fixtureRows() {
  const { createClassifier, classifyRecords } = await import('../lib/classify/engine.mjs');
  const records = fixtureRecords();
  classifyRecords(records, createClassifier({ rules: SEED_RULES }));
  return records.map((record, index) => ({
    ...record,
    id: String(index + 1),
    amount: String(record.amount),
    balance: record.balance === null ? null : String(record.balance),
  }));
}

test('fixture 한 달치의 섹션 합계', async () => {
  const result = report(await fixtureRows());

  // 수입: 34,000 + 5,900,000 + 1,045,850 + 3,500,000 + 1,000,000 + 263(이자)
  assert.equal(result.수입.total, 11480113);
  // 저축 3,350,000 + 용돈 1,000,000 + 주거비 800,000
  assert.equal(result.고정지출1.total, -5150000);
  assert.equal(result.고정지출2.total, 0); // 용돈 규칙이 생긴 뒤로 고정비로 새지 않는다
  assert.equal(result.변동지출.카드대금.total, -5090698);
  assert.equal(result.변동지출.기타.total, -181280); // 코웨이 · 모임원송금 2건
  assert.equal(result.계좌간이동.total, -1500000);
  assert.equal(result.미분류.count, 8);
  assert.equal(result.거래건수, 24);
});

test('용돈 2건은 고정지출1 에 들어간다(고정지출2 가 아니다)', async () => {
  const result = report(await fixtureRows());

  assert.deepEqual(result.고정지출1.items, [
    { key: '저축', total: -3350000, count: 6 },
    { key: '용돈', total: -1000000, count: 2 },
    { key: '주거비', total: -800000, count: 1 },
  ]);
  // 용돈 규칙이 생기기 전에는 이 두 건이 자동이체 포괄 규칙에 걸려 여기 있었다.
  assert.deepEqual(result.고정지출2.items, [
    { key: '고정비', total: 0, count: 0 },
    { key: '비상금', total: 0, count: 0 },
  ]);
});

test('섹션 합계가 메인 계좌 금액 총합과 같다(항등식)', async () => {
  const rows = await fixtureRows();
  const result = report(rows);
  const sumOfAmounts = rows.reduce((total, current) => total + Number(current.amount), 0);

  assert.equal(
    result.종합정산.수입 +
      result.종합정산.고정지출1 +
      result.종합정산.고정지출2 +
      result.종합정산.변동지출 +
      result.종합정산.계좌간이동,
    result.종합정산.실현순증감,
  );
  assert.equal(result.종합정산.실현순증감, sumOfAmounts);
});

test('fixture 의 실현순증감이 메인 잔액 변화와 같다', async () => {
  const result = report(await fixtureRows());
  const main = result.계좌별잔액변화.find((entry) => entry.role === 'main');

  assert.equal(main.derived, true);
  assert.equal(main.opening, 7721051);
  assert.equal(main.closing, 7279186);
  assert.equal(main.change, -441865);
  assert.equal(result.종합정산.실현순증감, main.change);
});

// ── 실제 왕복 ──────────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function localAdminUrl() {
  const raw = process.env.TEST_DATABASE_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  const url = new URL(raw);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('TEST_DATABASE_URL 이 로컬 호스트가 아닙니다. 왕복 테스트를 거부합니다.');
  }
  return url;
}

function runMigrations(databaseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', 'migrate.mjs')], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`마이그레이션 실패(exit ${code}): ${stderr.trim()}`));
    });
  });
}

async function withScratchDatabase(t, name, run) {
  const admin = localAdminUrl();
  if (admin === null) {
    t.skip('TEST_DATABASE_URL 이 없어 실제 왕복은 확인하지 않는다(로컬 Postgres 필요).');
    return;
  }

  const { default: pg } = await import('pg');
  const scratch = `budget_agent_${name}_${process.pid}`;
  assert.match(scratch, /^[a-z_0-9]+$/);

  const adminClient = new pg.Client({ connectionString: admin.href });
  adminClient.on('error', () => {});
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${scratch}`);
  await adminClient.query(`CREATE DATABASE ${scratch}`);
  await adminClient.end();

  const scratchUrl = new URL(admin.href);
  scratchUrl.pathname = `/${scratch}`;

  t.after(async () => {
    const cleanup = new pg.Client({ connectionString: admin.href });
    cleanup.on('error', () => {});
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await cleanup.end();
  });

  await runMigrations(scratchUrl.href);

  const client = new pg.Client({ connectionString: scratchUrl.href });
  client.on('error', () => {});
  await client.connect();
  try {
    for (const { role, last4, nickname } of ACCOUNTS) {
      await client.query('INSERT INTO accounts (nickname, role, last4) VALUES ($1, $2, $3)', [
        nickname,
        role,
        last4,
      ]);
    }
    await run(client);
  } finally {
    await client.end().catch(() => {});
  }
}

test('저장된 한 달치로 같은 숫자가 나온다', async (t) => {
  await withScratchDatabase(t, 'report', async (client) => {
    await client.query('BEGIN');
    await insertTransactions(client, fixtureRecords());
    await client.query('COMMIT');
    await classifyStored(client, { yearMonth: YM });

    // adjustments 테이블은 스키마에 남아 있지만 집계는 더 이상 읽지 않는다.
    await client.query(
      `INSERT INTO adjustments (year_month, target, amount, reason)
       VALUES ($1, '변동비', -10000, '전월 이월')`,
      [YM],
    );

    const result = await buildMonthlyReport(client, YM);

    assert.equal(result.yearMonth, YM);
    assert.equal(result.거래건수, 24);
    assert.equal(result.수입.total, 11480113);
    assert.equal(result.변동지출.카드대금.total, -5090698);
    assert.deepEqual(
      result.변동지출.카드대금.issuers.map((item) => item.issuer),
      ['삼성카드', '현대카드', 'KB국민카드'],
    );
    assert.equal(result.계좌간이동.total, -1500000);
    // 20260924033721729_add-allowance-rule.sql 이 실제로 적용된 결과.
    // 규칙을 손으로 복사한 상수가 아니라 마이그레이션이 넣은 행으로 분류된 값이다.
    assert.equal(result.고정지출1.items.find((item) => item.key === '용돈').total, -1000000);
    assert.equal(result.고정지출1.total, -5150000);
    assert.equal(result.고정지출2.total, 0);
    assert.equal(result.미분류.count, 8);
    assert.equal(Object.hasOwn(result, '보정'), false);
    assert.equal(Object.hasOwn(result.종합정산, '보정후순증감'), false);

    const main = result.계좌별잔액변화.find((entry) => entry.role === 'main');
    assert.equal(main.change, -441865);
    assert.equal(result.종합정산.실현순증감, main.change);

    // 다른 달을 물으면 빈 표가 나온다(던지지 않는다).
    const empty = await buildMonthlyReport(client, '2026-07');
    assert.equal(empty.거래건수, 0);
    assert.equal(empty.종합정산.실현순증감, 0);
  });
});

test('year_month 형식이 아니면 조회하지 않는다', async () => {
  const client = {
    async query() {
      throw new Error('쿼리가 나가면 안 된다');
    },
  };
  for (const bad of ['2026-8', '2026/08', 'august', '']) {
    await assert.rejects(() => buildMonthlyReport(client, bad), /YYYY-MM/);
  }
});

test('DB 오류 메시지를 그대로 흘리지 않는다', async () => {
  const client = {
    async query() {
      throw new Error('relation "transactions" does not exist (host=secret-host)');
    },
  };

  await assert.rejects(
    () => buildMonthlyReport(client, YM),
    (error) => {
      assert.ok(!error.message.includes('secret-host'));
      assert.match(error.message, /현금흐름표 입력을 읽지 못했습니다/);
      return true;
    },
  );
});
