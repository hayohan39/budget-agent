// 정규화(파싱된 행 -> transactions 레코드) 테스트.
//
// 값은 마스킹된 fixture 의 것이고 실제 거래가 아니다(test/fixtures/README.md).
// 계좌 뒤 4자리도 전부 가짜다.
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openXlsxFile } from '../lib/xlsx/workbook.mjs';
import { parseNaiveTimestamp } from '../lib/toss/datetime.mjs';
import { parseTossStatement } from '../lib/toss/statement.mjs';
import {
  buildDedupeKey,
  isOwnAccountTransfer,
  KST_OFFSET,
  normalizeDescription,
  toKstTimestamp,
  toTransactionRecord,
  toTransactionRecords,
  toYearMonth,
} from '../lib/toss/normalize.mjs';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'toss-sample-masked.xlsx',
);

// fixture 머리말의 계좌는 `****-****-1288` 이다. 원본에서도 더미 값이었다.
const MAIN_LAST4 = '1288';

// 등록된 계좌 3개. 실제 계좌 뒤 4자리는 어떤 파일에도 적지 않는다.
const ACCOUNTS = Object.freeze([
  { id: 1, role: 'main', last4: MAIN_LAST4, nickname: '메인' },
  { id: 2, role: 'fixed', last4: '2222', nickname: '고정비' },
  { id: 3, role: 'emergency', last4: '3333', nickname: '비상금' },
]);

function parseFixture() {
  return parseTossStatement(openXlsxFile(FIXTURE).sheet(0));
}

function fixtureRecords(accounts = ACCOUNTS) {
  return toTransactionRecords(parseFixture(), accounts);
}

/** 파싱 결과와 같은 모양의 가짜 행 하나. 값은 전부 지어낸 것이다. */
function fakeRow(given = {}) {
  const {
    datetime = '2026.08.30 14:03:33',
    description = '적요값',
    txnType = '입금',
    institution = '',
    amount = 1000,
    balance = 2000,
    memo = '',
    sheetRow = 10,
  } = given;

  const parsed = parseNaiveTimestamp(datetime);
  assert.ok(parsed.ok, `테스트 입력의 거래 일시가 형식에 맞지 않는다: ${datetime}`);

  return {
    sheetRow,
    datetime: parsed.value,
    description,
    txnType,
    institution,
    amount,
    balance,
    hasBalance: balance !== null,
    memo,
  };
}

function record(given = {}, accounts = ACCOUNTS) {
  return toTransactionRecord(fakeRow(given), { accountLast4: MAIN_LAST4, accounts });
}

// ── 시각 ───────────────────────────────────────────────────────────────────

test('txn_at 에 +09:00 오프셋이 명시된다', () => {
  assert.equal(record().txn_at, `2026-08-30T14:03:33${KST_OFFSET}`);
  assert.ok(record().txn_at.endsWith('+09:00'));
  // Z 로 끝나면 UTC 로 해석된다 — 9시간 밀린 값이 저장된다.
  assert.ok(!record().txn_at.endsWith('Z'));
});

test('toKstTimestamp 는 한 자리 구성요소를 0 으로 채운다', () => {
  assert.equal(
    toKstTimestamp({ year: 2026, month: 9, day: 1, hour: 5, minute: 0, second: 7 }),
    '2026-09-01T05:00:07+09:00',
  );
});

test('월초 새벽 거래의 year_month 가 전월로 밀리지 않는다', () => {
  // `2026-09-01T05:00:00+09:00` 는 UTC 로 `2026-08-31T20:00:00Z` 다.
  // Date 를 거쳐 UTC 의 연·월을 읽는 구현은 여기서 `2026-08` 을 내놓는다.
  const at2026_09_01 = record({ datetime: '2026.09.01 05:00:00' });

  assert.equal(at2026_09_01.year_month, '2026-09');
  assert.equal(at2026_09_01.txn_at, '2026-09-01T05:00:00+09:00');

  // 대조군: UTC 로 읽었을 때 실제로 달라지는 값인지 확인한다. 이 단정이
  // 깨지면 위 테스트가 아무것도 지키지 않는다는 뜻이다.
  assert.equal(new Date(at2026_09_01.txn_at).getUTCMonth() + 1, 8);
});

