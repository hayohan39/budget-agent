// POST /api/report/voids — 출금 · 입금 한 쌍의 무효(상쇄) 처리 · 해제.
//
// 본체는 lib/classify/http.mjs(가드 · 본문 읽기)와 lib/report/voids.mjs(검사 · 쓰기)에 있다.
// 가드 순서와 응답 규칙은 app/api/classify/route.ts 와 같다. console 호출이 이 파일에 없다.
import { auth, isAllowedEmail } from "@/auth";
import { withClient } from "@/lib/db/client.mjs";
import { handleVoidPost } from "@/lib/classify/http.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleVoidPost(request, { auth, isAllowedEmail, withClient });
}
