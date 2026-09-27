// Neon Postgres 연결을 여는 공용 모듈(직결 `connect` · 풀 `withClient` / `withTransaction`).
//
// scripts/migrate.mjs 와 scripts/seed-accounts.mjs 가 각자 만들던 연결 코드를
// 한 곳으로 모은 것이다. 그 두 스크립트에서 얻은 교훈 두 가지를 여기 박아 둔다.
//
//   1. `client.on('error', ...)` 를 반드시 붙인다. 세션 도중 소켓이 끊기면 pg 는
//      대기 중인 쿼리를 reject 하면서 'error' 이벤트도 emit 한다. 리스너가 없으면
//      EventEmitter 가 그대로 throw 해서 try/catch 밖으로 빠져나가고, Node 가
//      에러 객체 전체를 스택과 함께 로그에 찍는다. 쿼리 쪽에서 같은 에러를 이미
//      처리하므로 여기서 삼켜도 정보는 사라지지 않는다. (995ad38 에서 고친 버그다.)
//   2. 에러는 `error.message` 만 쓴다. 에러 객체를 그대로 넘기면 pg 가 붙여 놓은
//      `detail` · `parameters` · 연결 설정이 함께 로그로 흘러간다.
//
// DATABASE_URL 은 읽기만 하고 어디에도 출력하지 않는다. 문자열 안에 사용자명과
// 비밀번호가 들어 있다.
import process from 'node:process';

/**
 * 연결 문자열을 환경에서 읽는다. 값은 돌려주기만 하고 로그에 남기지 않는다.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function requireConnectionString(env = process.env) {
  const connectionString = env.DATABASE_URL;
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    // 변수 이름만 말한다. 값이 일부라도 섞이면 안 된다.
    throw new Error('DATABASE_URL 이 설정되지 않았습니다.');
  }
  return connectionString;
}

/**
 * 풀을 거치지 않는 **직결** pg Client 를 돌려준다. 쓰고 나면 호출자가 `end()`
 * 해야 한다. 세션 advisory 잠금을 쓰는 scripts/migrate.mjs 전용이다 — 웹앱
 * 런타임은 아래 `withClient` / `withTransaction`(풀)을 쓴다.
 *
 * pg 는 여기서 동적으로 import 한다. 최상위에서 import 하면 DB 가 필요 없는
 * 경로(파싱·정규화 단위 테스트 등)까지 드라이버를 끌고 들어간다.
 *
 * @param {object} [options]
 * @param {string} [options.connectionString] 없으면 DATABASE_URL 에서 읽는다
 * @returns {Promise<import('pg').Client>}
 */
export async function connect(options = {}) {
  const connectionString = options.connectionString ?? requireConnectionString();
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString });
  // 위 1번. 이 리스너를 지우지 말 것.
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (error) {
    // 연결 실패. 에러 객체가 아니라 message 만 남긴다.
    throw new Error(`데이터베이스에 연결하지 못했습니다: ${error.message}`);
  }
  return client;
}

