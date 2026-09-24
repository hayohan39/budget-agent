// 리포트 화면이 "어느 달을 볼까"를 정할 때 쓰는 것들.
//
// 화면이 SQL 을 직접 쓰지 않게 하려고 여기에 모았다. 형식 검사도 여기 있다 —
// 검사와 질의가 같은 파일에 있어야 "검사 없이 질의하는 경로"가 생기지 않는다.
//
// ── 로그 위생 ─────────────────────────────────────────────────────────────
//
// 이 파일에 `console` 이 없다. 에러는 `message` 조차 읽지 않는다(pg 메시지에는
// 문제가 된 값이 그대로 들어 있다). 돌려주는 것은 `YYYY-MM` 문자열뿐이고
// 거래 내용은 어떤 형태로도 나가지 않는다.

/**
 * `year_month` 의 유일한 형식. transactions · adjustments 의
 * CHECK (year_month ~ '^[0-9]{4}-[0-9]{2}$') 와 같은 정규식이다.
 */
export const YEAR_MONTH_PATTERN = /^[0-9]{4}-[0-9]{2}$/;

/** 한 번에 보여 줄 달의 최대 개수. 5년치면 선택 목록으로 충분하다. */
export const MAX_MONTHS = 60;

/**
 * `YYYY-MM` 인가. 쿼리에 넣기 전에 반드시 통과시킨다.
 *
 * 파라미터 바인딩을 쓰더라도 형식을 먼저 본다. 바인딩은 SQL 주입을 막을 뿐,
 * 형식이 틀린 값이 조용히 "빈 달"로 보이는 것은 막지 못한다.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isYearMonth(value) {
  return typeof value === 'string' && YEAR_MONTH_PATTERN.test(value);
}

/**
 * 거래가 하나라도 있는 달 목록. 최신순.
 *
 * `DISTINCT` 라서 건수도 금액도 나가지 않는다 — 달 이름뿐이다.
 *
 * @param {{query: Function}} client 열려 있는 연결
 * @param {{limit?: number}} [options]
 * @returns {Promise<string[]>} `YYYY-MM` 최신순. 거래가 없으면 빈 배열.
 */
export async function listYearMonths(client, options = {}) {
  const limit = options.limit ?? MAX_MONTHS;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('limit 은 1 이상의 정수여야 합니다.');
  }

  let result;
  try {
    result = await client.query(
      `SELECT DISTINCT year_month
         FROM transactions
        ORDER BY year_month DESC
        LIMIT $1`,
      [limit],
    );
  } catch {
    // pg 메시지에는 값이 섞여 나온다. 읽지 않는다.
    throw new Error('거래 월 목록을 읽지 못했습니다.');
  }

  // CHAR(7) 이라 길이는 정확히 7 이지만, 드라이버가 무엇을 주든 형식을 한 번 더
  // 거른다. 여기를 통과한 값만 화면의 링크와 다음 질의로 흘러간다.
  return result.rows.map((row) => String(row.year_month).trim()).filter(isYearMonth);
}
