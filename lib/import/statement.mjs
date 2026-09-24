// 업로드된 토스뱅크 거래내역 xlsx 하나를 파싱해서 transactions 에 저장한다.
//
// 라우트 핸들러(app/api/import/route.ts)는 이 모듈을 감싸는 껍데기일 뿐이다.
// 인증 · multipart 해석 · 직렬화만 거기서 하고, 실제 흐름은 여기 있다.
// Next.js 없이 `node --test` 로 그대로 돌릴 수 있어야 하기 때문이다.
//
// ── 이 모듈이 지키는 것 ────────────────────────────────────────────────────
//
//   1. **결과 객체에 거래 내용을 담지 않는다.** 적요 · 금액 · 잔액 · 거래처 ·
//      행 단위 날짜 · 계좌 뒤 4자리 중 어느 것도 나가지 않는다. 나가는 것은
//      역할 이름 · 조회기간(월 경계) · 건수 · 경고 코드뿐이다. 이 객체는 그대로
//      HTTP 응답이 되고, 응답은 브라우저 devtools · 프록시 로그에 남는다.
//   2. **에러 객체를 절대 밖으로 흘리지 않는다.** 던져진 에러는 코드로만
//      분류하고 message 는 읽지도 않는다. 파서 · pg 의 에러 메시지에는 문제가
//      된 셀 값이 그대로 들어 있다(`invalid input syntax for type bigint: "..."`).
//      그래서 catch 절은 전부 바인딩 없는 `catch {}` 다 — 실수로 쓸 수 없게.
//   3. **아무것도 로그로 출력하지 않는다.** console 호출이 이 파일에 없다.
import { Buffer } from 'node:buffer';

import { openXlsx } from '../xlsx/workbook.mjs';
import { findHeaderRow, parseTossStatement } from '../toss/statement.mjs';
import { reconcileBalances } from '../toss/reconcile.mjs';
import { resolveAccount, toTransactionRecords } from '../toss/normalize.mjs';
import { classifyRecords } from '../classify/engine.mjs';
import { loadClassifier } from '../classify/store.mjs';
import { insertTransactions } from '../db/transactions.mjs';

/**
 * 실패 코드 -> 사용자에게 보여 줄 문장.
 *
 * 코드는 안정적인 식별자(UI 분기용)이고, 문장은 사람이 다음에 무엇을 해야 하는지
 * 말해 준다. 어느 쪽에도 파일 내용은 들어가지 않는다.
 */
export const IMPORT_ERROR_MESSAGES = Object.freeze({
  // 암호화된 xlsx 는 ZIP 이 아니라 OLE2 복합 문서다. 복호화는 구현하지 않았다.
  encrypted:
    '암호가 걸린 엑셀 파일입니다. 토스 앱에서 직접 내려받은 파일을 올려주세요.',
  notXlsx: 'xlsx 파일이 아니거나 파일이 손상되었습니다. 내려받은 파일을 그대로 올려주세요.',
  notTossStatement:
    '토스뱅크 거래내역 형식이 아닙니다. 거래 내역 표(거래 일시 · 적요 · …)를 찾지 못했습니다.',
  accountNotRegistered:
    '이 파일의 계좌가 등록되어 있지 않습니다. 계좌를 먼저 등록한 뒤 다시 올려주세요.',
  parseFailed:
    '거래내역을 읽지 못했습니다. 파일 형식이 예상과 다릅니다. 토스 앱에서 다시 내려받아 올려주세요.',
  saveFailed: '거래를 저장하지 못했습니다. 저장된 건은 없습니다. 잠시 후 다시 시도해 주세요.',
  tooLarge: '파일이 너무 큽니다. 한 파일당 4MB 까지만 올릴 수 있습니다.',
  empty: '빈 파일입니다.',
});

