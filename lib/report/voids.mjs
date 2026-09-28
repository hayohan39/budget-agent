// 무효(상쇄) 처리 — 사람이 출금 · 입금 한 쌍을 "없던 일" 로 표시한다(voided_pairs).
//
// 사용자 요청(2026-09): "지현 IRP, 선용 IRP 의 경우 출금되었다가 거부되어서 다시 입금되는
// 경우가 있는데 이때 중복으로 수입에 잡히는 것 같아. 보통은 입출금 항목 모두 독립적으로
// 동작해야하는게 맞지만 이 경우에는 입출금 무효화 하고 싶어. 예외처리할 수 있는 기능도
// 추가해줘."
//
// ── 무엇을 하는가 ─────────────────────────────────────────────────────────
//
//   후보 찾기   같은 계좌 · 금액 크기가 같고 방향이 반대인 두 거래가 `VOID_WINDOW_DAYS`
//               일 안에 있으면 후보다. 적요나 메모가 같은 쌍이 먼저 온다. **제안만 한다** —
//               저절로 무효가 되는 거래는 없다.
//   무효 처리   사람이 후보(또는 두 거래 id)를 고르면 서버가 두 행을 잠그고 다시 검사한 뒤
//               한 쌍을 저장한다. 두 거래는 현금흐름표의 수입 · 지출 · 미분류 · 계좌 블록 ·
//               통계에서 빠진다(lib/report/monthly.mjs 의 isVoided).
//   해제        그 쌍의 행 하나를 지운다. 두 거래는 원래 자리로 돌아간다.
//
// 검산: 무효 쌍도 메인 잔액을 실제로 움직였다(출금됐다가 되돌아왔다). 현금흐름표는 두
// 거래를 `무효처리` 한 항으로 모아 실현순증감에 넣으므로(같은 달이면 0) 검산이 그대로 맞는다.
//
// ── 무엇을 믿지 않는가 ────────────────────────────────────────────────────
//
// 클라이언트는 거래 id(숫자 문자열)만 보낸다. 계좌 · 금액 · 방향은 서버가 잠근 행에서 다시
// 읽어 검사한다. 이미 다른 쌍에 든 거래는 거부한다(스키마 UNIQUE 가 마지막 방어선).
//
// ── 로그 위생 ─────────────────────────────────────────────────────────────
//
// 이 파일에 console 호출이 없다. catch 는 바인딩 없는 `catch {}` 이고 던지는 에러는 고정된
// 문장뿐이다. 후보 · 목록에는 적요 · 메모 · 금액 · 날짜가 들어간다 — 사람이 쌍을 알아볼 수
// 있어야 하기 때문이다. 로그인 + 화이트리스트 뒤의 no-store 화면에만 그린다.

import { toBigInt, toSafeNumber } from '../money.mjs';
import { normalizeDescription } from '../toss/normalize.mjs';
import { isYearMonth } from './months.mjs';
import { isTransferLeg, isVaultMove } from './monthly.mjs';

/** 후보로 보는 두 거래의 최대 시각 차이(일). 출금 뒤 거부 · 반환은 보통 며칠 안이다. */
export const VOID_WINDOW_DAYS = 31;

/** 한 달 화면에 보여 줄 후보 쌍 수 상한. */
export const MAX_VOID_CANDIDATES = 20;

/** 무효 쓰기 전체를 한 줄로 세우는 트랜잭션 잠금(ASCII 'void', 0). */
const VOID_WRITE_LOCK = Object.freeze([0x766f6964, 0]);

