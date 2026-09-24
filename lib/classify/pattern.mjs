// category_rules.pattern 을 RegExp 로 바꾸는 유일한 통로.
//
// 이 패턴들은 **DB 에서 온다.** 사람이 대시보드에서 규칙을 추가할 수 있고,
// 그 문자열이 그대로 정규식 엔진에 들어간다. 나쁜 패턴 하나가 할 수 있는 일:
//
//   1. 컴파일 실패로 분류 작업 전체를 죽인다.
//   2. 파국적 역추적(catastrophic backtracking)으로 서버리스 함수를 붙잡는다.
//      `(a+)+b` 계열은 입력 길이에 지수로 폭발한다. Vercel 함수 타임아웃이
//      10초라 함수는 죽고, 그 달 분류는 영영 끝나지 않는다.
//
// 그래서 여기서 **컴파일 전에** 거른다. 의존성은 쓰지 않는다(정규식 정적
// 분석 라이브러리는 그 자체가 큰 공격면이고, CLAUDE.md 가 패키지 추가에
// 보수적으로 가라고 한다).
//
// ── 무엇을 막는가 ─────────────────────────────────────────────────────────
//
//   a. 길이 상한(MAX_PATTERN_LENGTH). 시드 규칙 중 가장 긴 것이 14자다.
//      200자면 실사용에 충분히 넉넉하면서, 사람이 읽고 검토할 수 있는 크기다.
//   b. **무한 수량자 전부.** `*` · `+` · `{n,}` 는 중첩 여부를 따지지 않고
//      거부한다(아래 "왜 전부 막는가" 참고).
//   c. 유한 반복의 곱(`{n,m}` 중첩). 그룹 안에서 본 최대 반복 배수를 기억했다가
//      그룹에 붙은 수량자와 곱한다. `(a{1000}){1000}` 은 각각은 상한 안이지만
//      곱이 10^6 이라 거부된다. 개별 `{n,m}` 의 m 상한만 보면 이게 새어 나간다.
//
// ── 왜 무한 수량자를 전부 막는가 ──────────────────────────────────────────
//
// 이전 판은 "무한 수량자가 **중첩**될 때"만 거부했다. 그 검사는 그룹 안에
// `*`/`+`/`{n,}` 토큰이 직접 있었는지만 추적해서, 교대(alternation)만으로
// 모호해지는 `(a|a)*` 류를 통째로 놓쳤다. 실제로 `(a|a)*!` 는 검사를 통과했고
// `'a'.repeat(30)` 을 주면 `regex.test` 한 번이 112초가 걸렸다.
//
// 그 구멍의 두 번째 방어선으로 적요 길이 상한(engine.mjs 의 MAX_SUBJECT_LENGTH,
// 256자)을 들었지만 이것은 **계산이 틀린 주장**이었다. 역추적이 입력 길이의
// 지수라면 2^40 ≈ 10^12 이라 40자에서 이미 실사용상 무한대다. 256자로 묶는
// 것은 방어가 아니다.
//
// 무한 수량자를 아예 받지 않으면 역추적 경로의 수가 패턴에 적힌 유한 반복의
// 곱으로 **구조적으로** 묶인다(위 c 가 그 곱을 MAX_REPEAT 로 막는다). 지수
// 폭발이 "일어나기 어렵다"가 아니라 "일어날 수 없다"가 된다. 길이 상한이나
// 워커 타임아웃보다 강한 보장이고, 새 의존성도 워커 스레드도 필요 없다.
//
// 실제 규칙이 무한 수량자를 쓰지 않기 때문에 가능한 선택이다. 시드 규칙
// (migrations/*_seed-category-rules.sql)과 용돈 규칙
// (migrations/*_add-allowance-rule.sql)이 쓰는 것은 리터럴 · `|` · `?` 뿐이고,
// 유일한 무한 수량자는 포괄 규칙의 `.*` 하나다. 그리고 그 `.*` 는 "적요를 보지
// 말고 거래 유형만 보라"는 **뜻**으로 쓰인 값이라(seed 주석), 정규식 엔진에
// 넣을 필요 자체가 없다 — 아래 MATCH_ALL_PATTERN 으로 따로 받는다.
//
// 플래그는 쓰지 않는다(빈 플래그). 특히 `u` 플래그를 붙이면 `\-` 같은
// 관대한 이스케이프가 전부 컴파일 오류가 되어, 사람이 손으로 넣은 기존
// 규칙이 조용히 통째로 버려진다. 매칭은 **부분 문자열** 매칭이다 — 시드
// 규칙의 `카드` 는 `삼성카드주식회사` 에 걸린다.

