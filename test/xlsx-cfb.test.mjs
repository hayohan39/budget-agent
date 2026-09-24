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

test('없는 스트림을 읽으려 하면 이름만 알리고 던진다', () => {
  const cfb = openCfb(sampleContainer());
  assert.throws(() => cfb.read('EncryptionInfo'), /EncryptionInfo/);
});

test('maxBytes 를 넘는 스트림은 읽지 않는다', () => {
  const cfb = openCfb(sampleContainer());
  assert.throws(() => cfb.read('Large', { maxBytes: 1024 }), /너무 큽니다/);
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
