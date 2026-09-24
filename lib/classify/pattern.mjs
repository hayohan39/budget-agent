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
//   b. **중첩된 무한 수량자.** `(a+)+` `(a*)*` `(x+|y)*` 처럼 무한 수량자가
//      걸린 그룹에 다시 무한 수량자가 붙는 형태가 지수 폭발의 거의 전부다.
//      그룹 안에 무한 수량자가 있었는지를 기억했다가, 그 그룹 닫는 괄호
//      뒤에 무한 수량자가 오면 거부한다.
//   c. 과도한 반복 횟수(`{n,m}` 의 m 이 MAX_REPEAT 초과). 유한하더라도
//      `(a{1000}){1000}` 같은 곱셈은 실질적으로 무한과 같다.
//
// 이것으로 모든 ReDoS 를 막을 수는 없다(`(a|a)*` 같은 형태는 구조만으로는
// 판별되지 않는다). 그래서 **입력 길이 상한**(engine.mjs 의 MAX_SUBJECT_LENGTH)
// 을 두 번째 방어선으로 함께 쓴다. 역추적 폭발은 입력 길이의 지수이므로,
// 입력이 짧게 묶여 있으면 최악의 경우도 유한한 시간 안에 끝난다.
//
// 플래그는 쓰지 않는다(빈 플래그). 특히 `u` 플래그를 붙이면 `\-` 같은
// 관대한 이스케이프가 전부 컴파일 오류가 되어, 사람이 손으로 넣은 기존
// 규칙이 조용히 통째로 버려진다. 매칭은 **부분 문자열** 매칭이다 — 시드
// 규칙의 `카드` 는 `삼성카드주식회사` 에 걸린다.

/** 패턴 길이 상한. 시드 규칙 최대 길이의 10배 이상이다. */
export const MAX_PATTERN_LENGTH = 200;

/** `{n,m}` 에서 허용하는 최대 반복 횟수. */
export const MAX_REPEAT = 1000;

/** 거부 사유 코드. 패턴 본문은 어디에도 싣지 않는다. */
export const PATTERN_REJECTIONS = Object.freeze({
  empty: 'patternEmpty',
  tooLong: 'patternTooLong',
  nestedQuantifier: 'patternNestedQuantifier',
  repeatTooLarge: 'patternRepeatTooLarge',
  invalid: 'patternInvalid',
});

const UNBOUNDED = new Set(['*', '+']);

/**
 * `{` 로 시작하는 자리에서 수량자를 읽는다.
 *
 * @param {string} pattern
 * @param {number} start `{` 의 위치
 * @returns {{ kind:'brace', end:number, unbounded:boolean, max:number } | null}
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
  const max = unbounded ? Number.POSITIVE_INFINITY : Number(upper === undefined || upper === '' ? min : upper);
  return { kind: 'brace', end: close, unbounded, max: Math.max(min, max) };
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
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, code: PATTERN_REJECTIONS.tooLong };
  }

  // 스택의 각 칸 = 열려 있는 그룹 하나. 값은 "이 그룹 안에서 무한 수량자를
  // 본 적이 있는가". 맨 아래 칸은 그룹 밖(최상위)이다.
  const sawUnbounded = [false];
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
      sawUnbounded.push(false);
      continue;
    }

    if (char === ')') {
      // 짝이 맞지 않으면 여기서 판정하지 않는다. RegExp 컴파일이 잡는다.
      if (sawUnbounded.length === 1) return { ok: false, code: PATTERN_REJECTIONS.invalid };
      const groupHadUnbounded = sawUnbounded.pop();

      // 닫는 괄호 바로 뒤의 수량자를 본다. `?` 는 뒤에 붙는 lazy 표시일 수도
      // 있으나(`)+?`), 그것은 다음 순회에서 무해하게 지나간다.
      const next = pattern[index + 1];
      let quantifierIsUnbounded = false;
      if (next !== undefined && UNBOUNDED.has(next)) {
        quantifierIsUnbounded = true;
      } else if (next === '{') {
        const brace = readBraceQuantifier(pattern, index + 1);
        if (brace) {
          // 무한(`{n,}`)이면 반복 횟수 상한이 아니라 중첩 판정의 문제다.
          if (!brace.unbounded && brace.max > MAX_REPEAT) {
            return { ok: false, code: PATTERN_REJECTIONS.repeatTooLarge };
          }
          quantifierIsUnbounded = brace.unbounded;
        }
      }

      if (quantifierIsUnbounded && groupHadUnbounded) {
        // (a+)+ · (a*)* · (\d+|x)* … 지수 폭발의 전형.
        return { ok: false, code: PATTERN_REJECTIONS.nestedQuantifier };
      }
      // 그룹이 무한 수량자를 품었다는 사실은 바깥 그룹으로 전파된다.
      // ((a+))+ 처럼 한 겹 더 감싸도 잡기 위해서다.
      if (groupHadUnbounded || quantifierIsUnbounded) {
        sawUnbounded[sawUnbounded.length - 1] = true;
      }
      continue;
    }

    if (UNBOUNDED.has(char)) {
      sawUnbounded[sawUnbounded.length - 1] = true;
      continue;
    }

    if (char === '{') {
      const brace = readBraceQuantifier(pattern, index);
      if (brace) {
        if (!brace.unbounded && brace.max > MAX_REPEAT) {
          return { ok: false, code: PATTERN_REJECTIONS.repeatTooLarge };
        }
        if (brace.unbounded) sawUnbounded[sawUnbounded.length - 1] = true;
        index = brace.end;
      }
      continue;
    }
  }

  if (sawUnbounded.length !== 1) return { ok: false, code: PATTERN_REJECTIONS.invalid };
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
  try {
    // 플래그 없음: 부분 문자열 매칭, `lastIndex` 상태 없음(`g` 를 쓰면 같은
    // RegExp 를 재사용할 때 test() 결과가 호출마다 달라진다).
    return { ok: true, regex: new RegExp(/** @type {string} */ (pattern)) };
  } catch {
    // 에러 메시지에는 패턴 본문이 들어 있다. 읽지 않는다.
    return { ok: false, code: PATTERN_REJECTIONS.invalid };
  }
}
