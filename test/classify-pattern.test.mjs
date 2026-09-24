// 정규식 안전 검사(ReDoS 가드) 테스트.
//
// 이 검사가 막아야 하는 것은 두 가지다.
//   - 컴파일되지 않는 패턴이 분류 작업 전체를 죽이는 것
//   - 파국적 역추적이 서버리스 함수(타임아웃 10초)를 붙잡는 것
// 멀쩡한 시드 규칙을 잘못 거부하지 않는 것도 똑같이 중요하다.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PATTERN_LENGTH,
  MAX_REPEAT,
  PATTERN_REJECTIONS,
  checkPattern,
  compilePattern,
} from '../lib/classify/pattern.mjs';

/** migrations/*_seed-category-rules.sql 의 패턴 그대로. */
const SEED_PATTERNS = [
  '비상금 ?계좌',
  '고정비 ?계좌',
  '카드',
  '대출 ?이자',
  'IRP|ISA|연금',
  '코인적립',
  '통장 ?이자',
  '.*',
];

test('시드 규칙의 패턴은 전부 통과한다', () => {
  for (const pattern of SEED_PATTERNS) {
    assert.deepEqual(checkPattern(pattern), { ok: true }, pattern);
    const compiled = compilePattern(pattern);
    assert.equal(compiled.ok, true, pattern);
  }
});

test('부분 문자열 매칭이다 — 앵커를 붙이지 않는다', () => {
  const compiled = compilePattern('카드');
  assert.equal(compiled.ok, true);
  assert.equal(compiled.regex.test('삼성카드주식회사'), true);
  assert.equal(compiled.regex.test('KB카드출금'), true);
  assert.equal(compiled.regex.test('통장 이자'), false);
});

test('g 플래그를 쓰지 않아 같은 RegExp 를 재사용해도 결과가 같다', () => {
  const { regex } = compilePattern('카드');
  // g 플래그가 붙어 있으면 lastIndex 가 남아 두 번째 호출이 false 가 된다.
  assert.equal(regex.test('삼성카드'), true);
  assert.equal(regex.test('삼성카드'), true);
  assert.equal(regex.flags, '');
});

test('빈 패턴을 거부한다', () => {
  for (const pattern of ['', '   ', null, undefined, 42]) {
    const result = checkPattern(pattern);
    assert.equal(result.ok, false);
    assert.equal(result.code, PATTERN_REJECTIONS.empty);
  }
});

test('길이 상한을 넘는 패턴을 거부한다', () => {
  const ok = 'a'.repeat(MAX_PATTERN_LENGTH);
  const tooLong = 'a'.repeat(MAX_PATTERN_LENGTH + 1);

  assert.deepEqual(checkPattern(ok), { ok: true });
  assert.deepEqual(checkPattern(tooLong), { ok: false, code: PATTERN_REJECTIONS.tooLong });
});

test('중첩된 무한 수량자를 거부한다', () => {
  const evil = [
    '(a+)+',
    '(a*)*',
    '(a+)*',
    '(a*)+',
    '(x+|y)*',
    '((a+))+',      // 한 겹 더 감싸도 전파된다
    '(a+){2,}',     // {n,} 도 무한이다
    '(\\d+|\\s)+$',
    '카드(대금+)+',
  ];
  for (const pattern of evil) {
    const result = checkPattern(pattern);
    assert.equal(result.ok, false, pattern);
    assert.equal(result.code, PATTERN_REJECTIONS.nestedQuantifier, pattern);
  }
});

test('중첩이 아닌 무한 수량자는 통과시킨다', () => {
  // 그룹 밖의 `+`, 그룹에 안 걸린 `*`, 유한 수량자 중첩은 폭발하지 않는다.
  for (const pattern of ['a+b', '(ab)+', '(a|b)*', 'a+(b)', '(a+)', '(a{1,3})+', 'a*b*c*']) {
    assert.deepEqual(checkPattern(pattern), { ok: true }, pattern);
  }
});

test('문자 클래스 안의 괄호·별표는 수량자가 아니다', () => {
  // `[(]` 를 그룹으로 오해하면 괄호 짝이 어긋나 멀쩡한 패턴이 거부된다.
  for (const pattern of ['[(*+)]', '[()]+', '\\(a+\\)+', '[a-z*]+']) {
    assert.deepEqual(checkPattern(pattern), { ok: true }, pattern);
  }
});

test('과도한 반복 횟수를 거부한다', () => {
  assert.deepEqual(checkPattern(`a{${MAX_REPEAT}}`), { ok: true });
  assert.deepEqual(checkPattern(`a{${MAX_REPEAT + 1}}`), {
    ok: false,
    code: PATTERN_REJECTIONS.repeatTooLarge,
  });
  assert.deepEqual(checkPattern('(a{2,5000})'), {
    ok: false,
    code: PATTERN_REJECTIONS.repeatTooLarge,
  });
});

test('수량자가 아닌 중괄호는 리터럴로 통과한다', () => {
  assert.deepEqual(checkPattern('금액{원}'), { ok: true });
});

test('괄호 짝이 맞지 않으면 거부한다', () => {
  for (const pattern of ['(a', 'a)', '((a)']) {
    const result = checkPattern(pattern);
    assert.equal(result.ok, false, pattern);
  }
});

test('컴파일되지 않는 패턴은 코드만 돌려주고 던지지 않는다', () => {
  // 구조 검사는 통과하지만 RegExp 가 거부하는 패턴.
  const result = compilePattern('[a-');
  assert.equal(result.ok, false);
  assert.equal(result.code, PATTERN_REJECTIONS.invalid);
});

test('거부 결과에 패턴 본문이 들어가지 않는다', () => {
  const secret = '홍길동'.repeat(MAX_PATTERN_LENGTH);
  const result = compilePattern(secret);

  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes('홍길동'), '패턴 본문이 새어 나왔다');
});

test('거부된 형태가 실제로 느렸다는 것을 확인한다', () => {
  // 가드가 없었다면 어떤 일이 일어나는지. `(a+)+$` 에 a 만 30개 주고 실패시키면
  // 역추적이 2^30 번 일어난다. 가드가 막으므로 여기서는 "거부되는지"만 본다.
  // (실제로 컴파일해서 돌리면 이 테스트가 몇 분 동안 멈춘다.)
  assert.equal(checkPattern('(a+)+$').ok, false);
});
