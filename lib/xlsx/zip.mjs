// 최소 ZIP 리더. xlsx 는 ZIP 컨테이너라서 이것만 있으면 파트를 꺼낼 수 있다.
//
// 왜 직접 쓰는가
//   - 새 npm 의존성을 늘리지 않는다(CLAUDE.md). 압축 해제는 `node:zlib` 의
//     inflateRawSync 하나로 끝난다.
//   - 스프레드시트 라이브러리는 값을 "정규화"한다. 이 파서가 반드시 구분해야 하는
//     성질(문자열로 들어온 날짜, 지수 표기 숫자, 세 종류의 빈 셀)이 그 과정에서
//     사라진다.
//
// 설계 메모
//   - 중앙 디렉터리(Central Directory)를 읽는다. 로컬 헤더를 앞에서부터 훑는
//     방식은 삭제된 엔트리나 데이터 디스크립터가 끼면 조용히 틀린다.
//   - 아카이브 버퍼는 한 번만 읽고, 엔트리 데이터는 subarray(복사 없는 뷰)로
//     가리킨다. 압축 해제 결과만 캐시한다.
//   - Zip64 는 지원하지 않는다. 다만 "조용히 잘못 읽는" 대신 크게 실패한다.
//   - 에러 메시지에 엔트리 "내용"을 넣지 않는다. 파트 이름과 위치만 알린다.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50; // End of Central Directory
const SIG_CD = 0x02014b50; // Central Directory file header
const SIG_LFH = 0x04034b50; // Local File Header
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;

const MAX_COMMENT = 0xffff;
const EOCD_MIN_SIZE = 22;
const ZIP64_MARKER_32 = 0xffffffff;
const ZIP64_MARKER_16 = 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/**
 * 엔트리 하나를 압축 해제했을 때 허용하는 최대 크기.
 *
 * 업로드 상한(lib/import/statement.mjs 의 MAX_FILE_BYTES, 4MB)은 **압축된**
 * 파일 크기만 묶는다. deflate 는 반복 데이터를 1000:1 로 줄이므로, 그 상한
 * 안에서도 400KB 엔트리가 400MB 로 부푸는 아카이브를 만들 수 있다(압축 폭탄).
 * 실제로 측정하면 398KB 짜리 zip 하나가 RSS 를 858MB 끌어올렸다.
 *
 * 64MiB 는 4MB xlsx 의 시트 XML 이 실제로 커질 수 있는 크기(수만 행)보다
 * 넉넉하면서, 서버리스 함수 메모리로 감당되는 값이다. fixture 는 10KB 다.
 */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

// ── CRC32 ──────────────────────────────────────────────────────────────────
// 직접 구현한다(표 생성 포함). zlib.crc32 는 Node 20.15+ 에서만 있고, 이 정도는
// 의존성을 따질 만큼의 코드가 아니다.
let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value;
  }
  crcTable = table;
  return table;
}

/**
 * @param {Buffer|Uint8Array} bytes
 * @returns {number} unsigned CRC32
 */
export function crc32(bytes) {
  const table = getCrcTable();
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

// ── EOCD ───────────────────────────────────────────────────────────────────

// 뒤에서부터 EOCD 서명을 찾는다. 코멘트 안에 서명과 같은 바이트열이 들어 있을 수
// 있으므로, 코멘트 길이가 실제 남은 바이트와 정확히 맞는 후보만 받아들인다.
function findEocd(buffer) {
  const min = Math.max(0, buffer.length - (EOCD_MIN_SIZE + MAX_COMMENT));
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== SIG_EOCD) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + EOCD_MIN_SIZE + commentLength === buffer.length) return offset;
  }
  throw new Error('ZIP 끝(EOCD) 레코드를 찾지 못했습니다. xlsx 파일이 아니거나 잘렸습니다.');
}

function assertNotZip64(buffer, eocdOffset, eocd) {
  // Zip64 EOCD 로케이터는 EOCD 바로 앞에 붙는다.
  const locatorOffset = eocdOffset - 20;
  const hasLocator =
    locatorOffset >= 0 && buffer.readUInt32LE(locatorOffset) === SIG_ZIP64_EOCD_LOCATOR;

  const overflowed =
    eocd.entryCount === ZIP64_MARKER_16 ||
    eocd.totalEntryCount === ZIP64_MARKER_16 ||
    eocd.directorySize === ZIP64_MARKER_32 ||
    eocd.directoryOffset === ZIP64_MARKER_32;

  if (hasLocator || overflowed) {
    // 여기서 그냥 진행하면 32비트 필드의 포화값(0xFFFFFFFF)을 진짜 오프셋으로
    // 믿고 엉뚱한 곳을 읽는다. 조용히 틀리느니 크게 실패한다.
    throw new Error('Zip64 아카이브는 지원하지 않습니다. (거래내역 xlsx 는 Zip64 가 아닙니다)');
  }
}

function readEocd(buffer) {
  const offset = findEocd(buffer);
  const eocd = {
    diskNumber: buffer.readUInt16LE(offset + 4),
    directoryDisk: buffer.readUInt16LE(offset + 6),
    entryCount: buffer.readUInt16LE(offset + 8),
    totalEntryCount: buffer.readUInt16LE(offset + 10),
    directorySize: buffer.readUInt32LE(offset + 12),
    directoryOffset: buffer.readUInt32LE(offset + 16),
    commentLength: buffer.readUInt16LE(offset + 20),
  };

  assertNotZip64(buffer, offset, eocd);

  if (eocd.diskNumber !== 0 || eocd.directoryDisk !== 0) {
    throw new Error('분할(multi-disk) ZIP 은 지원하지 않습니다.');
  }
  if (eocd.directoryOffset + eocd.directorySize > buffer.length) {
    throw new Error('중앙 디렉터리 위치가 파일 크기를 벗어납니다. 아카이브가 잘렸습니다.');
  }
  return eocd;
}

