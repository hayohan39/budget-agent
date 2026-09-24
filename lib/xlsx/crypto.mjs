// 암호가 걸린 OOXML(ECMA-376) 을 풀어서 평범한 ZIP 버퍼로 되돌린다.
//
// 토스뱅크가 내려주는 거래내역 xlsx 는 비밀번호가 걸려 있다. 그 파일은 ZIP 이
// 아니라 OLE2 복합 문서이고(lib/xlsx/cfb.mjs), 안에 `EncryptionInfo` 와
// `EncryptedPackage` 두 스트림이 들어 있다. 이 모듈은 그 둘을 읽어 키를 유도하고
// 복호화해서, 기존 파서가 그대로 먹을 수 있는 ZIP 바이트를 돌려준다.
//
// 구현 범위 (MS-OFFCRYPTO)
//   - **Agile encryption** (버전 4.4, XML 기술자): AES-CBC + SHA-1/256/384/512.
//   - **Standard encryption** (버전 3.2 / 4.2, 이진 헤더): AES-ECB + SHA-1.
//   - 구현하지 않음: Extensible(4.3) · RC4 계열(1.1, 2.2 의 CryptoAPI RC4) ·
//     인증서 기반 keyEncryptor · ChainingModeCFB · 외부 키 관리(fExternal).
//     모두 `unsupported` 로 거절한다.
//   새 npm 의존성을 쓰지 않는다 — node:crypto 에 AES-CBC/ECB · SHA · HMAC 이
//   전부 있고, 컨테이너는 바이트 파싱이다(CLAUDE.md).
//
// ── 이 모듈이 지키는 것 ────────────────────────────────────────────────────
//
//   1. **비밀번호는 어디로도 나가지 않는다.** 로그 · 에러 메시지 · 예외 ·
//      반환값 · 스택 어디에도 담기지 않는다. 이 파일에 console 호출이 없고,
//      비밀번호를 문자열 템플릿에 넣는 자리가 한 곳도 없다.
//   2. **던지지 않는다.** 실패는 전부 `{ ok: false, error: <코드> }` 다. 코드는
//      고정 문자열이라 내용을 흘릴 수 없다. 내부에서 던져진 에러(파서 · crypto)
//      는 바인딩 없는 `catch {}` 로 받아 코드로만 바꾼다 — 실수로 읽을 수 없게.
//   3. **틀린 비밀번호는 payload 를 건드리기 전에 걸러낸다.** 스펙의 password
//      verifier 를 먼저 확인한다. 그래야 "비밀번호가 틀림" 과 "파일이 깨짐" 이
//      섞이지 않는다.
//   4. **할당 전에 크기를 본다.** 복호화 결과 · OLE2 스트림 모두 상한이 있다.
//      선언된 크기가 터무니없으면 한 바이트도 잡지 않고 거절한다.
//   5. 디스크에 아무것도 쓰지 않는다. 전부 메모리다.
import { Buffer } from 'node:buffer';
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { MAX_STREAM_BYTES, openCfb } from './cfb.mjs';
import { attr } from './xml.mjs';

export const ENCRYPTION_INFO_STREAM = 'EncryptionInfo';
export const ENCRYPTED_PACKAGE_STREAM = 'EncryptedPackage';

/**
 * 복호화 실패 코드.
 *
 * 값은 UI 분기용 식별자다. 파일 내용 · 비밀번호는 어느 코드에서도 유추할 수
 * 없다. `wrongPassword` 만 "비밀번호가 틀렸다" 를 뜻하고, 나머지는 비밀번호와
 * 무관한 사유다.
 */
