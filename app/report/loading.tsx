import { Bar, LoadingShell } from "../_ui/skeleton";

// /report 를 읽는 동안의 뼈대. 데이터 없음. 모양은 달 탭 · 검산 표시 · 접힌 계좌 섹션 셋 ·
// 종합정산 | 계좌별 잔액 변화 순서다(page.tsx 와 같은 배치).
export default function Loading() {
  return (
    <LoadingShell title="월별 현금흐름표">
      <Bar className="h-8 w-full" />
      <Bar className="h-7 w-28" />
      <div className="flex flex-col gap-2">
        <Bar className="h-11 w-full" />
        <Bar className="h-11 w-full" />
        <Bar className="h-11 w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Bar className="h-64 w-full" />
        <Bar className="h-40 w-full" />
      </div>
    </LoadingShell>
  );
}
