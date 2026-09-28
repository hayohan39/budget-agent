// 파싱된 토스뱅크 거래내역 행 -> transactions 테이블에 넣을 레코드.
//
// 이 모듈이 지키는 것 세 가지.
//
//   1. 시간대. 원본 `거래 일시` 는 타임존이 없는 한국 현지 벽시계 시각이다.
//      여기서 딱 한 번, `+09:00` 을 문자열로 붙여 TIMESTAMPTZ 로 만든다.
//      Date 를 거치지 않으므로 실행 환경의 TZ 가 값에 끼어들 여지가 없다.
//   2. 중복 제거. 같은 달을 두 번 수집해도 새로 저장되는 건이 0 이어야 한다.
//      그러면서 같은 초·같은 금액의 서로 다른 두 건은 구분해야 한다.
//   3. 로그 위생. 적요·금액·잔액은 오류 메시지에 넣지 않는다. 행 번호와
//      필드 이름만 넣는다.
//
// 분류(category)는 다음 단계다. 여기서는 항상 null 로 두고, 계좌 간 이동
// 라벨(is_transfer)만 적요로 판정한다.
import { createHash } from 'node:crypto';

import { normalizeDescription } from '../text/description.mjs';

/** 원본 시각은 타임존 없는 KST 벽시계다. 저장할 때 붙이는 유일한 오프셋. */
export const KST_OFFSET = '+09:00';

/** dedupe_key 계산 방식의 버전. 계산식을 바꾸면 이 값을 올린다. */
const DEDUPE_VERSION = 'v1';

/**
 * 계좌 간 이동 판정용 적요 패턴.
 *
 * 시드 규칙(`migrations/*_seed-category-rules.sql`)의 `비상금 ?계좌` ·
 * `고정비 ?계좌` 와 같은 표현을 쓴다. 분류기 본체는 다음 단계이고, 여기서는
 * "내 계좌 사이의 이동인가"만 라벨로 남긴다.
 *
 * ⚠️ is_transfer 는 집계 제외 플래그가 **아니다.** PLAN.md 의 현금흐름
 *    모델에서 메인 계좌에서 고정비·비상금으로 나간 돈은 유출로 계상한다.
 *    이 플래그는 같은 이동이 두 계좌의 원장에 두 번 잡히는 것을 리포트에서
 *    구분하기 위한 라벨일 뿐이다. 여기서 금액을 상계하지 않는다.
 */
const TRANSFER_PATTERNS = Object.freeze([
  { role: 'emergency', pattern: /비상금 ?계좌/ },
  { role: 'fixed', pattern: /고정비 ?계좌/ },
]);

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function pad(value, width) {
  return String(value).padStart(width, '0');
}

// 적요 정규화는 lib/text/description.mjs 에 있다(Node 전용 import 가 없어 브라우저도
// 같은 함수를 쓴다). 기존 import 경로를 위해 그대로 다시 내보낸다.
export { normalizeDescription };

/** 비어 있는 선택 텍스트 컬럼은 '' 대신 null 로 둔다. */
function optionalText(value) {
  const normalized = normalizeDescription(value);
  return normalized === '' ? null : normalized;
}

/**
 * KST 벽시계 구성요소 -> `+09:00` 오프셋이 명시된 TIMESTAMPTZ 리터럴.
 *
 * Date 를 만들지 않는다. `new Date(year, month - 1, ...)` 는 실행 환경의
 * 시간대로 해석되므로, Vercel(UTC)과 개발 노트북(KST)에서 같은 파일이 서로
 * 다른 순간으로 저장된다. 문자열로 조립하면 그 경로가 아예 없다.
 *
 * @param {{year:number,month:number,day:number,hour:number,minute:number,second:number}} parts
 * @returns {string} 예: `2026-08-01T03:33:28+09:00`
 */
export function toKstTimestamp(parts) {
  const { year, month, day, hour, minute, second } = parts;
  return (
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` +
    `T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}${KST_OFFSET}`
  );
}

/**
 * KST 기준 `YYYY-MM`.
 *
 * 원본 문자열의 연·월을 그대로 쓴다. 한 번 더 계산하는 것처럼 보이지만
 * **이쪽이 맞는 방법이다.** 원본 `거래 일시` 는 이미 KST 벽시계이고,
 * year_month 는 정의상 "KST 기준 날짜의 연월"이기 때문이다.
 *
 * Date 를 거치면 틀린다. `2026.09.01 05:00:00` 은 `2026-09-01T05:00+09:00`
 * = `2026-08-31T20:00Z` 이고, 여기서 UTC 의 연·월(`getUTCMonth`)을 읽으면
 * `2026-08` 이 나온다. 월초 새벽 거래가 조용히 전월로 밀려가고, 잔액 검산은
 * 계좌 단위라 이 이동을 잡아내지 못한다. `Asia/Seoul` 로 되돌리는 변환을
 * 쓰더라도 결과는 원본 문자열의 연·월과 같을 수밖에 없으므로, 틀릴 수 있는
 * 경로를 하나 더 만드는 대신 원본에서 바로 꺼낸다.
 *
 * @param {{year:number,month:number}} parts
 * @returns {string} 예: `2026-09`
 */
export function toYearMonth(parts) {
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}`;
}

