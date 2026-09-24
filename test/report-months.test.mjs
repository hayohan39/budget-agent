// 달 목록과 year_month 형식 검사.
//
// 형식 검사가 화면과 SQL 사이의 유일한 관문이라 여기서 경계값을 굳혀 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isYearMonth, listYearMonths, MAX_MONTHS } from '../lib/report/months.mjs';

test('YYYY-MM 만 통과한다', () => {
  for (const good of ['2026-08', '1999-12', '0000-00']) {
    assert.equal(isYearMonth(good), true, good);
  }
  for (const bad of ['2026-8', '2026/08', '2026-08-01', ' 2026-08', '2026-08 ', 'august', '', null, undefined, 202608]) {
    assert.equal(isYearMonth(bad), false, String(bad));
  }
});

test('개행이 섞인 값은 통과하지 못한다', () => {
  // `$` 는 개행 앞에서도 맞는다. `^...$` 만 믿으면 '2026-08\n악성' 이 통과한다.
  assert.equal(isYearMonth('2026-08\n2026-09'), false);
});

test('달 목록은 최신순이고 파라미터로 상한을 건다', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ year_month: '2026-08' }, { year_month: '2026-07' }] };
    },
  };

  assert.deepEqual(await listYearMonths(client), ['2026-08', '2026-07']);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ORDER BY year_month DESC/);
  assert.deepEqual(calls[0].params, [MAX_MONTHS]);
});

test('형식이 아닌 값은 걸러서 내보낸다', async () => {
  const client = {
    async query() {
      return { rows: [{ year_month: '2026-08' }, { year_month: '엉뚱한값' }] };
    },
  };
  assert.deepEqual(await listYearMonths(client), ['2026-08']);
});

test('거래가 없으면 빈 배열이다(던지지 않는다)', async () => {
  const client = { async query() { return { rows: [] }; } };
  assert.deepEqual(await listYearMonths(client), []);
});

test('DB 오류 메시지를 그대로 흘리지 않는다', async () => {
  const client = {
    async query() {
      throw new Error('relation "transactions" does not exist (host=secret-host)');
    },
  };

  await assert.rejects(
    () => listYearMonths(client),
    (error) => {
      assert.ok(!error.message.includes('secret-host'));
      assert.match(error.message, /거래 월 목록을 읽지 못했습니다/);
      return true;
    },
  );
});

test('limit 이 정수가 아니면 질의하지 않는다', async () => {
  const client = {
    async query() {
      throw new Error('쿼리가 나가면 안 된다');
    },
  };
  for (const bad of [0, -1, 1.5, '10']) {
    await assert.rejects(() => listYearMonths(client, { limit: bad }), /1 이상의 정수/);
  }
});
