// lib/tax/http.mjs — /api/tax/settings · /api/tax/tags.
//
// 가드 순서(세션 → 화이트리스트 → Origin → 본문)가 DB 보다 먼저인지, 본문 검사가 무엇을 거부하는지,
// 응답이 받은 값을 되비추지 않는지 본다.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleTaxSettingsPost,
  handleTaxTagPost,
  parseSettingsRequest,
  parseTagRequest,
} from '../lib/tax/http.mjs';

const HOST = 'budget.example';
const ALLOWED = 'owner@example.com';

function request(path, body, { origin = `https://${HOST}`, type = 'application/json' } = {}) {
  const headers = new Headers({ host: HOST, 'content-type': type });
  if (origin !== null) headers.set('origin', origin);
  return new Request(`https://${HOST}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function deps({ session = { user: { email: ALLOWED } }, fail = false } = {}) {
  const queries = [];
  return {
    queries,
    auth: async () => session,
    isAllowedEmail: (email) => email === ALLOWED,
    withClient: async (fn) => {
      if (fail) throw new Error('connect ECONNREFUSED db.internal:5432 user=secret');
      return fn({
        async query(text, values) {
          queries.push({ text, values });
          return { rows: [], rowCount: 1 };
        },
      });
    },
  };
}

const SETTINGS = Object.freeze({
  year: 2026,
  salary: 52_345_678,
  marginalRate: 15,
  homelessHouseholder: true,
  mortgageTier: 'none',
});

test('설정 요청 검사: 다섯 칸, 빈칸은 null, 틀린 값 · 모르는 키는 거부', () => {
  assert.deepEqual(parseSettingsRequest(SETTINGS), {
    ok: true,
    value: { year: 2026, settings: { salary: 52_345_678, marginalRate: 15, homelessHouseholder: true, mortgageTier: 'none' } },
  });
  assert.deepEqual(parseSettingsRequest({ year: 2026 }).value.settings, {
    salary: null,
    marginalRate: null,
    homelessHouseholder: null,
    mortgageTier: null,
  });
  for (const bad of [
    { ...SETTINGS, year: 2019 },
    { ...SETTINGS, year: '2026' },
    { ...SETTINGS, salary: -1 },
    { ...SETTINGS, salary: 1.5 },
    { ...SETTINGS, salary: '5000만' },
    { ...SETTINGS, salary: 10_000_000_001 },
    { ...SETTINGS, marginalRate: 20 },
    { ...SETTINGS, homelessHouseholder: 'yes' },
    { ...SETTINGS, mortgageTier: '99m' },
    { ...SETTINGS, extra: 1 },
    [],
    null,
  ]) {
    assert.equal(parseSettingsRequest(bad).ok, false, JSON.stringify(bad));
  }
});

test('연결 요청 검사: 분류는 연결 가능한 것만, 항목은 정규화 · 제어 문자 거부, 공제 항목은 정해진 값만', () => {
  assert.deepEqual(parseTagRequest({ action: 'set', category: '저축', item: '  미래에셋   IRP ', deduction: 'irp' }), {
    ok: true,
    value: { action: 'set', category: '저축', item: '미래에셋 IRP', deduction: 'irp' },
  });
  assert.deepEqual(parseTagRequest({ action: 'set', category: '고정비', item: '종신보험', deduction: 'none' }).value.deduction, 'none');
  assert.deepEqual(parseTagRequest({ action: 'delete', category: '저축', item: 'IRP' }), {
    ok: true,
    value: { action: 'delete', category: '저축', item: 'IRP' },
  });
  for (const bad of [
    { action: 'set', category: '수입', item: '월급', deduction: 'irp' },
    { action: 'set', category: '카드대금', item: '삼성카드', deduction: 'irp' },
    { action: 'set', category: '저축', item: '', deduction: 'irp' },
    { action: 'set', category: '저축', item: 'a\u0000b', deduction: 'irp' },
    { action: 'set', category: '저축', item: 'x'.repeat(201), deduction: 'irp' },
    { action: 'set', category: '저축', item: 'ISA', deduction: 'isa' },
    { action: 'delete', category: '저축', item: 'IRP', deduction: 'irp' },
    { action: 'rename', category: '저축', item: 'IRP' },
    { action: 'set', category: '저축', item: 'IRP', deduction: 'irp', amount: 1 },
  ]) {
    assert.equal(parseTagRequest(bad).ok, false, JSON.stringify(bad));
  }
});

test('가드: 세션 없음 401 · 명단 밖 403 · 다른 Origin 403 — DB 에 닿지 않는다', async () => {
  for (const [handler, path, body] of [
    [handleTaxSettingsPost, '/api/tax/settings', SETTINGS],
    [handleTaxTagPost, '/api/tax/tags', { action: 'set', category: '저축', item: 'IRP', deduction: 'irp' }],
  ]) {
    const noSession = deps({ session: null });
    assert.equal((await handler(request(path, body), noSession)).status, 401);
    const stranger = deps({ session: { user: { email: 'x@example.com' } } });
    assert.equal((await handler(request(path, body), stranger)).status, 403);
    const crossOrigin = deps();
    assert.equal((await handler(request(path, body, { origin: 'https://evil.example' }), crossOrigin)).status, 403);
    for (const d of [noSession, stranger, crossOrigin]) assert.equal(d.queries.length, 0);
  }
});

test('설정 저장: 200 · no-store · 본문에 연봉을 되비추지 않는다. DB 실패는 503 + 고정 문장', async () => {
  const d = deps();
  const response = await handleTaxSettingsPost(request('/api/tax/settings', SETTINGS), d);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { ok: true });
  assert.ok(!text.includes('52345678'));
  assert.equal(d.queries.length, 1);
  assert.deepEqual(d.queries[0].values, [2026, 52_345_678, 15, true, 'none']);

  const bad = await handleTaxSettingsPost(request('/api/tax/settings', { ...SETTINGS, salary: -52_345_678 }), deps());
  assert.equal(bad.status, 400);
  assert.ok(!(await bad.text()).includes('52345678'));

  const down = await handleTaxSettingsPost(request('/api/tax/settings', SETTINGS), deps({ fail: true }));
  assert.equal(down.status, 503);
  const downText = await down.text();
  assert.ok(!downText.includes('db.internal') && !downText.includes('secret'));
});

test('연결 저장 · 해제: 항목 이름을 되비추지 않는다. JSON 이 아니면 400', async () => {
  const d = deps();
  const set = await handleTaxTagPost(
    request('/api/tax/tags', { action: 'set', category: '저축', item: '미래에셋 IRP', deduction: 'irp' }),
    d,
  );
  assert.equal(set.status, 200);
  assert.ok(!(await set.text()).includes('미래에셋'));
  assert.deepEqual(d.queries[0].values, ['저축', '미래에셋 IRP', 'irp']);

  const del = await handleTaxTagPost(request('/api/tax/tags', { action: 'delete', category: '저축', item: '미래에셋 IRP' }), d);
  assert.equal(del.status, 200);
  assert.match(d.queries[1].text, /^DELETE FROM tax_item_tags/);

  const notJson = await handleTaxTagPost(request('/api/tax/tags', {}, { type: 'text/plain' }), deps());
  assert.equal(notJson.status, 400);
});
