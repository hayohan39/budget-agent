// Neon Postgres 연결 하나를 여는 공용 모듈.
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
 * 연결된 pg Client 를 돌려준다. 쓰고 나면 호출자가 `end()` 해야 한다.
 * 보통은 아래 `withClient` / `withTransaction` 을 쓰는 편이 낫다.
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

/**
 * 연결을 열고 `fn` 을 실행한 뒤 반드시 닫는다.
 *
 * @template T
 * @param {(client: import('pg').Client) => Promise<T>} fn
 * @param {{ connectionString?: string }} [options]
 * @returns {Promise<T>}
 */
export async function withClient(fn, options = {}) {
  const client = await connect(options);
  try {
    return await fn(client);
  } finally {
    // 닫기 실패는 작업 결과에 영향을 주지 않는다. 여기서 던지면 원래 에러를
    // 덮어써 원인을 잃는다.
    await client.end().catch(() => {});
  }
}

/**
 * 연결을 열고 하나의 트랜잭션 안에서 `fn` 을 실행한다.
 * `fn` 이 던지면 ROLLBACK 한다 — 한 달치가 반만 들어가는 상태를 만들지 않는다.
 *
 * @template T
 * @param {(client: import('pg').Client) => Promise<T>} fn
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
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }, options);
}
