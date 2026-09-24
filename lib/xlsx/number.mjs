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
 * 안전하게 다룰 수 있는 정수부 자릿수. Number.MAX_SAFE_INTEGER 가 16자리
 * (9007199254740991)라, 15자리까지는 어떤 값이든 정확히 표현된다.
 */
const MAX_WHOLE_DIGITS = 15;

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

  // ── 패딩을 만들기 **전에** 자릿수를 판정한다 ───────────────────────────
  //
  // 아래 `'0'.repeat(...)` 두 줄은 지수 크기만큼 문자열을 만든다. 지수는 셀
  // 원문에서 오고 DECIMAL 정규식이 그 자릿수를 제한하지 않아서
  // (`1E268000000`), 먼저 거르지 않으면 정작 판정을 하는 MAX_WHOLE_DIGITS
  // 검사에 닿기도 전에 수백 MB 를 할당한다. 더 큰 지수(`1E1000000000`)는
  // repeat 가 RangeError 로 던져서, 실패를 사유 코드로 돌려주기로 한 이
  // 함수의 약속까지 깨진다.
  //
  // 아래 세 분기는 지금 코드가 내는 답을 그대로 두고 앞당길 뿐이다.
  const significant = digits.replace(/^0+/, '');

  // 유효숫자가 없으면 지수와 무관하게 0 이다(`0`, `-0`, `0.000`, `0E9999`).
  if (significant === '') return { ok: true, value: 0 };

  // 소수부를 먼저 본다. 원래 순서가 "소수부 → 자릿수"라서, 둘 다 걸리는 값의
  // 사유 코드가 바뀌지 않으려면 이 순서를 지켜야 한다. 소수부는 digits 안에서만
  // 나오므로 패딩 없이 볼 수 있다(pointAt >= digits.length 면 소수부가 없다).
  if (pointAt < digits.length && /[1-9]/.test(digits.slice(Math.max(pointAt, 0)))) {
    return { ok: false, reason: 'fraction' };
  }

  // 정수부는 pointAt 자리이고, 앞의 0 을 걷어내면 정확히 이만큼 남는다.
  // 여기서 상한을 넘으면 아래 MAX_WHOLE_DIGITS 검사도 똑같이 넘는다.
  if (pointAt - (digits.length - significant.length) > MAX_WHOLE_DIGITS) {
    return { ok: false, reason: 'unsafe' };
  }

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
  if (trimmed.length > MAX_WHOLE_DIGITS) return { ok: false, reason: 'unsafe' };

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
