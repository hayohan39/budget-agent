import { Bar, LoadingShell } from "../_ui/skeleton";

// /stats 를 읽는 동안의 뼈대. 데이터 없음.
export default function Loading() {
  return (
    <LoadingShell title="가계부 통계">
      <Bar className="h-8 w-56" />
      <Bar className="h-10 w-full" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Bar key={index} className="h-56 w-full" />
        ))}
      </div>
      <Bar className="h-64 w-full" />
    </LoadingShell>
  );
}
