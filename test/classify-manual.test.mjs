// /classify 의 쓰기(이번만 · 앞으로도 · 매핑 수정 · 삭제)와 요청 검사.
//
// 두 층이다.
//   1. 요청 검사 · 묶기 — 순수 함수. 항상 돈다.
//   2. 실제 왕복 — 스크래치 DB 에 새 마이그레이션까지 scripts/migrate.mjs 로
//      적용하고 fixture 를 올린 뒤 쓰기를 해 본다. `TEST_DATABASE_URL` 이 있을
//      때만 돈다(로컬 호스트만 허용).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CLASSIFY_ERROR_MESSAGES,
  CLASSIFY_FILTERS,
  applyClassification,
  countUnclassified,
  deleteMapping,
  groupKeyOf,
  groupRows,
  listClassifyGroups,
  listMappings,
  parseClassifyRequest,
  parseMappingRequest,
  updateMapping,
} from '../lib/classify/manual.mjs';
import { CLASSIFY_CATEGORIES, buildMonthlyReport } from '../lib/report/monthly.mjs';
import { verifyMonthlyReport } from '../lib/report/verify.mjs';
import { importStatementBuffer } from '../lib/import/statement.mjs';
import { insertTransactions } from '../lib/db/transactions.mjs';
import { classifyStored, loadClassifier } from '../lib/classify/store.mjs';
import { classifyRecords } from '../lib/classify/engine.mjs';
import { toTransactionRecords } from '../lib/toss/normalize.mjs';
import { parseTossStatement } from '../lib/toss/statement.mjs';
import { openXlsxFile } from '../lib/xlsx/workbook.mjs';
import { SCRATCH_ACCOUNTS, runMigrations, withScratchDatabase } from './helpers/scratch-db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'toss-sample-masked.xlsx');

function valid(overrides = {}) {
  return {
    scope: 'once',
    month: '2026-08',
    key: '코웨이08월렌탈',
    direction: 'out',
    category: '고정비',
    item: '정수기',
    ...overrides,
  };
}

// ── 요청 검사 ─────────────────────────────────────────────────────────────

test('올바른 요청은 정규화된 키 · 항목으로 통과한다', () => {
  const parsed = parseClassifyRequest(valid({ key: '  코웨이08월렌탈 ', item: ' 정수기  렌탈 ' }));
  assert.deepEqual(parsed, {
    ok: true,
    value: {
      scope: 'once',
      month: '2026-08',
      key: '코웨이08월렌탈',
      direction: 'out',
      category: '고정비',
      item: '정수기 렌탈',
      stripMonth: false,
    },
  });
});

test('stripMonth 는 boolean 만 받는다 — 생략하면 false, boolean 이 아니면 거부한다', () => {
  assert.equal(parseClassifyRequest(valid()).value.stripMonth, false);
  assert.equal(parseClassifyRequest(valid({ stripMonth: true })).value.stripMonth, true);
  assert.equal(parseClassifyRequest(valid({ stripMonth: false })).value.stripMonth, false);
  for (const bad of ['true', 1, 0, null, {}, []]) {
    const parsed = parseClassifyRequest(valid({ stripMonth: bad }));
    assert.equal(parsed.ok, false, String(bad));
    assert.equal(parsed.error, 'badRequest');
  }
});

test('허용 목록 밖의 분류는 거부한다', () => {
  // '기타' 는 이제 허용 목록에 있다(아래 루프가 통과를 확인한다). '미분류' 는 여전히 아니다.
  for (const category of ['손수정', '', ' 고정비', '미분류', ' 기타', '기타 ', null, 1, ['고정비']]) {
    const parsed = parseClassifyRequest(valid({ category }));
    assert.equal(parsed.ok, false, String(category));
    assert.equal(parsed.error, 'badCategory');
  }
  for (const category of CLASSIFY_CATEGORIES) {
    assert.equal(parseClassifyRequest(valid({ category })).ok, true, category);
  }
});

test('월 형식이 틀리면 거부하고 받은 값을 되비추지 않는다', () => {
  for (const month of ['2026-8', '2026/08', "2026-08' OR 1=1", '', null, 202608]) {
    const parsed = parseClassifyRequest(valid({ month }));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, 'badMonth');
    assert.ok(!parsed.message.includes('OR 1=1'));
  }
});

test('제어 문자 · 40자 초과 항목은 거부한다', () => {
  const control = parseClassifyRequest(valid({ item: '정수기\u0007' }));
  assert.equal(control.ok, false);
  assert.equal(control.error, 'itemControlChars');

  const long = parseClassifyRequest(valid({ item: '가'.repeat(41) }));
  assert.equal(long.ok, false);
  assert.equal(long.error, 'itemTooLong');
  assert.equal(long.message, CLASSIFY_ERROR_MESSAGES.itemTooLong);
});

test('범위 · 키 · 본문 모양이 틀리면 거부한다', () => {
  assert.equal(parseClassifyRequest(valid({ scope: 'forever' })).error, 'badScope');
  assert.equal(parseClassifyRequest(valid({ scope: undefined })).error, 'badScope');
  assert.equal(parseClassifyRequest(valid({ key: '' })).error, 'badKey');
  assert.equal(parseClassifyRequest(valid({ key: '   ' })).error, 'badKey');
  assert.equal(parseClassifyRequest(valid({ key: 42 })).error, 'badKey');
  assert.equal(parseClassifyRequest(valid({ key: '가'.repeat(257) })).error, 'badKey');
  assert.equal(parseClassifyRequest(null).error, 'badRequest');
  assert.equal(parseClassifyRequest([]).error, 'badRequest');
});

