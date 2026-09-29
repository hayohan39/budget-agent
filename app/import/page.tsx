import { ImportForm } from "./import-form";

// middleware 가 세션과 화이트리스트를 모두 막는다(matcher 가 /import 와
// /api/import 를 모두 포함하고, middleware.ts 가 요청마다 isAllowedEmail 을
// 다시 본다). 페이지 자체도 세션 없이는 렌더되지 않도록 서버 컴포넌트로 둔다.
export default function ImportPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
      <h1 className="text-xl font-semibold tracking-tight">거래내역 올리기</h1>
      <p className="text-[13px] text-muted">
        토스뱅크 앱에서 내려받은 거래내역 엑셀(.xlsx) 파일을 담고, 미리보기로
        확인한 뒤, 체크한 파일만 월별 현금흐름에 적용합니다. 메인 · 고정비 ·
        비상금 세 개까지 담을 수 있습니다. 같은 달을 다시 올려도 이미 저장된
        거래는 중복으로 들어가지 않습니다.
      </p>
      <ImportForm />
    </main>
  );
}
