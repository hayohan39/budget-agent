// jwt 콜백에 담아 두는 Google 토큰 필드의 타입 선언.
// 이 값들은 암호화된 세션 쿠키 안에만 있고 클라이언트 session 에는 노출되지 않는다.
import "next-auth/jwt";

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  }
}
