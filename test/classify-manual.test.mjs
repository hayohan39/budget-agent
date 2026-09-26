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
    value: { scope: 'once', month: '2026-08', key: '코웨이08월렌탈', category: '고정비', item: '정수기 렌탈' },
  });
});

test('허용 목록 밖의 분류는 거부한다', () => {
  for (const category of ['손수정', '', ' 고정비', '미분류', '기타', null, 1, ['고정비']]) {
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

test('매핑 요청: 수정은 분류 · 항목을, 삭제는 키만 본다', () => {
  assert.deepEqual(parseMappingRequest({ action: 'delete', key: ' 코인적립 ' }), {
    ok: true,
    value: { action: 'delete', key: '코인적립' },
  });
  assert.equal(parseMappingRequest({ action: 'update', key: '코인적립', category: '손수정' }).error, 'badCategory');
  assert.equal(parseMappingRequest({ action: 'drop', key: '코인적립' }).error, 'badRequest');
  assert.equal(
    parseMappingRequest({ action: 'update', key: '코인적립', category: '저축', item: 'a\nb' }).error,
    'itemControlChars',
  );
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
  assert.equal((await updateMapping(client, { key: 'x', category: '손수정' })).ok, false);
  assert.equal((await deleteMapping(client, { key: '' })).ok, false);
});

// ── 묶기 ───────────────────────────────────────────────────────────────────

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
      { category: '고정비', item: '정수기', total: -3780, count: 1 },
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

    const missing = await updateMapping(client, { key: '코인적립', category: '저축', item: null });
    assert.equal(missing.error, 'mappingNotFound');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM merchant_map')).rows[0].n, 0);
    assert.equal((await deleteMapping(client, { key: '코인적립' })).error, 'mappingNotFound');
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

    const outcome = await updateMapping(client, { key: '코인적립', category: '변동비', item: '코인 모으기' });
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

    const coin = await deleteMapping(client, { key: '코인적립' });
    assert.deepEqual(coin, { ok: true, reclassified: 2, unclassified: 0 });
    // 규칙(코인적립 -> 저축)으로 돌아갔다. manual 은 그대로.
    assert.deepEqual(await rowsOf(client, '코인적립'), [
      ['2026-08', '저축', null, 'rule'],
      ['2026-09', '저축', null, 'rule'],
      ['2026-09', '용돈', '손', 'manual'],
    ]);

    const person = await deleteMapping(client, { key: '이영희' });
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
