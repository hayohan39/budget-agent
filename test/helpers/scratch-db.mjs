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
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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

/**
 * scripts/migrate.mjs 를 그 DB 에 대해 실행한다. 표준 출력은 버린다.
 *
 * 러너는 `cwd/migrations` 를 읽는다. `cwd` 를 주면 그 디렉터리의 마이그레이션만
 * 적용한다(아래 `migrationsBefore`).
 *
 * @param {string} databaseUrl
 * @param {{ cwd?: string }} [options]
 */
export function runMigrations(databaseUrl, { cwd = REPO_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', 'migrate.mjs')], {
      cwd,
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
 * 파일명이 `before` 보다 앞선 마이그레이션만 임시 디렉터리에 복사한다.
 * 새 마이그레이션이 **이미 행이 있는 테이블**에 깨끗하게 적용되는지 보려고 쓴다.
 * 복사본은 내용이 같아 체크섬도 같다 — 나중에 저장소의 러너를 돌리면 나머지만 적용된다.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} before 이 파일과 그 뒤의 파일은 복사하지 않는다
 * @returns {Promise<string>} 러너의 cwd 로 쓸 디렉터리
 */
async function migrationsBeforeDir(t, before) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'budget-migrations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(REPO_ROOT, 'migrations');
  const target = path.join(root, 'migrations');
  await mkdir(target);
  const files = (await readdir(source)).filter((file) => file.endsWith('.sql') && file < before);
  assert.ok(files.length > 0, '복사할 마이그레이션이 없다');
  for (const file of files) await copyFile(path.join(source, file), path.join(target, file));
  return root;
}

/**
 * 스크래치 DB 를 만들고 마이그레이션 + 계좌 3개까지 넣은 연결로 `run` 을 부른다.
 *
 * `migrationsBefore` 를 주면 그 파일 **앞까지만** 적용한 상태로 부른다. 나머지는
 * `run` 안에서 `runMigrations(url)` 로 적용한다.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} name 영소문자 · 숫자 · 밑줄
 * @param {(client: import('pg').Client, url: string) => Promise<void>} run
 * @param {{ migrationsBefore?: string }} [options]
 */
export async function withScratchDatabase(t, name, run, { migrationsBefore } = {}) {
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

  if (migrationsBefore === undefined) await runMigrations(scratchUrl.href);
  else await runMigrations(scratchUrl.href, { cwd: await migrationsBeforeDir(t, migrationsBefore) });

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
