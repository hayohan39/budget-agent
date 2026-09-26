// 업로드 화면(app/import/import-form.tsx)의 "적용 뒤 담아 둔 목록" 계산.
//
// React 없이 `node --test` 로 못 박으려고 순수 함수로 뺐다. 파일 바이트도
// 거래 내용도 보지 않는다 — 키와 체크 여부, 적용 성공 여부만 다룬다.

/**
 * 적용이 끝난 뒤 담아 둔 목록을 어떻게 남길지 정한다.
 *
 * - 이번에 보냈고 성공한 파일만 목록에서 뺀다.
 * - 보냈지만 실패한 파일은 남기고 체크도 그대로 둔다(고친 뒤 바로 다시 적용).
 * - 보내지 않은 파일(체크하지 않은 파일)은 미리보기 결과 · 체크 상태를 포함해
 *   손대지 않는다 — 같은 객체를 그대로 돌려준다.
 * - 보냈는데 결과가 없는 파일(중간에 끊긴 경우)은 알 수 없으므로 그대로 둔다.
 *
 * @template {{key: string, selected: boolean}} T
 * @param {readonly T[]} staged 적용 직전의 목록
 * @param {Iterable<string>} sentKeys 이번 적용에서 보낸 파일의 키
 * @param {ReadonlyArray<{key: string, outcome: {ok: boolean}}>} results 파일별 결과
 * @returns {T[]}
 */
export function nextStagedAfterApply(staged, sentKeys, results) {
  const sent = new Set(sentKeys);
  /** @type {Map<string, boolean>} */
  const okByKey = new Map();
  for (const result of results) {
    if (sent.has(result.key)) okByKey.set(result.key, result.outcome.ok);
  }

  /** @type {T[]} */
  const next = [];
  for (const item of staged) {
    const ok = okByKey.get(item.key);
    if (ok === true) continue;
    if (ok === false) {
      next.push(item.selected ? item : { ...item, selected: true });
      continue;
    }
    next.push(item);
  }
  return next;
}
