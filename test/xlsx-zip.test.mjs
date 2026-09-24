// 최소 ZIP 리더 테스트.
//
// 실제 fixture 로 "읽힌다"를 확인하고, 깨진 아카이브는 여기서 직접 만들어서
// "제대로 거절한다"를 확인한다. 깨진 입력은 손으로 만들어야 원하는 지점(CRC ·
// 압축 방식 · Zip64)에서 정확히 실패하는지 볼 수 있다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { MAX_ENTRY_BYTES, crc32, openZip, openZipFile } from '../lib/xlsx/zip.mjs';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'toss-sample-masked.xlsx',
);

// ── 테스트용 ZIP 빌더 ──────────────────────────────────────────────────────
// 저장(method 0) 또는 deflate(method 8) 엔트리 하나짜리 아카이브를 만든다.
// 필드를 일부러 틀리게 쓸 수 있어야 해서 라이브러리를 쓰지 않는다.
function buildZip(entries, options = {}) {
  const comment = Buffer.from(options.comment ?? '', 'utf8');
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, 'utf8');
    const method = entry.method ?? 0;
    const stored = method === 8 ? deflateRawSync(content) : content;
    const crc = entry.crc ?? crc32(content);
    // 중앙 디렉터리에 적을 "압축 해제 후 크기". 일부러 틀리게 쓸 수 있어야
    // 압축 폭탄(크게 부풀린 값 · 작게 거짓말한 값)을 재현할 수 있다.
    const declared = entry.uncompressedSize ?? content.length;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, stored);
    centrals.push(central);
    offset += local.length + stored.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22 + comment.length);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(options.directorySize ?? directory.length, 12);
  eocd.writeUInt32LE(options.directoryOffset ?? offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  comment.copy(eocd, 22);

  return Buffer.concat([...locals, directory, eocd]);
}

// ── fixture ────────────────────────────────────────────────────────────────

test('아카이브의 파트 목록을 중앙 디렉터리 순서로 돌려준다', () => {
  const names = openZipFile(FIXTURE).names();

  assert.equal(names.length, 12);
  // 순서는 중앙 디렉터리에 적힌 그대로다(이름순도 아니고 로컬 헤더 순서도 아니다).
  assert.equal(names[0], 'xl/drawings/drawing1.xml');
  for (const part of ['xl/workbook.xml', 'xl/sharedStrings.xml', 'xl/styles.xml', '[Content_Types].xml']) {
    assert.ok(names.includes(part), `${part} 가 목록에 없다`);
  }
});

test('모든 파트를 CRC32 검증까지 통과해 읽는다', () => {
  const zip = openZipFile(FIXTURE);

  for (const name of zip.names()) {
    assert.ok(zip.read(name).length > 0, `${name} 를 읽지 못했다`);
  }
  // 같은 파트를 두 번 읽어도 같은 결과다(캐시가 내용을 바꾸지 않는다).
  assert.deepEqual(zip.read('xl/styles.xml'), zip.read('xl/styles.xml'));
});

test('없는 파트를 요청하면 이름을 알려 주며 거부한다', () => {
  const zip = openZipFile(FIXTURE);
  assert.throws(() => zip.read('xl/worksheets/sheet9.xml'), /없는 파트/);
});

test('엔트리 바이트가 한 개라도 뒤집히면 거부한다', () => {
  const bytes = readFileSync(FIXTURE);
  // 첫 엔트리의 압축 데이터 한복판(로컬 헤더 30바이트 + 이름 뒤)을 건드린다.
  const target = 30 + 'xl/drawings/drawing1.xml'.length + 40;
  bytes[target] ^= 0xff;

  const zip = openZip(bytes);
  // 압축 해제 단계에서 깨지든 CRC 에서 걸리든, 조용히 통과하지는 않는다.
  assert.throws(() => zip.read('xl/drawings/drawing1.xml'));
});

// ── 직접 만든 아카이브 ──────────────────────────────────────────────────────