/**
 * 중복 제거 키.
 *
 * 재수집해도 같아야 하고(안정성), 서로 다른 거래끼리는 달라야 한다(충돌 없음).
 *
 * 들어가는 것: 계좌 뒤 4자리 · KST 벽시계 문자열 · 금액 · 거래 후 잔액 ·
 * 정규화한 적요의 해시. 시각만으로는 안 되고(fixture 에 같은 초가 4묶음),
 * 시각+금액으로도 안 된다 — 28·29행이 같은 초에 둘 다 -500,000 이다.
 * 잔액이 두 행을 가르고, 적요 해시가 마지막 보루다.
 *
 * **적요 원문은 키에 평문으로 들어가지 않는다.** 키는 로그·URL·에러에 섞여
 * 나가기 쉬운 값이라 거래 내용이 그대로 읽히면 안 된다. 그래서 적요는 먼저
 * 해시해서 넣고, 전체를 다시 sha256 한다.
 *
 * ### 잔액이 없는 행
 *
 * fixture 의 `H18` 처럼 `거래 후 잔액` 칸이 통째로 빠진 행이 실제로 있다.
 * 이때 0 을 넣으면 "잔액 0 인 행"(fixture 의 `H19`)과 같은 키가 되어 버린다.
 * 그래서 잔액 자리에는 숫자와 섞일 수 없는 표식을 넣는데, 표식만 넣으면
 * 두 행을 가르던 discriminator 가 통째로 사라진다.
 *
 * 그 자리를 같은 파일에서 얻을 수 있는 나머지 필드(거래 유형 · 거래 기관 ·
 * 메모)의 해시로 메운다. 잔액이 있는 행은 종전과 똑같이 다섯 요소만 쓰므로,
 * 메모를 나중에 고쳐도 키가 흔들리지 않는다. 메모 변경에 민감해지는 것은
 * 잔액이 빠진 드문 행뿐이고, 그 대가로 그런 행 둘이 같은 키를 받는 일이
 * 없어진다.
 *
 * @param {object} input
 * @param {string} input.last4 계좌번호 뒤 4자리
 * @param {string} input.iso 오프셋 없는 KST 벽시계 문자열
 * @param {number} input.amount
 * @param {number|null} input.balance
 * @param {string} input.description
 * @param {string} [input.txnType] 잔액이 없을 때만 쓰인다
 * @param {string} [input.institution] 잔액이 없을 때만 쓰인다
 * @param {string} [input.memo] 잔액이 없을 때만 쓰인다
 * @returns {string} sha256 hex 64자
 */
export function buildDedupeKey(input) {
  const { last4, iso, amount, balance, description } = input;

  const balanceSlot =
    balance === null || balance === undefined
      ? // 잔액 결손. 숫자와 섞이지 않는 접두사를 두고, 나머지 필드 해시로 메운다.
        `x:${sha256(
          [
            normalizeDescription(input.txnType),
            normalizeDescription(input.institution),
            normalizeDescription(input.memo),
          ].join('\u001f'),
        )}`
      : `b:${String(balance)}`;

  // 각 조각은 16진수·숫자·고정 접두사뿐이라 개행이 들어갈 수 없다. 구분자로
  // 개행을 쓰면 조각 경계를 옮겨 다른 입력이 같은 문자열이 되는 일이 없다.
  const payload = [
    DEDUPE_VERSION,
    last4,
    iso,
    String(amount),
    balanceSlot,
    `d:${sha256(normalizeDescription(description))}`,
  ].join('\n');

  return sha256(payload);
}

/**
 * 적요가 가리키는 내 다른 계좌의 역할(`fixed` · `emergency`). 없으면 null.
 *
 * `isOwnAccountTransfer` 와 같은 패턴 목록을 쓴다. 보낸 쪽(메인) 행의 적요
 * (`고정비 계좌` · `비상금 계좌`)에서 받는 쪽 계좌를 알아낼 때 쓴다
 * (lib/report/monthly.mjs 의 `matchIncomingTransfers`).
 *
 * @param {unknown} description
 * @returns {string|null}
 */
export function ownTransferRoleOf(description) {
  const normalized = normalizeDescription(description);
  const found = TRANSFER_PATTERNS.find(({ pattern }) => pattern.test(normalized));
  return found === undefined ? null : found.role;
}

/**
 * 적요로 내 계좌 간 이동을 판정한다.
 *
 * 적요 패턴만으로는 부족하다 — 그 이름의 계좌가 실제로 등록돼 있어야 하고,
 * 이 명세서 자신의 계좌여서는 안 된다(자기 계좌로의 이동은 없다). 금액·날짜
 * 대조 같은 정교한 짝짓기는 하지 않는다. PLAN.md 가 말하듯 적요에 가계부
 * 항목명이 그대로 들어 있어서 이것으로 충분하다.
 *
 * @param {string} description
 * @param {Array<{id:number, role:string}>} accounts 등록된 계좌 전부
 * @param {number} ownAccountId 이 명세서의 계좌 id
 * @returns {boolean}
 */
