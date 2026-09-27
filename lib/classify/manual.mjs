// 사람이 /classify 에서 고르는 분류 — 읽기(그룹 목록 · 매핑 목록)와 쓰기
// (이번만 · 앞으로도 · 매핑 수정 · 매핑 삭제).
//
// 라우트 핸들러(app/api/classify/*)는 인증 · Origin · 직렬화만 하고 여기를
// 부른다. Next.js 없이 `node --test` 로 돌릴 수 있어야 하기 때문이다.
//
// ── 그룹 키 ───────────────────────────────────────────────────────────────
//
// 묶음은 **(계좌, 정규화한 적요, 방향)** 이다(2026-09 에 계좌가 더해졌다).
// 계좌는 accounts.role(main · fixed · emergency)로 가리키고 화면에는 별칭
// (메인 · 고정비 · 비상금)으로만 보인다 — 뒤 4자리는 읽지도 않는다. 같은 적요라도
// 계좌가 다르면 다른 묶음이다. 예전에는 계좌를 가리지 않아서, 고정비 계좌에
// 찍힌 '메인에서 온 돈'(적요 = 보낸 사람 이름)이 메인 계좌의 같은 이름 입금과
// 한 묶음이 되어 메인의 수입처럼 보였다(사용자 보고).
//
// 방향 부분은 입금(in) · 출금(out)이다. 방향은 입금(in) · 출금(out)이며
// lib/classify/direction.mjs 의 `directionOf` 하나로 정한다. 같은 적요에 입금과
// 출금이 섞여 있으면 **두 묶음**이 되고 따로 분류한다 — 용도가 다르기 때문이다
// (사용자 요청). 금액을 더해 한 묶음으로 만들지 않는다.
//
// 적요 부분의 키는 **정규화한 적요**(`normalizeDescription(description)`)다. 분류기가
// merchant_map 을 찾을 때(engine.mjs 의 buildMerchantMap · classify), 이 화면이
// 행을 묶을 때, 매핑을 저장할 때 모두 같은 함수를 쓴다. 업로드 경로는 적요를
// 저장하기 전에 이미 같은 함수로 정규화하므로(normalize.mjs 의
// toTransactionRecord) 저장된 `description` 은 곧 키다. 그래서 다른 달의 행은
// `description = $key` 로 찾는다.
//
// ── 받는 쪽 계좌의 내 계좌 간 이체 ───────────────────────────────────────
//
// 메인 → 고정비 · 비상금 이체의 받는 쪽 입금은 적요가 보낸 사람 이름이라 규칙에
// 걸리지 않고 미분류로 남는다. 현금흐름표는 이 돈을 분류와 무관하게 그 계좌의
// `입금`(메인에서)으로 이미 센다. 그래서 메인 쪽 이동 출금과 짝이 맞는 입금
// (lib/report/monthly.mjs 의 `matchIncomingTransfers`)은 **미분류로 세지 않는다**
// — '미분류만' 목록에서 빠지고, '전체' 에서는 묶음에 그 건수가 따로 보인다.
// 짝이 없는 입금은 그대로 미분류다.
//
// ── merchant_map 은 계좌를 모른다 ─────────────────────────────────────────
//
// 묶음은 계좌별이지만 매핑의 키는 여전히 (적요, 방향)이다(스키마를 바꾸지
// 않았다). 분류기(engine.mjs)가 계좌를 보지 않으므로, "앞으로도" 는 계좌와
// 무관하게 같은 적요 · 같은 방향의 거래 전부에 걸린다 — 그래서 쓰기도 **모든
// 계좌 · 모든 달**의 같은 키 · 같은 방향 행 중 manual 이 아닌 행을 함께 바꾼다
// (지금 고른 묶음의 행은 출처와 무관하게 바뀐다). "이번만" 은 그 달 그 계좌 그
// 묶음의 행만 바꾼다.
//
// ── 무엇을 믿지 않는가 ────────────────────────────────────────────────────
//
// 클라이언트가 주는 것은 달 · 계좌(역할) · 키 · 방향 · 분류 · 항목뿐이다. 행 id · 건수 · 금액은
// 받지 않는다. 서버가 그 달의 행을 **직접 다시 읽어** (계좌, 키, 방향)으로 묶고, 그
// 묶음이 실제로 그 달에 있을 때만 쓴다(없는 묶음으로 매핑을 만들지 않는다).
// 묶음 쓰기의 방향은 in · out 만 받는다 — `any` 는 화면에서 만들 수 없다.
//
// ── 덮어쓰기 규칙 ─────────────────────────────────────────────────────────
//
//   이번만     그 달 그 묶음(계좌 + 키 + 방향)의 행 전부 -> 분류 · 항목, 출처 'manual'.
//   앞으로도   merchant_map 에 ((키, 묶음의 방향) -> 분류, 항목) upsert.
//              방향은 늘 in 또는 out 이다(`any` 로 저장하지 않는다).
//              그 달 그 묶음의 행 전부(사용자가 지금 보고 고른 바로 그 행들이다)
//              + 같은 키 · **같은 방향** 의 다른 행(다른 달 · 다른 계좌) 중 출처가
//              NULL · rule · map 인 행 -> 분류 · 항목, 출처 'map'. 묶음 밖의
//              **manual 행은 건드리지 않고**, 반대 방향의 행도 건드리지 않는다.
//              `stripMonth` 체크박스(2026-09, "월마다 문구가 바뀌는 항목") 가 켜져
//              있으면 매핑의 키가 원래 적요가 아니라 `stripMonthToken(키)` 가 된다
//              (없으면 거부 — noMonthToken). 정확한 키의 매핑이 그 폴백보다 늘
//              먼저 걸린다(engine.mjs 1 -> 1-b). lib/classify/month-pattern.mjs.
//   매핑 수정  merchant_map 의 (키, 방향) 한 행을 고치고, 그 매핑이 **다스리는**
//              행 중 manual 이 아닌 행에 반영한다(아래 "다스리는 방향").
//   매핑 삭제  merchant_map 의 (키, 방향) 한 행을 지우고, 그 매핑이 다스리던
//              방향에서 출처가 'map' 인 같은 키의 행만 분류기로 다시 분류한다.
//              분류기는 지운 뒤의 매핑을 읽으므로, 방향 매핑을 지우면 같은 키의
//              `any` 매핑이 있으면 그것이(출처 'map'), 없으면 규칙이('rule'), 그것도
//              없으면 미분류가 된다. manual 은 건드리지 않는다.
//
// ── 다스리는 방향 ─────────────────────────────────────────────────────────
//
// 조회 순서는 방향이 맞는 매핑 -> `any` -> 규칙이다(engine.mjs). 그래서
//
//   (키, in) · (키, out) 매핑은 자기 방향만 다스린다.
//   (키, any) 매핑은 **같은 키의 방향 매핑이 없는 방향만** 다스린다. 예를 들어
//   (키, any) 와 (키, out) 이 함께 있으면 출금 행은 (키, out) 이, 입금 행은
//   (키, any) 가 분류한다.
//
// 수정 · 삭제는 이 "다스리는 방향" 에만 닿는다. `any` 를 고쳐도 (키, out) 이 이미
// 분류한 출금 행은 그대로이고, `any` 를 지워도 출금 행은 (키, out) 그대로다 —
// 그 행들은 처음부터 `any` 가 분류한 것이 아니기 때문이다. 방향 구분 전의
// `any` 매핑만 있으면 양쪽 방향이 다 닿는다.
//
// 쓰기 하나는 트랜잭션 하나다. 중간에 실패하면 전부 되돌린다.
//
// ── 로그 위생 ─────────────────────────────────────────────────────────────
//
// 이 파일에 console 호출이 없다. catch 는 전부 바인딩 없는 `catch {}` 이고,
// 던지는 에러는 고정된 문장뿐이다(pg 메시지에는 적요 · 금액이 섞여 나온다).
// 쓰기 결과는 건수뿐이다 — 적요를 되돌려 주지 않는다.

