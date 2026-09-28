// POST /api/classify/patterns/preview — 적요 패턴을 저장하기 전 미리보기(읽기만).
//
// 응답에 사용자 자신의 적요 몇 개가 실린다. 로그인 + 화이트리스트 뒤, no-store.
// 본체는 lib/classify/http.mjs 에 있다. console 호출이 이 파일에 없다.
import { auth, isAllowedEmail } from "@/auth";
import { withClient } from "@/lib/db/client.mjs";
import { handlePatternPreview } from "@/lib/classify/http.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handlePatternPreview(request, { auth, isAllowedEmail, withClient });
}
