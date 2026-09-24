// xlsx(SpreadsheetML) 에서 파서가 필요한 부분만 꺼낸다.
//
// 값을 "정리"하지 않는 것이 이 모듈의 목적이다. 원본 `<v>` 문자열과 셀 타입을
// 그대로 들고 올라가야 위층에서 문자열 날짜 · 지수 표기 숫자 · 세 종류의 빈 셀을
// 구분할 수 있다.
import { openZip, openZipFile } from './zip.mjs';
import { attr, decodeXmlText, eachTag, firstTagInner, joinTextRuns } from './xml.mjs';

const CELL_REF = /^([A-Z]+)([0-9]+)$/;

/** 열 문자(A, B, ... AA) -> 1부터 시작하는 열 번호. */
export function columnToIndex(letters) {
  let index = 0;
  for (let i = 0; i < letters.length; i += 1) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index;
}

/** 1부터 시작하는 열 번호 -> 열 문자. */
export function indexToColumn(index) {
  let rest = index;
  let letters = '';
  while (rest > 0) {
    const remainder = (rest - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    rest = (rest - remainder - 1) / 26;
  }
  return letters;
}

/** 열 번호 · 행 번호 -> 셀 참조(`"B10"`). */
export function cellRef(rowNumber, columnIndex) {
  return `${indexToColumn(columnIndex)}${rowNumber}`;
}

function parseRef(ref) {
  const match = CELL_REF.exec(ref);
  if (!match) throw new Error(`셀 참조 형식이 올바르지 않습니다: ${ref}`);
  return { column: match[1], columnIndex: columnToIndex(match[1]), row: Number(match[2]) };
}

// ── sharedStrings ──────────────────────────────────────────────────────────

/**
 * `xl/sharedStrings.xml` -> 문자열 배열.
 *
 * `<si>` 하나가 문자열 하나다. 서식이 섞이면 `<r><t>` 런이 여러 개로 쪼개지는데,
 * 사람 눈에는 한 문자열이므로 이어 붙인다.
 *
 * @param {string} xml
 * @returns {string[]}
 */
export function readSharedStrings(xml) {
  const strings = [];
  for (const { inner } of eachTag(xml, 'si')) {
    strings.push(inner === null ? '' : joinTextRuns(inner));
  }
  return strings;
}

// ── styles ─────────────────────────────────────────────────────────────────

/**
 * `xl/styles.xml` -> cellXfs 인덱스별 표시 형식.
 *
 * 셀의 `s=` 는 cellXfs 의 인덱스다. 거기서 numFmtId 를 얻고, 164 이상이면
 * `<numFmts>` 에 정의된 사용자 서식이므로 formatCode 를 함께 붙인다.
 *
 * @param {string} xml
 * @returns {{ numberFormats: Map<number, string>, cellXfs: Array<{ numFmtId: number, formatCode: string|null }> }}
 */
export function readStyles(xml) {
  const numberFormats = new Map();
  const numFmtsBlock = firstTagInner(xml, 'numFmts');
  if (numFmtsBlock) {
    for (const { source } of eachTag(numFmtsBlock, 'numFmt')) {
      const id = Number(attr(source, 'numFmtId'));
      const code = attr(source, 'formatCode');
      if (Number.isInteger(id) && code !== null) numberFormats.set(id, code);
    }
  }

  // cellStyleXfs 에도 `<xf>` 가 있다. 셀이 가리키는 것은 cellXfs 뿐이므로
  // 그 블록만 잘라서 본다.
  const cellXfs = [];
  const cellXfsBlock = firstTagInner(xml, 'cellXfs');
  if (cellXfsBlock) {
    for (const { source } of eachTag(cellXfsBlock, 'xf')) {
      const numFmtId = Number(attr(source, 'numFmtId') ?? '0');
      cellXfs.push({
        numFmtId: Number.isInteger(numFmtId) ? numFmtId : 0,
        formatCode: numberFormats.get(numFmtId) ?? null,
      });
    }
  }

  return { numberFormats, cellXfs };
}

// ── workbook + rels ────────────────────────────────────────────────────────

// ZIP 엔트리 이름은 언제나 `/` 로 구분된다. 파일 시스템 경로가 아니므로
// path.join 을 쓰면 안 된다 — Windows 에서 `\` 가 섞여 엔트리를 못 찾는다.
function resolveZipPath(basePart, target) {
  if (target.startsWith('/')) return target.slice(1);

  const baseDirectory = basePart.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') baseDirectory.pop();
    else baseDirectory.push(segment);
  }
  return baseDirectory.join('/');
}

