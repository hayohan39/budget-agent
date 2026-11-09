// 공제 트래커(/tax)의 데이터 쪽. 설계: docs/year-end-tax.md 2장.
//
//   - 귀속연도의 거래를 가계부 (분류, 항목) 묶음 · 가계부 패턴으로 모아 순출금 합계를 낸다.
//   - 묶음 · 패턴 → 공제 항목 연결(tax_item_tags · tax_pattern_tags), 직접 입력(tax_manual_entries),
//     연도 설정(tax_year_settings)을 읽고 쓴다.
//   - 연결된 묶음의 금액을 공제 항목별로 더해 계산 엔진(deductions.mjs)에 넘긴다.
//
// 금액은 저장하지 않는다. 요청마다 transactions 에서 다시 합친다 — 거래를 다시 분류하면
// 트래커가 따라 바뀐다. 로그 · console 호출이 없다.
import { sumBigInt, toBigInt, toSafeNumber } from '../money.mjs';
import { directionOf, DIRECTIONS } from '../classify/direction.mjs';
import { resolveItem } from '../classify/item.mjs';
import { compileWildcard, wildcardMatches } from '../classify/wildcard.mjs';
import { CARD_CATEGORY, FIXED1_CATEGORIES, FIXED2_CATEGORIES, VARIABLE_CATEGORY, canonicalCategory } from '../report/monthly.mjs';
import { CARD_KINDS, computeDeductions, DEDUCTION_KEYS } from './deductions.mjs';

/**
 * 공제 항목에 연결할 수 있는 분류. 수입 · 이자(들어온 돈), 카드대금(카드 공제는 T3 에서 따로),
 * 내 계좌 간 이체는 뺀다.
 */
export const TAGGABLE_CATEGORIES = Object.freeze([...FIXED1_CATEGORIES, ...FIXED2_CATEGORIES, VARIABLE_CATEGORY]);

/** tax_item_tags · tax_pattern_tags.deduction 에 들어갈 수 있는 값. 'none' = 후보에서 제외. */
export const TAG_VALUES = Object.freeze([...DEDUCTION_KEYS, 'none']);

/** 항목 이름 길이 상한. 스키마 CHECK(char_length(item) <= 200) 와 같다. */
export const TAG_ITEM_MAX_LENGTH = 200;

const yearRange = (year) => [`${year}-01`, `${year}-12`];

/**
 * @typedef {{ category: string, item: string, description: string, memo: string | null, amount: bigint }} TaxRow
 */

/**
 * 귀속연도 거래 중 공제 항목에 연결할 수 있는 분류의 행. 항목 이름은 화면과 같은 `resolveItem` 결과.
 *
 * @param {{ query: Function }} client
 * @param {number} year
 * @returns {Promise<{ rows: TaxRow[], months: string[] }>}
 */
export async function loadYearRows(client, year) {
  const [from, to] = yearRange(year);
  const { rows: monthRows } = await client.query(
    'SELECT DISTINCT year_month FROM transactions WHERE year_month BETWEEN $1 AND $2 ORDER BY year_month',
    [from, to],
  );
  const { rows } = await client.query(
    `SELECT category, item, description, memo, amount
       FROM transactions
      WHERE year_month BETWEEN $1 AND $2
        AND category IS NOT NULL`,
    [from, to],
  );

  /** @type {TaxRow[]} */
  const out = [];
  for (const row of rows) {
    const category = canonicalCategory(row.category);
    if (!TAGGABLE_CATEGORIES.includes(category)) continue;
    out.push({
      category,
      item: resolveItem({ ...row, category }),
      description: String(row.description ?? ''),
      memo: row.memo === null || row.memo === undefined ? null : String(row.memo),
      amount: toBigInt(row.amount),
    });
  }
  return { rows: out, months: monthRows.map((row) => String(row.year_month)) };
}

