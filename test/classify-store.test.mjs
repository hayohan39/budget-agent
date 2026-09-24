// 저장된 미분류 행을 채우는 경로 테스트.
//
// 두 층이다.
//   1. 가짜 클라이언트 — 커서 진행 · 배치 · 멱등 · 로그 위생. 항상 돈다.
//   2. 실제 왕복 — 스크래치 DB 에 마이그레이션을 적용해 시드 규칙 9개로
//      fixture 24행을 분류한다. `TEST_DATABASE_URL` 이 있을 때만 돈다.
//
// ⚠️ `DATABASE_URL` 은 읽지 않는다. 운영 Neon 을 가리키는 값이다.
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
import { createClassifier } from '../lib/classify/engine.mjs';
import { classifyStored, loadClassifier } from '../lib/classify/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'toss-sample-masked.xlsx');

const ACCOUNTS = Object.freeze([
  { id: 1, role: 'main', last4: '1288', nickname: '메인' },
  { id: 2, role: 'fixed', last4: '2222', nickname: '고정비' },
  { id: 3, role: 'emergency', last4: '3333', nickname: '비상금' },
]);

const RULES = Object.freeze([
  { id: 1, txn_type: null, pattern: '코인적립', sign: null, category: '저축', priority: 10 },
  { id: 2, txn_type: '펌뱅킹출금', pattern: '카드', sign: -1, category: '카드대금', priority: 20 },
]);

/**
 * transactions 를 흉내 내는 가짜 클라이언트.
 *
 * id 는 BIGSERIAL 이라 pg 가 **문자열**로 준다. 그 성질을 그대로 재현한다 —
 * 커서를 Number 로 바꿔 쓰는 구현이었다면 여기서 드러나야 한다.
 */
function fakeClient(rows) {
  const table = rows.map((row) => ({ ...row, id: String(row.id) }));
  const queries = [];

  return {
    table,
    queries,
    async query(text, values = []) {
      queries.push({ text, values });

      if (text.includes('FROM category_rules')) return { rows: RULES.map((rule) => ({ ...rule })) };
      if (text.includes('FROM merchant_map')) return { rows: [] };

      if (text.includes('FROM transactions')) {
        const [cursor, yearMonth, limit] = values;
        const selected = table
          .filter((row) => row.category === null)
          .filter((row) => BigInt(row.id) > BigInt(cursor))
          .filter((row) => yearMonth === null || row.year_month === yearMonth)
          .sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1))
          .slice(0, limit)
          .map((row) => ({
            id: row.id,
            description: row.description,
            txn_type: row.txn_type,
            amount: row.amount,
          }));
        return { rows: selected };
      }

      if (text.includes('UPDATE transactions')) {
        const [category, ids] = values;
        let rowCount = 0;
        for (const row of table) {
          if (row.category !== null) continue;
          if (!ids.includes(row.id)) continue;
          row.category = category;
          rowCount += 1;
        }
        return { rowCount, rows: [] };
      }

      throw new Error(`가짜 클라이언트가 모르는 쿼리: ${text.split('\n')[0]}`);
    },
  };
}

function sampleRows() {
  return [
    { id: 1, description: '코인적립', txn_type: '자동이체', amount: '-200000', category: null, year_month: '2026-08' },
    { id: 2, description: '삼성카드주식회사', txn_type: '펌뱅킹출금', amount: '-2858322', category: null, year_month: '2026-08' },
    { id: 3, description: '이영희', txn_type: '모임원송금', amount: '-7500', category: null, year_month: '2026-08' },
    { id: 4, description: '전자카드비', txn_type: '펌뱅킹출금', amount: '1045850', category: null, year_month: '2026-08' },
    { id: 5, description: '코인적립', txn_type: '자동이체', amount: '-200000', category: '손수정', year_month: '2026-08' },
    { id: 6, description: '코인적립', txn_type: '자동이체', amount: '-200000', category: null, year_month: '2026-09' },
  ];
}

test('미분류 행만 채우고 이미 분류된 행은 건드리지 않는다', async () => {
  const client = fakeClient(sampleRows());
  const result = await classifyStored(client);

  assert.deepEqual(
    { scanned: result.scanned, classified: result.classified, unmatched: result.unmatched },
    { scanned: 5, classified: 3, unmatched: 2 },
  );
  assert.deepEqual(client.table.map((row) => row.category), [
    '저축',      // 1
    '카드대금',   // 2
    null,        // 3 규칙 없음
    null,        // 4 입금 — sign 가드
    '손수정',    // 5 사람이 고친 값은 그대로다
    '저축',      // 6 다른 달도 같이 돈다
  ]);
});

