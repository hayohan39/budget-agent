// `<v>` 원문 -> 정수 변환 테스트.
//
// 금액이 1원이라도 틀리면 검산이 의미를 잃는다. 여기서 쓰는 숫자는 fixture 의
// 값이거나 표기를 보이기 위한 가짜다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeIntegerFailure, toExactInteger } from '../lib/xlsx/number.mjs';

function value(raw) {
  const result = toExactInteger(raw);
  assert.equal(result.ok, true, `${JSON.stringify(raw)} 를 정수로 읽지 못했다`);
  return result.value;
}

function reason(raw) {
  const result = toExactInteger(raw);
  assert.equal(result.ok, false, `${JSON.stringify(raw)} 가 통과해 버렸다`);
  return result.reason;
}

test('`.0` 이 붙은 숫자를 정수로 읽는다', () => {
  assert.equal(value('34000.0'), 34000);
  assert.equal(value('-2858322.0'), -2858322);
  assert.equal(value('263.0'), 263);
  assert.equal(value('0.0'), 0);
  assert.equal(value('0.000'), 0);
  // 음수 0 도 0 이다(Object.is 로 -0 이 아님을 확인한다).
  assert.ok(Object.is(value('-0.0'), 0));
});

test('지수 표기를 자릿수 그대로 읽는다 — parseInt 는 여기서 1 을 준다', () => {
  assert.equal(Number.parseInt('1.2341234E7', 10), 1); // 쓰면 안 되는 이유.
  assert.equal(value('1.2341234E7'), 12341234);
  assert.equal(value('1.0E7'), 10000000);
  assert.equal(value('-1.5E1'), -15);
  assert.equal(value('5e2'), 500);
  assert.equal(value('1E0'), 1);
});

test('소수부가 남는 값은 반올림하지 않고 거부한다', () => {
  // 원화에 소수점은 없지만 "없을 것"이라고 가정하지 않는다.
  assert.equal(reason('12.5'), 'fraction');
  assert.equal(reason('-0.5'), 'fraction');
  assert.equal(reason('1e-3'), 'fraction');
  assert.equal(reason('1.23456E2'), 'fraction');
});

test('숫자가 아닌 값과 빈 값을 구분해 거부한다', () => {
  assert.equal(reason(''), 'empty');
  assert.equal(reason('   '), 'empty');
  assert.equal(reason(null), 'empty');
  assert.equal(reason(undefined), 'empty');
  assert.equal(reason('1,000'), 'format'); // 콤마는 표시 서식이지 값이 아니다.
  assert.equal(reason('1 000'), 'format');
  assert.equal(reason('０'), 'format'); // 전각 숫자.
  assert.equal(reason('NaN'), 'format');
  assert.equal(reason('Infinity'), 'format');
  assert.equal(reason('0x10'), 'format');
});

test('안전한 정수 범위를 넘으면 조용히 뭉개지 않고 거부한다', () => {
  assert.equal(reason('9007199254740993'), 'unsafe');
  assert.equal(reason('1.23456789012345678E20'), 'unsafe');
  // 경계 바로 아래는 통과한다.
  assert.equal(value('999999999999999'), 999999999999999);
});

test('실패 사유 설명에 값이 들어가지 않는다', () => {
  for (const raw of ['12.5', '9007199254740993', '1,000', '']) {
    const message = describeIntegerFailure(toExactInteger(raw).reason);
    assert.ok(!message.includes(raw.trim()) || raw.trim() === '', `사유 문구에 값이 샜다`);
  }
});

test('큰 지수를 자릿수 판정 전에 거른다 — 문자열을 할당하지 않는다', () => {
  // `<v>` 원문의 지수부에는 자릿수 제한이 없다. 예전 구현은 자릿수 상한을
  // 보기 **전에** `'0'.repeat(지수)` 로 패딩을 만들어서, `1E268000000` 하나에
  // 268MB 를 할당했고 더 큰 지수는 RangeError 로 던져 버렸다(사유 코드를
  // 돌려주기로 한 약속이 깨진다).
  const before = process.memoryUsage().heapUsed;
  for (const raw of ['1E268000000', '1E1000000000', '1E99999999999', '-9.9E2147483600']) {
    assert.equal(reason(raw), 'unsafe', raw); // 던지지 않고 사유 코드로 돌아온다
  }
  const grewMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
  assert.ok(grewMb < 32, `힙이 ${grewMb.toFixed(1)}MB 늘었다 — 패딩을 만들고 있다`);

  // 음의 큰 지수도 마찬가지다. 값이 전부 소수점 아래로 내려간다.
  assert.equal(reason('1E-268000000'), 'fraction');
  // 유효숫자가 없으면 지수가 아무리 커도 0 이다.
  assert.equal(value('0E268000000'), 0);
  assert.equal(value('0.000E-268000000'), 0);
});

test('큰 지수를 걸러도 정상 지수 표기는 그대로 읽는다', () => {
  // 토스 명세서(Java 계열 도구)는 절댓값 1e7 이상을 지수 표기로 적는다.
  assert.equal(value('1.2341234E7'), 12341234);
  assert.equal(value('3.4E4'), 34000);
  assert.equal(value('-1.5E6'), -1500000);
  assert.equal(value('9.99999999999999E14'), 999999999999999);
  assert.equal(value('1E14'), 100000000000000); // 15자리, 상한 바로 아래
  assert.equal(reason('1E15'), 'unsafe'); // 16자리는 기존 자릿수 상한 밖이다.
  // 앞의 0 은 자릿수로 세지 않는다.
  assert.equal(value('0000000000000000001'), 1);
  assert.equal(value('0.00000001E8'), 1);
});
