// 최소 OLE2/CFB 리더 테스트.
//
// zip.mjs 테스트와 같은 태도다: "읽힌다" 는 실제로 만든 컨테이너로 확인하고,
// "제대로 거절한다" 는 깨진 컨테이너를 손으로 만들어 확인한다. 특히 **고리가
// 있는 체인에서 멈추는가** 를 본다 — 여기서 못 멈추면 요청 하나가 프로세스를
// 통째로 묶는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { MAX_DIRECTORY_ENTRIES, MAX_STREAM_BYTES, openCfb } from '../lib/xlsx/cfb.mjs';
import { MAX_ENTRY_BYTES } from '../lib/xlsx/zip.mjs';
import { buildCfb } from './helpers/ooxml-encrypt.mjs';

/** 미니 스트림 경로(4096 미만)와 일반 섹터 경로를 둘 다 담은 컨테이너. */
function sampleContainer() {
  return buildCfb([
    { name: 'Small', data: Buffer.alloc(100, 0x41) },
    { name: 'Large', data: Buffer.alloc(9000, 0x42) },
  ]);
}

/**
 * 헤더에서 첫 FAT 섹터를 찾아 항목 하나를 바꿔치기한다.
 * (v3 · 512바이트 섹터 기준. 우리 빌더가 만드는 형태다.)
 */
function patchFatEntry(container, sectorId, value) {
  const copy = Buffer.from(container);
  const fatSectorId = copy.readUInt32LE(76);
  const at = 512 + fatSectorId * 512 + sectorId * 4;
  copy.writeUInt32LE(value >>> 0, at);
  return copy;
}

/**
 * 루트 엔트리(디렉터리 0번)의 선언 크기를 바꿔치기한다.
 * 루트 엔트리의 크기가 곧 **미니 스트림 본체의 크기**다.
 * (v3 · 512바이트 섹터 기준. 크기 필드는 엔트리 시작에서 120바이트 뒤다.)
 */
function patchRootSize(container, size) {
  const copy = Buffer.from(container);
  const directoryStart = copy.readUInt32LE(48);
  copy.writeUInt32LE(size >>> 0, 512 + directoryStart * 512 + 120);
  return copy;
}

/**
 * `run` 이 도는 동안 `Buffer.alloc` 이 한 번에 요청한 최대 바이트 수.
 *
 * "거절한다" 만 보면 **거절하기 전에 이미 64MB 를 잡았는지** 를 놓친다. 이
 * 모듈의 약속은 "할당하기 전에 선언된 크기를 본다" 이므로 할당 자체를 센다.
 * 원래 함수는 finally 로 반드시 되돌린다.
 */
function largestAllocation(run) {
  const original = Buffer.alloc;
  let largest = 0;
  Buffer.alloc = (size, ...rest) => {
    if (typeof size === 'number' && size > largest) largest = size;
    return original.call(Buffer, size, ...rest);
  };
  try {
    run();
  } finally {
    Buffer.alloc = original;
  }
  return largest;
}

test('스트림 목록을 읽고 이름으로 찾는다', () => {
  const cfb = openCfb(sampleContainer());
  assert.deepEqual(cfb.names().sort(), ['Large', 'Small']);
  assert.equal(cfb.has('Small'), true);
  assert.equal(cfb.has('없는스트림'), false);
});

test('미니 스트림(4096 미만)과 일반 섹터 체인을 모두 읽는다', () => {
  const cfb = openCfb(sampleContainer());
  const small = cfb.read('Small');
  const large = cfb.read('Large');
  assert.equal(small.length, 100);
  assert.equal(large.length, 9000);
  assert.ok(small.every((byte) => byte === 0x41));
  assert.ok(large.every((byte) => byte === 0x42));
});

