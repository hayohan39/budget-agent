// xlsx 셀 리더 테스트.
//
// fixture 에 없는 표현(inlineStr · 여러 런 · xml:space · 사용자 숫자 서식)은
// 작은 XML 조각을 직접 만들어서 확인한다. 토스가 아닌 도구가 내보낸 파일에서
// 실제로 나오는 형태들이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cellRef,
  columnToIndex,
  indexToColumn,
  openXlsxFile,
  readSharedStrings,
  readStyles,
  readWorkbookSheets,
  readWorksheet,
} from '../lib/xlsx/workbook.mjs';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'toss-sample-masked.xlsx',
);

function sheetXml(cells, extra = '') {
  return `<worksheet><sheetData>${cells}</sheetData>${extra}</worksheet>`;
}

// ── 셀 참조 ────────────────────────────────────────────────────────────────

test('열 문자와 열 번호를 서로 변환한다', () => {
  assert.equal(columnToIndex('A'), 1);
  assert.equal(columnToIndex('H'), 8);
  assert.equal(columnToIndex('AA'), 27);
  assert.equal(indexToColumn(1), 'A');
  assert.equal(indexToColumn(27), 'AA');
  assert.equal(indexToColumn(702), 'ZZ');
  assert.equal(cellRef(19, 8), 'H19');
});

// ── 공유 문자열 ────────────────────────────────────────────────────────────

test('공유 문자열의 XML 엔티티를 디코딩한다', () => {
  const strings = readSharedStrings(
    '<sst><si><t>a&amp;b</t></si><si><t>&lt;tag&gt;</t></si>' +
      '<si><t>&quot;큰따옴표&quot; &apos;작은따옴표&apos;</t></si>' +
      '<si><t>&#65;&#x42;&#44032;</t></si>' +
      '<si><t>&amp;lt; 는 두 번 디코딩하면 안 된다</t></si></sst>',
  );

  assert.deepEqual(strings, [
    'a&b',
    '<tag>',
    '"큰따옴표" \'작은따옴표\'',
    'AB가',
    '&lt; 는 두 번 디코딩하면 안 된다',
  ]);
});

test('xml:space="preserve" 가 붙은 앞뒤 공백을 지우지 않는다', () => {
  const strings = readSharedStrings(
    '<sst><si><t xml:space="preserve"> 앞뒤 공백 </t></si><si><t xml:space="preserve">   </t></si></sst>',
  );

  assert.deepEqual(strings, [' 앞뒤 공백 ', '   ']);
});

test('런이 여러 개인 <si> 는 이어 붙여 한 문자열로 읽는다', () => {
  // 서식이 섞이면 한 문자열이 <r><t> 여러 개로 쪼개진다. 사람 눈에는 한 값이다.
  const strings = readSharedStrings(
    '<sst><si><r><rPr><b/></rPr><t xml:space="preserve">거래 </t></r>' +
      '<r><t>금액</t></r></si>' +
      // 후리가나(<rPh>)는 값이 아니라 발음 주석이라 값에 섞이면 안 된다.
      '<si><r><t>카드</t></r><rPh sb="0" eb="2"><t>かーど</t></rPh></si></sst>',
  );

  assert.deepEqual(strings, ['거래 금액', '카드']);
});

test('빈 <si> 와 빈 <t> 는 빈 문자열이 된다 — 없는 값과 구분된다', () => {
  const strings = readSharedStrings('<sst><si><t></t></si><si/><si><t>값</t></si></sst>');

  assert.deepEqual(strings, ['', '', '값']);
  assert.equal(strings.length, 3);
});

test('공유 문자열 인덱스가 범위를 벗어나면 셀 참조와 함께 거부한다', () => {
  assert.throws(
    () => readWorksheet(sheetXml('<c r="B2" t="s"><v>7</v></c>'), { sharedStrings: ['하나'] }),
    /B2: 공유 문자열 인덱스/,
  );
});

// ── 스타일 ─────────────────────────────────────────────────────────────────

test('cellXfs 인덱스별 numFmtId 를 읽는다', () => {
  // cellXfs 가 아예 없는 styles.xml 도 빈 목록으로 조용히 넘어간다.
  assert.deepEqual(readStyles('<styleSheet/>').cellXfs, []);

  const styles = openXlsxFile(FIXTURE).styles;
  assert.equal(styles.cellXfs.length, 8);
  // 금액·잔액 셀이 쓰는 style 6 만 숫자 서식(#,##0 = 내장 3번)을 갖는다.
  assert.equal(styles.cellXfs[6].numFmtId, 3);
  assert.equal(styles.cellXfs[5].numFmtId, 0);
});

