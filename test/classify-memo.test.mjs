// 메모 — 분류기(메모 매핑 · 규칙이 메모도 본다) · /classify 묶음 · 메모 기준 앞으로도 ·
// 미분류 다시 분류 · 현금흐름표 항목 줄의 메모.
//
// 사용자 요청(2026-09): "현재 엑셀파일에서 적요 뿐만 아니라 메모도 중요한 정보야 …
// 7월의 경우 저축에 대한 항목명들이 적요가 아닌 메모로 적혀 있어. 그래서 자동으로
// 변동비로 옮겨진 것 같아. 적요와 메모까지 함께 검토해서 항목을 분류하는 분류기 개선이
// 필요해."
//
// 합성 데이터만 쓴다(가상 이름 · 가상 금액). DB 테스트는 TEST_DATABASE_URL 이 있을 때만 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_SUBJECT_LENGTH, MEMO_ITEM_MAX_LENGTH, createClassifier } from '../lib/classify/engine.mjs';
import { ITEM_MAX_LENGTH } from '../lib/classify/item.mjs';
import {
  applyClassification,
  deleteMemoMapping,
  groupRows,
  listMemoMappings,
  parseClassifyRequest,
  parseMemoMappingRequest,
  reclassifyUnclassified,
  updateMapping,
  updateMemoMapping,
} from '../lib/classify/manual.mjs';
import { handleMappingPost, handleReclassifyPost } from '../lib/classify/http.mjs';
import { LINE_MEMO_LIMIT, aggregateMonthly } from '../lib/report/monthly.mjs';
import { insertTransactions } from '../lib/db/transactions.mjs';
import { withScratchDatabase } from './helpers/scratch-db.mjs';

/** 운영 DB 의 시드 규칙(migrations/*_seed-category-rules.sql + add-allowance-rule). */
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

// ── 분류기 ────────────────────────────────────────────────────────────────

test('7월 사례(합성): 적요는 보낸 사람 이름, 저축 상품명은 메모에만 — 이제 저축으로 분류된다', () => {
  const classifier = createClassifier({ rules: SEED_RULES });
  // 적요만 보면 어떤 규칙에도 걸리지 않아 미분류(= 현금흐름표의 변동비)로 갔던 모양.
  for (const [memo, txnType] of [
    ['길동 IRP', '모임원송금'],
    ['철수 연금저축', '출금'],
    ['영희 ISA', '모임원송금'],
  ]) {
    const before = classifier.classify({ description: '홍길동', memo: null, txn_type: txnType, amount: -300000 });
    assert.equal(before.category, null, '메모가 없으면 예전처럼 미분류');
    const after = classifier.classify({ description: '홍길동', memo, txn_type: txnType, amount: -300000 });
    assert.deepEqual([after.category, after.source, after.ruleId, after.basis], ['저축', 'category_rules', 5, 'memo'], memo);
    // 메모가 항목 이름이 된다 — 현금흐름표 저축 섹션에서 상품마다 다른 줄이다.
    assert.equal(after.item, memo);
  }
});

test('규칙은 priority 순으로, 규칙마다 적요 -> 메모를 본다 — 포괄 규칙이 메모의 저축을 가리지 않는다', () => {
  const classifier = createClassifier({ rules: SEED_RULES });
  // `자동이체 .*`(90)는 적요에 늘 맞는다. 적요를 모든 규칙에 먼저 돌렸다면 고정비가 됐다.
  const result = classifier.classify({ description: '홍길동', memo: '길동 IRP', txn_type: '자동이체', amount: -350000 });
  assert.equal(result.category, '저축');
  // 메모가 없으면 예전 그대로 고정비.
  assert.equal(classifier.classify({ description: '홍길동', txn_type: '자동이체', amount: -350000 }).category, '고정비');
  // 규칙의 txn_type · sign 가드는 메모에도 그대로다: 용돈 규칙은 출금만.
  assert.equal(classifier.classify({ description: '김철수', memo: '철수 용돈', txn_type: '입금', amount: 500000 }).category, null);
  assert.equal(classifier.classify({ description: '김철수', memo: '철수 용돈', txn_type: '출금', amount: -500000 }).category, '용돈');
});

