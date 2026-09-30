import { ImportForm } from "./import-form";

// middleware 가 세션과 화이트리스트를 모두 막는다(matcher 가 /import 와
// /api/import 를 모두 포함하고, middleware.ts 가 요청마다 isAllowedEmail 을
// 다시 본다). 페이지 자체도 세션 없이는 렌더되지 않도록 서버 컴포넌트로 둔다.
export default function ImportPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
      <h1 className="text-xl font-semibold tracking-tight">거래내역 올리기</h1>
      <ImportForm />
    </main>
  );
}
