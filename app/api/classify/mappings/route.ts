// POST /api/classify/mappings — 저장된 매핑(merchant_map)의 수정 · 삭제.
//
// 본체는 lib/classify/http.mjs 에 있다. 가드 순서와 응답 규칙은
// app/api/classify/route.ts 와 같다. console 호출이 이 파일에 없다.
import { auth, isAllowedEmail } from "@/auth";
import { withClient } from "@/lib/db/client.mjs";
import { handleMappingPost } from "@/lib/classify/http.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleMappingPost(request, { auth, isAllowedEmail, withClient });
}
