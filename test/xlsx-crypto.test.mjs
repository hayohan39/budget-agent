// ECMA-376 복호화(lib/xlsx/crypto.mjs) 테스트.
//
// ⚠️ 한계를 먼저 적어 둔다. 여기 있는 왕복 시험은 **우리가 만든 암호화기**
//    (test/helpers/ooxml-encrypt.mjs)로 암호화한 파일을 우리 복호화기로 푼다.
//    이것이 증명하는 것은 두 구현이 서로 맞는다는 **자기 일관성**이지, 엑셀과
//    토스뱅크가 실제로 내보내는 파일을 읽을 수 있다는 **호환성**이 아니다.
//    스펙을 같은 방향으로 잘못 읽었다면 이 시험은 그대로 통과한다. 진짜 토스
//    파일이 생기면 그때 다시 확인해야 한다.
//
// 그래도 이 시험이 잡아 주는 것들:
//   - 두 방식(agile · standard)의 키 유도 · 검증자 · payload 경로가 끝까지 도는가
//   - 틀린 비밀번호가 payload 를 건드리기 전에 걸리는가
//   - 비밀번호가 결과 · 에러 어디에도 섞여 나오지 않는가
//   - 크기 상한이 **할당 전에** 걸리는가
//   - 망가진 컨테이너에서 멈추는가(멈추지 못하면 요청 하나가 프로세스를 묶는다)
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DECRYPT_ERRORS,
  ENCRYPTION_INFO_STREAM,
  MAX_DECRYPTED_BYTES,
  MAX_PASSWORD_LENGTH,
  MAX_SPIN_COUNT,
  decryptOoxml,
  parseEncryptionInfo,
} from '../lib/xlsx/crypto.mjs';
import { openCfb } from '../lib/xlsx/cfb.mjs';
import { MAX_ENTRY_BYTES } from '../lib/xlsx/zip.mjs';
import { openXlsx, openXlsxFile } from '../lib/xlsx/workbook.mjs';
import { parseTossStatement } from '../lib/toss/statement.mjs';
import { buildCfb, encryptAgile, encryptStandard } from './helpers/ooxml-encrypt.mjs';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'toss-sample-masked.xlsx',
);

// 실제 비밀번호처럼 보이는 값을 쓴다. 결과 어디에도 이 문자열이 없어야 한다.
const PASSWORD = 'Toss-9x!7Qa';

function plainBuffer() {
  return readFileSync(FIXTURE);
}

/** agile 기술자만 손으로 만들어 parseEncryptionInfo 를 직접 시험한다. */
function agileInfo(xml) {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(4, 0);
  head.writeUInt16LE(4, 2);
  head.writeUInt32LE(0x40, 4);
  return Buffer.concat([head, Buffer.from(xml, 'utf8')]);
}

function agileXml(overrides = {}) {
  const salt = Buffer.alloc(16, 7).toString('base64');
  const blob = Buffer.alloc(64, 9).toString('base64');
  const chaining = overrides.chaining ?? 'ChainingModeCBC';
  const cipher = overrides.cipher ?? 'AES';
  const spinCount = overrides.spinCount ?? 100000;
  return (
    '<encryption>' +
    `<keyData saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="${cipher}"` +
    ` cipherChaining="${chaining}" hashAlgorithm="SHA512" saltValue="${salt}"/>` +
    '<keyEncryptors><keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/password">' +
    `<p:encryptedKey spinCount="${spinCount}" saltSize="16" blockSize="16" keyBits="256"` +
    ` hashSize="64" cipherAlgorithm="${cipher}" cipherChaining="${chaining}" hashAlgorithm="SHA512"` +
    ` saltValue="${salt}" encryptedVerifierHashInput="${blob}"` +
    ` encryptedVerifierHashValue="${blob}" encryptedKeyValue="${blob}"/>` +
    '</keyEncryptor></keyEncryptors></encryption>'
  );
}

/** 결과 객체 어디에도 비밀번호가 없는지 본다(직렬화해서 통째로 확인). */
function assertNoPassword(value, password) {
  const serialised = JSON.stringify(value, (key, entry) =>
    Buffer.isBuffer(entry) ? `<buffer ${entry.length}>` : entry,
  );
  assert.equal(serialised.includes(password), false);
  assert.equal(String(value.error ?? '').includes(password), false);
}

// ── 왕복 ───────────────────────────────────────────────────────────────────

test('agile(4.4, AES-256/SHA-512): 암호화한 것을 그대로 되돌린다', () => {
  const plain = plainBuffer();
  const result = decryptOoxml(encryptAgile(plain, PASSWORD), PASSWORD);

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'agile');
  assert.equal(result.integrity, 'ok');
  assert.equal(result.data.equals(plain), true);
});

