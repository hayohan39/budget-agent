// Neon API 헬퍼. GitHub Actions 에서 PR 별 프리뷰 DB 브랜치를 만들고 지운다.
//
//   node scripts/neon.mjs preview-create --pr 12 --sha <commit>
//   node scripts/neon.mjs preview-delete --pr 12
//
// 필요한 환경변수: NEON_API_KEY, NEON_PROJECT_ID
//
// preview-create 는 PR 의 이전 프리뷰 브랜치를 지우고 프로덕션(기본 브랜치)에서
// 새로 딴다. 매 push 마다 새로 따는 이유: PR 안에서 마이그레이션 파일을 고치면
// 이미 적용된 브랜치에서는 체크섬 불일치로 실패한다. 매번 "현재 프로덕션 + 이 PR 의
// 마이그레이션" 을 검증하는 것이 merge 후에 실제로 일어날 일과 같다.
//
// 결과(연결 문자열)는 GITHUB_OUTPUT 으로 내보내고 로그에는 마스킹한다.
import { appendFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const API = process.env.NEON_API_URL ?? 'https://console.neon.tech/api/v2';
const PREVIEW_PREFIX = 'preview/pr-';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function neon(path, { method = 'GET', body, token = process.env.NEON_API_KEY } = {}) {
  if (!token) throw new Error('NEON_API_KEY 가 없습니다.');
  // 423: 프로젝트에 진행 중인 작업이 있다(직전 브랜치 삭제 등). 잠시 뒤 재시도한다.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (res.status === 423 && attempt < 10) {
      await sleep(3000);
      continue;
    }
    if (!res.ok) {
      const error = new Error(`Neon ${method} ${path} → HTTP ${res.status}: ${data.message ?? text.slice(0, 300)}`);
      error.status = res.status;
      throw error;
    }
    return data;
  }
}

/** 작업(operation)들이 끝날 때까지 기다린다. 엔드포인트가 뜨기 전에 접속하면 실패할 수 있다. */
export async function waitForOperations(projectId, operations = [], { timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (const op of operations) {
    for (;;) {
      const { operation } = await neon(`/projects/${projectId}/operations/${op.id}`);
      if (operation.status === 'finished' || operation.status === 'skipped') break;
      if (operation.status === 'failed' || operation.status === 'error') {
        throw new Error(`Neon 작업 실패: ${operation.action} (${operation.error ?? operation.status})`);
      }
      if (Date.now() > deadline) throw new Error(`Neon 작업 대기 시간 초과: ${operation.action}`);
      await sleep(2000);
    }
  }
}

/** 브랜치의 첫 데이터베이스와 소유 role 로 direct / pooled 연결 문자열을 만든다. */
export async function connectionUris(projectId, branchId) {
  const { databases } = await neon(`/projects/${projectId}/branches/${branchId}/databases`);
  const db = databases?.[0];
  if (!db) throw new Error(`브랜치 ${branchId} 에 데이터베이스가 없습니다.`);
  const params = (pooled) =>
    new URLSearchParams({
      branch_id: branchId,
      database_name: db.name,
      role_name: db.owner_name,
      pooled: String(pooled),
    });
  const [direct, pooled] = await Promise.all([
    neon(`/projects/${projectId}/connection_uri?${params(false)}`),
    neon(`/projects/${projectId}/connection_uri?${params(true)}`),
  ]);
  return { direct: strictSsl(direct.uri), pooled: strictSsl(pooled.uri), database: db.name, role: db.owner_name };
}

// Neon 이 주는 URI 는 sslmode=require 다. node-postgres 는 이를 verify-full 로 취급하면서
// 매 연결마다 SECURITY WARNING 을 찍는다(다음 메이저에서 의미가 약해질 예정). Neon 인증서는
// 공인 인증서라 verify-full 이 그대로 동작하므로 명시해서 경고와 향후 약화를 둘 다 피한다.
export function strictSsl(uri) {
  return uri.replace(/([?&])sslmode=require(?=&|$)/, '$1sslmode=verify-full');
}

async function listBranches(projectId) {
  const { branches } = await neon(`/projects/${projectId}/branches`);
  return branches ?? [];
}

async function deleteBranches(projectId, predicate) {
  const deleted = [];
  for (const branch of await listBranches(projectId)) {
    // 방어선: 이름이 프리뷰 접두사가 아니면 절대 지우지 않는다.
    if (!branch.name.startsWith(PREVIEW_PREFIX) || branch.default || branch.primary) continue;
    if (!predicate(branch)) continue;
    const { operations } = await neon(`/projects/${projectId}/branches/${branch.id}`, { method: 'DELETE' });
    await waitForOperations(projectId, operations);
    deleted.push(branch.name);
  }
  return deleted;
}

async function output(values) {
  const file = process.env.GITHUB_OUTPUT;
  for (const [key, value] of Object.entries(values)) {
    if (/url/i.test(key)) console.log(`::add-mask::${value}`);
    if (file) await appendFile(file, `${key}=${value}\n`);
  }
}

async function previewCreate({ pr, sha }) {
  const projectId = required('NEON_PROJECT_ID');
  const prefix = `${PREVIEW_PREFIX}${pr}-`;
  const name = `${prefix}${String(sha).slice(0, 7)}`;

  const removed = await deleteBranches(projectId, (b) => b.name.startsWith(prefix));
  if (removed.length) console.log(`이전 프리뷰 브랜치 삭제: ${removed.join(', ')}`);

  // parent 를 지정하지 않으면 기본(프로덕션) 브랜치에서 딴다.
  const created = await neon(`/projects/${projectId}/branches`, {
    method: 'POST',
    body: { branch: { name }, endpoints: [{ type: 'read_write' }] },
  });
  await waitForOperations(projectId, created.operations);
  const uris = await connectionUris(projectId, created.branch.id);
  console.log(`프리뷰 브랜치 생성: ${name} (${created.branch.id})`);

  await output({
    branch_name: name,
    branch_id: created.branch.id,
    database_url: uris.direct,
    database_url_pooled: uris.pooled,
  });
}

async function previewDelete({ pr }) {
  const projectId = required('NEON_PROJECT_ID');
  const prefix = `${PREVIEW_PREFIX}${pr}-`;
  const removed = await deleteBranches(projectId, (b) => b.name.startsWith(prefix));
  console.log(removed.length ? `삭제: ${removed.join(', ')}` : '지울 프리뷰 브랜치가 없습니다.');
}

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} 가 없습니다.`);
  return value;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  try {
    if (!/^\d+$/.test(args.pr ?? '')) throw new Error('--pr <번호> 가 필요합니다.');
    if (command === 'preview-create') {
      if (!args.sha) throw new Error('--sha 가 필요합니다.');
      await previewCreate(args);
    } else if (command === 'preview-delete') {
      await previewDelete(args);
    } else {
      throw new Error(`알 수 없는 명령: ${command ?? '(없음)'}`);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