/** 순출금 = 출금 합계 − 입금(환불 · 해지). */
const netOf = (rows) => toSafeNumber(-sumBigInt(rows.map((row) => row.amount)));

/**
 * 행 → (분류, 항목) 묶음. 순출금이 큰 순서.
 *
 * @param {TaxRow[]} rows
 * @returns {Array<{ category: string, item: string, net: number, count: number }>}
 */
export function groupRows(rows) {
  /** @type {Map<string, { category: string, item: string, rows: TaxRow[] }>} */
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.category}\u001f${row.item}`;
    if (!byKey.has(key)) byKey.set(key, { category: row.category, item: row.item, rows: [] });
    byKey.get(key).rows.push(row);
  }
  return [...byKey.values()]
    .map((group) => ({ category: group.category, item: group.item, net: netOf(group.rows), count: group.rows.length }))
    .sort((a, b) => b.net - a.net || a.category.localeCompare(b.category) || a.item.localeCompare(b.item));
}

/**
 * 귀속연도 거래를 (분류, 항목) 묶음으로(패턴 · 직접 입력 없이).
 *
 * @param {{ query: Function }} client
 * @param {number} year
 */
export async function loadYearGroups(client, year) {
  const { rows, months } = await loadYearRows(client, year);
  return { groups: groupRows(rows), months };
}

/**
 * @typedef {{ salary: number | null, marginalRate: number | null, homelessHouseholder: boolean | null,
 *   mortgageTier: string | null }} TaxSettings
 */

/** @returns {TaxSettings} */
export function emptySettings() {
  return { salary: null, marginalRate: null, homelessHouseholder: null, mortgageTier: null };
}

/**
 * @param {{ query: Function }} client
 * @param {number} year
 * @returns {Promise<TaxSettings>}
 */
export async function loadSettings(client, year) {
  const { rows } = await client.query(
    `SELECT annual_salary, marginal_rate, homeless_householder, mortgage_tier
       FROM tax_year_settings WHERE tax_year = $1`,
    [year],
  );
  if (rows.length === 0) return emptySettings();
  const row = rows[0];
  return {
    salary: row.annual_salary === null ? null : toSafeNumber(toBigInt(row.annual_salary)),
    marginalRate: row.marginal_rate === null ? null : Number(row.marginal_rate),
    homelessHouseholder: row.homeless_householder,
    mortgageTier: row.mortgage_tier,
  };
}

/**
 * @param {{ query: Function }} client
 * @param {number} year
 * @param {TaxSettings} settings
 */
export async function saveSettings(client, year, settings) {
  await client.query(
    `INSERT INTO tax_year_settings (tax_year, annual_salary, marginal_rate, homeless_householder, mortgage_tier)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tax_year) DO UPDATE SET
       annual_salary = EXCLUDED.annual_salary,
       marginal_rate = EXCLUDED.marginal_rate,
       homeless_householder = EXCLUDED.homeless_householder,
       mortgage_tier = EXCLUDED.mortgage_tier,
       updated_at = NOW()`,
    [year, settings.salary, settings.marginalRate, settings.homelessHouseholder, settings.mortgageTier],
  );
}

/**
 * @param {{ query: Function }} client
 * @returns {Promise<Array<{ category: string, item: string, deduction: string }>>}
 */
export async function loadTags(client) {
  const { rows } = await client.query('SELECT category, item, deduction FROM tax_item_tags ORDER BY category, item');
  return rows.map((row) => ({ category: row.category, item: row.item, deduction: row.deduction }));
}

/** @param {{ query: Function }} client */
export async function setTag(client, { category, item, deduction }) {
  await client.query(
    `INSERT INTO tax_item_tags (category, item, deduction) VALUES ($1, $2, $3)
     ON CONFLICT (category, item) DO UPDATE SET deduction = EXCLUDED.deduction, updated_at = NOW()`,
    [category, item, deduction],
  );
}

/** @param {{ query: Function }} client */
export async function deleteTag(client, { category, item }) {
  const { rowCount } = await client.query('DELETE FROM tax_item_tags WHERE category = $1 AND item = $2', [category, item]);
  return rowCount ?? 0;
}

// ── 후보 찾기 ─────────────────────────────────────────────────────────────

/**
 * 항목 이름으로 공제 후보를 짐작한다. 결과는 **제안**일 뿐이고 사람이 연결해야 금액이 잡힌다.
 *
 *   - deduction: 제안하는 공제 항목. 후보지만 무엇인지 모르면 null(주택 대출: 전세 · 주담대를 사람이 고른다)
 *   - candidate: 후보로 보여 줄 만한가
 *
 * ISA 는 세액공제 대상이 아니라 후보에서 뺀다. 건강보험 · 고용보험 · 국민연금은 급여에서 빠지는
 * 4대보험이라 보험료 · 연금 후보가 아니다.
 *
 * @param {string} category
 * @param {string} item
 * @returns {{ candidate: boolean, deduction: string | null }}
 */
export function suggestDeduction(category, item) {
  const text = item.toLowerCase();
  const has = (pattern) => pattern.test(text);
  if (has(/isa/) || has(/건강보험|고용보험|국민연금|장기요양/)) return { candidate: false, deduction: null };
  if (has(/irp|퇴직연금/)) return { candidate: true, deduction: 'irp' };
  if (has(/연금/)) return { candidate: true, deduction: 'pension_savings' };
  if (has(/청약/)) return { candidate: true, deduction: 'housing_subscription' };
  if (has(/월세/)) return { candidate: true, deduction: 'rent' };
  if (has(/고향사랑/)) return { candidate: true, deduction: 'donation_hometown' };
  if (has(/정치|후원회/)) return { candidate: true, deduction: 'donation_political' };
  if (has(/기부|후원/)) return { candidate: true, deduction: 'donation_general' };
  if (has(/보험/)) return { candidate: true, deduction: 'insurance' };
  if (category === '주거비' && has(/대출|이자/)) return { candidate: true, deduction: null };
  return { candidate: false, deduction: null };
}

// ── 패턴 연결 ─────────────────────────────────────────────────────────────

/**
 * @typedef {{ basis: 'description' | 'memo', direction: 'in' | 'out' | 'any', pattern: string }} PatternKey
 */

const patternKeyOf = (p) => `${p.basis}\u001f${p.direction}\u001f${p.pattern}`;

/**
 * 가계부 패턴과 같은 기준으로 행 하나가 맞는가: 기준(적요 · 메모)의 글자를 같은 와일드카드 매처로,
 * 방향은 'any' 가 아니면 금액 부호로 본다.
 *
 * @param {PatternKey & { tokens: string[] }} compiled
 * @param {TaxRow} row
 */
function patternMatches(compiled, row) {
  if (compiled.direction !== DIRECTIONS.any && compiled.direction !== directionOf(row.amount)) return false;
  const subject = compiled.basis === 'memo' ? row.memo : row.description;
  if (subject === null || subject === '') return false;
  return wildcardMatches(compiled.tokens, subject);
}

/**
 * 행을 패턴별로 나눈다. 한 행은 **먼저 맞는 패턴 하나**에만 간다(같은 거래를 두 번 세지 않는다).
 * 순서는 글자가 긴(더 구체적인) 패턴부터, 같으면 패턴 · 기준 · 방향 순.
 *
 * @template {PatternKey} P
 * @param {TaxRow[]} rows
 * @param {P[]} patterns
 * @returns {{ matched: Array<{ pattern: P, rows: TaxRow[] }>, rest: TaxRow[] }}
 */
export function splitByPatterns(rows, patterns) {
  const ordered = [...patterns]
    .sort(
      (a, b) =>
        [...b.pattern].length - [...a.pattern].length ||
        a.pattern.localeCompare(b.pattern) ||
        a.basis.localeCompare(b.basis) ||
        a.direction.localeCompare(b.direction),
    )
    .map((pattern) => ({ pattern, compiled: { ...pattern, tokens: compileWildcard(pattern.pattern) }, rows: [] }));
  const rest = [];
  for (const row of rows) {
    const hit = ordered.find((entry) => patternMatches(entry.compiled, row));
    if (hit) hit.rows.push(row);
    else rest.push(row);
  }
  return { matched: ordered.map(({ pattern, rows: hits }) => ({ pattern, rows: hits })), rest };
}

/** @param {{ query: Function }} client */
export async function loadPatternTags(client) {
  const { rows } = await client.query(
    'SELECT basis, direction, pattern, deduction FROM tax_pattern_tags ORDER BY pattern, basis, direction',
  );
  return rows.map((row) => ({
    basis: row.basis,
    direction: row.direction,
    pattern: row.pattern,
    deduction: row.deduction,
  }));
}

/** @param {{ query: Function }} client */
export async function setPatternTag(client, { basis, direction, pattern, deduction }) {
  await client.query(
    `INSERT INTO tax_pattern_tags (basis, direction, pattern, deduction) VALUES ($1, $2, $3, $4)
     ON CONFLICT (basis, direction, pattern) DO UPDATE SET deduction = EXCLUDED.deduction, updated_at = NOW()`,
    [basis, direction, pattern, deduction],
  );
}

/** @param {{ query: Function }} client */
export async function deletePatternTag(client, { basis, direction, pattern }) {
  const { rowCount } = await client.query(
    'DELETE FROM tax_pattern_tags WHERE basis = $1 AND direction = $2 AND pattern = $3',
    [basis, direction, pattern],
  );
  return rowCount ?? 0;
}

/**
 * 가계부에 저장된 적요 · 메모 패턴(연결 후보의 출처). /classify 의 "저장된 규칙 → 패턴" 과 같은 목록.
 *
 * @param {{ query: Function }} client
 * @returns {Promise<Array<PatternKey & { category: string, item: string | null }>>}
 */
export async function loadSavedPatterns(client) {
  const { rows } = await client.query(
    `SELECT 'description' AS basis, direction, pattern, category, item FROM description_patterns
     UNION ALL
     SELECT 'memo' AS basis, direction, pattern, category, item FROM memo_patterns`,
  );
  return rows.map((row) => ({
    basis: row.basis,
    direction: row.direction,
    pattern: String(row.pattern),
    category: String(canonicalCategory(row.category)),
    item: row.item === null || row.item === undefined ? null : String(row.item),
  }));
}

// ── 직접 입력 ─────────────────────────────────────────────────────────────

/** 직접 입력 이름 길이 상한. 스키마 CHECK(char_length(label) <= 40) 와 같다. */
export const MANUAL_LABEL_MAX_LENGTH = 40;

/**
 * @param {{ query: Function }} client
 * @param {number} year
 * @returns {Promise<Array<{ id: string, deduction: string, label: string, amount: number }>>}
 */
export async function loadManualEntries(client, year) {
  const { rows } = await client.query(
    'SELECT id, deduction, label, amount FROM tax_manual_entries WHERE tax_year = $1 ORDER BY id',
    [year],
  );
  return rows.map((row) => ({
    id: String(row.id),
    deduction: row.deduction,
    label: row.label,
    amount: toSafeNumber(toBigInt(row.amount)),
  }));
}

/** @param {{ query: Function }} client */
export async function addManualEntry(client, { year, deduction, label, amount }) {
  await client.query(
    'INSERT INTO tax_manual_entries (tax_year, deduction, label, amount) VALUES ($1, $2, $3, $4)',
    [year, deduction, label, amount],
  );
}

/** 이름 · 금액 고치기. 고친 행 수(0 이면 없는 id). */
export async function updateManualEntry(client, { id, label, amount }) {
  const { rowCount } = await client.query(
    'UPDATE tax_manual_entries SET label = $2, amount = $3, updated_at = NOW() WHERE id = $1',
    [id, label, amount],
  );
  return rowCount ?? 0;
}

/** @param {{ query: Function }} client */
export async function deleteManualEntry(client, { id }) {
  const { rowCount } = await client.query('DELETE FROM tax_manual_entries WHERE id = $1', [id]);
  return rowCount ?? 0;
}

// ── 화면용 조립 ───────────────────────────────────────────────────────────

/**
 * @typedef {{ kind: 'group', category: string, item: string, net: number }
 *   | { kind: 'pattern', basis: string, direction: string, pattern: string, net: number }
 *   | { kind: 'manual', id: string, label: string, net: number }} Source
 */

/**
 * 거래 행 · 연결 · 설정 → 트래커 화면 데이터. 순수 함수.
 *
 * 한 거래는 한 번만 센다. 순서:
 *   1. **연결된 패턴**(tax_pattern_tags)이 먼저 가져간다. 'none' 패턴에 맞는 거래는 후보에서도 빠진다.
 *   2. 남은 거래를 (분류, 항목) 묶음으로 모아 **연결된 묶음**(tax_item_tags)을 센다.
 *   3. 연결되지 않은 거래 중 **가계부 패턴**에 맞는 것은 패턴 후보로, 나머지는 묶음 후보로 보여 준다
 *      (가계부에서 패턴으로 묶인 거래는 트래커에서도 패턴 하나로 보인다).
 *   4. **직접 입력**(tax_manual_entries)은 그대로 더한다.
 *
 * @param {{ year: number, rows: TaxRow[], tags: Array<{ category: string, item: string, deduction: string }>,
 *   patternTags?: Array<PatternKey & { deduction: string }>,
 *   savedPatterns?: Array<PatternKey & { category: string, item: string | null }>,
 *   manualEntries?: Array<{ id: string, deduction: string, label: string, amount: number }>,
 *   settings: TaxSettings, card?: import('./deductions.mjs').CardInput }} input  card 는 combineCard() 결과
 */
export function buildTracker({ year, rows, tags, patternTags = [], savedPatterns = [], manualEntries = [], settings, card }) {
  /** @type {Record<string, number>} */
  const amounts = Object.fromEntries(DEDUCTION_KEYS.map((key) => [key, 0]));
  /** @type {Record<string, Source[]>} */
  const sources = Object.fromEntries(DEDUCTION_KEYS.map((key) => [key, []]));
  const dismissed = [];
  const add = (deduction, source) => {
    amounts[deduction] += source.net;
    sources[deduction].push(source);
  };

  // 1. 연결된 패턴
  const known = patternTags.filter((tag) => TAG_VALUES.includes(tag.deduction));
  const byPattern = splitByPatterns(rows, known);
  for (const { pattern: tag, rows: hits } of byPattern.matched) {
    const source = { kind: 'pattern', basis: tag.basis, direction: tag.direction, pattern: tag.pattern, net: Math.max(0, netOf(hits)) };
    if (tag.deduction === 'none') dismissed.push(source);
    else add(tag.deduction, source);
  }

  // 2. 연결된 묶음. 올해 거래가 없는 연결도 0원으로 보여 준다(연결이 살아 있다는 표시).
  const groups = groupRows(byPattern.rest);
  const groupOf = new Map(groups.map((group) => [`${group.category}\u001f${group.item}`, group]));
  const tagged = new Set(tags.map((tag) => `${tag.category}\u001f${tag.item}`));
  for (const tag of tags) {
    const group = groupOf.get(`${tag.category}\u001f${tag.item}`);
    const source = { kind: 'group', category: tag.category, item: tag.item, net: group ? Math.max(0, group.net) : 0 };
    if (tag.deduction === 'none') {
      if (group) dismissed.push(source);
    } else if (DEDUCTION_KEYS.includes(tag.deduction)) {
      add(tag.deduction, source);
    }
  }

  // 3. 후보: 연결 안 된 거래 → 가계부 패턴 후보 → 묶음 후보
  const untagged = byPattern.rest.filter((row) => !tagged.has(`${row.category}\u001f${row.item}`));
  const linkedKeys = new Set(patternTags.map(patternKeyOf));
  const bySaved = splitByPatterns(untagged, savedPatterns.filter((p) => !linkedKeys.has(patternKeyOf(p))));
  const candidates = [];
  const others = [];
  for (const { pattern, rows: hits } of bySaved.matched) {
    const net = netOf(hits);
    if (net <= 0) continue;
    const suggestion = suggestDeduction(pattern.category, pattern.item ?? pattern.pattern);
    const entry = {
      kind: 'pattern',
      basis: pattern.basis,
      direction: pattern.direction,
      pattern: pattern.pattern,
      category: pattern.category,
      item: pattern.item,
      net,
      suggested: suggestion.deduction,
    };
    (suggestion.candidate ? candidates : others).push(entry);
  }
  for (const group of groupRows(bySaved.rest)) {
    if (group.net <= 0) continue;
    const suggestion = suggestDeduction(group.category, group.item);
    const entry = { kind: 'group', category: group.category, item: group.item, net: group.net, suggested: suggestion.deduction };
    (suggestion.candidate ? candidates : others).push(entry);
  }

  // 4. 직접 입력
  for (const entry of manualEntries) {
    if (DEDUCTION_KEYS.includes(entry.deduction)) {
      add(entry.deduction, { kind: 'manual', id: entry.id, label: entry.label, net: entry.amount });
    }
  }

  const result = computeDeductions({
    year,
    salary: settings.salary,
    marginalRate: settings.marginalRate,
    homelessHouseholder: settings.homelessHouseholder,
    mortgageTier: settings.mortgageTier,
    amounts,
    card,
  });

  return { result, sources, candidates, others, dismissed };
}

/**
 * 거래가 있는 달 목록 → `3월~10월` · `1월, 3월~5월` 같은 짧은 글.
 *
 * @param {string[]} months `YYYY-MM` 오름차순
 */
export function describeMonths(months) {
  const numbers = months.map((month) => Number(month.slice(5, 7)));
  const runs = [];
  for (const n of numbers) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}월` : `${a}월~${b}월`)).join(', ');
}

