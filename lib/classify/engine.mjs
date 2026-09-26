// 규칙 기반 분류기. LLM 을 쓰지 않는다.
//
// 우선순위 (PLAN.md · migrations/*_create-category-rules.sql)
//
//   1. merchant_map  — 사람이 한 번 고친 매핑. 무조건 이긴다.
//   2. category_rules — 정규식 규칙. `priority` 오름차순, 같으면 `id` 오름차순.
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
 * merchant_map 행 -> 정규화된 적요를 키로 하는 Map.
 *
 * 키는 `normalizeDescription` 을 거친다. 저장할 때와 조회할 때 같은 함수를
 * 쓰지 않으면, 공백 하나 차이로 사람이 고쳐 둔 매핑이 조용히 안 걸린다.
 * (/classify 가 그룹을 묶는 키 · 매핑을 저장하는 키도 같은 함수다 —
 *  lib/classify/manual.mjs 의 `groupKeyOf`.)
 *
 * 값에는 분류와 항목이 함께 들어 있다. 항목이 비어 있으면 `null` 이다.
 *
 * @param {Array<{description:string, category:string, item?:string|null}>} entries
 * @returns {Map<string, {category: string, item: string|null}>}
 */
export function buildMerchantMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = normalizeDescription(entry.description);
    if (key === '') continue;
    const item = typeof entry.item === 'string' && entry.item.trim() !== '' ? entry.item : null;
    map.set(key, { category: entry.category, item });
  }
  return map;
}

/**
 * 분류기를 만든다. 정규식 컴파일은 여기서 딱 한 번 일어난다.
 *
 * @param {object} input
 * @param {Array<object>} [input.rules] category_rules 행
 * @param {Array<{description:string, category:string, item?:string|null}>} [input.merchantMap] merchant_map 행
 * @returns {{ classify: (row: object) => {category: string|null, source: string|null, ruleId: (number|string|null), counterparty: string|null, item?: string|null}, skipped: Array<{id:*, code:string}>, ruleCount: number }}
 */
export function createClassifier({ rules = [], merchantMap = [] } = {}) {
  const { rules: compiled, skipped } = compileRules(rules);
  const corrections = buildMerchantMap(merchantMap);

  /**
   * 거래 한 건을 분류한다.
   *
   * @param {{description?:string, txn_type?:string, txnType?:string, amount?:unknown}} row
   */
  function classify(row) {
    const description = normalizeDescription(row.description);
    const subject = description.slice(0, MAX_SUBJECT_LENGTH);
    const txnType = normalizeDescription(row.txn_type ?? row.txnType);
    const sign = signOf(row.amount ?? 0);

    // 1. 사람이 고친 매핑이 가장 세다.
    const corrected = corrections.get(description);
    if (corrected !== undefined) {
      return decorate(corrected.category, 'merchant_map', null, description, corrected.item);
    }

    // 2. 규칙. 이미 (priority, id) 로 정렬돼 있으므로 처음 걸리는 것이 답이다.
    for (const rule of compiled) {
      if (rule.txnType !== null && rule.txnType !== txnType) continue;
      if (rule.sign !== null && rule.sign !== sign) continue;
      if (!rule.regex.test(subject)) continue;
      // 규칙은 항목을 주지 않는다(category_rules 에 항목 컬럼이 없다).
      return decorate(rule.category, 'category_rules', rule.id, description, null);
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