/** 경고 코드. 저장은 됐지만 사람이 한 번 봐야 하는 것들. */
export const WARNING_CODES = Object.freeze({
  /** 토스 표시 상한(각주의 "N만 개까지만")에 닿았다. 뒤가 잘렸을 수 있다. */
  truncationSuspected: 'truncationSuspected',
  /** 같은 초에 여러 건이 있다. 시각만으로는 행을 구분할 수 없다. */
  timestampTies: 'timestampTies',
  /** 파일의 행 순서가 오름차순도 내림차순도 아니다. */
  orderUnsorted: 'orderUnsorted',
  /** `거래 후 잔액` 칸이 빠진 행이 있다. */
  balanceMissing: 'balanceMissing',
  /** 잔액 검산(잔액[n] - 잔액[n+1] == 금액[n])이 어긋난 쌍이 있다. */
  balanceMismatch: 'balanceMismatch',
  /** 모임통장(명의자가 둘 이상)이다. */
  jointAccount: 'jointAccount',
  /** 분류 규칙을 읽지 못해 이 파일은 미분류로 저장했다. 나중에 다시 돌리면 된다. */
  classificationSkipped: 'classificationSkipped',
  /** 컴파일되지 않는 정규식 규칙이 있어 그 규칙만 건너뛰었다. */
  rulePatternSkipped: 'rulePatternSkipped',
});

/** 한 파일의 상한. Vercel 서버리스 요청 본문 상한(4.5MB)보다 낮게 둔다. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** 한 번에 올릴 수 있는 파일 수. 메인 · 고정비 · 비상금 세 개. */
export const MAX_FILE_COUNT = 3;

// 암호화된 OOXML 은 ZIP 이 아니라 OLE2 복합 문서(CFBF)로 감싸여 있다.
// 그 시그니처가 이 8바이트다.
const OLE2_MAGIC = Buffer.from('d0cf11e0a1b11ae1', 'hex');
// 정상 xlsx 는 ZIP 이므로 로컬 파일 헤더 `PK\x03\x04` 로 시작한다.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b]);

function fail(code) {
  return { ok: false, error: code, message: IMPORT_ERROR_MESSAGES[code] };
}

/**
 * 버퍼 앞부분만 보고 "아예 xlsx 가 아닌" 경우를 먼저 걸러 낸다.
 *
 * ZIP 리더에 던져도 결국 실패하지만, 그때는 "EOCD 를 찾지 못했습니다" 같은
 * 한 가지 사유로 뭉뚱그려진다. 암호가 걸린 파일은 사용자가 할 일이 완전히
 * 다르므로(다시 내려받기) 여기서 갈라 둔다.
 *
 * @param {Buffer} buffer
 * @returns {{ ok: true } | { ok: false, error: string, message: string }}
 */
export function checkWorkbookMagic(buffer) {
  if (buffer.length === 0) return fail('empty');
  if (buffer.length >= OLE2_MAGIC.length && buffer.subarray(0, OLE2_MAGIC.length).equals(OLE2_MAGIC)) {
    // 복호화는 구현하지 않았다. 시도하지도 않는다.
    return fail('encrypted');
  }
  if (buffer.length < ZIP_MAGIC.length || !buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    return fail('notXlsx');
  }
  return { ok: true };
}

/**
 * 파싱 결과에서 경고 코드를 뽑는다.
 *
 * ⚠️ `reconcileBalances` 의 결과에는 금액과 차액이 들어 있다. 여기서는
 *    `ok` 불리언만 읽고 나머지는 버린다. 건수조차 내보내지 않는다.
 *
 * @param {ReturnType<import('../toss/statement.mjs').parseTossStatement>} statement
 * @returns {string[]}
 */
export function collectWarnings(statement) {
  const warnings = [];
  if (statement.truncationSuspected) warnings.push(WARNING_CODES.truncationSuspected);
  if (statement.order.ties > 0) warnings.push(WARNING_CODES.timestampTies);
  if (statement.order.direction === 'unsorted') warnings.push(WARNING_CODES.orderUnsorted);
  if (statement.rows.some((row) => !row.hasBalance)) warnings.push(WARNING_CODES.balanceMissing);
  // 검산은 최신순(내림차순)을 전제한다. 그 전제가 깨진 파일에 돌리면 전부
  // 불일치로 잡혀 의미가 없으므로 내림차순일 때만 본다.
  if (statement.order.direction === 'descending' && !reconcileBalances(statement.rows).ok) {
    warnings.push(WARNING_CODES.balanceMismatch);
  }
  if (statement.jointAccount) warnings.push(WARNING_CODES.jointAccount);
  return warnings;
}

