// 인증되지 않은 요청은 어떤 페이지 · API 라우트에도 닿지 않는다.
// 예외는 인증 자체에 필요한 경로(/api/auth/*, /signin) 와 정적 자산뿐이다.
import { NextResponse } from "next/server";
import { auth } from "@/auth";

export default auth((req) => {
  if (req.auth) return NextResponse.next();

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