// ── 연결 풀 (2026-09) ─────────────────────────────────────────────────────
//
// 웹앱 런타임(페이지 · API 라우트)은 요청마다 새 연결을 열던 것을 멈추고, 모듈
// 수준의 작은 `pg.Pool` 을 함께 쓴다. Neon 은 TLS + 인증 왕복 때문에 새 연결
// 하나가 쿼리 몇 개보다 비싸다. Vercel Fluid compute 는 한 인스턴스가 여러 요청을
// 이어 받으므로, 따뜻한 인스턴스에서는 이미 열린 연결을 다시 쓴다.
//
// 새 의존성은 없다 — pg 에 들어 있는 pg-pool 이다.
//
// 서버리스에서 안전하도록 정한 것들:
//   - `max` 가 작다(POOL_OPTIONS). 인스턴스가 여러 개 떠도 Neon 연결 한도를
//     넘기지 않는다. 개인 가계부라 동시 요청이 몇 개뿐이다.
//   - 쉬는 연결은 곧 닫는다(`idleTimeoutMillis`). 연결 하나의 수명에도 상한을
//     둔다(`maxLifetimeSeconds`) — Neon 이 계산 노드를 재우면 서버 쪽에서 소켓이
//     끊긴다.
//   - **얼어 있던 인스턴스 대비.** 서버리스 함수는 요청 사이에 멈춘다. 멈춘 동안에는
//     위 타이머가 돌지 않아서, 깨어난 직후 풀에 "오래 쉰" 연결이 남아 있을 수 있다.
//     그래서 빌릴 때 마지막 반납 시각을 직접 보고, 너무 오래 쉰 연결은 버리고
//     새로 빌린다(`acquire`).
//   - `allowExitOnIdle` — CLI 스크립트(seed-accounts)가 풀을 써도 작업이 끝나면
//     프로세스가 그대로 끝난다.
//   - 풀의 'error' 이벤트(쉬는 연결의 소켓이 끊김)와 연결마다의 'error' 에
//     리스너를 붙인다. 없으면 위 1번과 같은 이유로 프로세스가 죽고 에러 객체
//     전체가 로그에 찍힌다.
//   - **반납할 때 트랜잭션이 끝나지 않은 연결은 버린다**(`release`). `fn` 이
//     BEGIN 뒤에 던지고 ROLLBACK 도 실패한 경우, 그 연결을 풀에 돌려주면 다음
//     요청이 남의 트랜잭션 안에서 돈다. pg 가 ReadyForQuery 로 받은 상태
//     (`getTransactionStatus()`, 'I' = 트랜잭션 밖)를 보고 'I' 가 아니면 버린다.
//
// 세션 수준 상태를 쓰지 않는다 — 연결이 요청 사이에 재사용되고, 나중에
// DATABASE_URL 을 Neon 의 pooled(-pooler, PgBouncer transaction mode) 호스트로
// 바꿔도 그대로 돌아야 하기 때문이다. 런타임 코드는
//   - `SET` 대신 필요하면 `SET LOCAL` 만 쓴다(지금은 둘 다 없다),
//   - 세션 advisory 잠금(`pg_advisory_lock`) 대신 트랜잭션 잠금
//     (`pg_advisory_xact_lock`, lib/classify/manual.mjs)만 쓴다,
//   - 이름 붙은 prepared statement(`{ name: ... }` 쿼리)를 쓰지 않는다.
// 세션 잠금을 쓰는 scripts/migrate.mjs 는 풀을 거치지 않고 `connect()` 로 직결한다.
//
// 연결 문자열은 풀을 고르는 Map 의 키로만 쓴다. 어디에도 출력하지 않는다.

/** 풀 설정. 숫자는 테스트가 확인한다. */
export const POOL_OPTIONS = Object.freeze({
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  maxLifetimeSeconds: 300,
  allowExitOnIdle: true,
});

/**
 * 이보다 오래 쉰 연결은 빌려주지 않고 버린다(위 "얼어 있던 인스턴스 대비").
 * 풀의 idleTimeoutMillis 와 같다 — 타이머가 제때 돌았다면 이미 닫혔을 연결이다.
 */
export const STALE_IDLE_MS = POOL_OPTIONS.idleTimeoutMillis;

// Next dev 서버는 모듈을 다시 읽는다(HMR). 모듈 변수에 두면 고칠 때마다 풀이
// 하나씩 늘어난다. globalThis 에 한 번만 둔다. 키는 Symbol.for 라 다른 코드와
// 부딪히지 않는다.
const POOLS_KEY = Symbol.for('budget-agent.pg-pools');

/** @returns {Map<string, import('pg').Pool>} */
function pools() {
  const holder = /** @type {Record<symbol, Map<string, import('pg').Pool>>} */ (
    /** @type {unknown} */ (globalThis)
  );
  holder[POOLS_KEY] ??= new Map();
  return holder[POOLS_KEY];
}

const RELEASED_AT = Symbol('releasedAt');

/**
 * 연결 문자열 하나에 풀 하나. 처음 부를 때 만든다.
 *
 * @param {string} connectionString
 * @returns {Promise<import('pg').Pool>}
 */
