// 메모 기준 패턴(memo_patterns, 2026-09) — 분류기 순서 · 요청 검사 · 잠금 · /classify 쓰기 ·
// 미리보기 · 수정 · 삭제 · 동시 쓰기.
//
// 사용자 요청: "앞으로도 선택시 메모 기준도 마찬가지로 '패턴으로 저장' 기능 추가해줘."
// 예: 적요는 늘 보낸 사람 이름(홍길동)이고 메모만 `길동 IRP 01회` · `길동 IRP 02회` 로 바뀐다.
//
// 합성 데이터만 쓴다. DB 테스트는 TEST_DATABASE_URL 이 있을 때만 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createClassifier } from '../lib/classify/engine.mjs';
import {
  applyClassification,
  deletePattern,
  listPatterns,
  parsePatternRequest,
  previewPattern,
  updatePattern,
} from '../lib/classify/manual.mjs';
import { handlePatternPost, handlePatternPreview } from '../lib/classify/http.mjs';
import { insertTransactions } from '../lib/db/transactions.mjs';
import { loadClassifier } from '../lib/classify/store.mjs';
import { withScratchDatabase } from './helpers/scratch-db.mjs';

// ── 분류기 순서 ────────────────────────────────────────────────────────────

const RULES = [{ id: 9, txn_type: null, pattern: 'IRP', sign: null, category: '저축', priority: 50 }];

test('분류기: 메모 매핑 → 적요 매핑 → 월 토큰 매핑 → 메모 패턴 → 적요 패턴 → 규칙 → 미분류', () => {
  const classifier = createClassifier({
    rules: RULES,
    memoMap: [{ memo: '길동 IRP 09회', direction: 'out', category: '용돈', item: '메모정확' }],
    merchantMap: [
      { description: '정확한적요', direction: 'out', category: '주거비', item: '적요정확' },
      { description: '코웨이렌탈', direction: 'out', category: '고정비', item: '월토큰' },
    ],
    memoPatterns: [{ id: 1, pattern: '길동 IRP ##회', direction: 'out', category: '고정비', item: '메모패턴' }],
    patterns: [{ id: 1, pattern: '홍길*', direction: 'out', category: '변동비', item: '적요패턴' }],
  });
  const at = (description, memo, amount = -1) => classifier.classify({ description, memo, txn_type: '이체', amount });

  // 0. 메모 매핑이 메모 패턴보다 먼저(같은 메모 기준에서 정확한 값이 이긴다).
  assert.equal(at('홍길동', '길동 IRP 09회').item, '메모정확');
  // 1. 적요 매핑(정확한 값)이 메모 패턴보다 먼저 — 정확한 값이 기준과 무관하게 패턴보다 세다.
  assert.equal(at('정확한적요', '길동 IRP 03회').item, '적요정확');
  // 1-b. 월 토큰 매핑도 정확한 값이다.
  assert.equal(at('코웨이09월렌탈', '길동 IRP 03회').item, '월토큰');
  // 1-c. 메모 패턴이 적요 패턴보다 먼저.
  const byMemoPattern = at('홍길동', '길동 IRP 03회');
  assert.deepEqual(
    [byMemoPattern.category, byMemoPattern.item, byMemoPattern.source, byMemoPattern.basis],
    ['고정비', '메모패턴', 'merchant_map', 'memo'],
  );
  // 1-d. 메모 패턴이 안 맞으면 적요 패턴.
  assert.equal(at('홍길동', '길동 IRP 추가').item, '적요패턴');
  assert.equal(at('홍길동', null).item, '적요패턴');
  // 2. 둘 다 안 맞으면 규칙(메모의 IRP) → 3. 미분류.
  assert.deepEqual([at('김철수', '철수 IRP').category, at('김철수', '철수 IRP').basis], ['저축', 'memo']);
  assert.equal(at('김철수', '아무 메모').category, null);
});

