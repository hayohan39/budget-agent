// POST /api/tax/tags — 연말정산 공제 트래커(/tax).
//
// 본체는 lib/tax/http.mjs 에 있다(가드 순서를 node --test 로 못 박으려고).
// 이 파일은 인증 · DB 연결을 꽂아 주기만 한다. console 호출이 없다.
import { auth, isAllowedEmail } from "@/auth";
import { withClient } from "@/lib/db/client.mjs";
import { handleTaxTagPost } from "@/lib/tax/http.mjs";

// pg 는 Edge 에서 돌지 않는다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleTaxTagPost(request, { auth, isAllowedEmail, withClient });
}