import { normalizeDescription } from '../toss/normalize.mjs';
import { toBigInt, toSafeNumber } from '../money.mjs';
import { isYearMonth } from '../report/months.mjs';
import { CLASSIFY_CATEGORIES, matchIncomingTransfers } from '../report/monthly.mjs';
import { loadClassifier } from './store.mjs';
import { storedSourceOf } from './engine.mjs';
import { stripMonthToken } from './month-pattern.mjs';
import { CATEGORY_SOURCES, effectiveSource, resolveItem, sanitizeItem } from './item.mjs';
import {
  DIRECTIONS,
  ROW_DIRECTIONS,
  directionOf,
  directionPredicate,
  isMappingDirection,
  isRowDirection,
} from './direction.mjs';

/** 그룹 키 길이 상한. 적요 길이 상한(engine.mjs 의 MAX_SUBJECT_LENGTH)과 같다. */
export const MAX_KEY_LENGTH = 256;

/** 목록 필터. */
export const CLASSIFY_FILTERS = Object.freeze({
  unclassified: 'unclassified',
  all: 'all',
});

/**
 * 묶음이 속한 계좌의 역할. accounts_role_valid CHECK 와 같은 세 값이고, 순서가
 * 곧 화면의 순서다. 클라이언트는 이 값으로만 계좌를 가리킨다(id · 뒤 4자리 아님).
 */
