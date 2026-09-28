// /api/classify · /api/classify/mappings · /api/classify/patterns(/preview) 의 핸들러 본체.
//
// app/api/classify/**/route.ts 는 이 함수들에 `auth` · `isAllowedEmail` ·
// `withClient` 를 꽂아 주기만 한다. 본체를 여기 두는 이유는 Next.js 없이
// `node --test` 로 **가드 순서 자체**를 테스트하기 위해서다(인증 없음 · 명단 밖 ·
// 다른 Origin 이 DB 에 닿기 전에 막히는지).
//
// ── 왜 서버 액션이 아니라 라우트 핸들러인가 ───────────────────────────────
//
//   - /api/import 와 같은 가드 순서(인증 -> 화이트리스트 -> Origin -> 검사)를
//     같은 모양의 코드로 둘 수 있다. 서버 액션의 Origin 검사는 프레임워크 안에
//     숨어 있어 이 순서를 테스트로 못 박을 수 없다.
//   - 응답에 `Cache-Control: no-store` 와 상태 코드를 직접 붙인다.
//   - 서버 액션은 요청 본문 형식(React 직렬화)과 액션 id 가 프레임워크 내부라,
//     "클라이언트가 보낸 것을 무엇도 믿지 않는다" 를 이 파일에서 검사할 수 없다.
//
// ── 보안 ───────────────────────────────────────────────────────────────────
//
//   - 본문을 읽기 전에 세션 · 화이트리스트 · Origin 을 본다.
//   - 본문은 작은 JSON 하나다. 상한을 넘으면 읽지 않는다.
//   - 응답 본문에는 건수와 고정된 문장뿐이다. 적요(키)를 되비추지 않는다.
//   - console 호출이 이 파일에 없다. catch 는 전부 바인딩 없는 `catch {}` 다.

import { Buffer } from 'node:buffer';

import {
  CLASSIFY_ERROR_MESSAGES,
  applyClassification,
  deleteMapping,
  deletePattern,
  parseClassifyRequest,
  parseMappingRequest,
  parsePatternRequest,
  previewPattern,
  updateMapping,
  updatePattern,
} from './manual.mjs';
import { VOID_ERROR_MESSAGES, parseVoidRequest, unvoidPair, voidPair } from '../report/voids.mjs';

/** 요청 본문 상한(바이트). 키 256자 × UTF-8 4바이트 + 나머지 필드로 넉넉하다. */
export const MAX_BODY_BYTES = 8 * 1024;

const NO_STORE = Object.freeze({ 'Cache-Control': 'no-store' });

/**
 * JSON 응답. 헤더에 no-store 를 늘 붙인다.
 *
 * @param {unknown} body
 * @param {number} [status]
 */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE },
  });
}

function bare(message, status) {
  return jsonResponse({ ok: false, message }, status);
}

/**
 * Origin 확인(app/api/import/route.ts 와 같은 규칙).
 *
 * Origin 이 없는 요청(같은 출처 폼 전송 등)은 통과시키고, 있는데 Host 와 다르면
 * 거부한다. 파싱되지 않는 Origin 도 거부한다.
 *
 * @param {Request} request
 */
export function originMatchesHost(request) {
  const origin = request.headers.get('origin');
  if (origin === null || origin === '') return true;
  const host = request.headers.get('host');
  if (host === null || host === '') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 인증 -> 화이트리스트 -> Origin. 통과하면 null, 막히면 응답.
 *
 * @param {Request} request
 * @param {{ auth: () => Promise<any>, isAllowedEmail: (email: string | null | undefined) => boolean }} deps
 */
export async function guard(request, deps) {
  let session;
  try {
    session = await deps.auth();
  } catch {
    session = null;
  }
  if (!session) return bare('로그인이 필요합니다.', 401);
  if (!deps.isAllowedEmail(session.user?.email)) return bare('접근 권한이 없습니다.', 403);
  if (!originMatchesHost(request)) return bare('허용되지 않은 요청입니다.', 403);
  return null;
}

/**
 * 작은 JSON 본문을 읽는다. 상한을 넘거나 JSON 이 아니면 null.
 *
 * @param {Request} request
 */
async function readJson(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && declared !== '') {
    if (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BODY_BYTES) return null;
  }
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) return null;

  let text;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function failureStatus(error) {
  if (error === 'keyNotFound' || error === 'mappingNotFound' || error === 'patternNotFound') return 404;
  if (error === 'saveFailed') return 500;
  return 400;
}

/**
 * @typedef {{
 *   auth: () => Promise<any>,
 *   isAllowedEmail: (email: string | null | undefined) => boolean,
 *   withClient: <T>(fn: (client: {query: Function}) => Promise<T>) => Promise<T>,
 * }} Deps
 */

/**
 * POST /api/classify — 이번만 · 앞으로도.
 *
 * @param {Request} request
 * @param {Deps} deps
 */
