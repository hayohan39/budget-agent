// 토스뱅크 거래내역 xlsx 시트 -> 구조화된 행.
//
// 원칙
//   - 행·열 번호를 상수로 박지 않는다. 헤더 8개가 나란히 있는 행을 찾아서 거기서
//     열 위치를 얻는다. 토스가 머리말 줄 수를 하나 바꾸면 끝날 문제로 파서가
//     깨지면 안 된다.
//   - 상대방 `계좌번호` 열은 읽지도 돌려주지도 않는다(아래 SKIPPED 주석 참고).
//   - 오류 메시지에는 셀 참조와 사유만 넣는다. 값은 넣지 않는다.
import { toExactInteger, describeIntegerFailure } from '../xlsx/number.mjs';
import { cellRef, openXlsx } from '../xlsx/workbook.mjs';
import { parseNaiveDate, parseNaiveTimestamp } from './datetime.mjs';

/** 표의 헤더 8개. 사이 공백은 보통 공백(U+0020) 하나다. */
export const TOSS_HEADERS = Object.freeze([
  '거래 일시',
  '적요',
  '거래 유형',
  '거래 기관',
  '계좌번호',
  '거래 금액',
  '거래 후 잔액',
  '메모',
]);

// 헤더 순서 그대로의 내부 키. `counterpartyAccount` 는 자리만 세고 값은 읽지
// 않는다(=SKIPPED).
const COLUMN_KEYS = Object.freeze([
  'datetime',
  'description',
  'txnType',
  'institution',
  'counterpartyAccount',
  'amount',
  'balance',
  'memo',
]);

const LABEL_HOLDER = '성명';
const LABEL_ACCOUNT = '계좌번호';
const LABEL_PERIOD = '조회기간';

const MASKED_ACCOUNT = /^\*{4}-\*{4}-(\d{4})$/;
const PERIOD_RANGE = /^(\d{4}\.\d{2}\.\d{2})\s*-\s*(\d{4}\.\d{2}\.\d{2})$/;
const JOINT_SUFFIX = /\s외\s*(\d+)\s*인\s*$/;
// "거래내역은 10만 개까지만 표시됩니다" — 표시 상한 각주.
const ROW_CAP_NOTE = /(\d+)\s*만\s*개까지만/;

// 비교용 정규화: 앞뒤 공백을 떼고, 붙여넣기로 섞여 들어오는 줄바꿈·비분리
// 공백(U+00A0)을 보통 공백으로 눌러 준다. 사이 공백 자체는 건드리지 않는다.
function normalizeLabel(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/[ \s]+/g, ' ').trim();
}

function textOf(sheet, ref) {
  const value = sheet.value(ref);
  return typeof value === 'string' ? value : null;
}

/**
 * 헤더 8개가 연속으로 놓인 행을 찾는다.
 *
 * 한 칸만 보고 찾으면 안 된다. `계좌번호` 는 머리말 블록의 라벨로도 등장하고
 * (같은 공유 문자열을 가리킨다) 그쪽이 표보다 위에 있어서, 단일 셀 매칭은
 * 머리말 행을 표 헤더로 잘못 잡는다.
 */
export function findHeaderRow(sheet) {
  const candidates = [...sheet.cells.values()]
    .filter((cell) => normalizeLabel(cell.value) === TOSS_HEADERS[0])
    .sort((a, b) => a.row - b.row || a.columnIndex - b.columnIndex);

  for (const candidate of candidates) {
    const matched = TOSS_HEADERS.every(
      (header, offset) =>
        normalizeLabel(sheet.value(cellRef(candidate.row, candidate.columnIndex + offset))) ===
        header,
    );
    if (matched) {
      const columns = {};
      COLUMN_KEYS.forEach((key, offset) => {
        columns[key] = candidate.columnIndex + offset;
      });
      return { row: candidate.row, firstColumn: candidate.columnIndex, columns };
    }
  }

  throw new Error(
    `표 헤더(${TOSS_HEADERS.join(' · ')}) 8개가 연속으로 놓인 행을 찾지 못했습니다.`,
  );
}

// 머리말 블록에서 라벨을 찾아 그 오른쪽 칸의 참조를 돌려준다. 값 칸이 병합돼
// 있어도(`C3:F3`) 값이 든 좌상단 셀이 바로 오른쪽 칸이다.
function findLabelValueRef(sheet, label, beforeRow) {
  const labelCell = [...sheet.cells.values()]
    .filter((cell) => cell.row < beforeRow && normalizeLabel(cell.value) === label)
    .sort((a, b) => a.row - b.row || a.columnIndex - b.columnIndex)[0];

  if (!labelCell) return null;
  return sheet.mergeAnchor(cellRef(labelCell.row, labelCell.columnIndex + 1));
}

