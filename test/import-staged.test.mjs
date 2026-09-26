// 업로드 화면의 "적용 뒤 담아 둔 목록" 계산(lib/import/staged.mjs) 테스트.
//
// 보내서 성공한 파일만 빠지고, 실패한 파일은 체크된 채 남고, 보내지 않은
// 파일은 손대지 않는다는 것을 못 박는다. React 도 DB 도 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { nextStagedAfterApply } from '../lib/import/staged.mjs';

/** 화면의 Staged 와 같은 모양의 가짜 항목. 미리보기 결과는 표식만 둔다. */
function item(key, selected) {
  return { key, selected, preview: { status: 'ok', data: { marker: key } } };
}

const ok = (key) => ({ key, outcome: { ok: true } });
const fail = (key) => ({
  key,
  outcome: { ok: false, failure: { code: 'http500', message: '실패' } },
});

test('전부 성공 + 체크하지 않은 파일 하나: 보내지 않은 파일은 그대로 남는다', () => {
  const a = item('a', true);
  const b = item('b', true);
  const c = item('c', false);
  const next = nextStagedAfterApply([a, b, c], ['a', 'b'], [ok('a'), ok('b')]);
  assert.deepEqual(next.map((x) => x.key), ['c']);
  // 미리보기 결과 · 체크 상태를 포함해 같은 객체 그대로다.
  assert.equal(next[0], c);
});

test('일부 실패 + 체크하지 않은 파일 하나: 실패는 체크된 채, 미체크는 그대로', () => {
  const a = item('a', true);
  const b = item('b', true);
  const c = item('c', false);
  const next = nextStagedAfterApply([a, b, c], ['a', 'b'], [ok('a'), fail('b')]);
  assert.deepEqual(next.map((x) => x.key), ['b', 'c']);
  assert.equal(next[0].selected, true);
  assert.deepEqual(next[0].preview, b.preview);
  assert.equal(next[1], c);
  assert.equal(next[1].selected, false);
});

test('전부 실패: 아무것도 빠지지 않고 보낸 파일은 모두 체크된 채 남는다', () => {
  const a = item('a', true);
  const b = item('b', true);
  const c = item('c', false);
  const next = nextStagedAfterApply([a, b, c], ['a', 'b'], [fail('a'), fail('b')]);
  assert.deepEqual(next.map((x) => x.key), ['a', 'b', 'c']);
  assert.deepEqual(next.map((x) => x.selected), [true, true, false]);
  assert.equal(next[2], c);
});

test('아무것도 체크하지 않음: 목록이 그대로다', () => {
  const list = [item('a', false), item('b', false)];
  const next = nextStagedAfterApply(list, [], []);
  assert.equal(next.length, 2);
  assert.equal(next[0], list[0]);
  assert.equal(next[1], list[1]);
});

test('보내지 않은 파일의 결과가 섞여 와도 그 파일은 건드리지 않는다', () => {
  const a = item('a', true);
  const c = item('c', false);
  const next = nextStagedAfterApply([a, c], ['a'], [ok('a'), ok('c')]);
  assert.deepEqual(next.map((x) => x.key), ['c']);
  assert.equal(next[0], c);
});

test('보냈는데 결과가 없는 파일(중간에 끊김)은 그대로 둔다', () => {
  const a = item('a', true);
  const b = item('b', true);
  const next = nextStagedAfterApply([a, b], ['a', 'b'], [ok('a')]);
  assert.deepEqual(next.map((x) => x.key), ['b']);
  assert.equal(next[0], b);
});

test('입력 배열을 바꾸지 않는다', () => {
  const list = [item('a', true), item('b', true)];
  const snapshot = structuredClone(list);
  nextStagedAfterApply(list, ['a', 'b'], [ok('a'), fail('b')]);
  assert.deepEqual(list, snapshot);
});
