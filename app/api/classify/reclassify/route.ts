// POST /api/classify/reclassify — 저장된 미분류 거래만 지금의 분류기(메모 포함)로 다시 분류.
//
// 본체는 lib/classify/http.mjs 에 있다. 가드 순서와 응답 규칙은
// app/api/classify/route.ts 와 같다. console 호출이 이 파일에 없다.
import { auth, isAllowedEmail } from "@/auth";
import { withClient } from "@/lib/db/client.mjs";
import { handleReclassifyPost } from "@/lib/classify/http.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleReclassifyPost(request, { auth, isAllowedEmail, withClient });
}
