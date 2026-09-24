// 토스뱅크 거래내역 파서 테스트.
//
// 값은 마스킹된 fixture 의 것이고 실제 거래가 아니다(test/fixtures/README.md).
// 오류 경로는 작은 시트를 직접 만들어서 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { indexToColumn, openXlsxFile, readWorksheet } from '../lib/xlsx/workbook.mjs';
import { parseNaiveTimestamp } from '../lib/toss/datetime.mjs';
import { findHeaderRow, parseTossStatement, TOSS_HEADERS } from '../lib/toss/statement.mjs';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'toss-sample-masked.xlsx',
);

function fixtureSheet() {
  return openXlsxFile(FIXTURE).sheet(0);
}

function parseFixture() {
  return parseTossStatement(fixtureSheet());
}

// ── 직접 만드는 시트 ───────────────────────────────────────────────────────
// 표의 모양만 같고 값은 전부 가짜다. 오류 경로를 정확히 겨누려고 쓴다.

function text(ref, value) {
  return `<c r="${ref}" t="str"><v>${value}</v></c>`;
}

function number(ref, raw) {
  return `<c r="${ref}"><v>${raw}</v></c>`;
}

function buildStatementXml(options = {}) {
  const {
    account = '****-****-9999',
    period = '2026.08.01 - 2026.08.31',
    holder = '가상이름',
    headers = TOSS_HEADERS,
    rows = [{}],
  } = options;

  const cells = [
    text('B2', '성명'),
    text('C2', holder),
    text('B3', '계좌번호'),
    text('C3', account),
    text('B4', '조회기간'),
    text('C4', period),
    text('B6', '※ 거래내역은 10만 개까지만 표시됩니다.'),
    ...headers.map((header, offset) => text(`${indexToColumn(2 + offset)}8`, header)),
  ];

  rows.forEach((row, index) => {
    const rowNumber = 9 + index;
    const {
      datetime = '2026.08.30 14:03:33',
      description = '적요값',
      txnType = '입금',
      institution = '',
      amount = '1000.0',
      balance = '2000.0',
      memo = '',
    } = row;

    cells.push(text(`B${rowNumber}`, datetime));
    cells.push(text(`C${rowNumber}`, description));
    cells.push(text(`D${rowNumber}`, txnType));
    cells.push(text(`E${rowNumber}`, institution));
    if (amount !== null) cells.push(number(`G${rowNumber}`, amount));
    if (balance !== null) cells.push(number(`H${rowNumber}`, balance));
    cells.push(text(`I${rowNumber}`, memo));
  });

  return `<worksheet><sheetData>${cells.join('')}</sheetData></worksheet>`;
}

function buildStatement(options) {
  return parseTossStatement(readWorksheet(buildStatementXml(options)));
}

// ── 헤더 행 찾기 ───────────────────────────────────────────────────────────

test('헤더 행을 위치가 아니라 8개 헤더 나열로 찾는다', () => {
  const sheet = fixtureSheet();
  const header = findHeaderRow(sheet);

  assert.equal(header.row, 9);
  assert.equal(header.firstColumn, 2); // B 열에서 시작한다(A 는 여백).
  assert.deepEqual(header.columns, {
    datetime: 2,
    description: 3,
    txnType: 4,
    institution: 5,
    counterpartyAccount: 6,
    amount: 7,
    balance: 8,
    memo: 9,
  });
});

test('한 칸만 보고 찾았다면 머리말 블록을 헤더로 잘못 잡았을 것이다', () => {
  const sheet = fixtureSheet();

  // `계좌번호` 는 머리말 라벨(3행)과 표 헤더(9행)에 모두 나오고, 같은 공유
  // 문자열을 가리킨다. 한 칸 매칭은 위에 있는 3행에 먼저 걸린다.
  const singleCellHits = [...sheet.cells.values()]
    .filter((cell) => cell.value === '계좌번호')
    .map((cell) => cell.ref)
    .sort();
  assert.deepEqual(singleCellHits, ['B3', 'F9']);

  // 그래서 8개 나열로 찾는다 — 3행이 아니라 9행이 나온다.
  assert.equal(findHeaderRow(sheet).row, 9);
});

test('헤더가 하나라도 어긋나면 헤더 행을 찾지 못했다고 던진다', () => {
  const headers = [...TOSS_HEADERS];
  headers[6] = '거래후 잔액'; // 공백 하나 차이.

  assert.throws(() => buildStatement({ headers }), /헤더/);
});