export const ACCOUNT_ROLES = Object.freeze(['main', 'fixed', 'emergency']);

/** 쓰기 범위. */
export const CLASSIFY_SCOPES = Object.freeze({
  once: 'once',
  always: 'always',
});

/** 실패 코드 -> 사용자에게 보여 줄 문장. 입력값은 어디에도 싣지 않는다. */
export const CLASSIFY_ERROR_MESSAGES = Object.freeze({
  badRequest: '요청 형식이 올바르지 않습니다.',
  badMonth: '월 형식이 올바르지 않습니다(YYYY-MM).',
  badScope: '적용 범위가 올바르지 않습니다.',
  badKey: '묶음을 찾을 수 없습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.',
  badDirection: '입금 · 출금 구분이 올바르지 않습니다.',
  badAccount: '계좌 구분이 올바르지 않습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.',
  badCategory: '고를 수 없는 분류입니다.',
  itemNotString: '항목 이름 형식이 올바르지 않습니다.',
  itemControlChars: '항목 이름에 쓸 수 없는 문자가 들어 있습니다.',
  itemTooLong: '항목 이름은 40자까지 쓸 수 있습니다.',
  keyNotFound: '이 달에 그 묶음이 없습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.',
  mappingNotFound: '저장된 매핑이 없습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.',
  noMonthToken: '이 적요에는 월 표시(예: 08월)가 없어 이 옵션을 쓸 수 없습니다. 체크를 해제하고 다시 시도해 주세요.',
  saveFailed: '저장하지 못했습니다. 바뀐 것은 없습니다. 잠시 후 다시 시도해 주세요.',
});

/**
 * 그룹 키. 분류기 · 이 화면 · merchant_map 이 모두 이 함수를 쓴다.
 *
 * @param {unknown} description
 * @returns {string}
 */
export function groupKeyOf(description) {
  return normalizeDescription(description);
}

/** 허용된 분류인가. 목록은 lib/report/monthly.mjs 의 CLASSIFY_CATEGORIES 하나뿐이다. */
export function isAllowedCategory(value) {
  return typeof value === 'string' && CLASSIFY_CATEGORIES.includes(value);
}

function reject(code) {
  return { ok: false, error: code, message: CLASSIFY_ERROR_MESSAGES[code] };
}

/** 클라이언트가 보낸 키를 정규화하고 모양만 본다(존재 여부는 DB 에서 본다). */
function parseKey(value) {
  if (typeof value !== 'string') return null;
  if (value.length > MAX_KEY_LENGTH * 4) return null; // 정규화 전에 터무니없는 길이를 자른다
  const key = groupKeyOf(value);
  if (key === '' || [...key].length > MAX_KEY_LENGTH) return null;
  return key;
}

/**
 * 이번만 · 앞으로도 요청의 본문을 검사한다. DB 에 닿기 전에 부른다.
 *
 * `stripMonth` 는 "앞으로도" 에서만 뜻이 있는 선택 필드다(app/classify/forms.tsx 의
 * 체크박스). 있으면 반드시 boolean 이어야 한다 — 그 밖의 값은 클라이언트가
 * 보낸 모양이 이상하다는 뜻이라 조용히 false 로 넘기지 않고 거부한다. 실제로
 * 월 토큰을 지운 키로 저장할지는 여기서 정하지 않는다(그 적요에 월 토큰이
 * 있는지는 DB 에서 그 달의 실제 행을 확인한 뒤에야 안다 — `applyClassification`
 * 가 `key` 로 `stripMonthToken` 을 다시 계산한다. 클라이언트가 지운 키를
 * 직접 보내지 않는다).
 *
 * @param {unknown} body JSON 본문
 * `account` 는 묶음이 속한 계좌의 역할(`ACCOUNT_ROLES`)이다. 필수다 — 없으면
 * 여러 계좌의 행이 한 번에 바뀔 수 있다.
 *
 * @returns {{ ok: true, value: { scope: string, month: string, account: string, key: string, direction: string, category: string, item: string|null, stripMonth: boolean } }
 *          | { ok: false, error: string, message: string }}
 */
