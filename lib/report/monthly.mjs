// 월별 현금흐름표(月別 現金흐름表)의 **데이터**를 만든다.
//
// 문자열 렌더링은 여기서 하지 않는다. 표 서식은 아직 확정되지 않았고, 서식이
// 바뀔 때마다 집계가 흔들리면 안 된다. 이 모듈은 숫자와 건수만 돌려준다.
//
// ── 부호 규약 ─────────────────────────────────────────────────────────────
//
// **저장된 그대로다. 입금 +, 출금 −.** 지출 섹션의 합계는 음수로 나온다.
// 렌더링할 때 절댓값을 붙이는 것은 화면의 몫이다. 여기서 부호를 뒤집으면
// "어떤 값이 뒤집힌 값인가"를 호출자가 매번 기억해야 하고, 한 번 틀리면
// 검산이 정확히 2배만큼 어긋나면서 원인은 보이지 않는다.
//
// 따라서 다음 항등식이 **정의상** 성립한다.
//
//   실현순증감 = 수입 + 고정지출1 + 고정지출2 + 카드비 + 변동비 + 계좌간이동
//              = 메인 계좌 거래 금액의 단순 합
//
// 이 값이 메인 계좌의 잔액 변화와 같은지 보는 것이 검산이다(verify.mjs).
//
// ── 무엇을 세고 무엇을 세지 않는가 ────────────────────────────────────────
//
// 종합정산은 **메인 계좌 기준**이다(PLAN.md 자금 흐름 모델). 모든 돈이 메인으로
// 들어와 메인에서 나가기 때문이다. 고정비·비상금 계좌의 입금은 메인에서 간 돈
// 그 자체라서, 그것까지 수입으로 세면 같은 돈이 두 번 잡힌다. 그 계좌들은
// `계좌블록` 에서 따로 본다.
//
// 내 계좌 사이의 이동은 **수입에도 지출에도 넣지 않고 자기 줄(`계좌간이동`)로
// 뺀다.** 메인에서 비상금으로 500,000 을 옮긴 것은 가계 전체로 보면 돈이
// 나간 것이 아니다. 다만 메인 계좌의 잔액은 실제로 줄기 때문에, 위 항등식에
// 별도 항으로 들어간다.

// 비메인 계좌(고정비 · 비상금)에서 붙은 **이자는 종합정산의 수입이 아니다.**
// 메인 계좌로 들어온 돈이 아니기 때문이다. 대신 그 계좌 블록 안에서 그 계좌의
// 집행을 상계한다 — `계좌블록[].순증감 = 입금 + 이자 − 집행`. 두 계좌에 같은
// 규칙을 쓴다(한쪽만 특별 취급하지 않는다). 이 상계는 블록 안에서 닫히므로
// 위 `실현순증감` 항등식은 그대로다.
//
// ── 로그 위생 ─────────────────────────────────────────────────────────────
//
// 이 파일에 `console` 이 없다. DB 에러는 `message` 조차 읽지 않는다.
// 돌려주는 값에 메모 · 거래 일시 · 잔액 같은 행 단위 값은 들어가지 않는다 —
// 섹션 이름 · 분류 이름 · 항목 이름 · 합계 · 건수뿐이다.
//
// ⚠️ **항목 이름에는 적요가 들어간다.** 사람이 따로 정하지 않은 항목은 정규화한
//    적요 그대로가 이름이다(lib/classify/item.mjs). 사용자가 명시적으로 요청한
//    변경이고(PLAN.md "적요 표시 원칙 변경"), 이 결과는 로그인 + 화이트리스트
//    뒤의 no-store 화면에만 그려진다. 로그 · 에러 메시지로 흘리지 않는다.
//
// ── 항목 줄 ────────────────────────────────────────────────────────────────
//
// `항목별` 은 섹션 안을 (분류, 항목, 방향) 한 줄씩으로 쪼갠 것이다. 방향은
// 입금(in) · 출금(out)이고 lib/classify/direction.mjs 의 `directionOf` 로 정한다.
// 같은 항목이라도 입금과 출금은 **서로 다른 줄**이다 — 부호가 반대인 금액을 한
// 줄에서 상쇄하지 않는다(사용자 요청: "합계산하지 말고 항목별로"). 섹션 합계를
// **다시 계산하지 않는다** — 같은 루프에서 같은 금액을 같은 섹션에 더할 뿐이라
// 항목 줄의 합은 섹션 합계와 정의상 같다(테스트로 못 박는다). 실현순증감 ·
// 검산은 이 줄들과 무관하게 예전 그대로다.
//
// ── 보정은 없다 (2026-09) ─────────────────────────────────────────────────
//
// 예전에는 `adjustments` 테이블의 수동 보정을 읽어 `보정` 섹션과
// `보정후순증감` 을 만들었다. 그 테이블에 값을 넣는 화면 · API 가 한 번도 없어서
// 늘 0 이었고, 사용자가 "수동으로 기입할 때 생겼던 것이라 이제 필요 없다"고 해
// 걷어 냈다. 종합정산의 합계는 곧 `실현순증감` 이다(검산 대상과 같은 값).
// 테이블 자체는 스키마에 남아 있다 — 이 파일은 더 이상 읽지 않는다.

