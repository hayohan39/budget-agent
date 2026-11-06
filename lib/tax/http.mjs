// /api/tax/settings · /api/tax/tags 의 핸들러 본체. app/api/tax/**/route.ts 는 인증 · DB 를 꽂아 주기만 한다.
//
// 가드 순서와 응답 규칙은 /api/classify 와 같다(lib/classify/http.mjs 의 guard · readJson 을 그대로 쓴다):
// 세션 → 화이트리스트(요청마다) → Origin → 본문 검사 → DB.
//
//   - 응답 본문에는 고정 문장과 ok 뿐이다. **받은 값(연봉 · 항목 이름)을 되비추지 않는다.**
//   - 오류 문장에도 값을 넣지 않는다.
//   - console 호출이 없다. catch 는 바인딩 없는 `catch {}` 다.
import { guard, jsonResponse, readJson } from '../classify/http.mjs';
import { normalizeDescription } from '../text/description.mjs';
import { rulesFor, SUPPORTED_YEARS } from './deductions.mjs';
import { deleteTag, saveSettings, setTag, TAG_ITEM_MAX_LENGTH, TAG_VALUES, TAGGABLE_CATEGORIES } from './store.mjs';

/** 연봉 상한(원). 스키마 CHECK(annual_salary BETWEEN 0 AND 10000000000) 와 같다. */
export const MAX_SALARY = 10_000_000_000;

export const TAX_ERROR_MESSAGES = Object.freeze({
  badRequest: '요청 형식이 올바르지 않습니다.',
  year: '지원하지 않는 귀속연도입니다.',
  salary: '연봉은 0 이상의 정수(원)로 입력해 주세요.',
  marginalRate: '한계세율은 세율 구간 중 하나를 골라 주세요.',
  homeless: '무주택 세대주 여부가 올바르지 않습니다.',
  mortgageTier: '주택담보대출 한도 구간이 올바르지 않습니다.',
  category: '연결할 수 없는 분류입니다.',
  item: '항목 이름이 올바르지 않습니다.',
  deduction: '공제 항목이 올바르지 않습니다.',
  action: '알 수 없는 동작입니다.',
});

const CONTROL = /[\p{Cc}\p{Cf}]/u;

const fail = (key) => ({ ok: false, message: TAX_ERROR_MESSAGES[key] });

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(body, keys) {
  return Object.keys(body).every((key) => keys.includes(key));
}

/**
 * 연도 설정 저장 요청. 다섯 칸을 한 번에 받는다(빈칸은 null — "미입력").
 *
 * @param {unknown} body
 * @returns {{ ok: true, value: { year: number, settings: import('./store.mjs').TaxSettings } } | { ok: false, message: string }}
 */
export function parseSettingsRequest(body) {
  const keys = ['year', 'salary', 'marginalRate', 'homelessHouseholder', 'mortgageTier'];
  if (!isPlainObject(body) || !hasOnly(body, keys)) return fail('badRequest');
  if (!SUPPORTED_YEARS.includes(body.year)) return fail('year');
  const rules = rulesFor(body.year);

  const salary = body.salary ?? null;
  if (salary !== null && (!Number.isSafeInteger(salary) || salary < 0 || salary > MAX_SALARY)) return fail('salary');

  const marginalRate = body.marginalRate ?? null;
  if (marginalRate !== null && !rules.marginalRates.includes(marginalRate)) return fail('marginalRate');

  const homelessHouseholder = body.homelessHouseholder ?? null;
  if (homelessHouseholder !== null && typeof homelessHouseholder !== 'boolean') return fail('homeless');

  const mortgageTier = body.mortgageTier ?? null;
  if (mortgageTier !== null && mortgageTier !== 'none' && !Object.hasOwn(rules.mortgageInterest.tiers, mortgageTier)) {
    return fail('mortgageTier');
  }

  return { ok: true, value: { year: body.year, settings: { salary, marginalRate, homelessHouseholder, mortgageTier } } };
}

/**
 * 묶음 연결 요청. `set` 은 (분류, 항목) → 공제 항목(또는 'none'), `delete` 는 연결 해제.
 *
 * 항목 이름은 화면이 보여 준 값(resolveItem 결과)이다. 같은 정규화를 다시 거쳐 키로 쓴다.
 * 제어 문자 · 길이 초과는 거부한다(조용히 고치지 않는다).
 *
 * @param {unknown} body
 * @returns {{ ok: true, value: { action: 'set' | 'delete', category: string, item: string, deduction?: string } }
 *   | { ok: false, message: string }}
 */
export function parseTagRequest(body) {
  if (!isPlainObject(body) || !hasOnly(body, ['action', 'category', 'item', 'deduction'])) return fail('badRequest');
  if (body.action !== 'set' && body.action !== 'delete') return fail('action');
  if (!TAGGABLE_CATEGORIES.includes(body.category)) return fail('category');

  if (typeof body.item !== 'string' || CONTROL.test(body.item)) return fail('item');
  const item = normalizeDescription(body.item);
  if (item === '' || [...item].length > TAG_ITEM_MAX_LENGTH) return fail('item');

  if (body.action === 'delete') {
    if (body.deduction !== undefined) return fail('badRequest');
    return { ok: true, value: { action: 'delete', category: body.category, item } };
  }
  if (!TAG_VALUES.includes(body.deduction)) return fail('deduction');
  return { ok: true, value: { action: 'set', category: body.category, item, deduction: body.deduction } };
}

/**
 * @typedef {{
 *   auth: () => Promise<any>,
 *   isAllowedEmail: (email: string | null | undefined) => boolean,
 *   withClient: <T>(fn: (client: {query: Function}) => Promise<T>) => Promise<T>,
 * }} Deps
 */

const bare = (message, status) => jsonResponse({ ok: false, message }, status);

/**
 * POST /api/tax/settings
 *
 * @param {Request} request
 * @param {Deps} deps
 */
export async function handleTaxSettingsPost(request, deps) {
  const blocked = await guard(request, deps);
  if (blocked !== null) return blocked;

  const body = await readJson(request);
  if (body === null) return bare(TAX_ERROR_MESSAGES.badRequest, 400);
  const parsed = parseSettingsRequest(body);
  if (!parsed.ok) return bare(parsed.message, 400);

  try {
    await deps.withClient((client) => saveSettings(client, parsed.value.year, parsed.value.settings));
  } catch {
    return bare('저장하지 못했습니다. 잠시 후 다시 시도해 주세요.', 503);
  }
  return jsonResponse({ ok: true });
}

/**
 * POST /api/tax/tags
 *
 * @param {Request} request
 * @param {Deps} deps
 */
export async function handleTaxTagPost(request, deps) {
  const blocked = await guard(request, deps);
  if (blocked !== null) return blocked;

  const body = await readJson(request);
  if (body === null) return bare(TAX_ERROR_MESSAGES.badRequest, 400);
  const parsed = parseTagRequest(body);
  if (!parsed.ok) return bare(parsed.message, 400);

  try {
    await deps.withClient((client) =>
      parsed.value.action === 'delete' ? deleteTag(client, parsed.value) : setTag(client, parsed.value),
    );
  } catch {
    return bare('저장하지 못했습니다. 잠시 후 다시 시도해 주세요.', 503);
  }
  return jsonResponse({ ok: true });
}