export function parseClassifyRequest(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return reject('badRequest');
  const { scope, month, account, key, direction, category, item, stripMonth } =
    /** @type {Record<string, unknown>} */ (body);

  if (scope !== CLASSIFY_SCOPES.once && scope !== CLASSIFY_SCOPES.always) return reject('badScope');
  if (!isYearMonth(month)) return reject('badMonth');
  if (typeof account !== 'string' || !ACCOUNT_ROLES.includes(account)) return reject('badAccount');
  const parsedKey = parseKey(key);
  if (parsedKey === null) return reject('badKey');
  // 묶음의 방향은 in · out 뿐이다. `any` 는 여기서 만들 수 없다.
  if (!isRowDirection(direction)) return reject('badDirection');
  if (!isAllowedCategory(category)) return reject('badCategory');
  const parsedItem = sanitizeItem(item, parsedKey);
  if (!parsedItem.ok) return reject(parsedItem.code);
  if (stripMonth !== undefined && typeof stripMonth !== 'boolean') return reject('badRequest');

  return {
    ok: true,
    value: {
      scope: /** @type {string} */ (scope),
      month: /** @type {string} */ (month),
      account,
      key: parsedKey,
      direction: /** @type {string} */ (direction),
      category: /** @type {string} */ (category),
      item: parsedItem.item,
      stripMonth: stripMonth === true,
    },
  };
}

/**
 * 매핑 수정 · 삭제 요청의 본문을 검사한다.
 *
 * 방향은 in · out · any 를 받는다 — 이미 저장된 (키, 방향) 한 행을 가리키는
 * 값이다. 수정 · 삭제는 없는 매핑을 만들지 않으므로(없으면 mappingNotFound)
 * 여기서 `any` 를 받아도 화면이 `any` 매핑을 새로 만들 길은 없다.
 */
export function parseMappingRequest(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return reject('badRequest');
  const { action, key, direction, category, item } = /** @type {Record<string, unknown>} */ (body);

  const parsedKey = parseKey(key);
  if (parsedKey === null) return reject('badKey');
  if (!isMappingDirection(direction)) return reject('badDirection');
  const parsedDirection = /** @type {string} */ (direction);

  if (action === 'delete') {
    return { ok: true, value: { action: 'delete', key: parsedKey, direction: parsedDirection } };
  }
  if (action !== 'update') return reject('badRequest');

  if (!isAllowedCategory(category)) return reject('badCategory');
  const parsedItem = sanitizeItem(item, parsedKey);
  if (!parsedItem.ok) return reject(parsedItem.code);
  return {
    ok: true,
    value: {
      action: 'update',
      key: parsedKey,
      direction: parsedDirection,
      category: /** @type {string} */ (category),
      item: parsedItem.item,
    },
  };
}

// ── 읽기 ───────────────────────────────────────────────────────────────────

/**
 * 그 달의 행을 (계좌, 정규화한 적요, 방향)으로 묶는다. DB 를 모른다.
 *
 * 같은 적요의 입금과 출금은 서로 다른 묶음이다. 합계는 한 방향의 금액만 더하므로
 * 부호가 반대인 금액이 서로 상쇄되지 않는다. 계좌가 다르면 역시 다른 묶음이다.
 *
 * `accounts` 를 주면 묶음에 계좌(역할 · 별칭)가 붙고, 받는 쪽 계좌의 내 계좌 간
 * 이체 입금(`matchIncomingTransfers`)을 미분류에서 뺀다. 계좌를 모르는 행은
 * `account: null` 묶음이 된다.
 *
 * @param {Array<{id?:unknown, account_id?:unknown, txn_at?:unknown, description:string, amount:unknown, category:string|null, item?:string|null, category_source?:string|null, is_transfer?:boolean}>} rows
 * @param {string} filter CLASSIFY_FILTERS 의 값
 * @param {Array<{id:unknown, role:string, nickname:string}>} [accounts]
 */
