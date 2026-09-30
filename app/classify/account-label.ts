// 묶음이 속한 계좌의 표시 이름. 서버 컴포넌트(page.tsx)와 클라이언트 컴포넌트
// (forms.tsx)가 함께 쓰므로 "use client" 파일 밖에 둔다 — "use client" 모듈의
// 함수를 서버에서 부르면 클라이언트 참조라서 실행되지 않는다.
//
// 별칭(accounts.nickname)만 쓴다. 뒤 4자리(accounts.last4)는 이 화면에 오지 않는다.

/** 묶음이 속한 계좌. 역할과 별칭뿐이다. */
export type GroupAccount = { role: string; nickname: string };

/** 별칭 뒤에 `계좌` 를 붙인다(예: 고정비 계좌). */
export function accountLabel(account: GroupAccount | null): string {
  return account === null ? "알 수 없는 계좌" : `${account.nickname} 계좌`;
}

/**
 * 묶음을 계좌별 구역으로 나눈다. 목록은 이미 계좌 순서(메인 → 고정비 → 비상금)로
 * 정렬돼 온다(lib/classify/manual.mjs 의 groupRows) — 여기서는 끊기만 한다.
 * /classify 와 /report 의 미분류 섹션이 함께 쓴다.
 */
export function groupsByAccount<T extends { account: GroupAccount | null }>(
  groups: T[],
): Array<{ id: string; label: string; groups: T[] }> {
  const sections: Array<{ id: string; label: string; groups: T[] }> = [];
  for (const group of groups) {
    const id = group.account?.role ?? "unknown";
    const last = sections[sections.length - 1];
    if (last !== undefined && last.id === id) last.groups.push(group);
    else sections.push({ id, label: accountLabel(group.account), groups: [group] });
  }
  return sections;
}
