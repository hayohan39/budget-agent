// 사람이 입력하는 적요 패턴(`#` = 숫자 한 자리, `*` = 아무 글자) — 문법 · 매처 · 분류기
// 순서 · /classify 쓰기 · 미리보기 · 동시 쓰기.
//
// 사용자 요청: "매번 패턴이 달라질수 있는게 나올수있기 때문에 저장 시 사용자가 직접
// 패턴을 입력할 수 있게 하는 게 좋을 것 같아." (흥국01184 · 흥국02184 · 흥국03184)
//
// 합성 데이터만 쓴다. DB 테스트는 TEST_DATABASE_URL 이 있을 때만 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

import {
  MAX_MATCH_SUBJECT,
  compileWildcard,
  likePrefilter,
  parseWildcardPattern,
  suggestPattern,
  wildcardMatches,
} from '../lib/classify/wildcard.mjs';
import { createClassifier } from '../lib/classify/engine.mjs';
import {
  applyClassification,
  deletePattern,
  listPatterns,
  parseClassifyRequest,
  parsePatternRequest,
  previewPattern,
  updatePattern,
} from '../lib/classify/manual.mjs';
import { handlePatternPost, handlePatternPreview } from '../lib/classify/http.mjs';
import { insertTransactions } from '../lib/db/transactions.mjs';
import { loadClassifier } from '../lib/classify/store.mjs';
import { withScratchDatabase } from './helpers/scratch-db.mjs';

const matches = (pattern, description) => {
  const parsed = parseWildcardPattern(pattern);
  assert.equal(parsed.ok, true, pattern);
  return wildcardMatches(compileWildcard(parsed.pattern), description);
};

// ── 문법 · 검사 ────────────────────────────────────────────────────────────

test('검사: 통과하는 패턴은 정규화되고 글자 · 와일드카드 수를 센다', () => {
  assert.deepEqual(parseWildcardPattern('흥국##184'), { ok: true, pattern: '흥국##184', literals: 5, stars: 0, digits: 2 });
  assert.deepEqual(parseWildcardPattern('  코웨이 ** 렌탈 '), { ok: true, pattern: '코웨이 * 렌탈', literals: 5, stars: 1, digits: 0 });
});

test('검사: 거부하는 패턴', () => {
  const code = (value) => parseWildcardPattern(value).code;
  assert.equal(code(42), 'patternNotString');
  assert.equal(code(null), 'patternNotString');
  assert.equal(code('   '), 'patternEmpty');
  assert.equal(code('흥국\u0000##'), 'patternControlChars');
  assert.equal(code('흥국‮##'), 'patternControlChars');
  assert.equal(code(`흥국${'가'.repeat(63)}#`), 'patternTooLong');
  assert.equal(code('가*나*다*라*마*바'), 'patternTooManyWildcards'); // * 5개
  assert.equal(code(`가나${'#'.repeat(17)}`), 'patternTooManyWildcards');
  assert.equal(code('흥국01184'), 'patternNoWildcard'); // 바뀌는 자리가 없다 = 정확한 매핑
  // 거의 모든 적요에 걸리는 패턴.
  for (const value of ['*', '#', '*#*', '가*', '* *', '#가#']) assert.equal(code(value), 'patternTooFewLiterals', value);
});

// ── 매처 ──────────────────────────────────────────────────────────────────

test('매처: # 는 숫자 한 자리, * 는 아무 글자(없어도 됨), 적요 전체와 맞아야 한다', () => {
  for (const d of ['흥국01184', '흥국02184', '흥국12184', '흥국99184']) assert.equal(matches('흥국##184', d), true, d);
  for (const d of ['흥국1184', '흥국011840', 'x흥국01184', '흥국0a184', '흥국01185', '흥국０１184']) {
    assert.equal(matches('흥국##184', d), false, d);
  }
  assert.equal(matches('코웨이*렌탈', '코웨이렌탈'), true); // * 는 비어도 된다
  assert.equal(matches('코웨이*렌탈', '코웨이 9월 렌탈'), true);
  assert.equal(matches('코웨이*렌탈', '코웨이08월렌탈 환불'), false); // 뒤가 고정
  assert.equal(matches('*렌탈', '아무개렌탈'), true);
  assert.equal(matches('  흥국 ## ', '흥국  01'), true); // 공백은 양쪽 모두 정리
});

