// 업로드 -> 파싱 -> 저장 경로(lib/import/statement.mjs) 테스트.
//
// Next.js 없이 돈다. 라우트 핸들러는 인증 · multipart · 직렬화만 하는 껍데기이고
// 판단은 전부 이 모듈에 있기 때문이다.
//
// 저장은 가짜 클라이언트로 확인한다. 실제 왕복은 test/db-transactions.test.mjs
// 가 `TEST_DATABASE_URL` 이 있을 때만 돌리는 것과 같은 규칙을 따르고, 여기서는
// `DATABASE_URL` 도 `TEST_DATABASE_URL` 도 읽지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { openXlsxFile } from '../lib/xlsx/workbook.mjs';
import { parseTossStatement } from '../lib/toss/statement.mjs';
import { INSERT_COLUMNS } from '../lib/db/transactions.mjs';
import {
  IMPORT_ERROR_MESSAGES,
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  WARNING_CODES,
  checkWorkbookMagic,
  collectWarnings,
  importStatementBuffer,
} from '../lib/import/statement.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'toss-sample-masked.xlsx');

const ACCOUNTS = Object.freeze([
  { id: 1, role: 'main', last4: '1288', nickname: '메인' },
  { id: 2, role: 'fixed', last4: '2222', nickname: '고정비' },
  { id: 3, role: 'emergency', last4: '3333', nickname: '비상금' },
]);

function fixtureBuffer() {
  return readFileSync(FIXTURE);
}

/**
 * dedupe_key 를 기억하는 가짜 pg 클라이언트.
 *
 * 실제 `ON CONFLICT (dedupe_key) DO NOTHING` 과 같은 동작을 흉내 낸다:
 * 처음 보는 키만 세고, 이미 본 키는 rowCount 에 포함하지 않는다. 그래야 같은
 * 파일을 두 번 올렸을 때 두 번째가 전부 skipped 인지 확인할 수 있다.
 */
function fakeClient() {
  const stored = new Set();
  const statements = [];
  return {
    stored,
    statements,
    async query(text, values) {
      statements.push(text);
      if (values === undefined) return { rowCount: 0, rows: [] };

      const keyColumn = INSERT_COLUMNS.indexOf('dedupe_key');
      let inserted = 0;
      for (let offset = 0; offset < values.length; offset += INSERT_COLUMNS.length) {
        const key = values[offset + keyColumn];
        if (stored.has(key)) continue;
        stored.add(key);
        inserted += 1;
      }
      return { rowCount: inserted, rows: [] };
    },
  };
}

// ── 매직 바이트 분류 ───────────────────────────────────────────────────────

test('OLE2 매직으로 시작하면 암호 걸린 파일로 분류한다', () => {
  // 암호화된 OOXML 은 ZIP 이 아니라 OLE2 복합 문서다.
  const ole2 = Buffer.concat([
    Buffer.from('d0cf11e0a1b11ae1', 'hex'),
    Buffer.alloc(512, 0),
  ]);
  const result = checkWorkbookMagic(ole2);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'encrypted');
  assert.equal(result.message, IMPORT_ERROR_MESSAGES.encrypted);
  assert.match(result.message, /암호가 걸린 엑셀 파일입니다/);
});

test('정상 fixture 는 매직 검사를 통과한다', () => {
  assert.deepEqual(checkWorkbookMagic(fixtureBuffer()), { ok: true });
});

test('빈 버퍼와 임의 바이트는 각각 다른 코드로 갈린다', () => {
  assert.equal(checkWorkbookMagic(Buffer.alloc(0)).error, 'empty');
  assert.equal(checkWorkbookMagic(Buffer.from('hello world')).error, 'notXlsx');
});

// ── 실패 경로 ──────────────────────────────────────────────────────────────

test('암호 걸린 것처럼 보이는 버퍼는 던지지 않고 안내 문구로 돌아온다', async () => {
  const client = fakeClient();
  const ole2 = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(4096, 7)]);

  const result = await importStatementBuffer(ole2, { client, accounts: ACCOUNTS });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'encrypted');
  assert.equal(result.message, IMPORT_ERROR_MESSAGES.encrypted);
  // 복호화를 시도하지 않는다 — DB 로도 아무것도 가지 않는다.
  assert.equal(client.statements.length, 0);
});

