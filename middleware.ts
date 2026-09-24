// 인증되지 않은 요청은 어떤 페이지 · API 라우트에도 닿지 않는다.
// 예외는 인증 자체에 필요한 경로(/api/auth/*, /signin) 와 정적 자산뿐이다.
import { NextResponse } from "next/server";
import { auth, isAllowedEmail } from "@/auth";

export default auth((req) => {
  // 세션이 있다고 통과시키지 않는다. 화이트리스트를 **요청마다** 다시 본다 —
  // JWT 세션 쿠키는 ALLOWED_EMAILS 에서 이메일을 뺀 뒤에도 만료 전까지 살아
  // 있어서, 로그인 시점(auth.ts 의 signIn 콜백)에만 확인하면 명단에서 빠진
  // 사용자가 쿠키가 죽을 때까지 계속 들어온다.
  //
  // 여기가 공통 관문이지만 /api/import · /report 의 개별 검사는 그대로 둔다.
  // matcher 설정이 한 번 어긋나면 이 관문은 통째로 비켜 가진다(다층 방어).
  //
  // isAllowedEmail 은 process.env.ALLOWED_EMAILS 만 읽는 순수 함수라
  // Edge 런타임에서도 그대로 돈다. auth.ts 는 이미 이 파일이 import 하고 있어
  // 새로 끌어오는 모듈도 없다.
  if (req.auth && isAllowedEmail(req.auth.user?.email)) return NextResponse.next();

  // API 는 로그인 페이지 HTML 대신 401 을 받는다.
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const signInUrl = new URL("/signin", req.nextUrl.origin);
  signInUrl.searchParams.set(
    "callbackUrl",
    `${req.nextUrl.pathname}${req.nextUrl.search}`,
  );
  return NextResponse.redirect(signInUrl);
});

export const config = {
  // 아래 경로만 빼고 전부 보호한다.
  //   api/auth  - 로그인 · 콜백 핸들러
  //   signin    - 로그인 페이지
  //   _next/*   - 빌드 산출물
  //   favicon.ico
  // 접두사 매칭이 아니라 정확히 그 경로(또는 그 하위)만 예외로 둔다.
  // `api/auth` 를 접두사로 두면 `/api/authorize` 같은 경로까지 열린다.
  matcher: [
    "/((?!api/auth$|api/auth/|signin$|_next/static/|_next/image/|favicon\\.ico$).*)",
  ],
};