test('매처: 정규식 · LIKE 특수 문자는 그냥 글자다', () => {
  assert.equal(matches('a.b#', 'a.b1'), true);
  assert.equal(matches('a.b#', 'axb1'), false);
  assert.equal(matches('(주)가#', '(주)가3'), true);
  assert.equal(matches('가\\나#', '가\\나1'), true);
  assert.equal(matches('50%할인#', '50%할인1'), true);
  assert.equal(matches('50%할인#', '50할인1'), false);
  assert.equal(matches('a_b#', 'a_b1'), true);
  assert.equal(matches('a_b#', 'axb1'), false);
  assert.equal(likePrefilter('a_b%c\\d#*'), 'a\\_b\\%c\\\\d_%');
});

/** 참고용 느린 구현(동적 계획법). 무작위 비교로 빠른 매처의 정확성을 본다. */
function reference(pattern, subject) {
  const p = [...pattern];
  const s = [...subject];
  const dp = Array.from({ length: p.length + 1 }, () => new Array(s.length + 1).fill(false));
  dp[0][0] = true;
  for (let i = 1; i <= p.length; i += 1) dp[i][0] = dp[i - 1][0] && p[i - 1] === '*';
  for (let i = 1; i <= p.length; i += 1) {
    for (let j = 1; j <= s.length; j += 1) {
      const t = p[i - 1];
      if (t === '*') dp[i][j] = dp[i - 1][j] || dp[i][j - 1];
      else if (t === '#') dp[i][j] = dp[i - 1][j - 1] && s[j - 1] >= '0' && s[j - 1] <= '9';
      else dp[i][j] = dp[i - 1][j - 1] && t === s[j - 1];
    }
  }
  return dp[p.length][s.length];
}

test('퍼즈: 무작위 패턴 · 적요에서 참고 구현과 결과가 같다', () => {
  const alphabet = ['가', '나', '1', '2', '#', '*', 'a'];
  const subjectAlphabet = ['가', '나', '1', '2', 'a', '#', '*'];
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  let checked = 0;
  for (let i = 0; i < 20000; i += 1) {
    const pattern = Array.from({ length: 2 + Math.floor(Math.random() * 8) }, () => pick(alphabet)).join('');
    const parsed = parseWildcardPattern(pattern);
    if (!parsed.ok) continue;
    const subject = Array.from({ length: Math.floor(Math.random() * 12) }, () => pick(subjectAlphabet)).join('');
    assert.equal(wildcardMatches(compileWildcard(parsed.pattern), subject), reference(parsed.pattern, subject), `${parsed.pattern} / ${subject}`);
    checked += 1;
  }
  assert.ok(checked > 1000);
});

test('ReDoS 없음: 최악의 입력도 (적요 × 패턴) 걸음 안에 끝나고, 긴 적요는 비교하지 않는다', () => {
  const tokens = compileWildcard(parseWildcardPattern('*가*가*가*가#나').pattern);
  const worst = '가'.repeat(MAX_MATCH_SUBJECT - 1) + '1';
  const start = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) assert.equal(wildcardMatches(tokens, worst), false);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 1000, `너무 오래 걸렸다: ${elapsedMs}ms`);
  // 상한을 넘는 적요는 비교하지 않는다(늘 false).
  assert.equal(wildcardMatches(compileWildcard(parseWildcardPattern('가*').pattern + '가'), '가'.repeat(MAX_MATCH_SUBJECT + 1)), false);
});

test('제안: 적요에서 바뀌는 자리를 # · * 로 바꾼 값을 미리 채운다', () => {
  assert.equal(suggestPattern('흥국01184'), '흥국##184');
  assert.equal(suggestPattern('코웨이08월렌탈'), '코웨이##월렌탈');
  assert.equal(suggestPattern('코웨이9월렌탈'), '코웨이#월렌탈');
  assert.equal(suggestPattern('KB카드1234'), 'KB카드##34'); // 01~12 로 시작하면 달로 본다(제안일 뿐)
  assert.equal(suggestPattern('가상카드5678'), '가상카드####');
  assert.equal(suggestPattern('흥국13184'), '흥국#####');
  assert.equal(suggestPattern('홍길동 110123456789'), '홍길동 *'); // 긴 숫자는 * 로
  assert.equal(suggestPattern('김철수'), '김철수'); // 숫자가 없으면 그대로(저장 전에 고쳐야 한다)
  for (const d of ['흥국01184', '코웨이08월렌탈', 'KB카드1234', '홍길동 110123456789']) {
    assert.equal(matches(suggestPattern(d), d), true, d); // 제안은 늘 원래 적요와 맞는다
  }
});

