// lib/db/client.mjs 의 연결 풀 테스트. 로컬 스크래치 Postgres 에서만 돈다
// (TEST_DATABASE_URL 이 없으면 DB 쪽은 건너뛴다). 합성 데이터만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { POOL_OPTIONS, STALE_IDLE_MS, closePools, withClient, withTransaction } from '../lib/db/client.mjs';
import { withScratchDatabase } from './helpers/scratch-db.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test.after(() => closePools());

async function pidOf(client) {
  return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
}

test('풀 설정: 서버리스에 맞게 작고, 쉬는 연결을 곧 닫고, 프로세스 종료를 막지 않는다', () => {
  assert.ok(POOL_OPTIONS.max >= 2 && POOL_OPTIONS.max <= 5);
  assert.ok(POOL_OPTIONS.idleTimeoutMillis > 0 && POOL_OPTIONS.idleTimeoutMillis <= 30_000);
  assert.ok(POOL_OPTIONS.connectionTimeoutMillis > 0);
  assert.ok(POOL_OPTIONS.maxLifetimeSeconds > 0);
  assert.equal(POOL_OPTIONS.allowExitOnIdle, true);
  assert.equal(STALE_IDLE_MS, POOL_OPTIONS.idleTimeoutMillis);
});

test('풀: 연결을 다시 쓰고, 트랜잭션은 한 연결에서 BEGIN · fn · COMMIT 한다', async (t) => {
  await withScratchDatabase(t, 'pool_reuse', async (_client, url) => {
    const options = { connectionString: url };
    const first = await withClient(pidOf, options);
    const second = await withClient(pidOf, options);
    assert.equal(first, second, '순서대로 부르면 같은 연결을 다시 쓴다');

    // 트랜잭션 안의 문장은 모두 같은 연결 · 같은 트랜잭션이다.
    const seen = await withTransaction(async (client) => {
      const a = await client.query('SELECT pg_backend_pid() AS pid, txid_current() AS xid');
      const b = await client.query('SELECT pg_backend_pid() AS pid, txid_current() AS xid');
      return [a.rows[0], b.rows[0], client.getTransactionStatus()];
    }, options);
    assert.deepEqual(seen[0], seen[1]);
    assert.equal(seen[2], 'T');

    // 던지면 ROLLBACK — 쓴 것이 남지 않고, 연결은 깨끗한 채로 풀에 돌아온다.
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query(`INSERT INTO merchant_map (description, direction, category) VALUES ('가상풀', 'out', '변동비')`);
        throw new Error('의도한 실패');
      }, options),
      /의도한 실패/,
    );
    const after = await withClient(async (client) => {
      const count = await client.query(`SELECT count(*)::int AS n FROM merchant_map WHERE description = '가상풀'`);
      return { n: count.rows[0].n, status: client.getTransactionStatus() };
    }, options);
    assert.deepEqual(after, { n: 0, status: 'I' });
  });
});

test('풀: 트랜잭션을 열어 둔 채 던진 연결은 풀로 돌아가지 않는다', async (t) => {
  await withScratchDatabase(t, 'pool_dirty', async (_client, url) => {
    const options = { connectionString: url };
    let dirtyPid;
    await assert.rejects(
      withClient(async (client) => {
        dirtyPid = await pidOf(client);
        await client.query('BEGIN');
        await client.query(`INSERT INTO merchant_map (description, direction, category) VALUES ('가상풀', 'out', '변동비')`);
        throw new Error('COMMIT · ROLLBACK 없이 던진다');
      }, options),
      /없이 던진다/,
    );
    const next = await withClient(async (client) => ({ pid: await pidOf(client), status: client.getTransactionStatus() }), options);
    assert.notEqual(next.pid, dirtyPid, '더러운 연결을 다시 빌려주면 안 된다');
    assert.equal(next.status, 'I');
    // 그 연결은 끊겼으므로 열린 트랜잭션도 사라졌다 — 쓴 것은 남지 않는다.
    const count = await withClient(
      (client) => client.query(`SELECT count(*)::int AS n FROM merchant_map WHERE description = '가상풀'`),
      options,
    );
    assert.equal(count.rows[0].n, 0);
  });
});

test('풀: 오래 쉰 연결(얼어 있던 인스턴스)은 버리고 새 연결을 빌린다', async (t) => {
  await withScratchDatabase(t, 'pool_stale', async (_client, url) => {
    const options = { connectionString: url };
    const before = await withClient(pidOf, options);
    const realNow = Date.now;
    Date.now = () => realNow() + STALE_IDLE_MS + 1_000;
    try {
      const after = await withClient(pidOf, options);
      assert.notEqual(after, before);
    } finally {
      Date.now = realNow;
    }
  });
});