test('xlsx 가 아닌 임의 바이트는 안전한 메시지로 돌아온다', async () => {
  const client = fakeClient();
  const junk = Buffer.from('이것은 엑셀이 아니다 '.repeat(64), 'utf8');

  const result = await importStatementBuffer(junk, { client, accounts: ACCOUNTS });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'notXlsx');
  assert.equal(result.message, IMPORT_ERROR_MESSAGES.notXlsx);
  assert.equal(client.statements.length, 0);
});

test('ZIP 이긴 한데 워크북이 아니면 notXlsx 로 돌아온다', async () => {
  const client = fakeClient();
  // `PK` 로 시작하지만 EOCD 가 없는 조각.
  const brokenZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 0)]);

  const result = await importStatementBuffer(brokenZip, { client, accounts: ACCOUNTS });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'notXlsx');
});

test('등록되지 않은 계좌면 뒤 4자리를 내보내지 않고 거절한다', async () => {
  const client = fakeClient();
  const others = ACCOUNTS.map((account) => ({ ...account, last4: `9${account.last4.slice(1)}` }));

  const result = await importStatementBuffer(fixtureBuffer(), { client, accounts: others });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'accountNotRegistered');
  assert.ok(!result.message.includes('1288'), '계좌 뒤 4자리가 새어 나왔다');
  assert.equal(client.statements.length, 0);
});

test('저장이 실패하면 롤백하고 saveFailed 로 돌아온다', async () => {
  const statements = [];
  const client = {
    async query(text) {
      statements.push(text.split('\n')[0]);
      if (text.startsWith('INSERT INTO transactions')) {
        const error = new Error('invalid input syntax for type bigint: "무언가"');
        error.code = '22P02';
        throw error;
      }
      return { rowCount: 0, rows: [] };
    },
  };

  const result = await importStatementBuffer(fixtureBuffer(), { client, accounts: ACCOUNTS });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'saveFailed');
  assert.equal(result.message, IMPORT_ERROR_MESSAGES.saveFailed);
  assert.ok(statements.includes('ROLLBACK'), '롤백하지 않았다');
  assert.ok(!statements.includes('COMMIT'));
  // pg 가 메시지에 넣은 값이 결과로 새어 나오지 않는다.
  assert.ok(!JSON.stringify(result).includes('무언가'));
  assert.ok(!JSON.stringify(result).includes('22P02'));
});

test('상한을 넘는 버퍼는 파싱 전에 거절한다', async () => {
  const client = fakeClient();
  const big = Buffer.alloc(MAX_FILE_BYTES + 1);
  big.write('PK');

  const result = await importStatementBuffer(big, { client, accounts: ACCOUNTS });

  assert.equal(result.error, 'tooLarge');
  assert.equal(client.statements.length, 0);
});

test('상한 상수가 Vercel 요청 본문 한도(4.5MB) 아래에 있다', () => {
  assert.equal(MAX_FILE_BYTES, 4 * 1024 * 1024);
  assert.ok(MAX_FILE_BYTES < 4.5 * 1024 * 1024);
  assert.equal(MAX_FILE_COUNT, 3);
});

// ── 성공 경로 ──────────────────────────────────────────────────────────────

test('fixture 가 한 번에 들어가고 같은 파일을 다시 올리면 전부 skipped 다', async () => {
  const client = fakeClient();
  const buffer = fixtureBuffer();

  const first = await importStatementBuffer(buffer, { client, accounts: ACCOUNTS });
  assert.equal(first.ok, true, first.message);
  assert.deepEqual(
    { inserted: first.inserted, skipped: first.skipped },
    { inserted: 24, skipped: 0 },
  );
  assert.deepEqual(first.account, { role: 'main', nickname: '메인' });
  assert.deepEqual(first.period, { from: '2026-08-01', to: '2026-08-31' });

  // 두 번째 수집(PLAN.md 검증 5).
  const second = await importStatementBuffer(buffer, { client, accounts: ACCOUNTS });
  assert.equal(second.ok, true);
  assert.deepEqual(
    { inserted: second.inserted, skipped: second.skipped },
    { inserted: 0, skipped: 24 },
  );
  assert.equal(client.stored.size, 24);
});