// ── 분류기 순서 ────────────────────────────────────────────────────────────

const RULES = [{ id: 9, txn_type: 'CMS출금', pattern: '.*', sign: null, category: '고정비', priority: 90 }];

test('분류기: 정확한 키 → 월 토큰 키 → 패턴 → 규칙', () => {
  const classifier = createClassifier({
    rules: RULES,
    merchantMap: [
      { description: '흥국02184', direction: 'out', category: '저축', item: '정확' },
      { description: '코웨이렌탈', direction: 'out', category: '고정비', item: '월토큰' },
    ],
    patterns: [
      { id: 1, pattern: '흥국##184', direction: 'out', category: '변동비', item: '패턴' },
      { id: 2, pattern: '코웨이*렌탈', direction: 'out', category: '변동비', item: '패턴2' },
    ],
  });
  const item = (description, txn_type = '출금') => classifier.classify({ description, txn_type, amount: -1 });
  assert.deepEqual([item('흥국02184').item, item('흥국02184').source], ['정확', 'merchant_map']);
  assert.deepEqual([item('흥국03184').item, item('흥국03184').category], ['패턴', '변동비']);
  assert.equal(item('코웨이09월렌탈').item, '월토큰'); // 예전 월 토큰 매핑이 패턴보다 먼저
  assert.equal(item('코웨이 새 렌탈').item, '패턴2');
  // 패턴이 규칙보다 세다.
  assert.equal(item('흥국04184', 'CMS출금').category, '변동비');
  assert.equal(item('흥국04999', 'CMS출금').category, '고정비');
  // 방향이 다르면 안 걸린다.
  assert.equal(classifier.classify({ description: '흥국03184', amount: 1 }).category, null);
});

test('분류기: 방향이 맞는 패턴이 any 보다 먼저, 같은 단계에서는 글자가 많은 패턴 → 먼저 만든 패턴', () => {
  const classifier = createClassifier({
    patterns: [
      { id: 5, pattern: '흥국*', direction: 'out', category: '변동비', item: '넓은출금' },
      { id: 3, pattern: '흥국##184', direction: 'any', category: '저축', item: '좁은any' },
      { id: 7, pattern: '흥국##1*', direction: 'out', category: '고정비', item: '중간-나중' },
      { id: 6, pattern: '흥국#*84', direction: 'out', category: '고정비', item: '중간-먼저' },
    ],
  });
  // 출금: any 가 더 구체적이어도 방향 패턴이 먼저. 방향 패턴 중 글자 수 3(흥국1 · 흥국84)이 같은 둘은 id 가 작은 6.
  assert.equal(classifier.classify({ description: '흥국01184', amount: -1 }).item, '중간-먼저');
  assert.equal(classifier.classify({ description: '흥국01199', amount: -1 }).item, '중간-나중');
  assert.equal(classifier.classify({ description: '흥국 기타', amount: -1 }).item, '넓은출금');
  // 입금: 방향 패턴이 없어 any.
  assert.equal(classifier.classify({ description: '흥국01184', amount: 1 }).item, '좁은any');
  // 손으로 넣은 잘못된 패턴은 조용히 건너뛴다.
  const bad = createClassifier({ patterns: [{ id: 1, pattern: '*', direction: 'out', category: '변동비' }] });
  assert.equal(bad.classify({ description: '아무거나', amount: -1 }).category, null);
});

// ── 요청 검사 ─────────────────────────────────────────────────────────────

const BASE = Object.freeze({
  scope: 'always',
  month: '2026-01',
  account: 'main',
  key: '흥국01184',
  direction: 'out',
  category: '고정비',
  item: '흥국보험',
});

