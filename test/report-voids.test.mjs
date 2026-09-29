// 무효(상쇄) 처리 — 출금 뒤 거부 · 반환되어 되돌아온 같은 금액의 입금을 사람이 "없던 일"로 표시.
//
// 사용자 요청(2026-09): "지현 IRP, 선용 IRP 의 경우 출금되었다가 거부되어서 다시 입금되는
// 경우가 있는데 이때 중복으로 수입에 잡히는 것 같아 … 이 경우에는 입출금 무효화 하고 싶어.
// 예외처리할 수 있는 기능도 추가해줘."
//
// 합성 데이터만 쓴다(가상 이름 · 가상 금액). DB 테스트는 TEST_DATABASE_URL 이 있을 때만 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateMonthly, buildMonthlyReport } from '../lib/report/monthly.mjs';
import { verifyMonthlyReport } from '../lib/report/verify.mjs';
import {
  VOID_ERROR_MESSAGES,
  VOID_WINDOW_DAYS,
  checkVoidPair,
  findVoidCandidates,
  listVoidCandidates,
  listVoidedPairs,
  parseVoidRequest,
  unvoidPair,
  voidPair,
} from '../lib/report/voids.mjs';
import { handleVoidPost } from '../lib/classify/http.mjs';
import { CLASSIFY_FILTERS, countUnclassified, listAllPeriodGroups, listClassifyGroups } from '../lib/classify/manual.mjs';
import { insertTransactions } from '../lib/db/transactions.mjs';
import { withScratchDatabase } from './helpers/scratch-db.mjs';

const ACCOUNTS = [
  { id: 1, role: 'main', nickname: '메인' },
  { id: 2, role: 'fixed', nickname: '고정비' },
  { id: 3, role: 'emergency', nickname: '비상금' },
];