test('분류기: 메모 패턴은 메모 전체 · 같은 방향에만, 빈 메모는 건너뛰고, any · 잘못된 패턴은 무시한다', () => {
  const classifier = createClassifier({
    memoPatterns: [
      { id: 2, pattern: '길동 IRP ##회', direction: 'out', category: '저축', item: null },
      { id: 3, pattern: '월세 *', direction: 'any', category: '주거비', item: '옛 any' }, // 스키마가 막는 값
      { id: 4, pattern: '*', direction: 'out', category: '변동비', item: '너무 넓음' },
    ],
  });
  const at = (memo, amount = -1) => classifier.classify({ description: '홍길동', memo, amount });
  assert.equal(at('길동 IRP 01회').category, '저축');
  assert.equal(at('길동 IRP 01회').item, null); // 항목이 없으면 화면이 적요로 계산한다
  assert.equal(at('길동 IRP 01회 추가').category, null); // 메모 전체와 맞아야 한다
  assert.equal(at('  길동   IRP  01회 ').category, '저축'); // 메모는 정규화해서 비교
  assert.equal(at('길동 IRP 01회', 1).category, null); // 반대 방향
  assert.equal(at('').category, null);
  assert.equal(at('월세 9월').category, null);
  assert.equal(at('아무거나').category, null);
});

// ── 요청 검사 ─────────────────────────────────────────────────────────────

test('요청: 메모 패턴 수정 · 삭제는 in · out 만, 모르는 기준은 거부, 기준이 없으면 적요 패턴이다', () => {
  assert.equal(parsePatternRequest({ action: 'delete', pattern: '길동 ##', direction: 'out', basis: 'memo' }).value.basis, 'memo');
  assert.equal(parsePatternRequest({ action: 'delete', pattern: '길동 ##', direction: 'any', basis: 'memo' }).error, 'badDirection');
  assert.equal(parsePatternRequest({ action: 'delete', pattern: '길동 ##', direction: 'any' }).value.basis, 'description');
  assert.equal(parsePatternRequest({ action: 'delete', pattern: '길동 ##', direction: 'out', basis: 'amount' }).error, 'badBasis');
  const update = parsePatternRequest({ action: 'update', pattern: '길동 ##', direction: 'in', basis: 'memo', category: '수입', item: ' ' });
  assert.deepEqual([update.ok, update.value.basis, update.value.item], [true, 'memo', null]);
});

// ── 잠금 · 쓰기 대상 ──────────────────────────────────────────────────────

const BASE = Object.freeze({
  scope: 'always',
  month: '2026-01',
  account: 'main',
  key: '홍길동',
  memo: '길동 IRP 01회',
  basis: 'memo',
  direction: 'out',
  category: '저축',
  item: '길동 IRP',
});

/** 쿼리만 기록하는 가짜 DB. 그 달 메인 계좌에 (홍길동, `memo`) 출금 한 건이 있다. */
function recordingClient(memo) {
  const queries = [];
  return {
    queries,
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.startsWith('SELECT t.id, t.description, t.memo, t.amount')) {
        return { rows: [{ id: '7', description: '홍길동', memo, amount: '-300000' }], rowCount: 1 };
      }
      if (text.includes('LIKE $1')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  };
}

test('잠금: 키 잠금 = (메모 패턴 네임스페이스, 쓰는 패턴 문자열), 그다음 분류 쓰기 전체 잠금 · memo_patterns 에만 쓴다', async () => {
  const client = recordingClient('길동 IRP 01회');
  const outcome = await applyClassification(client, { ...BASE, pattern: ' 길동 IRP ##회 ' });
  assert.equal(outcome.ok, true);
  const locks = client.queries.filter((query) => query.text.startsWith('SELECT pg_advisory_xact_lock('));
  const insert = client.queries.find((query) => query.text.includes('INSERT INTO memo_patterns'));
  assert.equal(client.queries[0].text, 'BEGIN');
  assert.equal(locks[0], client.queries[1]);
  assert.equal(locks[0].values[0], 0x6d706174); // 'mpat' — 적요 패턴('dpat')과 다른 쓰기 대상
  assert.equal(locks[0].values[1], insert.values[0]);
  assert.equal(insert.values[0], '길동 IRP ##회');
  assert.deepEqual(locks[1].values, [0x636c7377, 0]);
  assert.ok(!client.queries.some((query) => /INSERT INTO (description_patterns|memo_map|merchant_map)/.test(query.text)));
  // 다른 달 후보는 메모 열로 찾는다.
  assert.ok(client.queries.some((query) => query.text.includes('WHERE memo LIKE $1')));
});