/**
 * 메모리에 올라온 xlsx 한 개 -> 파싱 -> 계좌 해석 -> 저장.
 *
 * 던지지 않는다. 실패는 전부 `{ ok: false, error, message }` 로 돌아온다.
 * 파일 하나가 나빠도 다른 파일은 계속 처리되어야 하기 때문이다.
 *
 * 저장은 이 파일 단위로 하나의 트랜잭션이다. 중간에 실패하면 이 파일 몫은
 * 통째로 되돌아간다 — 한 달치가 반만 들어간 상태가 가장 되짚기 어렵다.
 * (`lib/db/client.mjs` 의 `withTransaction` 은 연결을 직접 여는 형태라
 *  이미 열린 연결을 재사용하는 이 경로에는 맞지 않는다.)
 *
 * @param {Buffer} buffer 업로드된 파일 바이트. 디스크에 쓰지 않는다.
 * @param {object} context
 * @param {{ query: Function }} context.client 열려 있는 pg 커넥션
 * @param {Array<{id:number, role:string, nickname:string, last4:string}>} context.accounts
 * @param {number} [context.batchSize]
 */
export async function importStatementBuffer(buffer, { client, accounts, batchSize } = {}) {
  if (!Buffer.isBuffer(buffer)) return fail('notXlsx');
  if (buffer.length > MAX_FILE_BYTES) return fail('tooLarge');

  const magic = checkWorkbookMagic(buffer);
  if (!magic.ok) return magic;

  let sheet;
  try {
    sheet = openXlsx(buffer).sheet(0);
  } catch {
    // ZIP 은 열렸지만 워크북 파트가 없는 경우도 여기로 온다. 사용자가 할 일은
    // 같다 — 제대로 된 파일을 다시 올리는 것.
    return fail('notXlsx');
  }

  // 표 헤더를 먼저 따로 찾는다. "xlsx 는 맞는데 토스 거래내역이 아니다" 와
  // "토스 거래내역인데 값이 이상하다" 는 사용자에게 다른 이야기다.
  try {
    findHeaderRow(sheet);
  } catch {
    return fail('notTossStatement');
  }

  let statement;
  try {
    statement = parseTossStatement(sheet);
  } catch {
    // 머리말 형식 · 날짜 serial · 금액 셀 등. 값은 읽지 않는다.
    return fail('parseFailed');
  }

  let account;
  try {
    // 등록 여부 판정은 normalize 의 것을 그대로 쓴다. 다만 그 에러 메시지에는
    // 뒤 4자리가 들어 있으므로 메시지는 버리고 코드로만 답한다.
    account = resolveAccount(statement.account.last4, accounts);
  } catch {
    return fail('accountNotRegistered');
  }

  let records;
  try {
    records = toTransactionRecords(statement, accounts);
  } catch {
    return fail('parseFailed');
  }

  // 저장 **전에** 분류한다. 업로드 한 번으로 분류까지 끝나야 대시보드가 바로
  // 쓸 만해지고, 나중에 `classifyStored` 를 돌려도 이미 채워진 행은 건드리지
  // 않으므로(=`category IS NULL` 만 본다) 두 경로가 서로를 덮어쓰지 않는다.
  //
  // 규칙을 읽지 못해도 업로드 자체를 실패시키지 않는다. 미분류로 저장해 두면
  // `classifyStored` 가 나중에 같은 규칙으로 같은 결과를 채운다. 거래를 잃는
  // 것보다 분류가 늦는 편이 낫다.
  const classifyWarnings = [];
  try {
    const classifier = await loadClassifier(client);
    classifyRecords(records, classifier);
    if (classifier.skipped.length > 0) {
      classifyWarnings.push(WARNING_CODES.rulePatternSkipped);
    }
  } catch {
    classifyWarnings.push(WARNING_CODES.classificationSkipped);
  }

  let saved;
  try {
    await client.query('BEGIN');
    saved = await insertTransactions(client, records, { batchSize });
    await client.query('COMMIT');
  } catch {
    // 롤백 자체가 실패해도(연결이 끊긴 경우) 사용자에게 할 말은 같다.
    await client.query('ROLLBACK').catch(() => {});
    return fail('saveFailed');
  }

  return {
    ok: true,
    // 계좌를 가리키는 값으로 역할과 별명만 쓴다. 뒤 4자리는 내보내지 않는다.
    account: { role: account.role, nickname: account.nickname },
    // 조회기간은 월 경계이지 개별 거래의 날짜가 아니다.
    period: { from: statement.period.from.iso, to: statement.period.to.iso },
    inserted: saved.inserted,
    skipped: saved.skipped,
    warnings: [...collectWarnings(statement), ...classifyWarnings],
  };
}