/** 실패 코드 -> 문장. 입력값은 싣지 않는다. */
export const VOID_ERROR_MESSAGES = Object.freeze({
  badRequest: '요청 형식이 올바르지 않습니다.',
  notFound: '거래를 찾을 수 없습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.',
  sameTransaction: '같은 거래 둘을 짝지을 수 없습니다.',
  accountMismatch: '두 거래의 계좌가 다릅니다. 같은 계좌의 출금 · 입금만 무효 처리할 수 있습니다.',
  directionMismatch: '출금 하나와 입금 하나를 골라 주세요.',
  amountMismatch: '두 거래의 금액이 다릅니다. 금액이 같은 출금 · 입금만 무효 처리할 수 있습니다.',
  alreadyVoided: '이미 무효 처리된 거래가 들어 있습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.',
  pairNotFound: '무효 처리 내역이 없습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.',
  saveFailed: '저장하지 못했습니다. 바뀐 것은 없습니다. 잠시 후 다시 시도해 주세요.',
});

function reject(code) {
  return { ok: false, error: code, message: VOID_ERROR_MESSAGES[code] };
}

/** BIGSERIAL id 문자열. 앞자리 0 · 부호 · 공백을 받지 않는다(19자리까지). */
const ID_TEXT = /^[1-9][0-9]{0,18}$/;

function parseId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && ID_TEXT.test(value)) return value;
  return null;
}

/**
 * 요청 본문 검사. `{ action: 'void', outId, inId }` 또는 `{ action: 'unvoid', pairId }`.
 *
 * @param {unknown} body
 */
export function parseVoidRequest(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return reject('badRequest');
  const { action, outId, inId, pairId } = /** @type {Record<string, unknown>} */ (body);
  if (action === 'void') {
    const out = parseId(outId);
    const inn = parseId(inId);
    if (out === null || inn === null) return reject('badRequest');
    if (out === inn) return reject('sameTransaction');
    return { ok: true, value: { action: 'void', outId: out, inId: inn } };
  }
  if (action === 'unvoid') {
    const pair = parseId(pairId);
    if (pair === null) return reject('badRequest');
    return { ok: true, value: { action: 'unvoid', pairId: pair } };
  }
  return reject('badRequest');
}

async function inTransaction(client, work) {
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int4, $2::int4)', VOID_WRITE_LOCK);
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
 * 두 거래를 무효(상쇄) 한 쌍으로 저장한다. 어느 쪽이 출금인지는 서버가 금액으로 정한다
 * (outId · inId 가 바뀌어 와도 된다).
 *
 * @param {{query: Function}} client
 * @param {{ outId: unknown, inId: unknown }} input
 * @returns {Promise<{ok: true, pairId: string} | {ok: false, error: string, message: string}>}
 */
export async function voidPair(client, input) {
  const checked = parseVoidRequest({ ...input, action: 'void' });
  if (!checked.ok) return checked;
  const { outId, inId } = checked.value;

  return inTransaction(client, async () => {
    const found = await client.query(
      `SELECT id, account_id, amount
         FROM transactions
        WHERE id = ANY($1::bigint[])
        ORDER BY id
          FOR UPDATE`,
      [[outId, inId]],
    );
    if (found.rows.length !== 2) return reject('notFound');
    const [first, second] = found.rows;
    if (String(first.account_id) !== String(second.account_id)) return reject('accountMismatch');
    const a = toBigInt(first.amount);
    const b = toBigInt(second.amount);
    const outflow = a < 0n ? first : b < 0n ? second : null;
    const inflow = a > 0n ? first : b > 0n ? second : null;
    if (outflow === null || inflow === null) return reject('directionMismatch');
    if (toBigInt(outflow.amount) + toBigInt(inflow.amount) !== 0n) return reject('amountMismatch');

    const taken = await client.query(
      `SELECT 1 FROM voided_pairs
        WHERE out_txn_id = ANY($1::bigint[]) OR in_txn_id = ANY($1::bigint[])
        LIMIT 1`,
      [[outId, inId]],
    );
    if (taken.rows.length > 0) return reject('alreadyVoided');

    const inserted = await client.query(
      'INSERT INTO voided_pairs (out_txn_id, in_txn_id) VALUES ($1, $2) RETURNING id',
      [String(outflow.id), String(inflow.id)],
    );
    return { ok: true, pairId: String(inserted.rows[0].id) };
  });
}

