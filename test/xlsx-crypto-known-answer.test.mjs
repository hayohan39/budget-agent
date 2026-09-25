// 기지답(known answer) 시험 — **바깥에서 온 정답**으로 키 유도를 못 박는다.
//
// 왜 따로 파일을 두는가
//   test/xlsx-crypto.test.mjs 의 왕복 시험은 우리 암호화기가 만든 파일을 우리
//   복호화기가 푼다. 두 쪽이 **같은 방향으로** 스펙을 잘못 읽으면 왕복은 조용히
//   통과한다. 실제로 그런 일이 있었다: agile 의 dataIntegrity 블록 키 마지막
//   바이트가 lib 과 시험 암호화기 양쪽에서 똑같이 틀려 있었고, 왕복 시험은
//   `integrity === 'ok'` 로 통과하고 있었다. 자기 검증 고리를 끊으려면 우리가
//   만들지 않은 정답이 필요하다.
//
// 어디서 온 값인가
//   공개된 msoffcrypto-tool 시험 자료(`nolze/msoffcrypto-tool`)의
//   `ecma376standard_password.docx` 다. **실제 Microsoft Office 가 만든 파일**
//   이고, 비밀번호 `Password1234_` 는 그 자료가 공개해 둔 시험용 값이다
//   (개인 비밀번호가 아니다 — 저장소에 들어와도 되는 유일한 종류다).
//   조합은 standard 3.2 / AES-128 / SHA-1 로, 실제 토스뱅크 명세서와 같은
//   프로파일이다.
//
//   파일 자체는 저장소에 넣지 않는다. 필요한 것은 상수 여섯 개뿐이고, 제3자
//   바이너리를 들여오면 라이선스 문제가 생긴다(CLAUDE.md: 의존성에 보수적으로).
//
// 무엇을 못 박는가
//   salt 와 비밀번호만 주면 우리 함수가 Office 와 **같은** H_final 과 같은
//   AES-128 키를 내놓는가. 그 키로 Office 가 저장해 둔 verifier 가 실제로
//   맞아떨어지는가. 틀린 비밀번호는 거기서 걸리는가.
//   여기가 깨지면 키 스케줄(50,000회 반복 · 연결 순서 · 블록 번호 · X1/X2
//   확장 · 키 자르기) 중 하나가 어긋난 것이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import {
  DECRYPT_ERRORS,
  standardEncryptionKey,
  standardPasswordHash,
  standardSecretKey,
} from '../lib/xlsx/crypto.mjs';

/**
 * `ecma376standard_password.docx` 에서 뽑은 값.
 * 우리가 만든 값이 하나도 없다 — 전부 Office 가 쓴 바이트다.
 */
const OFFICE = Object.freeze({
  /** 공개된 시험용 비밀번호. 스펙대로 UTF-16LE 로 쓴다. */
  password: 'Password1234_',
  salt: 'e88266490c5bd1eebd2b4394e3f830ef',
  finalHash: 'e2f8cde457e5d449eb205057c88d201d14531ff3',
  key: '40b13a71f90b966e375408f2d181a1aa',
  encryptedVerifier: '516f732e966fac17b1c5d7d8cc36c928',
  encryptedVerifierHash:
    '2b6168dabe2911ad2bd37c1746745c14d3cf1bb140a48f4e6f3d23880872b16a',
});

const salt = Buffer.from(OFFICE.salt, 'hex');
const passwordUtf16 = Buffer.from(OFFICE.password, 'utf16le');

/** 실제 파일의 EncryptionVerifier 자리에 있던 바이트들. */
function officeDescriptor() {
  return {
    keyBytes: 16, // AES-128
    salt,
    encryptedVerifier: Buffer.from(OFFICE.encryptedVerifier, 'hex'),
    encryptedVerifierHash: Buffer.from(OFFICE.encryptedVerifierHash, 'hex'),
  };
}

test('기지답(실제 Office 파일): 우리 H_final 이 Office 의 H_final 과 같다', () => {
  // 50,000회 반복 · `uint32le(i) ‖ digest` 연결 순서 · 마지막 블록 번호 0 이
  // 하나라도 어긋나면 여기서 값이 달라진다.
  const actual = standardPasswordHash(salt, passwordUtf16);
  assert.equal(actual.toString('hex'), OFFICE.finalHash);
});

test('기지답(실제 Office 파일): 우리 AES-128 키가 Office 의 키와 같다', () => {
  // X1/X2 확장(0x36 · 0x5c)과 키 자르기까지 맞아야 나오는 값이다.
  const finalHash = standardPasswordHash(salt, passwordUtf16);
  const actual = standardEncryptionKey(finalHash, 16);
  assert.equal(actual.toString('hex'), OFFICE.key);
  assert.equal(actual.length, 16);
});

test('기지답(실제 Office 파일): Office 가 저장한 verifier 가 그 키로 맞아떨어진다', () => {
  // 키가 같다는 것만으로는 ECB verifier 경로가 맞는지 알 수 없다. Office 가
  // 파일에 적어 둔 EncryptedVerifier / EncryptedVerifierHash 로 직접 본다.
  const result = standardSecretKey(officeDescriptor(), passwordUtf16);

  assert.equal(result.ok, true);
  assert.equal(result.secret.toString('hex'), OFFICE.key);
});

test('기지답(실제 Office 파일): 틀린 비밀번호는 같은 파일에서 wrongPassword 로 걸린다', () => {
  // 통과 경로만 맞추면 "언제나 통과" 로도 통과한다. 거절 경로도 같은 실제
  // 파일의 바이트로 확인한다.
  for (const wrong of ['Password1234', 'password1234_', 'Password1234__', '다른비밀번호']) {
    const result = standardSecretKey(officeDescriptor(), Buffer.from(wrong, 'utf16le'));
    assert.equal(result.ok, false, wrong);
    assert.equal(result.error, DECRYPT_ERRORS.wrongPassword, wrong);
    assert.equal('secret' in result, false, wrong);
  }
});
