// 적요 정규화 — 서버와 브라우저가 **같은 함수**를 쓴다.
//
// 이 파일은 Node 전용 모듈(`node:*`)을 import 하지 않는다. /classify 의 클라이언트
// 컴포넌트(app/classify/forms.tsx)가 lib/classify/wildcard.mjs 를 거쳐 이 함수를
// 쓰기 때문이다. 예전에는 lib/toss/normalize.mjs 에 있었는데, 그 파일은 dedupe
// 해시 때문에 `node:crypto` 를 import 해서 브라우저 번들에 끌려 들어가면 안 된다.
// lib/toss/normalize.mjs 는 이 함수를 그대로 다시 내보낸다(같은 함수 객체) — 저장 ·
// 분류 · 화면이 서로 다른 정규화를 쓰는 일이 없다. test/client-module-graph.test.mjs
// 가 클라이언트 모듈 그래프에 `node:` import 가 없는지 검사한다.

/**
 * 해시에 넣기 전 적요를 다듬는다.
 *
 * 앞뒤 공백을 떼고 사이 공백을 하나로 누른다. 토스가 같은 거래를 다시
 * 내보내면서 공백을 하나 더 넣거나 비분리 공백(U+00A0)으로 바꾸는 정도의
 * 차이로 dedupe_key 가 달라져 같은 거래가 두 번 저장되는 것을 막는다.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDescription(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/gu, ' ').trim();
}