// ── 중앙 디렉터리 ───────────────────────────────────────────────────────────

function readCentralDirectory(buffer, eocd) {
  const entries = new Map();
  let offset = eocd.directoryOffset;
  const end = eocd.directoryOffset + eocd.directorySize;

  for (let index = 0; index < eocd.totalEntryCount; index += 1) {
    if (offset + 46 > end) {
      throw new Error(`중앙 디렉터리가 잘렸습니다. (${index + 1}번째 엔트리)`);
    }
    if (buffer.readUInt32LE(offset) !== SIG_CD) {
      throw new Error(`중앙 디렉터리 서명이 올바르지 않습니다. (${index + 1}번째 엔트리)`);
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    if ((flags & 0x0001) !== 0) {
      throw new Error(`암호화된 엔트리는 지원하지 않습니다: ${name}`);
    }
    if (
      compressedSize === ZIP64_MARKER_32 ||
      uncompressedSize === ZIP64_MARKER_32 ||
      localHeaderOffset === ZIP64_MARKER_32
    ) {
      throw new Error(`Zip64 확장 필드를 쓰는 엔트리는 지원하지 않습니다: ${name}`);
    }

    entries.set(name, {
      name,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

// 로컬 헤더의 이름/엑스트라 길이는 중앙 디렉터리의 값과 다를 수 있다. 데이터
// 시작 위치는 반드시 로컬 헤더에서 다시 계산한다.
function dataOffsetOf(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== SIG_LFH) {
    throw new Error(`로컬 헤더가 올바르지 않습니다: ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  return offset + 30 + nameLength + extraLength;
}

function inflateEntry(buffer, entry) {
  const start = dataOffsetOf(buffer, entry);
  const end = start + entry.compressedSize;
  if (end > buffer.length) {
    throw new Error(`엔트리 데이터가 파일 범위를 벗어납니다: ${entry.name}`);
  }

  // 압축을 풀기 **전에** 중앙 디렉터리가 선언한 크기부터 본다. 풀고 나서
  // 재는 것은 이미 메모리를 다 쓴 뒤라 방어가 아니다.
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new Error(`압축을 풀면 너무 커지는 엔트리입니다: ${entry.name}`);
  }

  // subarray 는 복사가 아니라 뷰다. 아카이브를 두 번 들고 있지 않는다.
  const raw = buffer.subarray(start, end);

  let data;
  if (entry.method === METHOD_STORED) {
    data = Buffer.from(raw); // 캐시에 남길 것이므로 여기서만 복사한다.
  } else if (entry.method === METHOD_DEFLATED) {
    // 선언된 크기는 아카이브를 만든 쪽이 적은 값이라 그대로 믿지 않는다.
    // zlib 에도 같은 상한을 걸어 두면, 헤더가 작게 거짓말해도 그 이상은
    // 풀지 않고 멈춘다(아래 크기 대조로 불일치가 다시 걸린다).
    try {
      data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch {
      // 에러 객체를 그대로 올리지 않는다. zlib 메시지에는 파트 내용의
      // 바이트가 섞여 나올 수 있다. 파트 이름만 알린다.
      throw new Error(`엔트리 압축을 풀지 못했습니다: ${entry.name}`);
    }
  } else {
    throw new Error(`지원하지 않는 압축 방식입니다: method=${entry.method} (${entry.name})`);
  }

  if (data.length !== entry.uncompressedSize) {
    throw new Error(`압축 해제 크기가 중앙 디렉터리와 다릅니다: ${entry.name}`);
  }
  if (crc32(data) !== entry.crc) {
    throw new Error(`CRC32 검증에 실패했습니다: ${entry.name}`);
  }
  return data;
}

/**
 * 메모리에 올라온 ZIP 아카이브를 연다.
 *
 * @param {Buffer} buffer 아카이브 전체 바이트. 호출자가 한 번만 읽어서 넘긴다.
 */
export function openZip(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('openZip 에는 Buffer 를 넘겨야 합니다.');
  }
  const eocd = readEocd(buffer);
  const entries = readCentralDirectory(buffer, eocd);
  const cache = new Map();

  return {
    /** 아카이브에 든 파트 이름 목록(중앙 디렉터리 순서). */
    names() {
      return [...entries.keys()];
    },
    has(name) {
      return entries.has(name);
    },
    /**
     * 파트 하나를 압축 해제해 돌려준다. CRC32 가 맞지 않으면 던진다.
     * @param {string} name
     * @returns {Buffer}
     */
    read(name) {
      const cached = cache.get(name);
      if (cached) return cached;

      const entry = entries.get(name);
      if (!entry) throw new Error(`아카이브에 없는 파트입니다: ${name}`);

      const data = inflateEntry(buffer, entry);
      cache.set(name, data);
      return data;
    },
    /** 파트를 UTF-8 텍스트로 읽는다. */
    readText(name) {
      return this.read(name).toString('utf8');
    },
  };
}

/**
 * 파일에서 ZIP 을 연다. 파일은 여기서 한 번만 읽는다.
 * @param {string} filePath
 */
export function openZipFile(filePath) {
  return openZip(readFileSync(filePath));
}
