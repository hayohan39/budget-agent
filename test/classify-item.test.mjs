// 항목 이름 결정 순서 · 사람이 입력한 항목 검사 · 분류기가 남기는 출처/항목.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORY_SOURCES,
  EMPTY_DESCRIPTION_LABEL,
  ITEM_MAX_LENGTH,
  ITEM_REJECTIONS,
  effectiveSource,
  resolveItem,
  sanitizeItem,
} from '../lib/classify/item.mjs';
import { classifyRecords, createClassifier, storedSourceOf } from '../lib/classify/engine.mjs';

// ── 결정 순서 ─────────────────────────────────────────────────────────────

test('저장된 항목이 카드사 · 적요보다 먼저다', () => {
  assert.equal(
    resolveItem({ item: '생활카드', category: '카드대금', description: '삼성카드주식회사' }),
    '생활카드',
  );
  assert.equal(resolveItem({ item: '길동 ISA', category: '저축', description: '홍길동 ISA' }), '길동 ISA');
});

test('항목이 없으면 카드대금은 카드사 이름이다', () => {
  assert.equal(resolveItem({ item: null, category: '카드대금', description: '삼성카드주식회사' }), '삼성카드');
  assert.equal(resolveItem({ category: '카드대금', description: 'KB카드출금' }), 'KB국민카드');
});

test('그 밖에는 정규화한 적요 그대로다', () => {
  assert.equal(resolveItem({ item: null, category: '저축', description: '  김철수   IRP ' }), '김철수 IRP');
  // 카드대금이 아니면 카드사로 바꾸지 않는다.
  assert.equal(resolveItem({ category: '고정비', description: '삼성카드주식회사' }), '삼성카드주식회사');
  // 미분류도 적요가 항목이다.
  assert.equal(resolveItem({ category: null, description: '코웨이08월렌탈' }), '코웨이08월렌탈');
});

test('빈 항목(공백뿐)은 없는 것으로 본다', () => {
  assert.equal(resolveItem({ item: '   ', category: '저축', description: '코인적립' }), '코인적립');
});

test('적요가 비면 고정된 이름을 쓴다', () => {
  assert.equal(resolveItem({ category: null, description: '' }), EMPTY_DESCRIPTION_LABEL);
});

test('저장된 출처가 없으면 rule 로 본다', () => {
  assert.equal(effectiveSource(null), CATEGORY_SOURCES.rule);
  assert.equal(effectiveSource(undefined), CATEGORY_SOURCES.rule);
  assert.equal(effectiveSource('rule'), CATEGORY_SOURCES.rule);
  assert.equal(effectiveSource('map'), CATEGORY_SOURCES.map);
  assert.equal(effectiveSource('manual'), CATEGORY_SOURCES.manual);
  assert.equal(effectiveSource('something'), CATEGORY_SOURCES.rule);
});

// ── 입력 검사 ─────────────────────────────────────────────────────────────

test('항목 입력은 앞뒤 공백을 걷고 연속 공백을 모은다', () => {
  assert.deepEqual(sanitizeItem('  길동   ISA ', '홍길동 ISA'), { ok: true, item: '길동 ISA' });
});

test('비었거나 키와 같으면 null(따로 정하지 않음)', () => {
  assert.deepEqual(sanitizeItem('', '코인적립'), { ok: true, item: null });
  assert.deepEqual(sanitizeItem('   ', '코인적립'), { ok: true, item: null });
  assert.deepEqual(sanitizeItem(undefined, '코인적립'), { ok: true, item: null });
  assert.deepEqual(sanitizeItem(null, '코인적립'), { ok: true, item: null });
  assert.deepEqual(sanitizeItem(' 코인적립 ', '코인적립'), { ok: true, item: null });
  // 40자가 넘는 적요도 미리 채워진 그대로 보내면 받는다(null 로 저장).
  const longKey = '가'.repeat(ITEM_MAX_LENGTH + 10);
  assert.deepEqual(sanitizeItem(longKey, longKey), { ok: true, item: null });
});

test('제어 문자가 들어 있으면 거부한다(조용히 지우지 않는다)', () => {
  for (const bad of ['길동\nISA', '길동\tISA', 'a\u0000b', 'a\u007fb', '‮역순', 'a​b']) {
    assert.deepEqual(sanitizeItem(bad, 'x'), { ok: false, code: ITEM_REJECTIONS.controlChars });
  }
});

test('40자를 넘으면 거부한다(자르지 않는다)', () => {
  assert.deepEqual(sanitizeItem('가'.repeat(ITEM_MAX_LENGTH), 'x'), {
    ok: true,
    item: '가'.repeat(ITEM_MAX_LENGTH),
  });
  assert.deepEqual(sanitizeItem('가'.repeat(ITEM_MAX_LENGTH + 1), 'x'), {
    ok: false,
    code: ITEM_REJECTIONS.tooLong,
  });
  // 글자 수는 코드 포인트로 센다(서로게이트 쌍 하나가 한 글자).
  assert.equal(sanitizeItem('😀'.repeat(ITEM_MAX_LENGTH), 'x').ok, true);
});

test('문자열이 아니면 거부한다', () => {
  for (const bad of [1, {}, [], true]) {
    assert.deepEqual(sanitizeItem(bad, 'x'), { ok: false, code: ITEM_REJECTIONS.notString });
  }
});

// ── 분류기가 남기는 출처 · 항목 ───────────────────────────────────────────

const RULES = Object.freeze([
  { id: 1, txn_type: null, pattern: 'IRP|ISA|연금', sign: null, category: '저축', priority: 50 },
  { id: 2, txn_type: '자동이체', pattern: '.*', sign: null, category: '고정비', priority: 90 },
]);

test('매핑이 걸리면 map 과 매핑의 항목, 규칙이 걸리면 rule 과 null', () => {
  const classifier = createClassifier({
    rules: RULES,
    merchantMap: [
      { description: '코웨이08월렌탈', category: '고정비', item: '정수기' },
      { description: '길동 용돈', category: '용돈', item: null },
    ],
  });
  const records = [
    { description: '코웨이08월렌탈', txn_type: 'CMS출금', amount: -3780, category: null },
    { description: '길동 용돈', txn_type: '자동이체', amount: -500000, category: null },
    { description: '김철수 IRP', txn_type: '자동이체', amount: -300000, category: null },
    { description: '이영희', txn_type: '모임원송금', amount: -7500, category: null },
  ];
  classifyRecords(records, classifier);

  assert.deepEqual(
    records.map(({ category, category_source: source, item }) => [category, source ?? null, item ?? null]),
    [
      ['고정비', 'map', '정수기'],
      ['용돈', 'map', null],
      ['저축', 'rule', null],
      [null, null, null],
    ],
  );
});

test('storedSourceOf 는 분류기의 출처를 스키마 값으로 바꾼다', () => {
  assert.equal(storedSourceOf('merchant_map'), 'map');
  assert.equal(storedSourceOf('category_rules'), 'rule');
  assert.equal(storedSourceOf(null), null);
});