test('standard(4.2, AES-128/SHA-1): 실제 토스 파일과 같은 조합을 되돌린다', () => {
  // 진짜 토스뱅크 명세서를 구조만 확인한 결과가 이 조합이었다. 왕복 시험의
  // 기본 자리는 실제 파일이 쓰는 파라미터가 차지해야 한다.
  const plain = plainBuffer();
  const result = decryptOoxml(encryptStandard(plain, PASSWORD, { keyBits: 128 }), PASSWORD);

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'standard');
  // standard 에는 dataIntegrity 가 아예 없다. 없는 것을 "실패" 로 보지 않는다.
  assert.equal(result.integrity, 'absent');
  assert.equal(result.data.equals(plain), true);
});

test('standard(4.2, AES-256/SHA-1): 더 긴 키도 되돌린다', () => {
  const plain = plainBuffer();
  const result = decryptOoxml(encryptStandard(plain, PASSWORD), PASSWORD);

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'standard');
  assert.equal(result.data.equals(plain), true);
});

test('agile 의 다른 조합(AES-128/SHA-1)도 되돌린다', () => {
  const plain = plainBuffer();
  const blob = encryptAgile(plain, PASSWORD, { hash: 'sha1', keyBits: 128, spinCount: 50 });
  const result = decryptOoxml(blob, PASSWORD);

  assert.equal(result.ok, true);
  assert.equal(result.data.equals(plain), true);
});

test('standard 의 예전 버전 표기(3.2)도 그대로 받는다', () => {
  // 스펙은 3.2 와 4.2 를 모두 standard 로 정한다. 실제 파일이 4.2 라고 해서
  // 3.2 를 떨어뜨리면 다른 은행·다른 생성기가 만든 파일을 못 읽게 된다.
  const plain = plainBuffer();
  const blob = encryptStandard(plain, PASSWORD, { version: [3, 2] });
  const result = decryptOoxml(blob, PASSWORD);

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'standard');
  assert.equal(result.data.equals(plain), true);
});

test('복호화한 버퍼를 기존 파서가 그대로 먹는다', () => {
  // 이 모듈의 계약은 "평범한 ZIP 버퍼를 돌려준다" 이다. 파싱 결과가 평문
  // fixture 를 직접 읽은 것과 같아야 계약이 지켜진 것이다.
  const expected = parseTossStatement(openXlsxFile(FIXTURE).sheet(0));

  for (const blob of [
    encryptAgile(plainBuffer(), PASSWORD),
    encryptStandard(plainBuffer(), PASSWORD),
  ]) {
    const result = decryptOoxml(blob, PASSWORD);
    assert.equal(result.ok, true);
    const actual = parseTossStatement(openXlsx(result.data).sheet(0));
    assert.deepEqual(actual, expected);
  }
});

// ── 틀린 비밀번호 ──────────────────────────────────────────────────────────

test('틀린 비밀번호는 payload 를 건드리기 전에 wrongPassword 로 걸린다', () => {
  for (const blob of [
    encryptAgile(plainBuffer(), PASSWORD),
    encryptStandard(plainBuffer(), PASSWORD),
  ]) {
    const result = decryptOoxml(blob, '틀린비밀번호');
    assert.equal(result.ok, false);
    assert.equal(result.error, DECRYPT_ERRORS.wrongPassword);
    // 실패 결과에 data 가 붙어 있으면 안 된다 — 아무것도 풀지 않았다.
    assert.equal('data' in result, false);
  }
});

test('wrongPassword 는 encrypted · notXlsx 와 다른 코드다', () => {
  // UI 가 "다시 받으세요" 와 "비밀번호가 틀렸습니다" 를 갈라 말할 수 있어야 한다.
  assert.equal(DECRYPT_ERRORS.wrongPassword, 'wrongPassword');
  assert.notEqual(DECRYPT_ERRORS.wrongPassword, DECRYPT_ERRORS.notEncrypted);
  assert.notEqual(DECRYPT_ERRORS.wrongPassword, DECRYPT_ERRORS.corruptContainer);
});

test('결과에도 에러에도 비밀번호가 섞여 나오지 않는다', () => {
  const blob = encryptAgile(plainBuffer(), PASSWORD);

  assertNoPassword(decryptOoxml(blob, PASSWORD), PASSWORD);
  assertNoPassword(decryptOoxml(blob, 'another-secret'), 'another-secret');
  assertNoPassword(decryptOoxml(blob.subarray(0, 700), PASSWORD), PASSWORD);
  assertNoPassword(decryptOoxml(Buffer.alloc(0), PASSWORD), PASSWORD);
});

