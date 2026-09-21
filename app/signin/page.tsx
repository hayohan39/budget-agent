import { signIn } from "@/auth";

export default async function SignIn({ searchParams }: PageProps<"/signin">) {
  const params = await searchParams;
  const raw = params.callbackUrl;
  const requested = Array.isArray(raw) ? raw[0] : raw;
  // 오픈 리다이렉트 방지: 같은 사이트의 절대 경로만 허용한다.
  const callbackUrl =
    requested && /^\/(?!\/)/.test(requested) ? requested : "/";
  const failed = params.error !== undefined;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">가계부</h1>
      {failed ? (
        <p className="text-sm text-red-600">
          로그인할 수 없는 계정입니다.
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
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Google 로 로그인
        </button>
      </form>
    </main>
  );
}