test('CRC32 구현이 알려진 값과 일치한다', () => {
  // 표준 검증 벡터.
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('저장(method 0)과 deflate(method 8) 엔트리를 모두 읽는다', () => {
  const zip = openZip(
    buildZip([
      { name: 'stored.xml', content: '<a/>', method: 0 },
      { name: 'deflated.xml', content: '<b>'.repeat(200), method: 8 },
    ]),
  );

  assert.equal(zip.readText('stored.xml'), '<a/>');
  assert.equal(zip.readText('deflated.xml'), '<b>'.repeat(200));
});

test('CRC32 가 맞지 않으면 파트 이름과 함께 거부한다', () => {
  // 내용은 멀쩡한데 CRC 만 틀린 엔트리. 검증을 빼먹으면 조용히 통과한다.
  const zip = openZip(buildZip([{ name: 'broken.xml', content: '<a/>', crc: 0x12345678 }]));

  assert.throws(() => zip.read('broken.xml'), /CRC32 검증에 실패했습니다: broken\.xml/);
});

test('지원하지 않는 압축 방식은 방식 번호를 알려 주며 거부한다', () => {
  // 12 = bzip2. 이 리더는 0 과 8 만 다룬다.
  const zip = openZip(buildZip([{ name: 'bz.xml', content: '<a/>', method: 12 }]));

  assert.throws(() => zip.read('bz.xml'), /method=12/);
});

test('EOCD 코멘트가 있어도, 코멘트 안에 EOCD 서명이 들어 있어도 제대로 연다', () => {
  // 코멘트 길이를 확인하지 않고 서명만 뒤에서 찾으면 여기서 가짜를 잡는다.
  const zip = openZip(buildZip([{ name: 'a.xml', content: '<a/>' }], { comment: 'PK\u0005\u0006 주석' }));

  assert.deepEqual(zip.names(), ['a.xml']);
  assert.equal(zip.readText('a.xml'), '<a/>');
});

test('Zip64 아카이브는 조용히 잘못 읽는 대신 크게 실패한다', () => {
  // 32비트 필드가 포화된 상태(0xFFFFFFFF). 그대로 믿으면 엉뚱한 곳을 읽는다.
  const bytes = buildZip([{ name: 'a.xml', content: '<a/>' }], { directoryOffset: 0xffffffff });

  assert.throws(() => openZip(bytes), /Zip64/);
});

test('ZIP 이 아니거나 잘린 파일은 EOCD 단계에서 거부한다', () => {
  assert.throws(() => openZip(Buffer.from('이건 xlsx 가 아니다', 'utf8')), /EOCD/);

  const truncated = readFileSync(FIXTURE).subarray(0, 400);
  assert.throws(() => openZip(Buffer.from(truncated)), /EOCD|잘렸습니다/);
});

test('Buffer 가 아닌 입력은 받지 않는다', () => {
  assert.throws(() => openZip('xlsx 내용'), TypeError);
});

// ── 압축 폭탄 ──────────────────────────────────────────────────────────────

test('압축 해제 후 크기가 상한을 넘는 엔트리는 풀기 전에 거부한다', () => {
  // 업로드 상한(4MB)은 **압축된** 크기만 묶는다. deflate 는 반복 데이터를
  // 1000:1 로 줄이므로 그 안에서도 수백 MB 로 부푸는 엔트리를 만들 수 있다.
  // 실제로 398KB 짜리 zip 하나가 400MB 를 풀어 RSS 를 858MB 끌어올렸다.
  const zip = openZip(
    buildZip([
      {
        name: 'xl/worksheets/sheet1.xml',
        content: 'A'.repeat(1024),
        method: 8,
        uncompressedSize: MAX_ENTRY_BYTES + 1,
      },
    ]),
  );

  const before = process.memoryUsage().heapUsed;
  assert.throws(() => zip.read('xl/worksheets/sheet1.xml'), /너무 커지는 엔트리/);
  const grewMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
  // 풀기 전에 걸러야 방어다. 풀고 나서 재면 이미 메모리를 다 쓴 뒤다.
  assert.ok(grewMb < 16, `힙이 ${grewMb.toFixed(1)}MB 늘었다 — 압축을 풀고 있다`);

  // 거부 메시지에는 파트 이름만 들어간다(내용은 들어가지 않는다).
  assert.throws(() => zip.read('xl/worksheets/sheet1.xml'), /sheet1\.xml/);
});

test('상한 바로 아래를 선언한 엔트리는 그대로 읽는다', () => {
  const zip = openZip(
    buildZip([{ name: 'ok.xml', content: '<a/>', method: 8 }]),
  );
  assert.equal(zip.readText('ok.xml'), '<a/>');
});

test('선언 크기를 작게 거짓말해도 zlib 상한에서 멈춘다', () => {
  // 중앙 디렉터리의 값은 아카이브를 만든 쪽이 적은 값이다. 그것만 믿으면
  // "1KB 라고 적고 실제로는 수십 MB" 인 엔트리에 그대로 당한다.
  const real = Buffer.alloc(MAX_ENTRY_BYTES + 1024, 0x41);
  const zip = openZip(
    buildZip([{ name: 'liar.xml', content: real, method: 8, uncompressedSize: 1024 }]),
  );

  // 풀다가 상한에서 멈추고, 에러 객체를 그대로 올리지 않는다(파트 이름만).
  assert.throws(() => zip.read('liar.xml'), /압축을 풀지 못했습니다: liar\.xml/);
});
