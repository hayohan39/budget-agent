import { signIn } from "@/auth";

/**
 * Auth.js 가 `pages.error` 로 넘겨 주는 오류 코드 -> 사람이 읽는 문장.
 *
 * 코드 값을 읽지 않고 "error 파라미터가 있는가" 만 보던 때는, 서버 설정이
 * 잘못됐을 때(`Configuration` — 예: AUTH_GOOGLE_SECRET 이 틀림)에도 화면이
 * "로그인할 수 없는 계정입니다" 라고 말해 사용자 계정을 탓했다. 실제로 이것
 * 때문에 긴 디버깅이 한 번 있었다. 그래서 코드별로 문장을 나눈다.
 *
 * ⚠️ 문장에 설정의 구체적인 내용(어떤 환경변수가 어떻게 틀렸는지)을 담지
 *    않는다. 브라우저로 나가는 값이다 — 자세한 사정은 서버 로그의 몫이다.
 */
const ERROR_TEXT: Record<string, string> = {
  // 화이트리스트 밖이거나 이메일 미인증. 계정 쪽 사유다.
  AccessDenied: "이 계정으로는 로그인할 수 없습니다.",
  // 서버 설정 문제. 사용자 계정 잘못이 아니라는 것을 분명히 말한다.
  Configuration:
    "서버 설정 문제입니다. 계정 잘못이 아닙니다. 관리자에게 알려주세요.",
  // 이메일 링크 만료 등. 지금 provider 로는 나오지 않지만 코드로는 존재한다.
  Verification: "인증 링크가 만료되었거나 이미 사용되었습니다. 다시 시도해 주세요.",
};

/** 분류되지 않은 코드에 쓰는 문장. 계정을 탓하지 않는다. */
const GENERIC_ERROR_TEXT = "로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.";

/**
 * 쿼리스트링의 `error` 값 -> 보여 줄 문장. 오류가 없으면 null.
 *
 * 값 자체는 화면에 내보내지 않는다(표에 없는 코드도 일반 문장으로 덮는다).
 */
function signInErrorText(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const code = Array.isArray(raw) ? raw[0] : raw;
  if (typeof code !== "string") return GENERIC_ERROR_TEXT;
  return ERROR_TEXT[code] ?? GENERIC_ERROR_TEXT;
}

export default async function SignIn({ searchParams }: PageProps<"/signin">) {
  const params = await searchParams;
  const raw = params.callbackUrl;
  const requested = Array.isArray(raw) ? raw[0] : raw;
  // 오픈 리다이렉트 방지: 같은 사이트의 절대 경로만 허용한다.
  const callbackUrl =
    requested && /^\/(?!\/)/.test(requested) ? requested : "/";
  const errorText = signInErrorText(params.error);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-5 px-4 py-10 sm:px-8">
      <h1 className="text-2xl font-semibold tracking-tight">가계부</h1>
      {errorText !== null ? (
        <p role="alert" className="text-[13px] text-danger">
          {errorText}
        </p>
      ) : null}
      <form
        action={async () => {
          "use server";
          await signIn("google", { redirectTo: callbackUrl });
        }}
      >
        <button
          type="submit"
          className="h-9 rounded-md bg-inverse px-4 text-[13px] font-medium text-on-inverse hover:bg-inverse-hover"
        >
          Google 로 로그인
        </button>
      </form>
    </main>
  );
}