/**
 * 머리말 블록을 읽는다.
 *
 * 성명은 **값을 돌려주지 않는다.** 이 파서의 결과는 그대로 DB 로 흘러가는데
 * 이름을 담을 컬럼이 없고(PLAN.md 스키마), 쓰지 않을 개인정보를 메모리와
 * 로그 경로에 띄워 둘 이유가 없다. 모임통장 판별에 필요한 `외 N인` 정보만
 * 숫자로 남긴다.
 */
export function readHeaderBlock(sheet, headerRow) {
  const accountRef = findLabelValueRef(sheet, LABEL_ACCOUNT, headerRow);
  if (!accountRef) {
    throw new Error(`머리말 블록에서 "${LABEL_ACCOUNT}" 라벨을 찾지 못했습니다.`);
  }

  const maskedAccount = textOf(sheet, accountRef);
  const matched = maskedAccount === null ? null : MASKED_ACCOUNT.exec(maskedAccount);
  if (!matched) {
    // 뒤 4자리는 계좌를 구분하는 유일한 키다. 형식이 다르면 추측하지 않고 멈춘다.
    throw new Error(
      `${accountRef}: 계좌번호가 마스킹 형식(****-****-0000)이 아닙니다. 계좌를 판별할 수 없습니다.`,
    );
  }
  const accountLast4 = matched[1];

  const periodRef = findLabelValueRef(sheet, LABEL_PERIOD, headerRow);
  const periodText = periodRef === null ? null : textOf(sheet, periodRef);
  const periodMatch = periodText === null ? null : PERIOD_RANGE.exec(periodText);
  if (!periodMatch) {
    throw new Error(
      `${periodRef ?? '머리말'}: 조회기간이 "YYYY.MM.DD - YYYY.MM.DD" 형식이 아닙니다.`,
    );
  }
  const from = parseNaiveDate(periodMatch[1]);
  const to = parseNaiveDate(periodMatch[2]);
  if (!from.ok || !to.ok) {
    throw new Error(`${periodRef}: 조회기간의 날짜가 달력에 없는 날짜입니다.`);
  }

  const holderRef = findLabelValueRef(sheet, LABEL_HOLDER, headerRow);
  const holderText = holderRef === null ? null : textOf(sheet, holderRef);
  const jointMatch = holderText === null ? null : JOINT_SUFFIX.exec(holderText);

  // 각주에서 표시 상한을 읽는다. 상한을 코드에 박지 않고 파일이 말하는 값을 쓴다.
  let rowCap = null;
  for (const cell of sheet.cells.values()) {
    if (cell.row >= headerRow || typeof cell.value !== 'string') continue;
    const noteMatch = ROW_CAP_NOTE.exec(cell.value);
    if (noteMatch) {
      rowCap = Number(noteMatch[1]) * 10000;
      break;
    }
  }

  return {
    accountLast4,
    accountRef,
    period: { from: from.value, to: to.value, raw: periodText },
    // 이름은 담지 않는다. 모임통장인지와 명의자 수만.
    jointAccount: jointMatch !== null,
    holderCount: jointMatch === null ? 1 : Number(jointMatch[1]) + 1,
    rowCap,
  };
}

function requireText(sheet, ref, what) {
  const value = sheet.value(ref);
  if (typeof value !== 'string') {
    throw new Error(`${ref}: ${what}이(가) 문자열이 아닙니다.`);
  }
  return value;
}

function optionalText(sheet, ref) {
  const value = sheet.value(ref);
  return typeof value === 'string' ? value : '';
}

/**
 * 값이 반드시 있어야 하는 정수 셀(거래 금액).
 * @returns {number}
 */
function readRequiredInteger(sheet, ref, what) {
  if (sheet.state(ref) !== 'present') {
    throw new Error(`${ref}: ${what}이(가) 비어 있습니다.`);
  }

  // 숫자 셀은 raw 문자열로 읽는다. 해석된 숫자를 쓰면 1e7 이상에서 표기가
  // 사라지고, 소수부가 있었는지도 알 수 없다.
  const result = toExactInteger(sheet.raw(ref));
  if (!result.ok) {
    throw new Error(`${ref}: ${what} ${describeIntegerFailure(result.reason)}.`);
  }
  return result.value;
}

/**
 * 없을 수 있는 정수 셀(거래 후 잔액). 없으면 null — 0 과는 다른 값이다.
 * @returns {number|null}
 */
function readOptionalInteger(sheet, ref, what) {
  // 셀이 없거나(absent) 값이 없다(blank).
  if (sheet.state(ref) !== 'present') return null;
  return readRequiredInteger(sheet, ref, what);
}

/**
 * 데이터 행 하나를 읽는다.
 *
 * ⚠️ `계좌번호`(상대방 계좌) 열은 일부러 읽지 않는다.
 *   이 열은 General 서식의 **숫자** 셀이다(fixture 에서 `1.2341234E7`).
 *   숫자가 된 시점에서 앞자리 0 이 사라졌고 표기도 지수형이라, 여기서 얻는
 *   문자열은 원래 계좌번호와 다른 값이다. 그 값을 해시해 봐야 "틀린 값의
 *   해시"이고, 대조도 복원도 되지 않으면서 개인정보 취급 대상만 하나 늘어난다.
 *   계좌 구분은 머리말의 마스킹된 뒤 4자리로 한다.
 */
