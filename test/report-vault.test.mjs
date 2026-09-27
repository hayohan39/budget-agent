// 비상금 계좌에 연결된 금고(토스뱅크 금고)로 옮긴 돈 · 금고에서 꺼낸 돈.
//
// 사용자 설명: "비상금 계좌 같은 경우에는 '비상금'으로 출금될때가 있는데 이건 비상금
// 계좌에 연결된 금고로 빠지는거야. 즉 금고저축인거지."
//
// 합성 데이터만 쓴다(이름 · 금액은 가상).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateMonthly,
  buildMonthlyReport,
  isVaultMove,
  matchIncomingTransfers,
} from '../lib/report/monthly.mjs';
import { verifyMonthlyReport } from '../lib/report/verify.mjs';
import { trendPointOf } from '../lib/report/trends.mjs';
import { CLASSIFY_FILTERS, groupRows, listClassifyGroups } from '../lib/classify/manual.mjs';
import { withScratchDatabase } from './helpers/scratch-db.mjs';

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
    txn_at: `2026-08-${String(1 + (seq % 27)).padStart(2, '0')}T09:00:00+09:00`,
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

/** 비상금 계좌 한 달: 메인에서 30만 입금 → 금고로 20만 → 금고에서 5만 꺼냄 → 이자 → 병원비 집행. */
function emergencyMonth() {
  return [
    row({ amount: '3000000', description: '가상회사 급여', category: '수입', txn_at: '2026-08-01T09:00:00+09:00', balance: '3000000' }),
    row({ amount: '-300000', description: '비상금 계좌', category: '비상금이체', is_transfer: true, txn_at: '2026-08-02T09:00:00+09:00', balance: '2700000' }),
    row({ account_id: 3, amount: '300000', description: '홍길동', txn_at: '2026-08-02T09:00:00+09:00', balance: '1300000' }),
    row({ account_id: 3, amount: '-200000', description: '비상금', txn_type: '출금', txn_at: '2026-08-03T09:00:00+09:00', balance: '1100000' }),
    row({ account_id: 3, amount: '50000', description: '비상금', txn_type: '입금', txn_at: '2026-08-10T09:00:00+09:00', balance: '1150000' }),
    row({ account_id: 3, amount: '900', description: '이자', txn_type: '이자입금', category: '이자', txn_at: '2026-08-20T09:00:00+09:00', balance: '1150900' }),
    row({ account_id: 3, amount: '-80000', description: '가상병원', txn_type: '출금', txn_at: '2026-08-25T09:00:00+09:00', balance: '1070900' }),
  ];
}

function emergencyBlock(report) {
  return report.계좌블록.find((block) => block.role === 'emergency');
}

test('isVaultMove: 비상금 계좌의 적요가 정확히 비상금일 때만', () => {
  assert.equal(isVaultMove({ description: '비상금' }, 'emergency'), true);
  assert.equal(isVaultMove({ description: '  비상금 ' }, 'emergency'), true); // 정규화
  for (const description of ['비상금 계좌', '비상금계좌', '비상금 적금', '비상', '']) {
    assert.equal(isVaultMove({ description }, 'emergency'), false, description);
  }
  // 다른 계좌의 같은 적요는 금고 이동이 아니다.
  for (const role of ['main', 'fixed', undefined, null, 'constructor']) {
    assert.equal(isVaultMove({ description: '비상금' }, role), false, String(role));
  }
});

test('금고로 옮긴 돈은 금고저축, 꺼낸 돈은 금고 인출 — 집행 · 입금이 아니다', () => {
  const block = emergencyBlock(aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows: emergencyMonth() }));
  assert.deepEqual(block.입금, { total: 300000, count: 1 });
  assert.deepEqual(block.집행, { total: -80000, count: 1 });
  assert.deepEqual(block.이자, { total: 900, count: 1 });
  assert.deepEqual(block.금고저축, { total: -200000, count: 1 });
  assert.deepEqual(block.금고인출, { total: 50000, count: 1 });
  // 항목 줄에는 집행만 — 금고 이동은 없다.
  assert.deepEqual(block.항목.map((line) => line.item), ['가상병원']);
  // 순증감은 금고까지 합친 이 계좌 돈의 증감(입금 + 이자 − 집행).
  assert.equal(block.순증감, 300000 + 900 - 80000);
});

test('계좌 잔액 변화 = 순증감 + 금고저축 + 금고 인출 (명세서 잔액과 맞는다)', () => {
  const report = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows: emergencyMonth() });
  const block = emergencyBlock(report);
  const balance = report.계좌별잔액변화.find((entry) => entry.role === 'emergency');
  assert.equal(balance.derived, true);
  assert.equal(balance.change, block.순증감 + block.금고저축.total + block.금고인출.total);
});

test('종합정산 · 검산 · 통계는 그대로다(금고 이동은 메인 계좌의 돈이 아니다)', () => {
  const withVault = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows: emergencyMonth() });
  const withoutVault = aggregateMonthly({
    yearMonth: '2026-08',
    accounts: ACCOUNTS,
    rows: emergencyMonth().filter((r) => !(r.account_id === 3 && r.description === '비상금')),
  });
  assert.deepEqual(withVault.종합정산, withoutVault.종합정산);
  assert.equal(verifyMonthlyReport(withVault).ok, true);
  // 거래 건수(count)만 다르다 — 여섯 값은 같다.
  const pointWith = trendPointOf(withVault);
  const pointWithout = trendPointOf(withoutVault);
  for (const key of ['수입', '저축', '주거비', '고정비', '카드비', '변동비']) {
    assert.equal(pointWith[key], pointWithout[key], key);
  }
});

