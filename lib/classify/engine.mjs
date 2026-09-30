// 규칙 기반 분류기. LLM 을 쓰지 않는다.
//
// 우선순위 (PLAN.md · migrations/*_create-category-rules.sql)
//
//   0. **memo_map — 사람이 메모 기준으로 고른 매핑(2026-09).** 키는 (정규화한 메모,
//      방향)이다. 메모는 사용자가 거래마다 직접 적은 글이라 적요(보낸 사람 이름 ·
//      가맹점)보다 구체적이다 — 같은 적요(예: 내 이름으로 보낸 자동이체)에 메모만
//      `지현 IRP` · `선용 IRP` 로 다른 거래가 실제로 있다. 그래서 메모 매핑이 적요
//      매핑보다 먼저다. 메모가 빈 행은 이 단계를 그냥 지나간다. 메모 매핑은 사람이
//      /classify 에서 "메모 기준 앞으로도" 를 골랐을 때만 생긴다.
//   1. merchant_map  — 사람이 한 번 고친 매핑. 무조건 이긴다.
//      키는 (정규화한 적요, 방향)이다. 같은 적요에서도 방향(입금 · 출금)이 딱
//      맞는 매핑이 먼저이고, 없으면 방향 무관(`any` — 방향 구분 전에 저장된
//      매핑)을 본다. 둘 다 없으면 1-b(월 토큰을 지운 키)로 간다
//      (lib/classify/direction.mjs).
//   1-b. **월 토큰을 지운 키로 다시 조회한다(2026-09).** "코웨이08월렌탈" 처럼
//      적요에 달마다 바뀌는 월 표시가 박힌 고정비는, 원문 그대로는 다음 달
//      다른 키가 되어 1번에서 못 찾는다. `stripMonthToken` 으로 그 토큰을
//      지운 키가 있고(=적요에 월 토큰이 실제로 있었고) 원본 키와 다르면, 그
//      키로 같은 순서(방향이 맞는 매핑 -> `any`)로 다시 찾는다. 이 폴백은
//      1번이 아무것도 못 찾았을 때만 돈다 — **정확한 키의 매핑이 늘 이긴다**
//      (lib/classify/month-pattern.mjs, /classify 의 "월마다 문구가 바뀌는
//      항목" 체크박스로만 이 키에 매핑을 저장할 수 있다).
//   1-c. **사람이 입력한 메모 패턴(memo_patterns, 2026-09).** 문법 · 정렬은 1-d 와 같고
//      비교 대상이 정규화한 **메모 전체**다(메모가 빈 행은 지나간다). 방향은 in · out 뿐이다.
//      정확한 값(0 · 1 · 1-b)이 기준과 무관하게 패턴보다 먼저이고, 패턴 단계 안에서는 메모가
//      적요보다 먼저다(0 이 1 보다 먼저인 것과 같은 이유 — 메모가 더 구체적이다).
//   1-d. **사람이 입력한 적요 패턴(description_patterns, 2026-09).** `#` = 숫자 한
//      자리, `*` = 아무 글자(lib/classify/wildcard.mjs — 정규식이 아니다). 방향이 맞는
//      패턴을 먼저 보고, 하나도 안 맞으면 `any` 패턴을 본다. 같은 단계에서 여러
//      패턴이 맞으면 **와일드카드 · 공백이 아닌 글자가 많은 패턴**(더 구체적인
//      패턴)이 이기고, 같으면 **먼저 만든 패턴**(id 가 작은 쪽)이 이긴다 — 실행마다
//      결과가 달라지지 않도록 순서를 고정한다(`compilePatterns`).
//   2. category_rules — 정규식 규칙. `priority` 오름차순, 같으면 `id` 오름차순.
//      **규칙마다 적요를 먼저, 안 맞으면 메모를 본다(2026-09).** 규칙 하나가 둘 중
//      하나에 맞으면 걸린다. 적요를 모든 규칙에 먼저 돌리고 나서 메모를 보면 안 된다 —
//      `자동이체 .*` 같은 포괄 규칙(priority 90)이 적요에 늘 맞아서, 메모의 `IRP`
//      (저축, priority 50)가 영영 기회를 못 얻는다. priority 가 규칙 사이의 순서를
//      정하고, 필드는 그 규칙 안에서만 본다. 메모도 적요와 같은 길이 상한
//      (MAX_SUBJECT_LENGTH)으로 잘라서 넣는다.
//   3. 아무것도 안 걸리면 `null`(미분류). 예외를 던지지 않는다 — 미지의 거래
//      유형이 한 건 나왔다고 그 달 전체가 멈추면 안 된다.
//
// ── 결정성 ────────────────────────────────────────────────────────────────
//
// 같은 `priority` 의 규칙이 둘 다 걸리면 **`id` 가 작은 쪽**(= 먼저 만들어진
// 규칙)이 이긴다. 정렬 키는 `(priority, id)` 이고, 이는 DB 인덱스
// `category_rules_priority_idx ON (priority, id)` 와 같은 순서다. 타이브레이커를
// 정하지 않으면 같은 입력이 실행마다 다른 분류를 받을 수 있고, 그것은 "가끔
// 틀리는" 리포트가 된다 — 가장 찾기 어려운 종류의 버그다.
//
// ── 성능 ──────────────────────────────────────────────────────────────────
//
// 정규식은 분류기를 만들 때 **한 번만** 컴파일한다. 행마다 `new RegExp` 를
// 부르면 수천 행에서 그 비용이 그대로 쌓인다.
//
// ── 로그 위생 ─────────────────────────────────────────────────────────────
//
// 이 파일에 `console` 호출이 없다. 컴파일에 실패한 규칙은 던지지도 찍지도
// 않고 `skipped` 배열에 `{ id, code }` 로만 남는다. 규칙 id 와 사유 코드는
// 스키마의 식별자이지 거래 데이터가 아니다. 패턴 본문은 싣지 않는다 —
// 패턴에는 `홍길동` 같은 개인 라벨이 들어갈 수 있고, 그 값이 거래 행과 함께
// 로그에 나란히 찍히면 그 자체로 내역이 된다.