/**
 * @param {ReturnType<import('../xlsx/workbook.mjs').readWorksheet>} sheet
 * @param {number} rowNumber
 * @param {Record<string, number>} columns
 */
function readRow(sheet, rowNumber, columns) {
  const ref = (key) => cellRef(rowNumber, columns[key]);

  const datetimeRef = ref('datetime');
  const datetimeText = requireText(sheet, datetimeRef, '거래 일시');
  const datetime = parseNaiveTimestamp(datetimeText);
  if (!datetime.ok) {
    throw new Error(`${datetimeRef}: 거래 일시가 "YYYY.MM.DD HH:mm:ss" 형식이 아닙니다.`);
  }

  const balanceRef = ref('balance');
  const balance = readOptionalInteger(sheet, balanceRef, '거래 후 잔액');

  return {
    sheetRow: rowNumber,
    datetime: datetime.value,
    description: optionalText(sheet, ref('description')),
    txnType: optionalText(sheet, ref('txnType')),
    institution: optionalText(sheet, ref('institution')),
    amount: readRequiredInteger(sheet, ref('amount'), '거래 금액'),
    // 잔액은 "없음"(null)과 "0"이 다르다. hasBalance 로 못을 박아 둔다.
    balance,
    hasBalance: balance !== null,
    balanceState: sheet.state(balanceRef),
    memo: optionalText(sheet, ref('memo')),
  };
}

// 파일에 적힌 순서를 그대로 두고, 관찰한 정렬 방향만 알려 준다. 같은 초에 여러
// 건이 있어서(충돌) 시각을 정렬 키로 쓰면 순서가 흔들린다 — 재정렬하지 않는다.
function describeOrder(rows) {
  let nonIncreasing = true;
  let nonDecreasing = true;
  let ties = 0;
  const collisionGroups = [];

  for (let i = 1; i < rows.length; i += 1) {
    const previous = rows[i - 1].datetime.iso;
    const current = rows[i].datetime.iso;
    if (current > previous) nonIncreasing = false;
    if (current < previous) nonDecreasing = false;
    if (current === previous) {
      ties += 1;
      const last = collisionGroups.at(-1);
      if (last && last.rows.at(-1) === rows[i - 1].sheetRow) last.rows.push(rows[i].sheetRow);
      else collisionGroups.push({ rows: [rows[i - 1].sheetRow, rows[i].sheetRow] });
    }
  }

  let direction = 'unsorted';
  if (nonIncreasing && nonDecreasing) direction = 'constant';
  else if (nonIncreasing) direction = 'descending';
  else if (nonDecreasing) direction = 'ascending';

  return { direction, strict: ties === 0 && direction !== 'constant', ties, collisionGroups };
}

/**
 * 시트 하나를 거래내역으로 읽는다.
 *
 * @param {ReturnType<import('../xlsx/workbook.mjs').readWorksheet>} sheet
 */
export function parseTossStatement(sheet) {
  const header = findHeaderRow(sheet);
  const block = readHeaderBlock(sheet, header.row);

  const rows = [];
  const lastRow = sheet.used?.maxRow ?? header.row;
  for (let rowNumber = header.row + 1; rowNumber <= lastRow; rowNumber += 1) {
    // 거래 일시 칸이 비면 표가 끝난 것으로 본다(토스 내역에 합계 행은 없다).
    if (sheet.state(cellRef(rowNumber, header.columns.datetime)) !== 'present') break;
    rows.push(readRow(sheet, rowNumber, header.columns));
  }

  if (rows.length === 0) {
    throw new Error(`${header.row + 1}행부터 거래 행이 하나도 없습니다.`);
  }

  return {
    sheetName: sheet.name,
    account: { last4: block.accountLast4 },
    period: block.period,
    jointAccount: block.jointAccount,
    holderCount: block.holderCount,
    headerRow: header.row,
    firstDataRow: rows[0].sheetRow,
    columns: header.columns,
    rows,
    order: describeOrder(rows),
    rowCap: block.rowCap,
    // 상한에 닿았으면 뒤가 잘렸을 수 있다. 조용히 넘기지 않고 올려 보낸다.
    truncationSuspected: block.rowCap !== null && rows.length >= block.rowCap,
  };
}

/**
 * 메모리에 올라온 xlsx 바이트 -> 거래내역.
 *
 * 수집 경로(Gmail -> 파싱 -> 저장)는 파일을 디스크에 쓰지 않는다. 그래서 런타임
 * 진입점은 Buffer 를 받는 이 함수다.
 *
 * @param {import('node:buffer').Buffer} buffer
 * @param {string|number} [sheet] 시트 이름 또는 순번(기본: 첫 시트)
 */
export function parseTossStatementBuffer(buffer, sheet = 0) {
  return parseTossStatement(openXlsx(buffer).sheet(sheet));
}