export const DECRYPT_ERRORS = Object.freeze({
  /** OLE2 는 맞는데 암호화 스트림이 없다. 우리가 아는 형태가 아니다. */
  notEncrypted: 'notEncrypted',
  /** OLE2 컨테이너 자체를 읽지 못했다(잘림 · 손상 · 고리). */
  corruptContainer: 'corruptContainer',
  /** 구현하지 않은 암호화 방식(Extensible · RC4 · 인증서 · CFB 등). */
  unsupportedEncryption: 'unsupportedEncryption',
  /** password verifier 불일치. 비밀번호가 틀렸다. */
  wrongPassword: 'wrongPassword',
  /** 비밀번호가 비었거나 상한을 넘었다. */
  passwordRejected: 'passwordRejected',
  /** 키는 맞는데 복호화 도중 실패했다(길이 · 패딩 등). */
  decryptFailed: 'decryptFailed',
  /** 풀면 상한을 넘는 크기다. 풀기 전에 거절한다. */
  tooLarge: 'tooLarge',
});

/**
 * 복호화된 payload 의 최대 크기.
 *
 * ZIP 엔트리 상한과 같은 값(MAX_STREAM_BYTES = lib/xlsx/zip.mjs 의
 * MAX_ENTRY_BYTES)을 쓴다. 복호화 결과는 곧바로 그 ZIP 리더로 들어가므로 한쪽만
 * 느슨하면 상한이 없는 것과 같다. 압축 폭탄과 같은 부류의 벡터다 — 암호를 푼
 * 바이트도 "작은 입력에서 나오는 큰 출력" 이다.
 */
export const MAX_DECRYPTED_BYTES = MAX_STREAM_BYTES;

/** EncryptionInfo 스트림의 상한. 기술자 XML 은 실제로 1KB 안팎이다. */
export const MAX_ENCRYPTION_INFO_BYTES = 256 * 1024;

/**
 * spinCount 상한.
 *
 * agile 기술자의 spinCount 는 파일이 적어 오는 값이고, 한 번에 해시 하나다.
 * 엑셀은 100,000 을 쓴다. 2^31 로 적힌 파일 하나가 서버 CPU 를 통째로 묶는 일을
 * 막기 위해 상한을 둔다. 넘으면 계산을 **시작하지 않고** 거절한다.
 */
export const MAX_SPIN_COUNT = 1_000_000;

/** 비밀번호 길이 상한(문자 수). 엑셀 자체가 255자까지만 받는다. */
export const MAX_PASSWORD_LENGTH = 255;

/** 세그먼트 단위. agile 은 payload 를 이 크기로 잘라 각각 다른 IV 로 푼다. */
const SEGMENT_BYTES = 4096;

/** agile 블록 키(MS-OFFCRYPTO 2.3.4.12). 스펙이 정한 고정 바이트열이다. */
const BLOCK_KEY = Object.freeze({
  verifierHashInput: Buffer.from('fea7d2763b4b9e79', 'hex'),
  verifierHashValue: Buffer.from('d7aa0f6d3061344e', 'hex'),
  keyValue: Buffer.from('146e0be7abacd0d6', 'hex'),
  hmacKey: Buffer.from('5fb2ad010cb9e1f6', 'hex'),
  // ⚠️ 마지막 바이트는 0x33 이다. 0xa0 으로 적힌 글이 인터넷에 돌아다니지만
  //    (`…84a0`) 그것은 옮겨 적다 틀린 값이다. 실제 Microsoft Office 가 만든
  //    agile(4.4) 파일 두 개로 확인했다: `…8433` 일 때만 dataIntegrity HMAC 이
  //    맞는다. 스펙(MS-OFFCRYPTO 2.3.4.14)과 참조 구현
  //    (msoffcrypto-tool `ecma376_agile.py`)도 같은 값이다. 되돌리지 말 것.
  hmacValue: Buffer.from('a0677f02b22c8433', 'hex'),
});

/** 기술자가 쓰는 해시 이름 -> node:crypto 이름. 모르는 이름은 받지 않는다. */
const HASH_NAMES = new Map([
  ['SHA1', 'sha1'],
  ['SHA-1', 'sha1'],
  ['SHA256', 'sha256'],
  ['SHA-256', 'sha256'],
  ['SHA384', 'sha384'],
  ['SHA-384', 'sha384'],
  ['SHA512', 'sha512'],
  ['SHA-512', 'sha512'],
]);

/**
 * EncryptionHeaderFlags 의 `fExternal` 비트(MS-OFFCRYPTO 2.3.2).
 *
 * 서 있으면 키를 문서 바깥(외부 키 관리)에서 가져온다는 뜻이다. 비밀번호로
 * 푸는 파일이 아니다.
 */
