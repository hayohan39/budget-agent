// ⚠️ 테스트 전용. **lib/ 에 들여놓지 않는다.**
//
// ECMA-376 암호화 xlsx 를 만드는 쪽(encryptor)이다. 앱은 복호화만 하면 되므로
// 이 코드는 런타임에 필요 없다. 여기 있는 이유는 하나뿐이다: 진짜 토스 파일이
// 아직 없어서, 왕복(평문 -> 암호화 -> 복호화 -> 평문)으로라도 복호화기를
// 확인하려면 암호화하는 쪽이 필요하다.
//
// ⚠️ 이 왕복이 증명하는 것은 **자기 일관성**이지, 엑셀/토스가 실제로 내보내는
//    파일과의 호환성이 아니다. 스펙 해석이 같은 방향으로 틀렸다면 왕복은
//    그대로 통과한다. 진짜 파일이 들어오면 그때 다시 확인해야 한다.
//
// 구현 범위는 lib/xlsx/crypto.mjs 가 읽는 것과 같다.
//   - agile (4.4): AES-CBC + 선택한 해시, dataIntegrity(HMAC) 포함
//   - standard (4.2 기본 · 3.2 선택): AES-ECB + SHA-1
import { Buffer } from 'node:buffer';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

const SECTOR_BYTES = 512;
const MINI_SECTOR_BYTES = 64;
const MINI_CUTOFF = 4096;
const DIRECTORY_ENTRY_BYTES = 128;

const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const FREESECT = 0xffffffff;
const NOSTREAM = 0xffffffff;

const BLOCK_KEY = {
  verifierHashInput: Buffer.from('fea7d2763b4b9e79', 'hex'),
  verifierHashValue: Buffer.from('d7aa0f6d3061344e', 'hex'),
  keyValue: Buffer.from('146e0be7abacd0d6', 'hex'),
  hmacKey: Buffer.from('5fb2ad010cb9e1f6', 'hex'),
  hmacValue: Buffer.from('a0677f02b22c84a0', 'hex'),
};

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

function fit(bytes, size, pad) {
  if (bytes.length === size) return bytes;
  if (bytes.length > size) return bytes.subarray(0, size);
  return Buffer.concat([bytes, Buffer.alloc(size - bytes.length, pad)]);
}

/** 블록 배수로 0 패딩. 스펙이 정한 패딩 방식이다. */
function padBlocks(bytes, blockSize) {
  const remainder = bytes.length % blockSize;
  if (remainder === 0) return bytes;
  return Buffer.concat([bytes, Buffer.alloc(blockSize - remainder)]);
}