test('다시 돌려도 결과가 같다(멱등)', async () => {
  const client = fakeClient(sampleRows());
  await classifyStored(client);
  const snapshot = client.table.map((row) => row.category);

  const again = await classifyStored(client);
  assert.equal(again.classified, 0);
  assert.equal(again.unmatched, 2); // 규칙에 안 걸린 두 건은 계속 미분류로 남는다
  assert.deepEqual(client.table.map((row) => row.category), snapshot);
});

test('규칙에 안 걸린 행이 있어도 무한 루프에 빠지지 않는다', async () => {
  // 배치 크기 1 · 미분류 5건. id 커서가 앞으로만 나아가므로 끝난다.
  const client = fakeClient(sampleRows());
  const result = await classifyStored(client, { batchSize: 1 });

  assert.equal(result.batches, 5);
  assert.equal(result.scanned, 5);
});

test('배치 크기만큼 끊어 읽는다', async () => {
  const client = fakeClient(sampleRows());
  const result = await classifyStored(client, { batchSize: 2 });

  // 5건을 2·2·1 로 읽는다. 마지막 배치가 상한 미만이면 더 읽지 않는다.
  assert.equal(result.batches, 3);
});

test('yearMonth 를 주면 그 달만 본다', async () => {
  const client = fakeClient(sampleRows());
  const result = await classifyStored(client, { yearMonth: '2026-09' });

  assert.equal(result.scanned, 1);
  assert.equal(result.classified, 1);
  assert.equal(client.table.find((row) => row.id === '6').category, '저축');
  assert.equal(client.table.find((row) => row.id === '1').category, null);
});

test('id 를 문자열로 주고받는다(2^53 경계에서 깨지지 않게)', async () => {
  const huge = '9007199254740993'; // Number 로 바꾸면 ...992 가 되는 값
  const client = fakeClient([
    { id: huge, description: '코인적립', txn_type: '자동이체', amount: '-1', category: null, year_month: '2026-08' },
  ]);
  const result = await classifyStored(client);

  assert.equal(result.classified, 1);
  const update = client.queries.find((query) => query.text.includes('UPDATE transactions'));
  assert.deepEqual(update.values[1], [huge]);
});

test('UPDATE 에 category IS NULL 가드가 들어 있다', async () => {
  const client = fakeClient(sampleRows());
  await classifyStored(client);

  const update = client.queries.find((query) => query.text.includes('UPDATE transactions'));
  assert.match(update.text, /WHERE category IS NULL/);
  // 값은 전부 파라미터로 나간다.
  assert.ok(!update.text.includes('저축'));
});

test('batchSize 가 이상하면 거부한다', async () => {
  const client = fakeClient(sampleRows());
  for (const batchSize of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(() => classifyStored(client, { batchSize }), /batchSize/);
  }
});

