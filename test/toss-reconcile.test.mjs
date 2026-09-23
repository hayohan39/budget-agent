// 행 단위 잔액 검산 테스트.
//
//   잔액[n] - 잔액[n+1] == 금액[n]   (최신순)
//
// 파서가 한 행이라도 밀리거나 부호를 뒤집으면 여기서 드러난다. 그래서 이
// 검산은 파서 회귀 테스트로도 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openXlsxFile } from '../lib/xlsx/workbook.mjs';
import { parseTossStatement } from '../lib/toss/statement.mjs';
import { reconcileBalances } from '../lib/toss/reconcile.mjs';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'toss-sample-masked.xlsx',
);

function fixtureRows() {
  return parseTossStatement(openXlsxFile(FIXTURE).sheet(0)).rows;
}

test('fixture 는 21쌍이 맞고 불일치가 없다', () => {
  const result = reconcileBalances(fixtureRows());

  assert.equal(result.pairs, 23); // 24행이니 인접 쌍은 23개.
  assert.equal(result.checked, 21);
  assert.equal(result.matched, 21);
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.ok, true);
});

test('잔액이 없는 행이 끼는 두 쌍은 사유와 함께 건너뛴다', () => {
  const result = reconcileBalances(fixtureRows());

  assert.equal(result.skipped.length, 2);
  assert.deepEqual(
    result.skipped.map((pair) => [pair.sheetRow, pair.nextSheetRow, pair.reason]),
    [
      [17, 18, 'balance-missing'],
      [18, 19, 'balance-missing'],
    ],
  );
});

test('불일치는 던지지 않고 결과로 돌려준다 — 판단은 호출자 몫이다', () => {
  const rows = [
    { sheetRow: 10, amount: 1000, balance: 5000 }, // 5000 - 4000 = 1000  -> 일치
    { sheetRow: 11, amount: -500, balance: 4000 }, // 4000 - 4600 = -600 ≠ -500 -> 불일치
    { sheetRow: 12, amount: 300, balance: 4600 },
  ];

  const result = reconcileBalances(rows);

  assert.equal(result.ok, false);
  assert.equal(result.checked, 2);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.mismatches, [
    { index: 1, sheetRow: 11, nextSheetRow: 12, expected: -600, actual: -500, difference: -100 },
  ]);
});

test('잔액 0 은 건너뛰지 않는다 — falsy 라고 빼면 검산이 구멍난다', () => {
  const rows = [
    { sheetRow: 10, amount: -1000, balance: 0 },
    { sheetRow: 11, amount: 500, balance: 1000 },
  ];

  const result = reconcileBalances(rows);

  assert.equal(result.checked, 1);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.skipped, []);
});

test('행이 0~1개면 검산할 쌍이 없다', () => {
  assert.equal(reconcileBalances([]).pairs, 0);
  assert.equal(reconcileBalances([{ sheetRow: 10, amount: 1, balance: 1 }]).pairs, 0);
  assert.equal(reconcileBalances([]).ok, true);
});

test('파서를 거친 전체 흐름이 검산을 통과한다', () => {
  // 파싱 -> 검산까지 한 번에. 열이 밀리거나 부호가 뒤집히면 여기서 깨진다.
  const rows = fixtureRows();
  const result = reconcileBalances(rows);

  assert.equal(result.assumedOrder, 'newest-first');
  assert.equal(result.ok, true);
  assert.equal(result.checked + result.skipped.length, rows.length - 1);
});
