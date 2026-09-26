// transactions 저장 테스트.
//
// 두 층으로 나뉜다.
//
//   1. 연결 없이 도는 부분 — SQL 문 조립과 파라미터 바인딩. 항상 돈다.
//   2. 실제 왕복 — 스크래치 DB 를 만들고 이 레포의 마이그레이션을 적용한 뒤
//      fixture 를 두 번 넣어 `inserted: 24` -> `inserted: 0` 을 확인한다.
//      `TEST_DATABASE_URL` 이 설정돼 있을 때만 돈다.
//
// ⚠️ 이 파일은 `DATABASE_URL` 을 **읽지 않는다.** 그 값은 운영 Neon 을 가리킨다.
//    테스트는 오직 `TEST_DATABASE_URL` 만 보고, 그마저도 로컬 호스트가 아니면
//    거부한다. 테스트가 실수로 운영 DB 에 쓰는 사고를 구조적으로 막는다.
//
// 로컬 서버 준비 예시(값은 전부 로컬 전용 더미다):
//   TEST_DATABASE_URL=postgres://budget_test:budget_test@127.0.0.1:5432/postgres
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openXlsxFile } from '../lib/xlsx/workbook.mjs';
import { parseTossStatement } from '../lib/toss/statement.mjs';
import { toTransactionRecords } from '../lib/toss/normalize.mjs';
import {
  buildInsertStatement,
  insertTransactions,
  INSERT_COLUMNS,
} from '../lib/db/transactions.mjs';
import { requireConnectionString } from '../lib/db/client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'toss-sample-masked.xlsx');

const MAIN_LAST4 = '1288';
const ACCOUNTS = Object.freeze([
  { id: 1, role: 'main', last4: MAIN_LAST4, nickname: '메인' },
  { id: 2, role: 'fixed', last4: '2222', nickname: '고정비' },
  { id: 3, role: 'emergency', last4: '3333', nickname: '비상금' },
]);

function fixtureRecords() {
  const statement = parseTossStatement(openXlsxFile(FIXTURE).sheet(0));
  return toTransactionRecords(statement, ACCOUNTS);
}

// ── 연결 없이: SQL 조립 ────────────────────────────────────────────────────

