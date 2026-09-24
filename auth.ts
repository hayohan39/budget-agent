// NextAuth(Auth.js v5) 설정.
//
// 보안 원칙
// - 화이트리스트(ALLOWED_EMAILS) 밖의 계정은 signIn 콜백에서 즉시 거부한다.
// - 토큰은 JWT(암호화된 세션 쿠키) 안에만 둔다. 클라이언트로 내려가는 session
//   객체에는 넣지 않는다.
// - 토큰·이메일을 로그에 남기지 않는다.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

// 로그인에는 신원 확인용 기본 스코프만 요청한다. 거래내역은 웹앱 업로드로
// 받으므로 Gmail 읽기 권한(restricted 스코프)이 필요 없고, Drive 백업 권한은
// 나중에 백업 버튼을 처음 누르는 시점에 증분 동의(incremental auth)로 따로
// 받는다. 여기에 스코프를 다시 늘리지 않는다.
const GOOGLE_SCOPES = ["openid", "email", "profile"].join(" ");

function allowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

/**
 * 화이트리스트 판정. 로그인 시점뿐 아니라 요청마다 다시 확인해야 한다 —
 * 세션 쿠키는 ALLOWED_EMAILS 에서 이메일을 뺀 뒤에도 만료 전까지 살아 있다.
 * 비어 있으면 아무도 통과하지 못한다(fail closed).
 */
export function isAllowedEmail(email: string | null | undefined): boolean {
  if (typeof email !== "string" || email.length === 0) return false;
  return allowedEmails().includes(email.toLowerCase());
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: {
        params: {
          scope: GOOGLE_SCOPES,
          // refresh token 을 받으려면 offline + consent 가 둘 다 필요하다.
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/signin",
    error: "/signin",
  },
  callbacks: {
    // 화이트리스트가 비어 있으면 아무도 들어올 수 없다(fail closed).
    signIn({ profile }) {
      if (profile?.email_verified !== true) return false;
      return isAllowedEmail(profile?.email);
    },
    // 최초 로그인 시에만 account 가 들어온다. 이후 호출에서는 기존 토큰을 유지한다.
    // 여기 담긴 값은 암호화된 세션 쿠키 안에만 존재한다.
    jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.expiresAt = account.expires_at;
        if (account.refresh_token) token.refreshToken = account.refresh_token;
      }
      return token;
    },
    // 클라이언트로 내려가는 값이므로 토큰은 절대 옮겨 담지 않는다.
    session({ session }) {
      return session;
    },
  },
});