const FLAG_EXTERNAL = 0x10;

/** standard encryption 의 AlgID -> 키 길이(바이트). AES 만 받는다. */
const STANDARD_ALG_ID = new Map([
  [0x660e, 16],
  [0x660f, 24],
  [0x6610, 32],
]);

function failure(code) {
  return { ok: false, error: code };
}

function hash(algorithm, ...parts) {
  const digest = createHash(algorithm);
  for (const part of parts) digest.update(part);
  return digest.digest();
}

function uint32le(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

/**
 * 버퍼를 정확히 size 바이트로 맞춘다. 길면 자르고, 짧으면 pad 로 채운다.
 * (MS-OFFCRYPTO 는 모자란 자리를 0x36 으로 채우라고 정한다.)
 */
function fit(bytes, size, pad) {
  if (bytes.length === size) return bytes;
  if (bytes.length > size) return bytes.subarray(0, size);
  return Buffer.concat([bytes, Buffer.alloc(size - bytes.length, pad)]);
}

/** 길이가 달라도 던지지 않는 상수시간 비교. */
function equals(a, b) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 비밀번호를 스펙이 쓰는 형태(UTF-16LE, 종단 널 없음)로 바꾼다.
 *
 * ⚠️ 이 버퍼는 이 모듈 밖으로 나가지 않는다. 반환값에도 에러에도 담지 않는다.
 */
function passwordBytes(password) {
  return Buffer.from(password, 'utf16le');
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length === 0) return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  return true;
}

// ── agile encryption (버전 4.4) ────────────────────────────────────────────

// 기술자 XML 의 요소에는 네임스페이스 접두사가 붙을 수 있다(`<p:encryptedKey>`).
// 접두사 이름은 파일마다 다를 수 있으므로 무엇이 오든 받는다.
const KEY_DATA_TAG = /<(?:[\w.-]+:)?keyData(\s[^>]*?)\/?>/;
const ENCRYPTED_KEY_TAG = /<(?:[\w.-]+:)?encryptedKey(\s[^>]*?)\/?>/g;
const DATA_INTEGRITY_TAG = /<(?:[\w.-]+:)?dataIntegrity(\s[^>]*?)\/?>/;

function readInt(source, name) {
  const raw = attr(source, name);
  if (raw === null) return null;
  if (!/^[0-9]{1,10}$/.test(raw.trim())) return null;
  return Number.parseInt(raw.trim(), 10);
}

function readBase64(source, name, maxBytes) {
  const raw = attr(source, name);
  if (raw === null) return null;
  // 길이를 먼저 본다. base64 문자열 자체가 터무니없이 길면 디코딩하지 않는다.
  if (raw.length > maxBytes * 2) return null;
  const decoded = Buffer.from(raw, 'base64');
  return decoded.length === 0 || decoded.length > maxBytes ? null : decoded;
}

/**
 * keyData / encryptedKey 에 공통으로 붙는 암호 파라미터를 읽고 검증한다.
 * 모르는 알고리즘 · 말이 안 되는 크기는 여기서 전부 걸러진다.
 */
function readCipherParams(source) {
  const hashName = attr(source, 'hashAlgorithm');
  const cipher = attr(source, 'cipherAlgorithm');
  const chaining = attr(source, 'cipherChaining');
  const keyBits = readInt(source, 'keyBits');
  const blockSize = readInt(source, 'blockSize');
  const hashSize = readInt(source, 'hashSize');
  const saltSize = readInt(source, 'saltSize');
  const salt = readBase64(source, 'saltValue', 64);

  if (hashName === null || !HASH_NAMES.has(hashName.toUpperCase())) return null;
  if (cipher !== 'AES') return null;
  if (chaining !== 'ChainingModeCBC') return null;
  if (keyBits !== 128 && keyBits !== 192 && keyBits !== 256) return null;
  if (blockSize !== 16) return null;
  if (salt === null || saltSize !== salt.length) return null;

  const algorithm = HASH_NAMES.get(hashName.toUpperCase());
  const digestBytes = createHash(algorithm).digest().length;
  if (hashSize !== null && hashSize !== digestBytes) return null;

  return { algorithm, digestBytes, keyBytes: keyBits / 8, blockSize, salt };
}