async function poolFor(connectionString) {
  const existing = pools().get(connectionString);
  if (existing !== undefined) return existing;
  const { default: pg } = await import('pg');
  // await 사이에 다른 요청이 먼저 만들었을 수 있다.
  const raced = pools().get(connectionString);
  if (raced !== undefined) return raced;
  const pool = new pg.Pool({ connectionString, ...POOL_OPTIONS });
  // 쉬는 연결의 소켓 에러. pg-pool 이 그 연결을 이미 버린다. 삼킨다(위 1번과 같은 이유).
  pool.on('error', () => {});
  // 빌려 간 동안에는 pg-pool 이 자기 리스너를 떼어 낸다. 그때 소켓이 끊기면 리스너
  // 없는 'error' 가 프로세스를 죽인다. 연결마다 영구 리스너를 하나 붙여 둔다
  // (connect() 의 `client.on('error', ...)` 와 같은 이유). 쿼리는 따로 reject 된다.
  pool.on('connect', (client) => {
    client.on('error', () => {});
  });
  pools().set(connectionString, pool);
  return pool;
}

/**
 * 풀에서 연결 하나를 빌린다. 너무 오래 쉰 연결은 버리고 다시 빌린다.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<import('pg').PoolClient>}
 */
async function acquire(pool) {
  // 풀의 연결 수보다 한 번 더 — 전부 낡았어도 마지막에는 새 연결이 온다.
  for (let attempt = 0; attempt <= POOL_OPTIONS.max; attempt += 1) {
    let client;
    try {
      client = await pool.connect();
    } catch (error) {
      // connect() 와 같은 문장. 에러 객체가 아니라 message 만 남긴다.
      throw new Error(`데이터베이스에 연결하지 못했습니다: ${error.message}`);
    }
    const releasedAt = /** @type {Record<symbol, number|undefined>} */ (/** @type {unknown} */ (client))[RELEASED_AT];
    if (releasedAt === undefined || Date.now() - releasedAt <= STALE_IDLE_MS) return client;
    client.release(true); // 버린다(풀에 돌려주지 않는다).
  }
  throw new Error('데이터베이스에 연결하지 못했습니다: 연결 풀을 비우지 못했습니다.');
}

/**
 * 빌린 연결을 돌려준다. 트랜잭션 밖(`'I'`)이 아니면 버린다.
 *
 * @param {import('pg').PoolClient} client
 */
function release(client) {
  const status = typeof client.getTransactionStatus === 'function' ? client.getTransactionStatus() : 'I';
  if (status !== 'I') {
    client.release(true);
    return;
  }
  /** @type {Record<symbol, number>} */ (/** @type {unknown} */ (client))[RELEASED_AT] = Date.now();
  client.release();
}

/**
 * 풀에서 연결을 빌려 `fn` 을 실행하고 반드시 돌려준다.
 *
 * `fn` 안에서 BEGIN 을 열었다면 `fn` 이 COMMIT/ROLLBACK 까지 끝내야 한다. 끝내지
 * 못하고 던지면 그 연결은 풀로 돌아가지 않고 버려진다(`release`).
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @param {{ connectionString?: string }} [options]
 * @returns {Promise<T>}
 */
export async function withClient(fn, options = {}) {
  const connectionString = options.connectionString ?? requireConnectionString();
  const client = await acquire(await poolFor(connectionString));
  try {
    return await fn(client);
  } finally {
    release(client);
  }
}

/**
 * 풀에서 연결 **하나**를 빌려 그 연결 위에서 하나의 트랜잭션으로 `fn` 을 실행한다.
 * `fn` 이 던지면 ROLLBACK 한다 — 한 달치가 반만 들어가는 상태를 만들지 않는다.
 * BEGIN · fn · COMMIT 이 모두 같은 연결이다(풀에 쿼리를 따로 던지지 않는다).
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @param {{ connectionString?: string }} [options]
 * @returns {Promise<T>}
 */
export async function withTransaction(fn, options = {}) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // 롤백 자체가 실패해도(연결이 이미 끊긴 경우) 원래 에러를 그대로 올린다.
      // 그 연결은 트랜잭션 상태가 'I' 가 아니라 반납할 때 버려진다.
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }, options);
}

/**
 * 모든 풀을 닫는다. 테스트 · 스크립트 정리용이다(런타임은 부르지 않는다).
 */
export async function closePools() {
  const all = [...pools().values()];
  pools().clear();
  await Promise.all(all.map((pool) => pool.end().catch(() => {})));
}
