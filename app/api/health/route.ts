// GET /api/health — 배포 후 헬스체크(deploy.yml). 로그인 없이 열려 있다.
// 무엇을 내보내는지는 lib/health.mjs 에 적었다. console 호출이 이 파일에 없다.
import { withClient } from "@/lib/db/client.mjs";
import { checkHealth } from "@/lib/health.mjs";

// pg 는 Edge 에서 돌지 않는다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const health = await checkHealth({ withClient });
  return Response.json(health, {
    status: health.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
