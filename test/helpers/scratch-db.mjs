// ⚠️ 테스트 전용. 로컬 스크래치 Postgres 에 임시 DB 를 만들고 마이그레이션을
// 적용한 연결을 빌려준다. test/classify-store.test.mjs · report-monthly.test.mjs
// 에 있던 것과 같은 절차다(그 파일들은 손대지 않았다).
//
//   - `TEST_DATABASE_URL` 이 없으면 테스트를 건너뛴다.
//   - 호스트가 로컬이 아니면 **거부한다.** `DATABASE_URL`(운영 Neon)은 읽지 않는다.
//   - 마이그레이션은 scripts/migrate.mjs 를 그대로 실행한다 — 새 마이그레이션이
//     실제 러너로 깨끗하게 적용되는지가 여기서 함께 검사된다.
import assert from 'node:assert/strict';
import process from 'node:process';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const SCRATCH_ACCOUNTS = Object.freeze([
  { id: 1, role: 'main', last4: '1288', nickname: '메인' },
  { id: 2, role: 'fixed', last4: '2222', nickname: '고정비' },
  { id: 3, role: 'emergency', last4: '3333', nickname: '비상금' },
]);

function localAdminUrl() {
  const raw = process.env.TEST_DATABASE_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const url = new URL(raw);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    // 호스트명은 메시지에 넣지 않는다.
    throw new Error('TEST_DATABASE_URL 이 로컬 호스트가 아닙니다. 왕복 테스트를 거부합니다.');
  }
  return url;
}

/** scripts/migrate.mjs 를 그 DB 에 대해 실행한다. 표준 출력은 버린다. */
export function runMigrations(databaseUrl) {
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

/**
 * 스크래치 DB 를 만들고 마이그레이션 + 계좌 3개까지 넣은 연결로 `run` 을 부른다.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} name 영소문자 · 숫자 · 밑줄
 * @param {(client: import('pg').Client, url: string) => Promise<void>} run
 */
export async function withScratchDatabase(t, name, run) {
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
    for (const { role, last4, nickname } of SCRATCH_ACCOUNTS) {
      await client.query('INSERT INTO accounts (nickname, role, last4) VALUES ($1, $2, $3)', [
        nickname,
        role,
        last4,
      ]);
    }
    await run(client, scratchUrl.href);
  } finally {
    await client.end().catch(() => {});
  }
}