test('메모로 걸린 규칙의 항목: 40자 이하 메모는 그대로, 넘으면 비워 둔다(적요로 계산)', () => {
  assert.equal(MEMO_ITEM_MAX_LENGTH, ITEM_MAX_LENGTH);
  const classifier = createClassifier({ rules: SEED_RULES });
  const long = `${'가'.repeat(ITEM_MAX_LENGTH)} IRP`;
  const result = classifier.classify({ description: '홍길동', memo: long, amount: -1 });
  assert.deepEqual([result.category, result.item], ['저축', null]);
  // 적요로 걸린 규칙은 예전처럼 항목을 주지 않는다.
  assert.equal(classifier.classify({ description: '길동 IRP', memo: '메모', amount: -1 }).item, null);
});

test('적요가 맞으면 적요의 결과가 그 규칙의 답이다(메모는 적요가 안 맞을 때만 본다)', () => {
  const classifier = createClassifier({ rules: SEED_RULES });
  // 적요 `대출 이자`(주거비, 40)가 메모 `IRP`(저축, 50)보다 priority 가 앞선다.
  const result = classifier.classify({ description: '대출 이자', memo: '길동 IRP', txn_type: '자동이체', amount: -800000 });
  assert.equal(result.category, '주거비');
});

test('메모 매핑이 가장 먼저다 — 적요 매핑 · 패턴 · 규칙보다 앞, 방향이 맞을 때만, 빈 메모는 건너뛴다', () => {
  const classifier = createClassifier({
    rules: SEED_RULES,
    merchantMap: [{ description: '홍길동', direction: 'out', category: '변동비', item: null }],
    memoMap: [{ memo: '길동 IRP', direction: 'out', category: '저축', item: 'IRP(길동)' }],
  });
  const byMemo = classifier.classify({ description: '홍길동', memo: ' 길동  IRP ', txn_type: '출금', amount: -300000 });
  assert.deepEqual([byMemo.category, byMemo.item, byMemo.source, byMemo.basis], ['저축', 'IRP(길동)', 'merchant_map', 'memo']);
  // 반대 방향(입금)에는 메모 매핑이 없다 -> 적요 매핑도 out 뿐 -> 규칙(IRP, sign 없음) -> 저축.
  const refund = classifier.classify({ description: '홍길동', memo: '길동 IRP', txn_type: '입금', amount: 300000 });
  assert.deepEqual([refund.category, refund.source], ['저축', 'category_rules']);
  // 메모가 다르면 적요 매핑.
  const other = classifier.classify({ description: '홍길동', memo: '저녁', txn_type: '출금', amount: -30000 });
  assert.deepEqual([other.category, other.source, other.basis], ['변동비', 'merchant_map', undefined]);
});

test('ReDoS · 작업량: 메모도 적요와 같은 상한(MAX_SUBJECT_LENGTH)까지만 규칙에 넣는다', () => {
  const classifier = createClassifier({ rules: [{ id: 1, pattern: 'IRP', category: '저축' }] });
  const within = `${'가'.repeat(MAX_SUBJECT_LENGTH - 3)}IRP`;
  const beyond = `${'가'.repeat(MAX_SUBJECT_LENGTH)}IRP`;
  assert.equal(classifier.classify({ description: '홍길동', memo: within, amount: -1 }).category, '저축');
  // 상한 뒤의 글자는 보지 않는다(잘린다).
  assert.equal(classifier.classify({ description: '홍길동', memo: beyond, amount: -1 }).category, null);
  // 아주 긴 메모도 금방 끝난다(규칙 정규식은 pattern.mjs 가 구조적으로 ReDoS 를 막는다).
  const started = Date.now();
  classifier.classify({ description: '홍길동', memo: 'a'.repeat(1_000_000), amount: -1 });
  assert.ok(Date.now() - started < 1000);
});

// ── /classify 묶음 · 요청 ─────────────────────────────────────────────────

const ACCOUNTS = [
  { id: 1, role: 'main', nickname: '메인' },
  { id: 2, role: 'fixed', nickname: '고정비' },
  { id: 3, role: 'emergency', nickname: '비상금' },
];

test('묶음: 같은 적요라도 메모가 다르면 다른 묶음이고, 메모가 빈 행끼리는 한 묶음이다', () => {
  const rows = [
    { id: '1', account_id: 1, description: '홍길동', memo: '길동 IRP', amount: '-300000', category: null },
    { id: '2', account_id: 1, description: '홍길동', memo: '철수 연금저축', amount: '-500000', category: null },
    { id: '3', account_id: 1, description: '홍길동', memo: null, amount: '-10000', category: null },
    { id: '4', account_id: 1, description: '홍길동', memo: '', amount: '-20000', category: null },
    { id: '5', account_id: 1, description: '홍길동', memo: ' 길동   IRP ', amount: '-300000', category: null },
  ];
  const groups = groupRows(rows, 'all', ACCOUNTS);
  assert.deepEqual(
    groups.map((group) => [group.key, group.memo, group.count, group.total]),
    [
      ['홍길동', null, 2, -30000],
      ['홍길동', '길동 IRP', 2, -600000],
      ['홍길동', '철수 연금저축', 1, -500000],
    ].sort((a, b) => Math.abs(b[3]) - Math.abs(a[3])),
  );
});