test('요청: 패턴은 앞으로도에서만, 월 옵션과 함께 쓸 수 없고, 모양이 틀리면 거부한다', () => {
  assert.equal(parseClassifyRequest({ ...BASE, pattern: ' 흥국##184 ' }).value.pattern, '흥국##184');
  assert.equal(parseClassifyRequest({ ...BASE }).value.pattern, null);
  assert.equal(parseClassifyRequest({ ...BASE, scope: 'once', pattern: '흥국##184' }).error, 'badScope');
  assert.equal(parseClassifyRequest({ ...BASE, stripMonth: true, pattern: '흥국##184' }).error, 'patternWithStripMonth');
  assert.equal(parseClassifyRequest({ ...BASE, pattern: '*' }).error, 'patternTooFewLiterals');
  assert.equal(parseClassifyRequest({ ...BASE, pattern: 7 }).error, 'patternNotString');
  // 거부 문장에 입력값을 싣지 않는다.
  assert.ok(!parseClassifyRequest({ ...BASE, pattern: '비밀*' }).message?.includes('비밀'));
  assert.equal(parsePatternRequest({ action: 'delete', pattern: '흥국##184', direction: 'any' }).ok, true);
  assert.equal(parsePatternRequest({ action: 'update', pattern: '흥국##184', direction: 'out', category: '기타' }).error, 'badCategory');
  assert.equal(parsePatternRequest({ action: 'nope', pattern: '흥국##184', direction: 'out' }).error, 'badRequest');
});

/** 쿼리만 기록하는 가짜 DB. 그 달 메인 계좌에 `description` 출금 한 건이 있다. */
function recordingClient(description) {
  const queries = [];
  return {
    queries,
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.startsWith('SELECT t.id, t.description, t.amount')) {
        return { rows: [{ id: '7', description, amount: '-52000' }], rowCount: 1 };
      }
      if (text.includes('LIKE $1')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  };
}

test('잠금: 키 잠금 = 쓰는 패턴 문자열 그대로, 그다음 분류 쓰기 전체 잠금', async () => {
  const client = recordingClient('흥국01184');
  const outcome = await applyClassification(client, { ...BASE, pattern: '  흥국##184 ' });
  assert.equal(outcome.ok, true);
  const locks = client.queries.filter((query) => query.text.startsWith('SELECT pg_advisory_xact_lock('));
  const insert = client.queries.find((query) => query.text.includes('INSERT INTO description_patterns'));
  assert.equal(client.queries[0].text, 'BEGIN');
  assert.equal(locks[0], client.queries[1]);
  assert.equal(locks[0].values[0], 0x64706174); // 'dpat'
  assert.equal(locks[0].values[1], insert.values[0]);
  assert.equal(insert.values[0], '흥국##184');
  assert.deepEqual(locks[1].values, [0x636c7377, 0]);
  assert.ok(!client.queries.some((query) => query.text.includes('INSERT INTO merchant_map')));
});

test('맞지 않는 패턴은 거부하고 아무것도 쓰지 않는다', async () => {
  const client = recordingClient('흥국01184');
  const outcome = await applyClassification(client, { ...BASE, pattern: '흥국##999' });
  assert.equal(outcome.error, 'patternNoMatch');
  assert.ok(client.queries.some((query) => query.text === 'ROLLBACK'));
  assert.ok(!client.queries.some((query) => /INSERT INTO|UPDATE transactions/.test(query.text)));
});

// ── HTTP 가드 ─────────────────────────────────────────────────────────────

const HOST = 'budget.example';
function httpRequest(path, body, { origin = `https://${HOST}` } = {}) {
  const headers = new Headers({ host: HOST, 'content-type': 'application/json' });
  if (origin !== null) headers.set('origin', origin);
  return new Request(`https://${HOST}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
function deps(session, client) {
  const calls = { withClient: 0 };
  return {
    calls,
    value: {
      auth: async () => session,
      isAllowedEmail: (email) => email === 'owner@example.com',
      withClient: async (fn) => {
        calls.withClient += 1;
        return fn(client);
      },
    },
  };
}

test('HTTP: 미리보기 · 패턴 수정 모두 인증 · 명단 · Origin 을 DB 전에 본다, 응답은 no-store', async () => {
  const owner = { user: { email: 'owner@example.com' } };
  for (const [handler, path] of [
    [handlePatternPreview, '/api/classify/patterns/preview'],
    [handlePatternPost, '/api/classify/patterns'],
  ]) {
    for (const [session, origin, status] of [
      [null, `https://${HOST}`, 401],
      [{ user: { email: 'other@example.com' } }, `https://${HOST}`, 403],
      [owner, 'https://evil.example', 403],
    ]) {
      const d = deps(session, recordingClient('x'));
      const response = await handler(httpRequest(path, { pattern: '흥국##184' }, { origin }), d.value);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(d.calls.withClient, 0);
    }
  }
  // 모양이 틀린 패턴은 DB 에 닿기 전에 400 이고 되비추지 않는다.
  const d = deps(owner, recordingClient('x'));
  const response = await handlePatternPost(httpRequest('/api/classify/patterns', { action: 'delete', pattern: '비밀', direction: 'out' }), d.value);
  assert.equal(response.status, 400);
  assert.ok(!(await response.text()).includes('비밀'));
  assert.equal(d.calls.withClient, 0);
});

