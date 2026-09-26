// /api/classify · /api/classify/mappings 핸들러의 가드 순서와 응답 위생.
//
// 라우트 파일(app/api/classify/**/route.ts)은 lib/classify/http.mjs 의 함수에
// auth · isAllowedEmail · withClient 를 꽂기만 한다. 여기서는 그 셋을 가짜로
// 꽂아 "DB 에 닿기 전에 막히는가" 를 본다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_BODY_BYTES, handleClassifyPost, handleMappingPost } from '../lib/classify/http.mjs';

const HOST = 'budget.example';
const ALLOWED = 'owner@example.com';

function request(body, { origin = `https://${HOST}`, type = 'application/json', raw } = {}) {
  const headers = new Headers({ host: HOST, 'content-type': type });
  if (origin !== null) headers.set('origin', origin);
  return new Request(`https://${HOST}/api/classify`, {
    method: 'POST',
    headers,
    body: raw ?? JSON.stringify(body),
  });
}

/** 가짜 DB. 쿼리를 기록하고, 그 달에는 `코인적립` 한 건만 있다. */
function fakeClient() {
  const queries = [];
  return {
    queries,
    async query(text, values = []) {
      queries.push({ text, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [], rowCount: 0 };
      if (text.startsWith('SELECT id, description FROM transactions WHERE year_month')) {
        return { rows: [{ id: '41', description: '코인적립' }], rowCount: 1 };
      }
      if (text.includes('UPDATE transactions')) return { rows: [], rowCount: 1 };
      if (text.includes('INSERT INTO merchant_map')) return { rows: [], rowCount: 1 };
      if (text.includes('DELETE FROM merchant_map')) return { rows: [], rowCount: 0 };
      if (text.includes('UPDATE merchant_map')) return { rows: [], rowCount: 0 };
      throw new Error(`모르는 쿼리: ${text.split('\n')[0]}`);
    },
  };
}

function deps({ session = { user: { email: ALLOWED } }, client = fakeClient() } = {}) {
  const calls = { withClient: 0 };
  return {
    calls,
    client,
    value: {
      auth: async () => session,
      isAllowedEmail: (email) => email === ALLOWED,
      withClient: async (fn) => {
        calls.withClient += 1;
        return fn(client);
      },
    },
  };
}

const GOOD = Object.freeze({
  scope: 'once',
  month: '2026-08',
  key: '코인적립',
  category: '저축',
  item: '코인',
});

async function read(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { status: response.status, body: await response.json() };
}

for (const [name, handler] of [
  ['classify', handleClassifyPost],
  ['mappings', handleMappingPost],
]) {
  test(`${name}: 세션이 없으면 401, DB 에 닿지 않는다`, async () => {
    const d = deps({ session: null });
    const { status } = await read(await handler(request(GOOD), d.value));
    assert.equal(status, 401);
    assert.equal(d.calls.withClient, 0);
  });

  test(`${name}: 화이트리스트 밖이면 403, DB 에 닿지 않는다`, async () => {
    const d = deps({ session: { user: { email: 'stranger@example.com' } } });
    const { status } = await read(await handler(request(GOOD), d.value));
    assert.equal(status, 403);
    assert.equal(d.calls.withClient, 0);
  });

  test(`${name}: 다른 Origin 이면 403, DB 에 닿지 않는다`, async () => {
    for (const origin of ['https://evil.example', 'not a url', `http://${HOST}.evil`]) {
      const d = deps();
      const { status } = await read(await handler(request(GOOD, { origin }), d.value));
      assert.equal(status, 403, origin);
      assert.equal(d.calls.withClient, 0);
    }
  });

  test(`${name}: JSON 이 아니거나 너무 크면 400`, async () => {
    for (const options of [
      { type: 'text/plain' },
      { raw: '{not json' },
      { raw: JSON.stringify({ ...GOOD, pad: 'x'.repeat(MAX_BODY_BYTES) }) },
    ]) {
      const d = deps();
      const { status } = await read(await handler(request(GOOD, options), d.value));
      assert.equal(status, 400);
      assert.equal(d.calls.withClient, 0);
    }
  });
}

test('classify: 모르는 분류 · 틀린 달 · 제어 문자 · 긴 항목은 400, DB 에 닿지 않는다', async () => {
  for (const bad of [
    { category: '손수정' },
    { month: '2026-13-01' },
    { item: '코인\u0000' },
    { item: '가'.repeat(41) },
    { key: '' },
    { scope: 'all' },
  ]) {
    const d = deps();
    const { status, body } = await read(await handleClassifyPost(request({ ...GOOD, ...bad }), d.value));
    assert.equal(status, 400, JSON.stringify(Object.keys(bad)));
    assert.equal(body.ok, false);
    assert.equal(d.calls.withClient, 0);
  }
});

test('classify: 없는 키는 404 이고 키를 되비추지 않는다', async () => {
  const d = deps();
  const { status, body } = await read(
    await handleClassifyPost(request({ ...GOOD, key: '비밀 적요 홍길동' }), d.value),
  );
  assert.equal(status, 404);
  assert.ok(!JSON.stringify(body).includes('홍길동'));
  assert.ok(d.client.queries.some((query) => query.text === 'ROLLBACK'));
  assert.ok(!d.client.queries.some((query) => /UPDATE transactions|INSERT INTO/.test(query.text)));
});

test('classify: 클라이언트가 보낸 id · 건수는 무시하고 서버가 찾은 id 로만 쓴다', async () => {
  const d = deps();
  const { status, body } = await read(
    await handleClassifyPost(request({ ...GOOD, ids: ['1', '2', '3'], count: 999, total: -1 }), d.value),
  );
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, updated: 1, mapped: false });

  const update = d.client.queries.find((query) => query.text.includes('UPDATE transactions'));
  assert.deepEqual(update.values, ['저축', '코인', ['41']]);
  // 값은 전부 파라미터로 나간다.
  assert.ok(!update.text.includes('저축'));
  assert.ok(d.client.queries.some((query) => query.text === 'COMMIT'));
});

test('classify: Origin 헤더가 없으면(같은 출처 폼) 통과한다', async () => {
  const d = deps();
  const { status } = await read(await handleClassifyPost(request(GOOD, { origin: null }), d.value));
  assert.equal(status, 200);
});

test('classify: DB 연결 실패는 503 이고 원인 메시지를 흘리지 않는다', async () => {
  const d = deps();
  d.value.withClient = async () => {
    throw new Error('connect ECONNREFUSED secret-host.neon.tech user=admin');
  };
  const { status, body } = await read(await handleClassifyPost(request(GOOD), d.value));
  assert.equal(status, 503);
  assert.ok(!JSON.stringify(body).includes('secret-host'));
});

test('mappings: 없는 매핑 삭제 · 수정은 404', async () => {
  for (const payload of [
    { action: 'delete', key: '코인적립' },
    { action: 'update', key: '코인적립', category: '저축', item: null },
  ]) {
    const d = deps();
    const { status } = await read(await handleMappingPost(request(payload), d.value));
    assert.equal(status, 404);
  }
});

test('mappings: 모르는 분류 · 모르는 동작은 400', async () => {
  for (const payload of [
    { action: 'update', key: '코인적립', category: '손수정' },
    { action: 'truncate', key: '코인적립' },
  ]) {
    const d = deps();
    const { status } = await read(await handleMappingPost(request(payload), d.value));
    assert.equal(status, 400);
    assert.equal(d.calls.withClient, 0);
  }
});
