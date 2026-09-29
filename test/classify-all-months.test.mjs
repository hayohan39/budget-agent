// /classify '전체 기간' — 모든 달의 묶음을 **달별로** 한 화면에(쿼리 한 번).
//
// 사용자 요청(2026-09): "분류 정리의 경우 월별이 아닌 전체 케이스에 대한 분류 rule 을
// 한번에 처리할수있도록 해줘." 이어서: "모든달의 미분류된 항목을 한화면에서 수정하는 것은
// 맞는데 여전히 해당 미분류 항목이 해당 월에 속해있어야해. 그래서 그 항목이 이번만으로
// 분류되면 해당 월에 대해서만 적용이되어야해."
//
// 합성 데이터만 쓴다. DB 테스트는 TEST_DATABASE_URL 이 있을 때만 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLASSIFY_FILTERS,
  MAX_ALL_PERIOD_ROWS,
  applyClassification,
  classifyMonthHref,
  listAllPeriodGroups,
  listClassifyGroups,
  parseClassifyRequest,
} from '../lib/classify/manual.mjs';
import { insertTransactions } from '../lib/db/transactions.mjs';
import { withScratchDatabase } from './helpers/scratch-db.mjs';

test('쓰기 요청의 달은 여전히 YYYY-MM 만 받는다(전체 기간에서도 묶음의 달이 간다)', () => {
  const base = { scope: 'once', account: 'main', key: '가게', direction: 'out', category: '변동비' };
  assert.equal(parseClassifyRequest({ ...base, month: 'all' }).error, 'badMonth');
  assert.equal(parseClassifyRequest({ ...base, month: '2026-07' }).ok, true);
});

test('"이 달만 보기" 링크는 지금 보기 필터를 싣는다(모르는 필터는 기본값, 달은 YYYY-MM 만)', () => {
  assert.equal(classifyMonthHref('2026-07', CLASSIFY_FILTERS.all), '/classify?month=2026-07&filter=all');
  assert.equal(classifyMonthHref('2026-07', CLASSIFY_FILTERS.unclassified), '/classify?month=2026-07&filter=unclassified');
  assert.equal(classifyMonthHref('2026-07', '"><script>'), '/classify?month=2026-07&filter=unclassified');
  assert.equal(classifyMonthHref('2026-07', undefined), '/classify?month=2026-07&filter=unclassified');
  assert.throws(() => classifyMonthHref('all', CLASSIFY_FILTERS.all));
});

/**
 * 상한 경계 — DB 없이. `LIMIT MAX + 1` 로 읽은 행을 흉내 내는 가짜 client.
 * `months` 는 [달, 행 수] 를 최신 달부터.
 */
function fakeClient(months) {
  const all = [];
  for (const [month, count] of months) {
    for (let i = 0; i < count; i += 1) {
      all.push({
        year_month: month,
        id: String(all.length + 1),
        account_id: 1,
        txn_at: `${month}-01T09:00:00+09:00`,
        description: '가게',
        memo: null,
        amount: '-1000',
        category: null,
        item: null,
        category_source: null,
        is_transfer: false,
      });
    }
  }
  return {
    async query(sql, params) {
      if (/FROM accounts/.test(sql)) return { rows: [{ id: 1, role: 'main', nickname: '메인' }] };
      return { rows: all.slice(0, params[0]) };
    },
  };
}

test('전체 기간 상한: 달 한가운데서 잘리면 그 (가장 오래된) 달은 반쪽이라 버린다', async () => {
  const result = await listAllPeriodGroups(
    fakeClient([
      ['2026-08', MAX_ALL_PERIOD_ROWS - 10],
      ['2026-07', 20], // 10건만 상한 안 — 잘린 달
    ]),
    CLASSIFY_FILTERS.all,
  );
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.months.map((m) => [m.month, m.groups[0].count]),
    [['2026-08', MAX_ALL_PERIOD_ROWS - 10]],
  );
});

test('전체 기간 상한: 달 경계에서 딱 끊기면(다음 행이 더 오래된 달) 마지막 달은 온전하니 남긴다', async () => {
  const result = await listAllPeriodGroups(
    fakeClient([
      ['2026-08', MAX_ALL_PERIOD_ROWS - 10],
      ['2026-07', 10], // 상한 안에 다 들어온 달
      ['2026-06', 5], // 상한 밖에서 시작 — 보이지 않는다
    ]),
    CLASSIFY_FILTERS.all,
  );
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.months.map((m) => [m.month, m.groups[0].count]),
    [
      ['2026-08', MAX_ALL_PERIOD_ROWS - 10],
      ['2026-07', 10],
    ],
  );
});

test('전체 기간 상한: 상한과 정확히 같은 행 수면 잘리지 않았다', async () => {
  const result = await listAllPeriodGroups(
    fakeClient([
      ['2026-08', MAX_ALL_PERIOD_ROWS - 10],
      ['2026-07', 10],
    ]),
    CLASSIFY_FILTERS.all,
  );
  assert.equal(result.truncated, false);
  assert.deepEqual(result.months.map((m) => m.month), ['2026-08', '2026-07']);
});