function parseAgile(info) {
  // 헤더 8바이트(major/minor/reserved) 뒤가 UTF-8 XML 이다.
  const xml = info.toString('utf8', 8);

  const keyDataMatch = KEY_DATA_TAG.exec(xml);
  if (keyDataMatch === null) return failure(DECRYPT_ERRORS.unsupportedEncryption);
  const keyData = readCipherParams(keyDataMatch[1]);
  if (keyData === null) return failure(DECRYPT_ERRORS.unsupportedEncryption);

  // keyEncryptor 는 여러 개일 수 있다(비밀번호 · 인증서). 우리가 다루는 것은
  // spinCount 와 verifier 를 가진 비밀번호 방식뿐이다.
  let encryptedKey = null;
  ENCRYPTED_KEY_TAG.lastIndex = 0;
  let match;
  while ((match = ENCRYPTED_KEY_TAG.exec(xml)) !== null) {
    const source = match[1];
    const spinCount = readInt(source, 'spinCount');
    if (spinCount === null) continue;
    const params = readCipherParams(source);
    if (params === null) continue;

    // 계산을 **시작하기 전에** 상한을 본다.
    if (spinCount < 1 || spinCount > MAX_SPIN_COUNT) {
      return failure(DECRYPT_ERRORS.unsupportedEncryption);
    }

    const verifierInput = readBase64(source, 'encryptedVerifierHashInput', 64);
    const verifierValue = readBase64(source, 'encryptedVerifierHashValue', 128);
    const keyValue = readBase64(source, 'encryptedKeyValue', 64);
    if (verifierInput === null || verifierValue === null || keyValue === null) continue;

    encryptedKey = { ...params, spinCount, verifierInput, verifierValue, keyValue };
    break;
  }

  if (encryptedKey === null) return failure(DECRYPT_ERRORS.unsupportedEncryption);

  // dataIntegrity 는 선택 사항이다. 있으면 HMAC 으로 payload 변조를 확인한다.
  const integrityMatch = DATA_INTEGRITY_TAG.exec(xml);
  const integrity =
    integrityMatch === null
      ? null
      : {
          key: readBase64(integrityMatch[1], 'encryptedHmacKey', 128),
          value: readBase64(integrityMatch[1], 'encryptedHmacValue', 128),
        };

  return { ok: true, kind: 'agile', keyData, encryptedKey, integrity };
}

/**
 * 비밀번호 -> 해시 반복(spin) 결과.
 *
 * 이 부분이 유일하게 비싼 계산이라 블록 키마다 다시 돌리지 않고 한 번만 한다.
 */
function spinPassword({ algorithm, salt, spinCount }, password) {
  let digest = hash(algorithm, salt, password);
  for (let i = 0; i < spinCount; i += 1) {
    digest = hash(algorithm, uint32le(i), digest);
  }
  return digest;
}

function agileBlockKey({ algorithm, keyBytes }, spun, blockKey) {
  return fit(hash(algorithm, spun, blockKey), keyBytes, 0x36);
}

