// middleware.ts 의 matcher 가 로그인 예외로 여는 경로를 못 박는다.
// 예외는 정확히 그 경로(또는 그 하위)뿐이어야 한다 — 접두사로 열리면 `/api/healthz`,
// `/api/authorize` 같은 경로까지 로그인 없이 닿는다.
//
// middleware.ts 는 next-auth 를 import 하므로 직접 불러오지 않고, matcher 문자열을
// 소스에서 읽어 같은 정규식으로 검사한다(Next 의 matcher 는 이 패턴을 정규식으로 쓴다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(ROOT, 'middleware.ts'), 'utf8');
const literal = source.match(/matcher:\s*\[\s*("(?:[^"\\]|\\.)*")/)?.[1];
assert.ok(literal, 'middleware.ts 에서 matcher 를 찾지 못했다');
const matcher = new RegExp(`^${JSON.parse(literal)}$`);
const protectedPath = (p) => matcher.test(p);

test('로그인 없이 열리는 경로', () => {
  for (const p of ['/api/health', '/api/auth', '/api/auth/callback/google', '/signin', '/favicon.ico']) {
    assert.equal(protectedPath(p), false, p);
  }
});

test('그 밖은 전부 보호된다(접두사로 열리지 않는다)', () => {
  for (const p of ['/', '/report', '/api/import', '/api/healthz', '/api/health/x', '/api/authorize', '/signinx']) {
    assert.equal(protectedPath(p), true, p);
  }
});
