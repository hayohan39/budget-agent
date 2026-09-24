// 행 단위 잔액 검산.
//
//   잔액[n] - 잔액[n+1] == 금액[n]      (최신순 정렬 기준)
//
// PLAN.md 가 말하는 파싱 자가 검증이다. 한 행이라도 밀리거나 부호가 뒤집히면
// 여기서 바로 드러난다.
//
// 이 함수는 **던지지 않는다.** 불일치는 파일의 성질일 수도 있고(누락된 잔액,
// 기간 경계), 파서의 버그일 수도 있다. 어느 쪽인지는 호출자가 판단한다.
// 잔액이 없는 행은 그 행이 끼는 두 쌍을 건너뛰고, 건너뛴 이유를 남긴다.

/**
 * @param {Array<{ sheetRow?: number, amount: number, balance: number|null }>} rows
 *   파일에 적힌 순서(최신순) 그대로의 행.
 */
export function reconcileBalances(rows) {
  const mismatches = [];
  const skipped = [];
  let checked = 0;

  for (let index = 0; index + 1 < rows.length; index += 1) {
    const current = rows[index];
    const next = rows[index + 1];
    const pair = {
      index,
      sheetRow: current.sheetRow ?? null,
      nextSheetRow: next.sheetRow ?? null,
    };

    if (current.balance === null || current.balance === undefined) {
      skipped.push({ ...pair, reason: 'balance-missing', at: 'current' });
      continue;
    }
    if (next.balance === null || next.balance === undefined) {
      skipped.push({ ...pair, reason: 'balance-missing', at: 'next' });
      continue;
    }

    checked += 1;
    const expected = current.balance - next.balance;
    if (expected !== current.amount) {
      // 차액은 사람이 원인을 찾는 데 필요하다. 다만 이것은 "결과 객체"이지
      // 로그가 아니다 — 호출자가 로그로 흘리지 않도록 주의해야 한다.
      mismatches.push({ ...pair, expected, actual: current.amount, difference: expected - current.amount });
    }
  }

  return {
    assumedOrder: 'newest-first',
    pairs: Math.max(rows.length - 1, 0),
    checked,
    matched: checked - mismatches.length,
    mismatches,
    skipped,
    ok: mismatches.length === 0,
  };
}