test('메모와 맞지 않는 메모 패턴은 거부하고 아무것도 쓰지 않는다(적요와 맞아도)', async () => {
  const client = recordingClient('길동 IRP 01회');
  const outcome = await applyClassification(client, { ...BASE, pattern: '홍길*' });
  assert.equal(outcome.error, 'memoPatternNoMatch');
  assert.ok(!outcome.message.includes('홍길'));
  assert.ok(client.queries.some((query) => query.text === 'ROLLBACK'));
  assert.ok(!client.queries.some((query) => /INSERT INTO|UPDATE transactions/.test(query.text)));
});

// ── HTTP ──────────────────────────────────────────────────────────────────

const HOST = 'budget.example';
function httpRequest(path, body) {
  const headers = new Headers({ host: HOST, 'content-type': 'application/json', origin: `https://${HOST}` });
  return new Request(`https://${HOST}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
function deps(client) {
  return {
    auth: async () => ({ user: { email: 'owner@example.com' } }),
    isAllowedEmail: (email) => email === 'owner@example.com',
    withClient: async (fn) => fn(client),
  };
}

test('HTTP: 메모 패턴 삭제는 memo_patterns 로 가고, 미리보기는 메모 열을 본다 · 모르는 기준은 400', async () => {
  const client = recordingClient('x');
  const removed = await handlePatternPost(
    httpRequest('/api/classify/patterns', { action: 'delete', pattern: '길동 ##', direction: 'out', basis: 'memo' }),
    deps(client),
  );
  // 가짜 DB 는 DELETE 에 1행을 돌려준다.
  assert.equal(removed.status, 200);
  assert.ok(client.queries.some((query) => query.text.startsWith('DELETE FROM memo_patterns')));
  assert.ok(!client.queries.some((query) => query.text.includes('description_patterns')));

  const preview = await handlePatternPreview(
    httpRequest('/api/classify/patterns/preview', { pattern: '길동 ##', key: '길동 01', basis: 'memo' }),
    deps(client),
  );
  assert.equal(preview.status, 200);
  const body = await preview.json();
  assert.deepEqual([body.ok, body.basis, body.matchesKey], [true, 'memo', true]);
  assert.ok(client.queries.some((query) => query.text.includes('WHERE memo LIKE $1')));

  const bad = await handlePatternPreview(
    httpRequest('/api/classify/patterns/preview', { pattern: '길동 ##', basis: 'amount' }),
    deps(client),
  );
  assert.equal(bad.status, 400);
});

// ── 실제 왕복 ─────────────────────────────────────────────────────────────

function record(n, overrides = {}) {
  const month = overrides.year_month ?? '2026-01';
  return {
    account_id: 1,
    txn_at: `${month}-${String(10 + (n % 15)).padStart(2, '0')}T09:00:00+09:00`,
    description: '홍길동',
    txn_type: '이체',
    institution: null,
    cp_acct_hash: null,
    amount: -300000,
    balance: null,
    memo: null,
    category: null,
    category_source: null,
    item: null,
    is_transfer: false,
    dedupe_key: `test-memo-pattern-${n}`,
    year_month: month,
    ...overrides,
  };
}

async function seed(client) {
  await insertTransactions(client, [
    record(1, { year_month: '2026-01', memo: '길동 IRP 01회' }),
    record(2, { year_month: '2026-02', memo: '길동 IRP 02회' }),
    record(3, { year_month: '2026-03', memo: '길동 IRP 03회', account_id: 2 }), // 다른 계좌 · 다른 적요도 걸린다
    record(4, { year_month: '2026-03', memo: '길동 IRP 04회', description: '김철수' }),
    record(5, { year_month: '2026-04', memo: '길동 IRP 05회', category: '변동비', category_source: 'manual' }),
    record(6, { year_month: '2026-02', memo: '길동 IRP 추가' }), // 패턴과 다른 메모
    record(7, { year_month: '2026-02', memo: '길동 IRP 02회', amount: 300000 }), // 반대 방향
    record(8, { year_month: '2026-02', memo: null }), // 메모 없음
  ]);
}

async function rows(client) {
  const result = await client.query(
    `SELECT memo, year_month, account_id, amount, category, item, category_source
       FROM transactions ORDER BY memo NULLS FIRST, year_month, account_id, amount`,
  );
  return result.rows.map((r) => [r.memo, r.year_month, Number(r.account_id), Number(r.amount), r.category, r.item, r.category_source]);
}

async function memoPatternRows(client) {
  const result = await client.query('SELECT pattern, direction, category, item FROM memo_patterns ORDER BY pattern, direction');
  return result.rows.map((r) => [r.pattern, r.direction, r.category, r.item]);
}

test('실제 DB: 메모 패턴으로 저장하면 다른 달 · 계좌 · 적요의 맞는 메모가 바로 분류되고, 수정 · 삭제도 따라간다', async (t) => {
  await withScratchDatabase(t, 'memo_pattern_apply', async (client) => {
    await seed(client);

    const preview = await previewPattern(client, { pattern: '길동 IRP ##회', key: '길동 IRP 01회', basis: 'memo' });
    assert.equal(preview.ok, true);
    assert.equal(preview.matchesKey, true);
    assert.deepEqual([preview.out.count, preview.out.manual, preview.out.distinct, preview.in.count], [5, 1, 5, 1]);
    assert.ok(preview.out.samples.every((sample) => sample.startsWith('길동 IRP')));
    // 적요 기준 미리보기는 같은 패턴을 적요에서 찾는다 — 메모에는 걸리지 않는다.
    assert.equal((await previewPattern(client, { pattern: '길동 IRP ##회' })).out.count, 0);

    const outcome = await applyClassification(client, { ...BASE, pattern: '길동 IRP ##회' });
    assert.deepEqual(outcome, { ok: true, updated: 4, mapped: true });
    assert.deepEqual(await memoPatternRows(client), [['길동 IRP ##회', 'out', '저축', '길동 IRP']]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM description_patterns')).rows[0].n, 0);
    assert.deepEqual(await rows(client), [
      [null, '2026-02', 1, -300000, null, null, null],
      ['길동 IRP 01회', '2026-01', 1, -300000, '저축', '길동 IRP', 'map'],
      ['길동 IRP 02회', '2026-02', 1, -300000, '저축', '길동 IRP', 'map'],
      ['길동 IRP 02회', '2026-02', 1, 300000, null, null, null],
      ['길동 IRP 03회', '2026-03', 2, -300000, '저축', '길동 IRP', 'map'],
      ['길동 IRP 04회', '2026-03', 1, -300000, '저축', '길동 IRP', 'map'],
      ['길동 IRP 05회', '2026-04', 1, -300000, '변동비', null, 'manual'],
      ['길동 IRP 추가', '2026-02', 1, -300000, null, null, null],
    ]);
    const listed = (await listPatterns(client)).map((p) => [p.pattern, p.direction, p.basis, p.category]);
    assert.deepEqual(listed, [['길동 IRP ##회', 'out', 'memo', '저축']]);

    // 다음 업로드에도 걸린다.
    const classifier = await loadClassifier(client);
    const future = classifier.classify({ description: '누군가', memo: '길동 IRP 06회', txn_type: '이체', amount: -1 });
    assert.deepEqual([future.category, future.item, future.basis], ['저축', '길동 IRP', 'memo']);

    // 적요 기준으로는 같은 패턴을 찾을 수 없다(서로 다른 테이블).
    assert.equal((await updatePattern(client, { pattern: '길동 IRP ##회', direction: 'out', category: '용돈' })).error, 'patternNotFound');

    // 수정은 맞는 행에 반영된다(manual 은 그대로).
    assert.deepEqual(
      await updatePattern(client, { pattern: '길동 IRP ##회', direction: 'out', basis: 'memo', category: '용돈', item: null }),
      { ok: true, updated: 4 },
    );
    for (const r of (await rows(client)).filter((row) => row[6] === 'map')) assert.deepEqual([r[4], r[5]], ['용돈', null]);

    // 삭제하면 다시 분류된다 — 이 DB 의 규칙에 `IRP` 메모 규칙이 있으면 규칙으로, 없으면 미분류.
    const removed = await deletePattern(client, { pattern: '길동 IRP ##회', direction: 'out', basis: 'memo' });
    assert.equal(removed.ok, true);
    assert.equal(removed.reclassified + removed.unclassified, 4);
    const after = await rows(client);
    assert.equal(after.filter((r) => r[6] === 'map').length, 0);
    assert.deepEqual(after.find((r) => r[0] === '길동 IRP 05회').slice(4), ['변동비', null, 'manual']);
    assert.deepEqual(await memoPatternRows(client), []);
  });
});

test('실제 DB: 정확한 값(메모 매핑 · 적요 매핑)은 메모 패턴보다, 메모 패턴은 적요 패턴보다 먼저다', async (t) => {
  await withScratchDatabase(t, 'memo_pattern_precedence', async (client) => {
    await seed(client);
    await client.query(`INSERT INTO memo_map (memo, direction, category, item) VALUES ('길동 IRP 02회', 'out', '주거비', '메모정확')`);
    await client.query(`INSERT INTO merchant_map (description, direction, category, item) VALUES ('김철수', 'out', '용돈', '적요정확')`);

    // 적요 패턴(홍길*)을 먼저 저장: 홍길동 행이 적요 패턴으로.
    assert.equal(
      (await applyClassification(client, { ...BASE, basis: undefined, memo: '길동 IRP 01회', pattern: '홍길*', category: '변동비', item: '적요패턴' })).ok,
      true,
    );
    // 메모 패턴을 저장하면 적요 패턴 행을 가져온다. 정확한 값이 걸린 행은 그대로.
    assert.equal((await applyClassification(client, { ...BASE, pattern: '길동 IRP ##회', item: '메모패턴' })).ok, true);
    const byMemo = new Map((await rows(client)).filter((r) => r[3] < 0).map((r) => [`${r[0]}|${r[1]}`, r.slice(4)]));
    assert.deepEqual(byMemo.get('길동 IRP 01회|2026-01'), ['저축', '메모패턴', 'map']);
    assert.deepEqual(byMemo.get('길동 IRP 03회|2026-03'), ['저축', '메모패턴', 'map']);
    assert.deepEqual(byMemo.get('길동 IRP 02회|2026-02'), ['주거비', '메모정확', 'map']);
    assert.deepEqual(byMemo.get('길동 IRP 04회|2026-03'), ['용돈', '적요정확', 'map']);
    assert.deepEqual(byMemo.get('길동 IRP 추가|2026-02'), ['변동비', '적요패턴', 'map']);

    // 메모 패턴을 지우면 그 행들은 적요 패턴으로 돌아간다.
    assert.equal((await deletePattern(client, { pattern: '길동 IRP ##회', direction: 'out', basis: 'memo' })).ok, true);
    const back = new Map((await rows(client)).filter((r) => r[3] < 0).map((r) => [`${r[0]}|${r[1]}`, r.slice(4)]));
    assert.deepEqual(back.get('길동 IRP 01회|2026-01'), ['변동비', '적요패턴', 'map']);
    // 다른 계좌(고정비 계좌, account 2)의 홍길동도 적요 패턴이 다스린다.
    assert.deepEqual(back.get('길동 IRP 03회|2026-03'), ['변동비', '적요패턴', 'map']);
    assert.deepEqual(back.get('길동 IRP 02회|2026-02'), ['주거비', '메모정확', 'map']);
  });
});

test('실제 DB: memo_patterns 의 CHECK — any 방향 · 빈 패턴 · 65자 패턴 · 41자 항목 · 같은 (패턴, 방향) 중복은 들어가지 않는다', async (t) => {
  await withScratchDatabase(t, 'memo_pattern_checks', async (client) => {
    const insert = (pattern, direction, item = null) =>
      client.query('INSERT INTO memo_patterns (pattern, direction, category, item) VALUES ($1, $2, $3, $4)', [pattern, direction, '저축', item]);
    await insert('길동 ##', 'out');
    for (const [pattern, direction, item] of [
      ['길동 ##', 'any', null],
      ['  ', 'out', null],
      [`가${'#'.repeat(64)}`, 'out', null],
      ['길동 #', 'out', '가'.repeat(41)],
      ['길동 ##', 'out', null],
    ]) {
      await assert.rejects(insert(pattern, direction, item), (error) => typeof error?.code === 'string');
    }
  });
});

// ── 동시 쓰기 ──────────────────────────────────────────────────────────────

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

async function waitingOnLock(observer, pid, promise) {
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

async function openClients(t, url, n) {
  const { default: pg } = await import('pg');
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const c = new pg.Client({ connectionString: url });
    c.on('error', () => {});
    await c.connect();
    t.after(() => c.end().catch(() => {}));
    out.push({ client: c, pid: (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid });
  }
  return out;
}

test('동시 쓰기: 같은 메모 패턴의 수정과 저장은 패턴 키 잠금으로 줄 서고, 나중 쓰기가 남는다', async (t) => {
  await withScratchDatabase(t, 'memo_pattern_race_same', async (observer, url) => {
    await seed(observer);
    assert.equal((await applyClassification(observer, { ...BASE, pattern: '길동 IRP ##회', category: '변동비' })).ok, true);
    const [first, second] = await openClients(t, url, 2);

    const gated = pauseBefore(first.client, 'LIKE $1');
    const edit = updatePattern(gated.client, { pattern: '길동 IRP ##회', direction: 'out', basis: 'memo', category: '용돈', item: null });
    await gated.paused;

    const save = applyClassification(second.client, {
      ...BASE,
      month: '2026-02',
      memo: '길동 IRP 02회',
      pattern: '길동 IRP ##회',
      category: '저축',
      item: '길동 IRP',
    });
    assert.equal(await waitingOnLock(observer, second.pid, save), 'waiting');
    gated.release();
    const [a, b] = await Promise.all([edit, save]);
    assert.deepEqual([a.ok, b.ok], [true, true]);

    assert.deepEqual(await memoPatternRows(observer), [['길동 IRP ##회', 'out', '저축', '길동 IRP']]);
    for (const r of (await rows(observer)).filter((row) => row[6] === 'map')) {
      assert.deepEqual([r[4], r[5]], ['저축', '길동 IRP'], r[0]);
    }
  });
});

test('동시 쓰기: 메모 패턴과 같은 행을 건드리는 적요 패턴 쓰기가 교착 없이 줄 서고, 커밋 순서와 무관하게 메모 패턴이 이긴다', async (t) => {
  await withScratchDatabase(t, 'memo_pattern_race_description', async (observer, url) => {
    await seed(observer);
    const [first, second] = await openClients(t, url, 2);

    // T1: 1월 묶음을 메모 패턴으로 저장. 다른 달 후보를 잠그기 직전에 멈춘다.
    const gated = pauseBefore(first.client, 'LIKE $1');
    const memoSave = applyClassification(gated.client, { ...BASE, pattern: '길동 IRP ##회', category: '저축', item: '메모패턴' });
    await gated.paused;

    // T2: 2월 묶음(같은 적요 홍길동)을 적요 패턴으로 저장 — 1월 행도 후보다. 나중에 커밋된다.
    const descriptionSave = applyClassification(second.client, {
      ...BASE,
      basis: undefined,
      month: '2026-02',
      memo: '길동 IRP 02회',
      pattern: '홍길*',
      category: '변동비',
      item: '적요패턴',
    });
    assert.equal(await waitingOnLock(observer, second.pid, descriptionSave), 'waiting');
    gated.release();
    const [a, b] = await Promise.all([memoSave, descriptionSave]);
    assert.deepEqual([a.ok, b.ok], [true, true]);

    const byMemo = new Map((await rows(observer)).filter((r) => r[3] < 0).map((r) => [`${r[0]}|${r[1]}`, r.slice(4)]));
    // 적요 패턴 저장이 고른 2월 묶음 자체는 사람이 방금 고른 값이다(그 묶음의 행은 그대로 바뀐다).
    assert.deepEqual(byMemo.get('길동 IRP 02회|2026-02'), ['변동비', '적요패턴', 'map']);
    // 그 밖의 메모 패턴 행은 적요 패턴이 나중에 커밋돼도 메모 패턴을 따른다.
    assert.deepEqual(byMemo.get('길동 IRP 01회|2026-01'), ['저축', '메모패턴', 'map']);
    assert.deepEqual(byMemo.get('길동 IRP 03회|2026-03'), ['저축', '메모패턴', 'map']);
    // 메모 패턴에 안 맞는 홍길동 행은 적요 패턴.
    assert.deepEqual(byMemo.get('길동 IRP 추가|2026-02'), ['변동비', '적요패턴', 'map']);
  });
});