test('매핑 요청: 수정은 분류 · 항목을, 삭제는 키 · 방향만 본다', () => {
  assert.deepEqual(parseMappingRequest({ action: 'delete', key: ' 코인적립 ', direction: 'out' }), {
    ok: true,
    value: { action: 'delete', key: '코인적립', direction: 'out' },
  });
  assert.equal(
    parseMappingRequest({ action: 'update', key: '코인적립', direction: 'out', category: '손수정' }).error,
    'badCategory',
  );
  assert.equal(parseMappingRequest({ action: 'drop', key: '코인적립', direction: 'out' }).error, 'badRequest');
  assert.equal(
    parseMappingRequest({ action: 'update', key: '코인적립', direction: 'out', category: '저축', item: 'a\nb' }).error,
    'itemControlChars',
  );
  // 저장된 매핑을 가리키는 값이라 any 도 받는다(수정 · 삭제는 새 매핑을 만들지 않는다).
  assert.equal(parseMappingRequest({ action: 'delete', key: '코인적립', direction: 'any' }).ok, true);
  for (const direction of [undefined, null, '', 'both', 'OUT', 1]) {
    const parsed = parseMappingRequest({ action: 'delete', key: '코인적립', direction });
    assert.equal(parsed.error, 'badDirection', String(direction));
  }
});

test('묶음 쓰기의 방향은 in · out 뿐이다 — any 는 화면에서 만들 수 없다', () => {
  assert.equal(parseClassifyRequest(valid({ direction: 'in' })).ok, true);
  for (const direction of ['any', undefined, null, '', 'both', 'IN', "out' OR 1=1", 0, ['in']]) {
    const parsed = parseClassifyRequest(valid({ direction }));
    assert.equal(parsed.ok, false, String(direction));
    assert.equal(parsed.error, 'badDirection');
    assert.equal(parsed.message, CLASSIFY_ERROR_MESSAGES.badDirection);
    assert.ok(!parsed.message.includes('OR 1=1'));
  }
});

test('검사를 통과하지 못하면 DB 에 아무것도 보내지 않는다', async () => {
  const client = {
    async query() {
      throw new Error('쿼리가 나가면 안 된다');
    },
  };
  for (const bad of [valid({ category: '손수정' }), valid({ month: 'x' }), valid({ item: '가'.repeat(41) })]) {
    const outcome = await applyClassification(client, bad);
    assert.equal(outcome.ok, false);
  }
  assert.equal((await updateMapping(client, { key: 'x', direction: 'out', category: '손수정' })).ok, false);
  assert.equal((await deleteMapping(client, { key: '', direction: 'out' })).ok, false);
  assert.equal((await deleteMapping(client, { key: 'x', direction: 'both' })).ok, false);
  assert.equal((await applyClassification(client, valid({ direction: 'any' }))).ok, false);
});

// ── 묶기 ───────────────────────────────────────────────────────────────────

test('입금과 출금이 섞인 적요는 방향별로 두 묶음이 되고 합계를 상쇄하지 않는다', () => {
  const rows = [
    { description: '김철수', amount: '34000', category: null },
    { description: '김철수', amount: '3500000', category: null },
    { description: '김철수 ', amount: '1000000', category: null },
    { description: '김철수', amount: '-170000', category: null },
  ];
  const groups = groupRows(rows, CLASSIFY_FILTERS.unclassified);
  assert.deepEqual(
    groups.map((group) => [group.key, group.direction, group.count, group.total, group.unclassified]),
    [
      ['김철수', 'in', 3, 4534000, 3],
      ['김철수', 'out', 1, -170000, 1],
    ],
  );
  // 한쪽만 분류돼도 다른 쪽 묶음의 상태는 따로 센다.
  const mixed = groupRows(
    rows.map((row) => (Number(row.amount) < 0 ? { ...row, category: '용돈', category_source: 'map' } : row)),
    CLASSIFY_FILTERS.all,
  );
  const outGroup = mixed.find((group) => group.direction === 'out');
  const inGroup = mixed.find((group) => group.direction === 'in');
  assert.deepEqual([outGroup.category, outGroup.mixed, outGroup.unclassified], ['용돈', false, 0]);
  assert.deepEqual([inGroup.category, inGroup.mixed, inGroup.unclassified], [null, false, 3]);
  // 미분류만 보기에서는 입금 묶음만 남는다.
  const outClassified = rows.map((row) => (Number(row.amount) < 0 ? { ...row, category: '용돈' } : row));
  assert.deepEqual(
    groupRows(outClassified, CLASSIFY_FILTERS.unclassified).map((group) => group.direction),
    ['in'],
  );
});

test('정규화한 적요로 묶고 혼합 여부 · 미분류 건수를 센다', () => {
  const rows = [
    { description: '이영희', amount: '-7500', category: null, category_source: null },
    { description: ' 이영희 ', amount: '-2500', category: '변동비', category_source: 'manual', item: '모임' },
    { description: '코인적립', amount: '-200000', category: '저축', category_source: null },
    { description: '김철수', amount: '34000', category: null },
  ];
  const unclassified = groupRows(rows, CLASSIFY_FILTERS.unclassified);
  assert.deepEqual(
    unclassified.map((group) => [group.key, group.count, group.total, group.unclassified, group.mixed, group.manual]),
    [
      ['김철수', 1, 34000, 1, false, 0],
      ['이영희', 2, -10000, 1, true, 1],
    ],
  );
  const all = groupRows(rows, CLASSIFY_FILTERS.all);
  const coin = all.find((group) => group.key === '코인적립');
  assert.deepEqual(
    [coin.category, coin.item, coin.source, coin.mixed],
    ['저축', '코인적립', 'rule', false],
  );
  assert.equal(groupKeyOf('  대출   이자 '), '대출 이자');
});

// ── 실제 왕복 ──────────────────────────────────────────────────────────────

/** 다른 달(2026-09)의 행 하나. dedupe_key 는 테스트 전용 고정값. */
function extraRecord(n, overrides = {}) {
  return {
    account_id: 1,
    txn_at: `2026-09-${String(n).padStart(2, '0')}T09:00:00+09:00`,
    description: '이영희',
    txn_type: '모임원송금',
    institution: null,
    cp_acct_hash: null,
    amount: -1000 * n,
    balance: null,
    memo: null,
    category: null,
    category_source: null,
    item: null,
    is_transfer: false,
    dedupe_key: `test-extra-${n}`,
    year_month: '2026-09',
    ...overrides,
  };
}

