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
//   실현순증감 = 수입 + 고정지출1 + 고정지출2 + 변동지출 + 계좌간이동
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
// 돌려주는 값에 적요·메모·거래 일시는 들어가지 않는다 — 섹션 이름 · 분류 이름 ·
// 카드사 이름 · 합계 · 건수뿐이다.

import { sumBigInt, toBigInt, toSafeNumber } from '../money.mjs';
import { cardIssuerOf } from '../classify/issuer.mjs';

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

/** 이동이 향한(또는 온) 계좌 이름. 분류가 없으면 '기타'. */
function transferLabel(row) {
  return TRANSFER_CATEGORIES[String(row.category ?? '')] ?? '기타';
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
 * @param {Array<{target:string, amount:unknown, reason:string}>} [input.adjustments]
 */
export function aggregateMonthly({ yearMonth, accounts = [], rows = [], adjustments = [] }) {
  const main = accounts.find((account) => account.role === 'main') ?? null;
  const mainId = main === null ? null : String(main.id);

  const income = new Map();
  const fixed1 = new Map();
  const fixed2 = new Map();
  const card = new Map();
  const cardTotal = bucket();
  const variableOther = bucket();
  const transfers = new Map();
  let unclassified = 0;

  const perAccount = new Map();

  for (const row of rows) {
    const accountId = String(row.account_id);
    const amount = toBigInt(row.amount);
    const category = row.category === null || row.category === undefined ? null : String(row.category);

    if (category === null) unclassified += 1;

    const block = perAccount.get(accountId) ?? { rows: [], 입금: bucket(), 집행: bucket(), 이자: bucket() };
    block.rows.push(row);
    if (category === '이자') add(block.이자, amount);
    else if (amount > 0n) add(block.입금, amount);
    else add(block.집행, amount);
    perAccount.set(accountId, block);

    // 종합정산은 메인 계좌만 본다. 다른 계좌의 입금은 메인에서 간 돈이라
    // 여기서 세면 같은 돈을 두 번 세게 된다.
    if (mainId === null || accountId !== mainId) continue;

    if (isTransferLeg(row)) {
      intoKeyed(transfers, transferLabel(row), amount);
      continue;
    }

    if (amount > 0n) {
      intoKeyed(income, category ?? UNCLASSIFIED, amount);
      continue;
    }

    if (category !== null && FIXED1_CATEGORIES.includes(category)) {
      intoKeyed(fixed1, category, amount);
      continue;
    }
    if (category !== null && FIXED2_CATEGORIES.includes(category)) {
      intoKeyed(fixed2, category, amount);
      continue;
    }
    if (category === CARD_CATEGORY) {
      intoKeyed(card, cardIssuerOf(row.description), amount);
      add(cardTotal, amount);
      continue;
    }
    // 규칙에 걸리지 않은 출금과 표의 어느 칸에도 없는 분류. 변동지출로 본다.
    add(variableOther, amount);
  }

  const incomeSection = {
    total: toSafeNumber(sumBigInt([...income.values()].map((value) => value.total))),
    count: [...income.values()].reduce((sum, value) => sum + value.count, 0),
    items: keyedItems(income),
  };
  const fixed1Section = fixedSection(FIXED1_CATEGORIES, fixed1);
  const fixed2Section = fixedSection(FIXED2_CATEGORIES, fixed2);
  const variableSection = {
    total: toSafeNumber(cardTotal.total + variableOther.total),
    count: cardTotal.count + variableOther.count,
    카드대금: {
      total: toSafeNumber(cardTotal.total),
      count: cardTotal.count,
      issuers: keyedItems(card, 'issuer'),
    },
    기타: { total: toSafeNumber(variableOther.total), count: variableOther.count },
  };
  const transferSection = {
    total: toSafeNumber(sumBigInt([...transfers.values()].map((value) => value.total))),
    count: [...transfers.values()].reduce((sum, value) => sum + value.count, 0),
    items: keyedItems(transfers),
  };

  const adjustmentItems = adjustments.map((entry) => ({
    target: String(entry.target),
    amount: toSafeNumber(toBigInt(entry.amount)),
    reason: String(entry.reason ?? ''),
  }));
  const adjustmentSection = {
    total: adjustmentItems.reduce((sum, item) => sum + item.amount, 0),
    count: adjustmentItems.length,
    items: adjustmentItems,
  };

  const realized =
    incomeSection.total +
    fixed1Section.total +
    fixed2Section.total +
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
    변동지출: variableSection,
    // 수입에도 지출에도 넣지 않는 자기 줄. 메인 잔액은 실제로 줄기 때문에
    // 아래 실현순증감에는 별도 항으로 들어간다.
    계좌간이동: transferSection,
    보정: adjustmentSection,
    종합정산: {
      수입: incomeSection.total,
      고정지출1: fixed1Section.total,
      고정지출2: fixed2Section.total,
      변동지출: variableSection.total,
      계좌간이동: transferSection.total,
      // 메인 계좌에서 실제로 움직인 돈. 검산 대상이다.
      실현순증감: realized,
      보정: adjustmentSection.total,
      보정후순증감: realized + adjustmentSection.total,
    },
    // 건수만이다. 금액은 내보내지 않는다.
    미분류: { count: unclassified },
    계좌별잔액변화: balances,
    계좌블록: accountBlocks,
    거래건수: rows.length,
  };
}

/**
 * 그 달의 입력(계좌 · 거래 · 보정)을 읽는다.
 *
 * @param {{query: Function}} client
 * @param {string} yearMonth
 */
export async function loadMonthlyInputs(client, yearMonth) {
  if (typeof yearMonth !== 'string' || !/^\d{4}-\d{2}$/.test(yearMonth)) {
    throw new Error('year_month 는 YYYY-MM 형식이어야 합니다.');
  }

  let accounts;
  let rows;
  let adjustments;
  try {
    accounts = await client.query('SELECT id, role, nickname FROM accounts ORDER BY id');
    rows = await client.query(
      `SELECT id, account_id, txn_at, description, txn_type, amount, balance, category, is_transfer
         FROM transactions
        WHERE year_month = $1
        ORDER BY txn_at, id DESC`,
      [yearMonth],
    );
    adjustments = await client.query(
      'SELECT target, amount, reason FROM adjustments WHERE year_month = $1 ORDER BY id',
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
    adjustments: adjustments.rows,
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
