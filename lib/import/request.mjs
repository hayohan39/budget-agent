// /api/import 요청의 모양을 판정하는 순수 함수들.
//
// 라우트 핸들러(app/api/import/route.ts)는 Next.js 없이 테스트하기 어렵다.
// 그래서 "이 요청을 받아도 되는가" 를 가르는 판단을 여기로 빼서
// `node --test` 로 직접 못 박는다. 이 파일은 DB 도 파일 바이트도 만지지 않는다.
//
// ── 원칙 ───────────────────────────────────────────────────────────────────
//
//   - **모드는 명시해야 한다.** 없거나 모르는 값이면 거부한다(fail closed).
//     기본값을 두지 않는다 — 특히 "적용" 을 기본값으로 두면, 모드를 빠뜨린
//     요청 하나가 그대로 DB 쓰기가 된다.
//   - **요청 하나에 파일 하나.** Vercel 서버리스의 요청 본문 상한은 4.5MB 다.
//     한 파일 상한이 4MB 이므로 파일 둘만 실어도 넘을 수 있다. 여러 파일은
//     클라이언트가 파일마다 요청을 나눠 보낸다.
import { MAX_FILE_BYTES } from './statement.mjs';

/** 허용하는 모드. 이 둘 말고는 없다. */
export const IMPORT_MODES = Object.freeze({
  /** 저장하지 않고 건수만 본다. DB 에는 SELECT 만 나간다. */
  preview: 'preview',
  /** 처음부터 다시 검증하고 저장한다. */
  apply: 'apply',
});

/** 모드를 싣는 쿼리 파라미터 이름. 본문을 읽기 전에 판정하려고 URL 에 둔다. */
export const MODE_PARAM = 'mode';

/**
 * multipart 오버헤드(경계 문자열 · 파트 헤더 · 비밀번호 필드)를 위한 여유.
 * 비밀번호는 255자 상한이고 UTF-8 로 많아야 765바이트다. 64KB 면 넉넉하다.
 */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** 한 요청 본문의 상한. 파일 하나 + 오버헤드. Vercel 의 4.5MB 보다 낮다. */
export const MAX_REQUEST_BYTES = MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES;

/**
 * 모드 문자열을 판정한다. 정확히 일치할 때만 받는다.
 *
 * 대소문자 · 앞뒤 공백을 너그럽게 봐 주지 않는다. `Apply`, ` apply` 도 거부한다.
 *
 * @param {unknown} value
 * @returns {'preview' | 'apply' | null} 받을 수 없으면 null
 */
export function parseImportMode(value) {
  if (value === IMPORT_MODES.preview) return IMPORT_MODES.preview;
  if (value === IMPORT_MODES.apply) return IMPORT_MODES.apply;
  return null;
}

/**
 * `Content-Length` 헤더만 보고 본문이 상한을 넘는지 판정한다.
 *
 * 본문을 읽기 **전에** 거르려는 것이다. 헤더가 없으면(청크 전송 등) 여기서는
 * 판단하지 않는다 — 그때는 플랫폼의 본문 상한과 파일 단위 크기 검사가 막는다.
 * 숫자가 아닌 값은 넘는 것으로 본다(fail closed).
 *
 * @param {string | null | undefined} header
 * @returns {boolean} 넘으면 true
 */
export function exceedsRequestLimit(header) {
  if (header === null || header === undefined || header === '') return false;
  if (!/^[0-9]+$/.test(header)) return true;
  const length = Number(header);
  return !Number.isSafeInteger(length) || length > MAX_REQUEST_BYTES;
}

/**
 * 폼의 파일 필드 값들에서 파일 하나를 고른다. 정확히 하나일 때만 받는다.
 *
 * 파일을 고르지 않은 채 폼을 보내면 브라우저는 이름도 내용도 없는 파트를
 * 하나 실어 보낸다. 그것은 "파일 0개" 로 센다.
 *
 * @template {{ name: string, size: number }} F
 * @param {Array<unknown>} entries `formData.getAll(field)` 의 결과
 * @returns {{ ok: true, file: F } | { ok: false, error: 'noFile' | 'tooManyFiles' }}
 */
export function pickSingleUpload(entries) {
  const files = entries.filter(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'arrayBuffer' in entry &&
      typeof entry.size === 'number' &&
      typeof entry.name === 'string' &&
      (entry.size > 0 || entry.name !== ''),
  );
  if (files.length === 0) return { ok: false, error: 'noFile' };
  if (files.length > 1) return { ok: false, error: 'tooManyFiles' };
  return { ok: true, file: /** @type {F} */ (files[0]) };
}