import { sumBigInt, toBigInt, toSafeNumber } from '../money.mjs';
import { resolveItem } from '../classify/item.mjs';
import { directionOf } from '../classify/direction.mjs';
import { ownTransferRoleOf } from '../toss/normalize.mjs';
import { isYearMonth } from './months.mjs';

/** 카드사별로 쪼개는 분류. */
export const CARD_CATEGORY = '카드대금';

/**
 * 내 계좌 간 이동으로 보는 분류.
 *
 * ⚠️ `transactions.is_transfer` 만으로는 부족하다. 그 플래그는 적요에
 *    `비상금 계좌` · `고정비 계좌` 가 들어 있을 때만 서고(normalize.mjs 의
 *    `isOwnAccountTransfer`), 받는 쪽 계좌 명세서의 입금 행에는 서지 않는다.
 *    종합정산이 메인 기준이라 받는 쪽 행을 애초에 세지 않는 것이 첫 번째
 *    방어이고, 분류 결과(`고정비이체`·`비상금이체`)를 함께 보는 것이 두 번째다.
 */
export const TRANSFER_CATEGORIES = Object.freeze({
  고정비이체: '고정비',
  비상금이체: '비상금',
});

/** 고정지출1 — 메인에서 바로 나가는 고정성 지출. 순서가 곧 표의 순서다. */
export const FIXED1_CATEGORIES = Object.freeze(['저축', '용돈', '주거비']);

/** 고정지출2 — 고정비 · 비상금 성격의 지출(계좌 이동은 제외하고 따로 센다). */
export const FIXED2_CATEGORIES = Object.freeze(['고정비', '비상금']);

/**
 * 수입 성격의 분류. 메인 계좌의 입금은 **변동비 · 미분류가 아니면** 분류와 무관하게
 * 수입 섹션으로 가고, 이 분류가 붙은 **출금**(월급 반환 등)도 수입 섹션에 음수 줄로
 * 남는다 — 사람이 "수입" 이라고 고른 돈이 변동비로 새지 않게.
 */
export const INCOME_CATEGORIES = Object.freeze(['수입', '이자']);

/**
 * 일회성 항목 — 메인 계좌의 **변동비** 섹션(2026-09, 사용자 요청: "변동비를 카드비와
 * 변동비로 나누고 … 변동비에는 일회성 항목들을 넣고싶어. 일회성 항목은 일회성 수입이
 * 될수도 일회성 지출이 될수도 있어").
 *
 *   출금 -> 변동비 섹션의 `일회성 지출` 줄
 *   입금 -> 변동비 섹션의 `일회성 수입` 줄 — **수입 섹션으로 가지 않는다.**
 *
 * 입금과 출금은 서로 다른 항목 줄이다(방향 규칙). 섹션 합계만 둘의 합(순액)이다 —
 * 실현순증감 항등식이 섹션 합계의 단순 합이라 그래야 한다.
 */
export const VARIABLE_CATEGORY = '변동비';

/**
 * 예전 분류 `기타`(2026-09 초에 만들었다가 같은 달에 변동비로 합쳤다).
 *
 * 선택지(`CLASSIFY_CATEGORIES`)에서 뺐고, 쓰기 API 는 더 이상 받지 않는다. 다만
 * 이미 저장된 행 · 매핑에는 남아 있을 수 있어 **읽을 때** `변동비` 로 본다
 * (`canonicalCategory`). 저장된 값을 고치는 마이그레이션은 두지 않는다 — 이
 * 레포의 마이그레이션은 운영 데이터를 UPDATE 하지 않는다.
 */
export const LEGACY_OTHER_CATEGORY = '기타';

/** 읽을 때 합치는 예전 분류 -> 지금 분류. */
const CATEGORY_ALIASES = Object.freeze({ [LEGACY_OTHER_CATEGORY]: VARIABLE_CATEGORY });

/**
 * 저장된 분류 -> 집계 · 화면이 쓰는 분류. 예전 `기타` 는 `변동비` 가 된다.
 * null · undefined 는 null(미분류)이다. 그 밖의 값은 그대로다.
 *
 * @param {unknown} category
 * @returns {string|null}
 */
export function canonicalCategory(category) {
  if (category === null || category === undefined) return null;
  const name = String(category);
  return Object.hasOwn(CATEGORY_ALIASES, name) ? CATEGORY_ALIASES[name] : name;
}

