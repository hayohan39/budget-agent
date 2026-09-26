// 월마다 바뀌는 적요 토큰을 지우는 `stripMonthToken` 테스트. DB 없이 돈다.
//
// 사용자 문제: "코웨이08월렌탈의 경우 월별로 코웨이09월렌탈, 코웨이10월렌탈
// 바뀌게 되는 고정비야." — 이 함수가 그 세 적요를 같은 보조 키로 모은다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { stripMonthToken } from '../lib/classify/month-pattern.mjs';

test('월 토큰(1~2자리 숫자 + 월)을 지운다', () => {
  assert.equal(stripMonthToken('코웨이08월렌탈'), '코웨이렌탈');
  assert.equal(stripMonthToken('코웨이09월렌탈'), '코웨이렌탈');
  assert.equal(stripMonthToken('코웨이10월렌탈'), '코웨이렌탈');
  assert.equal(stripMonthToken('코웨이9월렌탈'), '코웨이렌탈'); // 한 자리 숫자
  assert.equal(stripMonthToken('9월코웨이렌탈'), '코웨이렌탈'); // 토큰이 맨 앞
  assert.equal(stripMonthToken('코웨이렌탈9월'), '코웨이렌탈'); // 토큰이 맨 뒤
});

test('숫자가 앞에 없는 월 은 지우지 않는다(거짓 양성 방지)', () => {
  // '월세' 자체는 숫자로 시작하지 않으므로 토큰이 아니다 — 지울 것이 없으니 null.
  assert.equal(stripMonthToken('월세'), null);
  assert.equal(stripMonthToken('이번달 급여'), null); // '월' 자체가 없다
  assert.equal(stripMonthToken('월급'), null);
  // 숫자가 있어도 바로 앞이 아니면(월과 붙어 있지 않으면) 토큰이 아니다.
  assert.equal(stripMonthToken('8 코웨이 월세'), null);
});

test('숫자 + 월이 섞인 적요는 그 부분만 지우고 월세 같은 단어는 남긴다', () => {
  // '08월' 은 지우지만 뒤의 '월세'는 숫자가 바로 앞에 없으므로 그대로 남는다.
  assert.equal(stripMonthToken('08월 월세'), '월세');
});

test('같은 적요 안의 월 토큰 여러 개를 모두 지운다', () => {
  assert.equal(stripMonthToken('12월코웨이3월렌탈'), '코웨이렌탈');
  assert.equal(stripMonthToken('08월 코웨이 09월 렌탈'), '코웨이 렌탈');
});

test('토큰이 하나도 없으면 null 이다(원문을 그대로 돌려주지 않는다)', () => {
  assert.equal(stripMonthToken('코웨이렌탈'), null);
  assert.equal(stripMonthToken('김철수'), null);
  assert.equal(stripMonthToken(''), null);
});

test('지운 뒤 남는 것이 없거나 공백뿐이면 null 이다', () => {
  assert.equal(stripMonthToken('08월'), null);
  assert.equal(stripMonthToken('9월'), null);
  assert.equal(stripMonthToken('08월 9월'), null);
});

test('문자열이 아닌 입력은 null 이다(던지지 않는다)', () => {
  for (const value of [null, undefined, 42, {}, [], true]) {
    assert.equal(stripMonthToken(value), null, String(value));
  }
});

test('공백을 정리한다 — 지운 자리의 이중 공백을 하나로 모으고 양끝을 자른다', () => {
  assert.equal(stripMonthToken('코웨이  08월  렌탈'), '코웨이 렌탈');
  assert.equal(stripMonthToken(' 08월 렌탈'), '렌탈');
  assert.equal(stripMonthToken('렌탈 08월 '), '렌탈');
});

test('반복 호출해도 같은 결과다(결정적) — 전역 정규식 상태가 새지 않는다', () => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal(stripMonthToken('코웨이08월렌탈'), '코웨이렌탈');
    assert.equal(stripMonthToken('월세'), null);
  }
});

// ── ReDoS 안전성 / 퍼즈 ──────────────────────────────────────────────────

const RANDOM_CHARS = '0123456789월코웨이렌탈 세이번달급여\t\n가나다라마바사아자차카타파하';

function randomString(maxLength) {
  const length = Math.floor(Math.random() * maxLength);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += RANDOM_CHARS[Math.floor(Math.random() * RANDOM_CHARS.length)];
  }
  return out;
}

test('퍼즈: 5000개의 무작위 문자열에 대해 던지지 않고 빠르게 끝난다', () => {
  const samples = [];
  for (let i = 0; i < 5000; i += 1) samples.push(randomString(60));
  // 적대적으로 숫자와 '월'을 아주 많이 반복하는 긴 문자열도 섞는다.
  samples.push('9월'.repeat(2000));
  samples.push('0'.repeat(5000) + '월');
  samples.push('월'.repeat(5000));

  const start = process.hrtime.bigint();
  for (const sample of samples) {
    assert.doesNotThrow(() => stripMonthToken(sample));
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  // 5000+ 회 호출을 합쳐 50ms 안에 끝나야 한다(선형 시간 정규식이면 여유가 크다).
  assert.ok(elapsedMs < 50, `너무 오래 걸렸다: ${elapsedMs}ms`);
});
