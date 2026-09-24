// 금액 다루기. 전부 정수 원(KRW)이고 DB 에서는 BIGINT 다.
//
// 이 파일이 있는 이유 하나: **pg 는 BIGINT 를 문자열로 준다.** `amount` ·
// `balance` 는 `'-500000'` 처럼 문자열로 돌아온다. 그대로 `+` 하면 문자열이
// 이어 붙고(`'1' + '2' === '12'`), `Number()` 로 바꾸면 2^53 을 넘는 순간
// 조용히 값이 어긋난다. 그래서 집계는 BigInt 로만 하고, 밖으로 나갈 때만
// 안전 범위를 확인해 number 로 바꾼다.
//
// 값은 어떤 에러 메시지에도 넣지 않는다(CLAUDE.md). 무엇이 잘못됐는지만 말한다.

/** 문자열로 받은 BIGINT 가 정수인지 보는 패턴. 지수·소수·공백을 받지 않는다. */
const INTEGER_TEXT = /^[+-]?\d+$/;

/**
 * number | string | bigint -> bigint.
 *
 * null · undefined 는 `fallback`(기본 0n)으로 흘린다 — `balance` 가 빠진 행이
 * 실제로 있다(fixture 의 H18).
 *
 * @param {unknown} value
 * @param {bigint} [fallback]
 * @returns {bigint}
 */
export function toBigInt(value, fallback = 0n) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error('금액이 안전한 정수가 아닙니다.');
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!INTEGER_TEXT.test(text)) {
      // 값은 넣지 않는다. 적요가 섞인 문자열이 들어올 수도 있다.
      throw new Error('금액 문자열이 정수 형식이 아닙니다.');
    }
    return BigInt(text);
  }
  throw new Error('금액의 타입이 올바르지 않습니다.');
}

/**
 * 부호만 본다. 분류 규칙의 `sign` 가드가 쓴다.
 * @param {unknown} value
 * @returns {-1|0|1}
 */
export function signOf(value) {
  const amount = toBigInt(value);
  if (amount > 0n) return 1;
  if (amount < 0n) return -1;
  return 0;
}

/**
 * bigint -> number. 안전 범위를 벗어나면 던진다(값은 메시지에 넣지 않는다).
 *
 * 결과 객체는 JSON 으로 직렬화돼 나가므로 bigint 그대로 내보낼 수 없다.
 * 원 단위 정수라 9,007조 원까지는 무손실이다 — 실제로 넘을 일은 없지만,
 * 넘었는데 조용히 반올림되는 것이 이 프로젝트에서 가장 나쁜 실패다.
 *
 * @param {bigint} value
 * @returns {number}
 */
export function toSafeNumber(value) {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error('집계 금액이 안전한 정수 범위를 벗어났습니다.');
  }
  return asNumber;
}

/**
 * 합계. 빈 배열이면 0n.
 * @param {Iterable<unknown>} values
 * @returns {bigint}
 */
export function sumBigInt(values) {
  let total = 0n;
  for (const value of values) total += toBigInt(value);
  return total;
}