export function isOwnAccountTransfer(description, accounts, ownAccountId) {
  const normalized = normalizeDescription(description);
  return TRANSFER_PATTERNS.some(({ role, pattern }) => {
    if (!pattern.test(normalized)) return false;
    const target = accounts.find((account) => account.role === role);
    return target !== undefined && target.id !== ownAccountId;
  });
}

/**
 * 뒤 4자리로 계좌를 찾는다. 못 찾으면 던진다.
 *
 * 추측해서 아무 계좌에나 넣으면 그 달의 현금흐름표가 통째로 틀리면서도
 * 검산은 계좌 단위라 통과해 버린다. 조용히 넘어가는 대신 멈춘다.
 * 뒤 4자리는 이미 accounts 테이블에 있는 값이라 메시지에 넣어도 새는 것이
 * 없다 — 대신 다른 값은 넣지 않는다.
 *
 * @param {string} last4
 * @param {Array<{id:number, role:string, last4:string}>} accounts
 */
export function resolveAccount(last4, accounts) {
  const found = accounts.find((account) => account.last4 === last4);
  if (!found) {
    throw new Error(
      `등록되지 않은 계좌입니다: 뒤 4자리 ${last4}. accounts 에 먼저 등록하세요(npm run accounts:seed).`,
    );
  }
  return found;
}

function requireInteger(value, what, sheetRow) {
  // 파서가 이미 정수로 만들어 주지만 여기서 다시 못을 박는다. 이 값들은
  // BIGINT 컬럼으로 그대로 흘러가고, 한 번 잘못 들어가면 검산이 어긋난
  // 원인을 되짚기 어렵다. 값은 메시지에 넣지 않는다.
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${sheetRow}행: ${what}이(가) 안전한 정수가 아닙니다.`);
  }
  return value;
}

/**
 * 파싱된 행 하나 -> transactions 레코드 하나.
 *
 * @param {object} row `parseTossStatement` 의 rows 원소
 * @param {object} context
 * @param {string} context.accountLast4 명세서 머리말의 계좌 뒤 4자리
 * @param {Array<{id:number, role:string, last4:string}>} context.accounts
 */
export function toTransactionRecord(row, { accountLast4, accounts }) {
  const account = resolveAccount(accountLast4, accounts);
  const sheetRow = row.sheetRow ?? '?';

  const amount = requireInteger(row.amount, '거래 금액', sheetRow);
  const balance =
    row.balance === null || row.balance === undefined
      ? null
      : requireInteger(row.balance, '거래 후 잔액', sheetRow);

  return {
    account_id: account.id,
    // 오프셋을 붙인 문자열 그대로 넘긴다. pg 가 텍스트로 보내고 Postgres 가
    // 오프셋을 해석한다.
    txn_at: toKstTimestamp(row.datetime),
    // description 은 NOT NULL 이다. 적요가 빈 행이 있어도 ''(빈 문자열)로 둔다.
    description: normalizeDescription(row.description),
    txn_type: normalizeDescription(row.txnType),
    institution: optionalText(row.institution),
    // ⚠️ 항상 null 이다. 원본의 `계좌번호`(상대방 계좌) 열은 General 서식의
    //    숫자 셀이라 앞자리 0 이 구조적으로 사라진다(`1.2341234E7`). 파서가
    //    이 열을 아예 읽지 않는 이유이고(lib/toss/statement.mjs readRow),
    //    읽어 봐야 "틀린 값의 해시"라서 대조도 복원도 되지 않으면서 개인정보
    //    취급 대상만 하나 늘어난다. 이 컬럼을 채우는 코드 경로는 두지 않는다.
    cp_acct_hash: null,
    amount,
    balance,
    memo: optionalText(row.memo),
    // 분류는 다음 단계(merchant_map -> category_rules). 여기서는 미분류로 둔다.
    category: null,
    is_transfer: isOwnAccountTransfer(row.description, accounts, account.id),
    dedupe_key: buildDedupeKey({
      last4: account.last4,
      iso: row.datetime.iso,
      amount,
      balance,
      description: row.description,
      txnType: row.txnType,
      institution: row.institution,
      memo: row.memo,
    }),
    year_month: toYearMonth(row.datetime),
  };
}

/**
 * 명세서 하나 -> transactions 레코드 배열.
 *
 * 파일에 적힌 순서(최신순)를 그대로 유지한다. 재정렬하면 같은 초의 행들
 * 순서가 흔들린다.
 *
 * @param {ReturnType<import('./statement.mjs').parseTossStatement>} statement
 * @param {Array<{id:number, role:string, last4:string}>} accounts accounts 테이블 전체
 */
export function toTransactionRecords(statement, accounts) {
  const accountLast4 = statement.account.last4;
  // 계좌 해석은 행마다 같다. 없는 계좌면 행을 하나도 만들기 전에 던진다.
  resolveAccount(accountLast4, accounts);
  return statement.rows.map((row) => toTransactionRecord(row, { accountLast4, accounts }));
}