export function groupRows(rows, filter = CLASSIFY_FILTERS.unclassified, accounts = []) {
  const accountById = new Map(
    accounts.map((account) => [String(account.id), { role: String(account.role), nickname: String(account.nickname) }]),
  );
  const incomingTransfers = matchIncomingTransfers({ accounts, rows });
  const rank = (account) => {
    const index = account === null ? -1 : ACCOUNT_ROLES.indexOf(account.role);
    return index === -1 ? ACCOUNT_ROLES.length : index;
  };

  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const row of rows) {
    const key = groupKeyOf(row.description);
    const direction = directionOf(row.amount);
    const account = accountById.get(String(row.account_id)) ?? null;
    const groupId = JSON.stringify([account?.role ?? null, key, direction]);
    const group = groups.get(groupId) ?? {
      account,
      key,
      direction,
      count: 0,
      total: 0n,
      unclassified: 0,
      transferIn: 0,
      transfer: 0,
      manual: 0,
      categories: new Set(),
      items: new Set(),
      sources: new Set(),
    };
    group.count += 1;
    group.total += toBigInt(row.amount);
    const category = row.category === null || row.category === undefined ? null : String(row.category);
    const transferIn = row.id !== undefined && incomingTransfers.has(String(row.id));
    if (transferIn) group.transferIn += 1;
    // 받는 쪽 계좌의 내 계좌 간 이체 입금은 분류가 없어도 미분류로 세지 않는다.
    if (category === null && !transferIn) group.unclassified += 1;
    if (row.is_transfer === true) group.transfer += 1;
    const source = category === null ? null : effectiveSource(row.category_source);
    if (source === CATEGORY_SOURCES.manual) group.manual += 1;
    group.categories.add(category);
    group.items.add(resolveItem(row));
    group.sources.add(source);
    groups.set(groupId, group);
  }

  const single = (set) => (set.size === 1 ? [...set][0] : undefined);

  return [...groups.values()]
    .filter((group) => filter === CLASSIFY_FILTERS.all || group.unclassified > 0)
    .map((group) => {
      const category = single(group.categories);
      const item = single(group.items);
      const source = single(group.sources);
      return {
        account: group.account,
        key: group.key,
        direction: group.direction,
        count: group.count,
        total: toSafeNumber(group.total),
        unclassified: group.unclassified,
        transferIn: group.transferIn,
        transfer: group.transfer,
        manual: group.manual,
        // undefined = 행마다 다르다(혼합). null = 미분류.
        mixed: category === undefined,
        category: category ?? null,
        item: item ?? null,
        mixedItem: item === undefined,
        source: source ?? null,
      };
    })
    .sort((left, right) => {
      const byAccount = rank(left.account) - rank(right.account);
      if (byAccount !== 0) return byAccount;
      const byAmount = Math.abs(right.total) - Math.abs(left.total);
      if (byAmount !== 0) return byAmount;
      if (left.key !== right.key) return left.key < right.key ? -1 : 1;
      return left.direction < right.direction ? -1 : left.direction > right.direction ? 1 : 0;
    });
}

async function readMonthRows(client, month) {
  const result = await client.query(
    `SELECT id, account_id, txn_at, description, amount, category, item, category_source, is_transfer
       FROM transactions
      WHERE year_month = $1
      ORDER BY id`,
    [month],
  );
  return result.rows;
}

/** 계좌 목록. 역할과 별칭만 읽는다 — 뒤 4자리(last4)는 이 화면에 필요 없다. */
async function readAccounts(client) {
  const result = await client.query('SELECT id, role, nickname FROM accounts ORDER BY id');
  return result.rows.map((row) => ({ id: row.id, role: String(row.role), nickname: String(row.nickname) }));
}

/**
 * /classify 화면의 그룹 목록.
 *
 * @param {{query: Function}} client
 * @param {string} month
 * @param {string} filter
 */
export async function listClassifyGroups(client, month, filter) {
  if (!isYearMonth(month)) throw new Error('year_month 는 YYYY-MM 형식이어야 합니다.');
  let rows;
  let accounts;
  try {
    accounts = await readAccounts(client);
    rows = await readMonthRows(client, month);
  } catch {
    throw new Error('분류할 거래를 읽지 못했습니다.');
  }
  return groupRows(rows, filter, accounts);
}

/** 그 달의 미분류 건수. */
export async function countUnclassified(client, month) {
  if (!isYearMonth(month)) throw new Error('year_month 는 YYYY-MM 형식이어야 합니다.');
  try {
    const result = await client.query(
      'SELECT count(*)::int AS n FROM transactions WHERE year_month = $1 AND category IS NULL',
      [month],
    );
    return Number(result.rows[0]?.n ?? 0);
  } catch {
    throw new Error('미분류 건수를 읽지 못했습니다.');
  }
}

/**
 * 저장된 매핑 목록. 적요(키) · 방향 · 분류 · 항목 · 고친 시각.
 *
 * @param {{query: Function}} client
 */
