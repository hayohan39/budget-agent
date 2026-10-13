// GET /api/health 의 본체. 배포 직후 deploy.yml 이 로그인 없이 부른다.
//
// 이 앱에서 로그인 없이 열린 유일한 API 다(middleware.ts matcher 예외). 그래서
// 앱에 대해 알려 주는 것을 최소로 둔다: 커밋 7자리와 DB 연결 여부(ok/error)뿐이다.
// 오류 메시지 · 지연 시간 · 마이그레이션 수 · 거래 건수 같은 것은 내보내지 않는다.
// 에러 객체도 출력하지 않는다(연결 문자열의 호스트·사용자명이 섞일 수 있다).
import process from 'node:process';

/**
 * @param {{
 *   withClient: (fn: (client: { query: (sql: string) => Promise<unknown> }) => Promise<unknown>) => Promise<unknown>,
 *   env?: Record<string, string | undefined>,
 * }} deps
 * @returns {Promise<{ ok: boolean, database: 'ok' | 'error' | 'not-configured', commit: string | null }>}
 */
export async function checkHealth({ withClient, env = process.env }) {
  /** @type {'ok' | 'error' | 'not-configured'} */
  let database = 'not-configured';
  if (env.DATABASE_URL) {
    try {
      await withClient((client) => client.query('select 1'));
      database = 'ok';
    } catch {
      database = 'error';
    }
  }
  return {
    // DB 를 아직 연결하지 않은 것은 장애가 아니다. 연결했는데 실패한 것만 장애로 본다.
    ok: database !== 'error',
    database,
    commit: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  };
}