// ── 실제 왕복 ─────────────────────────────────────────────────────────────

function record(n, overrides = {}) {
  const month = overrides.year_month ?? '2026-01';
  return {
    account_id: 1,
    txn_at: `${month}-${String(10 + (n % 15)).padStart(2, '0')}T09:00:00+09:00`,
    description: '흥국01184',
    txn_type: 'CMS출금',
    institution: null,
    cp_acct_hash: null,
    amount: -52000,
    balance: null,
    memo: null,
    category: null,
    category_source: null,
    item: null,
    is_transfer: false,
    dedupe_key: `test-pattern-${n}`,
    year_month: month,
    ...overrides,
  };
}

async function seed(client) {
  await insertTransactions(client, [
    record(1, { year_month: '2026-01', description: '흥국01184' }),
    record(2, { year_month: '2026-02', description: '흥국02184' }),
    record(3, { year_month: '2026-03', description: '흥국03184' }),
    record(4, { year_month: '2026-04', description: '흥국04184', category: '변동비', category_source: 'manual' }),
    record(5, { year_month: '2026-02', description: '흥국02999' }), // 다른 뒷자리
    record(6, { year_month: '2026-02', description: '흥국02184', amount: 52000 }), // 반대 방향
    record(7, { year_month: '2026-03', description: '흥국03184', account_id: 2 }), // 다른 계좌
  ]);
}

async function rows(client) {
  const result = await client.query(
    `SELECT description, year_month, account_id, amount, category, item, category_source
       FROM transactions ORDER BY description, year_month, account_id, amount`,
  );
  return result.rows.map((r) => [r.description, r.year_month, Number(r.account_id), Number(r.amount), r.category, r.item, r.category_source]);
}

async function patternRows(client) {
  const result = await client.query('SELECT pattern, direction, category, item FROM description_patterns ORDER BY pattern, direction');
  return result.rows.map((r) => [r.pattern, r.direction, r.category, r.item]);
}