async function importFixture(client) {
  const result = await importStatementBuffer(readFileSync(FIXTURE), {
    client,
    accounts: SCRATCH_ACCOUNTS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.inserted, 24);
}

async function rowsOf(client, description) {
  const result = await client.query(
    `SELECT year_month, category, item, category_source
       FROM transactions WHERE description = $1 ORDER BY year_month, id`,
    [description],
  );
  return result.rows.map((row) => [row.year_month, row.category, row.item, row.category_source]);
}

test('새 마이그레이션이 러너로 깨끗하게 적용되고 CHECK 가 선다', async (t) => {
  await withScratchDatabase(t, 'classify_migration', async (client, url) => {
    // 두 번째 실행은 아무것도 하지 않는다(체크섬이 같다).
    await runMigrations(url);

    const columns = await client.query(
      `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns
        WHERE (table_name, column_name) IN (('transactions','item'), ('transactions','category_source'), ('merchant_map','item'))
        ORDER BY 1, 2`,
    );
    assert.deepEqual(
      columns.rows.map((row) => [row.table_name, row.column_name, row.is_nullable]),
      [
        ['merchant_map', 'item', 'YES'],
        ['transactions', 'category_source', 'YES'],
        ['transactions', 'item', 'YES'],
      ],
    );

    await importFixture(client);
    // 업로드가 규칙으로 분류한 행은 출처가 'rule' 이다. 미분류는 NULL.
    const sources = await client.query(
      `SELECT coalesce(category_source, '(null)') AS s, count(*)::int AS n
         FROM transactions GROUP BY 1 ORDER BY 1`,
    );
    assert.deepEqual(sources.rows.map((row) => [row.s, row.n]), [['(null)', 8], ['rule', 16]]);

    await assert.rejects(() => client.query(`UPDATE transactions SET category_source = 'bogus'`));
    await assert.rejects(() => client.query(`UPDATE transactions SET item = repeat('가', 41)`));
    await assert.rejects(() => client.query(`UPDATE transactions SET item = '   '`));
    await assert.rejects(() =>
      client.query(`INSERT INTO merchant_map (description, category, item) VALUES ('x', '저축', '')`),
    );
    // NULL 은 된다(마이그레이션이 데이터를 채우지 않는다).
    await client.query(`UPDATE transactions SET category_source = NULL, item = NULL WHERE false`);
  });
});

test('이번만: 그 달 그 묶음만 manual 로 바꾸고 매핑은 만들지 않는다', async (t) => {
  await withScratchDatabase(t, 'classify_once', async (client) => {
    await importFixture(client);
    await insertTransactions(client, [extraRecord(1, { description: '코웨이08월렌탈', txn_type: 'CMS출금' })]);

    const outcome = await applyClassification(client, valid());
    assert.deepEqual(outcome, { ok: true, updated: 1, mapped: false });

    assert.deepEqual(await rowsOf(client, '코웨이08월렌탈'), [
      ['2026-08', '고정비', '정수기', 'manual'],
      ['2026-09', null, null, null], // 다른 달은 그대로
    ]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM merchant_map')).rows[0].n, 0);

    // 규칙 재실행이 manual 을 덮지 않는다(category IS NULL 가드).
    await classifyStored(client);
    assert.deepEqual((await rowsOf(client, '코웨이08월렌탈'))[0], ['2026-08', '고정비', '정수기', 'manual']);

    // 리포트에 항목 줄로 나오고 검산은 그대로다.
    const report = await buildMonthlyReport(client, '2026-08');
    assert.deepEqual(
      report.항목별.고정지출2.find((line) => line.item === '정수기'),
      { category: '고정비', item: '정수기', direction: 'out', total: -3780, count: 1 },
    );
    assert.equal(report.미분류.count, 7);
    assert.equal(verifyMonthlyReport(report).ok, true);

    // 그룹 목록: 미분류만 보기에서 빠지고, 전체 보기에서는 manual 로 보인다.
    const unclassified = await listClassifyGroups(client, '2026-08', CLASSIFY_FILTERS.unclassified);
    assert.ok(!unclassified.some((group) => group.key === '코웨이08월렌탈'));
    const all = await listClassifyGroups(client, '2026-08', CLASSIFY_FILTERS.all);
    const group = all.find((entry) => entry.key === '코웨이08월렌탈');
    assert.deepEqual([group.category, group.item, group.source], ['고정비', '정수기', 'manual']);
  });
});

test('앞으로도: 매핑을 upsert 하고 같은 키의 행을 바꾸되 다른 달의 manual 은 건드리지 않는다', async (t) => {
  await withScratchDatabase(t, 'classify_always', async (client) => {
    await importFixture(client);
    await insertTransactions(client, [
      extraRecord(1), // NULL
      extraRecord(2, { category: '변동비', category_source: 'manual', item: '모임' }),
      extraRecord(3, { category: '고정비', category_source: 'rule' }),
      extraRecord(4, { category: '고정비', category_source: null }), // 옛 행
    ]);

    const outcome = await applyClassification(
      client,
      valid({ scope: 'always', key: '이영희', category: '용돈', item: '영희 용돈' }),
    );
    assert.deepEqual(outcome, { ok: true, updated: 4, mapped: true });

    const map = await client.query('SELECT description, category, item FROM merchant_map');
    assert.deepEqual(map.rows, [{ description: '이영희', category: '용돈', item: '영희 용돈' }]);

    assert.deepEqual(await rowsOf(client, '이영희'), [
      ['2026-08', '용돈', '영희 용돈', 'map'],
      ['2026-09', '용돈', '영희 용돈', 'map'],
      ['2026-09', '변동비', '모임', 'manual'], // 그대로
      ['2026-09', '용돈', '영희 용돈', 'map'],
      ['2026-09', '용돈', '영희 용돈', 'map'],
    ]);

    // 같은 키로 다시 고르면 upsert — 행이 하나로 남고 값만 바뀐다.
    await applyClassification(client, valid({ scope: 'always', key: '이영희', category: '변동비', item: '' }));
    const again = await client.query('SELECT category, item FROM merchant_map');
    assert.deepEqual(again.rows, [{ category: '변동비', item: null }]);
    assert.deepEqual((await rowsOf(client, '이영희'))[2], ['2026-09', '변동비', '모임', 'manual']);

    // 앞으로 올릴 거래는 규칙보다 매핑을 먼저 본다(분류기가 DB 매핑을 읽는다).
    const records = toTransactionRecords(parseTossStatement(openXlsxFile(FIXTURE).sheet(0)), SCRATCH_ACCOUNTS);
    classifyRecords(records, await loadClassifier(client));
    const future = records.find((record) => record.description === '이영희');
    assert.deepEqual([future.category, future.category_source, future.item], ['변동비', 'map', null]);

    const mappings = await listMappings(client);
    assert.deepEqual(
      mappings.map(({ key, category, item }) => [key, category, item]),
      [['이영희', '변동비', null]],
    );
    assert.match(mappings[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('앞으로도로 만든 매핑은 다음 업로드에 분류와 항목을 함께 붙인다', async (t) => {
  await withScratchDatabase(t, 'classify_import_map', async (client) => {
    await importFixture(client);
    await applyClassification(
      client,
      valid({ scope: 'always', key: '코웨이08월렌탈', category: '고정비', item: '정수기' }),
    );
    // 같은 달을 지우고 다시 올린다 — 이번에는 업로드 경로가 매핑을 쓴다.
    await client.query('DELETE FROM transactions');
    await importFixture(client);
    assert.deepEqual(await rowsOf(client, '코웨이08월렌탈'), [['2026-08', '고정비', '정수기', 'map']]);
  });
});

// ── 월마다 바뀌는 적요(2026-09) ───────────────────────────────────────────
//
// 사용자 문제: "코웨이08월렌탈의 경우 월별로 코웨이09월렌탈, 코웨이10월렌탈
// 바뀌게 되는 고정비야." fixture 의 2026-08 행이 정확히 '코웨이08월렌탈' 이다
// (test/classify-engine.test.mjs 의 fixture 주석 참고).

test('체크박스 켠 앞으로도: 월 토큰을 지운 키로 매핑을 저장하고, 원문이 다른 다음 달 행도 재분류 한 번으로 자동 분류된다', async (t) => {
  await withScratchDatabase(t, 'classify_stripmonth', async (client) => {
    await importFixture(client);
    // 다음 달(2026-09)의 같은 고정비. 적요 원문이 다르다(09월) — import 시점에는
    // 아직 이 매핑이 없으니 미분류로 저장된다.
    await insertTransactions(client, [
      extraRecord(1, { description: '코웨이09월렌탈', txn_type: 'CMS출금', amount: -3780 }),
    ]);
    assert.deepEqual(await rowsOf(client, '코웨이09월렌탈'), [['2026-09', null, null, null]]);

    // 화면에서 "월마다 문구가 바뀌는 항목이에요" 체크박스를 켜고 앞으로도 저장.
    const outcome = await applyClassification(
      client,
      valid({ scope: 'always', key: '코웨이08월렌탈', category: '고정비', item: '정수기', stripMonth: true }),
    );
    assert.deepEqual(outcome, { ok: true, updated: 1, mapped: true });

    // 매핑의 키는 원문(코웨이08월렌탈)이 아니라 지운 키(코웨이렌탈)다.
    assert.deepEqual(await mapRows(client), [['코웨이렌탈', 'out', '고정비', '정수기']]);

    // 이 달(2026-08)의 그 묶음은 바로 반영된다.
    assert.deepEqual(await rowsOf(client, '코웨이08월렌탈'), [['2026-08', '고정비', '정수기', 'map']]);

    // 09월 행은 원문이 달라 이 UPDATE 로는 안 닿는다 — 아직 미분류다.
    assert.deepEqual(await rowsOf(client, '코웨이09월렌탈'), [['2026-09', null, null, null]]);

    // 재분류(classifyStored) 한 번으로, 사람 손을 더 대지 않고 09월 행이 잡힌다.
    const result = await classifyStored(client);
    assert.equal(result.classified, 1);
    assert.deepEqual(await rowsOf(client, '코웨이09월렌탈'), [['2026-09', '고정비', '정수기', 'map']]);

    // 다음 업로드(파싱 -> classifyRecords)도 같은 분류기를 타므로 10월 적요도
    // 사람이 다시 고를 필요 없이 바로 분류된다.
    const classifier = await loadClassifier(client);
    const future = classifier.classify({ description: '코웨이10월렌탈', txn_type: 'CMS출금', amount: -3780 });
    assert.deepEqual([future.category, future.source, future.item], ['고정비', 'merchant_map', '정수기']);

    // /report 에는 지운 키가 아니라 사람이 고른 항목 이름이 그대로 나온다(양쪽 달).
    const augReport = await buildMonthlyReport(client, '2026-08');
    assert.deepEqual(
      augReport.항목별.고정지출2.find((line) => line.item === '정수기'),
      { category: '고정비', item: '정수기', direction: 'out', total: -3780, count: 1 },
    );
    const sepReport = await buildMonthlyReport(client, '2026-09');
    assert.deepEqual(
      sepReport.항목별.고정지출2.find((line) => line.item === '정수기'),
      { category: '고정비', item: '정수기', direction: 'out', total: -3780, count: 1 },
    );
    assert.equal(verifyMonthlyReport(augReport).ok, true);
    // 9월 행은 이 테스트가 잔액 없이 끼워 넣은 것이라 검산은 스킵된다(잔액 결손).
    assert.equal(verifyMonthlyReport(sepReport).ok, null);
    assert.equal(verifyMonthlyReport(sepReport).reason, 'balanceMissing');
  });
});

test('체크박스를 켰는데 적요에 월 토큰이 없으면 거부하고 매핑을 만들지 않는다', async (t) => {
  await withScratchDatabase(t, 'classify_stripmonth_reject', async (client) => {
    await importFixture(client);
    // '이영희' 는 fixture 에 있고 월 토큰이 없는 평범한 적요다.
    const outcome = await applyClassification(
      client,
      valid({ scope: 'always', key: '이영희', direction: 'out', category: '고정비', item: '뭔가', stripMonth: true }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, 'noMonthToken');
    assert.equal(outcome.message, CLASSIFY_ERROR_MESSAGES.noMonthToken);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM merchant_map')).rows[0].n, 0);
    // 그 행도 바뀌지 않았다 — 거부는 아무것도 만들지도 바꾸지도 않는다.
    assert.deepEqual(await rowsOf(client, '이영희'), [['2026-08', null, null, null]]);
  });
});

test('체크박스를 끄면 월 토큰이 있어도 예전처럼 원문 키로 저장한다', async (t) => {
  await withScratchDatabase(t, 'classify_stripmonth_off', async (client) => {
    await importFixture(client);
    const outcome = await applyClassification(
      client,
      valid({ scope: 'always', key: '코웨이08월렌탈', category: '고정비', item: '정수기' }), // stripMonth 없음(기본 false)
    );
    assert.deepEqual(outcome, { ok: true, updated: 1, mapped: true });
    assert.deepEqual(await mapRows(client), [['코웨이08월렌탈', 'out', '고정비', '정수기']]);
  });
});

test('없는 키는 거부하고 아무것도 만들지 않는다', async (t) => {
  await withScratchDatabase(t, 'classify_missing', async (client) => {
    await importFixture(client);
    await insertTransactions(client, [extraRecord(1, { description: '9월에만 있는 적요' })]);

    for (const input of [
      valid({ scope: 'always', key: '어디에도 없는 적요' }),
      valid({ scope: 'once', key: '어디에도 없는 적요' }),
      // 다른 달에는 있지만 이 달에는 없다.
      valid({ scope: 'always', key: '9월에만 있는 적요' }),
    ]) {
      const outcome = await applyClassification(client, input);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error, 'keyNotFound');
      assert.ok(!outcome.message.includes('적요'), '키를 되비추지 않는다');
    }
    assert.equal((await client.query('SELECT count(*)::int AS n FROM merchant_map')).rows[0].n, 0);
    assert.equal(
      (await client.query(`SELECT count(*)::int AS n FROM transactions WHERE category_source = 'manual'`)).rows[0].n,
      0,
    );

    const missing = await updateMapping(client, { key: '코인적립', direction: 'out', category: '저축', item: null });
    assert.equal(missing.error, 'mappingNotFound');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM merchant_map')).rows[0].n, 0);
    assert.equal((await deleteMapping(client, { key: '코인적립', direction: 'out' })).error, 'mappingNotFound');
  });
});

test('매핑 수정: 같은 키의 manual 이 아닌 행에 반영한다', async (t) => {
  await withScratchDatabase(t, 'classify_update', async (client) => {
    await importFixture(client);
    await insertTransactions(client, [
      extraRecord(1, { description: '코인적립', txn_type: '자동이체' }),
      extraRecord(2, { description: '코인적립', txn_type: '자동이체', category: '변동비', category_source: 'manual' }),
    ]);
    await applyClassification(client, valid({ scope: 'always', key: '코인적립', category: '저축', item: '코인' }));

    const outcome = await updateMapping(client, { key: '코인적립', direction: 'out', category: '변동비', item: '코인 모으기' });
    assert.deepEqual(outcome, { ok: true, updated: 2 });
    assert.deepEqual(await rowsOf(client, '코인적립'), [
      ['2026-08', '변동비', '코인 모으기', 'map'],
      ['2026-09', '변동비', '코인 모으기', 'map'],
      ['2026-09', '변동비', null, 'manual'],
    ]);
  });
});

test('매핑 삭제: map 행만 규칙으로 다시 분류하고 manual 은 그대로 둔다', async (t) => {
  await withScratchDatabase(t, 'classify_delete', async (client) => {
    await importFixture(client);
    await insertTransactions(client, [
      extraRecord(1, { description: '코인적립', txn_type: '자동이체' }),
      extraRecord(2, { description: '코인적립', txn_type: '자동이체', category: '용돈', category_source: 'manual', item: '손' }),
      extraRecord(3), // 이영희 · 모임원송금 — 어떤 규칙에도 안 걸린다
    ]);
    await applyClassification(client, valid({ scope: 'always', key: '코인적립', category: '변동비', item: '코인' }));
    await applyClassification(client, valid({ scope: 'always', key: '이영희', category: '용돈', item: null }));
    assert.deepEqual((await rowsOf(client, '코인적립'))[0], ['2026-08', '변동비', '코인', 'map']);

    const coin = await deleteMapping(client, { key: '코인적립', direction: 'out' });
    assert.deepEqual(coin, { ok: true, reclassified: 2, unclassified: 0 });
    // 규칙(코인적립 -> 저축)으로 돌아갔다. manual 은 그대로.
    assert.deepEqual(await rowsOf(client, '코인적립'), [
      ['2026-08', '저축', null, 'rule'],
      ['2026-09', '저축', null, 'rule'],
      ['2026-09', '용돈', '손', 'manual'],
    ]);

    const person = await deleteMapping(client, { key: '이영희', direction: 'out' });
    assert.deepEqual(person, { ok: true, reclassified: 0, unclassified: 2 });
    assert.deepEqual(await rowsOf(client, '이영희'), [
      ['2026-08', null, null, null],
      ['2026-09', null, null, null],
    ]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM merchant_map')).rows[0].n, 0);

    // 되돌린 뒤에도 검산은 그대로다.
    assert.equal(verifyMonthlyReport(await buildMonthlyReport(client, '2026-08')).ok, true);
  });
});

// ── 방향(입금 · 출금) ──────────────────────────────────────────────────────

/** 적요의 행을 (달, 방향, 분류, 항목, 출처)로. 금액 순서가 아니라 id 순서다. */
async function directedRowsOf(client, description) {
  const result = await client.query(
    `SELECT year_month, amount, category, item, category_source
       FROM transactions WHERE description = $1 ORDER BY year_month, id`,
    [description],
  );
  return result.rows.map((row) => [
    row.year_month,
    Number(row.amount) > 0 ? 'in' : 'out',
    row.category,
    row.item,
    row.category_source,
  ]);
}

async function mapRows(client) {
  const result = await client.query(
    'SELECT description, direction, category, item FROM merchant_map ORDER BY description, direction',
  );
  return result.rows.map((row) => [row.description, row.direction, row.category, row.item]);
}

test('fixture: 입금 · 출금이 섞인 적요(김철수)는 /classify 에서 두 묶음이다', async (t) => {
  await withScratchDatabase(t, 'classify_directions', async (client) => {
    await importFixture(client);
    const groups = await listClassifyGroups(client, '2026-08', CLASSIFY_FILTERS.unclassified);
    const kim = groups.filter((group) => group.key === '김철수');
    assert.deepEqual(
      kim.map((group) => [group.direction, group.count, group.total]),
      [
        ['in', 3, 4534000],
        ['out', 1, -170000],
      ],
    );
  });
});

test('앞으로도(출금): 방향 매핑을 저장하고 같은 적요의 입금 행은 건드리지 않는다', async (t) => {
  await withScratchDatabase(t, 'classify_always_out', async (client) => {
    await importFixture(client);
    await insertTransactions(client, [
      extraRecord(1, { description: '김철수' }), // 9월 출금
      extraRecord(2, { description: '김철수', amount: 2000, txn_type: '입금' }), // 9월 입금
      extraRecord(3, { description: '김철수', category: '변동비', category_source: 'manual' }), // 9월 출금 manual
    ]);

    const outcome = await applyClassification(
      client,
      valid({ scope: 'always', key: '김철수', direction: 'out', category: '용돈', item: '철수 용돈' }),
    );
    assert.deepEqual(outcome, { ok: true, updated: 2, mapped: true });
    assert.deepEqual(await mapRows(client), [['김철수', 'out', '용돈', '철수 용돈']]);

    assert.deepEqual(await directedRowsOf(client, '김철수'), [
      ['2026-08', 'in', null, null, null],
      ['2026-08', 'in', null, null, null],
      ['2026-08', 'out', '용돈', '철수 용돈', 'map'],
      ['2026-08', 'in', null, null, null],
      ['2026-09', 'out', '용돈', '철수 용돈', 'map'],
      ['2026-09', 'in', null, null, null], // 반대 방향 — 그대로
      ['2026-09', 'out', '변동비', null, 'manual'], // manual — 그대로
    ]);

    // 입금 묶음은 여전히 미분류 목록에 있고, 출금 묶음은 빠졌다.
    const groups = await listClassifyGroups(client, '2026-08', CLASSIFY_FILTERS.unclassified);
    assert.deepEqual(
      groups.filter((group) => group.key === '김철수').map((group) => group.direction),
      ['in'],
    );

    // 이번만(입금): 이 달의 입금 행만 manual 이 된다.
    const once = await applyClassification(
      client,
      valid({ scope: 'once', key: '김철수', direction: 'in', category: '수입', item: '철수 월급' }),
    );
    assert.deepEqual(once, { ok: true, updated: 3, mapped: false });
    const august = (await directedRowsOf(client, '김철수')).filter((row) => row[0] === '2026-08');
    assert.deepEqual(august, [
      ['2026-08', 'in', '수입', '철수 월급', 'manual'],
      ['2026-08', 'in', '수입', '철수 월급', 'manual'],
      ['2026-08', 'out', '용돈', '철수 용돈', 'map'],
      ['2026-08', 'in', '수입', '철수 월급', 'manual'],
    ]);
    assert.deepEqual(await mapRows(client), [['김철수', 'out', '용돈', '철수 용돈']]);

    // 다음 업로드: 출금은 방향 매핑이, 입금은 (매핑이 없으니) 규칙 · 미분류가 된다.
    const records = toTransactionRecords(parseTossStatement(openXlsxFile(FIXTURE).sheet(0)), SCRATCH_ACCOUNTS);
    classifyRecords(records, await loadClassifier(client));
    const future = records
      .filter((record) => record.description === '김철수')
      .map((record) => [record.amount > 0 ? 'in' : 'out', record.category ?? null]);
    assert.deepEqual(future, [
      ['in', null],
      ['in', null],
      ['out', '용돈'],
      ['in', null],
    ]);

    assert.equal(verifyMonthlyReport(await buildMonthlyReport(client, '2026-08')).ok, true);
  });
});

test('방향 구분 전의 any 매핑은 양쪽에 그대로 걸리고, 방향 매핑과 함께 있을 때 수정 · 삭제는 자기 방향만 다룬다', async (t) => {
  await withScratchDatabase(t, 'classify_any_specific', async (client) => {
    await importFixture(client);
    await insertTransactions(client, [
      extraRecord(1, { description: '김철수' }), // 9월 출금
      extraRecord(2, { description: '김철수', amount: 2000, txn_type: '입금' }), // 9월 입금
      extraRecord(3, { description: '김철수', amount: 3000, txn_type: '입금', category: '수입', category_source: 'manual' }),
    ]);

    // 마이그레이션 전에 저장된 것과 같은 모양의 매핑(방향 무관). 업로드 경로처럼
    // 분류기로 미분류 행을 채운다.
    await client.query(`INSERT INTO merchant_map (description, category, item) VALUES ('김철수', '변동비', '옛 매핑')`);
    await classifyStored(client);
    assert.deepEqual(await mapRows(client), [['김철수', 'any', '변동비', '옛 매핑']]);
    const legacy = await directedRowsOf(client, '김철수');
    assert.ok(
      legacy.filter((row) => row[4] !== 'manual').every((row) => row[2] === '변동비' && row[4] === 'map'),
      'any 매핑이 입금 · 출금 모두에 걸렸다',
    );

    // 출금에만 방향 매핑을 만든다.
    await applyClassification(
      client,
      valid({ scope: 'always', key: '김철수', direction: 'out', category: '용돈', item: '철수 용돈' }),
    );
    assert.deepEqual(await mapRows(client), [
      ['김철수', 'any', '변동비', '옛 매핑'],
      ['김철수', 'out', '용돈', '철수 용돈'],
    ]);

    // any 수정: any 가 다스리는 입금 행만 바뀐다(출금은 방향 매핑이 다스린다).
    const edit = await updateMapping(client, { key: '김철수', direction: 'any', category: '수입', item: '받은 돈' });
    assert.deepEqual(edit, { ok: true, updated: 4 }); // 8월 입금 3 + 9월 입금 1(manual 제외)
    assert.deepEqual(await directedRowsOf(client, '김철수'), [
      ['2026-08', 'in', '수입', '받은 돈', 'map'],
      ['2026-08', 'in', '수입', '받은 돈', 'map'],
      ['2026-08', 'out', '용돈', '철수 용돈', 'map'],
      ['2026-08', 'in', '수입', '받은 돈', 'map'],
      ['2026-09', 'out', '용돈', '철수 용돈', 'map'],
      ['2026-09', 'in', '수입', '받은 돈', 'map'],
      ['2026-09', 'in', '수입', null, 'manual'],
    ]);

    // 방향 매핑 삭제: 출금 행은 any 매핑으로 물러선다(출처 map, any 의 항목).
    const dropOut = await deleteMapping(client, { key: '김철수', direction: 'out' });
    assert.deepEqual(dropOut, { ok: true, reclassified: 2, unclassified: 0 });
    assert.deepEqual(
      (await directedRowsOf(client, '김철수')).filter((row) => row[1] === 'out'),
      [
        ['2026-08', 'out', '수입', '받은 돈', 'map'],
        ['2026-09', 'out', '수입', '받은 돈', 'map'],
      ],
    );
    assert.deepEqual(await mapRows(client), [['김철수', 'any', '수입', '받은 돈']]);

    // 다시 출금 매핑을 만든 뒤 any 를 지우면: 입금 행만 규칙으로 돌아가고(여기서는
    // 걸리는 규칙이 없어 미분류), 출금 행은 방향 매핑 그대로다.
    await applyClassification(
      client,
      valid({ scope: 'always', key: '김철수', direction: 'out', category: '용돈', item: '철수 용돈' }),
    );
    const dropAny = await deleteMapping(client, { key: '김철수', direction: 'any' });
    assert.deepEqual(dropAny, { ok: true, reclassified: 0, unclassified: 4 });
    assert.deepEqual(await directedRowsOf(client, '김철수'), [
      ['2026-08', 'in', null, null, null],
      ['2026-08', 'in', null, null, null],
      ['2026-08', 'out', '용돈', '철수 용돈', 'map'],
      ['2026-08', 'in', null, null, null],
      ['2026-09', 'out', '용돈', '철수 용돈', 'map'],
      ['2026-09', 'in', null, null, null],
      ['2026-09', 'in', '수입', null, 'manual'], // manual 은 끝까지 그대로
    ]);
    assert.deepEqual(await mapRows(client), [['김철수', 'out', '용돈', '철수 용돈']]);

    // 없는 (키, 방향)은 404 — 같은 키의 다른 방향 매핑을 대신 고치지 않는다.
    assert.equal((await deleteMapping(client, { key: '김철수', direction: 'in' })).error, 'mappingNotFound');
    assert.equal(
      (await updateMapping(client, { key: '김철수', direction: 'any', category: '수입', item: null })).error,
      'mappingNotFound',
    );
    assert.deepEqual(await mapRows(client), [['김철수', 'out', '용돈', '철수 용돈']]);

    assert.equal(verifyMonthlyReport(await buildMonthlyReport(client, '2026-08')).ok, true);
  });
});

test('any 매핑만 있을 때 지우면 양쪽 방향의 map 행이 모두 다시 분류된다', async (t) => {
  await withScratchDatabase(t, 'classify_any_delete', async (client) => {
    await importFixture(client);
    await client.query(`INSERT INTO merchant_map (description, category) VALUES ('김철수', '변동비')`);
    await classifyStored(client);
    const listed = await listMappings(client);
    assert.deepEqual(
      listed.map(({ key, direction, category }) => [key, direction, category]),
      [['김철수', 'any', '변동비']],
    );

    const outcome = await deleteMapping(client, { key: '김철수', direction: 'any' });
    assert.deepEqual(outcome, { ok: true, reclassified: 0, unclassified: 4 });
    assert.ok((await directedRowsOf(client, '김철수')).every((row) => row[2] === null && row[4] === null));
  });
});

// ── 동시 쓰기 ──────────────────────────────────────────────────────────────

/**
 * `query` 를 가로채 `pattern` 을 포함한 첫 문장 직전에 멈추는 연결 래퍼.
 * `paused` 는 멈춘 순간 풀리고, `release()` 를 부르면 그 문장을 보낸다.
 */
function pauseBefore(client, pattern) {
  let signalPaused;
  let release;
  const paused = new Promise((resolve) => {
    signalPaused = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let armed = true;
  return {
    paused,
    release,
    client: {
      async query(text, params) {
        if (armed && typeof text === 'string' && text.includes(pattern)) {
          armed = false;
          signalPaused();
          await gate;
        }
        return client.query(text, params);
      },
    },
  };
}

/** `promise` 가 끝나거나 그 연결(pid)이 잠금을 기다리기 시작할 때까지 기다린다. */
async function settledOrWaitingOnLock(observer, pid, promise) {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (done) return 'settled';
    const activity = await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (activity.rows[0]?.wait_event_type === 'Lock') return 'waiting';
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('두 번째 쓰기가 끝나지도, 잠금을 기다리지도 않았다');
}

test('동시 쓰기: any 수정 도중 끼어든 같은 키의 방향 매핑이 덮어써지지 않는다', async (t) => {
  await withScratchDatabase(t, 'classify_race', async (client, url) => {
    await importFixture(client);
    await client.query(`INSERT INTO merchant_map (description, category) VALUES ('김철수', '변동비')`);
    await classifyStored(client);

    const { default: pg } = await import('pg');
    const second = new pg.Client({ connectionString: url });
    second.on('error', () => {});
    await second.connect();
    t.after(() => second.end().catch(() => {}));
    const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

    const firstConn = new pg.Client({ connectionString: url });
    firstConn.on('error', () => {});
    await firstConn.connect();
    t.after(() => firstConn.end().catch(() => {}));

    // T1: (김철수, any) 수정. merchant_map 을 고치고 governedDirections 로 [in, out]
    // 을 계산한 뒤, 첫 UPDATE transactions 직전에 트랜잭션을 연 채로 멈춘다.
    const gated = pauseBefore(firstConn, 'UPDATE transactions');
    const edit = updateMapping(gated.client, { key: '김철수', direction: 'any', category: '수입', item: null });
    await gated.paused;

    // T2: 같은 키의 출금 묶음을 앞으로도 기타로. 다른 기본키 행이라 행 잠금으로는
    // T1 과 줄 서지 않는다 — 키 단위 잠금이 있으면 여기서 기다린다.
    const always = applyClassification(
      second,
      valid({ scope: 'always', key: '김철수', direction: 'out', category: '기타', item: null }),
    );
    await settledOrWaitingOnLock(client, secondPid, always);

    gated.release();
    const [editOutcome, alwaysOutcome] = await Promise.all([edit, always]);
    assert.equal(editOutcome.ok, true);
    assert.equal(alwaysOutcome.ok, true);

    // 매핑은 any: 수입, out: 기타. 출처 map 인 행은 자기를 다스리는 매핑과 같아야 한다.
    assert.deepEqual(await mapRows(client), [
      ['김철수', 'any', '수입', null],
      ['김철수', 'out', '기타', null],
    ]);
    const mapped = (await directedRowsOf(client, '김철수')).filter((row) => row[4] === 'map');
    assert.ok(mapped.some((row) => row[1] === 'out'), '출금 map 행이 있어야 검사가 의미 있다');
    for (const [, direction, category] of mapped) {
      assert.equal(category, direction === 'out' ? '기타' : '수입', `${direction} 행이 매핑과 어긋난다`);
    }
  });
});

// ── 기타 ───────────────────────────────────────────────────────────────────

test('기타로 고른 묶음은 분류된 것이다 — 미분류만 보기와 미분류 건수에서 빠진다', () => {
  const rows = [
    { description: '이영희', amount: '-7500', category: '기타', category_source: 'manual' },
    { description: '김철수', amount: '34000', category: null },
  ];
  assert.deepEqual(
    groupRows(rows, CLASSIFY_FILTERS.unclassified).map((group) => group.key),
    ['김철수'],
  );
  const other = groupRows(rows, CLASSIFY_FILTERS.all).find((group) => group.key === '이영희');
  assert.deepEqual([other.category, other.unclassified, other.mixed], ['기타', 0, false]);
});

test('기타로 처리: 이번만 · 앞으로도 모두 되고, 앞으로도는 그 방향의 기타 매핑을 저장한다', async (t) => {
  await withScratchDatabase(t, 'classify_other', async (client) => {
    await importFixture(client);
    assert.equal(await countUnclassified(client, '2026-08'), 8);

    // 출금 묶음(이영희) — 앞으로도.
    const always = await applyClassification(
      client,
      valid({ scope: 'always', key: '이영희', direction: 'out', category: '기타', item: null }),
    );
    assert.deepEqual(always, { ok: true, updated: 1, mapped: true });
    assert.deepEqual(await mapRows(client), [['이영희', 'out', '기타', null]]);
    assert.equal(await countUnclassified(client, '2026-08'), 7);

    // 입금 묶음(김철수 입금 3건) — 이번만. 출금 1건은 미분류로 남는다.
    const once = await applyClassification(
      client,
      valid({ scope: 'once', key: '김철수', direction: 'in', category: '기타', item: null }),
    );
    assert.deepEqual(once, { ok: true, updated: 3, mapped: false });
    assert.equal(await countUnclassified(client, '2026-08'), 4);

    const unclassified = await listClassifyGroups(client, '2026-08', CLASSIFY_FILTERS.unclassified);
    assert.ok(!unclassified.some((group) => group.key === '이영희'));
    assert.deepEqual(
      unclassified.filter((group) => group.key === '김철수').map((group) => group.direction),
      ['out'],
    );

    const report = await buildMonthlyReport(client, '2026-08');
    assert.equal(report.미분류.count, 4);
    assert.deepEqual(
      report.항목별.변동지출.find((line) => line.category === '기타'),
      { category: '기타', item: '이영희', direction: 'out', total: -7500, count: 1 },
    );
    assert.deepEqual(
      report.항목별.수입.find((line) => line.category === '기타'),
      { category: '기타', item: '김철수', direction: 'in', total: 4534000, count: 3 },
    );
    assert.equal(verifyMonthlyReport(report).ok, true);
  });
});
