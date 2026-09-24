// 금액 헬퍼 테스트.
//
// 핵심은 하나다: **pg 가 BIGINT 를 문자열로 준다.** 그 사실을 잊은 코드는
// 조용히 틀린 합계를 낸다(`'1' + '2' === '12'`). 여기서 못을 박는다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { signOf, sumBigInt, toBigInt, toSafeNumber } from '../lib/money.mjs';

test('문자열 BIGINT 를 그대로 읽는다', () => {
  assert.equal(toBigInt('-2858322'), -2858322n);
  assert.equal(toBigInt('0'), 0n);
  assert.equal(toBigInt('+7'), 7n);
  assert.equal(toBigInt(' 42 '), 42n);
});

test('number·bigint 도 받는다', () => {
  assert.equal(toBigInt(34000), 34000n);
  assert.equal(toBigInt(-1n), -1n);
});

test('null·undefined 는 기본값으로 흘린다', () => {
  // 잔액이 빠진 행이 실제로 있다(fixture 의 H18).
  assert.equal(toBigInt(null), 0n);
  assert.equal(toBigInt(undefined), 0n);
  assert.equal(toBigInt(null, 7n), 7n);
});

test('2^53 을 넘는 문자열도 손실 없이 읽는다', () => {
  const huge = '9007199254740993'; // Number 로 바꾸면 ...992 가 된다
  assert.equal(toBigInt(huge), 9007199254740993n);
  // Number 를 한 번이라도 거치면 마지막 자리가 조용히 사라진다.
  assert.notEqual(BigInt(Number(huge)), toBigInt(huge));
});

test('정수가 아닌 값은 거부하고 값을 메시지에 넣지 않는다', () => {
  for (const bad of ['1.5', '1e3', '삼만원', '', '12,000', {}, true]) {
    assert.throws(
      () => toBigInt(bad),
      (error) => {
        // 빈 문자열은 모든 문자열에 포함되므로 검사에서 뺀다.
        if (bad !== '') {
          assert.ok(!error.message.includes(String(bad)), '값이 메시지에 들어갔다');
        }
        return true;
      },
      JSON.stringify(bad),
    );
  }
  assert.throws(() => toBigInt(1.5), /안전한 정수/);
});

test('부호는 문자열에서도 정확하다', () => {
  assert.equal(signOf('-1'), -1);
  assert.equal(signOf('0'), 0);
  assert.equal(signOf('1045850'), 1);
  assert.equal(signOf(-2858322), -1);
});

test('합계는 문자열을 이어 붙이지 않는다', () => {
  assert.equal(sumBigInt(['1', '2']), 3n);
  assert.equal(sumBigInt([]), 0n);
  assert.equal(sumBigInt(['-500000', '-500000', '34000']), -966000n);
});

test('안전 범위를 벗어나면 number 로 바꾸지 않는다', () => {
  assert.equal(toSafeNumber(-441865n), -441865);
  assert.throws(() => toSafeNumber(9007199254740993n), /안전한 정수 범위/);
  assert.throws(
    () => toSafeNumber(12345678901234567890n),
    (error) => {
      assert.ok(!error.message.includes('12345678901234567890'));
      return true;
    },
  );
});
