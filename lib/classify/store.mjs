// 분류기와 DB 사이. 규칙을 읽고, 이미 저장된 미분류 행을 채운다.
//
// ── 멱등 ──────────────────────────────────────────────────────────────────
//
// 다시 돌려도 결과가 같아야 한다. 그래서 **`category IS NULL` 인 행만** 본다.
// 읽을 때도(WHERE), 쓸 때도(UPDATE ... AND category IS NULL) 두 번 건다.
// 두 번째 조건은 동시성 방어다 — 업로드가 같은 행을 먼저 분류했다면 그쪽 값이
// 남는다. 사람이 대시보드에서 고친 분류를 나중에 규칙이 덮어쓰는 일도 없다.
//
// ── 종료 보장 ─────────────────────────────────────────────────────────────
//
// 배치를 `LIMIT n` 으로 끊어 읽는데, 아무 규칙에도 안 걸린 행은 `NULL` 로
// 남는다. 그래서 매번 같은 조건으로 다시 읽으면 **같은 배치를 영원히 돈다.**
// `id` 커서(keyset)로 앞으로만 나아가 이 무한 루프를 구조적으로 막는다.
// `id` 는 BIGSERIAL 이고 pg 가 문자열로 주므로, Number 로 바꾸지 않고
// 문자열 그대로 파라미터로 되돌려 보낸다(2^53 넘는 id 에서 조용히 깨지는
// 경로를 만들지 않는다).
//
// ── 로그 위생 ─────────────────────────────────────────────────────────────
//
// 이 파일에 `console` 이 없다. 에러는 `error.message` 조차 읽지 않는다 —
// pg 의 메시지에는 문제가 된 값(적요·금액)이 그대로 들어 있다.

import { createClassifier, storedSourceOf } from './engine.mjs';

/** 한 번에 읽어서 분류할 행 수. */
export const DEFAULT_CLASSIFY_BATCH = 500;

/**
 * category_rules 를 읽는다. 정렬은 분류기가 다시 하지만, DB 인덱스와 같은
 * 순서로 받아 두면 규칙 목록을 그대로 눈으로 훑을 수 있다.
 *
 * @param {{query: Function}} client
 */
export async function loadRules(client) {
  let result;
  try {
    result = await client.query(
      'SELECT id, txn_type, pattern, sign, category, priority FROM category_rules ORDER BY priority, id',
    );
  } catch {
    throw new Error('분류 규칙을 읽지 못했습니다.');
  }
  return result.rows;
}

/**
 * merchant_map 을 읽는다. 사람이 고친 매핑이라 규칙보다 세다. 방향(in · out · any)을
 * 함께 읽는다 — 분류기가 방향이 맞는 매핑을 먼저 본다(engine.mjs).
 *
 * @param {{query: Function}} client
 */
export async function loadMerchantMap(client) {
  let result;
  try {
    result = await client.query('SELECT description, direction, category, item FROM merchant_map');
  } catch {
    throw new Error('가맹점 매핑을 읽지 못했습니다.');
  }
  return result.rows;
}

/**
 * DB 에서 규칙과 매핑을 읽어 분류기를 만든다.
 *
 * @param {{query: Function}} client
 */
export async function loadClassifier(client) {
  const [rules, merchantMap] = await Promise.all([loadRules(client), loadMerchantMap(client)]);
  return createClassifier({ rules, merchantMap });
}

/**
 * 이미 저장된 미분류 행을 분류해 채운다.
 *
 * @param {{query: Function}} client 열려 있는 연결
 * @param {object} [options]
 * @param {string} [options.yearMonth] 주면 그 달만. 없으면 전체.
 * @param {number} [options.batchSize]
 * @param {{classify: Function, skipped: Array}} [options.classifier] 없으면 DB 에서 만든다
 * @returns {Promise<{scanned:number, classified:number, unmatched:number, batches:number, skippedRules:Array<{id:*, code:string}>}>}
 *   건수와 규칙 id 뿐이다. 행 내용은 어떤 형태로도 돌려주지 않는다.
 */
export async function classifyStored(client, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_CLASSIFY_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize 는 1 이상의 정수여야 합니다.');
  }

  const classifier = options.classifier ?? (await loadClassifier(client));
  const yearMonth = options.yearMonth ?? null;

  let cursor = '0';
  let scanned = 0;
  let classified = 0;
  let unmatched = 0;
  let batches = 0;

  for (;;) {
    let page;
    try {
      page = await client.query(
        `SELECT id, description, txn_type, amount
           FROM transactions
          WHERE category IS NULL
            AND id > $1::bigint
            AND ($2::char(7) IS NULL OR year_month = $2::char(7))
          ORDER BY id
          LIMIT $3`,
        [cursor, yearMonth, batchSize],
      );
    } catch {
      throw new Error('미분류 거래를 읽지 못했습니다.');
    }

    if (page.rows.length === 0) break;
    batches += 1;
    scanned += page.rows.length;
    cursor = String(page.rows[page.rows.length - 1].id);

    /**
     * (분류 · 출처 · 항목) -> id 목록. 같은 조합은 한 번에 쓴다.
     * @type {Map<string, {category: string, source: string|null, item: string|null, ids: string[]}>}
     */
    const byOutcome = new Map();
    for (const row of page.rows) {
      const { category, source, item } = classifier.classify(row);
      if (category === null) {
        unmatched += 1;
        continue;
      }
      const stored = storedSourceOf(source);
      const itemValue = item ?? null;
      const key = JSON.stringify([category, stored, itemValue]);
      const entry = byOutcome.get(key);
      if (entry === undefined) {
        byOutcome.set(key, { category, source: stored, item: itemValue, ids: [String(row.id)] });
      } else {
        entry.ids.push(String(row.id));
      }
    }

    for (const { category, source, item, ids } of byOutcome.values()) {
      let updated;
      try {
        // $1 · $2 의 자리는 예전과 같다(분류 · id 목록). 출처와 항목은 뒤에 붙인다.
        updated = await client.query(
          `UPDATE transactions
              SET category = $1,
                  category_source = $3,
                  item = $4
            WHERE category IS NULL
              AND id = ANY($2::bigint[])`,
          [category, ids, source, item],
        );
      } catch {
        throw new Error('분류 결과를 저장하지 못했습니다.');
      }
      classified += updated.rowCount;
    }

    if (page.rows.length < batchSize) break;
  }

  return { scanned, classified, unmatched, batches, skippedRules: classifier.skipped ?? [] };
}