export async function listMappings(client) {
  let result;
  try {
    result = await client.query(
      `SELECT description, direction, category, item, updated_at
         FROM merchant_map
        ORDER BY updated_at DESC, description, direction`,
    );
  } catch {
    throw new Error('매핑 목록을 읽지 못했습니다.');
  }
  return result.rows.map((row) => ({
    key: String(row.description),
    direction: String(row.direction),
    category: String(row.category),
    item: row.item === null || row.item === undefined ? null : String(row.item),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }));
}

// ── 쓰기 ───────────────────────────────────────────────────────────────────

/**
 * 키 단위 advisory 잠금의 네임스페이스(ASCII 'mmap'). 두 int4 인자 형태
 * `pg_advisory_xact_lock(int4, int4)` 는 bigint 한 개 형태(scripts/migrate.mjs 의
 * `pg_advisory_lock(bigint)`)와 잠금 공간이 달라 서로 부딪히지 않는다.
 */
const MAPPING_LOCK_NAMESPACE = 0x6d6d6170;

/**
 * 이미 열린 연결에서 트랜잭션 하나. 실패하면 ROLLBACK 하고 고정된 코드로 답한다.
 *
 * BEGIN 바로 다음 문장으로 **적요 키 단위** 트랜잭션 advisory 잠금을 잡는다.
 * 기본키가 (description, direction) 이라 (키, any) 수정과 (키, out) 앞으로도는
 * 서로 다른 merchant_map 행을 잠근다 — 행 잠금만으로는 줄 서지 않는다. 그러면
 * `any` 수정이 governedDirections 로 [in, out] 을 계산한 뒤 (키, out) 이 커밋되고,
 * `any` 의 UPDATE transactions 가 그 출금 행을 덮어써 매핑과 어긋난다. 같은 키의
 * 쓰기를 전부 이 잠금 뒤에 세워 그 끼어들기를 막는다. 잠금은 COMMIT · ROLLBACK
 * 에서 풀린다. 키는 매개변수로만 넘긴다(해시 충돌은 불필요한 대기일 뿐이다).
 */
async function inTransaction(client, key, work) {
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int4, hashtext($2::text))', [
      MAPPING_LOCK_NAMESPACE,
      key,
    ]);
    const outcome = await work();
    if (outcome.ok) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return outcome;
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    return reject('saveFailed');
  }
}

/**
 * 그 달 그 계좌에서 (키, 방향) 묶음에 해당하는 행 id 를 서버가 직접 찾는다.
 *
 * 방향은 서버가 저장된 금액에서 다시 계산한다(클라이언트의 금액을 믿지 않는다).
 * 계좌는 역할로 거른다. `FOR UPDATE` 로 잠가 같은 행을 두 요청이 동시에 고치는
 * 것을 줄 세운다.
 */
async function monthGroupIds(client, month, account, key, direction) {
  const result = await client.query(
    `SELECT t.id, t.description, t.amount
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.year_month = $1 AND a.role = $2
      ORDER BY t.id
        FOR UPDATE OF t`,
    [month, account],
  );
  return result.rows
    .filter((row) => groupKeyOf(row.description) === key && directionOf(row.amount) === direction)
    .map((row) => String(row.id));
}

/**
 * (키, 방향) 매핑이 다스리는 거래 방향들. 위 "다스리는 방향" 주석.
 *
 * `any` 는 같은 키에 방향 매핑이 없는 방향만 다스린다. 트랜잭션 안에서, 매핑을
 * 고치거나 지운 **뒤에** 부른다(`any` 자신은 결과에 영향을 주지 않는다).
 *
 * @param {{query: Function}} client
 * @param {string} key
 * @param {string} direction in | out | any
 * @returns {Promise<string[]>}
 */
async function governedDirections(client, key, direction) {
  if (direction !== DIRECTIONS.any) return [direction];
  const specific = await client.query(
    `SELECT direction FROM merchant_map WHERE description = $1 AND direction IN ('in', 'out')`,
    [key],
  );
  const taken = new Set(specific.rows.map((row) => String(row.direction)));
  return ROW_DIRECTIONS.filter((candidate) => !taken.has(candidate));
}

