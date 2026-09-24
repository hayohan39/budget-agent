// 토스 거래내역의 시각 문자열을 "시간대 없이" 읽는다.
//
// 이 파일의 존재 이유 하나: `new Date('2026.08.01 03:33:28')` 을 쓰지 않는 것.
// 그렇게 만들면 값이 실행 환경의 시간대로 해석된다. Vercel 함수는 UTC 로 돌고
// 개발 노트북은 KST 로 도니까, 같은 파일을 같은 코드로 읽어도 **월초·월말 거래의
// 달이 바뀐다.** 월별 현금흐름표에서 8월 1일 03:33 거래가 7월로 넘어가는 식의
// 오류는 조용하고, 검산으로도 잡히지 않는다.
//
// 그래서 여기서는 숫자를 그대로 쪼개 들고 다니고, 시간대 적용은 저장 직전에
// 딱 한 곳(KST 고정)에서 하도록 남겨 둔다.

const TIMESTAMP = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const DATE_ONLY = /^(\d{4})\.(\d{2})\.(\d{2})$/;

// 달력상 존재하는 날짜인지만 본다. Date.UTC 는 시간대를 타지 않는 순수 달력
// 계산이라 여기 쓰는 것은 안전하다(결과 Date 객체를 값으로 쓰지는 않는다).
function isRealDate(year, month, day) {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

/**
 * `YYYY.MM.DD HH:mm:ss` -> 벽시계 그대로의 구성요소.
 *
 * @param {unknown} text
 * @returns {{ ok: true, value: { year:number, month:number, day:number, hour:number, minute:number, second:number, iso:string, raw:string } } | { ok:false, reason:'type'|'format'|'calendar' }}
 */
export function parseNaiveTimestamp(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'type' };

  const match = TIMESTAMP.exec(text);
  if (!match) return { ok: false, reason: 'format' };

  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);

  // 24시간제. 초는 항상 있다. 윤초(60)는 받지 않는다.
  if (month < 1 || month > 12) return { ok: false, reason: 'calendar' };
  if (day < 1 || day > 31) return { ok: false, reason: 'calendar' };
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: 'calendar' };
  if (!isRealDate(year, month, day)) return { ok: false, reason: 'calendar' };

  return {
    ok: true,
    value: {
      year,
      month,
      day,
      hour,
      minute,
      second,
      // 오프셋 없는 ISO 유사 표기. 접미사 `Z` 를 붙이지 않는 것이 핵심이다.
      // 고정폭이라 문자열 비교만으로 시각 순서를 알 수 있다.
      iso: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`,
      raw: text,
    },
  };
}

/**
 * `YYYY.MM.DD` -> 날짜 구성요소(시간대 없음).
 * @param {unknown} text
 */
export function parseNaiveDate(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'type' };

  const match = DATE_ONLY.exec(text);
  if (!match) return { ok: false, reason: 'format' };

  const [, y, mo, d] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31 || !isRealDate(year, month, day)) {
    return { ok: false, reason: 'calendar' };
  }

  return {
    ok: true,
    value: { year, month, day, iso: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` },
  };
}