function record(n, overrides = {}) {
  const month = overrides.year_month ?? '2026-07';
  return {
    account_id: 1,
    txn_at: `${month}-${String(1 + (n % 27)).padStart(2, '0')}T09:00:00+09:00`,
    description: '동네가게',
    txn_type: '체크카드',
    institution: null,
    cp_acct_hash: null,
    amount: -10000,
    balance: null,
    memo: null,
    category: null,
    category_source: null,
    item: null,
    is_transfer: false,
    dedupe_key: `test-all-${n}`,
    year_month: month,
    ...overrides,
  };
}

async function rows(client) {
  const result = await client.query(
    `SELECT year_month, description, category, category_source FROM transactions ORDER BY dedupe_key`,
  );
  return result.rows.map((r) => [r.year_month, r.description, r.category, r.category_source]);
}

async function seed(client) {
  await insertTransactions(client, [
    record(1, { year_month: '2026-05' }),
    record(2, { year_month: '2026-06' }),
    record(3, { year_month: '2026-07' }),
    record(4, { year_month: '2026-07', memo: '회식' }), // 같은 달 · 다른 메모 = 다른 묶음
    record(5, { year_month: '2026-06', description: '단골식당' }),
    record(6, { year_month: '2026-07', description: '단골식당', category: '변동비', category_source: 'manual' }),
    record(7, { year_month: '2026-05', description: '분류된것', category: '고정비', category_source: 'rule' }),
  ]);
}

test('실제 DB: 전체 기간은 달별 묶음이고(최신 달 먼저), 각 달의 묶음은 한 달 보기와 같다 — 쿼리 한 번', async (t) => {
  await withScratchDatabase(t, 'all_months_list', async (client) => {
    await seed(client);
    const seen = [];
    const spy = { query: (text, values) => (seen.push(text), client.query(text, values)) };
    const all = await listAllPeriodGroups(spy, CLASSIFY_FILTERS.unclassified);
    assert.equal(seen.filter((text) => text.includes('FROM transactions')).length, 1, '거래는 쿼리 한 번');
    assert.equal(all.truncated, false);
    assert.deepEqual(
      all.months.map(({ month, groups }) => [month, groups.map((g) => [g.key, g.memo, g.count])]),
      [
        ['2026-07', [['동네가게', null, 1], ['동네가게', '회식', 1]]],
        ['2026-06', [['단골식당', null, 1], ['동네가게', null, 1]]],
        ['2026-05', [['동네가게', null, 1]]],
      ],
    );
    for (const { month, groups } of all.months) {
      assert.deepEqual(groups, await listClassifyGroups(client, month, CLASSIFY_FILTERS.unclassified), month);
    }
    // '전체' 보기는 분류된 묶음까지 달별로.
    const everything = await listAllPeriodGroups(client, CLASSIFY_FILTERS.all);
    assert.ok(everything.months.find((m) => m.month === '2026-05').groups.some((g) => g.key === '분류된것'));
  });
});

test('실제 DB: 전체 기간에서 고른 이번만은 그 묶음의 달에만, 앞으로도는 모든 달(manual 제외)', async (t) => {
  await withScratchDatabase(t, 'all_months_write', async (client) => {
    await seed(client);
    const all = await listAllPeriodGroups(client, CLASSIFY_FILTERS.unclassified);
    const june = all.months.find((m) => m.month === '2026-06').groups.find((g) => g.key === '동네가게');
    // 화면은 묶음의 달(2026-06)을 그대로 보낸다.
    const once = await applyClassification(client, {
      scope: 'once',
      month: '2026-06',
      account: june.account.role,
      key: june.key,
      memo: june.memo,
      direction: june.direction,
      category: '용돈',
      item: null,
    });
    assert.deepEqual(once, { ok: true, updated: 1, mapped: false });
    assert.deepEqual((await rows(client)).slice(0, 4), [
      ['2026-05', '동네가게', null, null],
      ['2026-06', '동네가게', '용돈', 'manual'],
      ['2026-07', '동네가게', null, null],
      ['2026-07', '동네가게', null, null],
    ]);

    const always = await applyClassification(client, {
      scope: 'always',
      month: '2026-06',
      account: 'main',
      key: '단골식당',
      direction: 'out',
      category: '변동비',
      item: '외식',
    });
    assert.deepEqual(always, { ok: true, updated: 1, mapped: true });
    assert.deepEqual((await rows(client)).slice(4, 6), [
      ['2026-06', '단골식당', '변동비', 'map'],
      ['2026-07', '단골식당', '변동비', 'manual'], // 다른 달의 이번만은 그대로
    ]);

    // 06월 묶음은 목록에서 빠지고, 다른 달의 같은 적요 묶음은 그대로 남는다.
    const after = await listAllPeriodGroups(client, CLASSIFY_FILTERS.unclassified);
    assert.deepEqual(after.months.map((m) => m.month), ['2026-07', '2026-05']);
  });
});