test('풀: pg_advisory_xact_lock 은 풀을 거쳐도 줄 세우고 COMMIT 에서 풀린다', async (t) => {
  await withScratchDatabase(t, 'pool_xact_lock', async (observer, url) => {
    const options = { connectionString: url };
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const order = [];
    let firstLocked;
    const locked = new Promise((resolve) => {
      firstLocked = resolve;
    });

    const first = withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::int4, hashtext($2::text))', [0x6d6d6170, '가상키']);
      order.push('first-locked');
      firstLocked();
      await gate;
      order.push('first-commit');
    }, options);
    await locked;

    let secondPid;
    const second = withTransaction(async (client) => {
      secondPid = await pidOf(client);
      await client.query('SELECT pg_advisory_xact_lock($1::int4, hashtext($2::text))', [0x6d6d6170, '가상키']);
      order.push('second-locked');
    }, options);

    // 두 번째가 잠금을 기다리기 시작할 때까지.
    const deadline = Date.now() + 10_000;
    for (;;) {
      assert.ok(Date.now() < deadline, '두 번째 트랜잭션이 잠금을 기다리지 않았다');
      if (secondPid !== undefined) {
        const activity = await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [secondPid]);
        if (activity.rows[0]?.wait_event_type === 'Lock') break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(order, ['first-locked']);

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-locked', 'first-commit', 'second-locked']);

    // 트랜잭션 잠금이라 COMMIT 뒤에는 아무도 쥐고 있지 않다(풀에 남은 연결도).
    // pg_locks 는 클러스터 전체라, 같은 스크래치 서버에서 동시에 도는 다른 테스트 파일의
    // 잠금이 섞이지 않게 이 DB 로 좁힌다.
    const held = await observer.query(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory'
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    assert.equal(held.rows[0].n, 0);
  });
});

/** 런타임 코드(lib · app). scripts/ 는 직결이라 빠진다. */
async function runtimeSources() {
  const out = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(mjs|js|ts|tsx)$/.test(entry.name)) out.push(full);
    }
  }
  await walk(path.join(REPO_ROOT, 'lib'));
  await walk(path.join(REPO_ROOT, 'app'));
  return out;
}

/** 코드 한 덩어리에서 세션 수준 기능의 흔적을 찾는다. */
function sessionFeaturesIn(text) {
  // 주석은 빼고 본다(이 규칙을 설명하는 주석이 있다).
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found = [];
  // 세션 advisory 잠금(xact 가 아닌 것).
  if (/pg_(try_)?advisory_(lock|lock_shared|unlock)\s*\(/.test(code)) found.push('session advisory lock');
  // 문장 맨 앞의 SET(= SET LOCAL 이 아닌 세션 설정). UPDATE … SET 은 문장 맨 앞이 아니다.
  if (/[`'"]\s*SET\s+(?!LOCAL\b)/i.test(code)) found.push('SET without LOCAL');
  if (/[`'"]\s*(PREPARE|LISTEN|DECLARE)\s+\w/i.test(code)) found.push('session statement');
  // 이름 붙은 prepared statement: query({ name: ..., text: ... }).
  if (/query\(\s*\{[^}]*\bname\s*:/.test(code)) found.push('named prepared statement');
  return found;
}

test('세션 기능 탐지기 자체가 잡아야 할 것을 잡는다(양성 대조)', () => {
  assert.deepEqual(sessionFeaturesIn("client.query('SELECT pg_advisory_lock($1)', [1])"), ['session advisory lock']);
  assert.deepEqual(sessionFeaturesIn("client.query(`SET search_path TO x`)"), ['SET without LOCAL']);
  assert.deepEqual(sessionFeaturesIn("client.query({ name: 'q1', text: 'SELECT 1' })"), ['named prepared statement']);
  assert.deepEqual(sessionFeaturesIn("client.query('SET LOCAL statement_timeout = 1000')"), []);
  assert.deepEqual(sessionFeaturesIn("client.query(`UPDATE t\n SET a = 1`)"), []);
  assert.deepEqual(sessionFeaturesIn("client.query('SELECT pg_advisory_xact_lock($1)', [1])"), []);
});

test('런타임 코드(lib · app)는 세션 수준 기능을 쓰지 않는다(트랜잭션 모드 풀러에서도 안전)', async () => {
  const offenders = [];
  for (const file of await runtimeSources()) {
    for (const what of sessionFeaturesIn(await readFile(file, 'utf8'))) {
      offenders.push(`${path.relative(REPO_ROOT, file)}: ${what}`);
    }
  }
  assert.deepEqual(offenders, []);
  // scripts/migrate.mjs 는 세션 잠금을 쓴다 — 그래서 풀이 아니라 직결(connect)이다.
  const migrate = await readFile(path.join(REPO_ROOT, 'scripts', 'migrate.mjs'), 'utf8');
  assert.deepEqual(sessionFeaturesIn(migrate), ['session advisory lock']);
  assert.match(migrate, /await connect\(\)/);
});
