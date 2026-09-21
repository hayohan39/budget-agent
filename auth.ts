// NextAuth(Auth.js v5) 설정.
//
// 보안 원칙
// - 화이트리스트(ALLOWED_EMAILS) 밖의 계정은 signIn 콜백에서 즉시 거부한다.
// - 토큰은 JWT(암호화된 세션 쿠키) 안에만 둔다. 클라이언트로 내려가는 session
//   객체에는 넣지 않는다.
// - 토큰·이메일을 로그에 남기지 않는다.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

// Gmail 첨부 수집(readonly) 과 앱이 만든 파일만 접근하는 Drive(drive.file).
// 더 넓은 스코프는 요청하지 않는다.
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

function allowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
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
      const email = profile?.email?.toLowerCase();
      if (!email || profile?.email_verified !== true) return false;
      return allowedEmails().includes(email);
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
