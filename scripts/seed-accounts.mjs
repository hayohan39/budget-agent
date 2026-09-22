// 계좌 3개(메인 · 고정비 · 비상금)를 accounts 에 등록한다.
//
//   ACCOUNT_LAST4_MAIN / ACCOUNT_LAST4_FIXED / ACCOUNT_LAST4_EMERGENCY 환경변수
//   또는
//   npm run accounts:seed -- main=1234 fixed=5678 emergency=9012
//
// 계좌번호 뒤 4자리는 코드에도 마이그레이션에도 하드코딩하지 않는다. 실행할
// 때 환경변수로 받고(셋 다 없으면 CLI 인자로 폴백), 로그에는 숫자를 남기지
// 않는다(건수와 역할만 출력한다).
//
// 환경변수를 우선하는 이유: `npm run` 은 실행 전에 해석된 명령줄을 로그에
// 그대로 출력한다. CI 에서 인자로 넘기면 GitHub 마스킹이 유일한 방어선이 되는데
// CI 로그는 영구 저장되므로 한 번 새면 되돌릴 수 없다. 환경변수는 애초에
// echo 되지 않는다.
//
// 같은 값으로 여러 번 돌려도 안전하다(ON CONFLICT).
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// role -> nickname. accounts.role / accounts.nickname 은 각각 UNIQUE 다.
const NICKNAMES = new Map([
  ['main', '메인'],
  ['fixed', '고정비'],
  ['emergency', '비상금'],
]);

// role -> 환경변수 이름.
const ENV_NAMES = new Map([
  ['main', 'ACCOUNT_LAST4_MAIN'],
  ['fixed', 'ACCOUNT_LAST4_FIXED'],
  ['emergency', 'ACCOUNT_LAST4_EMERGENCY'],
]);

const USAGE = [
  '환경변수: ACCOUNT_LAST4_MAIN · ACCOUNT_LAST4_FIXED · ACCOUNT_LAST4_EMERGENCY (각 4자리)',
  '또는: npm run accounts:seed -- main=<4자리> fixed=<4자리> emergency=<4자리>',
].join('\n');

// 검증은 환경변수 경로와 CLI 경로가 똑같이 거친다. 에러 메시지에는 역할 이름만
// 넣고 값 자체는 절대 넣지 않는다(자릿수도 출력하지 않는다).
function toAccounts(seen) {
  for (const [role, value] of seen) {
    // 뒤 4자리 정확히. 로그와 에러 메시지에 값 자체를 넣지 않는다.
    if (!/^[0-9]{4}$/.test(value)) {
      throw new Error(`"${role}" 값이 4자리 숫자가 아닙니다. 계좌번호 뒤 4자리만 넣으세요.\n${USAGE}`);
    }
  }

  const missing = [...NICKNAMES.keys()].filter((role) => !seen.has(role));
  if (missing.length > 0) {
    throw new Error(`역할이 빠졌습니다: ${missing.join(', ')}\n${USAGE}`);
  }

  // last4 는 계좌 식별 키다. 겹치면 파일이 어느 계좌 것인지 판별할 수 없다.
  if (new Set(seen.values()).size !== seen.size) {
    throw new Error('계좌 뒤 4자리가 서로 달라야 합니다. 겹치는 값이 있습니다.');
  }

  return [...seen].map(([role, last4]) => ({ role, last4, nickname: NICKNAMES.get(role) }));
}

// 환경변수 경로. 셋이 모두 채워져 있을 때만 쓰고, 하나라도 비어 있으면 null 을
// 돌려 CLI 인자 폴백에 맡긴다.
export function parseEnv(env) {
  const seen = new Map();
  for (const [role, name] of ENV_NAMES) {
    const value = env[name];
    if (typeof value !== 'string') {
      return null;
    }
    // GitHub 시크릿 UI 에 값을 붙여넣으면 끝에 개행이나 공백이 딸려 오는 일이
    // 흔하다. 그대로 검증하면 "4자리를 넣었는데 4자리가 아니라고 한다"는
    // 혼란스러운 실패가 된다. 여기서 한 번 다듬는다(CLI 경로는 그대로 둔다).
    const trimmed = value.trim();
    // 다듬고 나서 비었으면 아예 없는 것과 똑같이 취급해 CLI 폴백에 맡긴다.
    if (trimmed === '') {
      return null;
    }
    seen.set(role, trimmed);
  }
  return toAccounts(seen);
}

export function parseArgs(argv) {
  const seen = new Map();
  for (const [index, arg] of argv.entries()) {
    const match = /^([a-z]+)=(.*)$/.exec(arg);
    if (!match) {
      // 토큰 전체(`역할=값`)를 되비추면 계좌 뒤 4자리가 그대로 stderr 에 찍힌다.
      // 정규식이 개행에 매치되지 않으므로 값에 개행이 섞이면 4자리 검사 대신
      // 이 경로로 빠진다 — 값은 넣지 말고 몇 번째 인자인지만 알린다.
      throw new Error(
        `${index + 1}번째 인자의 형식이 올바르지 않습니다. 역할=<4자리> 형태여야 합니다.\n${USAGE}`,
      );
    }
    // role 은 `[a-z]+` 캡처라 숫자도 개행도 들어갈 수 없다. 값이 섞여 나올 수
    // 없으므로 아래 두 에러에서는 역할 이름을 그대로 써도 안전하다.
    const [, role, value] = match;
    if (!NICKNAMES.has(role)) {
      throw new Error(
        `알 수 없는 역할: "${role}" (가능한 값: ${[...NICKNAMES.keys()].join(', ')})\n${USAGE}`,
      );
    }
    if (seen.has(role)) {
      throw new Error(`역할이 중복되었습니다: "${role}"`);
    }
    seen.set(role, value);
  }

  return toAccounts(seen);
}

// 환경변수가 우선. 셋 다 없으면 기존 CLI 인자 방식으로 폴백한다.
export function resolveAccounts(env, argv) {
  return parseEnv(env) ?? parseArgs(argv);
}

async function seed(accounts) {
  const { default: pg } = await import('pg');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL 이 설정되지 않았습니다.');
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const { role, last4, nickname } of accounts) {
      // role 이 UNIQUE 이므로 역할 기준으로 갱신한다. 같은 값으로 다시 돌리면
      // 아무것도 바뀌지 않고, 뒤 4자리가 바뀌었으면 그 값으로 맞춘다.
      await client.query(
        `INSERT INTO accounts (nickname, role, last4)
         VALUES ($1, $2, $3)
         ON CONFLICT (role) DO UPDATE SET nickname = EXCLUDED.nickname, last4 = EXCLUDED.last4`,
        [nickname, role, last4],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    // 에러 객체를 그대로 출력하지 않고 message 만 쓴다. pg 에러의 detail ·
    // parameters 에는 계좌 뒤 4자리가 섞여 나올 수 있다.
    throw new Error(`계좌 등록에 실패했습니다: ${error.message}`);
  } finally {
    await client.end();
  }
}

// 다른 모듈에서 import 할 때는 실행하지 않는다(테스트용).
// Windows 에서 `file://C:\...` 는 깨지므로 pathToFileURL 로 변환해서 비교한다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const accounts = resolveAccounts(process.env, process.argv.slice(2));
    await seed(accounts);
    console.log(`${accounts.length}개 계좌 등록 완료 (${accounts.map((a) => a.role).join(', ')})`);
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  }
}