test('v4(4096바이트 섹터) 컨테이너도 섹터 오프셋을 맞게 읽는다', () => {
  // MS-CFB 는 섹터 n 이 `SectorSize × (n + 1)` 에서 시작한다고 정한다. 즉 머리
  // 영역은 **한 섹터**이고, v4 에서는 그것이 512 가 아니라 4096바이트다.
  // `512 + id × SectorSize` 로 계산하면 v4 에서만 한 섹터씩 어긋난다.
  // readHeader 가 major === 4 를 받아들이므로, 어긋난 채로 여기까지 와서
  // 멀쩡한 파일이 "다시 내려받아 올려주세요" 로 돌아간다.
  const container = buildCfb(
    [
      { name: 'Small', data: Buffer.alloc(100, 0x41) },
      { name: 'Large', data: Buffer.alloc(9000, 0x42) },
    ],
    { sectorBytes: 4096 },
  );
  assert.equal(container.readUInt16LE(26), 4); // major version
  assert.equal(container.readUInt16LE(30), 12); // sector shift (4096)

  const cfb = openCfb(container);
  assert.deepEqual(cfb.names().sort(), ['Large', 'Small']);
  // 미니 경로(4096 미만)와 일반 섹터 경로를 둘 다 지난다.
  assert.ok(cfb.read('Small').every((byte) => byte === 0x41));
  assert.ok(cfb.read('Large').every((byte) => byte === 0x42));
});

test('하위 스토리지의 같은 이름 스트림이 루트의 것을 가리지 못한다', () => {
  // 실제 암호화 xlsx 에는 `\u0006DataSpaces` 스토리지가 들어 있고 그 안에도
  // 스트림이 여럿 있다. 이름을 컨테이너 전체에서 찾으면, 디렉터리에서 먼저
  // 나오는 하위 스토리지의 미끼가 진짜 EncryptionInfo 를 가릴 수 있다.
  const decoy = Buffer.alloc(80, 0xde);
  const real = Buffer.alloc(96, 0x11);
  const container = buildCfb([
    { name: '\u0006DataSpaces', storage: [{ name: 'EncryptionInfo', data: decoy }] },
    { name: 'EncryptionInfo', data: real },
    { name: 'EncryptedPackage', data: Buffer.alloc(120, 0x22) },
  ]);

  // 미끼가 디렉터리에서 정말 먼저 나오는지부터 본다 — 순서가 반대라면 이
  // 시험은 아무것도 증명하지 못한다. 엔트리 이름은 엔트리 시작 오프셋에 있고
  // 크기 필드는 그로부터 120바이트 뒤다.
  const needle = Buffer.from('EncryptionInfo', 'utf16le');
  const first = container.indexOf(needle);
  const second = container.indexOf(needle, first + 1);
  assert.ok(first >= 0 && second > first);
  assert.equal(container.readUInt32LE(first + 120), decoy.length);
  assert.equal(container.readUInt32LE(second + 120), real.length);

  const cfb = openCfb(container);
  const info = cfb.read('EncryptionInfo');
  assert.equal(info.length, real.length);
  assert.ok(info.every((byte) => byte === 0x11));
  // 하위 스토리지의 스트림은 아예 보이지 않는다. 스토리지 자체도 스트림이 아니다.
  assert.deepEqual(cfb.names().sort(), ['EncryptedPackage', 'EncryptionInfo']);
});

test('루트 스토리지 안에서 이름이 겹치면 고르지 않고 거절한다', () => {
  // 어느 쪽을 고르든 "골랐다" 고 말할 수 없는 컨테이너다. 조용히 하나를
  // 집는 대신 던진다.
  const container = buildCfb([
    { name: 'EncryptionInfo', data: Buffer.alloc(80, 0xde) },
    { name: 'EncryptionInfo', data: Buffer.alloc(96, 0x11) },
  ]);
  assert.throws(() => openCfb(container), /OLE2/);
});

test('없는 스트림을 읽으려 하면 이름만 알리고 던진다', () => {
  const cfb = openCfb(sampleContainer());
  assert.throws(() => cfb.read('EncryptionInfo'), /EncryptionInfo/);
});

test('maxBytes 를 넘는 스트림은 읽지 않는다', () => {
  const cfb = openCfb(sampleContainer());
  assert.throws(() => cfb.read('Large', { maxBytes: 1024 }), /너무 큽니다/);
});

