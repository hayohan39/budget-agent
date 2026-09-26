// /api/import 요청 모양 판정(lib/import/request.mjs) 테스트.
//
// 라우트 핸들러는 Next.js 없이 돌리기 어렵다. 그래서 "모드가 없으면 거부" ·
// "요청 하나에 파일 하나" · "본문을 읽기 전에 크기 거부" 판단을 순수 함수로
// 빼 두었고, 여기서 그것을 못 박는다. DB 도 파일도 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_FILE_BYTES } from '../lib/import/statement.mjs';
import {
  IMPORT_MODES,
  MAX_REQUEST_BYTES,
  exceedsRequestLimit,
  parseImportMode,
  pickSingleUpload,
} from '../lib/import/request.mjs';

// ── 요청 모양 ──────────────────────────────────────────────────────────────

test('모드는 preview 와 apply 만 받는다', () => {
  assert.equal(parseImportMode('preview'), IMPORT_MODES.preview);
  assert.equal(parseImportMode('apply'), IMPORT_MODES.apply);
});

test('모드가 없거나 모르는 값이면 거부한다 — 적용으로 기본값을 잡지 않는다', () => {
  for (const value of [
    null,
    undefined,
    '',
    ' ',
    'Apply',
    'APPLY',
    ' apply',
    'apply ',
    'Preview',
    'import',
    'insert',
    'true',
    '1',
    ['apply'],
    { mode: 'apply' },
    1,
    true,
  ]) {
    assert.equal(parseImportMode(value), null, `받으면 안 되는 모드: ${JSON.stringify(value)}`);
  }
});

/** File 을 흉내 낸 객체. pickSingleUpload 는 모양만 본다. */
function fakeFile(name, size) {
  return { name, size, async arrayBuffer() { return new ArrayBuffer(size); } };
}

test('요청 하나에 파일 하나만 받는다', () => {
  const one = pickSingleUpload([fakeFile('a.xlsx', 10)]);
  assert.equal(one.ok, true);
  assert.equal(one.file.name, 'a.xlsx');

  assert.deepEqual(pickSingleUpload([fakeFile('a.xlsx', 10), fakeFile('b.xlsx', 10)]), {
    ok: false,
    error: 'tooManyFiles',
  });
  assert.deepEqual(
    pickSingleUpload([fakeFile('a.xlsx', 10), fakeFile('b.xlsx', 10), fakeFile('c.xlsx', 10)]),
    { ok: false, error: 'tooManyFiles' },
  );
});

test('파일이 없거나 빈 파트뿐이면 noFile 이다', () => {
  assert.deepEqual(pickSingleUpload([]), { ok: false, error: 'noFile' });
  // 파일을 고르지 않고 보낸 폼의 빈 파트.
  assert.deepEqual(pickSingleUpload([fakeFile('', 0)]), { ok: false, error: 'noFile' });
  // 문자열 필드는 파일이 아니다.
  assert.deepEqual(pickSingleUpload(['a.xlsx']), { ok: false, error: 'noFile' });
  // 빈 파트 + 진짜 파일 하나는 하나로 센다.
  assert.equal(pickSingleUpload([fakeFile('', 0), fakeFile('a.xlsx', 10)]).ok, true);
});

test('Content-Length 로 본문을 읽기 전에 상한을 넘는 요청을 가른다', () => {
  assert.ok(MAX_REQUEST_BYTES > MAX_FILE_BYTES);
  // Vercel 서버리스 요청 본문 한도(4.5MB) 아래.
  assert.ok(MAX_REQUEST_BYTES < 4.5 * 1024 * 1024);

  assert.equal(exceedsRequestLimit(null), false);
  assert.equal(exceedsRequestLimit(''), false);
  assert.equal(exceedsRequestLimit('1024'), false);
  assert.equal(exceedsRequestLimit(String(MAX_REQUEST_BYTES)), false);
  assert.equal(exceedsRequestLimit(String(MAX_REQUEST_BYTES + 1)), true);
  // 파일 셋을 한 요청에 실은 크기는 거부된다.
  assert.equal(exceedsRequestLimit(String(3 * MAX_FILE_BYTES)), true);
  // 숫자가 아닌 값은 넘는 것으로 본다.
  for (const junk of ['-1', '1e9', 'abc', '12 34', '99999999999999999999999']) {
    assert.equal(exceedsRequestLimit(junk), true, junk);
  }
});
