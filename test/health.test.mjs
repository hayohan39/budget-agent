// /api/health 본체 테스트. 로그인 없이 열린 유일한 API 라서, 무엇을 내보내지
// **않는지**가 핵심이다: DB 오류 메시지(호스트·사용자명이 섞일 수 있다)를 응답에 싣지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth } from '../lib/health.mjs';

const ok = async (fn) => fn({ query: async () => ({ rows: [] }) });

test('DB 연결이 되면 ok, 커밋 7자리', async () => {
  const health = await checkHealth({
    withClient: ok,
    env: { DATABASE_URL: 'postgres://x', VERCEL_GIT_COMMIT_SHA: 'abcdef1234' },
  });
  assert.deepEqual(health, { ok: true, database: 'ok', commit: 'abcdef1' });
});

test('DB 오류면 ok=false, 오류 내용은 응답에 없다', async () => {
  const secret = 'connect ECONNREFUSED ep-secret-host.neon.tech user=owner';
  const health = await checkHealth({
    withClient: async () => {
      throw new Error(secret);
    },
    env: { DATABASE_URL: 'postgres://x' },
  });
  assert.deepEqual(health, { ok: false, database: 'error', commit: null });
  assert.ok(!JSON.stringify(health).includes('neon'));
});

test('DATABASE_URL 이 없으면 연결을 시도하지 않는다', async () => {
  let called = false;
  const health = await checkHealth({
    withClient: async () => {
      called = true;
    },
    env: {},
  });
  assert.equal(called, false);
  assert.deepEqual(health, { ok: true, database: 'not-configured', commit: null });
});