test('미니 스트림이 파일보다 크다고 적힌 컨테이너는 할당하기 전에 거절한다', () => {
  // 루트 엔트리의 크기만 크게 적은 컨테이너다. 상한(MAX_STREAM_BYTES)은
  // 넘지 않으므로 그 검사만으로는 통과하고, 체인을 펼치는 readChain 이
  // "체인이 짧다" 를 알아차리기 **전에** 그 크기로 Buffer 를 잡는다.
  // 2KB 남짓한 파일로 63MB 를 잡게 만들 수 있었다(약 25,000배 증폭).
  const container = patchRootSize(sampleContainer(), MAX_STREAM_BYTES - 1);
  assert.ok(container.length < 64 * 1024, '증폭을 보려면 원본이 작아야 한다');

  const largest = largestAllocation(() => {
    // 'Small' 은 4096 미만이라 미니 스트림 경로로 간다.
    assert.throws(() => openCfb(container).read('Small'), /미니 스트림 크기가 파일보다/);
  });

  // 거절하기까지 파일 크기보다 큰 버퍼를 단 한 번도 잡지 않는다.
  assert.ok(largest <= container.length, `할당 ${largest}바이트`);
});

test('미니 스트림 크기 검사는 정상 컨테이너를 막지 않는다', () => {
  // 위 검사가 지나치게 넓으면 멀쩡한 파일이 corruptContainer 로 죽는다.
  const cfb = openCfb(sampleContainer());
  assert.equal(cfb.read('Small').length, 100);
});

test('스트림 상한은 ZIP 엔트리 상한과 같은 값이다', () => {
  // 복호화 결과는 결국 ZIP 리더로 들어간다. 한쪽만 느슨하면 상한이 없는 것과
  // 같으므로 두 값이 따로 흐르지 않는지 확인한다.
  assert.equal(MAX_STREAM_BYTES, MAX_ENTRY_BYTES);
  assert.equal(MAX_STREAM_BYTES, 64 * 1024 * 1024);
});

test('OLE2 가 아닌 버퍼는 시그니처에서 거절한다', () => {
  assert.throws(() => openCfb(Buffer.alloc(1024, 0x50)), /시그니처/);
});

test('헤더보다 짧은 버퍼는 거절한다', () => {
  assert.throws(() => openCfb(Buffer.alloc(100)), /헤더/);
});

test('잘린 컨테이너는 던지되 멈춘다', () => {
  const full = sampleContainer();
  for (const length of [600, 1024, 4096, full.length - 512]) {
    // 어디서 잘리든 "조용히 이상한 값을 돌려주기" 가 아니라 "던지기" 여야 한다.
    assert.throws(() => {
      const cfb = openCfb(full.subarray(0, length));
      cfb.read('Large');
      cfb.read('Small');
    });
  }
});

test('자기 자신을 가리키는 FAT 항목(고리)에서 멈춘다', () => {
  // 고리가 있는 체인은 상한이 없으면 영원히 돈다. 섹터 수로 묶어 둔 것을 본다.
  const looped = patchFatEntry(sampleContainer(), 0, 0);
  assert.throws(() => openCfb(looped).read('Large'), /OLE2/);
});

test('끝나지 않는 체인(다음 섹터가 계속 이어짐)에서도 멈춘다', () => {
  const container = sampleContainer();
  // 섹터 1 -> 2, 2 -> 1 로 서로를 가리키게 만든다.
  const looped = patchFatEntry(patchFatEntry(container, 1, 2), 2, 1);
  assert.throws(() => openCfb(looped).read('Large'), /OLE2/);
});

test('바이트 순서 표시가 틀리면 거절한다', () => {
  const broken = Buffer.from(sampleContainer());
  broken.writeUInt16LE(0x1234, 28);
  assert.throws(() => openCfb(broken), /바이트 순서/);
});

test('섹터 크기가 버전과 맞지 않으면 거절한다', () => {
  const broken = Buffer.from(sampleContainer());
  broken.writeUInt16LE(12, 30); // v3 인데 4096 섹터라고 주장한다
  assert.throws(() => openCfb(broken), /섹터 크기/);
});

test('디렉터리 엔트리 상한이 정해져 있다', () => {
  assert.equal(typeof MAX_DIRECTORY_ENTRIES, 'number');
  assert.ok(MAX_DIRECTORY_ENTRIES > 0);
});

test('Buffer 가 아니면 타입 오류다', () => {
  assert.throws(() => openCfb('not a buffer'), TypeError);
});