/**
 * 이번만 · 앞으로도. `parseClassifyRequest` 를 통과한 값만 받는다.
 *
 * `stripMonth` 가 켜져 있으면(앞으로도에서만 뜻이 있다) `key`(=그 달에 실제로
 * 있다고 이미 확인한 묶음의 정규화된 적요) 에서 `stripMonthToken` 으로 월
 * 토큰을 지운 키를 다시 계산해, merchant_map 은 **그 키**로 저장한다. 클라이언트가
 * 지운 키를 직접 보내지 않는다 — 서버가 검증한 실제 적요에서 다시 계산한다
 * (CLAUDE.md: 클라이언트가 보낸 것을 믿지 않는다). 그 적요에 월 토큰이 없으면
 * (`stripMonthToken` 이 null) 거부한다 — 체크박스가 켜져 있는데 원래 키 그대로
 * 조용히 저장하면, 사람은 "월마다 자동 적용된다"고 믿지만 실제로는 그냥 평범한
 * 정확 매핑이 되어 오해를 남긴다.
 *
 * 이 달 이 묶음(`ids`)의 행은 어느 쪽이든 그대로 바뀐다 — 방금 화면에서 고른
 * 바로 그 적요이므로 지운 키로 저장해도 분류가 안 걸릴 리 없다(1-b 폴백이
 * 그 적요 -> 지운 키로 정확히 다시 찾아 준다, engine.mjs). 다른 달의 적요가
 * 다른 월 토큰을 달고 있어 원문이 다르면, 그 행은 다음 재분류(`classifyStored`)
 * 나 다음 업로드에서 폴백으로 자동 분류된다 — 여기서 즉시 훑지 않는다.
 *
 * @param {{query: Function}} client 열린 연결(트랜잭션은 여기서 연다)
 * @param {{ scope: string, month: string, account: string, key: string, direction: string, category: string, item: string|null, stripMonth?: boolean }} input
 * @returns {Promise<{ok: true, updated: number, mapped: boolean} | {ok: false, error: string, message: string}>}
 */
export async function applyClassification(client, input) {
  // 방어적으로 한 번 더 본다 — 라우트가 검사를 빠뜨려도 여기서 멈춘다.
  const checked = parseClassifyRequest(input);
  if (!checked.ok) return checked;
  const { scope, month, account, key, direction, category, item, stripMonth } = checked.value;

  // 잠금 키는 **실제로 쓰게 될** merchant_map 키여야 한다(원래 키가 아니다).
  // stripMonth 가 켜져 있고 앞으로도(scope always) 라면 그 쓰기 대상은
  // stripMonthToken(key) 다 — 아래 콜백 안에서 다시 계산하는 mapKey 와 같은 값을
  // 잠그기 *전에* 미리 계산해 둔다. 그러지 않으면 원래 키로 잠근 뒤 지운 키로
  // 쓰게 되어, 지운 키가 같은 서로 다른 원래 키(예: `코웨이08월렌탈` ·
  // `코웨이09월렌탈` → `코웨이렌탈`)나 그 지운 키를 직접 쓰는 updateMapping ·
  // deleteMapping 과 서로 다른 잠금을 잡아 줄 서지 않는다(#7 이 막으려던 경쟁이
  // 다시 열린다). 콜백 안의 stripMonthToken 재계산은 그대로 둔다 — noMonthToken
  // 거부(달 토큰이 없는 적요)는 여기서 미리 판정하지 않고 그 자리에서 한다.
  const lockKey =
    scope === CLASSIFY_SCOPES.always && stripMonth ? (stripMonthToken(key) ?? key) : key;

  return inTransaction(client, lockKey, async () => {
    const ids = await monthGroupIds(client, month, account, key, direction);
    if (ids.length === 0) return reject('keyNotFound');

    if (scope === CLASSIFY_SCOPES.once) {
      const updated = await client.query(
        `UPDATE transactions
            SET category = $1, item = $2, category_source = 'manual'
          WHERE id = ANY($3::bigint[])`,
        [category, item, ids],
      );
      return { ok: true, updated: updated.rowCount, mapped: false };
    }

    // key 는 이미 이 달에 실제로 있는 것으로 확인됐다(ids.length > 0). 체크박스가
    // 켜져 있으면 이 실제 값에서 다시 계산한다 — 클라이언트가 지운 키를 직접
    // 보내지 않는다.
    let mapKey = key;
    if (stripMonth) {
      const stripped = stripMonthToken(key);
      if (stripped === null) return reject('noMonthToken');
      mapKey = stripped;
    }

    // 방향은 늘 묶음의 방향(in · out)이다. parseClassifyRequest 가 any 를 막는다.
    await client.query(
      `INSERT INTO merchant_map (description, direction, category, item, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (description, direction)
       DO UPDATE SET category = EXCLUDED.category, item = EXCLUDED.item, updated_at = NOW()`,
      [mapKey, direction, category, item],
    );
    // 매핑은 계좌를 모른다(위 "merchant_map 은 계좌를 모른다"). 그래서 지금 고른
    // 묶음 밖의 같은 키 · 같은 방향 행은 달 · 계좌와 무관하게 manual 이 아니면 따라간다.
    const updated = await client.query(
      `UPDATE transactions
          SET category = $1, item = $2, category_source = 'map'
        WHERE id = ANY($3::bigint[])
           OR (description = $4
               AND ${directionPredicate(5)}
               AND (category_source IS NULL OR category_source <> 'manual'))`,
      [category, item, ids, mapKey, direction],
    );
    return { ok: true, updated: updated.rowCount, mapped: true };
  });
}

