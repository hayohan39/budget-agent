// 정규화된 레코드를 transactions 에 멱등하게 저장한다.
//
// 같은 달을 두 번 수집해도 두 번째는 `inserted: 0` 이어야 한다(PLAN.md 검증 5).
// `dedupe_key` 가 UNIQUE 이므로 `ON CONFLICT (dedupe_key) DO NOTHING` 이 그
// 보장을 DB 에서 직접 해 준다 — 애플리케이션에서 먼저 조회해 비교하는 방식은
// 조회와 삽입 사이에 다른 요청이 끼면 깨진다.
//
// 로그에는 **건수만** 남긴다. 행 내용은 어떤 경로로도 출력하지 않는다.
import { withTransaction } from './client.mjs';

/**
 * 삽입하는 컬럼. 순서가 곧 파라미터 순서다.
 * `id` 와 `created_at` 은 DB 기본값에 맡긴다.
 */
export const INSERT_COLUMNS = Object.freeze([
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
  // 분류기가 채운다(lib/classify/engine.mjs 의 classifyRecords). 매핑이 걸렸으면
  // 'map' 과 매핑의 항목, 규칙이 걸렸으면 'rule' 과 null, 미분류면 둘 다 null.
  'category_source',
  'item',
  'is_transfer',
  'dedupe_key',
  'year_month',
]);

/**
 * 한 번의 INSERT 에 넣을 최대 행 수.
 *
 * Postgres 확장 프로토콜의 파라미터 상한은 65535 개다. 컬럼이 15 개이므로
 * 이론상 4369 행까지 되지만, 한 번에 보내는 쿼리 문자열과 파라미터 배열이
 * 커질수록 실패했을 때 어느 행이 문제인지 좁히기 어렵다. 넉넉히 여유를 둔다.
 */
export const DEFAULT_BATCH_SIZE = 500;

/**
 * 레코드 묶음 하나를 파라미터화된 INSERT 문으로 만든다.
 *
 * 값은 전부 `$n` 으로 나간다. SQL 문자열에 값을 이어 붙이지 않는다 — 적요에
 * 따옴표가 들어 있는 것만으로도 깨지고, 그 경로는 그대로 인젝션이 된다.
 *
 * @param {Array<Record<string, unknown>>} records
 * @returns {{ text: string, values: unknown[] }}
 */
export function buildInsertStatement(records) {
  if (records.length === 0) {
    throw new Error('삽입할 레코드가 없습니다.');
  }

  const values = [];
  const tuples = records.map((record) => {
    const placeholders = INSERT_COLUMNS.map((column) => {
      values.push(record[column] ?? null);
      return `$${values.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });

  const text =
    `INSERT INTO transactions (${INSERT_COLUMNS.join(', ')})\n` +
    `VALUES ${tuples.join(', ')}\n` +
    `ON CONFLICT (dedupe_key) DO NOTHING`;

  return { text, values };
}

/**
 * 같은 dedupe_key 가 입력 안에 두 번 나오면 첫 번째만 남긴다.
 *
 * 한 문장 안의 중복까지 `ON CONFLICT DO NOTHING` 에 맡기지 않고 여기서
 * 먼저 거른다. 결과 건수가 DB 구현 세부에 기대지 않게 하려는 것이다.
 * 걸러진 행은 `skipped` 로 잡힌다(= 입력 건수 - 실제로 들어간 건수).
 *
 * @param {Array<{dedupe_key: string}>} records
 */
function dedupeWithin(records) {
  const seen = new Set();
  const unique = [];
  for (const record of records) {
    if (seen.has(record.dedupe_key)) continue;
    seen.add(record.dedupe_key);
    unique.push(record);
  }
  return unique;
}

/**
 * pg 에러를 값이 새지 않는 형태로 바꾼다.
 *
 * ⚠️ 여기서는 `error.message` 조차 쓰지 않는다. 다른 곳(연결 실패 등)과 다른
 *    이유다 — 이 경로의 에러 메시지에는 거래 값이 섞여 나온다. 예를 들어
 *    `invalid input syntax for type bigint: "..."` 는 문제가 된 값을 메시지
 *    본문에 그대로 넣는다. 그래서 SQLSTATE 코드와 제약·컬럼 이름만 남긴다.
 *    이 셋은 스키마의 이름이지 거래 데이터가 아니다.
 */
function redactDbError(error, what) {
  const parts = [];
  if (typeof error?.code === 'string') parts.push(`SQLSTATE ${error.code}`);
  if (typeof error?.constraint === 'string') parts.push(`제약 ${error.constraint}`);
  if (typeof error?.column === 'string') parts.push(`컬럼 ${error.column}`);
  if (typeof error?.table === 'string') parts.push(`테이블 ${error.table}`);
  return new Error(`${what} (${parts.join(', ') || '원인을 식별할 수 없습니다'})`);
}

/**
 * 이미 열려 있는 연결에 레코드를 삽입한다. 트랜잭션은 호출자가 잡는다.
 *
 * @param {import('pg').Client} client
 * @param {Array<Record<string, unknown>>} records
 * @param {{ batchSize?: number }} [options]
 * @returns {Promise<{ inserted: number, skipped: number }>}
 */
export async function insertTransactions(client, records, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize 는 1 이상의 정수여야 합니다.');
  }
  if (records.length === 0) return { inserted: 0, skipped: 0 };

  const unique = dedupeWithin(records);

  let inserted = 0;
  for (let offset = 0; offset < unique.length; offset += batchSize) {
    const batch = unique.slice(offset, offset + batchSize);
    const { text, values } = buildInsertStatement(batch);
    let result;
    try {
      result = await client.query(text, values);
    } catch (error) {
      // 몇 번째 묶음인지만 알린다. 행 내용은 넣지 않는다.
      throw redactDbError(
        error,
        `거래 저장에 실패했습니다: ${offset + 1}~${offset + batch.length}번째 레코드`,
      );
    }
    // ON CONFLICT DO NOTHING 이라 rowCount 는 실제로 들어간 행 수다.
    inserted += result.rowCount;
  }

  // skipped = 이미 저장돼 있던 건 + 입력 안의 중복. 둘 다 "새로 쓰지 않은 건"이다.
  return { inserted, skipped: records.length - inserted };
}

/**
 * 한 번의 수집을 하나의 트랜잭션으로 저장한다.
 *
 * 중간에 실패하면 전부 되돌린다. 한 달치가 반만 들어간 상태는 잔액 검산이
 * 어긋나는데 원인은 파일이 아니라 저장 실패라서, 나중에 원인을 되짚기가
 * 가장 어려운 형태의 오류다.
 *
 * @param {Array<Record<string, unknown>>} records
 * @param {{ batchSize?: number, connectionString?: string }} [options]
 * @returns {Promise<{ inserted: number, skipped: number }>}
 */
export async function importTransactions(records, options = {}) {
  const { batchSize, ...connection } = options;
  return withTransaction(
    (client) => insertTransactions(client, records, { batchSize }),
    connection,
  );
}
