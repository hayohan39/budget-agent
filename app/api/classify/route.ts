// POST /api/classify — /classify 화면의 "이번만" · "앞으로도".
//
// 본체는 lib/classify/http.mjs 에 있다(가드 순서를 node --test 로 못 박으려고).
// 이 파일은 인증 · DB 연결을 꽂아 주기만 한다.
//
// 가드 순서: 세션 -> 화이트리스트(요청마다 다시) -> Origin -> 본문 검사.
// 응답은 늘 `Cache-Control: no-store` 이고 적요를 되비추지 않는다.
// console 호출이 이 파일에 없다.
import { auth, isAllowedEmail } from "@/auth";
import { withClient } from "@/lib/db/client.mjs";
import { handleClassifyPost } from "@/lib/classify/http.mjs";

// pg 는 Edge 에서 돌지 않는다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleClassifyPost(request, { auth, isAllowedEmail, withClient });
}