const VALID = { scope: 'always', month: '2026-07', account: 'main', key: '홍길동', direction: 'out', category: '저축' };

test('요청: 메모는 정규화하고, 메모 기준은 앞으로도 · 메모 있는 묶음에서만, 옵션과 함께 못 쓴다', () => {
  assert.deepEqual(
    [parseClassifyRequest({ ...VALID, memo: '  길동  IRP ' }).value.memo, parseClassifyRequest(VALID).value.basis],
    ['길동 IRP', 'description'],
  );
  assert.equal(parseClassifyRequest({ ...VALID, memo: '   ' }).value.memo, null);
  assert.equal(parseClassifyRequest({ ...VALID, memo: 42 }).error, 'badMemo');
  assert.equal(parseClassifyRequest({ ...VALID, memo: '가'.repeat(257) }).error, 'badMemo');
  assert.equal(parseClassifyRequest({ ...VALID, basis: 'amount' }).error, 'badBasis');
  assert.equal(parseClassifyRequest({ ...VALID, basis: 'memo' }).error, 'noMemo');
  assert.equal(parseClassifyRequest({ ...VALID, scope: 'once', memo: '길동 IRP', basis: 'memo' }).error, 'badScope');
  assert.equal(parseClassifyRequest({ ...VALID, memo: '길동 IRP', basis: 'memo', stripMonth: true }).error, 'memoWithOption');
  assert.equal(parseClassifyRequest({ ...VALID, memo: '길동 IRP', basis: 'memo', pattern: '홍##' }).error, 'memoWithOption');
  assert.equal(parseClassifyRequest({ ...VALID, memo: '길동 IRP', basis: 'memo' }).value.basis, 'memo');

  assert.equal(parseMemoMappingRequest({ action: 'delete', memo: '길동 IRP', direction: 'any' }).error, 'badDirection');
  assert.equal(parseMemoMappingRequest({ action: 'delete', memo: '', direction: 'out' }).error, 'badMemo');
});

