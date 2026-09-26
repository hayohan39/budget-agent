// 거래의 **방향** — 입금(in) · 출금(out).
//
// 같은 적요라도 들어온 돈과 나간 돈은 용도가 다르다(사용자 요청: "적요 하나에
// 입금/출금 구분되는 경우에는 구분을 해야해. 합계산하지 말고 항목별로"). 그래서
// /classify 의 묶음, merchant_map 의 키, 현금흐름표의 항목 줄이 모두 (적요, 방향)
// 단위다. 방향을 정하는 함수는 여기 하나뿐이다.
//
//   in   금액 > 0
//   out  금액 ≤ 0
//
// 금액 0 은 `out` 이다. 현금흐름표가 입금을 `amount > 0` 으로만 가르기 때문이다
// (lib/report/monthly.mjs 의 placeMainRow). 두 곳이 0 을 다르게 보면 /classify
// 에서 '입금' 묶음으로 고른 행이 리포트에서는 지출 칸에 나타난다.
//
// merchant_map.direction 에는 세 번째 값 `any` 가 있다. 방향 구분이 생기기 전에
// 저장된 매핑이며(마이그레이션이 기본값으로 채운다) 양쪽 방향에 걸린다. 화면에서
// 새로 만들 수는 없다 — /classify 의 쓰기는 늘 그 묶음의 구체적인 방향으로 저장한다.
//
// 이 파일에 console 호출이 없다.

import { toBigInt } from '../money.mjs';

/** 방향 값. merchant_map_direction_valid CHECK 와 같은 세 값이다. */
export const DIRECTIONS = Object.freeze({
  in: 'in',
  out: 'out',
  any: 'any',
});

/** 거래 한 건이 가질 수 있는 방향(= /classify 묶음이 가질 수 있는 방향). */
export const ROW_DIRECTIONS = Object.freeze([DIRECTIONS.in, DIRECTIONS.out]);

/** 화면에 쓰는 이름. */
export const DIRECTION_LABELS = Object.freeze({
  in: '입금',
  out: '출금',
  any: '방향 무관',
});

/**
 * 금액 -> 방향.
 *
 * @param {unknown} amount 부호 있는 금액(문자열 · number · bigint)
 * @returns {'in'|'out'}
 */
export function directionOf(amount) {
  return toBigInt(amount ?? 0) > 0n ? DIRECTIONS.in : DIRECTIONS.out;
}

/** 거래 한 건의 방향으로 쓸 수 있는 값인가(in · out). */
export function isRowDirection(value) {
  return value === DIRECTIONS.in || value === DIRECTIONS.out;
}

/** 저장된 매핑의 방향으로 쓸 수 있는 값인가(in · out · any). */
export function isMappingDirection(value) {
  return isRowDirection(value) || value === DIRECTIONS.any;
}

/**
 * SQL 에서 방향으로 행을 거르는 조건. `$n` 자리에 방향 문자열을 바인딩한다.
 *
 * 값은 늘 파라미터로 넘긴다 — 여기서 만드는 것은 자리 번호뿐이다.
 *
 * @param {number} index 방향 값이 들어갈 파라미터 번호
 * @returns {string}
 */
export function directionPredicate(index) {
  if (!Number.isInteger(index) || index < 1) throw new Error('파라미터 번호가 올바르지 않습니다.');
  return `(($${index}::text = 'in' AND amount > 0) OR ($${index}::text = 'out' AND amount <= 0))`;
}