test('읽기가 실패하면 원인 메시지를 흘리지 않는다', async () => {
  const client = {
    async query(text) {
      if (text.includes('FROM category_rules')) {
        throw new Error('permission denied for relation category_rules (user=hunter2)');
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => classifyStored(client),
    (error) => {
      assert.ok(!error.message.includes('hunter2'), '원본 메시지가 새어 나왔다');
      assert.match(error.message, /분류 규칙을 읽지 못했습니다/);
      return true;
    },
  );
});

test('결과 객체에 행 내용이 들어가지 않는다', async () => {
  const client = fakeClient(sampleRows());
  const result = await classifyStored(client);
  const serialized = JSON.stringify(result);

  for (const leak of ['이영희', '삼성카드주식회사', '2858322', '전자카드비']) {
    assert.ok(!serialized.includes(leak), `${leak} 이(가) 새어 나왔다`);
  }
});

test('loadClassifier 가 규칙과 매핑을 함께 읽는다', async () => {
  const client = fakeClient(sampleRows());
  const classifier = await loadClassifier(client);

  assert.equal(classifier.ruleCount, 2);
  assert.deepEqual(classifier.skipped, []);
  assert.equal(
    classifier.classify({ description: '코인적립', txn_type: '자동이체', amount: '-1' }).category,
    '저축',
  );
});

test('미리 만든 분류기를 주면 규칙을 다시 읽지 않는다', async () => {
  const client = fakeClient(sampleRows());
  const classifier = createClassifier({ rules: RULES });
  await classifyStored(client, { classifier });

  assert.ok(!client.queries.some((query) => query.text.includes('FROM category_rules')));
});

// ── 실제 왕복 ──────────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function localAdminUrl() {
  const raw = process.env.TEST_DATABASE_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  const url = new URL(raw);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    // 호스트명은 메시지에 넣지 않는다. CI 로그에서 마스킹되지 않는 식별자다.
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

/** 스크래치 DB 를 만들고 마이그레이션까지 적용한 연결을 돌려준다. */
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

function fixtureRecords() {
  const statement = parseTossStatement(openXlsxFile(FIXTURE).sheet(0));
  return toTransactionRecords(statement, ACCOUNTS);
}

test('시드 규칙으로 fixture 24행을 실제 DB 에서 분류한다', async (t) => {
  await withScratchDatabase(t, 'classify', async (client) => {
    await client.query('BEGIN');
    await insertTransactions(client, fixtureRecords());
    await client.query('COMMIT');

    const first = await classifyStored(client, { yearMonth: '2026-08', batchSize: 10 });
    assert.deepEqual(
      { scanned: first.scanned, classified: first.classified, unmatched: first.unmatched },
      { scanned: 24, classified: 16, unmatched: 8 },
    );
    assert.deepEqual(first.skippedRules, []);

    const counts = await client.query(
      `SELECT coalesce(category, '(미분류)') AS category, count(*)::int AS n
         FROM transactions GROUP BY 1 ORDER BY 1`,
    );
    assert.deepEqual(
      counts.rows.map((row) => [row.category, row.n]),
      [
        ['(미분류)', 8],
        ['고정비이체', 1],
        ['비상금이체', 1],
        // 용돈 2건. 20260924033721729_add-allowance-rule.sql 이전에는 자동이체
        // 포괄 규칙에 걸려 '고정비' 2건이었다.
        ['용돈', 2],
        ['이자', 1],
        ['저축', 6],
        ['주거비', 1],
        ['카드대금', 4],
      ],
    );

    // 두 번째 실행은 아무것도 바꾸지 않는다(멱등).
    const second = await classifyStored(client, { yearMonth: '2026-08', batchSize: 10 });
    assert.equal(second.classified, 0);
    assert.equal(second.unmatched, 8);

    // 사람이 고친 매핑은 다음 실행에서도 덮이지 않는다.
    // 두 행 다 이미 분류돼 있어야 검사가 의미를 갖는다 — 규칙이 넣은 값과
    // 다른 분류를 merchant_map 에 넣어 두고, 그래도 덮이지 않는지 본다.
    await client.query(
      `UPDATE transactions SET category = '변동비' WHERE description = '길동 용돈'`,
    );
    await client.query(
      `INSERT INTO merchant_map (description, category) VALUES ('철수 용돈', '변동비')`,
    );
    const third = await classifyStored(client);
    assert.equal(third.classified, 0, '이미 분류된 행은 다시 쓰지 않는다');
    const kept = await client.query(
      `SELECT description, category FROM transactions WHERE description LIKE '%용돈'`,
    );
    const byDescription = new Map(kept.rows.map((row) => [row.description, row.category]));
    // 사람이 고친 값도, 규칙이 넣은 값도 그대로다.
    assert.equal(byDescription.get('길동 용돈'), '변동비');
    assert.equal(byDescription.get('철수 용돈'), '용돈');
  });
});

test('업로드 경로가 넣은 행은 이미 분류돼 있다', async (t) => {
  await withScratchDatabase(t, 'classify_import', async (client) => {
    const { readFileSync } = await import('node:fs');
    const { importStatementBuffer } = await import('../lib/import/statement.mjs');

    const result = await importStatementBuffer(readFileSync(FIXTURE), {
      client,
      accounts: ACCOUNTS,
    });
    assert.equal(result.ok, true);
    assert.equal(result.inserted, 24);

    const unclassified = await client.query(
      'SELECT count(*)::int AS n FROM transactions WHERE category IS NULL',
    );
    // 업로드만으로 16건이 분류됐다. 남은 8건은 규칙이 없는 건이다.
    assert.equal(unclassified.rows[0].n, 8);

    // 뒤이어 돌린 분류 작업이 바꿀 것이 없다.
    const after = await classifyStored(client);
    assert.equal(after.classified, 0);
  });
});