// ── 카드 (T3) ─────────────────────────────────────────────────────────────

/** `YYYY-MM` 에서 n 달 이동. */
export function shiftMonth(yearMonth, n) {
  const total = Number(yearMonth.slice(0, 4)) * 12 + Number(yearMonth.slice(5, 7)) - 1 + n;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/**
 * 카드대금 결제액 → 귀속연도 **사용월**별 추정 사용액.
 *
 * 결제월을 한 달 앞당겨 사용월로 본다(대부분 카드는 전월 사용분을 이번 달에 결제한다). 그래서
 * 2026년 사용분은 2026-02 ~ 2027-01 결제다. 카드사별로 나눠 보여 주고(`resolveItem` = 카드사 이름),
 * 같은 달 · 같은 카드사의 입금(환불 · 취소)은 뺀다. 결제수단은 알 수 없어 화면 · 엔진 모두 전부
 * 신용카드로 본다(PLAN.md: 카드는 전부 신용카드).
 *
 * @param {{ query: Function }} client
 * @param {number} year
 * @returns {Promise<Array<{ month: string, total: number, byIssuer: Array<{ issuer: string, amount: number }> }>>}
 *   사용월 오름차순. 결제 내역이 있는 달만.
 */
export async function loadCardUsage(client, year) {
  const from = `${year}-02`;
  const to = `${year + 1}-01`;
  const { rows } = await client.query(
    `SELECT year_month, category, item, description, amount
       FROM transactions
      WHERE category = $1 AND year_month BETWEEN $2 AND $3`,
    [CARD_CATEGORY, from, to],
  );

  /** @type {Map<string, Map<string, bigint[]>>} */
  const byMonth = new Map();
  for (const row of rows) {
    const month = shiftMonth(String(row.year_month), -1);
    const issuer = resolveItem(row);
    if (!byMonth.has(month)) byMonth.set(month, new Map());
    const issuers = byMonth.get(month);
    if (!issuers.has(issuer)) issuers.set(issuer, []);
    issuers.get(issuer).push(toBigInt(row.amount));
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, issuers]) => {
      const byIssuer = [...issuers.entries()]
        .map(([issuer, amounts]) => ({ issuer, amount: Math.max(0, toSafeNumber(-sumBigInt(amounts))) }))
        .sort((a, b) => b.amount - a.amount || a.issuer.localeCompare(b.issuer));
      return { month, total: byIssuer.reduce((sum, row) => sum + row.amount, 0), byIssuer };
    });
}