function cbcEncrypt(key, iv, data) {
  const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function ecbEncrypt(key, data) {
  const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

// ── OLE2/CFB 쓰기 ──────────────────────────────────────────────────────────

const OBJECT_TYPE_STORAGE = 1;
const OBJECT_TYPE_STREAM = 2;
const OBJECT_TYPE_ROOT = 5;

/**
 * 디렉터리 엔트리를 깊이 우선으로 펼친다. 배열 위치가 곧 디렉터리 인덱스라서,
 * 스토리지의 자식은 그 스토리지 **바로 뒤** 그리고 뒤따르는 형제보다 **앞**에
 * 놓인다. 하위 스토리지의 스트림이 루트의 같은 이름 스트림보다 디렉터리에서
 * 먼저 나오는 배치를 만들 수 있어야 해서 이 순서를 쓴다.
 *
 * @returns {number[]} 이 층 형제들의 디렉터리 인덱스
 */
function flattenDirectory(items, nodes) {
  const indices = [];
  for (const item of items) {
    indices.push(nodes.length);
    if (Array.isArray(item.storage)) {
      const node = {
        name: item.name,
        type: OBJECT_TYPE_STORAGE,
        data: null,
        start: 0,
        size: 0,
        children: [],
      };
      nodes.push(node);
      node.children = flattenDirectory(item.storage, nodes);
    } else {
      nodes.push({
        name: item.name,
        type: OBJECT_TYPE_STREAM,
        data: item.data,
        start: null,
        size: item.data.length,
        children: [],
      });
    }
  }
  return indices;
}

/**
 * 스트림 목록으로 OLE2 복합 문서(v3, 512바이트 섹터)를 만든다.
 *
 * 4096바이트 미만인 스트림은 미니 스트림에, 그 이상은 일반 섹터 체인에 둔다 —
 * 실제 파일과 같은 배치라서 리더의 두 경로가 모두 걸린다.
 *
 * 항목은 스트림(`{ name, data }`) 이거나 스토리지(`{ name, storage: [...] }`)다.
 * 스토리지는 실제 파일의 `\u0006DataSpaces` 처럼 자식을 품는다 — 같은 이름이
 * 층을 달리해 겹치는 컨테이너를 만들 수 있어야 해서 쓴다.
 *
 * @param {Array<{name: string, data?: Buffer, storage?: Array<object>}>} streams
 * @returns {Buffer}
 */
export function buildCfb(streams) {
  const sectors = [];
  const fat = [];

  /** 데이터를 512바이트 섹터 체인으로 붙이고 시작 섹터 번호를 돌려준다. */
  function allocate(data) {
    if (data.length === 0) return ENDOFCHAIN;
    const count = Math.ceil(data.length / SECTOR_BYTES);
    const start = sectors.length;
    for (let i = 0; i < count; i += 1) {
      const chunk = Buffer.alloc(SECTOR_BYTES);
      data.copy(chunk, 0, i * SECTOR_BYTES, Math.min(data.length, (i + 1) * SECTOR_BYTES));
      sectors.push(chunk);
      fat.push(sectors.length);
    }
    fat[start + count - 1] = ENDOFCHAIN;
    return start;
  }

  // 0. 디렉터리 엔트리를 먼저 펼친다(루트가 0번).
  const root = {
    name: 'Root Entry',
    type: OBJECT_TYPE_ROOT,
    data: null,
    start: 0,
    size: 0,
    children: [],
  };
  const nodes = [root];
  root.children = flattenDirectory(streams, nodes);
  const streamNodes = nodes.filter((node) => node.type === OBJECT_TYPE_STREAM);

  // 1. 미니 스트림에 들어갈 것들을 먼저 모은다.
  const miniChunks = [];
  const miniFat = [];
  let miniSectorCount = 0;

  for (const node of streamNodes) {
    if (node.size >= MINI_CUTOFF || node.size === 0) continue;
    const count = Math.ceil(node.size / MINI_SECTOR_BYTES);
    const start = miniSectorCount;
    for (let i = 0; i < count; i += 1) {
      const chunk = Buffer.alloc(MINI_SECTOR_BYTES);
      node.data.copy(
        chunk,
        0,
        i * MINI_SECTOR_BYTES,
        Math.min(node.size, (i + 1) * MINI_SECTOR_BYTES),
      );
      miniChunks.push(chunk);
      miniFat.push(start + i + 1);
    }
    miniFat[start + count - 1] = ENDOFCHAIN;
    miniSectorCount += count;
    node.start = start;
  }

  const miniStream = Buffer.concat(miniChunks);

  // 2. 일반 섹터에 들어갈 스트림.
  for (const node of streamNodes) {
    if (node.start === null) node.start = allocate(node.data);
  }

  // 3. 미니 스트림 본체는 루트 엔트리의 체인이다.
  root.start = allocate(miniStream);
  root.size = miniStream.length;

  // 4. 디렉터리. 읽는 쪽(lib/xlsx/cfb.mjs)은 트리를 타지 않지만, 아주 엉터리로
  //    두지는 않는다: 부모는 child 로 첫 자식만 가리키고, 형제는 right 로 한 줄
  //    이어지는 퇴화 트리로 만든다.
  const left = new Array(nodes.length).fill(NOSTREAM);
  const right = new Array(nodes.length).fill(NOSTREAM);
  const child = new Array(nodes.length).fill(NOSTREAM);
  for (let i = 0; i < nodes.length; i += 1) {
    const kids = nodes[i].children;
    if (kids.length > 0) child[i] = kids[0];
    for (let k = 0; k + 1 < kids.length; k += 1) right[kids[k]] = kids[k + 1];
  }

  const perSector = SECTOR_BYTES / DIRECTORY_ENTRY_BYTES;
  const directoryEntryCount = Math.ceil(nodes.length / perSector) * perSector;
  const directory = Buffer.alloc(directoryEntryCount * DIRECTORY_ENTRY_BYTES);
  for (let i = 0; i < directoryEntryCount; i += 1) {
    const at = i * DIRECTORY_ENTRY_BYTES;
    const isUsed = i < nodes.length;
    directory.writeUInt32LE(isUsed ? left[i] : NOSTREAM, at + 68);
    directory.writeUInt32LE(isUsed ? right[i] : NOSTREAM, at + 72);
    directory.writeUInt32LE(isUsed ? child[i] : NOSTREAM, at + 76);
    if (!isUsed) continue;

    const node = nodes[i];
    const name = Buffer.from(node.name, 'utf16le');
    name.copy(directory, at);
    directory.writeUInt16LE(name.length + 2, at + 64);
    directory.writeUInt8(node.type, at + 66);
    directory.writeUInt8(1, at + 67); // black
    directory.writeUInt32LE(node.start, at + 116);
    directory.writeUInt32LE(node.size, at + 120);
  }
  const directoryStart = allocate(directory);

  // 5. 미니 FAT.
  let miniFatStart = ENDOFCHAIN;
  let miniFatSectorCount = 0;
  if (miniFat.length > 0) {
    const perFatSector = SECTOR_BYTES / 4;
    miniFatSectorCount = Math.ceil(miniFat.length / perFatSector);
    const table = Buffer.alloc(miniFatSectorCount * SECTOR_BYTES, 0xff);
    for (let i = 0; i < miniFat.length; i += 1) table.writeUInt32LE(miniFat[i], i * 4);
    miniFatStart = allocate(table);
  }

  // 6. FAT. FAT 섹터 자신도 FAT 안에 표시되므로 개수가 수렴할 때까지 센다.
  const perFatSector = SECTOR_BYTES / 4;
  let fatSectorCount = 1;
  for (let i = 0; i < 8; i += 1) {
    const needed = Math.ceil((sectors.length + fatSectorCount) / perFatSector);
    if (needed === fatSectorCount) break;
    fatSectorCount = needed;
  }

  const fatSectorIds = [];
  for (let i = 0; i < fatSectorCount; i += 1) {
    fatSectorIds.push(sectors.length + i);
    fat.push(FATSECT);
  }
  for (let i = 0; i < fatSectorCount; i += 1) sectors.push(Buffer.alloc(SECTOR_BYTES));

  const fatTable = Buffer.alloc(fatSectorCount * SECTOR_BYTES, 0xff);
  for (let i = 0; i < fat.length; i += 1) fatTable.writeUInt32LE(fat[i], i * 4);
  for (let i = 0; i < fatSectorCount; i += 1) {
    fatTable.copy(sectors[fatSectorIds[i]], 0, i * SECTOR_BYTES, (i + 1) * SECTOR_BYTES);
  }

  // 7. 헤더.
  const header = Buffer.alloc(SECTOR_BYTES, 0);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header, 0);
  header.writeUInt16LE(0x003e, 24); // minor version
  header.writeUInt16LE(3, 26); // major version
  header.writeUInt16LE(0xfffe, 28); // byte order
  header.writeUInt16LE(9, 30); // sector shift (512)
  header.writeUInt16LE(6, 32); // mini sector shift (64)
  header.writeUInt32LE(0, 40); // directory sector count (v3 는 0)
  header.writeUInt32LE(fatSectorCount, 44);
  header.writeUInt32LE(directoryStart, 48);
  header.writeUInt32LE(MINI_CUTOFF, 56);
  header.writeUInt32LE(miniFatStart, 60);
  header.writeUInt32LE(miniFatSectorCount, 64);
  header.writeUInt32LE(ENDOFCHAIN, 68); // DIFAT 시작 (헤더 109개로 충분)
  header.writeUInt32LE(0, 72); // DIFAT 섹터 수
  for (let i = 0; i < 109; i += 1) {
    header.writeUInt32LE(i < fatSectorCount ? fatSectorIds[i] : FREESECT, 76 + i * 4);
  }

  return Buffer.concat([header, ...sectors]);
}

// ── agile (4.4) ────────────────────────────────────────────────────────────

const HASH_DIGEST_BYTES = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
const HASH_XML_NAME = { sha1: 'SHA1', sha256: 'SHA256', sha384: 'SHA384', sha512: 'SHA512' };

/**
 * 평문 OOXML(ZIP) 버퍼를 agile 방식으로 암호화한다.
 *
 * @param {Buffer} plain
 * @param {string} password
 * @param {{hash?: string, keyBits?: number, spinCount?: number,
 *          dataIntegrity?: boolean, corruptIntegrity?: boolean,
 *          declaredSize?: number}} [options]
 * @returns {Buffer} OLE2 복합 문서
 */
export function encryptAgile(plain, password, options = {}) {
  const algorithm = options.hash ?? 'sha512';
  const keyBits = options.keyBits ?? 256;
  const spinCount = options.spinCount ?? 100;
  const digestBytes = HASH_DIGEST_BYTES[algorithm];
  const keyBytes = keyBits / 8;
  const blockSize = 16;

  const keySalt = randomBytes(16); // keyEncryptor 의 salt
  const dataSalt = randomBytes(16); // keyData 의 salt
  const secret = randomBytes(keyBytes);
  const passwordUtf16 = Buffer.from(password, 'utf16le');

  let spun = hash(algorithm, keySalt, passwordUtf16);
  for (let i = 0; i < spinCount; i += 1) spun = hash(algorithm, uint32le(i), spun);
  const derive = (blockKey) => fit(hash(algorithm, spun, blockKey), keyBytes, 0x36);

  const iv = fit(keySalt, blockSize, 0x36);
  const verifierInput = randomBytes(16);
  const encryptedVerifierHashInput = cbcEncrypt(
    derive(BLOCK_KEY.verifierHashInput),
    iv,
    verifierInput,
  );
  const encryptedVerifierHashValue = cbcEncrypt(
    derive(BLOCK_KEY.verifierHashValue),
    iv,
    padBlocks(hash(algorithm, verifierInput), blockSize),
  );
  const encryptedKeyValue = cbcEncrypt(
    derive(BLOCK_KEY.keyValue),
    iv,
    padBlocks(secret, blockSize),
  );

  // payload: 4096바이트 세그먼트마다 IV 가 다르다.
  const chunks = [];
  for (let offset = 0, segment = 0; offset < plain.length; offset += 4096, segment += 1) {
    const slice = padBlocks(plain.subarray(offset, offset + 4096), blockSize);
    const segmentIv = fit(hash(algorithm, dataSalt, uint32le(segment)), blockSize, 0x36);
    chunks.push(cbcEncrypt(secret, segmentIv, slice));
  }
  const size = Buffer.alloc(8);
  // 선언된 크기를 일부러 거짓으로 적을 수 있어야 한다(상한 검사 시험용).
  size.writeUInt32LE(options.declaredSize ?? plain.length, 0);
  const encryptedPackage = Buffer.concat([size, ...chunks]);

  let integrityXml = '';
  if (options.dataIntegrity !== false) {
    const hmacKey = randomBytes(digestBytes);
    const keyIv = fit(hash(algorithm, dataSalt, BLOCK_KEY.hmacKey), blockSize, 0x36);
    const valueIv = fit(hash(algorithm, dataSalt, BLOCK_KEY.hmacValue), blockSize, 0x36);
    const hmacValue = createHmac(algorithm, hmacKey).update(encryptedPackage).digest();
    // 일부러 틀린 HMAC 을 넣어 무결성 경고 경로를 볼 수 있어야 한다.
    const stored = options.corruptIntegrity === true ? randomBytes(digestBytes) : hmacValue;
    const encryptedHmacKey = cbcEncrypt(secret, keyIv, padBlocks(hmacKey, blockSize));
    const encryptedHmacValue = cbcEncrypt(secret, valueIv, padBlocks(stored, blockSize));
    integrityXml =
      `<dataIntegrity encryptedHmacKey="${encryptedHmacKey.toString('base64')}"` +
      ` encryptedHmacValue="${encryptedHmacValue.toString('base64')}"/>`;
  }

  const hashName = HASH_XML_NAME[algorithm];
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption"' +
    ' xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryptor/password">' +
    `<keyData saltSize="16" blockSize="16" keyBits="${keyBits}" hashSize="${digestBytes}"` +
    ` cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="${hashName}"` +
    ` saltValue="${dataSalt.toString('base64')}"/>` +
    integrityXml +
    '<keyEncryptors><keyEncryptor' +
    ' uri="http://schemas.microsoft.com/office/2006/keyEncryptor/password">' +
    `<p:encryptedKey spinCount="${spinCount}" saltSize="16" blockSize="16"` +
    ` keyBits="${keyBits}" hashSize="${digestBytes}" cipherAlgorithm="AES"` +
    ` cipherChaining="ChainingModeCBC" hashAlgorithm="${hashName}"` +
    ` saltValue="${keySalt.toString('base64')}"` +
    ` encryptedVerifierHashInput="${encryptedVerifierHashInput.toString('base64')}"` +
    ` encryptedVerifierHashValue="${encryptedVerifierHashValue.toString('base64')}"` +
    ` encryptedKeyValue="${encryptedKeyValue.toString('base64')}"/>` +
    '</keyEncryptor></keyEncryptors></encryption>';

  const info = Buffer.alloc(8);
  info.writeUInt16LE(4, 0);
  info.writeUInt16LE(4, 2);
  info.writeUInt32LE(0x40, 4);

  return buildCfb([
    { name: 'EncryptionInfo', data: Buffer.concat([info, Buffer.from(xml, 'utf8')]) },
    { name: 'EncryptedPackage', data: encryptedPackage },
  ]);
}

// ── standard (4.2 / 3.2) ───────────────────────────────────────────────────

/**
 * 평문 OOXML(ZIP) 버퍼를 standard 방식(AES-ECB + SHA-1)으로 암호화한다.
 *
 * 기본값은 **4.2** 다. 실제 토스뱅크 명세서를 구조만 들여다본 결과가 4.2 /
 * AES-128 / SHA-1 이었다(`AlgID=0x660E`, `AlgIDHash=0x8004`, `KeySize=128`,
 * `ProviderType=24`, `SaltSize=16`, `VerifierHashSize=20`). 왕복 시험의 기본이
 * 실제 파일과 같은 버전을 쓰도록 여기서 4.2 를 낸다. 3.2 도 스펙상 유효하고
 * 복호화기가 받으므로 `version: [3, 2]` 로 따로 시험한다.
 *
 * @param {Buffer} plain
 * @param {string} password
 * @param {{keyBits?: number, version?: [number, number]}} [options]
 * @returns {Buffer} OLE2 복합 문서
 */
export function encryptStandard(plain, password, options = {}) {
  const [major, minor] = options.version ?? [4, 2];
  const keyBits = options.keyBits ?? 256;
  const keyBytes = keyBits / 8;
  const algId = { 16: 0x660e, 24: 0x660f, 32: 0x6610 }[keyBytes];

  const salt = randomBytes(16);
  const passwordUtf16 = Buffer.from(password, 'utf16le');

  let digest = hash('sha1', salt, passwordUtf16);
  for (let i = 0; i < 50000; i += 1) digest = hash('sha1', uint32le(i), digest);
  digest = hash('sha1', digest, uint32le(0));

  const x1 = Buffer.alloc(64, 0x36);
  const x2 = Buffer.alloc(64, 0x5c);
  for (let i = 0; i < digest.length; i += 1) {
    x1[i] ^= digest[i];
    x2[i] ^= digest[i];
  }
  const key = Buffer.concat([hash('sha1', x1), hash('sha1', x2)]).subarray(0, keyBytes);

  const verifier = randomBytes(16);
  const encryptedVerifier = ecbEncrypt(key, verifier);
  const encryptedVerifierHash = ecbEncrypt(key, padBlocks(hash('sha1', verifier), 16));

  const cspName = Buffer.from('Microsoft Enhanced RSA and AES Cryptographic Provider\u0000', 'utf16le');
  const encryptionHeader = Buffer.concat([
    uint32le(0x24), // Flags: fCryptoAPI | fAES
    uint32le(0), // SizeExtra
    uint32le(algId),
    uint32le(0x8004), // AlgIDHash: SHA-1
    uint32le(keyBits),
    uint32le(0x18), // ProviderType: AES
    uint32le(0),
    uint32le(0),
    cspName,
  ]);

  const version = Buffer.alloc(4);
  version.writeUInt16LE(major, 0);
  version.writeUInt16LE(minor, 2);

  const info = Buffer.concat([
    version, // EncryptionVersionInfo (기본 4.2 — 실제 파일과 같다)
    uint32le(0x24), // Flags
    uint32le(encryptionHeader.length),
    encryptionHeader,
    uint32le(16), // SaltSize
    salt,
    encryptedVerifier,
    uint32le(20), // VerifierHashSize
    encryptedVerifierHash,
  ]);

  const size = Buffer.alloc(8);
  size.writeUInt32LE(plain.length, 0);
  const encryptedPackage = Buffer.concat([size, ecbEncrypt(key, padBlocks(plain, 16))]);

  return buildCfb([
    { name: 'EncryptionInfo', data: info },
    { name: 'EncryptedPackage', data: encryptedPackage },
  ]);
}
