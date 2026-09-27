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
