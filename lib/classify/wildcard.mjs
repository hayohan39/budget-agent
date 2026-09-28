// 사람이 /classify 에서 직접 입력하는 **적요 패턴**(2026-09).
//
// 사용자 요청: "매번 패턴이 달라질수 있는게 나올수있기 때문에 저장 시 사용자가 직접
// 패턴을 입력할 수 있게 하는 게 좋을 것 같아." (예: 흥국01184 · 흥국02184 → 흥국##184)
//
// ── 문법 ──────────────────────────────────────────────────────────────────
//
//   #   숫자 한 자리(0-9)
//   *   아무 글자 여러 개(없어도 된다)
//   그 밖의 글자는 **글자 그대로**다. 괄호 · 점 · 역슬래시도 그냥 글자다.
//
// 패턴은 적요 **전체**와 맞아야 한다(앞뒤에 `*` 를 쓰지 않으면 앞뒤가 고정된다).
// 패턴과 적요 모두 `normalizeDescription`(공백 정리)을 거쳐 비교한다.
//
// ── 정규식이 아니다 ───────────────────────────────────────────────────────
//
// 사람이 쓴 문자열을 정규식으로 컴파일하지 않는다(CLAUDE.md · pattern.mjs 의 ReDoS
// 논의). 아래 `matchTokens` 는 정규식 없이 두 포인터로 맞춰 보는 고전적인 와일드카드
// 매처다. `*` 에서 되짚을 때 **가장 최근의 `*` 하나로만** 돌아가므로 경우의 수가
// 폭발하지 않는다 — 최악의 경우에도 (적요 길이 × 패턴 길이) 번 안에 끝난다.
// 적요는 MAX_SUBJECT_LENGTH(256)자로, 패턴은 MAX_PATTERN_LENGTH(64)자로 묶이므로
// 한 번 비교는 많아야 약 1.6만 걸음이다. 입력 길이에 대해 선형이다(패턴이 고정일 때).
//
// ── 검사 ──────────────────────────────────────────────────────────────────
//
//   - 문자열 · 제어 문자 없음 · 정규화 뒤 1~64자
//   - `*` 는 연달아 쓰면 하나로 본다. `*` 는 4개, `#` 는 16개까지
//   - 와일드카드가 적어도 하나 — 없으면 그냥 정확한 매핑(‘앞으로도’)과 같다
//   - 와일드카드 · 공백이 아닌 글자가 적어도 2개 — `*` 나 `#*` 처럼 거의 모든 적요에
//     걸리는 패턴을 막는다
//   - 저장할 때는 지금 고른 묶음의 적요와 실제로 맞아야 한다(manual.mjs)
//
// console 호출이 이 파일에 없다. 거부는 코드(문자열 상수)로만 돌려준다.
//
// ── 브라우저에서도 돈다 ──────────────────────────────────────────────────
//
// /classify 의 클라이언트 컴포넌트(app/classify/forms.tsx)가 이 파일을 import 한다
// (제안 · 입력 검사 · 맞는지 미리 보기). 그래서 이 파일과 이 파일이 import 하는 것은
// Node 전용 모듈(`node:*`)을 쓰면 안 된다 — test/client-module-graph.test.mjs 가 검사한다.
// 정규화는 서버와 같은 함수(lib/text/description.mjs)다.

import { normalizeDescription } from '../text/description.mjs';

export const MAX_PATTERN_LENGTH = 64;
export const MAX_STARS = 4;
export const MAX_DIGITS = 16;
export const MIN_LITERALS = 2;
/** 비교할 적요의 길이 상한(engine.mjs 의 MAX_SUBJECT_LENGTH 와 같다). */
export const MAX_MATCH_SUBJECT = 256;

export const DIGIT = '#';
export const STAR = '*';

export const PATTERN_REJECTIONS = Object.freeze({
  notString: 'patternNotString',
  controlChars: 'patternControlChars',
  empty: 'patternEmpty',
  tooLong: 'patternTooLong',
  tooManyWildcards: 'patternTooManyWildcards',
  noWildcard: 'patternNoWildcard',
  tooFewLiterals: 'patternTooFewLiterals',
});

const CONTROL = /[\p{Cc}\p{Cf}]/u;

/** 한 글자가 ASCII 숫자인가. */
function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

/**
 * 패턴 문자열을 검사하고 정규화한다.
 *
 * @param {unknown} value
 * @returns {{ ok: true, pattern: string, literals: number, stars: number, digits: number }
 *          | { ok: false, code: string }}
 */