test('분류가 없는 금고 이동은 미분류로 세지 않는다 · 규칙이 붙인 분류가 있어도 금고 이동이다', () => {
  const report = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows: emergencyMonth() });
  // 미분류: 가상병원 1건뿐(홍길동 입금은 메인 쪽 이체와 짝이라 빠진다).
  assert.deepEqual(report.미분류, { count: 1, 계좌간이체입금: 1, 금고이동: 2 });

  // 자동이체 규칙 등으로 '고정비' 가 붙어 있어도 금고 이동이다(집행이 아니다).
  const labelled = emergencyMonth().map((r) =>
    r.account_id === 3 && r.description === '비상금' ? { ...r, category: '고정비' } : r,
  );
  const block = emergencyBlock(aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows: labelled }));
  assert.deepEqual(block.집행, { total: -80000, count: 1 });
  assert.deepEqual(block.금고저축, { total: -200000, count: 1 });
});

test('다른 계좌 · 다른 적요는 예전 그대로다', () => {
  const rows = [
    // 메인 계좌의 '비상금' 출금 — 금고 이동으로 보지 않는다(변동비의 미분류 일회성 지출).
    row({ amount: '-10000', description: '비상금' }),
    // 고정비 계좌의 '비상금' 출금 — 집행이다.
    row({ account_id: 2, amount: '-20000', description: '비상금' }),
    // 비상금 계좌의 '비상금 적금' — 집행이다.
    row({ account_id: 3, amount: '-30000', description: '비상금 적금' }),
  ];
  const report = aggregateMonthly({ yearMonth: '2026-08', accounts: ACCOUNTS, rows });
  assert.equal(report.변동비.일회성지출.total, -10000);
  assert.equal(report.계좌블록.find((b) => b.role === 'fixed').집행.total, -20000);
  const emergency = emergencyBlock(report);
  assert.equal(emergency.집행.total, -30000);
  assert.equal(emergency.금고저축.count, 0);
  assert.equal(report.미분류.count, 3);
  assert.equal(report.미분류.금고이동, 0);
});

test('금고에서 꺼낸 입금은 메인 → 비상금 이체와 짝짓지 않는다(금액 · 시각이 같아도)', () => {
  const rows = [
    row({ id: 'm1', amount: '-50000', description: '비상금 계좌', category: '비상금이체', is_transfer: true, txn_at: '2026-08-05T09:00:00+09:00' }),
    // 같은 초 · 같은 금액의 금고 인출 — 짝이 아니다.
    row({ id: 'v1', account_id: 3, amount: '50000', description: '비상금', txn_at: '2026-08-05T09:00:00+09:00' }),
    // 진짜 받는 쪽 입금(1초 뒤).
    row({ id: 'r1', account_id: 3, amount: '50000', description: '홍길동', txn_at: '2026-08-05T09:00:01+09:00' }),
  ];
  assert.deepEqual([...matchIncomingTransfers({ accounts: ACCOUNTS, rows })], ['r1']);
});

test('/classify: 금고 이동 묶음은 미분류만 보기에서 빠지고, 전체 보기에서는 건수가 보인다', () => {
  const rows = emergencyMonth();
  const unclassified = groupRows(rows, CLASSIFY_FILTERS.unclassified, ACCOUNTS);
  assert.deepEqual(
    unclassified.map((group) => [group.account.role, group.key, group.direction]),
    [['emergency', '가상병원', 'out']],
  );
  const all = groupRows(rows, CLASSIFY_FILTERS.all, ACCOUNTS);
  const vaultGroups = all.filter((group) => group.vault > 0);
  assert.deepEqual(
    vaultGroups.map((group) => [group.key, group.direction, group.vault, group.unclassified]).sort(),
    [
      ['비상금', 'in', 1, 0],
      ['비상금', 'out', 1, 0],
    ],
  );
});

test('실제 DB: 저장된 비상금 계좌의 금고 이동이 현금흐름표 · /classify 에 반영된다', async (t) => {
  await withScratchDatabase(t, 'vault', async (client) => {
    const rows = emergencyMonth();
    const ids = new Map();
    for (const [index, r] of rows.entries()) {
      const inserted = await client.query(
        `INSERT INTO transactions
           (account_id, txn_at, description, txn_type, amount, balance, category, is_transfer, year_month, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2026-08', $9) RETURNING id`,
        [r.account_id, r.txn_at, r.description, r.txn_type, r.amount, r.balance, r.category, r.is_transfer, `vault-${index}`],
      );
      ids.set(r.id, inserted.rows[0].id);
    }
    const report = await buildMonthlyReport(client, '2026-08');
    const block = emergencyBlock(report);
    assert.deepEqual([block.금고저축.total, block.금고인출.total, block.집행.total, block.입금.total], [-200000, 50000, -80000, 300000]);
    assert.equal(report.미분류.금고이동, 2);
    const balance = report.계좌별잔액변화.find((entry) => entry.role === 'emergency');
    assert.equal(balance.change, block.순증감 + block.금고저축.total + block.금고인출.total);

    const groups = await listClassifyGroups(client, '2026-08', CLASSIFY_FILTERS.unclassified);
    assert.deepEqual(groups.map((group) => group.key), ['가상병원']);
  });
});