/**
 * 무효 처리 해제.
 *
 * @param {{query: Function}} client
 * @param {{ pairId: unknown }} input
 */
export async function unvoidPair(client, input) {
  const checked = parseVoidRequest({ ...input, action: 'unvoid' });
  if (!checked.ok) return checked;
  return inTransaction(client, async () => {
    const removed = await client.query('DELETE FROM voided_pairs WHERE id = $1::int', [checked.value.pairId]);
    if (removed.rowCount === 0) return reject('pairNotFound');
    return { ok: true };
  });
}

/** 앞뒤 달. `YYYY-MM` 문자열 산술(Date 를 거치지 않는다). */
function neighborMonths(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  const shift = (delta) => {
    const index = year * 12 + (month - 1) + delta;
    return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
  };
  return [shift(-1), yearMonth, shift(1)];
}

/** 화면에 보일 거래 한 건. */
function leg(row) {
  return {
    id: String(row.id),
    yearMonth: String(row.year_month).trim(),
    at: String(row.at_text),
    description: normalizeDescription(row.description),
    memo: normalizeDescription(row.memo) || null,
    amount: toSafeNumber(toBigInt(row.amount)),
  };
}

const LEG_COLUMNS = `t.id, t.account_id, t.year_month, t.txn_at, t.description, t.memo, t.amount, t.category, t.is_transfer,
       to_char(t.txn_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS at_text`;

/**
 * 그 달에 한 쪽이라도 걸친 무효 쌍 목록.
 *
 * @param {{query: Function}} client
 * @param {string} yearMonth
 */
export async function listVoidedPairs(client, yearMonth) {
  if (!isYearMonth(yearMonth)) throw new Error('year_month 는 YYYY-MM 형식이어야 합니다.');
  let result;
  try {
    result = await client.query(
      `SELECT v.id AS pair_id, a.role, a.nickname,
              o.id AS o_id, o.year_month AS o_ym, o.description AS o_desc, o.memo AS o_memo, o.amount AS o_amount,
              to_char(o.txn_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS o_at,
              i.id AS i_id, i.year_month AS i_ym, i.description AS i_desc, i.memo AS i_memo, i.amount AS i_amount,
              to_char(i.txn_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS i_at
         FROM voided_pairs v
         JOIN transactions o ON o.id = v.out_txn_id
         JOIN transactions i ON i.id = v.in_txn_id
         JOIN accounts a ON a.id = o.account_id
        WHERE o.year_month = $1 OR i.year_month = $1
        ORDER BY o.txn_at, v.id`,
      [yearMonth],
    );
  } catch {
    throw new Error('무효 처리 목록을 읽지 못했습니다.');
  }
  return result.rows.map((row) => ({
    pairId: String(row.pair_id),
    account: { role: String(row.role), nickname: String(row.nickname) },
    out: leg({ id: row.o_id, year_month: row.o_ym, at_text: row.o_at, description: row.o_desc, memo: row.o_memo, amount: row.o_amount }),
    in: leg({ id: row.i_id, year_month: row.i_ym, at_text: row.i_at, description: row.i_desc, memo: row.i_memo, amount: row.i_amount }),
  }));
}

/**
 * 두 거래의 글자(적요 · 메모)가 겹치는가. 빈 값은 겹침으로 세지 않는다.
 */
function sharesText(left, right) {
  const words = new Set([left.description, left.memo].filter((value) => value));
  return [right.description, right.memo].some((value) => value && words.has(value));
}

