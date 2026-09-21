import { auth, signOut } from "@/auth";

// middleware 가 이미 막지만, 페이지 자체도 세션 없이는 아무것도 보여주지 않는다.
export default async function Home() {
  const session = await auth();
  const email = session?.user?.email;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">가계부</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{email}</p>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/signin" });
        }}
      >
        <button
          type="submit"
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          로그아웃
        </button>
      </form>
    </main>
  );
}