import { normalizeDescription } from '../toss/normalize.mjs';
import { signOf } from '../money.mjs';
import { compilePattern } from './pattern.mjs';
import { cardIssuerOf } from './issuer.mjs';
import { DIRECTIONS, directionOf, isMappingDirection } from './direction.mjs';
import { stripMonthToken } from './month-pattern.mjs';
import { compileWildcard, parseWildcardPattern, wildcardMatches } from './wildcard.mjs';

/**
 * 정규식에 넣을 적요의 길이 상한.
 *
 * ⚠️ 이것은 ReDoS 방어선이 **아니다.** 예전 주석은 이 상한을 pattern.mjs 의
 * 구조 검사 다음가는 두 번째 방어선이라고 적었지만, 그 계산이 틀렸다.
 * 역추적 폭발이 입력 길이의 지수라면 2^40 ≈ 10^12 이라 40자에서 이미
 * 실사용상 무한대다 — 256자로 묶는 것은 아무것도 막지 못한다. 지수 폭발은
 * pattern.mjs 가 무한 수량자를 아예 받지 않아 **구조적으로** 막는다.
 *
 * 그래도 상한 자체는 남겨 둔다. 규칙 하나당 하는 일을 입력 길이에 비례하게
 * 묶어 두면, 비정상적으로 긴 적요 한 줄이 수천 행 × 수십 규칙의 선형 비용을
 * 끌어올리는 것을 막는다(ReDoS 와 무관한, 그냥 일반적인 작업량 상한이다).
 * 실제 적요는 20자 안팎이고 가장 긴 fixture 행도 10자 미만이라 256자는 잘릴
 * 걱정이 없는 상한이다.
 */
