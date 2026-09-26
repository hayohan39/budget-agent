// 미리보기(저장하지 않는 dry run) · 적용 경로 테스트.
//
// 두 층이다.
//   1. 가짜 클라이언트 — 미리보기가 SELECT 말고는 아무것도 보내지 않는다는 것,
//      건수가 맞는다는 것, 결과에 거래 내용 · 비밀번호가 없다는 것. 항상 돈다.
//   2. 실제 왕복 — 스크래치 DB 에서 미리보기 -> 적용 -> 다시 미리보기.
//      `TEST_DATABASE_URL` 이 있을 때만 돈다.
//
// ⚠️ `DATABASE_URL` 은 읽지 않는다. 운영 Neon 을 가리키는 값이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openXlsxFile } from '../lib/xlsx/workbook.mjs';
import { parseTossStatement } from '../lib/toss/statement.mjs';
import { INSERT_COLUMNS } from '../lib/db/transactions.mjs';
import {
  EXISTING_KEYS_QUERY,
  IMPORT_ERROR_MESSAGES,
  MAX_FILE_BYTES,
  importStatementBuffer,
  previewStatementBuffer,
} from '../lib/import/statement.mjs';
import { encryptAgile, encryptStandard } from './helpers/ooxml-encrypt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'toss-sample-masked.xlsx');

const ACCOUNTS = Object.freeze([
  { id: 1, role: 'main', last4: '1288', nickname: '메인' },
  { id: 2, role: 'fixed', last4: '2222', nickname: '고정비' },
  { id: 3, role: 'emergency', last4: '3333', nickname: '비상금' },
]);

/** 이 파일에서 쓰는 "진짜처럼 보이는" 비밀번호. 결과 어디에도 없어야 한다. */
const FILE_PASSWORD = 'Toss-4f!2Lm';

function fixtureBuffer() {
  return readFileSync(FIXTURE);
}

/**
 * transactions · 분류 규칙을 흉내 내는 가짜 pg 클라이언트.
 *
 * 받은 문장을 전부 기록한다. 미리보기가 무엇을 보냈는지 그대로 확인하려는 것이다.
 *
 * @param {{ rules?: Array<object>, failLookup?: boolean }} [options]
 */