/** 패턴 길이 상한. 시드 규칙 최대 길이의 10배 이상이다. */
export const MAX_PATTERN_LENGTH = 200;

/** `{n,m}` 에서 허용하는 최대 반복 횟수. 중첩된 경우는 그 **곱**을 본다. */
export const MAX_REPEAT = 1000;

/**
 * 적요를 보지 않는 포괄 규칙의 패턴.
 *
 * 시드 규칙 두 개(`이자입금` · `자동이체`)가 이 값을 "적요는 보지 말고 거래
 * 유형만으로 판정하라"는 뜻으로 쓴다(seed-category-rules.sql 주석). 무한
 * 수량자를 금지하면서도 이 규칙들이 그대로 돌아야 하므로, 정규식으로 컴파일
 * 하지 않고 여기서 이름 붙여 받는다.
 */
export const MATCH_ALL_PATTERN = '.*';

/**
 * `.*` 를 대신하는 정규식. 빈 정규식은 모든 문자열에 길이 0 으로 걸리므로
 * `test()` 결과가 `.*` 와 언제나 같고, 역추적할 것이 아예 없다.
 */
const MATCH_ALL_REGEX = /(?:)/;

/** 거부 사유 코드. 패턴 본문은 어디에도 싣지 않는다. */
export const PATTERN_REJECTIONS = Object.freeze({
  empty: 'patternEmpty',
  tooLong: 'patternTooLong',
  unboundedQuantifier: 'patternUnboundedQuantifier',
  repeatTooLarge: 'patternRepeatTooLarge',
  invalid: 'patternInvalid',
});

const UNBOUNDED = new Set(['*', '+']);

/**
 * `{` 로 시작하는 자리에서 수량자를 읽는다.
 *
 * @param {string} pattern
 * @param {number} start `{` 의 위치
 * @returns {{ end:number, unbounded:boolean, max:number } | null}
 *   수량자가 아니면 null(정규식에서 `{` 는 리터럴일 수 있다).
 */
function readBraceQuantifier(pattern, start) {
  const close = pattern.indexOf('}', start);
  if (close === -1) return null;
  const body = pattern.slice(start + 1, close);
  const match = /^(\d+)(,(\d*)?)?$/.exec(body);
  if (!match) return null;

  const min = Number(match[1]);
  const hasComma = match[2] !== undefined;
  const upper = match[3];
  const unbounded = hasComma && (upper === undefined || upper === '');
  const max = unbounded
    ? Number.POSITIVE_INFINITY
    : Number(upper === undefined || upper === '' ? min : upper);
  return { end: close, unbounded, max: Math.max(min, max) };
}

/** 현재 그룹이 품은 최대 반복 배수를 올린다. */
function bump(factors, value) {
  const last = factors.length - 1;
  if (value > factors[last]) factors[last] = value;
}

/**
 * 컴파일해도 안전한 패턴인지 **구조만 보고** 판정한다.
 *
 * 문자 클래스(`[...]`) 안에서는 `(`·`)`·`*` 가 전부 리터럴이므로 건너뛰고,
 * 백슬래시로 이스케이프된 한 글자도 건너뛴다. 그러지 않으면 `[(]` 나 `\(`
 * 때문에 괄호 짝이 어긋나 멀쩡한 패턴을 거부한다.
 *
 * @param {unknown} pattern
 * @returns {{ ok: true } | { ok: false, code: string }}
 */
