// 계좌 3개(메인 · 고정비 · 비상금)를 accounts 에 등록한다.
//
//   npm run accounts:seed -- main=1234 fixed=5678 emergency=9012
//
// 계좌번호 뒤 4자리는 코드에도 마이그레이션에도 하드코딩하지 않는다. 실행할
// 때 CLI 인자로 받고, 로그에는 숫자를 남기지 않는다(건수와 역할만 출력한다).
// 같은 인자로 여러 번 돌려도 안전하다(ON CONFLICT).
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// role -> nickname. accounts.role / accounts.nickname 은 각각 UNIQUE 다.
const NICKNAMES = new Map([
  ['main', '메인'],
  ['fixed', '고정비'],
  ['emergency', '비상금'],
]);

const USAGE = 'npm run accounts:seed -- main=<4자리> fixed=<4자리> emergency=<4자리>';

export function parseArgs(argv) {
  const seen = new Map();
  for (const arg of argv) {
    const match = /^([a-z]+)=(.*)$/.exec(arg);
    if (!match) {
      throw new Error(`인자 형식이 올바르지 않습니다: "${arg}"\n${USAGE}`);
    }
    const [, role, value] = match;
    if (!NICKNAMES.has(role)) {
      throw new Error(
        `알 수 없는 역할: "${role}" (가능한 값: ${[...NICKNAMES.keys()].join(', ')})\n${USAGE}`,
      );
    }
    if (seen.has(role)) {
      throw new Error(`역할이 중복되었습니다: "${role}"`);
    }
    // 뒤 4자리 정확히. 로그와 에러 메시지에 값 자체를 넣지 않는다.
    if (!/^[0-9]{4}$/.test(value)) {
      throw new Error(`"${role}" 값이 4자리 숫자가 아닙니다. 계좌번호 뒤 4자리만 넣으세요.\n${USAGE}`);
    }
    seen.set(role, value);
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
      // role 이 UNIQUE 이므로 역할 기준으로 갱신한다. 같은 인자로 다시 돌리면
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
    const accounts = parseArgs(process.argv.slice(2));
    await seed(accounts);
    console.log(`${accounts.length}개 계좌 등록 완료 (${accounts.map((a) => a.role).join(', ')})`);
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  }
}