test('실제 DB: 패턴으로 저장하면 다른 달 · 계좌의 맞는 행이 바로 분류되고, 수정 · 삭제도 따라간다', async (t) => {
  await withScratchDatabase(t, 'pattern_apply', async (client) => {
    await seed(client);

    // 저장 전 미리보기.
    const preview = await previewPattern(client, { pattern: '흥국##184', key: '흥국01184' });
    assert.equal(preview.ok, true);
    assert.equal(preview.matchesKey, true);
    assert.deepEqual(
      [preview.out.count, preview.out.manual, preview.out.distinct, preview.in.count],
      [5, 1, 4, 1],
    );
    assert.equal(preview.out.samples[0], '흥국03184'); // 가장 자주 나온 적요(2건)가 먼저
    assert.ok(!preview.out.samples.includes('흥국02999'));
    assert.equal((await previewPattern(client, { pattern: '*' })).error, 'patternTooFewLiterals');

    const outcome = await applyClassification(client, { ...BASE, pattern: '흥국##184' });
    assert.deepEqual(outcome, { ok: true, updated: 4, mapped: true });
    assert.deepEqual(await patternRows(client), [['흥국##184', 'out', '고정비', '흥국보험']]);
    assert.deepEqual(await rows(client), [
      ['흥국01184', '2026-01', 1, -52000, '고정비', '흥국보험', 'map'],
      ['흥국02184', '2026-02', 1, -52000, '고정비', '흥국보험', 'map'],
      ['흥국02184', '2026-02', 1, 52000, null, null, null],
      ['흥국02999', '2026-02', 1, -52000, null, null, null],
      ['흥국03184', '2026-03', 1, -52000, '고정비', '흥국보험', 'map'],
      ['흥국03184', '2026-03', 2, -52000, '고정비', '흥국보험', 'map'],
      ['흥국04184', '2026-04', 1, -52000, '변동비', null, 'manual'],
    ]);
    assert.deepEqual(await listPatterns(client).then((list) => list.map((p) => [p.pattern, p.direction, p.category])), [
      ['흥국##184', 'out', '고정비'],
    ]);

    // 다음 업로드에도 걸린다.
    const classifier = await loadClassifier(client);
    const future = classifier.classify({ description: '흥국05184', txn_type: 'CMS출금', amount: -52000 });
    assert.deepEqual([future.category, future.item], ['고정비', '흥국보험']);

    // 수정은 맞는 행에 반영된다(manual 은 그대로).
    assert.deepEqual(await updatePattern(client, { pattern: '흥국##184', direction: 'out', category: '저축', item: null }), {
      ok: true,
      updated: 4,
    });
    const mapped = (await rows(client)).filter((r) => r[6] === 'map');
    assert.equal(mapped.length, 4);
    for (const r of mapped) assert.deepEqual([r[4], r[5]], ['저축', null]);
    assert.equal((await updatePattern(client, { pattern: '흥국##999', direction: 'out', category: '저축' })).error, 'patternNotFound');

    // 삭제하면 다시 분류된다 — 규칙(CMS출금에 걸리는 규칙은 없다)이 없으니 미분류.
    assert.deepEqual(await deletePattern(client, { pattern: '흥국##184', direction: 'out' }), {
      ok: true,
      reclassified: 0,
      unclassified: 4,
    });
    const after = await rows(client);
    assert.equal(after.filter((r) => r[6] === 'map').length, 0);
    assert.deepEqual(after.find((r) => r[0] === '흥국04184').slice(4), ['변동비', null, 'manual']);
    assert.deepEqual(await patternRows(client), []);
  });
});

test('실제 DB: 정확한 키 매핑이 있는 행은 패턴을 저장 · 삭제해도 그 매핑을 따른다', async (t) => {
  await withScratchDatabase(t, 'pattern_exact_wins', async (client) => {
    await seed(client);
    const exact = await applyClassification(client, { ...BASE, month: '2026-02', key: '흥국02184', category: '저축', item: '정확' });
    assert.equal(exact.ok, true);
    assert.equal((await applyClassification(client, { ...BASE, pattern: '흥국##184' })).ok, true);
    const find = async (description, month) =>
      (await rows(client)).find((r) => r[0] === description && r[1] === month && r[3] < 0 && r[2] === 1).slice(4);
    assert.deepEqual(await find('흥국02184', '2026-02'), ['저축', '정확', 'map']);
    assert.deepEqual(await find('흥국03184', '2026-03'), ['고정비', '흥국보험', 'map']);
    await deletePattern(client, { pattern: '흥국##184', direction: 'out' });
    assert.deepEqual(await find('흥국02184', '2026-02'), ['저축', '정확', 'map']);
    assert.deepEqual(await find('흥국03184', '2026-03'), [null, null, null]);
  });
});

test('실제 DB: 예전 월 토큰 매핑(코웨이렌탈)은 패턴이 생겨도 그대로 먼저 걸린다', async (t) => {
  await withScratchDatabase(t, 'pattern_stripmonth_compat', async (client) => {
    await client.query(`INSERT INTO merchant_map (description, direction, category, item) VALUES ('코웨이렌탈', 'out', '고정비', '정수기')`);
    await client.query(`INSERT INTO description_patterns (pattern, direction, category, item) VALUES ('코웨이*', 'out', '변동비', '패턴')`);
    const classifier = await loadClassifier(client);
    assert.equal(classifier.classify({ description: '코웨이09월렌탈', amount: -1 }).item, '정수기');
    assert.equal(classifier.classify({ description: '코웨이 필터', amount: -1 }).item, '패턴');
  });
});

// ── 동시 쓰기 ──────────────────────────────────────────────────────────────