function cbcDecrypt(key, iv, data) {
  const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function ecbDecrypt(key, data) {
  const decipher = createDecipheriv(`aes-${key.length * 8}-ecb`, key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** 블록 암호에 넣기 전에 길이가 블록 배수인지 본다. 아니면 깨진 파일이다. */
function blockAligned(data, blockSize) {
  return data.length > 0 && data.length % blockSize === 0;
}

function agileSecretKey(descriptor, password) {
  const { encryptedKey } = descriptor;
  const spun = spinPassword(encryptedKey, password);
  const iv = fit(encryptedKey.salt, encryptedKey.blockSize, 0x36);

  if (
    !blockAligned(encryptedKey.verifierInput, encryptedKey.blockSize) ||
    !blockAligned(encryptedKey.verifierValue, encryptedKey.blockSize) ||
    !blockAligned(encryptedKey.keyValue, encryptedKey.blockSize)
  ) {
    return failure(DECRYPT_ERRORS.decryptFailed);
  }

  // password verifier: 임의값을 풀고, 그 해시가 따로 저장된 해시와 같은지 본다.
  // payload 는 아직 건드리지 않는다.
  const inputKey = agileBlockKey(encryptedKey, spun, BLOCK_KEY.verifierHashInput);
  const valueKey = agileBlockKey(encryptedKey, spun, BLOCK_KEY.verifierHashValue);

  let verifier;
  let expected;
  try {
    verifier = cbcDecrypt(inputKey, iv, encryptedKey.verifierInput);
    expected = cbcDecrypt(valueKey, iv, encryptedKey.verifierValue);
  } catch {
    return failure(DECRYPT_ERRORS.decryptFailed);
  }

  const actual = hash(encryptedKey.algorithm, verifier);
  // 저장된 해시가 해시 길이보다 짧으면 비밀번호 문제가 아니라 깨진 기술자다.
  // 그 둘을 한 코드로 뭉뚱그리지 않는다.
  if (expected.length < actual.length) return failure(DECRYPT_ERRORS.decryptFailed);
  if (!equals(actual, expected.subarray(0, actual.length))) {
    return failure(DECRYPT_ERRORS.wrongPassword);
  }

  let secret;
  try {
    const wrapKey = agileBlockKey(encryptedKey, spun, BLOCK_KEY.keyValue);
    secret = cbcDecrypt(wrapKey, iv, encryptedKey.keyValue).subarray(
      0,
      descriptor.keyData.keyBytes,
    );
  } catch {
    return failure(DECRYPT_ERRORS.decryptFailed);
  }

  if (secret.length !== descriptor.keyData.keyBytes) {
    return failure(DECRYPT_ERRORS.decryptFailed);
  }
  return { ok: true, secret };
}

/**
 * dataIntegrity(HMAC) 확인.
 *
 * 비밀번호를 모르는 쪽이 EncryptedPackage 를 바꿔치기했는지 본다. 비밀번호
 * 검증과는 다른 이야기라 결과를 불리언으로만 돌려주고, 판단은 호출자에게
 * 맡긴다(여기서 던지면 "무결성" 과 "복호화 실패" 가 섞인다).
 *
 * @returns {'ok'|'mismatch'|'absent'}
 */
export function verifyDataIntegrity(descriptor, secret, packageStream) {
  const { integrity, keyData } = descriptor;
  if (integrity === null || integrity.key === null || integrity.value === null) {
    return 'absent';
  }
  try {
    const keyIv = fit(
      hash(keyData.algorithm, keyData.salt, BLOCK_KEY.hmacKey),
      keyData.blockSize,
      0x36,
    );
    const valueIv = fit(
      hash(keyData.algorithm, keyData.salt, BLOCK_KEY.hmacValue),
      keyData.blockSize,
      0x36,
    );
    if (
      !blockAligned(integrity.key, keyData.blockSize) ||
      !blockAligned(integrity.value, keyData.blockSize)
    ) {
      return 'mismatch';
    }

    const hmacKey = cbcDecrypt(secret, keyIv, integrity.key).subarray(0, keyData.digestBytes);
    const stored = cbcDecrypt(secret, valueIv, integrity.value).subarray(0, keyData.digestBytes);
    // HMAC 대상은 EncryptedPackage 스트림 **전체**다(앞 8바이트 크기 필드 포함).
    const actual = createHmac(keyData.algorithm, hmacKey).update(packageStream).digest();
    return equals(actual, stored) ? 'ok' : 'mismatch';
  } catch {
    return 'mismatch';
  }
}

function decryptAgilePackage(descriptor, secret, packageStream) {
  const { keyData } = descriptor;
  const declared = readDeclaredSize(packageStream);
  if (declared === null) return failure(DECRYPT_ERRORS.tooLarge);

  const body = packageStream.subarray(8);
  if (!blockAligned(body, keyData.blockSize)) return failure(DECRYPT_ERRORS.decryptFailed);
  // 선언된 크기가 실제 암호문보다 크면 그 값은 거짓말이다. 할당하기 전에 본다.
  if (declared > body.length) return failure(DECRYPT_ERRORS.decryptFailed);

  const out = Buffer.alloc(declared);
  let written = 0;
  let segment = 0;
  try {
    for (let offset = 0; offset < body.length && written < declared; offset += SEGMENT_BYTES) {
      const chunk = body.subarray(offset, Math.min(offset + SEGMENT_BYTES, body.length));
      const iv = fit(
        hash(keyData.algorithm, keyData.salt, uint32le(segment)),
        keyData.blockSize,
        0x36,
      );
      const plain = cbcDecrypt(secret, iv, chunk);
      written += plain.copy(out, written, 0, Math.min(plain.length, declared - written));
      segment += 1;
    }
  } catch {
    return failure(DECRYPT_ERRORS.decryptFailed);
  }

  if (written !== declared) return failure(DECRYPT_ERRORS.decryptFailed);
  return { ok: true, data: out };
}

// ── standard encryption (버전 3.2 / 4.2) ───────────────────────────────────

function parseStandard(info) {
  if (info.length < 12) return failure(DECRYPT_ERRORS.corruptContainer);
  const headerSize = info.readUInt32LE(8);
  // 헤더 크기는 파일이 적어 오는 값이다. 그대로 믿고 오프셋을 계산하지 않는다.
  if (headerSize < 32 || headerSize > info.length - 12) {
    return failure(DECRYPT_ERRORS.corruptContainer);
  }

  const header = info.subarray(12, 12 + headerSize);

  // Flags 는 두 군데에 같은 값으로 적힌다: 스트림 머리(오프셋 4)와
  // EncryptionHeader 의 첫 4바이트. 어느 쪽이든 fExternal 이 서 있으면 키를
  // 바깥에서 받는 파일이다. 버전만 보고 "비밀번호 방식" 이라 단정하면 엉뚱한
  // 키를 만들어 "비밀번호가 틀렸다" 고 답하게 된다 — 사실이 아닌 답이다.
  if ((((info.readUInt32LE(4) | header.readUInt32LE(0)) & FLAG_EXTERNAL) >>> 0) !== 0) {
    return failure(DECRYPT_ERRORS.unsupportedEncryption);
  }

  const algId = header.readUInt32LE(8);
  const algIdHash = header.readUInt32LE(12);
  const keyBits = header.readUInt32LE(16);

  // AlgIDHash 0 은 "기본값"(SHA-1)이고 0x8004 가 SHA-1 이다. 그 밖은 모른다.
  if (algIdHash !== 0 && algIdHash !== 0x8004) {
    return failure(DECRYPT_ERRORS.unsupportedEncryption);
  }

  let keyBytes;
  if (algId === 0) {
    // AlgID 0 은 "KeySize 를 보라"는 뜻이다.
    keyBytes = keyBits / 8;
  } else {
    const known = STANDARD_ALG_ID.get(algId);
    if (known === undefined) return failure(DECRYPT_ERRORS.unsupportedEncryption);
    keyBytes = known;
    if (keyBits !== 0 && keyBits !== known * 8) {
      return failure(DECRYPT_ERRORS.unsupportedEncryption);
    }
  }
  if (keyBytes !== 16 && keyBytes !== 24 && keyBytes !== 32) {
    return failure(DECRYPT_ERRORS.unsupportedEncryption);
  }

  // EncryptionVerifier 는 헤더 바로 뒤에 붙는다.
  let at = 12 + headerSize;
  if (at + 4 > info.length) return failure(DECRYPT_ERRORS.corruptContainer);
  const saltSize = info.readUInt32LE(at);
  at += 4;
  if (saltSize !== 16) return failure(DECRYPT_ERRORS.unsupportedEncryption);
  if (at + saltSize + 16 + 4 > info.length) return failure(DECRYPT_ERRORS.corruptContainer);

  const salt = Buffer.from(info.subarray(at, at + saltSize));
  at += saltSize;
  const encryptedVerifier = Buffer.from(info.subarray(at, at + 16));
  at += 16;
  const verifierHashSize = info.readUInt32LE(at);
  at += 4;
  if (verifierHashSize !== 20) return failure(DECRYPT_ERRORS.unsupportedEncryption);
  // AES 는 해시(20바이트)를 블록 배수(32바이트)로 채워 저장한다.
  if (at + 32 > info.length) return failure(DECRYPT_ERRORS.corruptContainer);
  const encryptedVerifierHash = Buffer.from(info.subarray(at, at + 32));

  return {
    ok: true,
    kind: 'standard',
    keyBytes,
    salt,
    encryptedVerifier,
    encryptedVerifierHash,
    integrity: null,
  };
}

/**
 * MS-OFFCRYPTO 2.3.4.7 — standard encryption 의 비밀번호 해시(H_final).
 * salt ‖ password 를 해시하고 50,000회 반복한 뒤 블록 번호 0 을 한 번 더 붙인다.
 *
 * ⚠️ `password` 는 UTF-16LE 바이트다. 이 함수는 그것을 읽기만 하고 어디에도
 *    남기지 않는다. 반환값은 해시라서 원문을 되돌릴 수 없다.
 *
 * export 하는 이유는 하나다: 실제 Microsoft Office 가 만든 파일에서 뽑은
 * 기지답(known answer) 벡터로 이 단계만 따로 확인하기 위해서다
 * (test/xlsx-crypto-known-answer.test.mjs). 앱 코드는 쓰지 않는다.
 */
export function standardPasswordHash(salt, password) {
  let digest = hash('sha1', salt, password);
  for (let i = 0; i < 50000; i += 1) {
    digest = hash('sha1', uint32le(i), digest);
  }
  return hash('sha1', digest, uint32le(0));
}

/**
 * MS-OFFCRYPTO 2.3.4.7 — H_final 을 X1/X2 로 펼쳐 AES 키 길이만큼 자른다.
 *
 * `standardPasswordHash` 와 같은 이유로 export 한다(기지답 시험).
 */
export function standardEncryptionKey(finalHash, keyBytes) {
  const x1 = Buffer.alloc(64, 0x36);
  const x2 = Buffer.alloc(64, 0x5c);
  for (let i = 0; i < finalHash.length; i += 1) {
    x1[i] ^= finalHash[i];
    x2[i] ^= finalHash[i];
  }
  return Buffer.concat([hash('sha1', x1), hash('sha1', x2)]).subarray(0, keyBytes);
}

/**
 * standard encryption 의 키 유도 + password verifier 확인.
 *
 * 기지답 시험이 verifier 경로까지 보도록 export 한다. 던지지 않는다.
 */
export function standardSecretKey(descriptor, password) {
  const key = standardEncryptionKey(
    standardPasswordHash(descriptor.salt, password),
    descriptor.keyBytes,
  );

  let verifier;
  let storedHash;
  try {
    verifier = ecbDecrypt(key, descriptor.encryptedVerifier);
    storedHash = ecbDecrypt(key, descriptor.encryptedVerifierHash);
  } catch {
    return failure(DECRYPT_ERRORS.decryptFailed);
  }

  const actual = hash('sha1', verifier);
  if (!equals(actual, storedHash.subarray(0, actual.length))) {
    return failure(DECRYPT_ERRORS.wrongPassword);
  }
  return { ok: true, secret: key };
}

function decryptStandardPackage(secret, packageStream) {
  const declared = readDeclaredSize(packageStream);
  if (declared === null) return failure(DECRYPT_ERRORS.tooLarge);

  const body = packageStream.subarray(8);
  // ECB 는 블록 단위다. 꼬리의 남는 바이트는 암호문이 아니므로 잘라 낸다.
  const usable = body.subarray(0, body.length - (body.length % 16));
  if (usable.length === 0 || declared > usable.length) {
    return failure(DECRYPT_ERRORS.decryptFailed);
  }

  try {
    return { ok: true, data: ecbDecrypt(secret, usable).subarray(0, declared) };
  } catch {
    return failure(DECRYPT_ERRORS.decryptFailed);
  }
}

// ── 공통 ───────────────────────────────────────────────────────────────────

/**
 * EncryptedPackage 앞 8바이트의 "풀었을 때 크기" 를 읽는다.
 *
 * 상한을 넘거나 64비트 상위가 있으면 null 을 돌려준다 — **할당하기 전에**
 * 걸러야 한다. 풀어 놓고 재는 것은 이미 메모리를 다 쓴 뒤라 방어가 아니다
 * (lib/xlsx/zip.mjs 가 압축 폭탄에 대해 같은 순서를 지킨다).
 */
function readDeclaredSize(packageStream) {
  if (packageStream.length < 8) return null;
  const low = packageStream.readUInt32LE(0);
  const high = packageStream.readUInt32LE(4);
  if (high !== 0) return null;
  if (low === 0 || low > MAX_DECRYPTED_BYTES) return null;
  return low;
}

/**
 * EncryptionInfo 스트림의 버전을 읽어 어느 방식인지 정한다.
 * @returns {{ok: true, ...}|{ok: false, error: string}}
 */
export function parseEncryptionInfo(info) {
  if (!Buffer.isBuffer(info) || info.length < 8) {
    return failure(DECRYPT_ERRORS.corruptContainer);
  }
  const major = info.readUInt16LE(0);
  const minor = info.readUInt16LE(2);

  if (major === 4 && minor === 4) return parseAgile(info);
  if ((major === 2 || major === 3 || major === 4) && minor === 2) return parseStandard(info);
  // 4.3(Extensible) · x.1(RC4) 등. 조용히 잘못 읽느니 거절한다.
  return failure(DECRYPT_ERRORS.unsupportedEncryption);
}

/**
 * 암호가 걸린 OOXML 버퍼를 풀어서 ZIP 바이트를 돌려준다.
 *
 * 던지지 않는다. 실패는 전부 `{ ok: false, error }` 다.
 *
 * @param {Buffer} buffer OLE2 복합 문서 전체 바이트
 * @param {string} password 사용자가 이번 요청에 입력한 비밀번호. 저장하지 않는다.
 * @returns {{ok: true, data: Buffer, kind: 'agile'|'standard',
 *            integrity: 'ok'|'mismatch'|'absent'}
 *          |{ok: false, error: string}}
 */
export function decryptOoxml(buffer, password) {
  if (!Buffer.isBuffer(buffer)) return failure(DECRYPT_ERRORS.corruptContainer);
  if (!checkPassword(password)) return failure(DECRYPT_ERRORS.passwordRejected);

  let info;
  let packageStream;
  try {
    const cfb = openCfb(buffer);
    if (!cfb.has(ENCRYPTION_INFO_STREAM) || !cfb.has(ENCRYPTED_PACKAGE_STREAM)) {
      return failure(DECRYPT_ERRORS.notEncrypted);
    }
    info = cfb.read(ENCRYPTION_INFO_STREAM, { maxBytes: MAX_ENCRYPTION_INFO_BYTES });
    // 스트림 크기 상한은 cfb.read 가 할당 전에 본다.
    packageStream = cfb.read(ENCRYPTED_PACKAGE_STREAM);
  } catch {
    // OLE2 파서의 에러 객체는 읽지 않는다. 구조적 사유 하나로 묶는다.
    return failure(DECRYPT_ERRORS.corruptContainer);
  }

  const descriptor = parseEncryptionInfo(info);
  if (descriptor.ok !== true) return descriptor;

  const secret = descriptor.kind === 'agile'
    ? agileSecretKey(descriptor, passwordBytes(password))
    : standardSecretKey(descriptor, passwordBytes(password));
  if (secret.ok !== true) return secret;

  const decrypted = descriptor.kind === 'agile'
    ? decryptAgilePackage(descriptor, secret.secret, packageStream)
    : decryptStandardPackage(secret.secret, packageStream);
  if (decrypted.ok !== true) return decrypted;

  const integrity =
    descriptor.kind === 'agile'
      ? verifyDataIntegrity(descriptor, secret.secret, packageStream)
      : 'absent';

  return { ok: true, data: decrypted.data, kind: descriptor.kind, integrity };
}