export async function handleClassifyPost(request, deps) {
  const blocked = await guard(request, deps);
  if (blocked !== null) return blocked;

  const body = await readJson(request);
  if (body === null) return bare(CLASSIFY_ERROR_MESSAGES.badRequest, 400);

  const parsed = parseClassifyRequest(body);
  if (!parsed.ok) return bare(parsed.message, 400);

  let outcome;
  try {
    outcome = await deps.withClient((client) => applyClassification(client, parsed.value));
  } catch {
    return bare('데이터베이스에 연결하지 못했습니다.', 503);
  }
  if (!outcome.ok) return bare(outcome.message, failureStatus(outcome.error));
  return jsonResponse({ ok: true, updated: outcome.updated, mapped: outcome.mapped });
}

/**
 * POST /api/classify/mappings — 매핑 수정 · 삭제.
 *
 * @param {Request} request
 * @param {Deps} deps
 */
export async function handleMappingPost(request, deps) {
  const blocked = await guard(request, deps);
  if (blocked !== null) return blocked;

  const body = await readJson(request);
  if (body === null) return bare(CLASSIFY_ERROR_MESSAGES.badRequest, 400);

  const parsed = parseMappingRequest(body);
  if (!parsed.ok) return bare(parsed.message, 400);

  let outcome;
  try {
    outcome = await deps.withClient((client) =>
      parsed.value.action === 'delete'
        ? deleteMapping(client, parsed.value)
        : updateMapping(client, parsed.value),
    );
  } catch {
    return bare('데이터베이스에 연결하지 못했습니다.', 503);
  }
  if (!outcome.ok) return bare(outcome.message, failureStatus(outcome.error));

  return parsed.value.action === 'delete'
    ? jsonResponse({ ok: true, reclassified: outcome.reclassified, unclassified: outcome.unclassified })
    : jsonResponse({ ok: true, updated: outcome.updated });
}

/**
 * POST /api/classify/patterns — 저장된 적요 패턴의 수정 · 삭제.
 *
 * @param {Request} request
 * @param {Deps} deps
 */
export async function handlePatternPost(request, deps) {
  const blocked = await guard(request, deps);
  if (blocked !== null) return blocked;

  const body = await readJson(request);
  if (body === null) return bare(CLASSIFY_ERROR_MESSAGES.badRequest, 400);

  const parsed = parsePatternRequest(body);
  if (!parsed.ok) return bare(parsed.message, 400);

  let outcome;
  try {
    outcome = await deps.withClient((client) =>
      parsed.value.action === 'delete' ? deletePattern(client, parsed.value) : updatePattern(client, parsed.value),
    );
  } catch {
    return bare('데이터베이스에 연결하지 못했습니다.', 503);
  }
  if (!outcome.ok) return bare(outcome.message, failureStatus(outcome.error));

  return parsed.value.action === 'delete'
    ? jsonResponse({ ok: true, reclassified: outcome.reclassified, unclassified: outcome.unclassified })
    : jsonResponse({ ok: true, updated: outcome.updated });
}

/**
 * POST /api/classify/patterns/preview — 저장 전 미리보기(읽기만).
 *
 * 응답에는 사용자 자신의 적요 몇 개가 실린다(로그인 + 화이트리스트 뒤, no-store).
 * 로그에 남기지 않는다. 패턴 · 키는 되비추지 않는다(정규화한 패턴만 돌려준다).
 *
 * @param {Request} request
 * @param {Deps} deps
 */
export async function handlePatternPreview(request, deps) {
  const blocked = await guard(request, deps);
  if (blocked !== null) return blocked;

  const body = await readJson(request);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return bare(CLASSIFY_ERROR_MESSAGES.badRequest, 400);
  }

  let outcome;
  try {
    outcome = await deps.withClient((client) => previewPattern(client, body));
  } catch {
    return bare('데이터베이스에 연결하지 못했습니다.', 503);
  }
  if (!outcome.ok) return jsonResponse({ ok: false, message: outcome.message }, 400);
  return jsonResponse(outcome);
}

/**
 * POST /api/report/voids — 무효(상쇄) 처리 · 해제. 본문은 거래 id(숫자 문자열)뿐이다.
 * 응답은 쌍 id 또는 고정 문장이다. 거래 내용을 되비추지 않는다.
 *
 * @param {Request} request
 * @param {Deps} deps
 */
export async function handleVoidPost(request, deps) {
  const blocked = await guard(request, deps);
  if (blocked !== null) return blocked;

  const body = await readJson(request);
  if (body === null) return bare(VOID_ERROR_MESSAGES.badRequest, 400);

  const parsed = parseVoidRequest(body);
  if (!parsed.ok) return bare(parsed.message, 400);

  let outcome;
  try {
    outcome = await deps.withClient((client) =>
      parsed.value.action === 'void' ? voidPair(client, parsed.value) : unvoidPair(client, parsed.value),
    );
  } catch {
    return bare('데이터베이스에 연결하지 못했습니다.', 503);
  }
  if (!outcome.ok) {
    const status =
      outcome.error === 'notFound' || outcome.error === 'pairNotFound'
        ? 404
        : outcome.error === 'alreadyVoided'
          ? 409
          : outcome.error === 'saveFailed'
            ? 500
            : 400;
    return bare(outcome.message, status);
  }
  return jsonResponse(parsed.value.action === 'void' ? { ok: true, pairId: outcome.pairId } : { ok: true });
}
