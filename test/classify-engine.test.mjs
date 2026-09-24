// 분류 엔진 테스트. DB 없이 돈다.
//
// 시드 규칙(migrations/*_seed-category-rules.sql)을 그대로 복사해 두고,
// 마스킹 fixture 24행을 통과시켜 실제로 기대한 분류가 나오는지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openXlsxFile } from '../lib/xlsx/workbook.mjs';
import { parseTossStatement } from '../lib/toss/statement.mjs';
import { toTransactionRecords } from '../lib/toss/normalize.mjs';
import {
  CARD_CATEGORY,
  MAX_SUBJECT_LENGTH,
  classifyRecords,
  compileRules,
  createClassifier,
} from '../lib/classify/engine.mjs';
import { cardIssuerOf, UNKNOWN_ISSUER } from '../lib/classify/issuer.mjs';
import { PATTERN_REJECTIONS } from '../lib/classify/pattern.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'toss-sample-masked.xlsx');

const ACCOUNTS = Object.freeze([
  { id: 1, role: 'main', last4: '1288', nickname: '메인' },
  { id: 2, role: 'fixed', last4: '2222', nickname: '고정비' },
  { id: 3, role: 'emergency', last4: '3333', nickname: '비상금' },
]);

/**
 * migrations/20260922021606097_seed-category-rules.sql 의 INSERT 와 같은 값.
 * id 는 SERIAL 이라 삽입 순서대로 1..9 가 된다.
 */
const SEED_RULES = Object.freeze([
  { id: 1, txn_type: null, pattern: '비상금 ?계좌', sign: null, category: '비상금이체', priority: 10 },
  { id: 2, txn_type: null, pattern: '고정비 ?계좌', sign: null, category: '고정비이체', priority: 20 },
  { id: 3, txn_type: '펌뱅킹출금', pattern: '카드', sign: -1, category: '카드대금', priority: 30 },
  { id: 4, txn_type: null, pattern: '대출 ?이자', sign: null, category: '주거비', priority: 40 },
  { id: 5, txn_type: null, pattern: 'IRP|ISA|연금', sign: null, category: '저축', priority: 50 },
  { id: 6, txn_type: null, pattern: '코인적립', sign: null, category: '저축', priority: 60 },
  { id: 7, txn_type: null, pattern: '통장 ?이자', sign: null, category: '이자', priority: 70 },
  { id: 8, txn_type: '이자입금', pattern: '.*', sign: null, category: '이자', priority: 80 },
  { id: 9, txn_type: '자동이체', pattern: '.*', sign: null, category: '고정비', priority: 90 },
]);

function fixtureRecords() {
  const statement = parseTossStatement(openXlsxFile(FIXTURE).sheet(0));
  return toTransactionRecords(statement, ACCOUNTS);
}

function seedClassifier(merchantMap = []) {
  return createClassifier({ rules: SEED_RULES, merchantMap });
}

// ── 우선순위 ───────────────────────────────────────────────────────────────

test('merchant_map 이 category_rules 를 이긴다', () => {
  const row = { description: '코인적립', txn_type: '자동이체', amount: -200000 };

  assert.equal(seedClassifier().classify(row).category, '저축');

  const corrected = seedClassifier([{ description: '코인적립', category: '변동비' }]);
  const result = corrected.classify(row);
  assert.equal(result.category, '변동비');
  assert.equal(result.source, 'merchant_map');
  assert.equal(result.ruleId, null);
});

test('merchant_map 키는 적요 정규화를 거친다', () => {
  // 저장은 공백이 하나, 들어온 적요는 공백이 둘·앞뒤 공백까지 있는 경우.
  const classifier = seedClassifier([{ description: '대출 이자', category: '손수정' }]);
  const result = classifier.classify({ description: '  대출   이자 ', txn_type: '자동이체', amount: -1 });

  assert.equal(result.category, '손수정');
});

test('priority 가 작은 규칙이 먼저 걸린다', () => {
  // `코인적립` 은 priority 60 이고 `자동이체` 포괄 규칙은 90 이다.
  const result = seedClassifier().classify({
    description: '코인적립',
    txn_type: '자동이체',
    amount: -200000,
  });

  assert.equal(result.category, '저축');
  assert.equal(result.source, 'category_rules');
  assert.equal(result.ruleId, 6);
});

test('priority 가 같으면 id 가 작은 규칙이 이긴다(결정적)', () => {
  const tied = [
    { id: 42, txn_type: null, pattern: '용돈', sign: null, category: '나중에만든규칙', priority: 55 },
    { id: 7, txn_type: null, pattern: '용돈', sign: null, category: '먼저만든규칙', priority: 55 },
  ];

  // 입력 순서를 뒤집어도 결과가 같아야 한다 — 그것이 "결정적"이라는 뜻이다.
  for (const rules of [tied, [...tied].reverse()]) {
    const result = createClassifier({ rules }).classify({
      description: '길동 용돈',
      txn_type: '자동이체',
      amount: -500000,
    });
    assert.equal(result.category, '먼저만든규칙');
    assert.equal(result.ruleId, 7);
  }
});

