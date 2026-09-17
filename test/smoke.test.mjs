import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

test('플레이스홀더 테스트 — 실제 테스트로 교체하세요', () => {
  assert.equal(1 + 1, 2);
});

test('경로 조합은 플랫폼에 맞게 나온다', () => {
  assert.equal(path.join('a', 'b'), `a${path.sep}b`);
});