/**
 * 매핑 수정. 있는 (키, 방향) 매핑만 고친다(새로 만들지 않는다).
 *
 * 반영 범위는 그 매핑이 다스리는 방향의 manual 이 아닌 행이다.
 *
 * @param {{query: Function}} client
 * @param {{ key: string, direction: string, category: string, item: string|null }} input
 */
export async function updateMapping(client, input) {
  const checked = parseMappingRequest({ ...input, action: 'update' });
  if (!checked.ok) return checked;
  const { key, direction, category, item } = checked.value;

  return inTransaction(client, key, async () => {
    const found = await client.query(
      `UPDATE merchant_map SET category = $3, item = $4, updated_at = NOW()
        WHERE description = $1 AND direction = $2`,
      [key, direction, category, item],
    );
    if (found.rowCount === 0) return reject('mappingNotFound');

    let updated = 0;
    for (const governed of await governedDirections(client, key, direction)) {
      const result = await client.query(
        `UPDATE transactions
            SET category = $1, item = $2, category_source = 'map'
          WHERE description = $3
            AND ${directionPredicate(4)}
            AND (category_source IS NULL OR category_source <> 'manual')`,
        [category, item, key, governed],
      );
      updated += result.rowCount;
    }
    return { ok: true, updated };
  });
}

/**
 * 매핑 삭제. 그 매핑이 다스리던 방향에서 그 매핑이 채운 행(출처 'map')만 분류기로
 * 다시 분류한다.
 *
 * @param {{query: Function}} client
 * @param {{ key: string, direction: string }} input
 */
export async function deleteMapping(client, input) {
  const checked = parseMappingRequest({ ...input, action: 'delete' });
  if (!checked.ok) return checked;
  const { key, direction } = checked.value;

  return inTransaction(client, key, async () => {
    const removed = await client.query('DELETE FROM merchant_map WHERE description = $1 AND direction = $2', [
      key,
      direction,
    ]);
    if (removed.rowCount === 0) return reject('mappingNotFound');

    // 지운 뒤에 계산한다. `any` 를 지웠을 때 방향 매핑이 남아 있는 방향은 빠진다.
    const directions = await governedDirections(client, key, direction);
    const affected = await client.query(
      `SELECT id, description, txn_type, amount
         FROM transactions
        WHERE description = $1
          AND category_source = 'map'
          AND (($2::text = 'in' AND amount > 0) OR ($3::text = 'out' AND amount <= 0))
        ORDER BY id
        FOR UPDATE`,
      [
        key,
        directions.includes(DIRECTIONS.in) ? DIRECTIONS.in : null,
        directions.includes(DIRECTIONS.out) ? DIRECTIONS.out : null,
      ],
    );

    // 지운 뒤에 읽으므로 이 분류기에는 방금 지운 매핑이 없다. 방향 매핑을 지웠다면
    // 같은 키의 `any` 매핑이 걸릴 수 있고(출처 'map', 그 매핑의 항목), 없으면 규칙이다.
    const classifier = await loadClassifier(client);
    let reclassified = 0;
    let unclassified = 0;
    for (const row of affected.rows) {
      const { category, source, item } = classifier.classify(row);
      await client.query(
        `UPDATE transactions
            SET category = $1, item = $4, category_source = $2
          WHERE id = $3::bigint AND category_source = 'map'`,
        [category, category === null ? null : storedSourceOf(source), String(row.id), item ?? null],
      );
      if (category === null) unclassified += 1;
      else reclassified += 1;
    }
    return { ok: true, reclassified, unclassified };
  });
}
