// 마크다운 → 블록 트리. 연말정산 가이드 탭(app/tax/guide)이 docs/year-end-tax-guide.md 를
// 화면에 그릴 때 쓴다.
//
// ── 왜 직접 만드나 ──────────────────────────────────────────────────────────
//
// 가이드 한 파일을 보여 주려고 마크다운 패키지를 들이지 않는다(CLAUDE.md: npm 패키지
// 추가에 보수적으로). 가이드가 쓰는 문법만 처리한다:
//
//   제목(#~######) · 문단 · 목록(- / 1.) · 표 · 코드 블록(```) · 인용(>) · 구분선(---)
//   · 인라인 **굵게** · `코드` · HTML 주석(<!-- -->, 통째로 버린다 — 관리 메모용)
//
// 그 밖의 문법(링크 · 기울임 · 중첩 목록 · 이미지 · HTML 태그)은 해석하지 않고 글자
// 그대로 문단에 남는다. 가이드에 새 문법을 쓰려면 여기부터 늘린다.
// test/markdown-blocks.test.mjs 가 실제 가이드 파일이 이 범위 안에 있는지 확인한다.
//
// ── 출력 ────────────────────────────────────────────────────────────────────
//
// HTML 문자열을 만들지 않는다. 블록 · 인라인 노드의 배열만 돌려주고, 화면은 React 가
// 그린다. 그래서 원문에 `<` 가 섞여도 태그가 되지 않는다(이스케이프를 신경 쓸 곳이 없다).

/**
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'code', text: string }
 *   | { type: 'strong', children: Inline[] }} Inline
 *
 * @typedef {{ type: 'heading', level: number, id: string, text: string, inline: Inline[] }
 *   | { type: 'paragraph', inline: Inline[] }
 *   | { type: 'list', ordered: boolean, start: number, items: Inline[][] }
 *   | { type: 'table', header: Inline[][], rows: Inline[][][] }
 *   | { type: 'code', text: string }
 *   | { type: 'quote', blocks: Block[] }
 *   | { type: 'hr' }} Block
 */

const FENCE = /^```/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^>\s?/;
const BULLET = /^[-*]\s+(.*)$/;
const ORDERED = /^(\d+)\.\s+(.*)$/;
const TABLE_ROW = /^\|/;
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const CONTINUATION = /^\s+\S/;

const isBlank = (line) => line.trim() === '';

/** 표가 시작하는 줄인가: `|` 로 시작하고 다음 줄이 `| --- |` 구분선. */
function startsTable(lines, i) {
  return TABLE_ROW.test(lines[i]) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]);
}

/** 이 줄에서 문단이 아닌 다른 블록이 시작하는가. 문단은 여기서 끊긴다. */
function startsOtherBlock(lines, i) {
  const line = lines[i];
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    startsTable(lines, i)
  );
}

/**
 * 인라인 문법: `코드` 와 **굵게**. 굵게 안의 `코드` 도 처리한다.
 * 짝이 맞지 않는 `**` · `` ` `` 는 글자 그대로 둔다.
 *
 * @param {string} text
 * @returns {Inline[]}
 */
export function parseInline(text) {
  /** @type {Inline[]} */
  const nodes = [];
  const pattern = /`([^`]+)`|\*\*(.+?)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push({ type: 'text', text: text.slice(last, index) });
    if (match[1] !== undefined) nodes.push({ type: 'code', text: match[1] });
    else nodes.push({ type: 'strong', children: parseInline(match[2]) });
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes;
}

/** 인라인 노드에서 글자만 꺼낸다(목차 · 제목 id 용). */
export function inlineText(nodes) {
  return nodes.map((node) => (node.type === 'strong' ? inlineText(node.children) : node.text)).join('');
}

/** `| a | b |` → ['a', 'b']. 칸 안의 `|` 는 지원하지 않는다. */
function splitRow(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body.split('|').map((cell) => cell.trim());
}

/**
 * @param {string[]} lines
 * @param {{ next: number }} ids 제목 id 번호. 인용 안의 제목도 같은 번호를 이어 쓴다.
 * @returns {Block[]}
 */
function parseLines(lines, ids) {
  /** @type {Block[]} */
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 닫는 ``` (없으면 파일 끝까지가 코드다)
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const inline = parseInline(heading[2]);
      ids.next += 1;
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        id: `section-${ids.next}`,
        text: inlineText(inline),
        inline,
      });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(lines[i].replace(QUOTE, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', blocks: parseLines(body, ids) });
      continue;
    }

    if (startsTable(lines, i)) {
      const header = splitRow(line);
      i += 2; // 머리 줄 + 구분선
      const rows = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        const cells = splitRow(lines[i]);
        // 칸 수를 머리 줄에 맞춘다. 모자라면 빈칸, 넘치면 버린다.
        rows.push(header.map((_, column) => parseInline(cells[column] ?? '')));
        i += 1;
      }
      blocks.push({ type: 'table', header: header.map(parseInline), rows });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered);
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < lines.length) {
        const item = marker.exec(lines[i]);
        if (item) {
          items.push(item[isOrdered ? 2 : 1].trim());
        } else if (items.length > 0 && CONTINUATION.test(lines[i])) {
          // 들여 쓴 다음 줄은 앞 항목에 이어 붙인다.
          items[items.length - 1] += ` ${lines[i].trim()}`;
        } else {
          break;
        }
        i += 1;
      }
      blocks.push({
        type: 'list',
        ordered: isOrdered,
        start: ordered ? Number(ordered[1]) : 1,
        items: items.map(parseInline),
      });
      continue;
    }

    const body = [line.trim()];
    i += 1;
    while (i < lines.length && !isBlank(lines[i]) && !startsOtherBlock(lines, i)) {
      body.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', inline: parseInline(body.join(' ')) });
  }

  return blocks;
}

/**
 * @param {string} source 마크다운 원문
 * @returns {Block[]}
 */
export function parseMarkdown(source) {
  const text = source.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  return parseLines(text.split('\n'), { next: 0 });
}