test('정렬 키가 (priority, id) 다', () => {
  const { rules } = compileRules([
    { id: 3, pattern: 'c', category: 'C', priority: 20 },
    { id: 1, pattern: 'a', category: 'A', priority: 20 },
    { id: 2, pattern: 'b', category: 'B', priority: 10 },
  ]);

  assert.deepEqual(rules.map((rule) => [rule.priority, rule.id]), [[10, 2], [20, 1], [20, 3]]);
});

// ── 규칙 가드 ──────────────────────────────────────────────────────────────

test('sign 가드가 없으면 전자카드비(입금)가 카드대금이 된다', () => {
  const incoming = { description: '전자카드비', txn_type: '펌뱅킹출금', amount: 1045850 };

  // 시드 규칙에는 sign = -1 가드가 있다 -> 걸리지 않는다.
  assert.equal(seedClassifier().classify(incoming).category, null);

  // 가드를 뺀 규칙으로는 오분류된다. 이 테스트가 가드의 존재 이유다.
  const noGuard = createClassifier({
    rules: [{ id: 1, txn_type: '펌뱅킹출금', pattern: '카드', sign: null, category: '카드대금', priority: 30 }],
  });
  assert.equal(noGuard.classify(incoming).category, '카드대금');
});

test('txn_type 가드가 다르면 걸리지 않는다', () => {
  // 적요에 `카드` 가 있고 출금이지만 거래 유형이 다르다.
  const result = seedClassifier().classify({
    description: '카드포인트',
    txn_type: 'CMS출금',
    amount: -1000,
  });
  assert.equal(result.category, null);
});

test('금액 0 은 어떤 부호 가드에도 걸리지 않는다', () => {
  const rules = [
    { id: 1, txn_type: null, pattern: '테스트', sign: -1, category: '출금', priority: 10 },
    { id: 2, txn_type: null, pattern: '테스트', sign: 1, category: '입금', priority: 20 },
  ];
  const result = createClassifier({ rules }).classify({ description: '테스트', amount: 0 });
  assert.equal(result.category, null);
});

test('BIGINT 가 문자열로 와도 부호를 제대로 읽는다', () => {
  // pg 는 BIGINT 를 문자열로 준다. '-2858322' 를 양수로 읽으면 카드대금을 놓친다.
  const result = seedClassifier().classify({
    description: '삼성카드주식회사',
    txn_type: '펌뱅킹출금',
    amount: '-2858322',
  });
  assert.equal(result.category, CARD_CATEGORY);
});

// ── 나쁜 규칙 ──────────────────────────────────────────────────────────────

test('컴파일되지 않는 규칙은 건너뛰고 나머지는 계속 돈다', () => {
  const rules = [
    { id: 1, txn_type: null, pattern: '[a-', sign: null, category: '깨진규칙', priority: 10 },
    { id: 2, txn_type: null, pattern: '(a+)+', sign: null, category: '폭발규칙', priority: 20 },
    { id: 3, txn_type: null, pattern: '코인적립', sign: null, category: '저축', priority: 30 },
  ];
  const classifier = createClassifier({ rules });

  assert.equal(classifier.ruleCount, 1);
  assert.deepEqual(classifier.skipped, [
    { id: 1, code: PATTERN_REJECTIONS.invalid },
    { id: 2, code: PATTERN_REJECTIONS.nestedQuantifier },
  ]);
  // 살아 있는 규칙은 그대로 동작한다.
  assert.equal(classifier.classify({ description: '코인적립', amount: -1 }).category, '저축');
});

test('건너뛴 규칙 보고에 패턴 본문이 들어가지 않는다', () => {
  const classifier = createClassifier({
    rules: [{ id: 1, pattern: '(홍길동+)+', category: 'x', priority: 1 }],
  });

  assert.equal(classifier.skipped.length, 1);
  assert.ok(!JSON.stringify(classifier.skipped).includes('홍길동'));
});

test('규칙이 하나도 없으면 전부 미분류다(던지지 않는다)', () => {
  const classifier = createClassifier();
  assert.deepEqual(classifier.classify({ description: '무엇이든', amount: -1 }), {
    category: null,
    source: null,
    ruleId: null,
    counterparty: null,
  });
});

test('아주 긴 적요도 상한까지만 정규식에 넣는다', () => {
  const classifier = createClassifier({
    rules: [{ id: 1, pattern: '끝', category: '끝', priority: 1 }],
  });
  const long = `${'가'.repeat(MAX_SUBJECT_LENGTH)}끝`;

  // 상한 밖의 글자는 보지 않는다 — 입력 길이를 묶어 두는 것이 두 번째 방어선이다.
  assert.equal(classifier.classify({ description: long, amount: -1 }).category, null);
});