test('INSERT 문이 ON CONFLICT (dedupe_key) DO NOTHING 으로 끝난다', () => {
  const { text } = buildInsertStatement(fixtureRecords().slice(0, 2));

  assert.match(text, /^INSERT INTO transactions \(/);
  assert.match(text, /ON CONFLICT \(dedupe_key\) DO NOTHING$/);
});

test('컬럼 목록이 스키마와 맞고 id·created_at 은 넣지 않는다', () => {
  assert.deepEqual([...INSERT_COLUMNS], [
    'account_id',
    'txn_at',
    'description',
    'txn_type',
    'institution',
    'cp_acct_hash',
    'amount',
    'balance',
    'memo',
    'category',
    'category_source',
    'item',
    'is_transfer',
    'dedupe_key',
    'year_month',
  ]);
  // BIGSERIAL 과 DEFAULT NOW() 는 DB 에 맡긴다.
  assert.ok(!INSERT_COLUMNS.includes('id'));
  assert.ok(!INSERT_COLUMNS.includes('created_at'));
});

test('값은 전부 $n 파라미터로 나가고 SQL 에 문자열로 이어 붙지 않는다', () => {
  const records = fixtureRecords();
  const { text, values } = buildInsertStatement(records);

  assert.equal(values.length, records.length * INSERT_COLUMNS.length);
  // 마지막 파라미터 번호가 값 개수와 같다 — 번호가 건너뛰거나 겹치지 않는다.
  assert.ok(text.includes(`$${values.length})`));
  assert.ok(!text.includes(`$${values.length + 1}`));

  // 적요·메모 같은 텍스트가 SQL 문 안에 등장하면 안 된다.
  for (const record of records) {
    assert.ok(!text.includes(record.description), '적요가 SQL 문에 박혔다');
    if (record.memo) assert.ok(!text.includes(record.memo), '메모가 SQL 문에 박혔다');
    assert.ok(!text.includes(record.dedupe_key), 'dedupe_key 가 SQL 문에 박혔다');
  }
});

test('파라미터가 컬럼 순서대로 묶여 나간다', () => {
  const records = fixtureRecords().slice(0, 3);
  const { values } = buildInsertStatement(records);

  records.forEach((record, index) => {
    const tuple = values.slice(index * INSERT_COLUMNS.length, (index + 1) * INSERT_COLUMNS.length);
    assert.deepEqual(tuple, INSERT_COLUMNS.map((column) => record[column] ?? null));
  });
});

test('작은따옴표가 든 적요도 값으로만 나간다', () => {
  // 문자열 이어 붙이기 구현이었다면 여기서 SQL 이 깨진다.
  const nasty = { ...fixtureRecords()[0], description: `O'Brien'); DROP TABLE transactions;--` };
  const { text, values } = buildInsertStatement([nasty]);

  assert.ok(!text.includes('DROP TABLE'));
  assert.ok(values.includes(nasty.description));
});

test('레코드가 없으면 조립을 거부한다', () => {
  assert.throws(() => buildInsertStatement([]), /삽입할 레코드가 없습니다/);
});

// ── 연결 없이: 배치·멱등 동작 ──────────────────────────────────────────────

/** query 호출만 기록하는 가짜 클라이언트. 실제 연결을 열지 않는다. */
function fakeClient({ rowCountOf = (batch) => batch } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      const batch = values.length / INSERT_COLUMNS.length;
      calls.push({ text, values, batch });
      return { rowCount: rowCountOf(batch, calls.length) };
    },
  };
}

test('batchSize 만큼 나눠서 보낸다', async () => {
  const client = fakeClient();
  const result = await insertTransactions(client, fixtureRecords(), { batchSize: 10 });

  assert.deepEqual(client.calls.map((call) => call.batch), [10, 10, 4]);
  assert.deepEqual(result, { inserted: 24, skipped: 0 });
});

test('두 번째 수집은 inserted 0 · skipped 24 가 된다', async () => {
  // ON CONFLICT DO NOTHING 이면 rowCount 가 0 이다.
  const client = fakeClient({ rowCountOf: () => 0 });
  const result = await insertTransactions(client, fixtureRecords(), { batchSize: 10 });

  assert.deepEqual(result, { inserted: 0, skipped: 24 });
});

test('같은 dedupe_key 가 입력 안에 두 번 있으면 한 번만 보낸다', async () => {
  const records = fixtureRecords();
  const client = fakeClient();
  const result = await insertTransactions(client, [...records, records[0]]);

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].batch, 24);
  assert.deepEqual(result, { inserted: 24, skipped: 1 });
});

test('레코드가 없으면 쿼리를 보내지 않는다', async () => {
  const client = fakeClient();
  assert.deepEqual(await insertTransactions(client, []), { inserted: 0, skipped: 0 });
  assert.equal(client.calls.length, 0);
});

test('batchSize 가 이상하면 거부한다', async () => {
  const client = fakeClient();
  for (const batchSize of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      () => insertTransactions(client, fixtureRecords(), { batchSize }),
      /batchSize/,
      `batchSize=${String(batchSize)}`,
    );
  }
});

