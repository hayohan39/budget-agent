// 연말정산 탭 공통 머리: 하위 탭(공제 트래커 · 가이드). 데이터가 없어 가이드 페이지의 정적 렌더를 막지 않는다.
import { TaxTabs } from "./tax-tabs";

export default function TaxLayout({ children }: LayoutProps<"/tax">) {
  return (
    <>
      <div className="mx-auto flex w-full max-w-3xl px-4 pt-6 sm:px-8 sm:pt-8">
        <TaxTabs />
      </div>
      {children}
    </>
  );
}