export function checkPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    return { ok: false, code: PATTERN_REJECTIONS.empty };
  }
  // 포괄 규칙. 정규식으로 다루지 않으므로 무한 수량자 검사를 지나간다.
  if (pattern === MATCH_ALL_PATTERN) return { ok: true };
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, code: PATTERN_REJECTIONS.tooLong };
  }

  // 스택의 각 칸 = 열려 있는 그룹 하나. 값은 "이 그룹 안에서 본 최대 반복
  // 배수". 맨 아래 칸은 그룹 밖(최상위)이다.
  const factors = [1];
  let inCharClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === '\\') {
      index += 1; // 이스케이프된 한 글자를 통째로 건너뛴다.
      continue;
    }

    if (inCharClass) {
      if (char === ']') inCharClass = false;
      continue;
    }

    if (char === '[') {
      inCharClass = true;
      continue;
    }

    if (char === '(') {
      factors.push(1);
      continue;
    }

    if (char === ')') {
      // 짝이 맞지 않으면 여기서 판정하지 않는다. RegExp 컴파일이 잡는다.
      if (factors.length === 1) return { ok: false, code: PATTERN_REJECTIONS.invalid };
      const inner = /** @type {number} */ (factors.pop());

      // 닫는 괄호 바로 뒤의 수량자를 본다.
      const next = pattern[index + 1];
      let multiplier = 1;
      if (next !== undefined && UNBOUNDED.has(next)) {
        return { ok: false, code: PATTERN_REJECTIONS.unboundedQuantifier };
      }
      if (next === '{') {
        const brace = readBraceQuantifier(pattern, index + 1);
        if (brace) {
          if (brace.unbounded) {
            return { ok: false, code: PATTERN_REJECTIONS.unboundedQuantifier };
          }
          multiplier = brace.max;
          index = brace.end; // 수량자를 여기서 소비한다.
        }
      }

      // 그룹 안의 반복과 그룹에 붙은 반복은 **곱해진다**. `(a{1000}){1000}` 은
      // 각각은 상한 안이지만 곱이 10^6 이다.
      const total = inner * multiplier;
      if (total > MAX_REPEAT) return { ok: false, code: PATTERN_REJECTIONS.repeatTooLarge };
      bump(factors, total);
      continue;
    }

    if (UNBOUNDED.has(char)) {
      return { ok: false, code: PATTERN_REJECTIONS.unboundedQuantifier };
    }

    if (char === '{') {
      const brace = readBraceQuantifier(pattern, index);
      if (brace) {
        if (brace.unbounded) {
          return { ok: false, code: PATTERN_REJECTIONS.unboundedQuantifier };
        }
        if (brace.max > MAX_REPEAT) {
          return { ok: false, code: PATTERN_REJECTIONS.repeatTooLarge };
        }
        bump(factors, brace.max);
        index = brace.end;
      }
      continue;
    }
  }

  if (factors.length !== 1) return { ok: false, code: PATTERN_REJECTIONS.invalid };
  return { ok: true };
}

/**
 * 안전 검사를 통과한 패턴만 RegExp 로 만든다.
 *
 * 실패는 던지지 않고 코드로 돌려준다. 규칙 하나가 나쁘다고 그 달 분류 전체를
 * 멈추면, 고칠 방법(대시보드)에 들어가지도 못한 채 막힌다.
 *
 * @param {unknown} pattern
 * @returns {{ ok: true, regex: RegExp } | { ok: false, code: string }}
 */
export function compilePattern(pattern) {
  const checked = checkPattern(pattern);
  if (!checked.ok) return checked;
  // 포괄 규칙은 정규식 엔진에 넣지 않는다.
  if (pattern === MATCH_ALL_PATTERN) return { ok: true, regex: MATCH_ALL_REGEX };
  try {
    // 플래그 없음: 부분 문자열 매칭, `lastIndex` 상태 없음(`g` 를 쓰면 같은
    // RegExp 를 재사용할 때 test() 결과가 호출마다 달라진다).
    return { ok: true, regex: new RegExp(/** @type {string} */ (pattern)) };
  } catch {
    // 에러 메시지에는 패턴 본문이 들어 있다. 읽지 않는다.
    return { ok: false, code: PATTERN_REJECTIONS.invalid };
  }
}