test('저장 실패 메시지에 행 내용이 들어가지 않는다', async () => {
  const records = fixtureRecords();
  const secret = records.find((record) => record.memo !== null);
  assert.ok(secret, 'fixture 에 메모가 있는 행이 있어야 한다');

  const client = {
    async query() {
      // pg 는 값이 섞인 message 를 내놓는다. 그대로 흘리면 안 된다.
      const error = new Error(
        `invalid input syntax for type bigint: "${secret.description}" ${secret.memo}`,
      );
      error.code = '22P02';
      error.table = 'transactions';
      throw error;
    },
  };

  await assert.rejects(
    () => insertTransactions(client, records),
    (error) => {
      assert.ok(!error.message.includes(secret.description), '적요가 새어 나왔다');
      assert.ok(!error.message.includes(secret.memo), '메모가 새어 나왔다');
      assert.ok(!error.message.includes(String(secret.amount)), '금액이 새어 나왔다');
      // 대신 어디가 문제인지는 알려 준다.
      assert.match(error.message, /1~24번째 레코드/);
      assert.match(error.message, /SQLSTATE 22P02/);
      return true;
    },
  );
});

// ── 연결 문자열 ────────────────────────────────────────────────────────────

test('DATABASE_URL 이 없으면 이름만 말하고 던진다', () => {
  for (const env of [{}, { DATABASE_URL: '' }, { DATABASE_URL: '   ' }]) {
    assert.throws(() => requireConnectionString(env), /DATABASE_URL 이 설정되지 않았습니다/);
  }
});

test('연결 문자열은 돌려주기만 하고 가공하지 않는다', () => {
  const dummy = 'postgres://user:pw@localhost:5432/db';
  assert.equal(requireConnectionString({ DATABASE_URL: dummy }), dummy);
});

// ── 실제 왕복 ──────────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * 스크래치 DB 를 쓸 수 있으면 관리용 URL 을 돌려준다. 없으면 null.
 * 운영 DB 로 새어 나가지 않도록 로컬 호스트가 아니면 거부한다.
 */
function localAdminUrl() {
  const raw = process.env.TEST_DATABASE_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  const url = new URL(raw);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    // 호스트명을 메시지에 넣지 않는다. CI 로그에서 마스킹되지 않는 식별자다.
    throw new Error('TEST_DATABASE_URL 이 로컬 호스트가 아닙니다. 왕복 테스트를 거부합니다.');
  }
  return url;
}

function runMigrations(databaseUrl) {
  return new Promise((resolve, reject) => {
    // 문자열 조합 + shell:true 는 인용 규칙이 플랫폼마다 달라서 쓰지 않는다.
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
      // 마이그레이션은 거래 데이터를 다루지 않으므로 stderr 를 그대로 봐도 된다.
      else reject(new Error(`마이그레이션 실패(exit ${code}): ${stderr.trim()}`));
    });
  });
}

