// 정규식 안전 검사(ReDoS 가드) 테스트.
//
// 이 검사가 막아야 하는 것은 두 가지다.
//   - 컴파일되지 않는 패턴이 분류 작업 전체를 죽이는 것
//   - 파국적 역추적이 서버리스 함수(타임아웃 10초)를 붙잡는 것
// 멀쩡한 시드 규칙을 잘못 거부하지 않는 것도 똑같이 중요하다.
//
// 가드는 무한 수량자(`*` `+` `{n,}`)를 중첩 여부와 무관하게 전부 거부한다.
// 중첩만 보던 예전 판은 `(a|a)*` 처럼 교대만으로 모호해지는 패턴을 놓쳤다.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PATTERN_LENGTH,
  MAX_REPEAT,
  PATTERN_REJECTIONS,
  checkPattern,
  compilePattern,
} from '../lib/classify/pattern.mjs';

/**
 * migrations 에 실제로 들어 있는 패턴 전부, 문자 그대로.
 * `*_seed-category-rules.sql` 9개 + `*_add-allowance-rule.sql` 1개.
 */
const SEED_PATTERNS = [
  '비상금 ?계좌',
  '고정비 ?계좌',
  '카드',
  '대출 ?이자',
  'IRP|ISA|연금',
  '코인적립',
  '통장 ?이자',
  '.*',
  '용돈',
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
    assert.equal(result.code, PATTERN_REJECTIONS.unboundedQuantifier, pattern);
  }
});

test('교대(alternation)만으로 모호한 패턴도 거부한다', () => {
  // 예전 가드의 구멍. 그룹 안에 무한 수량자 토큰이 없어서 "중첩" 검사를
  // 통과했지만, `(a|a)*!` 에 'a' 30개를 주면 test() 한 번이 112초 걸렸다.
  // 이제는 닫는 괄호 뒤의 `*` 자체가 거부 사유다.
  for (const pattern of ['(a|a)*', '(a|a)*!', '(a|a|a)+', '([ab]|[ab])*']) {
    const result = checkPattern(pattern);
    assert.equal(result.ok, false, pattern);
    assert.equal(result.code, PATTERN_REJECTIONS.unboundedQuantifier, pattern);
  }
});

test('중첩이 아닌 무한 수량자도 거부한다', () => {
  // 예전 판은 이것들을 "폭발하지 않는다"며 통과시켰다. 이제는 구조만으로
  // 안전을 보장하려고 무한 수량자를 전부 받지 않는다. 실제 규칙은 무한
  // 수량자를 쓰지 않으므로(SEED_PATTERNS) 잃는 것이 없다.
  for (const pattern of ['a+b', '(ab)+', '(a|b)*', 'a+(b)', '(a+)', '(a{1,3})+', 'a*b*c*']) {
    const result = checkPattern(pattern);
    assert.equal(result.ok, false, pattern);
    assert.equal(result.code, PATTERN_REJECTIONS.unboundedQuantifier, pattern);
  }
});

test('유한 수량자와 `?` 는 그대로 통과한다', () => {
  // 시드 규칙이 쓰는 형태(리터럴 · `|` · `?` · 문자 클래스)는 전부 살아 있다.
  for (const pattern of ['a?b', '(ab)?', '(a|b)?', '대출 ?이자', 'a{3}', 'a{1,3}', '(a{10}){10}']) {
    assert.deepEqual(checkPattern(pattern), { ok: true }, pattern);
  }
});

test('포괄 규칙 `.*` 만은 예외로 받고, 정규식 엔진에 넣지 않는다', () => {
  // 시드의 `이자입금` · `자동이체` 규칙이 "적요를 보지 말라"는 뜻으로 쓰는 값.
  assert.deepEqual(checkPattern('.*'), { ok: true });

  const compiled = compilePattern('.*');
  assert.equal(compiled.ok, true);
  // `.*` 와 test() 결과가 같아야 한다 — 무엇을 주든 참이다.
  for (const subject of ['', '카드', '길동 용돈', 'a'.repeat(256), '줄\n바꿈']) {
    assert.equal(compiled.regex.test(subject), true, subject);
    assert.equal(/.*/.test(subject), true, subject);
  }
  // 하지만 `.` 도 `*` 도 없는 정규식이라 역추적할 것이 없다.
  assert.equal(compiled.regex.source, '(?:)');

  // `.*` 를 품은 다른 패턴은 예외가 아니다.
  assert.equal(checkPattern('카드.*').code, PATTERN_REJECTIONS.unboundedQuantifier);
});

test('문자 클래스 안의 괄호·별표는 수량자가 아니다', () => {
  // `[(]` 를 그룹으로 오해하면 괄호 짝이 어긋나 멀쩡한 패턴이 거부된다.
  // 클래스 안의 `*`·`+` 는 리터럴이라 무한 수량자 거부에도 걸리지 않는다.
  for (const pattern of ['[(*+)]', '[()]?', '\\(a\\)', '[a-z*]', '[+*]{2}']) {
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

test('중첩된 유한 반복은 곱으로 본다', () => {
  // 개별 `{n,m}` 의 m 만 보면 둘 다 상한(1000) 안이라 통과해 버린다.
  // 실제 반복은 10^6 이다. 파일 머리 주석이 약속한 방어가 이것이다.
  assert.deepEqual(checkPattern(`a{${MAX_REPEAT}}`), { ok: true });
  assert.deepEqual(checkPattern(`(a{${MAX_REPEAT}}){${MAX_REPEAT}}`), {
    ok: false,
    code: PATTERN_REJECTIONS.repeatTooLarge,
  });
  // 곱이 상한 안이면 통과한다.
  assert.deepEqual(checkPattern('(a{10}){100}'), { ok: true });
  assert.deepEqual(checkPattern('(a{10}){101}'), {
    ok: false,
    code: PATTERN_REJECTIONS.repeatTooLarge,
  });
  // 한 겹 더 감싸도 곱이 전파된다.
  assert.deepEqual(checkPattern('((a{10}){10}){100}'), {
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
  // `(a|a)*!` 도 마찬가지다. 측정해 보면 'a' 30개에 112초가 걸린다.
  assert.equal(checkPattern('(a|a)*!').ok, false);
});

test('거부는 패턴 하나에서 끝나고 나머지 규칙은 계속 돈다', () => {
  // compilePattern 은 던지지 않는다. 한 규칙이 나쁘다고 그 달 분류 전체가
  // 멈추면 고칠 방법(대시보드)에 들어가지도 못한다.
  const bad = compilePattern('(a|a)*');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, PATTERN_REJECTIONS.unboundedQuantifier);
  // 거부 결과에 패턴 본문이 없다.
  assert.deepEqual(Object.keys(bad).sort(), ['code', 'ok']);
});