test('164 이상 사용자 서식은 formatCode 까지 붙여 준다', () => {
  // 내장 서식은 번호만 있고 코드가 없다. 164 부터는 파일 안에 정의가 들어온다.
  const styles = readStyles(
    '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy&quot;년&quot;mm&quot;월&quot;"/></numFmts>' +
      '<cellStyleXfs count="1"><xf numFmtId="99"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
  );

  // cellStyleXfs 의 <xf> 는 섞여 들어오면 안 된다.
  assert.equal(styles.cellXfs.length, 2);
  assert.deepEqual(styles.cellXfs[1], { numFmtId: 164, formatCode: 'yyyy"년"mm"월"' });
  assert.equal(styles.numberFormats.get(164), 'yyyy"년"mm"월"');
});

// ── 워크북 · 시트 경로 ─────────────────────────────────────────────────────

test('시트 파트 경로를 rels 로 풀어 준다 — sheet1.xml 이라고 가정하지 않는다', () => {
  const sheets = readWorkbookSheets(
    '<workbook><sheets>' +
      '<sheet state="visible" name="두번째" sheetId="2" r:id="rId9"/>' +
      '<sheet name="첫번째" sheetId="1" r:id="rId4"/>' +
      '</sheets></workbook>',
    '<Relationships>' +
      '<Relationship Id="rId4" Target="worksheets/이름이 다른 시트.xml"/>' +
      '<Relationship Id="rId9" Target="/xl/worksheets/odd.xml"/>' +
      '</Relationships>',
  );

  // 문서 순서를 지킨다(sheetId 순이 아니다).
  assert.deepEqual(
    sheets.map((sheet) => [sheet.name, sheet.part]),
    [
      ['두번째', 'xl/worksheets/odd.xml'],
      ['첫번째', 'xl/worksheets/이름이 다른 시트.xml'],
    ],
  );
});

test('시트 이름과 파트 경로를 fixture 에서 읽는다', () => {
  const workbook = openXlsxFile(FIXTURE);

  assert.deepEqual(workbook.sheetNames, ['토스뱅크 거래내역']);
  assert.equal(workbook.sheets[0].part, 'xl/worksheets/sheet1.xml');
  assert.throws(() => workbook.sheet('없는 시트'), /시트를 찾지 못했습니다/);
});

// ── 워크시트 ───────────────────────────────────────────────────────────────

test('셀은 위치가 아니라 r= 참조로 색인된다', () => {
  // 가운데 열이 통째로 빠진 행. 순서대로 세면 G 가 F 자리로 밀린다.
  const sheet = readWorksheet(sheetXml('<c r="E12" t="s"><v>0</v></c><c r="G12"><v>1045850.0</v></c>'), {
    sharedStrings: [''],
  });

  assert.equal(sheet.state('F12'), 'absent');
  assert.equal(sheet.raw('G12'), '1045850.0');
  assert.equal(sheet.cell('G12').column, 'G');
  assert.equal(sheet.cell('G12').columnIndex, 7);
});

test('<dimension> 이 없으면 실제 셀에서 사용 범위를 만든다', () => {
  const sheet = openXlsxFile(FIXTURE).sheet(0);

  assert.equal(sheet.declaredDimension, null);
  assert.deepEqual(sheet.used, { minRow: 1, maxRow: 33, minColumn: 2, maxColumn: 9, ref: 'B1:I33' });
  // <row> 가 998 개 있지만 값이 든 셀은 203 개뿐이다. 빈 패딩 행은 세지 않는다.
  assert.equal(sheet.cells.size, 203);
});

test('병합 셀 목록과 병합 앵커를 돌려준다', () => {
  const sheet = openXlsxFile(FIXTURE).sheet(0);

  assert.deepEqual(
    sheet.merges.map((merge) => merge.ref),
    ['B1:F1', 'C2:F2', 'C3:F3', 'C4:F4', 'B6:F6', 'B7:F7'],
  );
  // 병합 범위 안의 빈 칸을 물어도 값이 실제로 든 좌상단을 가리킨다.
  assert.equal(sheet.mergeAnchor('E3'), 'C3');
  assert.equal(sheet.mergeAnchor('C3'), 'C3');
  assert.equal(sheet.mergeAnchor('H10'), 'H10'); // 병합 밖은 그대로.
});

