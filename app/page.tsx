import { auth, signOut } from "@/auth";

// middleware 가 이미 막지만, 페이지 자체도 세션 없이는 아무것도 보여주지 않는다.
// 페이지 이동 링크는 모든 화면 공통의 우측 상단 네비게이션(app/_ui/site-nav.tsx)에 있다.
export default async function Home() {
  const session = await auth();
  const email = session?.user?.email;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-5 px-4 py-10 sm:px-8">
      <h1 className="text-2xl font-semibold tracking-tight">가계부</h1>
      <p className="text-[13px] text-muted">{email}</p>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/signin" });
        }}
      >
        <button
          type="submit"
          className="inline-flex h-9 items-center rounded-md border border-line-strong bg-canvas px-4 text-[13px] font-medium hover:bg-hover"
        >
          로그아웃
        </button>
      </form>
    </main>
  );
}