// ── 카드사 정규화 ──────────────────────────────────────────────────────────

test('카드대금만 counterparty(카드사)를 만든다', () => {
  const classifier = seedClassifier();

  const card = classifier.classify({
    description: '삼성카드주식회사',
    txn_type: '펌뱅킹출금',
    amount: -2858322,
  });
  assert.equal(card.category, CARD_CATEGORY);
  assert.equal(card.counterparty, '삼성카드');

  const other = classifier.classify({ description: '코인적립', txn_type: '자동이체', amount: -1 });
  assert.equal(other.counterparty, null);
});

test('표기가 달라도 같은 카드사로 모인다', () => {
  assert.equal(cardIssuerOf('삼성카드주식회사'), '삼성카드');
  assert.equal(cardIssuerOf('삼성카드'), '삼성카드');
  assert.equal(cardIssuerOf('KB카드출금'), 'KB국민카드');
  assert.equal(cardIssuerOf('kb카드'), 'KB국민카드');
  assert.equal(cardIssuerOf('국민카드'), 'KB국민카드');
  assert.equal(cardIssuerOf('현대카드'), '현대카드');
  assert.equal(cardIssuerOf('신한카드㈜'), '신한카드');
  assert.equal(cardIssuerOf('BC카드'), 'BC카드');
});

test('모르는 카드사는 군더더기만 떼고 그대로 쓴다', () => {
  assert.equal(cardIssuerOf('한국카드주식회사'), '한국카드');
  assert.equal(cardIssuerOf('  '), UNKNOWN_ISSUER);
  assert.equal(cardIssuerOf(null), UNKNOWN_ISSUER);
});

// ── fixture 전체 ───────────────────────────────────────────────────────────

test('fixture 24행이 시드 규칙으로 기대한 분류를 받는다', () => {
  const records = fixtureRecords();
  const classifier = seedClassifier();
  const categories = records.map((record) => classifier.classify(record).category);

  // 파일 순서(최신순) 그대로. 24행.
  assert.deepEqual(categories, [
    null,        // 김철수 입금
    null,        // 홍길동 입금
    null,        // 전자카드비 (입금 — sign 가드가 막는다)
    '카드대금',   // 삼성카드주식회사
    null,        // 코웨이08월렌탈 (CMS출금 — 포괄 규칙이 자동이체만 본다)
    null,        // 이영희 모임원송금
    '카드대금',   // KB카드출금
    '카드대금',   // 삼성카드주식회사
    null,        // 김철수 입금(월급)
    '카드대금',   // 현대카드
    null,        // 김철수 모임원송금
    '저축',      // 코인적립
    '주거비',    // 대출 이자
    '저축',      // 김철수 IRP
    '저축',      // 철수 연금저축
    '저축',      // 김철수 ISA
    '저축',      // 홍길동 ISA
    '저축',      // 길동 IRP
    '고정비',    // 길동 용돈  ← 용돈 규칙이 없어 자동이체 포괄 규칙에 걸린다
    '고정비',    // 철수 용돈  ← 같음
    '비상금이체', // 비상금 계좌
    '고정비이체', // 고정비 계좌
    null,        // 김철수 입금(휴가비)
    '이자',      // 통장 이자
  ]);
});

test('카드대금 4건이 카드사 3곳으로 묶인다', () => {
  const classifier = seedClassifier();
  const issuers = fixtureRecords()
    .map((record) => classifier.classify(record))
    .filter((result) => result.category === CARD_CATEGORY)
    .map((result) => result.counterparty);

  assert.deepEqual(issuers, ['삼성카드', 'KB국민카드', '삼성카드', '현대카드']);
});

test('classifyRecords 가 레코드에 분류를 채우고 재실행해도 같다', () => {
  const records = fixtureRecords();
  const classifier = seedClassifier();

  const first = classifyRecords(records, classifier);
  assert.deepEqual(first, { classified: 16, unmatched: 8 });
  const snapshot = records.map((record) => record.category);

  // 두 번째 실행은 이미 분류된 행을 건드리지 않는다(멱등).
  const second = classifyRecords(records, classifier);
  assert.deepEqual(second, { classified: 0, unmatched: 8 });
  assert.deepEqual(records.map((record) => record.category), snapshot);
});

test('사람이 고친 매핑을 넣으면 미분류가 줄어든다', () => {
  const records = fixtureRecords();
  const classifier = seedClassifier([
    { description: '길동 용돈', category: '용돈' },
    { description: '철수 용돈', category: '용돈' },
    { description: '코웨이08월렌탈', category: '고정비' },
  ]);
  classifyRecords(records, classifier);

  assert.equal(records.filter((record) => record.category === '용돈').length, 2);
  assert.equal(records.filter((record) => record.category === null).length, 7);
});