/**
 * `xl/workbook.xml` + rels -> 시트 이름과 파트 경로(문서 순서).
 * 시트 파트 이름이 `sheet1.xml` 이라고 가정하지 않는다.
 *
 * @param {string} workbookXml
 * @param {string} relsXml
 * @param {string} workbookPart
 */
export function readWorkbookSheets(workbookXml, relsXml, workbookPart = 'xl/workbook.xml') {
  const targets = new Map();
  for (const { source } of eachTag(relsXml, 'Relationship')) {
    const id = attr(source, 'Id');
    const target = attr(source, 'Target');
    if (id && target) targets.set(id, target);
  }

  const sheets = [];
  const sheetsBlock = firstTagInner(workbookXml, 'sheets');
  if (!sheetsBlock) throw new Error('workbook.xml 에 <sheets> 가 없습니다.');

  for (const { source } of eachTag(sheetsBlock, 'sheet')) {
    const name = attr(source, 'name');
    const relationshipId = attr(source, 'r:id') ?? attr(source, 'id');
    if (!name || !relationshipId) continue;

    const target = targets.get(relationshipId);
    if (!target) throw new Error(`시트 관계를 찾지 못했습니다: ${relationshipId}`);

    sheets.push({
      name,
      sheetId: attr(source, 'sheetId'),
      state: attr(source, 'state') ?? 'visible',
      part: resolveZipPath(workbookPart, target),
    });
  }

  if (sheets.length === 0) throw new Error('workbook.xml 에 시트가 없습니다.');
  return sheets;
}

// ── worksheet ──────────────────────────────────────────────────────────────

/**
 * 셀 하나.
 *
 * @typedef {object} Cell
 * @property {string} ref 셀 참조(`"H19"`). 위치가 아니라 이 값이 셀의 정체다.
 * @property {number} row 행 번호(1부터)
 * @property {string} column 열 문자(`"H"`)
 * @property {number} columnIndex 열 번호(1부터)
 * @property {string|null} type `t` 속성. 없으면 null(= 숫자)
 * @property {number|null} styleIndex `s` 속성(cellXfs 인덱스)
 * @property {string|null} raw `<v>` 원문. 값 엘리먼트가 없으면 null
 * @property {string|number|boolean|{xlsxError: string}|null} value 해석된 값
 * @property {'number'|'shared'|'string'|'inline'|'boolean'|'error'|'blank'} kind
 */

function resolveValue(cell, sharedStrings) {
  switch (cell.type) {
    case 's': {
      // 공유 문자열 테이블 인덱스. 여기만은 정수로 읽어야 한다.
      const index = Number(cell.raw);
      if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) {
        throw new Error(`${cell.ref}: 공유 문자열 인덱스가 범위를 벗어났습니다.`);
      }
      return { kind: 'shared', value: sharedStrings[index] };
    }
    case 'str':
      return { kind: 'string', value: cell.raw ?? '' };
    case 'b':
      return { kind: 'boolean', value: cell.raw === '1' };
    case 'e':
      // 오류 셀은 값이 아니라 표식으로 올린다. 문자열로 올리면 위층에서 진짜
      // 텍스트와 섞인다.
      return { kind: 'error', value: Object.freeze({ xlsxError: cell.raw ?? '' }) };
    default:
      // 타입 속성이 없으면 숫자다. raw 문자열을 반드시 함께 들고 간다
      // (`34000.0`, `1.2341234E7` 처럼 표기가 값을 결정한다).
      return { kind: 'number', value: Number(cell.raw) };
  }
}

