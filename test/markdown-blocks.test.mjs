// lib/markdown/blocks.mjs — 가이드 탭의 마크다운 변환기.
//
// 문법마다 한 번씩 확인하고, 마지막에 실제 docs/year-end-tax-guide.md 가 변환기가 아는
// 문법만 쓰는지 본다. 가이드를 고치다가 표가 깨지거나 모르는 문법이 들어가면 여기서 걸린다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { inlineText, parseInline, parseMarkdown } from '../lib/markdown/blocks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('인라인: 굵게 · 코드 · 굵게 안의 코드, 짝 없는 기호는 글자 그대로', () => {
  assert.deepEqual(parseInline('가 **나** 다 `라`'), [
    { type: 'text', text: '가 ' },
    { type: 'strong', children: [{ type: 'text', text: '나' }] },
    { type: 'text', text: ' 다 ' },
    { type: 'code', text: '라' },
  ]);
  assert.deepEqual(parseInline('**`a` b**'), [
    { type: 'strong', children: [{ type: 'code', text: 'a' }, { type: 'text', text: ' b' }] },
  ]);
  assert.deepEqual(parseInline('2 ** 3 과 `짝 없음'), [{ type: 'text', text: '2 ** 3 과 `짝 없음' }]);
  assert.equal(inlineText(parseInline('**연말정산**이란 `x`')), '연말정산이란 x');
});

test('제목은 순서대로 id 를 받고, 문단은 여러 줄을 한 줄로 잇는다', () => {
  const blocks = parseMarkdown('# 제목\n\n## 1. 첫째\n줄 하나\n줄 둘\n\n### 소제목\n');
  assert.deepEqual(
    blocks.map((block) => block.type === 'heading' ? [block.level, block.id, block.text] : block.type),
    [[1, 'section-1', '제목'], [2, 'section-2', '1. 첫째'], 'paragraph', [3, 'section-3', '소제목']],
  );
  assert.equal(inlineText(blocks[2].inline), '줄 하나 줄 둘');
});

test('목록: 들여 쓴 다음 줄은 앞 항목에 이어 붙고, 번호 목록은 시작 번호를 지킨다', () => {
  const [bullets, numbers] = parseMarkdown('- 하나\n  이어짐\n- 둘\n\n3. 셋\n4. 넷\n');
  assert.equal(bullets.type, 'list');
  assert.equal(bullets.ordered, false);
  assert.deepEqual(bullets.items.map(inlineText), ['하나 이어짐', '둘']);
  assert.equal(numbers.ordered, true);
  assert.equal(numbers.start, 3);
  assert.deepEqual(numbers.items.map(inlineText), ['셋', '넷']);
});

test('표: 머리 줄 · 구분선 · 본문. 칸 수는 머리 줄에 맞춘다', () => {
  const [table] = parseMarkdown('| 가 | 나 |\n| --- | :---: |\n| 1 | **2** |\n| 3 |\n| 4 | 5 | 6 |\n');
  assert.equal(table.type, 'table');
  assert.deepEqual(table.header.map(inlineText), ['가', '나']);
  assert.deepEqual(table.rows.map((row) => row.map(inlineText)), [['1', '2'], ['3', ''], ['4', '5']]);
  assert.equal(table.rows[0][1][0].type, 'strong');
});

test('구분선 없이 | 로 시작하는 줄은 표가 아니라 문단이다', () => {
  const [block] = parseMarkdown('| 그냥 글자\n');
  assert.equal(block.type, 'paragraph');
});

test('코드 블록은 안의 마크다운을 해석하지 않는다. 닫는 ``` 가 없으면 끝까지', () => {
  const [code, after] = parseMarkdown('```\n# 제목 아님\n**굵게 아님**\n```\n뒤 문단\n');
  assert.deepEqual(code, { type: 'code', text: '# 제목 아님\n**굵게 아님**' });
  assert.equal(after.type, 'paragraph');
  assert.deepEqual(parseMarkdown('```\n열린 채'), [{ type: 'code', text: '열린 채' }]);
});

test('인용 안에서도 문단 · 목록을 해석하고, 구분선과 HTML 주석을 처리한다', () => {
  const blocks = parseMarkdown('<!-- 관리 메모\n**숨김** -->\n> 설명\n>\n> - 항목\n>   이어짐\n\n---\n');
  assert.deepEqual(blocks.map((block) => block.type), ['quote', 'hr']);
  const [paragraph, list] = blocks[0].blocks;
  assert.equal(inlineText(paragraph.inline), '설명');
  assert.deepEqual(list.items.map(inlineText), ['항목 이어짐']);
  assert.ok(!JSON.stringify(blocks).includes('숨김'));
});

test('원문의 < 는 글자로 남는다(태그로 해석하지 않는다)', () => {
  const [block] = parseMarkdown('<b>굵게</b> & <script>x</script>\n');
  assert.deepEqual(block, { type: 'paragraph', inline: [{ type: 'text', text: '<b>굵게</b> & <script>x</script>' }] });
});

test('CRLF 원문도 같은 결과', () => {
  assert.deepEqual(parseMarkdown('# a\r\n\r\n- b\r\n'), parseMarkdown('# a\n\n- b\n'));
});

test('실제 가이드 문서는 변환기가 아는 문법만 쓴다', () => {
  const source = readFileSync(path.join(ROOT, 'docs', 'year-end-tax-guide.md'), 'utf8');
  const blocks = parseMarkdown(source);
  const all = blocks.flatMap((block) => (block.type === 'quote' ? [block, ...block.blocks] : [block]));

  // 화면 제목이 되는 # 은 하나, 목차가 되는 ## 은 여러 개.
  const headings = all.filter((block) => block.type === 'heading');
  assert.equal(headings.filter((block) => block.level === 1).length, 1);
  assert.ok(headings.filter((block) => block.level === 2).length >= 5);
  assert.ok(all.some((block) => block.type === 'table'));

  // 해석되지 못한 블록 문법이 문단에 글자로 남아 있으면 안 된다.
  for (const block of all) {
    if (block.type !== 'paragraph') continue;
    const text = inlineText(block.inline);
    assert.doesNotMatch(text, /^(\||```|>|#)/, `해석되지 않은 블록: ${text.slice(0, 40)}`);
    assert.doesNotMatch(text, /\*\*|<!--|-->/, `해석되지 않은 인라인: ${text.slice(0, 40)}`);
  }

  // 표마다 모든 줄의 칸 수가 머리 줄과 같아야 한다. 변환기는 모자란 칸을 빈칸으로 채워
  // 조용히 넘어가므로, 원문의 칸 수가 틀린 것은 여기서 잡는다.
  const cellCount = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length;
  let header = 0;
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith('|')) {
      header = 0;
      continue;
    }
    if (header === 0) {
      header = cellCount(line);
      continue;
    }
    assert.equal(cellCount(line), header, `표 칸 수가 머리 줄과 다르다: ${line.slice(0, 40)}`);
  }
});
