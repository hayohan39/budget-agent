// 공제 트래커(/tax)의 데이터 쪽. 설계: docs/year-end-tax.md 2장.
//
//   - 귀속연도의 거래를 가계부 (분류, 항목) 묶음으로 모아 순출금 합계를 낸다.
//   - 묶음 → 공제 항목 연결(tax_item_tags)과 연도 설정(tax_year_settings)을 읽고 쓴다.
//   - 연결된 묶음의 금액을 공제 항목별로 더해 계산 엔진(deductions.mjs)에 넘긴다.
//
// 금액은 저장하지 않는다. 요청마다 transactions 에서 다시 합친다 — 거래를 다시 분류하면
// 트래커가 따라 바뀐다. 로그 · console 호출이 없다.
import { sumBigInt, toBigInt, toSafeNumber } from '../money.mjs';
import { resolveItem } from '../classify/item.mjs';
import { FIXED1_CATEGORIES, FIXED2_CATEGORIES, VARIABLE_CATEGORY, canonicalCategory } from '../report/monthly.mjs';
import { computeDeductions, DEDUCTION_KEYS } from './deductions.mjs';

/**
 * 공제 항목에 연결할 수 있는 분류. 수입 · 이자(들어온 돈), 카드대금(카드 공제는 T3 에서 따로),
 * 내 계좌 간 이체는 뺀다.
 */
export const TAGGABLE_CATEGORIES = Object.freeze([...FIXED1_CATEGORIES, ...FIXED2_CATEGORIES, VARIABLE_CATEGORY]);

/** tax_item_tags.deduction 에 들어갈 수 있는 값. 'none' = 공제 아님. */
export const TAG_VALUES = Object.freeze([...DEDUCTION_KEYS, 'none']);

/** 항목 이름 길이 상한. 스키마 CHECK(char_length(item) <= 200) 와 같다. */
export const TAG_ITEM_MAX_LENGTH = 200;

const yearRange = (year) => [`${year}-01`, `${year}-12`];

/**
 * 귀속연도 거래를 (분류, 항목) 묶음으로. 순출금 = 출금 합계 − 같은 묶음의 입금(환불 · 해지).
 *
 * @param {{ query: Function }} client
 * @param {number} year
 * @returns {Promise<{ groups: Array<{ category: string, item: string, net: number, count: number }>, months: string[] }>}
 */
export async function loadYearGroups(client, year) {
  const [from, to] = yearRange(year);
  const { rows: monthRows } = await client.query(
    'SELECT DISTINCT year_month FROM transactions WHERE year_month BETWEEN $1 AND $2 ORDER BY year_month',
    [from, to],
  );
  const { rows } = await client.query(
    `SELECT category, item, description, amount
       FROM transactions
      WHERE year_month BETWEEN $1 AND $2
        AND category IS NOT NULL`,
    [from, to],
  );

  /** @type {Map<string, { category: string, item: string, amounts: bigint[] }>} */
  const byKey = new Map();
  for (const row of rows) {
    const category = canonicalCategory(row.category);
    if (!TAGGABLE_CATEGORIES.includes(category)) continue;
    const item = resolveItem({ ...row, category });
    const key = `${category}\u001f${item}`;
    let group = byKey.get(key);
    if (!group) {
      group = { category, item, amounts: [] };
      byKey.set(key, group);
    }
    group.amounts.push(toBigInt(row.amount));
  }

  const groups = [...byKey.values()]
    .map(({ category, item, amounts }) => ({
      category,
      item,
      net: toSafeNumber(-sumBigInt(amounts)),
      count: amounts.length,
    }))
    .sort((a, b) => b.net - a.net || a.category.localeCompare(b.category) || a.item.localeCompare(b.item));

  return { groups, months: monthRows.map((row) => String(row.year_month)) };
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

// ── 화면용 조립 ───────────────────────────────────────────────────────────

/**
 * 묶음 · 연결 · 설정 → 트래커 화면 데이터. 순수 함수.
 *
 * @param {{ year: number, groups: Array<{ category: string, item: string, net: number, count: number }>,
 *   tags: Array<{ category: string, item: string, deduction: string }>, settings: TaxSettings }} input
 */
export function buildTracker({ year, groups, tags, settings }) {
  const tagOf = new Map(tags.map((tag) => [`${tag.category}\u001f${tag.item}`, tag.deduction]));
  const groupOf = new Map(groups.map((group) => [`${group.category}\u001f${group.item}`, group]));

  /** @type {Record<string, number>} */
  const amounts = Object.fromEntries(DEDUCTION_KEYS.map((key) => [key, 0]));
  /** @type {Record<string, Array<{ category: string, item: string, net: number }>>} */
  const sources = Object.fromEntries(DEDUCTION_KEYS.map((key) => [key, []]));
  const dismissed = [];

  // 연결된 묶음. 올해 거래가 없는 연결도 0원으로 보여 준다(연결이 살아 있다는 표시).
  for (const tag of tags) {
    const group = groupOf.get(`${tag.category}\u001f${tag.item}`);
    const net = group ? Math.max(0, group.net) : 0;
    if (tag.deduction === 'none') {
      if (group) dismissed.push({ category: tag.category, item: tag.item, net });
      continue;
    }
    if (!DEDUCTION_KEYS.includes(tag.deduction)) continue;
    amounts[tag.deduction] += net;
    sources[tag.deduction].push({ category: tag.category, item: tag.item, net });
  }

  // 연결되지 않은 묶음 중 순출금이 있는 것: 후보 / 그 밖.
  const candidates = [];
  const others = [];
  for (const group of groups) {
    if (group.net <= 0 || tagOf.has(`${group.category}\u001f${group.item}`)) continue;
    const suggestion = suggestDeduction(group.category, group.item);
    const entry = { category: group.category, item: group.item, net: group.net, suggested: suggestion.deduction };
    (suggestion.candidate ? candidates : others).push(entry);
  }

  const result = computeDeductions({
    year,
    salary: settings.salary,
    marginalRate: settings.marginalRate,
    homelessHouseholder: settings.homelessHouseholder,
    mortgageTier: settings.mortgageTier,
    amounts,
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
