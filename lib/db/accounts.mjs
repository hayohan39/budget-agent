// accounts 테이블 읽기.
//
// 파싱 결과를 계좌에 붙이려면 등록된 계좌 목록이 필요하다. 이 모듈은 읽기만
// 한다 — 등록은 scripts/seed-accounts.mjs 의 몫이다.
//
// 돌려주는 모양은 lib/toss/normalize.mjs 의 `resolveAccount` ·
// `toTransactionRecords` 가 기대하는 것과 같다: `{ id, role, nickname, last4 }`.
// 여기서 새 해시 체계를 만들지 않는다. 계좌 식별 키는 accounts.last4 하나뿐이고
// (migrations/*_create-accounts.sql), 명세서 머리말의 마스킹된 뒤 4자리와 그대로
// 맞춘다.

/**
 * 등록된 계좌를 전부 읽는다.
 *
 * 에러는 `error.message` 조차 쓰지 않는다. pg 에러 메시지에는 값이 섞여 나올 수
 * 있고, 이 경로의 값은 계좌 뒤 4자리다.
 *
 * @param {{ query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }> }} client
 * @returns {Promise<Array<{ id: number, role: string, nickname: string, last4: string }>>}
 */
export async function listAccounts(client) {
  let result;
  try {
    result = await client.query('SELECT id, role, nickname, last4 FROM accounts ORDER BY id');
  } catch {
    throw new Error('계좌 목록을 읽지 못했습니다.');
  }
  return result.rows.map((row) => ({
    id: Number(row.id),
    role: String(row.role),
    nickname: String(row.nickname),
    // last4 는 CHAR(4) 라 pg 가 공백을 붙여 줄 일은 없지만, 비교 키라서 못을 박는다.
    last4: String(row.last4).trim(),
  }));
}
