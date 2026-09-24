// 카드대금 행의 적요 -> 카드사 이름.
//
// 왜 필요한가. 카드는 **카드사별 월 사용액만** 추적한다(PLAN.md: 건별 내역은
// 절대 저장하지 않는다). 그러려면 카드대금 행을 카드사로 묶어야 하는데, 적요
// 표기가 카드사마다 제각각이다. 실물에서 확인된 것만 해도 세 가지 형태다.
//
//   삼성카드주식회사   정식 법인명
//   현대카드          브랜드명
//   KB카드출금        브랜드 + 동작
//
// 그대로 `GROUP BY` 하면 같은 카드사가 표기마다 쪼개진다. 여기서 한 번
// 정규화해서 `삼성카드` · `현대카드` · `KB국민카드` 로 모은다.
//
// ── 왜 컬럼이 아니라 함수인가 ─────────────────────────────────────────────
//
// transactions 에 `counterparty` 컬럼을 새로 만들지 않는다. 적요에서 언제든
// 다시 계산할 수 있는 값이라 저장할 이유가 없고, 저장하지 않은 데이터는
// 유출되지 않는다(CLAUDE.md). 표기 매핑을 고칠 때 마이그레이션 대신 이 파일만
// 고치면 된다는 이점도 있다. 리포트는 집계 시점에 이 함수를 통과시킨 값으로
// 묶는다(= `GROUP BY counterparty` 와 같은 결과).

import { normalizeDescription } from '../toss/normalize.mjs';

/**
 * 적요에서 찾을 조각 -> 표준 카드사 이름.
 *
 * 순서가 곧 우선순위다. 위에서부터 먼저 걸리는 것을 쓴다. `국민` 보다 `KB` 가
 * 먼저 와야 하는 식의 함정은 없지만, 새 항목을 넣을 때 더 구체적인 표기를
 * 위에 두면 안전하다.
 *
 * 매칭은 대소문자를 가리지 않는다(`kb카드` · `BC카드`).
 */
export const CARD_ISSUERS = Object.freeze([
  { match: '신한', name: '신한카드' },
  { match: '삼성', name: '삼성카드' },
  { match: '현대', name: '현대카드' },
  { match: '롯데', name: '롯데카드' },
  { match: '하나', name: '하나카드' },
  { match: '비씨', name: 'BC카드' },
  { match: 'bc', name: 'BC카드' },
  { match: 'kb', name: 'KB국민카드' },
  { match: '국민', name: 'KB국민카드' },
  { match: 'nh', name: 'NH농협카드' },
  { match: '농협', name: 'NH농협카드' },
  { match: '우리', name: '우리카드' },
  { match: '씨티', name: '씨티카드' },
  { match: '카카오', name: '카카오뱅크카드' },
  { match: '토스', name: '토스뱅크카드' },
]);

/** 카드사를 알아볼 수 없을 때 쓰는 이름. */
export const UNKNOWN_ISSUER = '기타카드';

/** 적요에서 떼어 내는 군더더기. 회사 형태와 동작 표기. */
const NOISE = /(주식회사|㈜|\(주\)|출금|대금|결제|청구|이용료)/g;

/**
 * 카드대금 행의 적요 -> 카드사 이름.
 *
 * 표에 없는 카드사는 적요에서 군더더기만 떼어 낸 문자열을 그대로 쓴다.
 * `기타카드` 로 뭉뚱그리면 새 카드가 생겼을 때 사용자가 알아차리지 못한다.
 * 카드대금 행의 적요는 카드사 표기라서(`펌뱅킹출금` + `/카드/` 로 걸러진
 * 행에만 쓴다) 사람 이름이 들어올 경로가 아니다.
 *
 * @param {unknown} description 적요
 * @returns {string}
 */
export function cardIssuerOf(description) {
  const normalized = normalizeDescription(description);
  const haystack = normalized.toLowerCase();

  for (const { match, name } of CARD_ISSUERS) {
    if (haystack.includes(match)) return name;
  }

  const cleaned = normalized.replace(NOISE, '').trim();
  return cleaned === '' ? UNKNOWN_ISSUER : cleaned;
}
