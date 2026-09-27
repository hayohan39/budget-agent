// 가계부 통계 — 월별 추이(수입 · 저축 · 주거비 · 고정비 · 변동비)의 **데이터**.
//
// ── 단일 출처 ─────────────────────────────────────────────────────────────
//
// 분류 규칙을 여기서 다시 세우지 않는다. 달마다 월별 현금흐름표와 **같은 집계**
// (`aggregateMonthly`, lib/report/monthly.mjs)를 돌리고, 그 결과에서 다섯 값을
// 꺼낼 뿐이다. 그래서 통계 화면의 숫자는 그 달 현금흐름표의 종합정산 표와 같다.
//
//   수입    종합정산.수입        — 메인 계좌로 들어온 돈(+ 사람이 '수입' · '이자'로
//                                  고른 메인 출금의 음수 줄). 내 계좌 간 이동
//                                  (`고정비이체` · `비상금이체` · is_transfer)은
//                                  `계좌간이동` 으로 빠져 여기 들어오지 않고,
//                                  고정비 · 비상금 계좌의 입금(메인에서 간 돈)과
//                                  이자도 세지 않는다 → 이체가 수입을 부풀리지 않는다.
//   저축    고정지출1 의 `저축`
//   주거비  고정지출1 의 `주거비`
//   고정비  고정지출2 의 `고정비` + 계좌간이동 의 `고정비`
//           — 현금흐름표 종합정산의 '고정비(계좌 이체 포함)' 줄과 같은 정의다.
//             메인에서 바로 나간 고정비 분류 지출 + 고정비 계좌로 옮긴 돈.
//   변동비  종합정산.변동지출    — 카드대금 + 카드 아닌 변동지출(변동비 · 기타 ·
//                                  미분류 출금 · 표에 없는 분류).
//
// 지출 네 가지는 **나간 돈의 크기(양수)** 로 바꿔 돌려준다(현금흐름표는 저장 부호
// 그대로 음수). 그래프에서 막대가 위로 자라게 하려는 것이다. 현금흐름표가 메인
// 계좌의 입금을 분류와 무관하게 수입 섹션에 두므로(placeMainRow) 지출 칸에는
// 출금만 모인다 — 환불 · 카드 취소 입금은 지출을 줄이지 않고 수입에 잡힌다.
// 값을 0 으로 자르거나 부호를 따로 고치지 않는다(집계 그대로).
//
// ── 로그 위생 ─────────────────────────────────────────────────────────────
//
// 이 파일에 `console` 이 없다. DB 에러는 `message` 를 읽지 않고 고정 문장으로
// 바꾼다. 돌려주는 값은 달 이름 · 다섯 합계 · 거래 건수뿐이다(적요 · 계좌 없음).

import { buildMonthlyReport } from './monthly.mjs';
import { isYearMonth, listYearMonths } from './months.mjs';

/** 그래프 · 표의 순서. `key` 는 돌려주는 점의 필드 이름이다. */
export const TREND_SERIES = Object.freeze([
  Object.freeze({ key: '수입', label: '수입', kind: 'income' }),
  Object.freeze({ key: '저축', label: '저축', kind: 'expense' }),
  Object.freeze({ key: '주거비', label: '주거비', kind: 'expense' }),
  Object.freeze({ key: '고정비', label: '고정비', kind: 'expense' }),
  Object.freeze({ key: '변동비', label: '변동비', kind: 'expense' }),
]);

/** 기간 선택지(개월). `all` 은 `listYearMonths` 의 상한(60개월)까지다. */
export const TREND_RANGES = Object.freeze({ '6': 6, '12': 12, '24': 24, all: null });
export const DEFAULT_TREND_RANGE = '12';

function totalOf(items, key) {
  const found = (items ?? []).find((item) => item.key === key);
  return typeof found?.total === 'number' ? found.total : 0;
}

