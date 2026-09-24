// 최소 OLE2/CFB(Compound File Binary) 리더.
//
// 왜 있는가
//   암호가 걸린 OOXML(xlsx)은 ZIP 이 아니라 OLE2 복합 문서다. 그 안에 스트림이
//   두 개 들어 있고(`EncryptionInfo`, `EncryptedPackage`), 그 둘만 꺼내면
//   lib/xlsx/crypto.mjs 가 복호화해서 평범한 ZIP 버퍼를 돌려줄 수 있다.
//
// 무엇이 아닌가
//   범용 OLE2 라이브러리가 아니다. 쓰기 · 하위 스토리지 순회 · 속성 집합 ·
//   레드블랙 트리 탐색은 없다. 디렉터리 엔트리를 선형으로 훑어 **루트 스토리지
//   직계 자식** 중에서 이름으로 스트림 하나를 찾는 것까지가 전부다. 새 npm
//   의존성을 늘리지 않기 위한 최소 구현이다(CLAUDE.md).
//
// ── 이 모듈이 지키는 것 ────────────────────────────────────────────────────
//
//   1. **자원 상한을 먼저 본다.** 손상되었거나 악의적인 컨테이너는 섹터 체인을
//      고리 모양으로 만들거나(무한 루프), 스트림 크기를 터무니없이 크게 적어
//      (거대한 할당) 프로세스를 죽일 수 있다. 체인 길이 · 디렉터리 엔트리 수 ·
//      스트림 크기를 전부 묶고, **할당하기 전에** 선언된 크기부터 본다.
//   2. **에러 메시지에 스트림 내용을 넣지 않는다.** 구조적 위치만 알린다.
//   3. **이름은 한 곳에서만 찾는다.** 루트 스토리지의 직계 자식만 이름으로
//      노출한다. 하위 스토리지에 같은 이름의 스트림을 넣어 진짜를 가리는
//      컨테이너에 속지 않는다 — 결과가 디렉터리 순서에 좌우되지 않는다.
//   4. console 호출이 이 파일에 없다.
import { Buffer } from 'node:buffer';

import { MAX_ENTRY_BYTES } from './zip.mjs';

const SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');

const HEADER_BYTES = 512;
const DIFAT_HEADER_ENTRIES = 109;
const DIRECTORY_ENTRY_BYTES = 128;

const MAXREGSECT = 0xfffffffa;
const DIFSECT = 0xfffffffc;
const FATSECT = 0xfffffffd;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

const NOSTREAM = 0xffffffff;

const OBJECT_TYPE_STREAM = 2;
const OBJECT_TYPE_ROOT = 5;

/**
 * 스트림 하나를 메모리에 올릴 때 허용하는 최대 크기.
 *
 * ZIP 리더의 엔트리 상한과 **같은 값**을 쓴다. 암호화된 xlsx 를 풀면 결국 그
 * ZIP 리더로 들어가므로, 한쪽만 느슨하면 상한이 없는 것과 같다. 두 값이 따로
 * 흐르지 않도록 여기서 가져다 쓴다.
 */
export const MAX_STREAM_BYTES = MAX_ENTRY_BYTES;

/**
 * 디렉터리 엔트리 수 상한.
 *
 * 디렉터리도 섹터 체인이라 손상되면 끝없이 이어질 수 있다. 우리가 찾는 것은
 * 스트림 두 개뿐이고, 암호화된 OOXML 의 디렉터리는 엔트리 서너 개짜리다.
 */
export const MAX_DIRECTORY_ENTRIES = 4096;

function fail(message) {
  return new Error(message);
}

/**
 * 헤더를 읽고 검증한다. 모르는 값은 추측하지 않고 거절한다 —
 * 조용히 틀린 곳을 읽느니 크게 실패하는 편이 낫다(zip.mjs 와 같은 태도).
 */