export const MAX_SUBJECT_LENGTH = 256;

/**
 * 메모로 규칙이 걸렸을 때 메모를 항목 이름으로 쓰는 길이 상한. lib/classify/item.mjs 의
 * ITEM_MAX_LENGTH · 스키마 CHECK(char_length(item) <= 40)와 같다(item.mjs 가 이 파일을
 * import 하므로 순환을 피해 값을 따로 둔다 — 테스트가 둘이 같은지 본다).
 */
export const MEMO_ITEM_MAX_LENGTH = 40;

/** 카드사별로 묶어야 하는 분류. 이 분류만 `counterparty` 를 만든다. */
export const CARD_CATEGORY = '카드대금';

/**
 * 규칙 배열을 컴파일한다. 나쁜 규칙은 건너뛰고 사유 코드만 남긴다.
 *
 * @param {Array<{id:number|string, txn_type?:string|null, pattern:string, sign?:number|null, category:string, priority?:number}>} rules
 * @returns {{ rules: Array<object>, skipped: Array<{id:number|string, code:string}> }}
 */
export function compileRules(rules) {
  const compiled = [];
  const skipped = [];

  for (const rule of rules) {
    const result = compilePattern(rule.pattern);
    if (!result.ok) {
      skipped.push({ id: rule.id, code: result.code });
      continue;
    }
    compiled.push({
      id: rule.id,
      txnType: rule.txn_type ?? null,
      sign: rule.sign === null || rule.sign === undefined ? null : Number(rule.sign),
      category: rule.category,
      priority: Number(rule.priority ?? 100),
      regex: result.regex,
    });
  }

  // (priority, id) 오름차순. id 는 SERIAL 이지만 pg 가 문자열로 줄 수도 있는
  // 값과 섞이지 않도록 숫자 비교가 가능할 때만 숫자로 비교한다.
  compiled.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    return compareIds(left.id, right.id);
  });

  return { rules: compiled, skipped };
}

function compareIds(left, right) {
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

/**
 * (적요, 방향) -> Map 키. JSON 배열이라 구분자 충돌이 없다.
 *
 * @param {string} description 정규화한 적요
 * @param {string} direction in | out | any
 */
export function merchantKeyOf(description, direction) {
  return JSON.stringify([description, direction]);
}

/**
 * merchant_map 행 -> (정규화된 적요, 방향)을 키로 하는 Map.
 *
 * 적요는 `normalizeDescription` 을 거친다. 저장할 때와 조회할 때 같은 함수를
 * 쓰지 않으면, 공백 하나 차이로 사람이 고쳐 둔 매핑이 조용히 안 걸린다.
 * (/classify 가 그룹을 묶는 키 · 매핑을 저장하는 키도 같은 함수다 —
 *  lib/classify/manual.mjs 의 `groupKeyOf`.)
 *
 * `direction` 이 없는 행은 `any` 로 본다(방향 구분 전의 매핑과 같은 뜻이다).
 * 알 수 없는 방향 값은 건너뛴다 — 스키마 CHECK 가 막는 값이지만, 모르는 값을
 * `any` 로 넓혀 양쪽 방향에 걸리게 하는 것보다 안 거는 편이 안전하다.
 *
 * 값에는 분류와 항목이 함께 들어 있다. 항목이 비어 있으면 `null` 이다.
 *
 * @param {Array<{description:string, direction?:string|null, category:string, item?:string|null}>} entries
 * @returns {Map<string, {category: string, item: string|null}>}
 */
export function buildMerchantMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = normalizeDescription(entry.description);
    if (key === '') continue;
    const direction = entry.direction === undefined || entry.direction === null ? DIRECTIONS.any : entry.direction;
    if (!isMappingDirection(direction)) continue;
    const item = typeof entry.item === 'string' && entry.item.trim() !== '' ? entry.item : null;
    map.set(merchantKeyOf(key, direction), { category: entry.category, item });
  }
  return map;
}