test('비밀번호가 비었거나 너무 길면 파일을 읽기도 전에 거절한다', () => {
  const blob = encryptAgile(plainBuffer(), PASSWORD);

  assert.equal(decryptOoxml(blob, '').error, DECRYPT_ERRORS.passwordRejected);
  assert.equal(decryptOoxml(blob, undefined).error, DECRYPT_ERRORS.passwordRejected);
  assert.equal(
    decryptOoxml(blob, 'a'.repeat(MAX_PASSWORD_LENGTH + 1)).error,
    DECRYPT_ERRORS.passwordRejected,
  );
  assert.equal(decryptOoxml(blob, 'a'.repeat(MAX_PASSWORD_LENGTH)).error, DECRYPT_ERRORS.wrongPassword);
});

// ── 크기 상한 ──────────────────────────────────────────────────────────────

test('복호화 결과 상한은 ZIP 엔트리 상한과 같은 값이다', () => {
  assert.equal(MAX_DECRYPTED_BYTES, MAX_ENTRY_BYTES);
});

test('선언된 크기가 상한을 넘으면 풀기 전에 거절한다', () => {
  // 앞 8바이트의 "풀면 이만큼" 값만 크게 적은 파일. 실제 암호문은 작다.
  // 이 값을 믿고 Buffer 를 잡으면 그 자리에서 메모리가 날아간다.
  const blob = encryptAgile(plainBuffer(), PASSWORD, {
    declaredSize: MAX_DECRYPTED_BYTES + 1,
  });
  const result = decryptOoxml(blob, PASSWORD);

  assert.equal(result.ok, false);
  assert.equal(result.error, DECRYPT_ERRORS.tooLarge);
});

test('선언된 크기가 실제 암호문보다 크면 거절한다', () => {
  const blob = encryptAgile(plainBuffer(), PASSWORD, { declaredSize: 1024 * 1024 });
  const result = decryptOoxml(blob, PASSWORD);

  assert.equal(result.ok, false);
  assert.equal(result.error, DECRYPT_ERRORS.decryptFailed);
});

test('선언된 크기가 0 이면 거절한다', () => {
  const result = decryptOoxml(encryptAgile(plainBuffer(), PASSWORD, { declaredSize: 0 }), PASSWORD);
  assert.equal(result.error, DECRYPT_ERRORS.tooLarge);
});

// ── 무결성(dataIntegrity) ──────────────────────────────────────────────────

test('dataIntegrity 가 맞지 않으면 mismatch 로 알린다', () => {
  const blob = encryptAgile(plainBuffer(), PASSWORD, { corruptIntegrity: true });
  const result = decryptOoxml(blob, PASSWORD);

  // 복호화 자체는 된다. 판단(경고로 둘지 막을지)은 위층의 몫이라 여기서는
  // 사실만 돌려준다.
  assert.equal(result.ok, true);
  assert.equal(result.integrity, 'mismatch');
});

test('dataIntegrity 가 아예 없으면 absent 다', () => {
  const blob = encryptAgile(plainBuffer(), PASSWORD, { dataIntegrity: false });
  const result = decryptOoxml(blob, PASSWORD);

  assert.equal(result.ok, true);
  assert.equal(result.integrity, 'absent');
});

// ── 망가진 · 지원하지 않는 입력 ────────────────────────────────────────────

test('잘린 OLE2 컨테이너는 던지지 않고 corruptContainer 로 끝난다', () => {
  const blob = encryptAgile(plainBuffer(), PASSWORD);
  for (const length of [0, 8, 200, 512, 1024, 4096, blob.length - 1024]) {
    const result = decryptOoxml(blob.subarray(0, length), PASSWORD);
    assert.equal(result.ok, false, `length=${length}`);
    // 어떤 길이에서도 코드로만 답한다. 예외가 밖으로 나가지 않는다.
    assert.equal(typeof result.error, 'string');
  }
});

test('OLE2 가 아닌 바이트는 corruptContainer 다', () => {
  const result = decryptOoxml(Buffer.from('PK\u0003\u0004 not a compound file'), PASSWORD);
  assert.equal(result.error, DECRYPT_ERRORS.corruptContainer);
});

test('암호화 스트림이 없는 OLE2 는 notEncrypted 다', () => {
  const blob = buildCfb([{ name: 'Workbook', data: Buffer.alloc(200, 1) }]);
  assert.equal(decryptOoxml(blob, PASSWORD).error, DECRYPT_ERRORS.notEncrypted);
});

test('Buffer 가 아닌 입력도 던지지 않는다', () => {
  assert.equal(decryptOoxml('문자열', PASSWORD).error, DECRYPT_ERRORS.corruptContainer);
  assert.equal(decryptOoxml(null, PASSWORD).error, DECRYPT_ERRORS.corruptContainer);
});