function readHeader(buffer) {
  if (buffer.length < HEADER_BYTES) {
    throw fail('OLE2 헤더가 잘렸습니다.');
  }
  if (!buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw fail('OLE2 시그니처가 아닙니다.');
  }

  const major = buffer.readUInt16LE(26);
  const byteOrder = buffer.readUInt16LE(28);
  const sectorShift = buffer.readUInt16LE(30);
  const miniSectorShift = buffer.readUInt16LE(32);

  if (byteOrder !== 0xfffe) throw fail('OLE2 바이트 순서 표시가 올바르지 않습니다.');
  if (major !== 3 && major !== 4) throw fail('지원하지 않는 OLE2 버전입니다.');
  if ((major === 3 && sectorShift !== 9) || (major === 4 && sectorShift !== 12)) {
    throw fail('OLE2 섹터 크기가 버전과 맞지 않습니다.');
  }
  if (miniSectorShift !== 6) throw fail('OLE2 미니 섹터 크기가 올바르지 않습니다.');

  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniSectorShift;
  const miniCutoff = buffer.readUInt32LE(56);
  if (miniCutoff !== 0x1000) throw fail('OLE2 미니 스트림 기준 크기가 올바르지 않습니다.');

  // 파일 안에 실제로 존재하는 섹터 수. 모든 상한의 기준이 된다.
  //
  // MS-CFB 는 섹터 n 이 `SectorSize × (n + 1)` 에서 시작한다고 정한다. 즉 머리
  // 영역은 **한 섹터**다: v3(512) 에서는 512바이트지만 v4(4096) 에서는
  // 4096바이트다(512바이트 헤더 뒤가 0 으로 채워진다). 512 를 빼면 v4 에서만
  // 한 섹터 어긋나 멀쩡한 파일을 corruptContainer 로 돌려보낸다.
  // v3 에서는 값이 그대로다.
  const sectorCount = Math.floor(buffer.length / sectorSize) - 1;
  if (sectorCount < 1) throw fail('OLE2 본문이 비어 있습니다.');

  return {
    sectorSize,
    miniSectorSize,
    miniCutoff,
    sectorCount,
    fatSectorCount: buffer.readUInt32LE(44),
    directoryStart: buffer.readUInt32LE(48),
    miniFatStart: buffer.readUInt32LE(60),
    miniFatSectorCount: buffer.readUInt32LE(64),
    difatStart: buffer.readUInt32LE(68),
    difatSectorCount: buffer.readUInt32LE(72),
  };
}

/**
 * 메모리에 올라온 OLE2 복합 문서를 연다.
 *
 * @param {Buffer} buffer 문서 전체 바이트. 호출자가 한 번만 읽어서 넘긴다.
 * @returns {{ names(): string[], has(name: string): boolean,
 *             read(name: string, options?: { maxBytes?: number }): Buffer }}
 */