test('머리말 줄 수가 달라도 헤더 행을 찾아낸다', () => {
  // 직접 만든 시트는 헤더가 8행이다(fixture 는 9행). 행 번호를 박지 않았다는 확인.
  assert.equal(buildStatement().headerRow, 8);
});

// ── 머리말 블록 ────────────────────────────────────────────────────────────

test('마스킹된 계좌번호에서 뒤 4자리를 뽑는다', () => {
  const statement = parseFixture();

  // 1288 은 fixture 의 더미 값이다(원본에서도 실제 계좌번호가 아니었다 —
  // test/fixtures/README.md). 실제 계좌 뒤 4자리는 어떤 파일에도 적지 않는다.
  assert.equal(statement.account.last4, '1288');
  // 뒤 4자리 말고 계좌번호 비슷한 것은 아무것도 돌려주지 않는다.
  assert.deepEqual(Object.keys(statement.account), ['last4']);
});

test('마스킹 형식이 아니면 추측하지 않고 던진다', () => {
  for (const account of ['1234-5678-9012', '****-****-12', '****-****-12345', '계좌번호 없음', '']) {
    assert.throws(() => buildStatement({ account }), /마스킹 형식/, JSON.stringify(account));
  }
});

test('조회기간을 시작일·종료일로 돌려준다', () => {
  const { period } = parseFixture();

  assert.equal(period.raw, '2026.08.01 - 2026.08.31');
  assert.deepEqual(period.from, { year: 2026, month: 8, day: 1, iso: '2026-08-01' });
  assert.deepEqual(period.to, { year: 2026, month: 8, day: 31, iso: '2026-08-31' });
});

test('조회기간 형식이 다르거나 없는 날짜면 던진다', () => {
  assert.throws(() => buildStatement({ period: '2026-08-01 ~ 2026-08-31' }), /조회기간/);
  assert.throws(() => buildStatement({ period: '2026.02.30 - 2026.03.01' }), /달력에 없는/);
});

test('모임통장은 `외 N인` 접미사로 알아내고 이름은 돌려주지 않는다', () => {
  const statement = parseFixture();

  assert.equal(statement.jointAccount, true);
  assert.equal(statement.holderCount, 2);
  // 성명 값은 결과 어디에도 담기지 않는다 — 저장할 컬럼도 없고 쓸 데도 없다.
  const serialized = JSON.stringify(statement);
  assert.ok(!serialized.includes('외 1인'), '성명 값이 결과에 섞여 나왔다');
  assert.ok(!('holderName' in statement), '성명을 담는 키가 있다');
  assert.equal(typeof statement.holderCount, 'number'); // 사람 수만 남는다.
});

test('표시 상한 각주를 읽고 잘림 의심 여부를 알려 준다', () => {
  const statement = parseFixture();

  assert.equal(statement.rowCap, 100000);
  assert.equal(statement.truncationSuspected, false);
});

// ── 데이터 행 ──────────────────────────────────────────────────────────────

test('데이터 24건을 파일 순서 그대로 읽는다', () => {
  const statement = parseFixture();

  assert.equal(statement.rows.length, 24);
  assert.equal(statement.firstDataRow, 10);
  assert.deepEqual(
    statement.rows.map((row) => row.sheetRow),
    Array.from({ length: 24 }, (unused, index) => 10 + index),
  );
});

test('거래 일시를 시간대 없이 구성요소로 읽는다', () => {
  const [first] = parseFixture().rows;

  assert.deepEqual(first.datetime, {
    year: 2026,
    month: 8,
    day: 30,
    hour: 14,
    minute: 3,
    second: 33,
    iso: '2026-08-30T14:03:33',
    raw: '2026.08.30 14:03:33',
  });
  // 오프셋도 Z 도 붙지 않는다. 붙는 순간 읽는 쪽이 UTC 로 해석해 버린다.
  assert.ok(!first.datetime.iso.endsWith('Z'));
});