test('빈 셀 세 종류를 구분한다', () => {
  const sheet = openXlsxFile(FIXTURE).sheet(0);

  // 1) 셀은 있는데 값 엘리먼트가 없다: <c r="F32" s="7"/>
  assert.equal(sheet.state('F32'), 'blank');
  assert.notEqual(sheet.cell('F32'), undefined);
  assert.equal(sheet.cell('F32').raw, null);
  assert.equal(sheet.value('F32'), undefined);

  // 2) 셀 엘리먼트 자체가 없다.
  for (const ref of ['F12', 'F14', 'F16', 'F19', 'F33', 'H18']) {
    assert.equal(sheet.state(ref), 'absent', `${ref} 는 셀이 없어야 한다`);
    assert.equal(sheet.cell(ref), undefined, `${ref}`);
  }

  // 3) 값이 빈 문자열이다 — 이것은 "값이 있는" 셀이다.
  assert.equal(sheet.state('I10'), 'present');
  assert.equal(sheet.value('I10'), '');
  assert.equal(sheet.cell('I10').kind, 'shared');
});

test('숫자 셀은 해석값과 원문을 함께 들고 온다', () => {
  const sheet = openXlsxFile(FIXTURE).sheet(0);

  // `.0` 접미사와 지수 표기는 값을 정수로 옮길 때 필요한 정보다. 지워 버리면
  // 위층에서 되살릴 수 없다.
  assert.equal(sheet.raw('G10'), '34000.0');
  assert.equal(sheet.value('G10'), 34000);
  assert.equal(sheet.raw('F15'), '1.2341234E7');
  assert.equal(sheet.cell('F15').type, null); // t 속성 없음 = 숫자
  assert.equal(sheet.cell('G10').styleIndex, 6);
});

test('t="str" · t="inlineStr" · t="b" · t="e" 를 각각 해석한다', () => {
  const sheet = readWorksheet(
    sheetXml(
      '<c r="A1" t="str"><v>수식 결과</v></c>' +
        '<c r="A2" t="inlineStr"><is><r><t xml:space="preserve">인라인 </t></r><r><t>문자열</t></r></is></c>' +
        '<c r="A3" t="b"><v>1</v></c>' +
        '<c r="A4" t="b"><v>0</v></c>' +
        '<c r="A5" t="e"><v>#N/A</v></c>',
    ),
  );

  assert.equal(sheet.value('A1'), '수식 결과');
  assert.equal(sheet.cell('A1').kind, 'string');
  assert.equal(sheet.value('A2'), '인라인 문자열');
  assert.equal(sheet.cell('A2').kind, 'inline');
  assert.equal(sheet.value('A3'), true);
  assert.equal(sheet.value('A4'), false);
  // 오류 셀은 표식으로 올라온다 — 진짜 텍스트 "#N/A" 와 섞이지 않는다.
  assert.equal(sheet.cell('A5').kind, 'error');
  assert.deepEqual(sheet.value('A5'), { xlsxError: '#N/A' });
});

test('값 없이 수식만 든 셀은 blank 로 본다', () => {
  const sheet = readWorksheet(sheetXml('<c r="A1"><f>SUM(B1:B2)</f></c>'));

  assert.equal(sheet.state('A1'), 'blank');
  assert.equal(sheet.value('A1'), undefined);
});

test('r= 가 없는 셀은 받지 않는다', () => {
  assert.throws(() => readWorksheet(sheetXml('<c t="s"><v>0</v></c>')), /r= 가 없는 셀/);
});

test('한 행의 셀을 열 순서로 준다 — 빈 자리를 메우지 않는다', () => {
  const sheet = openXlsxFile(FIXTURE).sheet(0);

  const row12 = sheet.row(12);
  assert.deepEqual(
    row12.map((cell) => cell.ref),
    ['B12', 'C12', 'D12', 'E12', 'G12', 'H12', 'I12'],
  );
  assert.deepEqual(
    sheet.row(9).map((cell) => cell.value),
    ['거래 일시', '적요', '거래 유형', '거래 기관', '계좌번호', '거래 금액', '거래 후 잔액', '메모'],
  );
});
