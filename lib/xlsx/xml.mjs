// xlsx 파트를 읽는 데 필요한 만큼의 XML 도구. 범용 파서가 아니다.
//
// SpreadsheetML 파트는 기계가 생성한 XML 이고 우리가 보는 요소는 정해져 있다.
// 필요한 것은 (1) 엔티티 디코딩 (2) 속성 읽기 (3) 특정 태그 훑기 뿐이라, 이
// 세 가지만 정확하게 만든다.

// 엔티티는 한 번에 하나의 정규식으로 처리한다. `&amp;lt;` 같은 입력을 두 번
// 치환하면 `<` 가 되어 버린다. 한 패스로 끝내야 그런 이중 디코딩이 없다.
const ENTITY = /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;

const NAMED = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

/**
 * XML 텍스트 노드/속성값의 엔티티를 디코딩한다.
 * @param {string} text
 * @returns {string}
 */
export function decodeXmlText(text) {
  if (!text.includes('&')) return text; // 흔한 경우의 지름길.
  return text.replace(ENTITY, (whole, dec, hex, named) => {
    if (dec !== undefined) return codePoint(Number.parseInt(dec, 10), whole);
    if (hex !== undefined) return codePoint(Number.parseInt(hex, 16), whole);
    return NAMED.get(named) ?? whole;
  });
}

function codePoint(value, whole) {
  // 범위를 벗어난 숫자 참조는 원문을 그대로 둔다. 던지지 않는다 — 셀 하나의
  // 표기 문제로 파일 전체 파싱을 중단시킬 이유가 없다.
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return whole;
  return String.fromCodePoint(value);
}

/**
 * 여는 태그 소스(`<c r="B9" s="4" t="s"`)에서 속성 하나를 읽는다.
 * @param {string} tagSource
 * @param {string} name
 * @returns {string|null}
 */
export function attr(tagSource, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tagSource);
  if (!match) return null;
  return decodeXmlText(match[2] ?? match[3] ?? '');
}

/**
 * 특정 태그를 문서 순서대로 훑는다. 빈 태그(`<row r="99"/>`)도 포함한다.
 *
 * 이 훑기는 여는 태그를 정규식으로 건너뛰며 찾기 때문에, 내용이 없는 태그가
 * 수백 개 있어도 비용이 거의 없다(fixture 의 빈 패딩 `<row>` 967 개).
 *
 * @param {string} xml
 * @param {string} tagName
 * @yields {{ source: string, inner: string|null }}
 */
export function* eachTag(xml, tagName) {
  const open = new RegExp(`<${tagName}(\\s[^>]*?)?(/?)>`, 'g');
  const close = `</${tagName}>`;
  let match;

  while ((match = open.exec(xml)) !== null) {
    const source = match[0];
    if (match[2] === '/') {
      yield { source, inner: null };
      continue;
    }
    const start = open.lastIndex;
    const end = xml.indexOf(close, start);
    if (end === -1) {
      throw new Error(`<${tagName}> 를 닫는 태그가 없습니다.`);
    }
    yield { source, inner: xml.slice(start, end) };
    open.lastIndex = end + close.length;
  }
}

/**
 * 태그 하나의 내용만 꺼낸다. 없으면 null.
 * @param {string} xml
 * @param {string} tagName
 * @returns {string|null}
 */
export function firstTagInner(xml, tagName) {
  for (const { inner } of eachTag(xml, tagName)) return inner;
  return null;
}

/**
 * `<t>` 들의 텍스트를 순서대로 이어 붙인다.
 *
 * - 공백을 다듬지 않는다. `xml:space="preserve"` 가 붙은 `<t>` 의 앞뒤 공백은
 *   데이터이고, 붙지 않은 `<t>` 를 다듬으면 두 경우가 구분되지 않는다.
 * - 후리가나(`<rPh>`)는 값이 아니라 발음 주석이므로 먼저 걷어낸다.
 *
 * @param {string} xml `<si>` 또는 `<is>` 의 내용
 * @returns {string}
 */
export function joinTextRuns(xml) {
  const withoutPhonetic = xml.includes('<rPh') ? xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '') : xml;
  let text = '';
  for (const { inner } of eachTag(withoutPhonetic, 't')) {
    if (inner !== null) text += decodeXmlText(inner);
  }
  return text;
}