test('성공 결과는 트랜잭션으로 감싸여 커밋된다', async () => {
  const client = fakeClient();
  await importStatementBuffer(fixtureBuffer(), { client, accounts: ACCOUNTS });

  // 분류 규칙·가맹점 매핑 읽기는 트랜잭션 **밖**에서 먼저 일어난다(읽기뿐이다).
  // 감싸야 하는 것은 쓰기다: INSERT 는 BEGIN 과 COMMIT 사이에 있어야 한다.
  const begin = client.statements.indexOf('BEGIN');
  const insert = client.statements.findIndex((text) => text.startsWith('INSERT INTO transactions'));
  assert.ok(begin !== -1, 'BEGIN 이 없다');
  assert.ok(insert > begin, 'INSERT 가 BEGIN 앞에 있다');
  assert.ok(
    client.statements.slice(0, begin).every((text) => text.startsWith('SELECT')),
    '트랜잭션 시작 전에 쓰기 문장이 나갔다',
  );
  assert.equal(client.statements.at(-1), 'COMMIT');
});

test('fixture 의 경고 코드가 올라온다', () => {
  const statement = parseTossStatement(openXlsxFile(FIXTURE).sheet(0));
  const warnings = collectWarnings(statement);

  // fixture 에는 같은 초 충돌 4묶음과 잔액이 빠진 행(H18) 하나가 있다.
  assert.ok(warnings.includes(WARNING_CODES.timestampTies));
  assert.ok(warnings.includes(WARNING_CODES.balanceMissing));
  // 잔액 검산은 결손 행을 건너뛰고 나머지 21쌍이 맞는다 -> 불일치 경고는 없다.
  assert.ok(!warnings.includes(WARNING_CODES.balanceMismatch));
  // 10만 건 상한에 한참 못 미친다.
  assert.ok(!warnings.includes(WARNING_CODES.truncationSuspected));
  // 코드는 전부 알려진 값이어야 한다.
  for (const code of warnings) {
    assert.ok(Object.values(WARNING_CODES).includes(code), `알 수 없는 경고 코드: ${code}`);
  }
});

// ── 결과 객체에 거래 내용이 없다 ───────────────────────────────────────────

test('직렬화한 결과에 적요·메모·금액·잔액·계좌 뒤 4자리가 들어 있지 않다', async () => {
  const client = fakeClient();
  const result = await importStatementBuffer(fixtureBuffer(), { client, accounts: ACCOUNTS });
  assert.equal(result.ok, true);

  const serialized = JSON.stringify(result);
  const statement = parseTossStatement(openXlsxFile(FIXTURE).sheet(0));

  // 계좌 뒤 4자리.
  assert.ok(!serialized.includes(statement.account.last4), '계좌 뒤 4자리가 새어 나왔다');

  for (const row of statement.rows) {
    if (row.description !== '') {
      assert.ok(!serialized.includes(row.description), `적요가 새어 나왔다`);
    }
    if (row.memo !== '') {
      assert.ok(!serialized.includes(row.memo), '메모가 새어 나왔다');
    }
    if (row.institution !== '') {
      assert.ok(!serialized.includes(row.institution), '거래 기관이 새어 나왔다');
    }
    // 금액·잔액. 건수(24 · 0)와 겹치지 않을 만큼 큰 값만 본다.
    if (Math.abs(row.amount) > 1000) {
      assert.ok(!serialized.includes(String(row.amount)), '금액이 새어 나왔다');
      assert.ok(!serialized.includes(String(Math.abs(row.amount))), '금액이 새어 나왔다');
    }
    if (row.balance !== null && Math.abs(row.balance) > 1000) {
      assert.ok(!serialized.includes(String(row.balance)), '잔액이 새어 나왔다');
    }
    // 행 단위 시각. 조회기간(월 경계)은 허용하지만 개별 거래의 일시는 아니다.
    assert.ok(!serialized.includes(row.datetime.iso), '거래 일시가 새어 나왔다');
  }

  // 허용된 키만 있는지도 못 박는다.
  assert.deepEqual(Object.keys(result).sort(), [
    'account',
    'inserted',
    'ok',
    'period',
    'skipped',
    'warnings',
  ]);
  assert.deepEqual(Object.keys(result.account).sort(), ['nickname', 'role']);
});

test('실패 결과에도 파일 내용이 들어가지 않는다', async () => {
  const client = fakeClient();
  const others = ACCOUNTS.map((account) => ({ ...account, last4: `9${account.last4.slice(1)}` }));
  const result = await importStatementBuffer(fixtureBuffer(), { client, accounts: others });

  const serialized = JSON.stringify(result);
  const statement = parseTossStatement(openXlsxFile(FIXTURE).sheet(0));
  assert.ok(!serialized.includes(statement.account.last4));
  for (const row of statement.rows) {
    if (row.description !== '') assert.ok(!serialized.includes(row.description));
  }
  assert.deepEqual(Object.keys(result).sort(), ['error', 'message', 'ok']);
});
