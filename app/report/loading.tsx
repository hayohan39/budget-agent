import { Bar, LoadingShell } from "../_ui/skeleton";

// /report 를 읽는 동안의 뼈대. 데이터 없음.
export default function Loading() {
  return (
    <LoadingShell title="월별 현금흐름표">
      <Bar className="h-8 w-56" />
      <Bar className="h-40 w-full" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Bar className="h-64 w-full" />
        <Bar className="h-64 w-full" />
      </div>
      <Bar className="h-48 w-full" />
    </LoadingShell>
  );
}