/**
 * 사람이 /classify 에서 고를 수 있는 분류 — **이 집계가 섹션에 넣는 분류 전부.**
 *
 * UI 의 선택지와 쓰기 API 의 허용 목록이 둘 다 이 상수 하나에서 나온다.
 * 여기 없는 분류는 저장되지 않고, 여기 있는 분류는 부호와 무관하게
 * `placeMainRow` 의 명시적인 갈래에 걸린다(테스트로 못 박는다).
 * 예전 `기타` 는 여기 없다(`LEGACY_OTHER_CATEGORY`).
 */
export const CLASSIFY_CATEGORIES = Object.freeze([
  ...INCOME_CATEGORIES,
  ...FIXED1_CATEGORIES,
  ...FIXED2_CATEGORIES,
  CARD_CATEGORY,
  VARIABLE_CATEGORY,
  ...Object.keys(TRANSFER_CATEGORIES),
]);

/** 미분류 행을 표에서 가리키는 이름. */
export const UNCLASSIFIED = '미분류';

/**
 * 시각을 비교 가능한 숫자로.
 *
 * pg 는 TIMESTAMPTZ 를 **Date 객체**로 준다. 문자열로 바꿔 사전순으로 비교하면
 * `Sat Aug 30 2026 …` 같은 로캘 표기가 되어 순서가 엉킨다. 테스트는 ISO
 * 문자열을 그대로 넣으므로 두 형태를 모두 받는다.
 */