function readCell(source, inner, sharedStrings) {
  const ref = attr(source, 'r');
  if (!ref) throw new Error('r= 가 없는 셀이 있습니다. 위치로 셀을 세지 않습니다.');

  const { row, column, columnIndex } = parseRef(ref);
  const styleAttribute = attr(source, 's');
  const cell = {
    ref,
    row,
    column,
    columnIndex,
    type: attr(source, 't'),
    styleIndex: styleAttribute === null ? null : Number(styleAttribute),
    raw: null,
    value: null,
    kind: 'blank',
  };

  if (inner === null || inner === '') return cell; // `<c r="F32" s="7"/>` — 셀은 있고 값이 없다.

  if (cell.type === 'inlineStr') {
    const is = firstTagInner(inner, 'is');
    if (is === null) return cell;
    cell.raw = null;
    cell.value = joinTextRuns(is);
    cell.kind = 'inline';
    return cell;
  }

  const rawValue = firstTagInner(inner, 'v');
  if (rawValue === null) return cell; // `<c ...><f>..</f></c>` 처럼 값이 아직 없는 셀.

  cell.raw = decodeXmlText(rawValue);
  const resolved = resolveValue(cell, sharedStrings);
  cell.kind = resolved.kind;
  cell.value = resolved.value;
  return cell;
}

/**
 * 워크시트 파트 -> 셀 사전.
 *
 * 셀은 언제나 `r=` 참조로 색인한다. 행 안의 순서로 세면 빠진 셀이 있는 순간
 * 열이 통째로 밀린다(이 fixture 는 실제로 F 열이 빠진 행이 있다).
 *
 * @param {string} xml
 * @param {{ sharedStrings?: string[], styles?: ReturnType<typeof readStyles>, name?: string, part?: string }} context
 */
export function readWorksheet(xml, context = {}) {
  const sharedStrings = context.sharedStrings ?? [];
  const styles = context.styles ?? { numberFormats: new Map(), cellXfs: [] };

  const sheetData = firstTagInner(xml, 'sheetData') ?? '';
  const cells = new Map();

  // `<row>` 를 거치지 않고 `<c>` 만 훑는다. 값 없는 패딩 행 수백 개는 여는 태그
  // 하나씩만 스캔되고 끝난다.
  for (const { source, inner } of eachTag(sheetData, 'c')) {
    const cell = readCell(source, inner, sharedStrings);
    cells.set(cell.ref, cell);
  }

  const merges = [];
  const mergeBlock = firstTagInner(xml, 'mergeCells');
  if (mergeBlock) {
    for (const { source } of eachTag(mergeBlock, 'mergeCell')) {
      const ref = attr(source, 'ref');
      if (!ref) continue;
      const [from, to] = ref.split(':');
      merges.push({ ref, anchor: from, from: parseRef(from), to: parseRef(to ?? from) });
    }
  }

  // `<dimension>` 은 없을 수 있다(이 fixture 에 없다). 있어도 믿지 않고 실제
  // 셀에서 사용 범위를 만든다.
  let minRow = Infinity;
  let maxRow = 0;
  let minColumn = Infinity;
  let maxColumn = 0;
  for (const cell of cells.values()) {
    if (cell.row < minRow) minRow = cell.row;
    if (cell.row > maxRow) maxRow = cell.row;
    if (cell.columnIndex < minColumn) minColumn = cell.columnIndex;
    if (cell.columnIndex > maxColumn) maxColumn = cell.columnIndex;
  }
  const used =
    cells.size === 0
      ? null
      : { minRow, maxRow, minColumn, maxColumn, ref: `${cellRef(minRow, minColumn)}:${cellRef(maxRow, maxColumn)}` };

  const declaredDimension = (() => {
    for (const { source } of eachTag(xml, 'dimension')) return attr(source, 'ref');
    return null;
  })();

  return {
    name: context.name ?? null,
    part: context.part ?? null,
    cells,
    merges,
    used,
    declaredDimension,
    styles,

    /** 셀 객체. 없으면 undefined(= 셀 엘리먼트 자체가 없음). */
    cell(ref) {
      return cells.get(ref);
    },

    /**
     * 빈 셀 세 종류를 구분한다.
     *  - `'absent'`  셀 엘리먼트가 없다
     *  - `'blank'`   셀은 있는데 값 엘리먼트가 없다
     *  - `'present'` 값이 있다(빈 문자열도 값이다)
     */
    state(ref) {
      const cell = cells.get(ref);
      if (!cell) return 'absent';
      return cell.kind === 'blank' ? 'blank' : 'present';
    },

    /** 해석된 값. 셀이 없거나 값이 없으면 undefined. */
    value(ref) {
      const cell = cells.get(ref);
      if (!cell || cell.kind === 'blank') return undefined;
      return cell.value;
    },

    /** `<v>` 원문. 숫자 표기를 잃지 않으려면 이쪽을 쓴다. */
    raw(ref) {
      return cells.get(ref)?.raw ?? null;
    },

    /** 셀이 병합 범위 안에 있으면 값이 실제로 들어 있는 좌상단 참조를 준다. */
    mergeAnchor(ref) {
      const { row, columnIndex } = parseRef(ref);
      for (const merge of merges) {
        if (
          row >= merge.from.row &&
          row <= merge.to.row &&
          columnIndex >= merge.from.columnIndex &&
          columnIndex <= merge.to.columnIndex
        ) {
          return merge.anchor;
        }
      }
      return ref;
    },

    /** 한 행의 셀을 열 순서로. 없는 셀은 건너뛴다(자리를 메우지 않는다). */
    row(rowNumber) {
      const found = [];
      for (const cell of cells.values()) {
        if (cell.row === rowNumber) found.push(cell);
      }
      return found.sort((a, b) => a.columnIndex - b.columnIndex);
    },
  };
}