/**
 * 무효 후보 쌍 찾기. DB 를 모른다 — 행만 받는다(테스트용으로 따로 내보낸다).
 *
 * 조건: 같은 계좌 · 출금 하나와 입금 하나 · 금액 크기 같음 · 시각 차이 `windowDays` 일 이하 ·
 * 둘 중 하나는 `yearMonth` 의 거래 · 둘 다 아직 무효가 아님(호출자가 거른다) · 내 계좌 간
 * 이동 다리(isTransferLeg)나 금고 이동(isVaultMove)이 아님.
 * 순서: 적요나 메모가 겹치는 쌍 -> 출금이 먼저인 쌍(출금 뒤 되돌아온 입금) -> 시각 차이가
 * 작은 쌍 -> id. 한 거래가 여러 후보에 나올 수 있다(하나를 무효로 하면 나머지는 사라진다).
 *
 * @param {Array<object>} rows `LEG_COLUMNS` 모양 + role · nickname
 * @param {string} yearMonth
 * @param {{ windowDays?: number, limit?: number }} [options]
 */
export function findVoidCandidates(rows, yearMonth, { windowDays = VOID_WINDOW_DAYS, limit = MAX_VOID_CANDIDATES } = {}) {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const outs = [];
  const ins = [];
  for (const row of rows) {
    // 내 계좌 간 이동 · 금고 이동은 이미 제자리가 있다(계좌간이동 · 금고저축/인출). 후보가 아니다.
    if (isTransferLeg(row) || isVaultMove(row, row.role)) continue;
    const amount = toBigInt(row.amount);
    const entry = { row, amount, at: new Date(row.txn_at).getTime(), leg: leg(row) };
    if (amount < 0n) outs.push(entry);
    else if (amount > 0n) ins.push(entry);
  }
  const candidates = [];
  for (const out of outs) {
    for (const inn of ins) {
      if (String(out.row.account_id) !== String(inn.row.account_id)) continue;
      if (out.amount + inn.amount !== 0n) continue;
      const gap = inn.at - out.at;
      if (Math.abs(gap) > windowMs) continue;
      if (out.leg.yearMonth !== yearMonth && inn.leg.yearMonth !== yearMonth) continue;
      candidates.push({
        account: { role: String(out.row.role), nickname: String(out.row.nickname) },
        out: out.leg,
        in: inn.leg,
        similar: sharesText(out.leg, inn.leg),
        outFirst: gap >= 0,
        gapMs: Math.abs(gap),
      });
    }
  }
  const byId = (left, right) => {
    const a = toBigInt(left);
    const b = toBigInt(right);
    return a === b ? 0 : a < b ? -1 : 1;
  };
  candidates.sort(
    (left, right) =>
      Number(right.similar) - Number(left.similar) ||
      Number(right.outFirst) - Number(left.outFirst) ||
      left.gapMs - right.gapMs ||
      byId(left.out.id, right.out.id) ||
      byId(left.in.id, right.in.id),
  );
  return candidates.slice(0, limit).map(({ gapMs, ...rest }) => ({ ...rest, gapDays: Math.round(gapMs / 86400000) }));
}

/**
 * 그 달의 무효 후보 쌍. 앞뒤 달까지 **쿼리 한 번**으로 읽는다(창이 31일이라 충분하다).
 *
 * @param {{query: Function}} client
 * @param {string} yearMonth
 */
export async function listVoidCandidates(client, yearMonth) {
  if (!isYearMonth(yearMonth)) throw new Error('year_month 는 YYYY-MM 형식이어야 합니다.');
  let result;
  try {
    result = await client.query(
      `SELECT ${LEG_COLUMNS}, a.role, a.nickname
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE t.year_month = ANY($1::char(7)[])
          AND NOT EXISTS (SELECT 1 FROM voided_pairs v WHERE v.out_txn_id = t.id OR v.in_txn_id = t.id)
        ORDER BY t.id`,
      [neighborMonths(yearMonth)],
    );
  } catch {
    throw new Error('무효 후보를 읽지 못했습니다.');
  }
  return findVoidCandidates(result.rows, yearMonth);
}