test('실행 환경의 시간대를 바꿔도 year_month 와 txn_at 이 흔들리지 않는다', (t) => {
  // CI 컨테이너도 Vercel 함수도 UTC 다. 시간대를 바꿔 보지 않으면 "UTC 로
  // 읽어서 월초 거래가 전월로 밀리는" 버그가 초록불로 지나간다.
  const original = process.env.TZ;

  const setZone = (zone) => {
    process.env.TZ = zone;
    // 이 환경에서 TZ 전환이 실제로 먹는지 확인용으로 함께 돌려준다.
    return new Date(Date.UTC(2026, 8, 1)).getHours();
  };

  try {
    const seoulHour = setZone('Asia/Seoul');
    const seoul = record({ datetime: '2026.09.01 05:00:00' });

    const losAngelesHour = setZone('America/Los_Angeles');
    const losAngeles = record({ datetime: '2026.09.01 05:00:00' });

    const utcHour = setZone('UTC');
    const utc = record({ datetime: '2026.09.01 05:00:00' });

    // 전환이 먹지 않는 환경이라면 이 테스트는 아무것도 지키지 않으면서
    // 통과한다. 그럴 때는 통과시키지 말고 건너뛴 것으로 표시한다.
    if (seoulHour === losAngelesHour && seoulHour === utcHour) {
      t.skip('이 환경은 실행 중 TZ 전환이 적용되지 않아 검증이 성립하지 않는다');
      return;
    }

    for (const [zone, value] of [
      ['Asia/Seoul', seoul],
      ['America/Los_Angeles', losAngeles],
      ['UTC', utc],
    ]) {
      assert.equal(value.year_month, '2026-09', `${zone} 에서 year_month 가 밀렸다`);
      assert.equal(value.txn_at, '2026-09-01T05:00:00+09:00', `${zone} 에서 txn_at 이 밀렸다`);
      assert.equal(value.dedupe_key, seoul.dedupe_key, `${zone} 에서 dedupe_key 가 달라졌다`);
    }

    // 월말도 같은 이유로 확인한다(반대 방향으로 밀리는 경우).
    assert.equal(record({ datetime: '2026.08.31 23:59:59' }).year_month, '2026-08');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('year_month 는 원본 문자열의 연·월 그대로다', () => {
  assert.equal(toYearMonth({ year: 2026, month: 1 }), '2026-01');
  assert.equal(toYearMonth({ year: 2026, month: 12 }), '2026-12');
  // CHAR(7) 이고 CHECK 제약이 `^[0-9]{4}-[0-9]{2}$` 다.
  assert.match(toYearMonth({ year: 2026, month: 9 }), /^[0-9]{4}-[0-9]{2}$/);
});

// ── dedupe_key ─────────────────────────────────────────────────────────────

test('dedupe_key 는 같은 입력에 대해 항상 같다', () => {
  const first = fixtureRecords().map((r) => r.dedupe_key);
  const second = fixtureRecords().map((r) => r.dedupe_key);

  assert.deepEqual(second, first);
  // sha256 hex 64자.
  for (const key of first) assert.match(key, /^[0-9a-f]{64}$/);
});

test('같은 초·같은 금액인 28·29행의 dedupe_key 가 다르다', () => {
  // fixture 28·29행: 둘 다 `2026.08.02 09:12:48`, 둘 다 -500,000.
  // 시각+금액만으로 키를 만들면 여기서 충돌한다.
  const rows = parseFixture().rows;
  const row28 = rows.find((row) => row.sheetRow === 28);
  const row29 = rows.find((row) => row.sheetRow === 29);

  assert.ok(row28 && row29);
  assert.equal(row28.datetime.iso, row29.datetime.iso);
  assert.equal(row28.amount, row29.amount);

  const key28 = toTransactionRecord(row28, { accountLast4: MAIN_LAST4, accounts: ACCOUNTS });
  const key29 = toTransactionRecord(row29, { accountLast4: MAIN_LAST4, accounts: ACCOUNTS });
  assert.notEqual(key28.dedupe_key, key29.dedupe_key);
});

test('dedupe_key 에 적요가 평문으로 들어가지 않는다', () => {
  // 키는 로그·URL·에러 메시지에 섞여 나가기 쉬운 값이다. 거래 내용이 그대로
  // 읽히면 안 된다.
  for (const row of parseFixture().rows) {
    const key = toTransactionRecord(row, {
      accountLast4: MAIN_LAST4,
      accounts: ACCOUNTS,
    }).dedupe_key;
    assert.ok(!key.includes(row.description), `적요가 키에 그대로 들어갔다(${row.sheetRow}행)`);
  }

  // 16진수만 나오므로 애초에 한글이 들어갈 수 없다. 구현이 접두사를 붙이는
  // 식으로 바뀌어도 여기서 걸린다.
  const key = record({ description: '비밀스러운적요' }).dedupe_key;
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes('비밀스러운적요'));
});

test('잔액이 없는 서로 다른 두 행은 서로 다른 dedupe_key 를 받는다', () => {
  // fixture 의 H18 처럼 `거래 후 잔액` 칸이 통째로 빠진 행이 실제로 있다.
  // 잔액이 두 행을 가르던 역할을 못 하게 되므로, 나머지 필드가 그 자리를 메운다.
  const base = { datetime: '2026.08.14 10:53:16', amount: 3500000, balance: null };

  // 적요만 다르다.
  assert.notEqual(
    record({ ...base, description: '김철수' }).dedupe_key,
    record({ ...base, description: '이영희' }).dedupe_key,
  );
  // 메모만 다르다.
  assert.notEqual(
    record({ ...base, memo: '곰돌이 월급' }).dedupe_key,
    record({ ...base, memo: '곰돌이 상여' }).dedupe_key,
  );
  // 거래 기관만 다르다.
  assert.notEqual(
    record({ ...base, institution: '우리은행' }).dedupe_key,
    record({ ...base, institution: 'KB국민은행' }).dedupe_key,
  );
  // 그래도 같은 행을 다시 읽으면 같은 키다.
  assert.equal(record({ ...base }).dedupe_key, record({ ...base }).dedupe_key);
});

test('잔액 없음은 잔액 0 과 다른 키가 된다', () => {
  // fixture 의 H19 는 진짜 잔액 0 이다. 결손을 0 으로 채우면 두 행이 겹친다.
  const base = { datetime: '2026.08.12 19:05:39', amount: -1901314, description: '현대카드' };
  assert.notEqual(record({ ...base, balance: 0 }).dedupe_key, record({ ...base, balance: null }).dedupe_key);
});

test('잔액이 있는 행의 키는 메모 변경에 흔들리지 않는다', () => {
  // 메모는 사용자가 앱에서 고칠 수 있는 값이다. 잔액이 있으면 그것만으로
  // 충분히 구분되므로 메모를 키에 넣지 않는다 — 넣으면 메모를 고친 달을
  // 재수집할 때 같은 거래가 두 번 저장된다.
  const base = { datetime: '2026.08.05 11:45:12', amount: -170000, balance: 1901314 };
  assert.equal(
    record({ ...base, memo: '경주 숙박비' }).dedupe_key,
    record({ ...base, memo: '' }).dedupe_key,
  );
});

test('적요의 사소한 공백 차이는 같은 키를 만든다', () => {
  const key = record({ description: '고정비 계좌' }).dedupe_key;
  assert.equal(record({ description: '  고정비 계좌  ' }).dedupe_key, key);
  assert.equal(record({ description: '고정비  계좌' }).dedupe_key, key);
  // 비분리 공백(U+00A0)도 마찬가지다.
  assert.equal(record({ description: '고정비 계좌' }).dedupe_key, key);
});

test('계좌가 다르면 같은 거래도 다른 키가 된다', () => {
  const mine = record();
  const theirs = buildDedupeKey({
    last4: '2222',
    iso: '2026-08-30T14:03:33',
    amount: 1000,
    balance: 2000,
    description: '적요값',
  });
  assert.notEqual(mine.dedupe_key, theirs);
});

test('normalizeDescription 은 앞뒤를 떼고 사이 공백을 하나로 만든다', () => {
  assert.equal(normalizeDescription('  가  나\t다\n라 '), '가 나 다 라');
  assert.equal(normalizeDescription(''), '');
  assert.equal(normalizeDescription(undefined), '');
  assert.equal(normalizeDescription(null), '');
});

// ── fixture 전체 ───────────────────────────────────────────────────────────

test('fixture 전체가 24개 레코드와 24개의 서로 다른 dedupe_key 가 된다', () => {
  const records = fixtureRecords();

  assert.equal(records.length, 24);
  assert.equal(new Set(records.map((r) => r.dedupe_key)).size, 24);
  // 전부 같은 계좌·같은 달이다.
  assert.deepEqual([...new Set(records.map((r) => r.account_id))], [1]);
  assert.deepEqual([...new Set(records.map((r) => r.year_month))], ['2026-08']);
  // 파일에 적힌 순서(최신순)를 유지한다 — 재정렬하면 같은 초 행들이 흔들린다.
  assert.equal(records[0].txn_at, '2026-08-30T14:03:33+09:00');
  assert.equal(records.at(-1).txn_at, '2026-08-01T03:33:28+09:00');
});

test('모든 레코드의 cp_acct_hash 가 null 이다', () => {
  // 원본 `계좌번호` 열은 숫자 셀이라 앞자리 0 이 구조적으로 사라진다. 파서가
  // 읽지 않기로 했고, 여기서도 채우지 않는다.
  for (const value of fixtureRecords()) {
    assert.equal(value.cp_acct_hash, null);
  }
});

test('category 는 전부 null 이다 — 분류는 다음 단계다', () => {
  for (const value of fixtureRecords()) assert.equal(value.category, null);
});

test('잔액이 빠진 행은 balance 가 null 이고 0 이 아니다', () => {
  const missing = fixtureRecords().filter((r) => r.balance === null);
  assert.equal(missing.length, 1); // H18
  assert.equal(missing[0].txn_at, '2026-08-14T10:53:16+09:00');

  // 진짜 0 인 행은 그대로 0 이다.
  const zero = fixtureRecords().filter((r) => r.balance === 0);
  assert.equal(zero.length, 1); // H19
});

test('빈 거래 기관·메모는 빈 문자열이 아니라 null 이 된다', () => {
  const records = fixtureRecords();
  assert.ok(records.some((r) => r.institution === null));
  assert.ok(records.some((r) => r.memo === null));
  assert.ok(!records.some((r) => r.institution === ''));
  assert.ok(!records.some((r) => r.memo === ''));
  // description 과 txn_type 은 NOT NULL 이라 null 이 되면 안 된다.
  for (const value of records) {
    assert.equal(typeof value.description, 'string');
    assert.equal(typeof value.txn_type, 'string');
  }
});

// ── is_transfer ────────────────────────────────────────────────────────────

test('내 계좌 간 이동만 is_transfer 로 표시된다', () => {
  const transfers = fixtureRecords().filter((r) => r.is_transfer);

  assert.deepEqual(
    transfers.map((r) => r.description).sort(),
    ['고정비 계좌', '비상금 계좌'],
  );
  // 금액은 상계하지 않는다. 현금흐름표에서 이 돈은 유출로 계상된다.
  assert.deepEqual(transfers.map((r) => r.amount).sort((a, b) => a - b), [-1000000, -500000]);
});

test('시드 규칙과 같은 띄어쓰기 변형을 받아들인다', () => {
  // `비상금 ?계좌` · `고정비 ?계좌` — 공백이 있어도 없어도 매칭된다.
  for (const description of ['비상금 계좌', '비상금계좌', '고정비 계좌', '고정비계좌']) {
    assert.equal(record({ description }).is_transfer, true, description);
  }
  for (const description of ['김철수', '통장 이자', '삼성카드주식회사', '계좌']) {
    assert.equal(record({ description }).is_transfer, false, description);
  }
});

test('해당 계좌가 등록돼 있지 않으면 is_transfer 를 세우지 않는다', () => {
  // 메인 계좌 하나만 등록된 상태. 상대 계좌가 없으면 내 계좌 간 이동이 아니다.
  const onlyMain = [ACCOUNTS[0]];
  assert.equal(record({ description: '고정비 계좌' }, onlyMain).is_transfer, false);
  assert.equal(record({ description: '비상금 계좌' }, onlyMain).is_transfer, false);
});

test('자기 자신으로의 이동은 is_transfer 가 아니다', () => {
  const asFixed = [{ id: 2, role: 'fixed', last4: MAIN_LAST4, nickname: '고정비' }];
  assert.equal(
    isOwnAccountTransfer('고정비 계좌', asFixed, 2),
    false,
    '같은 계좌 안의 이동은 있을 수 없다',
  );
});

// ── 계좌 해석 ──────────────────────────────────────────────────────────────

test('등록되지 않은 뒤 4자리면 던진다', () => {
  const statement = parseFixture();
  const others = [{ id: 9, role: 'main', last4: '7777', nickname: '메인' }];

  assert.throws(
    () => toTransactionRecords(statement, others),
    (error) => {
      assert.match(error.message, /등록되지 않은 계좌/);
      // 어느 계좌인지는 알려 줘야 고칠 수 있다. 뒤 4자리는 이미 accounts 에
      // 들어 있는 값이라 새는 것이 없다.
      assert.ok(error.message.includes(MAIN_LAST4));
      return true;
    },
  );
});

test('계좌를 못 찾으면 레코드를 하나도 만들지 않는다', () => {
  // 절반만 만들어 놓고 던지면 호출자가 부분 결과를 저장할 여지가 생긴다.
  const statement = parseFixture();
  assert.throws(() => toTransactionRecords(statement, []), /등록되지 않은 계좌/);
});

test('금액·잔액이 안전한 정수가 아니면 던진다', () => {
  for (const amount of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1000']) {
    assert.throws(() => record({ amount }), /거래 금액/, `amount=${String(amount)}`);
  }
  for (const balance of [1.5, Number.NaN, 2 ** 53]) {
    assert.throws(() => record({ balance }), /거래 후 잔액/, `balance=${String(balance)}`);
  }
});

// ── 보안 성질: 오류 메시지에 값이 새지 않는다 ───────────────────────────────

test('오류 메시지에 적요나 금액 값이 포함되지 않는다', () => {
  // 적요와 금액은 거래 내용 그 자체다. 검증에 걸린 값을 메시지에 되비추면
  // 그 메시지가 로그로 흘러 들어간다. 누군가 넣기 시작하면 여기서 깨지게 둔다.
  const description = '비밀상호명주식회사';
  const memo = '민감한메모내용';
  const institution = '비밀은행';

  const cases = [
    {
      label: '등록되지 않은 계좌',
      run: () =>
        toTransactionRecord(fakeRow({ description, memo, institution, amount: 1234567 }), {
          accountLast4: '9999',
          accounts: ACCOUNTS,
        }),
    },
    {
      label: '정수가 아닌 금액',
      run: () => record({ description, memo, institution, amount: 1234567.89 }),
    },
    {
      label: '정수가 아닌 잔액',
      run: () => record({ description, memo, institution, balance: 7654321.12 }),
    },
    {
      label: '안전 범위를 넘는 금액',
      run: () => record({ description, memo, institution, amount: 2 ** 53 }),
    },
  ];

  for (const { label, run } of cases) {
    assert.throws(
      run,
      (error) => {
        for (const [what, value] of [
          ['적요', description],
          ['메모', memo],
          ['거래 기관', institution],
          ['금액', '1234567'],
          ['잔액', '7654321'],
        ]) {
          assert.ok(
            !error.message.includes(value),
            `${label}: 오류 메시지에 ${what} 값이 새어 나왔다`,
          );
        }
        return true;
      },
      label,
    );
  }
});

test('행 오류 메시지는 행 번호와 필드 이름만 말한다', () => {
  assert.throws(
    () => toTransactionRecord(fakeRow({ sheetRow: 18, amount: 0.5 }), {
      accountLast4: MAIN_LAST4,
      accounts: ACCOUNTS,
    }),
    /18행: 거래 금액/,
  );
});
