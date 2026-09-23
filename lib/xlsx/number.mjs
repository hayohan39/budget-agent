// xlsx `<v>` 원문 -> 정확한 정수.
//
// 왜 parseInt / parseFloat / Number 를 그대로 쓰지 않는가
//   - `parseInt('34000.0')` 은 `34000` 을 주지만 `parseInt('1.2341234E7')` 은
//     `1` 을 준다. 조용히 틀리는 값이 금액 컬럼에 들어가면 알아채기 어렵다.
//   - 이 fixture 를 만든 도구는 Java 계열이라 절댓값이 1e7 이상이면 `1.2341234E7`
//     처럼 지수 표기로 적는다. 금액·잔액도 1천만 원을 넘으면 같은 표기가 된다.
//   - `Number()` 는 지수 표기를 제대로 읽지만 소수부가 있는지, 안전한 정수
//     범위인지는 알려주지 않는다. 반올림으로 덮으면 1원이 사라져도 검산이
//     통과해 버린다.
//
// 그래서 십진 문자열을 부동소수점으로 만들지 않고 자릿수 그대로 다룬다.
//
// 반환값에 값 자체를 되비추지 않는다. 호출자는 실패 사유와 셀 참조만으로
// 오류 메시지를 만든다(CI 로그·런타임 로그에 거래 금액이 남으면 안 된다).

const DECIMAL = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/;

/**
 * @typedef {{ ok: true, value: number } | { ok: false, reason: 'empty'|'format'|'fraction'|'unsafe' }} ExactIntegerResult
 */

/**
 * @param {string|null|undefined} raw
 * @returns {ExactIntegerResult}
 */
export function toExactInteger(raw) {
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };

  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'empty' };

  const match = DECIMAL.exec(text);
  if (!match) return { ok: false, reason: 'format' };

  const [, sign, intPart = '', fracPart = '', expPart] = match;
  const digits = `${intPart}${fracPart}`;
  if (digits === '') return { ok: false, reason: 'format' };

  const exponent = expPart === undefined ? 0 : Number.parseInt(expPart, 10);
  // 소수점 위치(digits 기준). 지수는 소수점을 그만큼 옮긴다.
  const pointAt = intPart.length + exponent;

  let wholeDigits;
  let fractionDigits;
  if (pointAt <= 0) {
    wholeDigits = '';
    fractionDigits = '0'.repeat(-pointAt) + digits;
  } else if (pointAt >= digits.length) {
    wholeDigits = digits + '0'.repeat(pointAt - digits.length);
    fractionDigits = '';
  } else {
    wholeDigits = digits.slice(0, pointAt);
    fractionDigits = digits.slice(pointAt);
  }

  // 소수부가 0 이 아니면 반올림하지 않고 거부한다. 원화에 소수점은 없지만
  // "없을 것"이라고 가정하지 않고 확인한다.
  if (/[1-9]/.test(fractionDigits)) return { ok: false, reason: 'fraction' };

  const trimmed = wholeDigits.replace(/^0+/, '');
  if (trimmed === '') return { ok: true, value: 0 }; // -0 도 0 으로 눌러 둔다.

  // 자릿수로 먼저 거른다. 여기서 걸러야 Number 변환에서 정밀도가 깨지지 않는다.
  if (trimmed.length > 15) return { ok: false, reason: 'unsafe' };

  const value = Number(`${sign === '-' ? '-' : ''}${trimmed}`);
  if (!Number.isSafeInteger(value)) return { ok: false, reason: 'unsafe' };
  return { ok: true, value };
}

/** 실패 사유를 사람이 읽는 한 마디로. 값은 절대 넣지 않는다. */
export function describeIntegerFailure(reason) {
  switch (reason) {
    case 'empty':
      return '값이 비어 있습니다';
    case 'fraction':
      return '정수가 아닙니다(소수부가 있습니다)';
    case 'unsafe':
      return '안전하게 다룰 수 있는 정수 범위를 넘습니다';
    default:
      return '숫자 형식이 아닙니다';
  }
}