/**
 * @typedef {{ throughMonth: string, credit: number, debit: number, culture: number, market: number,
 *   transit: number }} CardConfirmation
 */

/**
 * @param {{ query: Function }} client
 * @param {number} year
 * @returns {Promise<CardConfirmation | null>}
 */
export async function loadCardConfirmation(client, year) {
  const { rows } = await client.query(
    `SELECT through_month, credit, debit, culture, market, transit
       FROM tax_card_confirmations WHERE tax_year = $1`,
    [year],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const value = { throughMonth: String(row.through_month) };
  for (const kind of CARD_KINDS) value[kind] = toSafeNumber(toBigInt(row[kind]));
  return /** @type {CardConfirmation} */ (value);
}

/**
 * @param {{ query: Function }} client
 * @param {number} year
 * @param {CardConfirmation} value
 */
export async function saveCardConfirmation(client, year, value) {
  await client.query(
    `INSERT INTO tax_card_confirmations (tax_year, through_month, credit, debit, culture, market, transit)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tax_year) DO UPDATE SET
       through_month = EXCLUDED.through_month,
       credit = EXCLUDED.credit, debit = EXCLUDED.debit, culture = EXCLUDED.culture,
       market = EXCLUDED.market, transit = EXCLUDED.transit,
       updated_at = NOW()`,
    [year, value.throughMonth, value.credit, value.debit, value.culture, value.market, value.transit],
  );
}

/** @param {{ query: Function }} client */
export async function clearCardConfirmation(client, year) {
  await client.query('DELETE FROM tax_card_confirmations WHERE tax_year = $1', [year]);
}

/**
 * 확인값 + 추정 → 엔진 입력. 기준월까지는 확인값(결제수단별), 그 뒤 사용월은 추정(신용카드).
 * 확인값이 없으면 전부 추정이다.
 *
 * @param {{ usage: Array<{ month: string, total: number }>, confirmation: CardConfirmation | null }} input
 * @returns {{ input: import('./deductions.mjs').CardInput, confirmedTotal: number, estimatedTotal: number,
 *   estimatedMonths: string[] }}
 */
export function combineCard({ usage, confirmation }) {
  const after = confirmation === null ? usage : usage.filter((row) => row.month > confirmation.throughMonth);
  const estimatedTotal = after.reduce((sum, row) => sum + row.total, 0);
  const base = Object.fromEntries(CARD_KINDS.map((kind) => [kind, confirmation === null ? 0 : confirmation[kind]]));
  const confirmedTotal = CARD_KINDS.reduce((sum, kind) => sum + base[kind], 0);
  return {
    input: { ...base, credit: base.credit + estimatedTotal, estimated: after.length > 0 },
    confirmedTotal,
    estimatedTotal,
    estimatedMonths: after.map((row) => row.month),
  };
}