function pauseBefore(client, pattern) {
  let signalPaused;
  let release;
  const paused = new Promise((resolve) => {
    signalPaused = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let armed = true;
  return {
    paused,
    release,
    client: {
      async query(text, params) {
        if (armed && typeof text === 'string' && text.includes(pattern)) {
          armed = false;
          signalPaused();
          await gate;
        }
        return client.query(text, params);
      },
    },
  };
}

async function waitingOnLock(observer, pid, promise) {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (done) return 'settled';
    const activity = await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (activity.rows[0]?.wait_event_type === 'Lock') return 'waiting';
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('두 번째 쓰기가 끝나지도, 잠금을 기다리지도 않았다');
}

async function openClients(t, url, n) {
  const { default: pg } = await import('pg');
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const c = new pg.Client({ connectionString: url });
    c.on('error', () => {});
    await c.connect();
    t.after(() => c.end().catch(() => {}));
    out.push({ client: c, pid: (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid });
  }
  return out;
}

test('동시 쓰기: 같은 패턴의 수정과 저장은 패턴 키 잠금으로 줄 서고, 나중 쓰기가 남는다', async (t) => {
  await withScratchDatabase(t, 'pattern_race_same', async (observer, url) => {
    await seed(observer);
    assert.equal((await applyClassification(observer, { ...BASE, pattern: '흥국##184', category: '변동비' })).ok, true);
    const [first, second] = await openClients(t, url, 2);

    const gated = pauseBefore(first.client, 'LIKE $1');
    const edit = updatePattern(gated.client, { pattern: '흥국##184', direction: 'out', category: '저축', item: null });
    await gated.paused;

    const save = applyClassification(second.client, { ...BASE, month: '2026-03', key: '흥국03184', pattern: '흥국##184', category: '고정비', item: '흥국보험' });
    assert.equal(await waitingOnLock(observer, second.pid, save), 'waiting');
    gated.release();
    const [a, b] = await Promise.all([edit, save]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);

    assert.deepEqual(await patternRows(observer), [['흥국##184', 'out', '고정비', '흥국보험']]);
    for (const r of (await rows(observer)).filter((row) => row[6] === 'map')) {
      assert.deepEqual([r[4], r[5]], ['고정비', '흥국보험'], r[0]);
    }
  });
});

test('동시 쓰기: 패턴 쓰기와 같은 행을 건드리는 정확한 키 쓰기가 교착 없이 줄 서고, 정확한 키가 이긴다', async (t) => {
  await withScratchDatabase(t, 'pattern_race_exact', async (observer, url) => {
    await seed(observer);
    // 1월에도 2월 적요(흥국02184)가 한 건 있다 — 2월에서 시작한 정확한 키 쓰기가 1월 행을 고친다.
    await insertTransactions(observer, [record(8, { year_month: '2026-01', description: '흥국02184' })]);
    const [first, second] = await openClients(t, url, 2);

    // T1: 1월 묶음(흥국01184)을 패턴으로 저장. 1월 행을 잠근 뒤, 다른 달 후보를 잠그기 직전에 멈춘다.
    const gated = pauseBefore(first.client, 'LIKE $1');
    const pattern = applyClassification(gated.client, { ...BASE, pattern: '흥국##184', category: '고정비', item: '패턴' });
    await gated.paused;

    // T2: 2월 묶음(흥국02184)을 정확한 키로 저장 — 2월 행을 잠그고 1월의 같은 적요 행을 고치려 한다.
    // 전체 쓰기 잠금이 없으면 T1(2월 행 대기)과 서로를 기다리는 교착이 된다.
    const exact = applyClassification(second.client, { ...BASE, month: '2026-02', key: '흥국02184', category: '저축', item: '정확' });
    assert.equal(await waitingOnLock(observer, second.pid, exact), 'waiting');
    gated.release();
    const [a, b] = await Promise.all([pattern, exact]);
    assert.deepEqual([a.ok, b.ok], [true, true]);

    // 정확한 키(나중 커밋)가 흥국02184 행 전부를 다스리고, 나머지는 패턴.
    for (const r of (await rows(observer)).filter((row) => row[3] < 0 && row[6] === 'map')) {
      const expected = r[0] === '흥국02184' ? ['저축', '정확'] : ['고정비', '패턴'];
      assert.deepEqual([r[4], r[5]], expected, `${r[0]} ${r[1]}`);
    }
  });
});