test('실행 환경의 시간대를 바꿔도 거래 일시가 흔들리지 않는다', (t) => {
  // 이 프로젝트에서 가장 조용한 버그: 파싱을 new Date 로 흘리면 값이 실행
  // 환경의 시간대로 해석된다. Vercel 함수는 UTC, 노트북은 KST 라서 월초·월말
  // 거래의 "달"이 바뀌고, 월별 현금흐름표가 틀린 채로 검산을 통과한다.
  // CI 컨테이너도 UTC 라서 시간대를 바꿔 보지 않으면 이 버그는 초록불로 지나간다.
  const original = process.env.TZ;

  const setZone = (zone) => {
    process.env.TZ = zone;
    // 이 환경에서 TZ 전환이 실제로 먹는지 확인용으로 함께 돌려준다.
    return new Date(Date.UTC(2026, 7, 1)).getHours();
  };

  try {
    const seoulHour = setZone('Asia/Seoul');
    const seoul = parseFixture().rows.map((row) => row.datetime.iso);

    const losAngelesHour = setZone('America/Los_Angeles');
    const losAngeles = parseFixture().rows.map((row) => row.datetime.iso);

    // 전환이 먹지 않는 환경이라면 이 테스트는 아무것도 지키지 않으면서
    // 통과한다. 그럴 때는 통과시키지 말고 건너뛴 것으로 표시한다.
    if (seoulHour === losAngelesHour) {
      t.skip('이 환경은 실행 중 TZ 전환이 적용되지 않아 검증이 성립하지 않는다');
      return;
    }

    assert.deepEqual(losAngeles, seoul);
    // 월 경계에 걸린 행(8월 1일 새벽 03:33)이 7월로 밀리지 않는다.
    assert.equal(seoul.at(-1), '2026-08-01T03:33:28');
    assert.equal(losAngeles.at(-1), '2026-08-01T03:33:28');
    // 구성요소도 그대로다 — iso 문자열만 맞추고 속을 바꾸는 구현을 막는다.
    assert.deepEqual(parseFixture().rows.at(-1).datetime, {
      year: 2026,
      month: 8,
      day: 1,
      hour: 3,
      minute: 33,
      second: 28,
      iso: '2026-08-01T03:33:28',
      raw: '2026.08.01 03:33:28',
    });
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('거래 일시 형식이 정확히 맞지 않으면 거부한다', () => {
  const rejected = [
    '2026-08-30 14:03:33', // 구분자가 다르다
    '2026.08.30 14:03', // 초가 없다
    '2026.8.30 14:03:33', // 0 채움이 없다
    '2026.08.30T14:03:33', // 구분자가 T
    '2026.08.30 14:03:33 KST', // 시간대가 붙었다
    '2026.13.01 00:00:00', // 없는 달
    '2026.02.30 00:00:00', // 없는 날
    '2026.08.30 24:00:00', // 24시
  ];

  for (const datetime of rejected) {
    assert.throws(() => buildStatement({ rows: [{ datetime }] }), /거래 일시/, datetime);
  }
  // 정상값은 통과한다.
  assert.equal(parseNaiveTimestamp('2026.08.30 14:03:33').ok, true);
});

test('금액은 부호 있는 정수로 읽는다', () => {
  const rows = parseFixture().rows;
  const amountOf = (sheetRow) => rows.find((row) => row.sheetRow === sheetRow).amount;

  assert.equal(amountOf(13), -2858322); // 출금(음수)
  assert.equal(amountOf(33), 263); // 작은 입금
  assert.equal(amountOf(10), 34000); // `34000.0` -> 정수 34000
  assert.ok(Number.isInteger(amountOf(10)));
  for (const row of rows) {
    assert.ok(Number.isSafeInteger(row.amount), `${row.sheetRow}행 금액이 정수가 아니다`);
  }
});

test('금액이 없거나 정수가 아니면 셀 참조와 함께 거부한다', () => {
  assert.throws(() => buildStatement({ rows: [{ amount: null }] }), /G9: 거래 금액이\(가\) 비어 있습니다/);
  assert.throws(() => buildStatement({ rows: [{ amount: '12.5' }] }), /G9: 거래 금액 정수가 아닙니다/);
});

test('잔액 0 은 진짜 0 이다 — 없는 값이 아니다', () => {
  const row = parseFixture().rows.find((candidate) => candidate.sheetRow === 19);

  assert.equal(row.balance, 0);
  assert.equal(row.hasBalance, true);
  assert.equal(row.balanceState, 'present');
  assert.notEqual(row.balance, null);
});

test('잔액 셀이 아예 없는 행은 0 이 아니라 "없음"으로 올라온다', () => {
  const row = parseFixture().rows.find((candidate) => candidate.sheetRow === 18);

  assert.equal(row.balance, null);
  assert.equal(row.hasBalance, false);
  assert.equal(row.balanceState, 'absent');
  // 이 행에도 금액은 있다. 잔액만 빠진 것이다.
  assert.equal(row.amount, 3500000);
});

test('빈 셀 세 종류가 행 값에서 구분된 채로 올라온다', () => {
  const sheet = fixtureSheet();
  const statement = parseTossStatement(sheet);
  const rowOf = (sheetRow) => statement.rows.find((row) => row.sheetRow === sheetRow);

  // 1) 값이 빈 문자열인 셀(거래 기관) — 셀도 값도 있다.
  assert.equal(sheet.state('E12'), 'present');
  assert.equal(rowOf(12).institution, '');
  // 2) 셀 엘리먼트가 없는 자리(F12) 와 3) 값 없는 셀(F32) 은 시트에서 구분된다.
  assert.equal(sheet.state('F12'), 'absent');
  assert.equal(sheet.state('F32'), 'blank');
  assert.notEqual(sheet.state('F12'), sheet.state('F32'));
  // 메모는 대체로 빈 문자열이고, 적힌 행도 있다.
  assert.equal(rowOf(10).memo, '');
  assert.notEqual(rowOf(18).memo, '');
});

test('같은 초에 든 거래 묶음 4개가 순서 그대로 남는다', () => {
  const statement = parseFixture();

  assert.equal(statement.order.direction, 'descending');
  assert.equal(statement.order.strict, false, '충돌이 있으므로 엄격한 내림차순이 아니다');
  assert.equal(statement.order.collisionGroups.length, 4);
  assert.deepEqual(
    statement.order.collisionGroups.map((group) => group.rows),
    [
      [23, 24],
      [25, 26, 27],
      [28, 29],
      [30, 31],
    ],
  );

  // 묶음 안의 행이 합쳐지거나(dedupe) 자리를 바꾸지 않는다.
  const group = statement.rows.filter((row) => [25, 26, 27].includes(row.sheetRow));
  assert.equal(group.length, 3);
  assert.deepEqual(new Set(group.map((row) => row.datetime.iso)), new Set(['2026-08-03T09:13:57']));
  assert.deepEqual(
    group.map((row) => row.amount),
    [-1000000, -1000000, -350000],
  );
});

// ── 보안 성질 ──────────────────────────────────────────────────────────────

test('상대방 계좌번호 열은 결과에 담기지 않는다', () => {
  const sheet = fixtureSheet();
  const statement = parseTossStatement(sheet);

  // 시트에는 분명히 값이 있다 — 못 읽는 것이 아니라 읽지 않기로 한 것이다.
  assert.equal(sheet.raw('F15'), '1.2341234E7');

  const serialized = JSON.stringify(statement);
  for (const leaked of ['1.2341234E7', '12341234']) {
    assert.ok(!serialized.includes(leaked), `계좌번호 열 값이 결과에 섞여 나왔다`);
  }
  for (const row of statement.rows) {
    const keys = Object.keys(row);
    assert.ok(!keys.some((key) => /account|계좌/i.test(key)), '행에 계좌 관련 키가 있다');
    assert.equal(keys.length, 10);
  }
});

test('오류 메시지에 셀 값이 들어가지 않는다', () => {
  // CI 로그·런타임 로그는 영구 저장된다. 검증에 걸린 값을 메시지에 되비추면
  // 거래 내역이 그대로 로그에 남는다. 값 대신 셀 참조와 사유만 남긴다.
  const cases = [
    { label: '계좌번호', value: '1234-5678-9012', build: (value) => buildStatement({ account: value }) },
    { label: '조회기간', value: '2026/08/01 ~ 2026/08/31', build: (value) => buildStatement({ period: value }) },
    {
      label: '거래 일시',
      value: '2026-08-30 14:03:33',
      build: (value) => buildStatement({ rows: [{ datetime: value }] }),
    },
    {
      label: '거래 금액',
      value: '12.5',
      build: (value) => buildStatement({ rows: [{ amount: value }] }),
    },
    {
      label: '거래 후 잔액',
      value: '9007199254740993',
      build: (value) => buildStatement({ rows: [{ balance: value }] }),
    },
    {
      label: '적요',
      value: '적요에 들어간 사람 이름',
      build: (value) => buildStatement({ rows: [{ description: value, amount: 'not-a-number' }] }),
    },
  ];

  for (const { label, value, build } of cases) {
    assert.throws(
      () => build(value),
      (error) => {
        assert.ok(!error.message.includes(value), `${label} 오류 메시지에 값이 새어 나왔다`);
        // 대신 어느 셀인지는 알려 줘야 고칠 수 있다.
        assert.match(error.message, /[A-Z]+[0-9]+|머리말/, `${label} 오류가 위치를 알려주지 않는다`);
        return true;
      },
      label,
    );
  }
});
