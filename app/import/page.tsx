import Link from "next/link";

import { ImportForm } from "./import-form";

// middleware 가 이미 막지만(matcher 가 /import 와 /api/import 를 모두 포함한다),
// 페이지 자체도 세션 없이는 렌더되지 않도록 서버 컴포넌트로 둔다.
export default function ImportPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">거래내역 올리기</h1>
        <Link
          href="/"
          className="text-sm text-zinc-600 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          홈
        </Link>
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        토스뱅크 앱에서 내려받은 거래내역 엑셀(.xlsx) 파일을 올려주세요. 메인 ·
        고정비 · 비상금 세 개까지 한 번에 올릴 수 있습니다. 같은 달을 다시 올려도
        이미 저장된 거래는 중복으로 들어가지 않습니다.
      </p>
      <ImportForm />
    </main>
  );
}