export function parseWildcardPattern(value) {
  if (typeof value !== 'string') return { ok: false, code: PATTERN_REJECTIONS.notString };
  if (value.length > MAX_PATTERN_LENGTH * 4) return { ok: false, code: PATTERN_REJECTIONS.tooLong };
  if (CONTROL.test(value)) return { ok: false, code: PATTERN_REJECTIONS.controlChars };

  // 공백 정리 + 연달은 `*` 를 하나로.
  const chars = [];
  for (const ch of normalizeDescription(value)) {
    if (ch === STAR && chars[chars.length - 1] === STAR) continue;
    chars.push(ch);
  }
  const pattern = chars.join('');
  if (pattern === '') return { ok: false, code: PATTERN_REJECTIONS.empty };
  if (chars.length > MAX_PATTERN_LENGTH) return { ok: false, code: PATTERN_REJECTIONS.tooLong };

  let stars = 0;
  let digits = 0;
  let literals = 0;
  for (const ch of chars) {
    if (ch === STAR) stars += 1;
    else if (ch === DIGIT) digits += 1;
    else if (ch !== ' ') literals += 1;
  }
  if (stars > MAX_STARS || digits > MAX_DIGITS) return { ok: false, code: PATTERN_REJECTIONS.tooManyWildcards };
  if (stars + digits === 0) return { ok: false, code: PATTERN_REJECTIONS.noWildcard };
  if (literals < MIN_LITERALS) return { ok: false, code: PATTERN_REJECTIONS.tooFewLiterals };
  return { ok: true, pattern, literals, stars, digits };
}

/**
 * 검사를 통과한 패턴 -> 비교용 토큰(글자 배열). 코드 포인트 단위다(한글 · 이모지 안전).
 *
 * @param {string} pattern `parseWildcardPattern` 이 돌려준 pattern
 * @returns {string[]}
 */
export function compileWildcard(pattern) {
  return [...pattern];
}

/**
 * 토큰이 적요 **전체**와 맞는가. 정규식 없는 두 포인터 매처(파일 머리말).
 *
 * @param {string[]} tokens
 * @param {string[]} subject 코드 포인트 배열
 */
function matchTokens(tokens, subject) {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < subject.length) {
    const token = tokens[p];
    if (p < tokens.length && token !== STAR && (token === DIGIT ? isDigit(subject[s]) : token === subject[s])) {
      p += 1;
      s += 1;
    } else if (p < tokens.length && token === STAR) {
      starP = p;
      starS = s;
      p += 1;
    } else if (starP !== -1) {
      // 가장 최근의 `*` 가 한 글자 더 먹는다. 그보다 앞의 `*` 로는 돌아가지 않는다.
      p = starP + 1;
      starS += 1;
      s = starS;
    } else {
      return false;
    }
  }
  while (p < tokens.length && tokens[p] === STAR) p += 1;
  return p === tokens.length;
}

/**
 * 컴파일한 패턴이 적요와 맞는가. 적요는 정규화하고 길이 상한으로 자른다.
 *
 * @param {string[]} tokens `compileWildcard` 결과
 * @param {unknown} description
 */
export function wildcardMatches(tokens, description) {
  const subject = [...normalizeDescription(description)];
  if (subject.length > MAX_MATCH_SUBJECT) return false; // 비정상적으로 긴 적요는 패턴 대상이 아니다
  return matchTokens(tokens, subject);
}

/**
 * SQL 로 후보를 좁힐 LIKE 패턴(`ESCAPE '\'`). `#` -> `_`, `*` -> `%`, 나머지는 이스케이프.
 * 좁히기만 한다 — 최종 판정은 늘 `wildcardMatches` 다(`_` 는 숫자만이 아니다).
 *
 * @param {string} pattern 검사를 통과한 패턴
 */
export function likePrefilter(pattern) {
  let out = '';
  for (const ch of pattern) {
    if (ch === DIGIT) out += '_';
    else if (ch === STAR) out += '%';
    else if (ch === '%' || ch === '_' || ch === '\\') out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/**
 * 적요 -> 패턴 입력칸에 미리 채울 **제안**. 사람이 고쳐 쓰라고 주는 값일 뿐이다.
 *
 *   - `08월` 처럼 `월` 앞의 숫자는 같은 개수의 `#`(코웨이08월렌탈 -> 코웨이##월렌탈)
 *   - 2~6자리 숫자 덩어리가 01~12 로 시작하면 그 두 자리만 `##`(흥국01184 -> 흥국##184)
 *   - 그 밖의 1~6자리 숫자 덩어리는 전부 `#`(KB카드1234 -> KB카드####)
 *   - 7자리 이상은 `*`(식별자일 수 있어 그대로 두지 않는다)
 * 숫자가 없으면 적요 그대로다(와일드카드가 없어 저장 전에 고쳐야 한다).
 *
 * @param {unknown} description
 * @returns {string}
 */
export function suggestPattern(description) {
  const chars = [...normalizeDescription(description)];
  let out = '';
  let i = 0;
  while (i < chars.length) {
    if (!isDigit(chars[i])) {
      out += chars[i];
      i += 1;
      continue;
    }
    let j = i;
    while (j < chars.length && isDigit(chars[j])) j += 1;
    const run = chars.slice(i, j);
    const length = run.length;
    const month = Number(run[0] + (run[1] ?? ''));
    if (length > 6) out += STAR;
    else if (chars[j] === '월') out += DIGIT.repeat(length);
    else if (length >= 2 && run[0] !== undefined && month >= 1 && month <= 12 && (run[0] === '0' || run[0] === '1')) {
      out += DIGIT.repeat(2) + run.slice(2).join('');
    } else out += DIGIT.repeat(length);
    i = j;
  }
  return out.slice(0, MAX_PATTERN_LENGTH * 2);
}