// ── EncryptionInfo 파싱 ────────────────────────────────────────────────────

test('구현하지 않은 버전은 unsupportedEncryption 이다', () => {
  for (const [major, minor] of [
    [4, 3], // Extensible
    [2, 1], // RC4
    [3, 1],
    [1, 1],
    [5, 5],
  ]) {
    const info = Buffer.alloc(8);
    info.writeUInt16LE(major, 0);
    info.writeUInt16LE(minor, 2);
    assert.equal(
      parseEncryptionInfo(info).error,
      DECRYPT_ERRORS.unsupportedEncryption,
      `${major}.${minor}`,
    );
  }
});

test('spinCount 가 상한을 넘으면 계산을 시작하지 않고 거절한다', () => {
  // 2^31 로 적힌 파일 하나가 CPU 를 통째로 묶는 것을 막는 상한이다.
  const info = agileInfo(agileXml({ spinCount: MAX_SPIN_COUNT + 1 }));
  assert.equal(parseEncryptionInfo(info).error, DECRYPT_ERRORS.unsupportedEncryption);
});

test('CBC 가 아닌 체이닝 · AES 가 아닌 암호는 거절한다', () => {
  assert.equal(
    parseEncryptionInfo(agileInfo(agileXml({ chaining: 'ChainingModeCFB' }))).error,
    DECRYPT_ERRORS.unsupportedEncryption,
  );
  assert.equal(
    parseEncryptionInfo(agileInfo(agileXml({ cipher: 'RC4' }))).error,
    DECRYPT_ERRORS.unsupportedEncryption,
  );
});

test('정상 agile 기술자는 파싱된다', () => {
  const descriptor = parseEncryptionInfo(agileInfo(agileXml()));
  assert.equal(descriptor.ok, true);
  assert.equal(descriptor.kind, 'agile');
  assert.equal(descriptor.keyData.keyBytes, 32);
  assert.equal(descriptor.encryptedKey.spinCount, 100000);
});

test('실제 토스 파일의 standard 파라미터(4.2 / AES-128 / SHA-1)를 받아들인다', () => {
  // 진짜 토스뱅크 명세서를 **구조만** 확인해서 얻은 값이다(복호화하지 않았고
  // 파일은 저장소에 들어오지 않는다 — 개인 금융 데이터다). 받아들이는 범위를
  // 좁히는 변경이 있으면, 토스 파일이 조용히 깨지는 대신 이 시험이 이름으로
  // 먼저 알려 준다.
  const container = encryptStandard(plainBuffer(), PASSWORD, { keyBits: 128 });
  const info = openCfb(container).read(ENCRYPTION_INFO_STREAM);

  assert.equal(info.readUInt16LE(0), 4); // EncryptionVersionInfo.Major
  assert.equal(info.readUInt16LE(2), 2); // EncryptionVersionInfo.Minor
  assert.equal(info.readUInt32LE(4), 0x24); // 스트림 Flags: fCryptoAPI | fAES

  const headerSize = info.readUInt32LE(8);
  const header = info.subarray(12, 12 + headerSize);
  assert.equal(header.readUInt32LE(0), 0x24); // EncryptionHeader.Flags
  assert.equal(header.readUInt32LE(8), 0x660e); // AlgID: AES-128
  assert.equal(header.readUInt32LE(12), 0x8004); // AlgIDHash: SHA-1
  assert.equal(header.readUInt32LE(16), 128); // KeySize
  assert.equal(header.readUInt32LE(20), 24); // ProviderType: AES
  assert.equal(
    header.toString('utf16le', 32).replace(/\u0000[\s\S]*$/, ''),
    'Microsoft Enhanced RSA and AES Cryptographic Provider',
  );

  let at = 12 + headerSize;
  assert.equal(info.readUInt32LE(at), 16); // SaltSize
  at += 4 + 16 + 16; // salt + EncryptedVerifier
  assert.equal(info.readUInt32LE(at), 20); // VerifierHashSize (SHA-1)

  const descriptor = parseEncryptionInfo(info);
  assert.equal(descriptor.ok, true);
  assert.equal(descriptor.kind, 'standard');
  assert.equal(descriptor.keyBytes, 16);
  assert.equal(descriptor.salt.length, 16);
  // standard 에는 dataIntegrity(HMAC) 기술자가 스펙에 아예 없다.
  assert.equal(descriptor.integrity, null);
});

test('짧거나 Buffer 가 아닌 EncryptionInfo 는 corruptContainer 다', () => {
  assert.equal(parseEncryptionInfo(Buffer.alloc(4)).error, DECRYPT_ERRORS.corruptContainer);
  assert.equal(parseEncryptionInfo('x').error, DECRYPT_ERRORS.corruptContainer);
});
