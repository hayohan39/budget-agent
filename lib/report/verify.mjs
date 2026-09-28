// 검산 — 계산한 순증감이 메인 계좌의 실제 잔액 변화와 같은가.
//
//   실현순증감(거래 금액의 합)  ==  당월 마지막 잔액 − 전월 말 잔액
//
// 왼쪽은 `amount` 컬럼에서, 오른쪽은 `balance` 컬럼에서 나온다. 두 값은 서로
// 다른 출처라서 대조가 의미를 갖는다. 어긋나면 거래 누락이거나 파싱 오류다.
// PLAN.md 가 말하듯 **손으로 덮을 값이 아니다** — 그래서 거래 금액만 더한
// `실현순증감` 과 맞춰 본다.
//
// ── 이 모듈이 지키는 것 ───────────────────────────────────────────────────
//
//   1. **던지지 않는다.** 불일치는 사용자에게 알려 줄 정보이지 장애가 아니다.
//      여기서 던지면 리포트 화면이 통째로 비고, 정작 사용자는 무엇이 어긋났는지
//      볼 수 없다. 예상치 못한 입력도 `reason` 코드로 돌려준다.
//   2. **아무것도 출력하지 않는다.** `console` 호출이 이 파일에 없다.
//      ⚠️ 돌려주는 객체에는 금액과 차액이 들어 있다. 이것은 **결과**이지
//         로그가 아니다 — 호출자가 로그로 흘리지 않아야 한다
//         (lib/toss/reconcile.mjs 와 같은 규약).
//   3. 잔액을 추정하지 않는다. 경계 행의 잔액 칸이 비어 있으면 balanceSpan 이
//      **같은 달 안에서 잔액이 있는 가장 가까운 행**부터 그 사이 거래 금액으로만
//      이어 계산한다(lib/report/monthly.mjs). 빈 칸을 0 으로 읽지도, 다른 달 값으로
//      메우지도 않는다. 그렇게 건너간 행은 대조에서 빠지므로 `inferred` 로 밝힌다.
//      그 달의 잔액 칸이 전부 비어 있으면 "검산하지 않았다"고 말한다.

/** 검산하지 못한 사유. 금액이 아니라 코드다. */
export const VERIFY_REASONS = Object.freeze({
  noMainAccount: 'noMainAccount',
  noRows: 'noRows',
  balanceMissing: 'balanceMissing',
  unavailable: 'unavailable',
});

function skip(reason) {
  return {
    target: 'main',
    checked: false,
    ok: null,
    expected: null,
    actual: null,
    difference: null,
    inferred: false,
    reason,
  };
}

/**
 * 메인 계좌 검산.
 *
 * @param {object} report `aggregateMonthly` 의 결과
 * @returns {{target:'main', checked:boolean, ok:boolean|null, expected:number|null,
 *            actual:number|null, difference:number|null, inferred:boolean, reason:string|null}}
 *   `difference` 는 `실현순증감 − 잔액변화` 다. 양수면 거래 합계가 잔액 변화보다
 *   크다는 뜻이고, 그만큼의 출금이 파일에서 빠졌거나 입금이 두 번 잡혔다는
 *   신호다.
 */
export function verifyMonthlyReport(report) {
  try {
    const balances = report?.계좌별잔액변화;
    if (!Array.isArray(balances)) return skip(VERIFY_REASONS.unavailable);

    const main = balances.find((entry) => entry?.role === 'main');
    if (main === undefined) return skip(VERIFY_REASONS.noMainAccount);
    if (main.derived !== true) {
      // balanceSpan 이 남긴 사유를 그대로 쓴다(noRows · balanceMissing).
      return skip(main.reason ?? VERIFY_REASONS.unavailable);
    }

    const expected = main.change;
    // 거래 금액의 합. 종합정산 표의 합계와 같은 값이다(수동 보정은 2026-09 에 없앴다).
    const actual = report?.종합정산?.실현순증감;
    if (!Number.isFinite(expected) || !Number.isFinite(actual)) {
      return skip(VERIFY_REASONS.unavailable);
    }

    const difference = actual - expected;
    return {
      target: 'main',
      checked: true,
      ok: difference === 0,
      expected,
      actual,
      difference,
      // 경계 행의 잔액 칸이 비어 금액으로 이어 계산했는가(balanceSpan). 그 행들은
      // 대조에서 빠진다 — 화면이 밝힌다.
      inferred: main.inferredOpening === true || main.inferredClosing === true,
      reason: null,
    };
  } catch {
    // 여기까지 오면 리포트 모양이 예상과 다른 것이다. 그래도 던지지 않는다.
    return skip(VERIFY_REASONS.unavailable);
  }
}