/**
 * memo_map 행 -> (정규화한 메모, 방향)을 키로 하는 Map. 방향은 in · out 뿐이다
 * (그 밖의 값은 건너뛴다 — 스키마 CHECK 가 막는 값이다).
 *
 * @param {Array<{memo:string, direction:string, category:string, item?:string|null}>} entries
 * @returns {Map<string, {category: string, item: string|null}>}
 */
export function buildMemoMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = normalizeDescription(entry.memo);
    if (key === '') continue;
    if (entry.direction !== DIRECTIONS.in && entry.direction !== DIRECTIONS.out) continue;
    const item = typeof entry.item === 'string' && entry.item.trim() !== '' ? entry.item : null;
    map.set(merchantKeyOf(key, entry.direction), { category: entry.category, item });
  }
  return map;
}

/**
 * description_patterns 행 -> 방향별로 정렬된 비교용 목록. 검사를 통과하지 못한 행
 * (손으로 넣은 값 등)은 조용히 건너뛴다 — 스키마 CHECK 보다 코드 검사가 좁다.
 *
 * 정렬: 글자 수(literals) 내림차순 -> id 오름차순(먼저 만든 것). 이 순서의 첫
 * 번째로 맞는 패턴이 답이다.
 *
 * @param {Array<{id:number|string, pattern:string, direction?:string|null, category:string, item?:string|null}>} entries
 * @returns {{ in: Array<object>, out: Array<object>, any: Array<object> }}
 */
export function compilePatterns(entries) {
  const byDirection = { in: [], out: [], any: [] };
  for (const entry of entries) {
    const parsed = parseWildcardPattern(entry.pattern);
    if (!parsed.ok) continue;
    const direction = entry.direction === undefined || entry.direction === null ? DIRECTIONS.any : entry.direction;
    if (!Object.hasOwn(byDirection, direction)) continue;
    const item = typeof entry.item === 'string' && entry.item.trim() !== '' ? entry.item : null;
    byDirection[direction].push({
      id: entry.id,
      pattern: parsed.pattern,
      literals: parsed.literals,
      tokens: compileWildcard(parsed.pattern),
      category: entry.category,
      item,
    });
  }
  for (const list of Object.values(byDirection)) {
    list.sort((left, right) => right.literals - left.literals || compareIds(left.id, right.id));
  }
  return byDirection;
}

/**
 * 이 적요 · 방향에 걸리는 패턴(없으면 undefined). 방향 -> any 순서.
 *
 * @param {ReturnType<typeof compilePatterns>} compiled
 * @param {string} description 정규화한 적요
 * @param {string} direction in | out
 */
