// 거래 한 건의 **항목**(분류 아래 한 단계) 이름과, 사람이 고른 항목의 검사.
//
// 정산 템플릿은 섹션 안에 항목 줄이 있다(저축 → ISA · IRP · 연금저축, 용돈 →
// 사람별, 주거비 → 대출 이자, 수입 → 월급). 리포트가 분류 단위까지만 내려가면
// `자동이체 .*` 포괄 규칙에 걸린 서로 다른 자동이체가 한 줄로 뭉친다.
//
// ── 항목 이름을 정하는 순서 ───────────────────────────────────────────────
//
//   1. 행에 저장된 `item` — 사람이 /classify 에서 고른 값(이번만), 또는
//      merchant_map 에서 따라온 값(앞으로도).
//   2. (규칙이 항목을 주는 경우 — 지금은 없다. 규칙 테이블에 항목 컬럼이 없다.)
//   3. 카드대금이면 카드사 이름(lib/classify/issuer.mjs).
//   4. 그 밖에는 **정규화한 적요 그대로.** 그래서 규칙을 하나도 쓰지 않아도 서로
//      다른 적요는 서로 다른 줄이 된다.
//
// ── 적요가 화면에 나온다 ──────────────────────────────────────────────────
//
// 4번 때문에 리포트의 항목 줄에 적요가 나온다. 사용자의 명시적인 요청이고
// (PLAN.md "적요 표시 원칙 변경"), 로그인 + 화이트리스트 뒤의 no-store 화면에만
// 나온다. 로그 · 에러 메시지 · API 에러 본문에는 절대 싣지 않는다.
// 이 파일에 console 호출이 없다.

import { normalizeDescription } from '../toss/normalize.mjs';
import { CARD_CATEGORY } from './engine.mjs';
import { cardIssuerOf } from './issuer.mjs';

/** 항목 이름 길이 상한(글자 수). 스키마 CHECK(char_length(item) <= 40) 와 같다. */
export const ITEM_MAX_LENGTH = 40;

/** 적요가 빈 행의 항목 이름. description 은 NOT NULL 이지만 '' 일 수 있다. */
export const EMPTY_DESCRIPTION_LABEL = '(적요 없음)';

/** 분류 출처. transactions.category_source 의 CHECK 와 같은 세 값이다. */
export const CATEGORY_SOURCES = Object.freeze({
  rule: 'rule',
  map: 'map',
  manual: 'manual',
});

/**
 * 저장된 출처 -> 코드에서 쓰는 출처. NULL 은 이 컬럼이 생기기 전에 저장된 행이라
 * 규칙이 채운 것으로 본다(마이그레이션에서 데이터를 채우지 않는다).
 *
 * @param {unknown} value
 * @returns {'rule'|'map'|'manual'}
 */
export function effectiveSource(value) {
  if (value === CATEGORY_SOURCES.map) return CATEGORY_SOURCES.map;
  if (value === CATEGORY_SOURCES.manual) return CATEGORY_SOURCES.manual;
  return CATEGORY_SOURCES.rule;
}

/**
 * 행 하나의 항목 이름.
 *
 * @param {{ item?: unknown, category?: unknown, description?: unknown }} row
 * @returns {string}
 */
export function resolveItem(row) {
  const stored = typeof row.item === 'string' ? normalizeDescription(row.item) : '';
  if (stored !== '') return stored;

  if (row.category === CARD_CATEGORY) return cardIssuerOf(row.description);

  const key = normalizeDescription(row.description);
  return key === '' ? EMPTY_DESCRIPTION_LABEL : key;
}

/** 거부 사유 코드. 입력값은 싣지 않는다. */
export const ITEM_REJECTIONS = Object.freeze({
  notString: 'itemNotString',
  controlChars: 'itemControlChars',
  tooLong: 'itemTooLong',
});

// Cc(C0 · DEL · C1)와 Cf(양방향 재정렬 · 폭 없는 문자 등). 화면에서 글자 순서를
// 뒤집거나 보이지 않는 글자로 같은 이름을 둘로 만드는 데 쓰일 수 있다.
const CONTROL = /[\p{Cc}\p{Cf}]/u;

/**
 * 사람이 입력한 항목 이름을 검사한다.
 *
 *   - 앞뒤 공백을 걷고 연속 공백을 하나로 모은다(적요 정규화와 같은 함수).
 *   - 제어 문자가 있으면 **거부한다**(조용히 지우지 않는다 — 지우면 사용자가 본
 *     글자와 저장된 글자가 달라진다).
 *   - 40자를 넘으면 거부한다(자르지 않는다. 같은 이유).
 *   - 비었으면 `null` — "따로 정하지 않음". 화면은 적요(카드대금은 카드사)를 쓴다.
 *   - 그룹 키(정규화한 적요)와 같으면 역시 `null`. 정하지 않은 것과 뜻이 같고,
 *     적요가 40자를 넘는 그룹에서도 미리 채워진 값을 그대로 저장할 수 있다.
 *
 * **메모 기준 매핑은 `keepKey: true` 로 부른다.** `null` 의 뜻("정하지 않음")은 화면에서
 * **행마다의 적요**로 풀린다(`resolveItem`). 적요 매핑은 그 매핑이 다스리는 행의 적요가
 * 모두 키와 같아서 `null` 로 줄여도 같은 이름이 나오지만, 메모 매핑이 다스리는 행은 적요가
 * 제각각이다(예: 메모 `길동 IRP` 인 행의 적요가 `홍길동` · `길동` · 자동이체 문구). 거기서
 * 키(메모나 그 묶음의 적요)와 같은 항목을 `null` 로 바꾸면 한 줄이던 항목이 적요마다
 * 흩어진다. 그래서 `keepKey` 이면 키와 같은 값도 그대로 둔다 — 단 40자를 넘는 키는
 * (미리 채워진 값을 그대로 보낸 것이므로) 거부하지 않고 예전처럼 `null` 로 둔다.
 *
 * @param {unknown} value
 * @param {string} key 그룹 키(정규화한 적요, 메모 매핑 수정에서는 정규화한 메모)
 * @param {{ keepKey?: boolean }} [options]
 * @returns {{ ok: true, item: string | null } | { ok: false, code: string }}
 */
export function sanitizeItem(value, key, { keepKey = false } = {}) {
  if (value === undefined || value === null) return { ok: true, item: null };
  if (typeof value !== 'string') return { ok: false, code: ITEM_REJECTIONS.notString };
  // 줄바꿈 · 탭도 제어 문자다. 정규화가 공백으로 바꿔 숨기기 전에 먼저 본다.
  if (CONTROL.test(value)) return { ok: false, code: ITEM_REJECTIONS.controlChars };

  const item = normalizeDescription(value);
  if (item === '') return { ok: true, item: null };
  if (item === key && (!keepKey || [...item].length > ITEM_MAX_LENGTH)) return { ok: true, item: null };
  if ([...item].length > ITEM_MAX_LENGTH) return { ok: false, code: ITEM_REJECTIONS.tooLong };
  return { ok: true, item };
}