test('fixture 한 달치를 두 번 저장하면 두 번째는 inserted 0 이다', async (t) => {
  const admin = localAdminUrl();
  if (admin === null) {
    t.skip('TEST_DATABASE_URL 이 없어 실제 왕복은 확인하지 않는다(로컬 Postgres 필요).');
    return;
  }

  const { default: pg } = await import('pg');
  // 이름에 실행 pid 를 넣어 같은 서버에서 여러 번 돌려도 겹치지 않게 한다.
  const scratch = `budget_agent_test_${process.pid}`;

  const adminClient = new pg.Client({ connectionString: admin.href });
  adminClient.on('error', () => {});
  await adminClient.connect();
  // 식별자는 파라미터로 넘길 수 없다. 값이 pid 로만 이뤄져 있음을 먼저 못 박는다.
  assert.match(scratch, /^[a-z_0-9]+$/);
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
    // 계좌 3개를 먼저 넣는다. id 는 SMALLSERIAL 이라 1·2·3 이 된다.
    for (const { role, last4, nickname } of ACCOUNTS) {
      await client.query(
        'INSERT INTO accounts (nickname, role, last4) VALUES ($1, $2, $3)',
        [nickname, role, last4],
      );
    }
    const seeded = await client.query('SELECT id, role, last4 FROM accounts ORDER BY id');
    assert.deepEqual(
      seeded.rows.map((row) => ({ id: row.id, role: row.role, last4: row.last4 })),
      ACCOUNTS.map(({ id, role, last4 }) => ({ id, role, last4 })),
    );

    const records = fixtureRecords();

    await client.query('BEGIN');
    const first = await insertTransactions(client, records, { batchSize: 10 });
    await client.query('COMMIT');
    assert.deepEqual(first, { inserted: 24, skipped: 0 });

    // 같은 달을 다시 수집한다(PLAN.md 검증 5).
    await client.query('BEGIN');
    const second = await insertTransactions(client, records, { batchSize: 10 });
    await client.query('COMMIT');
    assert.deepEqual(second, { inserted: 0, skipped: 24 });

    const count = await client.query('SELECT count(*)::int AS n FROM transactions');
    assert.equal(count.rows[0].n, 24);

    // 저장된 값이 KST 로 되살아난다. 서버 타임존과 무관하게 같은 순간이다.
    const stored = await client.query(
      `SELECT to_char(txn_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI:SS') AS kst,
              year_month, cp_acct_hash, category, is_transfer, balance
         FROM transactions
        ORDER BY txn_at DESC, dedupe_key`,
    );
    assert.equal(stored.rows[0].kst, '2026-08-30T14:03:33');
    assert.equal(stored.rows.at(-1).kst, '2026-08-01T03:33:28');
    assert.deepEqual([...new Set(stored.rows.map((row) => row.year_month))], ['2026-08']);
    assert.ok(stored.rows.every((row) => row.cp_acct_hash === null));
    assert.ok(stored.rows.every((row) => row.category === null));
    assert.equal(stored.rows.filter((row) => row.is_transfer).length, 2);
    // 잔액 결손은 DB 에서도 null 이다(0 이 아니다).
    assert.equal(stored.rows.filter((row) => row.balance === null).length, 1);
    // BIGINT 는 pg 가 문자열로 준다. 0 이 null 로 뭉개지지 않았는지 확인한다.
    assert.equal(stored.rows.filter((row) => row.balance === '0').length, 1);

    // 서버 타임존을 UTC 로 바꿔도 KST 로 되살린 값은 그대로다.
    await client.query("SET TIME ZONE 'UTC'");
    const utc = await client.query(
      `SELECT to_char(txn_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI:SS') AS kst
         FROM transactions ORDER BY txn_at ASC LIMIT 1`,
    );
    assert.equal(utc.rows[0].kst, '2026-08-01T03:33:28');
  } finally {
    await client.end().catch(() => {});
  }
});

test('한 건이라도 실패하면 트랜잭션이 통째로 되돌아간다', async (t) => {
  const admin = localAdminUrl();
  if (admin === null) {
    t.skip('TEST_DATABASE_URL 이 없어 실제 왕복은 확인하지 않는다(로컬 Postgres 필요).');
    return;
  }

  const { default: pg } = await import('pg');
  const scratch = `budget_agent_rollback_${process.pid}`;
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
      await client.query(
        'INSERT INTO accounts (nickname, role, last4) VALUES ($1, $2, $3)',
        [nickname, role, last4],
      );
    }

    const records = fixtureRecords();
    // 두 번째 묶음의 계좌를 등록되지 않은 id 로 바꾼다 -> 외래 키 위반.
    const broken = records.map((record, index) =>
      index >= 10 ? { ...record, account_id: 99 } : record,
    );

    await client.query('BEGIN');
    await assert.rejects(
      () => insertTransactions(client, broken, { batchSize: 10 }),
      (error) => {
        assert.match(error.message, /SQLSTATE 23503/);
        assert.match(error.message, /11~20번째 레코드/);
        return true;
      },
    );
    await client.query('ROLLBACK');

    // 앞 10건도 남아 있으면 안 된다. 한 달이 반만 들어간 상태가 가장 나쁘다.
    const count = await client.query('SELECT count(*)::int AS n FROM transactions');
    assert.equal(count.rows[0].n, 0);
  } finally {
    await client.end().catch(() => {});
  }
});