export function findPattern(compiled, description, direction) {
  for (const list of [compiled[direction] ?? [], compiled.any]) {
    const found = list.find((entry) => wildcardMatches(entry.tokens, description));
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 분류기를 만든다. 정규식 컴파일은 여기서 딱 한 번 일어난다.
 *
 * @param {object} input
 * @param {Array<object>} [input.rules] category_rules 행
 * @param {Array<{description:string, direction?:string|null, category:string, item?:string|null}>} [input.merchantMap] merchant_map 행
 * @param {Array<{id:number|string, pattern:string, direction?:string|null, category:string, item?:string|null}>} [input.patterns] description_patterns 행
 * @param {Array<{memo:string, direction:string, category:string, item?:string|null}>} [input.memoMap] memo_map 행
 * @param {Array<{id:number|string, pattern:string, direction:string, category:string, item?:string|null}>} [input.memoPatterns] memo_patterns 행
 * @returns {{ classify: (row: object) => {category: string|null, source: string|null, ruleId: (number|string|null), counterparty: string|null, item?: string|null, basis?: string}, skipped: Array<{id:*, code:string}>, ruleCount: number }}
 */
export function createClassifier({ rules = [], merchantMap = [], patterns = [], memoMap = [], memoPatterns = [] } = {}) {
  const { rules: compiled, skipped } = compileRules(rules);
  const corrections = buildMerchantMap(merchantMap);
  const userPatterns = compilePatterns(patterns);
  const memoCorrections = buildMemoMap(memoMap);
  // 메모 패턴(memo_patterns)은 in · out 만 있다. 같은 컴파일 · 정렬 규칙을 쓴다.
  const userMemoPatterns = compilePatterns(
    memoPatterns.filter((entry) => entry.direction === DIRECTIONS.in || entry.direction === DIRECTIONS.out),
  );

  /**
   * 거래 한 건을 분류한다.
   *
   * @param {{description?:string, memo?:string|null, txn_type?:string, txnType?:string, amount?:unknown}} row
   */
  function classify(row) {
    const description = normalizeDescription(row.description);
    const subject = description.slice(0, MAX_SUBJECT_LENGTH);
    // 메모는 사용자가 적은 글이다. 없으면 ''(규칙 · 매핑 모두 건너뛴다).
    const memo = normalizeDescription(row.memo);
    const memoSubject = memo.slice(0, MAX_SUBJECT_LENGTH);
    const txnType = normalizeDescription(row.txn_type ?? row.txnType);
    const sign = signOf(row.amount ?? 0);
    const direction = directionOf(row.amount ?? 0);

    // 0. 메모 기준 매핑. 사람이 고른 값이라 출처는 매핑과 같은 'merchant_map'(저장 'map').
    if (memo !== '') {
      const byMemo = memoCorrections.get(merchantKeyOf(memo, direction));
      if (byMemo !== undefined) {
        return { ...decorate(byMemo.category, 'merchant_map', null, description, byMemo.item), basis: 'memo' };
      }
    }

    // 1. 사람이 고친 매핑이 가장 세다. 방향이 딱 맞는 것 -> 방향 무관(any) 순.
    const corrected =
      corrections.get(merchantKeyOf(description, direction)) ??
      corrections.get(merchantKeyOf(description, DIRECTIONS.any));
    if (corrected !== undefined) {
      return decorate(corrected.category, 'merchant_map', null, description, corrected.item);
    }

    // 1-b. 정확한 키로 못 찾았다. 월 토큰을 지운 키가 있으면(=적요에 월 토큰이
    // 있었다면) 그 키로 같은 순서(방향 -> any)로 다시 찾는다. `stripMonthToken`
    // 은 토큰이 없으면 null 을 주므로, 월 표시가 없는 평범한 적요는 여기서
    // 바로 지나간다(추가 조회가 없다).
    const monthStripped = stripMonthToken(description);
    if (monthStripped !== null && monthStripped !== description) {
      const strippedCorrected =
        corrections.get(merchantKeyOf(monthStripped, direction)) ??
        corrections.get(merchantKeyOf(monthStripped, DIRECTIONS.any));
      if (strippedCorrected !== undefined) {
        return decorate(strippedCorrected.category, 'merchant_map', null, description, strippedCorrected.item);
      }
    }

    // 1-c. 사람이 입력한 **메모** 패턴(2026-09). 정확한 값(메모 매핑 · 적요 매핑 · 월 토큰
    // 매핑)이 먼저이고, 패턴 단계 안에서는 메모가 적요보다 먼저다(0 이 1 보다 먼저인 것과 같다).
    // 메모 전체와 맞아야 한다. 출처는 메모 매핑과 같은 'merchant_map'(저장 'map').
    if (memo !== '') {
      const memoPattern = findPattern(userMemoPatterns, memo, direction);
      if (memoPattern !== undefined) {
        return {
          ...decorate(memoPattern.category, 'merchant_map', null, description, memoPattern.item),
          basis: 'memo',
          memoPatternId: memoPattern.id,
        };
      }
    }

    // 1-d. 사람이 입력한 적요 패턴. 출처는 매핑과 같은 'merchant_map'(저장은 'map')이다
    // — 사람이 고른 분류라 규칙보다 세고, 매핑처럼 '이번만' 은 덮지 않는다.
    const pattern = findPattern(userPatterns, description, direction);
    if (pattern !== undefined) {
      return { ...decorate(pattern.category, 'merchant_map', null, description, pattern.item), patternId: pattern.id };
    }

    // 2. 규칙. 이미 (priority, id) 로 정렬돼 있으므로 처음 걸리는 것이 답이다.
    for (const rule of compiled) {
      if (rule.txnType !== null && rule.txnType !== txnType) continue;
      if (rule.sign !== null && rule.sign !== sign) continue;
      // 규칙 안에서 적요 -> 메모 순(위 우선순위 2). 메모가 비면 적요만 본다.
      if (rule.regex.test(subject)) {
        // 규칙은 항목을 주지 않는다(category_rules 에 항목 컬럼이 없다).
        return decorate(rule.category, 'category_rules', rule.id, description, null);
      }
      if (memoSubject !== '' && rule.regex.test(memoSubject)) {
        // 메모로 걸렸으면 **메모가 곧 항목 이름**이다(사용자: "저축에 대한 항목명들이 적요가
        // 아닌 메모로 적혀 있어"). 적요(보낸 사람 이름 등)를 항목으로 쓰면 서로 다른 저축이
        // 한 줄로 뭉친다. 항목 길이 상한(40자, transactions_item_valid)을 넘으면 비워 둔다.
        const item = [...memo].length <= MEMO_ITEM_MAX_LENGTH ? memo : null;
        return { ...decorate(rule.category, 'category_rules', rule.id, description, item), basis: 'memo' };
      }
    }

    // 3. 미분류. transactions_unclassified_idx 가 이 행들을 훑는다.
    return { category: null, source: null, ruleId: null, counterparty: null };
  }

  return { classify, skipped, ruleCount: compiled.length };
}

/**
 * 카드대금이면 카드사 이름을 함께 돌려준다.
 *
 * `counterparty` 는 **저장되지 않는다.** transactions 에 그런 컬럼이 없고
 * 만들지도 않는다(issuer.mjs 주석). 집계할 때 같은 함수로 다시 계산한다.
 *
 * `item` 은 merchant_map 이 항목을 갖고 있을 때만 값이 있다. 규칙은 항목을
 * 주지 않는다(null).
 */
function decorate(category, source, ruleId, description, item) {
  return {
    category,
    source,
    ruleId,
    counterparty: category === CARD_CATEGORY ? cardIssuerOf(description) : null,
    item,
  };
}

/**
 * 분류기의 출처 이름 -> transactions.category_source 값.
 *
 * @param {string|null} source `classify()` 가 돌려준 source
 * @returns {'map'|'rule'|null}
 */
export function storedSourceOf(source) {
  if (source === 'merchant_map') return 'map';
  if (source === 'category_rules') return 'rule';
  return null;
}

/**
 * 저장 직전의 레코드 묶음에 분류를 채운다.
 *
 * 이미 분류가 있는 레코드는 건드리지 않는다(재실행 멱등).
 *
 * 분류와 함께 출처(`category_source`: map | rule)와, 매핑이 준 항목(`item`)을
 * 채운다. 규칙으로 분류된 행의 항목은 비워 둔다 — 화면이 적요에서 계산한다.
 *
 * @param {Array<Record<string, unknown>>} records `toTransactionRecords` 의 결과
 * @param {{classify: Function}} classifier
 * @returns {{ classified: number, unmatched: number }}
 */
export function classifyRecords(records, classifier) {
  let classified = 0;
  let unmatched = 0;

  for (const record of records) {
    if (record.category !== null && record.category !== undefined) continue;
    const { category, source, item } = classifier.classify(record);
    if (category === null) {
      unmatched += 1;
      continue;
    }
    record.category = category;
    record.category_source = storedSourceOf(source);
    record.item = item ?? null;
    classified += 1;
  }

  return { classified, unmatched };
}
