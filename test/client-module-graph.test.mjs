// 클라이언트 컴포넌트("use client")가 끌어오는 모듈 그래프에 Node 전용 import
// (`node:*` · Node 내장 모듈)가 없는지 검사한다.
//
// 배경: app/classify/forms.tsx 가 lib/classify/wildcard.mjs 를 import 하는데, 예전
// wildcard.mjs 는 lib/toss/normalize.mjs(=`node:crypto`)를 거쳐 적요를 정규화했다.
// 브라우저 번들에 Node 전용 모듈이 끌려 들어가면 빌드가 깨지거나 폴리필이 붙는다.
// 정규화 함수는 이제 lib/text/description.mjs 에 있고 서버도 같은 함수를 쓴다.
//
// 파서는 import 문만 정규식으로 훑는 단순한 것이다(이 저장소의 코드 스타일 — 세미콜론
// 으로 끝나는 import · export ... from — 에 맞춘다). `import type` 은 컴파일 때
// 지워지므로 건너뛴다. 패키지(next, react 등)는 따라 들어가지 않는다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeDescription as fromToss } from '../lib/toss/normalize.mjs';
import { normalizeDescription as fromText } from '../lib/text/description.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.jsx'];
const BUILTINS = new Set(builtinModules);

function isNodeOnly(specifier) {
  return specifier.startsWith('node:') || BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0]);
}

/** 소스에서 런타임 import 의 specifier 목록. */
function specifiersOf(source) {
  const found = [];
  const patterns = [
    /^[ \t]*(?:import|export)\s(?!type\s)[^;]*?\sfrom\s*["']([^"']+)["']/gm,
    /^[ \t]*import\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

/** 저장소 안의 파일로 풀 수 있으면 그 경로, 패키지면 null. */
function resolveLocal(specifier, fromFile) {
  let base;
  if (specifier.startsWith('@/')) base = path.join(ROOT, ...specifier.slice(2).split('/'));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), ...specifier.split('/'));
  else return null;
  const candidates = [base, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`))];
  const hit = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  assert.ok(hit, `풀 수 없는 import: ${specifier} (${path.relative(ROOT, fromFile)})`);
  return hit;
}

/** entry 에서 닿는 로컬 파일들과, 그중 Node 전용 import 를 가진 곳. */
function walk(entries) {
  const seen = new Set();
  const offenders = [];
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (isNodeOnly(specifier)) {
        offenders.push(`${path.relative(ROOT, file)} -> ${specifier}`);
        continue;
      }
      const next = resolveLocal(specifier, file);
      if (next !== null) stack.push(next);
    }
  }
  return { seen, offenders };
}

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (EXTENSIONS.includes(path.extname(full))) out.push(full);
  }
  return out;
}

function clientEntries() {
  return listFiles(path.join(ROOT, 'app')).filter((file) =>
    /^\s*(?:\/\/[^\n]*\n\s*)*["']use client["']/.test(readFileSync(file, 'utf8')),
  );
}

test('클라이언트 컴포넌트 목록에 /classify 입력 조각이 들어 있다', () => {
  const entries = clientEntries().map((file) => path.relative(ROOT, file));
  assert.ok(entries.includes(path.join('app', 'classify', 'forms.tsx')), entries.join(', '));
});

test('"use client" 모듈 그래프에 node: · Node 내장 import 가 없다', () => {
  const { seen, offenders } = walk(clientEntries());
  assert.deepEqual(offenders, []);
  // 실제로 wildcard.mjs · 정규화 모듈까지 따라 들어갔는지(검사가 헛돌지 않는지).
  const reached = [...seen].map((file) => path.relative(ROOT, file));
  assert.ok(reached.includes(path.join('lib', 'classify', 'wildcard.mjs')), reached.join(', '));
  assert.ok(reached.includes(path.join('lib', 'text', 'description.mjs')), reached.join(', '));
});

test('검사기 자체: lib/toss/normalize.mjs 에서 시작하면 node:crypto 를 잡는다', () => {
  const { offenders } = walk([path.join(ROOT, 'lib', 'toss', 'normalize.mjs')]);
  assert.ok(offenders.some((line) => line.endsWith('-> node:crypto')), offenders.join(', '));
});

test('서버와 브라우저가 같은 적요 정규화 함수를 쓴다', () => {
  assert.equal(fromToss, fromText);
  assert.equal(fromText('  흥국 01184 \t'), '흥국 01184');
});