export function openCfb(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('openCfb 에는 Buffer 를 넘겨야 합니다.');
  }

  const header = readHeader(buffer);
  const { sectorSize, miniSectorSize, miniCutoff, sectorCount } = header;
  const fatEntriesPerSector = sectorSize / 4;

  function sectorStart(id) {
    if (id > MAXREGSECT || id >= sectorCount) {
      throw fail('OLE2 섹터 번호가 파일 범위를 벗어납니다.');
    }
    // MS-CFB: 섹터 n 은 `SectorSize × (n + 1)` 에서 시작한다. v3 에서는
    // 512 + id·512 와 같은 값이고, v4 에서는 이쪽만 맞다.
    return (id + 1) * sectorSize;
  }

  // ── FAT ──────────────────────────────────────────────────────────────────
  // DIFAT(FAT 섹터의 목록)은 헤더에 109개까지 들어가고, 넘치면 DIFAT 섹터가
  // 사슬로 이어진다. 그 사슬도 고리가 될 수 있으므로 파일의 섹터 수로 묶는다.
  function readFatSectorIds() {
    const ids = [];
    for (let i = 0; i < DIFAT_HEADER_ENTRIES; i += 1) {
      const id = buffer.readUInt32LE(76 + i * 4);
      if (id === FREESECT || id === ENDOFCHAIN) continue;
      ids.push(id);
    }

    let next = header.difatStart;
    let visited = 0;
    while (next !== ENDOFCHAIN && next !== FREESECT) {
      if (visited >= sectorCount || ids.length > sectorCount) {
        throw fail('OLE2 DIFAT 사슬이 너무 깁니다.');
      }
      const start = sectorStart(next);
      for (let i = 0; i < fatEntriesPerSector - 1; i += 1) {
        const id = buffer.readUInt32LE(start + i * 4);
        if (id === FREESECT || id === ENDOFCHAIN) continue;
        ids.push(id);
      }
      next = buffer.readUInt32LE(start + (fatEntriesPerSector - 1) * 4);
      visited += 1;
    }

    if (ids.length > sectorCount) throw fail('OLE2 FAT 섹터 수가 파일 크기와 맞지 않습니다.');
    return ids;
  }

  const fatSectorIds = readFatSectorIds();

  /** FAT 에서 다음 섹터 번호를 읽는다. FAT 전체를 배열로 펼치지 않는다. */
  function fatNext(id) {
    const sectorIndex = Math.floor(id / fatEntriesPerSector);
    if (sectorIndex >= fatSectorIds.length) {
      throw fail('OLE2 FAT 항목이 없습니다.');
    }
    const start = sectorStart(fatSectorIds[sectorIndex]);
    return buffer.readUInt32LE(start + (id % fatEntriesPerSector) * 4);
  }

  /**
   * 섹터 체인을 번호 배열로 펼친다.
   *
   * 길이를 파일의 섹터 수로 묶는다. 제대로 된 체인은 같은 섹터를 두 번 지나지
   * 않으므로, 이 수를 넘겼다는 것은 곧 고리가 있다는 뜻이다. 무한 루프를
   * 구조적으로 막는다.
   *
   * @param {number} start 시작 섹터 번호
   * @param {number} limit 이 체인에서 허용할 최대 섹터 수
   */
  function chain(start, limit) {
    const ids = [];
    let id = start;
    const cap = Math.min(limit, sectorCount);
    while (id !== ENDOFCHAIN) {
      if (id === FREESECT || id === DIFSECT || id === FATSECT || id > MAXREGSECT) {
        throw fail('OLE2 섹터 체인이 끊겼습니다.');
      }
      if (ids.length >= cap) throw fail('OLE2 섹터 체인이 너무 깁니다(고리일 수 있습니다).');
      ids.push(id);
      id = fatNext(id);
    }
    return ids;
  }

  /** 체인이 가리키는 바이트를 length 만큼 모은다. 크기는 이미 검사된 값이다. */
  function readChain(ids, length, unitSize, startOf) {
    const out = Buffer.alloc(length);
    let written = 0;
    for (const id of ids) {
      if (written >= length) break;
      const from = startOf(id);
      const take = Math.min(unitSize, length - written);
      if (from + take > buffer.length) throw fail('OLE2 스트림이 파일 범위를 벗어납니다.');
      buffer.copy(out, written, from, from + take);
      written += take;
    }
    if (written !== length) throw fail('OLE2 스트림이 선언된 크기보다 짧습니다.');
    return out;
  }

  // ── 디렉터리 ─────────────────────────────────────────────────────────────
  // 레드블랙 트리를 **타지 않는다**. 엔트리 배열을 상한을 걸고 선형으로 훑는다.
  // 포인터를 따라가는 탐색은 포인터가 고리를 이루면 무한 루프가 된다.
  function readDirectory() {
    const perSector = sectorSize / DIRECTORY_ENTRY_BYTES;
    const maxSectors = Math.ceil(MAX_DIRECTORY_ENTRIES / perSector);
    const ids = chain(header.directoryStart, maxSectors);

    const entries = [];
    for (const id of ids) {
      const base = sectorStart(id);
      for (let i = 0; i < perSector; i += 1) {
        if (entries.length >= MAX_DIRECTORY_ENTRIES) {
          throw fail('OLE2 디렉터리 엔트리가 너무 많습니다.');
        }
        const at = base + i * DIRECTORY_ENTRY_BYTES;

        // 이름은 UTF-16LE 이고 길이는 널 종단을 포함한 **바이트** 수다.
        // 쓰지 않는 슬롯 · 이름이 이상한 슬롯도 자리는 남겨 둔다 — 배열 위치가
        // 곧 디렉터리 인덱스이고, 부모/자식 관계를 그 인덱스로 읽기 때문이다.
        const nameBytes = buffer.readUInt16LE(at + 64);
        const named = nameBytes >= 2 && nameBytes <= 64;

        // 64비트 크기. 상위 32비트가 있으면 우리 상한을 이미 넘은 것이다.
        const sizeLow = buffer.readUInt32LE(at + 120);
        const sizeHigh = buffer.readUInt32LE(at + 124);

        entries.push({
          name: named ? buffer.toString('utf16le', at, at + nameBytes - 2) : null,
          type: buffer.readUInt8(at + 66),
          left: buffer.readUInt32LE(at + 68),
          right: buffer.readUInt32LE(at + 72),
          child: buffer.readUInt32LE(at + 76),
          start: buffer.readUInt32LE(at + 116),
          size: sizeHigh === 0 ? sizeLow : Number.POSITIVE_INFINITY,
        });
      }
    }

    if (entries.length === 0) throw fail('OLE2 디렉터리가 비어 있습니다.');
    return entries;
  }

  /**
   * "같은 스토리지에 든 엔트리" 끼리 묶는다.
   *
   * 한 스토리지의 자식들은 left/right 로 이어진 하나의 트리를 이룬다. 그래서
   * **형제 간선으로 묶기만 하면** 부모가 누구인지는 그 묶음에 child 로 들어오는
   * 엔트리 하나만 보면 된다. 트리를 타고 내려가지 않으므로 포인터가 고리를
   * 이루어도 돌지 않는다: 엔트리 배열을 딱 한 번 훑고, union-find 의 find 는
   * 숲(forest) 구조라 언제나 끝난다.
   *
   * @returns {(index: number) => number} 엔트리 인덱스 -> 묶음 대표 인덱스
   */
  function siblingGroups(entries) {
    const parent = entries.map((_, index) => index);

    function find(index) {
      let node = index;
      while (parent[node] !== node) {
        parent[node] = parent[parent[node]]; // 경로 절반 줄이기
        node = parent[node];
      }
      return node;
    }

    function union(a, b) {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent[rootB] = rootA;
    }

    for (let index = 0; index < entries.length; index += 1) {
      for (const sibling of [entries[index].left, entries[index].right]) {
        if (sibling === NOSTREAM || sibling >= entries.length) continue;
        union(index, sibling);
      }
    }
    return find;
  }

  const directory = readDirectory();
  const rootIndex = directory.findIndex((entry) => entry.type === OBJECT_TYPE_ROOT);
  if (rootIndex < 0) throw fail('OLE2 루트 엔트리가 없습니다.');
  const root = directory[rootIndex];

  // 이름을 컨테이너 전체에서 찾으면 하위 스토리지의 같은 이름 스트림이 루트의
  // 것을 가릴 수 있다(먼저 나온 쪽이 이긴다 = 디렉터리 순서에 좌우된다).
  // 우리가 읽는 스트림은 전부 루트 스토리지의 **직계 자식**이므로, 루트의 자식
  // 묶음에 든 것만 이름으로 노출한다. 하위 스토리지의 스트림은 보이지 않는다.
  const find = siblingGroups(directory);
  const rootGroup =
    root.child === NOSTREAM || root.child >= directory.length ? null : find(root.child);

  const streams = new Map();
  if (rootGroup !== null) {
    for (let index = 0; index < directory.length; index += 1) {
      const entry = directory[index];
      if (entry.type !== OBJECT_TYPE_STREAM || entry.name === null) continue;
      if (find(index) !== rootGroup) continue;
      // 한 스토리지 안에 같은 이름이 둘 있을 수는 없다. 그런 컨테이너에서는
      // 어느 쪽을 골라도 "골랐다" 고 말할 수 없으므로 고르지 않는다.
      if (streams.has(entry.name)) throw fail('OLE2 루트 스토리지에 이름이 겹칩니다.');
      streams.set(entry.name, entry);
    }
  }

  let miniStream = null;

  /** 미니 스트림 본체(루트 엔트리의 체인)를 필요할 때 한 번만 읽는다. */
  function loadMiniStream() {
    if (miniStream !== null) return miniStream;
    if (root.size > MAX_STREAM_BYTES) throw fail('OLE2 미니 스트림이 너무 큽니다.');
    // 선언된 크기가 파일 전체보다 클 수는 없다. read() 와 같은 순서로, 체인을
    // 펼치기 전에 본다 — readChain 은 Buffer 를 먼저 잡고 나서야 체인이 짧다는
    // 것을 알아차리기 때문에, 이 줄이 없으면 2KB 짜리 파일이 64MB 를 잡는다.
    if (root.size > buffer.length) throw fail('OLE2 미니 스트림 크기가 파일보다 큽니다.');
    if (root.size === 0) {
      miniStream = Buffer.alloc(0);
      return miniStream;
    }
    const need = Math.ceil(root.size / sectorSize);
    miniStream = readChain(chain(root.start, need), root.size, sectorSize, sectorStart);
    return miniStream;
  }

  // 미니 스트림은 별도 버퍼(루트 엔트리의 체인)라서 파일 오프셋 기준인
  // readChain 을 쓸 수 없다. 미니 경로만 따로 자른다 — 상한은 같다.
  function sliceMini(entry) {
    const mini = loadMiniStream();
    const perSector = sectorSize / 4;
    const miniFatIds = chain(header.miniFatStart, Math.max(1, header.miniFatSectorCount));

    const out = Buffer.alloc(entry.size);
    let written = 0;
    let id = entry.start;
    const cap = Math.ceil(entry.size / miniSectorSize);
    let steps = 0;
    while (written < entry.size) {
      if (id === ENDOFCHAIN || id > MAXREGSECT) {
        throw fail('OLE2 미니 스트림이 선언된 크기보다 짧습니다.');
      }
      if (steps >= cap) throw fail('OLE2 미니 섹터 체인이 너무 깁니다(고리일 수 있습니다).');
      steps += 1;

      const from = id * miniSectorSize;
      const take = Math.min(miniSectorSize, entry.size - written);
      if (from + take > mini.length) {
        throw fail('OLE2 미니 섹터가 미니 스트림 범위를 벗어납니다.');
      }
      mini.copy(out, written, from, from + take);
      written += take;

      const sectorIndex = Math.floor(id / perSector);
      if (sectorIndex >= miniFatIds.length) throw fail('OLE2 미니 FAT 항목이 없습니다.');
      id = buffer.readUInt32LE(
        sectorStart(miniFatIds[sectorIndex]) + (id % perSector) * 4,
      );
    }
    return out;
  }

  return {
    /** 루트 스토리지 직계 자식 스트림의 이름 목록(디렉터리 순서). */
    names() {
      return [...streams.keys()];
    },
    has(name) {
      return streams.has(name);
    },
    /**
     * 스트림 하나를 통째로 읽는다.
     *
     * 선언된 크기를 **할당 전에** 먼저 본다. 컨테이너가 4GB 라고 적어 두어도
     * 그 값으로 Buffer 를 잡지 않는다.
     *
     * @param {string} name
     * @param {{ maxBytes?: number }} [options]
     * @returns {Buffer}
     */
    read(name, options = {}) {
      const entry = streams.get(name);
      if (entry === undefined) throw fail(`OLE2 컨테이너에 없는 스트림입니다: ${name}`);

      const limit = Math.min(options.maxBytes ?? MAX_STREAM_BYTES, MAX_STREAM_BYTES);
      if (!(entry.size <= limit)) {
        // `!(a <= b)` 로 쓰면 Infinity(상위 32비트가 있던 경우)도 함께 걸린다.
        throw fail(`OLE2 스트림이 너무 큽니다: ${name}`);
      }
      // 선언된 크기가 파일 전체보다 클 수는 없다. 이것도 할당 전에 본다.
      if (entry.size > buffer.length) {
        throw fail(`OLE2 스트림 크기가 파일보다 큽니다: ${name}`);
      }
      if (entry.size === 0) return Buffer.alloc(0);

      if (entry.size < miniCutoff) return sliceMini(entry);

      const need = Math.ceil(entry.size / sectorSize);
      return readChain(chain(entry.start, need), entry.size, sectorSize, sectorStart);
    },
  };
}
