// jwt 콜백에 담아 두는 Google 토큰 필드의 타입 선언.
// 이 값들은 암호화된 세션 쿠키 안에만 있고 클라이언트 session 에는 노출되지 않는다.
//
// refreshToken 은 두지 않는다. 로그인 스코프가 신원 확인용뿐이라 refresh token
// 으로 얻을 수 있는 것이 없고, 드라이브 백업은 증분 동의로 받은 세션 access
// token 으로 한다(auth.ts 주석 참고).
import "next-auth/jwt";

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    expiresAt?: number;
  }
}