test('HTTP: 메모 매핑 수정 · 다시 분류도 인증 · 명단 · Origin 을 DB 전에 보고, 메모를 되비추지 않는다', async () => {
  const calls = { withClient: 0 };
  const deps = (session) => ({
    auth: async () => session,
    isAllowedEmail: (email) => email === 'owner@example.test',
    withClient: async () => {
      calls.withClient += 1;
      throw new Error('여기까지 오면 안 된다');
    },
  });
  const request = (url, body, headers = {}) =>
    new Request(`http://localhost:3000${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', ...headers },
      body: JSON.stringify(body),
    });
  const owner = { user: { email: 'owner@example.test' } };
  assert.equal((await handleReclassifyPost(request('/api/classify/reclassify', {}), deps(null))).status, 401);
  assert.equal(
    (await handleReclassifyPost(request('/api/classify/reclassify', {}), deps({ user: { email: 'x@example.test' } }))).status,
    403,
  );
  assert.equal(
    (await handleReclassifyPost(request('/api/classify/reclassify', {}, { origin: 'https://evil.example' }), deps(owner))).status,
    403,
  );
  const bad = await handleMappingPost(
    request('/api/classify/mappings', { basis: 'memo', action: 'delete', memo: '비밀메모', direction: 'any' }),
    deps(owner),
  );
  assert.equal(bad.status, 400);
  assert.ok(!(await bad.text()).includes('비밀메모'));
  assert.equal(calls.withClient, 0);
});

// ── 현금흐름표 항목 줄의 메모 ─────────────────────────────────────────────

test('항목 줄: 서로 다른 메모를 자주 나온 순으로 최대 LINE_MEMO_LIMIT 개, 전체 개수는 memoCount', () => {
  const row = (id, memo) => ({
    id: String(id),
    account_id: 1,
    txn_at: `2026-07-${String(id).padStart(2, '0')}T09:00:00+09:00`,
    description: '홍길동',
    txn_type: '출금',
    amount: '-1000',
    balance: null,
    memo,
    category: '변동비',
    category_source: 'manual',
    item: '경조사',
    is_transfer: false,
  });
  const memos = ['결혼식', '결혼식', '돌잔치', null, '', '장례식', '집들이', '집들이', '집들이'];
  const report = aggregateMonthly({ yearMonth: '2026-07', accounts: ACCOUNTS, rows: memos.map((memo, i) => row(i + 1, memo)) });
  const [line] = report.항목별.변동비;
  assert.equal(LINE_MEMO_LIMIT, 3);
  assert.deepEqual([line.item, line.count, line.memos, line.memoCount], ['경조사', 9, ['집들이', '결혼식', '돌잔치'], 4]);

  // 항목 이름과 같은 메모는 목록에서도 개수에서도 빠진다(메모로 분류된 줄).
  const named = aggregateMonthly({
    yearMonth: '2026-07',
    accounts: ACCOUNTS,
    rows: ['집들이', '집들이', '결혼식', '돌잔치', '장례식', '생일'].map((memo, i) => ({ ...row(i + 1, memo), item: '집들이' })),
  }).항목별.변동비[0];
  assert.deepEqual([named.memos, named.memoCount], [['결혼식', '돌잔치', '생일'], 4]);
});

// ── 실제 DB ───────────────────────────────────────────────────────────────

function record(n, overrides = {}) {
  const month = overrides.year_month ?? '2026-07';
  return {
    account_id: 1,
    txn_at: `${month}-${String(1 + (n % 27)).padStart(2, '0')}T09:00:00+09:00`,
    description: '홍길동',
    txn_type: '모임원송금',
    institution: null,
    cp_acct_hash: null,
    amount: -300000,
    balance: null,
    memo: null,
    category: null,
    category_source: null,
    item: null,
    is_transfer: false,
    dedupe_key: `test-memo-${n}`,
    year_month: month,
    ...overrides,
  };
}

async function rows(client) {
  const result = await client.query(
    `SELECT year_month, description, memo, amount, category, item, category_source
       FROM transactions ORDER BY dedupe_key`,
  );
  return result.rows.map((r) => [r.year_month, r.description, r.memo, Number(r.amount), r.category, r.item, r.category_source]);
}

test('실제 DB: 다시 분류 버튼은 미분류 행만 메모까지 보고 채우고, 분류된 행은 건드리지 않는다', async (t) => {
  await withScratchDatabase(t, 'memo_reclassify', async (client) => {
    await insertTransactions(client, [
      record(1, { memo: '길동 IRP' }), // 7월, 예전 업로드 — 미분류로 남아 있던 행
      record(2, { memo: '철수 연금저축', amount: -500000 }),
      record(3, { memo: '저녁값', amount: -30000 }), // 규칙 없음 — 미분류 그대로
      record(4, { memo: '길동 IRP', category: '변동비', category_source: 'manual' }), // 사람이 고른 행
      record(5, { memo: '길동 IRP', txn_type: '자동이체', category: '고정비', category_source: 'rule' }), // 규칙이 채운 행
    ]);
    assert.deepEqual(await reclassifyUnclassified(client), { ok: true, scanned: 3, classified: 2 });
    assert.deepEqual(await rows(client), [
      // 메모로 걸린 행은 메모가 항목 이름이다.
      ['2026-07', '홍길동', '길동 IRP', -300000, '저축', '길동 IRP', 'rule'],
      ['2026-07', '홍길동', '철수 연금저축', -500000, '저축', '철수 연금저축', 'rule'],
      ['2026-07', '홍길동', '저녁값', -30000, null, null, null],
      ['2026-07', '홍길동', '길동 IRP', -300000, '변동비', null, 'manual'],
      ['2026-07', '홍길동', '길동 IRP', -300000, '고정비', null, 'rule'],
    ]);
    // 멱등.
    assert.deepEqual(await reclassifyUnclassified(client), { ok: true, scanned: 1, classified: 0 });

    // memo_map 의 CHECK: 빈 메모 · any 방향 · 257자 메모 · 41자 항목은 들어가지 않는다.
    for (const [memo, direction, item] of [
      ['  ', 'out', null],
      ['길동 IRP', 'any', null],
      ['가'.repeat(257), 'out', null],
      ['길동 IRP', 'out', '가'.repeat(41)],
    ]) {
      await assert.rejects(() =>
        client.query('INSERT INTO memo_map (memo, direction, category, item) VALUES ($1, $2, $3, $4)', [memo, direction, '저축', item]),
      );
    }
  });
});

test('실제 DB: 메모 기준 앞으로도 · 이번만 · 적요 기준 앞으로도가 서로를 덮지 않는다', async (t) => {
  await withScratchDatabase(t, 'memo_mapping', async (client) => {
    await insertTransactions(client, [
      record(1, { memo: '길동 IRP' }),
      record(2, { memo: '철수 연금저축', amount: -500000 }),
      record(3, { memo: null, amount: -10000 }),
      record(4, { year_month: '2026-08', memo: '길동 IRP', description: '길동' }), // 다른 달 · 다른 적요, 같은 메모
      record(5, { year_month: '2026-08', memo: '길동 IRP', amount: 300000 }), // 반대 방향
      record(6, { year_month: '2026-06', memo: '길동 IRP', category: '변동비', category_source: 'manual' }),
    ]);
    const base = { ...VALID, month: '2026-07', key: '홍길동', category: '저축', item: 'IRP' };

    // 이번만은 그 묶음(적요 + 메모)만.
    assert.deepEqual(await applyClassification(client, { ...base, scope: 'once', memo: '철수 연금저축', item: null }), {
      ok: true,
      updated: 1,
      mapped: false,
    });

    // 메모 기준 앞으로도: 같은 메모 · 같은 방향이면 다른 달 · 다른 적요도 따라간다(manual 은 그대로).
    assert.deepEqual(await applyClassification(client, { ...base, memo: '길동 IRP', basis: 'memo' }), {
      ok: true,
      updated: 2,
      mapped: true,
    });
    assert.deepEqual(
      (await listMemoMappings(client)).map((m) => [m.memo, m.direction, m.category, m.item]),
      [['길동 IRP', 'out', '저축', 'IRP']],
    );

    // 적요 기준 앞으로도(홍길동 · 출금 -> 변동비): 메모 매핑이 걸린 행은 따라가지 않는다.
    assert.deepEqual(
      await applyClassification(client, { ...base, memo: null, category: '변동비', item: null }),
      { ok: true, updated: 1, mapped: true },
    );
    // 이미 '이번만' 으로 고른 `철수 연금저축` 행은 manual 이라 따라가지 않는다.
    assert.deepEqual(await rows(client), [
      ['2026-07', '홍길동', '길동 IRP', -300000, '저축', 'IRP', 'map'],
      ['2026-07', '홍길동', '철수 연금저축', -500000, '저축', null, 'manual'],
      ['2026-07', '홍길동', null, -10000, '변동비', null, 'map'],
      ['2026-08', '길동', '길동 IRP', -300000, '저축', 'IRP', 'map'],
      ['2026-08', '홍길동', '길동 IRP', 300000, null, null, null],
      ['2026-06', '홍길동', '길동 IRP', -300000, '변동비', null, 'manual'],
    ]);
    // 적요 매핑 수정도 메모 매핑 행을 건드리지 않는다.
    assert.deepEqual(await updateMapping(client, { key: '홍길동', direction: 'out', category: '용돈', item: null }), {
      ok: true,
      updated: 1,
    });

    // 메모 매핑 수정 -> 같은 메모 · 방향의 manual 이 아닌 행.
    assert.deepEqual(await updateMemoMapping(client, { memo: '길동 IRP', direction: 'out', category: '저축', item: 'IRP 길동' }), {
      ok: true,
      updated: 2,
    });
    assert.equal((await updateMemoMapping(client, { memo: '없는 메모', direction: 'out', category: '저축' })).error, 'mappingNotFound');

    // 메모 매핑 삭제 -> 분류기로 다시: 홍길동(출금) 행은 적요 매핑(용돈), 길동 행은 규칙(IRP -> 저축).
    assert.deepEqual(await deleteMemoMapping(client, { memo: '길동 IRP', direction: 'out' }), {
      ok: true,
      reclassified: 2,
      unclassified: 0,
    });
    const after = await rows(client);
    assert.deepEqual(after[0].slice(4), ['용돈', null, 'map']);
    assert.deepEqual(after[3].slice(4), ['저축', '길동 IRP', 'rule']);
    assert.deepEqual(after[5].slice(4), ['변동비', null, 'manual']);
    assert.deepEqual(await listMemoMappings(client), []);

    // 메모 없는 묶음으로 메모 기준을 보내면 거부 · 그 달에 없는 메모면 keyNotFound.
    assert.equal((await applyClassification(client, { ...base, memo: '다른 메모', basis: 'memo' })).error, 'keyNotFound');
  });
});