function row(overrides = {}) {
  return {
    id: '1',
    account_id: 1,
    txn_at: '2026-07-10T09:00:00+09:00',
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

// 7월: 급여 입금 → 길동 IRP 출금 → 거부되어 되돌아온 입금(IRP 규칙에 걸려 '저축' 입금 = 수입 섹션).
function irpMonth({ voided }) {
  return [
    row({ id: '1', txn_at: '2026-07-01T09:00:00+09:00', description: '급여', amount: '3000000', balance: '3000000', category: '수입' }),
    row({ id: '2', txn_at: '2026-07-03T09:00:00+09:00', description: '길동 IRP', txn_type: '자동이체', amount: '-300000', balance: '2700000', category: '저축', voided }),
    row({ id: '3', txn_at: '2026-07-04T09:00:00+09:00', description: '길동 IRP', txn_type: '입금', amount: '300000', balance: '3000000', category: '저축', voided }),
    row({ id: '4', txn_at: '2026-07-20T09:00:00+09:00', description: '동네가게', txn_type: '체크카드', amount: '-50000', balance: '2950000' }),
  ];
}

test('무효가 아니면: 되돌아온 입금이 수입으로, 출금이 저축으로 따로 잡힌다(지금의 문제)', () => {
  const report = aggregateMonthly({ yearMonth: '2026-07', accounts: ACCOUNTS, rows: irpMonth({ voided: false }) });
  assert.equal(report.수입.total, 3300000);
  assert.equal(report.고정지출1.items.find((item) => item.key === '저축').total, -300000);
  assert.deepEqual(report.무효처리, { total: 0, count: 0 });
});

test('무효 쌍은 수입 · 지출 · 미분류 · 항목 줄 어디에도 없고, 무효처리 한 항(같은 달이면 0)에만 모인다', () => {
  const report = aggregateMonthly({ yearMonth: '2026-07', accounts: ACCOUNTS, rows: irpMonth({ voided: true }) });
  assert.equal(report.수입.total, 3000000);
  assert.equal(report.고정지출1.items.find((item) => item.key === '저축').total, 0);
  assert.ok(report.항목별.수입.every((line) => line.item !== '길동 IRP'));
  assert.ok(report.항목별.고정지출1.every((line) => line.item !== '길동 IRP'));
  assert.deepEqual(report.무효처리, { total: 0, count: 2 });
  assert.equal(report.종합정산.무효처리, 0);
  assert.equal(report.미분류.count, 1); // 동네가게만
  // 실현순증감 = 섹션 합 = 메인 금액 합(무효 쌍은 서로 지운다). 검산 통과.
  assert.equal(report.종합정산.실현순증감, 2950000);
  assert.equal(verifyMonthlyReport(report).ok, true);
});

test('미분류 무효 거래는 미분류로 세지 않는다', () => {
  const rows = irpMonth({ voided: true }).map((entry) => ({ ...entry, category: entry.voided ? null : entry.category }));
  const report = aggregateMonthly({ yearMonth: '2026-07', accounts: ACCOUNTS, rows });
  assert.equal(report.미분류.count, 1);
});

test('달을 걸친 쌍(6/30 출금 · 7/2 입금): 각 달의 무효처리에 ±금액이 남고 두 달 모두 검산이 맞는다', () => {
  const june = aggregateMonthly({
    yearMonth: '2026-06',
    accounts: ACCOUNTS,
    rows: [
      row({ id: '1', txn_at: '2026-06-01T09:00:00+09:00', description: '급여', amount: '1000000', balance: '1000000', category: '수입' }),
      row({ id: '2', txn_at: '2026-06-30T09:00:00+09:00', description: '길동 IRP', amount: '-300000', balance: '700000', category: '저축', voided: true }),
    ],
  });
  assert.deepEqual(june.무효처리, { total: -300000, count: 1 });
  assert.equal(june.종합정산.실현순증감, 700000);
  assert.equal(verifyMonthlyReport(june).ok, true);

  const july = aggregateMonthly({
    yearMonth: '2026-07',
    accounts: ACCOUNTS,
    rows: [
      row({ id: '3', txn_at: '2026-07-02T09:00:00+09:00', description: '길동 IRP', amount: '300000', balance: '1000000', category: '저축', voided: true }),
      row({ id: '4', txn_at: '2026-07-05T09:00:00+09:00', description: '가게', amount: '-1000', balance: '999000', category: '변동비' }),
    ],
  });
  assert.equal(july.수입.total, 0, '되돌아온 입금이 수입에 없다');
  assert.deepEqual(july.무효처리, { total: 300000, count: 1 });
  assert.equal(verifyMonthlyReport(july).ok, true);
});

test('비메인 계좌의 무효 쌍: 입금 · 집행 · 순증감에서 빠지고 블록의 무효 줄에만 있다', () => {
  const report = aggregateMonthly({
    yearMonth: '2026-07',
    accounts: ACCOUNTS,
    rows: [
      row({ id: '1', account_id: 2, txn_at: '2026-07-01T09:00:00+09:00', description: '보험', amount: '-50000', balance: '950000', category: '고정비' }),
      row({ id: '2', account_id: 2, txn_at: '2026-07-02T09:00:00+09:00', description: '보험', amount: '50000', balance: '950000', voided: true }),
      row({ id: '3', account_id: 2, txn_at: '2026-07-01T10:00:00+09:00', description: '보험', amount: '-50000', balance: '900000', voided: true }),
    ],
  });
  const fixed = report.계좌블록.find((block) => block.role === 'fixed');
  assert.deepEqual(fixed.집행, { total: -50000, count: 1 });
  assert.deepEqual(fixed.입금, { total: 0, count: 0 });
  assert.deepEqual(fixed.무효, { total: 0, count: 2 });
  assert.equal(fixed.순증감, -50000);
  // 계좌 잔액 변화 = 순증감 + 금고 + 무효.
  const balance = report.계좌별잔액변화.find((entry) => entry.role === 'fixed');
  assert.equal(balance.change, fixed.순증감 + fixed.금고저축.total + fixed.금고인출.total + fixed.무효.total);
  assert.equal(report.종합정산.실현순증감, 0);
});

// ── 후보 ──────────────────────────────────────────────────────────────────

function candidateRow(overrides) {
  return {
    account_id: 1,
    role: 'main',
    nickname: '메인',
    year_month: '2026-07',
    txn_at: '2026-07-03T09:00:00+09:00',
    at_text: '2026-07-03 09:00',
    description: '',
    memo: null,
    category: null,
    is_transfer: false,
    ...overrides,
  };
}

test('후보: 같은 계좌 · 같은 금액 · 반대 방향 · 31일 안. 적요/메모 같음 -> 출금 먼저 -> 가까운 순', () => {
  const rows = [
    candidateRow({ id: '1', description: '홍길동', memo: '길동 IRP', amount: '-300000' }),
    candidateRow({ id: '2', description: '한국투자증권', memo: '길동 IRP', amount: '300000', txn_at: '2026-07-05T09:00:00+09:00', at_text: '2026-07-05 09:00' }),
    candidateRow({ id: '3', description: '김철수', amount: '300000', txn_at: '2026-07-04T09:00:00+09:00', at_text: '2026-07-04 09:00' }),
    candidateRow({ id: '4', description: '홍길동', amount: '300000', account_id: 2, role: 'fixed', nickname: '고정비' }), // 다른 계좌
    candidateRow({ id: '5', description: '가게', amount: '-12000' }),
    candidateRow({ id: '6', description: '가게', amount: '12000', txn_at: '2026-09-01T09:00:00+09:00', year_month: '2026-09' }), // 60일 뒤
    candidateRow({ id: '7', description: '비상금 계좌', amount: '-500000', is_transfer: true, category: '비상금이체' }),
    candidateRow({ id: '8', description: '비상금 계좌', amount: '500000' }),
    // 금고 이동(비상금 계좌의 `비상금`)은 후보가 아니다.
    candidateRow({ id: '9', account_id: 3, role: 'emergency', nickname: '비상금', description: '비상금', amount: '-100000' }),
    candidateRow({ id: '10', account_id: 3, role: 'emergency', nickname: '비상금', description: '비상금', amount: '100000' }),
  ];
  const candidates = findVoidCandidates(rows, '2026-07');
  assert.deepEqual(
    candidates.map((c) => [c.out.id, c.in.id, c.similar, c.outFirst, c.gapDays]),
    [
      ['1', '2', true, true, 2],
      ['1', '3', false, true, 1],
    ],
  );
  assert.deepEqual(candidates[0].out, {
    id: '1',
    yearMonth: '2026-07',
    at: '2026-07-03 09:00',
    description: '홍길동',
    memo: '길동 IRP',
    amount: -300000,
  });
  // 그 달에 걸친 쌍만: 9월 기준으로는 7월 쌍이 나오지 않는다.
  assert.deepEqual(findVoidCandidates(rows, '2026-09'), []);
});

test('checkVoidPair: 후보 찾기와 무효 처리가 함께 쓰는 판정 — 창 · 금고 이동 · 이동 다리까지', () => {
  const out = candidateRow({ id: '1', amount: '-300000', txn_at: '2026-07-01T09:00:00+09:00' });
  const at = (iso) => candidateRow({ id: '2', amount: '300000', txn_at: iso });
  // 창 경계: 정확히 31일은 허용, 1초라도 넘으면 거부. 순서가 바뀌어도 같다.
  assert.equal(checkVoidPair(out, at('2026-08-01T09:00:00+09:00')).ok, true);
  assert.equal(checkVoidPair(at('2026-08-01T09:00:00+09:00'), out).ok, true);
  assert.equal(checkVoidPair(out, at('2026-08-01T09:00:01+09:00')).error, 'outOfWindow');
  assert.equal(checkVoidPair(out, at('2026-05-31T08:59:59+09:00')).error, 'outOfWindow'); // 입금이 먼저여도 창은 같다
  assert.equal(checkVoidPair(out, at('not a date')).error, 'outOfWindow');
  // 금고 이동(비상금 계좌의 `비상금`): 어느 한 쪽만 그래도 거부.
  const vault = (overrides) => candidateRow({ account_id: 3, role: 'emergency', nickname: '비상금', ...overrides });
  assert.equal(
    checkVoidPair(vault({ id: '3', description: '비상금', amount: '-100000' }), vault({ id: '4', description: '비상금', amount: '100000' })).error,
    'vaultMove',
  );
  assert.equal(
    checkVoidPair(vault({ id: '3', description: '가게', amount: '-100000' }), vault({ id: '4', description: '비상금', amount: '100000' })).error,
    'vaultMove',
  );
  // 내 계좌 간 이동 다리: is_transfer 든 이동 분류든.
  const plainIn = candidateRow({ id: '6', amount: '500000', txn_at: '2026-07-02T09:00:00+09:00' });
  assert.equal(checkVoidPair(candidateRow({ id: '5', amount: '-500000', is_transfer: true }), plainIn).error, 'transferLeg');
  assert.equal(checkVoidPair(candidateRow({ id: '5', amount: '-500000', category: '고정비이체' }), plainIn).error, 'transferLeg');
  assert.equal(checkVoidPair(candidateRow({ id: '5', amount: '-500000' }), { ...plainIn, category: '비상금이체' }).error, 'transferLeg');
  // 새 코드마다 고정 문장이 있다(입력값을 싣지 않는다).
  for (const code of ['outOfWindow', 'vaultMove', 'transferLeg']) {
    assert.equal(typeof VOID_ERROR_MESSAGES[code], 'string', code);
    assert.doesNotMatch(VOID_ERROR_MESSAGES[code], /[0-9]{4,}/);
  }
  assert.match(VOID_ERROR_MESSAGES.outOfWindow, new RegExp(`${VOID_WINDOW_DAYS}일`));
});

test('요청 검사: id 는 양의 정수 문자열, 같은 거래 둘은 거부', () => {
  assert.equal(parseVoidRequest({ action: 'void', outId: '12', inId: '13' }).ok, true);
  assert.equal(parseVoidRequest({ action: 'void', outId: '12', inId: '12' }).error, 'sameTransaction');
  for (const bad of ['0', '-1', '01', '1.5', ' 1', 'x', '1; DROP', null, {}, '12345678901234567890']) {
    assert.equal(parseVoidRequest({ action: 'void', outId: bad, inId: '13' }).error, 'badRequest', String(bad));
  }
  assert.equal(parseVoidRequest({ action: 'unvoid', pairId: '3' }).ok, true);
  assert.equal(parseVoidRequest({ action: 'delete', pairId: '3' }).error, 'badRequest');
});

test('HTTP: 인증 · 명단 · Origin 을 DB 전에 본다', async () => {
  let calls = 0;
  const deps = (session) => ({
    auth: async () => session,
    isAllowedEmail: (email) => email === 'owner@example.test',
    withClient: async () => {
      calls += 1;
      throw new Error('여기까지 오면 안 된다');
    },
  });
  const request = (body, headers = {}) =>
    new Request('http://localhost:3000/api/report/voids', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', ...headers },
      body: JSON.stringify(body),
    });
  const good = { action: 'void', outId: '1', inId: '2' };
  assert.equal((await handleVoidPost(request(good), deps(null))).status, 401);
  assert.equal((await handleVoidPost(request(good), deps({ user: { email: 'x@example.test' } }))).status, 403);
  assert.equal(
    (await handleVoidPost(request(good, { origin: 'https://evil.example' }), deps({ user: { email: 'owner@example.test' } }))).status,
    403,
  );
  assert.equal((await handleVoidPost(request({ action: 'void', outId: 'x' }), deps({ user: { email: 'owner@example.test' } }))).status, 400);
  assert.equal(calls, 0);
});

// ── 실제 DB ───────────────────────────────────────────────────────────────

function record(n, overrides = {}) {
  const month = overrides.year_month ?? '2026-07';
  return {
    account_id: 1,
    txn_at: `${month}-${String(1 + (n % 27)).padStart(2, '0')}T09:00:00+09:00`,
    description: '길동 IRP',
    txn_type: '자동이체',
    institution: null,
    cp_acct_hash: null,
    amount: -300000,
    balance: null,
    memo: null,
    category: null,
    category_source: null,
    item: null,
    is_transfer: false,
    dedupe_key: `test-void-${n}`,
    year_month: month,
    ...overrides,
  };
}

async function idOf(client, key) {
  return String((await client.query('SELECT id FROM transactions WHERE dedupe_key = $1', [key])).rows[0].id);
}

test('실제 DB: 무효 처리 · 검사 · 목록 · 해제, 현금흐름표와 /classify 에서 빠진다', async (t) => {
  await withScratchDatabase(t, 'voids', async (client) => {
    await insertTransactions(client, [
      record(1, { txn_at: '2026-07-01T09:00:00+09:00', description: '급여', txn_type: '입금', amount: 3000000, balance: 3000000, category: '수입', category_source: 'rule' }),
      record(2, { txn_at: '2026-07-03T09:00:00+09:00', amount: -300000, balance: 2700000 }),
      record(3, { txn_at: '2026-07-04T09:00:00+09:00', txn_type: '입금', amount: 300000, balance: 3000000, memo: '반환' }),
      record(4, { txn_at: '2026-07-05T09:00:00+09:00', txn_type: '입금', amount: 200000, balance: 3200000 }), // 금액 다름
      record(5, { txn_at: '2026-07-06T09:00:00+09:00', account_id: 2, txn_type: '입금', amount: 300000 }), // 다른 계좌
      record(6, { txn_at: '2026-07-07T09:00:00+09:00', amount: -300000, balance: 2900000 }), // 같은 금액 출금 하나 더
    ]);
    const [out, inn, other, fixed, out2] = await Promise.all(
      ['test-void-2', 'test-void-3', 'test-void-4', 'test-void-5', 'test-void-6'].map((key) => idOf(client, key)),
    );

    const before = await buildMonthlyReport(client, '2026-07');
    assert.equal(before.미분류.count, 5);
    assert.equal(await countUnclassified(client, '2026-07'), 5);

    // 후보: (out, inn) 과 (out2, inn) — 둘 다 같은 적요. 출금이 먼저이고 가까운 쪽이 먼저.
    const candidates = await listVoidCandidates(client, '2026-07');
    assert.deepEqual(candidates.map((c) => [c.out.id, c.in.id]), [[out, inn], [out2, inn]]);

    // 검사.
    assert.equal((await voidPair(client, { outId: out, inId: other })).error, 'amountMismatch');
    assert.equal((await voidPair(client, { outId: out, inId: fixed })).error, 'accountMismatch');
    assert.equal((await voidPair(client, { outId: out, inId: out2 })).error, 'directionMismatch');
    assert.equal((await voidPair(client, { outId: out, inId: '999999' })).error, 'notFound');

    // 순서가 바뀌어 와도 서버가 방향을 정한다.
    const made = await voidPair(client, { outId: inn, inId: out });
    assert.equal(made.ok, true);
    assert.equal((await voidPair(client, { outId: out2, inId: inn })).error, 'alreadyVoided');
    await assert.rejects(() => client.query('INSERT INTO voided_pairs (out_txn_id, in_txn_id) VALUES ($1, $1)', [out2]));

    const pairs = await listVoidedPairs(client, '2026-07');
    assert.deepEqual(pairs.map((p) => [p.pairId, p.out.id, p.in.id, p.in.memo, p.account.role]), [
      [made.pairId, out, inn, '반환', 'main'],
    ]);
    // 무효가 된 거래는 후보에서 사라진다.
    assert.deepEqual(await listVoidCandidates(client, '2026-07'), []);

    const after = await buildMonthlyReport(client, '2026-07');
    assert.deepEqual(after.무효처리, { total: 0, count: 2 });
    assert.equal(after.미분류.count, 3);
    assert.equal(after.종합정산.실현순증감, before.종합정산.실현순증감);
    assert.equal(verifyMonthlyReport(after).ok, verifyMonthlyReport(before).ok);
    assert.equal(await countUnclassified(client, '2026-07'), 3);
    const groups = await listClassifyGroups(client, '2026-07', CLASSIFY_FILTERS.all);
    assert.equal(
      groups.filter((g) => g.key === '길동 IRP').reduce((sum, g) => sum + g.count, 0),
      3, // out2 · other · fixed
    );
    // 전체 기간 보기도 한 달 보기와 같이 무효 거래를 뺀다.
    const allPeriod = await listAllPeriodGroups(client, CLASSIFY_FILTERS.all);
    assert.deepEqual(allPeriod.months.find((m) => m.month === '2026-07').groups, groups);

    // 해제.
    assert.deepEqual(await unvoidPair(client, { pairId: made.pairId }), { ok: true });
    assert.equal((await unvoidPair(client, { pairId: made.pairId })).error, 'pairNotFound');
    assert.deepEqual((await buildMonthlyReport(client, '2026-07')).무효처리, { total: 0, count: 0 });

    // 거래가 지워지면 쌍도 지워진다(ON DELETE CASCADE).
    await voidPair(client, { outId: out, inId: inn });
    await client.query('DELETE FROM transactions WHERE id = $1', [inn]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM voided_pairs')).rows[0].n, 0);
  });
});

test('동시 쓰기: 같은 입금을 두 쌍으로 동시에 무효 처리하면 하나만 된다', async (t) => {
  await withScratchDatabase(t, 'voids_race', async (client, url) => {
    await insertTransactions(client, [
      record(1, { amount: -300000 }),
      record(2, { amount: -300000, txn_at: '2026-07-10T09:00:00+09:00' }),
      record(3, { amount: 300000, txn_type: '입금', txn_at: '2026-07-12T09:00:00+09:00' }),
    ]);
    const [a, b, inn] = await Promise.all(['test-void-1', 'test-void-2', 'test-void-3'].map((key) => idOf(client, key)));
    const { default: pg } = await import('pg');
    const other = new pg.Client({ connectionString: url });
    other.on('error', () => {});
    await other.connect();
    t.after(() => other.end().catch(() => {}));

    const results = await Promise.all([voidPair(client, { outId: a, inId: inn }), voidPair(other, { outId: b, inId: inn })]);
    assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
    assert.equal(results.find((r) => !r.ok).error, 'alreadyVoided');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM voided_pairs')).rows[0].n, 1);
  });
});

test('실제 DB: 직접 보낸 id 도 후보 조건으로 거부된다(창 · 금고 이동 · 이동 다리), 올바른 쌍은 그대로 된다', async (t) => {
  await withScratchDatabase(t, 'voids_guard', async (client) => {
    await insertTransactions(client, [
      // 창: 7/1 출금 ↔ 8/5 입금(35일) 거부, 7/1 출금 ↔ 8/1 같은 시각 입금(정확히 31일) 허용.
      record(1, { txn_at: '2026-07-01T09:00:00+09:00', amount: -300000 }),
      record(2, { txn_at: '2026-08-05T09:00:00+09:00', year_month: '2026-08', txn_type: '입금', amount: 300000 }),
      record(3, { txn_at: '2026-08-01T09:00:00+09:00', year_month: '2026-08', txn_type: '입금', amount: 300000, dedupe_key: 'test-void-3b' }),
      // 금고 이동: 비상금 계좌의 `비상금` 출금 ↔ 입금.
      record(4, { account_id: 3, txn_at: '2026-07-02T09:00:00+09:00', description: '비상금', amount: -100000 }),
      record(5, { account_id: 3, txn_at: '2026-07-03T09:00:00+09:00', description: '비상금', txn_type: '입금', amount: 100000 }),
      // 내 계좌 간 이동 다리: 메인의 비상금이체 출금 ↔ 같은 금액 입금.
      record(6, { txn_at: '2026-07-05T09:00:00+09:00', description: '비상금 계좌', amount: -500000, is_transfer: true, category: '비상금이체', category_source: 'rule' }),
      record(7, { txn_at: '2026-07-06T09:00:00+09:00', description: '비상금 계좌', txn_type: '입금', amount: 500000 }),
    ]);
    const [out, far, near, vaultOut, vaultIn, moveOut, moveIn] = await Promise.all(
      ['test-void-1', 'test-void-2', 'test-void-3b', 'test-void-4', 'test-void-5', 'test-void-6', 'test-void-7'].map((key) => idOf(client, key)),
    );

    assert.equal((await voidPair(client, { outId: out, inId: far })).error, 'outOfWindow');
    assert.equal((await voidPair(client, { outId: far, inId: out })).error, 'outOfWindow');
    assert.equal((await voidPair(client, { outId: vaultOut, inId: vaultIn })).error, 'vaultMove');
    assert.equal((await voidPair(client, { outId: moveOut, inId: moveIn })).error, 'transferLeg');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM voided_pairs')).rows[0].n, 0);

    // HTTP 로도 같은 거부가 고정 문장 · 400 으로 나간다(입력값을 싣지 않는다).
    const deps = {
      auth: async () => ({ user: { email: 'owner@example.test' } }),
      isAllowedEmail: (email) => email === 'owner@example.test',
      withClient: async (work) => work(client),
    };
    const post = (body) =>
      handleVoidPost(
        new Request('http://localhost:3000/api/report/voids', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000' },
          body: JSON.stringify(body),
        }),
        deps,
      );
    for (const [body, code] of [
      [{ action: 'void', outId: out, inId: far }, 'outOfWindow'],
      [{ action: 'void', outId: vaultOut, inId: vaultIn }, 'vaultMove'],
      [{ action: 'void', outId: moveOut, inId: moveIn }, 'transferLeg'],
    ]) {
      const response = await post(body);
      assert.equal(response.status, 400, code);
      // 본문은 고정 문장 하나뿐이다.
      assert.deepEqual(await response.json(), { ok: false, message: VOID_ERROR_MESSAGES[code] }, code);
    }

    // 후보 목록에 없는 쌍은 거부되고, 있는 쌍(정확히 31일)은 그대로 된다.
    const listed = await listVoidCandidates(client, '2026-07');
    assert.deepEqual(listed.map((c) => [c.out.id, c.in.id]), [[out, near]]);
    const made = await voidPair(client, { outId: near, inId: out });
    assert.equal(made.ok, true);
    assert.deepEqual((await listVoidedPairs(client, '2026-07')).map((p) => [p.out.id, p.in.id]), [[out, near]]);
  });
});

test('실제 DB: 짧은 2월을 낀 31일 안의 쌍(1/31 -> 3/2)도 양쪽 달 목록에 나오고, 2월에는 안 나온다', async (t) => {
  await withScratchDatabase(t, 'voids_february', async (client) => {
    await insertTransactions(client, [
      // 2027 년은 윤년이 아니다 — 1/31 -> 3/2 는 30일(창 안)이지만 달로는 두 칸 떨어져 있다.
      record(1, { txn_at: '2027-01-31T09:00:00+09:00', year_month: '2027-01', amount: -300000 }),
      record(2, { txn_at: '2027-03-02T09:00:00+09:00', year_month: '2027-03', txn_type: '입금', amount: 300000 }),
      // 창 밖(1/31 -> 3/5, 33일)은 넓힌 읽기에도 나오지 않는다.
      record(3, { txn_at: '2027-01-31T10:00:00+09:00', year_month: '2027-01', amount: -700000 }),
      record(4, { txn_at: '2027-03-05T10:00:00+09:00', year_month: '2027-03', txn_type: '입금', amount: 700000 }),
    ]);
    const [out, inn] = await Promise.all(['test-void-1', 'test-void-2'].map((key) => idOf(client, key)));

    for (const month of ['2027-01', '2027-03']) {
      const listed = await listVoidCandidates(client, month);
      assert.deepEqual(listed.map((c) => [c.out.id, c.in.id]), [[out, inn]], month);
    }
    // 한쪽이 이 달인 쌍만 보인다 — 2월에는 두 다리 모두 없다.
    assert.deepEqual(await listVoidCandidates(client, '2027-02'), []);
    // 목록에 나온 쌍은 voidPair 도 받아들인다(같은 판정).
    assert.equal((await voidPair(client, { outId: out, inId: inn })).ok, true);
    assert.deepEqual(await listVoidCandidates(client, '2027-01'), []);
  });
});

/** 결정적 의사 난수(mulberry32). 실패를 재현할 수 있게 씨앗을 고정한다. */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test('성질: voidPair 가 받아들이는 쌍은 모두 findVoidCandidates 가 내놓는 쌍이고, 그 역도 같다(상한 제외)', async (t) => {
  await withScratchDatabase(t, 'voids_property', async (client) => {
    const random = prng(20260928);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const records = [];
    for (let n = 1; n <= 22; n += 1) {
      // 6/10 ~ 8/28 사이(한국 시각). 달을 걸치고 창(31일)을 넘는 쌍이 생기게 넓게 흩뿌린다.
      const day = Math.floor(random() * 80);
      const at = new Date(Date.UTC(2026, 5, 10, 0, 0, 0) + day * 86400000 + Math.floor(random() * 86400) * 1000);
      const seoul = new Date(at.getTime() + 9 * 3600000);
      const yearMonth = `${seoul.getUTCFullYear()}-${String(seoul.getUTCMonth() + 1).padStart(2, '0')}`;
      const transfer = random() < 0.15;
      records.push(
        record(n, {
          account_id: pick([1, 1, 3]),
          txn_at: at.toISOString(),
          year_month: yearMonth,
          description: pick(['길동 IRP', '비상금', '가게']),
          amount: pick([-100000, 100000, -200000, 200000]),
          is_transfer: transfer,
          category: transfer ? '비상금이체' : pick([null, null, '저축']),
        }),
      );
    }
    await insertTransactions(client, records);
    const { rows } = await client.query(
      `SELECT t.id, t.account_id, t.year_month, t.txn_at, t.description, t.memo, t.amount, t.category, t.is_transfer,
              to_char(t.txn_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS at_text, a.role, a.nickname
         FROM transactions t JOIN accounts a ON a.id = t.account_id ORDER BY t.id`,
    );
    const months = [...new Set(rows.map((r) => String(r.year_month).trim()))];
    const listed = new Set(
      months.flatMap((ym) => findVoidCandidates(rows, ym, { limit: Infinity }).map((c) => `${c.out.id}:${c.in.id}`)),
    );

    const seen = new Map();
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const [x, y] = random() < 0.5 ? [rows[i], rows[j]] : [rows[j], rows[i]];
        const outcome = await voidPair(client, { outId: String(x.id), inId: String(y.id) });
        const outRow = toBigIntSign(x.amount) < 0 ? x : y;
        const inRow = outRow === x ? y : x;
        const key = `${outRow.id}:${inRow.id}`;
        assert.equal(outcome.ok, listed.has(key), `${key} -> ${outcome.ok ? 'ok' : outcome.error}`);
        seen.set(outcome.ok ? 'ok' : outcome.error, (seen.get(outcome.ok ? 'ok' : outcome.error) ?? 0) + 1);
        if (outcome.ok) assert.deepEqual(await unvoidPair(client, { pairId: outcome.pairId }), { ok: true });
      }
    }
    // 씨앗이 모든 갈래를 실제로 건드렸는지(성질이 헛돌지 않았는지).
    for (const code of ['ok', 'outOfWindow', 'vaultMove', 'transferLeg', 'accountMismatch', 'directionMismatch', 'amountMismatch']) {
      assert.ok((seen.get(code) ?? 0) > 0, code);
    }
  });
});

function toBigIntSign(amount) {
  return String(amount).trim().startsWith('-') ? -1 : 1;
}