/** 0 을 -0 으로 만들지 않는 부호 뒤집기. */
function spent(value) {
  return value === 0 ? 0 : -value;
}

/**
 * `aggregateMonthly` 의 결과 하나 -> 그 달의 다섯 값.
 *
 * @param {ReturnType<typeof import('./monthly.mjs').aggregateMonthly>} report
 * @returns {{ yearMonth: string, hasData: boolean, count: number, 수입: number, 저축: number, 주거비: number, 고정비: number, 변동비: number }}
 */
export function trendPointOf(report) {
  const fixed1 = report.고정지출1?.items ?? [];
  const fixed2 = report.고정지출2?.items ?? [];
  const moves = report.계좌간이동?.items ?? [];
  const count = Number(report.거래건수 ?? 0);
  return {
    yearMonth: String(report.yearMonth),
    hasData: count > 0,
    count,
    수입: report.종합정산.수입,
    저축: spent(totalOf(fixed1, '저축')),
    주거비: spent(totalOf(fixed1, '주거비')),
    고정비: spent(totalOf(fixed2, '고정비') + totalOf(moves, '고정비')),
    변동비: spent(report.종합정산.변동지출),
  };
}

/** `YYYY-MM` 다음 달. */
export function nextYearMonth(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`;
}

/**
 * 첫 달부터 마지막 달까지 빠짐없이(오름차순). 거래가 없는 달도 한 칸으로 남긴다 —
 * 그래프에서 달 사이가 조용히 붙어 버리면 추이를 잘못 읽는다.
 *
 * @param {string} first `YYYY-MM`
 * @param {string} last `YYYY-MM`
 * @param {number} [max] 안전 상한
 */
export function monthSpan(first, last, max = 120) {
  if (!isYearMonth(first) || !isYearMonth(last) || first > last) return [];
  const months = [];
  let cursor = first;
  while (cursor <= last && months.length < max) {
    months.push(cursor);
    cursor = nextYearMonth(cursor);
  }
  return months;
}

/**
 * 달별 점 -> 빈 달을 채운 오름차순 목록. 거래가 없는 달은 다섯 값이 `null` 이다
 * (0 이 아니다 — "0원 썼다" 와 "자료가 없다" 는 다르다).
 *
 * @param {Array<ReturnType<typeof trendPointOf>>} points
 */
export function fillTrendMonths(points) {
  const withData = points.filter((point) => point.hasData);
  if (withData.length === 0) return [];
  const byMonth = new Map(withData.map((point) => [point.yearMonth, point]));
  const sorted = [...byMonth.keys()].sort();
  return monthSpan(sorted[0], sorted[sorted.length - 1]).map(
    (yearMonth) =>
      byMonth.get(yearMonth) ?? {
        yearMonth,
        hasData: false,
        count: 0,
        수입: null,
        저축: null,
        주거비: null,
        고정비: null,
        변동비: null,
      },
  );
}

/**
 * 최근 `months` 개월(달력 기준, 거래가 있는 가장 최근 달에서 거꾸로)의 추이.
 *
 * @param {{query: Function}} client 열려 있는 연결
 * @param {{ months?: number|null }} [options] null 이면 listYearMonths 의 상한까지
 */
export async function loadMonthlyTrends(client, { months = 12 } = {}) {
  const available = await listYearMonths(client);
  if (available.length === 0) return [];

  const latest = available[0];
  const inRange =
    months === null
      ? available
      : available.filter((yearMonth) => {
          const [ly, lm] = latest.split('-').map(Number);
          const [y, m] = yearMonth.split('-').map(Number);
          return (ly - y) * 12 + (lm - m) < months;
        });

  const points = [];
  // 한 연결에서 차례로 읽는다. 개인 가계부라 달 수가 작다(상한 60).
  for (const yearMonth of [...inRange].sort()) {
    points.push(trendPointOf(await buildMonthlyReport(client, yearMonth)));
  }
  return fillTrendMonths(points);
}