function timeKey(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value ?? ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 시각순(오름차순) 정렬.
 *
 * 같은 초에 여러 건이 있다(fixture 에 4묶음). 그때는 `id` **내림차순**이
 * 시간순이다 — 파일이 최신순이고 그 순서대로 INSERT 되므로, 같은 초 안에서는
 * id 가 클수록 파일 뒤쪽 = 더 과거다. 잔액 검산의 경계 행을 고를 때만 쓰이는
 * 순서라 이 추론이 틀려도 합계는 흔들리지 않는다.
 */
function chronological(rows) {
  return [...rows].sort((left, right) => {
    const leftAt = timeKey(left.txn_at);
    const rightAt = timeKey(right.txn_at);
    if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
    const leftId = toBigInt(left.id ?? 0);
    const rightId = toBigInt(right.id ?? 0);
    if (leftId === rightId) return 0;
    return leftId > rightId ? -1 : 1;
  });
}

/** 내 계좌 간 이동의 한쪽 다리인가. */
export function isTransferLeg(row) {
  if (row.is_transfer === true) return true;
  return Object.hasOwn(TRANSFER_CATEGORIES, String(row.category ?? ''));
}

/**
 * 이동 분류 -> 받는 쪽 계좌의 역할(accounts.role). `TRANSFER_CATEGORIES` 와 짝이다.
 */
export const TRANSFER_TARGET_ROLES = Object.freeze({
  고정비이체: 'fixed',
  비상금이체: 'emergency',
});

/**
 * 받는 쪽 입금을 보낸 쪽 출금과 짝지을 때 허용하는 시각 차이.
 *
 * 내 계좌 사이의 이체는 즉시 처리되어 두 명세서의 `거래 일시` 가 보통 같은 초다.
 * 여유를 조금 두되, 금액 · 받는 계좌가 모두 같아야 하고 가장 가까운 것부터
 * 1:1 로만 짝을 짓는다(아래 `matchIncomingTransfers`).
 */
export const INTERNAL_TRANSFER_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * 메인 계좌의 이동 출금이 향한 계좌의 역할. 모르면 null.
 *
 * 분류(`고정비이체` · `비상금이체`)가 먼저이고, 분류가 없으면 적요 패턴
 * (`고정비 계좌` · `비상금 계좌`, lib/toss/normalize.mjs)으로 본다.
 */
function transferTargetRole(row) {
  const category = String(row.category ?? '');
  if (Object.hasOwn(TRANSFER_TARGET_ROLES, category)) return TRANSFER_TARGET_ROLES[category];
  return ownTransferRoleOf(row.description);
}

/**
 * **받는 쪽 계좌에 찍힌 내 계좌 간 이체의 입금 행**을 찾는다. 돌려주는 것은 그
 * 행들의 id(문자열) 집합이다.
 *
 * 왜 필요한가. 메인 → 고정비 · 비상금 이체는 두 명세서에 한 번씩 찍힌다.
 * 보낸 쪽(메인)의 적요는 `고정비 계좌` · `비상금 계좌` 라서 규칙이 `고정비이체` ·
 * `비상금이체` 로 분류한다. 받는 쪽의 적요는 **보낸 사람 이름**이라 어떤 규칙에도
 * 걸리지 않고 `category IS NULL` 로 남는다. 현금흐름표는 비메인 계좌의 입금을
 * 분류와 무관하게 `계좌블록[].입금`(메인에서 온 돈)으로 이미 세지만, /classify 와
 * 미분류 건수는 `category IS NULL` 만 봐서 이 행들을 '미분류 입금' 으로 내보였다.
 *
 * 짝 조건(전부 만족해야 한다):
 *   - 보낸 쪽: 메인 계좌 · 출금 · 이동 다리(`isTransferLeg`) · 받는 계좌를 앎.
 *   - 받는 쪽: 그 역할의 계좌 · 입금 · 분류가 `이자` 가 아님 · 금액이 정확히 같음.
 *   - 시각 차이가 `toleranceMs` 이하.
 * 후보 쌍을 시각 차이가 작은 순(같으면 id 순)으로 훑어 **1:1** 로만 짝짓는다.
 * 짝이 없는 입금(환불 · 다른 사람이 보낸 돈 · 메인 쪽 명세서를 아직 올리지 않은
 * 이체)은 결과에 들어가지 않는다 — 여전히 미분류로 보인다.
 *
 * 분류는 보지 않는다(받는 쪽 행이 이미 분류돼 있어도 짝은 짓는다). 그래야 사람이
 * 한쪽을 손으로 분류해도 다른 입금이 대신 짝을 가로채지 않는다.
 *
 * DB 를 모른다. 행만 받는다. 이 파일의 다른 함수처럼 아무것도 출력하지 않는다.
 *
 * @param {object} input
 * @param {Array<{id:number|string, role:string}>} input.accounts
 * @param {Array<object>} input.rows 같은 기간의 transactions 행(계좌 무관)
 * @param {number} [input.toleranceMs]
 * @returns {Set<string>}
 */
export function matchIncomingTransfers({ accounts = [], rows = [], toleranceMs = INTERNAL_TRANSFER_TOLERANCE_MS }) {
  const roleOf = new Map(accounts.map((account) => [String(account.id), String(account.role)]));
  const outgoing = [];
  const incoming = [];
  for (const row of rows) {
    const role = roleOf.get(String(row.account_id));
    if (role === undefined) continue;
    const amount = toBigInt(row.amount ?? 0);
    if (role === 'main') {
      if (amount >= 0n || !isTransferLeg(row)) continue;
      const target = transferTargetRole(row);
      if (target === null) continue;
      outgoing.push({ id: String(row.id), target, amount: -amount, at: timeKey(row.txn_at) });
    } else if (amount > 0n && row.category !== '이자') {
      incoming.push({ id: String(row.id), role, amount, at: timeKey(row.txn_at) });
    }
  }

  const pairs = [];
  for (const leg of outgoing) {
    for (const candidate of incoming) {
      if (candidate.role !== leg.target || candidate.amount !== leg.amount) continue;
      const gap = Math.abs(candidate.at - leg.at);
      if (gap <= toleranceMs) pairs.push({ leg: leg.id, candidate: candidate.id, gap });
    }
  }
  const byId = (left, right) => {
    const a = toBigInt(left);
    const b = toBigInt(right);
    return a === b ? 0 : a < b ? -1 : 1;
  };
  pairs.sort((left, right) => left.gap - right.gap || byId(left.leg, right.leg) || byId(left.candidate, right.candidate));

  const usedLegs = new Set();
  const matched = new Set();
  for (const pair of pairs) {
    if (usedLegs.has(pair.leg) || matched.has(pair.candidate)) continue;
    usedLegs.add(pair.leg);
    matched.add(pair.candidate);
  }
  return matched;
}

/** 이동이 향한(또는 온) 계좌 이름. 분류가 없으면 '기타'. */
function transferLabel(row) {
  return TRANSFER_CATEGORIES[String(row.category ?? '')] ?? '기타';
}

/**
 * 메인 계좌 행이 들어가는 자리.
 *
 * 2026-09 에 예전 `변동지출`(카드대금 + 그 밖의 변동지출)을 둘로 나눴다(사용자 요청).
 *
 *   `card`     카드비 — 분류가 `카드대금` 인 **출금만**.
 *   `variable` 변동비 — 일회성 항목. 분류가 `변동비`(예전 `기타` 포함)이거나
 *              **미분류**인 행이 **방향과 무관하게** 온다(일회성 수입 · 일회성 지출).
 *              표에 없는 분류의 출금도 합계가 사라지지 않도록 여기로 온다.
 */
export const SECTIONS = Object.freeze({
  income: '수입',
  fixed1: '고정지출1',
  fixed2: '고정지출2',
  card: '카드비',
  variable: '변동비',
  transfer: '계좌간이동',
});

/**
 * 메인 계좌 행 하나가 종합정산의 어느 칸에 들어가는가.
 *
 * 순서가 뜻이다.
 *   1. 내 계좌 간 이동 -> 계좌간이동(분류 · 부호 무관).
 *   2. 미분류 · `변동비`(예전 `기타` 포함) -> 변동비. **입금도** 여기다 — 일회성 수입이
 *      수입 섹션을 부풀리지 않는다. 미분류는 일단 변동비에 보이고(사용자 요청),
 *      분류하면 제자리로 옮겨 간다. 줄의 분류(`key`)가 `미분류` 라 구별된다.
 *   3. 그 밖의 입금 -> 수입(분류 이름이 줄의 분류다. 카드대금 취소 입금 등도).
 *   4. 출금은 분류대로. 수입 · 이자 출금은 수입의 음수 줄.
 *
 * `explicit` 이 false 인 경우는 딱 하나다 — 분류가 있는데 이 파일이 아는 어느
 * 목록에도 없는 출금(손으로 넣은 옛 값 등). 합계가 사라지지 않도록 변동비에
 * 넣되, 허용 목록(`CLASSIFY_CATEGORIES`)의 분류는 절대 이 갈래로 오지 않는다.
 *
 * @param {{ category?: unknown, amount?: unknown, is_transfer?: unknown }} row
 * @returns {{ section: string, key: string, explicit: boolean }}
 */
export function placeMainRow(row) {
  const category = canonicalCategory(row.category);
  const amount = toBigInt(row.amount ?? 0);

  if (isTransferLeg(row)) return { section: SECTIONS.transfer, key: transferLabel(row), explicit: true };
  if (category === null) return { section: SECTIONS.variable, key: UNCLASSIFIED, explicit: true };
  if (category === VARIABLE_CATEGORY) return { section: SECTIONS.variable, key: category, explicit: true };
  if (amount > 0n) return { section: SECTIONS.income, key: category, explicit: true };
  if (INCOME_CATEGORIES.includes(category)) {
    return { section: SECTIONS.income, key: category, explicit: true };
  }
  if (FIXED1_CATEGORIES.includes(category)) return { section: SECTIONS.fixed1, key: category, explicit: true };
  if (FIXED2_CATEGORIES.includes(category)) return { section: SECTIONS.fixed2, key: category, explicit: true };
  if (category === CARD_CATEGORY) return { section: SECTIONS.card, key: category, explicit: true };
  // 규칙에 걸리지 않은 출금이 아니라, 표의 어느 칸에도 없는 분류. 변동비로 본다.
  return { section: SECTIONS.variable, key: category, explicit: false };
}

/** { total: bigint, count: number } 누적기. */
function bucket() {
  return { total: 0n, count: 0 };
}

function add(target, amount) {
  target.total += amount;
  target.count += 1;
  return target;
}

function intoKeyed(map, key, amount) {
  const existing = map.get(key) ?? bucket();
  add(existing, amount);
  map.set(key, existing);
}

/** Map<string, {total,count}> -> 정렬된 배열. 금액이 큰 항목이 위로 온다. */
function keyedItems(map, keyName = 'key') {
  return [...map.entries()]
    .map(([key, value]) => ({ [keyName]: key, total: toSafeNumber(value.total), count: value.count }))
    .sort((left, right) => {
      const byAmount = Math.abs(right.total) - Math.abs(left.total);
      if (byAmount !== 0) return byAmount;
      return String(left[keyName]) < String(right[keyName]) ? -1 : 1;
    });
}

/**
 * (분류, 항목, 방향) 줄 누적. 키는 JSON 배열이라 구분자 충돌이 없다.
 * 방향이 키에 들어 있으므로 한 줄 안의 금액은 늘 같은 부호다.
 */
function intoLine(map, category, item, amount) {
  const direction = directionOf(amount);
  const key = JSON.stringify([category, item, direction]);
  const existing = map.get(key) ?? { category, item, direction, ...bucket() };
  add(existing, amount);
  map.set(key, existing);
}

/**
 * 줄 Map -> 정렬된 배열. `order` 에 있는 분류가 그 순서로 먼저, 그 안에서는
 * 금액의 절댓값이 큰 줄이 위로 온다.
 */
function lineItems(map, order = []) {
  const rank = (category) => {
    const index = order.indexOf(category);
    return index === -1 ? order.length : index;
  };
  return [...map.values()]
    .map((value) => ({
      category: value.category,
      item: value.item,
      direction: value.direction,
      total: toSafeNumber(value.total),
      count: value.count,
    }))
    .sort((left, right) => {
      const byRank = rank(left.category) - rank(right.category);
      if (byRank !== 0) return byRank;
      if (left.category !== right.category) return left.category < right.category ? -1 : 1;
      const byAmount = Math.abs(right.total) - Math.abs(left.total);
      if (byAmount !== 0) return byAmount;
      if (left.item !== right.item) return left.item < right.item ? -1 : 1;
      return left.direction < right.direction ? -1 : left.direction > right.direction ? 1 : 0;
    });
}

/** 고정된 키 목록을 가진 섹션. 값이 0 이어도 줄이 사라지지 않는다. */
function fixedSection(categories, map) {
  const items = categories.map((key) => {
    const value = map.get(key) ?? bucket();
    return { key, total: toSafeNumber(value.total), count: value.count };
  });
  return {
    total: items.reduce((sum, item) => sum + item.total, 0),
    count: items.reduce((sum, item) => sum + item.count, 0),
    items,
  };
}

/**
 * 한 계좌의 월간 잔액 변화를 **저장된 `balance` 컬럼에서** 끌어낸다.
 *
 * 시작 잔액은 그 달 첫 거래의 `거래 후 잔액`에서 그 거래의 금액을 뺀 값이고,
 * 끝 잔액은 마지막 거래의 `거래 후 잔액` 그대로다. 금액 합계를 쓰지 않는
 * 것이 요점이다 — 금액 합계와 대조하는 것이 검산이므로, 여기서 금액을 쓰면
 * 검산이 항상 통과하는 빈 검사가 된다.
 *
 * 경계 행의 잔액이 비어 있으면(fixture 의 H18 같은 행) 그 달은 검산하지 않고
 * 사유만 남긴다. 추정해서 채우면 틀린 값으로 "통과"해 버린다.
 */
export function balanceSpan(rows) {
  const ordered = chronological(rows);
  if (ordered.length === 0) {
    return { opening: null, closing: null, change: null, derived: false, reason: 'noRows' };
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first.balance === null || first.balance === undefined) {
    return { opening: null, closing: null, change: null, derived: false, reason: 'balanceMissing' };
  }
  if (last.balance === null || last.balance === undefined) {
    return { opening: null, closing: null, change: null, derived: false, reason: 'balanceMissing' };
  }

  const opening = toBigInt(first.balance) - toBigInt(first.amount);
  const closing = toBigInt(last.balance);
  return {
    opening: toSafeNumber(opening),
    closing: toSafeNumber(closing),
    change: toSafeNumber(closing - opening),
    derived: true,
    reason: null,
  };
}

/**
 * 월별 현금흐름표 데이터를 만든다. DB 를 모른다 — 행만 받는다.
 *
 * @param {object} input
 * @param {string} input.yearMonth `YYYY-MM`
 * @param {Array<{id:number|string, role:string, nickname:string}>} input.accounts
 * @param {Array<object>} input.rows 그 달의 transactions 행 전부(계좌 무관)
 */
export function aggregateMonthly({ yearMonth, accounts = [], rows = [] }) {
  const main = accounts.find((account) => account.role === 'main') ?? null;
  const mainId = main === null ? null : String(main.id);
  // 받는 쪽 계좌에 찍힌 내 계좌 간 이체의 입금. 분류가 없어도 미분류로 세지 않는다 —
  // 아래 계좌 블록이 이미 `입금`(메인에서 온 돈)으로 센다.
  const incomingTransfers = matchIncomingTransfers({ accounts, rows });

  const income = new Map();
  const fixed1 = new Map();
  const fixed2 = new Map();
  const card = new Map();
  const cardTotal = bucket();
  // 변동비(일회성 항목). 입금 · 출금을 따로 센다 — 섹션 합계는 둘의 합이다.
  const variableIn = bucket();
  const variableOut = bucket();
  const transfers = new Map();
  let unclassified = 0;
  // 분류는 없지만 받는 쪽 계좌의 내 계좌 간 이체 입금이라 미분류로 세지 않은 건수.
  let transferInflows = 0;

  // (분류, 항목) 줄. 위 섹션 누적과 **같은 자리에서** 같은 금액을 더한다.
  const incomeLines = new Map();
  const fixed1Lines = new Map();
  const fixed2Lines = new Map();
  const cardLines = new Map();
  const variableLines = new Map();

  const perAccount = new Map();

  for (const row of rows) {
    const accountId = String(row.account_id);
    const amount = toBigInt(row.amount);
    // 예전 `기타` 는 여기서 `변동비` 가 된다(canonicalCategory). 미분류(null)는 그대로.
    const category = canonicalCategory(row.category);

    if (category === null) {
      if (incomingTransfers.has(String(row.id))) transferInflows += 1;
      else unclassified += 1;
    }

    const block = perAccount.get(accountId) ?? {
      rows: [],
      입금: bucket(),
      집행: bucket(),
      이자: bucket(),
      lines: new Map(),
    };
    block.rows.push(row);
    if (category === '이자') add(block.이자, amount);
    else if (amount > 0n) add(block.입금, amount);
    else {
      add(block.집행, amount);
      // 원본 템플릿 중앙 그룹의 항목 줄(실비보험 · 통신비 · 관리비 …).
      intoLine(block.lines, category ?? UNCLASSIFIED, resolveItem(row), amount);
    }
    perAccount.set(accountId, block);

    // 종합정산은 메인 계좌만 본다. 다른 계좌의 입금은 메인에서 간 돈이라
    // 여기서 세면 같은 돈을 두 번 세게 된다.
    if (mainId === null || accountId !== mainId) continue;

    const place = placeMainRow(row);
    const item = resolveItem(row);

    switch (place.section) {
      case SECTIONS.transfer:
        intoKeyed(transfers, place.key, amount);
        break;
      case SECTIONS.income:
        intoKeyed(income, place.key, amount);
        intoLine(incomeLines, place.key, item, amount);
        break;
      case SECTIONS.fixed1:
        intoKeyed(fixed1, place.key, amount);
        intoLine(fixed1Lines, place.key, item, amount);
        break;
      case SECTIONS.fixed2:
        intoKeyed(fixed2, place.key, amount);
        intoLine(fixed2Lines, place.key, item, amount);
        break;
      case SECTIONS.card:
        // 카드사 묶음. 사람이 항목을 정하지 않았으면 resolveItem 이 카드사를 준다.
        intoKeyed(card, item, amount);
        add(cardTotal, amount);
        intoLine(cardLines, CARD_CATEGORY, item, amount);
        break;
      default:
        // 변동비 — 일회성 수입 · 지출(변동비 분류 · 미분류 · 표에 없는 분류의 출금).
        // 항목 줄은 (분류, 항목, 방향)별로 따로 선다(place.key 가 줄의 분류다).
        add(amount > 0n ? variableIn : variableOut, amount);
        intoLine(variableLines, place.key, item, amount);
        break;
    }
  }

  const incomeSection = {
    total: toSafeNumber(sumBigInt([...income.values()].map((value) => value.total))),
    count: [...income.values()].reduce((sum, value) => sum + value.count, 0),
    items: keyedItems(income),
  };
  const fixed1Section = fixedSection(FIXED1_CATEGORIES, fixed1);
  const fixed2Section = fixedSection(FIXED2_CATEGORIES, fixed2);
  const cardSection = {
    total: toSafeNumber(cardTotal.total),
    count: cardTotal.count,
    issuers: keyedItems(card, 'issuer'),
  };
  const variableSection = {
    // 순액(일회성 수입 + 일회성 지출). 실현순증감 항등식의 한 항이다.
    total: toSafeNumber(variableIn.total + variableOut.total),
    count: variableIn.count + variableOut.count,
    일회성수입: { total: toSafeNumber(variableIn.total), count: variableIn.count },
    일회성지출: { total: toSafeNumber(variableOut.total), count: variableOut.count },
  };
  const transferSection = {
    total: toSafeNumber(sumBigInt([...transfers.values()].map((value) => value.total))),
    count: [...transfers.values()].reduce((sum, value) => sum + value.count, 0),
    items: keyedItems(transfers),
  };

  const realized =
    incomeSection.total +
    fixed1Section.total +
    fixed2Section.total +
    cardSection.total +
    variableSection.total +
    transferSection.total;

  const balances = accounts.map((account) => {
    const block = perAccount.get(String(account.id));
    const span = balanceSpan(block?.rows ?? []);
    return {
      role: account.role,
      nickname: account.nickname,
      count: block?.rows.length ?? 0,
      ...span,
    };
  });

  const accountBlocks = accounts
    .filter((account) => account.role !== 'main')
    .map((account) => {
      const block = perAccount.get(String(account.id));
      const 입금 = block?.입금.total ?? 0n;
      const 집행 = block?.집행.total ?? 0n;
      const 이자 = block?.이자.total ?? 0n;
      return {
        role: account.role,
        nickname: account.nickname,
        // 집행의 (분류, 항목) 줄. 합이 `집행.total` 과 같다.
        항목: lineItems(block?.lines ?? new Map(), [...FIXED2_CATEGORIES]),
        // 입금은 메인에서 온 돈이다. 종합정산에서는 세지 않는다(중복 계산 방지).
        입금: { total: toSafeNumber(입금), count: block?.입금.count ?? 0 },
        집행: { total: toSafeNumber(집행), count: block?.집행.count ?? 0 },
        이자: { total: toSafeNumber(이자), count: block?.이자.count ?? 0 },
        // 이 계좌 안에서만 닫히는 순증감. 이자가 이 계좌의 집행을 상계한다.
        //
        //   순증감 = 입금 + 이자 − 집행
        //
        // `집행` 은 출금이라 **이미 음수**다(부호 규약: 입금 +, 출금 −). 그래서
        // 식의 `− 집행` 은 코드에서 덧셈이다. 여기서 부호를 뒤집으면 이 줄만
        // 다른 규약을 쓰게 되고, 화면이 그것을 기억해야 한다.
        //
        // ⚠️ 이 값은 **종합정산으로 올라가지 않는다.** 비메인 계좌의 이자는
        //    메인 계좌의 현금흐름이 아니므로 `수입` 에 들어가지 않고,
        //    `실현순증감` 항등식에도 기여하지 않는다(위 루프가 비메인 행을
        //    애초에 세지 않는다). 상계는 이 블록 안에서만 끝난다.
        순증감: toSafeNumber(입금 + 이자 + 집행),
      };
    });

  return {
    yearMonth,
    // 표에 나오는 모든 금액의 부호 규약. 화면이 이 값을 보고 판단할 수 있게 남긴다.
    signConvention: '입금 +, 출금 −',
    mainAccount: main === null ? null : { role: main.role, nickname: main.nickname },
    수입: incomeSection,
    고정지출1: fixed1Section,
    고정지출2: fixed2Section,
    // 카드대금 출금만(카드사별).
    카드비: cardSection,
    // 일회성 수입 · 지출. 미분류 행도 일단 여기 보인다.
    변동비: variableSection,
    // 수입에도 지출에도 넣지 않는 자기 줄. 메인 잔액은 실제로 줄기 때문에
    // 아래 실현순증감에는 별도 항으로 들어간다.
    계좌간이동: transferSection,
    // 섹션 안의 (분류, 항목, 방향) 줄. 각 배열의 합이 그 섹션의 total 과 같다.
    항목별: {
      수입: lineItems(incomeLines, [...INCOME_CATEGORIES]),
      고정지출1: lineItems(fixed1Lines, [...FIXED1_CATEGORIES]),
      고정지출2: lineItems(fixed2Lines, [...FIXED2_CATEGORIES]),
      카드비: lineItems(cardLines, [CARD_CATEGORY]),
      변동비: lineItems(variableLines, [VARIABLE_CATEGORY, UNCLASSIFIED]),
    },
    종합정산: {
      수입: incomeSection.total,
      고정지출1: fixed1Section.total,
      고정지출2: fixed2Section.total,
      카드비: cardSection.total,
      변동비: variableSection.total,
      계좌간이동: transferSection.total,
      // 메인 계좌에서 실제로 움직인 돈. 검산 대상이고, 종합정산 표의 합계다.
      실현순증감: realized,
    },
    // 건수만이다. 금액은 내보내지 않는다. 받는 쪽 계좌의 내 계좌 간 이체 입금
    // (`matchIncomingTransfers`)은 분류가 없어도 세지 않는다.
    미분류: { count: unclassified, 계좌간이체입금: transferInflows },
    계좌별잔액변화: balances,
    계좌블록: accountBlocks,
    거래건수: rows.length,
  };
}

/**
 * 그 달의 입력(계좌 · 거래)을 읽는다.
 *
 * @param {{query: Function}} client
 * @param {string} yearMonth
 */
export async function loadMonthlyInputs(client, yearMonth) {
  // 형식 검사는 months.mjs 한 곳에서만 정의한다. 여기에 정규식을 다시 적으면
  // 두 곳이 따로 어긋날 수 있다(스키마의 CHECK 제약과도 같은 형식이다).
  if (!isYearMonth(yearMonth)) {
    throw new Error('year_month 는 YYYY-MM 형식이어야 합니다.');
  }

  let accounts;
  let rows;
  try {
    accounts = await client.query('SELECT id, role, nickname FROM accounts ORDER BY id');
    rows = await client.query(
      `SELECT id, account_id, txn_at, description, txn_type, amount, balance, category, is_transfer,
              item
         FROM transactions
        WHERE year_month = $1
        ORDER BY txn_at, id DESC`,
      [yearMonth],
    );
  } catch {
    // pg 메시지에는 값이 섞여 나온다. 읽지 않는다.
    throw new Error('현금흐름표 입력을 읽지 못했습니다.');
  }

  return {
    yearMonth,
    accounts: accounts.rows.map((row) => ({
      id: row.id,
      role: String(row.role),
      nickname: String(row.nickname),
    })),
    rows: rows.rows,
  };
}

/**
 * 한 달치 현금흐름표 데이터를 만든다.
 *
 * @param {{query: Function}} client 열려 있는 연결
 * @param {string} yearMonth `YYYY-MM`
 */
export async function buildMonthlyReport(client, yearMonth) {
  return aggregateMonthly(await loadMonthlyInputs(client, yearMonth));
}