// ── 워크북 ─────────────────────────────────────────────────────────────────

const WORKBOOK_PART = 'xl/workbook.xml';
const WORKBOOK_RELS_PART = 'xl/_rels/workbook.xml.rels';

/**
 * 열린 ZIP -> 워크북. 시트는 요청할 때 파싱한다.
 * @param {ReturnType<typeof openZip>} zip
 */
export function readWorkbook(zip) {
  if (!zip.has(WORKBOOK_PART)) {
    throw new Error('xl/workbook.xml 이 없습니다. xlsx 파일이 아닙니다.');
  }

  const sharedStrings = zip.has('xl/sharedStrings.xml')
    ? readSharedStrings(zip.readText('xl/sharedStrings.xml'))
    : [];
  const styles = zip.has('xl/styles.xml')
    ? readStyles(zip.readText('xl/styles.xml'))
    : { numberFormats: new Map(), cellXfs: [] };

  const relsXml = zip.has(WORKBOOK_RELS_PART) ? zip.readText(WORKBOOK_RELS_PART) : '';
  const sheets = readWorkbookSheets(zip.readText(WORKBOOK_PART), relsXml, WORKBOOK_PART);
  const parsed = new Map();

  return {
    sharedStrings,
    styles,
    sheets,
    sheetNames: sheets.map((sheet) => sheet.name),

    /**
     * 시트를 이름 또는 0부터 시작하는 순번으로 가져온다.
     * @param {string|number} [nameOrIndex]
     */
    sheet(nameOrIndex = 0) {
      const found =
        typeof nameOrIndex === 'number'
          ? sheets[nameOrIndex]
          : sheets.find((sheet) => sheet.name === nameOrIndex);
      if (!found) throw new Error(`시트를 찾지 못했습니다: ${String(nameOrIndex)}`);

      const cached = parsed.get(found.part);
      if (cached) return cached;

      const sheet = readWorksheet(zip.readText(found.part), {
        sharedStrings,
        styles,
        name: found.name,
        part: found.part,
      });
      parsed.set(found.part, sheet);
      return sheet;
    },
  };
}

/** 메모리에 있는 xlsx 바이트를 연다. */
export function openXlsx(buffer) {
  return readWorkbook(openZip(buffer));
}

/** 파일에서 xlsx 를 연다(테스트·스크립트용. 런타임 수집 경로는 메모리만 쓴다). */
export function openXlsxFile(filePath) {
  return readWorkbook(openZipFile(filePath));
}