function recordingClient({ rules = [], failLookup = false } = {}) {
  const stored = new Set();
  const statements = [];
  return {
    stored,
    statements,
    async query(text, values) {
      statements.push(text);
      if (text.includes('FROM category_rules')) return { rows: rules.map((rule) => ({ ...rule })) };
      if (text.includes('FROM merchant_map')) return { rows: [] };
      if (text === EXISTING_KEYS_QUERY) {
        if (failLookup) {
          const error = new Error(`무언가 ${values[0][0]}`);
          error.code = '57P01';
          throw error;
        }
        return { rows: values[0].filter((key) => stored.has(key)).map((key) => ({ dedupe_key: key })) };
      }
      if (text.startsWith('INSERT INTO transactions')) {
        const keyColumn = INSERT_COLUMNS.indexOf('dedupe_key');
        let inserted = 0;
        for (let offset = 0; offset < values.length; offset += INSERT_COLUMNS.length) {
          const key = values[offset + keyColumn];
          if (stored.has(key)) continue;
          stored.add(key);
          inserted += 1;
        }
        return { rowCount: inserted, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

/** 쓰기로 볼 수 있는 문장. 미리보기에서는 하나도 나오면 안 된다. */
const WRITE_OR_TX = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|TRUNCATE|DROP|ALTER|CREATE|GRANT|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|COPY|LOCK)\b/i;

function assertReadOnly(statements) {
  assert.ok(statements.length > 0, '아무 문장도 나가지 않았다(가짜가 연결되지 않았다)');
  for (const text of statements) {
    assert.match(text.trimStart(), /^SELECT\s/, `SELECT 가 아닌 문장이 나갔다: ${text.split('\n')[0]}`);
    assert.doesNotMatch(text, WRITE_OR_TX, `쓰기 · 트랜잭션 문장이 섞였다: ${text.split('\n')[0]}`);
  }
}

// ── 미리보기는 쓰지 않는다 ─────────────────────────────────────────────────

test('미리보기는 SELECT 만 보낸다 (INSERT/UPDATE/DELETE/BEGIN 없음)', async () => {
  const client = recordingClient();
  const result = await previewStatementBuffer(fixtureBuffer(), { client, accounts: ACCOUNTS });

  assert.equal(result.ok, true, result.message);
  assertReadOnly(client.statements);
  // "이미 있는가" 조회가 실제로 나갔다.
  assert.ok(client.statements.includes(EXISTING_KEYS_QUERY));
  assert.equal(client.stored.size, 0, '미리보기가 무언가를 저장했다');
});

test('암호가 걸린 파일의 미리보기도 SELECT 만 보낸다', async () => {
  const client = recordingClient();
  const blob = encryptAgile(fixtureBuffer(), FILE_PASSWORD);
  const result = await previewStatementBuffer(blob, {
    client,
    accounts: ACCOUNTS,
    password: FILE_PASSWORD,
  });

  assert.equal(result.ok, true, result.message);
  assertReadOnly(client.statements);
});

test('미리보기를 여러 번 해도 아무것도 쌓이지 않는다', async () => {
  const client = recordingClient();
  for (let i = 0; i < 3; i += 1) {
    const result = await previewStatementBuffer(fixtureBuffer(), { client, accounts: ACCOUNTS });
    assert.equal(result.newCount, 24);
  }
  assert.equal(client.stored.size, 0);
  assertReadOnly(client.statements);
});

test('실패하는 미리보기도 쓰지 않는다', async () => {
  const others = ACCOUNTS.map((account) => ({ ...account, last4: `9${account.last4.slice(1)}` }));
  const client = recordingClient();
  const result = await previewStatementBuffer(fixtureBuffer(), { client, accounts: others });

  assert.equal(result.error, 'accountNotRegistered');
  // 계좌 해석에서 멈췄으므로 DB 로는 아무것도 가지 않았다.
  assert.equal(client.statements.length, 0);
});

// ── 건수 ───────────────────────────────────────────────────────────────────

test('빈 DB 에 대한 미리보기는 전부 신규다', async () => {
  const result = await previewStatementBuffer(fixtureBuffer(), {
    client: recordingClient(),
    accounts: ACCOUNTS,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.account, { role: 'main', nickname: '메인' });
  assert.deepEqual(result.period, { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(
    { total: result.total, newCount: result.newCount, existingCount: result.existingCount },
    { total: 24, newCount: 24, existingCount: 0 },
  );
  // 규칙이 하나도 없으므로 전부 미분류 예상이다.
  assert.equal(result.unclassified, 24);
});

test('한 번 적용한 파일을 미리보기하면 전부 "이미 있음" 이다', async () => {
  const client = recordingClient();
  const applied = await importStatementBuffer(fixtureBuffer(), { client, accounts: ACCOUNTS });
  assert.equal(applied.inserted, 24);

  const before = client.statements.length;
  const preview = await previewStatementBuffer(fixtureBuffer(), { client, accounts: ACCOUNTS });

  assert.equal(preview.ok, true);
  assert.deepEqual(
    { total: preview.total, newCount: preview.newCount, existingCount: preview.existingCount },
    { total: 24, newCount: 0, existingCount: 24 },
  );
  assertReadOnly(client.statements.slice(before));
});

test('미리보기 다음 적용은 실제로 쓰고, 미리보기와 같은 건수가 된다', async () => {
  const client = recordingClient();
  const preview = await previewStatementBuffer(fixtureBuffer(), { client, accounts: ACCOUNTS });
  const applied = await importStatementBuffer(fixtureBuffer(), { client, accounts: ACCOUNTS });

  assert.equal(applied.ok, true, applied.message);
  assert.equal(applied.inserted, preview.newCount);
  assert.equal(applied.skipped, preview.existingCount);
  assert.equal(applied.unclassified, preview.unclassified);
  assert.deepEqual(applied.warnings, preview.warnings);
  assert.equal(client.stored.size, 24);
  // 적용은 트랜잭션 안에서 썼다.
  assert.ok(client.statements.includes('BEGIN'));
  assert.equal(client.statements.at(-1), 'COMMIT');
});

test('미분류 예상 건수는 분류 규칙을 반영한다', async () => {
  // 한 글자라도 있으면 걸리는 규칙. 무한 수량자가 없어 pattern.mjs 가 받는다.
  const rules = [{ id: 1, txn_type: null, pattern: '.', sign: null, category: '기타', priority: 1 }];
  const result = await previewStatementBuffer(fixtureBuffer(), {
    client: recordingClient({ rules }),
    accounts: ACCOUNTS,
  });

  assert.equal(result.ok, true);
  assert.ok(result.unclassified < result.total, '규칙이 반영되지 않았다');
});

test('"이미 있는가" 조회가 실패하면 previewFailed 로 돌아오고 원인은 새지 않는다', async () => {
  const client = recordingClient({ failLookup: true });
  const result = await previewStatementBuffer(fixtureBuffer(), { client, accounts: ACCOUNTS });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'previewFailed');
  assert.equal(result.message, IMPORT_ERROR_MESSAGES.previewFailed);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('무언가'));
  assert.ok(!serialized.includes('57P01'));
  assertReadOnly(client.statements);
});

// ── 결과에 거래 내용 · 비밀번호가 없다 ─────────────────────────────────────

test('미리보기 결과에는 허용된 키만 있고 거래 내용이 없다', async () => {
  const result = await previewStatementBuffer(fixtureBuffer(), {
    client: recordingClient(),
    accounts: ACCOUNTS,
  });

  assert.deepEqual(Object.keys(result).sort(), [
    'account',
    'existingCount',
    'newCount',
    'ok',
    'period',
    'total',
    'unclassified',
    'warnings',
  ]);
  assert.deepEqual(Object.keys(result.account).sort(), ['nickname', 'role']);

  const serialized = JSON.stringify(result);
  const statement = parseTossStatement(openXlsxFile(FIXTURE).sheet(0));
  assert.ok(!serialized.includes(statement.account.last4), '계좌 뒤 4자리가 새어 나왔다');
  for (const row of statement.rows) {
    if (row.description !== '') assert.ok(!serialized.includes(row.description), '적요가 새어 나왔다');
    if (row.memo !== '') assert.ok(!serialized.includes(row.memo), '메모가 새어 나왔다');
    if (Math.abs(row.amount) > 1000) {
      assert.ok(!serialized.includes(String(Math.abs(row.amount))), '금액이 새어 나왔다');
    }
    assert.ok(!serialized.includes(row.datetime.iso), '거래 일시가 새어 나왔다');
  }
});

test('미리보기에서 틀린 비밀번호는 wrongPassword 로 돌아오고 비밀번호는 어디에도 없다', async () => {
  for (const encrypt of [encryptAgile, encryptStandard]) {
    const blob = encrypt(fixtureBuffer(), FILE_PASSWORD);
    const wrong = '아주-틀린-비밀번호';
    const client = recordingClient();

    const result = await previewStatementBuffer(blob, { client, accounts: ACCOUNTS, password: wrong });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'wrongPassword');
    assert.equal(result.message, IMPORT_ERROR_MESSAGES.wrongPassword);
    assert.deepEqual(Object.keys(result).sort(), ['error', 'message', 'ok']);
    const serialized = JSON.stringify(result);
    for (const password of [wrong, FILE_PASSWORD]) {
      assert.equal(serialized.includes(password), false, '비밀번호가 결과에 새어 나왔다');
      assert.equal(serialized.includes(Buffer.from(password).toString('base64')), false);
      assert.equal(serialized.includes(encodeURIComponent(password)), false);
    }
    // 비밀번호 검증에서 멈췄다. DB 로는 아무것도 가지 않았다.
    assert.equal(client.statements.length, 0);
  }
});

test('맞는 비밀번호로 푼 미리보기는 평문 미리보기와 같다', async () => {
  const plain = await previewStatementBuffer(fixtureBuffer(), {
    client: recordingClient(),
    accounts: ACCOUNTS,
  });
  const result = await previewStatementBuffer(encryptStandard(fixtureBuffer(), FILE_PASSWORD), {
    client: recordingClient(),
    accounts: ACCOUNTS,
    password: FILE_PASSWORD,
  });
  assert.deepEqual(result, plain);
  assert.equal(JSON.stringify(result).includes(FILE_PASSWORD), false);
});

test('비밀번호 없이 암호 걸린 파일을 미리보기하면 encrypted 다', async () => {
  const client = recordingClient();
  const result = await previewStatementBuffer(encryptAgile(fixtureBuffer(), FILE_PASSWORD), {
    client,
    accounts: ACCOUNTS,
  });
  assert.equal(result.error, 'encrypted');
  assert.equal(client.statements.length, 0);
});

test('미리보기도 상한을 넘는 버퍼는 파싱 전에 거절한다', async () => {
  const client = recordingClient();
  const big = Buffer.alloc(MAX_FILE_BYTES + 1);
  big.write('PK');
  const result = await previewStatementBuffer(big, { client, accounts: ACCOUNTS });
  assert.equal(result.error, 'tooLarge');
  assert.equal(client.statements.length, 0);
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

test('실제 DB: 미리보기는 쓰지 않고, 적용은 쓰고, 다시 미리보기하면 전부 이미 있음이다', async (t) => {
  const admin = localAdminUrl();
  if (admin === null) {
    t.skip('TEST_DATABASE_URL 이 없어 실제 왕복은 확인하지 않는다(로컬 Postgres 필요).');
    return;
  }

  const { default: pg } = await import('pg');
  const scratch = `budget_agent_preview_${process.pid}`;
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

  const raw = new pg.Client({ connectionString: scratchUrl.href });
  raw.on('error', () => {});
  await raw.connect();
  try {
    for (const { role, last4, nickname } of ACCOUNTS) {
      await raw.query('INSERT INTO accounts (nickname, role, last4) VALUES ($1, $2, $3)', [
        nickname,
        role,
        last4,
      ]);
    }

    // 실제 연결 위에 문장을 기록하는 얇은 껍데기를 씌운다.
    const statements = [];
    const client = {
      query(text, values) {
        statements.push(text);
        return raw.query(text, values);
      },
    };
    const count = async () =>
      (await raw.query('SELECT count(*)::int AS n FROM transactions')).rows[0].n;

    const blob = encryptAgile(fixtureBuffer(), FILE_PASSWORD);

    const preview = await previewStatementBuffer(blob, {
      client,
      accounts: ACCOUNTS,
      password: FILE_PASSWORD,
    });
    assert.equal(preview.ok, true, preview.message);
    assert.deepEqual(
      { total: preview.total, newCount: preview.newCount, existingCount: preview.existingCount },
      { total: 24, newCount: 24, existingCount: 0 },
    );
    // 시드 규칙으로 16건이 분류되고 8건이 남는다(test/classify-store.test.mjs 와 같다).
    assert.equal(preview.unclassified, 8);
    assertReadOnly(statements);
    assert.equal(await count(), 0, '미리보기가 DB 에 썼다');

    const applied = await importStatementBuffer(blob, {
      client,
      accounts: ACCOUNTS,
      password: FILE_PASSWORD,
    });
    assert.equal(applied.ok, true, applied.message);
    assert.deepEqual({ inserted: applied.inserted, skipped: applied.skipped }, { inserted: 24, skipped: 0 });
    assert.equal(applied.unclassified, 8);
    assert.equal(await count(), 24);

    statements.length = 0;
    const again = await previewStatementBuffer(fixtureBuffer(), { client, accounts: ACCOUNTS });
    assert.deepEqual(
      { total: again.total, newCount: again.newCount, existingCount: again.existingCount },
      { total: 24, newCount: 0, existingCount: 24 },
    );
    assertReadOnly(statements);
    assert.equal(await count(), 24);
  } finally {
    await raw.end().catch(() => {});
  }
});
